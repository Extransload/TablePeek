//! What this build is (version, commit, how it was built) and whether a
//! newer release is out.
//!
//! The check asks GitHub for the latest release, at most once a day and only
//! when a page asks for the update status, sending nothing but the request
//! itself (its User-Agent names the running version). The answer is kept in
//! `update.json` in the settings folder with the user's choices: whether to
//! check at all and the release they chose to skip. Network, HTTP and rate
//! limit failures are kept as an error code for Settings and otherwise say
//! nothing.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// The version every crate of the workspace shares.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Short hash of the commit built, "-dirty" with local changes, or "unknown".
pub const COMMIT: &str = env!("TABLEPEEK_COMMIT");
/// "release" for the binaries the release workflow builds, else "source".
pub const DIST: &str = env!("TABLEPEEK_DIST");
/// The Rust target triple, which names this platform's release archive.
pub const TARGET: &str = env!("TABLEPEEK_TARGET");

/// GitHub's latest stable release of TablePeek (it leaves out drafts and
/// prereleases). `TABLEPEEK_UPDATE_URL` points the check at a mirror that
/// answers in the same shape.
pub const RELEASES_URL: &str = "https://api.github.com/repos/Extransload/TablePeek/releases/latest";
const URL_ENV: &str = "TABLEPEEK_UPDATE_URL";
/// Any value but empty or "0" turns the check off (CI, tests, packagers).
const DISABLE_ENV: &str = "TABLEPEEK_NO_UPDATE_CHECK";

const CACHE_FILE: &str = "update.json";
const CHECK_INTERVAL_SECS: u64 = 24 * 60 * 60;
const TIMEOUT: Duration = Duration::from_secs(5);
/// How much of the release notes is kept and shown.
const NOTES_LIMIT: usize = 2000;

/// `tablepeek --version`: `tablepeek 0.1.0 (abc1234, source)`.
pub fn version_line() -> String {
    format!("tablepeek {VERSION} ({COMMIT}, {DIST})")
}

#[derive(Debug, Clone, Serialize)]
pub struct VersionInfo {
    pub version: &'static str,
    pub commit: &'static str,
    pub dist: &'static str,
    pub target: &'static str,
}

pub fn version_info() -> VersionInfo {
    VersionInfo {
        version: VERSION,
        commit: COMMIT,
        dist: DIST,
        target: TARGET,
    }
}

/// The release archive the release workflow makes for `target`.
pub fn asset_name(tag: &str, target: &str) -> String {
    let extension = if target.contains("windows") {
        "zip"
    } else {
        "tar.gz"
    };
    format!("tablepeek-{tag}-{target}.{extension}")
}

/// A release tag (`v1.2.3`, `1.2.3`, `v1.3.0-rc.1`) as a version.
pub fn parse_tag(tag: &str) -> Option<semver::Version> {
    let tag = tag.trim();
    let bare = tag
        .strip_prefix('v')
        .or_else(|| tag.strip_prefix('V'))
        .unwrap_or(tag);
    semver::Version::parse(bare).ok()
}

