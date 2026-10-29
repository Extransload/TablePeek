//! One folder per engine: its descriptor (`descriptor.json`), its factory
//! and its driver. The engines registered here are listed in
//! `registry::factories()`.

pub mod cockroach;
pub mod mongodb;
pub mod mssql;
pub mod mysql;
pub mod postgres;
pub mod sqlite;
