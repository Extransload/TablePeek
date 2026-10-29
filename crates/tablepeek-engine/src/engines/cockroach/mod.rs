//! CockroachDB: PostgreSQL's driver under its own descriptor (port,
//! capabilities); the SQL it sends differs where `crate::postgres` checks
//! for the "cockroach" kind.

use std::sync::{Arc, LazyLock};

use async_trait::async_trait;
use tablepeek_types::ConnConfig;

use crate::driver::Driver;
use crate::engines::postgres;
use crate::registry::{parse_descriptor, ConfigProblem, DriverFactory, EngineDescriptor, NetRoute};
use crate::sql_log::SqlLog;
use crate::EngineError;

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
        postgres::settings(self.descriptor(), config).map(|_| ())
    }

    async fn connect(
        &self,
        config: &ConnConfig,
        net: &NetRoute,
        log: SqlLog,
    ) -> Result<Arc<dyn Driver>, EngineError> {
        postgres::open(self.descriptor(), config, net, log).await
    }
}