/// Whether `latest` is a stable release past `current`.
pub fn is_newer(latest: &str, current: &str) -> bool {
    match (parse_tag(latest), parse_tag(current)) {
        (Some(latest), Some(current)) => latest.pre.is_empty() && latest > current,
        _ => false,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedAsset {
    name: String,
    url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedRelease {
    tag: String,
    url: String,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    notes: String,
    #[serde(default)]
    assets: Vec<CachedAsset>,
}

/// update.json: the user's choices and the last answer.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct UpdateFile {
    #[serde(default = "default_enabled")]
    enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    skipped: Option<String>,
    /// When the last check was made (Unix seconds), whatever it found.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    checked_at: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    latest: Option<CachedRelease>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn default_enabled() -> bool {
    true
}

impl Default for UpdateFile {
    fn default() -> Self {
        Self {
            enabled: true,
            skipped: None,
            checked_at: None,
            latest: None,
            error: None,
        }
    }
}

/// What GET /api/update answers.
#[derive(Debug, Clone, Serialize)]
pub struct UpdateStatus {
    /// Checks are made: the setting is on and the environment allows them.
    pub enabled: bool,
    /// The user's setting.
    pub setting: bool,
    /// `TABLEPEEK_NO_UPDATE_CHECK` turned checks off.
    pub env_disabled: bool,
    /// This build, as a tag (`v0.1.0`).
    pub current: String,
    pub latest: Option<String>,
    /// `latest` is a stable release past `current`.
    pub newer: bool,
    /// The release's page.
    pub url: Option<String>,
    /// The start of its release notes.
    pub notes: Option<String>,
    pub published_at: Option<String>,
    /// Unix seconds of the last check.
    pub checked_at: Option<u64>,
    /// Why the last check failed: `network`, `timeout`, `rate_limited`,
    /// `http_<status>` or `invalid_response`.
    pub error: Option<String>,
    /// The release the user chose to skip.
    pub skipped: Option<String>,
    pub dist: &'static str,
    pub target: &'static str,
    /// This platform's archive of `latest`, and its download when the
    /// release has it.
    pub asset_name: Option<String>,
    pub asset_url: Option<String>,
}

/// A change to the user's choices; fields left out stay as they are.
#[derive(Debug, Default, Deserialize)]
pub struct UpdateSettings {
    #[serde(default)]
    pub enabled: Option<bool>,
    /// A tag to skip, or null to skip none.
    #[serde(default, deserialize_with = "some_value")]
    pub skipped: Option<Option<String>>,
}

// Tells a field given as null from one left out.
fn some_value<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Deserialize)]
struct GithubAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    published_at: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<GithubAsset>,
}

/// What one request found.
enum Fetched {
    Release(CachedRelease),
    /// No stable release to offer: none is published yet (404), or the
    /// endpoint answered with a draft or a prerelease.
    Nothing,
}

pub struct UpdateChecker {
    path: PathBuf,
    url: String,
    current: String,
    env_disabled: bool,
    // Held across a check, so pages asking at once share one request.
    file: tokio::sync::Mutex<UpdateFile>,
}

impl UpdateChecker {
    /// The checker the app runs: GitHub, or `TABLEPEEK_UPDATE_URL`, unless
    /// `TABLEPEEK_NO_UPDATE_CHECK` turns it off.
    pub fn from_env(dir: &Path) -> Self {
        let url = std::env::var(URL_ENV)
            .ok()
            .map(|url| url.trim().to_string())
            .filter(|url| !url.is_empty())
            .unwrap_or_else(|| RELEASES_URL.to_string());
        let env_disabled = std::env::var(DISABLE_ENV)
            .map(|value| {
                let value = value.trim();
                !value.is_empty() && value != "0"
            })
            .unwrap_or(false);
        Self::new(dir, url, VERSION, env_disabled)
    }

