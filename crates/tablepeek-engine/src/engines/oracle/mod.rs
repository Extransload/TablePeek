//! Oracle Database, through Oracle's pure-Rust thin driver (`oracledb`): no
//! Instant Client, TLS (TCPS) and wallets through rustls. The driver is
//! synchronous; every call runs on a blocking thread (session.rs).

mod catalog;
mod cells;
mod edit;
mod query;
mod session;
mod values;

use std::net::SocketAddr;
use std::path::Path;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use async_trait::async_trait;
use serde::Deserialize;
use tablepeek_types::{
    Capabilities, CellRef, ConnConfig, DbObjects, EditTarget, EngineMeta, InsertValue,
    ObjectDefinition, PkValue, Relation, ServerInfo, TableDetail, TableSchema,
};

use crate::driver::{CancelRequest, Driver, FileStream, SqlDriver, TxOp};
use crate::registry::{
    check_host, parse_descriptor, typed_config, ConfigProblem, DriverFactory, EngineDescriptor,
    Forwarder, NetRoute, TunnelTarget,
};
use crate::sql_log::{Dialect, SqlLog};
use crate::{EngineError, QueryData};

use session::OracleInner;

pub struct Factory;

pub static FACTORY: Factory = Factory;

static DESCRIPTOR: LazyLock<EngineDescriptor> =
    LazyLock::new(|| parse_descriptor(include_str!("descriptor.json")));

/// The connect form's settings (descriptor.json).
#[derive(Debug, Clone, Deserialize)]
struct OracleConfig {
    /// "service", "sid" or "descriptor".
    #[serde(default = "default_mode")]
    connect_mode: String,
    #[serde(default)]
    host: String,
    #[serde(default = "default_port")]
    port: u16,
    /// The service name, or the SID in "sid" mode.
    #[serde(default)]
    database: String,
    /// Easy Connect, a (DESCRIPTION=…) or a tnsnames.ora alias.
    #[serde(default)]
    connect_string: String,
    #[serde(default)]
    user: String,
    #[serde(default)]
    password: Option<String>,
    /// "", "sysdba" or "sysoper".
    #[serde(default)]
    privilege: String,
    #[serde(default)]
    tls: bool,
    /// The wallet's ewallet.pem; its folder is the wallet location.
    #[serde(default)]
    wallet_file: String,
    #[serde(default)]
    wallet_password: Option<String>,
    /// A tnsnames.ora; its folder is where aliases are looked up.
    #[serde(default)]
    tnsnames_file: String,
}

fn default_mode() -> String {
    "service".into()
}

fn default_port() -> u16 {
    1521
}

impl OracleConfig {
    fn by_descriptor(&self) -> bool {
        self.connect_mode == "descriptor"
    }
}

/// What a session is opened with, kept to open the next one (after a cancel
/// that had to drop the session) and the one a cancel request goes over.
pub(crate) struct Settings {
    connect_string: String,
    user: String,
    password: String,
    auth_mode: u8,
    wallet_dir: Option<String>,
    wallet_password: String,
    config_dir: Option<String>,
    /// Addresses of the descriptor (HOST, PORT) dialed through a tunnel's
    /// local end. The descriptor keeps them as written, so TCPS checks the
    /// certificate against the server's own name.
    routes: Vec<(String, u16, SocketAddr)>,
}

impl Settings {
    /// The driver's configuration for a new session.
    fn driver_config(&self) -> Result<oracledb::Config, EngineError> {
        let mut config = oracledb::Config::default()
            .set_credentials(&self.user, &self.password)
            .set_auth_mode(self.auth_mode)
            .set_driver_name("TablePeek")
            .set_transport_connect_timeout(Some(Duration::from_secs(15)));
        if let Some(dir) = &self.config_dir {
            config = config.set_config_dir(dir);
        }
        if let Some(dir) = &self.wallet_dir {
            config = config
                .set_wallet_location(dir.clone())
                .set_wallet_password(&self.wallet_password);
        }
        for (host, port, via) in &self.routes {
            config = config.set_address_route(host, *port, *via);
        }
        config
            .set_connect_string(&self.connect_string)
            .map_err(|err| session::connect_error(err, &self.connect_string))
    }

    /// The addresses (HOST, PORT) of the full descriptor the connect string
    /// stands for, as the driver reads it (an alias looked up in the
    /// tnsnames.ora, Easy Connect spelled out).
    fn addresses(&self) -> Result<Vec<(String, u16)>, EngineError> {
        let addresses = descriptor_addresses(&self.driver_config()?.get_connect_descriptor());
        if addresses.is_empty() {
            return Err(EngineError::BadRequest(
                "연결 문자열에서 서버 주소(HOST·PORT)를 찾지 못했습니다".into(),
            ));
        }
        Ok(addresses)
    }
}

