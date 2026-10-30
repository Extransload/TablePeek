//! A binary, varbinary or image cell read whole and replaced whole, past the
//! 16 KiB the grid shows of one (`capabilities.binary_cells`). Both run on
//! the session, so they see and join its open transaction. The value goes
//! out a SUBSTRING at a time; a varbinary(max) comes in through `.WRITE`
//! appends, an image through appends of its own, and a varbinary(n) or
//! binary(n), at most 8000 bytes, as one value.

use std::sync::Arc;
use std::time::Instant;

use tablepeek_types::CellRef;
use tiberius::{ColumnData, ToSql};

use super::{
    catalog_rows, cd_i64, check_tx, key_condition, mssql_err, qualified, quote_ident,
    split_display_table, take_client, MsConn, MssqlInner,
};
use crate::cells::{
    append_size, no_key, no_row, not_binary, null_value, read_stream, Chunks, PIECE,
};
use crate::driver::FileStream;
use crate::sql_log::{inline_params, Change, Dialect, LogParam};
use crate::EngineError;

/// A column's type and size (-1 for MAX), read as the other catalog reads
/// are (see `catalog_sql!`): the server checks the type again on writing.
const COLUMN_SIZE_SQL: &str = catalog_sql!(
    "SELECT DATA_TYPE, CHARACTER_MAXIMUM_LENGTH FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = @P1 AND TABLE_NAME = @P2 AND COLUMN_NAME = @P3"
);

/// How a column takes a new value.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    /// varbinary(max): appended to in place with `.WRITE`.
    Max,
    /// image, which `.WRITE` doesn't take: appended to by a rewrite.
    Image,
    /// binary(n), varbinary(n), timestamp: n bytes at most, as one value.
    Sized(u64),
}

/// Where a cell is: its table, its column quoted, how it takes a value, and
/// the WHERE condition naming its row with that condition's values.
struct Located {
    table: String,
    column: String,
    kind: Kind,
    data_type: String,
    condition: String,
    keys: Vec<Option<String>>,
}

