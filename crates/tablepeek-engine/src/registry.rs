//! Every engine TablePeek knows. Adding one is a folder under `engines/` and
//! a line in `factories()`; the server and the page read everything else
//! (label, form, capabilities) from the engine's descriptor.

use std::sync::Arc;

use async_trait::async_trait;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use tablepeek_types::{Capabilities, ConnConfig};

use crate::driver::Driver;
use crate::engines;
use crate::sql_log::SqlLog;
use crate::EngineError;

/// An engine as the page and the server see it, read from the engine's
/// `descriptor.json` and sent as-is by `GET /api/engines`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineDescriptor {
    /// The name saved profiles, the API and keychain accounts use. Never changes.
    pub id: String,
    /// URL schemes and older names that also mean this engine.
    #[serde(default)]
    pub aliases: Vec<String>,
    pub label: String,
    /// "sql", "document", …: which workbench the page opens.
    pub paradigm: String,
    /// Engines sharing a dialect (cockroach is "postgres").
    pub family: String,
    /// "server", "file" or "memory".
    pub transport: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_port: Option<u16>,
    #[serde(default)]
    pub url_schemes: Vec<String>,
    /// When set, a database error with a code reaches the page as
    /// `{prefix}_{code}` (`mongo_11000`) with the database's own message,
    /// rather than as `{id}_error`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code_prefix: Option<String>,
    pub capabilities: Capabilities,
    pub connection: ConnectionForm,
}

/// The connect form, drawn by the page from its fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionForm {
    pub fields: Vec<FieldSpec>,
    /// Tunnel kinds the engine can go through ("ssh", "http"); empty for none.
    #[serde(default)]
    pub tunnels: Vec<String>,
    /// The address line Home shows, with `{key}` standing for config values.
    pub summary: String,
    /// The full address, shown when the pointer rests on the address line;
    /// also the label of a connection opened without a saved name.
    pub detail: String,
}

/// One field of the connect form. The server reads only what it needs
/// (key, type, whether it is required); how the page draws it (label,
/// options, visible_when, …) passes through untouched.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FieldSpec {
    pub key: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub required: bool,
    #[serde(flatten)]
    pub ui: serde_json::Map<String, Value>,
}

impl FieldSpec {
    /// Kept in the keychain, never on disk or in responses.
    pub fn is_secret(&self) -> bool {
        self.kind == "secret"
    }
}

impl EngineDescriptor {
    /// The keys of the secret fields, first one first: its keychain account
    /// is `conn:{id}:{engine}`, the others' `conn:{id}:{engine}:{key}`.
    pub fn secret_keys(&self) -> impl Iterator<Item = &str> {
        self.connection
            .fields
            .iter()
            .filter(|field| field.is_secret())
            .map(|field| field.key.as_str())
    }

    /// The full address of `config` (the detail template); see `render`.
    pub fn detail(&self, config: &ConnConfig) -> String {
        self.render(&self.connection.detail, config)
    }

    /// `template` with each `{key}` replaced by its value in `config` (a
    /// missing one by the field's default, or nothing).
    pub fn render(&self, template: &str, config: &ConnConfig) -> String {
        let mut out = String::with_capacity(template.len());
        let mut rest = template;
        while let Some(open) = rest.find('{') {
            out.push_str(&rest[..open]);
            let after = &rest[open + 1..];
            let Some(close) = after.find('}') else {
                out.push_str(&rest[open..]);
                return out;
            };
            let key = &after[..close];
            let value = config.get(key).or_else(|| {
                self.connection
                    .fields
                    .iter()
                    .find(|field| field.key == key)
                    .and_then(|field| field.ui.get("default"))
            });
            match value {
                Some(Value::String(text)) => out.push_str(text),
                Some(Value::Null) | None => {}
                Some(other) => out.push_str(&other.to_string()),
            }
            rest = &after[close + 1..];
        }
        out.push_str(rest);
        out
    }
}