/// Each address's HOST and PORT in a descriptor the driver wrote, in order.
fn descriptor_addresses(descriptor: &str) -> Vec<(String, u16)> {
    let mut addresses = Vec::new();
    let mut rest = descriptor;
    while let Some(at) = rest.find("(HOST=") {
        let value = &rest[at + "(HOST=".len()..];
        let (Some(host_end), Some(port_at)) = (value.find(')'), value.find("(PORT=")) else {
            break;
        };
        let port_text = &value[port_at + "(PORT=".len()..];
        let Some(port_end) = port_text.find(')') else {
            break;
        };
        let host = value[..host_end]
            .trim_start_matches('[')
            .trim_end_matches(']');
        let port = port_text[..port_end].trim().parse().unwrap_or(1521);
        addresses.push((host.to_string(), port));
        rest = &port_text[port_end + 1..];
    }
    addresses
}

/// Local ends of a tunnel, one per address of a descriptor with several
/// (the driver dials each address itself); they stop with the driver.
#[derive(Default)]
struct LocalEnds(Vec<tokio::task::JoinHandle<()>>);

impl Drop for LocalEnds {
    fn drop(&mut self) {
        for task in &self.0 {
            task.abort();
        }
    }
}

impl LocalEnds {
    /// Opens a local end on 127.0.0.1 leading through the tunnel to
    /// `host:port` as its far end names it; returns the local port.
    async fn open(
        &mut self,
        forwarder: Arc<dyn Forwarder>,
        host: String,
        port: u16,
    ) -> Result<u16, EngineError> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .and_then(|listener| Ok((listener.local_addr()?.port(), listener)));
        let (local, listener) = listener.map_err(|err| {
            EngineError::BadRequest(format!("터널의 로컬 끝을 열지 못했습니다: {err}"))
        })?;
        self.0.push(tokio::spawn(async move {
            // Dropping the set (when the task is aborted) ends every stream.
            let mut streams = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let Ok((mut inbound, _)) = accepted else { break };
                        let forwarder = forwarder.clone();
                        let host = host.clone();
                        streams.spawn(async move {
                            if let Ok(mut outbound) = forwarder.connect(&host, port).await {
                                let _ = tokio::io::copy_bidirectional(&mut inbound, &mut outbound).await;
                            }
                        });
                    }
                    Some(_) = streams.join_next() => {}
                }
            }
        }));
        Ok(local)
    }
}

#[async_trait]
impl DriverFactory for Factory {
    fn descriptor(&self) -> &'static EngineDescriptor {
        &DESCRIPTOR
    }

    fn validate(&self, config: &ConnConfig) -> Result<(), ConfigProblem> {
        settings(self.descriptor(), config).map(|_| ())
    }

    fn tunnel_target(&self, config: &ConnConfig) -> Result<TunnelTarget, ConfigProblem> {
        let settings = settings(self.descriptor(), config)?;
        if !settings.by_descriptor() {
            return Ok(TunnelTarget::Address(settings.host, settings.port));
        }
        // Each address of the descriptor goes through the tunnel.
        let mut addresses = resolve(&settings)
            .addresses()
            .map_err(|err| ConfigProblem::invalid(err.to_string()))?;
        Ok(match addresses.len() {
            1 => {
                let (host, port) = addresses.remove(0);
                TunnelTarget::Address(host, port)
            }
            _ => TunnelTarget::Members,
        })
    }

    fn address(&self, config: &ConnConfig) -> String {
        match settings(self.descriptor(), config) {
            Ok(settings) if settings.by_descriptor() => {
                format!("{}@{}", settings.user, settings.connect_string.trim())
            }
            _ => self.descriptor().detail(config),
        }
    }

    async fn connect(
        &self,
        config: &ConnConfig,
        net: &NetRoute,
        log: SqlLog,
    ) -> Result<Arc<dyn Driver>, EngineError> {
        // TCPS goes through rustls, which needs the process's provider.
        crate::ensure_crypto_provider();
        let descriptor = self.descriptor();
        let settings = settings(descriptor, config)
            .map_err(|problem| EngineError::BadRequest(problem.message))?;
        let label = match settings.by_descriptor() {
            true => format!("{}@{}", settings.user, settings.connect_string.trim()),
            false => format!(
                "{}@{}:{}/{}",
                settings.user, settings.host, settings.port, settings.database
            ),
        };
        let mut resolved = resolve(&settings);
        // Through a tunnel, each address of the descriptor (an alias looked
        // up first) is dialed through a local end leading to it.
        let mut ends = LocalEnds::default();
        if !matches!(net, NetRoute::Direct) {
            for (host, port) in resolved.addresses()? {
                let via = match net {
                    NetRoute::Tunnel(forwarder) => SocketAddr::from((
                        [127, 0, 0, 1],
                        ends.open(forwarder.clone(), host.clone(), port).await?,
                    )),
                    NetRoute::Via {
                        host: via_host,
                        port: via_port,
                    } => tokio::net::lookup_host((via_host.as_str(), *via_port))
                        .await
                        .ok()
                        .and_then(|mut found| found.next())
                        .ok_or_else(|| {
                            EngineError::BadRequest(format!(
                                "터널의 로컬 끝을 찾지 못했습니다: {via_host}:{via_port}"
                            ))
                        })?,
                    NetRoute::Direct => continue,
                };
                resolved.routes.push((host, port, via));
            }
        }
        let inner = OracleInner::connect(resolved, label, log).await?;
        Ok(Arc::new(OracleDriver {
            inner,
            descriptor,
            _ends: ends,
        }))
    }
}

