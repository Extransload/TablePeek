//! One folder per engine: its descriptor (`descriptor.json`), its factory
//! and its driver. The engines registered here are listed in
//! `registry::factories()`.

pub mod cassandra;
pub mod clickhouse;
pub mod cockroach;
pub mod elasticsearch;
pub mod mongodb;
pub mod mssql;
pub mod mysql;
pub mod oracle;
pub mod postgres;
pub mod scylladb;
pub mod sqlite;
