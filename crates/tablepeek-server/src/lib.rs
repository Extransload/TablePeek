use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Json, Response};
use axum::routing::{delete, get, post, put};
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use rust_embed::RustEmbed;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tablepeek_engine::driver;
use tablepeek_engine::engines::mongodb::oidc;
use tablepeek_engine::registry::{self, NetRoute, TunnelTarget};
use tablepeek_engine::sql_log::{Change, LogEntry};
use tablepeek_engine::{Engine, EngineError, QueryData};
use tablepeek_types::{
    ApiError, ConnConfig, ConnectRequest, DbObjects, EditTarget, EngineMeta, ErrorFields, FsEntry,
    FsListing, InsertValue, ObjectDefinition, PkValue, QueryResult, ServerInfo, TableDetail,
    TableSchema, ValueExpr,
};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{broadcast, mpsc};

pub mod cursors;
pub mod picker;
mod search;
pub mod store;
pub mod transfer;
pub mod tunnel;
pub mod update;

#[derive(RustEmbed)]
#[folder = "$CARGO_MANIFEST_DIR/../../web/dist"]
struct Assets;

pub const SESSION_CAP: usize = 8;
// Results a job (an export page) is still reading: kept apart from the page's
// own, which they'd otherwise push out, until the job releases them.
pub const JOB_SESSION_CAP: usize = 4;
// How long a statement waits for a cancel meant for the statement before it
// to land, at most.
const CANCEL_SETTLE: std::time::Duration = std::time::Duration::from_secs(2);
// A job's transaction counts as the job's this long after its last statement.
const JOB_LEASE: std::time::Duration = std::time::Duration::from_secs(60);
// The refusal a write or a transaction command meets while a job holds the
// session (the page shows it in the UI language).
const JOB_BUSY: &str = "가져오기가 진행 중입니다. 끝난 뒤 다시 실행하세요.";

pub struct QuerySession {
    pub data: QueryData,
    pub journal: Vec<JournalEntry>,
}

impl QuerySession {
    pub fn new(data: QueryData) -> Self {
        Self {
            data,
            journal: Vec::new(),
        }
    }
}

#[derive(Clone)]
pub enum JournalEntry {
    Cell {
        row: usize,
        col: usize,
        old: Option<String>,
    },
    Structural,
}

pub struct SessionStore {
    map: HashMap<String, Arc<tokio::sync::Mutex<QuerySession>>>,
    order: VecDeque<String>,
    cap: usize,
    job_order: VecDeque<String>,
    structural: bool,
}

impl SessionStore {
    pub fn new(cap: usize) -> Self {
        Self {
            map: HashMap::new(),
            order: VecDeque::new(),
            cap,
            job_order: VecDeque::new(),
            structural: false,
        }
    }

    /// A job's result, counted apart: however many pages an export reads,
    /// the page's own results stay. A job that never releases its result
    /// loses it to its next ones.
    pub fn insert_job(&mut self, id: String, data: Arc<QueryData>) {
        self.job_order.retain(|existing| existing != &id);
        self.job_order.push_back(id.clone());
        let session = Arc::new(tokio::sync::Mutex::new(QuerySession::new((*data).clone())));
        self.map.insert(id, session);
        while self.job_order.len() > JOB_SESSION_CAP {
            if let Some(old) = self.job_order.pop_front() {
                self.map.remove(&old);
            }
        }
    }

    /// A result its reader is done with.
    pub fn remove(&mut self, id: &str) {
        self.map.remove(id);
        self.order.retain(|existing| existing != id);
        self.job_order.retain(|existing| existing != id);
    }

    pub fn insert(&mut self, id: String, data: Arc<QueryData>) {
        if let Some(pos) = self.order.iter().position(|existing| existing == &id) {
            self.order.remove(pos);
        }
        self.order.push_back(id.clone());
        let session = Arc::new(tokio::sync::Mutex::new(QuerySession::new((*data).clone())));
        self.map.insert(id, session);
        while self.order.len() > self.cap {
            if let Some(old) = self.order.pop_front() {
                self.map.remove(&old);
            }
        }
    }

    pub fn get(&self, id: &str) -> Option<Arc<tokio::sync::Mutex<QuerySession>>> {
        self.map.get(id).cloned()
    }

    pub fn snapshot(&self) -> Vec<Arc<tokio::sync::Mutex<QuerySession>>> {
        self.map.values().cloned().collect()
    }

    pub fn clear(&mut self) {
        self.map.clear();
        self.order.clear();
        self.job_order.clear();
    }

    pub fn mark_structural(&mut self) {
        self.structural = true;
    }

    pub fn take_structural(&mut self) -> bool {
        std::mem::take(&mut self.structural)
    }

    pub fn reset_structural(&mut self) {
        self.structural = false;
    }
}

pub struct ConnSlot {
    pub id: String,
    pub label: String,
    pub saved_id: Option<String>,
    pub origin: Option<ConnectRequest>,
    pub engine: Arc<Engine>,
    pub sessions: Arc<tokio::sync::Mutex<SessionStore>>,
    pub tunnel: Arc<tokio::sync::Mutex<Option<tunnel::Route>>>,
    pub inflight: Arc<AtomicUsize>,
    // Last known meta summary, so listing connections needs no database round
    // trip (and never waits behind a long query holding the engine lock).
    summary: std::sync::Mutex<Option<SlotSummary>>,
    // One statement at a time on the session (the engine runs them one by
    // one anyway), and what kind it is: a cancel reaches only the kind it is
    // meant for.
    gate: tokio::sync::Mutex<()>,
    holder: std::sync::Mutex<Holder>,
    // The open transaction is a job's (an import's, a restore's dump's own
    // BEGIN): when a job's statement last ran in it. Who opened it decides,
    // not which command did.
    job_tx: std::sync::Mutex<Option<std::time::Instant>>,
    /// A document store's cursors the page keeps open between requests.
    pub cursors: cursors::CursorTable,
}

/// Whose statement runs on a connection's session now.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Holder {
    Idle,
    // The page's own: a newer query cancels it, as moving to another table
    // does.
    Foreground,
    // A background job's (an import's chunk, a restore's statement, an
    // export's page): only the job's own Stop cancels it.
    Job,
    // A transaction command, a grid edit or row change: never cancelled,
    // since an interrupted COMMIT or UPDATE leaves its outcome unknown.
    Protected,
}

// Sets the slot's holder back to idle when the statement ends or is dropped.
struct HolderReset<'a>(&'a ConnSlot);

impl Drop for HolderReset<'_> {
    fn drop(&mut self) {
        self.0.set_holder(Holder::Idle);
    }
}

#[derive(Clone)]
struct SlotSummary {
    kind: String,
    path: Option<String>,
    demo: bool,
    table_count: usize,
    // Engine epoch the meta was read at; a statement or DB switch since then
    // may have changed it.
    epoch: u64,
}

impl ConnSlot {
    /// Stores a summary of `meta`, read when the engine was at `epoch`.
    fn remember(&self, epoch: u64, meta: &EngineMeta) {
        let mut summary = self
            .summary
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        // A slow meta call that started before a newer one (or before a DB
        // switch) must not replace what that one stored.
        if summary.as_ref().is_some_and(|known| known.epoch > epoch) {
            return;
        }
        *summary = Some(SlotSummary {
            kind: meta.kind.clone(),
            path: meta.path.clone(),
            demo: meta.demo,
            table_count: meta.tables.len(),
            epoch,
        });
    }

    /// The stored summary if nothing has run since it was read, or, while a
    /// statement is running, the last one known rather than waiting behind it.
    fn summary(&self) -> Option<SlotSummary> {
        let summary = self
            .summary
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()?;
        let current = summary.epoch == self.engine.epoch();
        (current || self.inflight.load(Ordering::SeqCst) > 0).then_some(summary)
    }

    /// The last summary read, however old: for listing a connection whose
    /// server can't be reached now.
    fn last_summary(&self) -> Option<SlotSummary> {
        self.summary
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Reads meta and remembers it, unless the engine moved on meanwhile.
    async fn refresh_summary(&self, include_system: bool) -> Result<EngineMeta, EngineError> {
        let epoch = self.engine.epoch();
        let meta = self.engine.meta(include_system).await?;
        if !include_system {
            self.remember(epoch, &meta);
        }
        Ok(meta)
    }

    pub fn new(
        id: String,
        label: String,
        saved_id: Option<String>,
        origin: Option<ConnectRequest>,
        engine: Engine,
    ) -> Self {
        Self {
            id,
            label,
            saved_id,
            origin,
            engine: Arc::new(engine),
            sessions: Arc::new(tokio::sync::Mutex::new(SessionStore::new(SESSION_CAP))),
            tunnel: Arc::new(tokio::sync::Mutex::new(None)),
            inflight: Arc::new(AtomicUsize::new(0)),
            summary: std::sync::Mutex::new(None),
            gate: tokio::sync::Mutex::new(()),
            holder: std::sync::Mutex::new(Holder::Idle),
            job_tx: std::sync::Mutex::new(None),
            cursors: cursors::CursorTable::default(),
        }
    }

    /// What this slot's history and safe mode are filed under: its local
    /// file (SQLite's) (opened as a file or through a saved profile alike), its saved
    /// profile, the demo, or, for a server connection that was never saved,
    /// this session alone.
    fn history_scope(&self) -> String {
        // One file, one scope, however its path was spelled (relative,
        // through a symlink, with ".."), and never two files under one.
        if let Some(path) = self.engine.file() {
            let path = std::fs::canonicalize(&path).unwrap_or(path);
            return format!("file:{}", path.display());
        }
        if let Some(id) = &self.saved_id {
            return store::saved_scope(id);
        }
        if self.origin.is_some() {
            return format!("{}{}", store::SESSION_PREFIX, self.id);
        }
        "demo".to_string()
    }

    fn set_holder(&self, holder: Holder) {
        *self
            .holder
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = holder;
    }

    pub fn holder(&self) -> Holder {
        *self
            .holder
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Runs one statement through the session's gate, as `holder`; `job`:
    /// it is a background job's. Cancels already sent (for the page's
    /// previous statement) land first: PostgreSQL and MySQL cancel whatever
    /// is running when the request arrives. Whether a transaction the
    /// statement leaves open is a job's is settled here too, before the next
    /// statement can start.
    pub async fn gated<T>(
        &self,
        holder: Holder,
        job: bool,
        run: impl std::future::Future<Output = T>,
    ) -> T {
        let _gate = self.gate.lock().await;
        self.engine.cancels_settled(CANCEL_SETTLE).await;
        let before = self.engine.in_tx().await.unwrap_or(false);
        self.set_holder(holder);
        let _reset = HolderReset(self);
        let outcome = run.await;
        let after = self.engine.in_tx().await.unwrap_or(false);
        let mut owner = self
            .job_tx
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !after {
            *owner = None;
        } else if job && (!before || owner.is_some()) {
            // Opened by the job, or the job still at work in its own.
            *owner = Some(std::time::Instant::now());
        }
        outcome
    }

    /// A job's transaction is open: its statement runs now, or one ran in it
    /// lately. A job whose page went away (a reload mid-import) lets go
    /// after JOB_LEASE, so its leftover transaction can be ended from the
    /// TX controls.
    pub fn job_tx_open(&self) -> bool {
        let last = *self
            .job_tx
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        last.is_some_and(|at| self.holder() == Holder::Job || at.elapsed() < JOB_LEASE)
    }

    /// The job is done (or its page gave up on it): an open transaction it
    /// leaves is the user's now.
    pub fn end_job(&self) {
        *self
            .job_tx
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    }

    /// Cancels the page's statement running now, if one is. Not a job's,
    /// and nothing while a job's transaction is open: a cancel would abort it
    /// on PostgreSQL and end the whole session on SQL Server, so the page's
    /// statement runs to its end instead.
    fn cancel_if_inflight(&self) {
        let job_tx = self.job_tx_open();
        let holder = self
            .holder
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if *holder == Holder::Foreground && !job_tx {
            self.engine.cancel();
        }
    }

    /// A job's Stop: cancels its statement running now (an import's chunk
    /// waiting on a row lock, a long export read). Never a transaction
    /// command, an edit or the page's statement.
    fn cancel_job(&self) {
        let holder = self
            .holder
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if *holder == Holder::Job {
            self.engine.cancel();
        }
    }

    /// What a write from the page (or another tab) meets while a job's
    /// transaction is open: it would join the job's transaction, and a
    /// COMMIT or ROLLBACK would end it.
    fn refused_while_job(&self) -> Result<(), EngineError> {
        if self.job_tx_open() {
            return Err(EngineError::BadRequest(JOB_BUSY.into()));
        }
        Ok(())
    }

    /// The page's statement while a job's transaction is open: PostgreSQL
    /// would abort that transaction (the job's work with it) if the statement
    /// failed, so it runs under a savepoint of its own there. A write is
    /// refused (see refused_while_job). `page` continues an earlier read of
    /// the same statement (`QueryData::next_page`).
    async fn foreground_query(
        &self,
        sql: &str,
        max_rows: usize,
        page: Option<&str>,
    ) -> Result<QueryData, EngineError> {
        if !self.job_tx_open() {
            return self.engine.query_page(sql, max_rows, page).await;
        }
        if !tablepeek_engine::is_read_only(sql) {
            return Err(EngineError::BadRequest(JOB_BUSY.into()));
        }
        if !(self.engine.failure_aborts_transaction() && self.engine.in_tx().await.unwrap_or(false))
        {
            return self.engine.query_page(sql, max_rows, page).await;
        }
        self.engine.query("SAVEPOINT tablepeek_page", 1).await?;
        let outcome = self.engine.query_page(sql, max_rows, page).await;
        // A failure is undone back to the savepoint, which then goes too.
        let usable = outcome.is_ok()
            || self
                .engine
                .query("ROLLBACK TO SAVEPOINT tablepeek_page", 1)
                .await
                .is_ok();
        if usable {
            let _ = self
                .engine
                .query("RELEASE SAVEPOINT tablepeek_page", 1)
                .await;
        }
        outcome
    }
}

#[derive(Default)]
pub struct Registry {
    map: HashMap<String, Arc<ConnSlot>>,
    order: Vec<String>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn insert(&mut self, slot: Arc<ConnSlot>) {
        if !self.order.iter().any(|id| id == &slot.id) {
            self.order.push(slot.id.clone());
        }
        self.map.insert(slot.id.clone(), slot);
    }

    pub fn get(&self, id: &str) -> Option<Arc<ConnSlot>> {
        self.map.get(id).cloned()
    }

    pub fn remove(&mut self, id: &str) -> Option<Arc<ConnSlot>> {
        self.order.retain(|existing| existing != id);
        self.map.remove(id)
    }

    pub fn list(&self) -> Vec<Arc<ConnSlot>> {
        self.order
            .iter()
            .filter_map(|id| self.map.get(id).cloned())
            .collect()
    }
}

#[derive(Clone)]
pub struct AppState {
    pub registry: Arc<tokio::sync::Mutex<Registry>>,
    pub default_conn: Arc<str>,
    pub token: Arc<str>,
    pub demo_rows: usize,
    pub allowed_hosts: Arc<Vec<String>>,
    pub store: Arc<tokio::sync::Mutex<store::StoreFile>>,
    pub update: Arc<update::UpdateChecker>,
}

async fn slot_for(
    state: &AppState,
    conn: Option<&str>,
) -> Result<Arc<ConnSlot>, (StatusCode, Json<ApiError>)> {
    let id = conn
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(state.default_conn.as_ref());
    state.registry.lock().await.get(id).ok_or_else(|| {
        // Without --db or --demo there is no default connection to fall back
        // to (WebSocket messages without a conn name it explicitly).
        not_found(if id == state.default_conn.as_ref() {
            "열린 연결이 없습니다. 먼저 연결을 여세요"
        } else {
            "연결을 찾을 수 없습니다"
        })
    })
}

async fn register_slot(
    state: &AppState,
    label: String,
    saved_id: Option<String>,
    origin: Option<ConnectRequest>,
    engine: Engine,
) -> Arc<ConnSlot> {
    let slot = Arc::new(ConnSlot::new(
        uuid::Uuid::new_v4().simple().to_string(),
        label,
        saved_id,
        origin,
        engine,
    ));
    state.registry.lock().await.insert(slot.clone());
    record_gui_changes(state, &slot);
    slot
}

/// Files the data changes that went through on `slot` into its History, as
/// TablePlus does for changes it commits: GUI cell edits and row inserts or
/// deletes, and statements the GUI ran asking for History. The engine holds
/// them back until their transaction commits and drops them on rollback.
/// Whatever is ready is filed as one batch, one write. Holds the slot weakly
/// and ends with its engine.
fn record_gui_changes(state: &AppState, slot: &Arc<ConnSlot>) {
    let Some(mut changes) = slot.engine.sql_log().take_changes() else {
        return;
    };
    let slot = Arc::downgrade(slot);
    let store = state.store.clone();
    tokio::spawn(async move {
        while let Some(first) = changes.recv().await {
            let mut batch = vec![first];
            while let Ok(next) = changes.try_recv() {
                batch.push(next);
            }
            let Some(slot) = slot.upgrade() else {
                break;
            };
            let scope = slot.history_scope();
            drop(slot);
            let at = unix_now();
            let entries = batch
                .into_iter()
                .map(|change: Change| store::HistoryEntry {
                    id: String::new(),
                    scope: scope.clone(),
                    sql: change.sql,
                    at,
                    ms: change.ms,
                    ok: true,
                    rows: change.rows,
                    error: None,
                })
                .collect();
            let _ = file_history(&store, entries).await;
        }
    });
}

/// A statement the user ran, for History: its time and row count, or the
/// error it stopped with.
fn run_entry(
    scope: String,
    sql: &str,
    started: std::time::Instant,
    outcome: Result<(f64, usize), &EngineError>,
) -> store::HistoryEntry {
    let (ms, ok, rows, error) = match outcome {
        Ok((elapsed_ms, rows)) => (elapsed_ms.round() as u64, true, rows as u64, None),
        Err(err) => (
            started.elapsed().as_millis() as u64,
            false,
            0,
            Some(if err.is_interrupted() {
                "쿼리가 취소되었습니다".to_string()
            } else {
                err.to_string()
            }),
        ),
    };
    store::HistoryEntry {
        id: String::new(),
        scope,
        sql: sql.to_string(),
        at: unix_now(),
        ms,
        ok,
        rows,
        error,
    }
}

/// Files `entries` (oldest first) unless their saved profile was deleted
/// meanwhile.
async fn file_history(
    store: &tokio::sync::Mutex<store::StoreFile>,
    entries: Vec<store::HistoryEntry>,
) -> Result<(), String> {
    change_history(store, |store| {
        let mut added = false;
        for entry in entries {
            if store.scope_exists(&entry.scope) {
                added |= store.add_history(entry);
            }
        }
        ((), added)
    })
    .await
}

/// Changes History under the store lock, then writes history.json on the
/// blocking pool so a large file never stalls an async worker. `change`
/// returns its result and whether it changed anything (only then is the
/// file written).
async fn change_history<R>(
    store: &tokio::sync::Mutex<store::StoreFile>,
    change: impl FnOnce(&mut store::StoreFile) -> (R, bool),
) -> Result<R, String> {
    let (result, snapshot) = {
        let mut store = store.lock().await;
        let (result, changed) = change(&mut store);
        let snapshot = changed.then(|| store.history_snapshot());
        (result, snapshot)
    };
    if let Some(snapshot) = snapshot {
        tokio::task::spawn_blocking(move || snapshot.write())
            .await
            .map_err(|err| err.to_string())??;
    }
    Ok(result)
}

struct InflightGuard(Arc<AtomicUsize>);

impl InflightGuard {
    fn new(counter: Arc<AtomicUsize>) -> Self {
        counter.fetch_add(1, Ordering::SeqCst);
        Self(counter)
    }
}

impl Drop for InflightGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/", get(index))
        .route("/assets/{*path}", get(asset))
        .route("/api/ws", get(ws_upgrade))
        .route("/api/engines", get(engines_route))
        .route("/api/meta", get(meta))
        .route("/api/open", post(open))
        .route("/api/connect", post(connect))
        .route("/api/conns", get(conns_list))
        .route("/api/conns/{id}", delete(conns_delete))
        .route("/api/fs/list", get(fs_list))
        .route("/api/fs/stat", get(fs_stat))
        .route("/api/fs/pick", post(fs_pick))
        .route("/api/fonts", get(fonts_route))
        .route("/api/schema", get(schema_route))
        .route("/api/relations", get(relations_route))
        .route("/api/count", get(count_route))
        .route("/api/exec", post(exec_route))
        .route("/api/job", post(job_route))
        .route("/api/databases", get(databases_route))
        .route("/api/switch-db", post(switch_db_route))
        .route("/api/query", post(query))
        .route("/api/table", get(table_info))
        .route("/api/connection-info", get(connection_info_route))
        .route("/api/version", get(version_route))
        .route("/api/update", get(update_status).put(update_configure))
        .route("/api/update/check", post(update_check))
        .route("/api/server", get(server_info_route))
        .route("/api/objects", get(objects_route))
        .route("/api/definition", get(definition_route))
        .route("/api/kill", post(kill_route))
        .route("/api/doc/databases", get(doc_databases))
        .route("/api/doc/collections", get(doc_collections))
        .route("/api/doc/stats", get(doc_stats))
        .route("/api/doc/find", post(doc_find))
        .route("/api/doc/count", post(doc_count))
        .route("/api/doc/aggregate", post(doc_aggregate))
        .route("/api/doc/distinct", post(doc_distinct))
        .route("/api/doc/insert", post(doc_insert))
        .route("/api/doc/update", post(doc_update))
        .route("/api/doc/replace", post(doc_replace))
        .route("/api/doc/delete", post(doc_delete))
        .route(
            "/api/doc/indexes",
            get(doc_indexes)
                .post(doc_create_index)
                .delete(doc_drop_index),
        )
        .route("/api/doc/explain", post(doc_explain))
        .route("/api/doc/command", post(doc_command))
        .route("/api/doc/export", post(doc_export))
        .route("/api/sql/export", post(sql_export))
        .route("/api/sql/cell", post(sql_cell_read))
        .route(
            "/api/sql/cell/write",
            post(sql_cell_write).layer(axum::extract::DefaultBodyLimit::disable()),
        )
        .route("/api/sql/skip", post(sql_skip))
        .route("/api/sql/count", post(sql_count))
        .route("/api/doc/perf", get(doc_perf))
        .route("/api/doc/update/preview", post(doc_update_preview))
        .route(
            "/api/doc/search-indexes",
            get(doc_search_indexes)
                .post(doc_create_search_index)
                .put(doc_update_search_index)
                .delete(doc_drop_search_index),
        )
        .route("/api/doc/watch", post(doc_watch))
        .route("/api/doc/gridfs/buckets", get(doc_gridfs_buckets))
        .route(
            "/api/doc/gridfs/files",
            post(doc_gridfs_files).delete(doc_gridfs_delete),
        )
        .route("/api/doc/gridfs/download", get(doc_gridfs_download))
        .route("/api/doc/gridfs/upload", post(doc_gridfs_upload))
        .route("/api/doc/cursor/open", post(doc_cursor_open))
        .route("/api/doc/cursor/next", post(doc_cursor_next))
        .route("/api/doc/cursor/close", post(doc_cursor_close))
        .route(
            "/api/connections",
            get(connections_list).post(connections_create),
        )
        .route("/api/connections/test", post(connections_test))
        .route("/api/connections/export", post(connections_export))
        .route("/api/connections/import", post(connections_import))
        .route(
            "/api/connections/{id}",
            delete(connections_delete).put(connections_update),
        )
        .route("/api/connections/{id}/connect", post(connection_connect))
        .route("/api/console", delete(console_clear))
        .route("/api/history", get(history_list).delete(history_clear))
        .route("/api/history/{id}", delete(history_delete))
        .route("/api/safe-mode", put(safe_mode_set))
        .route("/api/favorites", get(favorites_list).post(favorites_create))
        .route(
            "/api/favorites/{id}",
            put(favorites_update).delete(favorites_delete),
        )
        .route("/api/favorite-folders", post(folders_create))
        .route(
            "/api/favorite-folders/{id}",
            put(folders_update).delete(folders_delete),
        )
        .route("/api/oidc/logins", get(oidc_logins).delete(oidc_cancel))
        .route("/api/oidc/callback", get(oidc_callback))
        .merge(search::routes())
        .layer(middleware::from_fn_with_state(state.clone(), token_guard))
        .layer(middleware::from_fn_with_state(state.clone(), host_guard))
        .with_state(state)
}

pub async fn serve(listener: tokio::net::TcpListener, state: AppState) -> std::io::Result<()> {
    // Slots opened before the server (the --db or --demo one) were not
    // registered through register_slot.
    for slot in state.registry.lock().await.list() {
        record_gui_changes(&state, &slot);
    }
    // An OIDC browser login sends the provider back to this address.
    if let Ok(address) = listener.local_addr() {
        oidc::set_redirect_base(&format!("http://{address}"));
    }
    axum::serve(listener, app(state)).await
}

async fn host_guard(State(state): State<AppState>, request: Request<Body>, next: Next) -> Response {
    let allowed = request
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(|host| state.allowed_hosts.iter().any(|a| a == host))
        .unwrap_or(false);
    if allowed {
        next.run(request).await
    } else {
        (StatusCode::FORBIDDEN, "허용되지 않은 Host 헤더입니다").into_response()
    }
}

/// The routes that may carry the token in the query instead of the header.
const QUERY_TOKEN_ROUTES: [&str; 2] = ["/api/ws", "/api/doc/gridfs/download"];

/// Every API route wants the token, and checks it before the body or the
/// WebSocket upgrade is read: a stale one (the server restarted) is always
/// told as `invalid_token`, never as a malformed request. The WebSocket
/// handshake can only carry it in the query, as can a GridFS download the
/// browser saves itself (a plain link, not a buffered fetch).
async fn token_guard(
    State(state): State<AppState>,
    request: Request<Body>,
    next: Next,
) -> Response {
    let path = request.uri().path();
    // The identity provider sends the browser back here with no token; the
    // login's `state`, known only to the login waiting for it, stands in.
    if path.starts_with("/api/") && path != "/api/oidc/callback" {
        let query_token = QUERY_TOKEN_ROUTES
            .contains(&path)
            .then(|| request.uri().query())
            .flatten()
            .and_then(|query| {
                query
                    .split('&')
                    .find_map(|pair| pair.strip_prefix("token="))
            });
        if !authorized(&state, request.headers(), query_token) {
            return unauthorized().into_response();
        }
    }
    next.run(request).await
}

fn authorized(state: &AppState, headers: &HeaderMap, query_token: Option<&str>) -> bool {
    if let Some(t) = query_token {
        if t == &*state.token {
            return true;
        }
    }
    headers
        .get("x-tablepeek-token")
        .and_then(|v| v.to_str().ok())
        .map(|v| v == &*state.token)
        .unwrap_or(false)
}

/// A missing or stale token (the server restarted with a new one): the page
/// tells that from an unreachable server by this code.
fn unauthorized() -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::UNAUTHORIZED,
        Json(ApiError::new("invalid_token", "토큰이 유효하지 않습니다")),
    )
}

/// The prefix an engine's coded errors carry instead of `{engine}_error`.
fn error_code_prefix(engine: &str) -> Option<&'static str> {
    registry::factory(engine)?
        .descriptor()
        .error_code_prefix
        .as_deref()
}

fn engine_error(err: EngineError) -> (StatusCode, Json<ApiError>) {
    let (status, code): (StatusCode, std::borrow::Cow<'static, str>) = match &err {
        _ if err.is_interrupted() => (StatusCode::BAD_REQUEST, "interrupted".into()),
        EngineError::NotFound(_) => (StatusCode::NOT_FOUND, "not_found".into()),
        EngineError::NotAFile(_) => (StatusCode::BAD_REQUEST, "not_a_sqlite_file".into()),
        EngineError::NotEditable(_) => (StatusCode::BAD_REQUEST, "not_editable".into()),
        EngineError::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request".into()),
        EngineError::Unsupported(_) => (StatusCode::BAD_REQUEST, "unsupported_capability".into()),
        EngineError::UnknownEngine(_) => (StatusCode::BAD_REQUEST, "unsupported_driver".into()),
        EngineError::TableNotFound => (StatusCode::NOT_FOUND, "not_found".into()),
        EngineError::SessionNotFound => (StatusCode::NOT_FOUND, "not_found".into()),
        EngineError::TxRolledBack(_) => (StatusCode::CONFLICT, "tx_rolled_back".into()),
        EngineError::TxOutcomeUnknown(_) => (StatusCode::CONFLICT, "tx_outcome_unknown".into()),
        // The database's own code: `mongo_11000`.
        EngineError::Driver {
            engine,
            code: Some(code),
            ..
        } if error_code_prefix(engine).is_some() => {
            let prefix = error_code_prefix(engine).unwrap_or(engine);
            (StatusCode::BAD_REQUEST, format!("{prefix}_{code}").into())
        }
        // "postgres_error", "sqlite_error", …: the driver's id names it.
        EngineError::Driver { engine, .. } => {
            (StatusCode::BAD_REQUEST, format!("{engine}_error").into())
        }
        EngineError::Arrow(_) | EngineError::Internal(_) => {
            (StatusCode::INTERNAL_SERVER_ERROR, "internal".into())
        }
    };
    (status, Json(api_error(code.into_owned(), err)))
}

/// The reply for an engine error under `code`: a database's first line and
/// the rest it said (docs/ERRORS.md §2), any other error's own words.
fn api_error(code: String, err: EngineError) -> ApiError {
    let (message, fields) = match err {
        EngineError::Driver {
            message, fields, ..
        } => (message, fields),
        other => (other.to_string(), Box::default()),
    };
    redacted(ApiError {
        code,
        message,
        fields,
    })
}

/// The error with every password a connection string in it carries masked.
fn redacted(mut error: ApiError) -> ApiError {
    error.message = registry::redact_uri_passwords(&error.message);
    if let Some(raw) = error.fields.raw.as_mut() {
        *raw = registry::redact_uri_passwords(raw);
    }
    error
}

async fn index() -> Response {
    match Assets::get("index.html") {
        Some(file) => Html(String::from_utf8_lossy(&file.data).into_owned()).into_response(),
        None => (
            StatusCode::INTERNAL_SERVER_ERROR,
            "web/dist/index.html이 없습니다. web/에서 npm run build 후 다시 cargo build 하세요.",
        )
            .into_response(),
    }
}

fn mime_of(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "html" => "text/html; charset=utf-8",
        "json" | "map" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        _ => "application/octet-stream",
    }
}

async fn asset(AxumPath(path): AxumPath<String>) -> Response {
    match Assets::get(&format!("assets/{path}")) {
        Some(file) => (
            [
                (header::CONTENT_TYPE, mime_of(&path)),
                (header::CACHE_CONTROL, "public, max-age=3600"),
            ],
            file.data.to_vec(),
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

#[derive(Deserialize)]
struct ConnQuery {
    conn: Option<String>,
    system: Option<String>,
}

impl ConnQuery {
    fn include_system(&self) -> bool {
        matches!(self.system.as_deref(), Some("1") | Some("true"))
    }
}

async fn meta(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
) -> Result<Json<EngineMeta>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let slot = slot_for(&state, params.conn.as_deref()).await?;
    let meta = slot
        .refresh_summary(params.include_system())
        .await
        .map_err(engine_error)?;
    Ok(Json(meta))
}

async fn schema_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
) -> Result<Json<Vec<TableSchema>>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let slot = slot_for(&state, params.conn.as_deref()).await?;
    slot.engine
        .schema(params.include_system())
        .await
        .map(Json)
        .map_err(engine_error)
}

async fn relations_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let slot = slot_for(&state, params.conn.as_deref()).await?;
    let relations = slot
        .engine
        .relations(params.include_system())
        .await
        .map_err(engine_error)?;
    Ok(Json(json!({ "relations": relations })))
}

#[derive(Deserialize)]
struct CountQuery {
    conn: Option<String>,
    table: String,
}

async fn count_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<CountQuery>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let slot = slot_for(&state, params.conn.as_deref()).await?;
    let count = slot
        .engine
        .table_count(params.table.trim())
        .await
        .map_err(engine_error)?;
    Ok(Json(json!({ "count": count })))
}

#[derive(Deserialize)]
struct ExecRequest {
    sql: String,
    // Record the run in the connection's History if it succeeds (failed
    // attempts, a DROP retried in dependency order, say, would be noise) and,
    // inside an open transaction, only once that commits.
    #[serde(default)]
    history: bool,
    // A background job's statement (an import's chunk, a restore's): never
    // cancelled by the page's queries, nor cancelling them.
    #[serde(default)]
    job: bool,
}

#[derive(Deserialize)]
struct JobRequest {
    // "start" before a job's first statement, "end" after its last.
    action: String,
}

/// A background job (an import, a restore) starting or ending on a
/// connection. Starting is refused while a transaction is open there, from
/// any tab (the job's COMMIT, ROLLBACK or MySQL CREATE TABLE would end it),
/// or another job holds it. Ending hands a transaction the job leaves open
/// (a ROLLBACK that failed) to the TX controls.
async fn job_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<JobRequest>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let slot = slot_for(&state, params.conn.as_deref()).await?;
    let start = match req.action.as_str() {
        "start" => true,
        "end" => false,
        _ => return Err(bad_request("invalid_request", "알 수 없는 job action")),
    };
    slot.gated(Holder::Protected, false, async {
        if !start {
            slot.end_job();
            return Ok(());
        }
        slot.refused_while_job()?;
        if slot.engine.in_tx().await.unwrap_or(false) {
            return Err(EngineError::BadRequest(
                "트랜잭션이 열려 있습니다. 커밋하거나 롤백한 뒤 다시 시도하세요.".into(),
            ));
        }
        Ok(())
    })
    .await
    .map_err(engine_error)?;
    Ok(Json(json!({ "ok": true })))
}

async fn exec_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<ExecRequest>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let sql = req.sql.trim();
    if sql.is_empty() {
        return Err(bad_request("empty_sql", "SQL이 비어 있습니다"));
    }
    let slot = slot_for(&state, params.conn.as_deref()).await?;
    let _guard = InflightGuard::new(slot.inflight.clone());
    let holder = if req.job {
        Holder::Job
    } else {
        Holder::Foreground
    };
    // The page's own (a count, a structure change): while a job's
    // transaction is open, a read runs beside it and a write is refused.
    // A statement that returns rows (a user list, a session snapshot) gets
    // them up to EXEC_MAX_ROWS, with `truncated` set past that.
    let result = slot
        .gated(holder, req.job, async {
            if req.job {
                slot.engine.execute(sql, EXEC_MAX_ROWS).await
            } else {
                slot.foreground_query(sql, EXEC_MAX_ROWS, None)
                    .await
                    .map(|data| QueryResult {
                        columns: data.columns.clone(),
                        row_count: data.row_count,
                        rows: data.rows_json(),
                        elapsed_ms: data.elapsed_ms,
                        truncated: data.truncated,
                    })
            }
        })
        .await;
    let result = result.map_err(engine_error)?;
    if req.history {
        let change = Change {
            sql: sql.to_string(),
            ms: result.elapsed_ms.round() as u64,
            rows: result.row_count as u64,
        };
        slot.engine.file_change(change).await;
    }
    Ok(Json(json!({
        "ok": true,
        "columns": result.columns,
        "rows": result.rows,
        "row_count": result.row_count,
        "truncated": result.truncated,
        "elapsed_ms": result.elapsed_ms,
    })))
}

/// The most rows /api/exec returns from one statement.
const EXEC_MAX_ROWS: usize = 10_000;

async fn databases_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let slot = slot_for(&state, params.conn.as_deref()).await?;
    let databases = slot.engine.databases().await.map_err(engine_error)?;
    Ok(Json(json!({ "databases": databases })))
}

/// `config` without any secret: the engine's secret fields left out and the
/// passwords inside its connection strings removed.
fn public_config(driver: &str, config: &ConnConfig) -> ConnConfig {
    let Some(factory) = registry::factory(driver) else {
        return config.clone();
    };
    let descriptor = factory.descriptor();
    let mut shown = descriptor.without_uri_passwords(config);
    for key in descriptor.secret_keys() {
        shown.remove(key);
    }
    shown
}

/// The settings a connection was opened with, without secrets: the saved
/// profile for a saved one, the request that opened it otherwise. Null
/// settings for a connection opened from a file or the demo.
async fn connection_info_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let slot = slot_for(&state, params.conn.as_deref()).await?;
    let saved = match slot.saved_id.as_deref() {
        Some(id) => state.store.lock().await.find_connection(id).cloned(),
        None => None,
    };
    let settings = match (saved, slot.origin.as_ref()) {
        (Some(saved), _) => Some((saved.driver.clone(), saved.config.clone())),
        (None, Some(origin)) => Some((origin.driver.clone(), origin.config.clone())),
        (None, None) => None,
    };
    Ok(Json(match settings {
        Some((driver, config)) => json!({
            "driver": driver,
            "config": public_config(&driver, &config),
        }),
        None => json!({ "driver": null, "config": null }),
    }))
}

#[derive(Deserialize)]
struct SwitchDbRequest {
    database: String,
}

async fn switch_db_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<SwitchDbRequest>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let database = req.database.trim().to_string();
    if database.is_empty() {
        return Err(bad_request(
            "empty_database",
            "데이터베이스 이름이 비어 있습니다",
        ));
    }
    let slot = slot_for(&state, params.conn.as_deref()).await?;
    let Some(origin) = slot.origin.clone() else {
        return Err(bad_request(
            "unsupported_connection",
            "이 연결은 데이터베이스 전환을 지원하지 않습니다",
        ));
    };
    let factory = registry::require(&origin.driver).map_err(engine_error)?;
    let switchable = slot
        .engine
        .capabilities()
        .is_ok_and(|capabilities| capabilities.databases == "switch");
    if !switchable {
        return Err(bad_request(
            "unsupported_driver",
            "이 드라이버는 데이터베이스 전환을 지원하지 않습니다",
        ));
    }
    let mut config = origin.config.clone();
    config.insert("database".into(), Value::String(database));
    // Through the tunnel the connection opened, when it went through one.
    let net = match slot.tunnel.lock().await.as_ref() {
        Some(route) => route.net(),
        None if origin.ssh.is_some() || origin.http_tunnel.is_some() => {
            return Err(internal_error("SSH 터널이 닫혀 있습니다"));
        }
        None => NetRoute::Direct,
    };
    slot.cancel_if_inflight();
    slot.engine.cancel();
    // The session (and any job's transaction in it) goes with the switch.
    slot.end_job();
    {
        let mut sessions = slot.sessions.lock().await;
        sessions.clear();
    }
    let meta = slot
        .engine
        .swap_to(factory, &config, &net)
        .await
        .map_err(engine_error)?;
    slot.remember(slot.engine.epoch(), &meta);
    Ok(Json(json!({ "conn": &slot.id, "meta": meta })))
}

#[derive(Deserialize)]
struct OpenRequest {
    path: Option<String>,
}