fn settings(
    descriptor: &EngineDescriptor,
    config: &ConnConfig,
) -> Result<OracleConfig, ConfigProblem> {
    let settings: OracleConfig = typed_config(descriptor, config)?;
    match settings.connect_mode.as_str() {
        "service" | "sid" => {
            check_host(&settings.host)?;
            if settings.host.trim().is_empty() {
                return Err(ConfigProblem::invalid("호스트를 입력하세요"));
            }
            if settings.database.trim().is_empty() {
                return Err(ConfigProblem::invalid(if settings.connect_mode == "sid" {
                    "SID를 입력하세요"
                } else {
                    "서비스 이름을 입력하세요"
                }));
            }
        }
        "descriptor" => {
            if settings.connect_string.trim().is_empty() {
                return Err(ConfigProblem::invalid("연결 문자열을 입력하세요"));
            }
            // A pasted string must not carry a password into the saved
            // profile (user/password@host…).
            if settings.connect_string.contains('@') && !settings.connect_string.contains('(') {
                return Err(ConfigProblem::invalid(
                    "연결 문자열에는 계정 정보를 넣지 말고 사용자·비밀번호 칸에 입력하세요",
                ));
            }
        }
        other => {
            return Err(ConfigProblem::invalid(format!(
                "접속 방식이 올바르지 않습니다: {other}"
            )))
        }
    }
    if !matches!(settings.privilege.as_str(), "" | "sysdba" | "sysoper") {
        return Err(ConfigProblem::invalid(format!(
            "접속 권한이 올바르지 않습니다: {}",
            settings.privilege
        )));
    }
    Ok(settings)
}

/// The connect string and files the settings name, as the driver takes them.
fn resolve(settings: &OracleConfig) -> Settings {
    let connect_string = match settings.connect_mode.as_str() {
        "descriptor" => settings.connect_string.trim().to_string(),
        mode => {
            let host = settings.host.trim();
            // An IPv6 address goes in brackets in Easy Connect.
            let host = if host.contains(':') && !host.starts_with('[') {
                format!("[{host}]")
            } else {
                host.to_string()
            };
            let protocol = if settings.tls { "TCPS" } else { "TCP" };
            let target = settings.database.trim();
            if mode == "sid" {
                format!(
                    "(DESCRIPTION=(ADDRESS=(PROTOCOL={protocol})(HOST={host})(PORT={}))(CONNECT_DATA=(SID={target})))",
                    settings.port
                )
            } else {
                format!(
                    "{}://{host}:{}/{target}",
                    protocol.to_ascii_lowercase(),
                    settings.port
                )
            }
        }
    };
    let parent = |file: &str| -> Option<String> {
        let file = file.trim();
        (!file.is_empty()).then(|| {
            Path::new(file)
                .parent()
                .map_or_else(|| ".".into(), |dir| dir.to_string_lossy().into_owned())
        })
    };
    let wants_wallet = settings.tls || settings.by_descriptor();
    Settings {
        connect_string,
        user: settings.user.trim().to_string(),
        password: settings.password.clone().unwrap_or_default(),
        auth_mode: match settings.privilege.as_str() {
            "sysdba" => oracledb::AUTH_MODE_SYSDBA,
            "sysoper" => oracledb::AUTH_MODE_SYSOPER,
            _ => oracledb::AUTH_MODE_DEFAULT,
        },
        wallet_dir: wants_wallet
            .then(|| parent(&settings.wallet_file))
            .flatten(),
        wallet_password: settings.wallet_password.clone().unwrap_or_default(),
        config_dir: settings
            .by_descriptor()
            .then(|| parent(&settings.tnsnames_file))
            .flatten(),
        routes: Vec::new(),
    }
}

