//! What the page lists and shows of the server: tables and their columns,
//! the other objects, a table's structure, databases and running queries.
//! All read from the system tables, on requests of their own beside the
//! editor's session.

use serde_json::Value;
use tablepeek_types::{
    ColumnSchema, DbObjects, EngineMeta, IndexInfo, IndexPart, ObjectDefinition, ServerInfo,
    ServerSession, TableDetail, TableProperty, TableSchema,
};

use crate::{humanize_uptime_ko, EngineError};

use super::client::{text_of, Request};
use super::rows::{display_name, qualified, split_name, string_literal};
use super::ClickHouseInner;

/// Engines of objects that aren't tables: the sidebar lists them apart.
const NOT_TABLES: &str = "('View', 'MaterializedView', 'Dictionary', 'LiveView', 'WindowView')";

/// Which databases a list covers: the current one, and with the system
/// tables shown, `system` too (its tables qualified).
fn databases_filter(current: &str, include_system: bool) -> String {
    if include_system {
        format!("database IN ({}, 'system')", string_literal(current))
    } else {
        format!("database = {}", string_literal(current))
    }
}

fn text_at(row: &[Value], index: usize) -> String {
    row.get(index).and_then(text_of).unwrap_or_default()
}

fn number_at(row: &[Value], index: usize) -> Option<i64> {
    match row.get(index)? {
        Value::Number(number) => number.as_i64(),
        Value::String(text) => text.parse().ok(),
        _ => None,
    }
}

/// The tables a list shows, as (database, name, engine), the current
/// database's first. A materialized view's own storage (`.inner…`) is left
/// out: the view stands for it.
async fn table_list(
    inner: &ClickHouseInner,
    current: &str,
    include_system: bool,
) -> Result<Vec<(String, String, String)>, EngineError> {
    let sql = format!(
        "SELECT database, name, engine FROM system.tables WHERE {} AND engine NOT IN {NOT_TABLES} \
         AND NOT startsWith(name, '.inner') ORDER BY database != {} , database, name",
        databases_filter(current, include_system),
        string_literal(current)
    );
    let reply = inner.client.run(&sql, Request::read(current)).await?;
    Ok(reply
        .rows
        .iter()
        .map(|row| (text_at(row, 0), text_at(row, 1), text_at(row, 2)))
        .collect())
}

pub(crate) async fn meta(
    inner: &ClickHouseInner,
    include_system: bool,
) -> Result<EngineMeta, EngineError> {
    // A reload picks up keys changed elsewhere.
    inner.sources.clear();
    let current = inner.database();
    let tables = table_list(inner, &current, include_system)
        .await?
        .into_iter()
        .map(|(database, name, _)| display_name(&database, &name, &current))
        .collect();
    Ok(EngineMeta {
        kind: "clickhouse".into(),
        path: Some(inner.label_for(&current)),
        demo: false,
        tables,
        capabilities: None,
    })
}

/// A column's default as the structure shows it: DEFAULT's expression
/// alone, the other kinds (MATERIALIZED, ALIAS, EPHEMERAL) named.
fn default_text(kind: &str, expression: &str) -> Option<String> {
    match (kind, expression) {
        ("", _) => None,
        ("DEFAULT", expression) => Some(expression.to_string()),
        (kind, expression) => Some(format!("{kind} {expression}").trim().to_string()),
    }
}

/// An Enum8/Enum16's labels in order: Enum8('a' = 1, 'b' = 2) → [a, b].
fn enum_labels(declared: &str) -> Option<Vec<String>> {
    let base = super::rows::base_type(declared);
    let body = base
        .strip_prefix("Enum8(")
        .or_else(|| base.strip_prefix("Enum16("))
        .or_else(|| base.strip_prefix("Enum("))?;
    let mut labels = Vec::new();
    let mut chars = body.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch != '\'' {
            continue;
        }
        let mut label = String::new();
        while let Some(ch) = chars.next() {
            match ch {
                '\\' => {
                    if let Some(next) = chars.next() {
                        label.push(next);
                    }
                }
                '\'' if chars.peek() == Some(&'\'') => {
                    chars.next();
                    label.push('\'');
                }
                '\'' => break,
                other => label.push(other),
            }
        }
        labels.push(label);
        // Past " = n," to the next label.
        for ch in chars.by_ref() {
            if ch == ',' {
                break;
            }
        }
    }
    (!labels.is_empty()).then_some(labels)
}

