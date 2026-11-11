//! Database backup as an SQL file, written on the server (`/api/sql/dump*`,
//! docs/GUIDE.md#backup-and-restore). The page plans the file: the text
//! around each table's rows (its comment, CREATE TABLE, indexes, the foreign
//! keys at the end), which it writes in the engine's own SQL from the
//! structure it already reads, and each table's SELECT. The server reads
//! every row of those SELECTs as the database sends them and writes them as
//! INSERT statements (sql_literal) into a browser download: no row limit, and
//! about one batch of rows in memory however large the tables are.
//!
//! A backup goes in steps: the plan is posted and gets an id; the page starts
//! the download, which runs the reads; the page polls the progress and may
//! stop it. A failure or a stop breaks the download off, so the browser never
//! keeps a partial file as if it were whole.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use axum::Router;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tablepeek_engine::sql_log::Dialect;
use tablepeek_engine::{EngineError, QueryData};
use tablepeek_types::ApiError;
use tokio::sync::mpsc;

use super::sql_literal::{self, InsertColumn};
use super::{
    attachment, authorized, bad_request, engine_error, not_found, slot_for, unauthorized, AppState,
    ConnSlot, Holder, InflightGuard,
};

type ApiResult<T> = Result<T, (StatusCode, Json<ApiError>)>;

/// Rows read from the database at a time, as the page read them before:
/// five INSERT statements of 1000 rows.
const BATCH_ROWS: usize = 5000;
/// Text gathered before it goes out to the download.
const FLUSH_BYTES: usize = 256 * 1024;
/// The largest plan: the text of every table's structure.
const PLAN_LIMIT: usize = 64 * 1024 * 1024;
/// How long a finished backup's outcome waits for the page to read it.
const FINISHED_KEPT: Duration = Duration::from_secs(10 * 60);
/// How long a planned backup waits for its download to start.
const WAITING_KEPT: Duration = Duration::from_secs(60 * 60);

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/sql/dump",
            post(plan).layer(DefaultBodyLimit::max(PLAN_LIMIT)),
        )
        .route("/api/sql/dump/download", get(download))
        .route("/api/sql/dump/progress", get(progress))
        .route("/api/sql/dump/stop", post(stop))
}

/// What the file holds, in order: `head`, each table's `before`, its rows
/// and `after`, then `tail`. The texts are written as they are.
#[derive(Deserialize)]
struct Plan {
    filename: String,
    head: String,
    tables: Vec<PlanTable>,
    tail: String,
}

#[derive(Deserialize)]
struct PlanTable {
    name: String,
    before: String,
    /// The read whose rows are written; None for a table backed up without
    /// its data, or skipped.
    select: Option<String>,
    /// The table's name as the INSERTs write it.
    target: String,
    #[serde(default)]
    columns: Vec<PlanColumn>,
    /// One row to a statement, where VALUES takes one row (CQL, Oracle).
    #[serde(default)]
    single_row: bool,
    after: String,
}

/// A column as the INSERTs write it; the read's columns are matched to
/// these by name.
#[derive(Deserialize)]
struct PlanColumn {
    name: String,
    quoted: String,
    #[serde(default)]
    binary: bool,
    #[serde(default)]
    declared: Option<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Phase {
    /// Planned; the download hasn't been asked for yet.
    Waiting,
    Running,
    Done,
    Failed,
    Stopped,
}

impl Phase {
    fn ended(self) -> bool {
        matches!(self, Phase::Done | Phase::Failed | Phase::Stopped)
    }
}

/// What `/api/sql/dump/progress` answers.
#[derive(Serialize)]
struct Progress {
    state: Phase,
    table: Option<String>,
    tables_done: usize,
    tables: usize,
    /// Rows written of the table being written.
    rows: u64,
    /// Bytes of the file sent to the download.
    bytes: u64,
    error: Option<ApiError>,
}

struct Dump {
    /// Taken by the download that runs it (or by a Stop before it started).
    plan: Mutex<Option<Plan>>,
    progress: Mutex<Progress>,
    stop: AtomicBool,
    /// When it was planned, then when it ended.
    since: Mutex<Instant>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Dump {
    fn new(plan: Plan) -> Self {
        let tables = plan.tables.len();
        Self {
            plan: Mutex::new(Some(plan)),
            progress: Mutex::new(Progress {
                state: Phase::Waiting,
                table: None,
                tables_done: 0,
                tables,
                rows: 0,
                bytes: 0,
                error: None,
            }),
            stop: AtomicBool::new(false),
            since: Mutex::new(Instant::now()),
        }
    }

    fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    fn end(&self, state: Phase, error: Option<ApiError>) {
        let mut progress = lock(&self.progress);
        progress.state = state;
        progress.error = error;
        *lock(&self.since) = Instant::now();
    }

    /// Whether it is past keeping: ended and unread for a while, or never
    /// downloaded.
    fn stale(&self) -> bool {
        let state = lock(&self.progress).state;
        let age = lock(&self.since).elapsed();
        (state.ended() && age > FINISHED_KEPT) || (state == Phase::Waiting && age > WAITING_KEPT)
    }
}

/// A connection's backups, by id.
#[derive(Default)]
pub struct Dumps(Mutex<HashMap<String, Arc<Dump>>>);

impl Dumps {
    fn insert(&self, dump: Dump) -> String {
        let id = uuid::Uuid::new_v4().simple().to_string();
        let mut map = lock(&self.0);
        map.retain(|_, dump| !dump.stale());
        map.insert(id.clone(), Arc::new(dump));
        id
    }

