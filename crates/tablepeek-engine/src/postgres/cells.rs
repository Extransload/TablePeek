//! A bytea cell (CockroachDB's BYTES) read whole and replaced whole, past
//! the 16 KiB the grid shows of one (`capabilities.binary_cells`). Both run
//! on the session's connection, so they see and join its open transaction.
//! The value goes out as rows of one statement, a piece each, and comes in
//! as appends, so it never sits whole in memory.

use std::pin::pin;
use std::sync::Arc;
use std::time::Instant;

use futures_util::StreamExt;
use tablepeek_types::CellRef;
use tokio_postgres::types::ToSql;

use super::{
    aborts_transaction, check_key, column_type_of, key_condition, qualified_from_display,
    quote_ident, PgConn, PostgresInner,
};
use crate::cells::{
    append_size, no_key, no_row, not_binary, null_value, read_stream, Chunks, PIECE,
};
use crate::driver::FileStream;
use crate::sql_log::{inline_params, Change, Dialect, LogParam};
use crate::EngineError;

/// Where a cell is: its table as SQL, its column quoted, and the WHERE
/// condition naming its row with that condition's values.
struct Located {
    table: String,
    column: String,
    condition: String,
    keys: Vec<Option<String>>,
}

impl Located {
    /// Looks the cell up; an error unless its column is bytea and its key
    /// is the table's primary key now. The condition's values are bound
    /// from `$first` on.
    async fn find(client: &PgConn<'_>, cell: &CellRef, first: usize) -> Result<Self, EngineError> {
        if cell.pk.is_empty() {
            return Err(no_key());
        }
        let table = qualified_from_display(&cell.table);
        check_key(client, &table, &cell.pk).await?;
        if column_type_of(client, &table, &cell.column).await? != "bytea" {
            return Err(not_binary(&cell.column));
        }
        let (condition, keys) = key_condition(client, &table, &cell.pk, first).await?;
        Ok(Self {
            table,
            column: quote_ident(&cell.column),
            condition,
            keys,
        })
    }

    /// `sql` as the console shows it: the value as its size (`bytes`), the
    /// key values inline.
    fn shown(&self, sql: &str, bytes: Option<usize>) -> String {
        let mut values: Vec<LogParam> = Vec::with_capacity(self.keys.len() + 1);
        if let Some(bytes) = bytes {
            values.push(LogParam::Literal(format!("/* {bytes} bytes */")));
        }
        values.extend(
            self.keys
                .iter()
                .map(|key| key.clone().map_or(LogParam::Null, LogParam::Text)),
        );
        inline_params(sql, &values, Dialect::Postgres)
    }
}

/// The parameters of a statement: `value` first when given, then the key.
fn bound<'a>(
    value: Option<&'a Vec<u8>>,
    keys: &'a [Option<String>],
) -> Vec<&'a (dyn ToSql + Sync)> {
    value
        .map(|value| value as &(dyn ToSql + Sync))
        .into_iter()
        .chain(keys.iter().map(|key| key as &(dyn ToSql + Sync)))
        .collect()
}

