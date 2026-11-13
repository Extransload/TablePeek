//! Redis and Valkey, standalone servers (docs/engines/redis.md). One
//! multiplexed connection per database the page reads (the connection's own
//! first, others as key tabs of another database need them) carries the key
//! browser's and the key views' commands; the console has a connection of
//! its own, so a blocking command or a MULTI there holds up nothing else.
//! Edits and console commands go to the console log as redis-cli would
//! show them, and writes to History as well; the browser's own reads (scans,
//! pages, key facts, polls) are not logged.
//!
//! Redis Cluster and Sentinel are refused when connecting, with what to do
//! instead: a single connection would meet MOVED for most keys of a
//! cluster, and a sentinel holds no keys.

mod command;
#[cfg(test)]
mod live;
mod net;
mod ops;
mod reply;
#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex as StdMutex};
use std::time::Duration;

use ::redis::aio::MultiplexedConnection;
use ::redis::{AsyncConnectionConfig, ProtocolVersion, RedisConnectionInfo, Value};
use async_trait::async_trait;
use serde::{Deserialize, Deserializer};
use serde_json::Value as Json;
use tablepeek_types::{Capabilities, ConnConfig, EngineMeta, ServerInfo, ServerSession};

use crate::driver::{CancelRequest, Driver};
use crate::keyvalue::{CommandClass, KeyValueDriver};
use crate::registry::{
    check_host, parse_descriptor, percent_decode, typed_config, ConfigProblem, DriverFactory,
    EngineDescriptor, NetRoute, TunnelTarget,
};
use crate::sql_log::SqlLog;
use crate::EngineError;
use reply::{driver_error, engine_error};

pub struct Factory;

pub static FACTORY: Factory = Factory;

static DESCRIPTOR: LazyLock<EngineDescriptor> =
    LazyLock::new(|| parse_descriptor(include_str!("descriptor.json")));

const DEFAULT_PORT: u16 = 6379;

/// How long a browse or edit command may take before the page hears it
/// failed; the console's own connection waits as long as its command does.
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(60);

/// The connect form's values. Blank text counts as not given.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub(super) struct Settings {
    uri: Option<String>,
    host: Option<String>,
    port: Option<u16>,
    auth: Option<String>,
    user: Option<String>,
    password: Option<String>,
    #[serde(deserialize_with = "database_number")]
    database: Option<u32>,
    tls: bool,
    tls_ca_file: Option<String>,
    tls_client_cert: Option<String>,
    tls_client_key: Option<String>,
    tls_skip_verify: bool,
}

/// The database number as a number or as text (a database switch writes
/// it as text); blank is none.
fn database_number<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<u32>, D::Error> {
    match Option::<Json>::deserialize(deserializer)? {
        None | Some(Json::Null) => Ok(None),
        Some(Json::Number(number)) => number
            .as_u64()
            .and_then(|number| u32::try_from(number).ok())
            .map(Some)
            .ok_or_else(|| serde::de::Error::custom("데이터베이스 번호는 0 이상의 정수입니다")),
        Some(Json::String(text)) if text.trim().is_empty() => Ok(None),
        Some(Json::String(text)) => text
            .trim()
            .trim_start_matches("db")
            .parse()
            .map(Some)
            .map_err(|_| serde::de::Error::custom("데이터베이스 번호는 0 이상의 정수입니다")),
        Some(_) => Err(serde::de::Error::custom(
            "데이터베이스 번호는 0 이상의 정수입니다",
        )),
    }
}

fn given(value: &Option<String>) -> Option<&str> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// Where the server is and who the URL says logs in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Endpoint {
    tls: bool,
    host: String,
    port: u16,
    user: Option<String>,
    password: Option<String>,
    db: Option<u32>,
}

