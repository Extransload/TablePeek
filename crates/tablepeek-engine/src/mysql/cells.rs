//! A BINARY, VARBINARY or BLOB cell read whole and replaced whole, past the
//! 16 KiB the grid shows of one (`capabilities.binary_cells`). Both run on
//! the session's connection, so they see and join its open transaction.
//! The value goes out a SUBSTRING at a time and comes in as appends, each
//! statement within max_allowed_packet, which also bounds the whole value:
//! the server refuses to build a longer one.

use std::sync::Arc;
use std::time::Instant;

use mysql_async::prelude::Queryable;
use mysql_async::Value as MyValue;
use tablepeek_types::CellRef;

use super::{
    after_failed_change, ask_database, check_key, column_type_of, key_term, mysql_err, qualified,
    quote_ident, split_display_table, MyConn, MySqlInner,
};
use crate::cells::{
    append_size, no_key, no_row, not_binary, null_value, read_stream, too_large, Chunks, PIECE,
};
use crate::driver::FileStream;
use crate::sql_log::{inline_params, Change, Dialect, LogParam};
use crate::EngineError;

/// Room in a packet for the statement around the value.
const PACKET_SLACK: u64 = 64 << 10;

/// Where a cell is, and how much it can hold.
struct Located {
    table: String,
    column: String,
    /// The WHERE condition naming its row, the key written as literals.
    condition: String,
    /// What the column's type takes, in bytes.
    capacity: u64,
    /// The column's type as declared (`varbinary(10)`).
    column_type: String,
    /// The session's max_allowed_packet.
    packet: u64,
}

impl Located {
    /// Looks the cell up; an error unless its column holds bytes and its
    /// key is the table's primary key now.
    async fn find(
        inner: &MySqlInner,
        conn: &mut MyConn<'_>,
        cell: &CellRef,
    ) -> Result<Self, EngineError> {
        if cell.pk.is_empty() {
            return Err(no_key());
        }
        let (schema_part, table) = split_display_table(&cell.table);
        let schema = match schema_part {
            Some(schema) => schema,
            None => ask_database(inner, conn).await?,
        };
        check_key(inner, conn, &schema, &table, &cell.pk).await?;
        let (data_type, column_type) = column_type_of(conn, &schema, &table, &cell.column).await?;
        let data_type = data_type.to_lowercase();
        if !matches!(
            data_type.as_str(),
            "binary" | "varbinary" | "tinyblob" | "blob" | "mediumblob" | "longblob"
        ) {
            return Err(not_binary(&cell.column));
        }
        let capacity: Option<u64> = conn
            .exec_first(
                "SELECT CHARACTER_OCTET_LENGTH FROM information_schema.COLUMNS \
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?",
                vec![
                    MyValue::from(schema.clone()),
                    MyValue::from(table.clone()),
                    MyValue::from(cell.column.clone()),
                ],
            )
            .await
            .map_err(mysql_err)?;
        let packet: Option<u64> = conn
            .query_first("SELECT @@max_allowed_packet")
            .await
            .map_err(mysql_err)?;
        let mut condition = String::new();
        for (index, key) in cell.pk.iter().enumerate() {
            if index > 0 {
                condition.push_str(" AND ");
            }
            let (key_type, _) = column_type_of(conn, &schema, &table, &key.column).await?;
            condition.push_str(&key_term(
                &key.column,
                &key_type,
                &key.value,
                conn.no_backslash_escapes(),
            ));
        }
        Ok(Self {
            table: qualified(&schema, &table),
            column: quote_ident(&cell.column),
            condition,
            capacity: capacity.unwrap_or(u64::MAX),
            column_type,
            packet: packet.unwrap_or(4 << 20),
        })
    }

    /// The most bytes one statement can carry.
    fn piece_limit(&self) -> usize {
        usize::try_from(self.packet.saturating_sub(PACKET_SLACK).max(1 << 10)).unwrap_or(PIECE)
    }

    /// The most the cell can take, and what sets it.
    fn limit(&self) -> (u64, String) {
        if self.capacity <= self.packet {
            (self.capacity, self.column_type.clone())
        } else {
            (self.packet, "max_allowed_packet".into())
        }
    }
}

/// The cell's whole value, in pieces. A failure before the first piece (no
/// such row, not a binary column, NULL) is the call's error; one later ends
/// the stream with it.
pub(crate) async fn read_cell(
    inner: Arc<MySqlInner>,
    cell: &CellRef,
) -> Result<FileStream, EngineError> {
    let cell = cell.clone();
    read_stream(move |found, pieces| async move {
        let mut conn = inner.conn().await;
        let located = Located::find(&inner, &mut conn, &cell).await?;
        let Located {
            table,
            column,
            condition,
            ..
        } = &located;
        // Outside a transaction the pieces come from one snapshot of their
        // own; inside one, from the transaction's.
        let own = !inner.in_tx();
        if own {
            conn.query_drop("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY")
                .await
                .map_err(mysql_err)?;
        }
        let outcome = async {
            let length: Option<Option<u64>> = conn
                .query_first(format!(
                    "SELECT LENGTH({column}) FROM {table} WHERE {condition}"
                ))
                .await
                .map_err(mysql_err)?;
            let length = length.ok_or_else(no_row)?.ok_or_else(null_value)?;
            found.yes();
            // InnoDB reads a whole BLOB for each SUBSTRING of it, so a large
            // one goes in fewer, larger pieces.
            let most = located.piece_limit().min(16 << 20);
            let piece = usize::try_from(length / 16)
                .unwrap_or(usize::MAX)
                .clamp(PIECE.min(most), most);
            let mut at = 1u64;
            while at <= length {
                let sql = format!(
                    "SELECT SUBSTRING({column}, {at}, {piece}) FROM {table} WHERE {condition}"
                );
                let bytes: Option<Option<Vec<u8>>> =
                    conn.query_first(sql).await.map_err(mysql_err)?;
                let bytes = bytes.flatten().ok_or_else(no_row)?;
                if bytes.is_empty() {
                    break;
                }
                at += bytes.len() as u64;
                // A dropped receiver (the download stopped) ends the read.
                if !pieces.send(bytes).await {
                    break;
                }
            }
            Ok::<(), EngineError>(())
        }
        .await;
        if own {
            let _ = conn.query_drop("COMMIT").await;
        }
        outcome
    })
    .await
}