/// The cell's whole value, in pieces. A failure before the first piece (no
/// such row, not a bytea column, NULL) is the call's error; one later ends
/// the stream with it.
pub(crate) async fn read_cell(
    inner: Arc<PostgresInner>,
    cell: &CellRef,
) -> Result<FileStream, EngineError> {
    let cell = cell.clone();
    read_stream(move |found, pieces| async move {
        let client = inner.conn().await;
        let located = Located::find(&client, &cell, 1).await?;
        let Located {
            table,
            column,
            condition,
            keys,
        } = &located;
        let probe = format!("SELECT {column} IS NULL FROM {table} WHERE {condition}");
        let row = client
            .query_opt(&probe, &located_params(keys))
            .await?
            .ok_or_else(no_row)?;
        if row.get::<_, bool>(0) {
            return Err(null_value());
        }
        found.yes();
        // One statement, so one snapshot however long the download takes:
        // a row per piece, sent as the server makes it.
        let sql = format!(
            "SELECT g, (SELECT substring({column} FROM g::INT4 FOR {PIECE}) FROM {table} \
             WHERE {condition}) FROM generate_series(1, (SELECT octet_length({column}) \
             FROM {table} WHERE {condition})::INT8, {PIECE}) AS g"
        );
        client.note(&sql, &located_params(keys));
        let rows = client.watch(client.client.query_raw(&sql, bound(None, keys)).await)?;
        let mut rows = pin!(rows);
        let mut at = 1i64;
        while let Some(row) = rows.next().await {
            let row = row.inspect_err(|err| {
                if aborts_transaction(err) {
                    client.tx.failed();
                }
            })?;
            let piece: Option<Vec<u8>> = row.get(1);
            if row.get::<_, i64>(0) != at {
                return Err(EngineError::Internal(
                    "바이너리 값의 조각이 순서대로 오지 않았습니다".into(),
                ));
            }
            let piece = piece.ok_or_else(no_row)?;
            at += PIECE as i64;
            // A dropped receiver (the download stopped) ends the read.
            if !pieces.send(piece).await {
                break;
            }
        }
        Ok(())
    })
    .await
}

/// The key's values as the console shows them.
fn located_params(keys: &[Option<String>]) -> Vec<&dyn super::PgParam> {
    keys.iter().map(|key| key as &dyn super::PgParam).collect()
}

/// The most a CockroachDB value can take, and the setting that says so. It
/// is written in one statement, whose message has to fit the server's
/// buffer (`sql.conn.max_read_buffer_message_size`), and whose row has to
/// fit a Raft command (`kv.raft.command.max_size`) and the row size limit
/// (`sql.guardrails.max_row_size_err`); room is left for the rest. Appends
/// would not lift that: each rewrite of a row inside a transaction carries
/// the values it held before, so the Raft command grows faster than the
/// value. The cluster's own settings when it shows them, else defaults.
async fn cockroach_limit(client: &PgConn<'_>) -> (u64, &'static str) {
    const SLACK: u64 = 1 << 20;
    let mut limit = (u64::MAX, "");
    for (setting, default) in [
        ("sql.conn.max_read_buffer_message_size", 16u64 << 20),
        ("kv.raft.command.max_size", 64 << 20),
        ("sql.guardrails.max_row_size_err", 80 << 20),
    ] {
        let shown = client
            .query_opt(&format!("SHOW CLUSTER SETTING {setting}"), &[])
            .await
            .ok()
            .flatten()
            .and_then(|row| row.try_get::<_, String>(0).ok());
        let size = shown.as_deref().and_then(byte_size).unwrap_or(default);
        // Zero turns the row size limit off.
        if size > 0 && size < limit.0 {
            limit = (size, setting);
        }
    }
    (limit.0.saturating_sub(SLACK), limit.1)
}

/// A size as CockroachDB shows one: `64 MiB`, `512 KiB`, `1.0 GiB`, bytes.
fn byte_size(text: &str) -> Option<u64> {
    let text = text.trim();
    let split = text
        .find(|c: char| !(c.is_ascii_digit() || c == '.'))
        .unwrap_or(text.len());
    let number: f64 = text[..split].parse().ok()?;
    let unit = match text[split..].trim() {
        "" | "B" => 1u64,
        "KiB" => 1 << 10,
        "MiB" => 1 << 20,
        "GiB" => 1 << 30,
        "TiB" => 1 << 40,
        _ => return None,
    };
    Some((number * unit as f64) as u64)
}

