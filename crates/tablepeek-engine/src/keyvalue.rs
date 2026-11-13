//! The operations of a key-value store (Redis, Valkey): keys found by an
//! incremental scan rather than listed, each holding a value of its own type
//! (string, hash, list, set, sorted set, stream, a module's type), read a
//! page at a time. An engine of this paradigm answers `Driver::keyvalue()`
//! with itself. The request and reply shapes are the `/api/kv/*` bodies
//! (docs/engines/redis.md §4). Only changes and console commands are
//! logged; the browser's reads are not.
//!
//! Keys, fields, members and values are binary-safe: on the wire they are
//! a JSON string when they are UTF-8 and `{"b64": "…"}` otherwise (`Bin`),
//! both ways.

use async_trait::async_trait;
use base64::Engine as _;
use serde::de::{self, Deserializer};
use serde::ser::{SerializeMap, Serializer};
use serde::{Deserialize, Serialize};

use crate::driver::FileStream;
use crate::EngineError;

/// Bytes as they travel to and from the page: UTF-8 text as a JSON string,
/// anything else as `{"b64": "…"}`. The page may also send `{"hex": "…"}`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct Bin(pub Vec<u8>);

impl Bin {
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// The bytes as text, invalid UTF-8 as U+FFFD: for messages and logs.
    pub fn lossy(&self) -> std::borrow::Cow<'_, str> {
        String::from_utf8_lossy(&self.0)
    }
}

impl From<&str> for Bin {
    fn from(text: &str) -> Self {
        Bin(text.as_bytes().to_vec())
    }
}

impl From<Vec<u8>> for Bin {
    fn from(bytes: Vec<u8>) -> Self {
        Bin(bytes)
    }
}

impl Serialize for Bin {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match std::str::from_utf8(&self.0) {
            Ok(text) => serializer.serialize_str(text),
            Err(_) => {
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry(
                    "b64",
                    &base64::engine::general_purpose::STANDARD.encode(&self.0),
                )?;
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for Bin {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(untagged)]
        enum Wire {
            Text(String),
            Encoded {
                #[serde(default)]
                b64: Option<String>,
                #[serde(default)]
                hex: Option<String>,
            },
        }
        match Wire::deserialize(deserializer)? {
            Wire::Text(text) => Ok(Bin(text.into_bytes())),
            Wire::Encoded { b64: Some(b64), .. } => base64::engine::general_purpose::STANDARD
                .decode(b64.trim())
                .map(Bin)
                .map_err(|err| de::Error::custom(format!("b64 값이 올바르지 않습니다: {err}"))),
            Wire::Encoded { hex: Some(hex), .. } => parse_hex(&hex)
                .map(Bin)
                .ok_or_else(|| de::Error::custom("hex 값이 올바르지 않습니다")),
            Wire::Encoded { .. } => Err(de::Error::custom(
                "문자열 또는 {\"b64\": …}·{\"hex\": …}이어야 합니다",
            )),
        }
    }
}

/// Hex digits (spaces and `0x` allowed) as bytes; None for anything else.
pub fn parse_hex(text: &str) -> Option<Vec<u8>> {
    let digits: String = text
        .trim()
        .trim_start_matches("0x")
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect();
    if !digits.len().is_multiple_of(2) {
        return None;
    }
    (0..digits.len())
        .step_by(2)
        .map(|at| u8::from_str_radix(digits.get(at..at + 2)?, 16).ok())
        .collect()
}

/// One logical database (`SELECT n`) and what INFO keyspace says of it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KvDatabase {
    pub index: u32,
    pub keys: u64,
    pub expires: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Databases {
    /// Every database the server has (`CONFIG GET databases`, 16 when the
    /// account may not read it), with its key count.
    pub databases: Vec<KvDatabase>,
    /// The one the connection works in.
    pub current: u32,
    /// The current database's key count (DBSIZE).
    pub size: u64,
}

/// `/api/kv/keys/meta`: the expiry and size of up to `KEYS_META_LIMIT`
/// keys of the key list, in one round trip.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeysMetaRequest {
    #[serde(default)]
    pub db: u32,
    pub keys: Vec<Bin>,
}