/// The server a `redis://` or `rediss://` URL names:
/// `redis[s]://[[user]:password@]host[:port][/db][?db=n]`.
pub(super) fn url_endpoint(url: &str) -> Result<Endpoint, ConfigProblem> {
    let bad =
        |what: &str| ConfigProblem::invalid(format!("연결 문자열이 올바르지 않습니다: {what}"));
    let (scheme, rest) = url
        .split_once("://")
        .ok_or_else(|| bad("redis:// 또는 rediss://로 시작해야 합니다"))?;
    let tls = match scheme.to_ascii_lowercase().as_str() {
        "redis" | "valkey" => false,
        "rediss" | "valkeys" => true,
        "unix" | "redis+unix" => {
            return Err(ConfigProblem::invalid(
                "유닉스 소켓 연결은 지원하지 않습니다. 호스트와 포트로 접속하세요",
            ))
        }
        _ => return Err(bad("redis:// 또는 rediss://로 시작해야 합니다")),
    };
    let (authority, tail) = match rest.find(['/', '?', '#']) {
        Some(at) => rest.split_at(at),
        None => (rest, ""),
    };
    let (userinfo, hostport) = match authority.rfind('@') {
        Some(at) => (Some(&authority[..at]), &authority[at + 1..]),
        None => (None, authority),
    };
    let (user, password) = match userinfo {
        Some(info) => match info.split_once(':') {
            Some((user, password)) => (
                Some(percent_decode(user)).filter(|user| !user.is_empty()),
                Some(percent_decode(password)).filter(|password| !password.is_empty()),
            ),
            None => (
                Some(percent_decode(info)).filter(|user| !user.is_empty()),
                None,
            ),
        },
        None => (None, None),
    };
    if hostport.contains(',') {
        return Err(bad(
            "주소는 하나만 쓸 수 있습니다 (Redis Cluster·Sentinel은 지원하지 않습니다)",
        ));
    }
    let (host, port) = if let Some(inner) = hostport.strip_prefix('[') {
        let (host, after) = inner
            .split_once(']')
            .ok_or_else(|| bad("IPv6 주소의 ]가 없습니다"))?;
        (host.to_string(), after.strip_prefix(':'))
    } else {
        match hostport.rsplit_once(':') {
            Some((host, port)) => (host.to_string(), Some(port)),
            None => (hostport.to_string(), None),
        }
    };
    if host.is_empty() {
        return Err(bad("호스트가 없습니다"));
    }
    let port = match port.filter(|port| !port.is_empty()) {
        Some(port) => port.parse().map_err(|_| bad("포트가 숫자가 아닙니다"))?,
        None => DEFAULT_PORT,
    };
    let (path, query) = match tail.split_once('?') {
        Some((path, query)) => (path, query),
        None => (tail, ""),
    };
    let path = path.split('#').next().unwrap_or_default().trim_matches('/');
    let mut db = if path.is_empty() {
        None
    } else {
        Some(
            path.parse()
                .map_err(|_| bad("데이터베이스 번호가 숫자가 아닙니다"))?,
        )
    };
    for pair in query.split('&') {
        if let Some(number) = pair.strip_prefix("db=") {
            db = Some(
                number
                    .parse()
                    .map_err(|_| bad("데이터베이스 번호가 숫자가 아닙니다"))?,
            );
        }
    }
    Ok(Endpoint {
        tls,
        host,
        port,
        user,
        password,
        db,
    })
}

impl Settings {
    /// Where to connect: the URL, else the host fields. The database field
    /// wins over the URL's (a database switch sets it).
    fn endpoint(&self) -> Result<Endpoint, ConfigProblem> {
        let mut endpoint = match given(&self.uri) {
            Some(uri) => {
                let mut endpoint = url_endpoint(uri)?;
                endpoint.tls |= self.tls;
                endpoint
            }
            None => {
                let host = given(&self.host).unwrap_or("127.0.0.1");
                check_host(host)?;
                Endpoint {
                    tls: self.tls,
                    host: host.trim_matches(['[', ']']).to_string(),
                    port: self.port.unwrap_or(DEFAULT_PORT),
                    user: None,
                    password: None,
                    db: None,
                }
            }
        };
        if self.database.is_some() {
            endpoint.db = self.database;
        }
        Ok(endpoint)
    }