async fn open(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<OpenRequest>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    if let Some(path) = req.path.as_deref() {
        if let Some(slot) = open_file_slot(&state, path).await {
            let meta = slot.refresh_summary(false).await.map_err(engine_error)?;
            return Ok(Json(json!({ "conn": slot.id, "meta": meta })));
        }
    }
    let outcome = match req.path.as_deref() {
        None => Engine::open_demo(state.demo_rows),
        Some(path) => Engine::open_file(std::path::Path::new(path)),
    };
    match outcome {
        Ok(engine) => {
            let label = match req.path.as_deref() {
                None => "데모 데이터베이스".to_string(),
                Some(path) => path.to_string(),
            };
            let slot = register_slot(&state, label, None, None, engine).await;
            let meta = slot.refresh_summary(false).await.map_err(engine_error)?;
            Ok(Json(json!({ "conn": slot.id, "meta": meta })))
        }
        Err(err) => Err(engine_error(err)),
    }
}

/// The slot already open on this SQLite file, however its path was spelled.
/// Opening a file again, as a file or through a saved profile, goes to it:
/// two engines on one file would only contend for its lock.
async fn open_file_slot(state: &AppState, path: &str) -> Option<Arc<ConnSlot>> {
    let wanted = std::fs::canonicalize(path.trim()).ok()?;
    let slots = state.registry.lock().await.list();
    slots.into_iter().find(|slot| {
        slot.engine
            .file()
            .and_then(|file| std::fs::canonicalize(file).ok())
            .is_some_and(|file| file == wanted)
    })
}

fn bad_request(code: &str, message: impl Into<String>) -> (StatusCode, Json<ApiError>) {
    (StatusCode::BAD_REQUEST, Json(ApiError::new(code, message)))
}

fn internal_error(message: impl Into<String>) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ApiError::new("internal", message)),
    )
}

fn not_found(message: &str) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::NOT_FOUND,
        Json(ApiError::new("not_found", message)),
    )
}

fn store_error(message: String) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ApiError::new("store_error", message)),
    )
}

fn keyring_error(message: String) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ApiError::new("keyring_error", message)),
    )
}

/// Runs keychain work on the blocking pool. A macOS `security` call can sit
/// on an unanswered unlock prompt (until its deadline); it must not hold an
/// async worker, and so the requests queued behind it, while it waits.
async fn keychain<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    match tokio::task::spawn_blocking(work).await {
        Ok(value) => value,
        Err(err) => std::panic::resume_unwind(err.into_panic()),
    }
}

struct ConnectError {
    status: StatusCode,
    code: &'static str,
    message: String,
    fields: Box<ErrorFields>,
}

impl ConnectError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
            fields: Box::default(),
        }
    }

    /// A connection the engine could not open: a missing or foreign file by
    /// its own code, anything else `connect_failed` with the database's
    /// first line and the rest it said (SQLSTATE, MongoDB's topology, …).
    fn from_engine(err: EngineError) -> Self {
        let (status, code) = match &err {
            EngineError::NotFound(_) => (StatusCode::NOT_FOUND, "not_found"),
            EngineError::NotAFile(_) => (StatusCode::BAD_REQUEST, "not_a_sqlite_file"),
            _ => (StatusCode::BAD_REQUEST, "connect_failed"),
        };
        let error = api_error(String::new(), err);
        Self {
            status,
            code,
            message: error.message,
            fields: error.fields,
        }
    }

    fn into_response(self) -> (StatusCode, Json<ApiError>) {
        (
            self.status,
            Json(redacted(ApiError {
                code: self.code.into(),
                message: self.message,
                fields: self.fields,
            })),
        )
    }
}

fn connect_failed(message: impl Into<String>) -> ConnectError {
    ConnectError::new(StatusCode::BAD_REQUEST, "connect_failed", message)
}

// The code tells the client which secret to ask for.
fn stored_password_missing(kind: &str) -> ConnectError {
    let (code, message) = match kind {
        "ssh" => (
            "ssh_password_required",
            "저장된 SSH 비밀번호가 없습니다 — SSH 비밀번호를 입력해 연결하세요",
        ),
        "http" => (
            "http_password_required",
            "저장된 프록시 비밀번호가 없습니다 — 프록시 비밀번호를 입력해 연결하세요",
        ),
        _ => (
            "password_required",
            "저장된 비밀번호가 없습니다 — 비밀번호를 입력해 연결하세요",
        ),
    };
    ConnectError::new(StatusCode::BAD_REQUEST, code, message)
}

struct SlotOrigin {
    label: Option<String>,
    saved_id: Option<String>,
}

/// Opens the tunnel the request asks for: a local end leading to one
/// server, or, for a replica set or cluster, the tunnel itself, which the
/// engine leads a stream through to each member.
async fn open_external_tunnel(
    req: &ConnectRequest,
    target: TunnelTarget,
) -> Result<Option<tunnel::Route>, String> {
    if req.ssh.is_some() && req.http_tunnel.is_some() {
        return Err("SSH와 HTTP 터널은 동시에 사용할 수 없습니다".into());
    }
    match target {
        TunnelTarget::Address(host, port) => {
            if let Some(ssh) = req.ssh.as_ref() {
                return tunnel::open(ssh, &host, port)
                    .await
                    .map(|opened| Some(tunnel::Route::One(opened)));
            }
            if let Some(tunnel_config) = req.http_tunnel.as_ref() {
                return tunnel::open_http(tunnel_config, &host, port)
                    .await
                    .map(|opened| Some(tunnel::Route::One(opened)));
            }
        }
        TunnelTarget::Members => {
            if let Some(ssh) = req.ssh.as_ref() {
                let forwarder = tunnel::SshForwarder::open(ssh).await?;
                return Ok(Some(tunnel::Route::Members(Arc::new(forwarder))));
            }
            if let Some(tunnel_config) = req.http_tunnel.as_ref() {
                let forwarder = tunnel::HttpForwarder::new(tunnel_config);
                return Ok(Some(tunnel::Route::Members(Arc::new(forwarder))));
            }
        }
    }
    Ok(None)
}

async fn connect_with(
    state: &AppState,
    req: ConnectRequest,
    origin: SlotOrigin,
) -> Result<(Arc<ConnSlot>, EngineMeta), ConnectError> {
    let factory = registry::factory(&req.driver).ok_or_else(|| {
        ConnectError::new(
            StatusCode::BAD_REQUEST,
            "unsupported_driver",
            EngineError::UnknownEngine(req.driver.clone()).to_string(),
        )
    })?;
    factory.validate(&req.config).map_err(|problem| {
        ConnectError::new(StatusCode::BAD_REQUEST, problem.code, problem.message)
    })?;
    // Through the tunnel the request asks for, to the address the engine
    // names; the address the user gave stays the one shown.
    let tunnel = if req.ssh.is_some() || req.http_tunnel.is_some() {
        let target = factory.tunnel_target(&req.config).map_err(|problem| {
            ConnectError::new(StatusCode::BAD_REQUEST, problem.code, problem.message)
        })?;
        open_external_tunnel(&req, target)
            .await
            .map_err(connect_failed)?
    } else {
        None
    };
    let net = tunnel.as_ref().map_or(NetRoute::Direct, tunnel::Route::net);
    let address = factory.address(&req.config);
    let label = origin.label.unwrap_or_else(|| address.clone());
    let engine = Engine::open_demo(0).map_err(|err| connect_failed(err.to_string()))?;
    // Same status and code as /api/open for a missing file or one that is not SQLite.
    let mut meta = engine
        .swap_to(factory, &req.config, &net)
        .await
        .map_err(ConnectError::from_engine)?;
    if tunnel.is_some() {
        meta.path = Some(address);
    }
    let slot = register_slot(state, label, origin.saved_id, Some(req), engine).await;
    *slot.tunnel.lock().await = tunnel;
    slot.remember(slot.engine.epoch(), &meta);
    Ok((slot, meta))
}

/// The file a file engine's settings name (its `path`): opening it again
/// enters the connection already open on it.
fn config_file<'a>(driver: &str, config: &'a ConnConfig) -> Option<&'a str> {
    registry::factory(driver)
        .filter(|factory| factory.descriptor().transport == "file")
        .and(config.get("path"))
        .and_then(Value::as_str)
}

async fn connect(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ConnectRequest>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    // A file already open is entered, not opened twice.
    if let Some(path) = config_file(&req.driver, &req.config) {
        if let Some(slot) = open_file_slot(&state, path).await {
            let meta = slot.refresh_summary(false).await.map_err(engine_error)?;
            return Ok(Json(json!({ "conn": slot.id, "meta": meta })));
        }
    }
    let origin = SlotOrigin {
        label: None,
        saved_id: None,
    };
    match connect_with(&state, req, origin).await {
        Ok((slot, meta)) => Ok(Json(json!({ "conn": slot.id, "meta": meta }))),
        Err(err) => Err(err.into_response()),
    }
}

#[derive(Deserialize)]
struct NewConnectionRequest {
    name: String,
    connect: ConnectRequest,
    #[serde(default)]
    persist_password: bool,
}

/// A saved profile as the page sees it. A connection string saved with its
/// password (before passwords were taken out of them) shows without it.
/// `has_password` only for a profile that keeps secrets at all: one saved
/// with the keychain choice and no authentication says it has none.
fn connection_json(connection: &store::SavedConnection) -> Value {
    let mut value = serde_json::to_value(connection).unwrap_or(Value::Null);
    if let Some(object) = value.as_object_mut() {
        if let Some(factory) = registry::factory(&connection.driver) {
            let config = factory
                .descriptor()
                .without_uri_passwords(&connection.config);
            object.insert("config".into(), Value::Object(config));
        }
        let tunnelled = connection.ssh.is_some() || connection.http_tunnel.is_some();
        let keeps = connection.persist_password
            && keeps_secrets(&connection.driver, &connection.config, tunnelled);
        object.insert("persist_password".into(), Value::Bool(keeps));
        object.insert("has_password".into(), Value::Bool(keeps));
    }
    value
}

/// Whether a profile keeps secrets in the keychain at all: its engine takes
/// a password with these settings, or it goes through a tunnel.
fn keeps_secrets(driver: &str, config: &ConnConfig, tunnelled: bool) -> bool {
    tunnelled || registry::factory(driver).is_some_and(|factory| factory.needs_password(config))
}

async fn engines_route(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let engines: Vec<&registry::EngineDescriptor> = registry::factories()
        .iter()
        .map(|factory| factory.descriptor())
        .collect();
    Ok(Json(json!({ "engines": engines })))
}

async fn connections_list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let connections = {
        let store = state.store.lock().await;
        store
            .data()
            .connections
            .iter()
            .map(connection_json)
            .collect::<Vec<Value>>()
    };
    Ok(Json(json!({ "connections": connections })))
}

fn validate_connect_request(connect: &ConnectRequest) -> Result<(), (StatusCode, Json<ApiError>)> {
    match connect_problem(connect) {
        Some((code, message)) => Err(bad_request(code, message)),
        None => Ok(()),
    }
}

// What keeps a connect request from being saved or opened: (error code, message).
fn connect_problem(connect: &ConnectRequest) -> Option<(&'static str, String)> {
    let Some(factory) = registry::factory(&connect.driver) else {
        return Some((
            "unsupported_driver",
            EngineError::UnknownEngine(connect.driver.clone()).to_string(),
        ));
    };
    if let Err(problem) = factory.validate(&connect.config) {
        return Some((problem.code, problem.message));
    }
    let descriptor = factory.descriptor();
    let tunnels = &descriptor.connection.tunnels;
    let unsupported = (connect.ssh.is_some() && !tunnels.iter().any(|kind| kind == "ssh"))
        || (connect.http_tunnel.is_some() && !tunnels.iter().any(|kind| kind == "http"));
    if unsupported {
        // A local file needs no host, and there is nothing to tunnel to.
        return Some((
            "invalid_request",
            format!(
                "{} 연결에는 SSH·HTTP 터널을 쓸 수 없습니다",
                descriptor.label
            ),
        ));
    }
    if connect.ssh.is_some() || connect.http_tunnel.is_some() {
        // Somewhere to lead to (not a file).
        if let Err(problem) = factory.tunnel_target(&connect.config) {
            return Some((problem.code, problem.message));
        }
    }
    None
}

/// An engine's secret fields with the keychain kind each is stored under:
/// the first under the engine's id (`conn:{id}:postgres`), any others under
/// `{engine}:{key}`.
fn secret_kinds(descriptor: &registry::EngineDescriptor) -> Vec<(String, String)> {
    descriptor
        .secret_keys()
        .enumerate()
        .map(|(index, key)| {
            let kind = if index == 0 {
                descriptor.id.clone()
            } else {
                format!("{}:{key}", descriptor.id)
            };
            (key.to_string(), kind)
        })
        .collect()
}

/// The secret kinds of the engine `driver` names; none for one unknown.
fn driver_secret_kinds(driver: &str) -> Vec<(String, String)> {
    registry::factory(driver)
        .map(|factory| secret_kinds(factory.descriptor()))
        .unwrap_or_default()
}

/// A secret typed into the request, if it isn't blank.
fn request_secret<'a>(connect: &'a ConnectRequest, key: &str) -> Option<&'a str> {
    connect
        .config
        .get(key)
        .and_then(Value::as_str)
        .filter(|secret| !secret.is_empty())
}

/// Whether the request carries the engine's first secret (its password).
fn request_db_password(connect: &ConnectRequest) -> Option<&str> {
    let kinds = driver_secret_kinds(&connect.driver);
    let (key, _) = kinds.first()?;
    request_secret(connect, key)
}

fn delete_connection_passwords(id: &str) {
    let engine_kinds = registry::factories()
        .iter()
        .flat_map(|factory| secret_kinds(factory.descriptor()))
        .map(|(_, kind)| kind);
    for kind in engine_kinds.chain(["ssh".to_string(), "http".to_string()]) {
        store::delete_password(&store::connection_account(id, &kind));
    }
}

// Shared by create and update. On update an empty password keeps the stored
// one (moved to the new driver's account if the driver changed).
async fn save_connection(
    state: &AppState,
    id: &str,
    mut req: NewConnectionRequest,
    previous: Option<&store::SavedConnection>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let name = req.name.trim().to_string();
    if name.is_empty() {
        return Err(bad_request("invalid_request", "이름이 필요합니다"));
    }
    validate_connect_request(&req.connect)?;
    let factory = registry::require(&req.connect.driver).map_err(engine_error)?;
    let descriptor = factory.descriptor();
    // Saved under the engine's own id, whichever alias the request used.
    let driver = descriptor.id.clone();
    let secrets = secret_kinds(descriptor);
    // A password typed into a connection string becomes the engine's
    // password, so it is kept like one (keychain or asked for), never in the
    // saved string.
    descriptor.secure_config(&mut req.connect.config);
    // An import or an older client may leave out settings this version has.
    factory.upgrade_config(&mut req.connect.config);

    // Only a profile that takes a password (its engine's, with these
    // settings) or goes through a tunnel keeps any in the keychain: not a
    // SQLite file, nor a MongoDB profile without authentication or with X.509.
    let takes_password = factory.needs_password(&req.connect.config);
    let persist_password = req.persist_password
        && keeps_secrets(
            &driver,
            &req.connect.config,
            req.connect.ssh.is_some() || req.connect.http_tunnel.is_some(),
        );
    let ssh_account = store::connection_account(id, "ssh");
    let http_account = store::connection_account(id, "http");
    let fresh = previous.is_none();
    // The previous engine's secret kinds, when the profile changes engine:
    // its secrets move to the new engine's accounts.
    let moved_from: Vec<(String, String)> = previous
        .filter(|old| old.persist_password && old.driver != driver)
        .map(|old| driver_secret_kinds(&old.driver))
        .unwrap_or_default();
    // Every keychain write remembers what it replaced so a later failure can undo it.
    let mut written: Vec<(String, Option<String>)> = Vec::new();
    if persist_password {
        // Each account with the secret typed for it, or the old engine's
        // account to carry the secret over from.
        let mut pending: Vec<(String, Option<String>, Option<String>)> = secrets
            .iter()
            .filter(|_| takes_password)
            .map(|(key, kind)| {
                let carried = moved_from
                    .iter()
                    .find(|(old_key, _)| old_key == key)
                    .map(|(_, old_kind)| store::connection_account(id, old_kind));
                let typed = request_secret(&req.connect, key).map(str::to_string);
                (store::connection_account(id, kind), typed, carried)
            })
            .collect();
        let ssh_password = req
            .connect
            .ssh
            .as_ref()
            .and_then(|ssh| ssh.password.clone())
            .filter(|password| !password.is_empty());
        let http_password = req
            .connect
            .http_tunnel
            .as_ref()
            .and_then(|tunnel| tunnel.password.clone())
            .filter(|password| !password.is_empty());
        pending.push((ssh_account.clone(), ssh_password, None));
        pending.push((http_account.clone(), http_password, None));
        written = keychain(move || {
            let mut written = Vec::new();
            for (account, typed, carried) in pending {
                let Some(secret) =
                    typed.or_else(|| carried.and_then(|old| store::get_password(&old)))
                else {
                    continue;
                };
                let replaced = if fresh {
                    None
                } else {
                    store::get_password(&account)
                };
                if let Err(message) = store::set_password(&account, &secret) {
                    restore_secrets(&written);
                    return Err(message);
                }
                written.push((account, replaced));
            }
            Ok(written)
        })
        .await
        .map_err(keyring_error)?;
    }

    // Secrets stay out of the store file.
    let mut config = req.connect.config.clone();
    for (key, _) in &secrets {
        config.remove(key);
    }
    let connection = store::SavedConnection {
        id: id.to_string(),
        name,
        driver: driver.clone(),
        config,
        ssh: req.connect.ssh.as_ref().map(store::SavedSsh::from_config),
        http_tunnel: req
            .connect
            .http_tunnel
            .as_ref()
            .map(store::SavedHttpTunnel::from_config),
        persist_password,
        last_used: previous.map(|old| old.last_used).unwrap_or(0),
    };
    let outcome = {
        let mut store = state.store.lock().await;
        if fresh {
            store.add_connection(connection).map(|_| true)
        } else {
            store.update_connection(connection)
        }
    };
    let failure = match outcome {
        Ok(true) => None,
        Ok(false) => Some(not_found("연결을 찾을 수 없습니다")),
        Err(message) => Some(store_error(message)),
    };
    if let Some(failure) = failure {
        keychain(move || restore_secrets(&written)).await;
        return Err(failure);
    }

    // Drop secrets the saved profile no longer refers to. The old engine's
    // accounts go only once their secrets have been moved to the new ones.
    let had_secrets = previous.is_some_and(|old| old.persist_password);
    let mut stale: Vec<String> = Vec::new();
    if !persist_password {
        if had_secrets {
            let id = id.to_string();
            keychain(move || delete_connection_passwords(&id)).await;
        }
    } else if had_secrets {
        for (old_key, old_kind) in &moved_from {
            let moved = secrets.iter().any(|(key, kind)| {
                key == old_key
                    && written
                        .iter()
                        .any(|(account, _)| *account == store::connection_account(id, kind))
            });
            if moved {
                stale.push(store::connection_account(id, old_kind));
            }
        }
        // A password the settings no longer take (a tunnelled profile
        // switched to no authentication) goes too.
        if !takes_password {
            stale.extend(
                secrets
                    .iter()
                    .map(|(_, kind)| store::connection_account(id, kind)),
            );
        }
        if req.connect.ssh.is_none() {
            stale.push(ssh_account);
        }
        if req.connect.http_tunnel.is_none() {
            stale.push(http_account);
        }
    }
    if !stale.is_empty() {
        keychain(move || {
            stale
                .iter()
                .for_each(|account| store::delete_password(account))
        })
        .await;
    }
    Ok(())
}

fn restore_secrets(written: &[(String, Option<String>)]) {
    for (account, replaced) in written.iter().rev() {
        match replaced {
            Some(secret) => {
                let _ = store::set_password(account, secret);
            }
            None => store::delete_password(account),
        }
    }
}

async fn connections_create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<NewConnectionRequest>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    save_connection(&state, &id, req, None).await?;
    Ok(Json(json!({ "id": id })))
}

async fn connections_update(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
    Json(req): Json<NewConnectionRequest>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let previous = {
        let store = state.store.lock().await;
        store.find_connection(&id).cloned()
    };
    let Some(previous) = previous else {
        return Err(not_found("연결을 찾을 수 없습니다"));
    };
    save_connection(&state, &id, req, Some(&previous)).await?;
    Ok(Json(json!({ "id": id })))
}

#[derive(Deserialize)]
struct ExportConnectionsRequest {
    ids: Vec<String>,
    // Color, tags and group name per saved id: the page keeps these, not the store.
    #[serde(default)]
    meta: HashMap<String, transfer::ExportMeta>,
    #[serde(default)]
    groups: Vec<transfer::BundleGroup>,
    #[serde(default)]
    include_passwords: bool,
    passphrase: String,
}

// Seals the chosen profiles into a ".tablepeek" file. Passwords come from the
// keychain only when asked for, so they never pass through the page.
async fn connections_export(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ExportConnectionsRequest>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    if req.passphrase.chars().count() < transfer::MIN_PASSPHRASE_CHARS {
        return Err(bad_request(
            "weak_passphrase",
            "파일 암호는 8자 이상이어야 합니다",
        ));
    }
    // Each profile once, in the order asked.
    let mut seen = HashSet::new();
    let ids: Vec<String> = req
        .ids
        .into_iter()
        .filter(|id| seen.insert(id.clone()))
        .collect();
    let saved = {
        let store = state.store.lock().await;
        ids.iter()
            .map(|id| store.find_connection(id).cloned())
            .collect::<Option<Vec<_>>>()
    };
    let Some(saved) = saved else {
        return Err(not_found("연결을 찾을 수 없습니다"));
    };
    let ExportConnectionsRequest {
        meta,
        groups,
        include_passwords,
        passphrase,
        ..
    } = req;
    // Keychain reads and the key derivation both block, so neither runs on the async workers.
    let sealed = tokio::task::spawn_blocking(move || {
        let color = |value: &str| {
            if transfer::is_hex_color(value) {
                value.to_string()
            } else {
                String::new()
            }
        };
        let mut secrets = 0;
        let connections = saved
            .iter()
            .map(|connection| {
                let meta = meta.get(&connection.id).cloned().unwrap_or_default();
                let with_secrets = include_passwords && connection.persist_password;
                let carried = std::cell::Cell::new(false);
                let connect = transfer::export_connect(connection, |kind| {
                    let secret = with_secrets
                        .then(|| {
                            store::get_password(&store::connection_account(&connection.id, kind))
                        })
                        .flatten()
                        .filter(|secret| !secret.is_empty());
                    carried.set(carried.get() || secret.is_some());
                    secret
                });
                if carried.get() {
                    secrets += 1;
                }
                transfer::BundleConnection {
                    name: connection.name.clone(),
                    connect,
                    color: color(&meta.color),
                    tags: meta.tags,
                    group: meta.group,
                }
            })
            .collect::<Vec<_>>();
        let groups = groups
            .iter()
            .map(|group| transfer::BundleGroup {
                name: group.name.clone(),
                color: color(&group.color),
            })
            .collect();
        let count = connections.len();
        let plaintext = serde_json::to_vec(&transfer::Bundle {
            groups,
            connections,
        })
        .map_err(|err| err.to_string())?;
        let file = transfer::seal(&plaintext, &passphrase, transfer::DEFAULT_KDF)?;
        Ok::<_, String>((file, count, secrets))
    })
    .await
    .map_err(|err| internal_error(err.to_string()))?;
    let (file, count, secrets) = sealed.map_err(internal_error)?;
    // secrets: how many profiles carried a password into the file.
    Ok(Json(
        json!({ "file": file, "count": count, "secrets": secrets }),
    ))
}

#[derive(Deserialize)]
struct ImportConnectionsRequest {
    file: String,
    passphrase: String,
    // The word put after a clashing name, in the page's language ("가져옴").
    #[serde(default)]
    label: Option<String>,
}

// Opens a ".tablepeek" file and saves every connection in it, or none: one bad
// entry or a failed save leaves the store as it was.
async fn connections_import(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ImportConnectionsRequest>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let ImportConnectionsRequest {
        file,
        passphrase,
        label,
    } = req;
    let plaintext = tokio::task::spawn_blocking(move || transfer::open(&file, &passphrase))
        .await
        .map_err(|err| internal_error(err.to_string()))?
        .map_err(|err| match err {
            transfer::OpenError::NotConnectionsFile => bad_request(
                "not_connections_file",
                "TablePeek 연결 파일(.tablepeek)이 아닙니다",
            ),
            transfer::OpenError::Unsupported(message) => bad_request("unsupported_file", message),
            transfer::OpenError::WrongPassphraseOrDamaged => bad_request(
                "wrong_passphrase",
                "파일 암호가 맞지 않거나 파일이 손상되었습니다",
            ),
        })?;
    let bundle: transfer::Bundle = serde_json::from_slice(&plaintext)
        .map_err(|_| bad_request("invalid_file", "연결 파일의 내용을 읽을 수 없습니다"))?;
    let taken: HashSet<String> = {
        let store = state.store.lock().await;
        store
            .data()
            .connections
            .iter()
            .map(|connection| connection.name.clone())
            .collect()
    };
    let label = label
        .map(|label| label.trim().to_string())
        .filter(|label| !label.is_empty())
        .unwrap_or_else(|| "가져옴".to_string());
    let items = transfer::prepare_import(bundle.connections, &taken, &label)
        .map_err(|message| bad_request("invalid_file", message))?;

    let mut saved: Vec<(String, bool)> = Vec::new();
    let mut created = Vec::new();
    for item in items {
        let id = uuid::Uuid::new_v4().simple().to_string();
        let request = NewConnectionRequest {
            name: item.name.clone(),
            connect: item.connect,
            persist_password: item.persist_password,
        };
        if let Err(err) = save_connection(&state, &id, request, None).await {
            // Take back what this import already saved; the keychain outside the store lock.
            {
                let mut store = state.store.lock().await;
                for (id, _) in &saved {
                    let _ = store.remove_connection(id);
                }
            }
            let persisted: Vec<String> = saved
                .iter()
                .filter(|(_, persisted)| *persisted)
                .map(|(id, _)| id.clone())
                .collect();
            keychain(move || {
                persisted
                    .iter()
                    .for_each(|id| delete_connection_passwords(id))
            })
            .await;
            if err.1.code == "keyring_error" {
                return Err((
                    err.0,
                    Json(ApiError::new(
                        "import_keyring_error",
                        "파일에 든 비밀번호를 이 컴퓨터의 키체인에 저장하지 못해 아무것도 가져오지 않았습니다. 비밀번호를 빼고 내보낸 파일로 다시 가져오세요.",
                    )),
                ));
            }
            return Err(err);
        }
        saved.push((id.clone(), item.persist_password));
        created.push(json!({
            "id": id,
            "name": item.name,
            "color": item.color,
            "tags": item.tags,
            "group": item.group,
        }));
    }
    let groups: Vec<transfer::BundleGroup> = bundle
        .groups
        .into_iter()
        .map(|group| transfer::BundleGroup {
            color: if transfer::is_hex_color(&group.color) {
                group.color
            } else {
                String::new()
            },
            name: group.name,
        })
        .collect();
    Ok(Json(json!({ "groups": groups, "connections": created })))
}

#[derive(Deserialize)]
struct TestConnectionRequest {
    connect: ConnectRequest,
    #[serde(default)]
    saved_id: Option<String>,
}

// Opens the connection exactly like /api/connect, reports how it went, and
// closes it again. With saved_id, blank passwords fall back to the keychain.
async fn connections_test(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<TestConnectionRequest>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    validate_connect_request(&req.connect)?;
    let mut connect = req.connect;
    if let Some(id) = req.saved_id.as_deref() {
        let saved = {
            let store = state.store.lock().await;
            store.find_connection(id).cloned()
        };
        if let Some(saved) = saved.filter(|saved| saved.persist_password) {
            let id = id.to_string();
            connect = keychain(move || {
                // Blank secrets of the request's engine, from the saved engine's
                // accounts for the same fields.
                let saved_kinds = driver_secret_kinds(&saved.driver);
                for (key, _) in driver_secret_kinds(&connect.driver) {
                    if request_secret(&connect, &key).is_some() {
                        continue;
                    }
                    let stored = saved_kinds
                        .iter()
                        .find(|(saved_key, _)| *saved_key == key)
                        .and_then(|(_, kind)| {
                            store::get_password(&store::connection_account(&id, kind))
                        });
                    if let Some(secret) = stored {
                        connect.config.insert(key, Value::String(secret));
                    }
                }
                if let Some(ssh) = connect.ssh.as_mut() {
                    if ssh.password.as_deref().is_none_or(str::is_empty) {
                        ssh.password = store::get_password(&store::connection_account(&id, "ssh"));
                    }
                }
                if let Some(tunnel) = connect.http_tunnel.as_mut() {
                    if tunnel.password.as_deref().is_none_or(str::is_empty) {
                        tunnel.password =
                            store::get_password(&store::connection_account(&id, "http"));
                    }
                }
                connect
            })
            .await;
        }
    }
    // Spawned so the probe slot is always removed, even if the client goes away mid-test.
    let task_state = state.clone();
    let probe = tokio::spawn(async move {
        let started = std::time::Instant::now();
        let origin = SlotOrigin {
            label: Some("connection test".into()),
            saved_id: None,
        };
        let (slot, meta) = connect_with(&task_state, connect, origin).await?;
        let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
        task_state.registry.lock().await.remove(&slot.id);
        Ok::<_, ConnectError>(json!({
            "ok": true,
            "elapsed_ms": elapsed_ms,
            "kind": meta.kind,
            "tables": meta.tables.len(),
        }))
    });
    match probe.await {
        Ok(Ok(body)) => Ok(Json(body)),
        Ok(Err(err)) => Err(err.into_response()),
        Err(err) => Err(connect_failed(err.to_string()).into_response()),
    }
}

async fn connections_delete(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let removed = {
        let mut store = state.store.lock().await;
        store.remove_connection(&id).map_err(store_error)?
    };
    if !removed {
        return Err(not_found("연결을 찾을 수 없습니다"));
    }
    keychain(move || delete_connection_passwords(&id)).await;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Serialize)]
struct ConnSummary {
    id: String,
    label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    saved_id: Option<String>,
    is_default: bool,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
    demo: bool,
    table_count: usize,
    // This connection's own safe mode; null means the app-wide default applies.
    safe_mode: Option<u8>,
}

async fn conns_list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let slots = state.registry.lock().await.list();
    let mut conns = Vec::with_capacity(slots.len());
    for slot in slots {
        let (kind, path, demo, table_count) = match slot.summary() {
            Some(summary) => (
                summary.kind,
                summary.path,
                summary.demo,
                summary.table_count,
            ),
            None => match slot.refresh_summary(false).await {
                Ok(meta) => (meta.kind, meta.path, meta.demo, meta.tables.len()),
                // A server that went away still lists, as it was last
                // known (or by its engine), so the other connections don't
                // vanish from the page with it.
                Err(err) => match slot.last_summary() {
                    Some(summary) => (
                        summary.kind,
                        summary.path,
                        summary.demo,
                        summary.table_count,
                    ),
                    None => (
                        slot.engine
                            .engine_id()
                            .map_err(|_| engine_error(err))?
                            .to_string(),
                        None,
                        false,
                        0,
                    ),
                },
            },
        };
        let safe_mode = state.store.lock().await.safe_mode(&slot.history_scope());
        conns.push(ConnSummary {
            id: slot.id.clone(),
            label: slot.label.clone(),
            saved_id: slot.saved_id.clone(),
            is_default: slot.id == state.default_conn.as_ref(),
            kind,
            path,
            demo,
            table_count,
            safe_mode,
        });
    }
    Ok(Json(json!({ "conns": conns })))
}

async fn conns_delete(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    if id == state.default_conn.as_ref() {
        return Err(bad_request(
            "invalid_request",
            "기본 연결은 닫을 수 없습니다",
        ));
    }
    let Some(removed) = state.registry.lock().await.remove(&id) else {
        return Err(not_found("연결을 찾을 수 없습니다"));
    };
    // Their server cursors close now, not when the last request lets go.
    removed.cursors.close_all();
    // An unsaved connection's history has nowhere to come back to.
    let scope = removed.history_scope();
    if scope.starts_with(store::SESSION_PREFIX) {
        let _ = change_history(&state.store, |store| {
            store.forget_history(&scope);
            let _ = store.set_safe_mode(&scope, None);
            ((), true)
        })
        .await;
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Default, Deserialize)]
struct ConnectSecrets {
    #[serde(default)]
    password: Option<String>,
    #[serde(default)]
    ssh_password: Option<String>,
    #[serde(default)]
    http_password: Option<String>,
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|text| !text.is_empty())
}

// Passwords typed for this one connect win over the keychain; nothing is stored.
async fn connection_connect(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let secrets_body: ConnectSecrets = if body.is_empty() {
        ConnectSecrets::default()
    } else {
        serde_json::from_slice(&body)
            .map_err(|err| bad_request("invalid_request", format!("요청 형식 오류: {err}")))?
    };
    let saved = {
        let store = state.store.lock().await;
        store.find_connection(&id).cloned()
    };
    let Some(saved) = saved else {
        return Err(not_found("연결을 찾을 수 없습니다"));
    };
    let Some(factory) = registry::factory(&saved.driver) else {
        return Err(bad_request(
            "unsupported_driver",
            EngineError::UnknownEngine(saved.driver.clone()).to_string(),
        ));
    };
    // A file already open (as a file, or through this or another profile) is
    // entered, not opened twice.
    if let Some(path) = config_file(&saved.driver, &saved.config) {
        if let Some(slot) = open_file_slot(&state, path).await {
            let meta = slot.refresh_summary(false).await.map_err(engine_error)?;
            let _ = state.store.lock().await.touch_connection(&id, unix_now());
            return Ok(Json(json!({ "conn": slot.id, "meta": meta })));
        }
    }

    let mut request = ConnectRequest {
        driver: saved.driver.clone(),
        config: saved.config.clone(),
        ssh: None,
        http_tunnel: None,
    };
    // The first secret (the password) may be typed for this connect; the
    // rest come from the keychain, read off the async workers in one go.
    // A profile whose authentication takes no password reads none.
    let secrets = if factory.needs_password(&saved.config) {
        secret_kinds(factory.descriptor())
    } else {
        Vec::new()
    };
    let mut ssh = saved.ssh.as_ref().map(store::SavedSsh::to_config);
    let ssh_needs_password = ssh.as_ref().is_some_and(|ssh_config| {
        ssh_config
            .private_key_path
            .as_deref()
            .is_none_or(|path| path.trim().is_empty())
    });
    let mut http_tunnel = saved
        .http_tunnel
        .as_ref()
        .map(store::SavedHttpTunnel::to_config);
    let mut typed = non_empty(secrets_body.password);
    let typed_ssh = non_empty(secrets_body.ssh_password);
    let typed_http = non_empty(secrets_body.http_password);
    let persist = saved.persist_password;
    let (config, ssh_password, http_password) = {
        let mut config = request.config;
        let secrets = secrets.clone();
        let id = id.clone();
        let has_http = http_tunnel.is_some();
        let stored = move |kind: &str| {
            persist
                .then(|| store::get_password(&store::connection_account(&id, kind)))
                .flatten()
        };
        keychain(move || {
            for (key, kind) in &secrets {
                if let Some(secret) = typed.take().or_else(|| stored(kind)) {
                    config.insert(key.clone(), Value::String(secret));
                }
            }
            let ssh_password = ssh_needs_password
                .then(|| typed_ssh.or_else(|| stored("ssh")))
                .flatten();
            let http_password = has_http
                .then(|| typed_http.or_else(|| stored("http")))
                .flatten();
            (config, ssh_password, http_password)
        })
        .await
    };
    request.config = config;
    let supplied_password = request_db_password(&request).is_some();

    if let Some(ssh_config) = ssh.as_mut().filter(|_| ssh_needs_password) {
        match ssh_password {
            Some(password) => ssh_config.password = Some(password),
            None => return Err(stored_password_missing("ssh").into_response()),
        }
    }
    if let Some(tunnel_config) = http_tunnel.as_mut() {
        if http_password.is_some() {
            tunnel_config.password = http_password;
        } else if tunnel_config.username.is_some() {
            return Err(stored_password_missing("http").into_response());
        }
    }

    request.ssh = ssh;
    request.http_tunnel = http_tunnel;
    let origin = SlotOrigin {
        label: Some(saved.name.clone()),
        saved_id: Some(id.clone()),
    };
    match connect_with(&state, request, origin).await {
        Ok((slot, meta)) => {
            let _ = state.store.lock().await.touch_connection(&id, unix_now());
            Ok(Json(json!({ "conn": slot.id, "meta": meta })))
        }
        Err(err) => {
            // Tunnel failures (SSH/HTTP) are reported as they are, not as a DB password prompt.
            let tunnel_error = err.message.starts_with("SSH") || err.message.starts_with("HTTP");
            // An engine without secrets (a SQLite file) never prompts for a password.
            let needs_password = !supplied_password
                && !tunnel_error
                && !secrets.is_empty()
                && (err.message.contains("password")
                    || err.message.contains("비밀번호")
                    || err.message.contains("Authentication failed")
                    || err.message.contains("invalid configuration"));
            Err(if needs_password {
                stored_password_missing("db")
            } else {
                err
            }
            .into_response())
        }
    }
}

#[derive(Deserialize)]
struct HistoryParams {
    conn: Option<String>,
    limit: Option<usize>,
}

async fn history_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HistoryParams>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let scope = slot_for(&state, params.conn.as_deref())
        .await?
        .history_scope();
    let limit = params.limit.unwrap_or(50).clamp(1, store::HISTORY_CAP);
    let history = {
        let store = state.store.lock().await;
        store.history(&scope, limit)
    };
    Ok(Json(json!({ "history": history })))
}

async fn history_clear(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HistoryParams>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let scope = slot_for(&state, params.conn.as_deref())
        .await?
        .history_scope();
    change_history(&state.store, |store| {
        store.forget_history(&scope);
        ((), true)
    })
    .await
    .map_err(store_error)?;
    Ok(Json(json!({ "ok": true })))
}

async fn history_delete(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
    Query(params): Query<HistoryParams>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let scope = slot_for(&state, params.conn.as_deref())
        .await?
        .history_scope();
    let removed = change_history(&state.store, |store| {
        let removed = store.forget_history_entry(&scope, &id);
        (removed, removed)
    })
    .await
    .map_err(store_error)?;
    if !removed {
        return Err(not_found("기록을 찾을 수 없습니다"));
    }
    Ok(Json(json!({ "ok": true })))
}

async fn console_clear(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let slot = slot_for(&state, params.conn.as_deref()).await?;
    slot.engine.sql_log().clear();
    Ok(Json(json!({ "ok": true })))
}

/// The MongoDB OIDC browser logins a connect waits on: the page opens each
/// one's provider page in the browser.
async fn oidc_logins(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    Ok(Json(json!(oidc::pending())))
}

#[derive(Deserialize)]
struct OidcLoginQuery {
    id: String,
}