    fn get(&self, id: &str) -> Option<Arc<Dump>> {
        lock(&self.0).get(id).cloned()
    }

    fn remove(&self, id: &str) {
        lock(&self.0).remove(id);
    }
}

#[derive(Deserialize)]
struct DumpParams {
    conn: Option<String>,
    #[serde(default)]
    id: String,
    /// The download link carries the token here: a link sends no headers.
    token: Option<String>,
}

async fn dump_of(state: &AppState, params: &DumpParams) -> ApiResult<(Arc<ConnSlot>, Arc<Dump>)> {
    let slot = slot_for(state, params.conn.as_deref()).await?;
    let dump = slot
        .dumps
        .get(&params.id)
        .ok_or_else(|| not_found("백업을 찾을 수 없습니다"))?;
    Ok((slot, dump))
}

/// POST /api/sql/dump: keeps the plan and answers its id.
async fn plan(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<DumpParams>,
    Json(plan): Json<Plan>,
) -> ApiResult<Json<Value>> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let slot = slot_for(&state, params.conn.as_deref()).await?;
    // Only SQL engines write SQL backups.
    slot.engine.sql_dialect().map_err(engine_error)?;
    let id = slot.dumps.insert(Dump::new(plan));
    Ok(Json(json!({ "id": id })))
}

/// GET /api/sql/dump/download: the file, written as the rows are read.
async fn download(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<DumpParams>,
) -> ApiResult<Response> {
    if !authorized(&state, &headers, params.token.as_deref()) {
        return Err(unauthorized());
    }
    let (slot, dump) = dump_of(&state, &params).await?;
    let plan = lock(&dump.plan).take().ok_or_else(|| {
        bad_request(
            "dump_taken",
            "이 백업은 이미 내려받았거나 중지했습니다. 다시 백업하세요.",
        )
    })?;
    let dialect = slot.engine.sql_dialect().map_err(engine_error)?;
    lock(&dump.progress).state = Phase::Running;
    let filename = plan.filename.clone();
    let (sender, mut receiver) = mpsc::channel::<Result<Bytes, std::io::Error>>(4);
    tokio::spawn(run(slot, dump, plan, dialect, sender));
    let stream = futures_util::stream::poll_fn(move |cx| receiver.poll_recv(cx));
    let mut response = Body::from_stream(stream).into_response();
    let reply = response.headers_mut();
    reply.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain; charset=utf-8"),
    );
    reply.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    if let Ok(disposition) = HeaderValue::from_str(&attachment(&filename)) {
        reply.insert(header::CONTENT_DISPOSITION, disposition);
    }
    Ok(response)
}

/// GET /api/sql/dump/progress. A backup that has ended is forgotten once its
/// outcome is read.
async fn progress(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<DumpParams>,
) -> ApiResult<Json<Value>> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let (slot, dump) = dump_of(&state, &params).await?;
    let (reply, ended) = {
        let progress = lock(&dump.progress);
        (json!(&*progress), progress.state.ended())
    };
    if ended {
        slot.dumps.remove(&params.id);
    }
    Ok(Json(reply))
}

/// POST /api/sql/dump/stop: stops the read running now; a backup whose
/// download hasn't started never starts.
async fn stop(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<DumpParams>,
) -> ApiResult<Json<Value>> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let (slot, dump) = dump_of(&state, &params).await?;
    dump.stop.store(true, Ordering::SeqCst);
    if lock(&dump.plan).take().is_some() {
        dump.end(Phase::Stopped, None);
    } else {
        slot.cancel_job();
    }
    Ok(Json(json!({ "ok": true })))
}

/// Writes the file to `sender` and records how it ended. A failure or a
/// stop ends the body with an error, which breaks the download off.
async fn run(
    slot: Arc<ConnSlot>,
    dump: Arc<Dump>,
    plan: Plan,
    dialect: Dialect,
    sender: mpsc::Sender<Result<Bytes, std::io::Error>>,
) {
    let mut out = Output {
        text: String::with_capacity(FLUSH_BYTES * 2),
        sender: &sender,
        dump: &dump,
    };
    let outcome = write_plan(&slot, &dump, plan, dialect, &mut out).await;
    match outcome {
        Ok(()) => dump.end(Phase::Done, None),
        Err(error) => {
            let message = error.message.clone();
            if dump.stopped() {
                dump.end(Phase::Stopped, None);
            } else {
                dump.end(Phase::Failed, Some(error));
            }
            let _ = sender.send(Err(std::io::Error::other(message))).await;
        }
    }
}