/// The most keys one `/api/kv/keys/meta` request may name.
pub const KEYS_META_LIMIT: usize = 500;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyMeta {
    pub key: Bin,
    /// PTTL: -1 without an expiry, -2 when the key is gone.
    pub ttl_ms: i64,
    /// MEMORY USAGE (Redis's default sampling), when the account may run it.
    pub memory: Option<u64>,
}

/// The database overview the workbench's header shows, from one INFO.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Overview {
    /// "redis" or "valkey".
    pub flavor: String,
    pub version: String,
    /// Bytes (`used_memory`).
    pub used_memory: u64,
    /// `instantaneous_ops_per_sec`.
    pub ops_per_sec: u64,
    pub connected_clients: u64,
    /// Keys over every database.
    pub keys_total: u64,
    /// The database the connection works in.
    pub current: u32,
    /// Every database, empty ones too.
    pub databases: Vec<KvDatabase>,
}

fn default_scan_count() -> u32 {
    500
}

/// One step of the key browser's SCAN: from `cursor` ("0" to start),
/// keys matching `pattern` (a glob, all keys without one) and of `type`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanRequest {
    #[serde(default)]
    pub db: u32,
    #[serde(default)]
    pub cursor: String,
    #[serde(default)]
    pub pattern: Option<Bin>,
    #[serde(default, rename = "type")]
    pub kind: Option<String>,
    /// How many keys to gather before answering (the server may give a
    /// few more or, when its time is up, fewer).
    #[serde(default = "default_scan_count")]
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanKey {
    pub key: Bin,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanPage {
    /// Where the next step starts; "0" once every key was visited.
    pub cursor: String,
    pub keys: Vec<ScanKey>,
}

/// A key of a database.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyRef {
    #[serde(default)]
    pub db: u32,
    pub key: Bin,
}

/// What the key view shows about a key before its value.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyInfo {
    pub exists: bool,
    /// TYPE's answer ("string", "hash", … "ReJSON-RL" for a module's).
    #[serde(rename = "type")]
    pub kind: String,
    /// Milliseconds left (PTTL); -1 without an expiry.
    pub ttl_ms: i64,
    /// MEMORY USAGE, when the account may run it.
    pub memory: Option<u64>,
    /// OBJECT ENCODING, when the account may run it.
    pub encoding: Option<String>,
    /// Bytes of a string, fields of a hash, items of a list, members of a
    /// set or sorted set, entries of a stream.
    pub length: Option<u64>,
}

fn default_page_count() -> u32 {
    200
}

