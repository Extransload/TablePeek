//! The key-value operations (`/api/kv/*`): the key browser's scan, the
//! key views' pages, edits, the console, INFO, SLOWLOG and CLIENT KILL,
//! and a key's value exported whole.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use ::redis::aio::MultiplexedConnection;
use ::redis::Value;
use async_trait::async_trait;

use super::command::{self, command_text, kind_of, quote_arg, split_args, Kind, KEYS_BIG_DB};
use super::reply::{self, engine_error};
use super::{broken, RedisDriver, RESPONSE_TIMEOUT};
use crate::driver::FileStream;
use crate::keyvalue::*;
use crate::sql_log::Change;
use crate::EngineError;

/// How long one scan step (SCAN, HSCAN, SSCAN, ZSCAN with a sparse
/// pattern) may keep asking before it answers with what it has.
const SCAN_BUDGET: Duration = Duration::from_millis(300);

/// The most a page may ask for at once.
const MAX_PAGE: u32 = 5_000;

/// What a string view reads at first, and the most it ever reads.
const STRING_FIRST: u64 = 256 * 1024;
const STRING_MAX: u64 = 64 * 1024 * 1024;

/// What an export reads per command.
const EXPORT_PAGE: usize = 1_000;
const EXPORT_CHUNK: u64 = 1024 * 1024;

/// One command, kept as its arguments: sent as they are, logged as
/// redis-cli would show them.
#[derive(Debug, Clone)]
pub(super) struct Line(Vec<Vec<u8>>);

impl Line {
    pub(super) fn new(name: &str) -> Self {
        Line(vec![name.as_bytes().to_vec()])
    }

    pub(super) fn arg(mut self, arg: impl AsRef<[u8]>) -> Self {
        self.0.push(arg.as_ref().to_vec());
        self
    }

    pub(super) fn num(self, number: impl std::fmt::Display) -> Self {
        self.arg(number.to_string())
    }

    fn from_args(args: Vec<Vec<u8>>) -> Self {
        Line(args)
    }

    pub(super) fn text(&self) -> String {
        let args: Vec<&[u8]> = self.0.iter().map(Vec::as_slice).collect();
        command_text(&args)
    }

    fn cmd(&self) -> ::redis::Cmd {
        let mut cmd = ::redis::Cmd::new();
        for arg in &self.0 {
            cmd.arg(arg.as_slice());
        }
        cmd
    }
}

/// Several commands as one MULTI … EXEC.
fn transaction(lines: &[Line]) -> ::redis::Pipeline {
    let mut pipe = ::redis::pipe();
    pipe.atomic();
    for line in lines {
        pipe.add_command(line.cmd());
    }
    pipe
}

fn not_found() -> EngineError {
    EngineError::NotFound("키가 없습니다 (지워졌거나 만료되었습니다)".into())
}

fn bad(message: impl Into<String>) -> EngineError {
    EngineError::BadRequest(message.into())
}

/// A SCAN cursor as the page sent it: digits, "0" when empty.
fn cursor_of(cursor: Option<&str>) -> Result<String, EngineError> {
    let cursor = cursor
        .map(str::trim)
        .filter(|cursor| !cursor.is_empty())
        .unwrap_or("0");
    if !cursor.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(bad("커서가 올바르지 않습니다"));
    }
    Ok(cursor.to_string())
}

/// A score as ZADD takes it, checked: a number, `inf`, `+inf` or `-inf`.
fn score_of(text: &str) -> Result<String, EngineError> {
    let text = text.trim();
    let lower = text.to_ascii_lowercase();
    if matches!(lower.as_str(), "inf" | "+inf" | "-inf")
        || text.parse::<f64>().is_ok_and(f64::is_finite)
    {
        Ok(text.to_string())
    } else {
        Err(bad(format!("점수는 숫자여야 합니다: {text}")))
    }
}

/// A stream entry id `ms-seq` as its two numbers.
fn stream_id(id: &str) -> Option<(u64, u64)> {
    let (ms, seq) = id.split_once('-')?;
    Some((ms.parse().ok()?, seq.parse().ok()?))
}

/// The id right after `id`, to start the next page of XRANGE from.
pub(super) fn id_after(id: &str) -> Option<String> {
    let (ms, seq) = stream_id(id)?;
    Some(match seq.checked_add(1) {
        Some(seq) => format!("{ms}-{seq}"),
        None => format!("{}-0", ms.checked_add(1)?),
    })
}

/// The id right before `id`, to start the next page of XREVRANGE from.
pub(super) fn id_before(id: &str) -> Option<String> {
    let (ms, seq) = stream_id(id)?;
    Some(match seq.checked_sub(1) {
        Some(seq) => format!("{ms}-{seq}"),
        None => format!("{}-{}", ms.checked_sub(1)?, u64::MAX),
    })
}

/// Stream entries from an XRANGE reply: `[id, [field, value, …]]` each.
fn stream_entries(value: Value) -> Vec<StreamEntry> {
    reply::items(value)
        .into_iter()
        .filter_map(|entry| {
            let mut parts = reply::items(entry).into_iter();
            let id = reply::text(parts.next()?)?;
            let fields = parts
                .next()
                .map(reply::pairs)
                .unwrap_or_default()
                .into_iter()
                .filter_map(|(field, value)| {
                    Some((Bin(reply::bytes(field)?), Bin(reply::bytes(value)?)))
                })
                .collect();
            Some(StreamEntry { id, fields })
        })
        .collect()
}

/// Members and scores from ZRANGE … WITHSCORES or ZSCAN.
fn zset_entries(value: Value) -> Vec<ZsetEntry> {
    reply::pairs(value)
        .into_iter()
        .filter_map(|(member, score)| {
            Some(ZsetEntry {
                member: Bin(reply::bytes(member)?),
                score: reply::text(score)?,
            })
        })
        .collect()
}

impl RedisDriver {
    /// Sends one command to `db` and logs it. A broken connection is
    /// dropped (the next command opens another); with `retry` a read is
    /// sent once more on a new one.
    pub(super) async fn command(
        &self,
        db: u32,
        line: &Line,
        retry: bool,
    ) -> Result<Value, EngineError> {
        self.log.record_command(&line.text());
        self.send(db, line, retry).await
    }

    /// `command` without the log line: the browser's reads and polls,
    /// which would bury the console's own commands (docs/engines/redis.md §4).
    pub(super) async fn send(
        &self,
        db: u32,
        line: &Line,
        retry: bool,
    ) -> Result<Value, EngineError> {
        let cmd = line.cmd();
        let mut conn = self.conn(db).await?;
        match cmd.query_async::<Value>(&mut conn).await {
            Ok(value) => Ok(value),
            Err(err) if broken(&err) => {
                self.forget(db).await;
                if !retry {
                    return Err(engine_error(err));
                }
                let mut conn = self.conn(db).await?;
                cmd.query_async::<Value>(&mut conn)
                    .await
                    .map_err(engine_error)
            }
            Err(err) => Err(engine_error(err)),
        }
    }

