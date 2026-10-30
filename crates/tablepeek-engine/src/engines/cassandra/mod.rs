//! Apache Cassandra and ScyllaDB, over CQL. One driver serves both engine
//! descriptors (`cassandra`, `scylladb`); the server it reaches says which
//! product it is, and server info shows that.
//!
//! CQL reads like SQL but pages by the server's paging state, not OFFSET,
//! filters only on key columns (or with ALLOW FILTERING), and has no
//! transactions or foreign keys. Rows are edited by their whole primary
//! key, with lightweight-transaction conditions (IF EXISTS, IF NOT EXISTS)
//! as conflict checks unless the connection turns them off.

mod cql;
mod route;
mod schema;
mod steps;
mod values;

use std::collections::HashMap;
use std::future::Future;
use std::ops::ControlFlow;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, PoisonError};
use std::time::{Duration, Instant};

use arrow::datatypes::Schema;
use async_trait::async_trait;
use base64::Engine as _;
use scylla::client::session::Session;
use scylla::client::session_builder::SessionBuilder;
use scylla::errors::TranslationError;
use scylla::errors::{ExecutionError, NewSessionError, RequestAttemptError};
use scylla::frame::protocol_features::ProtocolFeatures;
use scylla::frame::response::result::ColumnType;
use scylla::frame::types::{Consistency, SerialConsistency};
use scylla::policies::address_translator::{AddressTranslator, UntranslatedPeer};
use scylla::response::query_result::QueryResult;
use scylla::response::{PagingState, PagingStateResponse};
use scylla::statement::prepared::PreparedStatement;
use scylla::statement::unprepared::Statement;
use scylla::value::{CqlValue, Row};
use serde::Deserialize;
use serde_json::Value;
use tablepeek_types::{
    Capabilities, ConnConfig, DbObjects, EditTarget, EngineMeta, ErrorFields, ErrorPosition,
    InsertValue, ObjectDefinition, PkValue, Relation, ServerInfo, TableDetail, TableSchema,
    ValueExpr,
};
use tokio::sync::watch;

use crate::driver::{CancelRequest, CountStep, Driver, SkipOutcome, SkipRequest, SqlDriver, TxOp};
use crate::registry::{
    check_host, parse_descriptor, typed_config, ConfigProblem, DriverFactory, EngineDescriptor,
    NetRoute, TunnelTarget,
};
use crate::sql_log::{inline_params, Change, Dialect, LogParam, SqlLog};
use crate::{build_arrow, EngineError, QueryData};

use schema::{ColumnKind, TableInfo};

static CASSANDRA: LazyLock<EngineDescriptor> =
    LazyLock::new(|| parse_descriptor(include_str!("descriptor.json")));

/// Makes connections for one of the CQL engines; `scylladb` has its own
/// descriptor and shares everything else.
pub struct Factory {
    descriptor: &'static LazyLock<EngineDescriptor>,
}

impl Factory {
    pub(crate) const fn new(descriptor: &'static LazyLock<EngineDescriptor>) -> Self {
        Self { descriptor }
    }
}

pub static FACTORY: Factory = Factory::new(&CASSANDRA);

/// The rows one request asks for at most; longer reads take several pages.
const PAGE_CAP: usize = 5_000;
/// How long a statement may take when the page sets no limit of its own.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
/// Metadata reads (system_schema, system.local) are small but may cross a
/// slow link.
const META_TIMEOUT: Duration = Duration::from_secs(15);

/// The levels CONSISTENCY takes, as cqlsh spells them.
const LEVELS: [(&str, Consistency); 11] = [
    ("ANY", Consistency::Any),
    ("ONE", Consistency::One),
    ("TWO", Consistency::Two),
    ("THREE", Consistency::Three),
    ("QUORUM", Consistency::Quorum),
    ("ALL", Consistency::All),
    ("LOCAL_QUORUM", Consistency::LocalQuorum),
    ("EACH_QUORUM", Consistency::EachQuorum),
    ("LOCAL_ONE", Consistency::LocalOne),
    ("SERIAL", Consistency::Serial),
    ("LOCAL_SERIAL", Consistency::LocalSerial),
];

fn level_named(name: &str) -> Option<Consistency> {
    let name = name.trim().to_ascii_uppercase();
    LEVELS
        .iter()
        .find(|(level, _)| *level == name)
        .map(|(_, level)| *level)
}

fn level_name(level: Consistency) -> &'static str {
    LEVELS
        .iter()
        .find(|(_, known)| *known == level)
        .map_or("ONE", |(name, _)| name)
}

fn serial_named(name: &str) -> Option<SerialConsistency> {
    match name.trim().to_ascii_uppercase().as_str() {
        "SERIAL" => Some(SerialConsistency::Serial),
        "LOCAL_SERIAL" => Some(SerialConsistency::LocalSerial),
        _ => None,
    }
}

fn serial_name(level: SerialConsistency) -> &'static str {
    match level {
        SerialConsistency::LocalSerial => "LOCAL_SERIAL",
        _ => "SERIAL",
    }
}

/// A connection's settings (`config`), as the descriptor's form sends them.
#[derive(Debug, Clone, Deserialize)]
struct Settings {
    host: String,
    #[serde(default = "default_port")]
    port: u16,
    #[serde(default)]
    user: String,
    #[serde(default)]
    password: Option<String>,
    /// The keyspace, under the key every engine's database switch writes.
    #[serde(default)]
    database: String,
    /// The local datacenter requests go to first; empty lets the driver pick.
    #[serde(default)]
    datacenter: String,
    #[serde(default = "default_consistency")]
    consistency: String,
    #[serde(default = "default_serial")]
    serial_consistency: String,
    /// Edits check with IF EXISTS / IF NOT EXISTS that the row is (or
    /// isn't) there; off, they write as plain CQL does (an upsert).
    #[serde(default = "default_true")]
    lwt_checks: bool,
    #[serde(default)]
    tls: bool,
    #[serde(default)]
    tls_ca_file: Option<String>,
    #[serde(default)]
    tls_cert_file: Option<String>,
    #[serde(default)]
    tls_key_file: Option<String>,
}

fn default_port() -> u16 {
    9042
}

fn default_consistency() -> String {
    "LOCAL_ONE".into()
}

fn default_serial() -> String {
    "SERIAL".into()
}

fn default_true() -> bool {
    true
}

