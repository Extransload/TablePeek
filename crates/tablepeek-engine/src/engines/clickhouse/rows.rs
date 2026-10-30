//! The page's statements and its row edits. ClickHouse has no unique keys:
//! a row is found by the columns of its table's sorting key, and an edit
//! goes ahead only when exactly one row has the values the grid showed.
//! Cells change through ALTER TABLE … UPDATE, a mutation the request waits
//! for (mutations_sync = 2); rows go with a lightweight DELETE on servers
//! that have one (23.3+), else with ALTER TABLE … DELETE.

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::time::Instant;

use serde_json::Value;
use tablepeek_types::{EditTarget, InsertValue, PkValue, ValueExpr};

use crate::driver::{FileStream, NativeExport};
use crate::source_cache::{key_unchanged, KEY_CHANGED};
use crate::sql_log::{lexemes, Dialect, Lexeme};
use crate::sql_parse::parse_single_table;
use crate::{build_arrow, EngineError, QueryData};

use super::client::{text_of, Reply, Request, Scope};
use super::ClickHouseInner;

/// Mutations run to the end, on every replica, before the request returns.
const WAIT_FOR_MUTATION: &[(&str, &str)] = &[("mutations_sync", "2")];

/// A lightweight UPDATE, turned on for the statement (experimental in 25.7,
/// beta and on by default from 25.8).
const LIGHTWEIGHT_UPDATE: &[(&str, &str)] = &[("allow_experimental_lightweight_update", "1")];

/// A name in backquotes, its backquotes and backslashes escaped.
pub(crate) fn quote_ident(name: &str) -> String {
    format!("`{}`", name.replace('\\', "\\\\").replace('`', "\\`"))
}

/// Text as a string literal, its quotes and backslashes escaped.
pub(crate) fn string_literal(text: &str) -> String {
    format!("'{}'", text.replace('\\', "\\\\").replace('\'', "\\'"))
}

pub(crate) fn qualified(database: &str, table: &str) -> String {
    format!("{}.{}", quote_ident(database), quote_ident(table))
}

/// A table as the page names it ("orders", or "shop.orders" outside the
/// current database): its database and name.
pub(crate) fn split_name(name: &str, current: &str) -> (String, String) {
    match name.split_once('.') {
        Some((database, table)) if !database.is_empty() && !table.is_empty() => {
            (database.to_string(), table.to_string())
        }
        _ => (current.to_string(), name.to_string()),
    }
}

/// How the page names a table: bare in the current database, else qualified.
pub(crate) fn display_name(database: &str, table: &str, current: &str) -> String {
    if database == current {
        table.to_string()
    } else {
        format!("{database}.{table}")
    }
}

/// A type without the wrappers that don't change how its values read:
/// Nullable(…), LowCardinality(…).
pub(crate) fn base_type(declared: &str) -> &str {
    let mut text = declared.trim();
    loop {
        let inner = ["Nullable(", "LowCardinality("]
            .iter()
            .find_map(|prefix| text.strip_prefix(prefix))
            .and_then(|rest| rest.strip_suffix(')'));
        match inner {
            Some(inner) => text = inner.trim(),
            None => return text,
        }
    }
}

/// Integers up to 64 bits, which come quoted and go into the grid as
/// numbers where they fit.
fn is_integer(base: &str) -> bool {
    matches!(
        base,
        "Int8" | "Int16" | "Int32" | "Int64" | "UInt8" | "UInt16" | "UInt32" | "UInt64"
    )
}

pub(crate) async fn query(
    inner: &ClickHouseInner,
    sql: &str,
    max_rows: usize,
) -> Result<QueryData, EngineError> {
    let started = Instant::now();
    let _session = inner.session.lock().await;
    inner.sources.before_statement(sql, Dialect::ClickHouse);
    let query_id = uuid::Uuid::new_v4().to_string();
    *inner.running() = Some(query_id.clone());
    let request = Request {
        scope: Scope::Session,
        query_id: Some(&query_id),
        max_rows,
        timeout_secs: inner.timeout_secs.load(Ordering::SeqCst),
        settings: &[],
    };
    let result = inner.client.run(sql, request).await;
    *inner.running() = None;
    // USE moved the session to another database.
    if first_word(sql).as_deref() == Some("USE") {
        if let Ok(Some(database)) = inner
            .client
            .scalar("SELECT currentDatabase()", Request::session(1))
            .await
        {
            *inner
                .database
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner) = database;
        }
    }
    let reply = result?;
    drop(_session);
    let (source_table, pk) = detect_source(inner, sql, &reply.columns).await;
    let row_count = reply.rows.len();
    let column_kinds = reply
        .types
        .iter()
        .map(|declared| (base_type(declared) == "Bool").then_some("boolean"))
        .collect();
    let columns = reply.columns.clone();
    let rows_affected = columns
        .is_empty()
        .then_some(reply.written_rows.unwrap_or(0));
    let truncated = reply.truncated;
    let values = by_column(reply);
    let (schema, batches) = build_arrow(&columns, values, row_count)?;
    Ok(QueryData {
        kind: "clickhouse",
        columns,
        schema,
        batches,
        row_count,
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
        truncated,
        source_table,
        pk,
        column_kinds,
        rows_affected,
        next_page: None,
    })
}