/// Replaces the cell with the bytes `data` brings, as a cell edit does: in
/// the open transaction, else committed. PostgreSQL takes it a piece at a
/// time; CockroachDB whole, up to what one statement can hold.
pub(crate) async fn write_cell(
    inner: &PostgresInner,
    cell: &CellRef,
    data: FileStream,
) -> Result<u64, EngineError> {
    let client = inner.conn().await;
    let located = Located::find(&client, cell, 2).await?;
    let in_tx = inner.in_tx();
    let started = Instant::now();
    let size = if inner.kind == "cockroach" {
        let (limit, setting) = cockroach_limit(&client).await;
        let bytes = Chunks::new(data).whole(limit, setting).await?;
        let Located {
            table,
            column,
            condition,
            ..
        } = &located;
        let set = format!("UPDATE {table} SET {column} = $1::BYTEA WHERE {condition}");
        write_piece(&client, &located, &set, &bytes).await?;
        bytes.len()
    } else {
        append_in_steps(&client, &located, data, in_tx).await?
    };
    // History shows the change with the size in place of the bytes.
    let Located {
        table,
        column,
        condition,
        ..
    } = &located;
    let change = Change {
        sql: located.shown(
            &format!("UPDATE {table} SET {column} = $1 WHERE {condition}"),
            Some(size),
        ),
        ms: started.elapsed().as_millis() as u64,
        rows: 1,
    };
    client.log.changed(change, in_tx);
    Ok(1)
}

/// Writes the upload into the cell, the first piece set and the rest
/// appended, each statement growing with the value (see `append_size`), and
/// returns its size. Inside a transaction it joins it, behind a savepoint;
/// else it runs in one of its own, committed at the end. A failure midway
/// (the upload broke off, the server refused) undoes it.
async fn append_in_steps(
    client: &PgConn<'_>,
    located: &Located,
    data: FileStream,
    in_tx: bool,
) -> Result<usize, EngineError> {
    let (open, undo, keep) = if in_tx {
        (
            "SAVEPOINT tablepeek_cell",
            "ROLLBACK TO SAVEPOINT tablepeek_cell",
            "RELEASE SAVEPOINT tablepeek_cell",
        )
    } else {
        ("BEGIN", "ROLLBACK", "COMMIT")
    };
    client.batch_execute(open).await?;
    let size = match append_all(client, located, data).await {
        Ok(size) => size,
        Err(err) => {
            if client.batch_execute(undo).await.is_ok() && in_tx {
                client.tx.recovered();
            }
            return Err(err);
        }
    };
    if let Err(err) = client.batch_execute(keep).await {
        // A COMMIT refused ended our own transaction rolled back; a
        // RELEASE refused leaves the savepoint to undo.
        if in_tx && client.batch_execute(undo).await.is_ok() {
            client.tx.recovered();
        }
        return Err(err.into());
    }
    Ok(size)
}

async fn append_all(
    client: &PgConn<'_>,
    located: &Located,
    data: FileStream,
) -> Result<usize, EngineError> {
    let Located {
        table,
        column,
        condition,
        ..
    } = located;
    let set = format!("UPDATE {table} SET {column} = $1::BYTEA WHERE {condition}");
    let append = format!("UPDATE {table} SET {column} = {column} || $1::BYTEA WHERE {condition}");
    let mut chunks = Chunks::new(data);
    let mut first = true;
    loop {
        let chunk = match chunks.next(append_size(chunks.taken)).await? {
            Some(chunk) => chunk,
            // An empty upload empties the cell.
            None if first => Vec::new(),
            None => break,
        };
        write_piece(client, located, if first { &set } else { &append }, &chunk).await?;
        first = false;
    }
    Ok(chunks.taken as usize)
}

/// Runs `sql` with `bytes` as its value; an error when the key finds no row.
async fn write_piece(
    client: &PgConn<'_>,
    located: &Located,
    sql: &str,
    bytes: &Vec<u8>,
) -> Result<(), EngineError> {
    client
        .log
        .record(&located.shown(sql, Some(bytes.len())), Dialect::Postgres);
    let changed = client.watch(
        client
            .client
            .execute(sql, &bound(Some(bytes), &located.keys))
            .await,
    )?;
    if changed == 0 {
        return Err(no_row());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::byte_size;

    #[test]
    fn cockroach_sizes_read_as_shown() {
        assert_eq!(byte_size("16 MiB"), Some(16 << 20));
        assert_eq!(byte_size("512 KiB"), Some(512 << 10));
        assert_eq!(byte_size("1.5 GiB"), Some(3 << 29));
        assert_eq!(byte_size("0 B"), Some(0));
        assert_eq!(byte_size("1024"), Some(1024));
        assert_eq!(byte_size("lots"), None);
    }
}