    /// "password" or "none": as chosen, or for a profile without a choice
    /// a password login when a user or password is there.
    fn auth_kind(&self, endpoint: &Endpoint) -> Result<&'static str, ConfigProblem> {
        match given(&self.auth) {
            Some("none") => Ok("none"),
            Some("password") => Ok("password"),
            Some(other) => Err(ConfigProblem::invalid(format!(
                "지원하지 않는 인증 방식입니다: {other}"
            ))),
            None if given(&self.user).is_some()
                || given(&self.password).is_some()
                || endpoint.user.is_some()
                || endpoint.password.is_some() =>
            {
                Ok("password")
            }
            None => Ok("none"),
        }
    }

    /// The ACL user (None for the default user) and the password, once the
    /// password (the first secret) is in; None without a login.
    fn credentials(
        &self,
        endpoint: &Endpoint,
    ) -> Result<Option<(Option<String>, String)>, EngineError> {
        let kind = self
            .auth_kind(endpoint)
            .map_err(|problem| EngineError::BadRequest(problem.message))?;
        if kind == "none" {
            return Ok(None);
        }
        let user = given(&self.user)
            .map(str::to_string)
            .or_else(|| endpoint.user.clone());
        let password = given(&self.password)
            .map(str::to_string)
            .or_else(|| endpoint.password.clone())
            .ok_or_else(|| EngineError::BadRequest("비밀번호를 입력하세요".into()))?;
        Ok(Some((user, password)))
    }
}

/// The settings as the connection uses them, checked.
pub(super) fn settings(config: &ConnConfig) -> Result<(Settings, Endpoint), ConfigProblem> {
    let settings: Settings = typed_config(&DESCRIPTOR, config)?;
    let endpoint = settings.endpoint()?;
    settings.auth_kind(&endpoint)?;
    Ok((settings, endpoint))
}

/// The connection's address as a URL, without its password.
fn address_of(endpoint: &Endpoint, user: Option<&str>) -> String {
    let scheme = if endpoint.tls { "rediss" } else { "redis" };
    let host = if endpoint.host.contains(':') {
        format!("[{}]", endpoint.host)
    } else {
        endpoint.host.clone()
    };
    let user = user.map(|user| format!("{user}@")).unwrap_or_default();
    format!(
        "{scheme}://{user}{host}:{}/{}",
        endpoint.port,
        endpoint.db.unwrap_or(0)
    )
}

#[async_trait]
impl DriverFactory for Factory {
    fn descriptor(&self) -> &'static EngineDescriptor {
        &DESCRIPTOR
    }

    fn validate(&self, config: &ConnConfig) -> Result<(), ConfigProblem> {
        settings(config).map(|_| ())
    }

    /// A profile without an authentication choice gets the one its
    /// settings imply (see `Settings::auth_kind`).
    fn upgrade_config(&self, config: &mut ConnConfig) {
        if config.contains_key("auth") {
            return;
        }
        if let Ok((settings, endpoint)) = settings(config) {
            if let Ok(kind) = settings.auth_kind(&endpoint) {
                config.insert("auth".into(), Json::String(kind.into()));
            }
        }
    }

    fn needs_password(&self, config: &ConnConfig) -> bool {
        match settings(config) {
            Ok((settings, endpoint)) => settings.auth_kind(&endpoint) == Ok("password"),
            Err(_) => true,
        }
    }

    fn tunnel_target(&self, config: &ConnConfig) -> Result<TunnelTarget, ConfigProblem> {
        let (_, endpoint) = settings(config)?;
        Ok(TunnelTarget::Address(endpoint.host, endpoint.port))
    }

    fn address(&self, config: &ConnConfig) -> String {
        match settings(config) {
            Ok((settings, endpoint)) => {
                let user = given(&settings.user)
                    .map(str::to_string)
                    .or_else(|| endpoint.user.clone())
                    .filter(|_| settings.auth_kind(&endpoint) == Ok("password"));
                address_of(&endpoint, user.as_deref())
            }
            Err(_) => DESCRIPTOR.detail(config),
        }
    }

    async fn connect(
        &self,
        config: &ConnConfig,
        net: &NetRoute,
        log: SqlLog,
    ) -> Result<Arc<dyn Driver>, EngineError> {
        crate::ensure_crypto_provider();
        let (settings, endpoint) =
            settings(config).map_err(|problem| EngineError::BadRequest(problem.message))?;
        let credentials = settings.credentials(&endpoint)?;
        let target = net::Target::new(&settings, &endpoint.host, endpoint.port, endpoint.tls, net)?;
        let label = self.address(config);
        let driver =
            RedisDriver::open(target, credentials, endpoint.db.unwrap_or(0), label, log).await?;
        Ok(Arc::new(driver))
    }
}

