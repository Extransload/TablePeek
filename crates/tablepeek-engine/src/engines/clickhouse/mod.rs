//! ClickHouse, over its HTTP interface (see `client`). Rows are edited by
//! the table's sorting key: a cell with ALTER TABLE … UPDATE (a mutation,
//! waited for), a row deleted with a lightweight DELETE where the server has
//! one; ClickHouse has no transactions, so every change stands at once.

mod catalog;
mod client;
mod rows;
#[cfg(test)]
mod tests;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard, PoisonError};

use async_trait::async_trait;
use serde::Deserialize;
use tablepeek_types::{
    Capabilities, ConnConfig, DbObjects, EditTarget, EngineMeta, InsertValue, ObjectDefinition,
    PkValue, Relation, ServerInfo, TableDetail, TableSchema,
};

use crate::driver::{CancelRequest, Driver, FileStream, NativeExport, SqlDriver, TxOp};
use crate::registry::{
    check_host, parse_descriptor, typed_config, ConfigProblem, DriverFactory, EngineDescriptor,
    NetRoute,
};
use crate::source_cache::SourceCache;
use crate::sql_log::{Dialect, SqlLog};
use crate::{EngineError, QueryData};

use client::{Client, Request};

pub struct Factory;

pub static FACTORY: Factory = Factory;

static DESCRIPTOR: LazyLock<EngineDescriptor> =
    LazyLock::new(|| parse_descriptor(include_str!("descriptor.json")));

/// A connection's settings (the descriptor's form fields).
#[derive(Debug, Clone, Deserialize)]
pub(crate) struct ClickHouseConfig {
    pub host: String,
    pub port: u16,
    #[serde(default = "default_user")]
    pub user: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub tls: bool,
    #[serde(default)]
    pub tls_ca_file: Option<String>,
    #[serde(default)]
    pub tls_skip_verify: bool,
    /// The cluster the app's structure changes run on (ON CLUSTER), also
    /// where row edits of a table every server keeps apart go.
    #[serde(default)]
    pub cluster: String,
}

fn default_user() -> String {
    "default".into()
}

#[async_trait]
impl DriverFactory for Factory {
    fn descriptor(&self) -> &'static EngineDescriptor {
        &DESCRIPTOR
    }

    fn validate(&self, config: &ConnConfig) -> Result<(), ConfigProblem> {
        settings(self.descriptor(), config).map(|_| ())
    }

    async fn connect(
        &self,
        config: &ConnConfig,
        net: &NetRoute,
        log: SqlLog,
    ) -> Result<Arc<dyn Driver>, EngineError> {
        let settings = settings(self.descriptor(), config)
            .map_err(|problem| EngineError::BadRequest(problem.message))?;
        let inner = connect(&settings, net, log, self.descriptor()).await?;
        Ok(Arc::new(ClickHouseDriver { inner }))
    }
}

fn settings(
    descriptor: &EngineDescriptor,
    config: &ConnConfig,
) -> Result<ClickHouseConfig, ConfigProblem> {
    let mut settings: ClickHouseConfig = typed_config(descriptor, config)?;
    check_host(&settings.host)?;
    if settings.user.trim().is_empty() {
        settings.user = default_user();
    }
    Ok(settings)
}

/// One connection: an HTTP client and the session the editor's statements
/// share, with what was learned of the server on connecting.
pub(crate) struct ClickHouseInner {
    client: Client,
    /// The session's current database, as USE left it.
    database: Mutex<String>,
    /// `version()`, and its major and minor numbers.
    version: String,
    release: (u32, u32),
    capabilities: Capabilities,
    /// The session takes one statement at a time; a second would be refused.
    session: tokio::sync::Mutex<()>,
    /// The query id of the page's statement running now, for a cancel.
    running: Mutex<Option<String>>,
    /// Settings' query time limit in seconds (0: none).
    timeout_secs: AtomicU64,
    /// Sorting key columns by (database, table), for the grid's edits;
    /// None for a table that can't be edited by key.
    sources: SourceCache<(String, String), Option<Vec<String>>>,
    /// `user@host:port`, before the current database in the meta's path.
    address: String,
    /// The connection's `cluster` setting, if any.
    cluster: Option<String>,
}

