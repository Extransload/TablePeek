//! What the sidebar, the structure view and the server panel read from
//! Oracle's data dictionary (the ALL_* views, so every account sees what it
//! may use; the V$ and DBA_* views only where the account has the rights,
//! leaving that part empty otherwise).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};

use tablepeek_types::{
    ColumnSchema, DbObjects, EngineMeta, ForeignKeyInfo, IndexInfo, IndexPart, ObjectDefinition,
    Relation, ServerInfo, ServerSession, TableDetail, TableProperty, TableSchema, TriggerInfo,
};

use super::query::display_name;
use super::session::{clob, int, ora_err, text, Ctx, OracleInner};
use crate::sql_parse::trim_ident;
use crate::{humanize_uptime_ko, EngineError};

/// A name in double quotes, quotes inside doubled.
pub(super) fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// Text as a SQL literal.
fn literal(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// OWNER.NAME as the sidebar names it (bare in the session's schema): the
/// owner and the name.
pub(super) fn split_name(schema: &str, display: &str) -> (String, String) {
    match display.split_once('.') {
        Some((owner, name)) => (trim_ident(owner), trim_ident(name)),
        None => (schema.to_string(), trim_ident(display)),
    }
}

/// The owners whose objects are listed: the session's schema and every
/// account Oracle didn't make, or all of them with the system ones.
fn owner_filter(column: &str, schema: &str, include_system: bool) -> String {
    if include_system {
        "1 = 1".into()
    } else {
        format!(
            "({column} = {} OR {column} IN (SELECT username FROM all_users WHERE oracle_maintained = 'N'))",
            literal(schema)
        )
    }
}

/// The tables listed: not nested, overflow, secondary or dropped ones, and
/// not the container tables materialized views keep their rows in.
fn tables_sql(schema: &str, include_system: bool) -> String {
    format!(
        "SELECT t.owner, t.table_name FROM all_tables t \
         WHERE {} AND t.nested = 'NO' AND t.secondary = 'N' AND t.dropped = 'NO' \
           AND (t.iot_type IS NULL OR t.iot_type = 'IOT') AND t.table_name NOT LIKE 'BIN$%' \
           AND NOT EXISTS (SELECT 1 FROM all_mviews m \
                           WHERE m.owner = t.owner AND m.container_name = t.table_name)",
        owner_filter("t.owner", schema, include_system)
    )
}

fn order_by_schema(schema: &str, owner: &str, rest: &str) -> String {
    format!(
        "ORDER BY CASE WHEN {owner} = {} THEN 0 ELSE 1 END, {owner}, {rest}",
        literal(schema)
    )
}

pub(super) async fn meta(
    inner: &OracleInner,
    include_system: bool,
) -> Result<EngineMeta, EngineError> {
    // A reload picks up schema changes made elsewhere: so do the sources.
    inner.sources.clear();
    let schema = inner.schema();
    let tables = inner
        .run(move |ctx| {
            let sql = format!(
                "{} {}",
                tables_sql(&schema, include_system),
                order_by_schema(&schema, "t.owner", "t.table_name")
            );
            let rows = ctx.rows_with(&sql, &[])?;
            Ok(rows
                .iter()
                .map(|row| {
                    display_name(
                        &schema,
                        &text(row, 0).unwrap_or_default(),
                        &text(row, 1).unwrap_or_default(),
                    )
                })
                .collect::<Vec<_>>())
        })
        .await?;
    Ok(EngineMeta {
        kind: "oracle".into(),
        path: Some(inner.label.clone()),
        demo: false,
        tables,
        capabilities: None,
    })
}

/// A column's type as CREATE TABLE writes it.
fn decl_type(row: &oracledb::Row, at: usize) -> String {
    let data_type = text(row, at).unwrap_or_default();
    let data_length = int(row, at + 1);
    let char_length = int(row, at + 2);
    let char_used = text(row, at + 3);
    let precision = int(row, at + 4);
    let scale = int(row, at + 5);
    match data_type.as_str() {
        "VARCHAR2" | "CHAR" => match (char_used.as_deref(), char_length, data_length) {
            (Some("C"), Some(length), _) => format!("{data_type}({length} CHAR)"),
            (_, _, Some(length)) => format!("{data_type}({length})"),
            _ => data_type,
        },
        "NVARCHAR2" | "NCHAR" => match char_length {
            Some(length) => format!("{data_type}({length})"),
            None => data_type,
        },
        "RAW" => match data_length {
            Some(length) => format!("RAW({length})"),
            None => data_type,
        },
        "NUMBER" => match (precision, scale) {
            (None, Some(0)) => "INTEGER".into(),
            (Some(precision), Some(0) | None) => format!("NUMBER({precision})"),
            (Some(precision), Some(scale)) => format!("NUMBER({precision},{scale})"),
            _ => data_type,
        },
        "FLOAT" => match precision {
            Some(precision) if precision != 126 => format!("FLOAT({precision})"),
            _ => data_type,
        },
        _ => data_type,
    }
}

/// Columns with the type, nullability, default and key flag, from
/// COLUMNS_SELECT's row shape.
const COLUMNS_SELECT: &str = "SELECT c.owner, c.table_name, c.column_name, c.data_type, \
     c.data_length, c.char_length, c.char_used, c.data_precision, c.data_scale, c.nullable, \
     c.identity_column, \
     CASE WHEN EXISTS (SELECT 1 FROM all_constraints k JOIN all_cons_columns kc \
                         ON kc.owner = k.owner AND kc.constraint_name = k.constraint_name \
                       WHERE k.constraint_type = 'P' AND k.owner = c.owner \
                         AND k.table_name = c.table_name AND kc.column_name = c.column_name) \
          THEN 1 ELSE 0 END, \
     c.data_default \
     FROM all_tab_columns c";

fn column_of(row: &mut oracledb::Row) -> ColumnSchema {
    let identity = text(row, 10).as_deref() == Some("YES");
    // An identity column's default is its sequence, which no CREATE TABLE
    // can name; DBMS_METADATA's DDL says GENERATED … AS IDENTITY instead.
    let default = (!identity)
        .then(|| clob(row, 12))
        .flatten()
        .map(|default| default.trim().to_string())
        .filter(|default| !default.is_empty() && !default.eq_ignore_ascii_case("NULL"));
    ColumnSchema {
        name: text(row, 2).unwrap_or_default(),
        decl_type: Some(decl_type(row, 3)),
        not_null: text(row, 9).as_deref() == Some("N"),
        pk: int(row, 11) == Some(1),
        default,
        enum_values: None,
    }
}

pub(super) async fn schema(
    inner: &OracleInner,
    include_system: bool,
) -> Result<Vec<TableSchema>, EngineError> {
    inner.sources.clear();
    let schema = inner.schema();
    inner
        .run(move |ctx| {
            let sql = format!(
                "{COLUMNS_SELECT} JOIN ({}) t ON t.owner = c.owner AND t.table_name = c.table_name {}",
                tables_sql(&schema, include_system),
                order_by_schema(&schema, "c.owner", "c.table_name, c.column_id")
            );
            let mut rows = ctx.rows_with(&sql, &[])?;
            let mut out: Vec<TableSchema> = Vec::new();
            for row in &mut rows {
                let name = display_name(
                    &schema,
                    &text(row, 0).unwrap_or_default(),
                    &text(row, 1).unwrap_or_default(),
                );
                let column = column_of(row);
                match out.last_mut() {
                    Some(table) if table.name == name => table.columns.push(column),
                    _ => out.push(TableSchema {
                        name,
                        columns: vec![column],
                    }),
                }
            }
            Ok(out)
        })
        .await
}

pub(super) async fn relations(
    inner: &OracleInner,
    include_system: bool,
) -> Result<Vec<Relation>, EngineError> {
    let schema = inner.schema();
    inner
        .run(move |ctx| {
            let sql = format!(
                "SELECT c.owner, c.table_name, c.constraint_name, cc.column_name, \
                        r.owner, r.table_name, rc.column_name \
                 FROM all_constraints c \
                 JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name \
                 JOIN all_constraints r ON r.owner = c.r_owner AND r.constraint_name = c.r_constraint_name \
                 JOIN all_cons_columns rc ON rc.owner = r.owner AND rc.constraint_name = r.constraint_name \
                   AND rc.position = cc.position \
                 WHERE c.constraint_type = 'R' AND {} AND c.table_name NOT LIKE 'BIN$%' \
                 {}",
                owner_filter("c.owner", &schema, include_system),
                order_by_schema(&schema, "c.owner", "c.table_name, c.constraint_name, cc.position")
            );
            let rows = ctx.rows_with(&sql, &[])?;
            let mut out: Vec<Relation> = Vec::new();
            let mut current: Option<(String, String, String)> = None;
            for row in &rows {
                let value = |index| text(row, index).unwrap_or_default();
                let key = (value(0), value(1), value(2));
                if current.as_ref() != Some(&key) {
                    out.push(Relation {
                        table: display_name(&schema, &key.0, &key.1),
                        columns: Vec::new(),
                        ref_table: display_name(&schema, &value(4), &value(5)),
                        ref_columns: Vec::new(),
                    });
                    current = Some(key);
                }
                if let Some(relation) = out.last_mut() {
                    relation.columns.push(value(3));
                    relation.ref_columns.push(value(6));
                }
            }
            Ok(out)
        })
        .await
}

pub(super) async fn table_count(inner: &OracleInner, name: &str) -> Result<i64, EngineError> {
    let (owner, table) = split_name(&inner.schema(), name);
    inner
        .run(move |ctx| {
            let sql = format!("SELECT COUNT(*) FROM {}.{}", quote(&owner), quote(&table));
            let rows = ctx
                .rows(&sql, &[], &[])
                .map_err(|err| ora_err(err, Some(&sql)))?;
            Ok(rows.first().and_then(|row| int(row, 0)).unwrap_or(0))
        })
        .await
}

/// A table's primary key columns, in key order.
pub(super) fn primary_key(
    ctx: &Ctx<'_>,
    owner: &str,
    table: &str,
) -> Result<Vec<String>, EngineError> {
    let rows = ctx.rows_with(
        "SELECT kc.column_name FROM all_constraints k \
         JOIN all_cons_columns kc ON kc.owner = k.owner AND kc.constraint_name = k.constraint_name \
         WHERE k.constraint_type = 'P' AND k.owner = :1 AND k.table_name = :2 \
         ORDER BY kc.position",
        &[owner, table],
    )?;
    Ok(rows.iter().filter_map(|row| text(row, 0)).collect())
}

/// The owner and name of a table, view or materialized view as the sidebar
/// or a statement named it (a bare name read in upper case as Oracle does),
/// with its type; None when there is no such object.
fn find_relation(
    ctx: &Ctx<'_>,
    owner: &str,
    name: &str,
) -> Result<Option<(String, String, String)>, EngineError> {
    let rows = ctx.rows_with(
        "SELECT owner, object_name, object_type FROM all_objects \
         WHERE owner IN (:1, UPPER(:2)) AND object_name IN (:3, UPPER(:4)) \
           AND object_type IN ('TABLE', 'VIEW', 'MATERIALIZED VIEW') \
         ORDER BY CASE WHEN object_name = :5 THEN 0 ELSE 1 END, \
                  CASE object_type WHEN 'TABLE' THEN 1 WHEN 'MATERIALIZED VIEW' THEN 0 ELSE 2 END",
        &[owner, owner, name, name, name],
    )?;
    Ok(rows.first().map(|row| {
        (
            text(row, 0).unwrap_or_default(),
            text(row, 1).unwrap_or_default(),
            text(row, 2).unwrap_or_default(),
        )
    }))
}

/// Sets how DBMS_METADATA writes DDL for this session: plain statements
/// without storage clauses, names qualified by their schema (a synonym's
/// or foreign key's target may live in another); `terminators` ends each
/// with `;` or, for PL/SQL, a `/` line, as a script.
fn metadata_transforms(ctx: &Ctx<'_>, terminators: bool) -> Result<(), EngineError> {
    let sql = format!(
        "BEGIN \
           DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'PRETTY', TRUE); \
           DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'SQLTERMINATOR', {}); \
           DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'SEGMENT_ATTRIBUTES', FALSE); \
           DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, 'STORAGE', FALSE); \
         END;",
        if terminators { "TRUE" } else { "FALSE" }
    );
    ctx.execute(&sql, &[], &[])
        .map(|_| ())
        .map_err(|err| ora_err(err, None))
}

/// DDL already read with DBMS_METADATA (about a second each on the server),
/// by type, owner, name and whether it was written as a script, with the
/// object's stamp when it was read (ddl_stamp); None where DBMS_METADATA
/// refused. Served again only while the stamp is the same, so a change made
/// by any session (ALTER, CREATE OR REPLACE, a drop and create) is read anew.
pub(super) type DdlCache =
    Arc<Mutex<HashMap<(String, String, String, bool), (String, Option<String>)>>>;

/// What changes whenever the DDL of `owner`.`name` may have: the newest
/// LAST_DDL_TIME of every object by that name (a package's or type's spec
/// and body), how many there are and their ids. None when it can't be read
/// or a change was made this very second, when another one could follow
/// within the same second unseen: such DDL isn't kept.
fn ddl_stamp(ctx: &Ctx<'_>, owner: &str, name: &str) -> Option<String> {
    let rows = ctx
        .rows_with(
            "SELECT TO_CHAR(MAX(last_ddl_time), 'YYYYMMDDHH24MISS') || '/' || COUNT(*) || '/' || SUM(object_id), \
             CASE WHEN MAX(last_ddl_time) >= SYSDATE - 1 / 86400 THEN 1 ELSE 0 END \
             FROM all_objects WHERE owner = :1 AND object_name = :2",
            &[owner, name],
        )
        .ok()?;
    let row = rows.first()?;
    (int(row, 1) == Some(0)).then(|| text(row, 0)).flatten()
}

/// DBMS_METADATA's DDL of an object, or None when it has none for this
/// account (another schema's object without SELECT_CATALOG_ROLE).
/// `terminators` ends each statement as a script would (see
/// metadata_transforms). A sequence's is read every time: its START WITH
/// moves with every NEXTVAL, which no DDL time shows.
fn metadata_ddl(
    ctx: &Ctx<'_>,
    cache: &DdlCache,
    kind: &str,
    owner: &str,
    name: &str,
    terminators: bool,
) -> Option<String> {
    let key = (
        kind.to_string(),
        owner.to_string(),
        name.to_string(),
        terminators,
    );
    let stamp = (kind != "SEQUENCE")
        .then(|| ddl_stamp(ctx, owner, name))
        .flatten();
    if let Some(stamp) = &stamp {
        if let Some((kept_stamp, kept)) = cache
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&key)
        {
            if kept_stamp == stamp {
                return kept.clone();
            }
        }
    }
    let ddl = metadata_transforms(ctx, terminators).ok().and_then(|()| {
        let mut rows = ctx
            .rows_with(
                "SELECT DBMS_METADATA.GET_DDL(:1, :2, :3) FROM DUAL",
                &[kind, name, owner],
            )
            .ok()?;
        let row = rows.first_mut()?;
        clob(row, 0)
            .map(|ddl| ddl.trim().to_string())
            .filter(|ddl| !ddl.is_empty())
    });
    let mut cache = cache.lock().unwrap_or_else(PoisonError::into_inner);
    match stamp {
        Some(stamp) => {
            cache.insert(key, (stamp, ddl.clone()));
        }
        None => {
            cache.remove(&key);
        }
    }
    ddl
}