/// What the server said about itself once connected.
#[derive(Debug, Clone, Default)]
pub(super) struct ServerFacts {
    /// "Redis" or "Valkey".
    flavor: &'static str,
    version: String,
    /// A replica that takes no writes.
    read_only: bool,
    /// `CONFIG GET databases`, read once; None where CONFIG is turned off
    /// (managed services).
    databases: Option<u32>,
}

/// The console's own connection, and the database it is in now.
struct ConsoleConn {
    conn: MultiplexedConnection,
    db: u32,
    /// CLIENT ID, to end a command stopped midway.
    id: Option<i64>,
}

pub(crate) struct RedisDriver {
    target: net::Target,
    info: RedisConnectionInfo,
    /// The database the connection works in (the profile's, or the one a
    /// database switch chose).
    db: u32,
    conns: tokio::sync::Mutex<HashMap<u32, MultiplexedConnection>>,
    console: tokio::sync::Mutex<Option<ConsoleConn>>,
    /// Woken by a stop: the console command running now gives up.
    console_stop: tokio::sync::Notify,
    /// CLIENT ID of the console connection while a command runs on it.
    console_busy: StdMutex<Option<i64>>,
    /// CLIENT IDs of the connections that serve the page's reads and
    /// edits: CLIENT LIST marks them current (they can't be killed from
    /// the page). The CLI's own connection is not among them.
    browse_ids: StdMutex<HashSet<i64>>,
    /// What COMMAND INFO said of commands the lists don't know.
    command_classes: StdMutex<HashMap<String, CommandClass>>,
    facts: ServerFacts,
    label: String,
    log: SqlLog,
}

impl RedisDriver {
    async fn open(
        target: net::Target,
        credentials: Option<(Option<String>, String)>,
        db: u32,
        label: String,
        log: SqlLog,
    ) -> Result<Self, EngineError> {
        let mut info = RedisConnectionInfo::default()
            .set_protocol(ProtocolVersion::RESP3)
            .set_lib_name("tablepeek", env!("CARGO_PKG_VERSION"));
        if let Some((user, password)) = credentials {
            if let Some(user) = user {
                info = info.set_username(user);
            }
            info = info.set_password(password);
        }
        let mut driver = Self {
            target,
            info,
            db,
            conns: tokio::sync::Mutex::new(HashMap::new()),
            console: tokio::sync::Mutex::new(None),
            console_stop: tokio::sync::Notify::new(),
            console_busy: StdMutex::new(None),
            browse_ids: StdMutex::new(HashSet::new()),
            command_classes: StdMutex::new(HashMap::new()),
            facts: ServerFacts::default(),
            label,
            log,
        };
        // RESP3 where the server speaks it (Redis 6 and later); RESP2 for
        // an older server or a proxy that only knows RESP2.
        let first = match driver.connect(db, Role::Browse).await {
            Ok((conn, _)) => conn,
            Err(err) if unknown_hello(&err) => {
                driver.info = driver.info.clone().set_protocol(ProtocolVersion::RESP2);
                driver.connect(db, Role::Browse).await?.0
            }
            Err(err) => return Err(err),
        };
        driver.conns.get_mut().insert(db, first.clone());
        driver.facts = driver.server_facts(first).await?;
        Ok(driver)
    }

    /// A new connection to `db`, logged in and named for CLIENT LIST
    /// (`tablepeek`, or `tablepeek-cli` for the CLI's), with its CLIENT ID.
    async fn connect(
        &self,
        db: u32,
        role: Role,
    ) -> Result<(MultiplexedConnection, Option<i64>), EngineError> {
        let stream = self.target.stream().await?;
        let info = self.info.clone().set_db(i64::from(db));
        // The CLI's command waits as long as it takes (BLPOP 0); the page's
        // reads and edits give up after RESPONSE_TIMEOUT.
        let response_timeout = match role {
            Role::Browse => Some(RESPONSE_TIMEOUT),
            Role::Cli => None,
        };
        let config = AsyncConnectionConfig::new()
            .set_response_timeout(response_timeout)
            .set_connection_timeout(None);
        let (mut conn, driver) = MultiplexedConnection::new_with_config(&info, stream, config)
            .await
            .map_err(|err| {
                if err.code() == Some("ERR")
                    && err
                        .detail()
                        .is_some_and(|detail| detail.contains("DB index is out of range"))
                {
                    driver_error(format!(
                        "데이터베이스 {db}이(가) 없습니다 (ERR DB index is out of range)"
                    ))
                } else {
                    engine_error(err)
                }
            })?;
        tokio::spawn(driver);
        // A name the ACL may refuse; the connection works without it.
        let _ = ::redis::cmd("CLIENT")
            .arg("SETNAME")
            .arg(role.name())
            .query_async::<Value>(&mut conn)
            .await;
        let id = ::redis::cmd("CLIENT")
            .arg("ID")
            .query_async::<Value>(&mut conn)
            .await
            .ok()
            .and_then(|value| reply::int(&value));
        if let (Role::Browse, Some(id)) = (role, id) {
            if let Ok(mut browse) = self.browse_ids.lock() {
                browse.insert(id);
            }
        }
        Ok((conn, id))
    }

