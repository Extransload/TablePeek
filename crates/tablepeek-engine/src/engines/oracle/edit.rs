//! Cell edits, new rows and deletes from the grid, by primary key (no
//! ROWID: a key names the row whatever moves it).

use std::collections::HashMap;

use tablepeek_types::{EditTarget, InsertValue, PkValue};

use super::catalog::{primary_key, quote, split_name};
use super::session::{ora_err, text, Ctx, OracleInner};
use super::values::{write_sql, Binds, Bound, Target};
use crate::source_cache::{key_unchanged, KEY_CHANGED};
use crate::EngineError;

/// A key value as text, the way the grid sends it.
fn key_text(value: &serde_json::Value) -> Option<String> {
    match value {
        serde_json::Value::Null => None,
        serde_json::Value::String(text) => Some(text.clone()),
        other => Some(other.to_string()),
    }
}

/// The table's columns and their types (ALL_TAB_COLUMNS.DATA_TYPE), and
/// its owner and name as the catalog has them; NotFound when there is no
/// such table.
pub(super) fn column_types(
    ctx: &Ctx<'_>,
    owner: &str,
    table: &str,
) -> Result<HashMap<String, Target>, EngineError> {
    let rows = ctx.rows_with(
        "SELECT column_name, data_type FROM all_tab_columns WHERE owner = :1 AND table_name = :2",
        &[owner, table],
    )?;
    if rows.is_empty() {
        return Err(EngineError::TableNotFound);
    }
    Ok(rows
        .iter()
        .filter_map(|row| Some((text(row, 0)?, Target::of(&text(row, 1)?))))
        .collect())
}

pub(super) fn target_of(
    types: &HashMap<String, Target>,
    column: &str,
) -> Result<Target, EngineError> {
    types
        .get(column)
        .copied()
        .ok_or_else(|| EngineError::NotEditable(format!("컬럼을 찾을 수 없습니다: {column}")))
}

/// Refuses a write keyed on columns that aren't the table's primary key now
/// (see `key_unchanged`).
pub(super) fn check_key(
    ctx: &Ctx<'_>,
    owner: &str,
    table: &str,
    pk: &[PkValue],
) -> Result<(), EngineError> {
    let current = primary_key(ctx, owner, table)?;
    if key_unchanged(&current, pk, false) {
        Ok(())
    } else {
        Err(EngineError::NotEditable(KEY_CHANGED.into()))
    }
}

/// `"K1" = :n AND "K2" = :m` for the key values, binds pushed onto `binds`.
pub(super) fn key_condition(
    types: &HashMap<String, Target>,
    pk: &[PkValue],
    binds: &mut Binds,
) -> Result<String, EngineError> {
    let mut parts = Vec::with_capacity(pk.len());
    for key in pk {
        let target = target_of(types, &key.column)?;
        let value = key_text(&key.value);
        if value.is_none() {
            // A primary key column is never NULL.
            return Err(EngineError::NotEditable(
                "기본 키 값이 비어 있어 행을 찾을 수 없습니다".into(),
            ));
        }
        let expr = write_sql(target, value.as_deref(), None, binds)?;
        parts.push(format!("{} = {expr}", quote(&key.column)));
    }
    Ok(parts.join(" AND "))
}