impl EngineDescriptor {
    /// Keys of the connection-string (`uri`) fields.
    fn uri_keys(&self) -> impl Iterator<Item = &str> {
        self.connection
            .fields
            .iter()
            .filter(|field| field.kind == "uri")
            .map(|field| field.key.as_str())
    }

    /// Takes the password out of every connection string in `config`
    /// (keeping its user), and, when the engine's first secret field is
    /// empty, moves it there: from then on it is a secret like any typed
    /// password, kept in the keychain or asked for on connect, never in a
    /// saved string.
    pub fn secure_config(&self, config: &mut ConnConfig) {
        let first_secret = self.secret_keys().next().map(str::to_string);
        for key in self.uri_keys() {
            let Some(Value::String(uri)) = config.get(key) else {
                continue;
            };
            let Some((stripped, password)) = split_uri_password(uri) else {
                continue;
            };
            config.insert(key.to_string(), Value::String(stripped));
            if let Some(secret) = &first_secret {
                let empty = config
                    .get(secret)
                    .and_then(Value::as_str)
                    .is_none_or(str::is_empty);
                if empty {
                    config.insert(secret.clone(), Value::String(password));
                }
            }
        }
    }

    /// `config` with the passwords of its connection strings removed, for
    /// showing or exporting a profile saved before they were taken out.
    pub fn without_uri_passwords(&self, config: &ConnConfig) -> ConnConfig {
        let mut shown = config.clone();
        for key in self.uri_keys() {
            if let Some(Value::String(uri)) = shown.get(key) {
                if let Some((stripped, _)) = split_uri_password(uri) {
                    shown.insert(key.to_string(), Value::String(stripped));
                }
            }
        }
        shown
    }
}

/// The userinfo of a URL (`scheme://user:password@host…`): where it sits in
/// `text`, as the byte range after `://` up to `@`. None without one.
fn userinfo_at(text: &str, scheme_end: usize) -> Option<(usize, usize)> {
    let start = scheme_end + 3;
    let authority_end = text[start..]
        .find(|ch: char| matches!(ch, '/' | '?' | '#' | '"' | '\'' | '`') || ch.is_whitespace())
        .map_or(text.len(), |end| start + end);
    let at = text[start..authority_end].rfind('@')? + start;
    Some((start, at))
}

/// A connection string without the password in its userinfo, and that
/// password decoded; None when it has none.
pub fn split_uri_password(uri: &str) -> Option<(String, String)> {
    let scheme_end = uri.find("://")?;
    let (start, at) = userinfo_at(uri, scheme_end)?;
    let (user, password) = uri[start..at].split_once(':')?;
    Some((
        format!("{}{user}{}", &uri[..start], &uri[at..]),
        percent_decode(password),
    ))
}

/// `text` with the password of every URL in it shown as `****`: for
/// messages and the console, where a driver may echo a connection string.
pub fn redact_uri_passwords(text: &str) -> String {
    if !text.contains("://") {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = 0;
    let mut search = 0;
    while let Some(found) = text[search..].find("://") {
        let scheme_end = search + found;
        search = scheme_end + 3;
        let Some((start, at)) = userinfo_at(text, scheme_end) else {
            continue;
        };
        if let Some(colon) = text[start..at].find(':') {
            out.push_str(&text[rest..start + colon + 1]);
            out.push_str("****");
            rest = at;
        }
        search = at;
    }
    out.push_str(&text[rest..]);
    out
}

/// `%XX` escapes decoded, as URLs write reserved characters.
pub(crate) fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(byte) = hex.and_then(|hex| u8::from_str_radix(hex, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Parses an engine's embedded `descriptor.json`. A broken one is a bug in
/// the build, caught by the registry's tests.
pub fn parse_descriptor(json: &str) -> EngineDescriptor {
    serde_json::from_str(json).unwrap_or_else(|err| panic!("엔진 정의를 읽을 수 없습니다: {err}"))
}

/// Why a connection's settings can't be used: an API error code and a
/// message for the user.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConfigProblem {
    pub code: &'static str,
    pub message: String,
}

impl ConfigProblem {
    pub fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "invalid_request",
            message: message.into(),
        }
    }
}