    /// A write from the page: logged, and once it went through, in History.
    async fn write(&self, db: u32, line: &Line) -> Result<Value, EngineError> {
        self.refuse_on_replica()?;
        let started = Instant::now();
        let value = self.command(db, line, false).await?;
        self.changed(line.text(), started);
        Ok(value)
    }

    /// Several writes as one MULTI … EXEC: each logged, one History entry.
    async fn write_all(&self, db: u32, lines: &[Line]) -> Result<Vec<Value>, EngineError> {
        self.refuse_on_replica()?;
        let started = Instant::now();
        self.log.record_command("MULTI");
        for line in lines {
            self.log.record_command(&line.text());
        }
        self.log.record_command("EXEC");
        let mut conn = self.conn(db).await?;
        let values = match transaction(lines)
            .query_async::<Vec<Value>>(&mut conn)
            .await
        {
            Ok(values) => values,
            Err(err) => {
                if broken(&err) {
                    self.forget(db).await;
                }
                return Err(engine_error(err));
            }
        };
        for value in &values {
            if let Value::ServerError(err) = value {
                return Err(reply::driver_error(match err.details() {
                    Some(detail) => format!("{} {detail}", err.code()),
                    None => err.code().to_string(),
                }));
            }
        }
        let text = std::iter::once("MULTI".to_string())
            .chain(lines.iter().map(Line::text))
            .chain(std::iter::once("EXEC".to_string()))
            .collect::<Vec<_>>()
            .join("\n");
        self.changed(text, started);
        Ok(values)
    }

    fn changed(&self, sql: String, started: Instant) {
        self.log.changed(
            Change {
                sql,
                ms: started.elapsed().as_millis() as u64,
                rows: 1,
            },
            false,
        );
    }

    fn refuse_on_replica(&self) -> Result<(), EngineError> {
        if self.facts.read_only {
            return Err(bad(
                "읽기 전용 복제 서버(replica)라 바꿀 수 없습니다. 마스터에 접속하세요",
            ));
        }
        Ok(())
    }

    /// TYPE of a key, "none" when it is gone.
    async fn type_of(&self, db: u32, key: &Bin) -> Result<String, EngineError> {
        let value = self
            .send(db, &Line::new("TYPE").arg(key.as_bytes()), true)
            .await?;
        Ok(reply::text(value).unwrap_or_else(|| "none".into()))
    }

    /// A key must exist (and, with `kind`, be of that type) before a change.
    async fn expect_type(&self, db: u32, key: &Bin, kind: &str) -> Result<(), EngineError> {
        let found = self.type_of(db, key).await?;
        if found == "none" {
            return Err(not_found());
        }
        if found != kind {
            return Err(bad(format!(
                "키의 타입이 {found}입니다 ({kind}을(를) 기대했습니다)"
            )));
        }
        Ok(())
    }

    async fn int(&self, db: u32, line: &Line) -> Result<i64, EngineError> {
        let value = self.send(db, line, true).await?;
        reply::int(&value).ok_or_else(|| reply::driver_error("정수 응답을 기대했습니다"))
    }

    /// One SCAN-family walk (SCAN, HSCAN, SSCAN, ZSCAN) from `cursor`
    /// until `want` elements, the end, or SCAN_BUDGET; `line` writes the
    /// command for a cursor.
    async fn scan_walk(
        &self,
        db: u32,
        line: impl Fn(&str) -> Line + Send + Sync,
        cursor: String,
        want: usize,
    ) -> Result<(String, Vec<Value>), EngineError> {
        let started = Instant::now();
        let mut cursor = cursor;
        let mut found = Vec::new();
        loop {
            let line = line(&cursor);
            let value = self.send(db, &line, true).await?;
            let (next, elements) = reply::scan_reply(value);
            found.extend(elements);
            cursor = next;
            if cursor == "0" || found.len() >= want || started.elapsed() > SCAN_BUDGET {
                return Ok((cursor, found));
            }
        }
    }
}

/// `head cursor [MATCH pattern] COUNT hint [TYPE kind]`.
fn scan_line(
    head: &Line,
    cursor: &str,
    pattern: Option<&Bin>,
    hint: usize,
    kind: Option<&str>,
) -> Line {
    let mut line = head.clone().arg(cursor);
    if let Some(pattern) = pattern {
        line = line.arg("MATCH").arg(pattern.as_bytes());
    }
    line = line.arg("COUNT").num(hint);
    if let Some(kind) = kind {
        line = line.arg("TYPE").arg(kind);
    }
    line
}

#[async_trait]
impl KeyValueDriver for RedisDriver {
    async fn databases(&self) -> Result<Databases, EngineError> {
        let keyspace = self
            .send(self.db, &Line::new("INFO").arg("keyspace"), true)
            .await
            .map(reply::text)?
            .unwrap_or_default();
        let size = self.int(self.db, &Line::new("DBSIZE")).await?;
        Ok(Databases {
            databases: self.database_list(&keyspace),
            current: self.db,
            size: u64::try_from(size).unwrap_or(0),
        })
    }

    async fn overview(&self) -> Result<Overview, EngineError> {
        let text = self
            .send(self.db, &Line::new("INFO"), true)
            .await
            .map(reply::text)?
            .unwrap_or_default();
        let number = |key: &str| {
            reply::info_field(&text, key)
                .and_then(|value| value.trim().parse::<u64>().ok())
                .unwrap_or(0)
        };
        let databases = self.database_list(&text);
        Ok(Overview {
            flavor: self.facts.flavor.to_ascii_lowercase(),
            version: self.facts.version.clone(),
            used_memory: number("used_memory"),
            ops_per_sec: number("instantaneous_ops_per_sec"),
            connected_clients: number("connected_clients"),
            keys_total: databases.iter().map(|db| db.keys).sum(),
            current: self.db,
            databases,
        })
    }

    async fn scan(&self, req: &ScanRequest) -> Result<ScanPage, EngineError> {
        let want = req.count.clamp(1, MAX_PAGE) as usize;
        let kind = req
            .kind
            .as_deref()
            .map(str::trim)
            .filter(|kind| !kind.is_empty());
        // A pattern may match few keys per step: bigger steps then.
        let hint = if req.pattern.is_some() || kind.is_some() {
            1_000
        } else {
            want.min(1_000)
        };
        let (cursor, found) = self
            .scan_walk(
                req.db,
                |cursor| {
                    scan_line(
                        &Line::new("SCAN"),
                        cursor,
                        req.pattern.as_ref().filter(|pattern| !pattern.is_empty()),
                        hint,
                        kind,
                    )
                },
                cursor_of(Some(&req.cursor))?,
                want,
            )
            .await?;
        let mut seen = HashSet::new();
        let names: Vec<Vec<u8>> = found
            .into_iter()
            .filter_map(reply::bytes)
            .filter(|key| seen.insert(key.clone()))
            .collect();
        let keys = match kind {
            Some(kind) => names
                .into_iter()
                .map(|key| ScanKey {
                    key: Bin(key),
                    kind: kind.to_string(),
                })
                .collect(),
            None if names.is_empty() => Vec::new(),
            None => {
                // Each key's type in one round trip, not logged one by one.
                let mut pipe = ::redis::pipe();
                for key in &names {
                    pipe.cmd("TYPE").arg(key.as_slice());
                }
                let mut conn = self.conn(req.db).await?;
                let types = pipe
                    .query_async::<Vec<Value>>(&mut conn)
                    .await
                    .map_err(engine_error)?;
                names
                    .into_iter()
                    .zip(types)
                    .filter_map(|(key, kind)| {
                        let kind = reply::text(kind)?;
                        (kind != "none").then_some(ScanKey {
                            key: Bin(key),
                            kind,
                        })
                    })
                    .collect()
            }
        };
        Ok(ScanPage { cursor, keys })
    }