fn settings(descriptor: &EngineDescriptor, config: &ConnConfig) -> Result<Settings, ConfigProblem> {
    let settings: Settings = typed_config(descriptor, config)?;
    check_host(&settings.host)?;
    if settings.host.trim().is_empty() {
        return Err(ConfigProblem::invalid("호스트를 입력하세요"));
    }
    if level_named(&settings.consistency).is_none() {
        return Err(ConfigProblem::invalid(format!(
            "일관성 수준이 올바르지 않습니다: {}",
            settings.consistency
        )));
    }
    if serial_named(&settings.serial_consistency).is_none() {
        return Err(ConfigProblem::invalid(format!(
            "직렬 일관성 수준은 SERIAL이나 LOCAL_SERIAL이어야 합니다: {}",
            settings.serial_consistency
        )));
    }
    let filled =
        |path: &Option<String>| path.as_deref().is_some_and(|path| !path.trim().is_empty());
    if settings.tls && filled(&settings.tls_cert_file) != filled(&settings.tls_key_file) {
        return Err(ConfigProblem::invalid(
            "TLS 클라이언트 인증서와 키는 함께 지정해야 합니다",
        ));
    }
    Ok(settings)
}

#[async_trait]
impl DriverFactory for Factory {
    fn descriptor(&self) -> &'static EngineDescriptor {
        self.descriptor
    }

    fn validate(&self, config: &ConnConfig) -> Result<(), ConfigProblem> {
        settings(self.descriptor(), config).map(|_| ())
    }

    /// The whole tunnel: the driver goes on to every node it finds (see
    /// `route`), not just the one named here.
    fn tunnel_target(&self, config: &ConnConfig) -> Result<TunnelTarget, ConfigProblem> {
        settings(self.descriptor(), config).map(|_| TunnelTarget::Members)
    }

    /// Only with a user: a cluster without authentication takes none.
    fn needs_password(&self, config: &ConnConfig) -> bool {
        config
            .get("user")
            .and_then(Value::as_str)
            .is_some_and(|user| !user.trim().is_empty())
    }

    async fn connect(
        &self,
        config: &ConnConfig,
        net: &NetRoute,
        log: SqlLog,
    ) -> Result<Arc<dyn Driver>, EngineError> {
        let descriptor = self.descriptor();
        let mut settings = settings(descriptor, config)
            .map_err(|problem| EngineError::BadRequest(problem.message))?;
        net.apply(&mut settings.host, &mut settings.port);
        CassandraDriver::open(descriptor, settings, net, log).await
    }
}

/// Nodes name themselves by the address they listen on inside their own
/// network (a container's, a private subnet's), which a port mapping on
/// this machine (or a tunnel's single end) doesn't reach: every node is
/// then reached through the address the connection was given, whose node
/// coordinates the request.
struct ThroughContactPoint(std::net::SocketAddr);

#[async_trait]
impl AddressTranslator for ThroughContactPoint {
    async fn translate_address(
        &self,
        _peer: &UntranslatedPeer,
    ) -> Result<std::net::SocketAddr, TranslationError> {
        Ok(self.0)
    }
}

/// The server a connection reached, as it describes itself.
#[derive(Debug, Clone, Default)]
struct Product {
    scylla: bool,
    version: String,
    cluster: String,
    datacenter: String,
    /// Keys' tokens are 64-bit numbers spread over the whole ring
    /// (Murmur3Partitioner, ScyllaDB's CDC partitioner): work over a table
    /// can split it into token ranges (`steps`).
    token_ring: bool,
}

/// One open CQL session.
pub(crate) struct CassandraDriver {
    id: &'static str,
    descriptor: &'static EngineDescriptor,
    session: Session,
    log: SqlLog,
    product: Product,
    authenticated: bool,
    lwt_checks: bool,
    address: String,
    /// The keyspace unqualified names belong to: the connection's, or the
    /// last USE.
    keyspace: Mutex<Option<String>>,
    consistency: Mutex<Consistency>,
    serial: Mutex<SerialConsistency>,
    /// TRACING ON: every statement's trace goes to the console.
    tracing: AtomicBool,
    /// Seconds a page's statement may take; 0 for the default.
    timeout_secs: AtomicU64,
    /// Bumped by a cancel: a statement waiting on the server stops waiting.
    cancels: watch::Sender<u64>,
    /// Tables' columns, read once and dropped when a statement changes
    /// schema.
    tables: Mutex<HashMap<(String, String), Arc<TableInfo>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A host and port as the driver takes a known node (IPv6 in brackets).
fn node_address(host: &str, port: u16) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    }
}