/// Where a connection actually goes once tunnels are open.
#[derive(Clone)]
pub enum NetRoute {
    /// To the address the settings name.
    Direct,
    /// Through a local tunnel end instead.
    Via { host: String, port: u16 },
    /// Through a tunnel that reaches any address behind it, for an engine
    /// that talks to several servers (a replica set's members) and opens a
    /// stream to each one it needs.
    Tunnel(Arc<dyn Forwarder>),
}

impl std::fmt::Debug for NetRoute {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NetRoute::Direct => f.write_str("Direct"),
            NetRoute::Via { host, port } => write!(f, "Via({host}:{port})"),
            NetRoute::Tunnel(_) => f.write_str("Tunnel"),
        }
    }
}

impl NetRoute {
    /// Points `host` and `port` at the tunnel, when there is one.
    pub fn apply(&self, host: &mut String, port: &mut u16) {
        if let NetRoute::Via {
            host: via_host,
            port: via_port,
        } = self
        {
            host.clone_from(via_host);
            *port = *via_port;
        }
    }
}

/// A byte stream through a tunnel to one address behind it.
pub trait TunnelStream: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send {}

impl<T: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send> TunnelStream for T {}

/// An open SSH or HTTP tunnel, able to reach any address behind it.
#[async_trait]
pub trait Forwarder: Send + Sync {
    /// A new stream to `host:port`, as the far end of the tunnel names it.
    async fn connect(&self, host: &str, port: u16) -> Result<Box<dyn TunnelStream>, String>;
}

/// Where an SSH or HTTP tunnel must lead.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TunnelTarget {
    /// One server: a local end leads to it (`NetRoute::Via`).
    Address(String, u16),
    /// Several servers, found only once connected (a seed list or an SRV
    /// name): the engine gets the tunnel itself (`NetRoute::Tunnel`).
    Members,
}

/// Makes connections of one engine.
#[async_trait]
pub trait DriverFactory: Send + Sync {
    fn descriptor(&self) -> &'static EngineDescriptor;

    /// Whether `config` can be connected with, before anything is opened.
    fn validate(&self, config: &ConnConfig) -> Result<(), ConfigProblem>;

    /// Fills in settings a profile saved by an earlier version lacks, as
    /// that version read their absence. Run on every profile read from the
    /// store and on every one saved; nothing by default.
    fn upgrade_config(&self, _config: &mut ConnConfig) {}

    /// Whether connecting with `config` takes the engine's password (its
    /// first secret): only then is a stored one read, or one asked for. By
    /// default whenever the engine has a secret.
    fn needs_password(&self, _config: &ConnConfig) -> bool {
        self.descriptor().secret_keys().next().is_some()
    }

    /// Where an SSH or HTTP tunnel must lead. By default the server the
    /// `host` and `port` keys name, the port falling back to the engine's
    /// default; an engine with no network address (a file) says why it
    /// can't be tunnelled.
    fn tunnel_target(&self, config: &ConnConfig) -> Result<TunnelTarget, ConfigProblem> {
        let descriptor = self.descriptor();
        let refused = || {
            ConfigProblem::invalid(format!(
                "{} 연결에는 SSH·HTTP 터널을 쓸 수 없습니다",
                descriptor.label
            ))
        };
        if descriptor.transport != "server" {
            return Err(refused());
        }
        let host = config
            .get("host")
            .and_then(Value::as_str)
            .filter(|host| !host.is_empty())
            .ok_or_else(refused)?;
        let port = config
            .get("port")
            .and_then(Value::as_u64)
            .and_then(|port| u16::try_from(port).ok())
            .or(descriptor.default_port)
            .ok_or_else(refused)?;
        Ok(TunnelTarget::Address(host.to_string(), port))
    }

    /// The connection's full address, shown as its label when it has no
    /// saved name: the descriptor's detail template by default.
    fn address(&self, config: &ConnConfig) -> String {
        self.descriptor().detail(config)
    }