    async fn keys_meta(&self, req: &KeysMetaRequest) -> Result<Vec<KeyMeta>, EngineError> {
        if req.keys.len() > KEYS_META_LIMIT {
            return Err(bad(format!(
                "키는 한 번에 {KEYS_META_LIMIT}개까지 물을 수 있습니다"
            )));
        }
        if req.keys.is_empty() {
            return Ok(Vec::new());
        }
        // PTTL and MEMORY USAGE of each key in one round trip; a refused
        // MEMORY (ACL, a proxy) leaves its size unknown.
        let mut pipe = ::redis::pipe();
        pipe.ignore_errors();
        for key in &req.keys {
            pipe.cmd("PTTL").arg(key.as_bytes());
            pipe.cmd("MEMORY").arg("USAGE").arg(key.as_bytes());
        }
        let mut conn = self.conn(req.db).await?;
        let replies = match pipe
            .query_async::<Vec<::redis::RedisResult<Value>>>(&mut conn)
            .await
        {
            Ok(replies) => replies,
            Err(err) => {
                if broken(&err) {
                    self.forget(req.db).await;
                }
                return Err(engine_error(err));
            }
        };
        let mut replies = replies.into_iter();
        Ok(req
            .keys
            .iter()
            .map(|key| {
                let ttl = replies.next().and_then(Result::ok);
                let memory = replies.next().and_then(Result::ok);
                KeyMeta {
                    key: key.clone(),
                    ttl_ms: ttl.as_ref().and_then(reply::int).unwrap_or(-2),
                    memory: memory
                        .as_ref()
                        .and_then(reply::int)
                        .and_then(|bytes| u64::try_from(bytes).ok()),
                }
            })
            .collect())
    }

    async fn key_info(&self, key: &KeyRef) -> Result<KeyInfo, EngineError> {
        let kind = self.type_of(key.db, &key.key).await?;
        if kind == "none" {
            return Ok(KeyInfo {
                exists: false,
                kind,
                ttl_ms: -2,
                memory: None,
                encoding: None,
                length: None,
            });
        }
        let k = key.key.as_bytes();
        let ttl_ms = self.int(key.db, &Line::new("PTTL").arg(k)).await?;
        // Both may be refused by the account's ACL, or missing on a proxy.
        let memory = self
            .send(key.db, &Line::new("MEMORY").arg("USAGE").arg(k), true)
            .await
            .ok()
            .and_then(|value| reply::int(&value))
            .and_then(|bytes| u64::try_from(bytes).ok());
        let encoding = self
            .send(key.db, &Line::new("OBJECT").arg("ENCODING").arg(k), true)
            .await
            .ok()
            .and_then(reply::text);
        let length = match kind.as_str() {
            "string" => Some("STRLEN"),
            "hash" => Some("HLEN"),
            "list" => Some("LLEN"),
            "set" => Some("SCARD"),
            "zset" => Some("ZCARD"),
            "stream" => Some("XLEN"),
            _ => None,
        };
        let length = match length {
            Some(name) => self
                .int(key.db, &Line::new(name).arg(k))
                .await
                .ok()
                .and_then(|length| u64::try_from(length).ok()),
            None => None,
        };
        Ok(KeyInfo {
            exists: true,
            kind,
            ttl_ms,
            memory,
            encoding,
            length,
        })
    }

    async fn read(&self, req: &ReadRequest) -> Result<KeyPage, EngineError> {
        let db = req.db;
        let k = req.key.as_bytes();
        let count = req.count.clamp(1, MAX_PAGE) as usize;
        let pattern = req.pattern.as_ref().filter(|pattern| !pattern.is_empty());
        let kind = self.type_of(db, &req.key).await?;
        Ok(match kind.as_str() {
            "none" => return Err(not_found()),
            "string" => {
                let total =
                    u64::try_from(self.int(db, &Line::new("STRLEN").arg(k)).await?).unwrap_or(0);
                let max = req.max_bytes.unwrap_or(STRING_FIRST).clamp(1, STRING_MAX);
                let value = if total == 0 {
                    Vec::new()
                } else {
                    let end = total.min(max) - 1;
                    let value = self
                        .send(db, &Line::new("GETRANGE").arg(k).num(0).num(end), true)
                        .await?;
                    reply::bytes(value).unwrap_or_default()
                };
                KeyPage::String {
                    truncated: (value.len() as u64) < total,
                    value: Bin(value),
                    total,
                }
            }
            "hash" => {
                let total =
                    u64::try_from(self.int(db, &Line::new("HLEN").arg(k)).await?).unwrap_or(0);
                let (cursor, found) = self
                    .scan_walk(
                        db,
                        |cursor| {
                            scan_line(
                                &Line::new("HSCAN").arg(k),
                                cursor,
                                pattern,
                                count.min(1_000),
                                None,
                            )
                        },
                        cursor_of(req.cursor.as_deref())?,
                        count,
                    )
                    .await?;
                let entries = reply::pairs(Value::Array(found))
                    .into_iter()
                    .filter_map(|(field, value)| {
                        Some(HashEntry {
                            field: Bin(reply::bytes(field)?),
                            value: Bin(reply::bytes(value)?),
                        })
                    })
                    .collect();
                KeyPage::Hash {
                    entries,
                    cursor,
                    total,
                }
            }
            "list" => {
                let total =
                    u64::try_from(self.int(db, &Line::new("LLEN").arg(k)).await?).unwrap_or(0);
                let start = req.offset.min(total);
                let stop = start + count as u64 - 1;
                let value = self
                    .send(db, &Line::new("LRANGE").arg(k).num(start).num(stop), true)
                    .await?;
                let items = reply::items(value)
                    .into_iter()
                    .enumerate()
                    .filter_map(|(at, value)| {
                        Some(ListItem {
                            index: (start + at as u64) as i64,
                            value: Bin(reply::bytes(value)?),
                        })
                    })
                    .collect();
                KeyPage::List {
                    items,
                    offset: start,
                    total,
                }
            }
            "set" => {
                let total =
                    u64::try_from(self.int(db, &Line::new("SCARD").arg(k)).await?).unwrap_or(0);
                let (cursor, found) = self
                    .scan_walk(
                        db,
                        |cursor| {
                            scan_line(
                                &Line::new("SSCAN").arg(k),
                                cursor,
                                pattern,
                                count.min(1_000),
                                None,
                            )
                        },
                        cursor_of(req.cursor.as_deref())?,
                        count,
                    )
                    .await?;
                KeyPage::Set {
                    members: found
                        .into_iter()
                        .filter_map(reply::bytes)
                        .map(Bin)
                        .collect(),
                    cursor,
                    total,
                }
            }
            "zset" => {
                let total =
                    u64::try_from(self.int(db, &Line::new("ZCARD").arg(k)).await?).unwrap_or(0);
                if pattern.is_some() || req.cursor.is_some() {
                    let (cursor, found) = self
                        .scan_walk(
                            db,
                            |cursor| {
                                scan_line(
                                    &Line::new("ZSCAN").arg(k),
                                    cursor,
                                    pattern,
                                    count.min(1_000),
                                    None,
                                )
                            },
                            cursor_of(req.cursor.as_deref())?,
                            count,
                        )
                        .await?;
                    KeyPage::Zset {
                        entries: zset_entries(Value::Array(found)),
                        cursor: Some(cursor),
                        offset: 0,
                        total,
                    }
                } else {
                    let start = req.offset.min(total);
                    let stop = start + count as u64 - 1;
                    let line = Line::new(if req.rev { "ZREVRANGE" } else { "ZRANGE" })
                        .arg(k)
                        .num(start)
                        .num(stop)
                        .arg("WITHSCORES");
                    let value = self.send(db, &line, true).await?;
                    KeyPage::Zset {
                        entries: zset_entries(value),
                        cursor: None,
                        offset: start,
                        total,
                    }
                }
            }
            "stream" => {
                let total =
                    u64::try_from(self.int(db, &Line::new("XLEN").arg(k)).await?).unwrap_or(0);
                let from = req
                    .from
                    .as_deref()
                    .map(str::trim)
                    .filter(|from| !from.is_empty());
                let line = if req.rev {
                    Line::new("XREVRANGE")
                        .arg(k)
                        .arg(from.unwrap_or("+"))
                        .arg("-")
                } else {
                    Line::new("XRANGE").arg(k).arg(from.unwrap_or("-")).arg("+")
                }
                .arg("COUNT")
                .num(count);
                let entries = stream_entries(self.send(db, &line, true).await?);
                let next = if entries.len() < count {
                    None
                } else {
                    entries.last().and_then(|last| {
                        if req.rev {
                            id_before(&last.id)
                        } else {
                            id_after(&last.id)
                        }
                    })
                };
                KeyPage::Stream {
                    entries,
                    next,
                    total,
                }
            }
            "ReJSON-RL" => {
                let value = self.send(db, &Line::new("JSON.GET").arg(k), true).await?;
                KeyPage::Json {
                    text: reply::text(value).unwrap_or_else(|| "null".into()),
                }
            }
            other => KeyPage::Other {
                kind: other.to_string(),
            },
        })
    }