/// A page of a key's value. Which fields count depends on the type: hash,
/// set and (with `pattern`) sorted set pages go by `cursor`; list and
/// sorted set pages by `offset`; stream pages from the entry id `from`;
/// a string's first `max_bytes`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadRequest {
    #[serde(default)]
    pub db: u32,
    pub key: Bin,
    #[serde(default)]
    pub cursor: Option<String>,
    #[serde(default)]
    pub offset: u64,
    #[serde(default = "default_page_count")]
    pub count: u32,
    #[serde(default)]
    pub pattern: Option<Bin>,
    /// Highest first: sorted sets by score, streams by id.
    #[serde(default)]
    pub rev: bool,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub max_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HashEntry {
    pub field: Bin,
    pub value: Bin,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListItem {
    pub index: i64,
    pub value: Bin,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZsetEntry {
    pub member: Bin,
    /// As the server writes it ("1.5", "inf"), so no precision is lost.
    pub score: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamEntry {
    pub id: String,
    pub fields: Vec<(Bin, Bin)>,
}

/// A page of a key's value, tagged with the key's type.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum KeyPage {
    String {
        value: Bin,
        /// STRLEN: the whole value's size.
        total: u64,
        truncated: bool,
    },
    Hash {
        entries: Vec<HashEntry>,
        cursor: String,
        total: u64,
    },
    List {
        items: Vec<ListItem>,
        offset: u64,
        total: u64,
    },
    Set {
        members: Vec<Bin>,
        cursor: String,
        total: u64,
    },
    Zset {
        entries: Vec<ZsetEntry>,
        /// Set when the page went by SCAN (a pattern), else None.
        cursor: Option<String>,
        offset: u64,
        total: u64,
    },
    Stream {
        entries: Vec<StreamEntry>,
        /// The id the next page starts after; None at the end.
        next: Option<String>,
        total: u64,
    },
    Json {
        /// JSON.GET's answer, as text.
        text: String,
    },
    /// A module's type the page can't show (or a key gone meanwhile).
    Other { kind: String },
}

/// A change to one key. Each carries what it needs; a value the page last
/// read (`expect`) makes the change fail when the key holds another now.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum EditOp {
    /// A string's value, keeping its expiry.
    SetString {
        value: Bin,
    },
    /// A hash field; with `only_new` it must not exist yet.
    HashSet {
        field: Bin,
        value: Bin,
        #[serde(default)]
        only_new: bool,
    },
    HashDelete {
        fields: Vec<Bin>,
    },
    /// A field renamed, its value kept, in one transaction.
    HashRename {
        field: Bin,
        to: Bin,
    },
    ListSet {
        index: i64,
        value: Bin,
        #[serde(default)]
        expect: Option<Bin>,
    },
    ListPush {
        values: Vec<Bin>,
        /// At the head (LPUSH) rather than the tail (RPUSH).
        #[serde(default)]
        head: bool,
    },
    /// The item at `index`, only while it still holds `expect`.
    ListRemove {
        index: i64,
        #[serde(default)]
        expect: Option<Bin>,
    },
    SetAdd {
        members: Vec<Bin>,
    },
    SetRemove {
        members: Vec<Bin>,
    },
    /// A member replaced by another, in one transaction.
    SetReplace {
        member: Bin,
        to: Bin,
    },
    /// A member's score (adding it unless `only_existing`); with
    /// `only_new` it must not be a member yet.
    ZsetAdd {
        member: Bin,
        score: String,
        #[serde(default)]
        only_new: bool,
    },
    ZsetRemove {
        members: Vec<Bin>,
    },
    /// A member renamed with its score, in one transaction.
    ZsetRename {
        member: Bin,
        to: Bin,
        score: String,
    },
    /// XADD; `id` "*" (or none) lets the server pick it.
    StreamAdd {
        #[serde(default)]
        id: Option<String>,
        fields: Vec<(Bin, Bin)>,
    },
    StreamDelete {
        ids: Vec<String>,
    },
    /// JSON.SET at `path` ("$" for the whole document).
    JsonSet {
        #[serde(default)]
        path: Option<String>,
        value: String,
    },
    /// A new key of `kind` with a first value; fails if the key exists.
    Create {
        kind: String,
        #[serde(default)]
        value: Option<Bin>,
        #[serde(default)]
        field: Option<Bin>,
        #[serde(default)]
        score: Option<String>,
        #[serde(default)]
        fields: Vec<(Bin, Bin)>,
        #[serde(default)]
        text: Option<String>,
        /// An expiry for it, in seconds.
        #[serde(default)]
        ttl_secs: Option<i64>,
    },
    /// RENAMENX, or RENAME with `overwrite`.
    Rename {
        to: Bin,
        #[serde(default)]
        overwrite: bool,
    },
    /// UNLINK.
    Delete,
    /// PEXPIRE.
    Expire {
        ttl_ms: i64,
    },
    Persist,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EditRequest {
    #[serde(default)]
    pub db: u32,
    pub key: Bin,
    #[serde(flatten)]
    pub op: EditOp,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EditOutcome {
    /// What the command said it changed (fields added, members removed, …).
    pub changed: i64,
    /// The id a stream entry got.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

/// How a console command acts, so safe mode knows whether to ask.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CommandClass {
    Read,
    Write,
    /// Destructive or server-wide (FLUSHALL, CONFIG SET, SHUTDOWN, a DEL
    /// of many keys, KEYS on a big database): asked for even in safe mode 1.
    Danger,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Classified {
    pub class: CommandClass,
    /// The command's name as the server knows it ("CONFIG SET").
    pub command: String,
    /// Why it is dangerous, for the confirmation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsoleRequest {
    /// The database the console tab is in.
    #[serde(default)]
    pub db: u32,
    /// One command as redis-cli takes it (quoted arguments, `\x..` escapes).
    pub line: String,
    #[serde(default)]
    pub confirmed: bool,
}

/// A reply as the server typed it (RESP3 where the server speaks it).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", content = "v", rename_all = "lowercase")]
pub enum Reply {
    Nil,
    Int(i64),
    Bulk(Bin),
    /// A simple string ("OK", "PONG").
    Status(String),
    /// Written as the server sent it ("3.14", "inf").
    Double(String),
    Bool(bool),
    Verbatim {
        format: String,
        text: String,
    },
    /// A number past 64 bits, in decimal.
    Bignum(String),
    Array(Vec<Reply>),
    Set(Vec<Reply>),
    Map(Vec<(Reply, Reply)>),
    Push {
        kind: String,
        data: Vec<Reply>,
    },
    Error(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsoleReply {
    pub reply: Reply,
    /// The database the console is in after the command (SELECT moves it).
    pub db: u32,
    pub elapsed_ms: u64,
    pub class: CommandClass,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InfoSection {
    pub name: String,
    pub entries: Vec<(String, String)>,
}

/// One SLOWLOG entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlowEntry {
    pub id: i64,
    /// Unix seconds.
    pub at: i64,
    pub duration_us: i64,
    pub args: Vec<Bin>,
    pub client: Option<String>,
    pub client_name: Option<String>,
}

/// `/api/kv/export`: a key's whole value as "json" (an object with the
/// key's type, expiry and value) or "text" (the value as a file: a
/// string's bytes, one line per item otherwise).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportRequest {
    #[serde(default)]
    pub db: u32,
    pub key: Bin,
    #[serde(default = "default_export_format")]
    pub format: String,
}

fn default_export_format() -> String {
    "json".into()
}

#[async_trait]
pub trait KeyValueDriver: Send + Sync {
    /// Every database with its key count, and the connection's.
    async fn databases(&self) -> Result<Databases, EngineError>;
    /// The header's numbers: version, memory, load, clients, key counts.
    async fn overview(&self) -> Result<Overview, EngineError>;
    async fn scan(&self, req: &ScanRequest) -> Result<ScanPage, EngineError>;
    /// Expiry and size of the key list's visible keys, in the order asked.
    async fn keys_meta(&self, req: &KeysMetaRequest) -> Result<Vec<KeyMeta>, EngineError>;
    async fn key_info(&self, key: &KeyRef) -> Result<KeyInfo, EngineError>;
    async fn read(&self, req: &ReadRequest) -> Result<KeyPage, EngineError>;
    async fn edit(&self, req: &EditRequest) -> Result<EditOutcome, EngineError>;
    /// How `line` would act; an error for a line that can't be sent from
    /// the console (unbalanced quotes, a subscription).
    async fn classify(&self, line: &str, db: u32) -> Result<Classified, EngineError>;
    /// Runs one console command. The caller has checked the class: a
    /// dangerous one only once confirmed.
    async fn console(&self, req: &ConsoleRequest) -> Result<ConsoleReply, EngineError>;
    /// Stops the console command running now (a BLPOP waiting, say).
    fn stop_console(&self);
    /// INFO, in sections; `section` for one ("keyspace"), all without.
    async fn info(&self, section: Option<&str>) -> Result<Vec<InfoSection>, EngineError>;
    async fn slowlog(&self, count: u32) -> Result<Vec<SlowEntry>, EngineError>;
    async fn slowlog_reset(&self) -> Result<(), EngineError>;
    /// CLIENT KILL ID: the sessions of the server info tab.
    async fn kill_client(&self, id: &str) -> Result<(), EngineError>;
    async fn export(&self, req: &ExportRequest) -> Result<FileStream, EngineError>;
}