impl CassandraDriver {
    async fn open(
        descriptor: &'static EngineDescriptor,
        settings: Settings,
        net: &NetRoute,
        log: SqlLog,
    ) -> Result<Arc<dyn Driver>, EngineError> {
        let id: &'static str = match descriptor.id.as_str() {
            "scylladb" => "scylladb",
            _ => "cassandra",
        };
        let address = node_address(settings.host.trim(), settings.port);
        // Through a tunnel to the whole network behind it, each node gets a
        // local end of its own, so requests still go straight to a replica.
        // Behind a tunnel's single end or a port mapped to this machine (a
        // container), the nodes' own addresses can't be reached: go through
        // this one.
        let (contact, translator): (String, Option<Arc<dyn AddressTranslator>>) = match net {
            NetRoute::Tunnel(forwarder) => {
                let through = route::ThroughTunnel::new(forwarder.clone(), settings.port);
                let end = through
                    .end(settings.host.trim(), settings.port)
                    .await
                    .map_err(|err| {
                        EngineError::Internal(format!("터널 로컬 포트를 열 수 없습니다: {err}"))
                    })?;
                (end.to_string(), Some(Arc::new(through)))
            }
            _ => {
                let found = tokio::net::lookup_host(&address)
                    .await
                    .ok()
                    .and_then(|mut found| found.next())
                    .filter(|found| {
                        matches!(net, NetRoute::Via { .. }) || found.ip().is_loopback()
                    });
                let translator = found.map(|found| {
                    Arc::new(ThroughContactPoint(found)) as Arc<dyn AddressTranslator>
                });
                (address.clone(), translator)
            }
        };
        let mut builder = SessionBuilder::new()
            .known_node(&contact)
            .connection_timeout(Duration::from_secs(10))
            // Tables and types are read from system_schema when the page
            // asks; the driver's own copy would only double the reads.
            .fetch_schema_metadata(false);
        if let Some(translator) = translator {
            // A node's shard-aware port is on its own address, which only
            // the regular port's end leads to.
            builder = builder
                .address_translator(translator)
                .disallow_shard_aware_port(true);
        }
        let user = settings.user.trim();
        if !user.is_empty() {
            builder = builder.user(user, settings.password.clone().unwrap_or_default());
        }
        if !settings.datacenter.trim().is_empty() {
            builder = builder.prefer_datacenter(settings.datacenter.trim().to_string());
        }
        if settings.tls {
            let config = crate::postgres::rustls_client_config(
                settings.tls_ca_file.as_deref(),
                settings.tls_cert_file.as_deref(),
                settings.tls_key_file.as_deref(),
            )?;
            builder = builder.tls_context(Some(Arc::new(config)));
        }
        let keyspace = settings.database.trim();
        if !keyspace.is_empty() {
            builder = builder.use_keyspace(keyspace, true);
        }
        log.record_command(&format!("-- {} {address} 연결", descriptor.label));
        let session = builder
            .build()
            .await
            .map_err(|err| session_error(id, &err))?;
        let (cancels, _) = watch::channel(0);
        let mut driver = CassandraDriver {
            id,
            descriptor,
            session,
            log,
            product: Product::default(),
            authenticated: !user.is_empty(),
            lwt_checks: settings.lwt_checks,
            address,
            keyspace: Mutex::new((!keyspace.is_empty()).then(|| keyspace.to_string())),
            consistency: Mutex::new(
                level_named(&settings.consistency).unwrap_or(Consistency::LocalOne),
            ),
            serial: Mutex::new(
                serial_named(&settings.serial_consistency).unwrap_or(SerialConsistency::Serial),
            ),
            tracing: AtomicBool::new(false),
            timeout_secs: AtomicU64::new(0),
            cancels,
            tables: Mutex::new(HashMap::new()),
        };
        driver.product = driver.read_product().await?;
        Ok(Arc::new(driver))
    }

    /// Which server this is: ScyllaDB answers from system.versions,
    /// Cassandra has no such table.
    async fn read_product(&self) -> Result<Product, EngineError> {
        let local = self
            .meta_rows(
                "SELECT release_version, cluster_name, data_center, partitioner FROM system.local WHERE key = 'local'",
            )
            .await?;
        let row = local.first();
        let mut product = Product {
            scylla: false,
            version: row.and_then(|row| schema::text(row, 0)).unwrap_or_default(),
            cluster: row.and_then(|row| schema::text(row, 1)).unwrap_or_default(),
            datacenter: row.and_then(|row| schema::text(row, 2)).unwrap_or_default(),
            token_ring: row
                .and_then(|row| schema::text(row, 3))
                .is_some_and(|partitioner| {
                    partitioner.ends_with("Murmur3Partitioner")
                        || partitioner.ends_with("CDCPartitioner")
                }),
        };
        if let Ok(rows) = self
            .meta_rows("SELECT version FROM system.versions WHERE key = 'local'")
            .await
        {
            if let Some(version) = rows.first().and_then(|row| schema::text(row, 0)) {
                product.scylla = true;
                product.version = version;
            }
        }
        Ok(product)
    }

    fn keyspace(&self) -> Option<String> {
        lock(&self.keyspace).clone()
    }

    /// `name` as the page writes it ("orders", "shop.orders") as its
    /// keyspace and table.
    fn resolve(&self, name: &str) -> Result<(String, String), EngineError> {
        if let Some((keyspace, table)) = name.split_once('.') {
            return Ok((keyspace.to_string(), table.to_string()));
        }
        let keyspace = self.keyspace().ok_or_else(|| {
            EngineError::BadRequest(format!(
                "키스페이스를 고르지 않은 연결입니다. {name} 대신 키스페이스.{name} 으로 쓰세요"
            ))
        })?;
        Ok((keyspace, name.to_string()))
    }

    /// A table's name as the sidebar lists it: bare in the connection's
    /// keyspace, qualified elsewhere.
    fn shown_name(&self, keyspace: &str, table: &str) -> String {
        if self.keyspace().as_deref() == Some(keyspace) {
            table.to_string()
        } else {
            format!("{keyspace}.{table}")
        }
    }

    fn statement(&self, cql: &str, page_size: usize, timeout: Duration) -> Statement {
        let mut statement = Statement::new(cql);
        statement.set_page_size(i32::try_from(page_size.max(1)).unwrap_or(i32::MAX));
        statement.set_consistency(*lock(&self.consistency));
        statement.set_serial_consistency(Some(*lock(&self.serial)));
        statement.set_request_timeout(Some(timeout));
        statement
    }

    fn page_timeout(&self) -> Duration {
        match self.timeout_secs.load(Ordering::Relaxed) {
            0 => DEFAULT_TIMEOUT,
            secs => Duration::from_secs(secs),
        }
    }

    /// Runs `work`, unless a cancel comes first.
    async fn cancellable<T>(
        &self,
        work: impl Future<Output = Result<T, ExecutionError>>,
    ) -> Result<T, EngineError> {
        let mut cancelled = self.cancels.subscribe();
        tokio::select! {
            outcome = work => outcome.map_err(|err| self.error(&err)),
            _ = cancelled.changed() => Err(EngineError::Driver {
                engine: self.id,
                code: None,
                message: "쿼리가 취소되었습니다 (서버에서는 끝까지 실행될 수 있습니다)".into(),
                interrupted: true,
                fields: Box::default(),
            }),
        }
    }

    /// One page of a statement's rows, from `state`.
    async fn page(
        &self,
        statement: Statement,
        state: PagingState,
    ) -> Result<(QueryResult, PagingStateResponse), EngineError> {
        self.log.record(statement.contents.as_str(), Dialect::Cql);
        self.cancellable(self.session.query_single_page(statement, &[], state))
            .await
    }

    /// Every row of a metadata read (system tables), all pages.
    async fn meta_rows(&self, cql: &str) -> Result<Vec<Row>, EngineError> {
        let mut rows = Vec::new();
        let mut state = PagingState::start();
        loop {
            let (result, response) = self
                .page(self.statement(cql, PAGE_CAP, META_TIMEOUT), state)
                .await?;
            if result.is_rows() {
                let rows_result = result
                    .into_rows_result()
                    .map_err(|err| self.internal(err))?;
                for row in rows_result
                    .rows::<Row>()
                    .map_err(|err| self.internal(err))?
                {
                    rows.push(row.map_err(|err| self.internal(err))?);
                }
            }
            match response.into_paging_control_flow() {
                ControlFlow::Break(()) => return Ok(rows),
                ControlFlow::Continue(next) => state = next,
            }
        }
    }

    fn internal(&self, err: impl std::fmt::Display) -> EngineError {
        EngineError::Driver {
            engine: self.id,
            code: None,
            message: err.to_string(),
            interrupted: false,
            fields: Box::default(),
        }
    }

    /// A request's failure as the page shows it: the server's own message
    /// and code (hex, as the CQL spec numbers them), a syntax error's place.
    fn error(&self, err: &ExecutionError) -> EngineError {
        let mut fields = ErrorFields {
            raw: Some(err.to_string()),
            ..ErrorFields::default()
        };
        let (code, message) = match err {
            ExecutionError::LastAttemptError(RequestAttemptError::DbError(db, message)) => {
                let code = db.code(&ProtocolFeatures::default());
                fields.server_code = Some(i64::from(code));
                if let Some((line, column)) = cql::error_position(message) {
                    fields.position = Some(ErrorPosition {
                        line: Some(line),
                        column: Some(column),
                        ..ErrorPosition::default()
                    });
                }
                (Some(format!("{code:04X}")), message.clone())
            }
            ExecutionError::RequestTimeout(limit) => (
                None,
                format!(
                    "{}초 안에 응답이 없어 기다리기를 멈췄습니다 (설정의 쿼리 시간 제한)",
                    limit.as_secs()
                ),
            ),
            other => (None, other.to_string()),
        };
        EngineError::Driver {
            engine: self.id,
            code,
            message,
            interrupted: false,
            fields: Box::new(fields),
        }
    }

    /// A statement's rows (at most `max_rows`) from `page`, or from the
    /// start; with more left, `next_page` says where they begin.
    async fn read(
        &self,
        cql: &str,
        max_rows: usize,
        page: Option<&str>,
        traced: bool,
    ) -> Result<QueryData, EngineError> {
        let started = Instant::now();
        let mut state = match page {
            Some(token) => decode_page(token)?,
            None => PagingState::start(),
        };
        let max_rows = max_rows.max(1);
        let mut columns: Vec<String> = Vec::new();
        let mut column_values: Vec<Vec<Value>> = Vec::new();
        let mut count = 0usize;
        let mut next_page = None;
        let mut trace_id = None;
        loop {
            let size = (max_rows - count).min(PAGE_CAP);
            let mut statement = self.statement(cql, size, self.page_timeout());
            statement.set_tracing(traced);
            let (result, response) = self.page(statement, state).await?;
            trace_id = trace_id.or(result.tracing_id());
            for warning in result.warnings() {
                self.log.record_command(&format!("-- 경고: {warning}"));
            }
            if result.is_rows() {
                let rows_result = result
                    .into_rows_result()
                    .map_err(|err| self.internal(err))?;
                if columns.is_empty() {
                    columns = rows_result
                        .column_specs()
                        .iter()
                        .map(|spec| spec.name().to_string())
                        .collect();
                    column_values = vec![Vec::new(); columns.len()];
                }
                for row in rows_result
                    .rows::<Row>()
                    .map_err(|err| self.internal(err))?
                {
                    let row = row.map_err(|err| self.internal(err))?;
                    for (index, value) in row.columns.iter().enumerate() {
                        if let Some(column) = column_values.get_mut(index) {
                            column.push(values::cell(value.as_ref()));
                        }
                    }
                    count += 1;
                }
            }
            match response.into_paging_control_flow() {
                ControlFlow::Break(()) => break,
                ControlFlow::Continue(next) if count >= max_rows => {
                    next_page = Some(encode_page(&next));
                    break;
                }
                ControlFlow::Continue(next) => state = next,
            }
        }
        if let Some(id) = trace_id.filter(|_| self.tracing.load(Ordering::Relaxed)) {
            self.log_trace(id).await;
        }
        let source = self.source_of(cql, &columns).await;
        let (schema, batches) = if columns.is_empty() {
            (Arc::new(Schema::empty()), Vec::new())
        } else {
            build_arrow(&columns, column_values, count)?
        };
        let (source_table, pk) = source.unzip();
        Ok(QueryData {
            kind: self.id,
            columns,
            schema,
            batches,
            row_count: count,
            elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
            truncated: next_page.is_some(),
            source_table,
            pk,
            column_kinds: Vec::new(),
            rows_affected: None,
            next_page,
        })
    }

    /// The console's summary of a traced statement (TRACING ON).
    async fn log_trace(&self, id: uuid::Uuid) {
        match self.session.get_tracing_info(&id).await {
            Ok(info) => self.log.record_command(&format!(
                "-- TRACING {id}: 이벤트 {}개, {}µs (코디네이터 {})",
                info.events.len(),
                info.duration.unwrap_or_default(),
                info.coordinator
                    .map(|ip| ip.to_string())
                    .unwrap_or_default()
            )),
            Err(err) => self
                .log
                .record_command(&format!("-- TRACING {id}: 기록을 읽지 못했습니다 ({err})")),
        }
    }

    /// The table a SELECT's rows can be edited in, and its key: a table
    /// (not a view) whose whole primary key the result carries.
    async fn source_of(&self, cql: &str, columns: &[String]) -> Option<(String, Vec<String>)> {
        let (keyspace, table, _) = cql::select_source(cql)?;
        let keyspace = keyspace.or_else(|| self.keyspace())?;
        let info = self.table_info(&keyspace, &table).await.ok()?;
        if info.view {
            return None;
        }
        let key: Vec<String> = info
            .key_columns()
            .map(|column| column.name.clone())
            .collect();
        if key.is_empty() || !key.iter().all(|name| columns.contains(name)) {
            return None;
        }
        if !columns.iter().all(|name| info.column(name).is_some()) {
            return None;
        }
        Some((self.shown_name(&keyspace, &table), key))
    }

    async fn table_info(&self, keyspace: &str, table: &str) -> Result<Arc<TableInfo>, EngineError> {
        let key = (keyspace.to_string(), table.to_string());
        if let Some(info) = lock(&self.tables).get(&key) {
            return Ok(info.clone());
        }
        let info = Arc::new(schema::table_info(self, keyspace, table).await?);
        lock(&self.tables).insert(key, info.clone());
        Ok(info)
    }

    fn forget_tables(&self) {
        lock(&self.tables).clear();
    }

    /// A single row answering one of TablePeek's own commands.
    fn answer(&self, columns: &[&str], row: Vec<Value>) -> Result<QueryData, EngineError> {
        let columns: Vec<String> = columns.iter().map(|name| name.to_string()).collect();
        let values = row.into_iter().map(|value| vec![value]).collect();
        let (schema, batches) = build_arrow(&columns, values, 1)?;
        Ok(QueryData {
            kind: self.id,
            columns,
            schema,
            batches,
            row_count: 1,
            ..QueryData::empty()
        })
    }

    fn consistency_row(&self) -> Result<QueryData, EngineError> {
        self.answer(
            &["consistency", "serial_consistency"],
            vec![
                Value::String(level_name(*lock(&self.consistency)).into()),
                Value::String(serial_name(*lock(&self.serial)).into()),
            ],
        )
    }

    /// One statement, or one of the commands TablePeek answers itself.
    async fn run(
        &self,
        statement: &str,
        max_rows: usize,
        page: Option<&str>,
    ) -> Result<QueryData, EngineError> {
        match cql::command(statement) {
            cql::Command::Consistency(level) => {
                self.log.record_command(statement);
                if let Some(level) = level {
                    let level = level_named(&level).ok_or_else(|| {
                        EngineError::BadRequest(format!("알 수 없는 일관성 수준: {level}"))
                    })?;
                    *lock(&self.consistency) = level;
                }
                self.consistency_row()
            }
            cql::Command::SerialConsistency(level) => {
                self.log.record_command(statement);
                if let Some(level) = level {
                    let level = serial_named(&level).ok_or_else(|| {
                        EngineError::BadRequest(
                            "직렬 일관성 수준은 SERIAL이나 LOCAL_SERIAL입니다".into(),
                        )
                    })?;
                    *lock(&self.serial) = level;
                }
                self.consistency_row()
            }
            cql::Command::Tracing(switch) => {
                self.log.record_command(statement);
                if let Some(on) = switch {
                    self.tracing.store(on, Ordering::Relaxed);
                }
                let on = self.tracing.load(Ordering::Relaxed);
                self.answer(
                    &["tracing"],
                    vec![Value::String(if on { "ON" } else { "OFF" }.into())],
                )
            }
            cql::Command::Explain(inner) => self.explain(inner).await,
            cql::Command::CopyTable { target, source } => {
                let copied = steps::copy_table(self, target, source).await;
                self.forget_tables();
                copied
            }
            cql::Command::Use(keyspace) => {
                let data = self.read(statement, max_rows, None, false).await?;
                *lock(&self.keyspace) = Some(keyspace);
                self.forget_tables();
                Ok(data)
            }
            cql::Command::Cql => {
                let traced = self.tracing.load(Ordering::Relaxed);
                let data = self.read(statement, max_rows, page, traced).await;
                if cql::changes_schema(statement) {
                    self.forget_tables();
                }
                data
            }
        }
    }

    /// TablePeek's EXPLAIN: the statement run once with tracing (a read
    /// only up to its first page), its trace events as rows.
    async fn explain(&self, inner: &str) -> Result<QueryData, EngineError> {
        if cql::split(inner).len() != 1 || !matches!(cql::command(inner), cql::Command::Cql) {
            return Err(EngineError::BadRequest(
                "EXPLAIN 뒤에는 CQL 문장 하나를 쓰세요".into(),
            ));
        }
        let started = Instant::now();
        let mut statement = self.statement(inner, 100, self.page_timeout());
        statement.set_tracing(true);
        let (result, _) = self.page(statement, PagingState::start()).await?;
        let id = result
            .tracing_id()
            .ok_or_else(|| self.internal("서버가 추적 ID를 주지 않았습니다"))?;
        let info = self
            .session
            .get_tracing_info(&id)
            .await
            .map_err(|err| self.internal(format!("추적 기록을 읽지 못했습니다: {err}")))?;
        let columns: Vec<String> = ["activity", "source", "source_elapsed", "thread"]
            .iter()
            .map(|name| name.to_string())
            .collect();
        let mut column_values: Vec<Vec<Value>> = vec![Vec::new(); columns.len()];
        let mut events = info.events.clone();
        events.sort_by_key(|event| event.source_elapsed.unwrap_or_default());
        for event in &events {
            column_values[0].push(event.activity.clone().map_or(Value::Null, Value::String));
            column_values[1].push(
                event
                    .source
                    .map_or(Value::Null, |ip| Value::String(ip.to_string())),
            );
            column_values[2].push(event.source_elapsed.map_or(Value::Null, Value::from));
            column_values[3].push(event.thread.clone().map_or(Value::Null, Value::String));
        }
        // The request as a whole closes the list: its kind, coordinator
        // and total time.
        column_values[0].push(Value::String(format!(
            "{} — {}",
            info.request.clone().unwrap_or_else(|| "Request".into()),
            info.parameters
                .as_ref()
                .and_then(|parameters| parameters.get("consistency_level").cloned())
                .unwrap_or_default()
        )));
        column_values[1].push(
            info.coordinator
                .map_or(Value::Null, |ip| Value::String(ip.to_string())),
        );
        column_values[2].push(info.duration.map_or(Value::Null, Value::from));
        column_values[3].push(Value::String("total".into()));
        let count = events.len() + 1;
        let (schema, batches) = build_arrow(&columns, column_values, count)?;
        Ok(QueryData {
            kind: self.id,
            columns,
            schema,
            batches,
            row_count: count,
            elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
            ..QueryData::empty()
        })
    }

    /// Prepares `cql` and binds `inputs` against its markers' types, in
    /// order; the statement as the console shows it comes back too.
    async fn bind(
        &self,
        cql: &str,
        inputs: &[Input<'_>],
    ) -> Result<(PreparedStatement, Vec<Option<CqlValue>>, String), EngineError> {
        let mut prepared = self
            .cancellable(async {
                self.session
                    .prepare(Statement::new(cql))
                    .await
                    .map_err(ExecutionError::from)
            })
            .await?;
        prepared.set_consistency(*lock(&self.consistency));
        prepared.set_serial_consistency(Some(*lock(&self.serial)));
        prepared.set_request_timeout(Some(self.page_timeout()));
        let specs = prepared.get_variable_col_specs();
        if specs.len() != inputs.len() {
            return Err(self.internal("바인드할 값의 수가 맞지 않습니다"));
        }
        let mut bound = Vec::with_capacity(inputs.len());
        for (spec, input) in specs.iter().zip(inputs) {
            bound.push(input.read(spec.typ())?);
        }
        let params: Vec<LogParam> = bound
            .iter()
            .map(|value| values::log_param(value.as_ref()))
            .collect();
        let shown = inline_params(cql, &params, Dialect::Cql);
        Ok((prepared, bound, shown))
    }

    /// Runs a change made from the grid; it goes to History. Answers
    /// whether it applied: a conditional write's `[applied]`, or true.
    async fn change(&self, cql: &str, inputs: &[Input<'_>]) -> Result<bool, EngineError> {
        let (prepared, bound, shown) = self.bind(cql, inputs).await?;
        self.log.record(&shown, Dialect::Cql);
        let started = Instant::now();
        let result = self
            .cancellable(self.session.execute_unpaged(&prepared, bound))
            .await?;
        let applied = applied(result);
        if applied {
            self.log.changed(
                Change {
                    sql: shown,
                    ms: started.elapsed().as_millis() as u64,
                    rows: 1,
                },
                false,
            );
        }
        Ok(applied)
    }

    /// The table an edit goes to, refusing a view.
    async fn editable(&self, table: &str) -> Result<Arc<TableInfo>, EngineError> {
        let (keyspace, name) = self.resolve(table)?;
        let info = self.table_info(&keyspace, &name).await?;
        if info.view {
            return Err(EngineError::NotEditable(
                "구체화된 뷰는 원본 테이블을 따라 바뀝니다. 원본 테이블에서 편집하세요".into(),
            ));
        }
        Ok(info)
    }

    /// `WHERE k1 = ? AND k2 = ?` over `columns`, with their values from the
    /// grid's key: each one must be there.
    fn key_clause<'a>(
        info: &TableInfo,
        columns: impl Iterator<Item = &'a schema::ColumnInfo>,
        pk: &'a [PkValue],
        inputs: &mut Vec<Input<'a>>,
    ) -> Result<String, EngineError> {
        let mut terms = Vec::new();
        for column in columns {
            let value = pk
                .iter()
                .find(|key| key.column == column.name)
                .ok_or_else(|| {
                    EngineError::NotEditable(format!(
                        "{} 테이블의 기본 키 컬럼 {}의 값이 없습니다",
                        info.name, column.name
                    ))
                })?;
            terms.push(format!("{} = ?", values::quote_name(&column.name)));
            inputs.push(Input::Cell(&value.value));
        }
        Ok(terms.join(" AND "))
    }
}