/// Gives up a waiting browser login; the connect that started it fails.
async fn oidc_cancel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<OidcLoginQuery>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    if !oidc::cancel(&params.id) {
        return Err(not_found("기다리는 OIDC 로그인이 없습니다"));
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct OidcCallback {
    state: Option<String>,
    code: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

/// Where the identity provider sends the browser back. No token comes
/// with it: the `state` names a login waiting here, and nothing else is
/// accepted. The page it shows only says what happened.
async fn oidc_callback(Query(params): Query<OidcCallback>) -> Response {
    let outcome = match (params.code, params.error) {
        (Some(code), None) => Ok(code),
        (_, error) => Err(match (error, params.error_description) {
            (Some(error), Some(description)) => format!("{error} ({description})"),
            (Some(error), None) => error,
            (None, _) => "IdP가 코드를 보내지 않았습니다".to_string(),
        }),
    };
    let failed = outcome.as_ref().err().cloned();
    let known = params
        .state
        .as_deref()
        .is_some_and(|login| oidc::finish(login, outcome));
    let (status, title, detail) = match (known, failed) {
        (false, _) => (
            StatusCode::BAD_REQUEST,
            "로그인을 기다리는 연결이 없습니다",
            "TablePeek에서 다시 연결하세요. This login is not waited for; connect again in TablePeek.".to_string(),
        ),
        (true, Some(error)) => (
            StatusCode::OK,
            "로그인하지 못했습니다",
            format!("Sign-in failed: {error}"),
        ),
        (true, None) => (
            StatusCode::OK,
            "로그인했습니다",
            "이 탭을 닫고 TablePeek으로 돌아가세요. Signed in; close this tab and return to TablePeek.".to_string(),
        ),
    };
    let escape = |text: &str| {
        text.replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
    };
    let page = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>TablePeek</title>\
         <body style=\"font: 14px system-ui; margin: 3em\"><h3>{}</h3><p>{}</p></body>",
        escape(title),
        escape(&detail)
    );
    (status, axum::response::Html(page)).into_response()
}

#[derive(Deserialize)]
struct SafeModeRequest {
    conn: Option<String>,
    // 0 off, 1 risky statements only, 2 every change; null returns to the default.
    mode: Option<u8>,
}

async fn safe_mode_set(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<SafeModeRequest>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    if req.mode.is_some_and(|mode| mode > 2) {
        return Err(bad_request(
            "invalid_request",
            "안전 모드는 0, 1, 2 중 하나입니다",
        ));
    }
    let scope = slot_for(&state, req.conn.as_deref()).await?.history_scope();
    let mut store = state.store.lock().await;
    // A profile deleted while still open keeps its mode for this session only.
    if store.scope_exists(&scope) {
        store.set_safe_mode(&scope, req.mode).map_err(store_error)?;
    }
    Ok(Json(json!({ "ok": true, "mode": req.mode })))
}

#[derive(Deserialize)]
struct NewFavoriteRequest {
    name: String,
    // May be empty: a new query starts out blank, like TablePlus's "Untitled".
    #[serde(default)]
    sql: String,
    keyword: Option<String>,
    folder: Option<String>,
}

#[derive(Deserialize)]
struct FavoriteUpdateRequest {
    name: Option<String>,
    sql: Option<String>,
    #[serde(default, deserialize_with = "present")]
    keyword: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    folder: Option<Option<String>>,
}

// Tells a field sent as null (Some(None)) from one left out (None).
fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

fn trimmed(value: String) -> Option<String> {
    Some(value.trim().to_string()).filter(|value| !value.is_empty())
}

fn unknown_folder() -> (StatusCode, Json<ApiError>) {
    bad_request("invalid_request", "폴더를 찾을 수 없습니다")
}

async fn favorites_list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let (favorites, folders) = {
        let store = state.store.lock().await;
        (store.favorites(), store.folders())
    };
    Ok(Json(json!({ "favorites": favorites, "folders": folders })))
}

async fn favorites_create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<NewFavoriteRequest>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let Some(name) = trimmed(req.name) else {
        return Err(bad_request("invalid_request", "이름이 필요합니다"));
    };
    // Kept as sent, like PUT: an editor tab bound to the new query matches it.
    let sql = req.sql;
    let keyword = req.keyword.and_then(trimmed);
    let folder = req.folder.and_then(trimmed);
    let id = uuid::Uuid::new_v4().simple().to_string();
    let now = unix_now();
    let mut store = state.store.lock().await;
    if folder
        .as_deref()
        .is_some_and(|folder| !store.has_folder(folder))
    {
        return Err(unknown_folder());
    }
    store
        .add_favorite(store::FavoriteEntry {
            id: id.clone(),
            name,
            sql,
            keyword,
            folder,
            created_at: now,
            updated_at: now,
        })
        .map_err(store_error)?;
    Ok(Json(json!({ "id": id })))
}

// Only the fields sent change; null clears the keyword or moves the query
// out of its folder. The SQL is kept as sent, untrimmed (as on create).
async fn favorites_update(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
    Json(req): Json<FavoriteUpdateRequest>,
) -> Result<Json<store::FavoriteEntry>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let name = match req.name {
        Some(name) => match trimmed(name) {
            Some(name) => Some(name),
            None => return Err(bad_request("invalid_request", "이름이 필요합니다")),
        },
        None => None,
    };
    let patch = store::FavoritePatch {
        name,
        sql: req.sql,
        keyword: req.keyword.map(|keyword| keyword.and_then(trimmed)),
        folder: req.folder.map(|folder| folder.and_then(trimmed)),
    };
    let mut store = state.store.lock().await;
    if let Some(Some(folder)) = &patch.folder {
        if !store.has_folder(folder) {
            return Err(unknown_folder());
        }
    }
    match store
        .update_favorite(&id, patch, unix_now())
        .map_err(store_error)?
    {
        Some(updated) => Ok(Json(updated)),
        None => Err(not_found("즐겨찾기를 찾을 수 없습니다")),
    }
}

async fn favorites_delete(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let removed = {
        let mut store = state.store.lock().await;
        store.remove_favorite(&id).map_err(store_error)?
    };
    if !removed {
        return Err(not_found("즐겨찾기를 찾을 수 없습니다"));
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct FolderRequest {
    name: String,
}

async fn folders_create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<FolderRequest>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let Some(name) = trimmed(req.name) else {
        return Err(bad_request("invalid_request", "폴더 이름이 필요합니다"));
    };
    let id = uuid::Uuid::new_v4().simple().to_string();
    state
        .store
        .lock()
        .await
        .add_folder(store::FavoriteFolder {
            id: id.clone(),
            name,
            created_at: unix_now(),
        })
        .map_err(store_error)?;
    Ok(Json(json!({ "id": id })))
}

async fn folders_update(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
    Json(req): Json<FolderRequest>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let Some(name) = trimmed(req.name) else {
        return Err(bad_request("invalid_request", "폴더 이름이 필요합니다"));
    };
    let renamed = state
        .store
        .lock()
        .await
        .rename_folder(&id, name)
        .map_err(store_error)?;
    if !renamed {
        return Err(not_found("폴더를 찾을 수 없습니다"));
    }
    Ok(Json(json!({ "ok": true })))
}

// The queries in the folder go with it.
async fn folders_delete(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let removed = state
        .store
        .lock()
        .await
        .remove_folder(&id)
        .map_err(store_error)?;
    if !removed {
        return Err(not_found("폴더를 찾을 수 없습니다"));
    }
    Ok(Json(json!({ "ok": true })))
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[derive(Deserialize)]
struct FsParams {
    path: Option<String>,
    #[serde(default)]
    hidden: bool,
}

async fn fs_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<FsParams>,
) -> Result<Json<FsListing>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    list_dir(params.path.as_deref(), params.hidden)
        .map(Json)
        .map_err(|err| {
            (
                StatusCode::BAD_REQUEST,
                Json(ApiError::new("fs_error", err.to_string())),
            )
        })
}

#[derive(Deserialize)]
struct StatParams {
    path: String,
}

async fn fs_stat(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<StatParams>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let path = params.path.trim();
    if path.is_empty() {
        return Err(bad_request("fs_error", "경로가 비어 있습니다"));
    }
    Ok(Json(path_stat(path)))
}

#[derive(Deserialize)]
struct PickFilterBody {
    name: String,
    extensions: Vec<String>,
}

#[derive(Deserialize)]
struct PickBody {
    title: String,
    #[serde(default)]
    filter: Option<PickFilterBody>,
    /// Folder to open in; a leading `~` is the home folder.
    #[serde(default)]
    dir: Option<String>,
    #[serde(default)]
    hidden: bool,
}

/// Shows the system's open-file dialog, answering in NDJSON as it goes:
/// `{"shown": true}` once the dialog is on screen, then one of
/// `{"path": …}` (null when cancelled) or `{"error": {"code", "message"}}`,
/// the code `native_picker_unavailable` where there is no such dialog and
/// `picker_busy` while another is up.
async fn fs_pick(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PickBody>,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let dir = body
        .dir
        .as_deref()
        .map(str::trim)
        .filter(|dir| !dir.is_empty())
        .map(|dir| match dir.strip_prefix('~') {
            Some(rest) if rest.is_empty() || rest.starts_with(['/', '\\']) => {
                default_dir().join(rest.trim_start_matches(['/', '\\']))
            }
            _ => PathBuf::from(dir),
        });
    let request = picker::PickRequest {
        title: body.title,
        filter: body.filter.map(|filter| picker::PickFilter {
            name: filter.name,
            extensions: filter.extensions,
        }),
        dir,
        hidden: body.hidden,
    };
    let (lines, mut rx) = mpsc::unbounded_channel::<Bytes>();
    tokio::task::spawn_blocking(move || {
        let line = |value: Value| Bytes::from(format!("{value}\n"));
        let picked = picker::pick_file(&request, &mut || {
            let _ = lines.send(line(json!({ "shown": true })));
        });
        let error =
            |code: &str, message: String| json!({ "error": { "code": code, "message": message } });
        let last = match picked {
            Ok(path) => json!({ "path": path }),
            Err(picker::PickError::Unavailable) => error(
                "native_picker_unavailable",
                "이 시스템에서는 파일 선택 창을 열 수 없습니다".into(),
            ),
            Err(picker::PickError::Busy) => {
                error("picker_busy", "파일 선택 창이 이미 열려 있습니다".into())
            }
            Err(picker::PickError::Failed(message)) => error("internal", message),
        };
        let _ = lines.send(line(last));
    });
    let stream = futures_util::stream::poll_fn(move |cx| {
        rx.poll_recv(cx)
            .map(|line| line.map(Ok::<_, std::convert::Infallible>))
    });
    Ok((
        [(header::CONTENT_TYPE, "application/x-ndjson")],
        Body::from_stream(stream),
    )
        .into_response())
}

// What this build is: GET /api/version.
async fn version_route(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<update::VersionInfo>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    Ok(Json(update::version_info()))
}

// Whether a newer release is out, checking GitHub when the last check is a
// day old and checks are on.
async fn update_status(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<update::UpdateStatus>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    Ok(Json(state.update.status().await))
}

// Settings' "Check now": checks whatever the time of the last check.
async fn update_check(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<update::UpdateStatus>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    Ok(Json(state.update.check_now().await))
}

// Turns checks on or off, or skips a release.
async fn update_configure(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(settings): Json<update::UpdateSettings>,
) -> Result<Json<update::UpdateStatus>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    state
        .update
        .configure(settings)
        .await
        .map(Json)
        .map_err(store_error)
}

/// The font families installed on this machine, for the settings' font
/// lists. The browser runs here too (the server listens on loopback only), so
/// what this finds is what a page can draw with. Read once, on first ask.
async fn fonts_route(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    static FAMILIES: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    if let Some(families) = FAMILIES.get() {
        return Ok(Json(families.clone()));
    }
    let found = tokio::task::spawn_blocking(installed_fonts)
        .await
        .map_err(|err| internal_error(err.to_string()))?;
    Ok(Json(FAMILIES.get_or_init(|| found).clone()))
}

/// One face of a family: its PostScript name, as TablePlus lists fonts.
struct InstalledFace {
    name: String,
    weight: u16,
    italic: bool,
}

/// One family as listed: its Korean name when it has one, monospaced when
/// all its faces are, and its faces.
struct InstalledFamily {
    korean: Option<String>,
    monospace: bool,
    faces: Vec<InstalledFace>,
}

/// Every family once, by the name CSS knows it by, with its Korean name when
/// the font has one (HYwulM is HY울릉도M), monospaced when all its faces are,
/// and every face of it by PostScript name (JetBrainsMonoNF-Regular), lighter
/// and upright first.
fn installed_fonts() -> Value {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    let mut families: HashMap<String, InstalledFamily> = HashMap::new();
    // A PostScript name names one font: listed once, under the family that
    // has it first.
    let mut seen: HashSet<String> = HashSet::new();
    for face in db.faces() {
        let Some((name, _)) = face.families.first() else {
            continue;
        };
        // macOS keeps the fonts of its own interface under names starting with a dot.
        if name.trim().is_empty() || name.starts_with('.') {
            continue;
        }
        let korean = face
            .families
            .iter()
            .find(|(local, language)| *language == fontdb::Language::Korean_Korea && local != name)
            .map(|(local, _)| local.clone());
        let entry = families.entry(name.clone()).or_insert(InstalledFamily {
            korean: None,
            monospace: true,
            faces: Vec::new(),
        });
        entry.korean = entry.korean.take().or(korean);
        entry.monospace &= face.monospaced;
        let postscript = face.post_script_name.trim();
        if !postscript.is_empty()
            && !postscript.starts_with('.')
            && seen.insert(postscript.to_string())
        {
            entry.faces.push(InstalledFace {
                name: postscript.to_string(),
                weight: face.weight.0,
                italic: face.style != fontdb::Style::Normal,
            });
        }
    }
    // A family whose every face is listed under another has nothing to pick.
    let mut list: Vec<(String, InstalledFamily)> = families
        .into_iter()
        .filter(|(_, family)| !family.faces.is_empty())
        .collect();
    list.sort_by_key(|(name, _)| name.to_lowercase());
    json!({
        "families": list
            .into_iter()
            .map(|(name, mut family)| {
                family
                    .faces
                    .sort_by(|a, b| (a.italic, a.weight, &a.name).cmp(&(b.italic, b.weight, &b.name)));
                json!({
                    "name": name,
                    "korean": family.korean,
                    "monospace": family.monospace,
                    "faces": family
                        .faces
                        .iter()
                        .map(|face| json!({ "name": face.name, "weight": face.weight, "italic": face.italic }))
                        .collect::<Vec<_>>(),
                })
            })
            .collect::<Vec<_>>(),
    })
}

fn path_stat(path: &str) -> Value {
    let requested = std::path::Path::new(path);
    match std::fs::metadata(requested) {
        Ok(metadata) => json!({
            "path": path,
            "exists": true,
            "is_file": metadata.is_file(),
            "readable": metadata.is_file() && std::fs::File::open(requested).is_ok(),
        }),
        Err(_) => json!({
            "path": path,
            "exists": false,
            "is_file": false,
            "readable": false,
        }),
    }
}

fn default_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

fn list_dir(path: Option<&str>, hidden: bool) -> Result<FsListing, std::io::Error> {
    let requested = match path {
        Some(p) if !p.trim().is_empty() => PathBuf::from(p.trim()),
        _ => default_dir(),
    };
    let dir = std::fs::canonicalize(&requested)?;

    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if !hidden && name.starts_with('.') {
            continue;
        }
        let file_type = entry.file_type()?;
        let kind = if file_type.is_dir() {
            "dir"
        } else if file_type.is_file() {
            "file"
        } else {
            continue;
        };
        let size = if kind == "file" {
            entry.metadata().ok().map(|m| m.len())
        } else {
            None
        };
        entries.push(FsEntry {
            name,
            path: entry.path().display().to_string(),
            kind: kind.to_string(),
            size,
        });
    }
    entries.sort_by(|a, b| {
        let a_dir = a.kind == "dir";
        let b_dir = b.kind == "dir";
        b_dir
            .cmp(&a_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(FsListing {
        path: dir.display().to_string(),
        parent: dir.parent().map(|p| p.display().to_string()),
        entries,
    })
}

#[derive(Deserialize)]
struct QueryRequest {
    sql: String,
    max_rows: Option<usize>,
}

async fn query(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<QueryRequest>,
) -> Result<Json<QueryResult>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }

    let slot = slot_for(&state, params.conn.as_deref()).await?;
    let max_rows = req.max_rows.unwrap_or(10_000).clamp(1, 500_000);
    let _inflight = InflightGuard::new(slot.inflight.clone());
    slot.gated(Holder::Foreground, false, async {
        slot.foreground_query(&req.sql, max_rows, None)
            .await
            .map(|data| QueryResult {
                columns: data.columns.clone(),
                row_count: data.row_count,
                rows: data.rows_json(),
                elapsed_ms: data.elapsed_ms,
                truncated: data.truncated,
            })
    })
    .await
    .map(Json)
    .map_err(engine_error)
}

#[derive(Deserialize)]
struct TableParams {
    name: Option<String>,
    conn: Option<String>,
}

async fn table_info(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<TableParams>,
) -> Result<Json<TableDetail>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let Some(name) = params
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
    else {
        return Err(bad_request("invalid_request", "테이블 이름이 필요합니다"));
    };
    let slot = slot_for(&state, params.conn.as_deref()).await?;
    slot.engine
        .table_detail(name)
        .await
        .map(Json)
        .map_err(engine_error)
}

async fn server_info_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
) -> Result<Json<ServerInfo>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let slot = slot_for(&state, params.conn.as_deref()).await?;
    slot.engine
        .server_info()
        .await
        .map(Json)
        .map_err(engine_error)
}

async fn objects_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
) -> Result<Json<DbObjects>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let slot = slot_for(&state, params.conn.as_deref()).await?;
    slot.engine
        .objects(params.include_system())
        .await
        .map(Json)
        .map_err(engine_error)
}

#[derive(Deserialize)]
struct DefinitionParams {
    kind: Option<String>,
    name: Option<String>,
    conn: Option<String>,
}

async fn definition_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<DefinitionParams>,
) -> Result<Json<ObjectDefinition>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let kind = params.kind.as_deref().unwrap_or("").trim();
    if !matches!(
        kind,
        "view"
            | "materialized_view"
            | "dictionary"
            | "function"
            | "procedure"
            | "trigger"
            | "sequence"
            | "type"
            | "aggregate"
            | "synonym"
            | "package"
    ) {
        return Err(bad_request(
            "invalid_request",
            "kind는 view/materialized_view/dictionary/function/procedure/trigger/sequence/type/aggregate/synonym/package 중 하나여야 합니다",
        ));
    }
    let Some(name) = params
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
    else {
        return Err(bad_request("invalid_request", "이름이 필요합니다"));
    };
    let slot = slot_for(&state, params.conn.as_deref()).await?;
    match slot.engine.object_definition(kind, name).await {
        Ok(Some(definition)) => Ok(Json(definition)),
        Ok(None) => Err(not_found("정의를 찾을 수 없습니다")),
        Err(err) => Err(engine_error(err)),
    }
}

// Document stores (/api/doc/*, docs/MONGODB.md §6). Bodies and replies are
// canonical Extended JSON. Reads run as the page's statement (a newer one
// or a cancel stops them); writes are never cancelled, and wait for a job's
// transaction like the grid's edits.

#[derive(Deserialize)]
struct DocParams {
    conn: Option<String>,
    #[serde(default)]
    db: String,
    #[serde(default)]
    coll: String,
}

/// Runs `$body` with the slot's document operations as `$ops`, gated like
/// any statement of the slot.
macro_rules! doc_call {
    ($slot:expr, $holder:expr, |$ops:ident| $body:expr) => {{
        let slot = &$slot;
        let _inflight = InflightGuard::new(slot.inflight.clone());
        slot.gated($holder, false, async {
            if $holder == Holder::Protected {
                slot.refused_while_job()?;
            }
            let session = slot.engine.document()?;
            let $ops = session.ops();
            $body.await
        })
        .await
        .map_err(engine_error)
    }};
}

/// Runs `$body` with the slot's document operations beside whatever holds
/// the connection, outside its gate. For reads that tag nothing a cancel
/// looks for (status, an export's cursor): a document store's client is a
/// pool of connections, not one session.
macro_rules! doc_beside {
    ($slot:expr, |$ops:ident| $body:expr) => {{
        let slot = &$slot;
        let _inflight = InflightGuard::new(slot.inflight.clone());
        async {
            let session = slot.engine.document()?;
            let $ops = session.ops();
            $body.await
        }
        .await
        .map_err(engine_error)
    }};
}

async fn doc_slot(
    state: &AppState,
    headers: &HeaderMap,
    conn: Option<&str>,
) -> Result<Arc<ConnSlot>, (StatusCode, Json<ApiError>)> {
    if !authorized(state, headers, None) {
        return Err(unauthorized());
    }
    slot_for(state, conn).await
}

async fn doc_databases(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<DocParams>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let slot = doc_slot(&state, &headers, params.conn.as_deref()).await?;
    let databases = doc_call!(slot, Holder::Foreground, |ops| ops.databases())?;
    Ok(Json(json!(databases)))
}

async fn doc_collections(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<DocParams>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let slot = doc_slot(&state, &headers, params.conn.as_deref()).await?;
    let collections = doc_call!(slot, Holder::Foreground, |ops| ops.collections(&params.db))?;
    Ok(Json(json!(collections)))
}

async fn doc_stats(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<DocParams>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let slot = doc_slot(&state, &headers, params.conn.as_deref()).await?;
    let stats = doc_call!(slot, Holder::Foreground, |ops| ops
        .stats(&params.db, &params.coll))?;
    Ok(Json(stats))
}

async fn doc_find(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<driver::FindRequest>,
) -> Result<Json<driver::DocBatch>, (StatusCode, Json<ApiError>)> {
    let slot = doc_slot(&state, &headers, params.conn.as_deref()).await?;
    doc_call!(slot, Holder::Foreground, |ops| ops.find(&req)).map(Json)
}

async fn doc_count(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<driver::CountRequest>,
) -> Result<Json<driver::CountResult>, (StatusCode, Json<ApiError>)> {
    let slot = doc_slot(&state, &headers, params.conn.as_deref()).await?;
    doc_call!(slot, Holder::Foreground, |ops| ops.count(&req)).map(Json)
}

async fn doc_aggregate(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<driver::AggregateRequest>,
) -> Result<Json<driver::DocBatch>, (StatusCode, Json<ApiError>)> {
    let slot = doc_slot(&state, &headers, params.conn.as_deref()).await?;
    let writes = driver::check_aggregate(&req).map_err(engine_error)?;
    // A pipeline that writes is never cancelled, like any other write.
    let holder = if writes {
        Holder::Protected
    } else {
        Holder::Foreground
    };
    doc_call!(slot, holder, |ops| ops.aggregate(&req)).map(Json)
}

async fn doc_distinct(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<driver::DistinctRequest>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let slot = doc_slot(&state, &headers, params.conn.as_deref()).await?;
    let values = doc_call!(slot, Holder::Foreground, |ops| ops.distinct(&req))?;
    Ok(Json(json!({ "values": values })))
}

async fn doc_insert(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<driver::InsertRequest>,
) -> Result<Json<driver::InsertOutcome>, (StatusCode, Json<ApiError>)> {
    let slot = doc_slot(&state, &headers, params.conn.as_deref()).await?;
    doc_call!(slot, Holder::Protected, |ops| ops.insert(&req)).map(Json)
}

async fn doc_update(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<driver::UpdateRequest>,
) -> Result<Json<driver::UpdateOutcome>, (StatusCode, Json<ApiError>)> {
    let slot = doc_slot(&state, &headers, params.conn.as_deref()).await?;
    driver::check_write(&req.filter, req.confirmed).map_err(engine_error)?;
    doc_call!(slot, Holder::Protected, |ops| ops.update(&req)).map(Json)
}

async fn doc_replace(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<driver::ReplaceRequest>,
) -> Result<Json<driver::UpdateOutcome>, (StatusCode, Json<ApiError>)> {
    let slot = doc_slot(&state, &headers, params.conn.as_deref()).await?;
    driver::check_write(&req.filter, req.confirmed).map_err(engine_error)?;
    doc_call!(slot, Holder::Protected, |ops| ops.replace(&req)).map(Json)
}

async fn doc_delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<driver::DeleteRequest>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let slot = doc_slot(&state, &headers, params.conn.as_deref()).await?;
    driver::check_write(&req.filter, req.confirmed).map_err(engine_error)?;
    let deleted = doc_call!(slot, Holder::Protected, |ops| ops.delete(&req))?;
    Ok(Json(json!({ "deleted": deleted })))
}

async fn doc_indexes(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<DocParams>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let slot = doc_slot(&state, &headers, params.conn.as_deref()).await?;
    let indexes = doc_call!(slot, Holder::Foreground, |ops| ops
        .indexes(&params.db, &params.coll))?;
    Ok(Json(json!(indexes)))
}

async fn doc_create_index(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<driver::CreateIndexRequest>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let slot = doc_slot(&state, &headers, params.conn.as_deref()).await?;
    let name = doc_call!(slot, Holder::Protected, |ops| ops.create_index(&req))?;
    Ok(Json(json!({ "name": name })))
}

async fn doc_drop_index(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<driver::DropIndexRequest>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let slot = doc_slot(&state, &headers, params.conn.as_deref()).await?;
    doc_call!(slot, Holder::Protected, |ops| ops.drop_index(&req))?;
    Ok(Json(json!({ "ok": true })))
}

async fn doc_explain(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<driver::ExplainRequest>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let slot = doc_slot(&state, &headers, params.conn.as_deref()).await?;
    doc_call!(slot, Holder::Foreground, |ops| ops.explain(&req)).map(Json)
}

/// Status reads and `killOp`, which run beside whatever holds the
/// connection: the client is a pool, and the performance tab must see (and
/// stop) the long query a tab is waiting on.
const DOC_MONITOR_COMMANDS: [&str; 6] = [
    "currentOp",
    "killOp",
    "top",
    "serverStatus",
    "hostInfo",
    "replSetGetStatus",
];

async fn doc_command(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<driver::CommandRequest>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let slot = doc_slot(&state, &headers, params.conn.as_deref()).await?;
    driver::check_command(&req).map_err(engine_error)?;
    let monitor = req
        .command
        .as_object()
        .and_then(|command| command.keys().next())
        .is_some_and(|name| DOC_MONITOR_COMMANDS.contains(&name.as_str()));
    if monitor {
        return doc_beside!(slot, |ops| ops.command(&req)).map(Json);
    }
    doc_call!(slot, Holder::Protected, |ops| ops.command(&req)).map(Json)
}

#[derive(Deserialize)]
struct SqlExportRequest {
    sql: String,
    #[serde(flatten)]
    export: driver::NativeExport,
}

/// What ends a native export that failed midway, on a line of its own: the
/// file so far is useless, and the page reads the error from it.
const EXPORT_ERROR_MARK: &str = "__tablepeek_error__";

/// Streams a read's whole result as a file the database writes itself
/// (ClickHouse's CSV and JSONEachRow), beside the page's statements. A
/// failure before the first byte is the usual error reply; one midway ends
/// the body with `\n__tablepeek_error__ {code, message}\n`.
async fn sql_export(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<SqlExportRequest>,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let slot = slot_for(&state, params.conn.as_deref()).await?;
    let chunks = slot
        .engine
        .export_native(&req.sql, &req.export)
        .await
        .map_err(engine_error)?;
    let body = chunks.map(|chunk| {
        Ok::<_, std::convert::Infallible>(match chunk {
            Ok(bytes) => Bytes::from(bytes),
            Err(err) => {
                let (_, Json(error)) = engine_error(err);
                Bytes::from(format!("\n{EXPORT_ERROR_MARK} {}\n", json!(error)))
            }
        })
    });
    let content_type = if req.export.format == "json" {
        "application/json; charset=utf-8"
    } else {
        "text/csv; charset=utf-8"
    };
    Ok((
        [(header::CONTENT_TYPE, content_type)],
        Body::from_stream(body),
    )
        .into_response())
}

/// A binary cell's whole value as a file, streamed as the session reads it
/// (`capabilities.binary_cells`). A failure midway breaks the response off,
/// so the page never takes a partial value for the whole.
async fn sql_cell_read(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(cell): Json<tablepeek_types::CellRef>,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let slot = slot_for(&state, params.conn.as_deref()).await?;
    let pieces = slot.engine.read_cell(&cell).await.map_err(engine_error)?;
    let body = pieces.map(|piece| piece.map(Bytes::from).map_err(std::io::Error::other));
    Ok((
        [(header::CONTENT_TYPE, "application/octet-stream")],
        Body::from_stream(body),
    )
        .into_response())
}

#[derive(Deserialize)]
struct CellWriteQuery {
    conn: Option<String>,
    /// The cell (`CellRef`) as JSON: the body is the new value's bytes.
    cell: String,
}

/// Replaces a binary cell with the request's body, passed to the session in
/// pieces as it arrives (no size limit; see `SqlDriver::write_cell`).
async fn sql_cell_write(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<CellWriteQuery>,
    body: Body,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let cell: tablepeek_types::CellRef = serde_json::from_str(&params.cell)
        .map_err(|err| bad_request("invalid_request", format!("셀을 읽을 수 없습니다: {err}")))?;
    let slot = slot_for(&state, params.conn.as_deref()).await?;
    let data = body
        .into_data_stream()
        .map(|piece| {
            piece.map(|bytes| bytes.to_vec()).map_err(|err| {
                EngineError::BadRequest(format!("올린 값을 끝까지 받지 못했습니다: {err}"))
            })
        })
        .boxed();
    let rows = slot
        .engine
        .write_cell(&cell, data)
        .await
        .map_err(engine_error)?;
    Ok(Json(json!({ "rows": rows })))
}

/// How long one `/api/sql/skip` or `/api/sql/count` call may work before it
/// answers with how far it got: the page shows that and calls again, or
/// stops there.
const STEP_BUDGET: std::time::Duration = std::time::Duration::from_millis(1500);

#[derive(Deserialize)]
struct SqlSkipRequest {
    sql: String,
    #[serde(flatten)]
    skip: driver::SkipRequest,
}

/// Passes rows of a data tab's statement on the server, so a far page is
/// reached without its rows coming to the page (engines that page by
/// token). One step at a time, as the page's own statement: Stop cancels it.
async fn sql_skip(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<SqlSkipRequest>,
) -> Result<Json<driver::SkipOutcome>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let slot = slot_for(&state, params.conn.as_deref()).await?;
    let _guard = InflightGuard::new(slot.inflight.clone());
    slot.gated(Holder::Foreground, false, async {
        slot.refused_while_job()?;
        slot.engine
            .skip_rows(&req.sql, &req.skip, STEP_BUDGET)
            .await
    })
    .await
    .map(Json)
    .map_err(engine_error)
}

#[derive(Deserialize)]
struct SqlCountRequest {
    sql: String,
    #[serde(default)]
    cursor: Option<String>,
}

/// One step of an exact count the engine splits (`count_steps`): the rows
/// of the parts counted this time and where the next step starts.
async fn sql_count(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<SqlCountRequest>,
) -> Result<Json<driver::CountStep>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let slot = slot_for(&state, params.conn.as_deref()).await?;
    let _guard = InflightGuard::new(slot.inflight.clone());
    slot.gated(Holder::Foreground, false, async {
        slot.refused_while_job()?;
        slot.engine
            .count_step(&req.sql, req.cursor.as_deref(), STEP_BUDGET)
            .await
    })
    .await
    .map(Json)
    .map_err(engine_error)
}

/// Streams a find or an aggregation as NDJSON: one canonical EJSON document
/// a line, then `{"$end": {"count": n}}`. A failure midway ends it with
/// `{"$error": {"code", "message"}}` instead. The client cancels by going
/// away: the stream is dropped, and the server's cursor with it.
async fn doc_export(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<driver::ExportRequest>,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    let slot = doc_slot(&state, &headers, params.conn.as_deref()).await?;
    // Read beside the page's statements: an export neither waits behind
    // them nor holds them up while the file downloads.
    let docs = doc_beside!(slot, |ops| ops.export(&req))?;
    let line = |value: Value| Bytes::from(format!("{value}\n"));
    let lines = futures_util::stream::unfold(Some((docs, 0u64)), move |state| async move {
        let (mut docs, count) = state?;
        Some(match docs.next().await {
            Some(Ok(doc)) => (line(doc), Some((docs, count + 1))),
            Some(Err(err)) => {
                let (_, Json(error)) = engine_error(err);
                let error = json!({ "$error": error });
                (line(error), None)
            }
            None => (line(json!({ "$end": { "count": count } })), None),
        })
    })
    .map(Ok::<_, std::convert::Infallible>);
    Ok((
        [(header::CONTENT_TYPE, "application/x-ndjson")],
        Body::from_stream(lines),
    )
        .into_response())
}

/// The server status the performance tab polls; read beside whatever holds
/// the connection, so the charts go on while a long query runs.
async fn doc_perf(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let slot = doc_slot(&state, &headers, params.conn.as_deref()).await?;
    doc_beside!(slot, |ops| ops.perf()).map(Json)
}

/// What an update would change, left undone: run as a read of the page.
async fn doc_update_preview(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<driver::UpdatePreviewRequest>,
) -> Result<Json<driver::UpdatePreview>, (StatusCode, Json<ApiError>)> {
    let slot = doc_slot(&state, &headers, params.conn.as_deref()).await?;
    driver::check_preview(&req).map_err(engine_error)?;
    doc_call!(slot, Holder::Foreground, |ops| ops.update_preview(&req)).map(Json)
}

async fn doc_search_indexes(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<DocParams>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let slot = doc_slot(&state, &headers, params.conn.as_deref()).await?;
    let indexes = doc_call!(slot, Holder::Foreground, |ops| ops
        .search_indexes(&params.db, &params.coll))?;
    Ok(Json(json!(indexes)))
}

async fn doc_create_search_index(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<driver::SearchIndexRequest>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let slot = doc_slot(&state, &headers, params.conn.as_deref()).await?;
    let name = doc_call!(slot, Holder::Protected, |ops| ops.create_search_index(&req))?;
    Ok(Json(json!({ "name": name })))
}

async fn doc_update_search_index(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<driver::SearchIndexRequest>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let slot = doc_slot(&state, &headers, params.conn.as_deref()).await?;
    doc_call!(slot, Holder::Protected, |ops| ops.update_search_index(&req))?;
    Ok(Json(json!({ "ok": true })))
}

async fn doc_drop_search_index(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<driver::DropSearchIndexRequest>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let slot = doc_slot(&state, &headers, params.conn.as_deref()).await?;
    driver::check_drop(req.confirmed, "검색 인덱스를").map_err(engine_error)?;
    doc_call!(slot, Holder::Protected, |ops| ops.drop_search_index(&req))?;
    Ok(Json(json!({ "ok": true })))
}

/// How often a change stream with nothing to say tells the page it is
/// still open (and finds out whether the page still listens).
const WATCH_HEARTBEAT: std::time::Duration = std::time::Duration::from_secs(15);

/// Streams a change stream as NDJSON: one change event (canonical EJSON) a
/// line, and `{"$heartbeat": <ms since the epoch>}` once it opens and every
/// 15 seconds. A failure ends it with `{"$error": {…}}`. The client stops
/// it by going away: the next line fails to go out, the stream is dropped,
/// and the server's cursor with it. Read beside the page's statements; it
/// may stay open for hours.
async fn doc_watch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<driver::WatchRequest>,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    let slot = doc_slot(&state, &headers, params.conn.as_deref()).await?;
    let events = doc_beside!(slot, |ops| ops.watch(&req))?;
    let line = |value: Value| Bytes::from(format!("{value}\n"));
    let heartbeat = tokio::time::interval(WATCH_HEARTBEAT);
    let lines = futures_util::stream::unfold(Some((events, heartbeat)), move |state| async move {
        let (mut events, mut heartbeat) = state?;
        // A change stream keeps its pending read across polls, so a
        // heartbeat cutting in loses no event.
        tokio::select! {
            event = events.next() => match event {
                Some(Ok(event)) => Some((line(event), Some((events, heartbeat)))),
                Some(Err(err)) => {
                    let (_, Json(error)) = engine_error(err);
                    Some((line(json!({ "$error": error })), None))
                }
                None => None,
            },
            _ = heartbeat.tick() => {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |since| since.as_millis() as u64);
                Some((line(json!({ "$heartbeat": now })), Some((events, heartbeat))))
            }
        }
    })
    .map(Ok::<_, std::convert::Infallible>);
    Ok((
        [
            (header::CONTENT_TYPE, "application/x-ndjson"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        Body::from_stream(lines),
    )
        .into_response())
}

async fn doc_gridfs_buckets(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<DocParams>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let slot = doc_slot(&state, &headers, params.conn.as_deref()).await?;
    let buckets = doc_call!(slot, Holder::Foreground, |ops| ops
        .gridfs_buckets(&params.db))?;
    Ok(Json(json!(buckets)))
}

async fn doc_gridfs_files(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<driver::GridFsFilesRequest>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let slot = doc_slot(&state, &headers, params.conn.as_deref()).await?;
    let files = doc_call!(slot, Holder::Foreground, |ops| ops.gridfs_files(&req))?;
    Ok(Json(json!({ "files": files })))
}

async fn doc_gridfs_delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<driver::GridFsFileRef>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let slot = doc_slot(&state, &headers, params.conn.as_deref()).await?;
    driver::check_drop(req.confirmed, "파일을").map_err(engine_error)?;
    doc_call!(slot, Holder::Protected, |ops| ops.gridfs_delete(&req))?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct GridFsDownloadParams {
    conn: Option<String>,
    #[serde(default)]
    db: String,
    #[serde(default)]
    bucket: String,
    /// The file's `_id` as canonical Extended JSON text.
    #[serde(default)]
    id: String,
    /// The token, for a plain link the browser saves (see `token_guard`).
    #[serde(default)]
    token: Option<String>,
}

/// Extended JSON text from a query parameter.
fn ejson_param(name: &str, text: &str) -> Result<Value, (StatusCode, Json<ApiError>)> {
    serde_json::from_str(text).map_err(|err| {
        bad_request(
            "bad_request",
            format!("{name}은(는) Extended JSON이어야 합니다: {err}"),
        )
    })
}

/// `attachment` with the name in RFC 5987 form, which keeps any script.
fn attachment(filename: &str) -> String {
    let mut encoded = String::with_capacity(filename.len());
    for byte in filename.bytes() {
        if byte.is_ascii_alphanumeric() || b"!#$&+-.^_`|~".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    format!("attachment; filename*=UTF-8''{encoded}")
}

/// A GridFS file's bytes, read from the server as they go out. Its name
/// rides in Content-Disposition and its length in Content-Length; a failure
/// midway cuts the reply short of that length.
async fn doc_gridfs_download(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<GridFsDownloadParams>,
) -> Result<Response, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, params.token.as_deref()) {
        return Err(unauthorized());
    }
    let slot = slot_for(&state, params.conn.as_deref()).await?;
    let req = driver::GridFsFileRef {
        db: params.db,
        bucket: params.bucket,
        id: ejson_param("id", &params.id)?,
        confirmed: false,
    };
    let file = doc_beside!(slot, |ops| ops.gridfs_download(&req))?;
    let bytes = file.bytes.map(|chunk| {
        chunk
            .map(Bytes::from)
            .map_err(|err| std::io::Error::other(err.to_string()))
    });
    let mut response = Body::from_stream(bytes).into_response();
    let reply = response.headers_mut();
    let content_type = file
        .content_type
        .as_deref()
        .and_then(|kind| header::HeaderValue::from_str(kind).ok())
        .unwrap_or(header::HeaderValue::from_static("application/octet-stream"));
    reply.insert(header::CONTENT_TYPE, content_type);
    reply.insert(
        header::CONTENT_LENGTH,
        header::HeaderValue::from(file.length),
    );
    if let Ok(disposition) =
        header::HeaderValue::from_str(&attachment(file.filename.as_deref().unwrap_or("file")))
    {
        reply.insert(header::CONTENT_DISPOSITION, disposition);
    }
    Ok(response)
}