/// The statement's first word, upper-cased, comments skipped.
fn first_word(sql: &str) -> Option<String> {
    lexemes(sql, Dialect::ClickHouse).find_map(|lexeme| match lexeme {
        Lexeme::Word(word) => Some(word.to_ascii_uppercase()),
        _ => None,
    })
}

/// The rows turned into one list per column; integers that came quoted (to
/// keep 64 bits exact) back to numbers where they fit the grid's.
fn by_column(reply: Reply) -> Vec<Vec<Value>> {
    let integer: Vec<bool> = (0..reply.columns.len())
        .map(|index| {
            reply
                .types
                .get(index)
                .is_some_and(|declared| is_integer(base_type(declared)))
        })
        .collect();
    let mut columns: Vec<Vec<Value>> =
        vec![Vec::with_capacity(reply.rows.len()); reply.columns.len()];
    for row in reply.rows {
        for (index, value) in row.into_iter().enumerate() {
            let Some(column) = columns.get_mut(index) else {
                break;
            };
            let value = match value {
                Value::String(text) if integer[index] => match text.parse::<i64>() {
                    Ok(number) => Value::from(number),
                    Err(_) => Value::String(text),
                },
                other => other,
            };
            column.push(value);
        }
    }
    columns
}

/// The virtual columns that tell one row from another where the sorting key
/// may not: the data part a row is in and its place in that part. They hold
/// until the part is merged or rewritten, so an edit by them also checks the
/// key and finds no row once the part has changed.
pub(crate) const ROW_IDENTITY: [&str; 2] = ["_part", "_part_offset"];

/// The table a single-table SELECT read, as the page names it, and the
/// columns its rows are found by: the sorting key, with `ROW_IDENTITY`
/// after it when the result holds those too (the data tab reads them).
async fn detect_source(
    inner: &ClickHouseInner,
    sql: &str,
    columns: &[String],
) -> (Option<String>, Option<Vec<String>>) {
    let Some((database, table)) = parse_single_table(sql) else {
        return (None, None);
    };
    let current = inner.database();
    let database = database.unwrap_or_else(|| current.clone());
    let cache_key = (database.clone(), table.clone());
    let key = match inner.sources.get(&cache_key) {
        Some(key) => key,
        None => match edit_key(inner, &database, &table).await {
            Ok(key) => {
                inner.sources.put(cache_key, key.clone());
                key
            }
            Err(_) => return (None, None),
        },
    };
    let shown = display_name(&database, &table, &current);
    let pk = key
        .filter(|key| key.iter().all(|column| columns.contains(column)))
        .map(|mut key| {
            if ROW_IDENTITY
                .iter()
                .all(|virtual_column| columns.iter().any(|column| column == virtual_column))
            {
                key.extend(ROW_IDENTITY.iter().map(|column| (*column).to_string()));
            }
            key
        });
    (Some(shown), pk)
}

/// The columns a table's rows are edited by: a MergeTree table's sorting
/// key, or a Distributed table's local table's (on this server); None for
/// a table that can't be edited by key.
pub(crate) async fn edit_key(
    inner: &ClickHouseInner,
    database: &str,
    table: &str,
) -> Result<Option<Vec<String>>, EngineError> {
    let Some(found) = table_key(inner, database, table).await? else {
        return Ok(None);
    };
    let found = match distributed_target(&found.engine_full, database) {
        Some((_, local_database, local_table)) if found.engine == "Distributed" => {
            match table_key(inner, &local_database, &local_table).await? {
                Some(local) => local,
                None => return Ok(None),
            }
        }
        _ => found,
    };
    Ok(found.editable().then_some(found.columns))
}

/// A table's engine, the columns its sorting key reads, and whether it
/// takes lightweight UPDATE (25.7+: both block columns turned on).
pub(crate) struct TableKey {
    pub engine: String,
    /// The engine with its arguments and clauses (a Distributed table's
    /// cluster and local table).
    pub engine_full: String,
    pub columns: Vec<String>,
    pub lightweight_update: bool,
}

impl TableKey {
    /// Rows can be found and changed by key: a MergeTree table with one.
    pub(crate) fn editable(&self) -> bool {
        self.engine.ends_with("MergeTree") && !self.columns.is_empty()
    }

    /// Its rows go to the other replicas by themselves (Keeper, or the
    /// cloud's shared storage).
    fn replicated(&self) -> bool {
        self.engine.starts_with("Replicated") || self.engine.starts_with("Shared")
    }
}