/// A value an edit binds, read once the statement's markers say its type.
enum Input<'a> {
    /// Typed into a cell (or None for NULL).
    Text(Option<&'a str>),
    /// A key as the grid read it.
    Cell(&'a Value),
    /// A counter's change.
    Delta(i64),
}

impl Input<'_> {
    fn read(&self, typ: &ColumnType<'_>) -> Result<Option<CqlValue>, EngineError> {
        match self {
            Input::Text(None) => Ok(None),
            Input::Text(Some(text)) => values::from_text(typ, text).map(Some),
            Input::Cell(value) => values::from_cell(typ, value),
            Input::Delta(delta) => Ok(Some(CqlValue::Counter(scylla::value::Counter(*delta)))),
        }
    }
}

/// Whether a write applied: a conditional one says so in `[applied]`.
fn applied(result: QueryResult) -> bool {
    let Ok(rows) = result.into_rows_result() else {
        return true;
    };
    let index = rows
        .column_specs()
        .iter()
        .position(|spec| spec.name() == "[applied]");
    let Some(index) = index else {
        return true;
    };
    let first = rows.rows::<Row>().ok().and_then(|mut rows| rows.next());
    !matches!(
        first
            .and_then(Result::ok)
            .and_then(|row| row.columns.into_iter().nth(index).flatten()),
        Some(CqlValue::Boolean(false))
    )
}

