//! Restore: an SQL file's statements run on a connection, in order
//! (`/api/sql/restore*`, docs/GUIDE.md#backup-and-restore). The page uploads
//! the file once; the server decodes it, splits it as the editor splits
//! statements (sql_split, with the dialect's lexing the page sends) and runs
//! each statement as the job's while the rest of the file is still arriving:
//! no request per statement, and about one piece of the file in memory
//! however large it is.
//!
//! The statements run as written: a dump brings its own BEGIN and COMMIT (or
//! none), so by default they aren't wrapped in a transaction, and what ran
//! before a failure or a stop stays. Asked to (`transaction`), the restore
//! runs them in one transaction of its own instead: one commit at the end
//! rather than one per statement, which is what makes a dump of single-row
//! INSERTs slow, and everything since the last commit rolled back on a
//! failure or a stop. A file that opens or ends transactions itself is
//! refused at that statement. The page claims the connection for the job
//! around the upload (`/api/job`) and keeps the session settings a dump may
//! change.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Json;
use axum::routing::{get, post};
use axum::Router;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tablepeek_engine::sql_log::Dialect;
use tablepeek_engine::{controls_transaction, EngineError};
use tablepeek_types::ApiError;

use super::sql_split::{FileStatement, Lexing, StatementReader};
use super::{
    authorized, bad_request, engine_error, not_found, slot_for, unauthorized, AppState, ConnSlot,
    Holder, InflightGuard, EXEC_MAX_ROWS,
};

type ApiResult<T> = Result<T, (StatusCode, Json<ApiError>)>;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/api/sql/restore",
            post(restore).layer(DefaultBodyLimit::disable()),
        )
        .route("/api/sql/restore/progress", get(progress))
        .route("/api/sql/restore/stop", post(stop))
}

/// How far a restore has got, and whether it was asked to stop.
#[derive(Default)]
struct Restore {
    /// Its upload has arrived and runs. A Stop may come first (the page's
    /// Stop right after it started the upload): it is kept until then.
    running: AtomicBool,
    statements: AtomicU64,
    bytes: AtomicU64,
    stop: AtomicBool,
}

impl Restore {
    fn stopped(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }
}

/// A connection's running restores, by the id the page gave.
#[derive(Default)]
pub struct Restores(Mutex<HashMap<String, Arc<Restore>>>);

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

impl Restores {
    fn get(&self, id: &str) -> Option<Arc<Restore>> {
        lock(&self.0).get(id).cloned()
    }
}

/// A restore listed while it runs, and no longer once it ends however it
/// ends (the page gone midway included).
struct Running<'a> {
    restores: &'a Restores,
    id: String,
}

impl Drop for Running<'_> {
    fn drop(&mut self) {
        lock(&self.restores.0).remove(&self.id);
    }
}

#[derive(Deserialize)]
struct RestoreParams {
    conn: Option<String>,
    #[serde(default)]
    id: String,
    /// The file's encoding as picked in the window; a byte order mark wins.
    #[serde(default)]
    encoding: String,
    /// The dialect's `SqlDialect.lexing`, as JSON.
    #[serde(default)]
    lexing: String,
    /// Run the statements in one transaction the restore opens.
    #[serde(default)]
    transaction: bool,
}