/// None when there is no such table.
pub(crate) async fn table_key(
    inner: &ClickHouseInner,
    database: &str,
    table: &str,
) -> Result<Option<TableKey>, EngineError> {
    let sql = format!(
        "SELECT engine, (SELECT groupArray(name) FROM (SELECT name FROM system.columns \
         WHERE database = {db} AND table = {name} AND is_in_sorting_key ORDER BY position)), \
         match(create_table_query, 'enable_block_number_column = (1|true)') \
         AND match(create_table_query, 'enable_block_offset_column = (1|true)'), engine_full \
         FROM system.tables WHERE database = {db} AND name = {name}",
        db = string_literal(database),
        name = string_literal(table),
    );
    let reply = inner.client.run(&sql, Request::read(database)).await?;
    let Some(row) = reply.rows.into_iter().next() else {
        return Ok(None);
    };
    let engine = row.first().and_then(text_of).unwrap_or_default();
    let columns = match row.get(1) {
        Some(Value::Array(names)) => names.iter().filter_map(text_of).collect(),
        _ => Vec::new(),
    };
    let lightweight_update = matches!(row.get(2), Some(Value::Number(n)) if n.as_u64() == Some(1))
        || matches!(row.get(2), Some(Value::Bool(true)));
    let engine_full = row.get(3).and_then(text_of).unwrap_or_default();
    Ok(Some(TableKey {
        engine,
        engine_full,
        columns,
        lightweight_update,
    }))
}

/// The cluster, database and table a Distributed table reads, from its
/// engine_full: `Distributed('c', 'db', 'local'[, sharding_key[, policy]])`.
/// An empty database (or currentDatabase()) is the Distributed table's own.
pub(crate) fn distributed_target(
    engine_full: &str,
    own_database: &str,
) -> Option<(String, String, String)> {
    let body = engine_full.trim().strip_prefix("Distributed(")?;
    let mut args: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut depth = 0usize;
    let mut quote: Option<char> = None;
    let mut chars = body.chars();
    while let Some(ch) = chars.next() {
        if let Some(open) = quote {
            current.push(ch);
            if ch == '\\' {
                current.extend(chars.next());
            } else if ch == open {
                quote = None;
            }
            continue;
        }
        match ch {
            '\'' | '`' | '"' => {
                quote = Some(ch);
                current.push(ch);
            }
            '(' => {
                depth += 1;
                current.push(ch);
            }
            ')' if depth == 0 => {
                args.push(std::mem::take(&mut current));
                break;
            }
            ')' => {
                depth -= 1;
                current.push(ch);
            }
            ',' if depth == 0 => args.push(std::mem::take(&mut current)),
            _ => current.push(ch),
        }
    }
    let unquote = |arg: &str| -> String {
        let arg = arg.trim();
        let mut chars = arg.chars();
        match chars.next() {
            Some(open @ ('\'' | '`' | '"')) if arg.len() >= 2 && arg.ends_with(open) => {
                let inner = &arg[1..arg.len() - 1];
                let mut text = String::with_capacity(inner.len());
                let mut chars = inner.chars();
                while let Some(ch) = chars.next() {
                    if ch == '\\' {
                        text.extend(chars.next());
                    } else {
                        text.push(ch);
                    }
                }
                text
            }
            _ => arg.to_string(),
        }
    };
    let cluster = unquote(args.first()?);
    let database = unquote(args.get(1)?);
    let table = unquote(args.get(2)?);
    if cluster.is_empty() || table.is_empty() {
        return None;
    }
    let database = if database.is_empty() || database.eq_ignore_ascii_case("currentDatabase()") {
        own_database.to_string()
    } else {
        database
    };
    Some((cluster, database, table))
}

/// Where a row edit goes: the table that holds the rows (a Distributed
/// table's local one), its key, and the cluster whose every server runs the
/// change; None runs it on the connected server alone.
struct Placement {
    database: String,
    table: String,
    key: TableKey,
    cluster: Option<String>,
    /// A Distributed table the grid read the rows through.
    distributed: Option<(String, String)>,
}

impl Placement {
    /// The table as the change names it, ON CLUSTER included.
    fn target(&self) -> String {
        match &self.cluster {
            Some(cluster) => format!(
                "{} ON CLUSTER {}",
                qualified(&self.database, &self.table),
                quote_ident(cluster)
            ),
            None => qualified(&self.database, &self.table),
        }
    }
}