/// Runs a change built by `build` from the table's column types, under the
/// session, committing it when no transaction of the user's is open.
async fn change<F>(
    inner: &OracleInner,
    table: &str,
    check: Option<Vec<PkValue>>,
    build: F,
) -> Result<u64, EngineError>
where
    F: FnOnce(&str, &HashMap<String, Target>, &mut Binds) -> Result<String, EngineError>
        + Send
        + 'static,
{
    let (owner, table) = split_name(&inner.schema(), table);
    let in_tx = inner.in_tx();
    inner
        .run(move |ctx| {
            let types = column_types(ctx, &owner, &table)?;
            if let Some(pk) = &check {
                check_key(ctx, &owner, &table, pk)?;
            }
            let table_ref = format!("{}.{}", quote(&owner), quote(&table));
            let mut binds = Binds::default();
            let dml = build(&table_ref, &types, &mut binds)?;
            // A long BLOB value is built in a temporary BLOB first, so the
            // change runs as a block that also returns its row count.
            let counted = !binds.lobs.is_empty();
            let sql = if counted {
                let declare: String = (1..=binds.lobs.len())
                    .map(|n| format!("blob{n} BLOB; "))
                    .collect();
                format!(
                    "DECLARE {declare}BEGIN {} {dml}; :rows := SQL%ROWCOUNT; END;",
                    binds.lobs.join(" ")
                )
            } else {
                dml
            };
            // The block binds the BLOB pieces first, in the order it names
            // them; the console writes in only the numbered values (a long
            // BLOB's pieces stay placeholders).
            let mut params: Vec<&dyn oracledb::ToDbValue> = binds
                .lob_values
                .iter()
                .chain(&binds.values)
                .map(Bound::as_param)
                .collect();
            let shown: Vec<_> = binds.values.iter().map(Bound::log_param).collect();
            if counted {
                params.push(&oracledb::DB_TYPE_NUMBER);
            }
            let changed = ctx
                .change(&sql, &params, &shown, in_tx, counted)
                .map_err(|err| ora_err(err, Some(&sql)))?;
            if !in_tx {
                ctx.autocommit().map_err(|err| ora_err(err, None))?;
            }
            Ok(changed)
        })
        .await
}

pub(super) async fn edit(inner: &OracleInner, target: &EditTarget) -> Result<u64, EngineError> {
    if target.pk.is_empty() {
        return Err(EngineError::NotEditable(
            "기본 키가 없어 편집할 수 없습니다".into(),
        ));
    }
    let target = target.clone();
    change(
        inner,
        &target.table.clone(),
        Some(target.pk.clone()),
        move |table_ref, types, binds| {
            let column_type = target_of(types, &target.column)?;
            let value = write_sql(column_type, target.value.as_deref(), target.expr, binds)?;
            let condition = key_condition(types, &target.pk, binds)?;
            Ok(format!(
                "UPDATE {table_ref} SET {} = {value} WHERE {condition}",
                quote(&target.column)
            ))
        },
    )
    .await
}

pub(super) async fn insert_row(
    inner: &OracleInner,
    table: &str,
    values: &[InsertValue],
) -> Result<u64, EngineError> {
    let values = values.to_vec();
    change(inner, table, None, move |table_ref, types, binds| {
        if values.is_empty() {
            // Oracle has no DEFAULT VALUES: one column set to DEFAULT
            // leaves every other at its default too.
            let first = types
                .keys()
                .min()
                .cloned()
                .ok_or(EngineError::TableNotFound)?;
            return Ok(format!(
                "INSERT INTO {table_ref} ({}) VALUES (DEFAULT)",
                quote(&first)
            ));
        }
        let mut columns = Vec::with_capacity(values.len());
        let mut exprs = Vec::with_capacity(values.len());
        for value in &values {
            let column_type = target_of(types, &value.column)?;
            columns.push(quote(&value.column));
            exprs.push(write_sql(
                column_type,
                value.value.as_deref(),
                value.expr,
                binds,
            )?);
        }
        Ok(format!(
            "INSERT INTO {table_ref} ({}) VALUES ({})",
            columns.join(", "),
            exprs.join(", ")
        ))
    })
    .await
}

pub(super) async fn delete_row(
    inner: &OracleInner,
    table: &str,
    pk: &[PkValue],
) -> Result<u64, EngineError> {
    if pk.is_empty() {
        return Err(EngineError::BadRequest("PK 조건이 필요합니다".into()));
    }
    let pk = pk.to_vec();
    change(
        inner,
        table,
        Some(pk.clone()),
        move |table_ref, types, binds| {
            let condition = key_condition(types, &pk, binds)?;
            Ok(format!("DELETE FROM {table_ref} WHERE {condition}"))
        },
    )
    .await
}