fn encode_page(state: &PagingState) -> String {
    let bytes = state
        .as_bytes_slice()
        .map(|bytes| bytes.as_ref())
        .unwrap_or(&[]);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn decode_page(token: &str) -> Result<PagingState, EngineError> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(token.trim())
        .map_err(|_| EngineError::BadRequest("페이지 토큰이 올바르지 않습니다".into()))?;
    Ok(PagingState::new_from_raw_bytes(bytes))
}

/// A connect failure: TLS, the login and the rest told apart.
fn session_error(engine: &'static str, err: &NewSessionError) -> EngineError {
    let raw = err.to_string();
    let lower = raw.to_lowercase();
    let message =
        if crate::caused_by_tls(err) || lower.contains("tls") || lower.contains("certificate") {
            format!("TLS 연결 실패: {raw}")
        } else if lower.contains("authentication")
            || lower.contains("credentials")
            || lower.contains("password")
        {
            format!("로그인 실패: {raw}")
        } else {
            raw.clone()
        };
    EngineError::Driver {
        engine,
        code: None,
        message,
        interrupted: false,
        fields: Box::new(ErrorFields {
            raw: Some(format!("{err:?}")),
            ..ErrorFields::default()
        }),
    }
}

#[async_trait]
impl Driver for CassandraDriver {
    fn id(&self) -> &'static str {
        self.id
    }

    /// The descriptor's, with users only where the cluster checks logins.
    fn capabilities(&self) -> Capabilities {
        let mut capabilities = self.descriptor.capabilities.clone();
        capabilities.users = self.authenticated;
        capabilities
    }

    async fn meta(&self, include_system: bool) -> Result<EngineMeta, EngineError> {
        let tables = schema::table_names(self, include_system).await?;
        Ok(EngineMeta {
            kind: self.id.into(),
            path: None,
            demo: false,
            tables,
            capabilities: None,
        })
    }

    /// CQL has no way to stop a statement: the wait for it stops, and the
    /// server finishes it on its own.
    fn cancel(&self) -> CancelRequest {
        self.cancels.send_modify(|count| *count += 1);
        CancelRequest::Done
    }

    async fn server_info(&self) -> Result<ServerInfo, EngineError> {
        schema::server_info(self).await
    }

    fn sql(&self) -> Option<&dyn SqlDriver> {
        Some(self)
    }
}

