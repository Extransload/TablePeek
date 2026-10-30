//! A binary cell (BLOB, RAW, LONG RAW) read whole and replaced whole, past
//! the 16 KiB the grid shows of one (`capabilities.binary_cells`). Both run
//! as one call on the page's session, so they see and join its open
//! transaction; the bytes travel between that call and the request through
//! a channel, a piece at a time, so a value of any size never sits whole in
//! memory: a BLOB is read and written through its locator.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use std::time::Instant;

use futures_util::StreamExt;
use tablepeek_types::CellRef;
use tokio::sync::{mpsc, oneshot};

use super::catalog::{quote, split_name};
use super::edit::{check_key, column_types, key_condition, target_of};
use super::session::{ora_err, Ctx, OracleInner};
use super::values::{Binds, Bound, Target};
use crate::driver::FileStream;
use crate::sql_log::{Change, Dialect};
use crate::EngineError;

/// How much of a BLOB one round trip reads or writes.
const PIECE: usize = 1 << 20;

/// A binary cell found: its column's type and how to name its row.
struct Located {
    target: Target,
    types: HashMap<String, Target>,
    table_ref: String,
}

impl Located {
    /// Looks the cell's table and column up; an error unless the column
    /// holds bytes and the key is the table's primary key now.
    fn find(
        ctx: &Ctx<'_>,
        owner: &str,
        table: &str,
        cell: &CellRef,
    ) -> Result<Located, EngineError> {
        if cell.pk.is_empty() {
            return Err(EngineError::NotEditable(
                "기본 키가 없어 행을 찾을 수 없습니다".into(),
            ));
        }
        let types = column_types(ctx, owner, table)?;
        let target = target_of(&types, &cell.column)?;
        if !matches!(target, Target::Blob | Target::Binary) {
            return Err(EngineError::BadRequest(format!(
                "바이너리 컬럼이 아닙니다: {}",
                cell.column
            )));
        }
        check_key(ctx, owner, table, &cell.pk)?;
        Ok(Located {
            target,
            types,
            table_ref: format!("{}.{}", quote(owner), quote(table)),
        })
    }

    /// `SELECT "C" FROM … WHERE <key>`, its binds pushed onto `binds`.
    fn select(&self, cell: &CellRef, binds: &mut Binds) -> Result<String, EngineError> {
        Ok(format!(
            "SELECT {} FROM {} WHERE {}",
            quote(&cell.column),
            self.table_ref,
            key_condition(&self.types, &cell.pk, binds)?
        ))
    }
}

/// The one row `sql` names, a BLOB in it as its locator; an error when the
/// key finds none.
fn the_row(ctx: &Ctx<'_>, sql: &str, binds: &Binds) -> Result<oracledb::Row, EngineError> {
    let params: Vec<&dyn oracledb::ToDbValue> = binds.values.iter().map(Bound::as_param).collect();
    let shown: Vec<_> = binds.values.iter().map(Bound::log_param).collect();
    ctx.log.record(&Ctx::shown(sql, &shown), Dialect::Oracle);
    let statement = ctx
        .conn
        .statement(sql)
        .map_err(|err| ora_err(err, Some(sql)))?
        .fetch_lobs()
        .build()
        .map_err(|err| ora_err(err, Some(sql)))?;
    statement
        .query(&params)
        .map_err(|err| ora_err(err, Some(sql)))?
        .next()
        .transpose()
        .map_err(|err| ora_err(err, Some(sql)))?
        .ok_or_else(|| {
            EngineError::NotFound(
                "이 키의 행이 없습니다. 다른 곳에서 지워졌거나 키가 바뀌었습니다".into(),
            )
        })
}

/// Runs a change `sql` with `binds`; an error when the key finds no row.
fn change_row(ctx: &Ctx<'_>, sql: &str, binds: &Binds) -> Result<(), EngineError> {
    let params: Vec<&dyn oracledb::ToDbValue> = binds.values.iter().map(Bound::as_param).collect();
    let shown: Vec<_> = binds.values.iter().map(Bound::log_param).collect();
    let done = ctx
        .execute(sql, &params, &shown)
        .map_err(|err| ora_err(err, Some(sql)))?;
    if done.rows_affected() == 0 {
        return Err(EngineError::NotFound(
            "이 키의 행이 없습니다. 다른 곳에서 지워졌거나 키가 바뀌었습니다".into(),
        ));
    }
    Ok(())
}