#[derive(Deserialize)]
struct GridFsUploadParams {
    conn: Option<String>,
    #[serde(default)]
    db: String,
    #[serde(default)]
    bucket: String,
    #[serde(default)]
    filename: String,
    /// The file document's `metadata` as canonical Extended JSON text.
    #[serde(default)]
    metadata: Option<String>,
}

/// Stores the request body as a GridFS file, chunk by chunk as it arrives
/// (nothing holds the whole file). Beside the page's statements, like an
/// export: a big upload doesn't hold up the tabs. A body that breaks off
/// leaves no file behind.
async fn doc_gridfs_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<GridFsUploadParams>,
    body: Body,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let slot = doc_slot(&state, &headers, params.conn.as_deref()).await?;
    let req = driver::GridFsUploadRequest {
        db: params.db,
        bucket: params.bucket,
        filename: params.filename,
        metadata: params
            .metadata
            .as_deref()
            .filter(|text| !text.is_empty())
            .map(|text| ejson_param("metadata", text))
            .transpose()?,
    };
    let reader: driver::ByteReader = Box::pin(futures_util::TryStreamExt::into_async_read(
        body.into_data_stream()
            .map(|chunk| chunk.map_err(std::io::Error::other)),
    ));
    let id = doc_beside!(slot, |ops| ops.gridfs_upload(&req, reader))?;
    Ok(Json(json!({ "id": id })))
}

/// Opens a find or an aggregation as a cursor the page reads batch by batch
/// (`/api/doc/cursor/next`), answering the first batch. One read to the end
/// at once is closed already (`id` null). Beside the page's statements like
/// an export, except an aggregation that writes, which runs as a write.
async fn doc_cursor_open(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<driver::CursorOpenRequest>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let slot = doc_slot(&state, &headers, params.conn.as_deref()).await?;
    let writes = driver::check_cursor(&req).map_err(engine_error)?;
    let mut stream = if writes {
        doc_call!(slot, Holder::Protected, |ops| ops.cursor(&req))?
    } else {
        doc_beside!(slot, |ops| ops.cursor(&req))?
    };
    let (batch, done) = cursors::read_batch(&mut stream, req.batch_size as usize)
        .await
        .map_err(engine_error)?;
    let id = if done {
        Value::Null
    } else {
        Value::String(slot.cursors.insert(stream, req.batch_size))
    };
    Ok(Json(json!({ "id": id, "batch": batch, "done": done })))
}

#[derive(Deserialize)]
struct CursorNextRequest {
    id: String,
    /// 1–1000; the size the cursor was opened with if left out.
    #[serde(default, rename = "batchSize")]
    batch_size: Option<u32>,
}

/// The next batch of an open cursor. It closes once read to the end, or
/// when reading it fails.
async fn doc_cursor_next(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<CursorNextRequest>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let slot = doc_slot(&state, &headers, params.conn.as_deref()).await?;
    if let Some(size) = req.batch_size {
        driver::check_batch_size(size).map_err(engine_error)?;
    }
    let (mut stream, opened) = slot.cursors.take(&req.id).map_err(|miss| match miss {
        cursors::CursorMiss::Gone => {
            not_found("커서가 없습니다: 끝까지 읽었거나 닫혔거나 10분 동안 읽지 않아 닫혔습니다")
        }
        cursors::CursorMiss::Busy => {
            bad_request("cursor_busy", "이 커서는 다른 요청이 읽고 있습니다")
        }
    })?;
    let size = req.batch_size.unwrap_or(opened);
    match cursors::read_batch(&mut stream, size as usize).await {
        Ok((batch, done)) => {
            if done {
                slot.cursors.close(&req.id);
            } else {
                slot.cursors.put_back(&req.id, stream);
            }
            Ok(Json(json!({ "batch": batch, "done": done })))
        }
        Err(err) => {
            slot.cursors.close(&req.id);
            Err(engine_error(err))
        }
    }
}

#[derive(Deserialize)]
struct CursorCloseRequest {
    id: String,
}

/// Closes a cursor on the server; closing one already gone is fine.
async fn doc_cursor_close(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<CursorCloseRequest>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    let slot = doc_slot(&state, &headers, params.conn.as_deref()).await?;
    let closed = slot.cursors.close(&req.id);
    Ok(Json(json!({ "ok": true, "closed": closed })))
}

#[derive(Deserialize)]
struct KillRequest {
    session_id: String,
}

async fn kill_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<KillRequest>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    // A number on most engines; ClickHouse's query id (a UUID) and Oracle's
    // "sid,serial#" are not. The engine checks the form it takes.
    let id = req.session_id.trim();
    let id_char = |c: char| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ',' | '.' | ':');
    if id.is_empty() || id.len() > 128 || !id.chars().all(id_char) {
        return Err(bad_request(
            "invalid_request",
            "세션 ID가 올바르지 않습니다",
        ));
    }
    let slot = slot_for(&state, params.conn.as_deref()).await?;
    slot.engine
        .kill_session(id)
        .await
        .map(|_| Json(json!({ "ok": true })))
        .map_err(engine_error)
}

struct Sender {
    tx: mpsc::Sender<Message>,
    order: Arc<tokio::sync::Mutex<()>>,
    // The page's latest query per connection: the page drops what it was
    // still waiting for when it sends a newer one, so an older one still
    // waiting for the session is skipped rather than run for nobody.
    latest: Arc<std::sync::Mutex<HashMap<String, u64>>>,
}

impl Clone for Sender {
    fn clone(&self) -> Self {
        Self {
            tx: self.tx.clone(),
            order: self.order.clone(),
            latest: self.latest.clone(),
        }
    }
}

impl Sender {
    async fn json(&self, value: Value) {
        let _ = self.tx.send(Message::Text(value.to_string().into())).await;
    }

    async fn batch_json(&self, value: Value, batch: Option<Vec<u8>>) {
        let _guard = self.order.lock().await;
        if let Some(bytes) = batch {
            if self.tx.send(Message::Binary(bytes.into())).await.is_err() {
                return;
            }
        }
        let _ = self.tx.send(Message::Text(value.to_string().into())).await;
    }
}

#[derive(Deserialize)]
struct WsParams {
    token: Option<String>,
    conn: Option<String>,
}

async fn ws_upgrade(
    State(state): State<AppState>,
    Query(params): Query<WsParams>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !authorized(&state, &headers, params.token.as_deref()) {
        return unauthorized().into_response();
    }
    let bound = params
        .conn
        .map(|conn| conn.trim().to_string())
        .filter(|conn| !conn.is_empty());
    ws.on_upgrade(move |socket| ws_session(socket, state, bound))
}

fn message_conn<'a>(value: &'a Value, bound: Option<&'a str>, default_conn: &'a str) -> &'a str {
    value["conn"]
        .as_str()
        .map(str::trim)
        .filter(|conn| !conn.is_empty())
        .or(bound)
        .unwrap_or(default_conn)
}

async fn cancel_all_inflight(state: &AppState) {
    let slots = state.registry.lock().await.list();
    for slot in slots {
        slot.cancel_if_inflight();
    }
}

async fn ws_session(socket: WebSocket, state: AppState, bound: Option<String>) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::channel::<Message>(32);
    let writer = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });
    let sender = Sender {
        tx,
        order: Arc::new(tokio::sync::Mutex::new(())),
        latest: Arc::default(),
    };
    // Console forwarders by connection id; each holds a Sender clone.
    let mut consoles: HashMap<String, tokio::task::JoinHandle<()>> = HashMap::new();
    // Transaction commands, edits and row changes wait their turn at the
    // connection's gate; run here they would hold up this socket's other
    // messages (fetches, cancels, releases) meanwhile. Each connection's
    // run in order on a task of their own, which ends with the socket.
    let mut ordered: HashMap<String, mpsc::UnboundedSender<Value>> = HashMap::new();

    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(text) => {
                let parsed: Result<Value, _> = serde_json::from_str(text.as_str());
                let value = match parsed {
                    Ok(value) => value,
                    Err(_) => {
                        sender
                            .json(error_json(
                                None,
                                bound.as_deref(),
                                ApiError::new("bad_request", "잘못된 JSON 메시지"),
                                false,
                            ))
                            .await;
                        continue;
                    }
                };
                let conn =
                    message_conn(&value, bound.as_deref(), state.default_conn.as_ref()).to_string();
                match value["type"].as_str().unwrap_or("") {
                    "query" => handle_query(&state, &sender, &value, &conn).await,
                    "fetch" => handle_fetch(&state, &sender, &value, &conn).await,
                    // A job's reader is done with its result.
                    "release" => {
                        if let (Ok(slot), Some(id)) =
                            (slot_for(&state, Some(&conn)).await, value["id"].as_str())
                        {
                            slot.sessions.lock().await.remove(id);
                        }
                    }
                    "cancel" => {
                        if let Ok(slot) = slot_for(&state, Some(&conn)).await {
                            // A job's Stop reaches its own statement; the
                            // editor's, the page's.
                            if value["job"].as_bool().unwrap_or(false) {
                                slot.cancel_job();
                            } else {
                                slot.cancel_if_inflight();
                            }
                        }
                    }
                    "edit" | "insert_row" | "delete_row" | "tx" => {
                        let queue = ordered.entry(conn.clone()).or_insert_with(|| {
                            let (queue, mut pending) = mpsc::unbounded_channel::<Value>();
                            let state = state.clone();
                            let sender = sender.clone();
                            let conn = conn.clone();
                            tokio::spawn(async move {
                                while let Some(value) = pending.recv().await {
                                    match value["type"].as_str().unwrap_or("") {
                                        "edit" => handle_edit(&state, &sender, &value, &conn).await,
                                        "insert_row" => {
                                            handle_row_change(
                                                &state,
                                                &sender,
                                                &value,
                                                &conn,
                                                RowOp::Insert,
                                            )
                                            .await
                                        }
                                        "delete_row" => {
                                            handle_row_change(
                                                &state,
                                                &sender,
                                                &value,
                                                &conn,
                                                RowOp::Delete,
                                            )
                                            .await
                                        }
                                        _ => handle_tx(&state, &sender, &value, &conn).await,
                                    }
                                }
                            });
                            queue
                        });
                        let _ = queue.send(value.clone());
                    }
                    "console" => {
                        handle_console(&state, &sender, &value, &conn, &mut consoles).await
                    }
                    "console_unwatch" => stop_console(&mut consoles, &conn),
                    _ => {
                        sender
                            .json(error_json(
                                None,
                                Some(&conn),
                                ApiError::new("bad_request", "알 수 없는 메시지 타입"),
                                false,
                            ))
                            .await
                    }
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    // The writer ends once every Sender is gone: the forwarders' (aborted
    // here), this one, those of queries still finishing, and the ordered
    // tasks', which end once their queues (dropped here) are done.
    for console in consoles.values() {
        console.abort();
    }
    drop(ordered);
    cancel_all_inflight(&state).await;
    drop(sender);
    let _ = writer.await;
}

/// How long a console forwarder waits for more statements to send along.
const CONSOLE_BATCH: std::time::Duration = std::time::Duration::from_millis(10);

/// Replies with the connection's console entries after `since` and, unless
/// this socket already has one, starts a forwarder that pushes the
/// statements logged from then on.
async fn handle_console(
    state: &AppState,
    sender: &Sender,
    value: &Value,
    conn: &str,
    consoles: &mut HashMap<String, tokio::task::JoinHandle<()>>,
) {
    let slot = match slot_for(state, Some(conn)).await {
        Ok(slot) => slot,
        Err((_, Json(err))) => {
            sender.json(error_json(None, Some(conn), err, false)).await;
            return;
        }
    };
    let log = slot.engine.sql_log();
    let watching = consoles.get(conn).is_some_and(|task| !task.is_finished());
    // Subscribed before the snapshot so nothing logged in between is lost;
    // the forwarder skips what the reply already carries.
    let events = (!watching).then(|| log.subscribe());
    let since = value["since"].as_u64();
    let (entries, reset) = log.since(since);
    let newest = match entries.last() {
        Some(entry) => entry.seq,
        None if reset => 0,
        None => since.unwrap_or(0),
    };
    sender
        .json(json!({
            "type": "console",
            "conn": conn,
            "entries": entries,
            "reset": reset,
        }))
        .await;
    if let Some(events) = events {
        let forwarder = forward_console(
            Arc::downgrade(&slot),
            events,
            sender.clone(),
            conn.to_string(),
            newest,
        );
        consoles.insert(conn.to_string(), tokio::spawn(forwarder));
    }
}

/// Stops this socket's forwarder for `conn`, if it has one (the console panel
/// closed); a later "console" message starts a fresh one.
fn stop_console(consoles: &mut HashMap<String, tokio::task::JoinHandle<()>>, conn: &str) {
    if let Some(console) = consoles.remove(conn) {
        console.abort();
    }
}

/// Pushes statements newer than `newest` as they are logged, a few
/// milliseconds' worth per message. Having fallen too far behind it sends
/// the whole log again with `reset`; when the engine goes away it says so
/// and ends.
async fn forward_console(
    slot: std::sync::Weak<ConnSlot>,
    mut events: broadcast::Receiver<LogEntry>,
    sender: Sender,
    conn: String,
    mut newest: u64,
) {
    loop {
        let mut batch: Vec<LogEntry> = Vec::new();
        let mut deadline: Option<tokio::time::Instant> = None;
        let mut lagged = false;
        let mut closed = false;
        loop {
            let event = match deadline {
                None => events.recv().await,
                Some(deadline) => match tokio::time::timeout_at(deadline, events.recv()).await {
                    Ok(event) => event,
                    Err(_) => break,
                },
            };
            match event {
                Ok(entry) if entry.seq > newest => {
                    newest = entry.seq;
                    batch.push(entry);
                    deadline.get_or_insert_with(|| tokio::time::Instant::now() + CONSOLE_BATCH);
                }
                Ok(_) => {}
                Err(RecvError::Lagged(_)) => {
                    lagged = true;
                    break;
                }
                Err(RecvError::Closed) => {
                    closed = true;
                    break;
                }
            }
        }
        if lagged {
            if let Some(slot) = slot.upgrade() {
                let (entries, _) = slot.engine.sql_log().since(None);
                drop(slot);
                newest = entries.last().map_or(newest, |entry| entry.seq);
                sender
                    .json(json!({
                        "type": "console",
                        "conn": conn,
                        "entries": entries,
                        "reset": true,
                    }))
                    .await;
                continue;
            }
            closed = true;
        }
        if !batch.is_empty() {
            sender
                .json(json!({
                    "type": "console",
                    "conn": conn,
                    "entries": batch,
                    "reset": false,
                }))
                .await;
        }
        if closed {
            sender
                .json(json!({ "type": "console_closed", "conn": conn }))
                .await;
            return;
        }
    }
}

async fn handle_query(state: &AppState, sender: &Sender, value: &Value, conn: &str) {
    let id = value["id"].as_str().unwrap_or("").to_string();
    let sql = value["sql"].as_str().unwrap_or("").to_string();
    let max_rows = value["max_rows"]
        .as_u64()
        .unwrap_or(10_000)
        .clamp(1, 500_000) as usize;
    let window = value["window"].as_u64().unwrap_or(1000).clamp(1, 100_000) as usize;
    // Only statements the user ran from the editor go into history; table
    // browsing and paging send their own SELECTs without this flag.
    let record = value["history"].as_bool().unwrap_or(false);
    // A background job's read (an export's page): it neither cancels the
    // page's statement nor can be cancelled by the page's next one, and its
    // result is kept apart until the job releases it.
    let job = value["job"].as_bool().unwrap_or(false);
    // The rest of an earlier read's rows, on an engine that pages by token.
    let page = value["page"].as_str().map(str::to_string);
    if id.is_empty() || sql.trim().is_empty() {
        sender
            .json(error_json(
                None,
                Some(conn),
                ApiError::new("bad_request", "query 메시지에 id/sql이 필요합니다"),
                false,
            ))
            .await;
        return;
    }

    let slot = match slot_for(state, Some(conn)).await {
        Ok(slot) => slot,
        Err((_, Json(err))) => {
            sender
                .json(error_json(Some(&id), Some(conn), err, false))
                .await;
            return;
        }
    };

    // Settings' query time limit, sent with every statement (0: none).
    if let Some(secs) = value["timeout_secs"].as_u64() {
        slot.engine.set_query_timeout(secs);
    }

    // The page's queries replace one another (see Sender::latest).
    let seq = (!job).then(|| {
        slot.cancel_if_inflight();
        let mut latest = sender
            .latest
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let next = latest.get(conn).map_or(1, |seq| seq + 1);
        latest.insert(conn.to_string(), next);
        next
    });

    let state = state.clone();
    let sender = sender.clone();
    let conn = conn.to_string();
    let scope = record.then(|| slot.history_scope());
    tokio::spawn(async move {
        let _inflight = InflightGuard::new(slot.inflight.clone());
        let started = std::time::Instant::now();
        let superseded = || {
            let latest = sender
                .latest
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            seq.is_some() && latest.get(&conn) != seq.as_ref()
        };
        // Read inside the gate, so a transaction another statement ends (a
        // job's COMMIT queued before this one) isn't put down to this one.
        let ran = slot
            .gated(
                if job { Holder::Job } else { Holder::Foreground },
                job,
                async {
                    if superseded() {
                        return None;
                    }
                    let mark = slot.engine.sql_log().ends();
                    let outcome = if job {
                        slot.engine
                            .query_page(&sql, max_rows, page.as_deref())
                            .await
                    } else {
                        slot.foreground_query(&sql, max_rows, page.as_deref()).await
                    };
                    // Statements run here can open or close a transaction (or,
                    // failing, abort one): the page's indicator follows this.
                    let in_tx = slot.engine.in_tx().await.unwrap_or(false);
                    // One this statement ended (COMMIT or ROLLBACK typed here, a
                    // failed COMMIT, a deadlock) settles the cached results as
                    // the toolbar's do.
                    let ended = slot.engine.sql_log().ended_since(mark);
                    Some((outcome, in_tx, ended))
                },
            )
            .await;
        let Some((outcome, in_tx, ended)) = ran else {
            sender
                .json(error_json(
                    Some(&id),
                    Some(&conn),
                    ApiError::new("interrupted", "쿼리가 취소되었습니다"),
                    true,
                ))
                .await;
            return;
        };
        // An outcome nobody knows (a COMMIT lost with the connection, a
        // failed batch that also ended the transaction): reload, not revert.
        let reload = matches!(outcome, Err(EngineError::TxOutcomeUnknown(_)));
        let invalidate = settle_after_query(&slot, ended, reload).await;
        let tx_state = ended.map(|committed| if committed { "committed" } else { "rolledback" });
        if let Some(scope) = scope {
            // A statement that changes rows is filed with how many it changed.
            let summary = outcome.as_ref().map(|data| {
                let rows = data.rows_affected.map_or(data.row_count, |n| n as usize);
                (data.elapsed_ms, rows)
            });
            let entry = run_entry(scope, &sql, started, summary);
            let _ = file_history(&state.store, vec![entry]).await;
        }
        match outcome {
            Ok(data) => {
                let data = Arc::new(data);
                let mut meta = json!({
                    "type": "meta",
                    "conn": conn,
                    "id": id,
                    "kind": data.kind,
                    "columns": data.columns,
                    "row_count": data.row_count,
                    "elapsed_ms": data.elapsed_ms,
                    "truncated": data.truncated,
                    "source_table": data.source_table,
                    "pk": data.pk,
                    "column_kinds": data.column_kinds,
                    "rows_affected": data.rows_affected,
                    "in_tx": in_tx,
                });
                if let Some(page) = &data.next_page {
                    meta["next_page"] = json!(page);
                }
                if let Some(state) = tx_state {
                    meta["tx"] = json!(state);
                }
                if invalidate {
                    meta["invalidate"] = json!(true);
                }
                // Kept before the page hears of it: a job's release (or the
                // page's fetch) may come back the moment the meta arrives.
                {
                    let mut sessions = slot.sessions.lock().await;
                    if job {
                        sessions.insert_job(id.clone(), data.clone());
                    } else {
                        sessions.insert(id.clone(), data.clone());
                    }
                }
                {
                    let _guard = sender.order.lock().await;
                    if sender
                        .tx
                        .send(Message::Text(meta.to_string().into()))
                        .await
                        .is_err()
                    {
                        return;
                    }
                }
                if let Err(err) = send_window(&slot, &sender, &conn, &id, 0, window).await {
                    sender
                        .json(error_json(
                            Some(&id),
                            Some(&conn),
                            engine_error(err).1 .0,
                            false,
                        ))
                        .await;
                }
            }
            Err(err) => {
                let cancelled = err.is_interrupted();
                let error = if cancelled {
                    ApiError::new("interrupted", "쿼리가 취소되었습니다")
                } else {
                    engine_error(err).1 .0
                };
                let mut body = error_json(Some(&id), Some(&conn), error, cancelled);
                body["in_tx"] = json!(in_tx);
                if let Some(state) = tx_state {
                    body["tx"] = json!(state);
                }
                if invalidate {
                    body["invalidate"] = json!(true);
                }
                sender.json(body).await;
            }
        }
    });
}

async fn handle_fetch(state: &AppState, sender: &Sender, value: &Value, conn: &str) {
    let id = value["id"].as_str().unwrap_or("");
    let offset = value["offset"].as_u64().unwrap_or(0) as usize;
    let limit = value["limit"].as_u64().unwrap_or(1000).clamp(1, 100_000) as usize;
    let slot = match slot_for(state, Some(conn)).await {
        Ok(slot) => slot,
        Err((_, Json(err))) => {
            sender
                .json(error_json(value["id"].as_str(), Some(conn), err, false))
                .await;
            return;
        }
    };
    if let Err(err) = send_window(&slot, sender, conn, id, offset, limit).await {
        sender
            .json(error_json(
                Some(id),
                Some(conn),
                engine_error(err).1 .0,
                false,
            ))
            .await;
    }
}

async fn send_window(
    slot: &ConnSlot,
    sender: &Sender,
    conn: &str,
    id: &str,
    offset: usize,
    limit: usize,
) -> Result<(), EngineError> {
    let session = slot.sessions.lock().await.get(id).ok_or_else(|| {
        EngineError::Internal("세션이 만료되었습니다. 쿼리를 다시 실행하세요".into())
    })?;
    let (payload, count) = {
        let guard = session.lock().await;
        let (batch, count) = guard.data.slice_rows(offset, limit)?;
        let payload = if count > 0 {
            Some(guard.data.encode_ipc(&batch)?)
        } else {
            None
        };
        (payload, count)
    };
    let message =
        json!({"type": "window", "conn": conn, "id": id, "offset": offset, "count": count});
    sender.batch_json(message, payload).await;
    Ok(())
}

async fn handle_edit(state: &AppState, sender: &Sender, value: &Value, conn: &str) {
    #[derive(Deserialize)]
    struct PkMsg {
        column: String,
        value: Value,
    }
    #[derive(Deserialize)]
    struct EditMsg {
        session: String,
        table: String,
        pk: Vec<PkMsg>,
        column: String,
        value: Option<String>,
        // DEFAULT or the current time, which the database writes itself.
        #[serde(default)]
        expr: Option<ValueExpr>,
        row: Option<usize>,
        col: Option<usize>,
        // Every column of the row as the grid last knew it.
        #[serde(default)]
        seen: Vec<PkMsg>,
        // `value` is an amount to add to the column in one atomic write (a
        // CQL counter's increment), not the value it takes.
        #[serde(default)]
        add: bool,
    }

    let msg: EditMsg = match serde_json::from_value(value.clone()) {
        Ok(msg) => msg,
        Err(err) => {
            sender
                .json(error_json(
                    None,
                    Some(conn),
                    ApiError::new("bad_request", format!("edit 메시지 형식 오류: {err}")),
                    false,
                ))
                .await;
            return;
        }
    };

    let slot = match slot_for(state, Some(conn)).await {
        Ok(slot) => slot,
        Err((_, Json(err))) => {
            sender.json(error_json(None, Some(conn), err, false)).await;
            return;
        }
    };

    // Staged edits can outlive their result session (eviction, or a structural
    // change clearing sessions); the PK-targeted UPDATE does not need it, so a
    // missing session only skips the cached-cell patch below.
    let session_arc = slot.sessions.lock().await.get(&msg.session);
    if let Some(session_arc) = &session_arc {
        let guard = session_arc.lock().await;
        if guard.data.source_table.as_deref() != Some(msg.table.as_str()) {
            drop(guard);
            sender
                .json(error_json(
                    None,
                    Some(conn),
                    ApiError::new("not_editable", "이 결과는 편집할 수 없습니다"),
                    false,
                ))
                .await;
            return;
        }
    }

    let echo_value = msg.value.clone();
    let echo_column = msg.column.clone();
    let row = msg.row;
    let col = msg.col;
    let session_id = msg.session.clone();
    let add = msg.add;
    let seen: Vec<PkValue> = msg
        .seen
        .into_iter()
        .map(|p| PkValue {
            column: p.column,
            value: p.value,
        })
        .collect();
    let target = EditTarget {
        table: msg.table,
        pk: msg
            .pk
            .into_iter()
            .map(|p| PkValue {
                column: p.column,
                value: p.value,
            })
            .collect(),
        column: msg.column,
        value: msg.value,
        expr: msg.expr,
    };

    // Through the gate, never cancelled: an interrupted UPDATE leaves its
    // outcome unknown. Refused while a job's transaction is open.
    let outcome = slot
        .gated(Holder::Protected, false, async {
            slot.refused_while_job()?;
            if add {
                slot.engine.edit_add(&target).await
            } else {
                slot.engine.edit_seen(&target, &seen).await
            }
        })
        .await;
    match outcome {
        Ok(changed) if target.expr.is_some() || add => {
            // Only the database knows what DEFAULT, the time or a sum became,
            // so the cached cell isn't patched: the page reads the row again.
            // Inside a transaction the change counts as structural, so a
            // rollback drops the results read in the meantime.
            if slot.engine.in_tx().await.unwrap_or(false) {
                let mut store = slot.sessions.lock().await;
                store.mark_structural();
                if let Some(session_arc) = store.get(&session_id) {
                    session_arc
                        .lock()
                        .await
                        .journal
                        .push(JournalEntry::Structural);
                }
            }
            sender
                .json(json!({
                    "type": "edited",
                    "conn": conn,
                    "row": row,
                    "col": col,
                    "column": echo_column,
                    "value": Value::Null,
                    "expr": target.expr,
                    "add": add,
                    "rows_affected": changed,
                }))
                .await;
        }
        Ok(changed) => {
            if let (Some(row), Some(col)) = (row, col) {
                if let Some(session_arc) = slot.sessions.lock().await.get(&session_id) {
                    let in_tx = slot.engine.in_tx().await.unwrap_or(false);
                    let mut guard = session_arc.lock().await;
                    let old = guard.data.cell_string(row, col);
                    if guard
                        .data
                        .patch_cell(row, col, echo_value.as_deref())
                        .is_ok()
                        && in_tx
                    {
                        guard.journal.push(JournalEntry::Cell { row, col, old });
                    }
                }
            }
            sender
                .json(json!({
                    "type": "edited",
                    "conn": conn,
                    "row": row,
                    "col": col,
                    "column": echo_column,
                    "value": echo_value,
                    "rows_affected": changed,
                }))
                .await;
        }
        Err(err) => {
            sender
                .json(error_json(None, Some(conn), engine_error(err).1 .0, false))
                .await;
        }
    }
}

#[derive(Clone, Copy)]
enum RowOp {
    Insert,
    Delete,
}

impl RowOp {
    fn label(self) -> &'static str {
        match self {
            RowOp::Insert => "insert",
            RowOp::Delete => "delete",
        }
    }
}

async fn handle_row_change(
    state: &AppState,
    sender: &Sender,
    value: &Value,
    conn: &str,
    op: RowOp,
) {
    let id = value["id"].as_str().unwrap_or("").to_string();
    let session_id = value["session"].as_str().unwrap_or("").to_string();
    let table = value["table"].as_str().unwrap_or("").trim().to_string();
    if table.is_empty() {
        sender
            .json(error_json(
                Some(&id),
                Some(conn),
                ApiError::new("bad_request", "table 값이 필요합니다"),
                false,
            ))
            .await;
        return;
    }

    let slot = match slot_for(state, Some(conn)).await {
        Ok(slot) => slot,
        Err((_, Json(err))) => {
            sender
                .json(error_json(Some(&id), Some(conn), err, false))
                .await;
            return;
        }
    };

    let outcome: Result<u64, EngineError> = match op {
        RowOp::Insert => match parse_insert_values(&value["values"]) {
            Ok(values) => {
                slot.gated(Holder::Protected, false, async {
                    slot.refused_while_job()?;
                    slot.engine.insert_values(&table, &values).await
                })
                .await
            }
            Err(message) => {
                sender
                    .json(error_json(
                        Some(&id),
                        Some(conn),
                        ApiError::new("bad_request", message),
                        false,
                    ))
                    .await;
                return;
            }
        },
        RowOp::Delete => match parse_pk_values(&value["pk"]) {
            Ok(pk) => {
                // The row as the grid last knew it; none from older pages.
                let seen = parse_pk_values(&value["seen"]).unwrap_or_default();
                slot.gated(Holder::Protected, false, async {
                    slot.refused_while_job()?;
                    slot.engine.delete_row_seen(&table, &pk, &seen).await
                })
                .await
            }
            Err(message) => {
                sender
                    .json(error_json(
                        Some(&id),
                        Some(conn),
                        ApiError::new("bad_request", message),
                        false,
                    ))
                    .await;
                return;
            }
        },
    };

    match outcome {
        Ok(changed) => {
            let in_tx = slot.engine.in_tx().await.unwrap_or(false);
            {
                let mut store = slot.sessions.lock().await;
                if in_tx {
                    store.mark_structural();
                    if let Some(session_arc) = store.get(&session_id) {
                        let mut guard = session_arc.lock().await;
                        guard.journal.push(JournalEntry::Structural);
                    }
                }
                store.clear();
            }
            sender
                .json(json!({
                    "type": "row_change",
                    "conn": conn,
                    "id": id,
                    "op": op.label(),
                    "rows_affected": changed,
                    "invalidate": true,
                }))
                .await;
        }
        Err(err) => {
            sender
                .json(error_json(
                    Some(&id),
                    Some(conn),
                    engine_error(err).1 .0,
                    false,
                ))
                .await;
        }
    }
}

fn parse_insert_values(entries: &Value) -> Result<Vec<InsertValue>, String> {
    let Some(items) = entries.as_array() else {
        return Err("values 배열이 필요합니다".into());
    };
    let mut values = Vec::with_capacity(items.len());
    for item in items {
        let Some(column) = item["column"]
            .as_str()
            .map(str::trim)
            .filter(|c| !c.is_empty())
        else {
            return Err("values 항목에 column이 필요합니다".into());
        };
        let value = match &item["value"] {
            Value::Null => None,
            Value::String(text) => Some(text.clone()),
            Value::Number(number) => Some(number.to_string()),
            Value::Bool(flag) => Some(if *flag { "true".into() } else { "false".into() }),
            _ => return Err("value는 문자열 또는 null이어야 합니다".into()),
        };
        // A named expression only ("default", "now"); never SQL text.
        let expr = match &item["expr"] {
            Value::Null => None,
            other => Some(
                serde_json::from_value::<ValueExpr>(other.clone())
                    .map_err(|_| "expr는 default 또는 now여야 합니다".to_string())?,
            ),
        };
        values.push(InsertValue {
            column: column.to_string(),
            value,
            expr,
        });
    }
    Ok(values)
}

fn parse_pk_values(entries: &Value) -> Result<Vec<PkValue>, String> {
    let Some(items) = entries.as_array() else {
        return Err("pk 배열이 필요합니다".into());
    };
    if items.is_empty() {
        return Err("PK 조건이 필요합니다".into());
    }
    let mut pk = Vec::with_capacity(items.len());
    for item in items {
        let Some(column) = item["column"]
            .as_str()
            .map(str::trim)
            .filter(|c| !c.is_empty())
        else {
            return Err("pk 항목에 column이 필요합니다".into());
        };
        pk.push(PkValue {
            column: column.to_string(),
            value: item["value"].clone(),
        });
    }
    Ok(pk)
}

async fn handle_tx(state: &AppState, sender: &Sender, value: &Value, conn: &str) {
    let action = value["action"].as_str().unwrap_or("");
    let slot = match slot_for(state, Some(conn)).await {
        Ok(slot) => slot,
        Err((_, Json(err))) => {
            sender.json(error_json(None, Some(conn), err, false)).await;
            return;
        }
    };
    // An import's own transaction: while it is open the page's statements
    // can't cancel anything (see cancel_if_inflight), and the page's own
    // transaction commands (from any tab) are refused.
    let job = value["job"].as_bool().unwrap_or(false);
    if !matches!(action, "begin" | "commit" | "rollback") {
        sender
            .json(error_json(
                None,
                Some(conn),
                ApiError::new("bad_request", "알 수 없는 tx action"),
                false,
            ))
            .await;
        return;
    }
    // A transaction command is never cancelled: an interrupted COMMIT leaves
    // its outcome unknown.
    let result = slot
        .gated(Holder::Protected, job, async {
            if !job {
                slot.refused_while_job()?;
            }
            match action {
                "begin" => slot.engine.begin_tx().await.map(|_| "began"),
                "commit" => slot.engine.commit_tx().await.map(|_| "committed"),
                _ => slot.engine.rollback_tx().await.map(|_| "rolledback"),
            }
        })
        .await;
    // A COMMIT that ended the transaction without committing (an aborted
    // PostgreSQL transaction, a session a cancel killed), or whose outcome
    // was lost with the connection: the page sees the transaction closed,
    // its cells reverted (reloaded when unsure), then why.
    let (result, action, closed) = match result {
        Err(EngineError::TxRolledBack(reason)) => {
            (Ok("rolledback"), "rollback", Some((reason, false)))
        }
        Err(EngineError::TxOutcomeUnknown(reason)) => {
            (Ok("rolledback"), "rollback", Some((reason, true)))
        }
        other => (other, action, None),
    };
    let reload = closed.as_ref().is_some_and(|(_, unknown)| *unknown);
    match result {
        Ok(state_label) => {
            // BEGIN, like COMMIT, starts the journal afresh.
            let invalidate = settle_sessions(&slot, action != "rollback", reload).await;
            let mut body = json!({"type": "tx", "conn": conn, "state": state_label});
            if invalidate {
                body["invalidate"] = json!(true);
            }
            // Whether the COMMIT went through is not known (the connection
            // dropped with it): the page mustn't take it as rolled back.
            if reload {
                body["unknown"] = json!(true);
            }
            sender.json(body).await;
            if let Some((reason, _)) = closed {
                sender
                    .json(error_json(
                        None,
                        Some(conn),
                        ApiError::new(
                            if reload {
                                "tx_outcome_unknown"
                            } else {
                                "tx_rolled_back"
                            },
                            reason,
                        ),
                        false,
                    ))
                    .await;
            }
        }
        Err(err) => {
            sender
                .json(error_json(None, Some(conn), engine_error(err).1 .0, false))
                .await;
        }
    }
}

/// What an editor query that ended the transaction (`ended`: whether it
/// committed), or left its outcome unknown, means for the cached results;
/// true when they were dropped.
async fn settle_after_query(slot: &ConnSlot, ended: Option<bool>, unknown: bool) -> bool {
    match ended {
        Some(committed) => settle_sessions(slot, committed, unknown).await,
        None if unknown => settle_sessions(slot, false, true).await,
        None => false,
    }
}

/// What a transaction's end means for the cached results. Committed, their
/// values stand and the journal starts afresh. Rolled back, edited cells
/// return to their old values, or, when rows came or went (or `reload`
/// asks), the results are dropped: true, the page must fetch them again.
async fn settle_sessions(slot: &ConnSlot, committed: bool, reload: bool) -> bool {
    if committed {
        apply_journal(slot, "commit").await;
        slot.sessions.lock().await.reset_structural();
        return false;
    }
    if take_structural(slot).await || reload {
        slot.sessions.lock().await.clear();
        true
    } else {
        apply_journal(slot, "rollback").await;
        false
    }
}

async fn take_structural(slot: &ConnSlot) -> bool {
    let mut store = slot.sessions.lock().await;
    let flag = store.take_structural();
    let sessions = store.snapshot();
    drop(store);
    let mut marker = false;
    for session_arc in sessions {
        let guard = session_arc.lock().await;
        if guard
            .journal
            .iter()
            .any(|entry| matches!(entry, JournalEntry::Structural))
        {
            marker = true;
            break;
        }
    }
    flag || marker
}

async fn apply_journal(slot: &ConnSlot, action: &str) {
    let sessions = slot.sessions.lock().await.snapshot();
    for session_arc in sessions {
        let mut guard = session_arc.lock().await;
        if action == "rollback" {
            let entries: Vec<JournalEntry> = std::mem::take(&mut guard.journal);
            let session: &mut QuerySession = &mut guard;
            for entry in entries.into_iter().rev() {
                if let JournalEntry::Cell { row, col, old } = entry {
                    let _ = session.data.patch_cell(row, col, old.as_deref());
                }
            }
        } else {
            guard.journal.clear();
        }
    }
}

/// A WebSocket error: the REST reply's fields (`code`, `message`, and what
/// else the database said) with the message's `id` and `conn`.
fn error_json(id: Option<&str>, conn: Option<&str>, error: ApiError, cancelled: bool) -> Value {
    let mut body = json!(redacted(error));
    body["type"] = json!("error");
    body["id"] = json!(id);
    body["cancelled"] = json!(cancelled);
    if let Some(conn) = conn {
        body["conn"] = json!(conn);
    }
    body
}

#[cfg(test)]
mod tests {
    use super::*;
    use tablepeek_engine::sql_log::Dialect;