fn column_of(row: &[Value], offset: usize, key_columns: bool) -> ColumnSchema {
    let declared = text_at(row, offset + 1);
    let in_key = matches!(row.get(offset + 4), Some(Value::Number(n)) if n.as_i64() == Some(1))
        || matches!(row.get(offset + 4), Some(Value::Bool(true)));
    ColumnSchema {
        name: text_at(row, offset),
        not_null: !declared.starts_with("Nullable(")
            && !declared.starts_with("LowCardinality(Nullable("),
        pk: key_columns && in_key,
        default: default_text(&text_at(row, offset + 2), &text_at(row, offset + 3)),
        enum_values: None,
        decl_type: Some(declared),
    }
}

pub(crate) async fn schema(
    inner: &ClickHouseInner,
    include_system: bool,
) -> Result<Vec<TableSchema>, EngineError> {
    inner.sources.clear();
    let current = inner.database();
    let tables = table_list(inner, &current, include_system).await?;
    // Every column in one round trip.
    let sql = format!(
        "SELECT database, table, name, type, default_kind, default_expression, is_in_sorting_key \
         FROM system.columns WHERE {} ORDER BY database, table, position",
        databases_filter(&current, include_system)
    );
    let reply = inner.client.run(&sql, Request::read(&current)).await?;
    let mut by_table: std::collections::HashMap<(String, String), Vec<ColumnSchema>> =
        std::collections::HashMap::new();
    let keyed: std::collections::HashSet<(String, String)> = tables
        .iter()
        .filter(|(_, _, engine)| engine.ends_with("MergeTree"))
        .map(|(database, name, _)| (database.clone(), name.clone()))
        .collect();
    for row in &reply.rows {
        let key = (text_at(row, 0), text_at(row, 1));
        let column = column_of(row, 2, keyed.contains(&key));
        by_table.entry(key).or_default().push(column);
    }
    // A Distributed table is edited by its local table's key.
    for (database, name, engine) in &tables {
        if engine != "Distributed" {
            continue;
        }
        let Ok(Some(key)) = super::rows::edit_key(inner, database, name).await else {
            continue;
        };
        if let Some(columns) = by_table.get_mut(&(database.clone(), name.clone())) {
            for column in columns {
                column.pk = key.contains(&column.name);
            }
        }
    }
    Ok(tables
        .into_iter()
        .map(|(database, name, _)| {
            let columns = by_table
                .remove(&(database.clone(), name.clone()))
                .unwrap_or_default();
            TableSchema {
                name: display_name(&database, &name, &current),
                columns,
            }
        })
        .collect())
}

pub(crate) async fn table_count(inner: &ClickHouseInner, name: &str) -> Result<i64, EngineError> {
    let current = inner.database();
    let (database, table) = split_name(name, &current);
    let sql = format!("SELECT count() FROM {}", qualified(&database, &table));
    inner
        .client
        .scalar(&sql, Request::read(&current))
        .await?
        .and_then(|text| text.parse().ok())
        .ok_or_else(|| EngineError::Internal("행 수를 가져오지 못했습니다".into()))
}

pub(crate) async fn databases(inner: &ClickHouseInner) -> Result<Vec<String>, EngineError> {
    let current = inner.database();
    let reply = inner
        .client
        .run(
            "SELECT name FROM system.databases ORDER BY name",
            Request::read(&current),
        )
        .await?;
    Ok(reply.rows.iter().map(|row| text_at(row, 0)).collect())
}