#[async_trait]
impl SqlDriver for CassandraDriver {
    fn dialect(&self) -> Dialect {
        Dialect::Cql
    }

    async fn schema(&self, include_system: bool) -> Result<Vec<TableSchema>, EngineError> {
        self.forget_tables();
        schema::schema(self, include_system).await
    }

    /// CQL has no foreign keys.
    async fn relations(&self, _include_system: bool) -> Result<Vec<Relation>, EngineError> {
        Ok(Vec::new())
    }

    /// An exact count, in token ranges counted several at once (`steps`).
    async fn table_count(&self, name: &str) -> Result<i64, EngineError> {
        let (keyspace, table) = self.resolve(name)?;
        let cql = format!(
            "SELECT COUNT(*) FROM {}.{}",
            values::quote_name(&keyspace),
            values::quote_name(&table)
        );
        let mut rows = 0;
        let mut cursor: Option<String> = None;
        loop {
            let step =
                steps::count_step(self, &cql, cursor.as_deref(), Duration::from_secs(3600)).await?;
            rows += step.rows;
            match step.cursor {
                Some(next) => cursor = Some(next),
                None => return Ok(rows),
            }
        }
    }

    async fn databases(&self) -> Result<Vec<String>, EngineError> {
        schema::keyspaces(self, false).await
    }

    async fn query(&self, sql: &str, max_rows: usize) -> Result<QueryData, EngineError> {
        let statements = cql::split(sql);
        let Some((last, earlier)) = statements.split_last() else {
            return Err(EngineError::BadRequest("실행할 CQL 문장이 없습니다".into()));
        };
        for statement in earlier {
            self.run(statement, max_rows, None).await?;
        }
        self.run(last, max_rows, None).await
    }

    async fn query_from(
        &self,
        sql: &str,
        max_rows: usize,
        page: &str,
    ) -> Result<QueryData, EngineError> {
        let statements = cql::split(sql);
        let [statement] = statements.as_slice() else {
            return Err(EngineError::BadRequest(
                "페이지 토큰으로는 문장 하나만 이어 읽을 수 있습니다".into(),
            ));
        };
        self.run(statement, max_rows, Some(page)).await
    }

    async fn skip_rows(
        &self,
        sql: &str,
        skip: &SkipRequest,
        budget: Duration,
    ) -> Result<SkipOutcome, EngineError> {
        steps::skip_rows(self, sql, skip, budget).await
    }