    /// INFO server and replication: what the server is, and whether this
    /// connection can work with it at all.
    async fn server_facts(
        &self,
        mut conn: MultiplexedConnection,
    ) -> Result<ServerFacts, EngineError> {
        let text = ::redis::cmd("INFO")
            .query_async::<Value>(&mut conn)
            .await
            .map_err(engine_error)
            .map(reply::text)?
            .unwrap_or_default();
        let field = |key: &str| reply::info_field(&text, key).map(str::trim);
        match field("redis_mode").or_else(|| field("server_mode")) {
            Some("cluster") => {
                return Err(driver_error(
                    "Redis Cluster 모드의 서버입니다. TablePeek은 클러스터를 다루지 않아 대부분의 키에서 MOVED를 만나게 됩니다: 클러스터 모드가 꺼진 서버에 접속하세요",
                ))
            }
            Some("sentinel") => {
                return Err(driver_error(
                    "Redis Sentinel입니다. Sentinel은 키를 갖지 않습니다: Sentinel이 알려 주는 마스터(SENTINEL get-master-addr-by-name)에 직접 접속하세요",
                ))
            }
            _ => {}
        }
        let valkey = field("valkey_version").is_some() || field("server_name") == Some("valkey");
        let version = if valkey {
            field("valkey_version").or_else(|| field("redis_version"))
        } else {
            field("redis_version")
        }
        .unwrap_or_default()
        .to_string();
        let replica = matches!(field("role"), Some("slave" | "replica"));
        let mut read_only = false;
        if replica {
            // A replica takes writes only with replica-read-only off.
            read_only = true;
            if let Ok(value) = ::redis::cmd("CONFIG")
                .arg("GET")
                .arg("replica-read-only")
                .query_async::<Value>(&mut conn)
                .await
            {
                let values = reply::items(value);
                if values.len() >= 2 {
                    read_only = reply::text(values[1].clone()).as_deref() != Some("no");
                }
            }
        }
        let databases = match ::redis::cmd("CONFIG")
            .arg("GET")
            .arg("databases")
            .query_async::<Value>(&mut conn)
            .await
        {
            Ok(value) => reply::pairs(value)
                .into_iter()
                .next()
                .and_then(|(_, count)| reply::int(&count))
                .and_then(|count| u32::try_from(count).ok()),
            Err(_) => None,
        };
        Ok(ServerFacts {
            flavor: if valkey { "Valkey" } else { "Redis" },
            version,
            read_only,
            databases,
        })
    }

    /// The connection to `db`, opened when this is its first use.
    async fn conn(&self, db: u32) -> Result<MultiplexedConnection, EngineError> {
        let mut conns = self.conns.lock().await;
        if let Some(conn) = conns.get(&db) {
            return Ok(conn.clone());
        }
        let (conn, _) = self.connect(db, Role::Browse).await?;
        conns.insert(db, conn.clone());
        Ok(conn)
    }

    /// A connection that broke goes; the next command opens a new one.
    async fn forget(&self, db: u32) {
        self.conns.lock().await.remove(&db);
    }
}

/// What a connection is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Role {
    /// The page's reads and edits.
    Browse,
    /// The CLI's own connection.
    Cli,
}

impl Role {
    /// Its CLIENT SETNAME, so CLIENT LIST tells TablePeek's apart.
    pub(super) fn name(self) -> &'static str {
        match self {
            Role::Browse => "tablepeek",
            Role::Cli => "tablepeek-cli",
        }
    }
}

