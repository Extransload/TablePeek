//! A SQLite blob read whole and replaced whole, past the 16 KiB the grid
//! shows of one (`capabilities.binary_cells`), on the connection, so inside
//! its open transaction. A table with rowids goes through SQLite's
//! incremental blob I/O, a piece at a time both ways; the upload is first
//! kept in a temporary file, since the blob is sized before it is written.
//! A table without rowids reads with substr() and writes the value whole.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use futures_util::StreamExt;
use rusqlite::{DatabaseName, OptionalExtension};
use tablepeek_types::CellRef;
use tokio::sync::mpsc;

use crate::cells::{no_key, no_row, not_binary, null_value, read_stream, Found, Pieces, PIECE};
use crate::driver::FileStream;
use crate::sql_log::{inline_params, Change, Dialect, LogParam};
use crate::{
    lock_conn, quote_ident, sqlite_blob_column, sqlite_key, sqlite_params, sqlite_refs,
    EngineError, SqliteConn, SqliteInner,
};

/// Where a cell is: the WHERE condition naming its row, with its values.
struct Located {
    table: String,
    column: String,
    condition: String,
    keys: Vec<rusqlite::types::Value>,
}

impl Located {
    fn find(conn: &SqliteConn<'_>, cell: &CellRef) -> Result<Self, EngineError> {
        if cell.pk.is_empty() {
            return Err(no_key());
        }
        let mut condition = String::new();
        let mut keys = Vec::with_capacity(cell.pk.len());
        for (index, key) in cell.pk.iter().enumerate() {
            if index > 0 {
                condition.push_str(" AND ");
            }
            keys.push(sqlite_key(conn, &cell.table, key)?);
            condition.push_str(&format!("{} = ?{}", quote_ident(&key.column), keys.len()));
        }
        Ok(Self {
            table: quote_ident(&cell.table),
            column: quote_ident(&cell.column),
            condition,
            keys,
        })
    }