/// The cell's whole value, in pieces. A failure before the first piece (no
/// such row, not a binary column, NULL) is the call's error; one later ends
/// the stream with it.
pub(super) async fn read_cell(
    inner: Arc<OracleInner>,
    cell: &CellRef,
) -> Result<FileStream, EngineError> {
    let (owner, table) = split_name(&inner.schema(), &cell.table);
    let cell = cell.clone();
    let (started, ready) = oneshot::channel::<Result<(), EngineError>>();
    let (pieces, received) = mpsc::channel::<Result<Vec<u8>, EngineError>>(2);
    // Whichever comes first answers: the call's look-up, or a failure to
    // run it at all (no session).
    let started = Arc::new(std::sync::Mutex::new(Some(started)));
    let answer = move |started: &std::sync::Mutex<Option<oneshot::Sender<_>>>, outcome| {
        if let Some(started) = started
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            let _ = started.send(outcome);
        }
    };
    tokio::spawn(async move {
        let call_started = started.clone();
        let ran = inner
            .run(move |ctx| {
                let started = call_started;
                let found = (|| {
                    let located = Located::find(ctx, &owner, &table, &cell)?;
                    let mut binds = Binds::default();
                    let sql = located.select(&cell, &mut binds)?;
                    let mut row = the_row(ctx, &sql, &binds)?;
                    let target = located.target;
                    let null = || EngineError::BadRequest("값이 NULL입니다".into());
                    Ok(match target {
                        Target::Blob => Source::Lob(
                            row.take::<Option<oracledb::Lob>>(0)
                                .map_err(|err| ora_err(err, None))?
                                .ok_or_else(null)?,
                        ),
                        _ => Source::Bytes(
                            row.get::<Option<Vec<u8>>>(0)
                                .map_err(|err| ora_err(err, None))?
                                .ok_or_else(null)?,
                        ),
                    })
                })();
                let source = match found {
                    Ok(source) => source,
                    Err(err) => {
                        answer(&started, Err(err));
                        return Ok(());
                    }
                };
                answer(&started, Ok(()));
                // A dropped receiver (the download stopped) ends the read.
                match source {
                    Source::Bytes(bytes) => {
                        for piece in bytes.chunks(PIECE) {
                            if pieces.blocking_send(Ok(piece.to_vec())).is_err() {
                                break;
                            }
                        }
                    }
                    Source::Lob(mut lob) => {
                        let mut buffer = vec![0; PIECE];
                        loop {
                            match lob.read(&mut buffer) {
                                Ok(0) => break,
                                Ok(read) => {
                                    if pieces.blocking_send(Ok(buffer[..read].to_vec())).is_err() {
                                        break;
                                    }
                                }
                                Err(err) => {
                                    let err = ora_err(oracledb::Error::from(err), None);
                                    let _ = pieces.blocking_send(Err(err));
                                    break;
                                }
                            }
                        }
                    }
                }
                Ok(())
            })
            .await;
        if let Err(err) = ran {
            answer(&started, Err(err));
        }
    });
    match ready.await {
        Ok(Ok(())) => {}
        Ok(Err(err)) => return Err(err),
        Err(_) => {
            return Err(EngineError::Internal(
                "바이너리 값을 읽지 못했습니다".into(),
            ))
        }
    }
    Ok(Box::pin(futures_util::stream::unfold(
        received,
        |mut received| async move { received.recv().await.map(|piece| (piece, received)) },
    )))
}

/// Where a cell's bytes come from: a BLOB's locator, or a RAW's value.
enum Source {
    Lob(oracledb::Lob),
    Bytes(Vec<u8>),
}

