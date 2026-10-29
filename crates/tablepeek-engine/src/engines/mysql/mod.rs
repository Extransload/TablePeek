//! MySQL and MariaDB.

use std::sync::{Arc, LazyLock};

use async_trait::async_trait;
use tablepeek_types::{
    Capabilities, ConnConfig, DbObjects, EditTarget, EngineMeta, InsertValue, MySqlConfig,
    ObjectDefinition, PkValue, Relation, ServerInfo, TableDetail, TableSchema,
};

use crate::driver::{CancelRequest, Driver, SqlDriver, TxOp};
use crate::mysql::{self as imp, MySqlInner};
use crate::registry::{
    check_host, parse_descriptor, typed_config, ConfigProblem, DriverFactory, EngineDescriptor,
    NetRoute,
};
use crate::sql_log::{Dialect, SqlLog};
use crate::{EngineError, QueryData};

pub struct Factory;

pub static FACTORY: Factory = Factory;

static DESCRIPTOR: LazyLock<EngineDescriptor> =
    LazyLock::new(|| parse_descriptor(include_str!("descriptor.json")));

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
        open(self.descriptor(), config, net, log).await
    }
}

fn settings(
    descriptor: &EngineDescriptor,
    config: &ConnConfig,
) -> Result<MySqlConfig, ConfigProblem> {
    let settings: MySqlConfig = typed_config(descriptor, config)?;
    check_host(&settings.host)?;
    Ok(settings)
}

async fn open(
    descriptor: &'static EngineDescriptor,
    config: &ConnConfig,
    net: &NetRoute,
    log: SqlLog,
) -> Result<Arc<dyn Driver>, EngineError> {
    let mut settings =
        settings(descriptor, config).map_err(|problem| EngineError::BadRequest(problem.message))?;
    net.apply(&mut settings.host, &mut settings.port);
    let inner = imp::connect(&settings, log).await?;
    Ok(Arc::new(MySqlDriver { inner, descriptor }))
}

pub(crate) struct MySqlDriver {
    inner: Arc<MySqlInner>,
    descriptor: &'static EngineDescriptor,
}

#[async_trait]
impl Driver for MySqlDriver {
    fn id(&self) -> &'static str {
        "mysql"
    }

    fn capabilities(&self) -> Capabilities {
        self.descriptor.capabilities.clone()
    }

    async fn meta(&self, include_system: bool) -> Result<EngineMeta, EngineError> {
        imp::meta(&self.inner, include_system).await
    }

    fn cancel(&self) -> CancelRequest {
        CancelRequest::Sent {
            request: self.inner.cancel(),
            lands_later: false,
        }
    }

    async fn server_info(&self) -> Result<ServerInfo, EngineError> {
        imp::server_info(&self.inner).await
    }

    fn sql(&self) -> Option<&dyn SqlDriver> {
        Some(self)
    }
}

#[async_trait]
impl SqlDriver for MySqlDriver {
    fn dialect(&self) -> Dialect {
        Dialect::MySql
    }

    async fn schema(&self, include_system: bool) -> Result<Vec<TableSchema>, EngineError> {
        imp::schema(&self.inner, include_system).await
    }

    async fn relations(&self, include_system: bool) -> Result<Vec<Relation>, EngineError> {
        imp::relations(&self.inner, include_system).await
    }

    async fn table_count(&self, name: &str) -> Result<i64, EngineError> {
        imp::table_count(&self.inner, name).await
    }

    async fn databases(&self) -> Result<Vec<String>, EngineError> {
        imp::databases(&self.inner).await
    }

    async fn query(&self, sql: &str, max_rows: usize) -> Result<QueryData, EngineError> {
        imp::query(&self.inner, sql, max_rows).await
    }

    async fn edit(&self, target: &EditTarget) -> Result<u64, EngineError> {
        imp::edit(&self.inner, target).await
    }

    async fn insert_row(&self, table: &str, values: &[InsertValue]) -> Result<u64, EngineError> {
        imp::insert_row(&self.inner, table, values).await
    }

    async fn delete_row(&self, table: &str, pk: &[PkValue]) -> Result<u64, EngineError> {
        imp::delete_row(&self.inner, table, pk).await
    }

    async fn table_detail(&self, name: &str) -> Result<TableDetail, EngineError> {
        imp::table_detail(&self.inner, name).await
    }

    async fn objects(&self, include_system: bool) -> Result<DbObjects, EngineError> {
        imp::objects(&self.inner, include_system).await
    }

    async fn object_definition(
        &self,
        kind: &str,
        name: &str,
    ) -> Result<Option<ObjectDefinition>, EngineError> {
        imp::object_definition(&self.inner, kind, name).await
    }

    async fn kill_session(&self, id: u64) -> Result<(), EngineError> {
        imp::kill_session(&self.inner, id).await
    }

    async fn in_tx(&self) -> Result<bool, EngineError> {
        Ok(self.inner.in_tx())
    }

    async fn tx(&self, op: TxOp) -> Result<(), EngineError> {
        imp::tx(&self.inner, op.statement()).await
    }
}
