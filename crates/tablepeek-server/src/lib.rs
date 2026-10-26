use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
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
use tablepeek_engine::sql_log::{Change, LogEntry};
use tablepeek_engine::{Engine, EngineError, QueryData};
use tablepeek_types::{
    ApiError, ConnectRequest, DbObjects, EditTarget, EngineMeta, FsEntry, FsListing, InsertValue,
    ObjectDefinition, PkValue, QueryResult, ServerInfo, TableDetail, TableSchema, ValueExpr,
};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::{broadcast, mpsc};

pub mod store;
pub mod transfer;
pub mod tunnel;

#[derive(RustEmbed)]
#[folder = "$CARGO_MANIFEST_DIR/../../web/dist"]
struct Assets;

pub const SESSION_CAP: usize = 8;
// Results a job (an export page) is still reading: kept apart from the page's
// own, which they'd otherwise push out, until the job releases them.
pub const JOB_SESSION_CAP: usize = 4;
// How long a job's statement waits for a cancel meant for the statement
// before it to land, at most.
const CANCEL_SETTLE: std::time::Duration = std::time::Duration::from_secs(2);

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
    pub tunnel: Arc<tokio::sync::Mutex<Option<tunnel::Tunnel>>>,
    pub inflight: Arc<AtomicUsize>,
    // Last known meta summary, so listing connections needs no database round
    // trip (and never waits behind a long query holding the engine lock).
    summary: std::sync::Mutex<Option<SlotSummary>>,
    // One statement at a time on the session (the engine runs them one by
    // one anyway), and what kind it is: a cancel reaches the page's own work,
    // never a job's.
    gate: tokio::sync::Mutex<()>,
    holder: std::sync::Mutex<Holder>,
    // A job's transaction (an import's) is open on the session.
    job_tx: AtomicBool,
}

/// Whose statement runs on a connection's session now.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Holder {
    Idle,
    // The page's own: a newer query cancels it, as moving to another table
    // does.
    Foreground,
    // A background job's (an import's chunk, a restore's statement, an
    // export's page) or a transaction command: never cancelled from here.
    Job,
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
            job_tx: AtomicBool::new(false),
        }
    }

    /// What this slot's history and safe mode are filed under: its saved
    /// profile, its SQLite file, the demo, or, for a server connection that was
    /// never saved, this session alone.
    fn history_scope(&self) -> String {
        if let Some(id) = &self.saved_id {
            return store::saved_scope(id);
        }
        if self.origin.is_some() {
            return format!("{}{}", store::SESSION_PREFIX, self.id);
        }
        match self.engine.sqlite_file() {
            // One file, one scope, however its path was spelled (relative,
            // through a symlink, with ".."), and never two files under one.
            Some(path) => {
                let path = std::fs::canonicalize(&path).unwrap_or(path);
                format!("file:{}", path.display())
            }
            None => "demo".to_string(),
        }
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

    /// Runs one statement through the session's gate, as `holder`. A job's
    /// waits first for cancels already sent to land, so one meant for the
    /// page's previous statement can't stop it.
    pub async fn gated<T>(&self, holder: Holder, run: impl std::future::Future<Output = T>) -> T {
        let _gate = self.gate.lock().await;
        if holder == Holder::Job {
            self.engine.cancels_settled(CANCEL_SETTLE).await;
        }
        self.set_holder(holder);
        let _reset = HolderReset(self);
        run.await
    }

    /// Cancels the page's statement running now, if one is. Not a job's,
    /// and nothing while a job's transaction is open: a cancel would abort it
    /// on PostgreSQL and end the whole session on SQL Server, so the page's
    /// statement runs to its end instead.
    fn cancel_if_inflight(&self) {
        let holder = self
            .holder
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if *holder == Holder::Foreground && !self.job_tx.load(Ordering::SeqCst) {
            self.engine.cancel();
        }
    }

    /// The page's statement while a job's transaction is open: PostgreSQL
    /// would abort that transaction (the job's work with it) if the statement
    /// failed, so it runs under a savepoint of its own there.
    async fn foreground_query(&self, sql: &str, max_rows: usize) -> Result<QueryData, EngineError> {
        if !(self.job_tx.load(Ordering::SeqCst) && self.engine.failure_aborts_transaction()) {
            return self.engine.query(sql, max_rows).await;
        }
        self.engine.query("SAVEPOINT tablepeek_page", 1).await?;
        let outcome = self.engine.query(sql, max_rows).await;
        // A failure is undone back to the savepoint, which then goes too.
        let usable = outcome.is_ok()
            || self
                .engine
                .query("ROLLBACK TO SAVEPOINT tablepeek_page", 1)
                .await
                .is_ok();
        if usable {
            let _ = self.engine.query("RELEASE SAVEPOINT tablepeek_page", 1).await;
        }
        outcome
    }

    /// After a statement: a transaction that is gone (ended from the editor,
    /// lost with the session) no longer holds the job's.
    async fn settle_job_tx(&self) {
        if self.job_tx.load(Ordering::SeqCst) && !self.engine.in_tx().await.unwrap_or(false) {
            self.job_tx.store(false, Ordering::SeqCst);
        }
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
        .route("/api/meta", get(meta))
        .route("/api/open", post(open))
        .route("/api/connect", post(connect))
        .route("/api/conns", get(conns_list))
        .route("/api/conns/{id}", delete(conns_delete))
        .route("/api/fs/list", get(fs_list))
        .route("/api/fs/stat", get(fs_stat))
        .route("/api/schema", get(schema_route))
        .route("/api/count", get(count_route))
        .route("/api/exec", post(exec_route))
        .route("/api/databases", get(databases_route))
        .route("/api/switch-db", post(switch_db_route))
        .route("/api/query", post(query))
        .route("/api/table", get(table_info))
        .route("/api/server", get(server_info_route))
        .route("/api/objects", get(objects_route))
        .route("/api/definition", get(definition_route))
        .route("/api/kill", post(kill_route))
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
        .layer(middleware::from_fn_with_state(state.clone(), host_guard))
        .with_state(state)
}

pub async fn serve(listener: tokio::net::TcpListener, state: AppState) -> std::io::Result<()> {
    // Slots opened before the server (the --db or --demo one) were not
    // registered through register_slot.
    for slot in state.registry.lock().await.list() {
        record_gui_changes(&state, &slot);
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

fn unauthorized() -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::UNAUTHORIZED,
        Json(ApiError {
            code: "unauthorized".into(),
            message: "토큰이 유효하지 않습니다".into(),
        }),
    )
}

fn engine_error(err: EngineError) -> (StatusCode, Json<ApiError>) {
    if err.is_interrupted() {
        return (
            StatusCode::BAD_REQUEST,
            Json(ApiError {
                code: "interrupted".into(),
                message: err.to_string(),
            }),
        );
    }
    let (status, code) = match &err {
        EngineError::NotFound(_) => (StatusCode::NOT_FOUND, "not_found"),
        EngineError::NotAFile(_) => (StatusCode::BAD_REQUEST, "not_a_sqlite_file"),
        EngineError::NotEditable(_) => (StatusCode::BAD_REQUEST, "not_editable"),
        EngineError::BadRequest(_) => (StatusCode::BAD_REQUEST, "bad_request"),
        EngineError::TableNotFound => (StatusCode::NOT_FOUND, "not_found"),
        EngineError::SessionNotFound => (StatusCode::NOT_FOUND, "not_found"),
        EngineError::TxRolledBack(_) => (StatusCode::CONFLICT, "tx_rolled_back"),
        EngineError::TxOutcomeUnknown(_) => (StatusCode::CONFLICT, "tx_outcome_unknown"),
        EngineError::Sqlite(_) => (StatusCode::BAD_REQUEST, "sqlite_error"),
        EngineError::Postgres { .. } => (StatusCode::BAD_REQUEST, "postgres_error"),
        EngineError::MySql(_) => (StatusCode::BAD_REQUEST, "mysql_error"),
        EngineError::Mssql(_) => (StatusCode::BAD_REQUEST, "mssql_error"),
        EngineError::Arrow(_) | EngineError::Internal(_) => {
            (StatusCode::INTERNAL_SERVER_ERROR, "internal")
        }
    };
    (
        status,
        Json(ApiError {
            code: code.into(),
            message: err.to_string(),
        }),
    )
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
    let holder = if req.job { Holder::Job } else { Holder::Foreground };
    let result = slot
        .gated(holder, async {
            if req.job {
                slot.engine.execute(sql, 1).await
            } else {
                slot.foreground_query(sql, 1).await.map(|data| QueryResult {
                    columns: data.columns.clone(),
                    row_count: data.row_count,
                    rows: data.rows_json(),
                    elapsed_ms: data.elapsed_ms,
                    truncated: data.truncated,
                })
            }
        })
        .await;
    slot.settle_job_tx().await;
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
        "rows": result.rows.iter().take(1000).collect::<Vec<_>>(),
        "row_count": result.row_count,
        "elapsed_ms": result.elapsed_ms,
    })))
}

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
    let mut next = origin.clone();
    match next.driver.as_str() {
        "postgres" => {
            if let Some(config) = next.postgres.as_mut() {
                config.database = database.clone();
            } else {
                return Err(bad_request(
                    "missing_config",
                    "PostgreSQL 접속 정보가 없습니다",
                ));
            }
        }
        "cockroach" => {
            if let Some(config) = next.cockroach.as_mut() {
                config.database = database.clone();
            } else {
                return Err(bad_request(
                    "missing_config",
                    "CockroachDB 접속 정보가 없습니다",
                ));
            }
        }
        "mysql" => {
            if let Some(config) = next.mysql.as_mut() {
                config.database = database.clone();
            } else {
                return Err(bad_request("missing_config", "MySQL 접속 정보가 없습니다"));
            }
        }
        "mssql" => {
            if let Some(config) = next.mssql.as_mut() {
                config.database = database.clone();
            } else {
                return Err(bad_request(
                    "missing_config",
                    "SQL Server 접속 정보가 없습니다",
                ));
            }
        }
        _ => {
            return Err(bad_request(
                "unsupported_driver",
                "이 드라이버는 데이터베이스 전환을 지원하지 않습니다",
            ));
        }
    }
    if next.ssh.is_some() {
        let guard = slot.tunnel.lock().await;
        let Some(tunnel) = guard.as_ref() else {
            return Err(internal_error("SSH 터널이 닫혀 있습니다"));
        };
        let local_port = tunnel.local_port;
        let host = "127.0.0.1".to_string();
        match next.driver.as_str() {
            "postgres" => {
                if let Some(config) = next.postgres.as_mut() {
                    config.host = host;
                    config.port = local_port;
                }
            }
            "cockroach" => {
                if let Some(config) = next.cockroach.as_mut() {
                    config.host = host;
                    config.port = local_port;
                }
            }
            "mysql" => {
                if let Some(config) = next.mysql.as_mut() {
                    config.host = host;
                    config.port = local_port;
                }
            }
            "mssql" => {
                if let Some(config) = next.mssql.as_mut() {
                    config.host = host;
                    config.port = local_port;
                }
            }
            _ => {}
        }
    }
    slot.cancel_if_inflight();
    slot.engine.cancel();
    {
        let mut sessions = slot.sessions.lock().await;
        sessions.clear();
    }
    let meta = match next.driver.as_str() {
        "postgres" => {
            slot.engine
                .swap_to_postgres(next.postgres.as_ref().expect("checked above"))
                .await
        }
        "cockroach" => {
            slot.engine
                .swap_to_cockroach(next.cockroach.as_ref().expect("checked above"))
                .await
        }
        "mysql" => {
            slot.engine
                .swap_to_mysql(next.mysql.as_ref().expect("checked above"))
                .await
        }
        "mssql" => {
            slot.engine
                .swap_to_mssql(next.mssql.as_ref().expect("checked above"))
                .await
        }
        _ => unreachable!(),
    }
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

