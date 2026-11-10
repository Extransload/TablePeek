//! What a connection says of its account and of the usage left: read live
//! from the Codex CLI, kept from ChatGPT's last answer, counted here for
//! Gemini (Google reports no remaining quota). Kept in
//! `~/.tablepeek/ai-usage.json` so a restart doesn't forget it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(crate) const USAGE_FILE: &str = "ai-usage.json";

/// One usage window: how much of it is used, and when it starts over.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Window {
    /// "five_hour", "seven_day", "daily", or the provider's own name.
    pub kind: String,
    /// The window's length, when known.
    pub minutes: Option<u64>,
    pub used_percent: f64,
    /// Unix seconds.
    pub resets_at: Option<i64>,
}

/// Windows as a provider last told them, and when.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Snapshot {
    windows: Vec<Window>,
    at: i64,
}

/// Requests sent today (the provider's day), per model.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Today {
    day: i64,
    counts: BTreeMap<String, u64>,
}

/// The last rate limit a provider reported.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct LimitSeen {
    pub model: Option<String>,
    pub limit: Option<u64>,
    pub per_day: bool,
    pub free_tier: bool,
    pub retry_after_s: Option<u64>,
    pub at: i64,
}

/// ai-usage.json, per provider id.
#[derive(Debug, Default, Serialize, Deserialize)]
pub(crate) struct UsageFile {
    #[serde(default)]
    windows: BTreeMap<String, Snapshot>,
    #[serde(default)]
    today: BTreeMap<String, Today>,
    #[serde(default)]
    limits: BTreeMap<String, LimitSeen>,
}