    #[test]
    fn list_dir_sorts_and_skips_hidden() {
        let base = std::env::temp_dir().join(format!(
            "tablepeek-fs-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(base.join("zdir")).unwrap();
        std::fs::create_dir_all(base.join("adir")).unwrap();
        std::fs::write(base.join("note.txt"), b"hi").unwrap();
        std::fs::write(base.join(".hidden"), b"x").unwrap();

        let listing = list_dir(Some(base.to_str().unwrap()), false).unwrap();
        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["adir", "zdir", "note.txt"]);
        assert_eq!(listing.entries[2].size, Some(2));

        let with_hidden = list_dir(Some(base.to_str().unwrap()), true).unwrap();
        let names: Vec<&str> = with_hidden
            .entries
            .iter()
            .map(|e| e.name.as_str())
            .collect();
        assert_eq!(names, vec!["adir", "zdir", ".hidden", "note.txt"]);
        assert!(listing.parent.is_some());

        std::fs::remove_dir_all(&base).unwrap();
    }

    #[test]
    fn path_stat_reports_file_and_missing_path() {
        let base = std::env::temp_dir().join(format!(
            "tablepeek-stat-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&base).unwrap();
        let file = base.join("note.txt");
        std::fs::write(&file, b"hi").unwrap();

        let found = path_stat(file.to_str().unwrap());
        assert_eq!(found["exists"], true);
        assert_eq!(found["is_file"], true);
        assert_eq!(found["readable"], true);

        let missing = path_stat(base.join("nope.txt").to_str().unwrap());
        assert_eq!(missing["exists"], false);
        assert_eq!(missing["is_file"], false);
        assert_eq!(missing["readable"], false);

        std::fs::remove_dir_all(&base).unwrap();
    }

    #[tokio::test]
    async fn slot_summary_is_dropped_after_a_statement() {
        let slot = ConnSlot::new(
            "c1".into(),
            "demo".into(),
            None,
            None,
            Engine::open_demo(10).unwrap(),
        );
        assert!(slot.summary().is_none());

        let before = slot.engine.epoch();
        let meta = slot.refresh_summary(false).await.unwrap();
        let tables = meta.tables.len();
        assert_eq!(slot.summary().unwrap().table_count, tables);

        slot.engine
            .query("CREATE TABLE summary_extra (x INTEGER)", 10)
            .await
            .unwrap();
        assert!(
            slot.summary().is_none(),
            "a statement may have changed the schema"
        );

        slot.refresh_summary(false).await.unwrap();
        assert_eq!(slot.summary().unwrap().table_count, tables + 1);

        // Meta read before the CREATE must not replace the newer summary.
        slot.remember(before, &meta);
        assert_eq!(slot.summary().unwrap().table_count, tables + 1);
    }

    #[tokio::test]
    async fn index_loads_without_token_for_refresh() {
        let response = index().await;
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[test]
    fn session_store_evicts_oldest() {
        let engine = Engine::open_demo(3).unwrap();
        let rt = tokio::runtime::Runtime::new().unwrap();
        let data = Arc::new(
            rt.block_on(engine.query("SELECT id FROM demo", 10))
                .unwrap(),
        );

        let mut store = SessionStore::new(2);
        store.insert("a".into(), data.clone());
        store.insert("b".into(), data.clone());
        store.insert("c".into(), data.clone());
        assert!(store.get("a").is_none());
        assert!(store.get("b").is_some());
        assert!(store.get("c").is_some());

        store.insert("b".into(), data.clone());
        store.insert("d".into(), data);
        assert!(store.get("b").is_some());
    }

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tablepeek-server-test-{}-{}-{name}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn test_state(dir: &std::path::Path) -> AppState {
        let mut registry = Registry::new();
        registry.insert(Arc::new(ConnSlot::new(
            "main".into(),
            "테스트 DB".into(),
            None,
            None,
            Engine::open_demo(3).unwrap(),
        )));
        AppState {
            registry: Arc::new(tokio::sync::Mutex::new(registry)),
            default_conn: "main".into(),
            token: "test-token".into(),
            demo_rows: 3,
            allowed_hosts: Arc::new(vec!["127.0.0.1:1".into()]),
            store: Arc::new(tokio::sync::Mutex::new(store::StoreFile::load(dir))),
            update: Arc::new(update::UpdateChecker::new(
                dir,
                update::RELEASES_URL.into(),
                update::VERSION,
                true,
            )),
        }
    }

    fn test_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-tablepeek-token", "test-token".parse().unwrap());
        headers
    }

    fn connect_request(value: Value) -> ConnectRequest {
        serde_json::from_value(value).unwrap()
    }

    fn test_connect_request(driver: &str) -> ConnectRequest {
        connect_request(json!({
            "driver": driver,
            "config": {
                "host": "127.0.0.1", "port": 5433, "user": "tablepeek",
                "password": "tablepeek_test_pw", "database": "tablepeek_test", "ssl_mode": "disable"
            }
        }))
    }

    fn test_mysql_connect_request() -> ConnectRequest {
        connect_request(json!({
            "driver": "mysql",
            "config": {
                "host": "127.0.0.1", "port": 3307, "user": "root",
                "password": "root_pw", "database": "tablepeek_test", "ssl_mode": "disable"
            }
        }))
    }

    fn test_cockroach_connect_request() -> ConnectRequest {
        connect_request(json!({
            "driver": "cockroach",
            "config": {
                "host": "127.0.0.1", "port": 26258, "user": "root",
                "database": "defaultdb", "ssl_mode": "disable"
            }
        }))
    }

    fn test_mssql_connect_request() -> ConnectRequest {
        connect_request(json!({
            "driver": "mssql",
            "config": {
                "host": "127.0.0.1", "port": 14330, "user": "sa",
                "password": "MsSql_test_pw1", "database": "tablepeek_test", "encrypt": false
            }
        }))
    }

    async fn connect_for_test(state: &AppState, req: ConnectRequest) -> Result<(), ConnectError> {
        let origin = SlotOrigin {
            label: None,
            saved_id: None,
        };
        connect_with(state, req, origin).await.map(|_| ())
    }

    #[tokio::test]
    async fn engines_route_lists_every_descriptor() {
        let dir = temp_dir("engines-route");
        let state = test_state(&dir);
        let err = engines_route(State(state.clone()), HeaderMap::new())
            .await
            .unwrap_err();
        assert_eq!(err.0, StatusCode::UNAUTHORIZED);
        let listed = engines_route(State(state), test_headers()).await.unwrap().0;
        let engines = listed["engines"].as_array().unwrap();
        let ids: Vec<&str> = engines.iter().map(|e| e["id"].as_str().unwrap()).collect();
        assert_eq!(
            ids,
            [
                "postgres",
                "mysql",
                "mssql",
                "oracle",
                "clickhouse",
                "cassandra",
                "scylladb",
                "cockroach",
                "sqlite",
                "mongodb",
                "elasticsearch",
                "opensearch"
            ]
        );
        let postgres = &engines[0];
        for key in [
            "aliases",
            "label",
            "paradigm",
            "family",
            "transport",
            "default_port",
            "url_schemes",
            "capabilities",
            "connection",
        ] {
            assert!(postgres.get(key).is_some(), "{key}");
        }
        assert_eq!(postgres["paradigm"], json!("sql"));
        assert_eq!(postgres["default_port"], json!(5432));
        assert_eq!(postgres["capabilities"]["explain"], json!("pg-json"));
        assert_eq!(postgres["capabilities"]["sessions"]["kill"], json!(true));
        let fields = postgres["connection"]["fields"].as_array().unwrap();
        let password = fields.iter().find(|f| f["key"] == "password").unwrap();
        assert_eq!(password["type"], json!("secret"));
        assert_eq!(password["label"], json!("비밀번호"));
        assert_eq!(
            postgres["connection"]["detail"],
            json!("{user}@{host}:{port}/{database}")
        );
        let by_id = |id: &str| engines.iter().find(|engine| engine["id"] == id).unwrap();
        let cockroach = by_id("cockroach");
        assert_eq!(cockroach["family"], json!("postgres"));
        let sqlite = by_id("sqlite");
        assert_eq!(sqlite["transport"], json!("file"));
        assert!(sqlite.get("default_port").is_none());
        assert_eq!(sqlite["connection"]["tunnels"], json!([]));
        assert_eq!(sqlite["capabilities"]["databases"], json!("none"));
        let mongodb = by_id("mongodb");
        assert_eq!(mongodb["paradigm"], json!("document"));
        assert_eq!(mongodb["capabilities"]["language"], json!("mongo"));
        assert_eq!(mongodb["error_code_prefix"], json!("mongo"));
        assert_eq!(mongodb["url_schemes"], json!(["mongodb", "mongodb+srv"]));
        for id in ["elasticsearch", "opensearch"] {
            let search = by_id(id);
            assert_eq!(search["paradigm"], json!("search"));
            assert_eq!(search["capabilities"]["language"], json!("es-dsl"));
            assert_eq!(search["error_code_prefix"], json!("es"));
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn meta_carries_capabilities() {
        let dir = temp_dir("meta-capabilities");
        let state = test_state(&dir);
        let meta = meta(
            State(state),
            test_headers(),
            Query(ConnQuery {
                conn: None,
                system: None,
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(meta.kind, "sqlite");
        let capabilities = meta.capabilities.expect("meta has capabilities");
        assert_eq!(capabilities.language, "sql");
        assert_eq!(capabilities.explain.as_deref(), Some("sqlite"));
        assert!(!capabilities.users);
        let body = serde_json::to_value(
            registry::factory("sqlite")
                .unwrap()
                .descriptor()
                .capabilities
                .clone(),
        )
        .unwrap();
        assert_eq!(serde_json::to_value(&capabilities).unwrap(), body);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn saving_an_unknown_engine_fails_loudly() {
        let dir = temp_dir("save-unknown");
        let state = test_state(&dir);
        let err = connections_create(
            State(state.clone()),
            test_headers(),
            Json(NewConnectionRequest {
                name: "x".into(),
                connect: connect_request(json!({ "driver": "db2", "config": { "host": "h" } })),
                persist_password: false,
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1.code, "unsupported_driver");
        assert_eq!(err.1.message, "지원하지 않는 엔진: db2");
        assert!(state.store.lock().await.data().connections.is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn connection_string_passwords_are_never_saved_or_shown() {
        let dir = temp_dir("uri-passwords");
        let state = test_state(&dir);
        // Typed, not pasted: the string still carries user:password@.
        let created = connections_create(
            State(state.clone()),
            test_headers(),
            Json(NewConnectionRequest {
                name: "몽고".into(),
                connect: connect_request(json!({
                    "driver": "mongodb",
                    "config": { "uri": "mongodb://app:s3cret%21@db.internal:27017/shop?authSource=admin" }
                })),
                persist_password: false,
            }),
        )
        .await
        .unwrap();
        let id = created.0["id"].as_str().unwrap().to_string();
        let raw = std::fs::read_to_string(dir.join("store.json")).unwrap();
        assert!(!raw.contains("s3cret"), "{raw}");
        let listed = connections_list(State(state.clone()), test_headers())
            .await
            .unwrap()
            .0;
        assert_eq!(
            listed["connections"][0]["config"]["uri"],
            json!("mongodb://app@db.internal:27017/shop?authSource=admin")
        );
        assert!(!listed.to_string().contains("s3cret"));

        // A profile saved before passwords were taken out shows and exports without it.
        let mut legacy = state
            .store
            .lock()
            .await
            .find_connection(&id)
            .cloned()
            .unwrap();
        legacy
            .config
            .insert("uri".into(), json!("mongodb://app:old-pw@db.internal/shop"));
        state
            .store
            .lock()
            .await
            .update_connection(legacy.clone())
            .unwrap();
        let listed = connections_list(State(state.clone()), test_headers())
            .await
            .unwrap()
            .0;
        assert_eq!(
            listed["connections"][0]["config"]["uri"],
            json!("mongodb://app@db.internal/shop")
        );
        let exported = transfer::export_connect(&legacy, |_| None);
        assert_eq!(
            exported["config"]["uri"],
            json!("mongodb://app@db.internal/shop")
        );
        assert!(!exported.to_string().contains("old-pw"));
        let with_secret = transfer::export_connect(&legacy, |kind| {
            (kind == "mongodb").then(|| "kept".to_string())
        });
        assert_eq!(with_secret["config"]["password"], json!("kept"));
        assert!(!with_secret.to_string().contains("old-pw"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn connection_info_leaves_every_secret_out() {
        let config: ConnConfig = serde_json::from_value(json!({
            "uri": "mongodb://app:uri-pw@db:27018/shop?authSource=admin",
            "user": "app",
            "password": "field-pw",
            "aws_session_token": "token-pw",
            "database": "shop"
        }))
        .unwrap();
        let shown = public_config("mongodb", &config);
        let text = serde_json::to_string(&shown).unwrap();
        for secret in ["uri-pw", "field-pw", "token-pw"] {
            assert!(!text.contains(secret), "{text}");
        }
        assert_eq!(
            shown["uri"],
            json!("mongodb://app@db:27018/shop?authSource=admin")
        );
        assert_eq!(shown["user"], json!("app"));
        assert_eq!(shown["database"], json!("shop"));

        let config: ConnConfig =
            serde_json::from_value(json!({ "host": "db", "user": "u", "password": "pg-pw" }))
                .unwrap();
        let shown = public_config("postgres", &config);
        assert!(!shown.contains_key("password"));
        assert_eq!(shown["host"], json!("db"));
    }

    #[test]
    fn error_messages_hide_url_passwords() {
        let err = engine_error(EngineError::Driver {
            engine: "mongodb",
            code: None,
            message: "bad uri mongodb://app:s3cret@db/shop".into(),
            interrupted: false,
            fields: Box::new(ErrorFields {
                raw: Some("Kind: bad uri mongodb://app:s3cret@db/shop, labels: {}".into()),
                ..ErrorFields::default()
            }),
        });
        assert_eq!(err.1.message, "bad uri mongodb://app:****@db/shop");
        assert_eq!(
            err.1.fields.raw.as_deref(),
            Some("Kind: bad uri mongodb://app:****@db/shop, labels: {}")
        );
        let err = connect_failed("SSH via postgres://u:pw@h/d").into_response();
        assert_eq!(err.1.message, "SSH via postgres://u:****@h/d");
        let body = error_json(
            None,
            None,
            ApiError::new("bad_request", "x mysql://root:pw@h:3306/d"),
            false,
        );
        assert_eq!(body["message"], json!("x mysql://root:****@h:3306/d"));
    }

    #[tokio::test]
    async fn saved_profiles_list_in_the_new_shape_without_secrets() {
        let dir = temp_dir("list-new-shape");
        let state = test_state(&dir);
        // An alias saves under the engine's own id; the password stays out.
        let created = connections_create(
            State(state.clone()),
            test_headers(),
            Json(NewConnectionRequest {
                name: "마리아".into(),
                connect: connect_request(json!({
                    "driver": "mariadb",
                    "config": { "host": "db", "port": 3306, "user": "u", "password": "pw", "database": "d" }
                })),
                persist_password: false,
            }),
        )
        .await
        .unwrap();
        assert!(created.0["id"].is_string());
        let listed = connections_list(State(state), test_headers())
            .await
            .unwrap()
            .0;
        let item = &listed["connections"][0];
        assert_eq!(item["driver"], json!("mysql"));
        assert_eq!(item["config"]["host"], json!("db"));
        assert!(item["config"].get("password").is_none());
        assert!(item.get("mysql").is_none());
        assert_eq!(item["has_password"], json!(false));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn doc_params(conn: Option<&str>, db: &str, coll: &str) -> Query<DocParams> {
        Query(DocParams {
            conn: conn.map(str::to_string),
            db: db.into(),
            coll: coll.into(),
        })
    }

    fn conn_query(conn: Option<&str>) -> Query<ConnQuery> {
        Query(ConnQuery {
            conn: conn.map(str::to_string),
            system: None,
        })
    }

    fn body<T: serde::de::DeserializeOwned>(value: Value) -> Json<T> {
        Json(serde_json::from_value(value).unwrap())
    }

    #[tokio::test]
    async fn doc_routes_refuse_sql_engines_and_unsafe_writes() {
        let dir = temp_dir("doc-routes");
        let state = test_state(&dir);
        let err = doc_databases(
            State(state.clone()),
            HeaderMap::new(),
            doc_params(None, "", ""),
        )
        .await
        .unwrap_err();
        assert_eq!(err.0, StatusCode::UNAUTHORIZED);
        // The default slot is SQLite: no document operations.
        let err = doc_find(
            State(state.clone()),
            test_headers(),
            conn_query(None),
            body(json!({ "db": "d", "coll": "c", "filter": {}, "limit": 20 })),
        )
        .await
        .unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1.code, "unsupported_capability");
        // A write with an empty filter needs confirming, one document or many.
        for (route, request) in [
            (
                "update",
                json!({ "db": "d", "coll": "c", "filter": {}, "update": { "$set": { "a": 1 } }, "many": true }),
            ),
            (
                "update",
                json!({ "db": "d", "coll": "c", "filter": {}, "update": { "$set": { "a": 2 } }, "many": false }),
            ),
            (
                "delete",
                json!({ "db": "d", "coll": "c", "filter": {}, "many": true }),
            ),
            (
                "delete",
                json!({ "db": "d", "coll": "c", "filter": null, "many": false }),
            ),
            (
                "replace",
                json!({ "db": "d", "coll": "c", "filter": {}, "replacement": {} }),
            ),
            (
                "command",
                json!({ "db": "d", "command": { "shutdown": 1 } }),
            ),
            ("command", json!({ "db": "d", "command": { "drop": "c" } })),
            (
                "command",
                json!({ "db": "d", "command": { "dropDatabase": 1 } }),
            ),
            (
                "command",
                json!({ "db": "d", "command": { "collMod": "c", "validationLevel": "off" } }),
            ),
            (
                "command",
                json!({ "db": "admin", "command": { "killOp": 1, "op": 7 } }),
            ),
            ("command", json!({ "db": "d", "command": { "profile": 2 } })),
            (
                "command",
                json!({ "db": "d", "command": { "renameCollection": "d.a", "to": "d.b" }, "confirmed": true }),
            ),
            (
                "aggregate",
                json!({ "db": "d", "coll": "c", "pipeline": [{ "$out": "copy" }] }),
            ),
            (
                "aggregate",
                json!({ "db": "d", "coll": "c", "pipeline": [{ "$merge": { "into": "copy" } }] }),
            ),
        ] {
            let err = match route {
                "update" => doc_update(
                    State(state.clone()),
                    test_headers(),
                    conn_query(None),
                    body(request),
                )
                .await
                .map(|_| ())
                .unwrap_err(),
                "delete" => doc_delete(
                    State(state.clone()),
                    test_headers(),
                    conn_query(None),
                    body(request),
                )
                .await
                .map(|_| ())
                .unwrap_err(),
                "replace" => doc_replace(
                    State(state.clone()),
                    test_headers(),
                    conn_query(None),
                    body(request),
                )
                .await
                .map(|_| ())
                .unwrap_err(),
                "aggregate" => doc_aggregate(
                    State(state.clone()),
                    test_headers(),
                    conn_query(None),
                    body(request),
                )
                .await
                .map(|_| ())
                .unwrap_err(),
                _ => doc_command(
                    State(state.clone()),
                    test_headers(),
                    conn_query(None),
                    body(request),
                )
                .await
                .map(|_| ())
                .unwrap_err(),
            };
            assert_eq!(
                (err.0, err.1.code.as_str()),
                (StatusCode::BAD_REQUEST, "bad_request"),
                "{route}"
            );
        }
        // Any other filter passes the rule, `_id` or not, as does a confirmed
        // empty one: on this SQLite slot they then meet the missing
        // document operations.
        for request in [
            json!({ "db": "d", "coll": "c", "filter": { "status": "x" }, "update": { "$set": { "a": 1 } } }),
            json!({ "db": "d", "coll": "c", "filter": {}, "update": { "$set": { "a": 1 } }, "many": true, "confirmed": true }),
        ] {
            let err = doc_update(
                State(state.clone()),
                test_headers(),
                conn_query(None),
                body(request),
            )
            .await
            .map(|_| ())
            .unwrap_err();
            assert_eq!(err.1.code, "unsupported_capability");
        }
        let err = doc_replace(
            State(state.clone()),
            test_headers(),
            conn_query(None),
            body(json!({ "db": "d", "coll": "c", "filter": { "sku": "A-1" }, "replacement": { "sku": "A-1" } })),
        )
        .await
        .map(|_| ())
        .unwrap_err();
        assert_eq!(err.1.code, "unsupported_capability");
        // Allowed requests of the new routes meet the SQLite slot's missing
        // document operations, the read commands with no confirmation.
        for command in [
            json!({ "db": "d", "command": { "create": "c", "capped": true, "size": 4096 } }),
            json!({ "db": "admin", "command": { "currentOp": 1 } }),
            json!({ "db": "d", "command": { "profile": -1 } }),
            json!({ "db": "admin", "command": { "renameCollection": "d.a", "to": "d.b" }, "confirmed": true }),
        ] {
            let err = doc_command(
                State(state.clone()),
                test_headers(),
                conn_query(None),
                body(command.clone()),
            )
            .await
            .unwrap_err();
            assert_eq!(err.1.code, "unsupported_capability", "{command}");
        }
        let err = doc_aggregate(
            State(state.clone()),
            test_headers(),
            conn_query(None),
            body(json!({ "db": "d", "coll": "c", "pipeline": [{ "$out": "copy" }], "confirmed": true })),
        )
        .await
        .unwrap_err();
        assert_eq!(err.1.code, "unsupported_capability");
        let err = doc_export(
            State(state.clone()),
            test_headers(),
            conn_query(None),
            body(json!({ "db": "d", "coll": "c" })),
        )
        .await
        .unwrap_err();
        assert_eq!(err.1.code, "unsupported_capability");
        let err = doc_perf(State(state.clone()), test_headers(), conn_query(None))
            .await
            .unwrap_err();
        assert_eq!(err.1.code, "unsupported_capability");
        // Phase 4 routes: their own rules first, then the missing document
        // operations of the SQLite slot.
        let preview = |limit: u32| {
            doc_update_preview(
                State(state.clone()),
                test_headers(),
                conn_query(None),
                body(
                    json!({ "db": "d", "coll": "c", "update": { "$set": { "a": 1 } }, "limit": limit }),
                ),
            )
        };
        assert_eq!(preview(21).await.unwrap_err().1.code, "bad_request");
        assert_eq!(preview(0).await.unwrap_err().1.code, "bad_request");
        // An empty filter needs no confirmation: a preview changes nothing.
        assert_eq!(
            preview(20).await.unwrap_err().1.code,
            "unsupported_capability"
        );
        let drop_search = |confirmed: bool| {
            doc_drop_search_index(
                State(state.clone()),
                test_headers(),
                conn_query(None),
                body(json!({ "db": "d", "coll": "c", "name": "default", "confirmed": confirmed })),
            )
        };
        assert_eq!(drop_search(false).await.unwrap_err().1.code, "bad_request");
        assert_eq!(
            drop_search(true).await.unwrap_err().1.code,
            "unsupported_capability"
        );
        let delete_file = |confirmed: bool| {
            doc_gridfs_delete(
                State(state.clone()),
                test_headers(),
                conn_query(None),
                body(
                    json!({ "db": "d", "bucket": "fs", "id": { "$oid": "65f1a0c2b7e4d3a1f0e9c8b7" }, "confirmed": confirmed }),
                ),
            )
        };
        assert_eq!(delete_file(false).await.unwrap_err().1.code, "bad_request");
        assert_eq!(
            delete_file(true).await.unwrap_err().1.code,
            "unsupported_capability"
        );
        let err = doc_search_indexes(
            State(state.clone()),
            test_headers(),
            doc_params(None, "d", "c"),
        )
        .await
        .unwrap_err();
        assert_eq!(err.1.code, "unsupported_capability");
        let err = doc_watch(
            State(state.clone()),
            test_headers(),
            conn_query(None),
            body(json!({ "db": "d" })),
        )
        .await
        .unwrap_err();
        assert_eq!(err.1.code, "unsupported_capability");
        let download = |headers: HeaderMap, token: Option<&str>, id: &str| {
            doc_gridfs_download(
                State(state.clone()),
                headers,
                Query(GridFsDownloadParams {
                    conn: None,
                    db: "d".into(),
                    bucket: "fs".into(),
                    id: id.into(),
                    token: token.map(str::to_string),
                }),
            )
        };
        let oid = r#"{"$oid":"65f1a0c2b7e4d3a1f0e9c8b7"}"#;
        assert_eq!(
            download(test_headers(), None, "not json")
                .await
                .unwrap_err()
                .1
                .code,
            "bad_request"
        );
        assert_eq!(
            download(test_headers(), None, oid)
                .await
                .unwrap_err()
                .1
                .code,
            "unsupported_capability"
        );
        // A plain link carries the token in the query instead.
        assert_eq!(
            download(HeaderMap::new(), Some("test-token"), oid)
                .await
                .unwrap_err()
                .1
                .code,
            "unsupported_capability"
        );
        assert_eq!(
            download(HeaderMap::new(), Some("old-token"), oid)
                .await
                .unwrap_err()
                .0,
            StatusCode::UNAUTHORIZED
        );
        let err = doc_gridfs_upload(
            State(state.clone()),
            test_headers(),
            Query(GridFsUploadParams {
                conn: None,
                db: "d".into(),
                bucket: "fs".into(),
                filename: "a.bin".into(),
                metadata: None,
            }),
            Body::from("abc"),
        )
        .await
        .unwrap_err();
        assert_eq!(err.1.code, "unsupported_capability");
        // Cursors: their rules, then the SQLite slot; unknown ids.
        let open = |request: Value| {
            doc_cursor_open(
                State(state.clone()),
                test_headers(),
                conn_query(None),
                body(request),
            )
        };
        for refused in [
            json!({ "db": "d", "coll": "c", "find": {}, "batchSize": 0 }),
            json!({ "db": "d", "coll": "c", "find": {}, "batchSize": 1001 }),
            json!({ "db": "d", "coll": "c" }),
            json!({ "db": "d", "coll": "c", "aggregate": { "pipeline": [{ "$out": "x" }] } }),
        ] {
            assert_eq!(
                open(refused.clone()).await.unwrap_err().1.code,
                "bad_request",
                "{refused}"
            );
        }
        assert_eq!(
            open(json!({ "db": "d", "coll": "c", "find": {} }))
                .await
                .unwrap_err()
                .1
                .code,
            "unsupported_capability"
        );
        let next = |request: Value| {
            doc_cursor_next(
                State(state.clone()),
                test_headers(),
                conn_query(None),
                body(request),
            )
        };
        let err = next(json!({ "id": "nope" })).await.unwrap_err();
        assert_eq!(
            (err.0, err.1.code.as_str()),
            (StatusCode::NOT_FOUND, "not_found")
        );
        let err = next(json!({ "id": "nope", "batchSize": 0 }))
            .await
            .unwrap_err();
        assert_eq!(err.1.code, "bad_request");
        let closed = doc_cursor_close(
            State(state.clone()),
            test_headers(),
            conn_query(None),
            body(json!({ "id": "nope" })),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(closed, json!({ "ok": true, "closed": false }));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn downloads_name_the_file_in_any_script() {
        assert_eq!(
            attachment("report.pdf"),
            "attachment; filename*=UTF-8''report.pdf"
        );
        assert_eq!(
            attachment("월 보고서 \"1\".pdf"),
            "attachment; filename*=UTF-8''%EC%9B%94%20%EB%B3%B4%EA%B3%A0%EC%84%9C%20%221%22.pdf"
        );
    }

    #[test]
    fn mongo_errors_keep_their_code_and_words() {
        let err = engine_error(EngineError::Driver {
            engine: "mongodb",
            code: Some("11000".into()),
            message: "E11000 duplicate key error".into(),
            interrupted: false,
            fields: Box::new(ErrorFields {
                server_code: Some(11000),
                code_name: Some("DuplicateKey".into()),
                ..ErrorFields::default()
            }),
        });
        assert_eq!(err.1.code, "mongo_11000");
        assert_eq!(err.1.message, "E11000 duplicate key error");
        // Without a code (a network error), the engine's usual one.
        let err = engine_error(EngineError::Driver {
            engine: "mongodb",
            code: None,
            message: "connection refused".into(),
            interrupted: false,
            fields: Box::default(),
        });
        assert_eq!(err.1.code, "mongodb_error");
        let err = engine_error(EngineError::Driver {
            engine: "postgres",
            code: Some("42P01".into()),
            message: "relation missing".into(),
            interrupted: false,
            fields: Box::new(ErrorFields {
                sqlstate: Some("42P01".into()),
                position: Some(tablepeek_types::ErrorPosition {
                    offset: Some(15),
                    ..Default::default()
                }),
                ..ErrorFields::default()
            }),
        });
        assert_eq!(err.1.code, "postgres_error");
        // The fields sit beside code and message, the unknown ones left out.
        let body = serde_json::to_value(&err.1 .0).unwrap();
        assert_eq!(
            body,
            json!({
                "code": "postgres_error",
                "message": "relation missing",
                "sqlstate": "42P01",
                "position": { "offset": 15 },
            })
        );
        // A WebSocket error carries the same fields.
        let frame = error_json(Some("q1"), Some("c1"), err.1 .0, false);
        assert_eq!(frame["type"], json!("error"));
        assert_eq!(frame["code"], json!("postgres_error"));
        assert_eq!(frame["sqlstate"], json!("42P01"));
        assert_eq!(frame["position"], json!({ "offset": 15 }));
    }

    #[tokio::test]
    async fn wrong_token_is_invalid_token_everywhere() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let dir = temp_dir("invalid-token");
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host = listener.local_addr().unwrap().to_string();
        let state = AppState {
            allowed_hosts: Arc::new(vec![host.clone()]),
            ..test_state(&dir)
        };
        let server = tokio::spawn(async move { axum::serve(listener, app(state)).await });
        // A body the route can't read and a WebSocket handshake: the stale
        // token is still what the reply names.
        let ws = "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n\
                  Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n";
        for (method, path, extra) in [
            ("GET", "/api/meta", ""),
            ("GET", "/api/connections", ""),
            ("POST", "/api/doc/aggregate", ""),
            ("POST", "/api/doc/command", ""),
            ("GET", "/api/ws?token=old-token", ws),
            ("GET", "/api/doc/gridfs/download?token=old-token&id=1", ""),
            ("POST", "/api/doc/gridfs/upload?token=test-token", ""),
        ] {
            let mut stream = tokio::net::TcpStream::connect(&host).await.unwrap();
            let request = format!(
                "{method} {path} HTTP/1.1\r\nHost: {host}\r\nx-tablepeek-token: old-token\r\n\
                 Content-Type: application/json\r\nContent-Length: 2\r\n{extra}\
                 Connection: close\r\n\r\n{{}}"
            );
            stream.write_all(request.as_bytes()).await.unwrap();
            let mut reply = String::new();
            stream.read_to_string(&mut reply).await.unwrap();
            assert!(reply.starts_with("HTTP/1.1 401"), "{path}: {reply}");
            let body = reply.split("\r\n\r\n").nth(1).unwrap_or("");
            let body: Value = serde_json::from_str(body).unwrap();
            assert_eq!(body["code"], json!("invalid_token"), "{path}");
        }
        server.abort();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn doc_routes_against_mongodb() {
        if std::env::var("TABLEPEEK_TEST_MONGODB").is_err() {
            return;
        }
        let dir = temp_dir("doc-mongo");
        let state = test_state(&dir);
        let request = connect_request(json!({
            "driver": "mongodb",
            "config": { "host": "127.0.0.1", "port": 27018, "user": "tablepeek",
                        "password": "tablepeek_test_pw", "direct_connection": true }
        }));
        let (slot, meta) = connect_with(
            &state,
            request,
            SlotOrigin {
                label: None,
                saved_id: None,
            },
        )
        .await
        .map_err(|err| err.message)
        .unwrap();
        assert_eq!(meta.kind, "mongodb");
        assert_eq!(slot.label, "tablepeek@127.0.0.1:27018/");
        assert_eq!(
            meta.capabilities.as_ref().unwrap().transactions,
            "replica_set"
        );
        assert!(slot.history_scope().starts_with(store::SESSION_PREFIX));
        let conn = Some(slot.id.as_str());
        let databases = doc_databases(
            State(state.clone()),
            test_headers(),
            doc_params(conn, "", ""),
        )
        .await
        .unwrap()
        .0;
        assert!(databases
            .as_array()
            .unwrap()
            .iter()
            .any(|db| db["name"] == "shop"));
        assert!(databases[0].get("sizeOnDisk").is_some());
        let collections = doc_collections(
            State(state.clone()),
            test_headers(),
            doc_params(conn, "shop", ""),
        )
        .await
        .unwrap()
        .0;
        assert!(collections
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["name"] == "orders" && c["type"] == "collection"));
        let found = doc_find(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(json!({ "db": "shop", "coll": "orders", "filter": {}, "limit": 3, "maxTimeMS": 5000 })),
        )
        .await
        .unwrap()
        .0;
        let found = serde_json::to_value(found).unwrap();
        assert_eq!(found["docs"].as_array().unwrap().len(), 3);
        assert!(found["elapsedMs"].is_number());
        let counted = doc_count(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(json!({ "db": "shop", "coll": "orders", "filter": {} })),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(
            serde_json::to_value(counted).unwrap(),
            json!({ "count": 2000, "exact": false })
        );
        // SQL routes say what this engine can't do.
        let err = schema_route(State(state.clone()), test_headers(), conn_query(conn))
            .await
            .unwrap_err();
        assert_eq!(err.1.code, "unsupported_capability");

        let coll = format!("tp_route_{}", uuid::Uuid::new_v4().simple());
        let inserted = doc_insert(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(json!({ "db": "tablepeek_test", "coll": coll, "docs": [{ "_id": 1 }] })),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(
            serde_json::to_value(inserted).unwrap(),
            json!({ "insertedIds": [{ "$numberInt": "1" }], "errors": [] })
        );
        // Unordered (an import): the failures are listed and the rest go in.
        let unordered = doc_insert(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(
                json!({ "db": "tablepeek_test", "coll": coll, "ordered": false,
                         "docs": [{ "_id": 1 }, { "_id": 2 }, { "_id": 3 }] }),
            ),
        )
        .await
        .unwrap()
        .0;
        let unordered = serde_json::to_value(unordered).unwrap();
        assert_eq!(
            unordered["insertedIds"],
            json!([{ "$numberInt": "2" }, { "$numberInt": "3" }])
        );
        assert_eq!(unordered["errors"][0]["index"], json!(0));
        assert_eq!(unordered["errors"][0]["code"], json!("mongo_11000"));
        assert_eq!(unordered["errors"].as_array().unwrap().len(), 1);
        // Ordered, asked explicitly (an import that stops at the first
        // failure): 200 with what went in before it and the failure.
        let stopped = doc_insert(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(
                json!({ "db": "tablepeek_test", "coll": coll, "ordered": true,
                         "docs": [{ "_id": 4 }, { "_id": 2 }, { "_id": 5 }] }),
            ),
        )
        .await
        .unwrap()
        .0;
        let stopped = serde_json::to_value(stopped).unwrap();
        assert_eq!(stopped["insertedIds"], json!([{ "$numberInt": "4" }]));
        assert_eq!(stopped["errors"][0]["index"], json!(1));
        assert_eq!(stopped["errors"].as_array().unwrap().len(), 1);
        let err = doc_insert(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(json!({ "db": "tablepeek_test", "coll": coll, "docs": [{ "_id": 1 }] })),
        )
        .await
        .unwrap_err();
        assert_eq!(err.1.code, "mongo_11000");
        let changed = doc_update(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(json!({ "db": "tablepeek_test", "coll": coll, "filter": { "_id": 1 }, "update": { "$set": { "a": 1 } } })),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(
            serde_json::to_value(changed).unwrap(),
            json!({ "matched": 1, "modified": 1 })
        );
        let deleted = doc_delete(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(json!({ "db": "tablepeek_test", "coll": coll, "filter": {}, "many": true, "confirmed": true })),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(deleted, json!({ "deleted": 4 }));
        // The console saw it in shell notation.
        let (entries, _) = slot.engine.sql_log().since(None);
        assert!(entries.iter().any(|entry| entry
            .sql
            .contains(".updateOne({ _id: 1 }, { $set: { a: 1 } })")));

        // Export: one document a line, then the count.
        let export = |req: Value| {
            doc_export(
                State(state.clone()),
                test_headers(),
                conn_query(conn),
                body(req),
            )
        };
        let lines = |bytes: Bytes| -> Vec<Value> {
            String::from_utf8(bytes.to_vec())
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect()
        };
        let read_all = |response: Response| async move {
            axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap()
        };
        let response = export(
            json!({ "db": "shop", "coll": "orders", "filter": { "status": "paid" },
                                     "sort": { "_id": 1 }, "limit": 7 }),
        )
        .await
        .unwrap();
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "application/x-ndjson"
        );
        let exported = lines(read_all(response).await);
        assert_eq!(exported.len(), 8);
        assert!(exported[..7].iter().all(|doc| doc["status"] == "paid"));
        assert_eq!(exported[7], json!({ "$end": { "count": 7 } }));
        let grouped = lines(
            read_all(
                export(json!({ "db": "shop", "coll": "orders",
                               "pipeline": [{ "$group": { "_id": "$status" } }] }))
                .await
                .unwrap(),
            )
            .await,
        );
        let statuses = grouped.len() - 1;
        assert_eq!(grouped[statuses], json!({ "$end": { "count": statuses } }));
        let err = export(json!({ "db": "shop", "coll": "orders", "pipeline": [{ "$out": "x" }] }))
            .await
            .unwrap_err();
        assert_eq!(err.1.code, "bad_request");
        // A failure midway (past the first batch of 101) ends the stream
        // with $error and no $end.
        let pivot = doc_find(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(json!({ "db": "shop", "coll": "orders", "sort": { "_id": 1 }, "skip": 150, "limit": 1 })),
        )
        .await
        .unwrap()
        .0
        .docs[0]["_id"]
            .clone();
        let failed = lines(
            read_all(
                export(json!({ "db": "shop", "coll": "orders", "pipeline": [
                    { "$sort": { "_id": 1 } },
                    { "$project": { "x": { "$cond": [{ "$gte": ["$_id", pivot] }, { "$toInt": "$status" }, 1] } } }
                ] }))
                .await
                .unwrap(),
            )
            .await,
        );
        let (last, docs) = failed.split_last().unwrap();
        // The batch holding the failure is lost whole; the ones before it arrived.
        assert!((101..150).contains(&docs.len()), "{} {last}", docs.len());
        assert!(
            last["$error"]["code"]
                .as_str()
                .unwrap()
                .starts_with("mongo_"),
            "{last}"
        );

        // Going away closes the server's cursor. Counted on this namespace
        // alone: other tests open cursors of their own meanwhile.
        let open_cursors = || async {
            let session = slot.engine.document().unwrap();
            let reply = session
                .ops()
                .command(&driver::CommandRequest {
                    db: "admin".into(),
                    command: json!({ "aggregate": 1, "cursor": {}, "pipeline": [
                        { "$currentOp": { "allUsers": true, "idleCursors": true } },
                        { "$match": { "ns": "shop.orders", "type": "idleCursor" } }
                    ] }),
                    confirmed: false,
                    poll: false,
                })
                .await
                .unwrap();
            reply["cursor"]["firstBatch"].as_array().unwrap().len()
        };
        let before = open_cursors().await;
        let response = export(json!({ "db": "shop", "coll": "orders" }))
            .await
            .unwrap();
        let mut frames = response.into_body().into_data_stream();
        assert!(frames.next().await.unwrap().is_ok());
        assert_eq!(open_cursors().await, before + 1);
        drop(frames);
        let mut closed = false;
        for _ in 0..50 {
            if open_cursors().await == before {
                closed = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(closed, "the export's cursor stayed open");

        let perf = doc_perf(State(state.clone()), test_headers(), conn_query(conn))
            .await
            .unwrap()
            .0;
        assert!(perf["opcounters"].get("insert").is_some(), "{perf}");
        assert!(perf["wiredTiger"].get("cacheMax").is_some(), "{perf}");
        let current = doc_command(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(json!({ "db": "admin", "command": { "currentOp": 1, "$all": true } })),
        )
        .await
        .unwrap()
        .0;
        assert!(current["inprog"].is_array(), "{current}");
        // The performance tab's polls leave the console alone; the same
        // command without `poll` and a write with it are logged.
        let console = || slot.engine.sql_log().since(None).0.len();
        let before = console();
        let _ = doc_perf(State(state.clone()), test_headers(), conn_query(conn))
            .await
            .unwrap();
        for command in [
            json!({ "db": "admin", "command": { "currentOp": 1, "$all": true }, "poll": true }),
            json!({ "db": "admin", "command": { "top": 1 }, "poll": true }),
            json!({ "db": "shop", "command": { "profile": -1 }, "poll": true }),
        ] {
            let _ = doc_command(
                State(state.clone()),
                test_headers(),
                conn_query(conn),
                body(command),
            )
            .await
            .unwrap();
        }
        let _ = doc_find(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(json!({ "db": "shop", "coll": "system.profile", "limit": 50, "poll": true })),
        )
        .await
        .unwrap();
        assert_eq!(console(), before);
        let _ = doc_command(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(json!({ "db": "admin", "command": { "top": 1 } })),
        )
        .await
        .unwrap();
        let _ = doc_command(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(json!({ "db": "admin", "command": { "killOp": 1, "op": 999999 }, "confirmed": true, "poll": true })),
        )
        .await
        .unwrap();
        assert_eq!(console(), before + 2);
        // $out writes only once confirmed.
        let out = |confirmed: bool| {
            doc_aggregate(
                State(state.clone()),
                test_headers(),
                conn_query(conn),
                body(
                    json!({ "db": "tablepeek_test", "coll": coll, "confirmed": confirmed,
                             "pipeline": [{ "$match": {} }, { "$out": format!("{coll}_copy") }] }),
                ),
            )
        };
        assert_eq!(out(false).await.unwrap_err().1.code, "bad_request");
        let _ = doc_insert(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(json!({ "db": "tablepeek_test", "coll": coll, "docs": [{ "_id": 9 }] })),
        )
        .await
        .unwrap();
        let _ = out(true).await.unwrap();
        let copied = doc_count(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(json!({ "db": "tablepeek_test", "coll": format!("{coll}_copy"), "filter": { "_id": { "$exists": true } } })),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(copied.count, Some(1));
        let _ = doc_command(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(json!({ "db": "tablepeek_test", "command": { "drop": format!("{coll}_copy") }, "confirmed": true })),
        )
        .await
        .unwrap();
        let dropped = doc_command(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(json!({ "db": "tablepeek_test", "command": { "drop": coll }, "confirmed": true })),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(dropped["ok"], json!({ "$numberDouble": "1.0" }));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A MongoDB slot of `state` with `config`, as the connect route opens it.
    async fn mongo_slot(state: &AppState, config: Value) -> Arc<ConnSlot> {
        let request = connect_request(json!({ "driver": "mongodb", "config": config }));
        connect_with(
            state,
            request,
            SlotOrigin {
                label: None,
                saved_id: None,
            },
        )
        .await
        .map_err(|err| err.message)
        .unwrap()
        .0
    }

    fn ndjson(bytes: &[u8]) -> Value {
        serde_json::from_slice(bytes).unwrap()
    }

    #[tokio::test]
    async fn doc_phase4_routes_against_mongodb() {
        if std::env::var("TABLEPEEK_TEST_MONGODB").is_err() {
            return;
        }
        let dir = temp_dir("doc-mongo-4");
        let state = test_state(&dir);
        let slot = mongo_slot(
            &state,
            json!({ "host": "127.0.0.1", "port": 27018, "user": "tablepeek",
                    "password": "tablepeek_test_pw", "direct_connection": true }),
        )
        .await;
        let conn = Some(slot.id.as_str());
        let coll = format!("tp_route4_{}", uuid::Uuid::new_v4().simple());
        let _ = doc_insert(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(json!({ "db": "tablepeek_test", "coll": coll, "docs": [
                { "_id": 1, "name": "kim" }, { "_id": 2, "name": "KIM" }, { "_id": 3, "name": "lee" }
            ] })),
        )
        .await
        .unwrap();
        let console = || {
            slot.engine
                .sql_log()
                .since(None)
                .0
                .into_iter()
                .map(|entry| entry.sql)
                .collect::<Vec<_>>()
        };

        // Query options: a case-insensitive collation finds both spellings.
        let find = |extra: Value| {
            let mut request = json!({ "db": "tablepeek_test", "coll": coll,
                                      "filter": { "name": "kim" }, "sort": { "_id": 1 } });
            request
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            doc_find(
                State(state.clone()),
                test_headers(),
                conn_query(conn),
                body(request),
            )
        };
        let collation = json!({ "locale": "en", "strength": 2 });
        assert_eq!(find(json!({})).await.unwrap().0.docs.len(), 1);
        let folded = find(json!({ "collation": collation, "hint": "_id_", "maxTimeMS": 5000 }))
            .await
            .unwrap()
            .0;
        assert_eq!(folded.docs.len(), 2);
        assert!(console().iter().any(|line| line.ends_with(
            r#".collation({ locale: "en", strength: 2 }).hint("_id_").maxTimeMS(5000)"#
        )));
        let err = find(json!({ "hint": "no_such_index" })).await.unwrap_err();
        assert!(err.1.code.starts_with("mongo_"), "{}", err.1.code);
        let err = find(json!({ "collation": { "strength": 2 } }))
            .await
            .unwrap_err();
        assert_eq!(err.1.code, "bad_request");
        let counted = doc_count(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(
                json!({ "db": "tablepeek_test", "coll": coll, "filter": { "name": "kim" },
                         "collation": collation, "hint": { "_id": 1 }, "maxTimeMS": 5000 }),
            ),
        )
        .await
        .unwrap()
        .0;
        assert_eq!((counted.count, counted.exact), (Some(2), true));
        let grouped = doc_aggregate(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(
                json!({ "db": "tablepeek_test", "coll": coll, "collation": collation,
                         "pipeline": [{ "$match": { "name": "kim" } }, { "$count": "n" }] }),
            ),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(grouped.docs, vec![json!({ "n": { "$numberInt": "2" } })]);
        let plan = doc_explain(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(json!({ "db": "tablepeek_test", "coll": coll, "find": { "filter": { "name": "kim" } },
                         "hint": { "_id": 1 }, "maxTimeMS": 5000 })),
        )
        .await
        .unwrap()
        .0;
        assert!(plan.to_string().contains("IXSCAN"), "{plan}");
        let exported = doc_export(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(
                json!({ "db": "tablepeek_test", "coll": coll, "filter": { "name": "kim" },
                         "collation": collation }),
            ),
        )
        .await
        .unwrap();
        let exported = axum::body::to_bytes(exported.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(
            exported
                .split(|byte| *byte == b'\n')
                .filter(|line| !line.is_empty())
                .count(),
            3
        );

        // Update preview: the first documents before and after, nothing kept.
        let preview = doc_update_preview(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(json!({ "db": "tablepeek_test", "coll": coll, "filter": {},
                         "update": { "$set": { "seen": true } }, "limit": 2 })),
        )
        .await
        .unwrap()
        .0;
        assert_eq!((preview.matched, preview.previewed), (Some(3), true));
        assert_eq!(preview.samples.len(), 2);
        assert!(preview.samples[0].before.get("seen").is_none());
        assert_eq!(preview.samples[0].after["seen"], json!(true));
        assert_eq!(
            preview.samples[0].after["_id"],
            preview.samples[0].before["_id"]
        );
        let pipeline = doc_update_preview(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(
                json!({ "db": "tablepeek_test", "coll": coll, "filter": { "_id": 3 },
                         "update": [{ "$set": { "upper": { "$toUpper": "$name" } } }] }),
            ),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(pipeline.samples[0].after["upper"], json!("LEE"));
        let untouched = doc_count(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(json!({ "db": "tablepeek_test", "coll": coll,
                         "filter": { "$or": [{ "seen": { "$exists": true } }, { "upper": { "$exists": true } }] } })),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(untouched.count, Some(0));
        assert!(console().iter().any(|line| line.starts_with("// 미리보기")));

        // Writes take the query bar's collation and hint too.
        let folded_preview = doc_update_preview(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(json!({ "db": "tablepeek_test", "coll": coll, "filter": { "name": "kim" },
                         "update": { "$set": { "seen": true } }, "collation": collation, "hint": "_id_" })),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(folded_preview.matched, Some(2));
        assert_eq!(folded_preview.samples.len(), 2);
        let tagged = doc_update(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(
                json!({ "db": "tablepeek_test", "coll": coll, "filter": { "name": "kim" },
                         "update": { "$set": { "tagged": true } }, "many": true,
                         "collation": collation, "hint": "_id_" }),
            ),
        )
        .await
        .unwrap()
        .0;
        assert_eq!((tagged.matched, tagged.modified), (2, 2));
        assert!(console().iter().any(|line| line.ends_with(
            r#".updateMany({ name: "kim" }, { $set: { tagged: true } }, { collation: { locale: "en", strength: 2 }, hint: "_id_" })"#
        )));
        let replaced = doc_replace(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(
                json!({ "db": "tablepeek_test", "coll": coll, "filter": { "name": "LEE" },
                         "replacement": { "name": "lee", "r": 1 }, "collation": collation }),
            ),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(replaced.matched, 1);
        let err = doc_delete(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(
                json!({ "db": "tablepeek_test", "coll": coll, "filter": { "name": "kim" },
                         "many": true, "hint": "no_such_index" }),
            ),
        )
        .await
        .unwrap_err();
        assert!(err.1.code.starts_with("mongo_"), "{}", err.1.code);
        let deleted = doc_delete(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(
                json!({ "db": "tablepeek_test", "coll": coll, "filter": { "name": "kim" },
                         "many": true, "collation": collation }),
            ),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(deleted, json!({ "deleted": 2 }));
        assert!(console().iter().any(|line| line.ends_with(
            r#".deleteMany({ name: "kim" }, { collation: { locale: "en", strength: 2 } })"#
        )));

        // This replica set has no Atlas Search.
        let err = doc_search_indexes(
            State(state.clone()),
            test_headers(),
            doc_params(conn, "tablepeek_test", &coll),
        )
        .await
        .unwrap_err();
        assert_eq!(err.1.code, "unsupported_capability");
        assert!(err.1.message.contains("Atlas Search"), "{}", err.1.message);
        let err = doc_create_search_index(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(
                json!({ "db": "tablepeek_test", "coll": coll, "name": "default",
                         "definition": { "mappings": { "dynamic": true } } }),
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(err.1.code, "unsupported_capability");

        // A change stream: a heartbeat as it opens, then the insert.
        let response = doc_watch(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(json!({ "db": "tablepeek_test", "coll": coll, "fullDocument": "updateLookup",
                         "pipeline": [{ "$match": { "operationType": { "$in": ["insert", "update"] } } }] })),
        )
        .await
        .unwrap();
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "application/x-ndjson"
        );
        let mut frames = response.into_body().into_data_stream();
        let first = ndjson(&frames.next().await.unwrap().unwrap());
        assert!(first["$heartbeat"].is_u64(), "{first}");
        let _ = doc_insert(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(json!({ "db": "tablepeek_test", "coll": coll, "docs": [{ "_id": 10, "name": "park" }] })),
        )
        .await
        .unwrap();
        let event = tokio::time::timeout(std::time::Duration::from_secs(10), frames.next())
            .await
            .expect("no change event")
            .unwrap()
            .unwrap();
        let event = ndjson(&event);
        assert_eq!(event["operationType"], "insert", "{event}");
        assert_eq!(event["fullDocument"]["name"], "park", "{event}");
        assert!(console()
            .iter()
            .any(|line| line.contains(".watch([{ $match:")
                && line.contains("fullDocument: \"updateLookup\"")));
        // Going away closes the change stream's cursor on the server.
        let watching = || async {
            let session = slot.engine.document().unwrap();
            let reply = session
                .ops()
                .command(&driver::CommandRequest {
                    db: "admin".into(),
                    command: json!({ "aggregate": 1, "cursor": {}, "pipeline": [
                        { "$currentOp": { "allUsers": true, "idleCursors": true } },
                        { "$match": { "ns": format!("tablepeek_test.{coll}") } }
                    ] }),
                    confirmed: false,
                    poll: false,
                })
                .await
                .unwrap();
            reply["cursor"]["firstBatch"].as_array().unwrap().len()
        };
        assert!(watching().await > 0);
        drop(frames);
        let mut closed = false;
        for _ in 0..50 {
            if watching().await == 0 {
                closed = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        assert!(closed, "the change stream stayed open");
        // Reconnecting after the last event seen picks up what happened
        // meanwhile.
        let _ = doc_insert(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(json!({ "db": "tablepeek_test", "coll": coll, "docs": [{ "_id": 11, "name": "choi" }] })),
        )
        .await
        .unwrap();
        let resumed = doc_watch(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(json!({ "db": "tablepeek_test", "coll": coll, "resumeAfter": event["_id"] })),
        )
        .await
        .unwrap();
        let mut frames = resumed.into_body().into_data_stream();
        let mut missed = Value::Null;
        for _ in 0..3 {
            let frame = tokio::time::timeout(std::time::Duration::from_secs(10), frames.next())
                .await
                .expect("no resumed event")
                .unwrap()
                .unwrap();
            let line = ndjson(&frame);
            if line.get("$heartbeat").is_none() {
                missed = line;
                break;
            }
        }
        assert_eq!(
            missed["documentKey"]["_id"],
            json!({ "$numberInt": "11" }),
            "{missed}"
        );
        drop(frames);
        let err = doc_watch(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(json!({ "db": "tablepeek_test", "fullDocument": "sometimes" })),
        )
        .await
        .unwrap_err();
        assert_eq!(err.1.code, "bad_request");

        // GridFS: 5 MB in, listed, the same bytes out, deleted.
        let bucket = format!("tp_fs_{}", uuid::Uuid::new_v4().simple());
        let data: Vec<u8> = (0..5 * 1024 * 1024u32)
            .map(|n| (n.wrapping_mul(2_654_435_761) >> 24) as u8)
            .collect();
        let pieces: Vec<Result<Bytes, std::io::Error>> = data
            .chunks(64 * 1024)
            .map(|piece| Ok(Bytes::copy_from_slice(piece)))
            .collect();
        let upload = |filename: &str, body: Body| {
            doc_gridfs_upload(
                State(state.clone()),
                test_headers(),
                Query(GridFsUploadParams {
                    conn: conn.map(str::to_string),
                    db: "tablepeek_test".into(),
                    bucket: bucket.clone(),
                    filename: filename.into(),
                    metadata: Some(r#"{"owner":"kim","n":{"$numberLong":"7"}}"#.into()),
                }),
                body,
            )
        };
        let id = upload(
            "보고서 1.bin",
            Body::from_stream(futures_util::stream::iter(pieces)),
        )
        .await
        .unwrap()
        .0["id"]
            .clone();
        assert!(id["$oid"].is_string(), "{id}");
        // A body that breaks off leaves nothing behind.
        let broken: Vec<Result<Bytes, std::io::Error>> = vec![
            Ok(Bytes::from(vec![1u8; 600 * 1024])),
            Err(std::io::Error::other("client went away")),
        ];
        assert!(upload(
            "broken.bin",
            Body::from_stream(futures_util::stream::iter(broken))
        )
        .await
        .is_err());
        let buckets = doc_gridfs_buckets(
            State(state.clone()),
            test_headers(),
            doc_params(conn, "tablepeek_test", ""),
        )
        .await
        .unwrap()
        .0;
        assert!(
            buckets.as_array().unwrap().contains(&json!(bucket)),
            "{buckets}"
        );
        let files = doc_gridfs_files(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(json!({ "db": "tablepeek_test", "bucket": bucket, "limit": 10 })),
        )
        .await
        .unwrap()
        .0;
        let files = files["files"].as_array().unwrap().clone();
        assert_eq!(files.len(), 1, "{files:?}");
        assert_eq!(files[0]["filename"], "보고서 1.bin");
        assert_eq!(files[0]["metadata"]["n"], json!({ "$numberLong": "7" }));
        let chunks = doc_count(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(json!({ "db": "tablepeek_test", "coll": format!("{bucket}.chunks"), "filter": { "files_id": { "$exists": true } } })),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(chunks.count, Some(21), "only the whole file's chunks");
        let download = |id: &Value| {
            doc_gridfs_download(
                State(state.clone()),
                test_headers(),
                Query(GridFsDownloadParams {
                    conn: conn.map(str::to_string),
                    db: "tablepeek_test".into(),
                    bucket: bucket.clone(),
                    id: id.to_string(),
                    token: None,
                }),
            )
        };
        let response = download(&id).await.unwrap();
        assert_eq!(
            response.headers()[header::CONTENT_LENGTH],
            data.len().to_string().as_str()
        );
        assert_eq!(
            response.headers()[header::CONTENT_DISPOSITION],
            "attachment; filename*=UTF-8''%EB%B3%B4%EA%B3%A0%EC%84%9C%201.bin"
        );
        let downloaded = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert!(downloaded == data, "the bytes came back different");
        let delete = |confirmed: bool| {
            doc_gridfs_delete(
                State(state.clone()),
                test_headers(),
                conn_query(conn),
                body(
                    json!({ "db": "tablepeek_test", "bucket": bucket, "id": id, "confirmed": confirmed }),
                ),
            )
        };
        assert_eq!(delete(false).await.unwrap_err().1.code, "bad_request");
        let _ = delete(true).await.unwrap();
        let err = download(&id).await.unwrap_err();
        assert_eq!(
            (err.0, err.1.code.as_str()),
            (StatusCode::NOT_FOUND, "not_found")
        );
        assert_eq!(delete(true).await.unwrap_err().1.code, "not_found");
        assert!(console().iter().any(|line| line
            .starts_with("mongofiles --db=tablepeek_test --prefix=tp_fs_")
            && line.contains(
                " put '보고서 1.bin' # metadata: { owner: \"kim\", n: NumberLong(\"7\") }"
            )));

        for name in [coll, format!("{bucket}.files"), format!("{bucket}.chunks")] {
            let _ = doc_command(
                State(state.clone()),
                test_headers(),
                conn_query(conn),
                body(json!({ "db": "tablepeek_test", "command": { "drop": name }, "confirmed": true })),
            )
            .await
            .unwrap();
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn doc_cursor_routes_against_mongodb() {
        if std::env::var("TABLEPEEK_TEST_MONGODB").is_err() {
            return;
        }
        let dir = temp_dir("doc-cursors");
        let state = test_state(&dir);
        let slot = mongo_slot(
            &state,
            json!({ "host": "127.0.0.1", "port": 27018, "user": "tablepeek",
                    "password": "tablepeek_test_pw", "direct_connection": true }),
        )
        .await;
        // Short enough to watch an idle cursor close; set before the first
        // cursor starts the sweeper.
        slot.cursors.set_idle(std::time::Duration::from_millis(400));
        let conn = Some(slot.id.as_str());
        let coll = format!("tp_cursor_{}", uuid::Uuid::new_v4().simple());
        for chunk in 0..5 {
            let docs: Vec<Value> = (chunk * 5_000..(chunk + 1) * 5_000)
                .map(|n| json!({ "n": n }))
                .collect();
            let _ = doc_insert(
                State(state.clone()),
                test_headers(),
                conn_query(conn),
                body(json!({ "db": "tablepeek_test", "coll": coll, "docs": docs })),
            )
            .await
            .unwrap();
        }
        let open = |request: Value| {
            doc_cursor_open(
                State(state.clone()),
                test_headers(),
                conn_query(conn),
                body(request),
            )
        };
        let next = |request: Value| {
            doc_cursor_next(
                State(state.clone()),
                test_headers(),
                conn_query(conn),
                body(request),
            )
        };
        let number = |doc: &Value| -> i64 {
            let n = &doc["n"];
            n["$numberInt"].as_str().unwrap().parse().unwrap()
        };
        // Server cursors still open on the scratch collection.
        let open_cursors = || async {
            let session = slot.engine.document().unwrap();
            let reply = session
                .ops()
                .command(&driver::CommandRequest {
                    db: "admin".into(),
                    command: json!({ "aggregate": 1, "cursor": {}, "pipeline": [
                        { "$currentOp": { "allUsers": true, "idleCursors": true } },
                        { "$match": { "ns": format!("tablepeek_test.{coll}"), "type": "idleCursor" } }
                    ] }),
                    confirmed: false,
                    poll: false,
                })
                .await
                .unwrap();
            reply["cursor"]["firstBatch"].as_array().unwrap().len()
        };
        let closes = || async {
            for _ in 0..50 {
                if open_cursors().await == 0 {
                    return true;
                }
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
            false
        };

        // An aggregation of 25,000 documents, past the 10,000 cap of
        // /api/doc/aggregate, in order and whole.
        let first = open(json!({ "db": "tablepeek_test", "coll": coll, "batchSize": 1000,
                                 "aggregate": { "pipeline": [{ "$sort": { "n": 1 } }, { "$project": { "_id": 0 } }] } }))
            .await
            .unwrap()
            .0;
        let id = first["id"].clone();
        assert!(id.is_string(), "{first}");
        assert_eq!(first["done"], json!(false));
        let mut seen: Vec<i64> = first["batch"]
            .as_array()
            .unwrap()
            .iter()
            .map(number)
            .collect();
        assert_eq!(seen.len(), 1000);
        loop {
            let page = next(json!({ "id": id })).await.unwrap().0;
            let batch = page["batch"].as_array().unwrap();
            assert!(batch.len() <= 1000);
            seen.extend(batch.iter().map(number));
            if page["done"] == json!(true) {
                break;
            }
        }
        assert_eq!(seen, (0..25_000).collect::<Vec<i64>>());
        // Read to the end, it is closed.
        assert_eq!(
            next(json!({ "id": id })).await.unwrap_err().1.code,
            "not_found"
        );
        let opened = slot
            .engine
            .sql_log()
            .since(None)
            .0
            .iter()
            .filter(|entry| {
                entry
                    .sql
                    .ends_with(".aggregate([{ $sort: { n: 1 } }, { $project: { _id: 0 } }], { batchSize: 1000 })")
            })
            .count();
        assert_eq!(opened, 1, "the open is logged once, not each batch");

        // A find keeps its batch size; closing it closes the server's cursor.
        let find = open(
            json!({ "db": "tablepeek_test", "coll": coll, "batchSize": 2,
                                "find": { "filter": { "n": { "$lt": 10 } }, "sort": { "n": 1 },
                                          "hint": "_id_", "maxTimeMS": 5000 } }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(find["batch"].as_array().unwrap().len(), 2);
        let page = next(json!({ "id": find["id"] })).await.unwrap().0;
        assert_eq!(
            page["batch"]
                .as_array()
                .unwrap()
                .iter()
                .map(number)
                .collect::<Vec<_>>(),
            vec![2, 3]
        );
        let page = next(json!({ "id": find["id"], "batchSize": 3 }))
            .await
            .unwrap()
            .0;
        assert_eq!(page["batch"].as_array().unwrap().len(), 3);
        assert!(open_cursors().await > 0);
        let closed = doc_cursor_close(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(json!({ "id": find["id"] })),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(closed, json!({ "ok": true, "closed": true }));
        assert!(
            closes().await,
            "the closed cursor stayed open on the server"
        );
        // All in the first batch: nothing left open.
        let whole =
            open(json!({ "db": "tablepeek_test", "coll": coll, "find": { "filter": { "n": 7 } } }))
                .await
                .unwrap()
                .0;
        assert_eq!(
            (whole["id"].clone(), whole["done"].clone()),
            (Value::Null, json!(true))
        );
        assert_eq!(whole["batch"].as_array().unwrap().len(), 1);

        // Left unread past the idle limit, it closes here and on the server.
        let idle = open(
            json!({ "db": "tablepeek_test", "coll": coll, "batchSize": 1,
                                "find": { "filter": {} } }),
        )
        .await
        .unwrap()
        .0;
        tokio::time::sleep(std::time::Duration::from_millis(1_000)).await;
        assert_eq!(
            next(json!({ "id": idle["id"] })).await.unwrap_err().1.code,
            "not_found"
        );
        assert!(closes().await, "the idle cursor stayed open on the server");

        // $out through a cursor only once confirmed.
        let out = |confirmed: bool| {
            open(
                json!({ "db": "tablepeek_test", "coll": coll, "confirmed": confirmed,
                         "aggregate": { "pipeline": [{ "$match": { "n": { "$lt": 3 } } }, { "$out": format!("{coll}_out") }] } }),
            )
        };
        assert_eq!(out(false).await.unwrap_err().1.code, "bad_request");
        let written = out(true).await.unwrap().0;
        assert_eq!(written["done"], json!(true));
        let copied = doc_count(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(json!({ "db": "tablepeek_test", "coll": format!("{coll}_out"), "filter": { "n": { "$exists": true } } })),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(copied.count, Some(3));

        // Disconnecting closes the slot's cursors.
        let _left = open(
            json!({ "db": "tablepeek_test", "coll": coll, "batchSize": 1,
                                 "find": { "filter": {} } }),
        )
        .await
        .unwrap();
        assert!(open_cursors().await > 0);
        let _ = conns_delete(
            State(state.clone()),
            AxumPath(slot.id.clone()),
            test_headers(),
        )
        .await
        .unwrap();
        assert_eq!(slot.cursors.open_count(), 0);
        assert!(closes().await, "the cursor outlived its connection");
        // The slot is gone from the registry; its engine still answers here.
        let session = slot.engine.document().unwrap();
        for name in [coll.clone(), format!("{coll}_out")] {
            let _ = session
                .ops()
                .command(&driver::CommandRequest {
                    db: "tablepeek_test".into(),
                    command: json!({ "drop": name }),
                    confirmed: true,
                    poll: false,
                })
                .await;
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Atlas Search indexes against the Atlas Local container of
    /// `make test-db-atlas` (127.0.0.1:27019, no auth).
    #[tokio::test]
    async fn search_index_routes_against_atlas_local() {
        if std::env::var("TABLEPEEK_TEST_MONGODB_ATLAS").is_err() {
            return;
        }
        let dir = temp_dir("doc-atlas");
        let state = test_state(&dir);
        let slot = mongo_slot(
            &state,
            json!({ "host": "127.0.0.1", "port": 27019, "direct_connection": true }),
        )
        .await;
        let conn = Some(slot.id.as_str());
        let coll = format!("tp_search_{}", uuid::Uuid::new_v4().simple());
        let _ = doc_insert(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(json!({ "db": "tablepeek_test", "coll": coll, "docs": [{ "title": "hello" }] })),
        )
        .await
        .unwrap();
        let created = doc_create_search_index(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(
                json!({ "db": "tablepeek_test", "coll": coll, "name": "titles",
                         "definition": { "mappings": { "dynamic": true } } }),
            ),
        )
        .await
        .map_err(|err| err.1.message.clone())
        .unwrap()
        .0;
        assert_eq!(created, json!({ "name": "titles" }));
        let vector = doc_create_search_index(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(json!({ "db": "tablepeek_test", "coll": coll, "name": "vectors", "type": "vectorSearch",
                         "definition": { "fields": [{ "type": "vector", "path": "v",
                                                      "numDimensions": 3, "similarity": "cosine" }] } })),
        )
        .await
        .map_err(|err| err.1.message.clone())
        .unwrap()
        .0;
        assert_eq!(vector, json!({ "name": "vectors" }));
        let listed = doc_search_indexes(
            State(state.clone()),
            test_headers(),
            doc_params(conn, "tablepeek_test", &coll),
        )
        .await
        .unwrap()
        .0;
        let listed = listed.as_array().unwrap();
        let titles = listed
            .iter()
            .find(|index| index["name"] == "titles")
            .unwrap();
        assert_eq!(titles["type"], "search");
        assert!(
            titles.get("status").is_some() && titles.get("queryable").is_some(),
            "{titles}"
        );
        assert!(listed
            .iter()
            .any(|index| index["name"] == "vectors" && index["type"] == "vectorSearch"));
        let _ = doc_update_search_index(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(json!({ "db": "tablepeek_test", "coll": coll, "name": "titles",
                         "definition": { "mappings": { "dynamic": false, "fields": { "title": { "type": "string" } } } } })),
        )
        .await
        .map_err(|err| err.1.message.clone())
        .unwrap();
        for name in ["titles", "vectors"] {
            let _ = doc_drop_search_index(
                State(state.clone()),
                test_headers(),
                conn_query(conn),
                body(json!({ "db": "tablepeek_test", "coll": coll, "name": name, "confirmed": true })),
            )
            .await
            .map_err(|err| err.1.message.clone())
            .unwrap();
        }
        let _ = doc_command(
            State(state.clone()),
            test_headers(),
            conn_query(conn),
            body(json!({ "db": "tablepeek_test", "command": { "drop": coll }, "confirmed": true })),
        )
        .await;
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn connect_rejects_unsupported_driver() {
        let dir = temp_dir("connect-driver");
        let state = test_state(&dir);
        let err = connect_for_test(&state, test_connect_request("db2"))
            .await
            .unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
        assert_eq!(err.code, "unsupported_driver");
        assert_eq!(err.message, "지원하지 않는 엔진: db2");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn connect_rejects_missing_mysql_config() {
        let dir = temp_dir("connect-missing-mysql");
        let state = test_state(&dir);
        let request = connect_request(json!({ "driver": "mysql" }));
        let err = connect_for_test(&state, request).await.unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
        assert_eq!(err.code, "invalid_request");
        assert_eq!(err.message, "MySQL 접속 정보가 없습니다");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn connect_rejects_missing_cockroach_config() {
        let dir = temp_dir("connect-missing-cockroach");
        let state = test_state(&dir);
        let request = connect_request(json!({ "driver": "cockroach" }));
        let err = connect_for_test(&state, request).await.unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
        assert_eq!(err.code, "invalid_request");
        assert_eq!(err.message, "CockroachDB 접속 정보가 없습니다");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn connect_rejects_missing_mssql_config() {
        let dir = temp_dir("connect-missing-mssql");
        let state = test_state(&dir);
        let request = connect_request(json!({ "driver": "mssql" }));
        let err = connect_for_test(&state, request).await.unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
        assert_eq!(err.code, "invalid_request");
        assert_eq!(err.message, "SQL Server 접속 정보가 없습니다");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn sqlite_connect(path: &str) -> ConnectRequest {
        serde_json::from_value(json!({ "driver": "sqlite", "sqlite": { "path": path } })).unwrap()
    }

    #[tokio::test]
    async fn saved_sqlite_profile_connects_to_its_file() {
        let dir = temp_dir("sqlite-profile");
        let file = dir.join("app.db");
        // SQLite reads an empty file as an empty database.
        std::fs::write(&file, b"").unwrap();
        let path = file.display().to_string();
        let state = test_state(&dir);
        let id = create_test_connection(&state, "로컬 파일", sqlite_connect(&path)).await;

        let listed = connections_list(State(state.clone()), test_headers())
            .await
            .unwrap();
        let item = &listed.0["connections"][0];
        assert_eq!(item["driver"], json!("sqlite"));
        assert_eq!(item["config"]["path"], json!(path));
        assert_eq!(item["has_password"], json!(false));

        let opened = connection_connect(
            State(state.clone()),
            AxumPath(id.clone()),
            test_headers(),
            Bytes::new(),
        )
        .await
        .unwrap();
        assert_eq!(opened.0["meta"]["kind"], json!("sqlite"));
        assert_eq!(opened.0["meta"]["path"], json!(path));
        let conn = opened.0["conn"].as_str().unwrap();
        let slot = state.registry.lock().await.get(conn).unwrap();
        assert_eq!(slot.saved_id.as_deref(), Some(id.as_str()));
        assert_eq!(slot.label, "로컬 파일");
        // History goes with the file, shared with opening it as a file.
        let canonical = std::fs::canonicalize(&file).unwrap();
        assert_eq!(
            slot.history_scope(),
            format!("file:{}", canonical.display())
        );

        // The file again, however it is reached, is the same connection.
        let slots = state.registry.lock().await.list().len();
        let spelled_otherwise = dir.join(".").join("app.db").display().to_string();
        let reopened = open(
            State(state.clone()),
            test_headers(),
            Json(OpenRequest {
                path: Some(spelled_otherwise),
            }),
        )
        .await
        .unwrap();
        assert_eq!(reopened.0["conn"], json!(conn));
        let again = connection_connect(
            State(state.clone()),
            AxumPath(id.clone()),
            test_headers(),
            Bytes::new(),
        )
        .await
        .unwrap();
        assert_eq!(again.0["conn"], json!(conn));
        assert_eq!(state.registry.lock().await.list().len(), slots);

        let tested = connections_test(
            State(state.clone()),
            test_headers(),
            Json(TestConnectionRequest {
                connect: sqlite_connect(&path),
                saved_id: None,
            }),
        )
        .await
        .unwrap();
        assert_eq!(tested.0["ok"], json!(true));
        assert_eq!(tested.0["kind"], json!("sqlite"));
        assert_eq!(tested.0["tables"], json!(0));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn sqlite_profile_needs_a_path() {
        let dir = temp_dir("sqlite-empty-path");
        let state = test_state(&dir);
        let err = connections_create(
            State(state.clone()),
            test_headers(),
            Json(NewConnectionRequest {
                name: "빈 경로".into(),
                connect: sqlite_connect("  "),
                persist_password: false,
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1.code, "invalid_request");
        assert_eq!(err.1.message, "SQLite 파일 경로를 입력하세요");

        let missing_config: ConnectRequest =
            serde_json::from_value(json!({ "driver": "sqlite" })).unwrap();
        let err = connect_for_test(&state, missing_config).await.unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
        assert_eq!(err.code, "invalid_request");
        assert_eq!(err.message, "SQLite 파일 경로를 입력하세요");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn sqlite_connect_reports_missing_and_foreign_files() {
        let dir = temp_dir("sqlite-bad-files");
        let state = test_state(&dir);
        let gone = dir.join("gone.db").display().to_string();
        let err = connect_for_test(&state, sqlite_connect(&gone))
            .await
            .unwrap_err();
        assert_eq!(err.status, StatusCode::NOT_FOUND);
        assert_eq!(err.code, "not_found");

        let text = dir.join("notes.txt");
        std::fs::write(
            &text,
            "this is plain text, not a database file at all\n".repeat(8),
        )
        .unwrap();
        let err = connect_for_test(&state, sqlite_connect(&text.display().to_string()))
            .await
            .unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
        assert_eq!(err.code, "not_a_sqlite_file");

        // A saved profile whose file went away reports that, not a password prompt.
        let id = create_test_connection(&state, "사라진 파일", sqlite_connect(&gone)).await;
        let err = connection_connect(
            State(state.clone()),
            AxumPath(id),
            test_headers(),
            Bytes::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(err.0, StatusCode::NOT_FOUND);
        assert_eq!(err.1.code, "not_found");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn sqlite_profile_survives_export_and_import() {
        let source = test_state(&temp_dir("sqlite-export"));
        let id = create_test_connection(&source, "로컬", sqlite_connect("/data/app.db")).await;
        let exported = connections_export(
            State(source.clone()),
            test_headers(),
            Json(export_request(vec![id], "correct horse")),
        )
        .await
        .unwrap();
        let file = exported.0["file"].as_str().unwrap().to_string();

        let target = test_state(&temp_dir("sqlite-import"));
        let imported = connections_import(
            State(target.clone()),
            test_headers(),
            Json(import_request(&file, "correct horse")),
        )
        .await
        .unwrap();
        let created = imported.0["connections"].as_array().unwrap();
        assert_eq!(created.len(), 1);
        let store = target.store.lock().await;
        let saved = store
            .find_connection(created[0]["id"].as_str().unwrap())
            .unwrap();
        assert_eq!(saved.driver, "sqlite");
        assert_eq!(saved.config["path"], json!("/data/app.db"));
        assert!(!saved.persist_password);
    }

    #[tokio::test]
    async fn connections_routes_require_token() {
        let dir = temp_dir("connections-auth");
        let state = test_state(&dir);
        let err = connections_list(State(state.clone()), HeaderMap::new())
            .await
            .unwrap_err();
        assert_eq!(err.0, StatusCode::UNAUTHORIZED);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn export_request(ids: Vec<String>, passphrase: &str) -> ExportConnectionsRequest {
        ExportConnectionsRequest {
            ids,
            meta: HashMap::new(),
            groups: Vec::new(),
            include_passwords: false,
            passphrase: passphrase.into(),
        }
    }

    fn import_request(file: &str, passphrase: &str) -> ImportConnectionsRequest {
        ImportConnectionsRequest {
            file: file.into(),
            passphrase: passphrase.into(),
            label: Some("가져옴".into()),
        }
    }

    async fn create_test_connection(
        state: &AppState,
        name: &str,
        connect: ConnectRequest,
    ) -> String {
        let created = connections_create(
            State(state.clone()),
            test_headers(),
            Json(NewConnectionRequest {
                name: name.into(),
                connect,
                persist_password: false,
            }),
        )
        .await
        .unwrap();
        created.0["id"].as_str().unwrap().to_string()
    }

    fn ssh_mysql_connect() -> ConnectRequest {
        serde_json::from_value(json!({
            "driver": "mysql",
            "mysql": { "host": "db.internal", "port": 3306, "user": "app", "password": "typed-pw", "database": "mc", "ssl_mode": "require" },
            "ssh": { "host": "bastion", "port": 22, "user": "deploy", "private_key_path": "/k/id" }
        }))
        .unwrap()
    }

    #[tokio::test]
    async fn connections_export_then_import_moves_profiles_and_meta() {
        let source = test_state(&temp_dir("export-source"));
        let pg = create_test_connection(&source, "분석 DB", test_connect_request("postgres")).await;
        let my = create_test_connection(&source, "prod", ssh_mysql_connect()).await;
        let mut request = export_request(vec![pg.clone(), my.clone()], "correct horse");
        request.meta.insert(
            my.clone(),
            transfer::ExportMeta {
                color: "#22c55e".into(),
                tags: vec!["production".into()],
                group: "CiteWell".into(),
            },
        );
        request.groups = vec![transfer::BundleGroup {
            name: "CiteWell".into(),
            color: "#f59e0b".into(),
        }];
        request.include_passwords = true; // nothing is in the keychain for these profiles
        let exported = connections_export(State(source.clone()), test_headers(), Json(request))
            .await
            .unwrap();
        assert_eq!(exported.0["count"], json!(2));
        assert_eq!(
            exported.0["secrets"],
            json!(0),
            "asked for passwords, but none was stored"
        );
        let file = exported.0["file"].as_str().unwrap().to_string();
        for hidden in ["분석 DB", "db.internal", "bastion", "CiteWell", "password"] {
            assert!(!file.contains(hidden), "{hidden} visible in the file");
        }
        let inside: Value =
            serde_json::from_slice(&transfer::open(&file, "correct horse").unwrap()).unwrap();
        assert!(
            !inside.to_string().contains("password"),
            "no secret was stored, so none is exported"
        );

        let target = test_state(&temp_dir("import-target"));
        let imported = connections_import(
            State(target.clone()),
            test_headers(),
            Json(import_request(&file, "correct horse")),
        )
        .await
        .unwrap();
        let created = imported.0["connections"].as_array().unwrap();
        assert_eq!(created.len(), 2);
        assert_eq!(created[1]["name"], json!("prod"));
        assert_eq!(created[1]["color"], json!("#22c55e"));
        assert_eq!(created[1]["tags"], json!(["production"]));
        assert_eq!(created[1]["group"], json!("CiteWell"));
        assert_eq!(
            imported.0["groups"],
            json!([{ "name": "CiteWell", "color": "#f59e0b" }])
        );
        let store = target.store.lock().await;
        let saved = store
            .find_connection(created[1]["id"].as_str().unwrap())
            .unwrap();
        assert_eq!(saved.config["host"], json!("db.internal"));
        assert_eq!(
            saved.ssh.as_ref().unwrap().private_key_path.as_deref(),
            Some("/k/id")
        );
        assert!(!saved.persist_password);
        drop(store);

        // A second import names the copies apart.
        let again = connections_import(
            State(target.clone()),
            test_headers(),
            Json(import_request(&file, "correct horse")),
        )
        .await
        .unwrap();
        assert_eq!(again.0["connections"][1]["name"], json!("prod (가져옴)"));
    }

    #[tokio::test]
    async fn connections_export_counts_each_profile_once() {
        let state = test_state(&temp_dir("export-dedupe"));
        let id = create_test_connection(&state, "a", test_connect_request("postgres")).await;
        let exported = connections_export(
            State(state.clone()),
            test_headers(),
            Json(export_request(vec![id.clone(), id], "correct horse")),
        )
        .await
        .unwrap();
        assert_eq!(exported.0["count"], json!(1));
        let inside: Value = serde_json::from_slice(
            &transfer::open(exported.0["file"].as_str().unwrap(), "correct horse").unwrap(),
        )
        .unwrap();
        assert_eq!(inside["connections"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn connections_export_rejects_short_passphrase_and_unknown_ids() {
        let state = test_state(&temp_dir("export-checks"));
        let id = create_test_connection(&state, "a", test_connect_request("postgres")).await;
        let short = connections_export(
            State(state.clone()),
            test_headers(),
            Json(export_request(vec![id.clone()], "seven77")),
        )
        .await
        .unwrap_err();
        assert_eq!(short.0, StatusCode::BAD_REQUEST);
        assert_eq!(short.1.code, "weak_passphrase");
        let missing = connections_export(
            State(state.clone()),
            test_headers(),
            Json(export_request(vec!["nope".into()], "correct horse")),
        )
        .await
        .unwrap_err();
        assert_eq!(missing.0, StatusCode::NOT_FOUND);
        let unauthorized = connections_export(
            State(state.clone()),
            HeaderMap::new(),
            Json(export_request(vec![id], "correct horse")),
        )
        .await
        .unwrap_err();
        assert_eq!(unauthorized.0, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn connections_import_tells_wrong_passphrase_from_other_files() {
        let state = test_state(&temp_dir("import-errors"));
        let file = transfer::seal(b"{}", "correct horse", transfer::DEFAULT_KDF).unwrap();
        let wrong = connections_import(
            State(state.clone()),
            test_headers(),
            Json(import_request(&file, "wrong horse")),
        )
        .await
        .unwrap_err();
        assert_eq!(wrong.1.code, "wrong_passphrase");
        let other = connections_import(
            State(state.clone()),
            test_headers(),
            Json(import_request("{\"a\":1}", "correct horse")),
        )
        .await
        .unwrap_err();
        assert_eq!(other.1.code, "not_connections_file");
    }

    #[tokio::test]
    async fn connections_import_is_all_or_nothing() {
        let state = test_state(&temp_dir("import-atomic"));
        let good = json!({ "driver": "postgres", "postgres": { "host": "h", "port": 5432, "user": "u", "database": "d" } });
        let bundle = json!({
            "groups": [],
            "connections": [
                { "name": "first", "connect": good },
                { "name": "second", "connect": { "driver": "postgres", "postgres": { "host": "db/prod", "port": 5432, "user": "u", "database": "d" } } }
            ]
        });
        let file = transfer::seal(
            bundle.to_string().as_bytes(),
            "correct horse",
            transfer::DEFAULT_KDF,
        )
        .unwrap();
        let error = connections_import(
            State(state.clone()),
            test_headers(),
            Json(import_request(&file, "correct horse")),
        )
        .await
        .unwrap_err();
        assert_eq!(error.0, StatusCode::BAD_REQUEST);
        assert!(
            error.1.message.starts_with("2번째 연결"),
            "{}",
            error.1.message
        );
        assert!(
            state.store.lock().await.data().connections.is_empty(),
            "nothing saved"
        );
    }

    #[tokio::test]
    async fn connections_routes_crud_without_keyring() {
        let dir = temp_dir("connections-crud");
        let state = test_state(&dir);
        let headers = test_headers();

        let created = connections_create(
            State(state.clone()),
            headers.clone(),
            Json(NewConnectionRequest {
                name: "테스트 연결".into(),
                connect: test_connect_request("postgres"),
                persist_password: false,
            }),
        )
        .await
        .unwrap();
        let id = created.0["id"].as_str().unwrap().to_string();
        assert!(!id.is_empty());

        let listed = connections_list(State(state.clone()), headers.clone())
            .await
            .unwrap();
        let connections = listed.0["connections"].as_array().unwrap();
        assert_eq!(connections.len(), 1);
        assert_eq!(connections[0]["name"], json!("테스트 연결"));
        assert_eq!(connections[0]["driver"], json!("postgres"));
        assert_eq!(connections[0]["persist_password"], json!(false));
        assert_eq!(connections[0]["has_password"], json!(false));
        assert!(connections[0]["config"].get("password").is_none());
        assert!(!listed.0.to_string().contains("tablepeek_test_pw"));

        let missing = connection_connect(
            State(state.clone()),
            AxumPath("no-such-id".into()),
            headers.clone(),
            Bytes::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(missing.0, StatusCode::NOT_FOUND);

        let deleted =
            connections_delete(State(state.clone()), AxumPath(id.clone()), headers.clone())
                .await
                .unwrap();
        assert_eq!(deleted.0["ok"], json!(true));

        let listed = connections_list(State(state.clone()), headers.clone())
            .await
            .unwrap();
        assert!(listed.0["connections"].as_array().unwrap().is_empty());

        let again = connections_delete(State(state.clone()), AxumPath(id), headers)
            .await
            .unwrap_err();
        assert_eq!(again.0, StatusCode::NOT_FOUND);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn connections_update_replaces_profile_without_keyring() {
        let dir = temp_dir("connections-update");
        let state = test_state(&dir);
        let headers = test_headers();

        let created = connections_create(
            State(state.clone()),
            headers.clone(),
            Json(NewConnectionRequest {
                name: "원래 이름".into(),
                connect: test_connect_request("postgres"),
                persist_password: false,
            }),
        )
        .await
        .unwrap();
        let id = created.0["id"].as_str().unwrap().to_string();
        state
            .store
            .lock()
            .await
            .touch_connection(&id, 1234)
            .unwrap();

        let mut edited = test_mysql_connect_request();
        edited
            .config
            .insert("host".into(), json!("db.example.internal"));
        let updated = connections_update(
            State(state.clone()),
            AxumPath(id.clone()),
            headers.clone(),
            Json(NewConnectionRequest {
                name: "  바뀐 이름 ".into(),
                connect: edited,
                persist_password: false,
            }),
        )
        .await
        .unwrap();
        assert_eq!(updated.0["id"], json!(id));

        let listed = connections_list(State(state.clone()), headers.clone())
            .await
            .unwrap();
        let connections = listed.0["connections"].as_array().unwrap();
        assert_eq!(connections.len(), 1);
        assert_eq!(connections[0]["id"], json!(id));
        assert_eq!(connections[0]["name"], json!("바뀐 이름"));
        assert_eq!(connections[0]["driver"], json!("mysql"));
        assert_eq!(
            connections[0]["config"]["host"],
            json!("db.example.internal")
        );
        assert!(connections[0].get("postgres").is_none());
        assert!(connections[0]["config"].get("password").is_none());
        assert_eq!(connections[0]["last_used"], json!(1234));

        let missing = connections_update(
            State(state.clone()),
            AxumPath("no-such-id".into()),
            headers.clone(),
            Json(NewConnectionRequest {
                name: "x".into(),
                connect: test_connect_request("postgres"),
                persist_password: false,
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(missing.0, StatusCode::NOT_FOUND);

        let blank = connections_update(
            State(state.clone()),
            AxumPath(id.clone()),
            headers.clone(),
            Json(NewConnectionRequest {
                name: "   ".into(),
                connect: test_connect_request("postgres"),
                persist_password: false,
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(blank.0, StatusCode::BAD_REQUEST);

        let bad_body = connection_connect(
            State(state.clone()),
            AxumPath(id),
            headers,
            Bytes::from_static(b"{not json"),
        )
        .await
        .unwrap_err();
        assert_eq!(bad_body.0, StatusCode::BAD_REQUEST);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn connection_update_and_test_routes_check_token_and_input() {
        let dir = temp_dir("connections-guards");
        let state = test_state(&dir);
        let request = || NewConnectionRequest {
            name: "x".into(),
            connect: test_connect_request("postgres"),
            persist_password: false,
        };

        let err = connections_update(
            State(state.clone()),
            AxumPath("any".into()),
            HeaderMap::new(),
            Json(request()),
        )
        .await
        .unwrap_err();
        assert_eq!(err.0, StatusCode::UNAUTHORIZED);

        let err = connections_test(
            State(state.clone()),
            HeaderMap::new(),
            Json(TestConnectionRequest {
                connect: test_connect_request("postgres"),
                saved_id: None,
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.0, StatusCode::UNAUTHORIZED);

        let err = connections_test(
            State(state.clone()),
            test_headers(),
            Json(TestConnectionRequest {
                connect: test_connect_request("db2"),
                saved_id: None,
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1.code, "unsupported_driver");

        let mut pasted = test_connect_request("postgres");
        pasted
            .config
            .insert("host".into(), json!("postgres://u:secret@db.example/app"));
        let err = connections_create(
            State(state.clone()),
            test_headers(),
            Json(NewConnectionRequest {
                name: "pasted".into(),
                connect: pasted,
                persist_password: false,
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        let listed = connections_list(State(state.clone()), test_headers())
            .await
            .unwrap();
        assert!(!listed.0.to_string().contains("secret"));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn connection_update_keeps_list_position() {
        let dir = temp_dir("connections-order");
        let state = test_state(&dir);
        let headers = test_headers();
        let mut ids = Vec::new();
        for name in ["first", "second"] {
            let created = connections_create(
                State(state.clone()),
                headers.clone(),
                Json(NewConnectionRequest {
                    name: name.into(),
                    connect: test_connect_request("postgres"),
                    persist_password: false,
                }),
            )
            .await
            .unwrap();
            ids.push(created.0["id"].as_str().unwrap().to_string());
        }
        let updated = connections_update(
            State(state.clone()),
            AxumPath(ids[0].clone()),
            headers.clone(),
            Json(NewConnectionRequest {
                name: "first, renamed".into(),
                connect: test_connect_request("postgres"),
                persist_password: false,
            }),
        )
        .await
        .unwrap();
        assert_eq!(updated.0["id"], json!(ids[0]));
        let listed = connections_list(State(state.clone()), headers)
            .await
            .unwrap();
        let names: Vec<&str> = listed.0["connections"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["first, renamed", "second"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn connections_routes_crud_mysql_without_keyring() {
        let dir = temp_dir("connections-crud-mysql");
        let state = test_state(&dir);
        let headers = test_headers();

        let created = connections_create(
            State(state.clone()),
            headers.clone(),
            Json(NewConnectionRequest {
                name: "테스트 MySQL".into(),
                connect: test_mysql_connect_request(),
                persist_password: false,
            }),
        )
        .await
        .unwrap();
        let id = created.0["id"].as_str().unwrap().to_string();
        assert!(!id.is_empty());

        let listed = connections_list(State(state.clone()), headers.clone())
            .await
            .unwrap();
        let connections = listed.0["connections"].as_array().unwrap();
        assert_eq!(connections.len(), 1);
        assert_eq!(connections[0]["name"], json!("테스트 MySQL"));
        assert_eq!(connections[0]["driver"], json!("mysql"));
        assert_eq!(connections[0]["config"]["host"], json!("127.0.0.1"));
        assert_eq!(connections[0]["config"]["port"], json!(3307));
        assert_eq!(
            connections[0]["config"]["database"],
            json!("tablepeek_test")
        );
        assert!(connections[0]["config"].get("password").is_none());
        assert!(connections[0].get("postgres").is_none());
        assert!(!listed.0.to_string().contains("root_pw"));

        let missing = connection_connect(
            State(state.clone()),
            AxumPath("no-such-id".into()),
            headers.clone(),
            Bytes::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(missing.0, StatusCode::NOT_FOUND);

        let deleted =
            connections_delete(State(state.clone()), AxumPath(id.clone()), headers.clone())
                .await
                .unwrap();
        assert_eq!(deleted.0["ok"], json!(true));

        let listed = connections_list(State(state.clone()), headers)
            .await
            .unwrap();
        assert!(listed.0["connections"].as_array().unwrap().is_empty());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn connections_routes_crud_cockroach_without_keyring() {
        let dir = temp_dir("connections-crud-cockroach");
        let state = test_state(&dir);
        let headers = test_headers();

        let created = connections_create(
            State(state.clone()),
            headers.clone(),
            Json(NewConnectionRequest {
                name: "테스트 CockroachDB".into(),
                connect: test_cockroach_connect_request(),
                persist_password: false,
            }),
        )
        .await
        .unwrap();
        let id = created.0["id"].as_str().unwrap().to_string();
        assert!(!id.is_empty());

        let listed = connections_list(State(state.clone()), headers.clone())
            .await
            .unwrap();
        let connections = listed.0["connections"].as_array().unwrap();
        assert_eq!(connections.len(), 1);
        assert_eq!(connections[0]["name"], json!("테스트 CockroachDB"));
        assert_eq!(connections[0]["driver"], json!("cockroach"));
        assert_eq!(connections[0]["config"]["host"], json!("127.0.0.1"));
        assert_eq!(connections[0]["config"]["port"], json!(26258));
        assert_eq!(connections[0]["config"]["database"], json!("defaultdb"));
        assert!(connections[0].get("postgres").is_none());
        assert!(connections[0].get("mysql").is_none());
        assert!(connections[0].get("mssql").is_none());

        let deleted = connections_delete(State(state.clone()), AxumPath(id), headers.clone())
            .await
            .unwrap();
        assert_eq!(deleted.0["ok"], json!(true));

        let listed = connections_list(State(state.clone()), headers)
            .await
            .unwrap();
        assert!(listed.0["connections"].as_array().unwrap().is_empty());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn connections_routes_crud_mssql_without_keyring() {
        let dir = temp_dir("connections-crud-mssql");
        let state = test_state(&dir);
        let headers = test_headers();

        let created = connections_create(
            State(state.clone()),
            headers.clone(),
            Json(NewConnectionRequest {
                name: "테스트 SQL Server".into(),
                connect: test_mssql_connect_request(),
                persist_password: false,
            }),
        )
        .await
        .unwrap();
        let id = created.0["id"].as_str().unwrap().to_string();
        assert!(!id.is_empty());

        let listed = connections_list(State(state.clone()), headers.clone())
            .await
            .unwrap();
        let connections = listed.0["connections"].as_array().unwrap();
        assert_eq!(connections.len(), 1);
        assert_eq!(connections[0]["name"], json!("테스트 SQL Server"));
        assert_eq!(connections[0]["driver"], json!("mssql"));
        assert_eq!(connections[0]["config"]["host"], json!("127.0.0.1"));
        assert_eq!(connections[0]["config"]["port"], json!(14330));
        assert_eq!(
            connections[0]["config"]["database"],
            json!("tablepeek_test")
        );
        assert_eq!(connections[0]["config"]["encrypt"], json!(false));
        assert!(connections[0]["config"].get("password").is_none());
        assert!(connections[0].get("postgres").is_none());
        assert!(connections[0].get("cockroach").is_none());
        assert!(!listed.0.to_string().contains("MsSql_test_pw1"));

        let deleted = connections_delete(State(state.clone()), AxumPath(id), headers.clone())
            .await
            .unwrap();
        assert_eq!(deleted.0["ok"], json!(true));

        let listed = connections_list(State(state.clone()), headers)
            .await
            .unwrap();
        assert!(listed.0["connections"].as_array().unwrap().is_empty());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn stored_connection_connect_reports_missing_password() {
        if std::env::var("TABLEPEEK_TEST_DOCKER").is_err() {
            return;
        }
        let dir = temp_dir("connections-stored-password");
        let state = test_state(&dir);
        let headers = test_headers();

        let mut request = test_connect_request("postgres");
        request.config.remove("password");
        let created = connections_create(
            State(state.clone()),
            headers.clone(),
            Json(NewConnectionRequest {
                name: "비밀번호 미저장".into(),
                connect: request,
                persist_password: false,
            }),
        )
        .await
        .unwrap();
        let id = created.0["id"].as_str().unwrap().to_string();

        let err = connection_connect(State(state.clone()), AxumPath(id), headers, Bytes::new())
            .await
            .unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1.code, "password_required");
        assert_eq!(
            err.1.message,
            "저장된 비밀번호가 없습니다 — 비밀번호를 입력해 연결하세요"
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A MongoDB profile without a password to keep (no authentication,
    /// X.509) is never saved or listed as keeping one, whatever the hidden
    /// storage choice said.
    #[tokio::test]
    async fn profiles_without_a_password_never_keep_one() {
        let dir = temp_dir("mongo-auth-persist");
        let state = test_state(&dir);
        let headers = test_headers();
        for (name, config) in [
            ("없음", json!({ "host": "127.0.0.1", "auth": "none" })),
            (
                "인증서",
                json!({ "host": "db", "auth": "x509", "tls": true }),
            ),
            // Saved before the choice, no user: no authentication.
            (
                "예전",
                json!({ "host": "127.0.0.1", "port": 27017, "database": "shop" }),
            ),
        ] {
            let created = connections_create(
                State(state.clone()),
                headers.clone(),
                Json(NewConnectionRequest {
                    name: name.into(),
                    connect: connect_request(json!({ "driver": "mongodb", "config": config })),
                    persist_password: true,
                }),
            )
            .await
            .unwrap();
            let id = created.0["id"].as_str().unwrap().to_string();
            let saved = state
                .store
                .lock()
                .await
                .find_connection(&id)
                .cloned()
                .unwrap();
            assert!(!saved.persist_password, "{name}");
        }
        // One already stored that way still lists without a password.
        let mut legacy = state.store.lock().await.data().connections[0].clone();
        legacy.persist_password = true;
        state.store.lock().await.update_connection(legacy).unwrap();
        let listed = connections_list(State(state.clone()), headers)
            .await
            .unwrap()
            .0;
        for connection in listed["connections"].as_array().unwrap() {
            assert_eq!(connection["has_password"], json!(false), "{connection}");
            assert_eq!(connection["persist_password"], json!(false), "{connection}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// MongoDB asks for a password only when the profile signs in with one,
    /// and a profile saved before the choice existed connects as it did.
    #[tokio::test]
    async fn mongodb_asks_for_a_password_only_for_password_auth() {
        if std::env::var("TABLEPEEK_TEST_MONGODB").is_err() {
            return;
        }
        let dir = temp_dir("mongo-auth-connect");
        let state = test_state(&dir);
        let headers = test_headers();
        let save = |config: Value| {
            let state = state.clone();
            let headers = headers.clone();
            async move {
                let created = connections_create(
                    State(state),
                    headers,
                    Json(NewConnectionRequest {
                        name: "몽고".into(),
                        connect: connect_request(json!({ "driver": "mongodb", "config": config })),
                        persist_password: false,
                    }),
                )
                .await
                .unwrap();
                created.0["id"].as_str().unwrap().to_string()
            }
        };
        // No auth choice, no user: saved as none, connects without asking.
        let open =
            save(json!({ "host": "127.0.0.1", "port": 27018, "direct_connection": true })).await;
        assert_eq!(
            state
                .store
                .lock()
                .await
                .find_connection(&open)
                .unwrap()
                .config["auth"],
            json!("none")
        );
        let connected = connection_connect(
            State(state.clone()),
            AxumPath(open),
            headers.clone(),
            Bytes::new(),
        )
        .await
        .unwrap();
        assert!(connected.0["conn"].is_string());
        // A user and password with nothing stored: asked for.
        let login = save(json!({
            "host": "127.0.0.1", "port": 27018, "direct_connection": true,
            "auth": "password", "user": "tablepeek", "auth_source": "admin"
        }))
        .await;
        let err = connection_connect(
            State(state.clone()),
            AxumPath(login.clone()),
            headers.clone(),
            Bytes::new(),
        )
        .await
        .unwrap_err();
        assert_eq!(err.1.code, "password_required");
        let typed = Bytes::from(json!({ "password": "tablepeek_test_pw" }).to_string());
        assert!(connection_connect(
            State(state.clone()),
            AxumPath(login),
            headers.clone(),
            typed
        )
        .await
        .is_ok());
        // No authentication: the same user is never sent, nothing is asked.
        let none = save(json!({
            "host": "127.0.0.1", "port": 27018, "direct_connection": true,
            "auth": "none", "user": "tablepeek"
        }))
        .await;
        assert!(
            connection_connect(State(state.clone()), AxumPath(none), headers, Bytes::new())
                .await
                .is_ok()
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn history_run(scope: &str, sql: &str, at: u64) -> store::HistoryEntry {
        store::HistoryEntry {
            id: String::new(),
            scope: scope.into(),
            sql: sql.into(),
            at,
            ms: 4,
            ok: true,
            rows: 1,
            error: None,
        }
    }

    #[tokio::test]
    async fn history_routes_list_and_clear_one_connection() {
        let dir = temp_dir("history-routes");
        let state = test_state(&dir);
        // The test state's default slot is the in-memory demo.
        {
            let mut store = state.store.lock().await;
            store
                .record_history(history_run("demo", "SELECT 1", 10))
                .unwrap();
            store
                .record_history(history_run("demo", "SELECT 2", 20))
                .unwrap();
            store
                .record_history(history_run("saved:other", "SELECT 3", 30))
                .unwrap();
        }
        let headers = test_headers();

        let listed = history_list(
            State(state.clone()),
            headers.clone(),
            Query(HistoryParams {
                conn: Some("main".into()),
                limit: Some(1),
            }),
        )
        .await
        .unwrap();
        let history = listed.0["history"].as_array().unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0]["sql"], json!("SELECT 2"));
        assert_eq!(history[0]["at"], json!(20));
        assert_eq!(history[0]["ms"], json!(4));
        assert_eq!(history[0]["ok"], json!(true));

        let _ = history_clear(
            State(state.clone()),
            headers.clone(),
            Query(HistoryParams {
                conn: None,
                limit: None,
            }),
        )
        .await
        .unwrap();
        let listed = history_list(
            State(state.clone()),
            headers.clone(),
            Query(HistoryParams {
                conn: None,
                limit: None,
            }),
        )
        .await
        .unwrap();
        assert!(listed.0["history"].as_array().unwrap().is_empty());
        // Clearing one connection leaves the others alone.
        assert_eq!(state.store.lock().await.history("saved:other", 10).len(), 1);

        let missing = history_list(
            State(state.clone()),
            headers,
            Query(HistoryParams {
                conn: Some("nope".into()),
                limit: None,
            }),
        )
        .await;
        assert_eq!(missing.unwrap_err().0, StatusCode::NOT_FOUND);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn slot_history_scope_follows_what_the_slot_opened() {
        let dir = temp_dir("slot-scope");
        let file = dir.join("app.db");
        // SQLite reads an empty file as an empty database.
        std::fs::write(&file, b"").unwrap();
        let saved = ConnSlot::new(
            "s1".into(),
            "운영".into(),
            Some("abc".into()),
            Some(serde_json::from_value(json!({ "driver": "postgres" })).unwrap()),
            Engine::open_demo(1).unwrap(),
        );
        assert_eq!(saved.history_scope(), "saved:abc");

        let unsaved = ConnSlot::new(
            "s2".into(),
            "임시".into(),
            None,
            Some(serde_json::from_value(json!({ "driver": "postgres" })).unwrap()),
            Engine::open_demo(1).unwrap(),
        );
        assert_eq!(unsaved.history_scope(), "session:s2");

        let demo = ConnSlot::new(
            "s3".into(),
            "데모".into(),
            None,
            None,
            Engine::open_demo(1).unwrap(),
        );
        assert_eq!(demo.history_scope(), "demo");

        let sqlite = ConnSlot::new(
            "s4".into(),
            file.display().to_string(),
            None,
            None,
            Engine::open_file(&file).unwrap(),
        );
        let canonical = std::fs::canonicalize(&file).unwrap();
        assert_eq!(
            sqlite.history_scope(),
            format!("file:{}", canonical.display())
        );

        // The same file reached by another spelling of its path shares the scope.
        let roundabout = dir.join("sub").join("..").join("app.db");
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        let again = ConnSlot::new(
            "s5".into(),
            roundabout.display().to_string(),
            None,
            None,
            Engine::open_file(&roundabout).unwrap(),
        );
        assert_eq!(again.history_scope(), sqlite.history_scope());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn safe_mode_route_sets_one_connection() {
        let dir = temp_dir("safe-mode-route");
        let state = test_state(&dir);
        let headers = test_headers();

        let listed = conns_list(State(state.clone()), headers.clone())
            .await
            .unwrap();
        assert_eq!(listed.0["conns"][0]["safe_mode"], Value::Null);

        let set = safe_mode_set(
            State(state.clone()),
            headers.clone(),
            Json(SafeModeRequest {
                conn: Some("main".into()),
                mode: Some(2),
            }),
        )
        .await
        .unwrap();
        assert_eq!(set.0["mode"], json!(2));
        assert_eq!(state.store.lock().await.safe_mode("demo"), Some(2));
        let listed = conns_list(State(state.clone()), headers.clone())
            .await
            .unwrap();
        assert_eq!(listed.0["conns"][0]["safe_mode"], json!(2));

        let bad = safe_mode_set(
            State(state.clone()),
            headers.clone(),
            Json(SafeModeRequest {
                conn: Some("main".into()),
                mode: Some(3),
            }),
        )
        .await;
        assert_eq!(bad.unwrap_err().0, StatusCode::BAD_REQUEST);

        let _ = safe_mode_set(
            State(state.clone()),
            headers,
            Json(SafeModeRequest {
                conn: None,
                mode: None,
            }),
        )
        .await
        .unwrap();
        assert_eq!(state.store.lock().await.safe_mode("demo"), None);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn favorites_routes_crud() {
        let dir = temp_dir("favorites-routes");
        let state = test_state(&dir);
        let headers = test_headers();

        let created = favorites_create(
            State(state.clone()),
            headers.clone(),
            Json(NewFavoriteRequest {
                name: "사용자 목록".into(),
                sql: "SELECT * FROM users\n".into(),
                keyword: Some("users".into()),
                folder: None,
            }),
        )
        .await
        .unwrap();
        let id = created.0["id"].as_str().unwrap().to_string();

        let listed = favorites_list(State(state.clone()), headers.clone())
            .await
            .unwrap();
        let favorites = listed.0["favorites"].as_array().unwrap();
        assert_eq!(favorites.len(), 1);
        assert_eq!(favorites[0]["id"], json!(id));
        assert_eq!(favorites[0]["name"], json!("사용자 목록"));
        // Stored as sent, newline and all.
        assert_eq!(favorites[0]["sql"], json!("SELECT * FROM users\n"));
        assert_eq!(favorites[0]["keyword"], json!("users"));

        let empty = favorites_create(
            State(state.clone()),
            headers.clone(),
            Json(NewFavoriteRequest {
                name: "  ".into(),
                sql: "SELECT 1".into(),
                keyword: None,
                folder: None,
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(empty.0, StatusCode::BAD_REQUEST);

        let deleted = favorites_delete(State(state.clone()), AxumPath(id.clone()), headers.clone())
            .await
            .unwrap();
        assert_eq!(deleted.0["ok"], json!(true));
        let again = favorites_delete(State(state.clone()), AxumPath(id), headers)
            .await
            .unwrap_err();
        assert_eq!(again.0, StatusCode::NOT_FOUND);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn favorites_folders_and_partial_updates() {
        let dir = temp_dir("favorites-folders");
        let state = test_state(&dir);
        let headers = test_headers();

        let folder = folders_create(
            State(state.clone()),
            headers.clone(),
            Json(FolderRequest {
                name: " Reports ".into(),
            }),
        )
        .await
        .unwrap();
        let folder_id = folder.0["id"].as_str().unwrap().to_string();
        let blank = folders_create(
            State(state.clone()),
            headers.clone(),
            Json(FolderRequest { name: " ".into() }),
        )
        .await
        .unwrap_err();
        assert_eq!(blank.0, StatusCode::BAD_REQUEST);

        // A new query may start out empty, inside a folder.
        let created = favorites_create(
            State(state.clone()),
            headers.clone(),
            Json(NewFavoriteRequest {
                name: "Untitled".into(),
                sql: String::new(),
                keyword: None,
                folder: Some(folder_id.clone()),
            }),
        )
        .await
        .unwrap();
        let id = created.0["id"].as_str().unwrap().to_string();
        let stray = favorites_create(
            State(state.clone()),
            headers.clone(),
            Json(NewFavoriteRequest {
                name: "Stray".into(),
                sql: String::new(),
                keyword: None,
                folder: Some("missing".into()),
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(stray.0, StatusCode::BAD_REQUEST);

        let listed = favorites_list(State(state.clone()), headers.clone())
            .await
            .unwrap();
        assert_eq!(listed.0["folders"][0]["id"], json!(folder_id));
        assert_eq!(listed.0["folders"][0]["name"], json!("Reports"));
        let favorite = &listed.0["favorites"][0];
        assert_eq!(favorite["sql"], json!(""));
        assert_eq!(favorite["folder"], json!(folder_id));
        assert_eq!(favorite["keyword"], json!(null));
        assert!(favorite["created_at"].as_u64().unwrap() > 0);
        assert_eq!(favorite["updated_at"], favorite["created_at"]);

        let update = |body: Value| {
            let state = state.clone();
            let headers = headers.clone();
            let id = id.clone();
            async move {
                favorites_update(
                    State(state),
                    AxumPath(id),
                    headers,
                    Json(serde_json::from_value(body).unwrap()),
                )
                .await
            }
        };
        let renamed = update(json!({ "name": "Daily", "sql": "SELECT 1\n", "keyword": "daily" }))
            .await
            .unwrap();
        assert_eq!(renamed.0.name, "Daily");
        assert_eq!(renamed.0.sql, "SELECT 1\n");
        assert_eq!(renamed.0.keyword.as_deref(), Some("daily"));
        assert_eq!(renamed.0.folder.as_deref(), Some(folder_id.as_str()));
        // Left out keeps a field, null clears it.
        let moved = update(json!({ "folder": null })).await.unwrap();
        assert_eq!(moved.0.folder, None);
        assert_eq!(moved.0.keyword.as_deref(), Some("daily"));
        let cleared = update(json!({ "keyword": null })).await.unwrap();
        assert_eq!(cleared.0.keyword, None);
        assert_eq!(cleared.0.name, "Daily");
        assert_eq!(
            update(json!({ "name": "  " })).await.unwrap_err().0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            update(json!({ "folder": "missing" })).await.unwrap_err().0,
            StatusCode::BAD_REQUEST
        );
        let missing = favorites_update(
            State(state.clone()),
            AxumPath("missing".into()),
            headers.clone(),
            Json(serde_json::from_value(json!({ "name": "x" })).unwrap()),
        )
        .await
        .unwrap_err();
        assert_eq!(missing.0, StatusCode::NOT_FOUND);

        let renamed_folder = folders_update(
            State(state.clone()),
            AxumPath(folder_id.clone()),
            headers.clone(),
            Json(FolderRequest {
                name: "Monthly".into(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(renamed_folder.0["ok"], json!(true));
        assert_eq!(
            folders_update(
                State(state.clone()),
                AxumPath("missing".into()),
                headers.clone(),
                Json(FolderRequest { name: "x".into() }),
            )
            .await
            .unwrap_err()
            .0,
            StatusCode::NOT_FOUND
        );

        // Deleting a folder takes its queries along.
        let moved_back = update(json!({ "folder": folder_id })).await.unwrap();
        assert_eq!(moved_back.0.folder.as_deref(), Some(folder_id.as_str()));
        let deleted = folders_delete(
            State(state.clone()),
            AxumPath(folder_id.clone()),
            headers.clone(),
        )
        .await
        .unwrap();
        assert_eq!(deleted.0["ok"], json!(true));
        let listed = favorites_list(State(state.clone()), headers.clone())
            .await
            .unwrap();
        assert!(listed.0["favorites"].as_array().unwrap().is_empty());
        assert!(listed.0["folders"].as_array().unwrap().is_empty());
        assert_eq!(
            folders_delete(State(state.clone()), AxumPath(folder_id), headers)
                .await
                .unwrap_err()
                .0,
            StatusCode::NOT_FOUND
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn history_route_deletes_one_entry_of_one_connection() {
        let dir = temp_dir("history-delete");
        let state = test_state(&dir);
        let headers = test_headers();
        {
            let mut store = state.store.lock().await;
            store
                .record_history(history_run("demo", "SELECT 1", 10))
                .unwrap();
            store
                .record_history(history_run("demo", "SELECT 2", 20))
                .unwrap();
            store
                .record_history(history_run("saved:other", "SELECT 3", 30))
                .unwrap();
        }
        let params = || HistoryParams {
            conn: Some("main".into()),
            limit: None,
        };
        let listed = history_list(State(state.clone()), headers.clone(), Query(params()))
            .await
            .unwrap();
        let ids: Vec<String> = listed.0["history"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["id"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(ids.len(), 2);
        let other = state.store.lock().await.history("saved:other", 1)[0]
            .id
            .clone();

        let deleted = history_delete(
            State(state.clone()),
            AxumPath(ids[0].clone()),
            headers.clone(),
            Query(params()),
        )
        .await
        .unwrap();
        assert_eq!(deleted.0["ok"], json!(true));
        for id in [ids[0].clone(), other] {
            let err = history_delete(
                State(state.clone()),
                AxumPath(id),
                headers.clone(),
                Query(params()),
            )
            .await
            .unwrap_err();
            assert_eq!(err.0, StatusCode::NOT_FOUND);
        }
        let left = state.store.lock().await.history("demo", 10);
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].id, ids[1]);
        assert_eq!(state.store.lock().await.history("saved:other", 10).len(), 1);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn exec_route_records_successes_once_committed() {
        let dir = temp_dir("exec-history");
        let state = test_state(&dir);
        let slot = slot_for(&state, Some("main")).await.unwrap();
        record_gui_changes(&state, &slot);
        let headers = test_headers();
        let exec = |sql: &str, history: bool| {
            let state = state.clone();
            let headers = headers.clone();
            let req = ExecRequest {
                sql: sql.into(),
                history,
                job: false,
            };
            async move {
                exec_route(
                    State(state),
                    headers,
                    Query(ConnQuery {
                        conn: None,
                        system: None,
                    }),
                    Json(req),
                )
                .await
            }
        };
        let _ = exec("SELECT 1", false).await.unwrap();
        // A failure still answers with its error but stays out of History.
        let err = exec("SELECT * FROM nope", true).await.unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert!(err.1 .0.message.contains("nope"));

        // Inside a transaction a run waits for COMMIT and goes with ROLLBACK.
        slot.engine.begin_tx().await.unwrap();
        let _ = exec("DELETE FROM demo WHERE id = 3", true).await.unwrap();
        slot.engine.rollback_tx().await.unwrap();
        slot.engine.begin_tx().await.unwrap();
        let _ = exec("DELETE FROM demo WHERE id = 2", true).await.unwrap();
        assert!(state.store.lock().await.history("demo", 10).is_empty());
        slot.engine.commit_tx().await.unwrap();

        let ran = exec(" SELECT name FROM demo ", true).await.unwrap();
        assert_eq!(ran.0["ok"], json!(true));
        let history = history_when(&dir, "demo", |history| history.len() >= 2).await;
        let sqls: Vec<&str> = history.iter().map(|entry| entry.sql.as_str()).collect();
        assert_eq!(
            sqls,
            vec!["SELECT name FROM demo", "DELETE FROM demo WHERE id = 2"]
        );
        assert!(history
            .iter()
            .all(|entry| entry.ok && entry.error.is_none()));
        // The run's rows are all it returned (one deleted, two left).
        assert_eq!((history[0].rows, history[1].rows), (2, 0));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn exec_route_returns_the_rows_of_a_statement() {
        let dir = temp_dir("exec-rows");
        let state = test_state(&dir);
        let exec = |sql: &str, job: bool| {
            exec_route(
                State(state.clone()),
                test_headers(),
                Query(ConnQuery {
                    conn: None,
                    system: None,
                }),
                Json(ExecRequest {
                    sql: sql.into(),
                    history: false,
                    job,
                }),
            )
        };
        // A list (the user manager's) arrives whole, from the page or a job.
        for job in [false, true] {
            let listed = exec("SELECT id, name FROM demo ORDER BY id", job)
                .await
                .unwrap()
                .0;
            assert_eq!(listed["rows"].as_array().unwrap().len(), 3, "{listed}");
            assert_eq!(listed["row_count"], json!(3));
            assert_eq!(listed["truncated"], json!(false));
        }
        // Past the cap the rows stop there and say so.
        let many = exec(
            "WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n WHERE x < 10005) SELECT x FROM n",
            false,
        )
        .await
        .unwrap()
        .0;
        assert_eq!(many["rows"].as_array().unwrap().len(), EXEC_MAX_ROWS);
        assert_eq!(many["truncated"], json!(true));
        // A statement without rows answers as before.
        let changed = exec("UPDATE demo SET name = name WHERE id = 1", false)
            .await
            .unwrap()
            .0;
        assert_eq!(changed["ok"], json!(true));
        assert_eq!(changed["rows"], json!([]));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A `security` call that never answers (an unlock prompt nobody sees)
    /// fails the save after its deadline, and other requests go on meanwhile,
    /// even on a runtime with a single worker.
    #[cfg(target_os = "macos")]
    #[tokio::test(flavor = "current_thread")]
    async fn stuck_keychain_fails_the_save_without_stalling_other_requests() {
        let dir = temp_dir("keychain-stuck");
        let state = test_state(&dir);
        let mut connect = test_connect_request("postgres");
        // The stand-in `security` (store::security_bin) sleeps on this word.
        connect
            .config
            .insert("password".into(), json!("hang-keychain"));
        let save = tokio::spawn(connections_create(
            State(state.clone()),
            test_headers(),
            Json(NewConnectionRequest {
                name: "stuck".into(),
                connect,
                persist_password: true,
            }),
        ));
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let started = std::time::Instant::now();
        let listed = connections_list(State(state.clone()), test_headers())
            .await
            .unwrap();
        assert!(started.elapsed() < std::time::Duration::from_millis(500));
        assert!(listed.0["connections"].as_array().unwrap().is_empty());
        assert!(
            !save.is_finished(),
            "the stuck keychain call returned early"
        );
        let err = save.await.unwrap().unwrap_err();
        assert_eq!(err.1.code, "keyring_error");
        assert_eq!(
            err.1.message,
            "키체인 응답이 없습니다 — 잠금 해제 창을 확인하세요"
        );
        // Nothing was saved.
        assert!(state.store.lock().await.data().connections.is_empty());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn gui_changes_land_in_history() {
        let dir = temp_dir("gui-history");
        let state = test_state(&dir);
        let opened = open(
            State(state.clone()),
            test_headers(),
            Json(OpenRequest { path: None }),
        )
        .await
        .unwrap();
        let slot = slot_for(&state, opened.0["conn"].as_str()).await.unwrap();
        slot.engine
            .edit(&EditTarget {
                table: "demo".into(),
                pk: vec![PkValue {
                    column: "id".into(),
                    value: json!(1),
                }],
                column: "name".into(),
                value: Some("O'Neil".into()),
                expr: None,
            })
            .await
            .unwrap();
        // Plain statements are not History.
        slot.engine.query("SELECT 1", 1).await.unwrap();

        let history = history_when(&dir, "demo", |history| !history.is_empty()).await;
        assert_eq!(history.len(), 1);
        assert_eq!(
            history[0].sql,
            "UPDATE \"demo\" SET \"name\" = 'O''Neil' WHERE \"id\" = 1"
        );
        assert!(history[0].ok);
        assert_eq!(history[0].rows, 1);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// History for `scope` as written to `dir`, once `done` says so (or after
    /// 2 s): the recorder files changes and writes the file in the background.
    async fn history_when(
        dir: &std::path::Path,
        scope: &str,
        done: impl Fn(&[store::HistoryEntry]) -> bool,
    ) -> Vec<store::HistoryEntry> {
        let read = || store::StoreFile::load(dir).history(scope, store::HISTORY_CAP);
        for _ in 0..400 {
            let history = read();
            if done(&history) {
                return history;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        read()
    }

    #[tokio::test]
    async fn gui_changes_follow_their_transaction_and_none_are_lost() {
        let dir = temp_dir("gui-history-tx");
        let mut state = test_state(&dir);
        state.demo_rows = 2_000;
        let opened = open(
            State(state.clone()),
            test_headers(),
            Json(OpenRequest { path: None }),
        )
        .await
        .unwrap();
        let slot = slot_for(&state, opened.0["conn"].as_str()).await.unwrap();
        let delete = |id: i64| {
            let engine = slot.engine.clone();
            async move {
                engine
                    .delete_row(
                        "demo",
                        &[PkValue {
                            column: "id".into(),
                            value: json!(id),
                        }],
                    )
                    .await
                    .unwrap()
            }
        };

        // Rolled back: never History. A row already gone: no change at all.
        slot.engine.begin_tx().await.unwrap();
        assert_eq!(delete(1).await, 1);
        slot.engine.rollback_tx().await.unwrap();
        assert_eq!(delete(5_000).await, 0);

        // A bulk delete committed at once: every row reaches History (up to
        // its cap), in order, newest first.
        slot.engine.begin_tx().await.unwrap();
        for id in 1..=2_000 {
            assert_eq!(delete(id).await, 1);
        }
        assert!(state.store.lock().await.history("demo", 1).is_empty());
        slot.engine.commit_tx().await.unwrap();
        // Filed as it arrives, possibly over several batches.
        let last = "DELETE FROM \"demo\" WHERE \"id\" = 2000";
        let history = history_when(&dir, "demo", |history| {
            history.first().is_some_and(|entry| entry.sql == last)
        })
        .await;
        assert_eq!(history.len(), store::HISTORY_CAP);
        assert_eq!(history[0].sql, "DELETE FROM \"demo\" WHERE \"id\" = 2000");
        assert_eq!(
            history[store::HISTORY_CAP - 1].sql,
            "DELETE FROM \"demo\" WHERE \"id\" = 1001"
        );
        let in_memory = state.store.lock().await.history("demo", 1);
        assert_eq!(in_memory[0].sql, last);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn test_sender() -> (Sender, mpsc::Receiver<Message>) {
        let (tx, rx) = mpsc::channel(64);
        let sender = Sender {
            tx,
            order: Arc::new(tokio::sync::Mutex::new(())),
            latest: Arc::default(),
        };
        (sender, rx)
    }

    async fn next_json(rx: &mut mpsc::Receiver<Message>) -> Value {
        let message = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
            .await
            .expect("no message within 2s")
            .expect("channel closed");
        match message {
            Message::Text(text) => serde_json::from_str(text.as_str()).unwrap(),
            other => panic!("unexpected message {other:?}"),
        }
    }

    fn console_sqls(message: &Value) -> Vec<&str> {
        message["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["sql"].as_str().unwrap())
            .collect()
    }

    #[tokio::test]
    async fn console_replies_then_follows_the_log_until_the_engine_closes() {
        let dir = temp_dir("console-ws");
        let state = test_state(&dir);
        let (sender, mut rx) = test_sender();
        let mut consoles = HashMap::new();
        let slot = slot_for(&state, Some("main")).await.unwrap();
        slot.engine.query("SELECT 1", 1).await.unwrap();

        handle_console(
            &state,
            &sender,
            &json!({ "since": null }),
            "main",
            &mut consoles,
        )
        .await;
        let reply = next_json(&mut rx).await;
        assert_eq!(reply["type"], json!("console"));
        assert_eq!(reply["conn"], json!("main"));
        assert_eq!(reply["reset"], json!(true));
        assert_eq!(console_sqls(&reply), vec!["SELECT 1;"]);
        let first = &reply["entries"][0];
        assert_eq!(first["seq"], json!(1));
        assert!(first["at_ms"].as_u64().unwrap() > 0);

        slot.engine.query("SELECT 2", 1).await.unwrap();
        slot.engine.query("SELECT 3", 1).await.unwrap();
        let pushed = next_json(&mut rx).await;
        assert_eq!(pushed["reset"], json!(false));
        let mut sqls: Vec<String> = console_sqls(&pushed)
            .into_iter()
            .map(String::from)
            .collect();
        if sqls.len() == 1 {
            sqls.extend(
                console_sqls(&next_json(&mut rx).await)
                    .into_iter()
                    .map(String::from),
            );
        }
        assert_eq!(sqls, vec!["SELECT 2;", "SELECT 3;"]);

        // Asking again catches up without a second forwarder.
        handle_console(
            &state,
            &sender,
            &json!({ "since": 3 }),
            "main",
            &mut consoles,
        )
        .await;
        let caught_up = next_json(&mut rx).await;
        assert_eq!(caught_up["reset"], json!(false));
        assert!(console_sqls(&caught_up).is_empty());
        assert_eq!(consoles.len(), 1);

        // Clearing over REST; sequence numbers go on.
        let cleared = console_clear(
            State(state.clone()),
            test_headers(),
            Query(ConnQuery {
                conn: Some("main".into()),
                system: None,
            }),
        )
        .await
        .unwrap();
        assert_eq!(cleared.0["ok"], json!(true));
        let (entries, reset) = slot.engine.sql_log().since(Some(3));
        assert!(reset && entries.is_empty());
        slot.engine.query("SELECT 4", 1).await.unwrap();
        let pushed = next_json(&mut rx).await;
        assert_eq!(pushed["entries"][0]["seq"], json!(4));

        // The connection closes: its engine goes, and the page is told.
        drop(slot);
        state.registry.lock().await.remove("main");
        let closed = next_json(&mut rx).await;
        assert_eq!(closed, json!({ "type": "console_closed", "conn": "main" }));

        handle_console(
            &state,
            &sender,
            &json!({ "since": null }),
            "main",
            &mut consoles,
        )
        .await;
        let missing = next_json(&mut rx).await;
        assert_eq!(missing["type"], json!("error"));
        assert_eq!(missing["conn"], json!("main"));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn console_unwatch_stops_pushes_until_asked_again() {
        let dir = temp_dir("console-unwatch");
        let state = test_state(&dir);
        let (sender, mut rx) = test_sender();
        let mut consoles = HashMap::new();
        let slot = slot_for(&state, Some("main")).await.unwrap();
        handle_console(&state, &sender, &json!({}), "main", &mut consoles).await;
        assert_eq!(next_json(&mut rx).await["reset"], json!(true));
        slot.engine.query("SELECT 1", 1).await.unwrap();
        assert_eq!(console_sqls(&next_json(&mut rx).await), vec!["SELECT 1;"]);

        stop_console(&mut consoles, "main");
        stop_console(&mut consoles, "other");
        assert!(consoles.is_empty());
        slot.engine.query("SELECT 2", 1).await.unwrap();
        let quiet = tokio::time::timeout(std::time::Duration::from_millis(100), rx.recv()).await;
        assert!(quiet.is_err(), "pushed after unwatch: {quiet:?}");

        // Watching again catches up from the page's newest and follows on.
        handle_console(
            &state,
            &sender,
            &json!({ "since": 1 }),
            "main",
            &mut consoles,
        )
        .await;
        let reply = next_json(&mut rx).await;
        assert_eq!(reply["reset"], json!(false));
        assert_eq!(console_sqls(&reply), vec!["SELECT 2;"]);
        slot.engine.query("SELECT 3", 1).await.unwrap();
        assert_eq!(console_sqls(&next_json(&mut rx).await), vec!["SELECT 3;"]);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The next text message of `kind` ("meta", "error", …), skipping the rest.
    async fn next_of(rx: &mut mpsc::Receiver<Message>, kind: &str) -> Value {
        loop {
            let message = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
                .await
                .expect("no message within 2s")
                .expect("channel closed");
            if let Message::Text(text) = message {
                let value: Value = serde_json::from_str(text.as_str()).unwrap();
                if value["type"] == json!(kind) {
                    return value;
                }
            }
        }
    }

    #[test]
    fn insert_values_take_named_expressions_only() {
        let values = parse_insert_values(&json!([
            { "column": "seen", "value": null, "expr": "now" },
            { "column": "status", "value": null, "expr": "default" },
            { "column": "name", "value": "x" },
        ]))
        .unwrap();
        let exprs: Vec<Option<ValueExpr>> = values.iter().map(|value| value.expr).collect();
        assert_eq!(
            exprs,
            vec![Some(ValueExpr::Now), Some(ValueExpr::Default), None]
        );
        assert_eq!(values[2].value.as_deref(), Some("x"));
        for bad in [json!("now(); DROP TABLE demo"), json!("NOW"), json!(1)] {
            let refused =
                parse_insert_values(&json!([{ "column": "seen", "value": null, "expr": bad }]));
            assert!(refused.is_err(), "{bad}");
        }
    }

    #[tokio::test]
    async fn an_expression_edit_is_read_back_not_patched() {
        let dir = temp_dir("edit-expr");
        let state = test_state(&dir);
        let (sender, mut rx) = test_sender();
        let slot = slot_for(&state, Some("main")).await.unwrap();
        let run = |id: &str, sql: &str| json!({ "type": "query", "id": id, "sql": sql });
        let now_edit = json!({
            "type": "edit", "session": "q1", "table": "demo",
            "pk": [{ "column": "id", "value": 1 }],
            "column": "created_at", "value": null, "expr": "now", "row": 0, "col": 3,
        });

        handle_query(&state, &sender, &run("q1", "SELECT * FROM demo"), "main").await;
        next_of(&mut rx, "meta").await;
        let before = {
            let session = slot.sessions.lock().await.get("q1").unwrap();
            let guard = session.lock().await;
            guard.data.cell_string(0, 3)
        };
        handle_query(&state, &sender, &run("q2", "BEGIN"), "main").await;
        next_of(&mut rx, "meta").await;

        handle_edit(&state, &sender, &now_edit, "main").await;
        let edited = next_of(&mut rx, "edited").await;
        assert_eq!(
            (edited["expr"].clone(), edited["value"].clone()),
            (json!("now"), Value::Null)
        );
        assert_eq!(edited["rows_affected"], json!(1));
        {
            // The cached cell keeps what it read; the page reads the row again.
            let session = slot.sessions.lock().await.get("q1").unwrap();
            let guard = session.lock().await;
            assert_eq!(guard.data.cell_string(0, 3), before);
        }
        let written = slot
            .engine
            .execute("SELECT created_at = CURRENT_TIMESTAMP OR created_at > datetime('now', '-1 minute') FROM demo WHERE id = 1", 1)
            .await
            .unwrap();
        assert_eq!(written.rows[0][0], json!(1));

        // Rolled back, the results read since are dropped for a fresh read.
        handle_query(&state, &sender, &run("q3", "ROLLBACK"), "main").await;
        let rolled = next_of(&mut rx, "meta").await;
        assert_eq!(rolled["tx"], json!("rolledback"));
        assert_eq!(rolled["invalidate"], json!(true));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn query_replies_carry_the_transaction_state() {
        let dir = temp_dir("query-in-tx");
        let state = test_state(&dir);
        let (sender, mut rx) = test_sender();
        let run = |id: &str, sql: &str| json!({ "type": "query", "id": id, "sql": sql });

        handle_query(&state, &sender, &run("q1", "SELECT 1"), "main").await;
        assert_eq!(next_of(&mut rx, "meta").await["in_tx"], json!(false));
        handle_query(&state, &sender, &run("q2", "BEGIN"), "main").await;
        assert_eq!(next_of(&mut rx, "meta").await["in_tx"], json!(true));
        // A failed statement leaves the transaction open, and says so.
        handle_query(&state, &sender, &run("q3", "SELECT * FROM nope"), "main").await;
        let failed = next_of(&mut rx, "error").await;
        assert_eq!(failed["id"], json!("q3"));
        assert_eq!(failed["in_tx"], json!(true));
        handle_query(&state, &sender, &run("q4", "COMMIT"), "main").await;
        assert_eq!(next_of(&mut rx, "meta").await["in_tx"], json!(false));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_transaction_ended_from_the_editor_settles_cached_results() {
        let dir = temp_dir("query-tx-end");
        let state = test_state(&dir);
        let (sender, mut rx) = test_sender();
        let slot = slot_for(&state, Some("main")).await.unwrap();
        let run = |id: &str, sql: &str| json!({ "type": "query", "id": id, "sql": sql });

        handle_query(&state, &sender, &run("q1", "SELECT * FROM demo"), "main").await;
        assert!(next_of(&mut rx, "meta").await.get("tx").is_none());
        handle_query(&state, &sender, &run("q2", "BEGIN"), "main").await;
        let began = next_of(&mut rx, "meta").await;
        assert_eq!(
            (began["in_tx"].clone(), began.get("tx")),
            (json!(true), None)
        );

        // A cell edited inside the transaction, as handle_edit records it.
        slot.engine
            .edit(&EditTarget {
                table: "demo".into(),
                pk: vec![PkValue {
                    column: "id".into(),
                    value: json!(1),
                }],
                column: "name".into(),
                value: Some("edited".into()),
                expr: None,
            })
            .await
            .unwrap();
        {
            let session = slot.sessions.lock().await.get("q1").unwrap();
            let mut guard = session.lock().await;
            let old = guard.data.cell_string(0, 1);
            guard.data.patch_cell(0, 1, Some("edited")).unwrap();
            guard.journal.push(JournalEntry::Cell {
                row: 0,
                col: 1,
                old,
            });
        }
        handle_query(&state, &sender, &run("q3", "ROLLBACK"), "main").await;
        let rolled = next_of(&mut rx, "meta").await;
        assert_eq!(rolled["in_tx"], json!(false));
        assert_eq!(rolled["tx"], json!("rolledback"));
        assert!(rolled.get("invalidate").is_none());
        {
            let session = slot.sessions.lock().await.get("q1").unwrap();
            let guard = session.lock().await;
            assert_eq!(guard.data.cell_string(0, 1).as_deref(), Some("user_1"));
            assert!(guard.journal.is_empty());
        }

        // Rows inserted inside a rolled-back transaction: results dropped.
        handle_query(&state, &sender, &run("q4", "BEGIN"), "main").await;
        next_of(&mut rx, "meta").await;
        slot.sessions.lock().await.mark_structural();
        handle_query(&state, &sender, &run("q5", "ROLLBACK"), "main").await;
        let dropped = next_of(&mut rx, "meta").await;
        assert_eq!(dropped["invalidate"], json!(true));
        assert!(slot.sessions.lock().await.get("q1").is_none());

        handle_query(&state, &sender, &run("q6", "BEGIN"), "main").await;
        next_of(&mut rx, "meta").await;
        handle_query(&state, &sender, &run("q7", "COMMIT"), "main").await;
        assert_eq!(next_of(&mut rx, "meta").await["tx"], json!("committed"));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn an_unknown_outcome_drops_cached_results() {
        let dir = temp_dir("unknown-outcome");
        let state = test_state(&dir);
        let slot = slot_for(&state, Some("main")).await.unwrap();
        let cache = |id: &str| {
            let slot = slot.clone();
            let id = id.to_string();
            async move {
                let data = slot.engine.query("SELECT * FROM demo", 10).await.unwrap();
                slot.sessions.lock().await.insert(id, Arc::new(data));
            }
        };

        // Nothing ended and nothing unknown: the results stay.
        cache("a").await;
        assert!(!settle_after_query(&slot, None, false).await);
        assert!(slot.sessions.lock().await.get("a").is_some());
        // A plain rollback reverts cells but keeps the results.
        assert!(!settle_after_query(&slot, Some(false), false).await);
        assert!(slot.sessions.lock().await.get("a").is_some());
        // Unknown, whether or not an end was counted: reload.
        assert!(settle_after_query(&slot, Some(false), true).await);
        assert!(slot.sessions.lock().await.get("a").is_none());
        cache("b").await;
        assert!(settle_after_query(&slot, None, true).await);
        assert!(slot.sessions.lock().await.get("b").is_none());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn console_forwarder_resends_the_log_after_lagging() {
        let dir = temp_dir("console-lag");
        let state = test_state(&dir);
        let (sender, mut rx) = test_sender();
        let mut consoles = HashMap::new();
        handle_console(&state, &sender, &json!({}), "main", &mut consoles).await;
        let reply = next_json(&mut rx).await;
        assert_eq!(reply["reset"], json!(true));

        // The forwarder has not run yet on this single-threaded runtime, so
        // these overflow its channel.
        let slot = slot_for(&state, Some("main")).await.unwrap();
        let log = slot.engine.sql_log();
        for index in 0..1_500 {
            log.record(&format!("SELECT {index}"), Dialect::Sqlite);
        }
        let resent = next_json(&mut rx).await;
        assert_eq!(resent["reset"], json!(true));
        let entries = resent["entries"].as_array().unwrap();
        assert_eq!(entries.len(), tablepeek_engine::sql_log::LOG_CAP);
        assert_eq!(entries.last().unwrap()["sql"], json!("SELECT 1499;"));

        log.record("SELECT 'after'", Dialect::Sqlite);
        let pushed = next_json(&mut rx).await;
        assert_eq!(pushed["reset"], json!(false));
        assert_eq!(console_sqls(&pushed), vec!["SELECT 'after';"]);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn conns_registry_list_open_delete() {
        let dir = temp_dir("conns-registry");
        let state = test_state(&dir);
        let headers = test_headers();

        let listed = conns_list(State(state.clone()), headers.clone())
            .await
            .unwrap();
        let conns = listed.0["conns"].as_array().unwrap();
        assert_eq!(conns.len(), 1);
        assert_eq!(conns[0]["id"], json!("main"));
        assert_eq!(conns[0]["is_default"], json!(true));

        let opened = open(
            State(state.clone()),
            headers.clone(),
            Json(OpenRequest { path: None }),
        )
        .await
        .unwrap();
        let new_id = opened.0["conn"].as_str().unwrap().to_string();
        assert_ne!(new_id, "main");
        assert_eq!(opened.0["meta"]["demo"], json!(true));

        let listed = conns_list(State(state.clone()), headers.clone())
            .await
            .unwrap();
        assert_eq!(listed.0["conns"].as_array().unwrap().len(), 2);

        let err = conns_delete(
            State(state.clone()),
            AxumPath("main".into()),
            headers.clone(),
        )
        .await
        .unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);

        let _ = conns_delete(
            State(state.clone()),
            AxumPath(new_id.clone()),
            headers.clone(),
        )
        .await
        .unwrap();
        let err = conns_delete(State(state.clone()), AxumPath(new_id), headers)
            .await
            .unwrap_err();
        assert_eq!(err.0, StatusCode::NOT_FOUND);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn meta_route_scopes_by_conn() {
        let dir = temp_dir("conns-meta");
        let state = test_state(&dir);
        let headers = test_headers();

        let missing = meta(
            State(state.clone()),
            headers.clone(),
            Query(ConnQuery {
                conn: Some("nope".into()),
                system: None,
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(missing.0, StatusCode::NOT_FOUND);

        let ok = meta(
            State(state.clone()),
            headers,
            Query(ConnQuery {
                conn: None,
                system: None,
            }),
        )
        .await
        .unwrap();
        assert!(ok.0.demo);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn relations_route_lists_foreign_keys_of_a_conn() {
        let dir = temp_dir("relations-route");
        let state = test_state(&dir);
        let headers = test_headers();
        let params = |conn: Option<&str>| {
            Query(ConnQuery {
                conn: conn.map(str::to_string),
                system: None,
            })
        };

        let err = relations_route(State(state.clone()), HeaderMap::new(), params(None))
            .await
            .unwrap_err();
        assert_eq!(err.0, StatusCode::UNAUTHORIZED);
        let missing = relations_route(State(state.clone()), headers.clone(), params(Some("nope")))
            .await
            .unwrap_err();
        assert_eq!(missing.0, StatusCode::NOT_FOUND);

        let slot = slot_for(&state, None).await.unwrap();
        for sql in [
            "CREATE TABLE users (id INTEGER PRIMARY KEY)",
            "CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users (id))",
        ] {
            slot.engine.execute(sql, 1).await.unwrap();
        }
        let ok = relations_route(State(state.clone()), headers, params(None))
            .await
            .unwrap();
        assert_eq!(
            ok.0,
            json!({ "relations": [
                { "table": "orders", "columns": ["user_id"], "ref_table": "users", "ref_columns": ["id"] }
            ] })
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn table_route_missing_table_returns_404() {
        let dir = temp_dir("table-404");
        let state = test_state(&dir);
        let headers = test_headers();

        let err = table_info(
            State(state.clone()),
            headers.clone(),
            Query(TableParams {
                name: Some("없는테이블".into()),
                conn: None,
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.0, StatusCode::NOT_FOUND);
        assert_eq!(err.1.code, "not_found");
        assert_eq!(err.1.message, "테이블을 찾을 수 없습니다");

        let err = table_info(
            State(state.clone()),
            headers,
            Query(TableParams {
                name: None,
                conn: None,
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1.code, "invalid_request");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn kill_route_validates_session_id() {
        let dir = temp_dir("kill-validation");
        let state = test_state(&dir);
        let headers = test_headers();

        let err = kill_route(
            State(state.clone()),
            headers.clone(),
            Query(ConnQuery {
                conn: None,
                system: None,
            }),
            Json(KillRequest {
                session_id: "1; KILL".into(),
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1.code, "invalid_request");

        let err = kill_route(
            State(state.clone()),
            headers,
            Query(ConnQuery {
                conn: None,
                system: None,
            }),
            Json(KillRequest {
                session_id: "1".into(),
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1.code, "bad_request");
        assert_eq!(err.1.message, "이 엔진은 세션 종료를 지원하지 않습니다");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn definition_route_missing_object_returns_404() {
        let dir = temp_dir("definition-404");
        let state = test_state(&dir);
        let headers = test_headers();

        let err = definition_route(
            State(state.clone()),
            headers.clone(),
            Query(DefinitionParams {
                kind: Some("view".into()),
                name: Some("없는뷰".into()),
                conn: None,
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.0, StatusCode::NOT_FOUND);
        assert_eq!(err.1.code, "not_found");
        assert_eq!(err.1.message, "정의를 찾을 수 없습니다");

        let err = definition_route(
            State(state.clone()),
            headers,
            Query(DefinitionParams {
                kind: Some("table".into()),
                name: Some("demo".into()),
                conn: None,
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1.code, "invalid_request");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    // Long enough on the demo's SQLite to be cancelled midway.
    const SLOW: &str = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 5000000) SELECT count(*) FROM c";

    fn gate_slot() -> Arc<ConnSlot> {
        Arc::new(ConnSlot::new(
            "gate".into(),
            "gate".into(),
            None,
            None,
            Engine::open_demo(1).unwrap(),
        ))
    }

    async fn until_held(slot: &ConnSlot, holder: Holder) {
        for _ in 0..500 {
            if slot.holder() == holder {
                // Into the statement itself, past the gate.
                tokio::time::sleep(std::time::Duration::from_millis(40)).await;
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
        panic!("{holder:?} never held the gate");
    }

    #[tokio::test]
    async fn a_cancel_stops_the_pages_statement_but_never_a_jobs() {
        let slot = gate_slot();
        for (holder, cancelled) in [(Holder::Foreground, true), (Holder::Job, false)] {
            let running = slot.clone();
            let task = tokio::spawn(async move {
                running
                    .gated(holder, holder == Holder::Job, running.engine.query(SLOW, 1))
                    .await
            });
            until_held(&slot, holder).await;
            slot.cancel_if_inflight();
            let outcome = task.await.unwrap();
            assert_eq!(
                outcome
                    .as_ref()
                    .err()
                    .is_some_and(EngineError::is_interrupted),
                cancelled,
                "{holder:?}: {:?}",
                outcome.as_ref().err()
            );
            assert_eq!(slot.holder(), Holder::Idle);
        }
    }

    #[tokio::test]
    async fn nothing_is_cancelled_while_a_jobs_transaction_is_open() {
        let slot = gate_slot();
        *slot.job_tx.lock().unwrap() = Some(std::time::Instant::now());
        let running = slot.clone();
        let task = tokio::spawn(async move {
            running
                .gated(Holder::Foreground, false, running.engine.query(SLOW, 1))
                .await
        });
        until_held(&slot, Holder::Foreground).await;
        slot.cancel_if_inflight();
        assert!(
            task.await.unwrap().is_ok(),
            "the page's statement ran to its end"
        );
    }

    #[tokio::test]
    async fn the_pages_statement_waits_for_the_jobs_instead_of_cancelling_it() {
        let slot = gate_slot();
        let job = slot.clone();
        let job_task = tokio::spawn(async move {
            let outcome = job
                .gated(Holder::Job, true, job.engine.query(SLOW, 1))
                .await;
            (outcome.is_ok(), std::time::Instant::now())
        });
        until_held(&slot, Holder::Job).await;
        // What handle_query does for the page's next query.
        slot.cancel_if_inflight();
        let page = slot.clone();
        let page_task = tokio::spawn(async move {
            let outcome = page
                .gated(Holder::Foreground, false, page.engine.query("SELECT 1", 1))
                .await;
            (outcome.is_ok(), std::time::Instant::now())
        });
        let (job_ok, job_done) = job_task.await.unwrap();
        let (page_ok, page_done) = page_task.await.unwrap();
        assert!(job_ok && page_ok);
        assert!(
            page_done >= job_done,
            "the page's statement ran after the job's"
        );
    }

    #[tokio::test]
    async fn a_query_the_page_replaced_while_it_waited_is_skipped() {
        let dir = temp_dir("superseded");
        let state = test_state(&dir);
        let slot = slot_for(&state, Some("main")).await.unwrap();
        let (sender, mut rx) = test_sender();
        let job = slot.clone();
        let held = tokio::spawn(async move {
            job.gated(Holder::Job, true, job.engine.query(SLOW, 1))
                .await
        });
        until_held(&slot, Holder::Job).await;
        // Two of the page's queries queue behind the job; the second replaces the first.
        let run = |id: &str, sql: &str| json!({ "type": "query", "id": id, "sql": sql });
        handle_query(&state, &sender, &run("old", "SELECT 1"), "main").await;
        handle_query(&state, &sender, &run("new", "SELECT 2"), "main").await;
        assert!(
            held.await.unwrap().is_ok(),
            "the job's statement ran to its end"
        );
        let mut replies = HashMap::new();
        while replies.len() < 2 {
            let message = next_json(&mut rx).await;
            if let Some(id) = message["id"].as_str() {
                if message["type"] == json!("meta") || message["type"] == json!("error") {
                    replies.insert(id.to_string(), message);
                }
            }
        }
        assert_eq!(replies["old"]["type"], json!("error"));
        assert_eq!(replies["old"]["cancelled"], json!(true));
        assert_eq!(replies["new"]["type"], json!("meta"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    async fn exec_as(
        state: &AppState,
        sql: &str,
        job: bool,
    ) -> Result<Value, (StatusCode, Json<ApiError>)> {
        exec_route(
            State(state.clone()),
            test_headers(),
            Query(ConnQuery {
                conn: None,
                system: None,
            }),
            Json(ExecRequest {
                sql: sql.into(),
                history: false,
                job,
            }),
        )
        .await
        .map(|Json(value)| value)
    }

    async fn job_action(
        state: &AppState,
        action: &str,
    ) -> Result<Value, (StatusCode, Json<ApiError>)> {
        job_route(
            State(state.clone()),
            test_headers(),
            Query(ConnQuery {
                conn: None,
                system: None,
            }),
            Json(JobRequest {
                action: action.into(),
            }),
        )
        .await
        .map(|Json(value)| value)
    }

    #[tokio::test]
    async fn a_transaction_is_the_jobs_when_a_jobs_statement_opened_it() {
        let dir = temp_dir("job-tx-owner");
        let state = test_state(&dir);
        let slot = slot_for(&state, Some("main")).await.unwrap();
        // A restore's dump runs its own BEGIN as a job statement.
        exec_as(&state, "BEGIN", true).await.unwrap();
        assert!(slot.job_tx_open());
        exec_as(&state, "COMMIT", true).await.unwrap();
        assert!(!slot.job_tx_open());
        // The user's own transaction stays the user's, even with an export's
        // read (a job statement) running in it.
        exec_as(&state, "BEGIN", false).await.unwrap();
        exec_as(&state, "SELECT 1", true).await.unwrap();
        assert!(!slot.job_tx_open());
        exec_as(&state, "ROLLBACK", false).await.unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_jobs_stop_reaches_its_own_statement_and_nothing_else() {
        let slot = gate_slot();
        for (holder, cancelled) in [
            (Holder::Job, true),
            (Holder::Foreground, false),
            (Holder::Protected, false),
        ] {
            let running = slot.clone();
            let task = tokio::spawn(async move {
                running
                    .gated(holder, holder == Holder::Job, running.engine.query(SLOW, 1))
                    .await
            });
            until_held(&slot, holder).await;
            slot.cancel_job();
            let outcome = task.await.unwrap();
            assert_eq!(
                outcome
                    .as_ref()
                    .err()
                    .is_some_and(EngineError::is_interrupted),
                cancelled,
                "{holder:?}"
            );
        }
        // Nor does the page's cancel reach a transaction command or an edit.
        let running = slot.clone();
        let task = tokio::spawn(async move {
            running
                .gated(Holder::Protected, false, running.engine.query(SLOW, 1))
                .await
        });
        until_held(&slot, Holder::Protected).await;
        slot.cancel_if_inflight();
        assert!(task.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn whose_transaction_it_is_is_settled_before_the_next_statement_starts() {
        let slot = gate_slot();
        let job = slot.clone();
        let held = tokio::spawn(async move {
            job.gated(Holder::Job, true, job.engine.query(SLOW, 1))
                .await
        });
        until_held(&slot, Holder::Job).await;
        let job = slot.clone();
        let begin = tokio::spawn(async move {
            job.gated(Holder::Protected, true, job.engine.begin_tx())
                .await
        });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        // The page's statement queued right behind the job's BEGIN.
        let page = slot.clone();
        let seen = tokio::spawn(async move {
            page.gated(Holder::Foreground, false, async { page.job_tx_open() })
                .await
        });
        held.await.unwrap().unwrap();
        begin.await.unwrap().unwrap();
        assert!(
            seen.await.unwrap(),
            "the page's statement saw the job's transaction as the job's"
        );
        slot.gated(Holder::Protected, true, slot.engine.rollback_tx())
            .await
            .unwrap();
        assert!(!slot.job_tx_open());
    }

    #[tokio::test]
    async fn a_page_query_doesnt_report_a_transaction_end_a_job_caused() {
        let dir = temp_dir("job-commit-mark");
        let state = test_state(&dir);
        let slot = slot_for(&state, Some("main")).await.unwrap();
        let (sender, mut rx) = test_sender();
        exec_as(&state, "BEGIN", true).await.unwrap();
        let job = slot.clone();
        let held = tokio::spawn(async move {
            job.gated(Holder::Job, true, job.engine.query(SLOW, 1))
                .await
        });
        until_held(&slot, Holder::Job).await;
        // The job's COMMIT queues first, then the page's query.
        let commit_state = state.clone();
        let commit = tokio::spawn(async move { exec_as(&commit_state, "COMMIT", true).await });
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        handle_query(
            &state,
            &sender,
            &json!({ "type": "query", "id": "page", "sql": "SELECT 1" }),
            "main",
        )
        .await;
        held.await.unwrap().unwrap();
        commit.await.unwrap().unwrap();
        let meta = next_of(&mut rx, "meta").await;
        assert_eq!(meta["id"], json!("page"));
        assert_eq!(meta["tx"], Value::Null, "the job's COMMIT isn't the page's");
        assert_eq!(meta["in_tx"], json!(false));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn the_page_can_read_but_not_write_or_end_a_jobs_transaction() {
        let dir = temp_dir("job-refusals");
        let state = test_state(&dir);
        let (sender, mut rx) = test_sender();
        exec_as(&state, "BEGIN", true).await.unwrap();
        // Another tab's exec: a read runs, a write is refused.
        exec_as(&state, "SELECT COUNT(*) FROM demo", false)
            .await
            .unwrap();
        let refused = exec_as(&state, "DELETE FROM demo", false)
            .await
            .unwrap_err();
        assert_eq!(refused.1 .0.message, JOB_BUSY);
        // Its transaction commands, queries that write, and row changes.
        handle_tx(
            &state,
            &sender,
            &json!({ "type": "tx", "action": "commit" }),
            "main",
        )
        .await;
        assert_eq!(next_of(&mut rx, "error").await["message"], json!(JOB_BUSY));
        handle_query(
            &state,
            &sender,
            &json!({ "type": "query", "id": "w", "sql": "UPDATE demo SET name = 'x'" }),
            "main",
        )
        .await;
        let write = next_of(&mut rx, "error").await;
        assert_eq!(
            (write["id"].clone(), write["message"].clone()),
            (json!("w"), json!(JOB_BUSY))
        );
        handle_query(
            &state,
            &sender,
            &json!({ "type": "query", "id": "r", "sql": "SELECT * FROM demo" }),
            "main",
        )
        .await;
        assert_eq!(next_of(&mut rx, "meta").await["id"], json!("r"));
        let delete = json!({ "type": "delete_row", "id": "d", "session": "none", "table": "demo", "pk": [{ "column": "id", "value": 1 }] });
        handle_row_change(&state, &sender, &delete, "main", RowOp::Delete).await;
        assert_eq!(next_of(&mut rx, "error").await["message"], json!(JOB_BUSY));
        // Starting another job is refused too.
        assert_eq!(
            job_action(&state, "start").await.unwrap_err().1 .0.message,
            JOB_BUSY
        );
        exec_as(&state, "COMMIT", true).await.unwrap();
        exec_as(&state, "DELETE FROM demo WHERE id = -1", false)
            .await
            .unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_job_starts_only_with_no_transaction_open_and_its_end_hands_one_over() {
        let dir = temp_dir("job-start-end");
        let state = test_state(&dir);
        let slot = slot_for(&state, Some("main")).await.unwrap();
        exec_as(&state, "BEGIN", false).await.unwrap();
        let refused = job_action(&state, "start").await.unwrap_err();
        assert!(refused.1 .0.message.contains("트랜잭션이 열려 있습니다"));
        exec_as(&state, "ROLLBACK", false).await.unwrap();
        job_action(&state, "start").await.unwrap();
        // The job's ROLLBACK failed, say: its transaction is still open.
        exec_as(&state, "BEGIN", true).await.unwrap();
        assert!(slot.job_tx_open());
        job_action(&state, "end").await.unwrap();
        assert!(
            !slot.job_tx_open(),
            "the leftover transaction is the user's now"
        );
        exec_as(&state, "ROLLBACK", false).await.unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_jobs_result_is_kept_before_its_meta_goes_out() {
        let dir = temp_dir("job-session-order");
        let state = test_state(&dir);
        let slot = slot_for(&state, Some("main")).await.unwrap();
        let (sender, mut rx) = test_sender();
        handle_query(
            &state,
            &sender,
            &json!({ "type": "query", "id": "page-1", "sql": "SELECT 1", "job": true }),
            "main",
        )
        .await;
        let meta = next_of(&mut rx, "meta").await;
        assert_eq!(meta["id"], json!("page-1"));
        // A release sent the moment the meta arrives finds it.
        assert!(slot.sessions.lock().await.get("page-1").is_some());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_row_change_waits_its_turn_at_the_gate() {
        let dir = temp_dir("row-change-gate");
        let state = test_state(&dir);
        let slot = slot_for(&state, Some("main")).await.unwrap();
        let (sender, mut rx) = test_sender();
        let job = slot.clone();
        let held = tokio::spawn(async move {
            let outcome = job
                .gated(Holder::Job, true, job.engine.query(SLOW, 1))
                .await;
            (outcome, std::time::Instant::now())
        });
        until_held(&slot, Holder::Job).await;
        let delete = json!({ "type": "delete_row", "id": "d", "session": "none", "table": "demo", "pk": [{ "column": "id", "value": -1 }] });
        let change_state = state.clone();
        let change_sender = sender.clone();
        let change = tokio::spawn(async move {
            handle_row_change(
                &change_state,
                &change_sender,
                &delete,
                "main",
                RowOp::Delete,
            )
            .await;
            std::time::Instant::now()
        });
        let (outcome, job_done) = held.await.unwrap();
        assert!(outcome.is_ok());
        let change_done = change.await.unwrap();
        assert!(
            change_done >= job_done,
            "the row change ran after the job's statement"
        );
        assert_eq!(next_of(&mut rx, "row_change").await["id"], json!("d"));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_jobs_results_never_push_out_the_pages_and_go_when_released() {
        let mut store = SessionStore::new(SESSION_CAP);
        let data = Arc::new(QueryData::empty());
        store.insert("page-1".into(), data.clone());
        store.insert("page-2".into(), data.clone());
        for page in 0..(SESSION_CAP * 3) {
            store.insert_job(format!("export-{page}"), data.clone());
        }
        assert!(store.get("page-1").is_some() && store.get("page-2").is_some());
        let kept = (0..SESSION_CAP * 3)
            .filter(|page| store.get(&format!("export-{page}")).is_some())
            .count();
        assert_eq!(kept, JOB_SESSION_CAP);
        let last = format!("export-{}", SESSION_CAP * 3 - 1);
        store.remove(&last);
        assert!(store.get(&last).is_none());
        store.remove("page-1");
        assert!(store.get("page-1").is_none() && store.get("page-2").is_some());
    }
}
