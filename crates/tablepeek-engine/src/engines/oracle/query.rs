//! Statements run from the editor and the data tabs: one statement per call,
//! as the page splits them (SQL*Plus style, PL/SQL ending at a `/` line).

use std::time::Instant;

use serde_json::{json, Value};
use tablepeek_types::{ErrorFields, ErrorPosition};

use super::session::{current_schema, ora_err, text, Ctx, OracleInner, Source};
use super::values::{cell, Kind};
use crate::sql_log::Dialect;
use crate::sql_parse::{parse_single_table, tx_controls, TxControl};
use crate::{build_arrow, EngineError, QueryData};

/// A statement as Oracle takes it, and what kind it is.
#[derive(Debug, PartialEq, Eq)]
pub(super) struct Prepared {
    pub(super) sql: String,
    /// A PL/SQL block or unit: its `END;` stays, and DBMS_OUTPUT is read
    /// after an anonymous block.
    pub(super) plsql: Option<Plsql>,
    /// SQL*Plus's EXEC written as the block it stands for: positions
    /// Oracle gives no longer point into the text as typed.
    pub(super) rewritten: bool,
    pub(super) explain: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Plsql {
    /// BEGIN/DECLARE … END; or CALL.
    Block,
    /// CREATE of a PL/SQL unit (or a view): `kind` as ALL_ERRORS names it,
    /// its owner if written, its name, and the line its CREATE is on.
    Unit {
        kind: &'static str,
        owner: Option<String>,
        name: String,
        line: u32,
    },
}

/// The words that start a statement, comments and quoted text aside, up to
/// `limit`; quoted names keep their quotes.
fn head_words(sql: &str, limit: usize) -> Vec<String> {
    crate::sql_log::lexemes(sql, Dialect::Oracle)
        .filter_map(|lexeme| match lexeme {
            crate::sql_log::Lexeme::Word(word) => Some(word.to_string()),
            _ => None,
        })
        .take(limit)
        .collect()
}

/// The statement the page sent, ready for the driver: a trailing `/` line
/// and, outside PL/SQL, a trailing `;` dropped; `EXEC p(1)` as the block
/// `BEGIN p(1); END;`.
pub(super) fn prepare(sql: &str) -> Prepared {
    let mut text = sql.trim_end().to_string();
    // A lone `/` on the last line ends the statement in SQL*Plus.
    if let Some(at) = text.rfind('\n') {
        if text[at + 1..].trim() == "/" {
            text.truncate(at);
            text.truncate(text.trim_end().len());
        }
    } else if text.trim() == "/" {
        text.clear();
    }
    let words: Vec<String> = head_words(&text, 8)
        .into_iter()
        .map(|word| word.to_ascii_uppercase())
        .collect();
    let first = words.first().map(String::as_str).unwrap_or("");
    if matches!(first, "EXEC" | "EXECUTE") && words.get(1).map(String::as_str) != Some("IMMEDIATE")
    {
        // EXEC p(1) is SQL*Plus for BEGIN p(1); END;
        let start = text.to_ascii_uppercase().find(first).unwrap_or(0) + first.len();
        let body = text[start..].trim().trim_end_matches(';').trim_end();
        return Prepared {
            sql: format!("BEGIN {body}; END;"),
            plsql: Some(Plsql::Block),
            rewritten: true,
            explain: false,
        };
    }
    let plsql = match first {
        "BEGIN" | "DECLARE" | "CALL" => Some(Plsql::Block),
        "CREATE" => unit_of(&text),
        _ => None,
    };
    // PL/SQL keeps its closing `;`; SQL (CALL, CREATE VIEW too) takes none.
    let keeps_semicolon = match &plsql {
        Some(Plsql::Block) => first != "CALL",
        Some(Plsql::Unit { kind, .. }) => *kind != "VIEW",
        None => false,
    };
    if !keeps_semicolon {
        if let Some(stripped) = text.strip_suffix(';') {
            text.truncate(stripped.trim_end().len());
        }
    }
    Prepared {
        explain: first == "EXPLAIN" && words.get(1).map(String::as_str) == Some("PLAN"),
        sql: text,
        plsql,
        rewritten: false,
    }
}

/// CREATE [OR REPLACE] [EDITIONABLE|NONEDITIONABLE] [FORCE] … of a unit
/// whose compile errors ALL_ERRORS keeps.
fn unit_of(sql: &str) -> Option<Plsql> {
    let raw = head_words(sql, 12);
    let upper: Vec<String> = raw.iter().map(|word| word.to_ascii_uppercase()).collect();
    let mut at = 1;
    let skip = [
        "OR",
        "REPLACE",
        "EDITIONABLE",
        "NONEDITIONABLE",
        "EDITIONING",
        "FORCE",
        "NO",
        "AND",
        "COMPILE",
        "RESOLVE",
        "NOFORCE",
    ];
    while upper
        .get(at)
        .is_some_and(|word| skip.contains(&word.as_str()))
    {
        at += 1;
    }
    let kind = match upper.get(at).map(String::as_str)? {
        "PROCEDURE" => "PROCEDURE",
        "FUNCTION" => "FUNCTION",
        "TRIGGER" => "TRIGGER",
        "LIBRARY" => "LIBRARY",
        "VIEW" => "VIEW",
        "PACKAGE" if upper.get(at + 1).map(String::as_str) == Some("BODY") => {
            at += 1;
            "PACKAGE BODY"
        }
        "PACKAGE" => "PACKAGE",
        "TYPE" if upper.get(at + 1).map(String::as_str) == Some("BODY") => {
            at += 1;
            "TYPE BODY"
        }
        "TYPE" => "TYPE",
        _ => return None,
    };
    // The name follows the kind's last word: owner.name or name, either
    // quoted.
    let last = upper.get(at)?;
    let create = sql.to_ascii_uppercase().find("CREATE").unwrap_or(0);
    let upper_sql = sql.to_ascii_uppercase();
    let after = upper_sql[create..].find(last.as_str())? + create + last.len();
    let (first_part, rest) = name_part(sql[after..].trim_start())?;
    let (owner, name) = match rest.trim_start().strip_prefix('.') {
        Some(rest) => (Some(first_part), name_part(rest.trim_start())?.0),
        None => (None, first_part),
    };
    let line = sql[..create].matches('\n').count() as u32 + 1;
    Some(Plsql::Unit {
        kind,
        owner,
        name,
        line,
    })
}

/// One name at the start of `text` (quoted or bare, read as Oracle reads
/// it) and the text after it.
fn name_part(text: &str) -> Option<(String, &str)> {
    if let Some(rest) = text.strip_prefix('"') {
        let end = rest.find('"')?;
        return Some((rest[..end].to_string(), &rest[end + 1..]));
    }
    let end = text
        .find(|ch: char| !(ch.is_alphanumeric() || matches!(ch, '_' | '$' | '#')))
        .unwrap_or(text.len());
    (end > 0).then(|| (text[..end].to_ascii_uppercase(), &text[end..]))
}

/// A query's rows, up to `max_rows`.
struct Fetched {
    columns: Vec<String>,
    values: Vec<Vec<Value>>,
    count: usize,
    truncated: bool,
}

fn fetch(ctx: &Ctx<'_>, sql: &str, max_rows: usize, log: bool) -> Result<Fetched, EngineError> {
    if log {
        ctx.log.record(sql, Dialect::Oracle);
    }
    let statement = ctx
        .conn
        .statement(sql)
        .map_err(|err| ora_err(err, Some(sql)))?
        .fetch_array_size(500)
        .build()
        .map_err(|err| ora_err(err, Some(sql)))?;
    let cursor = statement
        .query(&[])
        .map_err(|err| ora_err(err, Some(sql)))?;
    read_cursor(cursor, sql, max_rows)
}

fn read_cursor(
    cursor: oracledb::Cursor,
    sql: &str,
    max_rows: usize,
) -> Result<Fetched, EngineError> {
    let columns: Vec<String> = cursor
        .columns()
        .iter()
        .map(|column| column.name().to_string())
        .collect();
    let kinds: Vec<Kind> = cursor.columns().iter().map(Kind::of).collect();
    let mut values: Vec<Vec<Value>> = vec![Vec::new(); columns.len()];
    let mut count = 0usize;
    let mut truncated = false;
    for row in cursor {
        let mut row = row.map_err(|err| ora_err(err, Some(sql)))?;
        if count >= max_rows {
            truncated = true;
            break;
        }
        for (index, kind) in kinds.iter().enumerate() {
            values[index]
                .push(cell(&mut row, index, *kind).map_err(|err| ora_err(err, Some(sql)))?);
        }
        count += 1;
    }
    Ok(Fetched {
        columns,
        values,
        count,
        truncated,
    })
}

/// What DBMS_OUTPUT collected since it was last read, line by line.
fn dbms_output(ctx: &Ctx<'_>) -> Result<Vec<String>, EngineError> {
    const READ_OUTPUT: &str = "DECLARE l_line VARCHAR2(32767); l_status INTEGER; l_text CLOB; \
         BEGIN LOOP DBMS_OUTPUT.GET_LINE(l_line, l_status); EXIT WHEN l_status <> 0; \
         l_text := l_text || l_line || CHR(10); END LOOP; :1 := l_text; END;";
    let mut result = ctx
        .execute(READ_OUTPUT, &[&oracledb::DB_TYPE_CLOB], &[])
        .map_err(|err| ora_err(err, None))?;
    let mut row = result.out_bind_data();
    let text = super::session::clob(&mut row, 0).unwrap_or_default();
    Ok(text.lines().map(str::to_string).collect())
}

/// The errors a CREATE left its unit with, as one error pointing at the
/// first; None when it compiled.
fn compile_errors(
    ctx: &Ctx<'_>,
    schema: &str,
    kind: &str,
    owner: Option<&str>,
    name: &str,
    line: u32,
) -> Result<Option<EngineError>, EngineError> {
    let owner = owner.unwrap_or(schema);
    let rows = ctx.rows_with(
        "SELECT line, position, text, attribute, message_number FROM all_errors \
         WHERE owner = :1 AND name = :2 AND type = :3 ORDER BY sequence",
        &[owner, name, kind],
    )?;
    let errors: Vec<Value> = rows
        .iter()
        .map(|row| {
            json!({
                "line": super::session::int(row, 0),
                "column": super::session::int(row, 1),
                "text": text(row, 2),
                "attribute": text(row, 3),
            })
        })
        .collect();
    let Some(first) = rows
        .iter()
        .find(|row| text(row, 3).as_deref() == Some("ERROR"))
    else {
        return Ok(None);
    };
    let at_line = super::session::int(first, 0).unwrap_or(1).max(1) as u32;
    let at_column = super::session::int(first, 1).unwrap_or(1).max(1) as u32;
    let detail = text(first, 2).unwrap_or_default();
    let fields = ErrorFields {
        server_code: Some(24344),
        position: Some(ErrorPosition {
            line: Some(line + at_line - 1),
            column: Some(at_column),
            ..ErrorPosition::default()
        }),
        details: Some(json!({ "errors": errors })),
        ..ErrorFields::default()
    };
    Ok(Some(EngineError::Driver {
        engine: "oracle",
        code: Some("24344".into()),
        message: format!(
            "ORA-24344: {kind} {name}이(가) 컴파일 오류와 함께 만들어졌습니다 — {} ({at_line}행 {at_column}열)",
            detail.trim()
        ),
        interrupted: false,
        fields: Box::new(fields),
    }))
}

/// What a statement left behind.
struct Ran {
    fetched: Option<Fetched>,
    rows_affected: Option<u64>,
    schema: Option<String>,
}

pub(super) async fn query(
    inner: &OracleInner,
    sql: &str,
    max_rows: usize,
) -> Result<QueryData, EngineError> {
    let started = Instant::now();
    let prepared = prepare(sql);
    if prepared.sql.trim().is_empty() {
        return Err(EngineError::BadRequest("실행할 문장이 없습니다".into()));
    }
    let controls = tx_controls(&prepared.sql, Dialect::Oracle);
    inner
        .sources
        .before_statement(&prepared.sql, Dialect::Oracle);
    // A statement run outside a transaction of the user's is committed
    // right after (SET TRANSACTION starts one instead).
    let autocommit = !inner.in_tx() && !controls.contains(&TxControl::Begin);
    let schema = inner.schema();
    let timeout = inner.query_timeout();
    let statement_sql = prepared.sql.clone();
    let plsql = prepared.plsql.clone();
    let explain = prepared.explain;
    let rewritten = prepared.rewritten;
    let run = inner.run(move |ctx| {
        let sql = statement_sql.as_str();
        let position_sql = (!rewritten).then_some(sql);
        let ran = (|| {
            ctx.log.record(sql, Dialect::Oracle);
            let statement = ctx
                .conn
                .statement(sql)
                .map_err(|err| ora_err(err, position_sql))?
                .fetch_array_size(500)
                .build()
                .map_err(|err| ora_err(err, position_sql))?;
            let mut ran = Ran {
                fetched: None,
                rows_affected: None,
                schema: None,
            };
            if statement.is_query() {
                let cursor = statement
                    .query(&[])
                    .map_err(|err| ora_err(err, position_sql))?;
                ran.fetched = Some(read_cursor(cursor, sql, max_rows)?);
            } else {
                let mut statement = statement;
                let result = statement
                    .execute(&[])
                    .map_err(|err| ora_err(err, position_sql))?;
                ran.rows_affected = Some(result.rows_affected());
            }
            Ok::<Ran, EngineError>(ran)
        })();
        let mut ran = ran?;
        match &plsql {
            Some(Plsql::Block) => {
                let lines = dbms_output(ctx)?;
                if !lines.is_empty() {
                    ran.fetched = Some(Fetched {
                        columns: vec!["DBMS_OUTPUT".into()],
                        count: lines.len(),
                        values: vec![lines.into_iter().map(Value::from).collect()],
                        truncated: false,
                    });
                    ran.rows_affected = None;
                }
            }
            Some(Plsql::Unit {
                kind,
                owner,
                name,
                line,
            }) => {
                if let Some(err) =
                    compile_errors(ctx, &schema, kind, owner.as_deref(), name, *line)?
                {
                    return Err(err);
                }
            }
            None => {}
        }
        if explain {
            ran.fetched = Some(fetch(
                ctx,
                "SELECT plan_table_output FROM TABLE(DBMS_XPLAN.DISPLAY(NULL, NULL, 'TYPICAL'))",
                usize::MAX,
                true,
            )?);
            ran.rows_affected = None;
        }
        let upper = sql.to_ascii_uppercase();
        if upper.contains("CURRENT_SCHEMA") && upper.trim_start().starts_with("ALTER") {
            ran.schema = Some(current_schema(ctx)?);
        }
        // A plain query holds nothing to commit, unless it locked rows.
        let locks = ran.fetched.is_some() && upper.contains("FOR UPDATE");
        if autocommit && (ran.fetched.is_none() || locks || explain) {
            ctx.autocommit().map_err(|err| ora_err(err, None))?;
        }
        Ok(ran)
    });
    // The page's time limit: past it the statement is cancelled as the stop
    // button would (the driver's own call timeout can't break a call).
    let mut timed_out = false;
    let outcome = match timeout {
        None => run.await,
        Some(limit) => {
            tokio::pin!(run);
            tokio::select! {
                outcome = &mut run => outcome,
                () = tokio::time::sleep(limit) => {
                    timed_out = true;
                    let _ = inner.cancel();
                    run.await
                }
            }
        }
    };
    let ran = match outcome {
        Ok(ran) => ran,
        Err(err) => {
            inner.sources.clear();
            if inner.take_cancelled() {
                // ORA-01013: the statement stopped and the session, with its
                // transaction, stayed. Anything else: the session was ended.
                let kept =
                    matches!(&err, EngineError::Driver { code: Some(code), .. } if code == "1013");
                let message = match (kept, timeout) {
                    (true, Some(limit)) if timed_out => format!(
                        "쿼리 시간 제한({}초)을 넘어 문장을 멈췄습니다",
                        limit.as_secs()
                    ),
                    (true, _) => "쿼리를 취소했습니다".into(),
                    (false, Some(limit)) if timed_out => format!(
                        "쿼리 시간 제한({}초)을 넘어 세션을 끝내 멈췄습니다. 트랜잭션은 롤백되었습니다",
                        limit.as_secs()
                    ),
                    (false, _) => "쿼리를 취소했습니다. 세션을 끝내 멈췄으므로 트랜잭션은 롤백되었습니다".into(),
                };
                let message = if kept && inner.in_tx() {
                    format!("{message}. 열린 트랜잭션은 그대로입니다")
                } else {
                    message
                };
                return Err(match err {
                    EngineError::Driver { code, fields, .. } => EngineError::Driver {
                        engine: "oracle",
                        code,
                        message,
                        interrupted: true,
                        fields,
                    },
                    other => other,
                });
            }
            return Err(err);
        }
    };
    inner.take_cancelled();
    if let Some(schema) = ran.schema {
        inner.set_schema(schema);
    }
    // COMMIT, ROLLBACK and DDL run from the editor move the transaction.
    for control in &controls {
        match control {
            TxControl::Begin => inner.set_open(true, false),
            TxControl::Commit if inner.in_tx() => inner.set_open(false, true),
            TxControl::Rollback if inner.in_tx() => inner.set_open(false, false),
            TxControl::ImplicitCommit if inner.in_tx() => inner.set_open(false, true),
            _ => {}
        }
    }
    let fetched = ran.fetched.unwrap_or(Fetched {
        columns: Vec::new(),
        values: Vec::new(),
        count: 0,
        truncated: false,
    });
    let (source_table, pk) = if fetched.columns.is_empty() {
        (None, None)
    } else {
        detect_source(inner, &prepared.sql, &fetched.columns).await
    };
    let (schema, batches) = build_arrow(&fetched.columns, fetched.values, fetched.count)?;
    Ok(QueryData {
        kind: "oracle",
        columns: fetched.columns,
        schema,
        batches,
        row_count: fetched.count,
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
        truncated: fetched.truncated,
        source_table,
        pk,
        column_kinds: Vec::new(),
        rows_affected: ran.rows_affected,
        next_page: None,
    })
}

/// A table as its display name: bare in the session's schema, OWNER.NAME
/// elsewhere.
pub(super) fn display_name(schema: &str, owner: &str, name: &str) -> String {
    if owner == schema {
        name.to_string()
    } else {
        format!("{owner}.{name}")
    }
}

/// The table a SELECT read and its primary key, when the result holds every
/// key column. Lookups run on a table's first SELECT only.
async fn detect_source(
    inner: &OracleInner,
    sql: &str,
    columns: &[String],
) -> (Option<String>, Option<Vec<String>>) {
    let Some((owner_part, table_part)) = parse_single_table(sql) else {
        return (None, None);
    };
    let schema = inner.schema();
    let key = (
        owner_part.clone().unwrap_or_else(|| schema.clone()),
        table_part,
    );
    let found: Source = match inner.sources.get(&key) {
        Some(found) => found,
        None => {
            let lookup_key = key.clone();
            let looked_up = inner
                .run(move |ctx| {
                    let (owner, table) = (&lookup_key.0, &lookup_key.1);
                    let rows = ctx.rows_with(
                        "SELECT owner, table_name FROM all_tables \
                         WHERE owner IN (:1, UPPER(:2)) AND table_name IN (:3, UPPER(:4)) \
                         ORDER BY CASE WHEN table_name = :5 THEN 0 ELSE 1 END \
                         FETCH FIRST 1 ROWS ONLY",
                        &[owner, owner, table, table, table],
                    )?;
                    let Some(row) = rows.first() else {
                        return Ok(None);
                    };
                    let (owner, table) = (
                        text(row, 0).unwrap_or_default(),
                        text(row, 1).unwrap_or_default(),
                    );
                    let pk = super::catalog::primary_key(ctx, &owner, &table)?;
                    Ok(Some((owner, table, pk)))
                })
                .await;
            let Ok(looked_up) = looked_up else {
                return (None, None);
            };
            let source =
                looked_up.map(|(owner, table, pk)| (display_name(&schema, &owner, &table), pk));
            inner.sources.put(key, source.clone());
            source
        }
    };
    let Some((display, pk)) = found else {
        return (None, None);
    };
    let present = !pk.is_empty()
        && pk.iter().all(|name| {
            columns
                .iter()
                .any(|column| column.eq_ignore_ascii_case(name))
        });
    (Some(display), present.then_some(pk))
}