fn bad_request(code: &str, message: impl Into<String>) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::BAD_REQUEST,
        Json(ApiError {
            code: code.into(),
            message: message.into(),
        }),
    )
}

fn internal_error(message: impl Into<String>) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ApiError {
            code: "internal".into(),
            message: message.into(),
        }),
    )
}

fn not_found(message: &str) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::NOT_FOUND,
        Json(ApiError {
            code: "not_found".into(),
            message: message.into(),
        }),
    )
}

fn store_error(message: String) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ApiError {
            code: "store_error".into(),
            message,
        }),
    )
}

fn keyring_error(message: String) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(ApiError {
            code: "keyring_error".into(),
            message,
        }),
    )
}

struct ConnectError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl ConnectError {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    fn into_response(self) -> (StatusCode, Json<ApiError>) {
        (
            self.status,
            Json(ApiError {
                code: self.code.into(),
                message: self.message,
            }),
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

async fn open_external_tunnel(
    req: &ConnectRequest,
    target_host: &str,
    target_port: u16,
) -> Result<Option<tunnel::Tunnel>, String> {
    if req.ssh.is_some() && req.http_tunnel.is_some() {
        return Err("SSH와 HTTP 터널은 동시에 사용할 수 없습니다".into());
    }
    if let Some(ssh) = req.ssh.as_ref() {
        return tunnel::open(ssh, target_host, target_port).await.map(Some);
    }
    if let Some(tunnel_config) = req.http_tunnel.as_ref() {
        return tunnel::open_http(tunnel_config, target_host, target_port)
            .await
            .map(Some);
    }
    Ok(None)
}

async fn connect_with(
    state: &AppState,
    req: ConnectRequest,
    origin: SlotOrigin,
) -> Result<(Arc<ConnSlot>, EngineMeta), ConnectError> {
    let outcome = match req.driver.as_str() {
        "postgres" => connect_postgres(state, req, origin).await,
        "cockroach" => connect_cockroach(state, req, origin).await,
        "mysql" => connect_mysql(state, req, origin).await,
        "mssql" => connect_mssql(state, req, origin).await,
        _ => Err(ConnectError::new(
            StatusCode::BAD_REQUEST,
            "unsupported_driver",
            "지원하지 않는 드라이버입니다",
        )),
    };
    if let Ok((slot, meta)) = &outcome {
        slot.remember(slot.engine.epoch(), meta);
    }
    outcome
}

async fn connect_postgres(
    state: &AppState,
    req: ConnectRequest,
    origin: SlotOrigin,
) -> Result<(Arc<ConnSlot>, EngineMeta), ConnectError> {
    let Some(mut config) = req.postgres.clone() else {
        return Err(connect_failed("PostgreSQL 접속 정보가 없습니다"));
    };
    let original_host = config.host.clone();
    let original_port = config.port;
    let tunnel = open_external_tunnel(&req, &config.host, config.port)
        .await
        .map_err(connect_failed)?;
    if let Some(opened) = tunnel.as_ref() {
        config.host = "127.0.0.1".into();
        config.port = opened.local_port;
    }
    let label = origin.label.unwrap_or_else(|| {
        format!(
            "{}@{}:{}/{}",
            config.user, original_host, original_port, config.database
        )
    });
    let engine = Engine::open_demo(0).map_err(|err| connect_failed(err.to_string()))?;
    match engine.swap_to_postgres(&config).await {
        Ok(mut meta) => {
            if req.ssh.is_some() || req.http_tunnel.is_some() {
                meta.path = Some(format!(
                    "{}@{}:{}/{}",
                    config.user, original_host, original_port, config.database
                ));
            }
            let slot =
                register_slot(state, label, origin.saved_id, Some(req.clone()), engine).await;
            *slot.tunnel.lock().await = tunnel;
            Ok((slot, meta))
        }
        Err(err) => Err(connect_failed(err.to_string())),
    }
}

async fn connect_mysql(
    state: &AppState,
    req: ConnectRequest,
    origin: SlotOrigin,
) -> Result<(Arc<ConnSlot>, EngineMeta), ConnectError> {
    let Some(mut config) = req.mysql.clone() else {
        return Err(connect_failed("MySQL 접속 정보가 없습니다"));
    };
    let original_host = config.host.clone();
    let original_port = config.port;
    let tunnel = open_external_tunnel(&req, &config.host, config.port)
        .await
        .map_err(connect_failed)?;
    if let Some(opened) = tunnel.as_ref() {
        config.host = "127.0.0.1".into();
        config.port = opened.local_port;
    }
    let label = origin.label.unwrap_or_else(|| {
        format!(
            "{}@{}:{}/{}",
            config.user, original_host, original_port, config.database
        )
    });
    let engine = Engine::open_demo(0).map_err(|err| connect_failed(err.to_string()))?;
    match engine.swap_to_mysql(&config).await {
        Ok(mut meta) => {
            if req.ssh.is_some() || req.http_tunnel.is_some() {
                meta.path = Some(format!(
                    "{}@{}:{}/{}",
                    config.user, original_host, original_port, config.database
                ));
            }
            let slot =
                register_slot(state, label, origin.saved_id, Some(req.clone()), engine).await;
            *slot.tunnel.lock().await = tunnel;
            Ok((slot, meta))
        }
        Err(err) => Err(connect_failed(err.to_string())),
    }
}

async fn connect_cockroach(
    state: &AppState,
    req: ConnectRequest,
    origin: SlotOrigin,
) -> Result<(Arc<ConnSlot>, EngineMeta), ConnectError> {
    let Some(mut config) = req.cockroach.clone() else {
        return Err(connect_failed("CockroachDB 접속 정보가 없습니다"));
    };
    let original_host = config.host.clone();
    let original_port = config.port;
    let tunnel = open_external_tunnel(&req, &config.host, config.port)
        .await
        .map_err(connect_failed)?;
    if let Some(opened) = tunnel.as_ref() {
        config.host = "127.0.0.1".into();
        config.port = opened.local_port;
    }
    let label = origin.label.unwrap_or_else(|| {
        format!(
            "{}@{}:{}/{}",
            config.user, original_host, original_port, config.database
        )
    });
    let engine = Engine::open_demo(0).map_err(|err| connect_failed(err.to_string()))?;
    match engine.swap_to_cockroach(&config).await {
        Ok(mut meta) => {
            if req.ssh.is_some() || req.http_tunnel.is_some() {
                meta.path = Some(format!(
                    "{}@{}:{}/{}",
                    config.user, original_host, original_port, config.database
                ));
            }
            let slot =
                register_slot(state, label, origin.saved_id, Some(req.clone()), engine).await;
            *slot.tunnel.lock().await = tunnel;
            Ok((slot, meta))
        }
        Err(err) => Err(connect_failed(err.to_string())),
    }
}

async fn connect_mssql(
    state: &AppState,
    req: ConnectRequest,
    origin: SlotOrigin,
) -> Result<(Arc<ConnSlot>, EngineMeta), ConnectError> {
    let Some(mut config) = req.mssql.clone() else {
        return Err(connect_failed("SQL Server 접속 정보가 없습니다"));
    };
    let original_host = config.host.clone();
    let original_port = config.port;
    let tunnel = open_external_tunnel(&req, &config.host, config.port)
        .await
        .map_err(connect_failed)?;
    if let Some(opened) = tunnel.as_ref() {
        config.host = "127.0.0.1".into();
        config.port = opened.local_port;
    }
    let label = origin.label.unwrap_or_else(|| {
        format!(
            "{}@{}:{}/{}",
            config.user, original_host, original_port, config.database
        )
    });
    let engine = Engine::open_demo(0).map_err(|err| connect_failed(err.to_string()))?;
    match engine.swap_to_mssql(&config).await {
        Ok(mut meta) => {
            if req.ssh.is_some() || req.http_tunnel.is_some() {
                meta.path = Some(format!(
                    "{}@{}:{}/{}",
                    config.user, original_host, original_port, config.database
                ));
            }
            let slot =
                register_slot(state, label, origin.saved_id, Some(req.clone()), engine).await;
            *slot.tunnel.lock().await = tunnel;
            Ok((slot, meta))
        }
        Err(err) => Err(connect_failed(err.to_string())),
    }
}

async fn connect(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ConnectRequest>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
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

fn connection_json(connection: &store::SavedConnection) -> Value {
    let mut value = serde_json::to_value(connection).unwrap_or(Value::Null);
    if let Some(object) = value.as_object_mut() {
        object.insert(
            "has_password".into(),
            Value::Bool(connection.persist_password),
        );
    }
    value
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
fn connect_problem(connect: &ConnectRequest) -> Option<(&'static str, &'static str)> {
    let missing = match connect.driver.as_str() {
        "postgres" => connect.postgres.is_none().then_some("PostgreSQL 접속 정보가 없습니다"),
        "cockroach" => connect
            .cockroach
            .is_none()
            .then_some("CockroachDB 접속 정보가 없습니다"),
        "mysql" => connect.mysql.is_none().then_some("MySQL 접속 정보가 없습니다"),
        "mssql" => connect.mssql.is_none().then_some("SQL Server 접속 정보가 없습니다"),
        _ => return Some(("unsupported_driver", "지원하지 않는 드라이버입니다")),
    };
    if let Some(message) = missing {
        return Some(("invalid_request", message));
    }
    let host = match connect.driver.as_str() {
        "mysql" => connect.mysql.as_ref().map(|c| c.host.as_str()),
        "cockroach" => connect.cockroach.as_ref().map(|c| c.host.as_str()),
        "mssql" => connect.mssql.as_ref().map(|c| c.host.as_str()),
        _ => connect.postgres.as_ref().map(|c| c.host.as_str()),
    }
    .unwrap_or("");
    // A pasted URL in the host field would otherwise be stored verbatim, password included.
    if host.contains("://")
        || host
            .chars()
            .any(|ch| ch.is_whitespace() || matches!(ch, '/' | '@' | '?'))
    {
        return Some((
            "invalid_request",
            "호스트에는 주소만 입력하세요 (URL·계정 정보 제외)",
        ));
    }
    None
}

fn request_db_password(connect: &ConnectRequest) -> Option<&str> {
    match connect.driver.as_str() {
        "mysql" => connect.mysql.as_ref().and_then(|c| c.password.as_deref()),
        "cockroach" => connect.cockroach.as_ref().and_then(|c| c.password.as_deref()),
        "mssql" => connect.mssql.as_ref().and_then(|c| c.password.as_deref()),
        _ => connect.postgres.as_ref().and_then(|c| c.password.as_deref()),
    }
    .filter(|password| !password.is_empty())
}

fn set_request_db_password(connect: &mut ConnectRequest, password: String) {
    match connect.driver.as_str() {
        "mysql" => {
            if let Some(config) = connect.mysql.as_mut() {
                config.password = Some(password);
            }
        }
        "cockroach" => {
            if let Some(config) = connect.cockroach.as_mut() {
                config.password = Some(password);
            }
        }
        "mssql" => {
            if let Some(config) = connect.mssql.as_mut() {
                config.password = Some(password);
            }
        }
        _ => {
            if let Some(config) = connect.postgres.as_mut() {
                config.password = Some(password);
            }
        }
    }
}

fn delete_connection_passwords(id: &str) {
    for kind in ["postgres", "cockroach", "mysql", "mssql", "ssh", "http"] {
        store::delete_password(&store::connection_account(id, kind));
    }
}

// Shared by create and update. On update an empty password keeps the stored
// one (moved to the new driver's account if the driver changed).
async fn save_connection(
    state: &AppState,
    id: &str,
    req: NewConnectionRequest,
    previous: Option<&store::SavedConnection>,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    let name = req.name.trim().to_string();
    if name.is_empty() {
        return Err(bad_request("invalid_request", "이름이 필요합니다"));
    }
    validate_connect_request(&req.connect)?;

    let password_account = store::connection_account(id, &req.connect.driver);
    let ssh_account = store::connection_account(id, "ssh");
    let http_account = store::connection_account(id, "http");
    let fresh = previous.is_none();
    // Every keychain write remembers what it replaced so a later failure can undo it.
    let mut written: Vec<(String, Option<String>)> = Vec::new();
    if req.persist_password {
        let carried = previous
            .filter(|old| old.persist_password && old.driver != req.connect.driver)
            .and_then(|old| store::get_password(&store::connection_account(id, &old.driver)));
        let db_password = request_db_password(&req.connect)
            .map(str::to_string)
            .or(carried);
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
        for (account, secret) in [
            (&password_account, db_password),
            (&ssh_account, ssh_password),
            (&http_account, http_password),
        ] {
            let Some(secret) = secret else {
                continue;
            };
            let replaced = if fresh {
                None
            } else {
                store::get_password(account)
            };
            if let Err(message) = store::set_password(account, &secret) {
                restore_secrets(&written);
                return Err(keyring_error(message));
            }
            written.push((account.clone(), replaced));
        }
    }

    let mut postgres = req.connect.postgres.clone();
    let mut cockroach = req.connect.cockroach.clone();
    let mut mysql = req.connect.mysql.clone();
    let mut mssql = req.connect.mssql.clone();
    if let Some(config) = postgres.as_mut() {
        config.password = None;
    }
    if let Some(config) = cockroach.as_mut() {
        config.password = None;
    }
    if let Some(config) = mysql.as_mut() {
        config.password = None;
    }
    if let Some(config) = mssql.as_mut() {
        config.password = None;
    }
    let connection = store::SavedConnection {
        id: id.to_string(),
        name,
        driver: req.connect.driver.clone(),
        postgres,
        cockroach,
        mysql,
        mssql,
        ssh: req.connect.ssh.as_ref().map(store::SavedSsh::from_config),
        http_tunnel: req
            .connect
            .http_tunnel
            .as_ref()
            .map(store::SavedHttpTunnel::from_config),
        persist_password: req.persist_password,
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
    match outcome {
        Ok(true) => {}
        Ok(false) => {
            restore_secrets(&written);
            return Err(not_found("연결을 찾을 수 없습니다"));
        }
        Err(message) => {
            restore_secrets(&written);
            return Err(store_error(message));
        }
    }

    // Drop secrets the saved profile no longer refers to. The old driver's
    // account goes only once its password has been moved to the new account.
    let had_secrets = previous.is_some_and(|old| old.persist_password);
    if !req.persist_password {
        if had_secrets {
            delete_connection_passwords(id);
        }
    } else if had_secrets {
        let moved = written.iter().any(|(account, _)| account == &password_account);
        if let Some(old) = previous.filter(|old| old.driver != req.connect.driver) {
            if moved {
                store::delete_password(&store::connection_account(id, &old.driver));
            }
        }
        if req.connect.ssh.is_none() {
            store::delete_password(&ssh_account);
        }
        if req.connect.http_tunnel.is_none() {
            store::delete_password(&http_account);
        }
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
        return Err(bad_request("weak_passphrase", "파일 암호는 8자 이상이어야 합니다"));
    }
    // Each profile once, in the order asked.
    let mut seen = HashSet::new();
    let ids: Vec<String> = req.ids.into_iter().filter(|id| seen.insert(id.clone())).collect();
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
                        .then(|| store::get_password(&store::connection_account(&connection.id, kind)))
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
        let plaintext = serde_json::to_vec(&transfer::Bundle { groups, connections })
            .map_err(|err| err.to_string())?;
        let file = transfer::seal(&plaintext, &passphrase, transfer::DEFAULT_KDF)?;
        Ok::<_, String>((file, count, secrets))
    })
    .await
    .map_err(|err| internal_error(err.to_string()))?;
    let (file, count, secrets) = sealed.map_err(internal_error)?;
    // secrets: how many profiles carried a password into the file.
    Ok(Json(json!({ "file": file, "count": count, "secrets": secrets })))
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
            for (id, persisted) in &saved {
                if *persisted {
                    delete_connection_passwords(id);
                }
            }
            if err.1.code == "keyring_error" {
                return Err((
                    err.0,
                    Json(ApiError {
                        code: "import_keyring_error".into(),
                        message: "파일에 든 비밀번호를 이 컴퓨터의 키체인에 저장하지 못해 아무것도 가져오지 않았습니다. 비밀번호를 빼고 내보낸 파일로 다시 가져오세요.".into(),
                    }),
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
            if request_db_password(&connect).is_none() {
                if let Some(password) =
                    store::get_password(&store::connection_account(id, &saved.driver))
                {
                    set_request_db_password(&mut connect, password);
                }
            }
            if let Some(ssh) = connect.ssh.as_mut() {
                if ssh.password.as_deref().map_or(true, str::is_empty) {
                    ssh.password = store::get_password(&store::connection_account(id, "ssh"));
                }
            }
            if let Some(tunnel) = connect.http_tunnel.as_mut() {
                if tunnel.password.as_deref().map_or(true, str::is_empty) {
                    tunnel.password = store::get_password(&store::connection_account(id, "http"));
                }
            }
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
    delete_connection_passwords(&id);
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
            Some(summary) => (summary.kind, summary.path, summary.demo, summary.table_count),
            None => {
                let meta = slot.refresh_summary(false).await.map_err(engine_error)?;
                (meta.kind, meta.path, meta.demo, meta.tables.len())
            }
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
    let secrets: ConnectSecrets = if body.is_empty() {
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
    if saved.driver != "postgres"
        && saved.driver != "cockroach"
        && saved.driver != "mysql"
        && saved.driver != "mssql"
    {
        return Err(bad_request(
            "unsupported_driver",
            "지원하지 않는 드라이버입니다",
        ));
    }

    let mut request = ConnectRequest {
        driver: saved.driver.clone(),
        postgres: saved.postgres.clone(),
        cockroach: saved.cockroach.clone(),
        mysql: saved.mysql.clone(),
        mssql: saved.mssql.clone(),
        ssh: None,
        http_tunnel: None,
    };
    let db_password = non_empty(secrets.password).or_else(|| {
        if saved.persist_password {
            store::get_password(&store::connection_account(&id, &saved.driver))
        } else {
            None
        }
    });
    if let Some(password) = db_password {
        set_request_db_password(&mut request, password);
    }
    let supplied_password = request_db_password(&request).is_some();

    let mut ssh = saved.ssh.as_ref().map(store::SavedSsh::to_config);
    if let Some(ssh_config) = ssh.as_mut() {
        let has_key = ssh_config
            .private_key_path
            .as_deref()
            .map(|path| !path.trim().is_empty())
            .unwrap_or(false);
        if !has_key {
            let password = non_empty(secrets.ssh_password).or_else(|| {
                if saved.persist_password {
                    store::get_password(&store::connection_account(&id, "ssh"))
                } else {
                    None
                }
            });
            match password {
                Some(password) => ssh_config.password = Some(password),
                None => return Err(stored_password_missing("ssh").into_response()),
            }
        }
    }

    let mut http_tunnel = saved
        .http_tunnel
        .as_ref()
        .map(store::SavedHttpTunnel::to_config);
    if let Some(tunnel_config) = http_tunnel.as_mut() {
        let password = non_empty(secrets.http_password).or_else(|| {
            if saved.persist_password {
                store::get_password(&store::connection_account(&id, "http"))
            } else {
                None
            }
        });
        if password.is_some() {
            tunnel_config.password = password;
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
            let needs_password = !supplied_password
                && !tunnel_error
                && (err.message.contains("password")
                    || err.message.contains("비밀번호")
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
    let scope = slot_for(&state, params.conn.as_deref()).await?.history_scope();
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
    let scope = slot_for(&state, params.conn.as_deref()).await?.history_scope();
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
        return Err(bad_request("invalid_request", "안전 모드는 0, 1, 2 중 하나입니다"));
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
    list_dir(params.path.as_deref(), params.hidden).map(Json).map_err(|err| {
        (
            StatusCode::BAD_REQUEST,
            Json(ApiError {
                code: "fs_error".into(),
                message: err.to_string(),
            }),
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
    slot.gated(Holder::Foreground, slot.engine.execute(&req.sql, max_rows))
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
        "view" | "function" | "procedure" | "trigger" | "sequence"
    ) {
        return Err(bad_request(
            "invalid_request",
            "kind는 view/function/procedure/trigger/sequence 중 하나여야 합니다",
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
    let id = req.session_id.trim();
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
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
        return (StatusCode::UNAUTHORIZED, "토큰이 유효하지 않습니다").into_response();
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
                                "잘못된 JSON 메시지",
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
                            slot.cancel_if_inflight();
                        }
                    }
                    "edit" => handle_edit(&state, &sender, &value, &conn).await,
                    "insert_row" => {
                        handle_row_change(&state, &sender, &value, &conn, RowOp::Insert).await
                    }
                    "delete_row" => {
                        handle_row_change(&state, &sender, &value, &conn, RowOp::Delete).await
                    }
                    "tx" => handle_tx(&state, &sender, &value, &conn).await,
                    "console" => {
                        handle_console(&state, &sender, &value, &conn, &mut consoles).await
                    }
                    "console_unwatch" => stop_console(&mut consoles, &conn),
                    _ => {
                        sender
                            .json(error_json(
                                None,
                                Some(&conn),
                                "알 수 없는 메시지 타입",
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
    // here), this one, and those of queries still finishing.
    for console in consoles.values() {
        console.abort();
    }
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
            sender
                .json(error_json(None, Some(conn), &err.message, false))
                .await;
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
    if id.is_empty() || sql.trim().is_empty() {
        sender
            .json(error_json(
                None,
                Some(conn),
                "query 메시지에 id/sql이 필요합니다",
                false,
            ))
            .await;
        return;
    }

    let slot = match slot_for(state, Some(conn)).await {
        Ok(slot) => slot,
        Err((_, Json(err))) => {
            sender
                .json(error_json(Some(&id), Some(conn), &err.message, false))
                .await;
            return;
        }
    };

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
        let mark = slot.engine.sql_log().ends();
        let outcome = if job {
            slot.gated(Holder::Job, slot.engine.query(&sql, max_rows)).await
        } else {
            let superseded = || {
                let latest = sender
                    .latest
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                latest.get(&conn) != seq.as_ref()
            };
            let ran = slot
                .gated(Holder::Foreground, async {
                    if superseded() {
                        None
                    } else {
                        Some(slot.foreground_query(&sql, max_rows).await)
                    }
                })
                .await;
            match ran {
                Some(outcome) => outcome,
                None => {
                    sender
                        .json(error_json(Some(&id), Some(&conn), "쿼리가 취소되었습니다", true))
                        .await;
                    return;
                }
            }
        };
        slot.settle_job_tx().await;
        // Statements run here can open or close a transaction (or, failing,
        // abort one): the page's indicator follows this.
        let in_tx = slot.engine.in_tx().await.unwrap_or(false);
        // One this statement ended (COMMIT or ROLLBACK typed here, a failed
        // COMMIT, a deadlock) settles the cached results as the toolbar's do.
        let ended = slot.engine.sql_log().ended_since(mark);
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
                if let Some(state) = tx_state {
                    meta["tx"] = json!(state);
                }
                if invalidate {
                    meta["invalidate"] = json!(true);
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
                {
                    let mut sessions = slot.sessions.lock().await;
                    if job {
                        sessions.insert_job(id.clone(), data.clone());
                    } else {
                        sessions.insert(id.clone(), data.clone());
                    }
                }
                if let Err(err) = send_window(&slot, &sender, &conn, &id, 0, window).await {
                    sender
                        .json(error_json(Some(&id), Some(&conn), &err.to_string(), false))
                        .await;
                }
            }
            Err(err) => {
                let cancelled = err.is_interrupted();
                let message = if cancelled {
                    "쿼리가 취소되었습니다".to_string()
                } else {
                    err.to_string()
                };
                let mut body = error_json(Some(&id), Some(&conn), &message, cancelled);
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
                .json(error_json(
                    value["id"].as_str(),
                    Some(conn),
                    &err.message,
                    false,
                ))
                .await;
            return;
        }
    };
    if let Err(err) = send_window(&slot, sender, conn, id, offset, limit).await {
        sender
            .json(error_json(Some(id), Some(conn), &err.to_string(), false))
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
    }

    let msg: EditMsg = match serde_json::from_value(value.clone()) {
        Ok(msg) => msg,
        Err(err) => {
            sender
                .json(error_json(
                    None,
                    Some(conn),
                    &format!("edit 메시지 형식 오류: {err}"),
                    false,
                ))
                .await;
            return;
        }
    };

    let slot = match slot_for(state, Some(conn)).await {
        Ok(slot) => slot,
        Err((_, Json(err))) => {
            sender
                .json(error_json(None, Some(conn), &err.message, false))
                .await;
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
                    "이 결과는 편집할 수 없습니다",
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

    match slot.engine.edit(&target).await {
        Ok(changed) if target.expr.is_some() => {
            // Only the database knows what DEFAULT or the time became, so the
            // cached cell isn't patched: the page reads the row again. Inside
            // a transaction the change counts as structural, so a rollback
            // drops the results read in the meantime.
            if slot.engine.in_tx().await.unwrap_or(false) {
                let mut store = slot.sessions.lock().await;
                store.mark_structural();
                if let Some(session_arc) = store.get(&session_id) {
                    session_arc.lock().await.journal.push(JournalEntry::Structural);
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
                .json(error_json(None, Some(conn), &err.to_string(), false))
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
                "table 값이 필요합니다",
                false,
            ))
            .await;
        return;
    }

    let slot = match slot_for(state, Some(conn)).await {
        Ok(slot) => slot,
        Err((_, Json(err))) => {
            sender
                .json(error_json(Some(&id), Some(conn), &err.message, false))
                .await;
            return;
        }
    };

    let outcome: Result<u64, EngineError> = match op {
        RowOp::Insert => match parse_insert_values(&value["values"]) {
            Ok(values) => slot.engine.insert_values(&table, &values).await,
            Err(message) => {
                sender
                    .json(error_json(Some(&id), Some(conn), &message, false))
                    .await;
                return;
            }
        },
        RowOp::Delete => match parse_pk_values(&value["pk"]) {
            Ok(pk) => slot.engine.delete_row(&table, &pk).await,
            Err(message) => {
                sender
                    .json(error_json(Some(&id), Some(conn), &message, false))
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
                .json(error_json(Some(&id), Some(conn), &err.to_string(), false))
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
            sender
                .json(error_json(None, Some(conn), &err.message, false))
                .await;
            return;
        }
    };
    // An import's own transaction: while it is open the page's statements
    // can't cancel anything (see cancel_if_inflight).
    let job = value["job"].as_bool().unwrap_or(false);
    // A transaction command is never cancelled: an interrupted COMMIT leaves
    // its outcome unknown.
    let result = match action {
        "begin" => slot.gated(Holder::Job, slot.engine.begin_tx()).await.map(|_| "began"),
        "commit" => slot.gated(Holder::Job, slot.engine.commit_tx()).await.map(|_| "committed"),
        "rollback" => slot
            .gated(Holder::Job, slot.engine.rollback_tx())
            .await
            .map(|_| "rolledback"),
        _ => {
            sender
                .json(error_json(None, Some(conn), "알 수 없는 tx action", false))
                .await;
            return;
        }
    };
    if action == "begin" {
        if job && result.is_ok() {
            slot.job_tx.store(true, Ordering::SeqCst);
        }
    } else {
        slot.settle_job_tx().await;
    }
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
            sender.json(body).await;
            if let Some((reason, _)) = closed {
                sender
                    .json(error_json(None, Some(conn), &reason, false))
                    .await;
            }
        }
        Err(err) => {
            sender
                .json(error_json(None, Some(conn), &err.to_string(), false))
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
            let entries: Vec<JournalEntry> = guard.journal.drain(..).collect();
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

fn error_json(id: Option<&str>, conn: Option<&str>, message: &str, cancelled: bool) -> Value {
    let mut body = json!({
        "type": "error",
        "id": id,
        "message": message,
        "cancelled": cancelled,
    });
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
        let names: Vec<&str> = with_hidden.entries.iter().map(|e| e.name.as_str()).collect();
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
        assert!(slot.summary().is_none(), "a statement may have changed the schema");

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
        }
    }

    fn test_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-tablepeek-token", "test-token".parse().unwrap());
        headers
    }

    fn test_connect_request(driver: &str) -> ConnectRequest {
        ConnectRequest {
            driver: driver.into(),
            postgres: Some(tablepeek_types::PostgresConfig {
                host: "127.0.0.1".into(),
                port: 5433,
                user: "tablepeek".into(),
                password: Some("tablepeek_test_pw".into()),
                database: "tablepeek_test".into(),
                ssl_mode: tablepeek_types::SslMode::Disable,
                ssl_root_cert: None,
                ssl_client_cert: None,
                ssl_client_key: None,
            }),
            cockroach: None,
            mysql: None,
            mssql: None,
            ssh: None,
            http_tunnel: None,
        }
    }

    fn test_mysql_connect_request() -> ConnectRequest {
        ConnectRequest {
            driver: "mysql".into(),
            postgres: None,
            cockroach: None,
            mysql: Some(tablepeek_types::MySqlConfig {
                host: "127.0.0.1".into(),
                port: 3307,
                user: "root".into(),
                password: Some("root_pw".into()),
                database: "tablepeek_test".into(),
                ssl_mode: tablepeek_types::SslMode::Disable,
                ssl_root_cert: None,
                ssl_client_cert: None,
                ssl_client_key: None,
            }),
            mssql: None,
            ssh: None,
            http_tunnel: None,
        }
    }

    fn test_cockroach_connect_request() -> ConnectRequest {
        ConnectRequest {
            driver: "cockroach".into(),
            postgres: None,
            cockroach: Some(tablepeek_types::PostgresConfig {
                host: "127.0.0.1".into(),
                port: 26258,
                user: "root".into(),
                password: None,
                database: "defaultdb".into(),
                ssl_mode: tablepeek_types::SslMode::Disable,
                ssl_root_cert: None,
                ssl_client_cert: None,
                ssl_client_key: None,
            }),
            mysql: None,
            mssql: None,
            ssh: None,
            http_tunnel: None,
        }
    }

    fn test_mssql_connect_request() -> ConnectRequest {
        ConnectRequest {
            driver: "mssql".into(),
            postgres: None,
            cockroach: None,
            mysql: None,
            mssql: Some(tablepeek_types::MssqlConfig {
                host: "127.0.0.1".into(),
                port: 14330,
                user: "sa".into(),
                password: Some("MsSql_test_pw1".into()),
                database: "tablepeek_test".into(),
                encrypt: false,
            }),
            ssh: None,
            http_tunnel: None,
        }
    }

    async fn connect_for_test(state: &AppState, req: ConnectRequest) -> Result<(), ConnectError> {
        let origin = SlotOrigin {
            label: None,
            saved_id: None,
        };
        connect_with(state, req, origin).await.map(|_| ())
    }

    #[tokio::test]
    async fn connect_rejects_unsupported_driver() {
        let dir = temp_dir("connect-driver");
        let state = test_state(&dir);
        let err = connect_for_test(&state, test_connect_request("sqlite"))
            .await
            .unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
        assert_eq!(err.code, "unsupported_driver");
        assert_eq!(err.message, "지원하지 않는 드라이버입니다");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn connect_rejects_missing_mysql_config() {
        let dir = temp_dir("connect-missing-mysql");
        let state = test_state(&dir);
        let request = ConnectRequest {
            driver: "mysql".into(),
            postgres: None,
            cockroach: None,
            mysql: None,
            mssql: None,
            ssh: None,
            http_tunnel: None,
        };
        let err = connect_for_test(&state, request).await.unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
        assert_eq!(err.code, "connect_failed");
        assert_eq!(err.message, "MySQL 접속 정보가 없습니다");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn connect_rejects_missing_cockroach_config() {
        let dir = temp_dir("connect-missing-cockroach");
        let state = test_state(&dir);
        let request = ConnectRequest {
            driver: "cockroach".into(),
            postgres: None,
            cockroach: None,
            mysql: None,
            mssql: None,
            ssh: None,
            http_tunnel: None,
        };
        let err = connect_for_test(&state, request).await.unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
        assert_eq!(err.code, "connect_failed");
        assert_eq!(err.message, "CockroachDB 접속 정보가 없습니다");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn connect_rejects_missing_mssql_config() {
        let dir = temp_dir("connect-missing-mssql");
        let state = test_state(&dir);
        let request = ConnectRequest {
            driver: "mssql".into(),
            postgres: None,
            cockroach: None,
            mysql: None,
            mssql: None,
            ssh: None,
            http_tunnel: None,
        };
        let err = connect_for_test(&state, request).await.unwrap_err();
        assert_eq!(err.status, StatusCode::BAD_REQUEST);
        assert_eq!(err.code, "connect_failed");
        assert_eq!(err.message, "SQL Server 접속 정보가 없습니다");
        std::fs::remove_dir_all(&dir).unwrap();
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

    async fn create_test_connection(state: &AppState, name: &str, connect: ConnectRequest) -> String {
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
            transfer::ExportMeta { color: "#22c55e".into(), tags: vec!["production".into()], group: "CiteWell".into() },
        );
        request.groups = vec![transfer::BundleGroup { name: "CiteWell".into(), color: "#f59e0b".into() }];
        request.include_passwords = true; // nothing is in the keychain for these profiles
        let exported = connections_export(State(source.clone()), test_headers(), Json(request))
            .await
            .unwrap();
        assert_eq!(exported.0["count"], json!(2));
        assert_eq!(exported.0["secrets"], json!(0), "asked for passwords, but none was stored");
        let file = exported.0["file"].as_str().unwrap().to_string();
        for hidden in ["분석 DB", "db.internal", "bastion", "CiteWell", "password"] {
            assert!(!file.contains(hidden), "{hidden} visible in the file");
        }
        let inside: Value = serde_json::from_slice(&transfer::open(&file, "correct horse").unwrap()).unwrap();
        assert!(!inside.to_string().contains("password"), "no secret was stored, so none is exported");

        let target = test_state(&temp_dir("import-target"));
        let imported = connections_import(State(target.clone()), test_headers(), Json(import_request(&file, "correct horse")))
            .await
            .unwrap();
        let created = imported.0["connections"].as_array().unwrap();
        assert_eq!(created.len(), 2);
        assert_eq!(created[1]["name"], json!("prod"));
        assert_eq!(created[1]["color"], json!("#22c55e"));
        assert_eq!(created[1]["tags"], json!(["production"]));
        assert_eq!(created[1]["group"], json!("CiteWell"));
        assert_eq!(imported.0["groups"], json!([{ "name": "CiteWell", "color": "#f59e0b" }]));
        let store = target.store.lock().await;
        let saved = store.find_connection(created[1]["id"].as_str().unwrap()).unwrap();
        assert_eq!(saved.mysql.as_ref().unwrap().host, "db.internal");
        assert_eq!(saved.ssh.as_ref().unwrap().private_key_path.as_deref(), Some("/k/id"));
        assert!(!saved.persist_password);
        drop(store);

        // A second import names the copies apart.
        let again = connections_import(State(target.clone()), test_headers(), Json(import_request(&file, "correct horse")))
            .await
            .unwrap();
        assert_eq!(again.0["connections"][1]["name"], json!("prod (가져옴)"));
    }

    #[tokio::test]
    async fn connections_export_counts_each_profile_once() {
        let state = test_state(&temp_dir("export-dedupe"));
        let id = create_test_connection(&state, "a", test_connect_request("postgres")).await;
        let exported = connections_export(State(state.clone()), test_headers(), Json(export_request(vec![id.clone(), id], "correct horse")))
            .await
            .unwrap();
        assert_eq!(exported.0["count"], json!(1));
        let inside: Value = serde_json::from_slice(&transfer::open(exported.0["file"].as_str().unwrap(), "correct horse").unwrap()).unwrap();
        assert_eq!(inside["connections"].as_array().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn connections_export_rejects_short_passphrase_and_unknown_ids() {
        let state = test_state(&temp_dir("export-checks"));
        let id = create_test_connection(&state, "a", test_connect_request("postgres")).await;
        let short = connections_export(State(state.clone()), test_headers(), Json(export_request(vec![id.clone()], "seven77")))
            .await
            .unwrap_err();
        assert_eq!(short.0, StatusCode::BAD_REQUEST);
        assert_eq!(short.1.code, "weak_passphrase");
        let missing = connections_export(State(state.clone()), test_headers(), Json(export_request(vec!["nope".into()], "correct horse")))
            .await
            .unwrap_err();
        assert_eq!(missing.0, StatusCode::NOT_FOUND);
        let unauthorized = connections_export(State(state.clone()), HeaderMap::new(), Json(export_request(vec![id], "correct horse")))
            .await
            .unwrap_err();
        assert_eq!(unauthorized.0, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn connections_import_tells_wrong_passphrase_from_other_files() {
        let state = test_state(&temp_dir("import-errors"));
        let file = transfer::seal(b"{}", "correct horse", transfer::DEFAULT_KDF).unwrap();
        let wrong = connections_import(State(state.clone()), test_headers(), Json(import_request(&file, "wrong horse")))
            .await
            .unwrap_err();
        assert_eq!(wrong.1.code, "wrong_passphrase");
        let other = connections_import(State(state.clone()), test_headers(), Json(import_request("{\"a\":1}", "correct horse")))
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
        let file = transfer::seal(bundle.to_string().as_bytes(), "correct horse", transfer::DEFAULT_KDF).unwrap();
        let error = connections_import(State(state.clone()), test_headers(), Json(import_request(&file, "correct horse")))
            .await
            .unwrap_err();
        assert_eq!(error.0, StatusCode::BAD_REQUEST);
        assert!(error.1.message.starts_with("2번째 연결"), "{}", error.1.message);
        assert!(state.store.lock().await.data().connections.is_empty(), "nothing saved");
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
        assert!(connections[0]["postgres"].get("password").is_none());
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
        if let Some(config) = edited.mysql.as_mut() {
            config.host = "db.example.internal".into();
        }
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
        assert_eq!(connections[0]["mysql"]["host"], json!("db.example.internal"));
        assert!(connections[0].get("postgres").is_none());
        assert!(connections[0]["mysql"].get("password").is_none());
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
                connect: test_connect_request("oracle"),
                saved_id: None,
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1.code, "unsupported_driver");

        let mut pasted = test_connect_request("postgres");
        if let Some(config) = pasted.postgres.as_mut() {
            config.host = "postgres://u:secret@db.example/app".into();
        }
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
        let listed = connections_list(State(state.clone()), headers).await.unwrap();
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
        assert_eq!(connections[0]["mysql"]["host"], json!("127.0.0.1"));
        assert_eq!(connections[0]["mysql"]["port"], json!(3307));
        assert_eq!(connections[0]["mysql"]["database"], json!("tablepeek_test"));
        assert!(connections[0]["mysql"].get("password").is_none());
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
        assert_eq!(connections[0]["cockroach"]["host"], json!("127.0.0.1"));
        assert_eq!(connections[0]["cockroach"]["port"], json!(26258));
        assert_eq!(connections[0]["cockroach"]["database"], json!("defaultdb"));
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
        assert_eq!(connections[0]["mssql"]["host"], json!("127.0.0.1"));
        assert_eq!(connections[0]["mssql"]["port"], json!(14330));
        assert_eq!(connections[0]["mssql"]["database"], json!("tablepeek_test"));
        assert_eq!(connections[0]["mssql"]["encrypt"], json!(false));
        assert!(connections[0]["mssql"].get("password").is_none());
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
        request.postgres.as_mut().unwrap().password = None;
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
            store.record_history(history_run("demo", "SELECT 1", 10)).unwrap();
            store.record_history(history_run("demo", "SELECT 2", 20)).unwrap();
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

        let demo = ConnSlot::new("s3".into(), "데모".into(), None, None, Engine::open_demo(1).unwrap());
        assert_eq!(demo.history_scope(), "demo");

        let sqlite = ConnSlot::new(
            "s4".into(),
            file.display().to_string(),
            None,
            None,
            Engine::open_file(&file).unwrap(),
        );
        let canonical = std::fs::canonicalize(&file).unwrap();
        assert_eq!(sqlite.history_scope(), format!("file:{}", canonical.display()));

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

        let listed = conns_list(State(state.clone()), headers.clone()).await.unwrap();
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
        let listed = conns_list(State(state.clone()), headers.clone()).await.unwrap();
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
        assert_eq!((history[0].rows, history[1].rows), (1, 0));

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
        assert_eq!(exprs, vec![Some(ValueExpr::Now), Some(ValueExpr::Default), None]);
        assert_eq!(values[2].value.as_deref(), Some("x"));
        for bad in [json!("now(); DROP TABLE demo"), json!("NOW"), json!(1)] {
            let refused = parse_insert_values(&json!([{ "column": "seen", "value": null, "expr": bad }]));
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
        assert_eq!((edited["expr"].clone(), edited["value"].clone()), (json!("now"), Value::Null));
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
                session_id: "abc".into(),
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
            let task = tokio::spawn(async move { running.gated(holder, running.engine.query(SLOW, 1)).await });
            until_held(&slot, holder).await;
            slot.cancel_if_inflight();
            let outcome = task.await.unwrap();
            assert_eq!(
                outcome.as_ref().err().is_some_and(EngineError::is_interrupted),
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
        slot.job_tx.store(true, Ordering::SeqCst);
        let running = slot.clone();
        let task =
            tokio::spawn(async move { running.gated(Holder::Foreground, running.engine.query(SLOW, 1)).await });
        until_held(&slot, Holder::Foreground).await;
        slot.cancel_if_inflight();
        assert!(task.await.unwrap().is_ok(), "the page's statement ran to its end");
    }

    #[tokio::test]
    async fn the_pages_statement_waits_for_the_jobs_instead_of_cancelling_it() {
        let slot = gate_slot();
        let job = slot.clone();
        let job_task = tokio::spawn(async move {
            let outcome = job.gated(Holder::Job, job.engine.query(SLOW, 1)).await;
            (outcome.is_ok(), std::time::Instant::now())
        });
        until_held(&slot, Holder::Job).await;
        // What handle_query does for the page's next query.
        slot.cancel_if_inflight();
        let page = slot.clone();
        let page_task = tokio::spawn(async move {
            let outcome = page.gated(Holder::Foreground, page.engine.query("SELECT 1", 1)).await;
            (outcome.is_ok(), std::time::Instant::now())
        });
        let (job_ok, job_done) = job_task.await.unwrap();
        let (page_ok, page_done) = page_task.await.unwrap();
        assert!(job_ok && page_ok);
        assert!(page_done >= job_done, "the page's statement ran after the job's");
    }

    #[tokio::test]
    async fn a_query_the_page_replaced_while_it_waited_is_skipped() {
        let dir = temp_dir("superseded");
        let state = test_state(&dir);
        let slot = slot_for(&state, Some("main")).await.unwrap();
        let (sender, mut rx) = test_sender();
        let job = slot.clone();
        let held = tokio::spawn(async move { job.gated(Holder::Job, job.engine.query(SLOW, 1)).await });
        until_held(&slot, Holder::Job).await;
        // Two of the page's queries queue behind the job; the second replaces the first.
        let run = |id: &str, sql: &str| json!({ "type": "query", "id": id, "sql": sql });
        handle_query(&state, &sender, &run("old", "SELECT 1"), "main").await;
        handle_query(&state, &sender, &run("new", "SELECT 2"), "main").await;
        assert!(held.await.unwrap().is_ok(), "the job's statement ran to its end");
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
