//! What a CQL cluster holds, read from system_schema: keyspaces, tables,
//! materialized views, UDTs, functions, aggregates, indexes and triggers,
//! their CREATE statements (the server's DESCRIBE where it has one, else
//! written from the schema tables), and the server's own description.

use scylla::frame::response::result::{ColumnType, NativeType};
use scylla::value::{CqlValue, Row};
use tablepeek_types::{
    ColumnSchema, DbObjects, IndexInfo, ObjectDefinition, ServerInfo, ServerSession, TableDetail,
    TableProperty, TableSchema, TriggerInfo,
};

use super::values::{self, quote_name};
use super::CassandraDriver;
use crate::EngineError;

/// Text in column `index` of a system table's row.
pub(crate) fn text(row: &Row, index: usize) -> Option<String> {
    match row.columns.get(index)?.as_ref()? {
        CqlValue::Text(text) | CqlValue::Ascii(text) => Some(text.clone()),
        other => Some(values::literal(other)),
    }
}

fn number(row: &Row, index: usize) -> Option<i64> {
    match row.columns.get(index)?.as_ref()? {
        CqlValue::Int(value) => Some(i64::from(*value)),
        CqlValue::BigInt(value) | CqlValue::Counter(scylla::value::Counter(value)) => Some(*value),
        CqlValue::SmallInt(value) => Some(i64::from(*value)),
        _ => None,
    }
}