    /// The row's rowid, or None for a table without rowids (`name`).
    fn rowid(&self, conn: &SqliteConn<'_>, name: &str) -> Result<Option<i64>, EngineError> {
        let without_rowid = conn
            .query_row(
                "SELECT wr FROM pragma_table_list(?1)",
                &[&name as &dyn rusqlite::ToSql],
                |row| row.get::<_, bool>(0),
            )
            .optional()?
            .unwrap_or(false);
        if without_rowid {
            return Ok(None);
        }
        let Located {
            table, condition, ..
        } = self;
        conn.query_row(
            &format!("SELECT _rowid_ FROM {table} WHERE {condition}"),
            &sqlite_refs(&self.keys),
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .map(Some)
        .ok_or_else(no_row)
    }

    /// `sql` as the console shows it: `bytes` (a size) in front of the key.
    fn shown(&self, sql: &str, bytes: Option<usize>) -> String {
        let mut values = Vec::with_capacity(self.keys.len() + 1);
        values.extend(sqlite_params(&sqlite_refs(&self.keys)));
        if let Some(bytes) = bytes {
            values.push(LogParam::Literal(format!("/* {bytes} bytes */")));
        }
        inline_params(sql, &values, Dialect::Sqlite)
    }
}

/// Refuses a cell that holds no bytes: a column not declared binary, unless
/// what it holds now is a blob, and NULL. Its type now (`typeof`).
fn check_cell(
    conn: &SqliteConn<'_>,
    cell: &CellRef,
    located: &Located,
) -> Result<String, EngineError> {
    let Located {
        table,
        column,
        condition,
        ..
    } = located;
    let held: String = conn
        .query_row(
            &format!("SELECT typeof({column}) FROM {table} WHERE {condition}"),
            &sqlite_refs(&located.keys),
            |row| row.get(0),
        )
        .optional()?
        .ok_or_else(no_row)?;
    if held != "blob" && !sqlite_blob_column(conn, &cell.table, &cell.column)? {
        return Err(not_binary(&cell.column));
    }
    Ok(held)
}

/// The cell's whole value, in pieces. A failure before the first piece (no
/// such row, not a binary column, NULL) is the call's error; one later ends
/// the stream with it.
pub(crate) async fn read_cell(
    inner: Arc<SqliteInner>,
    cell: &CellRef,
) -> Result<FileStream, EngineError> {
    let cell = cell.clone();
    read_stream(move |found, pieces| async move {
        tokio::task::spawn_blocking(move || read_sync(&inner, &cell, &found, &pieces))
            .await
            .map_err(|err| EngineError::Internal(err.to_string()))?
    })
    .await
}

fn read_sync(
    inner: &SqliteInner,
    cell: &CellRef,
    found: &Found,
    pieces: &Pieces,
) -> Result<(), EngineError> {
    let conn = lock_conn(inner)?;
    let located = Located::find(&conn, cell)?;
    // Outside a transaction the pieces come from a read transaction of
    // their own, so the value can't change between them.
    let own = conn.is_autocommit();
    if own {
        conn.execute_batch("BEGIN")?;
    }
    let outcome = read_pieces(&conn, cell, &located, found, pieces);
    if own {
        let _ = conn.execute_batch("COMMIT");
    }
    outcome
}

fn read_pieces(
    conn: &SqliteConn<'_>,
    cell: &CellRef,
    located: &Located,
    found: &Found,
    pieces: &Pieces,
) -> Result<(), EngineError> {
    let held = check_cell(conn, cell, located)?;
    if held == "null" {
        return Err(null_value());
    }
    let rowid = if held == "blob" {
        located.rowid(conn, &cell.table)?
    } else {
        None
    };
    found.yes();
    if let Some(rowid) = rowid {
        let blob = conn.blob_open(&cell.table, &cell.column, rowid, true)?;
        let mut blob = std::io::BufReader::with_capacity(PIECE, blob);
        loop {
            let mut piece = vec![0; PIECE];
            let read = blob
                .read(&mut piece)
                .map_err(|err| EngineError::Internal(err.to_string()))?;
            if read == 0 {
                return Ok(());
            }
            piece.truncate(read);
            // A dropped receiver (the download stopped) ends the read.
            if !pieces.blocking_send(piece) {
                return Ok(());
            }
        }
    }
    // Text, or a table without rowids: as bytes, a substr() at a time.
    let Located {
        table,
        column,
        condition,
        keys,
    } = located;
    let first = keys.len() + 1;
    let sql = format!(
        "SELECT substr(CAST({column} AS BLOB), ?{first}, {PIECE}) FROM {table} WHERE {condition}"
    );
    let mut at = 1i64;
    loop {
        let mut params = keys.clone();
        params.push(rusqlite::types::Value::Integer(at));
        let piece: Option<Vec<u8>> = conn
            .query_row(&sql, &sqlite_refs(&params), |row| row.get(0))
            .optional()?
            .ok_or_else(no_row)?;
        let piece = piece.unwrap_or_default();
        if piece.is_empty() || !pieces.blocking_send(piece.clone()) {
            return Ok(());
        }
        at += piece.len() as i64;
    }
}

/// The upload, kept in a file of its own until written, removed after.
struct Spool {
    path: PathBuf,
    file: File,
}

impl Spool {
    fn create() -> Result<Self, EngineError> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or_default();
        let path =
            std::env::temp_dir().join(format!("tablepeek-cell-{}-{nanos}", std::process::id()));
        let file = File::options()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(spool_err)?;
        Ok(Self { path, file })
    }
}

