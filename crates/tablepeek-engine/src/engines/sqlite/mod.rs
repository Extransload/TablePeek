//! SQLite: a local file, or the in-memory demo. Its statements run on a
//! blocking thread; the work itself lives in the crate root's `*_sync`
//! functions.

use std::path::PathBuf;
use std::sync::{Arc, LazyLock};

use async_trait::async_trait;
use serde_json::Value;
use tablepeek_types::{
    Capabilities, CellRef, ConnConfig, DbObjects, EditTarget, EngineMeta, InsertValue,
    ObjectDefinition, PkValue, Relation, ServerInfo, TableDetail, TableSchema,
};

use crate::driver::{CancelRequest, Driver, FileStream, SqlDriver, TxOp};
use crate::registry::{parse_descriptor, ConfigProblem, DriverFactory, EngineDescriptor, NetRoute};
use crate::sql_log::{Dialect, SqlLog};
use crate::{EngineError, QueryData, SqliteInner};

pub struct Factory;

pub static FACTORY: Factory = Factory;

static DESCRIPTOR: LazyLock<EngineDescriptor> =
    LazyLock::new(|| parse_descriptor(include_str!("descriptor.json")));

fn path_of(config: &ConnConfig) -> Result<&str, ConfigProblem> {
    config
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| ConfigProblem::invalid("SQLite 파일 경로를 입력하세요"))
}

#[async_trait]
impl DriverFactory for Factory {
    fn descriptor(&self) -> &'static EngineDescriptor {
        &DESCRIPTOR
    }

    fn validate(&self, config: &ConnConfig) -> Result<(), ConfigProblem> {
        path_of(config).map(|_| ())
    }

    /// A file has no address, so `net` never leads anywhere else.
    async fn connect(
        &self,
        config: &ConnConfig,
        _net: &NetRoute,
        log: SqlLog,
    ) -> Result<Arc<dyn Driver>, EngineError> {
        let path = path_of(config).map_err(|problem| EngineError::BadRequest(problem.message))?;
        let path = PathBuf::from(path);
        let inner = tokio::task::spawn_blocking(move || crate::open_file_inner(&path, log))
            .await
            .map_err(|e| EngineError::Internal(e.to_string()))??;
        Ok(SqliteDriver::open(inner))
    }
}

pub(crate) struct SqliteDriver {
    inner: Arc<SqliteInner>,
}

impl SqliteDriver {
    pub(crate) fn open(inner: Arc<SqliteInner>) -> Arc<dyn Driver> {
        Arc::new(Self { inner })
    }

    /// Runs `work` on the connection off the async workers.
    async fn blocking<T, F>(&self, work: F) -> Result<T, EngineError>
    where
        T: Send + 'static,
        F: FnOnce(&SqliteInner) -> Result<T, EngineError> + Send + 'static,
    {
        let inner = self.inner.clone();
        tokio::task::spawn_blocking(move || work(&inner))
            .await
            .map_err(|e| EngineError::Internal(e.to_string()))?
    }
}

#[async_trait]
impl Driver for SqliteDriver {
    fn id(&self) -> &'static str {
        "sqlite"
    }

    fn capabilities(&self) -> Capabilities {
        DESCRIPTOR.capabilities.clone()
    }

    async fn meta(&self, include_system: bool) -> Result<EngineMeta, EngineError> {
        self.blocking(move |inner| crate::meta_sync(inner, include_system))
            .await
    }

    /// SQLite's interrupt takes effect at once.
    fn cancel(&self) -> CancelRequest {
        self.inner.interrupt.interrupt();
        CancelRequest::Done
    }

    async fn server_info(&self) -> Result<ServerInfo, EngineError> {
        self.blocking(crate::server_info_sync).await
    }

    fn file(&self) -> Option<PathBuf> {
        self.inner.path.clone()
    }

    fn sql(&self) -> Option<&dyn SqlDriver> {
        Some(self)
    }
}

#[async_trait]
impl SqlDriver for SqliteDriver {
    fn dialect(&self) -> Dialect {
        Dialect::Sqlite
    }