    async fn count_step(
        &self,
        sql: &str,
        cursor: Option<&str>,
        budget: Duration,
    ) -> Result<CountStep, EngineError> {
        steps::count_step(self, sql, cursor, budget).await
    }

    /// A counter's new value needs the one the grid showed: see `edit_seen`.
    async fn edit(&self, target: &EditTarget) -> Result<u64, EngineError> {
        self.edit_cell(target, CounterEdit::Shown(None)).await
    }

    /// A counter changes by the difference between the value typed and the
    /// one the grid showed, as one increment; refused if the counter has
    /// moved since it was read.
    async fn edit_seen(&self, target: &EditTarget, seen: &[PkValue]) -> Result<u64, EngineError> {
        let shown = seen
            .iter()
            .find(|value| value.column == target.column)
            .and_then(|value| whole_number(&value.value));
        self.edit_cell(target, CounterEdit::Shown(shown)).await
    }

    /// `c = c + n` on a counter, which the server applies atomically.
    async fn edit_add(&self, target: &EditTarget) -> Result<u64, EngineError> {
        self.edit_cell(target, CounterEdit::Add).await
    }

    async fn insert_row(&self, table: &str, row: &[InsertValue]) -> Result<u64, EngineError> {
        let info = self.editable(table).await?;
        for value in row {
            if info.column(&value.column).is_none() {
                return Err(EngineError::BadRequest(format!(
                    "{} 컬럼이 없습니다",
                    value.column
                )));
            }
        }
        let given = |name: &str| row.iter().find(|value| value.column == name);
        for key in info.key_columns() {
            if given(&key.name).is_none_or(|value| value.value.is_none() && value.expr.is_none()) {
                return Err(EngineError::BadRequest(format!(
                    "기본 키 컬럼 {}의 값을 넣으세요",
                    key.name
                )));
            }
        }
        if info.counter() {
            return self.insert_counters(&info, row).await;
        }
        let mut names = Vec::new();
        let mut markers = Vec::new();
        let mut inputs = Vec::new();
        for value in row {
            let column = info.column(&value.column).expect("checked above");
            let marker = match value.expr {
                Some(ValueExpr::Default) => continue,
                Some(ValueExpr::Now) => schema::parse_type(&column.type_text)
                    .as_ref()
                    .and_then(values::now_function)
                    .map(str::to_string)
                    .ok_or_else(|| {
                        EngineError::BadRequest(format!(
                            "{} 컬럼에는 현재 시각을 넣을 수 없습니다",
                            column.name
                        ))
                    })?,
                None => {
                    inputs.push(Input::Text(value.value.as_deref()));
                    "?".to_string()
                }
            };
            names.push(values::quote_name(&column.name));
            markers.push(marker);
        }
        let condition = if self.lwt_checks {
            " IF NOT EXISTS"
        } else {
            ""
        };
        let cql = format!(
            "INSERT INTO {} ({}) VALUES ({}){condition}",
            info.quoted(),
            names.join(", "),
            markers.join(", ")
        );
        if !self.change(&cql, &inputs).await? {
            return Err(EngineError::BadRequest(
                "같은 기본 키를 가진 행이 이미 있습니다 (IF NOT EXISTS)".into(),
            ));
        }
        Ok(1)
    }

    async fn delete_row(&self, table: &str, pk: &[PkValue]) -> Result<u64, EngineError> {
        let info = self.editable(table).await?;
        let mut inputs = Vec::new();
        let clause = Self::key_clause(&info, info.key_columns(), pk, &mut inputs)?;
        let condition = if self.lwt_checks && !info.counter() {
            " IF EXISTS"
        } else {
            ""
        };
        let cql = format!("DELETE FROM {} WHERE {clause}{condition}", info.quoted());
        Ok(u64::from(self.change(&cql, &inputs).await?))
    }

    async fn table_detail(&self, name: &str) -> Result<TableDetail, EngineError> {
        let (keyspace, table) = self.resolve(name)?;
        schema::table_detail(self, &keyspace, &table, name).await
    }

    async fn objects(&self, include_system: bool) -> Result<DbObjects, EngineError> {
        schema::objects(self, include_system).await
    }

    async fn object_definition(
        &self,
        kind: &str,
        name: &str,
    ) -> Result<Option<ObjectDefinition>, EngineError> {
        schema::object_definition(self, kind, name).await
    }

    async fn kill_session(&self, _id: &str) -> Result<(), EngineError> {
        Err(EngineError::Unsupported(
            "CQL에는 다른 연결을 끊는 명령이 없습니다".into(),
        ))
    }

    async fn in_tx(&self) -> Result<bool, EngineError> {
        Ok(false)
    }

    async fn tx(&self, _op: TxOp) -> Result<(), EngineError> {
        Err(EngineError::Unsupported(
            "CQL에는 트랜잭션이 없습니다 (배치는 BEGIN BATCH … APPLY BATCH로 씁니다)".into(),
        ))
    }

    fn set_query_timeout(&self, secs: u64) {
        self.timeout_secs.store(secs, Ordering::Relaxed);
    }
}

/// What a counter edit's value means.
#[derive(Debug, Clone, Copy)]
enum CounterEdit {
    /// The value the cell should show; with the one the grid showed, when
    /// it gave one.
    Shown(Option<i64>),
    /// An amount to add.
    Add,
}

/// A whole number as the grid sends a counter (a number, or text); NULL,
/// which a counter never set reads as, is 0.
fn whole_number(value: &Value) -> Option<i64> {
    match value {
        Value::Null => Some(0),
        Value::Number(number) => number.as_i64(),
        Value::String(text) => text.trim().parse().ok(),
        _ => None,
    }
}