impl Drop for Spool {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

fn spool_err(err: std::io::Error) -> EngineError {
    EngineError::Internal(format!("업로드를 임시 파일에 담지 못했습니다: {err}"))
}

/// Replaces the cell with the bytes `data` brings, as a cell edit does: in
/// the open transaction, behind a savepoint, else in one of its own,
/// committed at the end; a failure midway undoes it. The upload is kept
/// whole first, so one that breaks off never reaches the database.
pub(crate) async fn write_cell(
    inner: Arc<SqliteInner>,
    cell: &CellRef,
    mut data: FileStream,
) -> Result<u64, EngineError> {
    let cell = cell.clone();
    let (sender, mut received) = mpsc::channel::<Result<Vec<u8>, EngineError>>(2);
    // The request's body goes to the blocking side as it arrives.
    let pump = tokio::spawn(async move {
        while let Some(piece) = data.next().await {
            if sender.send(piece).await.is_err() {
                break;
            }
        }
    });
    let written = tokio::task::spawn_blocking(move || {
        let mut spool = Spool::create()?;
        let mut size = 0u64;
        while let Some(piece) = received.blocking_recv() {
            let piece = piece?;
            spool.file.write_all(&piece).map_err(spool_err)?;
            size += piece.len() as u64;
        }
        write_sync(&inner, &cell, &mut spool, size)
    })
    .await
    .map_err(|err| EngineError::Internal(err.to_string()));
    pump.abort();
    written?
}

fn write_sync(
    inner: &SqliteInner,
    cell: &CellRef,
    spool: &mut Spool,
    size: u64,
) -> Result<u64, EngineError> {
    let conn = lock_conn(inner)?;
    let located = Located::find(&conn, cell)?;
    check_cell(&conn, cell, &located)?;
    let in_tx = !conn.is_autocommit();
    let (open, undo, keep) = if in_tx {
        (
            "SAVEPOINT tablepeek_cell",
            "ROLLBACK TO tablepeek_cell; RELEASE tablepeek_cell",
            "RELEASE tablepeek_cell",
        )
    } else {
        ("BEGIN", "ROLLBACK", "COMMIT")
    };
    let started = Instant::now();
    conn.execute_batch(open)?;
    let outcome = write_value(&conn, cell, &located, spool, size)
        .and_then(|()| conn.execute_batch(keep).map_err(EngineError::from));
    if let Err(err) = outcome {
        let _ = conn.execute_batch(undo);
        return Err(err);
    }
    // History shows the change with the size in place of the bytes.
    let Located {
        table,
        column,
        condition,
        keys,
    } = &located;
    let at = keys.len() + 1;
    let change = Change {
        sql: located.shown(
            &format!("UPDATE {table} SET {column} = ?{at} WHERE {condition}"),
            Some(size as usize),
        ),
        ms: started.elapsed().as_millis() as u64,
        rows: 1,
    };
    conn.log.changed(change, in_tx);
    Ok(1)
}

/// Writes the spooled upload into the cell: through the blob's handle, a
/// piece at a time, when the table has rowids; else as one value.
fn write_value(
    conn: &SqliteConn<'_>,
    cell: &CellRef,
    located: &Located,
    spool: &mut Spool,
    size: u64,
) -> Result<(), EngineError> {
    let Located {
        table,
        column,
        condition,
        keys,
    } = located;
    let at = keys.len() + 1;
    let rowid = located.rowid(conn, &cell.table)?;
    spool.file.seek(SeekFrom::Start(0)).map_err(spool_err)?;
    let (sql, value) = match rowid {
        Some(_) => (
            format!("UPDATE {table} SET {column} = zeroblob(?{at}) WHERE {condition}"),
            rusqlite::types::Value::Integer(i64::try_from(size).unwrap_or(i64::MAX)),
        ),
        None => {
            let mut bytes = Vec::with_capacity(usize::try_from(size).unwrap_or_default());
            spool.file.read_to_end(&mut bytes).map_err(spool_err)?;
            (
                format!("UPDATE {table} SET {column} = ?{at} WHERE {condition}"),
                rusqlite::types::Value::Blob(bytes),
            )
        }
    };
    let mut params = keys.clone();
    params.push(value);
    conn.log
        .record(&located.shown(&sql, Some(size as usize)), Dialect::Sqlite);
    if conn.conn.execute(&sql, &*sqlite_refs(&params))? == 0 {
        return Err(no_row());
    }
    let Some(rowid) = rowid else {
        return Ok(());
    };
    let mut blob = conn.blob_open(&cell.table, &cell.column, rowid, false)?;
    let mut piece = vec![0; PIECE];
    loop {
        let read = spool.file.read(&mut piece).map_err(spool_err)?;
        if read == 0 {
            return Ok(());
        }
        blob.write_all(&piece[..read])
            .map_err(|err| EngineError::Internal(err.to_string()))?;
    }
}

impl SqliteConn<'_> {
    /// A blob opened for incremental I/O in the main database: not SQL, so
    /// nothing goes to the console.
    fn blob_open(
        &self,
        table: &str,
        column: &str,
        rowid: i64,
        read_only: bool,
    ) -> rusqlite::Result<rusqlite::blob::Blob<'_>> {
        self.conn
            .blob_open(DatabaseName::Main, table, column, rowid, read_only)
    }
}