/// CREATE TABLE written from the columns, for an account DBMS_METADATA
/// won't answer.
fn build_create_table(owner: &str, table: &str, columns: &[ColumnSchema]) -> String {
    let mut lines: Vec<String> = columns
        .iter()
        .map(|column| {
            let mut line = format!(
                "  {} {}",
                quote(&column.name),
                column.decl_type.as_deref().unwrap_or("VARCHAR2(4000)")
            );
            if let Some(default) = &column.default {
                line.push_str(&format!(" DEFAULT {default}"));
            }
            if column.not_null {
                line.push_str(" NOT NULL");
            }
            line
        })
        .collect();
    let pk: Vec<String> = columns
        .iter()
        .filter(|column| column.pk)
        .map(|column| quote(&column.name))
        .collect();
    if !pk.is_empty() {
        lines.push(format!("  PRIMARY KEY ({})", pk.join(", ")));
    }
    format!(
        "CREATE TABLE {}.{} (\n{}\n)",
        quote(owner),
        quote(table),
        lines.join(",\n")
    )
}

pub(super) async fn table_detail(
    inner: &OracleInner,
    name: &str,
) -> Result<TableDetail, EngineError> {
    // Opening a table's structure shows its key as it is now: so should the
    // next SELECT.
    inner.sources.clear();
    let schema = inner.schema();
    let user = inner.user();
    let (owner, table) = split_name(&schema, name);
    let cache = inner.ddl.clone();
    inner
        .run(move |ctx| {
            let Some((owner, table, object_type)) = find_relation(ctx, &owner, &table)? else {
                return Err(EngineError::TableNotFound);
            };
            let mut column_rows = ctx.rows_with(
                &format!("{COLUMNS_SELECT} WHERE c.owner = :1 AND c.table_name = :2 ORDER BY c.column_id"),
                &[&owner, &table],
            )?;
            let columns: Vec<ColumnSchema> = column_rows.iter_mut().map(column_of).collect();

            let pk_index: Option<String> = ctx
                .rows_with(
                    "SELECT index_name FROM all_constraints \
                     WHERE constraint_type = 'P' AND owner = :1 AND table_name = :2",
                    &[&owner, &table],
                )?
                .first()
                .and_then(|row| text(row, 0));
            let mut index_rows = ctx.rows_with(
                "SELECT i.index_name, i.uniqueness, ic.column_name, ic.descend, ie.column_expression \
                 FROM all_indexes i \
                 JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name \
                 LEFT JOIN all_ind_expressions ie ON ie.index_owner = ic.index_owner \
                   AND ie.index_name = ic.index_name AND ie.column_position = ic.column_position \
                 WHERE i.table_owner = :1 AND i.table_name = :2 AND i.index_type <> 'LOB' \
                 ORDER BY i.index_name, ic.column_position",
                &[&owner, &table],
            )?;
            let mut indexes: Vec<IndexInfo> = Vec::new();
            for row in &mut index_rows {
                let index_name = text(row, 0).unwrap_or_default();
                let descending = text(row, 3).as_deref() == Some("DESC");
                let expression = clob(row, 4).map(|text| text.trim().to_string());
                // A DESC key is stored as the expression "COLUMN".
                let part = match expression {
                    Some(expression)
                        if descending
                            && expression.starts_with('"')
                            && expression.ends_with('"')
                            && expression.len() > 1 =>
                    {
                        IndexPart {
                            column: Some(expression[1..expression.len() - 1].replace("\"\"", "\"")),
                            descending,
                            ..IndexPart::default()
                        }
                    }
                    Some(expression) => IndexPart {
                        expression: Some(expression),
                        descending,
                        ..IndexPart::default()
                    },
                    None => IndexPart {
                        column: text(row, 2),
                        descending,
                        ..IndexPart::default()
                    },
                };
                let column = part.column.clone();
                match indexes.last_mut() {
                    Some(existing) if existing.name == index_name => {
                        existing.columns.extend(column);
                        existing.parts.get_or_insert_with(Vec::new).push(part);
                    }
                    _ => indexes.push(IndexInfo {
                        primary: pk_index.as_deref() == Some(index_name.as_str()),
                        unique: text(row, 1).as_deref() == Some("UNIQUE"),
                        name: index_name,
                        columns: column.into_iter().collect(),
                        parts: Some(vec![part]),
                        ..IndexInfo::default()
                    }),
                }
            }

            let fk_rows = ctx.rows_with(
                "SELECT c.constraint_name, cc.column_name, r.owner, r.table_name, rc.column_name \
                 FROM all_constraints c \
                 JOIN all_cons_columns cc ON cc.owner = c.owner AND cc.constraint_name = c.constraint_name \
                 JOIN all_constraints r ON r.owner = c.r_owner AND r.constraint_name = c.r_constraint_name \
                 JOIN all_cons_columns rc ON rc.owner = r.owner AND rc.constraint_name = r.constraint_name \
                   AND rc.position = cc.position \
                 WHERE c.constraint_type = 'R' AND c.owner = :1 AND c.table_name = :2 \
                 ORDER BY c.constraint_name, cc.position",
                &[&owner, &table],
            )?;
            let mut foreign_keys: Vec<ForeignKeyInfo> = Vec::new();
            for row in &fk_rows {
                let value = |index| text(row, index).unwrap_or_default();
                match foreign_keys.last_mut() {
                    Some(existing) if existing.name == value(0) => {
                        existing.columns.push(value(1));
                        existing.ref_columns.push(value(4));
                    }
                    _ => foreign_keys.push(ForeignKeyInfo {
                        name: value(0),
                        columns: vec![value(1)],
                        ref_table: display_name(&schema, &value(2), &value(3)),
                        ref_columns: vec![value(4)],
                    }),
                }
            }

            // Statistics, comment, properties and sizes are extras: a
            // failure leaves them empty.
            let mut row_count_estimate = None;
            let mut properties: Vec<TableProperty> = vec![TableProperty {
                name: "유형".into(),
                value: object_type.clone(),
            }];
            if object_type == "TABLE" {
                if let Ok(rows) = ctx.rows_with(
                    "SELECT num_rows, tablespace_name, partitioned, temporary, iot_type, logging, \
                            compression, row_movement, TO_CHAR(last_analyzed, 'YYYY-MM-DD HH24:MI:SS') \
                     FROM all_tables WHERE owner = :1 AND table_name = :2",
                    &[&owner, &table],
                ) {
                    if let Some(row) = rows.first() {
                        row_count_estimate = int(row, 0);
                        let labels = [
                            (1, "테이블스페이스"),
                            (2, "파티션"),
                            (3, "임시 테이블"),
                            (4, "IOT"),
                            (5, "로깅"),
                            (6, "압축"),
                            (7, "행 이동"),
                            (8, "통계 수집 시각"),
                        ];
                        properties.extend(labels.iter().filter_map(|(index, label)| {
                            text(row, *index).map(|value| TableProperty {
                                name: (*label).into(),
                                value,
                            })
                        }));
                    }
                }
            }
            let comment = ctx
                .rows_with(
                    "SELECT comments FROM all_tab_comments WHERE owner = :1 AND table_name = :2",
                    &[&owner, &table],
                )
                .ok()
                .and_then(|rows| rows.first().and_then(|row| text(row, 0)))
                .filter(|comment| !comment.is_empty());
            // USER_SEGMENTS for the account's own tables; DBA_SEGMENTS, if
            // it may read it, for another schema's.
            let segments = if owner == user {
                "user_segments s WHERE 1 = 1".to_string()
            } else {
                format!("dba_segments s WHERE s.owner = {}", literal(&owner))
            };
            let sizes = ctx
                .rows_with(
                    &format!(
                        "SELECT \
                           (SELECT SUM(bytes) FROM {segments} AND s.segment_name = :1), \
                           (SELECT SUM(bytes) FROM {segments} AND s.segment_name IN \
                              (SELECT segment_name FROM all_lobs WHERE owner = :2 AND table_name = :3)), \
                           (SELECT SUM(bytes) FROM {segments} AND s.segment_name IN \
                              (SELECT index_name FROM all_indexes WHERE table_owner = :4 AND table_name = :5)) \
                         FROM DUAL"
                    ),
                    &[&table, &owner, &table, &owner, &table],
                )
                .ok()
                .and_then(|rows| {
                    rows.first()
                        .map(|row| (int(row, 0), int(row, 1), int(row, 2)))
                });
            let (data_bytes, index_bytes) = match sizes {
                Some((table_bytes, lob_bytes, index_bytes)) if table_bytes.is_some() => (
                    Some(table_bytes.unwrap_or(0) + lob_bytes.unwrap_or(0)),
                    Some(index_bytes.unwrap_or(0)),
                ),
                _ => (None, None),
            };
            let size_bytes = data_bytes.zip(index_bytes).map(|(data, index)| data + index);

            let mut trigger_rows = ctx
                .rows_with(
                    "SELECT trigger_name, trigger_type, triggering_event, description, when_clause, trigger_body \
                     FROM all_triggers WHERE table_owner = :1 AND table_name = :2 ORDER BY trigger_name",
                    &[&owner, &table],
                )
                .unwrap_or_default();
            let triggers = trigger_rows
                .iter_mut()
                .map(|row| {
                    let kind = text(row, 1).unwrap_or_default();
                    let timing = ["INSTEAD OF", "BEFORE", "AFTER"]
                        .into_iter()
                        .find(|timing| kind.starts_with(timing))
                        .map(str::to_string);
                    let description = text(row, 3).unwrap_or_default();
                    let when = text(row, 4).filter(|when| !when.trim().is_empty());
                    let body = clob(row, 5).unwrap_or_default();
                    let mut definition = format!("CREATE OR REPLACE TRIGGER {}", description.trim_end());
                    if let Some(when) = when {
                        definition.push_str(&format!("\nWHEN ({})", when.trim()));
                    }
                    definition.push('\n');
                    definition.push_str(body.trim_end());
                    TriggerInfo {
                        name: text(row, 0).unwrap_or_default(),
                        timing,
                        event: text(row, 2).map(|event| event.trim().to_string()),
                        definition: Some(definition),
                    }
                })
                .collect();

            let metadata_kind = match object_type.as_str() {
                "VIEW" => "VIEW",
                "MATERIALIZED VIEW" => "MATERIALIZED_VIEW",
                _ => "TABLE",
            };
            let ddl = metadata_ddl(ctx, &cache, metadata_kind, &owner, &table, false)
                .map(|ddl| ddl.trim_end_matches(';').trim_end().to_string())
                .unwrap_or_else(|| build_create_table(&owner, &table, &columns));

            Ok(TableDetail {
                name: display_name(&schema, &owner, &table),
                row_count_estimate,
                size_bytes,
                data_bytes,
                index_bytes,
                comment,
                columns,
                indexes,
                foreign_keys,
                triggers,
                ddl: Some(ddl),
                schema: Some(owner),
                properties,
            })
        })
        .await
}