    async fn edit(&self, req: &EditRequest) -> Result<EditOutcome, EngineError> {
        let db = req.db;
        let key = &req.key;
        let k = key.as_bytes();
        let changed = |value: &Value| reply::int(value).unwrap_or(1);
        let outcome = |changed: i64| EditOutcome { changed, id: None };
        match &req.op {
            EditOp::SetString { value } => {
                self.expect_type(db, key, "string").await?;
                self.write(
                    db,
                    &Line::new("SET").arg(k).arg(value.as_bytes()).arg("KEEPTTL"),
                )
                .await?;
                Ok(outcome(1))
            }
            EditOp::HashSet {
                field,
                value,
                only_new,
            } => {
                self.expect_type(db, key, "hash").await?;
                let name = if *only_new { "HSETNX" } else { "HSET" };
                let reply = self
                    .write(
                        db,
                        &Line::new(name)
                            .arg(k)
                            .arg(field.as_bytes())
                            .arg(value.as_bytes()),
                    )
                    .await?;
                if *only_new && reply::int(&reply) == Some(0) {
                    return Err(bad(format!("필드가 이미 있습니다: {}", field.lossy())));
                }
                Ok(outcome(changed(&reply)))
            }
            EditOp::HashDelete { fields } => {
                if fields.is_empty() {
                    return Err(bad("지울 필드가 없습니다"));
                }
                let mut line = Line::new("HDEL").arg(k);
                for field in fields {
                    line = line.arg(field.as_bytes());
                }
                let reply = self.write(db, &line).await?;
                Ok(outcome(changed(&reply)))
            }
            EditOp::HashRename { field, to } => {
                self.expect_type(db, key, "hash").await?;
                if self
                    .int(db, &Line::new("HEXISTS").arg(k).arg(to.as_bytes()))
                    .await?
                    == 1
                {
                    return Err(bad(format!(
                        "같은 이름의 필드가 이미 있습니다: {}",
                        to.lossy()
                    )));
                }
                let value = self
                    .send(db, &Line::new("HGET").arg(k).arg(field.as_bytes()), true)
                    .await?;
                let Some(value) = reply::bytes(value) else {
                    return Err(bad(format!("필드가 없습니다: {}", field.lossy())));
                };
                self.write_all(
                    db,
                    &[
                        Line::new("HSET").arg(k).arg(to.as_bytes()).arg(&value),
                        Line::new("HDEL").arg(k).arg(field.as_bytes()),
                    ],
                )
                .await?;
                Ok(outcome(1))
            }
            EditOp::ListSet {
                index,
                value,
                expect,
            } => {
                self.expect_type(db, key, "list").await?;
                self.check_list_item(db, key, *index, expect.as_ref())
                    .await?;
                self.write(
                    db,
                    &Line::new("LSET").arg(k).num(index).arg(value.as_bytes()),
                )
                .await?;
                Ok(outcome(1))
            }
            EditOp::ListPush { values, head } => {
                if values.is_empty() {
                    return Err(bad("넣을 값이 없습니다"));
                }
                self.expect_type(db, key, "list").await?;
                let mut line = Line::new(if *head { "LPUSH" } else { "RPUSH" }).arg(k);
                for value in values {
                    line = line.arg(value.as_bytes());
                }
                let reply = self.write(db, &line).await?;
                Ok(outcome(changed(&reply)))
            }
            EditOp::ListRemove { index, expect } => {
                self.expect_type(db, key, "list").await?;
                self.check_list_item(db, key, *index, expect.as_ref())
                    .await?;
                // Redis removes list items by value only: the item becomes
                // a marker no other item holds, which LREM then takes out.
                let marker = format!("__tablepeek_removed__:{}", uuid::Uuid::new_v4());
                self.write_all(
                    db,
                    &[
                        Line::new("LSET").arg(k).num(index).arg(&marker),
                        Line::new("LREM").arg(k).num(1).arg(&marker),
                    ],
                )
                .await?;
                Ok(outcome(1))
            }
            EditOp::SetAdd { members } | EditOp::SetRemove { members } => {
                if members.is_empty() {
                    return Err(bad("멤버가 없습니다"));
                }
                let add = matches!(req.op, EditOp::SetAdd { .. });
                if add {
                    self.expect_type(db, key, "set").await?;
                }
                let mut line = Line::new(if add { "SADD" } else { "SREM" }).arg(k);
                for member in members {
                    line = line.arg(member.as_bytes());
                }
                let reply = self.write(db, &line).await?;
                Ok(outcome(changed(&reply)))
            }
            EditOp::SetReplace { member, to } => {
                self.expect_type(db, key, "set").await?;
                if self
                    .int(db, &Line::new("SISMEMBER").arg(k).arg(to.as_bytes()))
                    .await?
                    == 1
                {
                    return Err(bad(format!("같은 멤버가 이미 있습니다: {}", to.lossy())));
                }
                self.write_all(
                    db,
                    &[
                        Line::new("SREM").arg(k).arg(member.as_bytes()),
                        Line::new("SADD").arg(k).arg(to.as_bytes()),
                    ],
                )
                .await?;
                Ok(outcome(1))
            }
            EditOp::ZsetAdd {
                member,
                score,
                only_new,
            } => {
                self.expect_type(db, key, "zset").await?;
                let score = score_of(score)?;
                let mut line = Line::new("ZADD").arg(k);
                if *only_new {
                    line = line.arg("NX");
                }
                let reply = self
                    .write(db, &line.arg(&score).arg(member.as_bytes()))
                    .await?;
                if *only_new && reply::int(&reply) == Some(0) {
                    return Err(bad(format!(
                        "같은 멤버가 이미 있습니다: {}",
                        member.lossy()
                    )));
                }
                Ok(outcome(changed(&reply)))
            }
            EditOp::ZsetRemove { members } => {
                if members.is_empty() {
                    return Err(bad("멤버가 없습니다"));
                }
                let mut line = Line::new("ZREM").arg(k);
                for member in members {
                    line = line.arg(member.as_bytes());
                }
                let reply = self.write(db, &line).await?;
                Ok(outcome(changed(&reply)))
            }
            EditOp::ZsetRename { member, to, score } => {
                self.expect_type(db, key, "zset").await?;
                let score = score_of(score)?;
                if member != to {
                    let exists = self
                        .send(db, &Line::new("ZSCORE").arg(k).arg(to.as_bytes()), true)
                        .await?;
                    if exists != Value::Nil {
                        return Err(bad(format!("같은 멤버가 이미 있습니다: {}", to.lossy())));
                    }
                }
                self.write_all(
                    db,
                    &[
                        Line::new("ZREM").arg(k).arg(member.as_bytes()),
                        Line::new("ZADD").arg(k).arg(&score).arg(to.as_bytes()),
                    ],
                )
                .await?;
                Ok(outcome(1))
            }
            EditOp::StreamAdd { id, fields } => {
                if fields.is_empty() {
                    return Err(bad("항목에는 필드가 하나 이상 있어야 합니다"));
                }
                self.expect_type(db, key, "stream").await?;
                let id = id
                    .as_deref()
                    .map(str::trim)
                    .filter(|id| !id.is_empty())
                    .unwrap_or("*");
                let mut line = Line::new("XADD").arg(k).arg(id);
                for (field, value) in fields {
                    line = line.arg(field.as_bytes()).arg(value.as_bytes());
                }
                let reply = self.write(db, &line).await?;
                Ok(EditOutcome {
                    changed: 1,
                    id: reply::text(reply),
                })
            }
            EditOp::StreamDelete { ids } => {
                if ids.is_empty() {
                    return Err(bad("지울 항목이 없습니다"));
                }
                let mut line = Line::new("XDEL").arg(k);
                for id in ids {
                    line = line.arg(id);
                }
                let reply = self.write(db, &line).await?;
                Ok(outcome(changed(&reply)))
            }
            EditOp::JsonSet { path, value } => {
                serde_json::from_str::<serde_json::Value>(value)
                    .map_err(|err| bad(format!("JSON이 올바르지 않습니다: {err}")))?;
                let path = path
                    .as_deref()
                    .map(str::trim)
                    .filter(|path| !path.is_empty())
                    .unwrap_or("$");
                self.write(db, &Line::new("JSON.SET").arg(k).arg(path).arg(value))
                    .await?;
                Ok(outcome(1))
            }
            EditOp::Create {
                kind,
                value,
                field,
                score,
                fields,
                text,
                ttl_secs,
            } => {
                if self.int(db, &Line::new("EXISTS").arg(k)).await? > 0 {
                    return Err(bad(format!(
                        "같은 이름의 키가 이미 있습니다: {}",
                        key.lossy()
                    )));
                }
                let value = value.clone().unwrap_or_default();
                let first = match kind.as_str() {
                    "string" => Line::new("SET").arg(k).arg(value.as_bytes()).arg("NX"),
                    "hash" => {
                        let field = field
                            .as_ref()
                            .filter(|field| !field.is_empty())
                            .ok_or_else(|| bad("첫 필드 이름을 입력하세요"))?;
                        Line::new("HSET")
                            .arg(k)
                            .arg(field.as_bytes())
                            .arg(value.as_bytes())
                    }
                    "list" => Line::new("RPUSH").arg(k).arg(value.as_bytes()),
                    "set" => Line::new("SADD").arg(k).arg(value.as_bytes()),
                    "zset" => Line::new("ZADD")
                        .arg(k)
                        .arg(score_of(score.as_deref().unwrap_or("0"))?)
                        .arg(value.as_bytes()),
                    "stream" => {
                        if fields.is_empty() {
                            return Err(bad("항목에는 필드가 하나 이상 있어야 합니다"));
                        }
                        let mut line = Line::new("XADD").arg(k).arg("*");
                        for (field, value) in fields {
                            line = line.arg(field.as_bytes()).arg(value.as_bytes());
                        }
                        line
                    }
                    "json" | "ReJSON-RL" => {
                        let text = text.as_deref().unwrap_or("{}");
                        serde_json::from_str::<serde_json::Value>(text)
                            .map_err(|err| bad(format!("JSON이 올바르지 않습니다: {err}")))?;
                        Line::new("JSON.SET").arg(k).arg("$").arg(text).arg("NX")
                    }
                    other => return Err(bad(format!("만들 수 없는 타입입니다: {other}"))),
                };
                match ttl_secs.filter(|ttl| *ttl > 0) {
                    Some(ttl) => {
                        self.write_all(db, &[first, Line::new("EXPIRE").arg(k).num(ttl)])
                            .await?;
                    }
                    None => {
                        let reply = self.write(db, &first).await?;
                        if reply == Value::Nil {
                            return Err(bad(format!(
                                "같은 이름의 키가 이미 있습니다: {}",
                                key.lossy()
                            )));
                        }
                    }
                }
                Ok(outcome(1))
            }
            EditOp::Rename { to, overwrite } => {
                if to == key {
                    return Ok(outcome(0));
                }
                let reply = self
                    .write(
                        db,
                        &Line::new(if *overwrite { "RENAME" } else { "RENAMENX" })
                            .arg(k)
                            .arg(to.as_bytes()),
                    )
                    .await?;
                if !*overwrite && reply::int(&reply) == Some(0) {
                    return Err(bad(format!(
                        "같은 이름의 키가 이미 있습니다: {}",
                        to.lossy()
                    )));
                }
                Ok(outcome(1))
            }
            EditOp::Delete => {
                let reply = self.write(db, &Line::new("UNLINK").arg(k)).await?;
                Ok(outcome(changed(&reply)))
            }
            EditOp::Expire { ttl_ms } => {
                if *ttl_ms <= 0 {
                    return Err(bad("만료 시간은 0보다 커야 합니다"));
                }
                let reply = self
                    .write(db, &Line::new("PEXPIRE").arg(k).num(ttl_ms))
                    .await?;
                if reply::int(&reply) == Some(0) {
                    return Err(not_found());
                }
                Ok(outcome(1))
            }
            EditOp::Persist => {
                let reply = self.write(db, &Line::new("PERSIST").arg(k)).await?;
                Ok(outcome(changed(&reply)))
            }
        }
    }