fn texts(row: &Row, index: usize) -> Vec<String> {
    match row.columns.get(index).and_then(Option::as_ref) {
        Some(CqlValue::List(items) | CqlValue::Set(items)) => items
            .iter()
            .map(|item| match item {
                CqlValue::Text(text) | CqlValue::Ascii(text) => text.clone(),
                other => values::literal(other),
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn text_map(row: &Row, index: usize) -> Vec<(String, String)> {
    match row.columns.get(index).and_then(Option::as_ref) {
        Some(CqlValue::Map(pairs)) => pairs
            .iter()
            .map(|(key, value)| {
                let shown = |value: &CqlValue| match value {
                    CqlValue::Text(text) | CqlValue::Ascii(text) => text.clone(),
                    other => values::literal(other),
                };
                (shown(key), shown(value))
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// A string as a CQL literal.
fn lit(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

fn qualified(keyspace: &str, name: &str) -> String {
    format!("{}.{}", quote_name(keyspace), quote_name(name))
}

/// Keyspaces Cassandra and ScyllaDB keep for themselves.
pub(crate) fn is_system(keyspace: &str) -> bool {
    keyspace.starts_with("system")
}

/// What a column is to its table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum ColumnKind {
    PartitionKey,
    Clustering,
    Static,
    Regular,
}

impl ColumnKind {
    fn read(kind: &str) -> Self {
        match kind {
            "partition_key" => ColumnKind::PartitionKey,
            "clustering" => ColumnKind::Clustering,
            "static" => ColumnKind::Static,
            _ => ColumnKind::Regular,
        }
    }

    pub(crate) fn is_key(self) -> bool {
        matches!(self, ColumnKind::PartitionKey | ColumnKind::Clustering)
    }
}

#[derive(Debug, Clone)]
pub(crate) struct ColumnInfo {
    pub(crate) name: String,
    pub(crate) kind: ColumnKind,
    pub(crate) position: i64,
    /// "asc", "desc" or "none".
    pub(crate) clustering_order: String,
    /// As system_schema writes it ("frozen<list<text>>").
    pub(crate) type_text: String,
}

/// A table's (or materialized view's) columns, key first, the rest by name.
#[derive(Debug, Clone)]
pub(crate) struct TableInfo {
    pub(crate) keyspace: String,
    pub(crate) name: String,
    pub(crate) view: bool,
    pub(crate) columns: Vec<ColumnInfo>,
}

impl TableInfo {
    pub(crate) fn column(&self, name: &str) -> Option<&ColumnInfo> {
        self.columns.iter().find(|column| column.name == name)
    }

    pub(crate) fn key_columns(&self) -> impl Iterator<Item = &ColumnInfo> {
        self.columns.iter().filter(|column| column.kind.is_key())
    }

    pub(crate) fn partition_columns(&self) -> impl Iterator<Item = &ColumnInfo> {
        self.columns
            .iter()
            .filter(|column| column.kind == ColumnKind::PartitionKey)
    }

    /// A counter table: its rows change by addition, never by INSERT.
    pub(crate) fn counter(&self) -> bool {
        self.columns
            .iter()
            .any(|column| !column.kind.is_key() && column.type_text == "counter")
    }

    pub(crate) fn quoted(&self) -> String {
        qualified(&self.keyspace, &self.name)
    }

    /// `PRIMARY KEY ((a, b), c, d)`.
    fn primary_key(&self) -> String {
        let partition: Vec<String> = self
            .partition_columns()
            .map(|c| quote_name(&c.name))
            .collect();
        let clustering: Vec<String> = self
            .columns
            .iter()
            .filter(|column| column.kind == ColumnKind::Clustering)
            .map(|column| quote_name(&column.name))
            .collect();
        let partition = if partition.len() == 1 && !clustering.is_empty() {
            partition[0].clone()
        } else {
            format!("({})", partition.join(", "))
        };
        let mut parts = vec![partition];
        parts.extend(clustering);
        format!("PRIMARY KEY ({})", parts.join(", "))
    }

    /// `CLUSTERING ORDER BY (c DESC, d ASC)`, when a clustering column is
    /// in descending order.
    fn clustering_order(&self) -> Option<String> {
        let clustering: Vec<&ColumnInfo> = self
            .columns
            .iter()
            .filter(|column| column.kind == ColumnKind::Clustering)
            .collect();
        clustering
            .iter()
            .any(|column| column.clustering_order == "desc")
            .then(|| {
                format!(
                    "CLUSTERING ORDER BY ({})",
                    clustering
                        .iter()
                        .map(|column| format!(
                            "{} {}",
                            quote_name(&column.name),
                            column.clustering_order.to_uppercase()
                        ))
                        .collect::<Vec<_>>()
                        .join(", ")
                )
            })
    }
}

/// The partition key, then the clustering columns, each in key order; the
/// static and regular columns after them by name, as cqlsh lists them.
fn sort_columns(columns: &mut [ColumnInfo]) {
    use std::cmp::Ordering;
    columns.sort_by(|a, b| match (a.kind.is_key(), b.kind.is_key()) {
        (true, true) => a.kind.cmp(&b.kind).then(a.position.cmp(&b.position)),
        (true, false) => Ordering::Less,
        (false, true) => Ordering::Greater,
        (false, false) => a.name.cmp(&b.name),
    });
}

const COLUMNS_SELECT: &str =
    "SELECT table_name, column_name, kind, position, clustering_order, type FROM system_schema.columns";

fn column_of(row: &Row) -> Option<(String, ColumnInfo)> {
    Some((
        text(row, 0)?,
        ColumnInfo {
            name: text(row, 1)?,
            kind: ColumnKind::read(&text(row, 2).unwrap_or_default()),
            position: number(row, 3).unwrap_or_default(),
            clustering_order: text(row, 4).unwrap_or_else(|| "none".into()),
            type_text: text(row, 5).unwrap_or_default(),
        },
    ))
}

pub(crate) async fn table_info(
    driver: &CassandraDriver,
    keyspace: &str,
    table: &str,
) -> Result<TableInfo, EngineError> {
    let rows = driver
        .meta_rows(&format!(
            "{COLUMNS_SELECT} WHERE keyspace_name = {} AND table_name = {}",
            lit(keyspace),
            lit(table)
        ))
        .await?;
    let mut columns: Vec<ColumnInfo> = rows.iter().filter_map(column_of).map(|(_, c)| c).collect();
    if columns.is_empty() {
        return Err(EngineError::TableNotFound);
    }
    sort_columns(&mut columns);
    let view = !driver
        .meta_rows(&format!(
            "SELECT view_name FROM system_schema.views WHERE keyspace_name = {} AND view_name = {}",
            lit(keyspace),
            lit(table)
        ))
        .await?
        .is_empty();
    Ok(TableInfo {
        keyspace: keyspace.to_string(),
        name: table.to_string(),
        view,
        columns,
    })
}

/// The keyspaces there are, the system's own only when asked.
pub(crate) async fn keyspaces(
    driver: &CassandraDriver,
    include_system: bool,
) -> Result<Vec<String>, EngineError> {
    let mut names: Vec<String> = driver
        .meta_rows("SELECT keyspace_name FROM system_schema.keyspaces")
        .await?
        .iter()
        .filter_map(|row| text(row, 0))
        .filter(|name| include_system || !is_system(name))
        .collect();
    names.sort();
    Ok(names)
}

/// The keyspaces the sidebar shows: the connection's (with the system's
/// when asked), or every one when it has none.
async fn scope(driver: &CassandraDriver, include_system: bool) -> Result<Vec<String>, EngineError> {
    match driver.keyspace() {
        Some(keyspace) => {
            let mut names = vec![keyspace.clone()];
            if include_system {
                names.extend(
                    keyspaces(driver, true)
                        .await?
                        .into_iter()
                        .filter(|name| is_system(name) && *name != keyspace),
                );
            }
            Ok(names)
        }
        None => keyspaces(driver, include_system).await,
    }
}

async fn names_in(
    driver: &CassandraDriver,
    keyspace: &str,
    cql: &str,
) -> Result<Vec<String>, EngineError> {
    let mut names: Vec<String> = driver
        .meta_rows(&format!("{cql} WHERE keyspace_name = {}", lit(keyspace)))
        .await?
        .iter()
        .filter_map(|row| text(row, 0))
        .collect();
    names.sort();
    names.dedup();
    Ok(names)
}

pub(crate) async fn table_names(
    driver: &CassandraDriver,
    include_system: bool,
) -> Result<Vec<String>, EngineError> {
    let mut out = Vec::new();
    for keyspace in scope(driver, include_system).await? {
        for table in names_in(
            driver,
            &keyspace,
            "SELECT table_name FROM system_schema.tables",
        )
        .await?
        {
            out.push(driver.shown_name(&keyspace, &table));
        }
    }
    Ok(out)
}

fn column_schema(column: &ColumnInfo) -> ColumnSchema {
    ColumnSchema {
        name: column.name.clone(),
        decl_type: Some(column.type_text.clone()),
        not_null: column.kind.is_key(),
        pk: column.kind.is_key(),
        default: None,
        enum_values: None,
    }
}

pub(crate) async fn schema(
    driver: &CassandraDriver,
    include_system: bool,
) -> Result<Vec<TableSchema>, EngineError> {
    let mut out = Vec::new();
    for keyspace in scope(driver, include_system).await? {
        let tables = names_in(
            driver,
            &keyspace,
            "SELECT table_name FROM system_schema.tables",
        )
        .await?;
        let rows = driver
            .meta_rows(&format!(
                "{COLUMNS_SELECT} WHERE keyspace_name = {}",
                lit(&keyspace)
            ))
            .await?;
        for table in tables {
            let mut columns: Vec<ColumnInfo> = rows
                .iter()
                .filter_map(column_of)
                .filter(|(owner, _)| *owner == table)
                .map(|(_, column)| column)
                .collect();
            sort_columns(&mut columns);
            out.push(TableSchema {
                name: driver.shown_name(&keyspace, &table),
                columns: columns.iter().map(column_schema).collect(),
            });
        }
    }
    Ok(out)
}

/// The server's own CREATE statement for an object (DESCRIBE, Cassandra 4
/// and ScyllaDB 6 on); None where the server has no DESCRIBE.
async fn describe(driver: &CassandraDriver, what: &str, name: &str) -> Option<String> {
    let rows = driver
        .meta_rows(&format!("DESCRIBE {what} {name}"))
        .await
        .ok()?;
    let statements: Vec<String> = rows
        .iter()
        .filter_map(|row| {
            row.columns
                .len()
                .checked_sub(1)
                .and_then(|last| text(row, last))
        })
        .collect();
    (!statements.is_empty()).then(|| statements.join("\n\n"))
}

/// A table's properties from system_schema, every column but its names.
pub(crate) async fn properties(
    driver: &CassandraDriver,
    keyspace: &str,
    table: &str,
    view: bool,
) -> Result<(Vec<TableProperty>, Option<String>), EngineError> {
    let (source, key) = if view {
        ("system_schema.views", "view_name")
    } else {
        ("system_schema.tables", "table_name")
    };
    let cql = format!(
        "SELECT * FROM {source} WHERE keyspace_name = {} AND {key} = {}",
        lit(keyspace),
        lit(table)
    );
    let (result, _) = driver
        .page(
            driver.statement(&cql, 1, super::META_TIMEOUT),
            scylla::response::PagingState::start(),
        )
        .await?;
    let rows = result
        .into_rows_result()
        .map_err(|err| driver.internal(err))?;
    let names: Vec<String> = rows
        .column_specs()
        .iter()
        .map(|spec| spec.name().to_string())
        .collect();
    let Some(row) = rows
        .rows::<Row>()
        .map_err(|err| driver.internal(err))?
        .next()
        .transpose()
        .map_err(|err| driver.internal(err))?
    else {
        return Ok((Vec::new(), None));
    };
    let mut comment = None;
    let mut out = Vec::new();
    for (name, value) in names.iter().zip(row.columns.iter()) {
        if matches!(
            name.as_str(),
            "keyspace_name" | "table_name" | "view_name" | "id" | "base_table_id" | "flags"
        ) {
            continue;
        }
        let Some(value) = value else {
            continue;
        };
        let shown = match value {
            CqlValue::Text(text) | CqlValue::Ascii(text) => text.clone(),
            other => values::literal(other),
        };
        if name == "comment" {
            comment = Some(shown.clone()).filter(|text| !text.is_empty());
        }
        out.push(TableProperty {
            name: name.clone(),
            value: shown,
        });
    }
    Ok((out, comment))
}

/// CREATE TABLE written from the schema, for servers without DESCRIBE and
/// for a copy of a table under another name.
pub(crate) fn create_table(info: &TableInfo, properties: &[TableProperty]) -> String {
    let mut lines: Vec<String> = info
        .columns
        .iter()
        .map(|column| {
            let mut line = format!("    {} {}", quote_name(&column.name), column.type_text);
            if column.kind == ColumnKind::Static {
                line.push_str(" static");
            }
            line
        })
        .collect();
    lines.push(format!("    {}", info.primary_key()));
    let mut out = format!("CREATE TABLE {} (\n{}\n)", info.quoted(), lines.join(",\n"));
    let mut options: Vec<String> = info.clustering_order().into_iter().collect();
    for property in properties {
        let value = &property.value;
        let written = match property.name.as_str() {
            "comment" => lit(value),
            "compaction" | "compression" | "caching" | "extensions" => value.clone(),
            "default_time_to_live" | "gc_grace_seconds" | "bloom_filter_fp_chance" => value.clone(),
            _ => continue,
        };
        options.push(format!("{} = {written}", property.name));
    }
    if !options.is_empty() {
        out.push_str(&format!(" WITH {}", options.join("\n    AND ")));
    }
    out.push(';');
    out
}

pub(crate) async fn table_detail(
    driver: &CassandraDriver,
    keyspace: &str,
    table: &str,
    shown: &str,
) -> Result<TableDetail, EngineError> {
    let info = driver.table_info(keyspace, table).await?;
    let (properties, comment) = properties(driver, keyspace, table, info.view).await?;
    let key: Vec<String> = info
        .key_columns()
        .map(|column| column.name.clone())
        .collect();
    let mut indexes = vec![IndexInfo {
        name: "PRIMARY KEY".into(),
        unique: true,
        primary: true,
        columns: key,
        definition: Some(info.primary_key()),
        ..IndexInfo::default()
    }];
    let index_rows = driver
        .meta_rows(&format!(
            "SELECT index_name, kind, options FROM system_schema.indexes WHERE keyspace_name = {} AND table_name = {}",
            lit(keyspace),
            lit(table)
        ))
        .await
        .unwrap_or_default();
    for row in &index_rows {
        let Some(name) = text(row, 0) else {
            continue;
        };
        let options = text_map(row, 2);
        let option = |key: &str| {
            options
                .iter()
                .find(|(name, _)| name == key)
                .map(|(_, value)| value.clone())
        };
        let target = option("target").unwrap_or_default();
        let class = option("class_name");
        let definition = match &class {
            Some(class) => format!(
                "CREATE CUSTOM INDEX {} ON {} ({target}) USING {};",
                quote_name(&name),
                info.quoted(),
                lit(class)
            ),
            None => format!(
                "CREATE INDEX {} ON {} ({target});",
                quote_name(&name),
                info.quoted()
            ),
        };
        // "name", "\"Mixed\"", or "values(tags)", "keys(m)", "full(f)".
        let inner = match (target.find('('), target.ends_with(')')) {
            (Some(open), true) if !target.starts_with('"') => &target[open + 1..target.len() - 1],
            _ => target.as_str(),
        };
        let column = super::cql::unquote(inner.trim());
        let column = if info.column(&target).is_some() {
            target.clone()
        } else {
            column
        };
        indexes.push(IndexInfo {
            name,
            unique: false,
            primary: false,
            columns: vec![column],
            definition: Some(local(driver, keyspace, &definition)),
            ..IndexInfo::default()
        });
    }
    let triggers = driver
        .meta_rows(&format!(
            "SELECT trigger_name, options FROM system_schema.triggers WHERE keyspace_name = {} AND table_name = {}",
            lit(keyspace),
            lit(table)
        ))
        .await
        .unwrap_or_default()
        .iter()
        .filter_map(|row| {
            let name = text(row, 0)?;
            let class = text_map(row, 1)
                .into_iter()
                .find(|(key, _)| key == "class")
                .map(|(_, class)| class)
                .unwrap_or_default();
            Some(TriggerInfo {
                definition: Some(format!(
                    "CREATE TRIGGER {} ON {} USING {};",
                    quote_name(&name),
                    info.quoted(),
                    lit(&class)
                )),
                name,
                timing: None,
                event: None,
            })
        })
        .collect();
    let what = if info.view {
        "MATERIALIZED VIEW"
    } else {
        "TABLE"
    };
    let ddl = match describe(driver, what, &info.quoted()).await {
        Some(ddl) => ddl,
        None if info.view => view_ddl(driver, keyspace, table).await?.unwrap_or_default(),
        None => create_table(&info, &properties),
    };
    let (partitions, size_bytes) = estimates(driver, keyspace, table).await;
    // Rows sampled from the ring; the server's partition count where the
    // ring can't be sampled.
    let row_count_estimate = super::steps::estimate_rows(driver, &info)
        .await
        .or(partitions);
    Ok(TableDetail {
        name: shown.to_string(),
        row_count_estimate,
        size_bytes,
        data_bytes: None,
        index_bytes: None,
        comment,
        columns: info.columns.iter().map(column_schema).collect(),
        indexes,
        foreign_keys: Vec::new(),
        triggers,
        ddl: Some(local(driver, keyspace, &ddl)),
        schema: Some(keyspace.to_string()),
        properties,
    })
}

/// A statement with the connection's own keyspace left out of its names, as
/// the sidebar lists them: a backup of it restores into whichever keyspace
/// it is run in.
fn local(driver: &CassandraDriver, keyspace: &str, statement: &str) -> String {
    if driver.keyspace().as_deref() != Some(keyspace) {
        return statement.to_string();
    }
    statement.replace(&format!(" {}.", quote_name(keyspace)), " ")
}

/// Partitions and bytes, from the server's size estimates: refreshed every
/// few minutes, empty until a table is flushed. A node keeps estimates for
/// the token ranges it holds, so the sums are scaled up by the share of the
/// ring those ranges cover.
async fn estimates(
    driver: &CassandraDriver,
    keyspace: &str,
    table: &str,
) -> (Option<i64>, Option<i64>) {
    let Ok(rows) = driver
        .meta_rows(&format!(
            "SELECT partitions_count, mean_partition_size, range_start, range_end FROM system.size_estimates WHERE keyspace_name = {} AND table_name = {}",
            lit(keyspace),
            lit(table)
        ))
        .await
    else {
        return (None, None);
    };
    if rows.is_empty() {
        return (None, None);
    }
    const RING: i128 = 1 << 64;
    let mut partitions = 0i64;
    let mut bytes = 0i64;
    let mut covered = 0i128;
    for row in &rows {
        let count = number(row, 0).unwrap_or_default();
        partitions += count;
        bytes += count.saturating_mul(number(row, 1).unwrap_or_default());
        let start = text(row, 2).and_then(|token| token.parse::<i128>().ok());
        let end = text(row, 3).and_then(|token| token.parse::<i128>().ok());
        if let (Some(start), Some(end)) = (start, end) {
            covered += (end - start).rem_euclid(RING);
        }
    }
    // Zero until the server has flushed and estimated the table (ScyllaDB
    // right after a load): no estimate, rather than a wrong one.
    if partitions == 0 {
        return (None, None);
    }
    let share = if covered > 0 && covered < RING {
        covered as f64 / RING as f64
    } else {
        1.0
    };
    (
        Some((partitions as f64 / share).round() as i64),
        Some((bytes as f64 / share).round() as i64),
    )
}

pub(crate) async fn objects(
    driver: &CassandraDriver,
    include_system: bool,
) -> Result<DbObjects, EngineError> {
    let mut objects = DbObjects::default();
    for keyspace in scope(driver, include_system).await? {
        let shown = |name: String| driver.shown_name(&keyspace, &name);
        let lists: [(&str, &mut Vec<String>); 5] = [
            (
                "SELECT view_name FROM system_schema.views",
                &mut objects.materialized_views,
            ),
            (
                "SELECT type_name FROM system_schema.types",
                &mut objects.types,
            ),
            (
                "SELECT function_name FROM system_schema.functions",
                &mut objects.functions,
            ),
            (
                "SELECT aggregate_name FROM system_schema.aggregates",
                &mut objects.aggregates,
            ),
            (
                "SELECT trigger_name FROM system_schema.triggers",
                &mut objects.triggers,
            ),
        ];
        // ScyllaDB keeps each secondary index as a view named after it
        // (`<index>_index`): those show under their table's indexes.
        let index_views: Vec<String> = names_in(
            driver,
            &keyspace,
            "SELECT index_name FROM system_schema.indexes",
        )
        .await
        .unwrap_or_default()
        .into_iter()
        .map(|index| format!("{index}_index"))
        .collect();
        for (cql, list) in lists {
            // ScyllaDB has no triggers table: nothing to list there.
            let names = names_in(driver, &keyspace, cql).await.unwrap_or_default();
            list.extend(
                names
                    .into_iter()
                    .filter(|name| !index_views.contains(name))
                    .map(shown),
            );
        }
    }
    Ok(objects)
}

pub(crate) async fn object_definition(
    driver: &CassandraDriver,
    kind: &str,
    name: &str,
) -> Result<Option<ObjectDefinition>, EngineError> {
    let (keyspace, object) = driver.resolve(name)?;
    let ddl = match kind {
        "materialized_view" => {
            match describe(driver, "MATERIALIZED VIEW", &qualified(&keyspace, &object)).await {
                Some(ddl) => Some(ddl),
                None => view_ddl(driver, &keyspace, &object).await?,
            }
        }
        "type" => type_ddl(driver, &keyspace, &object).await?,
        "function" => function_ddl(driver, &keyspace, &object).await?,
        "aggregate" => aggregate_ddl(driver, &keyspace, &object).await?,
        "trigger" => trigger_ddl(driver, &keyspace, &object).await?,
        _ => return Ok(None),
    };
    Ok(ddl.map(|ddl| ObjectDefinition {
        name: name.to_string(),
        kind: kind.to_string(),
        ddl: Some(ddl),
    }))
}

async fn view_ddl(
    driver: &CassandraDriver,
    keyspace: &str,
    view: &str,
) -> Result<Option<String>, EngineError> {
    let rows = driver
        .meta_rows(&format!(
            "SELECT base_table_name, where_clause, include_all_columns FROM system_schema.views WHERE keyspace_name = {} AND view_name = {}",
            lit(keyspace),
            lit(view)
        ))
        .await?;
    let Some(row) = rows.first() else {
        return Ok(None);
    };
    let base = text(row, 0).unwrap_or_default();
    let filter = text(row, 1).unwrap_or_default();
    let all = matches!(row.columns.get(2), Some(Some(CqlValue::Boolean(true))));
    let info = driver.table_info(keyspace, view).await?;
    let select = if all {
        "*".to_string()
    } else {
        info.columns
            .iter()
            .map(|column| quote_name(&column.name))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let mut ddl = format!(
        "CREATE MATERIALIZED VIEW {} AS\n    SELECT {select}\n    FROM {}\n    WHERE {filter}\n    {}",
        qualified(keyspace, view),
        qualified(keyspace, &base),
        info.primary_key()
    );
    if let Some(order) = info.clustering_order() {
        ddl.push_str(&format!("\n    WITH {order}"));
    }
    ddl.push(';');
    Ok(Some(ddl))
}

async fn type_ddl(
    driver: &CassandraDriver,
    keyspace: &str,
    name: &str,
) -> Result<Option<String>, EngineError> {
    let rows = driver
        .meta_rows(&format!(
            "SELECT field_names, field_types FROM system_schema.types WHERE keyspace_name = {} AND type_name = {}",
            lit(keyspace),
            lit(name)
        ))
        .await?;
    Ok(rows.first().map(|row| {
        let fields: Vec<String> = texts(row, 0)
            .iter()
            .zip(texts(row, 1))
            .map(|(field, typ)| format!("    {} {typ}", quote_name(field)))
            .collect();
        format!(
            "CREATE TYPE {} (\n{}\n);",
            qualified(keyspace, name),
            fields.join(",\n")
        )
    }))
}

/// Every overload of a function, one CREATE each.
async fn function_ddl(
    driver: &CassandraDriver,
    keyspace: &str,
    name: &str,
) -> Result<Option<String>, EngineError> {
    let rows = driver
        .meta_rows(&format!(
            "SELECT argument_names, argument_types, called_on_null_input, return_type, language, body FROM system_schema.functions WHERE keyspace_name = {} AND function_name = {}",
            lit(keyspace),
            lit(name)
        ))
        .await?;
    let statements: Vec<String> = rows
        .iter()
        .map(|row| {
            let arguments: Vec<String> = texts(row, 0)
                .iter()
                .zip(texts(row, 1))
                .map(|(argument, typ)| format!("{} {typ}", quote_name(argument)))
                .collect();
            let on_null = if matches!(row.columns.get(2), Some(Some(CqlValue::Boolean(true)))) {
                "CALLED ON NULL INPUT"
            } else {
                "RETURNS NULL ON NULL INPUT"
            };
            format!(
                "CREATE FUNCTION {}({})\n    {on_null}\n    RETURNS {}\n    LANGUAGE {}\n    AS $${}$$;",
                qualified(keyspace, name),
                arguments.join(", "),
                text(row, 3).unwrap_or_default(),
                text(row, 4).unwrap_or_default(),
                text(row, 5).unwrap_or_default()
            )
        })
        .collect();
    Ok((!statements.is_empty()).then(|| statements.join("\n\n")))
}

async fn aggregate_ddl(
    driver: &CassandraDriver,
    keyspace: &str,
    name: &str,
) -> Result<Option<String>, EngineError> {
    let rows = driver
        .meta_rows(&format!(
            "SELECT argument_types, state_func, state_type, final_func, initcond FROM system_schema.aggregates WHERE keyspace_name = {} AND aggregate_name = {}",
            lit(keyspace),
            lit(name)
        ))
        .await?;
    let statements: Vec<String> = rows
        .iter()
        .map(|row| {
            let mut ddl = format!(
                "CREATE AGGREGATE {}({})\n    SFUNC {}\n    STYPE {}",
                qualified(keyspace, name),
                texts(row, 0).join(", "),
                quote_name(&text(row, 1).unwrap_or_default()),
                text(row, 2).unwrap_or_default()
            );
            if let Some(final_func) = text(row, 3) {
                ddl.push_str(&format!("\n    FINALFUNC {}", quote_name(&final_func)));
            }
            if let Some(init) = text(row, 4) {
                ddl.push_str(&format!("\n    INITCOND {init}"));
            }
            ddl.push(';');
            ddl
        })
        .collect();
    Ok((!statements.is_empty()).then(|| statements.join("\n\n")))
}

async fn trigger_ddl(
    driver: &CassandraDriver,
    keyspace: &str,
    name: &str,
) -> Result<Option<String>, EngineError> {
    let rows = driver
        .meta_rows(&format!(
            "SELECT table_name, trigger_name, options FROM system_schema.triggers WHERE keyspace_name = {}",
            lit(keyspace)
        ))
        .await?;
    Ok(rows
        .iter()
        .find(|row| text(row, 1).as_deref() == Some(name))
        .map(|row| {
            let class = text_map(row, 2)
                .into_iter()
                .find(|(key, _)| key == "class")
                .map(|(_, class)| class)
                .unwrap_or_default();
            format!(
                "CREATE TRIGGER {} ON {} USING {};",
                quote_name(name),
                qualified(keyspace, &text(row, 0).unwrap_or_default()),
                lit(&class)
            )
        }))
}

/// The product and version, the cluster, and the clients connected now
/// (Cassandra's system_views.clients, ScyllaDB's system.clients).
pub(crate) async fn server_info(driver: &CassandraDriver) -> Result<ServerInfo, EngineError> {
    let product = &driver.product;
    let version = if product.scylla {
        format!("ScyllaDB {}", product.version)
    } else {
        format!("Apache Cassandra {}", product.version)
    };
    let peers = driver
        .meta_rows("SELECT peer FROM system.peers")
        .await
        .map(|rows| rows.len())
        .unwrap_or_default();
    // ScyllaDB leaves cluster_name empty.
    let nodes = format!("노드 {}개 · 데이터센터 {}", peers + 1, product.datacenter);
    let topology = if product.cluster.is_empty() {
        nodes
    } else {
        format!("클러스터 {} · {nodes}", product.cluster)
    };
    // ScyllaDB's table has no keyspace column.
    let clients = if product.scylla {
        "SELECT address, port, username, connection_stage, driver_name, driver_version FROM system.clients"
    } else {
        "SELECT address, port, username, connection_stage, driver_name, driver_version, keyspace_name FROM system_views.clients"
    };
    let sessions = driver.meta_rows(clients).await.ok().map(|rows| {
        rows.iter()
            .map(|row| {
                let address = text(row, 0).unwrap_or_default();
                let address = address.trim_matches('\'').to_string();
                let driver_name = [text(row, 4), text(row, 5)]
                    .into_iter()
                    .flatten()
                    .collect::<Vec<_>>()
                    .join(" ");
                ServerSession {
                    id: format!("{address}:{}", number(row, 1).unwrap_or_default()),
                    user: text(row, 2).filter(|user| !user.is_empty()),
                    database: text(row, 6).filter(|keyspace| !keyspace.is_empty()),
                    state: text(row, 3),
                    query: Some(driver_name).filter(|name| !name.is_empty()),
                    elapsed_ms: None,
                    is_current: false,
                }
            })
            .collect()
    });
    Ok(ServerInfo {
        driver: driver.id.to_string(),
        version: Some(version),
        database: driver.keyspace(),
        encoding: Some("UTF-8".into()),
        uptime: None,
        size_bytes: None,
        sessions,
        can_kill: false,
        topology: Some(topology),
        host: Some(driver.address.clone()),
    })
}

/// A column type's name read back as the driver's type, for the scalar
/// types an edit's NOW applies to; None for anything else.
pub(crate) fn parse_type(text: &str) -> Option<ColumnType<'static>> {
    let native = match text.trim() {
        "timestamp" => NativeType::Timestamp,
        "date" => NativeType::Date,
        "time" => NativeType::Time,
        "timeuuid" => NativeType::Timeuuid,
        "bigint" => NativeType::BigInt,
        _ => return None,
    };
    Some(ColumnType::Native(native))
}