    async fn schema(&self, include_system: bool) -> Result<Vec<TableSchema>, EngineError> {
        self.blocking(move |inner| crate::schema_sync(inner, include_system))
            .await
    }

    async fn relations(&self, include_system: bool) -> Result<Vec<Relation>, EngineError> {
        self.blocking(move |inner| crate::relations_sync(inner, include_system))
            .await
    }

    async fn table_count(&self, name: &str) -> Result<i64, EngineError> {
        let name = name.to_string();
        self.blocking(move |inner| crate::table_count_sync(inner, &name))
            .await
    }

    /// A file is one database: nothing to switch to.
    async fn databases(&self) -> Result<Vec<String>, EngineError> {
        Ok(Vec::new())
    }

    async fn query(&self, sql: &str, max_rows: usize) -> Result<QueryData, EngineError> {
        let sql = sql.to_string();
        self.blocking(move |inner| crate::run_query_sync(inner, &sql, max_rows))
            .await
    }

    async fn edit(&self, target: &EditTarget) -> Result<u64, EngineError> {
        let target = target.clone();
        self.blocking(move |inner| crate::edit_sync(inner, &target))
            .await
    }

    async fn insert_row(&self, table: &str, values: &[InsertValue]) -> Result<u64, EngineError> {
        let table = table.to_string();
        let values = values.to_vec();
        self.blocking(move |inner| crate::insert_sync(inner, &table, &values))
            .await
    }

    async fn delete_row(&self, table: &str, pk: &[PkValue]) -> Result<u64, EngineError> {
        let table = table.to_string();
        let pk = pk.to_vec();
        self.blocking(move |inner| crate::delete_sync(inner, &table, &pk))
            .await
    }

    async fn table_detail(&self, name: &str) -> Result<TableDetail, EngineError> {
        let name = name.to_string();
        self.blocking(move |inner| crate::table_detail_sync(inner, &name))
            .await
    }

    async fn objects(&self, include_system: bool) -> Result<DbObjects, EngineError> {
        self.blocking(move |inner| crate::objects_sync(inner, include_system))
            .await
    }

    async fn object_definition(
        &self,
        kind: &str,
        name: &str,
    ) -> Result<Option<ObjectDefinition>, EngineError> {
        let kind = kind.to_string();
        let name = name.to_string();
        self.blocking(move |inner| crate::object_definition_sync(inner, &kind, &name))
            .await
    }

    async fn kill_session(&self, _id: &str) -> Result<(), EngineError> {
        Err(EngineError::BadRequest(
            "이 엔진은 세션 종료를 지원하지 않습니다".into(),
        ))
    }

    async fn in_tx(&self) -> Result<bool, EngineError> {
        self.blocking(|inner| {
            let conn = crate::lock_conn(inner)?;
            Ok(!conn.is_autocommit())
        })
        .await
    }

    async fn tx(&self, op: TxOp) -> Result<(), EngineError> {
        self.blocking(move |inner| {
            let conn = crate::lock_conn(inner)?;
            match op {
                TxOp::Begin if !conn.is_autocommit() => {
                    return Err(EngineError::BadRequest(
                        "이미 트랜잭션이 진행 중입니다".into(),
                    ));
                }
                TxOp::Commit | TxOp::Rollback if conn.is_autocommit() => {
                    // Gone already (an error rolled it back): so is its work.
                    conn.log.settle(false);
                    return Err(EngineError::BadRequest(
                        "진행 중인 트랜잭션이 없습니다".into(),
                    ));
                }
                _ => {}
            }
            conn.execute_batch(op.statement())?;
            if op == TxOp::Begin {
                // Whatever an earlier, untracked transaction left.
                conn.log.settle(false);
            } else {
                conn.log.ended(op == TxOp::Commit);
            }
            Ok(())
        })
        .await
    }

    async fn read_cell(&self, cell: &CellRef) -> Result<FileStream, EngineError> {
        crate::sqlite_cells::read_cell(self.inner.clone(), cell).await
    }

    async fn write_cell(&self, cell: &CellRef, data: FileStream) -> Result<u64, EngineError> {
        crate::sqlite_cells::write_cell(self.inner.clone(), cell, data).await
    }
}