    async fn classify(&self, line: &str, db: u32) -> Result<Classified, EngineError> {
        let args = split_args(line).map_err(bad)?;
        if args.is_empty() {
            return Err(bad("명령을 입력하세요"));
        }
        let name = command::command_name(&args);
        let (class, reason) = match kind_of(&args) {
            Kind::Refused(reason) => return Err(bad(reason)),
            Kind::Known(class, reason) => (class, reason),
            Kind::Keys => {
                let size = self.int(db, &Line::new("DBSIZE")).await.unwrap_or(0);
                if size > KEYS_BIG_DB as i64 {
                    (
                        CommandClass::Danger,
                        Some(format!(
                            "키 {size}개를 한 번에 훑는 동안 서버가 다른 명령을 받지 않습니다 (SCAN을 쓰세요)"
                        )),
                    )
                } else {
                    (CommandClass::Read, None)
                }
            }
            Kind::Unknown => (self.command_class(&name).await, None),
        };
        Ok(Classified {
            class,
            command: name,
            reason,
        })
    }

    async fn console(&self, req: &ConsoleRequest) -> Result<ConsoleReply, EngineError> {
        let classified = self.classify(&req.line, req.db).await?;
        let args = split_args(&req.line).map_err(bad)?;
        let line = Line::from_args(args);
        let text = line.text();
        let select = classified.command == "SELECT";
        let mut guard = self.console.lock().await;
        // The console's connection, opened on first use, in the tab's
        // database (SELECT'd there when another tab moved it). One that was
        // killed (CLIENT KILL from Server › Clients, a timeout) is opened
        // again: that only resets the CLI.
        let mut fresh = guard.is_none();
        if let Some(console) = guard.as_mut() {
            if console.db != req.db {
                match ::redis::cmd("SELECT")
                    .arg(req.db)
                    .query_async::<Value>(&mut console.conn)
                    .await
                {
                    Ok(_) => console.db = req.db,
                    Err(err) if broken(&err) => fresh = true,
                    Err(err) => return Err(engine_error(err)),
                }
            } else if ::redis::cmd("PING")
                .query_async::<Value>(&mut console.conn)
                .await
                .is_err_and(|err| broken(&err))
            {
                fresh = true;
            }
        }
        if fresh {
            let (conn, id) = self.connect(req.db, super::Role::Cli).await?;
            *guard = Some(super::ConsoleConn {
                id,
                conn,
                db: req.db,
            });
        }
        let Some(console) = guard.as_mut() else {
            return Err(EngineError::Internal("콘솔 연결이 없습니다".into()));
        };
        let stopped = self.console_stop.notified();
        tokio::pin!(stopped);
        stopped.as_mut().enable();
        if let Ok(mut busy) = self.console_busy.lock() {
            *busy = Some(console.id.unwrap_or(-1));
        }
        self.log.record_command(&text);
        let started = Instant::now();
        let cmd = line.cmd();
        let result = tokio::select! {
            result = cmd.query_async::<Value>(&mut console.conn) => Some(result),
            () = &mut stopped => None,
        };
        if let Ok(mut busy) = self.console_busy.lock() {
            *busy = None;
        }
        let elapsed_ms = started.elapsed().as_millis() as u64;
        let reply = match result {
            None => {
                // Stopped: the connection goes, and the server is told to
                // drop the command it may still be blocked in.
                let id = console.id;
                *guard = None;
                if let Some(id) = id {
                    let _ = self
                        .send(
                            self.db,
                            &Line::new("CLIENT").arg("KILL").arg("ID").num(id),
                            false,
                        )
                        .await;
                }
                return Err(EngineError::Driver {
                    engine: "redis",
                    code: None,
                    message: "명령을 멈췄습니다".into(),
                    interrupted: true,
                    fields: Box::default(),
                });
            }
            Some(Ok(value)) => {
                if select {
                    if let Some(db) = line
                        .0
                        .get(1)
                        .and_then(|db| std::str::from_utf8(db).ok()?.parse().ok())
                    {
                        console.db = db;
                    }
                }
                if classified.class != CommandClass::Read {
                    self.changed(text, started);
                }
                reply::reply_of(value)
            }
            Some(Err(err)) if broken(&err) => {
                *guard = None;
                return Err(engine_error(err));
            }
            Some(Err(err)) => Reply::Error(match (err.code(), err.detail()) {
                (Some(code), Some(detail)) => format!("{code} {detail}"),
                (Some(code), None) => code.to_string(),
                _ => err.to_string(),
            }),
        };
        let db = guard.as_ref().map_or(req.db, |console| console.db);
        Ok(ConsoleReply {
            reply,
            db,
            elapsed_ms,
            class: classified.class,
        })
    }