/// Replaces the cell with the bytes `data` brings: the first piece set, the
/// rest appended with CONCAT, each statement growing with the value (see
/// `append_size`) up to max_allowed_packet. Inside a transaction it joins
/// it, behind a savepoint; else it runs in one of its own, committed at the
/// end. A failure midway (the upload broke off, the server refused, the
/// value outgrew the column or max_allowed_packet) undoes it, on a table
/// that keeps transactions (InnoDB).
pub(crate) async fn write_cell(
    inner: &MySqlInner,
    cell: &CellRef,
    data: FileStream,
) -> Result<u64, EngineError> {
    let mut conn = inner.conn().await;
    let located = Located::find(inner, &mut conn, cell).await?;
    let in_tx = inner.in_tx();
    let (open, undo, keep) = if in_tx {
        (
            "SAVEPOINT tablepeek_cell",
            "ROLLBACK TO SAVEPOINT tablepeek_cell",
            "RELEASE SAVEPOINT tablepeek_cell",
        )
    } else {
        ("START TRANSACTION", "ROLLBACK", "COMMIT")
    };
    let started = Instant::now();
    conn.query_drop(open).await.map_err(mysql_err)?;
    let outcome = append_all(&mut conn, &located, data).await;
    let outcome = match outcome {
        Ok(size) => conn
            .query_drop(keep)
            .await
            .map(|()| size)
            .map_err(Failure::from),
        Err(failure) => Err(failure),
    };
    let size = match outcome {
        Ok(size) => size,
        Err(failure) => {
            let err = match failure {
                Failure::Server(err) => {
                    after_failed_change(inner, &mut conn, &err).await;
                    mysql_err(err)
                }
                Failure::Other(err) => err,
            };
            // A deadlock already took the transaction, savepoint and all.
            if !in_tx || inner.in_tx() {
                let _ = conn.query_drop(undo).await;
            }
            return Err(err);
        }
    };
    // History shows the change with the size in place of the bytes.
    let Located {
        table,
        column,
        condition,
        ..
    } = &located;
    let change = Change {
        sql: format!("UPDATE {table} SET {column} = /* {size} bytes */ WHERE {condition}"),
        ms: started.elapsed().as_millis() as u64,
        rows: 1,
    };
    conn.log.changed(change, in_tx);
    Ok(1)
}

/// Why a write stopped: the server refused a statement, or anything else.
enum Failure {
    Server(mysql_async::Error),
    Other(EngineError),
}

impl From<mysql_async::Error> for Failure {
    fn from(err: mysql_async::Error) -> Self {
        Self::Server(err)
    }
}

impl From<EngineError> for Failure {
    fn from(err: EngineError) -> Self {
        Self::Other(err)
    }
}

/// Writes the upload into the cell, returning its size.
async fn append_all(
    conn: &mut MyConn<'_>,
    located: &Located,
    data: FileStream,
) -> Result<u64, Failure> {
    let Located {
        table,
        column,
        condition,
        ..
    } = located;
    let set = format!("UPDATE {table} SET {column} = ? WHERE {condition}");
    let append = format!("UPDATE {table} SET {column} = CONCAT({column}, ?) WHERE {condition}");
    let (limit, what) = located.limit();
    let mut chunks = Chunks::new(data);
    let mut first = true;
    loop {
        let size = append_size(chunks.taken).min(located.piece_limit());
        let chunk = match chunks.next(size).await? {
            Some(chunk) => chunk,
            // An empty upload empties the cell.
            None if first => Vec::new(),
            None => break,
        };
        if chunks.taken > limit {
            return Err(too_large(limit, &what).into());
        }
        let sql = if first { &set } else { &append };
        let shown = inline_params(
            sql,
            &[LogParam::Literal(format!("/* {} bytes */", chunk.len()))],
            Dialect::MySql,
        );
        conn.log.record(&shown, Dialect::MySql);
        let result = conn
            .conn
            .exec_iter(sql.as_str(), vec![MyValue::Bytes(chunk)])
            .await?;
        let changed = result.affected_rows();
        result.drop_result().await?;
        if changed == 0 {
            return Err(no_row().into());
        }
        first = false;
    }
    Ok(chunks.taken)
}