pub(crate) fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| i64::try_from(elapsed.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

impl UsageFile {
    pub(crate) fn load(dir: &Path) -> (PathBuf, Self) {
        let path = dir.join(USAGE_FILE);
        let file = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        (path, file)
    }

    /// Written through; a failure only loses what is shown next time.
    pub(crate) fn save(&self, path: &Path) {
        let tmp = path.with_extension("json.tmp");
        if let Ok(bytes) = serde_json::to_vec_pretty(self) {
            if std::fs::write(&tmp, bytes).is_ok() {
                let _ = std::fs::rename(&tmp, path);
            }
        }
    }

    pub(crate) fn set_windows(&mut self, provider: &str, windows: Vec<Window>, at: i64) {
        self.windows
            .insert(provider.to_string(), Snapshot { windows, at });
    }

    /// The windows last told, and when.
    pub(crate) fn windows(&self, provider: &str) -> Option<(&[Window], i64)> {
        self.windows
            .get(provider)
            .map(|snapshot| (snapshot.windows.as_slice(), snapshot.at))
    }

    /// One more request on Google's quota day (it starts at midnight in
    /// California).
    pub(crate) fn count(&mut self, provider: &str, model: &str, at: i64) {
        let day = pacific_day(at);
        let today = self.today.entry(provider.to_string()).or_default();
        if today.day != day {
            *today = Today {
                day,
                counts: BTreeMap::new(),
            };
        }
        *today.counts.entry(model.to_string()).or_default() += 1;
    }

    /// Today's requests per model.
    pub(crate) fn today(&self, provider: &str, at: i64) -> Vec<(String, u64)> {
        self.today
            .get(provider)
            .filter(|today| today.day == pacific_day(at))
            .map(|today| {
                today
                    .counts
                    .iter()
                    .map(|(model, count)| (model.clone(), *count))
                    .collect()
            })
            .unwrap_or_default()
    }

    pub(crate) fn set_limit(&mut self, provider: &str, limit: LimitSeen) {
        self.limits.insert(provider.to_string(), limit);
    }

    pub(crate) fn limit(&self, provider: &str) -> Option<&LimitSeen> {
        self.limits.get(provider)
    }
}

/// A rate-limit error's details (`ai_rate_limited`), as kept.
pub(crate) fn limit_seen(details: Option<&Value>, at: i64) -> LimitSeen {
    let details = details.cloned().unwrap_or(Value::Null);
    LimitSeen {
        model: details["model"].as_str().map(str::to_string),
        limit: details["limit"].as_u64(),
        per_day: details["per_day"].as_bool().unwrap_or(false),
        free_tier: details["free_tier"].as_bool().unwrap_or(false),
        retry_after_s: details["retry_after_s"].as_u64(),
        at,
    }
}

/// A window's kind from its length (Codex and ChatGPT give minutes).
fn kind_of(minutes: Option<u64>, fallback: &str) -> String {
    match minutes {
        Some(300) => "five_hour".into(),
        Some(10_080) => "seven_day".into(),
        Some(1_440) => "daily".into(),
        _ => fallback.into(),
    }
}

/// Codex's `account/rateLimits/read` window: `usedPercent`,
/// `windowDurationMins`, `resetsAt`.
pub(crate) fn codex_window(window: &Value, fallback: &str) -> Option<Window> {
    let minutes = window["windowDurationMins"].as_u64();
    Some(Window {
        kind: kind_of(minutes, fallback),
        minutes,
        used_percent: window["usedPercent"].as_f64()?,
        resets_at: window["resetsAt"].as_i64(),
    })
}

/// ChatGPT's answer headers: `x-codex-primary-used-percent`,
/// `-window-minutes`, `-reset-at` (and secondary), when it sends them.
pub(crate) fn header_windows(headers: &reqwest::header::HeaderMap) -> Vec<Window> {
    let read = |name: String| {
        headers
            .get(name.as_str())
            .and_then(|value| value.to_str().ok())
            .map(str::trim)
            .map(str::to_string)
    };
    ["primary", "secondary"]
        .into_iter()
        .filter_map(|which| {
            let used: f64 = read(format!("x-codex-{which}-used-percent"))?
                .parse()
                .ok()?;
            let minutes =
                read(format!("x-codex-{which}-window-minutes")).and_then(|text| text.parse().ok());
            Some(Window {
                kind: kind_of(minutes, which),
                minutes,
                used_percent: used,
                resets_at: read(format!("x-codex-{which}-reset-at"))
                    .and_then(|text| text.parse().ok()),
            })
        })
        .collect()
}

/// Whether requests to `model` count toward the quota Google names `quota`
/// ("gemini-3-flash" covers "gemini-3-flash-preview", not
/// "gemini-3-flash-lite-preview").
pub(crate) fn same_quota(model: &str, quota: &str) -> bool {
    match model.strip_prefix(quota) {
        Some(rest) => {
            rest.is_empty() || rest.starts_with("-preview") || rest.starts_with("-latest")
        }
        None => false,
    }
}

/// When Google's quota day after `unix` starts (midnight in California).
pub(crate) fn next_pacific_midnight(unix: i64) -> i64 {
    let day = pacific_day(unix);
    // Midnight is 07:00 or 08:00 UTC, by daylight time.
    let early = (day + 1) * 86_400 + 7 * 3_600;
    if pacific_day(early) == day {
        early + 3_600
    } else {
        early
    }
}

/// Days since 1970-01-01 in California (US Pacific): standard time is UTC−8,
/// daylight time UTC−7 from the second Sunday of March, 2:00, to the first
/// Sunday of November, 2:00.
pub(crate) fn pacific_day(unix: i64) -> i64 {
    let (year, _, _) = civil_from_days(unix.div_euclid(86_400));
    let sunday = |month: u32, nth: i64| {
        let first = days_from_civil(year, month, 1);
        // 1970-01-01 was a Thursday: weekday 0 is Sunday.
        let weekday = (first + 4).rem_euclid(7);
        first + (7 - weekday) % 7 + 7 * (nth - 1)
    };
    let dst_start = sunday(3, 2) * 86_400 + 10 * 3_600;
    let dst_end = sunday(11, 1) * 86_400 + 9 * 3_600;
    let offset = if (dst_start..dst_end).contains(&unix) {
        -7 * 3_600
    } else {
        -8 * 3_600
    };
    (unix + offset).div_euclid(86_400)
}

/// Days since 1970-01-01 of a date (Howard Hinnant's algorithm).
fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month = i64::from(month);
    let day_of_year =
        (153 * (if month > 2 { month - 3 } else { month + 9 }) + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = u32::try_from(day_of_year - (153 * month_index + 2) / 5 + 1).unwrap_or(1);
    let month = u32::try_from(if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    })
    .unwrap_or(1);
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn googles_day_starts_at_midnight_in_california() {
        let day = |y, m, d| days_from_civil(y, m, d);
        // 2026-11-10 07:59 UTC is still the 9th in California (PST, −8).
        assert_eq!(
            pacific_day(day(2026, 11, 10) * 86_400 + 7 * 3_600 + 59 * 60),
            day(2026, 11, 9)
        );
        assert_eq!(
            pacific_day(day(2026, 11, 10) * 86_400 + 8 * 3_600),
            day(2026, 11, 10)
        );
        // In summer (PDT, −7) the day turns at 07:00 UTC.
        assert_eq!(
            pacific_day(day(2026, 7, 1) * 86_400 + 6 * 3_600 + 59 * 60),
            day(2026, 6, 30)
        );
        assert_eq!(
            pacific_day(day(2026, 7, 1) * 86_400 + 7 * 3_600),
            day(2026, 7, 1)
        );
        // 2026's change dates: March 8 and November 1.
        assert_eq!(civil_from_days(day(2026, 3, 8)), (2026, 3, 8));
        assert_eq!(
            pacific_day(day(2026, 3, 9) * 86_400 + 7 * 3_600),
            day(2026, 3, 9)
        );
        assert_eq!(
            pacific_day(day(2026, 3, 8) * 86_400 + 7 * 3_600),
            day(2026, 3, 7)
        );
    }

    #[test]
    fn todays_counts_start_over_with_the_day() {
        let mut file = UsageFile::default();
        let monday = days_from_civil(2026, 11, 9) * 86_400 + 20 * 3_600;
        file.count("gemini", "flash", monday);
        file.count("gemini", "flash", monday + 60);
        assert_eq!(
            file.today("gemini", monday + 120),
            [("flash".to_string(), 2)]
        );
        let tuesday = monday + 86_400;
        assert!(file.today("gemini", tuesday).is_empty());
        file.count("gemini", "flash", tuesday);
        assert_eq!(file.today("gemini", tuesday), [("flash".to_string(), 1)]);
    }

    #[test]
    fn windows_read_from_each_source() {
        let codex = serde_json::json!({ "usedPercent": 66, "windowDurationMins": 300, "resetsAt": 1794310026 });
        assert_eq!(
            codex_window(&codex, "primary"),
            Some(Window {
                kind: "five_hour".into(),
                minutes: Some(300),
                used_percent: 66.0,
                resets_at: Some(1794310026)
            })
        );
        let mut headers = reqwest::header::HeaderMap::new();
        headers.insert("x-codex-primary-used-percent", "12.5".parse().unwrap());
        headers.insert("x-codex-primary-window-minutes", "300".parse().unwrap());
        headers.insert("x-codex-secondary-used-percent", "3".parse().unwrap());
        headers.insert("x-codex-secondary-window-minutes", "10080".parse().unwrap());
        let windows = header_windows(&headers);
        assert_eq!(
            windows
                .iter()
                .map(|w| (w.kind.as_str(), w.used_percent))
                .collect::<Vec<_>>(),
            [("five_hour", 12.5), ("seven_day", 3.0)]
        );
    }
}