/// The table the page's edit names, followed to where its rows live: a
/// Distributed table's edits go to its local table on every server of its
/// cluster; a table that isn't replicated but sits on several servers of
/// the connection's cluster (made ON CLUSTER) is changed on each of them;
/// anything else on the connected server, where a replicated table hands
/// the change on by itself.
async fn placement(
    inner: &ClickHouseInner,
    database: &str,
    table: &str,
) -> Result<Placement, EngineError> {
    let Some(key) = table_key(inner, database, table).await? else {
        return Err(EngineError::TableNotFound);
    };
    if key.engine == "Distributed" {
        let Some((cluster, local_database, local_table)) =
            distributed_target(&key.engine_full, database)
        else {
            return Err(EngineError::NotEditable(format!(
                "Distributed 테이블이 읽는 테이블을 알 수 없습니다: {}",
                key.engine_full
            )));
        };
        let Some(local) = table_key(inner, &local_database, &local_table).await? else {
            return Err(EngineError::NotEditable(format!(
                "Distributed 테이블이 읽는 {local_database}.{local_table}이(가) 이 서버에 없어 행을 고칠 수 없습니다"
            )));
        };
        return Ok(Placement {
            database: local_database,
            table: local_table,
            key: local,
            cluster: Some(cluster),
            distributed: Some((database.to_string(), table.to_string())),
        });
    }
    let mut cluster = None;
    if let Some(name) = inner.cluster.as_deref() {
        if key.editable() && !key.replicated() {
            // The same table on other servers of the cluster: made there
            // ON CLUSTER, each server holding rows of its own.
            let sql = format!(
                "SELECT count() FROM clusterAllReplicas({}, system.tables) \
                 WHERE database = {} AND name = {}",
                string_literal(name),
                string_literal(database),
                string_literal(table)
            );
            let servers: u64 = inner
                .client
                .scalar(&sql, Request::read(database))
                .await?
                .and_then(|text| text.parse().ok())
                .unwrap_or(0);
            if servers > 1 {
                cluster = Some(name.to_string());
            }
        }
    }
    Ok(Placement {
        database: database.to_string(),
        table: table.to_string(),
        key,
        cluster,
        distributed: None,
    })
}

/// A column's type and how its default is written (DEFAULT, MATERIALIZED, …).
struct ColumnInfo {
    declared: String,
    default_kind: String,
    default_expression: String,
}

async fn column_infos(
    inner: &ClickHouseInner,
    database: &str,
    table: &str,
) -> Result<HashMap<String, ColumnInfo>, EngineError> {
    let sql = format!(
        "SELECT name, type, default_kind, default_expression FROM system.columns \
         WHERE database = {} AND table = {}",
        string_literal(database),
        string_literal(table)
    );
    let reply = inner.client.run(&sql, Request::read(database)).await?;
    let mut infos: HashMap<String, ColumnInfo> = reply
        .rows
        .into_iter()
        .map(|row| {
            let text = |index: usize| row.get(index).and_then(text_of).unwrap_or_default();
            (
                text(0),
                ColumnInfo {
                    declared: text(1),
                    default_kind: text(2),
                    default_expression: text(3),
                },
            )
        })
        .collect();
    // The virtual columns a row is also found by.
    for (name, declared) in ROW_IDENTITY.iter().zip(["String", "UInt64"]) {
        infos.insert(
            (*name).to_string(),
            ColumnInfo {
                declared: declared.into(),
                default_kind: String::new(),
                default_expression: String::new(),
            },
        );
    }
    Ok(infos)
}

fn declared_type<'a>(
    columns: &'a HashMap<String, ColumnInfo>,
    name: &str,
) -> Result<&'a ColumnInfo, EngineError> {
    columns
        .get(name)
        .ok_or_else(|| EngineError::NotEditable(format!("컬럼을 찾을 수 없습니다: {name}")))
}

/// A value the grid sent as text, as an expression of the column's type:
/// arrays, maps and tuples (shown as JSON) written as ClickHouse literals,
/// anything else read from its text by CAST.
pub(crate) fn value_sql(text: &str, declared: &str) -> String {
    let base = base_type(declared);
    let nested = ["Array(", "Map(", "Tuple("]
        .iter()
        .any(|prefix| base.starts_with(prefix));
    if nested {
        if let Ok(json) = serde_json::from_str::<Value>(text) {
            if json.is_array() || json.is_object() {
                let tuple = base.starts_with("Tuple(");
                return format!("CAST({} AS {declared})", json_literal(&json, tuple));
            }
        }
    }
    format!("CAST({} AS {declared})", string_literal(text))
}