/// The sidebar's sections from ALL_OBJECTS, with the dictionary type each
/// one lists.
const OBJECT_TYPES: [(&str, &str); 9] = [
    ("VIEW", "view"),
    ("MATERIALIZED VIEW", "materialized_view"),
    ("SEQUENCE", "sequence"),
    ("SYNONYM", "synonym"),
    ("PACKAGE", "package"),
    ("PROCEDURE", "procedure"),
    ("FUNCTION", "function"),
    ("TRIGGER", "trigger"),
    ("TYPE", "type"),
];

pub(super) async fn objects(
    inner: &OracleInner,
    include_system: bool,
) -> Result<DbObjects, EngineError> {
    let schema = inner.schema();
    inner
        .run(move |ctx| {
            let types: Vec<String> = OBJECT_TYPES.iter().map(|(kind, _)| literal(kind)).collect();
            let sql = format!(
                "SELECT owner, object_name, object_type FROM all_objects \
                 WHERE object_type IN ({}) AND generated = 'N' \
                   AND object_name NOT LIKE 'BIN$%' AND object_name NOT LIKE 'SYS_PLSQL_%' AND {} \
                 {}",
                types.join(", "),
                owner_filter("owner", &schema, include_system),
                order_by_schema(&schema, "owner", "object_name")
            );
            let rows = ctx.rows_with(&sql, &[])?;
            let mut objects = DbObjects::default();
            for row in &rows {
                let name = display_name(
                    &schema,
                    &text(row, 0).unwrap_or_default(),
                    &text(row, 1).unwrap_or_default(),
                );
                let list = match text(row, 2).as_deref() {
                    Some("VIEW") => &mut objects.views,
                    Some("MATERIALIZED VIEW") => &mut objects.materialized_views,
                    Some("SEQUENCE") => &mut objects.sequences,
                    Some("SYNONYM") => &mut objects.synonyms,
                    Some("PACKAGE") => &mut objects.packages,
                    Some("PROCEDURE") => &mut objects.procedures,
                    Some("FUNCTION") => &mut objects.functions,
                    Some("TRIGGER") => &mut objects.triggers,
                    Some("TYPE") => &mut objects.types,
                    _ => continue,
                };
                list.push(name);
            }
            Ok(objects)
        })
        .await
}