/// POST /api/sql/restore: runs the uploaded file's statements and answers
/// how it went once it has.
async fn restore(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<RestoreParams>,
    body: Body,
) -> ApiResult<Json<Value>> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let id = params.id.trim();
    if id.is_empty() {
        return Err(bad_request("invalid_request", "복원 id가 필요합니다"));
    }
    let lexing: Lexing = serde_json::from_str(&params.lexing).map_err(|err| {
        bad_request(
            "invalid_request",
            format!("lexing을 읽을 수 없습니다: {err}"),
        )
    })?;
    let slot = slot_for(&state, params.conn.as_deref()).await?;
    let dialect = slot.engine.sql_dialect().map_err(engine_error)?;
    if params.transaction
        && slot
            .engine
            .capabilities()
            .map_err(engine_error)?
            .transactions
            == "none"
    {
        return Err(bad_request(
            "unsupported_capability",
            "이 데이터베이스에는 트랜잭션이 없어 한 트랜잭션으로 실행할 수 없습니다",
        ));
    }
    let restore = {
        let mut restores = lock(&slot.restores.0);
        let restore = restores.entry(id.to_string()).or_default().clone();
        if restore.running.swap(true, Ordering::SeqCst) {
            return Err(bad_request("invalid_request", "이미 실행 중인 복원입니다"));
        }
        restore
    };
    let _running = Running {
        restores: &slot.restores,
        id: id.to_string(),
    };
    let mut runner = Runner {
        slot: &slot,
        restore: &restore,
        one: params.transaction.then_some(dialect),
        leading: true,
    };
    let reader = StatementReader::new(&params.encoding, lexing);
    let mut failure = runner.run(body, reader).await.err();
    let mut rolled_back = false;
    if runner.one.is_some() {
        if failure.is_none() && !restore.stopped() {
            failure = runner.commit().await.err();
        } else {
            rolled_back = runner.roll_back().await;
        }
    }
    Ok(Json(json!({
        "statements": restore.statements.load(Ordering::SeqCst),
        "stopped": restore.stopped(),
        "rolled_back": rolled_back,
        "failure": failure,
    })))
}

/// Why a restore ended early: a statement that failed (its number from 1,
/// and its line), the file that couldn't be read, or the closing commit.
#[derive(Serialize)]
struct Failure {
    stage: Stage,
    error: ApiError,
    statement: Option<u64>,
    line: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum Stage {
    Statement,
    Read,
    Commit,
}

/// Runs a restore's statements.
struct Runner<'a> {
    slot: &'a ConnSlot,
    restore: &'a Restore,
    /// Some (the connection's dialect): in one transaction the restore opens.
    one: Option<Dialect>,
    /// Still at the file's leading PRAGMAs, which run before that transaction
    /// opens: SQLite ignores `PRAGMA foreign_keys` inside one, and a dump
    /// turns the checks off that way before its rows.
    leading: bool,
}