/// Bytes as the structure shows them: "1.5 MiB".
fn byte_size(bytes: i64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit + 1 < UNITS.len() {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

/// engine_full's clauses after the engine itself: "MergeTree PARTITION BY
/// … ORDER BY … TTL … SETTINGS …" → its TTL and SETTINGS (the keys have
/// columns of their own in system.tables).
fn engine_clause(engine_full: &str, clause: &str) -> Option<String> {
    const CLAUSES: [&str; 6] = [
        " PARTITION BY ",
        " PRIMARY KEY ",
        " ORDER BY ",
        " SAMPLE BY ",
        " TTL ",
        " SETTINGS ",
    ];
    let start = engine_full.find(clause)? + clause.len();
    let rest = &engine_full[start..];
    let end = CLAUSES
        .iter()
        .filter_map(|other| rest.find(other))
        .min()
        .unwrap_or(rest.len());
    let value = rest[..end].trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// The engine without its clauses: "ReplacingMergeTree(version)".
fn engine_head(engine_full: &str) -> &str {
    [
        " PARTITION BY ",
        " PRIMARY KEY ",
        " ORDER BY ",
        " SAMPLE BY ",
        " TTL ",
        " SETTINGS ",
    ]
    .iter()
    .filter_map(|clause| engine_full.find(clause))
    .min()
    .map_or(engine_full, |end| &engine_full[..end])
}

/// The table property that says whether cell edits are lightweight UPDATEs
/// (web/src/engines/clickhouse/sql.ts offers to turn it on from "꺼짐").
pub(crate) const LIGHTWEIGHT_UPDATE_PROPERTY: &str = "경량 UPDATE";

/// A SETTINGS clause that turns on both columns a lightweight UPDATE finds
/// rows by (enable_block_number_column, enable_block_offset_column).
fn block_columns_on(settings: &str) -> bool {
    ["enable_block_number_column", "enable_block_offset_column"]
        .iter()
        .all(|name| {
            [" = 1", " = true"]
                .iter()
                .any(|value| settings.contains(&format!("{name}{value}")))
        })
}

pub(crate) async fn table_detail(
    inner: &ClickHouseInner,
    name: &str,
) -> Result<TableDetail, EngineError> {
    inner.sources.clear();
    let current = inner.database();
    let (database, table) = split_name(name, &current);
    let db = string_literal(&database);
    let tbl = string_literal(&table);
    let sql = format!(
        "SELECT engine, engine_full, sorting_key, primary_key, partition_key, sampling_key, comment, \
         total_rows, total_bytes FROM system.tables WHERE database = {db} AND name = {tbl}"
    );
    let reply = inner.client.run(&sql, Request::read(&current)).await?;
    let Some(row) = reply.rows.into_iter().next() else {
        return Err(EngineError::TableNotFound);
    };
    let engine = text_at(&row, 0);
    let engine_full = text_at(&row, 1);
    let sorting_key = text_at(&row, 2);
    let primary_key = text_at(&row, 3);
    let partition_key = text_at(&row, 4);
    let sampling_key = text_at(&row, 5);
    let comment = text_at(&row, 6);
    let keyed = engine.ends_with("MergeTree");

    let sql = format!(
        "SELECT name, type, default_kind, default_expression, is_in_sorting_key, comment \
         FROM system.columns WHERE database = {db} AND table = {tbl} ORDER BY position"
    );
    let reply = inner.client.run(&sql, Request::read(&current)).await?;
    let mut columns: Vec<ColumnSchema> = reply
        .rows
        .iter()
        .map(|row| {
            let mut column = column_of(row, 0, keyed);
            column.enum_values = column.decl_type.as_deref().and_then(enum_labels);
            column
        })
        .collect();
    // A Distributed table's rows are edited by its local table's key.
    if engine == "Distributed" {
        if let Ok(Some(key)) = super::rows::edit_key(inner, &database, &table).await {
            for column in &mut columns {
                column.pk = key.contains(&column.name);
            }
        }
    }

    let sql = format!(
        "SELECT name, type_full, expr, granularity FROM system.data_skipping_indices \
         WHERE database = {db} AND table = {tbl} ORDER BY name"
    );
    let indexes: Vec<IndexInfo> = inner
        .client
        .run(&sql, Request::read(&current))
        .await
        .map(|reply| {
            reply
                .rows
                .iter()
                .map(|row| {
                    let name = text_at(row, 0);
                    let kind = text_at(row, 1);
                    let expr = text_at(row, 2);
                    let granularity = text_at(row, 3);
                    let plain = columns.iter().any(|column| column.name == expr);
                    IndexInfo {
                        definition: Some(format!(
                            "INDEX {} {expr} TYPE {kind} GRANULARITY {granularity}",
                            super::rows::quote_ident(&name)
                        )),
                        columns: if plain {
                            vec![expr.clone()]
                        } else {
                            Vec::new()
                        },
                        parts: Some(vec![if plain {
                            IndexPart {
                                column: Some(expr),
                                ..IndexPart::default()
                            }
                        } else {
                            IndexPart {
                                expression: Some(expr),
                                ..IndexPart::default()
                            }
                        }]),
                        name,
                        ..IndexInfo::default()
                    }
                })
                .collect()
        })
        .unwrap_or_default();

    // Active parts: how many, their rows and sizes.
    let sql = format!(
        "SELECT count(), sum(rows), sum(bytes_on_disk), sum(data_uncompressed_bytes) \
         FROM system.parts WHERE active AND database = {db} AND table = {tbl}"
    );
    let parts = inner
        .client
        .run(&sql, Request::read(&current))
        .await
        .ok()
        .and_then(|reply| reply.rows.into_iter().next())
        .unwrap_or_default();

    let ddl_sql = if engine == "Dictionary" {
        format!("SHOW CREATE DICTIONARY {}", qualified(&database, &table))
    } else {
        format!("SHOW CREATE TABLE {}", qualified(&database, &table))
    };
    let ddl = inner
        .client
        .scalar(&ddl_sql, Request::read(&current))
        .await
        .ok()
        .flatten();

    let mut properties = vec![TableProperty {
        name: "엔진".into(),
        value: engine_head(&engine_full).trim().to_string(),
    }];
    let mut push = |name: &str, value: Option<String>| {
        if let Some(value) = value.filter(|value| !value.is_empty()) {
            properties.push(TableProperty {
                name: name.into(),
                value,
            });
        }
    };
    push("ORDER BY", Some(sorting_key.clone()));
    push(
        "PRIMARY KEY",
        (primary_key != sorting_key).then_some(primary_key),
    );
    push("PARTITION BY", Some(partition_key));
    push("SAMPLE BY", Some(sampling_key));
    push("TTL", engine_clause(&engine_full, " TTL "));
    let settings = engine_clause(&engine_full, " SETTINGS ");
    push("SETTINGS", settings.clone());
    let part_count = number_at(&parts, 0).filter(|count| *count > 0 || keyed);
    if keyed {
        push("활성 파트", part_count.map(|count| count.to_string()));
        push("압축 전 크기", number_at(&parts, 3).map(byte_size));
    }
    // Whether cell edits patch rows (lightweight UPDATE) or rewrite parts;
    // the structure pane offers to turn the block columns on.
    if keyed && inner.lightweight_update() {
        let on = block_columns_on(settings.as_deref().unwrap_or_default());
        push(
            LIGHTWEIGHT_UPDATE_PROPERTY,
            Some(if on { "켜짐" } else { "꺼짐" }.into()),
        );
    }

    let row_count = number_at(&row, 7).or_else(|| number_at(&parts, 1));
    let size_bytes = number_at(&row, 8).or_else(|| number_at(&parts, 2));
    Ok(TableDetail {
        name: display_name(&database, &table, &current),
        row_count_estimate: row_count,
        size_bytes,
        data_bytes: None,
        index_bytes: None,
        comment: (!comment.is_empty()).then_some(comment),
        columns,
        indexes,
        foreign_keys: Vec::new(),
        triggers: Vec::new(),
        ddl,
        schema: Some(database),
        properties,
    })
}

pub(crate) async fn objects(
    inner: &ClickHouseInner,
    include_system: bool,
) -> Result<DbObjects, EngineError> {
    let current = inner.database();
    let sql = format!(
        "SELECT database, name, engine FROM system.tables WHERE {} AND engine IN {NOT_TABLES} \
         ORDER BY name",
        databases_filter(&current, include_system)
    );
    let reply = inner.client.run(&sql, Request::read(&current)).await?;
    let mut objects = DbObjects::default();
    for row in &reply.rows {
        let name = display_name(&text_at(row, 0), &text_at(row, 1), &current);
        match text_at(row, 2).as_str() {
            "MaterializedView" => objects.materialized_views.push(name),
            "Dictionary" => objects.dictionaries.push(name),
            _ => objects.views.push(name),
        }
    }
    // SQL user-defined functions (CREATE FUNCTION … AS (x) -> …).
    if let Ok(reply) = inner
        .client
        .run(
            "SELECT name FROM system.functions WHERE origin = 'SQLUserDefined' ORDER BY name",
            Request::read(&current),
        )
        .await
    {
        objects.functions = reply.rows.iter().map(|row| text_at(row, 0)).collect();
    }
    Ok(objects)
}

pub(crate) async fn object_definition(
    inner: &ClickHouseInner,
    kind: &str,
    name: &str,
) -> Result<Option<ObjectDefinition>, EngineError> {
    let current = inner.database();
    let (database, object) = split_name(name, &current);
    let sql = match kind {
        "view" | "materialized_view" => {
            format!("SHOW CREATE TABLE {}", qualified(&database, &object))
        }
        "dictionary" => format!("SHOW CREATE DICTIONARY {}", qualified(&database, &object)),
        "function" => format!(
            "SELECT create_query FROM system.functions WHERE name = {}",
            string_literal(name)
        ),
        _ => return Ok(None),
    };
    let Some(ddl) = inner.client.scalar(&sql, Request::read(&current)).await? else {
        return Ok(None);
    };
    Ok(Some(ObjectDefinition {
        name: if kind == "function" {
            name.to_string()
        } else {
            object
        },
        kind: kind.to_string(),
        ddl: Some(ddl),
    }))
}

pub(crate) async fn server_info(inner: &ClickHouseInner) -> Result<ServerInfo, EngineError> {
    let current = inner.database();
    let sql = "SELECT uptime(), (SELECT sum(bytes_on_disk) FROM system.parts \
               WHERE active AND database = currentDatabase())";
    let reply = inner.client.run(sql, Request::read(&current)).await?;
    let row = reply.rows.into_iter().next().unwrap_or_default();
    let uptime = number_at(&row, 0).map(humanize_uptime_ko);
    let size_bytes = number_at(&row, 1);
    // This list's own query is the one session marked as current.
    let own = uuid::Uuid::new_v4().to_string();
    let mut request = Request::read(&current);
    request.query_id = Some(&own);
    let reply = inner
        .client
        .run(
            "SELECT query_id, user, current_database, if(is_cancelled, 'Cancelling', 'Running'), \
             query, toInt64(elapsed * 1000) FROM system.processes ORDER BY elapsed DESC",
            request,
        )
        .await?;
    let sessions = reply
        .rows
        .iter()
        .map(|row| {
            let id = text_at(row, 0);
            let optional = |index: usize| Some(text_at(row, index)).filter(|text| !text.is_empty());
            ServerSession {
                is_current: id == own,
                user: optional(1),
                database: optional(2),
                state: optional(3),
                query: optional(4),
                elapsed_ms: number_at(row, 5),
                id,
            }
        })
        .collect();
    Ok(ServerInfo {
        driver: "clickhouse".into(),
        version: Some(inner.version.clone()),
        database: Some(current),
        encoding: Some("UTF-8".into()),
        uptime,
        size_bytes,
        sessions: Some(sessions),
        can_kill: inner.capabilities.sessions.kill,
        topology: None,
        host: None,
    })
}

/// Stops the query `id` names (its query id), the page's own statement
/// too: on ClickHouse a session is a query, and stopping it is a cancel.
/// KILL QUERY answers a row per query it found; none means it was over.
pub(crate) async fn kill_session(inner: &ClickHouseInner, id: &str) -> Result<(), EngineError> {
    let id = id.trim();
    if id.is_empty() {
        return Err(EngineError::BadRequest(
            "세션 ID가 올바르지 않습니다".into(),
        ));
    }
    let current = inner.database();
    let sql = format!("KILL QUERY WHERE query_id = {} ASYNC", string_literal(id));
    let reply = inner.client.run(&sql, Request::read(&current)).await?;
    if reply.rows.is_empty() {
        return Err(EngineError::SessionNotFound);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enum_labels_in_order() {
        assert_eq!(
            enum_labels("Enum8('new' = 1, 'it\\'s' = 2, 'a, b' = 3)"),
            Some(vec![
                "new".to_string(),
                "it's".to_string(),
                "a, b".to_string()
            ])
        );
        assert_eq!(
            enum_labels("Nullable(Enum16('x' = 1))"),
            Some(vec!["x".to_string()])
        );
        assert_eq!(enum_labels("String"), None);
    }

    #[test]
    fn engine_clauses_split() {
        let full = "MergeTree PARTITION BY toYYYYMM(ordered_at) ORDER BY (customer_id, id) \
                    TTL ordered_at + toIntervalYear(10) SETTINGS index_granularity = 8192";
        assert_eq!(engine_head(full), "MergeTree");
        assert_eq!(
            engine_clause(full, " TTL ").as_deref(),
            Some("ordered_at + toIntervalYear(10)")
        );
        assert_eq!(
            engine_clause(full, " SETTINGS ").as_deref(),
            Some("index_granularity = 8192")
        );
        assert_eq!(
            engine_head("ReplacingMergeTree(version) ORDER BY id"),
            "ReplacingMergeTree(version)"
        );
        assert_eq!(engine_clause("Memory", " TTL "), None);
    }

    #[test]
    fn defaults_name_their_kind() {
        assert_eq!(default_text("", ""), None);
        assert_eq!(default_text("DEFAULT", "now()").as_deref(), Some("now()"));
        assert_eq!(
            default_text("MATERIALIZED", "a + 1").as_deref(),
            Some("MATERIALIZED a + 1")
        );
    }

    #[test]
    fn sizes_read_as_bytes() {
        assert_eq!(byte_size(512), "512 B");
        assert_eq!(byte_size(1536), "1.5 KiB");
    }
}