/// Whether connecting failed because the server doesn't know HELLO (RESP3).
fn unknown_hello(err: &EngineError) -> bool {
    matches!(err, EngineError::Driver { message, code, .. }
        if code.as_deref() == Some("NOPROTO")
            || (message.contains("unknown command") && message.to_ascii_uppercase().contains("HELLO")))
}

/// Whether an error means the connection itself is gone.
fn broken(err: &::redis::RedisError) -> bool {
    err.is_connection_dropped() || err.is_io_error() || err.is_unrecoverable_error()
}

/// A CLIENT LIST line's fields, by name.
fn client_fields(line: &str) -> HashMap<&str, &str> {
    line.split(' ')
        .filter_map(|part| part.split_once('='))
        .collect()
}

#[async_trait]
impl Driver for RedisDriver {
    fn id(&self) -> &'static str {
        "redis"
    }

    /// A read-only replica can't be edited.
    fn capabilities(&self) -> Capabilities {
        let mut capabilities = DESCRIPTOR.capabilities.clone();
        if self.facts.read_only {
            capabilities.edit_by_key = false;
        }
        capabilities
    }

    /// Keys aren't listed (a database may hold millions): the key browser
    /// scans them. The path names the server and the database.
    async fn meta(&self, _include_system: bool) -> Result<EngineMeta, EngineError> {
        Ok(EngineMeta {
            kind: self.id().into(),
            path: Some(self.label.clone()),
            demo: false,
            tables: Vec::new(),
            capabilities: None,
        })
    }

    /// Stops the console's command; the browser's are short.
    fn cancel(&self) -> CancelRequest {
        self.stop_console();
        CancelRequest::Done
    }

    async fn server_info(&self) -> Result<ServerInfo, EngineError> {
        let text = self
            .send(self.db, &ops::Line::new("INFO"), true)
            .await
            .map(reply::text)?
            .unwrap_or_default();
        let field = |key: &str| reply::info_field(&text, key).map(str::trim);
        let sessions = self.sessions().await;
        Ok(ServerInfo {
            driver: self.id().into(),
            version: Some(format!("{} {}", self.facts.flavor, self.facts.version)),
            database: Some(format!("db{}", self.db)),
            encoding: None,
            uptime: field("uptime_in_seconds")
                .and_then(|secs| secs.parse::<i64>().ok())
                .map(crate::humanize_uptime_ko),
            size_bytes: field("used_memory").and_then(|bytes| bytes.parse().ok()),
            can_kill: sessions.is_some(),
            sessions,
            topology: field("role").map(|role| match role {
                "master" => "standalone".to_string(),
                "slave" => "replica".to_string(),
                other => other.to_string(),
            }),
            host: None,
        })
    }

    fn keyvalue(&self) -> Option<&dyn KeyValueDriver> {
        Some(self)
    }
}

impl RedisDriver {
    /// CLIENT LIST as sessions; None without the right to read it.
    async fn sessions(&self) -> Option<Vec<ServerSession>> {
        let text = self
            .send(self.db, &ops::Line::new("CLIENT").arg("LIST"), true)
            .await
            .ok()
            .and_then(reply::text)?;
        let browse = self.browse_ids.lock().ok()?.clone();
        Some(
            text.lines()
                .filter(|line| !line.trim().is_empty())
                .map(|line| {
                    let fields = client_fields(line);
                    let get = |key: &str| {
                        fields
                            .get(key)
                            .filter(|value| !value.is_empty())
                            .map(|value| value.to_string())
                    };
                    let id = get("id").unwrap_or_default();
                    let addr = get("addr").unwrap_or_default();
                    let name = get("name");
                    let lib = get("lib-name");
                    ServerSession {
                        is_current: id.parse::<i64>().is_ok_and(|id| browse.contains(&id)),
                        id,
                        user: get("user"),
                        database: get("db").map(|db| format!("db{db}")),
                        state: Some(
                            [
                                Some(addr),
                                name,
                                lib,
                                get("flags").map(|flags| format!("flags={flags}")),
                            ]
                            .into_iter()
                            .flatten()
                            .collect::<Vec<_>>()
                            .join(" · "),
                        ),
                        query: get("cmd").map(|cmd| cmd.replace('|', " ")),
                        elapsed_ms: get("idle")
                            .and_then(|idle| idle.parse::<i64>().ok())
                            .map(|secs| secs * 1000),
                    }
                })
                .collect(),
        )
    }
}