async fn write_plan(
    slot: &ConnSlot,
    dump: &Dump,
    plan: Plan,
    dialect: Dialect,
    out: &mut Output<'_>,
) -> Result<(), ApiError> {
    out.push(&plan.head).await?;
    for table in &plan.tables {
        if dump.stopped() {
            return Err(stopped());
        }
        {
            let mut progress = lock(&dump.progress);
            progress.table = Some(table.name.clone());
            progress.rows = 0;
        }
        out.push(&table.before).await?;
        if let Some(select) = &table.select {
            write_rows(slot, dump, dialect, table, select, out).await?;
        }
        out.push(&table.after).await?;
        lock(&dump.progress).tables_done += 1;
    }
    out.push(&plan.tail).await?;
    out.flush().await
}

/// Every row of `select` as INSERTs into the table. The read holds the
/// connection's session as a job's statement (only the backup's Stop
/// cancels it) while the rows are written as they come.
async fn write_rows(
    slot: &ConnSlot,
    dump: &Dump,
    dialect: Dialect,
    table: &PlanTable,
    select: &str,
    out: &mut Output<'_>,
) -> Result<(), ApiError> {
    let (rows, mut batches) = mpsc::channel::<QueryData>(2);
    let read = async move {
        let _inflight = InflightGuard::new(slot.inflight.clone());
        let result = slot
            .gated(
                Holder::Job,
                true,
                slot.engine.stream_rows(select, BATCH_ROWS, &rows),
            )
            .await;
        drop(rows);
        result
    };
    // Owns the receiving end: when it stops early (a failure, a stop) the
    // read sees its rows unwanted and ends.
    let write = async move {
        let mut columns: Option<Vec<InsertColumn>> = None;
        while let Some(batch) = batches.recv().await {
            if dump.stopped() {
                return Err(stopped());
            }
            let columns = match &mut columns {
                Some(columns) => &*columns,
                None => &*columns.insert(insert_columns(table, &batch.columns)?),
            };
            sql_literal::write_inserts(
                &mut out.text,
                dialect,
                &table.target,
                columns,
                table.single_row,
                &batch,
            );
            lock(&dump.progress).rows += batch.row_count as u64;
            out.flush_if_full().await?;
        }
        Ok(())
    };
    let (read, write): (Result<(), EngineError>, Result<(), ApiError>) = tokio::join!(read, write);
    write?;
    match read {
        Ok(()) if dump.stopped() => Err(stopped()),
        Ok(()) => Ok(()),
        Err(_) if dump.stopped() => Err(stopped()),
        Err(err) => Err(engine_error(err).1 .0),
    }
}

/// The read's columns as the INSERTs write them, in the read's order.
fn insert_columns(table: &PlanTable, names: &[String]) -> Result<Vec<InsertColumn>, ApiError> {
    names
        .iter()
        .map(|name| {
            let column = table
                .columns
                .iter()
                .find(|column| &column.name == name)
                .ok_or_else(|| {
                    ApiError::new(
                        "dump_columns_changed",
                        format!(
                            "{}의 컬럼 {name}이(가) 백업을 시작할 때 읽은 구조에 없습니다. 다시 백업하세요.",
                            table.name
                        ),
                    )
                })?;
            Ok(InsertColumn {
                quoted: column.quoted.clone(),
                binary: column.binary,
                declared: column.declared.clone(),
            })
        })
        .collect()
}

fn stopped() -> ApiError {
    ApiError::new("stopped", "백업을 중지했습니다")
}

/// The file's text on its way to the download, sent a piece at a time.
struct Output<'a> {
    text: String,
    sender: &'a mpsc::Sender<Result<Bytes, std::io::Error>>,
    dump: &'a Dump,
}

impl Output<'_> {
    async fn push(&mut self, text: &str) -> Result<(), ApiError> {
        self.text.push_str(text);
        self.flush_if_full().await
    }

    async fn flush_if_full(&mut self) -> Result<(), ApiError> {
        if self.text.len() >= FLUSH_BYTES {
            self.flush().await?;
        }
        Ok(())
    }

    async fn flush(&mut self) -> Result<(), ApiError> {
        if self.text.is_empty() {
            return Ok(());
        }
        let piece = std::mem::replace(&mut self.text, String::with_capacity(FLUSH_BYTES * 2));
        let length = piece.len() as u64;
        // The download went away: the browser cancelled it, or the page closed.
        self.sender
            .send(Ok(Bytes::from(piece)))
            .await
            .map_err(|_| ApiError::new("download_closed", "내려받기가 끊겨 백업을 멈췄습니다"))?;
        lock(&self.dump.progress).bytes += length;
        Ok(())
    }
}