    fn stop_console(&self) {
        let busy = self.console_busy.lock().ok().and_then(|busy| *busy);
        if busy.is_some() {
            self.console_stop.notify_waiters();
        }
    }

    async fn info(&self, section: Option<&str>) -> Result<Vec<InfoSection>, EngineError> {
        let mut line = Line::new("INFO");
        if let Some(section) = section.map(str::trim).filter(|section| !section.is_empty()) {
            line = line.arg(section);
        }
        let text = self
            .send(self.db, &line, true)
            .await
            .map(reply::text)?
            .unwrap_or_default();
        Ok(reply::info_sections(&text))
    }

    async fn slowlog(&self, count: u32) -> Result<Vec<SlowEntry>, EngineError> {
        let value = self
            .send(
                self.db,
                &Line::new("SLOWLOG").arg("GET").num(count.clamp(1, 1_000)),
                true,
            )
            .await?;
        Ok(reply::items(value)
            .into_iter()
            .filter_map(|entry| {
                let parts = reply::items(entry);
                Some(SlowEntry {
                    id: reply::int(parts.first()?)?,
                    at: reply::int(parts.get(1)?)?,
                    duration_us: reply::int(parts.get(2)?)?,
                    args: parts
                        .get(3)
                        .cloned()
                        .map(reply::items)
                        .unwrap_or_default()
                        .into_iter()
                        .filter_map(reply::bytes)
                        .map(Bin)
                        .collect(),
                    client: parts
                        .get(4)
                        .cloned()
                        .and_then(reply::text)
                        .filter(|text| !text.is_empty()),
                    client_name: parts
                        .get(5)
                        .cloned()
                        .and_then(reply::text)
                        .filter(|text| !text.is_empty()),
                })
            })
            .collect())
    }