/// The parts of an object's definition: its DBMS_METADATA types (a package
/// or type has a spec and a body) and the ALL_SOURCE types that stand in.
fn definition_parts(kind: &str) -> Option<(&'static str, &'static [(&'static str, &'static str)])> {
    Some(match kind {
        "view" => ("VIEW", &[("VIEW", "")]),
        "materialized_view" => ("MATERIALIZED VIEW", &[("MATERIALIZED_VIEW", "")]),
        "sequence" => ("SEQUENCE", &[("SEQUENCE", "")]),
        "synonym" => ("SYNONYM", &[("SYNONYM", "")]),
        "procedure" => ("PROCEDURE", &[("PROCEDURE", "PROCEDURE")]),
        "function" => ("FUNCTION", &[("FUNCTION", "FUNCTION")]),
        "trigger" => ("TRIGGER", &[("TRIGGER", "TRIGGER")]),
        "package" => (
            "PACKAGE",
            &[
                ("PACKAGE_SPEC", "PACKAGE"),
                ("PACKAGE_BODY", "PACKAGE BODY"),
            ],
        ),
        "type" => ("TYPE", &[("TYPE_SPEC", "TYPE"), ("TYPE_BODY", "TYPE BODY")]),
        _ => return None,
    })
}

pub(super) async fn object_definition(
    inner: &OracleInner,
    kind: &str,
    name: &str,
) -> Result<Option<ObjectDefinition>, EngineError> {
    let Some((object_type, parts)) = definition_parts(kind) else {
        return Ok(None);
    };
    let schema = inner.schema();
    let (owner, object) = split_name(&schema, name);
    let kind = kind.to_string();
    let cache = inner.ddl.clone();
    inner
        .run(move |ctx| {
            let found = ctx.rows_with(
                "SELECT owner, object_name FROM all_objects \
                 WHERE owner IN (:1, UPPER(:2)) AND object_name IN (:3, UPPER(:4)) AND object_type = :5 \
                 ORDER BY CASE WHEN object_name = :6 THEN 0 ELSE 1 END",
                &[&owner, &owner, &object, &object, object_type, &object],
            )?;
            let Some(row) = found.first() else {
                return Ok(None);
            };
            let (owner, object) = (text(row, 0).unwrap_or_default(), text(row, 1).unwrap_or_default());
            let plsql = parts.iter().any(|(_, source)| !source.is_empty());
            let mut pieces: Vec<String> = Vec::new();
            for (metadata_type, source_type) in parts {
                let ddl = metadata_ddl(ctx, &cache, metadata_type, &owner, &object, true)
                    .or_else(|| fallback_ddl(ctx, metadata_type, source_type, &owner, &object));
                if let Some(ddl) = ddl {
                    // A PL/SQL unit ends at a `/` line, as a script runs it
                    // (DBMS_METADATA writes one with SQLTERMINATOR).
                    let ends = ddl.trim_end().ends_with('/');
                    pieces.push(if plsql && !ends { format!("{ddl}\n/") } else { ddl });
                }
            }
            if pieces.is_empty() {
                return Ok(None);
            }
            Ok(Some(ObjectDefinition {
                name: display_name(&schema, &owner, &object),
                kind,
                ddl: Some(pieces.join("\n\n")),
            }))
        })
        .await
}