    /// Opens a connection; statements it sends go to `log`.
    async fn connect(
        &self,
        config: &ConnConfig,
        net: &NetRoute,
        log: SqlLog,
    ) -> Result<Arc<dyn Driver>, EngineError>;
}

/// Every registered engine, in the order the page offers them. A new engine
/// is one line here.
static FACTORIES: [&dyn DriverFactory; 6] = [
    &engines::postgres::FACTORY,
    &engines::mysql::FACTORY,
    &engines::mssql::FACTORY,
    &engines::cockroach::FACTORY,
    &engines::sqlite::FACTORY,
    &engines::mongodb::FACTORY,
];

pub fn factories() -> &'static [&'static dyn DriverFactory] {
    &FACTORIES
}

/// The engine `id` names, by its id or one of its aliases.
pub fn factory(id: &str) -> Option<&'static dyn DriverFactory> {
    let id = id.trim();
    factories().iter().copied().find(|factory| {
        let descriptor = factory.descriptor();
        descriptor.id == id || descriptor.aliases.iter().any(|alias| alias == id)
    })
}

/// The engine `id` names, or the error every caller reports for one it
/// doesn't know.
pub fn require(id: &str) -> Result<&'static dyn DriverFactory, EngineError> {
    factory(id).ok_or_else(|| EngineError::UnknownEngine(id.to_string()))
}

/// The label an engine shows under, or its id when it isn't registered.
pub fn label(id: &str) -> &str {
    factory(id).map_or(id, |factory| factory.descriptor().label.as_str())
}

/// Shared by engines: `config` read as the engine's typed settings, with the
/// messages the server has always given for missing or malformed ones.
pub(crate) fn typed_config<T: DeserializeOwned>(
    descriptor: &EngineDescriptor,
    config: &ConnConfig,
) -> Result<T, ConfigProblem> {
    if config.is_empty() {
        return Err(ConfigProblem::invalid(format!(
            "{} 접속 정보가 없습니다",
            descriptor.label
        )));
    }
    serde_json::from_value(Value::Object(config.clone()))
        .map_err(|err| ConfigProblem::invalid(format!("접속 정보가 올바르지 않습니다 ({err})")))
}