/// Replaces the cell with the bytes `data` brings. A BLOB is emptied and
/// filled through its locator a piece at a time; RAW takes the value whole
/// (its size is bounded by the column). The change joins the open
/// transaction, else is committed; a failure midway (the upload broke off,
/// the server refused) undoes it, to a savepoint inside a transaction.
pub(super) async fn write_cell(
    inner: &OracleInner,
    cell: &CellRef,
    mut data: FileStream,
) -> Result<u64, EngineError> {
    let (owner, table) = split_name(&inner.schema(), &cell.table);
    let cell = cell.clone();
    let in_tx = inner.in_tx();
    let (pieces, mut received) = mpsc::channel::<Result<Vec<u8>, EngineError>>(2);
    // The request's body goes to the session's call as it arrives.
    let pump = tokio::spawn(async move {
        while let Some(piece) = data.next().await {
            if pieces.send(piece).await.is_err() {
                break;
            }
        }
    });
    let written = inner
        .run(move |ctx| {
            let started = Instant::now();
            let located = Located::find(ctx, &owner, &table, &cell)?;
            let column = quote(&cell.column);
            let undo_to = if in_tx {
                ctx.execute("SAVEPOINT tablepeek_cell", &[], &[])
                    .map_err(|err| ora_err(err, None))?;
                "ROLLBACK TO SAVEPOINT tablepeek_cell"
            } else {
                "ROLLBACK"
            };
            let outcome = (|| -> Result<u64, EngineError> {
                if located.target == Target::Blob {
                    // Emptied, then filled through the row's own locator (the
                    // UPDATE holds the row's lock), a piece per round trip.
                    let mut binds = Binds::default();
                    let condition = key_condition(&located.types, &cell.pk, &mut binds)?;
                    let empty = format!(
                        "UPDATE {} SET {column} = EMPTY_BLOB() WHERE {condition}",
                        located.table_ref
                    );
                    change_row(ctx, &empty, &binds)?;
                    let mut binds = Binds::default();
                    let select = located.select(&cell, &mut binds)?;
                    let mut lob = the_row(ctx, &select, &binds)?
                        .take::<Option<oracledb::Lob>>(0)
                        .map_err(|err| ora_err(err, None))?
                        .ok_or_else(|| EngineError::Internal("빈 BLOB을 읽지 못했습니다".into()))?;
                    let mut buffer = Vec::with_capacity(PIECE);
                    let mut size = 0u64;
                    loop {
                        let piece = received.blocking_recv().transpose()?;
                        if let Some(piece) = &piece {
                            buffer.extend_from_slice(piece);
                        }
                        if buffer.len() >= PIECE || (piece.is_none() && !buffer.is_empty()) {
                            lob.write_all(&buffer)
                                .map_err(|err| ora_err(oracledb::Error::from(err), None))?;
                            size += buffer.len() as u64;
                            buffer.clear();
                        }
                        if piece.is_none() {
                            return Ok(size);
                        }
                    }
                }
                // RAW and LONG RAW take the value as one bind.
                let mut bytes = Vec::new();
                while let Some(piece) = received.blocking_recv() {
                    bytes.extend_from_slice(&piece?);
                }
                let size = bytes.len() as u64;
                let mut binds = Binds::default();
                binds.values.push(Bound::Bytes(Some(bytes)));
                let condition = key_condition(&located.types, &cell.pk, &mut binds)?;
                let update = format!(
                    "UPDATE {} SET {column} = :1 WHERE {condition}",
                    located.table_ref
                );
                change_row(ctx, &update, &binds)?;
                Ok(size)
            })();
            let size = match outcome {
                Ok(size) => size,
                Err(err) => {
                    ctx.log.record(undo_to, Dialect::Oracle);
                    let _ = ctx.conn.execute(undo_to, &[]);
                    return Err(err);
                }
            };
            if !in_tx {
                ctx.autocommit().map_err(|err| ora_err(err, None))?;
            }
            // History shows the change with the size in place of the bytes.
            let mut binds = Binds::default();
            let condition = key_condition(&located.types, &cell.pk, &mut binds)?;
            let shown_params: Vec<_> = binds.values.iter().map(Bound::log_param).collect();
            let shown = Ctx::shown(
                &format!(
                    "UPDATE {} SET {column} = /* {size} bytes */ WHERE {condition}",
                    located.table_ref
                ),
                &shown_params,
            );
            ctx.log.changed(
                Change {
                    sql: shown,
                    ms: started.elapsed().as_millis() as u64,
                    rows: 1,
                },
                in_tx,
            );
            Ok(1)
        })
        .await;
    pump.abort();
    written
}