    /// A checker asking `url` on behalf of version `current`, keeping its
    /// file in `dir`.
    pub fn new(dir: &Path, url: String, current: &str, env_disabled: bool) -> Self {
        let path = dir.join(CACHE_FILE);
        let file = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<UpdateFile>(&bytes).ok())
            .unwrap_or_default();
        Self {
            path,
            url,
            current: current.to_string(),
            env_disabled,
            file: tokio::sync::Mutex::new(file),
        }
    }

    /// The update status, checking first when checks are on and the last
    /// one is a day old (or never made).
    pub async fn status(&self) -> UpdateStatus {
        self.status_with(false).await
    }

    /// The update status after a check made now, when checks are on.
    pub async fn check_now(&self) -> UpdateStatus {
        self.status_with(true).await
    }

    /// Saves the user's choices. Turning checks off makes no request; turning
    /// them on waits for the next status to check.
    pub async fn configure(&self, settings: UpdateSettings) -> Result<UpdateStatus, String> {
        let mut file = self.file.lock().await;
        let mut next = file.clone();
        if let Some(enabled) = settings.enabled {
            next.enabled = enabled;
        }
        if let Some(skipped) = settings.skipped {
            next.skipped = skipped
                .map(|tag| tag.trim().to_string())
                .filter(|tag| !tag.is_empty());
        }
        self.persist(&next)?;
        *file = next;
        Ok(self.describe(&file))
    }

    async fn status_with(&self, force: bool) -> UpdateStatus {
        let mut file = self.file.lock().await;
        if self.enabled(&file) {
            let now = unix_now();
            // A time ahead of the clock (it was set back) counts as stale.
            let due = match file.checked_at {
                Some(at) => at > now || now - at >= CHECK_INTERVAL_SECS,
                None => true,
            };
            if force || due {
                match self.fetch().await {
                    Ok(Fetched::Release(release)) => {
                        file.latest = Some(release);
                        file.error = None;
                    }
                    Ok(Fetched::Nothing) => file.error = None,
                    // What an earlier check found stays.
                    Err(code) => file.error = Some(code),
                }
                file.checked_at = Some(now);
                // Not saving only means checking again next time.
                let _ = self.persist(&file);
            }
        }
        self.describe(&file)
    }

    fn enabled(&self, file: &UpdateFile) -> bool {
        file.enabled && !self.env_disabled
    }

    fn describe(&self, file: &UpdateFile) -> UpdateStatus {
        let enabled = self.enabled(file);
        let mut status = UpdateStatus {
            enabled,
            setting: file.enabled,
            env_disabled: self.env_disabled,
            current: format!("v{}", self.current),
            latest: None,
            newer: false,
            url: None,
            notes: None,
            published_at: None,
            checked_at: None,
            error: None,
            skipped: file.skipped.clone(),
            dist: DIST,
            target: TARGET,
            asset_name: None,
            asset_url: None,
        };
        if !enabled {
            return status;
        }
        status.checked_at = file.checked_at;
        status.error = file.error.clone();
        if let Some(release) = &file.latest {
            let asset = asset_name(&release.tag, TARGET);
            status.asset_url = release
                .assets
                .iter()
                .find(|candidate| candidate.name == asset)
                .map(|candidate| candidate.url.clone());
            status.asset_name = Some(asset);
            status.newer = is_newer(&release.tag, &self.current);
            status.latest = Some(release.tag.clone());
            status.url = Some(release.url.clone());
            status.notes = Some(release.notes.clone()).filter(|notes| !notes.is_empty());
            status.published_at = release.published_at.clone();
        }
        status
    }

    async fn fetch(&self) -> Result<Fetched, String> {
        let client = reqwest::Client::builder()
            .user_agent(format!("TablePeek/{}", self.current))
            .timeout(TIMEOUT)
            .build()
            .map_err(|_| "network".to_string())?;
        let response = client
            .get(&self.url)
            .header(reqwest::header::ACCEPT, "application/vnd.github+json")
            .send()
            .await
            .map_err(|err| request_error(&err))?;
        let status = response.status();
        if status == reqwest::StatusCode::NOT_FOUND {
            return Ok(Fetched::Nothing);
        }
        if status == reqwest::StatusCode::FORBIDDEN
            || status == reqwest::StatusCode::TOO_MANY_REQUESTS
        {
            return Err("rate_limited".into());
        }
        if !status.is_success() {
            return Err(format!("http_{}", status.as_u16()));
        }
        let release: GithubRelease = response.json().await.map_err(|err| {
            if err.is_timeout() {
                "timeout".to_string()
            } else {
                "invalid_response".to_string()
            }
        })?;
        if release.draft || release.prerelease {
            return Ok(Fetched::Nothing);
        }
        match parse_tag(&release.tag_name) {
            Some(version) if version.pre.is_empty() => {}
            Some(_) => return Ok(Fetched::Nothing),
            None => return Err("invalid_response".into()),
        }
        Ok(Fetched::Release(CachedRelease {
            tag: release.tag_name.trim().to_string(),
            url: release.html_url,
            published_at: release.published_at,
            notes: excerpt(release.body.as_deref().unwrap_or("")),
            assets: release
                .assets
                .into_iter()
                .map(|asset| CachedAsset {
                    name: asset.name,
                    url: asset.browser_download_url,
                })
                .collect(),
        }))
    }

    fn persist(&self, file: &UpdateFile) -> Result<(), String> {
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir)
                .map_err(|err| format!("저장 폴더를 만들 수 없습니다: {err}"))?;
        }
        let json = serde_json::to_vec_pretty(file)
            .map_err(|err| format!("업데이트 설정을 직렬화할 수 없습니다: {err}"))?;
        let temp = self.path.with_extension("json.tmp");
        std::fs::write(&temp, json).map_err(|err| format!("저장 파일을 쓸 수 없습니다: {err}"))?;
        std::fs::rename(&temp, &self.path)
            .map_err(|err| format!("저장 파일을 교체할 수 없습니다: {err}"))
    }
}