/// Shared by server engines: the host must be an address only. A pasted URL
/// would otherwise be stored verbatim, password included.
pub(crate) fn check_host(host: &str) -> Result<(), ConfigProblem> {
    if host.contains("://")
        || host
            .chars()
            .any(|ch| ch.is_whitespace() || matches!(ch, '/' | '@' | '?'))
    {
        return Err(ConfigProblem::invalid(
            "호스트에는 주소만 입력하세요 (URL·계정 정보 제외)",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_descriptor_parses_and_ids_are_unique() {
        let mut names = std::collections::HashSet::new();
        for engine in factories() {
            let descriptor = engine.descriptor();
            assert!(names.insert(descriptor.id.clone()), "{}", descriptor.id);
            for alias in &descriptor.aliases {
                assert!(names.insert(alias.clone()), "{alias}");
            }
            assert!(!descriptor.connection.fields.is_empty());
            assert!(factory(&descriptor.id).is_some());
        }
    }

    #[test]
    fn aliases_find_their_engine_and_unknown_ids_fail() {
        assert_eq!(factory("mariadb").unwrap().descriptor().id, "mysql");
        assert_eq!(factory("postgresql").unwrap().descriptor().id, "postgres");
        assert!(factory("oracle").is_none());
        let err = require("oracle").err().unwrap();
        assert_eq!(err.to_string(), "지원하지 않는 엔진: oracle");
    }

    #[test]
    fn secrets_and_summary_come_from_the_descriptor() {
        let postgres = factory("postgres").unwrap().descriptor();
        assert_eq!(postgres.secret_keys().collect::<Vec<_>>(), vec!["password"]);
        let config = json!({ "host": "db", "port": 5432, "user": "app", "database": "main" });
        assert_eq!(
            postgres.detail(config.as_object().unwrap()),
            "app@db:5432/main"
        );
        assert_eq!(
            postgres.render(&postgres.connection.summary, config.as_object().unwrap()),
            "db : main"
        );
        let sqlite = factory("sqlite").unwrap().descriptor();
        assert_eq!(sqlite.secret_keys().count(), 0);
        let config = json!({ "path": "/tmp/a.db" });
        assert_eq!(sqlite.detail(config.as_object().unwrap()), "/tmp/a.db");
    }

    #[test]
    fn validation_keeps_the_old_messages() {
        let postgres = factory("postgres").unwrap();
        let empty = ConnConfig::new();
        assert_eq!(
            postgres.validate(&empty).unwrap_err().message,
            "PostgreSQL 접속 정보가 없습니다"
        );
        let pasted =
            json!({ "host": "postgres://u:pw@db/app", "port": 5432, "user": "u", "database": "d" });
        assert_eq!(
            postgres
                .validate(pasted.as_object().unwrap())
                .unwrap_err()
                .message,
            "호스트에는 주소만 입력하세요 (URL·계정 정보 제외)"
        );
        let bad_mode = json!({ "host": "h", "port": 3306, "user": "u", "database": "d", "ssl_mode": "verify-full" });
        assert!(factory("mysql")
            .unwrap()
            .validate(bad_mode.as_object().unwrap())
            .is_err());
        assert_eq!(
            factory("sqlite")
                .unwrap()
                .validate(&empty)
                .unwrap_err()
                .message,
            "SQLite 파일 경로를 입력하세요"
        );
    }

    #[test]
    fn connection_string_passwords_move_out() {
        assert_eq!(
            split_uri_password("mongodb://app:p%40ss@db:27017,b/shop?authSource=admin"),
            Some((
                "mongodb://app@db:27017,b/shop?authSource=admin".into(),
                "p@ss".into()
            ))
        );
        assert_eq!(split_uri_password("mongodb://app@db/shop"), None);
        assert_eq!(split_uri_password("mongodb://db/x?u=a@b"), None);

        let mongodb = factory("mongodb").unwrap().descriptor();
        let mut typed = json!({ "uri": "mongodb://app:s3cret@db/shop" });
        let typed = typed.as_object_mut().unwrap();
        mongodb.secure_config(typed);
        assert_eq!(typed["uri"], json!("mongodb://app@db/shop"));
        assert_eq!(typed["password"], json!("s3cret"));
        // A password typed in its own field wins; the string's still goes.
        let mut both = json!({ "uri": "mongodb://app:old@db", "password": "typed" });
        let both = both.as_object_mut().unwrap();
        mongodb.secure_config(both);
        assert_eq!(both["uri"], json!("mongodb://app@db"));
        assert_eq!(both["password"], json!("typed"));
        let shown = mongodb.without_uri_passwords(
            json!({ "uri": "mongodb+srv://u:pw@c.example.net" })
                .as_object()
                .unwrap(),
        );
        assert_eq!(shown["uri"], json!("mongodb+srv://u@c.example.net"));
        assert!(shown.get("password").is_none());
    }

    #[test]
    fn messages_never_show_url_passwords() {
        assert_eq!(
            redact_uri_passwords(
                "failed: mongodb://app:s3cret@db:27017/shop and 'postgres://u:pw@h/d' x://a@b"
            ),
            "failed: mongodb://app:****@db:27017/shop and 'postgres://u:****@h/d' x://a@b"
        );
        assert_eq!(redact_uri_passwords("no urls here"), "no urls here");
    }

    #[test]
    fn tunnel_target_reads_host_and_port() {
        let mssql = factory("mssql").unwrap();
        let config = json!({ "host": "sql", "port": 14330 });
        assert_eq!(
            mssql.tunnel_target(config.as_object().unwrap()),
            Ok(TunnelTarget::Address("sql".to_string(), 14330))
        );
        let sqlite = factory("sqlite").unwrap();
        let config = json!({ "path": "/tmp/a.db" });
        assert_eq!(
            sqlite
                .tunnel_target(config.as_object().unwrap())
                .unwrap_err()
                .message,
            "SQLite 연결에는 SSH·HTTP 터널을 쓸 수 없습니다"
        );
    }
}