    async fn slowlog_reset(&self) -> Result<(), EngineError> {
        self.command(self.db, &Line::new("SLOWLOG").arg("RESET"), false)
            .await
            .map(|_| ())
    }

    async fn kill_client(&self, id: &str) -> Result<(), EngineError> {
        let id: i64 = id
            .trim()
            .parse()
            .map_err(|_| bad(format!("클라이언트 id는 숫자입니다: {id}")))?;
        let value = self
            .command(
                self.db,
                &Line::new("CLIENT").arg("KILL").arg("ID").num(id),
                false,
            )
            .await?;
        if reply::int(&value) == Some(0) {
            return Err(EngineError::SessionNotFound);
        }
        Ok(())
    }

    async fn export(&self, req: &ExportRequest) -> Result<FileStream, EngineError> {
        let json = match req.format.as_str() {
            "json" => true,
            "text" => false,
            other => {
                return Err(bad(format!(
                    "내보내기 형식은 json 또는 text입니다: {other}"
                )))
            }
        };
        let kind = self.type_of(req.db, &req.key).await?;
        if kind == "none" {
            return Err(not_found());
        }
        let ttl_ms = self
            .int(req.db, &Line::new("PTTL").arg(req.key.as_bytes()))
            .await?;
        let conn = self.conn(req.db).await?;
        let (sender, receiver) = tokio::sync::mpsc::channel(4);
        let key = req.key.clone();
        tokio::spawn(async move {
            let failed = sender.clone();
            let exporter = Exporter {
                conn,
                key,
                sender,
                json,
            };
            if let Err(err) = exporter.run(&kind, ttl_ms).await {
                let _ = failed.send(Err(err)).await;
            }
        });
        let mut receiver = receiver;
        Ok(Box::pin(futures_util::stream::poll_fn(move |cx| {
            receiver.poll_recv(cx)
        })))
    }
}

impl RedisDriver {
    /// Every database with the key and expiry counts the INFO text's
    /// keyspace lines give (`db0:keys=…,expires=…`), empty ones too: as
    /// many as `CONFIG GET databases` said, else 16, or as many as INFO
    /// shows in use.
    fn database_list(&self, info: &str) -> Vec<KvDatabase> {
        let counts = reply::keyspace(info);
        let highest = counts.keys().next_back().map_or(0, |index| index + 1);
        let total = self
            .facts
            .databases
            .unwrap_or(16)
            .max(highest)
            .max(self.db + 1)
            .min(10_000);
        (0..total)
            .map(|index| {
                let (keys, expires) = counts.get(&index).copied().unwrap_or((0, 0));
                KvDatabase {
                    index,
                    keys,
                    expires,
                }
            })
            .collect()
    }

    /// A list item the page last read must still be there before it is
    /// changed or removed.
    async fn check_list_item(
        &self,
        db: u32,
        key: &Bin,
        index: i64,
        expect: Option<&Bin>,
    ) -> Result<(), EngineError> {
        let Some(expect) = expect else {
            return Ok(());
        };
        let value = self
            .send(
                db,
                &Line::new("LINDEX").arg(key.as_bytes()).num(index),
                true,
            )
            .await?;
        if reply::bytes(value).as_deref() != Some(expect.as_bytes()) {
            return Err(bad(format!(
                "{index}번 항목이 읽은 뒤에 바뀌었습니다. 다시 불러온 뒤 고치세요"
            )));
        }
        Ok(())
    }

    /// How a command the lists don't know acts, by COMMAND INFO's flags
    /// (a module's command, a newer one): a write unless it says it only
    /// reads.
    async fn command_class(&self, name: &str) -> CommandClass {
        let first = name.split(' ').next().unwrap_or(name).to_ascii_lowercase();
        if let Some(class) = self
            .command_classes
            .lock()
            .ok()
            .and_then(|known| known.get(&first).copied())
        {
            return class;
        }
        let flags: Vec<String> = match self
            .send(self.db, &Line::new("COMMAND").arg("INFO").arg(&first), true)
            .await
        {
            Ok(value) => reply::items(value)
                .into_iter()
                .next()
                .map(reply::items)
                .and_then(|info| info.into_iter().nth(2))
                .map(reply::items)
                .unwrap_or_default()
                .into_iter()
                .filter_map(reply::text)
                .collect(),
            Err(_) => Vec::new(),
        };
        let class = if flags.iter().any(|flag| flag == "readonly")
            && !flags.iter().any(|flag| flag == "write")
        {
            CommandClass::Read
        } else {
            CommandClass::Write
        };
        if let Ok(mut known) = self.command_classes.lock() {
            known.insert(first, class);
        }
        class
    }
}

/// Writes one key's whole value to the export's channel, a page at a time.
struct Exporter {
    conn: MultiplexedConnection,
    key: Bin,
    sender: tokio::sync::mpsc::Sender<Result<Vec<u8>, EngineError>>,
    json: bool,
}

/// `value` as JSON text (a string, or `{"b64": …}`).
fn json_text(value: &impl serde::Serialize) -> Vec<u8> {
    serde_json::to_vec(value).unwrap_or_default()
}

/// A hash field as a JSON object's name: itself when UTF-8, else as
/// redis-cli quotes it.
fn json_name(bytes: &[u8]) -> Vec<u8> {
    match std::str::from_utf8(bytes) {
        Ok(text) => json_text(&text),
        Err(_) => json_text(&quote_arg(bytes)),
    }
}

impl Exporter {
    async fn call(&mut self, line: Line) -> Result<Value, EngineError> {
        tokio::time::timeout(
            RESPONSE_TIMEOUT,
            line.cmd().query_async::<Value>(&mut self.conn),
        )
        .await
        .map_err(|_| reply::driver_error("서버가 응답하지 않습니다 (시간 초과)"))?
        .map_err(engine_error)
    }

    /// Sends a chunk; false once the reader went away.
    async fn put(&self, chunk: Vec<u8>) -> bool {
        self.sender.send(Ok(chunk)).await.is_ok()
    }