pub(crate) struct OracleDriver {
    inner: Arc<OracleInner>,
    descriptor: &'static EngineDescriptor,
    /// Held for the tunnel's local ends, if the descriptor needed any.
    _ends: LocalEnds,
}

#[async_trait]
impl Driver for OracleDriver {
    fn id(&self) -> &'static str {
        "oracle"
    }

    fn capabilities(&self) -> Capabilities {
        let mut capabilities = self.descriptor.capabilities.clone();
        // Whether this session can stop a statement and keep itself.
        capabilities.cancel_ends_session = self.inner.cancel_ends_session();
        capabilities
    }

    async fn meta(&self, include_system: bool) -> Result<EngineMeta, EngineError> {
        catalog::meta(&self.inner, include_system).await
    }

    fn cancel(&self) -> CancelRequest {
        match self.inner.cancel() {
            Some(request) => CancelRequest::Sent {
                request,
                lands_later: false,
            },
            None => CancelRequest::Done,
        }
    }

    async fn server_info(&self) -> Result<ServerInfo, EngineError> {
        catalog::server_info(&self.inner).await
    }

    fn sql(&self) -> Option<&dyn SqlDriver> {
        Some(self)
    }
}

#[async_trait]
impl SqlDriver for OracleDriver {
    fn dialect(&self) -> Dialect {
        Dialect::Oracle
    }

    async fn schema(&self, include_system: bool) -> Result<Vec<TableSchema>, EngineError> {
        catalog::schema(&self.inner, include_system).await
    }

    async fn relations(&self, include_system: bool) -> Result<Vec<Relation>, EngineError> {
        catalog::relations(&self.inner, include_system).await
    }

    async fn table_count(&self, name: &str) -> Result<i64, EngineError> {
        catalog::table_count(&self.inner, name).await
    }

    async fn databases(&self) -> Result<Vec<String>, EngineError> {
        Ok(Vec::new())
    }

    async fn query(&self, sql: &str, max_rows: usize) -> Result<QueryData, EngineError> {
        query::query(&self.inner, sql, max_rows).await
    }

    async fn edit(&self, target: &EditTarget) -> Result<u64, EngineError> {
        edit::edit(&self.inner, target).await
    }

    async fn insert_row(&self, table: &str, values: &[InsertValue]) -> Result<u64, EngineError> {
        edit::insert_row(&self.inner, table, values).await
    }

    async fn delete_row(&self, table: &str, pk: &[PkValue]) -> Result<u64, EngineError> {
        edit::delete_row(&self.inner, table, pk).await
    }

    async fn table_detail(&self, name: &str) -> Result<TableDetail, EngineError> {
        catalog::table_detail(&self.inner, name).await
    }

    async fn objects(&self, include_system: bool) -> Result<DbObjects, EngineError> {
        catalog::objects(&self.inner, include_system).await
    }

    async fn object_definition(
        &self,
        kind: &str,
        name: &str,
    ) -> Result<Option<ObjectDefinition>, EngineError> {
        catalog::object_definition(&self.inner, kind, name).await
    }

    async fn read_cell(&self, cell: &CellRef) -> Result<FileStream, EngineError> {
        cells::read_cell(self.inner.clone(), cell).await
    }

    async fn write_cell(&self, cell: &CellRef, data: FileStream) -> Result<u64, EngineError> {
        cells::write_cell(&self.inner, cell, data).await
    }

    async fn kill_session(&self, id: &str) -> Result<(), EngineError> {
        catalog::kill_session(&self.inner, id).await
    }

    async fn in_tx(&self) -> Result<bool, EngineError> {
        Ok(self.inner.in_tx())
    }

    async fn tx(&self, op: TxOp) -> Result<(), EngineError> {
        self.inner.tx(op).await
    }

    fn set_query_timeout(&self, secs: u64) {
        self.inner.set_query_timeout(secs);
    }
}

#[cfg(test)]
mod tests;