impl ClickHouseInner {
    fn database(&self) -> String {
        self.database
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    fn running(&self) -> MutexGuard<'_, Option<String>> {
        self.running.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Whether the server takes DELETE FROM (lightweight deletes, 23.3).
    fn lightweight_delete(&self) -> bool {
        self.release >= (23, 3)
    }

    /// Whether the server takes UPDATE … SET (lightweight updates, 25.7),
    /// on tables that keep block numbers and offsets.
    fn lightweight_update(&self) -> bool {
        self.release >= (25, 7)
    }

    /// The connection as the page labels it: `user@host:port/database`.
    fn label_for(&self, database: &str) -> String {
        format!("{}/{database}", self.address)
    }

    /// Stops the page's statement running now, if any, from a request of
    /// its own (KILL QUERY finds it by its query id).
    fn cancel(&self) -> Option<tokio::task::JoinHandle<()>> {
        let query_id = self.running().clone()?;
        let database = self.database();
        let client = self.client.clone();
        Some(tokio::spawn(async move {
            let sql = format!(
                "KILL QUERY WHERE query_id = {} ASYNC",
                rows::string_literal(&query_id)
            );
            let _ = client.execute(&sql, Request::read(&database)).await;
        }))
    }
}

async fn connect(
    config: &ClickHouseConfig,
    net: &NetRoute,
    log: SqlLog,
    descriptor: &'static EngineDescriptor,
) -> Result<Arc<ClickHouseInner>, EngineError> {
    crate::ensure_crypto_provider();
    let session_id = uuid::Uuid::new_v4().to_string();
    let client = Client::new(config, net, session_id, log.clone())?;
    // Into the database the settings name, for the editor's session.
    if !config.database.trim().is_empty() {
        let sql = format!("USE {}", rows::quote_ident(config.database.trim()));
        client.execute(&sql, Request::session(usize::MAX)).await?;
    }
    let reply = client
        .run(
            "SELECT version(), currentDatabase(), getSetting('readonly')",
            Request::session(usize::MAX),
        )
        .await?;
    let row = reply.rows.into_iter().next().unwrap_or_default();
    let text = |index: usize| row.get(index).and_then(client::text_of).unwrap_or_default();
    let version = text(0);
    let database = text(1);
    let readonly = text(2) != "0";
    let mut capabilities = descriptor.capabilities.clone();
    if readonly {
        // A read-only account: nothing that writes is offered.
        capabilities.edit_by_key = false;
        capabilities.ddl = false;
        capabilities.users = false;
        capabilities.indexes.create = false;
        capabilities.indexes.drop = false;
        capabilities.import_formats.clear();
    } else {
        // The user screens read system.users, which takes the right to.
        capabilities.users = client
            .execute(
                "SELECT name FROM system.users LIMIT 1",
                Request::read(&database),
            )
            .await
            .is_ok();
    }
    Ok(Arc::new(ClickHouseInner {
        address: format!("{}@{}:{}", config.user, config.host, config.port),
        cluster: Some(config.cluster.trim().to_string()).filter(|name| !name.is_empty()),
        client,
        database: Mutex::new(database),
        release: release_of(&version),
        version,
        capabilities,
        session: tokio::sync::Mutex::new(()),
        running: Mutex::new(None),
        timeout_secs: AtomicU64::new(0),
        sources: SourceCache::default(),
    }))
}

/// "25.8.3.1" → (25, 8).
fn release_of(version: &str) -> (u32, u32) {
    let mut parts = version
        .split('.')
        .map(|part| part.parse::<u32>().unwrap_or(0));
    (parts.next().unwrap_or(0), parts.next().unwrap_or(0))
}

pub(crate) struct ClickHouseDriver {
    inner: Arc<ClickHouseInner>,
}

#[async_trait]
impl Driver for ClickHouseDriver {
    fn id(&self) -> &'static str {
        "clickhouse"
    }

    fn capabilities(&self) -> Capabilities {
        self.inner.capabilities.clone()
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
impl SqlDriver for ClickHouseDriver {
    fn dialect(&self) -> Dialect {
        Dialect::ClickHouse
    }

    async fn schema(&self, include_system: bool) -> Result<Vec<TableSchema>, EngineError> {
        catalog::schema(&self.inner, include_system).await
    }

    async fn relations(&self, _include_system: bool) -> Result<Vec<Relation>, EngineError> {
        // ClickHouse has no foreign keys.
        Ok(Vec::new())
    }

    async fn table_count(&self, name: &str) -> Result<i64, EngineError> {
        catalog::table_count(&self.inner, name).await
    }

    async fn databases(&self) -> Result<Vec<String>, EngineError> {
        catalog::databases(&self.inner).await
    }

    async fn query(&self, sql: &str, max_rows: usize) -> Result<QueryData, EngineError> {
        rows::query(&self.inner, sql, max_rows).await
    }

    async fn edit(&self, target: &EditTarget) -> Result<u64, EngineError> {
        rows::edit(&self.inner, target, &[]).await
    }

    async fn edit_seen(&self, target: &EditTarget, seen: &[PkValue]) -> Result<u64, EngineError> {
        rows::edit(&self.inner, target, seen).await
    }

    async fn insert_row(&self, table: &str, values: &[InsertValue]) -> Result<u64, EngineError> {
        rows::insert_row(&self.inner, table, values).await
    }

    async fn delete_row(&self, table: &str, pk: &[PkValue]) -> Result<u64, EngineError> {
        rows::delete_row(&self.inner, table, pk, &[]).await
    }

    async fn delete_row_seen(
        &self,
        table: &str,
        pk: &[PkValue],
        seen: &[PkValue],
    ) -> Result<u64, EngineError> {
        rows::delete_row(&self.inner, table, pk, seen).await
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

    async fn kill_session(&self, id: &str) -> Result<(), EngineError> {
        catalog::kill_session(&self.inner, id).await
    }

    async fn in_tx(&self) -> Result<bool, EngineError> {
        Ok(false)
    }

    async fn tx(&self, _op: TxOp) -> Result<(), EngineError> {
        Err(EngineError::Unsupported(
            "ClickHouse는 트랜잭션을 지원하지 않습니다".into(),
        ))
    }

    fn set_query_timeout(&self, secs: u64) {
        self.inner.timeout_secs.store(secs, Ordering::SeqCst);
    }

    async fn export_native(
        &self,
        sql: &str,
        export: &NativeExport,
    ) -> Result<FileStream, EngineError> {
        rows::export_native(&self.inner, sql, export).await
    }
}