    async fn run(mut self, kind: &str, ttl_ms: i64) -> Result<(), EngineError> {
        let k = self.key.0.clone();
        if self.json {
            let mut head = b"{\"key\":".to_vec();
            head.extend(json_text(&self.key));
            head.extend(b",\"type\":");
            head.extend(json_text(&kind));
            head.extend(format!(",\"ttl_ms\":{ttl_ms},\"value\":").into_bytes());
            if !self.put(head).await {
                return Ok(());
            }
        }
        match kind {
            "string" => {
                let total =
                    reply::int(&self.call(Line::new("STRLEN").arg(&k)).await?).unwrap_or(0) as u64;
                let mut all = Vec::new();
                let mut at = 0;
                while at < total {
                    let end = (at + EXPORT_CHUNK).min(total) - 1;
                    let bytes = reply::bytes(
                        self.call(Line::new("GETRANGE").arg(&k).num(at).num(end))
                            .await?,
                    )
                    .unwrap_or_default();
                    if bytes.is_empty() {
                        break;
                    }
                    at += bytes.len() as u64;
                    if self.json {
                        all.extend(bytes);
                    } else if !self.put(bytes).await {
                        return Ok(());
                    }
                }
                if self.json && !self.put(json_text(&Bin(all))).await {
                    return Ok(());
                }
            }
            "hash" | "set" => {
                let hash = kind == "hash";
                let open: &[u8] = if self.json {
                    if hash {
                        b"{"
                    } else {
                        b"["
                    }
                } else {
                    b""
                };
                if !self.put(open.to_vec()).await {
                    return Ok(());
                }
                let mut cursor = "0".to_string();
                let mut first = true;
                loop {
                    let line = Line::new(if hash { "HSCAN" } else { "SSCAN" })
                        .arg(&k)
                        .arg(&cursor)
                        .arg("COUNT")
                        .num(EXPORT_PAGE);
                    let (next, found) = reply::scan_reply(self.call(line).await?);
                    let mut chunk = Vec::new();
                    if hash {
                        for (field, value) in reply::pairs(Value::Array(found)) {
                            let (Some(field), Some(value)) =
                                (reply::bytes(field), reply::bytes(value))
                            else {
                                continue;
                            };
                            if self.json {
                                if !first {
                                    chunk.push(b',');
                                }
                                chunk.extend(json_name(&field));
                                chunk.push(b':');
                                chunk.extend(json_text(&Bin(value)));
                            } else {
                                chunk.extend(field);
                                chunk.push(b'\t');
                                chunk.extend(value);
                                chunk.push(b'\n');
                            }
                            first = false;
                        }
                    } else {
                        for member in found.into_iter().filter_map(reply::bytes) {
                            if self.json {
                                if !first {
                                    chunk.push(b',');
                                }
                                chunk.extend(json_text(&Bin(member)));
                            } else {
                                chunk.extend(member);
                                chunk.push(b'\n');
                            }
                            first = false;
                        }
                    }
                    if !chunk.is_empty() && !self.put(chunk).await {
                        return Ok(());
                    }
                    cursor = next;
                    if cursor == "0" {
                        break;
                    }
                }
                if self.json
                    && !self
                        .put(if hash { b"}".to_vec() } else { b"]".to_vec() })
                        .await
                {
                    return Ok(());
                }
            }
            "list" | "zset" => {
                let list = kind == "list";
                if self.json && !self.put(b"[".to_vec()).await {
                    return Ok(());
                }
                let mut start = 0usize;
                loop {
                    let stop = start + EXPORT_PAGE - 1;
                    let line = if list {
                        Line::new("LRANGE").arg(&k).num(start).num(stop)
                    } else {
                        Line::new("ZRANGE")
                            .arg(&k)
                            .num(start)
                            .num(stop)
                            .arg("WITHSCORES")
                    };
                    let value = self.call(line).await?;
                    let mut chunk = Vec::new();
                    let read = if list {
                        let items: Vec<Vec<u8>> = reply::items(value)
                            .into_iter()
                            .filter_map(reply::bytes)
                            .collect();
                        for (at, item) in items.iter().enumerate() {
                            if self.json {
                                if start + at > 0 {
                                    chunk.push(b',');
                                }
                                chunk.extend(json_text(&Bin(item.clone())));
                            } else {
                                chunk.extend(item);
                                chunk.push(b'\n');
                            }
                        }
                        items.len()
                    } else {
                        let entries = zset_entries(value);
                        for (at, entry) in entries.iter().enumerate() {
                            if self.json {
                                if start + at > 0 {
                                    chunk.push(b',');
                                }
                                let score = entry
                                    .score
                                    .parse::<f64>()
                                    .ok()
                                    .filter(|score| score.is_finite())
                                    .map(|score| json_text(&score))
                                    .unwrap_or_else(|| json_text(&entry.score));
                                chunk.extend(b"{\"member\":");
                                chunk.extend(json_text(&entry.member));
                                chunk.extend(b",\"score\":");
                                chunk.extend(score);
                                chunk.push(b'}');
                            } else {
                                chunk.extend(entry.score.as_bytes());
                                chunk.push(b'\t');
                                chunk.extend(entry.member.as_bytes());
                                chunk.push(b'\n');
                            }
                        }
                        entries.len()
                    };
                    if !chunk.is_empty() && !self.put(chunk).await {
                        return Ok(());
                    }
                    if read < EXPORT_PAGE {
                        break;
                    }
                    start += read;
                }
                if self.json && !self.put(b"]".to_vec()).await {
                    return Ok(());
                }
            }
            "stream" => {
                if self.json && !self.put(b"[".to_vec()).await {
                    return Ok(());
                }
                let mut from = "-".to_string();
                let mut first = true;
                loop {
                    let line = Line::new("XRANGE")
                        .arg(&k)
                        .arg(&from)
                        .arg("+")
                        .arg("COUNT")
                        .num(EXPORT_PAGE);
                    let entries = stream_entries(self.call(line).await?);
                    let mut chunk = Vec::new();
                    for entry in &entries {
                        if self.json {
                            if !first {
                                chunk.push(b',');
                            }
                            chunk.extend(b"{\"id\":");
                            chunk.extend(json_text(&entry.id));
                            chunk.extend(b",\"fields\":{");
                            for (at, (field, value)) in entry.fields.iter().enumerate() {
                                if at > 0 {
                                    chunk.push(b',');
                                }
                                chunk.extend(json_name(field.as_bytes()));
                                chunk.push(b':');
                                chunk.extend(json_text(value));
                            }
                            chunk.extend(b"}}");
                        } else {
                            chunk.extend(entry.id.as_bytes());
                            for (field, value) in &entry.fields {
                                chunk.push(b'\t');
                                chunk.extend(field.as_bytes());
                                chunk.push(b'=');
                                chunk.extend(value.as_bytes());
                            }
                            chunk.push(b'\n');
                        }
                        first = false;
                    }
                    if !chunk.is_empty() && !self.put(chunk).await {
                        return Ok(());
                    }
                    match entries.last().and_then(|last| id_after(&last.id)) {
                        Some(next) if entries.len() == EXPORT_PAGE => from = next,
                        _ => break,
                    }
                }
                if self.json && !self.put(b"]".to_vec()).await {
                    return Ok(());
                }
            }
            "ReJSON-RL" => {
                let text = reply::text(self.call(Line::new("JSON.GET").arg(&k)).await?)
                    .unwrap_or_else(|| "null".into());
                if !self.put(text.into_bytes()).await {
                    return Ok(());
                }
            }
            other => {
                return Err(bad(format!("{other} 타입의 키는 내보낼 수 없습니다")));
            }
        }
        if self.json {
            let _ = self.put(b"}\n".to_vec()).await;
        }
        Ok(())
    }
}