/// A definition from the dictionary for an account DBMS_METADATA refuses:
/// ALL_SOURCE for PL/SQL, ALL_VIEWS and ALL_MVIEWS for queries, and the
/// sequence's and synonym's settings.
fn fallback_ddl(
    ctx: &Ctx<'_>,
    metadata_type: &str,
    source_type: &str,
    owner: &str,
    object: &str,
) -> Option<String> {
    let qualified = format!("{}.{}", quote(owner), quote(object));
    if !source_type.is_empty() {
        let mut rows = ctx
            .rows_with(
                "SELECT text FROM all_source WHERE owner = :1 AND name = :2 AND type = :3 ORDER BY line",
                &[owner, object, source_type],
            )
            .ok()?;
        let source: String = rows.iter_mut().filter_map(|row| clob(row, 0)).collect();
        return (!source.trim().is_empty())
            .then(|| format!("CREATE OR REPLACE {}", source.trim_end()));
    }
    match metadata_type {
        "VIEW" => {
            let mut rows = ctx
                .rows_with(
                    "SELECT text FROM all_views WHERE owner = :1 AND view_name = :2",
                    &[owner, object],
                )
                .ok()?;
            let text = clob(rows.first_mut()?, 0)?;
            Some(format!(
                "CREATE OR REPLACE VIEW {qualified} AS\n{}",
                text.trim()
            ))
        }
        "MATERIALIZED_VIEW" => {
            let mut rows = ctx
                .rows_with(
                    "SELECT query FROM all_mviews WHERE owner = :1 AND mview_name = :2",
                    &[owner, object],
                )
                .ok()?;
            let text = clob(rows.first_mut()?, 0)?;
            Some(format!(
                "CREATE MATERIALIZED VIEW {qualified} AS\n{}",
                text.trim()
            ))
        }
        "SEQUENCE" => {
            let rows = ctx
                .rows_with(
                    "SELECT TO_CHAR(min_value), TO_CHAR(max_value), TO_CHAR(increment_by), cycle_flag, \
                            cache_size, TO_CHAR(last_number) \
                     FROM all_sequences WHERE sequence_owner = :1 AND sequence_name = :2",
                    &[owner, object],
                )
                .ok()?;
            let row = rows.first()?;
            let value = |index| text(row, index).unwrap_or_default();
            Some(format!(
                "CREATE SEQUENCE {qualified} MINVALUE {} MAXVALUE {} INCREMENT BY {} START WITH {} {} {}",
                value(0),
                value(1),
                value(2),
                value(5),
                match int(row, 4) {
                    Some(0) | None => "NOCACHE".to_string(),
                    Some(size) => format!("CACHE {size}"),
                },
                if value(3) == "Y" { "CYCLE" } else { "NOCYCLE" }
            ))
        }
        "SYNONYM" => {
            let rows = ctx
                .rows_with(
                    "SELECT table_owner, table_name, db_link FROM all_synonyms \
                     WHERE owner = :1 AND synonym_name = :2",
                    &[owner, object],
                )
                .ok()?;
            let row = rows.first()?;
            let target = match text(row, 0) {
                Some(target_owner) => format!("{}.{}", quote(&target_owner), quote(&text(row, 1)?)),
                None => quote(&text(row, 1)?),
            };
            let link = text(row, 2)
                .map(|link| format!("@{link}"))
                .unwrap_or_default();
            Some(if owner == "PUBLIC" {
                format!(
                    "CREATE OR REPLACE PUBLIC SYNONYM {} FOR {target}{link}",
                    quote(object)
                )
            } else {
                format!("CREATE OR REPLACE SYNONYM {qualified} FOR {target}{link}")
            })
        }
        _ => None,
    }
}

