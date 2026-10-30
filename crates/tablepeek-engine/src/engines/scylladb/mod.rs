//! ScyllaDB: Cassandra's CQL driver under ScyllaDB's own descriptor (its
//! label, icon and URL schemes); see `engines::cassandra`.

use std::sync::LazyLock;

use crate::engines::cassandra::Factory;
use crate::registry::{parse_descriptor, EngineDescriptor};

static DESCRIPTOR: LazyLock<EngineDescriptor> =
    LazyLock::new(|| parse_descriptor(include_str!("descriptor.json")));

pub static FACTORY: Factory = Factory::new(&DESCRIPTOR);