impl Runner<'_> {
    /// Runs the statements as the body brings them. Ok also when stopped:
    /// stopping isn't a failure.
    async fn run(&mut self, body: Body, mut reader: StatementReader) -> Result<(), Failure> {
        let mut data = body.into_data_stream();
        while let Some(piece) = data.next().await {
            let piece = piece.map_err(|err| Failure {
                stage: Stage::Read,
                error: ApiError::new(
                    "read_failed",
                    format!("파일을 끝까지 받지 못했습니다: {err}"),
                ),
                statement: None,
                line: None,
            })?;
            if !self.run_statements(reader.push(&piece)).await? {
                return Ok(());
            }
        }
        self.run_statements(reader.finish()).await?;
        Ok(())
    }

    /// Runs `statements` in order; false once stopped.
    async fn run_statements(&mut self, statements: Vec<FileStatement>) -> Result<bool, Failure> {
        let (slot, restore) = (self.slot, self.restore);
        for statement in statements {
            if restore.stopped() {
                return Ok(false);
            }
            let failed = |error: ApiError| Failure {
                stage: Stage::Statement,
                error,
                statement: Some(restore.statements.load(Ordering::SeqCst) + 1),
                line: Some(statement.line),
            };
            if self
                .one
                .is_some_and(|dialect| controls_transaction(&statement.text, dialect))
            {
                return Err(failed(ApiError::new(
                    "restore_transaction_statement",
                    "파일에 트랜잭션을 여닫는 문장(BEGIN·COMMIT 등)이 있어 한 트랜잭션으로 실행할 수 없습니다. 이 옵션을 끄고 다시 실행하세요.",
                )));
            }
            self.leading =
                self.leading && first_word(&statement.text).eq_ignore_ascii_case("PRAGMA");
            // A MySQL or Oracle DDL statement commits the transaction before
            // it runs, so one is opened again before the next statement.
            let in_one = self.one.is_some() && !self.leading;
            let outcome = {
                let _inflight = InflightGuard::new(slot.inflight.clone());
                slot.gated(Holder::Job, true, async {
                    if in_one && !slot.engine.in_tx().await? {
                        slot.engine.begin_tx().await?;
                    }
                    slot.engine.query(&statement.text, EXEC_MAX_ROWS).await
                })
                .await
            };
            match outcome {
                Ok(_) => {
                    restore.statements.fetch_add(1, Ordering::SeqCst);
                    restore.bytes.store(statement.bytes_read, Ordering::SeqCst);
                }
                // Stop cancelled the statement in flight: it failed because it
                // was stopped.
                Err(_) if restore.stopped() => return Ok(false),
                Err(err) => return Err(failed(engine_error(err).1 .0)),
            }
        }
        Ok(true)
    }

    /// Commits the restore's transaction, if one is open.
    async fn commit(&self) -> Result<(), Failure> {
        self.end(true).await.map_err(|err| Failure {
            stage: Stage::Commit,
            error: engine_error(err).1 .0,
            statement: None,
            line: None,
        })
    }

    /// Rolls back what ran since the transaction last committed; whether no
    /// transaction is left open after (a server that already ended it, as
    /// SQL Server does when a stop kills the statement, counts).
    async fn roll_back(&self) -> bool {
        let _ = self.end(false).await;
        !self.slot.engine.in_tx().await.unwrap_or(true)
    }

    async fn end(&self, commit: bool) -> Result<(), EngineError> {
        let engine = &self.slot.engine;
        let _inflight = InflightGuard::new(self.slot.inflight.clone());
        self.slot
            .gated(Holder::Job, true, async {
                if !engine.in_tx().await? {
                    return Ok(());
                }
                if commit {
                    engine.commit_tx().await
                } else {
                    engine.rollback_tx().await
                }
            })
            .await
    }
}

/// A statement's first word, past the comments before it.
fn first_word(sql: &str) -> &str {
    let mut rest = sql.trim_start();
    loop {
        if let Some(after) = rest.strip_prefix("--") {
            rest = after
                .split_once('\n')
                .map_or("", |(_, next)| next)
                .trim_start();
        } else if let Some(after) = rest.strip_prefix("/*") {
            rest = after
                .split_once("*/")
                .map_or("", |(_, next)| next)
                .trim_start();
        } else {
            break;
        }
    }
    let end = rest
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .unwrap_or(rest.len());
    &rest[..end]
}

#[derive(Deserialize)]
struct RestoreRef {
    conn: Option<String>,
    #[serde(default)]
    id: String,
}

/// GET /api/sql/restore/progress: statements run and file bytes read.
async fn progress(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<RestoreRef>,
) -> ApiResult<Json<Value>> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let slot = slot_for(&state, params.conn.as_deref()).await?;
    let restore = slot
        .restores
        .get(&params.id)
        .ok_or_else(|| not_found("실행 중인 복원이 없습니다"))?;
    Ok(Json(json!({
        "statements": restore.statements.load(Ordering::SeqCst),
        "bytes": restore.bytes.load(Ordering::SeqCst),
    })))
}

/// POST /api/sql/restore/stop: no statement starts after this one, which is
/// cancelled if it is still running. A Stop for a restore whose upload
/// hasn't arrived yet waits for it, which then runs nothing.
async fn stop(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<RestoreRef>,
) -> ApiResult<Json<Value>> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let id = params.id.trim();
    if id.is_empty() {
        return Err(bad_request("invalid_request", "복원 id가 필요합니다"));
    }
    let slot = slot_for(&state, params.conn.as_deref()).await?;
    let restore = lock(&slot.restores.0)
        .entry(id.to_string())
        .or_default()
        .clone();
    restore.stop.store(true, Ordering::SeqCst);
    if restore.running.load(Ordering::SeqCst) {
        slot.cancel_job();
    }
    Ok(Json(json!({ "ok": true })))
}