impl Located {
    /// Looks the cell up; an error unless its column holds bytes and its
    /// key is the table's primary key now. The condition's values are bound
    /// from `@P{first}` on.
    async fn find(
        inner: &MssqlInner,
        client: &mut MsConn<'_>,
        cell: &CellRef,
        first: usize,
    ) -> Result<Self, EngineError> {
        if cell.pk.is_empty() {
            return Err(no_key());
        }
        let (schema_part, table) = split_display_table(&cell.table);
        let schema = schema_part.unwrap_or_else(|| inner.default_schema.clone());
        super::check_key(inner, client, &schema, &table, &cell.pk).await?;
        let rows = catalog_rows(
            inner,
            client,
            COLUMN_SIZE_SQL,
            &[
                &schema.as_str() as &dyn ToSql,
                &table.as_str() as &dyn ToSql,
                &cell.column.as_str() as &dyn ToSql,
            ],
        )
        .await?;
        let row = rows.into_iter().next().ok_or_else(|| {
            EngineError::NotEditable(format!("컬럼을 찾을 수 없습니다: {}", cell.column))
        })?;
        let values: Vec<ColumnData<'static>> = row.into_iter().collect();
        let data_type = match values.first() {
            Some(ColumnData::String(Some(text))) => text.to_lowercase(),
            _ => String::new(),
        };
        let length = cd_i64(values.get(1));
        let kind = match (data_type.as_str(), length) {
            ("varbinary", Some(-1)) => Kind::Max,
            ("image", _) => Kind::Image,
            ("binary" | "varbinary", Some(size)) => Kind::Sized(size.max(0) as u64),
            ("timestamp" | "rowversion", _) => Kind::Sized(8),
            _ => return Err(not_binary(&cell.column)),
        };
        let (condition, keys) = key_condition(client, &schema, &table, &cell.pk, first).await?;
        Ok(Self {
            table: qualified(&inner.database, &schema, &table),
            column: quote_ident(&cell.column),
            kind,
            data_type,
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
        inline_params(sql, &values, Dialect::Mssql)
    }

    /// The key's values, after `before`.
    fn params<'a>(&'a self, before: &[&'a dyn ToSql]) -> Vec<&'a dyn ToSql> {
        before
            .iter()
            .copied()
            .chain(self.keys.iter().map(|key| key as &dyn ToSql))
            .collect()
    }
}

/// The values of a query's first row; None when it has none.
async fn first_row(
    client: &mut MsConn<'_>,
    sql: &str,
    params: &[&dyn ToSql],
) -> Result<Option<Vec<ColumnData<'static>>>, tiberius::error::Error> {
    let row = client.query(sql, params).await?.into_row().await?;
    Ok(row.map(|row| row.into_iter().collect()))
}

/// The cell's whole value, in pieces. A failure before the first piece (no
/// such row, not a binary column, NULL) is the call's error; one later ends
/// the stream with it.
pub(crate) async fn read_cell(
    inner: Arc<MssqlInner>,
    cell: &CellRef,
) -> Result<FileStream, EngineError> {
    let cell = cell.clone();
    read_stream(move |found, pieces| async move {
        let mut guard = inner.client().await?;
        let mut client = take_client(&mut guard, &inner.log)?;
        let located = Located::find(&inner, &mut client, &cell, 3).await?;
        let Located {
            table,
            column,
            condition,
            ..
        } = &located;
        // Outside a transaction the pieces come from one of its own, the
        // row's shared lock held to its end so the value can't change
        // between them; inside one, they read as its other reads do.
        let own = !inner.in_tx();
        let hint = if own { " WITH (REPEATABLEREAD)" } else { "" };
        if own {
            client.begin_transaction().await.map_err(mssql_err)?;
        }
        let outcome = async {
            // Each read says the value's size too: the first one finds out
            // whether there is a value at all.
            let read = format!(
                "SELECT DATALENGTH({column}), SUBSTRING({column}, @P1, @P2) \
                 FROM {table}{hint} WHERE {condition}"
            );
            let piece = PIECE as i64;
            let mut at = 1i64;
            let mut length = None;
            loop {
                let row = first_row(&mut client, &read, &located.params(&[&at, &piece]))
                    .await
                    .map_err(mssql_err)?
                    .ok_or_else(no_row)?;
                let size = cd_i64(row.first()).ok_or_else(null_value)?;
                if length.is_none() {
                    found.yes();
                }
                let total = *length.get_or_insert(size);
                let bytes = match row.into_iter().nth(1) {
                    Some(ColumnData::Binary(Some(bytes))) => bytes.into_owned(),
                    _ => Vec::new(),
                };
                if bytes.is_empty() {
                    break;
                }
                at += bytes.len() as i64;
                // A dropped receiver (the download stopped) ends the read.
                if !pieces.send(bytes).await || at > total {
                    break;
                }
            }
            Ok::<(), EngineError>(())
        }
        .await;
        if own {
            let _ = client.commit_transaction().await;
        }
        outcome
    })
    .await
}

/// Replaces the cell with the bytes `data` brings, as a cell edit does: in
/// the open transaction, else committed. A sized column takes the value in
/// one statement; varbinary(max) and image in pieces, the first set and the
/// rest appended, behind a savepoint inside a transaction or in one of its
/// own outside it, so a failure midway (the upload broke off, the server
/// refused) undoes it.
pub(crate) async fn write_cell(
    inner: &MssqlInner,
    cell: &CellRef,
    data: FileStream,
) -> Result<u64, EngineError> {
    let mut guard = inner.client().await?;
    let mut client = take_client(&mut guard, &inner.log)?;
    let located = Located::find(inner, &mut client, cell, 2).await?;
    let in_tx = inner.in_tx();
    let started = Instant::now();
    let Located {
        table,
        column,
        condition,
        ..
    } = &located;
    let set = format!("UPDATE {table} SET {column} = @P1 WHERE {condition}");
    let written = match located.kind {
        Kind::Sized(size) => {
            let what = format!("{}({size})", located.data_type);
            let bytes = Chunks::new(data).whole(size, &what).await?;
            write_piece(&mut client, &located, &set, bytes).await
        }
        Kind::Max | Kind::Image => append_in_steps(&mut client, &located, data, in_tx).await,
    };
    let size = match written {
        Ok(size) => size,
        Err(err) => {
            check_tx(inner, &mut client).await;
            return Err(err);
        }
    };
    // History shows the change with the size in place of the bytes.
    let change = Change {
        sql: located.shown(&set, Some(size)),
        ms: started.elapsed().as_millis() as u64,
        rows: 1,
    };
    inner.log.changed(change, in_tx);
    Ok(1)
}

/// Writes the upload into a varbinary(max) or image cell, returning its
/// size, inside a savepoint or a transaction of its own.
async fn append_in_steps(
    client: &mut MsConn<'_>,
    located: &Located,
    data: FileStream,
    in_tx: bool,
) -> Result<usize, EngineError> {
    const SAVEPOINT: &str = "tablepeek_cell";
    if in_tx {
        client
            .execute(&format!("SAVE TRANSACTION {SAVEPOINT}"), &[])
            .await
            .map_err(mssql_err)?;
    } else {
        client.begin_transaction().await.map_err(mssql_err)?;
    }
    let outcome = append_all(client, located, data).await;
    let outcome = match outcome {
        Ok(size) if !in_tx => client
            .commit_transaction()
            .await
            .map(|()| size)
            .map_err(mssql_err),
        other => other,
    };
    if outcome.is_err() {
        // A transaction the server already rolled back (a doomed one) has
        // no savepoint left to go back to; check_tx notes that after.
        if in_tx {
            let _ = client
                .execute(
                    &format!("IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION {SAVEPOINT}"),
                    &[],
                )
                .await;
        } else {
            let _ = client.execute("IF @@TRANCOUNT > 0 ROLLBACK", &[]).await;
        }
    }
    outcome
}

async fn append_all(
    client: &mut MsConn<'_>,
    located: &Located,
    data: FileStream,
) -> Result<usize, EngineError> {
    let Located {
        table,
        column,
        condition,
        ..
    } = located;
    let set = format!("UPDATE {table} SET {column} = @P1 WHERE {condition}");
    let append = match located.kind {
        Kind::Image => format!(
            "UPDATE {table} SET {column} = CAST(CAST({column} AS VARBINARY(MAX)) + @P1 AS IMAGE) \
             WHERE {condition}"
        ),
        _ => format!("UPDATE {table} SET {column}.WRITE(@P1, NULL, 0) WHERE {condition}"),
    };
    let mut chunks = Chunks::new(data);
    let mut first = true;
    loop {
        let chunk = match chunks.next(append_size(chunks.taken)).await? {
            Some(chunk) => chunk,
            // An empty upload empties the cell.
            None if first => Vec::new(),
            None => break,
        };
        write_piece(client, located, if first { &set } else { &append }, chunk).await?;
        first = false;
    }
    Ok(chunks.taken as usize)
}

/// Runs `sql` with `bytes` as @P1, returning their size; an error when the
/// key finds no row.
async fn write_piece(
    client: &mut MsConn<'_>,
    located: &Located,
    sql: &str,
    bytes: Vec<u8>,
) -> Result<usize, EngineError> {
    let size = bytes.len();
    client
        .log
        .record(&located.shown(sql, Some(size)), Dialect::Mssql);
    let changed = client
        .client
        .execute(sql, &located.params(&[&bytes]))
        .await
        .map_err(mssql_err)?
        .total();
    if changed == 0 {
        return Err(no_row());
    }
    Ok(size)
}