pub(super) async fn server_info(inner: &OracleInner) -> Result<ServerInfo, EngineError> {
    inner
        .run(move |ctx| {
            let first_text = |sql: &str| -> Option<String> {
                ctx.rows_with(sql, &[])
                    .ok()
                    .and_then(|rows| rows.first().and_then(|row| text(row, 0)))
            };
            let first_int = |sql: &str| -> Option<i64> {
                ctx.rows_with(sql, &[])
                    .ok()
                    .and_then(|rows| rows.first().and_then(|row| int(row, 0)))
            };
            let server_version = ctx.conn.version().ok().map(|version| version.to_string());
            let banner = first_text("SELECT banner FROM v$version WHERE banner LIKE 'Oracle%'");
            let version = match (banner, server_version) {
                (Some(banner), Some(version)) => Some(format!("{banner} ({version})")),
                (banner, version) => banner.or(version.map(|version| format!("Oracle {version}"))),
            };
            let database = first_text(
                "SELECT SYS_CONTEXT('USERENV', 'CON_NAME') || ' (' || \
                        SYS_CONTEXT('USERENV', 'SERVICE_NAME') || ')' FROM DUAL",
            );
            let encoding = first_text(
                "SELECT value FROM nls_database_parameters WHERE parameter = 'NLS_CHARACTERSET'",
            );
            let uptime =
                first_int("SELECT ROUND((SYSDATE - startup_time) * 86400) FROM v$instance");
            let size_bytes = first_int("SELECT SUM(bytes) FROM dba_data_files")
                .or_else(|| first_int("SELECT SUM(bytes) FROM user_segments"));
            let me = ctx.conn.session_id().ok().map(|sid| sid as i64);
            let sessions = ctx
                .rows_with(
                    "SELECT s.sid, s.serial#, s.username, s.schemaname, s.status, s.last_call_et, \
                            s.program, SUBSTR(q.sql_text, 1, 400) \
                     FROM v$session s LEFT JOIN v$sqlarea q ON q.sql_id = s.sql_id \
                     WHERE s.type = 'USER' ORDER BY s.sid",
                    &[],
                )
                .ok()
                .map(|rows| {
                    rows.iter()
                        .map(|row| {
                            let sid = int(row, 0).unwrap_or_default();
                            let status = text(row, 4);
                            let active = status.as_deref() == Some("ACTIVE");
                            let state = match (status, text(row, 6)) {
                                (Some(status), Some(program)) => {
                                    Some(format!("{status} · {program}"))
                                }
                                (status, _) => status,
                            };
                            ServerSession {
                                id: format!("{sid},{}", int(row, 1).unwrap_or_default()),
                                user: text(row, 2),
                                database: text(row, 3),
                                state,
                                query: text(row, 7),
                                elapsed_ms: active
                                    .then(|| int(row, 5).map(|secs| secs * 1000))
                                    .flatten(),
                                is_current: Some(sid) == me,
                            }
                        })
                        .collect::<Vec<_>>()
                });
            let can_kill = sessions.is_some()
                && first_int("SELECT COUNT(*) FROM session_privs WHERE privilege = 'ALTER SYSTEM'")
                    .is_some_and(|count| count > 0);
            Ok(ServerInfo {
                driver: "oracle".into(),
                version,
                database,
                encoding,
                uptime: uptime.map(humanize_uptime_ko),
                size_bytes,
                sessions,
                can_kill,
                topology: None,
                host: None,
            })
        })
        .await
}