fn request_error(err: &reqwest::Error) -> String {
    if err.is_timeout() {
        "timeout".into()
    } else {
        "network".into()
    }
}

/// The start of the release notes, cut at a character boundary.
fn excerpt(body: &str) -> String {
    let body = body.trim();
    match body.char_indices().nth(NOTES_LIMIT) {
        Some((end, _)) => format!("{}…", body[..end].trim_end()),
        None => body.to_string(),
    }
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    use axum::extract::State;
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::IntoResponse;
    use axum::routing::get;
    use axum::Router;

    #[derive(Clone)]
    struct Mock {
        hits: Arc<AtomicUsize>,
        agents: Arc<Mutex<Vec<String>>>,
        reply: Arc<Mutex<(StatusCode, String)>>,
    }

    impl Mock {
        fn answer(&self, status: StatusCode, body: serde_json::Value) {
            *self.reply.lock().unwrap() = (status, body.to_string());
        }

        fn hits(&self) -> usize {
            self.hits.load(Ordering::SeqCst)
        }
    }

    async fn latest(State(mock): State<Mock>, headers: HeaderMap) -> impl IntoResponse {
        mock.hits.fetch_add(1, Ordering::SeqCst);
        if let Some(agent) = headers.get("user-agent").and_then(|v| v.to_str().ok()) {
            mock.agents.lock().unwrap().push(agent.to_string());
        }
        let (status, body) = mock.reply.lock().unwrap().clone();
        (status, [("content-type", "application/json")], body)
    }

    /// A releases endpoint on a local port, answering whatever it is told.
    async fn mock_server() -> (Mock, String) {
        let mock = Mock {
            hits: Arc::new(AtomicUsize::new(0)),
            agents: Arc::new(Mutex::new(Vec::new())),
            reply: Arc::new(Mutex::new((StatusCode::OK, String::new()))),
        };
        mock.answer(StatusCode::OK, release("v0.2.0", false));
        let router = Router::new()
            .route("/releases/latest", get(latest))
            .with_state(mock.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/releases/latest", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, router).await });
        (mock, url)
    }

    fn release(tag: &str, prerelease: bool) -> serde_json::Value {
        serde_json::json!({
            "tag_name": tag,
            "html_url": format!("https://github.com/Extransload/TablePeek/releases/tag/{tag}"),
            "published_at": "2026-10-30T00:00:00Z",
            "body": "## Added\n- Something",
            "draft": false,
            "prerelease": prerelease,
            "assets": [{
                "name": asset_name(tag, TARGET),
                "browser_download_url": format!("https://example.invalid/{}", asset_name(tag, TARGET)),
            }],
        })
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tablepeek-update-test-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn compares_tags_as_semver() {
        assert!(is_newer("v0.2.0", "0.1.0"));
        assert!(is_newer("0.1.1", "v0.1.0"));
        assert!(is_newer("v0.10.0", "0.9.9"));
        assert!(is_newer("v1.0.0", "1.0.0-rc.2"));
        assert!(!is_newer("v0.1.0", "0.1.0"));
        assert!(!is_newer("v0.1.0", "0.2.0"));
        assert!(!is_newer("v0.3.0-rc.1", "0.2.0"));
        assert!(!is_newer("nightly", "0.1.0"));
        assert_eq!(parse_tag("V1.2.3"), Some(semver::Version::new(1, 2, 3)));
    }

    #[test]
    fn names_the_archive_for_the_target() {
        assert_eq!(
            asset_name("v0.1.0", "aarch64-apple-darwin"),
            "tablepeek-v0.1.0-aarch64-apple-darwin.tar.gz"
        );
        assert_eq!(
            asset_name("v0.1.0", "x86_64-pc-windows-msvc"),
            "tablepeek-v0.1.0-x86_64-pc-windows-msvc.zip"
        );
    }

    #[test]
    fn keeps_the_start_of_long_notes() {
        let long = "가".repeat(NOTES_LIMIT + 10);
        let cut = excerpt(&long);
        assert_eq!(cut.chars().count(), NOTES_LIMIT + 1);
        assert!(cut.ends_with('…'));
        assert_eq!(excerpt("  short  "), "short");
    }

    #[tokio::test]
    async fn finds_a_newer_release_and_names_the_running_version() {
        let (mock, url) = mock_server().await;
        let dir = temp_dir("newer");
        let checker = UpdateChecker::new(&dir, url, "0.1.0", false);
        let status = checker.status().await;
        assert_eq!(mock.hits(), 1);
        assert!(status.enabled);
        assert!(status.newer);
        assert_eq!(status.current, "v0.1.0");
        assert_eq!(status.latest.as_deref(), Some("v0.2.0"));
        assert_eq!(
            status.url.as_deref(),
            Some("https://github.com/Extransload/TablePeek/releases/tag/v0.2.0")
        );
        assert_eq!(status.notes.as_deref(), Some("## Added\n- Something"));
        assert_eq!(
            status.asset_name.as_deref(),
            Some(asset_name("v0.2.0", TARGET).as_str())
        );
        assert!(status.asset_url.is_some());
        assert!(status.error.is_none());
        assert_eq!(
            mock.agents.lock().unwrap().as_slice(),
            ["TablePeek/0.1.0".to_string()]
        );

        // The same release is not newer than itself.
        let checker = UpdateChecker::new(&dir, String::new(), "0.2.0", false);
        assert!(!checker.status().await.newer);
    }

    #[tokio::test]
    async fn skips_prereleases() {
        let (mock, url) = mock_server().await;
        let dir = temp_dir("prerelease");
        let checker = UpdateChecker::new(&dir, url, "0.1.0", false);
        mock.answer(StatusCode::OK, release("v0.3.0-rc.1", true));
        let status = checker.check_now().await;
        assert!(!status.newer);
        assert!(status.latest.is_none());
        assert!(status.error.is_none());

        // A prerelease tag not marked as one is skipped too, and what an
        // earlier check found stays.
        mock.answer(StatusCode::OK, release("v0.2.0", false));
        assert!(checker.check_now().await.newer);
        mock.answer(StatusCode::OK, release("v0.3.0-rc.2", false));
        let status = checker.check_now().await;
        assert_eq!(status.latest.as_deref(), Some("v0.2.0"));
        assert_eq!(mock.hits(), 3);
    }

    #[tokio::test]
    async fn checks_at_most_once_a_day() {
        let (mock, url) = mock_server().await;
        let dir = temp_dir("daily");
        let checker = UpdateChecker::new(&dir, url.clone(), "0.1.0", false);
        assert!(checker.status().await.newer);
        assert!(checker.status().await.newer);
        assert_eq!(mock.hits(), 1);

        // The answer is kept on disk: a restart within the day asks nothing.
        let checker = UpdateChecker::new(&dir, url.clone(), "0.1.0", false);
        let status = checker.status().await;
        assert!(status.newer);
        assert_eq!(mock.hits(), 1);

        // A day later it asks again.
        let path = dir.join(CACHE_FILE);
        let mut file: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        file["checked_at"] = (unix_now() - CHECK_INTERVAL_SECS).into();
        std::fs::write(&path, file.to_string()).unwrap();
        let checker = UpdateChecker::new(&dir, url, "0.1.0", false);
        checker.status().await;
        assert_eq!(mock.hits(), 2);

        // "Check now" asks whenever it is pressed.
        checker.check_now().await;
        assert_eq!(mock.hits(), 3);
    }

    #[tokio::test]
    async fn failures_are_kept_quietly() {
        let (mock, url) = mock_server().await;
        let dir = temp_dir("failures");
        let checker = UpdateChecker::new(&dir, url, "0.1.0", false);
        assert!(checker.check_now().await.newer);

        mock.answer(
            StatusCode::FORBIDDEN,
            serde_json::json!({"message": "rate limit"}),
        );
        let status = checker.check_now().await;
        assert_eq!(status.error.as_deref(), Some("rate_limited"));
        assert!(status.newer, "the earlier answer stays");

        mock.answer(StatusCode::BAD_GATEWAY, serde_json::json!({}));
        assert_eq!(checker.check_now().await.error.as_deref(), Some("http_502"));

        mock.answer(StatusCode::OK, serde_json::json!({"unexpected": true}));
        let status = checker.check_now().await;
        assert_eq!(status.error.as_deref(), Some("invalid_response"));

        // No release published yet is not an error.
        mock.answer(
            StatusCode::NOT_FOUND,
            serde_json::json!({"message": "Not Found"}),
        );
        assert!(checker.check_now().await.error.is_none());

        // Nothing listening.
        let offline = UpdateChecker::new(
            &temp_dir("offline"),
            "http://127.0.0.1:9/releases/latest".into(),
            "0.1.0",
            false,
        );
        let status = offline.status().await;
        assert_eq!(status.error.as_deref(), Some("network"));
        assert!(!status.newer);
    }

    #[tokio::test]
    async fn turned_off_makes_no_request() {
        let (mock, url) = mock_server().await;
        let dir = temp_dir("off");
        let checker = UpdateChecker::new(&dir, url.clone(), "0.1.0", false);
        let status = checker
            .configure(UpdateSettings {
                enabled: Some(false),
                skipped: None,
            })
            .await
            .unwrap();
        assert!(!status.enabled);
        assert!(!status.setting);
        let status = checker.status().await;
        assert!(!status.newer);
        assert!(status.latest.is_none());
        checker.check_now().await;
        assert_eq!(mock.hits(), 0);

        // The setting is kept.
        let checker = UpdateChecker::new(&dir, url.clone(), "0.1.0", false);
        checker.status().await;
        assert_eq!(mock.hits(), 0);

        // TABLEPEEK_NO_UPDATE_CHECK wins over the setting.
        let checker = UpdateChecker::new(&temp_dir("env-off"), url, "0.1.0", true);
        let status = checker.check_now().await;
        assert!(!status.enabled);
        assert!(status.setting);
        assert!(status.env_disabled);
        assert_eq!(mock.hits(), 0);
    }

    #[tokio::test]
    async fn remembers_the_skipped_release() {
        let dir = temp_dir("skip");
        let checker = UpdateChecker::new(&dir, String::new(), "0.1.0", true);
        let settings: UpdateSettings = serde_json::from_str(r#"{"skipped":"v0.2.0"}"#).unwrap();
        checker.configure(settings).await.unwrap();
        let checker = UpdateChecker::new(&dir, String::new(), "0.1.0", true);
        assert_eq!(checker.status().await.skipped.as_deref(), Some("v0.2.0"));

        // Null skips none; a body without the field leaves it alone.
        let settings: UpdateSettings = serde_json::from_str(r#"{"enabled":true}"#).unwrap();
        assert_eq!(
            checker
                .configure(settings)
                .await
                .unwrap()
                .skipped
                .as_deref(),
            Some("v0.2.0")
        );
        let settings: UpdateSettings = serde_json::from_str(r#"{"skipped":null}"#).unwrap();
        assert!(checker.configure(settings).await.unwrap().skipped.is_none());
    }
}
