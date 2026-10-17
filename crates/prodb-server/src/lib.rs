use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{Html, IntoResponse, Json, Response};
use axum::routing::{delete, get, post};
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use prodb_engine::{Engine, EngineError, QueryData};
use prodb_types::{
    ApiError, ConnectRequest, EditTarget, EngineMeta, FsEntry, FsListing, PkValue, QueryResult,
    TableSchema,
};
use rust_embed::RustEmbed;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;

pub mod store;
pub mod tunnel;

#[derive(RustEmbed)]
#[folder = "$CARGO_MANIFEST_DIR/../../web/dist"]
struct Assets;

pub const SESSION_CAP: usize = 8;

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
pub struct JournalEntry {
    pub row: usize,
    pub col: usize,
    pub old: Option<String>,
}

pub struct SessionStore {
    map: HashMap<String, Arc<tokio::sync::Mutex<QuerySession>>>,
    order: VecDeque<String>,
    cap: usize,
}

impl SessionStore {
    pub fn new(cap: usize) -> Self {
        Self {
            map: HashMap::new(),
            order: VecDeque::new(),
            cap,
        }
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
}

#[derive(Clone)]
pub struct AppState {
    pub engine: Arc<Engine>,
    pub token: Arc<str>,
    pub demo_rows: usize,
    pub allowed_hosts: Arc<Vec<String>>,
    pub sessions: Arc<tokio::sync::Mutex<SessionStore>>,
    pub tunnel: Arc<tokio::sync::Mutex<Option<tunnel::Tunnel>>>,
    pub store: Arc<tokio::sync::Mutex<store::StoreFile>>,
    pub inflight: Arc<AtomicUsize>,
}

impl AppState {
    fn cancel_if_inflight(&self) {
        if self.inflight.load(Ordering::SeqCst) > 0 {
            self.engine.cancel();
        }
    }
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
        .route("/api/fs/list", get(fs_list))
        .route("/api/schema", get(schema_route))
        .route("/api/query", post(query))
        .route("/api/connections", get(connections_list).post(connections_create))
        .route("/api/connections/{id}", delete(connections_delete))
        .route("/api/connections/{id}/connect", post(connection_connect))
        .route("/api/history", get(history_list).delete(history_clear))
        .route("/api/favorites", get(favorites_list).post(favorites_create))
        .route("/api/favorites/{id}", delete(favorites_delete))
        .layer(middleware::from_fn_with_state(state.clone(), host_guard))
        .with_state(state)
}

pub async fn serve(listener: tokio::net::TcpListener, state: AppState) -> std::io::Result<()> {
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
        .get("x-prodb-token")
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
        EngineError::Sqlite(_) => (StatusCode::BAD_REQUEST, "sqlite_error"),
        EngineError::Postgres(_) => (StatusCode::BAD_REQUEST, "postgres_error"),
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

#[derive(Deserialize)]
struct IndexParams {
    token: Option<String>,
}

async fn index(State(state): State<AppState>, Query(params): Query<IndexParams>) -> Response {
    if !authorized(&state, &HeaderMap::new(), params.token.as_deref()) {
        return (
            StatusCode::UNAUTHORIZED,
            "토큰이 없습니다. `prodb serve`가 출력한 URL로 접속하세요.",
        )
            .into_response();
    }
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

async fn meta(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<EngineMeta>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    state.engine.meta().await.map(Json).map_err(engine_error)
}

async fn schema_route(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Vec<TableSchema>>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    state.engine.schema().await.map(Json).map_err(engine_error)
}

#[derive(Deserialize)]
struct OpenRequest {
    path: Option<String>,
}

async fn open(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<OpenRequest>,
) -> Result<Json<EngineMeta>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let outcome = match req.path.as_deref() {
        None => state.engine.swap_to_demo(state.demo_rows).await,
        Some(path) => state.engine.swap_to_file(std::path::Path::new(path)).await,
    };
    match outcome {
        Ok(meta) => {
            *state.tunnel.lock().await = None;
            Ok(Json(meta))
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

fn stored_password_missing() -> ConnectError {
    connect_failed("저장된 비밀번호가 없습니다 — 비밀번호를 입력해 연결하세요")
}

async fn connect_with(state: &AppState, req: ConnectRequest) -> Result<EngineMeta, ConnectError> {
    match req.driver.as_str() {
        "postgres" => connect_postgres(state, req).await,
        "cockroach" => connect_cockroach(state, req).await,
        "mysql" => connect_mysql(state, req).await,
        "mssql" => connect_mssql(state, req).await,
        _ => Err(ConnectError::new(
            StatusCode::BAD_REQUEST,
            "unsupported_driver",
            "지원하지 않는 드라이버입니다",
        )),
    }
}

async fn connect_postgres(
    state: &AppState,
    req: ConnectRequest,
) -> Result<EngineMeta, ConnectError> {
    let Some(mut config) = req.postgres.clone() else {
        return Err(connect_failed("PostgreSQL 접속 정보가 없습니다"));
    };
    let original_host = config.host.clone();
    let original_port = config.port;
    let tunnel = match &req.ssh {
        Some(ssh) => {
            let opened = tunnel::open(ssh, &config.host, config.port)
                .await
                .map_err(connect_failed)?;
            config.host = "127.0.0.1".into();
            config.port = opened.local_port;
            Some(opened)
        }
        None => None,
    };
    match state.engine.swap_to_postgres(&config).await {
        Ok(mut meta) => {
            if req.ssh.is_some() {
                meta.path = Some(format!(
                    "{}@{}:{}/{}",
                    config.user, original_host, original_port, config.database
                ));
            }
            *state.tunnel.lock().await = tunnel;
            Ok(meta)
        }
        Err(err) => Err(connect_failed(err.to_string())),
    }
}

async fn connect_mysql(state: &AppState, req: ConnectRequest) -> Result<EngineMeta, ConnectError> {
    let Some(mut config) = req.mysql.clone() else {
        return Err(connect_failed("MySQL 접속 정보가 없습니다"));
    };
    let original_host = config.host.clone();
    let original_port = config.port;
    let tunnel = match &req.ssh {
        Some(ssh) => {
            let opened = tunnel::open(ssh, &config.host, config.port)
                .await
                .map_err(connect_failed)?;
            config.host = "127.0.0.1".into();
            config.port = opened.local_port;
            Some(opened)
        }
        None => None,
    };
    match state.engine.swap_to_mysql(&config).await {
        Ok(mut meta) => {
            if req.ssh.is_some() {
                meta.path = Some(format!(
                    "{}@{}:{}/{}",
                    config.user, original_host, original_port, config.database
                ));
            }
            *state.tunnel.lock().await = tunnel;
            Ok(meta)
        }
        Err(err) => Err(connect_failed(err.to_string())),
    }
}

async fn connect_cockroach(
    state: &AppState,
    req: ConnectRequest,
) -> Result<EngineMeta, ConnectError> {
    let Some(mut config) = req.cockroach.clone() else {
        return Err(connect_failed("CockroachDB 접속 정보가 없습니다"));
    };
    let original_host = config.host.clone();
    let original_port = config.port;
    let tunnel = match &req.ssh {
        Some(ssh) => {
            let opened = tunnel::open(ssh, &config.host, config.port)
                .await
                .map_err(connect_failed)?;
            config.host = "127.0.0.1".into();
            config.port = opened.local_port;
            Some(opened)
        }
        None => None,
    };
    match state.engine.swap_to_cockroach(&config).await {
        Ok(mut meta) => {
            if req.ssh.is_some() {
                meta.path = Some(format!(
                    "{}@{}:{}/{}",
                    config.user, original_host, original_port, config.database
                ));
            }
            *state.tunnel.lock().await = tunnel;
            Ok(meta)
        }
        Err(err) => Err(connect_failed(err.to_string())),
    }
}

async fn connect_mssql(state: &AppState, req: ConnectRequest) -> Result<EngineMeta, ConnectError> {
    let Some(mut config) = req.mssql.clone() else {
        return Err(connect_failed("SQL Server 접속 정보가 없습니다"));
    };
    let original_host = config.host.clone();
    let original_port = config.port;
    let tunnel = match &req.ssh {
        Some(ssh) => {
            let opened = tunnel::open(ssh, &config.host, config.port)
                .await
                .map_err(connect_failed)?;
            config.host = "127.0.0.1".into();
            config.port = opened.local_port;
            Some(opened)
        }
        None => None,
    };
    match state.engine.swap_to_mssql(&config).await {
        Ok(mut meta) => {
            if req.ssh.is_some() {
                meta.path = Some(format!(
                    "{}@{}:{}/{}",
                    config.user, original_host, original_port, config.database
                ));
            }
            *state.tunnel.lock().await = tunnel;
            Ok(meta)
        }
        Err(err) => Err(connect_failed(err.to_string())),
    }
}

async fn connect(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<ConnectRequest>,
) -> Result<Json<EngineMeta>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    connect_with(&state, req)
        .await
        .map(Json)
        .map_err(ConnectError::into_response)
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

async fn connections_create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<NewConnectionRequest>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let name = req.name.trim().to_string();
    if name.is_empty() {
        return Err(bad_request("invalid_request", "이름이 필요합니다"));
    }
    match req.connect.driver.as_str() {
        "postgres" => {
            if req.connect.postgres.is_none() {
                return Err(bad_request("invalid_request", "PostgreSQL 접속 정보가 없습니다"));
            }
        }
        "cockroach" => {
            if req.connect.cockroach.is_none() {
                return Err(bad_request(
                    "invalid_request",
                    "CockroachDB 접속 정보가 없습니다",
                ));
            }
        }
        "mysql" => {
            if req.connect.mysql.is_none() {
                return Err(bad_request("invalid_request", "MySQL 접속 정보가 없습니다"));
            }
        }
        "mssql" => {
            if req.connect.mssql.is_none() {
                return Err(bad_request("invalid_request", "SQL Server 접속 정보가 없습니다"));
            }
        }
        _ => return Err(bad_request("unsupported_driver", "지원하지 않는 드라이버입니다")),
    }

    let id = uuid::Uuid::new_v4().simple().to_string();
    let password_account = store::connection_account(&id, &req.connect.driver);
    let ssh_account = store::connection_account(&id, "ssh");
    let password = match req.connect.driver.as_str() {
        "mysql" => req
            .connect
            .mysql
            .as_ref()
            .and_then(|config| config.password.clone()),
        "cockroach" => req
            .connect
            .cockroach
            .as_ref()
            .and_then(|config| config.password.clone()),
        "mssql" => req
            .connect
            .mssql
            .as_ref()
            .and_then(|config| config.password.clone()),
        _ => req
            .connect
            .postgres
            .as_ref()
            .and_then(|config| config.password.clone()),
    };
    if req.persist_password {
        if let Some(password) = password.as_deref().filter(|password| !password.is_empty()) {
            store::set_password(&password_account, password).map_err(keyring_error)?;
        }
        if let Some(password) = req
            .connect
            .ssh
            .as_ref()
            .and_then(|ssh| ssh.password.as_deref())
            .filter(|password| !password.is_empty())
        {
            if let Err(message) = store::set_password(&ssh_account, password) {
                store::delete_password(&password_account);
                return Err(keyring_error(message));
            }
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
        id: id.clone(),
        name,
        driver: req.connect.driver.clone(),
        postgres,
        cockroach,
        mysql,
        mssql,
        ssh: req.connect.ssh.as_ref().map(store::SavedSsh::from_config),
        persist_password: req.persist_password,
    };
    let outcome = {
        let mut store = state.store.lock().await;
        store.add_connection(connection)
    };
    if let Err(message) = outcome {
        store::delete_password(&password_account);
        store::delete_password(&ssh_account);
        return Err(store_error(message));
    }
    Ok(Json(json!({ "id": id })))
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
    store::delete_password(&store::connection_account(&id, "postgres"));
    store::delete_password(&store::connection_account(&id, "cockroach"));
    store::delete_password(&store::connection_account(&id, "mysql"));
    store::delete_password(&store::connection_account(&id, "mssql"));
    store::delete_password(&store::connection_account(&id, "ssh"));
    Ok(Json(json!({ "ok": true })))
}

async fn connection_connect(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Json<EngineMeta>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
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
        return Err(bad_request("unsupported_driver", "지원하지 않는 드라이버입니다"));
    }

    let mut postgres = saved.postgres.clone();
    let mut cockroach = saved.cockroach.clone();
    let mut mysql = saved.mysql.clone();
    let mut mssql = saved.mssql.clone();
    let mut supplied_password = false;
    if saved.persist_password {
        if let Some(password) = store::get_password(&store::connection_account(&id, &saved.driver)) {
            match saved.driver.as_str() {
                "mysql" => {
                    if let Some(config) = mysql.as_mut() {
                        config.password = Some(password);
                        supplied_password = true;
                    }
                }
                "cockroach" => {
                    if let Some(config) = cockroach.as_mut() {
                        config.password = Some(password);
                        supplied_password = true;
                    }
                }
                "mssql" => {
                    if let Some(config) = mssql.as_mut() {
                        config.password = Some(password);
                        supplied_password = true;
                    }
                }
                _ => {
                    if let Some(config) = postgres.as_mut() {
                        config.password = Some(password);
                        supplied_password = true;
                    }
                }
            }
        }
    }

    let mut ssh = saved.ssh.as_ref().map(store::SavedSsh::to_config);
    if let Some(ssh_config) = ssh.as_mut() {
        let has_key = ssh_config
            .private_key_path
            .as_deref()
            .map(|path| !path.trim().is_empty())
            .unwrap_or(false);
        if !has_key {
            let password = if saved.persist_password {
                store::get_password(&store::connection_account(&id, "ssh"))
            } else {
                None
            };
            match password {
                Some(password) => ssh_config.password = Some(password),
                None => return Err(stored_password_missing().into_response()),
            }
        }
    }

    let request = ConnectRequest {
        driver: saved.driver.clone(),
        postgres,
        cockroach,
        mysql,
        mssql,
        ssh,
    };
    match connect_with(&state, request).await {
        Ok(meta) => Ok(Json(meta)),
        Err(err) => {
            let needs_password = !supplied_password
                && (err.message.contains("password")
                    || err.message.contains("비밀번호")
                    || err.message.contains("invalid configuration"));
            Err(if needs_password {
                stored_password_missing()
            } else {
                err
            }
            .into_response())
        }
    }
}

#[derive(Deserialize)]
struct HistoryParams {
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
    let limit = params.limit.unwrap_or(50).clamp(1, store::HISTORY_CAP);
    let history = {
        let store = state.store.lock().await;
        store.history(limit)
    };
    Ok(Json(json!({ "history": history })))
}

async fn history_clear(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    state
        .store
        .lock()
        .await
        .clear_history()
        .map_err(store_error)?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct NewFavoriteRequest {
    name: String,
    sql: String,
}

async fn favorites_list(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let favorites = {
        let store = state.store.lock().await;
        store.favorites()
    };
    Ok(Json(json!({ "favorites": favorites })))
}

async fn favorites_create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<NewFavoriteRequest>,
) -> Result<Json<Value>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let name = req.name.trim().to_string();
    let sql = req.sql.trim().to_string();
    if name.is_empty() || sql.is_empty() {
        return Err(bad_request("invalid_request", "이름과 SQL이 필요합니다"));
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    state
        .store
        .lock()
        .await
        .add_favorite(store::FavoriteEntry {
            id: id.clone(),
            name,
            sql,
        })
        .map_err(store_error)?;
    Ok(Json(json!({ "id": id })))
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

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

#[derive(Deserialize)]
struct FsParams {
    path: Option<String>,
}

async fn fs_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<FsParams>,
) -> Result<Json<FsListing>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    list_dir(params.path.as_deref())
        .map(Json)
        .map_err(|err| {
            (
                StatusCode::BAD_REQUEST,
                Json(ApiError {
                    code: "fs_error".into(),
                    message: err.to_string(),
                }),
            )
        })
}

fn default_dir() -> PathBuf {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

fn list_dir(path: Option<&str>) -> Result<FsListing, std::io::Error> {
    let requested = match path {
        Some(p) if !p.trim().is_empty() => PathBuf::from(p.trim()),
        _ => default_dir(),
    };
    let dir = std::fs::canonicalize(&requested)?;

    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
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
    Json(req): Json<QueryRequest>,
) -> Result<Json<QueryResult>, (StatusCode, Json<ApiError>)> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }

    let max_rows = req.max_rows.unwrap_or(10_000).clamp(1, 500_000);
    let _inflight = InflightGuard::new(state.inflight.clone());
    state
        .engine
        .execute(&req.sql, max_rows)
        .await
        .map(Json)
        .map_err(engine_error)
}

struct Sender {
    tx: mpsc::Sender<Message>,
    order: Arc<tokio::sync::Mutex<()>>,
}

impl Clone for Sender {
    fn clone(&self) -> Self {
        Self {
            tx: self.tx.clone(),
            order: self.order.clone(),
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

async fn ws_upgrade(
    State(state): State<AppState>,
    Query(params): Query<IndexParams>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !authorized(&state, &headers, params.token.as_deref()) {
        return (StatusCode::UNAUTHORIZED, "토큰이 유효하지 않습니다").into_response();
    }
    ws.on_upgrade(move |socket| ws_session(socket, state))
}

async fn ws_session(socket: WebSocket, state: AppState) {
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
    };

    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(text) => {
                let parsed: Result<Value, _> = serde_json::from_str(text.as_str());
                let value = match parsed {
                    Ok(value) => value,
                    Err(_) => {
                        sender.json(error_json(None, "잘못된 JSON 메시지", false)).await;
                        continue;
                    }
                };
                match value["type"].as_str().unwrap_or("") {
                    "query" => handle_query(&state, &sender, &value).await,
                    "fetch" => handle_fetch(&state, &sender, &value).await,
                    "cancel" => state.cancel_if_inflight(),
                    "edit" => handle_edit(&state, &sender, &value).await,
                    "tx" => handle_tx(&state, &sender, &value).await,
                    _ => sender.json(error_json(None, "알 수 없는 메시지 타입", false)).await,
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    state.cancel_if_inflight();
    let _ = writer.await;
}

async fn handle_query(state: &AppState, sender: &Sender, value: &Value) {
    let id = value["id"].as_str().unwrap_or("").to_string();
    let sql = value["sql"].as_str().unwrap_or("").to_string();
    let max_rows = value["max_rows"].as_u64().unwrap_or(10_000).clamp(1, 500_000) as usize;
    let window = value["window"].as_u64().unwrap_or(1000).clamp(1, 100_000) as usize;
    if id.is_empty() || sql.trim().is_empty() {
        sender
            .json(error_json(None, "query 메시지에 id/sql이 필요합니다", false))
            .await;
        return;
    }

    state.cancel_if_inflight();

    let state = state.clone();
    let sender = sender.clone();
    tokio::spawn(async move {
        let _inflight = InflightGuard::new(state.inflight.clone());
        match state.engine.query(&sql, max_rows).await {
            Ok(data) => {
                let mut store = state.store.lock().await;
                let _ = store.record_history(&sql, unix_now());
                drop(store);
                let data = Arc::new(data);
                let meta = json!({
                    "type": "meta",
                    "id": id,
                    "kind": data.kind,
                    "columns": data.columns,
                    "row_count": data.row_count,
                    "elapsed_ms": data.elapsed_ms,
                    "truncated": data.truncated,
                    "source_table": data.source_table,
                    "pk": data.pk,
                });
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
                state.sessions.lock().await.insert(id.clone(), data.clone());
                if let Err(err) = send_window(&state, &sender, &id, 0, window).await {
                    sender.json(error_json(Some(&id), &err.to_string(), false)).await;
                }
            }
            Err(err) => {
                let cancelled = err.is_interrupted();
                let message = if cancelled {
                    "쿼리가 취소되었습니다".to_string()
                } else {
                    err.to_string()
                };
                sender.json(error_json(Some(&id), &message, cancelled)).await;
            }
        }
    });
}

async fn handle_fetch(state: &AppState, sender: &Sender, value: &Value) {
    let id = value["id"].as_str().unwrap_or("");
    let offset = value["offset"].as_u64().unwrap_or(0) as usize;
    let limit = value["limit"].as_u64().unwrap_or(1000).clamp(1, 100_000) as usize;
    if let Err(err) = send_window(state, sender, id, offset, limit).await {
        sender.json(error_json(Some(id), &err.to_string(), false)).await;
    }
}

async fn send_window(
    state: &AppState,
    sender: &Sender,
    id: &str,
    offset: usize,
    limit: usize,
) -> Result<(), EngineError> {
    let session = state
        .sessions
        .lock()
        .await
        .get(id)
        .ok_or_else(|| EngineError::Internal("세션이 만료되었습니다. 쿼리를 다시 실행하세요".into()))?;
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
    let message = json!({"type": "window", "id": id, "offset": offset, "count": count});
    sender.batch_json(message, payload).await;
    Ok(())
}

async fn handle_edit(state: &AppState, sender: &Sender, value: &Value) {
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
        row: Option<usize>,
        col: Option<usize>,
    }

    let msg: EditMsg = match serde_json::from_value(value.clone()) {
        Ok(msg) => msg,
        Err(err) => {
            sender
                .json(error_json(None, &format!("edit 메시지 형식 오류: {err}"), false))
                .await;
            return;
        }
    };

    let session_arc = state.sessions.lock().await.get(&msg.session);
    let Some(session_arc) = session_arc else {
        sender.json(error_json(None, "세션이 만료되었습니다", false)).await;
        return;
    };
    {
        let guard = session_arc.lock().await;
        if guard.data.source_table.as_deref() != Some(msg.table.as_str()) {
            drop(guard);
            sender
                .json(error_json(None, "이 결과는 편집할 수 없습니다", false))
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
    };

    match state.engine.edit(&target).await {
        Ok(changed) => {
            if let (Some(row), Some(col)) = (row, col) {
                if let Some(session_arc) = state.sessions.lock().await.get(&session_id) {
                    let in_tx = state.engine.in_tx().await.unwrap_or(false);
                    let mut guard = session_arc.lock().await;
                    let old = guard.data.cell_string(row, col);
                    if guard
                        .data
                        .patch_cell(row, col, echo_value.as_deref())
                        .is_ok()
                        && in_tx
                    {
                        guard.journal.push(JournalEntry { row, col, old });
                    }
                }
            }
            sender
                .json(json!({
                    "type": "edited",
                    "row": row,
                    "col": col,
                    "column": echo_column,
                    "value": echo_value,
                    "rows_affected": changed,
                }))
                .await;
        }
        Err(err) => {
            sender.json(error_json(None, &err.to_string(), false)).await;
        }
    }
}

async fn handle_tx(state: &AppState, sender: &Sender, value: &Value) {
    let action = value["action"].as_str().unwrap_or("");
    let result = match action {
        "begin" => state.engine.begin_tx().await.map(|_| "began"),
        "commit" => state.engine.commit_tx().await.map(|_| "committed"),
        "rollback" => state.engine.rollback_tx().await.map(|_| "rolledback"),
        _ => {
            sender.json(error_json(None, "알 수 없는 tx action", false)).await;
            return;
        }
    };
    match result {
        Ok(state_label) => {
            apply_journal(state, action).await;
            sender.json(json!({"type": "tx", "state": state_label})).await;
        }
        Err(err) => {
            sender.json(error_json(None, &err.to_string(), false)).await;
        }
    }
}

async fn apply_journal(state: &AppState, action: &str) {
    let sessions = state.sessions.lock().await.snapshot();
    for session_arc in sessions {
        let mut guard = session_arc.lock().await;
        if action == "rollback" {
            let entries: Vec<JournalEntry> = guard.journal.drain(..).collect();
            let session: &mut QuerySession = &mut guard;
            for entry in entries.into_iter().rev() {
                let _ = session
                    .data
                    .patch_cell(entry.row, entry.col, entry.old.as_deref());
            }
        } else {
            guard.journal.clear();
        }
    }
}

fn error_json(id: Option<&str>, message: &str, cancelled: bool) -> Value {
    json!({
        "type": "error",
        "id": id,
        "message": message,
        "cancelled": cancelled,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_dir_sorts_and_skips_hidden() {
        let base = std::env::temp_dir().join(format!(
            "prodb-fs-test-{}-{}",
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

        let listing = list_dir(Some(base.to_str().unwrap())).unwrap();
        let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["adir", "zdir", "note.txt"]);
        assert_eq!(listing.entries[2].size, Some(2));
        assert!(listing.parent.is_some());

        std::fs::remove_dir_all(&base).unwrap();
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
            "prodb-server-test-{}-{}-{name}",
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
        AppState {
            engine: Arc::new(Engine::open_demo(3).unwrap()),
            token: "test-token".into(),
            demo_rows: 3,
            allowed_hosts: Arc::new(vec!["127.0.0.1:1".into()]),
            sessions: Arc::new(tokio::sync::Mutex::new(SessionStore::new(1))),
            tunnel: Arc::new(tokio::sync::Mutex::new(None)),
            store: Arc::new(tokio::sync::Mutex::new(store::StoreFile::load(dir))),
            inflight: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn test_headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-prodb-token", "test-token".parse().unwrap());
        headers
    }

    fn test_connect_request(driver: &str) -> ConnectRequest {
        ConnectRequest {
            driver: driver.into(),
            postgres: Some(prodb_types::PostgresConfig {
                host: "127.0.0.1".into(),
                port: 5433,
                user: "prodb".into(),
                password: Some("prodb_test_pw".into()),
                database: "prodb_test".into(),
                ssl_mode: prodb_types::SslMode::Disable,
            }),
            cockroach: None,
            mysql: None,
            mssql: None,
            ssh: None,
        }
    }

    fn test_mysql_connect_request() -> ConnectRequest {
        ConnectRequest {
            driver: "mysql".into(),
            postgres: None,
            cockroach: None,
            mysql: Some(prodb_types::MySqlConfig {
                host: "127.0.0.1".into(),
                port: 3307,
                user: "root".into(),
                password: Some("root_pw".into()),
                database: "prodb_test".into(),
                ssl_mode: prodb_types::SslMode::Disable,
            }),
            mssql: None,
            ssh: None,
        }
    }

    fn test_cockroach_connect_request() -> ConnectRequest {
        ConnectRequest {
            driver: "cockroach".into(),
            postgres: None,
            cockroach: Some(prodb_types::PostgresConfig {
                host: "127.0.0.1".into(),
                port: 26258,
                user: "root".into(),
                password: None,
                database: "defaultdb".into(),
                ssl_mode: prodb_types::SslMode::Disable,
            }),
            mysql: None,
            mssql: None,
            ssh: None,
        }
    }

    fn test_mssql_connect_request() -> ConnectRequest {
        ConnectRequest {
            driver: "mssql".into(),
            postgres: None,
            cockroach: None,
            mysql: None,
            mssql: Some(prodb_types::MssqlConfig {
                host: "127.0.0.1".into(),
                port: 14330,
                user: "sa".into(),
                password: Some("MsSql_test_pw1".into()),
                database: "prodb_test".into(),
                encrypt: false,
            }),
            ssh: None,
        }
    }

    #[tokio::test]
    async fn connect_rejects_unsupported_driver() {
        let dir = temp_dir("connect-driver");
        let state = test_state(&dir);
        let err = connect_with(&state, test_connect_request("sqlite"))
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
        };
        let err = connect_with(&state, request).await.unwrap_err();
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
        };
        let err = connect_with(&state, request).await.unwrap_err();
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
        };
        let err = connect_with(&state, request).await.unwrap_err();
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
        assert!(!listed.0.to_string().contains("prodb_test_pw"));

        let missing = connection_connect(
            State(state.clone()),
            AxumPath("no-such-id".into()),
            headers.clone(),
        )
        .await
        .unwrap_err();
        assert_eq!(missing.0, StatusCode::NOT_FOUND);

        let deleted = connections_delete(State(state.clone()), AxumPath(id.clone()), headers.clone())
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
        assert_eq!(connections[0]["mysql"]["database"], json!("prodb_test"));
        assert!(connections[0]["mysql"].get("password").is_none());
        assert!(connections[0].get("postgres").is_none());
        assert!(!listed.0.to_string().contains("root_pw"));

        let missing = connection_connect(
            State(state.clone()),
            AxumPath("no-such-id".into()),
            headers.clone(),
        )
        .await
        .unwrap_err();
        assert_eq!(missing.0, StatusCode::NOT_FOUND);

        let deleted = connections_delete(State(state.clone()), AxumPath(id.clone()), headers.clone())
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
        assert_eq!(connections[0]["mssql"]["database"], json!("prodb_test"));
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
        if std::env::var("PRODB_TEST_DOCKER").is_err() {
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

        let err = connection_connect(State(state.clone()), AxumPath(id), headers)
            .await
            .unwrap_err();
        assert_eq!(err.0, StatusCode::BAD_REQUEST);
        assert_eq!(err.1.code, "connect_failed");
        assert_eq!(
            err.1.message,
            "저장된 비밀번호가 없습니다 — 비밀번호를 입력해 연결하세요"
        );

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn history_routes_list_and_clear() {
        let dir = temp_dir("history-routes");
        let state = test_state(&dir);
        {
            let mut store = state.store.lock().await;
            store.record_history("SELECT 1", 10).unwrap();
            store.record_history("SELECT 2", 20).unwrap();
        }
        let headers = test_headers();

        let listed = history_list(
            State(state.clone()),
            headers.clone(),
            Query(HistoryParams { limit: Some(1) }),
        )
        .await
        .unwrap();
        let history = listed.0["history"].as_array().unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0]["sql"], json!("SELECT 2"));
        assert_eq!(history[0]["at"], json!(20));

        let _ = history_clear(State(state.clone()), headers.clone())
            .await
            .unwrap();
        let listed = history_list(
            State(state.clone()),
            headers,
            Query(HistoryParams { limit: None }),
        )
        .await
        .unwrap();
        assert!(listed.0["history"].as_array().unwrap().is_empty());

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
                sql: "SELECT * FROM users".into(),
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
        assert_eq!(favorites[0]["sql"], json!("SELECT * FROM users"));

        let empty = favorites_create(
            State(state.clone()),
            headers.clone(),
            Json(NewFavoriteRequest {
                name: "  ".into(),
                sql: "SELECT 1".into(),
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
}