/// JSON as a ClickHouse literal: arrays as [ … ], objects as map(…) (or as
/// a tuple's elements in order, for `tuple`).
fn json_literal(value: &Value, tuple: bool) -> String {
    match value {
        Value::Null => "NULL".into(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number.to_string(),
        Value::String(text) => string_literal(text),
        Value::Array(items) => {
            let items: Vec<String> = items.iter().map(|item| json_literal(item, false)).collect();
            if tuple {
                format!("tuple({})", items.join(", "))
            } else {
                format!("[{}]", items.join(", "))
            }
        }
        Value::Object(fields) => {
            if tuple {
                let items: Vec<String> = fields
                    .values()
                    .map(|item| json_literal(item, false))
                    .collect();
                format!("tuple({})", items.join(", "))
            } else {
                let items: Vec<String> = fields
                    .iter()
                    .map(|(key, item)| {
                        format!("{}, {}", string_literal(key), json_literal(item, false))
                    })
                    .collect();
                format!("map({})", items.join(", "))
            }
        }
    }
}

/// What a column becomes for one of Set Value's expressions.
fn expr_sql(expr: ValueExpr, column: &ColumnInfo) -> String {
    match expr {
        ValueExpr::Now => format!("CAST(now64(6) AS {})", column.declared),
        ValueExpr::Default
            if column.default_kind == "DEFAULT" && !column.default_expression.is_empty() =>
        {
            format!("CAST({} AS {})", column.default_expression, column.declared)
        }
        ValueExpr::Default => format!(
            "defaultValueOfTypeName({})",
            string_literal(&column.declared)
        ),
    }
}

/// `col = value` (or isNull) for each key column, joined by AND.
fn key_condition(
    pk: &[PkValue],
    columns: &HashMap<String, ColumnInfo>,
) -> Result<String, EngineError> {
    let mut terms = Vec::with_capacity(pk.len());
    for part in pk {
        let info = declared_type(columns, &part.column)?;
        let name = quote_ident(&part.column);
        let term = match &part.value {
            Value::Null => format!("isNull({name})"),
            Value::String(text) => format!("{name} = {}", value_sql(text, &info.declared)),
            other => format!("{name} = {}", value_sql(&other.to_string(), &info.declared)),
        };
        terms.push(term);
    }
    Ok(terms.join(" AND "))
}

/// Whether a column's value as the grid shows it can find the row again:
/// not aggregate states or the JSON kinds (no equality), not the geo shapes
/// or a tuple inside an array or map (their JSON doesn't CAST back).
fn comparable(declared: &str) -> bool {
    const UNMATCHED: [&str; 13] = [
        "AggregateFunction(",
        "JSON",
        "Object(",
        "Dynamic",
        "Variant(",
        "Nothing",
        "Point",
        "Ring",
        "Polygon",
        "MultiPolygon",
        "LineString",
        "MultiLineString",
        "Interval",
    ];
    let base = base_type(declared);
    !UNMATCHED.iter().any(|prefix| base.starts_with(prefix))
        && !base.get(1..).is_some_and(|rest| rest.contains("Tuple("))
}

/// `col = value` (or isNull) for every column of the row as the grid last
/// knew it, but the key's (the key condition has them) and those that
/// can't be matched; None when none is left.
fn seen_condition(
    seen: &[PkValue],
    key: &[String],
    columns: &HashMap<String, ColumnInfo>,
) -> Result<Option<String>, EngineError> {
    let usable: Vec<PkValue> = seen
        .iter()
        .filter(|part| {
            !ROW_IDENTITY.contains(&part.column.as_str())
                && !key.contains(&part.column)
                && columns
                    .get(&part.column)
                    .is_some_and(|info| comparable(&info.declared))
        })
        .cloned()
        .collect();
    if usable.is_empty() {
        return Ok(None);
    }
    key_condition(&usable, columns).map(Some)
}

/// How many rows of `from` (a table, or a table function) `condition` finds.
async fn count_where(
    inner: &ClickHouseInner,
    database: &str,
    from: &str,
    condition: &str,
) -> Result<u64, EngineError> {
    let sql = format!("SELECT count() FROM {from} WHERE {condition}");
    Ok(inner
        .client
        .scalar(&sql, Request::read(database))
        .await?
        .and_then(|text| text.parse().ok())
        .unwrap_or(0))
}

const MANY_BY_KEY: &str = "정렬 키 값이 같은 행이 여럿 있어 이 행만 고칠 수 없습니다. 데이터 탭에서 고치거나 SELECT에 _part, _part_offset을 더하세요";
const SAME_ROWS: &str = "정렬 키와 모든 컬럼 값이 같은 행이 여럿 있어 어느 행인지 알 수 없습니다. 새로 고친 뒤(데이터 탭, 또는 SELECT에 _part, _part_offset을 더해) 다시 하세요";
const SAME_ON_CLUSTER: &str =
    "클러스터에 이 행과 정렬 키·값이 모두 같은 행이 여럿 있어 이 행만 고칠 수 없습니다";

/// The data part a row was read from, also under a later mutation of it. A
/// mutation (an edit, a lightweight delete) renames the part it rewrites,
/// `partition_min_max_level` getting a mutation number after it, but keeps
/// its rows in place, so the offset still finds the row; a merge makes a new
/// part, and the row is no longer found by it. Before lightweight deletes
/// (23.3) a delete drops rows from the part, so only the name read counts.
pub(super) fn part_condition(name: &str, rows_stay: bool) -> String {
    let pieces: Vec<&str> = name.split('_').collect();
    let base = match pieces.len() {
        4 => name.to_string(),
        5 => pieces[..4].join("_"),
        _ => String::new(),
    };
    if !rows_stay || base.is_empty() {
        return format!("_part = {}", string_literal(name));
    }
    format!(
        "(_part = {} OR startsWith(_part, {}))",
        string_literal(&base),
        string_literal(&format!("{base}_"))
    )
}

/// The table's key checked against the one the grid keyed its rows on, and
/// the rows the grid's values match counted: an edit goes ahead for exactly
/// one. Rows sharing a key are told apart by `ROW_IDENTITY` when the grid
/// read it; a row that identity no longer finds (a merge made a new part)
/// or a key several rows share is found again by the key and every value
/// in `seen`. On a cluster (`Placement::cluster`) parts are each server's
/// own, so the row is found by its key and values alone, and no server may
/// hold two such rows (a Distributed table's shards together, one).
/// Answers the condition, or how many rows matched when none is used.
async fn find_row(
    inner: &ClickHouseInner,
    place: &Placement,
    pk: &[PkValue],
    seen: &[PkValue],
    columns: &HashMap<String, ColumnInfo>,
) -> Result<Result<String, u64>, EngineError> {
    if pk.is_empty() {
        return Err(EngineError::NotEditable(
            "정렬 키가 없어 행을 찾을 수 없습니다".into(),
        ));
    }
    if !place.key.editable() {
        return Err(EngineError::NotEditable(
            "정렬 키가 있는 MergeTree 계열 테이블만 키로 행을 고칠 수 있습니다".into(),
        ));
    }
    let key_parts: Vec<PkValue> = pk
        .iter()
        .filter(|part| !ROW_IDENTITY.contains(&part.column.as_str()))
        .cloned()
        .collect();
    if !key_unchanged(&place.key.columns, &key_parts, false) {
        inner.sources.clear();
        return Err(EngineError::NotEditable(KEY_CHANGED.into()));
    }
    let key = key_condition(&key_parts, columns)?;
    let by_values = seen_condition(seen, &place.key.columns, columns)?
        .map(|values| format!("{key} AND {values}"));
    let database = place.database.as_str();

    if let Some(cluster) = &place.cluster {
        let condition = by_values.unwrap_or(key);
        if let Some((shown_database, shown_table)) = &place.distributed {
            // One replica of each shard: the row is on one shard only.
            let from = qualified(shown_database, shown_table);
            match count_where(inner, database, &from, &condition).await? {
                0 => return Ok(Err(0)),
                1 => {}
                _ => return Err(EngineError::NotEditable(SAME_ON_CLUSTER.into())),
            }
        }
        // Every server's own copy: none holds two rows the change would hit.
        let sql = format!(
            "SELECT max(n), sum(n) FROM (SELECT hostName() AS host, count() AS n \
             FROM clusterAllReplicas({}, {}, {}) WHERE {condition} GROUP BY host)",
            string_literal(cluster),
            string_literal(&place.database),
            string_literal(&place.table)
        );
        let reply = inner.client.run(&sql, Request::read(database)).await?;
        let row = reply.rows.into_iter().next().unwrap_or_default();
        let number = |index: usize| -> u64 {
            row.get(index)
                .and_then(text_of)
                .and_then(|text| text.parse().ok())
                .unwrap_or(0)
        };
        if number(0) > 1 {
            return Err(EngineError::NotEditable(SAME_ON_CLUSTER.into()));
        }
        if number(1) == 0 {
            return Ok(Err(0));
        }
        return Ok(Ok(condition));
    }

    let from = qualified(&place.database, &place.table);
    let part = pk.iter().find(|part| part.column == ROW_IDENTITY[0]);
    let offset: Vec<PkValue> = pk
        .iter()
        .filter(|part| part.column == ROW_IDENTITY[1])
        .cloned()
        .collect();
    let first = match part {
        Some(part) => {
            let mut condition = format!(
                "{key} AND {}",
                part_condition(
                    part.value.as_str().unwrap_or_default(),
                    inner.lightweight_delete()
                )
            );
            if !offset.is_empty() {
                condition = format!("{condition} AND {}", key_condition(&offset, columns)?);
            }
            condition
        }
        None => key.clone(),
    };
    let matched = count_where(inner, database, &from, &first).await?;
    if matched == 1 {
        return Ok(Ok(first));
    }
    // Nothing found by the part the row was read from (a merge moved it),
    // or several rows share the key: the row's values tell which.
    let Some(by_values) = by_values else {
        return if matched == 0 {
            Ok(Err(0))
        } else {
            Err(EngineError::NotEditable(MANY_BY_KEY.into()))
        };
    };
    if matched == 0 && part.is_none() {
        return Ok(Err(0));
    }
    match count_where(inner, database, &from, &by_values).await? {
        0 => Ok(Err(0)),
        1 => Ok(Ok(by_values)),
        _ => Err(EngineError::NotEditable(SAME_ROWS.into())),
    }
}

pub(crate) async fn edit(
    inner: &ClickHouseInner,
    target: &EditTarget,
    seen: &[PkValue],
) -> Result<u64, EngineError> {
    let (database, table) = split_name(&target.table, &inner.database());
    let place = placement(inner, &database, &table).await?;
    let columns = column_infos(inner, &place.database, &place.table).await?;
    let info = declared_type(&columns, &target.column)?;
    let value = match (target.expr, &target.value) {
        (Some(expr), _) => expr_sql(expr, info),
        (None, None) => "NULL".into(),
        (None, Some(text)) => value_sql(text, &info.declared),
    };
    let condition = match find_row(inner, &place, &target.pk, seen, &columns).await? {
        Ok(condition) => condition,
        Err(matched) => return Ok(matched),
    };
    let target_table = place.target();
    let column = quote_ident(&target.column);
    // A lightweight UPDATE (25.7+) patches the row in place where the table
    // keeps block numbers and offsets; anything else rewrites its parts.
    let (sql, settings) = if inner.lightweight_update() && place.key.lightweight_update {
        (
            format!("UPDATE {target_table} SET {column} = {value} WHERE {condition}"),
            LIGHTWEIGHT_UPDATE,
        )
    } else {
        (
            format!("ALTER TABLE {target_table} UPDATE {column} = {value} WHERE {condition}"),
            WAIT_FOR_MUTATION,
        )
    };
    let mut request = Request::read(&place.database);
    request.settings = settings;
    inner.client.execute(&sql, request).await?;
    Ok(1)
}

pub(crate) async fn insert_row(
    inner: &ClickHouseInner,
    table: &str,
    values: &[InsertValue],
) -> Result<u64, EngineError> {
    let (database, table) = split_name(table, &inner.database());
    let target = qualified(&database, &table);
    let sql = if values
        .iter()
        .all(|value| ROW_IDENTITY.contains(&value.column.as_str()))
    {
        // Every column at its default: an empty JSON row says just that.
        format!("INSERT INTO {target} FORMAT JSONEachRow {{}}")
    } else {
        let columns = column_infos(inner, &database, &table).await?;
        let mut names = Vec::with_capacity(values.len());
        let mut exprs = Vec::with_capacity(values.len());
        for value in values {
            // A copied row's part and place are the database's to give.
            if ROW_IDENTITY.contains(&value.column.as_str()) {
                continue;
            }
            let info = declared_type(&columns, &value.column)?;
            names.push(quote_ident(&value.column));
            exprs.push(match (value.expr, &value.value) {
                (Some(expr), _) => expr_sql(expr, info),
                (None, None) => "NULL".into(),
                (None, Some(text)) => value_sql(text, &info.declared),
            });
        }
        format!(
            "INSERT INTO {target} ({}) VALUES ({})",
            names.join(", "),
            exprs.join(", ")
        )
    };
    let reply = inner.client.run(&sql, Request::read(&database)).await?;
    Ok(reply.written_rows.unwrap_or(1))
}

pub(crate) async fn delete_row(
    inner: &ClickHouseInner,
    table: &str,
    pk: &[PkValue],
    seen: &[PkValue],
) -> Result<u64, EngineError> {
    let (database, table) = split_name(table, &inner.database());
    let place = placement(inner, &database, &table).await?;
    let columns = column_infos(inner, &place.database, &place.table).await?;
    let condition = match find_row(inner, &place, pk, seen, &columns).await? {
        Ok(condition) => condition,
        Err(matched) => return Ok(matched),
    };
    let target = place.target();
    // Lightweight deletes are MergeTree's; the rest takes a mutation.
    let sql = if inner.lightweight_delete() && place.key.engine.ends_with("MergeTree") {
        format!("DELETE FROM {target} WHERE {condition}")
    } else {
        format!("ALTER TABLE {target} DELETE WHERE {condition}")
    };
    let mut request = Request::read(&place.database);
    request.settings = WAIT_FOR_MUTATION;
    inner.client.execute(&sql, request).await?;
    Ok(1)
}

/// The read `sql` written by the server as CSV (CSVWithNames with a header)
/// or as a JSON array of objects (JSONEachRow), streamed as it comes.
pub(crate) async fn export_native(
    inner: &ClickHouseInner,
    sql: &str,
    export: &NativeExport,
) -> Result<FileStream, EngineError> {
    let body = sql.trim().trim_end_matches(';').trim_end();
    if !crate::is_read_only(body) {
        return Err(EngineError::BadRequest(
            "내보내기는 읽기 문장 하나만 받습니다".into(),
        ));
    }
    let delimiter = export.delimiter.to_string();
    let (format, mut settings): (&str, Vec<(&str, &str)>) = match export.format.as_str() {
        "csv" => (
            if export.header { "CSVWithNames" } else { "CSV" },
            vec![
                ("format_csv_delimiter", delimiter.as_str()),
                (
                    "output_format_csv_crlf_end_of_line",
                    if export.crlf { "1" } else { "0" },
                ),
                (
                    "format_csv_null_representation",
                    if export.null_word { "NULL" } else { "" },
                ),
            ],
        ),
        "json" => (
            "JSONEachRow",
            vec![("output_format_json_array_of_rows", "1")],
        ),
        other => {
            return Err(EngineError::BadRequest(format!(
                "ClickHouse가 직접 쓸 수 없는 형식입니다: {other}"
            )))
        }
    };
    // A tuple is one field under its one header, not a field per element
    // (the setting is 24.3's; older servers write them apart).
    if export.format == "csv" && inner.release >= (24, 3) {
        settings.push((
            "output_format_csv_serialize_tuple_into_separate_columns",
            "0",
        ));
    }
    let database = inner.database();
    let statement = if export.format == "csv" && export.nested_json {
        format!(
            "{}\nFORMAT {format}",
            nested_as_json(inner, &database, body).await?
        )
    } else {
        format!("{body}\nFORMAT {format}")
    };
    let request = Request {
        scope: Scope::Database(&database),
        query_id: None,
        max_rows: usize::MAX,
        timeout_secs: inner.timeout_secs.load(Ordering::SeqCst),
        settings: &settings,
    };
    inner.client.stream(&statement, request).await
}

/// `body` with its arrays, maps and tuples turned into JSON text as the
/// grid shows them (toJSONString, under the same output settings), the
/// other columns as they are; `body` itself when it has none.
async fn nested_as_json(
    inner: &ClickHouseInner,
    database: &str,
    body: &str,
) -> Result<String, EngineError> {
    let reply = inner
        .client
        .run(&format!("DESCRIBE TABLE ({body})"), Request::read(database))
        .await?;
    let nested: Vec<String> = reply
        .rows
        .iter()
        .filter_map(|row| {
            let name = row.first().and_then(text_of)?;
            let declared = row.get(1).and_then(text_of)?;
            let base = base_type(&declared);
            ["Array(", "Map(", "Tuple(", "Nested("]
                .iter()
                .any(|prefix| base.starts_with(prefix))
                .then(|| format!("toJSONString({0}) AS {0}", quote_ident(&name)))
        })
        .collect();
    if nested.is_empty() {
        return Ok(body.to_string());
    }
    Ok(format!(
        "SELECT * REPLACE ({}) FROM ({body})",
        nested.join(", ")
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting_escapes_backslashes_and_quotes() {
        assert_eq!(quote_ident("Edge `Cases`"), "`Edge \\`Cases\\``");
        assert_eq!(string_literal("it's C:\\"), "'it\\'s C:\\\\'");
    }

    #[test]
    fn base_types_lose_their_wrappers() {
        assert_eq!(base_type("LowCardinality(Nullable(String))"), "String");
        assert_eq!(base_type("Nullable(UInt64)"), "UInt64");
        assert_eq!(
            base_type("Array(Nullable(String))"),
            "Array(Nullable(String))"
        );
    }

    #[test]
    fn values_follow_the_column_type() {
        assert_eq!(value_sql("5", "UInt32"), "CAST('5' AS UInt32)");
        assert_eq!(
            value_sql("[\"a\",\"b's\"]", "Array(String)"),
            "CAST(['a', 'b\\'s'] AS Array(String))"
        );
        assert_eq!(
            value_sql("{\"k\":\"v\"}", "Map(String, String)"),
            "CAST(map('k', 'v') AS Map(String, String))"
        );
        assert_eq!(
            value_sql("{\"a\":1,\"b\":\"x\"}", "Tuple(a UInt8, b String)"),
            "CAST(tuple(1, 'x') AS Tuple(a UInt8, b String))"
        );
        // Not JSON: read as the type's own text.
        assert_eq!(
            value_sql("['a']", "Array(String)"),
            "CAST('[\\'a\\']' AS Array(String))"
        );
    }

    #[test]
    fn names_split_on_the_first_dot() {
        assert_eq!(
            split_name("shop.orders", "default"),
            ("shop".into(), "orders".into())
        );
        assert_eq!(
            split_name("orders", "shop"),
            ("shop".into(), "orders".into())
        );
        assert_eq!(display_name("shop", "orders", "shop"), "orders");
        assert_eq!(display_name("system", "tables", "shop"), "system.tables");
    }

    #[test]
    fn distributed_tables_name_their_local_table() {
        assert_eq!(
            distributed_target(
                "Distributed('tp_cluster', 'shop', 'orders_local', rand())",
                "x"
            ),
            Some(("tp_cluster".into(), "shop".into(), "orders_local".into()))
        );
        assert_eq!(
            distributed_target(
                "Distributed(tp_cluster, currentDatabase(), `it\\`s`)",
                "own"
            ),
            Some(("tp_cluster".into(), "own".into(), "it`s".into()))
        );
        assert_eq!(
            distributed_target(
                "Distributed('c', '', 't', cityHash64(a, b), 'policy')",
                "own"
            ),
            Some(("c".into(), "own".into(), "t".into()))
        );
        assert_eq!(distributed_target("MergeTree ORDER BY id", "own"), None);
        assert_eq!(distributed_target("Distributed('c')", "own"), None);
    }

    #[test]
    fn rows_are_matched_by_comparable_columns() {
        assert!(comparable("String"));
        assert!(comparable("Nullable(Float64)"));
        assert!(comparable("Array(String)"));
        assert!(comparable("Tuple(a UInt32, b Array(String))"));
        assert!(comparable("Map(String, UInt64)"));
        assert!(!comparable("AggregateFunction(uniq, UInt64)"));
        assert!(!comparable("JSON"));
        assert!(!comparable("Array(Tuple(UInt8, String))"));
        assert!(!comparable("Point"));
    }
}