/// Ends a session given as "sid,serial#".
pub(super) async fn kill_session(inner: &OracleInner, id: &str) -> Result<(), EngineError> {
    let parts: Vec<&str> = id.split(',').map(str::trim).collect();
    let (sid, serial) = match parts.as_slice() {
        [sid, serial] => (sid.parse::<u64>(), serial.parse::<u64>()),
        _ => {
            return Err(EngineError::BadRequest(
                "세션 ID가 올바르지 않습니다".into(),
            ))
        }
    };
    let (Ok(sid), Ok(serial)) = (sid, serial) else {
        return Err(EngineError::BadRequest(
            "세션 ID가 올바르지 않습니다".into(),
        ));
    };
    inner
        .run(move |ctx| {
            if ctx.conn.session_id().ok() == Some(sid as usize) {
                return Err(EngineError::BadRequest(
                    "자신의 연결은 종료할 수 없습니다".into(),
                ));
            }
            let sql = format!("ALTER SYSTEM KILL SESSION '{sid},{serial}' IMMEDIATE");
            ctx.execute(&sql, &[], &[])
                .map(|_| ())
                .map_err(|err| match ora_err(err, None) {
                    EngineError::Driver { code, .. } if code.as_deref() == Some("30") => {
                        EngineError::SessionNotFound
                    }
                    other => other,
                })
        })
        .await
}