impl CassandraDriver {
    /// A cell's edit: a value bound against the column's type, NOW, or on a
    /// counter an increment (`mode`), with IF EXISTS where the connection
    /// checks.
    async fn edit_cell(&self, target: &EditTarget, mode: CounterEdit) -> Result<u64, EngineError> {
        let info = self.editable(&target.table).await?;
        let column = info.column(&target.column).ok_or_else(|| {
            EngineError::NotEditable(format!("{} 컬럼이 없습니다", target.column))
        })?;
        if column.kind.is_key() {
            return Err(EngineError::NotEditable(
                "기본 키 컬럼은 바꿀 수 없습니다. 새 행을 넣고 이 행을 지우세요".into(),
            ));
        }
        let name = values::quote_name(&column.name);
        let mut inputs = Vec::new();
        let counter = column.type_text == "counter";
        if matches!(mode, CounterEdit::Add) && (!counter || target.expr.is_some()) {
            return Err(EngineError::NotEditable(format!(
                "더할 값은 counter 컬럼에만 씁니다 ({}은(는) {})",
                column.name, column.type_text
            )));
        }
        let set = match (target.expr, &target.value) {
            (Some(ValueExpr::Default), _) => {
                return Err(EngineError::NotEditable(
                    "CQL 컬럼에는 기본값이 없습니다. NULL로 비우세요".into(),
                ))
            }
            (Some(ValueExpr::Now), _) => {
                let typ = schema::parse_type(&column.type_text);
                let function = typ.as_ref().and_then(values::now_function).ok_or_else(|| {
                    EngineError::NotEditable(format!(
                        "{} 컬럼에는 현재 시각을 넣을 수 없습니다",
                        column.type_text
                    ))
                })?;
                format!("{name} = {function}")
            }
            (None, Some(text)) if counter => {
                let number: i64 = text.trim().parse().map_err(|_| {
                    EngineError::BadRequest(format!("counter 값이 아닙니다: {text}"))
                })?;
                let delta = match mode {
                    CounterEdit::Add => number,
                    CounterEdit::Shown(None) => {
                        return Err(EngineError::NotEditable(format!(
                            "counter {}는 화면에 보인 값과 함께 고치거나 '더할 값'으로 바꿉니다",
                            column.name
                        )))
                    }
                    CounterEdit::Shown(Some(shown)) => {
                        let current = self.counter_value(&info, column, &target.pk).await?;
                        let delta = number.checked_sub(shown).ok_or_else(|| {
                            EngineError::BadRequest(format!("counter 값이 너무 큽니다: {text}"))
                        })?;
                        if current != shown {
                            return Err(EngineError::BadRequest(format!(
                                "counter {}의 값이 화면에 읽은 뒤 {shown}에서 {current}(으)로 바뀌어 저장하지 않았습니다. \
                                 {number}(으)로 맞추려면 새로고침한 뒤 다시 고치고, 지금 값에 {delta:+}만큼 더하려면 '더할 값'으로 바꾸세요",
                                column.name
                            )));
                        }
                        if delta == 0 {
                            return Ok(1);
                        }
                        delta
                    }
                };
                inputs.push(Input::Delta(delta));
                format!("{name} = {name} + ?")
            }
            (None, None) if counter => {
                return Err(EngineError::NotEditable(
                    "counter 컬럼은 NULL로 만들 수 없습니다. 행을 지우세요".into(),
                ))
            }
            (None, value) => {
                inputs.push(Input::Text(value.as_deref()));
                format!("{name} = ?")
            }
        };
        // A static column belongs to the partition: only its key picks it.
        let key_columns: Vec<&schema::ColumnInfo> = if column.kind == ColumnKind::Static {
            info.partition_columns().collect()
        } else {
            info.key_columns().collect()
        };
        let clause = Self::key_clause(&info, key_columns.into_iter(), &target.pk, &mut inputs)?;
        let condition = if self.lwt_checks && !info.counter() {
            " IF EXISTS"
        } else {
            ""
        };
        let cql = format!(
            "UPDATE {} SET {set} WHERE {clause}{condition}",
            info.quoted()
        );
        Ok(u64::from(self.change(&cql, &inputs).await?))
    }

    /// A counter's value now, which an edit's new value is measured from.
    async fn counter_value(
        &self,
        info: &TableInfo,
        column: &schema::ColumnInfo,
        pk: &[PkValue],
    ) -> Result<i64, EngineError> {
        let mut inputs = Vec::new();
        let clause = Self::key_clause(info, info.key_columns(), pk, &mut inputs)?;
        let cql = format!(
            "SELECT {} FROM {} WHERE {clause}",
            values::quote_name(&column.name),
            info.quoted()
        );
        let (prepared, bound, shown) = self.bind(&cql, &inputs).await?;
        self.log.record(&shown, Dialect::Cql);
        let result = self
            .cancellable(self.session.execute_unpaged(&prepared, bound))
            .await?;
        let rows = result
            .into_rows_result()
            .map_err(|err| self.internal(err))?;
        let first = rows
            .rows::<Row>()
            .map_err(|err| self.internal(err))?
            .next()
            .transpose()
            .map_err(|err| self.internal(err))?;
        Ok(first
            .and_then(|row| row.columns.into_iter().next().flatten())
            .and_then(|value| values::counter_of(&value))
            .unwrap_or_default())
    }

    /// A counter table takes no INSERT: each counter given is added to the
    /// row its key names (made by the first addition). A row already there
    /// is refused rather than added to; CQL takes no IF NOT EXISTS on a
    /// counter table, so the check is a read just before.
    async fn insert_counters(
        &self,
        info: &TableInfo,
        row: &[InsertValue],
    ) -> Result<u64, EngineError> {
        let pk: Vec<PkValue> = info
            .key_columns()
            .filter_map(|key| {
                let value = row.iter().find(|value| value.column == key.name)?;
                Some(PkValue {
                    column: key.name.clone(),
                    value: value.value.clone().map_or(Value::Null, Value::String),
                })
            })
            .collect();
        let mut sets = Vec::new();
        let mut inputs = Vec::new();
        for value in row {
            let column = info.column(&value.column).expect("checked by insert_row");
            if column.kind.is_key() {
                continue;
            }
            let Some(text) = value.value.as_deref() else {
                continue;
            };
            let amount: i64 = text
                .trim()
                .parse()
                .map_err(|_| EngineError::BadRequest(format!("counter 값이 아닙니다: {text}")))?;
            let name = values::quote_name(&column.name);
            sets.push(format!("{name} = {name} + ?"));
            inputs.push(Input::Delta(amount));
        }
        if sets.is_empty() {
            return Err(EngineError::BadRequest(
                "counter 테이블의 행은 counter 값을 하나 이상 넣어야 생깁니다".into(),
            ));
        }
        let clause = Self::key_clause(info, info.key_columns(), &pk, &mut inputs)?;
        let mut key_inputs = Vec::new();
        let key = Self::key_clause(info, info.key_columns(), &pk, &mut key_inputs)?;
        let probe = format!(
            "SELECT {} FROM {} WHERE {key} LIMIT 1",
            values::quote_name(&info.key_columns().next().expect("a table has a key").name),
            info.quoted()
        );
        let (prepared, bound, shown) = self.bind(&probe, &key_inputs).await?;
        self.log.record(&shown, Dialect::Cql);
        let found = self
            .cancellable(self.session.execute_unpaged(&prepared, bound))
            .await?
            .into_rows_result()
            .map_or(0, |rows| rows.rows_num());
        if found > 0 {
            return Err(EngineError::BadRequest(
                "같은 기본 키를 가진 counter 행이 이미 있습니다. 그 행의 counter를 고치거나 '더할 값'으로 더하세요".into(),
            ));
        }
        let cql = format!(
            "UPDATE {} SET {} WHERE {clause}",
            info.quoted(),
            sets.join(", ")
        );
        self.change(&cql, &inputs).await?;
        Ok(1)
    }
}

#[cfg(test)]
mod tests;
