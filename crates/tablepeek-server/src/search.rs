//! Search engines (`/api/search/*`, docs/engines/elasticsearch.md §4):
//! Elasticsearch and OpenSearch. Values travel as the server gives them.
//! Reads run as the page's statement (a newer one or a cancel stops them);
//! writes are never cancelled. Status polls, the task cancel, closing
//! cursors and exports run beside whatever holds the connection, so they
//! neither wait behind a long search nor hold one up.

use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post};
use axum::Router;
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use tablepeek_engine::search::{
    self as facet, AliasInfo, AliasesRequest, AnalyzeRequest, ApiKeyRequest, BulkRequest,
    ByQueryRequest, ConsoleReply, ConsoleRequest, CountRequest, DeleteDocRequest, DocRef,
    ExplainDocRequest, IndexDocRequest, IndexRequest, PitCloseRequest, PitOpenRequest, Raw,
    ReindexRequest, RequestClass, SearchExportRequest, SearchRequest, SecurityDeleteRequest,
    SecurityKind, SecurityPutRequest, SqlCursorRequest, SqlRequest, SqlResult, SqlTranslateRequest,
    TaskCancelRequest, UpdateDocRequest, UserEnabledRequest, UserPasswordRequest, ValidateRequest,
};
use tablepeek_engine::EngineError;
use tablepeek_types::ApiError;

use super::{
    authorized, engine_error, slot_for, unauthorized, AppState, ConnQuery, ConnSlot, Holder,
    InflightGuard,
};

type ApiResult<T> = Result<T, (StatusCode, Json<ApiError>)>;

/// The largest `_bulk` body the import may send at once.
const BULK_BODY_LIMIT: usize = 64 * 1024 * 1024;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/search/cluster", get(cluster))
        .route("/api/search/nodes", get(nodes))
        .route("/api/search/perf", get(perf))
        .route("/api/search/tasks", get(tasks))
        .route("/api/search/privileges", get(privileges))
        .route("/api/search/tasks/cancel", post(cancel_task))
        .route("/api/search/hot-threads", get(hot_threads))
        .route("/api/search/shards", get(shards))
        .route("/api/search/indices", get(indices))
        .route("/api/search/aliases", get(aliases).post(update_aliases))
        .route("/api/search/data-streams", get(data_streams))
        .route("/api/search/mapping", get(mapping).put(put_mapping))
        .route("/api/search/settings", get(settings).put(put_settings))
        .route("/api/search/definition", get(definition))
        .route("/api/search/index/create", post(create_index))
        .route("/api/search/index/delete", post(delete_index))
        .route("/api/search/index/open", post(open_index))
        .route("/api/search/index/close", post(close_index))
        .route("/api/search/index/refresh", post(refresh_index))
        .route("/api/search/reindex", post(reindex))
        .route("/api/search/search", post(search))
        .route("/api/search/profile", post(profile))
        .route("/api/search/count", post(count))
        .route("/api/search/pit", post(open_pit).delete(close_pit))
        .route("/api/search/doc/get", post(get_doc))
        .route("/api/search/doc/index", post(index_doc))
        .route("/api/search/doc/update", post(update_doc))
        .route("/api/search/doc/delete", post(delete_doc))
        .route("/api/search/delete-by-query", post(delete_by_query))
        .route("/api/search/update-by-query", post(update_by_query))
        .route("/api/search/explain", post(explain))
        .route("/api/search/validate", post(validate))
        .route("/api/search/analyze", post(analyze))
        .route("/api/search/sql", post(sql))
        .route("/api/search/sql/close", post(sql_close))
        .route("/api/search/sql/translate", post(sql_translate))
        .route("/api/search/console", post(console))
        .route("/api/search/console/classify", get(classify))
        .route(
            "/api/search/bulk",
            post(bulk).layer(DefaultBodyLimit::max(BULK_BODY_LIMIT)),
        )
        .route("/api/search/export", post(export))
        .route("/api/search/stop", post(stop))
        .route("/api/search/security", get(security))
        .route("/api/search/security/list", get(security_list))
        .route("/api/search/security/put", post(security_put))
        .route("/api/search/security/delete", post(security_delete))
        .route("/api/search/security/password", post(user_password))
        .route("/api/search/security/enabled", post(user_enabled))
        .route("/api/search/security/api-key", post(create_api_key))
}

/// Runs `$body` with the slot's search operations as `$ops`, gated like any
/// statement of the slot.
macro_rules! search_call {
    ($slot:expr, $holder:expr, |$ops:ident| $body:expr) => {{
        let slot = &$slot;
        let _inflight = InflightGuard::new(slot.inflight.clone());
        slot.gated($holder, false, async {
            if $holder == Holder::Protected {
                slot.refused_while_job()?;
            }
            let session = slot.engine.search()?;
            let $ops = session.ops();
            $body.await
        })
        .await
        .map_err(engine_error)
    }};
}

/// Runs `$body` with the slot's search operations beside whatever holds the
/// connection, outside its gate (the client is a pool of connections).
macro_rules! search_beside {
    ($slot:expr, |$ops:ident| $body:expr) => {{
        let slot = &$slot;
        let _inflight = InflightGuard::new(slot.inflight.clone());
        async {
            let session = slot.engine.search()?;
            let $ops = session.ops();
            $body.await
        }
        .await
        .map_err(engine_error)
    }};
}

async fn search_slot(
    state: &AppState,
    headers: &HeaderMap,
    conn: Option<&str>,
) -> ApiResult<Arc<ConnSlot>> {
    if !authorized(state, headers, None) {
        return Err(unauthorized());
    }
    slot_for(state, conn).await
}

/// A rule broken before anything was sent.
fn refused(err: EngineError) -> (StatusCode, Json<ApiError>) {
    engine_error(err)
}

#[derive(Deserialize)]
struct IndexParams {
    conn: Option<String>,
    #[serde(default)]
    index: String,
    #[serde(default)]
    hidden: bool,
    #[serde(default)]
    defaults: bool,
}

#[derive(Deserialize)]
struct TaskParams {
    conn: Option<String>,
    #[serde(default)]
    actions: Option<String>,
}

#[derive(Deserialize)]
struct HotThreadsParams {
    conn: Option<String>,
    #[serde(default)]
    threads: Option<u32>,
    #[serde(default)]
    interval: Option<String>,
}

#[derive(Deserialize)]
struct ClassifyParams {
    conn: Option<String>,
    #[serde(default)]
    method: String,
    #[serde(default)]
    path: String,
}

#[derive(Deserialize)]
struct BulkParams {
    conn: Option<String>,
    #[serde(flatten)]
    bulk: BulkRequest,
}

async fn cluster(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    search_beside!(slot, |ops| ops.cluster()).map(Json)
}

async fn nodes(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    search_beside!(slot, |ops| ops.nodes()).map(Json)
}

async fn perf(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    search_beside!(slot, |ops| ops.perf()).map(Json)
}

async fn tasks(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<TaskParams>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    let tasks = search_beside!(slot, |ops| ops.tasks(params.actions.as_deref()))?;
    Ok(Json(json!(tasks)))
}

/// Beside the gate: the task to stop is often the search the page waits on.
async fn cancel_task(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<TaskCancelRequest>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    facet::check_confirmed(req.confirmed, "작업을 취소하려면").map_err(refused)?;
    search_beside!(slot, |ops| ops.cancel_task(&req.id)).map(Json)
}

async fn hot_threads(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<HotThreadsParams>,
) -> ApiResult<Response> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    let text = search_beside!(slot, |ops| ops
        .hot_threads(params.threads, params.interval.as_deref()))?;
    Ok(([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], text).into_response())
}

async fn shards(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<IndexParams>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    let index = Some(params.index.as_str()).filter(|index| !index.trim().is_empty());
    search_beside!(slot, |ops| ops.shards(index)).map(Json)
}

/// Beside the gate and unlogged: the page asks before showing edits.
async fn privileges(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<IndexParams>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    let index = Some(params.index.as_str()).filter(|index| !index.trim().is_empty());
    search_beside!(slot, |ops| ops.privileges(index)).map(Json)
}

async fn indices(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<IndexParams>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    let indices = search_call!(slot, Holder::Foreground, |ops| ops.indices(params.hidden))?;
    Ok(Json(json!(indices)))
}

async fn aliases(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
) -> ApiResult<Json<Vec<AliasInfo>>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    search_call!(slot, Holder::Foreground, |ops| ops.aliases()).map(Json)
}

async fn update_aliases(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<AliasesRequest>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    facet::check_alias_actions(&req).map_err(refused)?;
    search_call!(slot, Holder::Protected, |ops| ops.update_aliases(&req)).map(Json)
}

async fn data_streams(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    search_call!(slot, Holder::Foreground, |ops| ops.data_streams()).map(Json)
}

async fn mapping(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<IndexParams>,
) -> ApiResult<Json<Raw>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    search_call!(slot, Holder::Foreground, |ops| ops.mapping(&params.index)).map(Json)
}

async fn put_mapping(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<IndexRequest>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    search_call!(slot, Holder::Protected, |ops| ops.put_mapping(&req)).map(Json)
}

async fn settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<IndexParams>,
) -> ApiResult<Json<Raw>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    search_call!(slot, Holder::Foreground, |ops| ops
        .settings(&params.index, params.defaults))
    .map(Json)
}

async fn put_settings(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<IndexRequest>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    search_call!(slot, Holder::Protected, |ops| ops.put_settings(&req)).map(Json)
}

async fn definition(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<IndexParams>,
) -> ApiResult<Json<Raw>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    search_call!(slot, Holder::Foreground, |ops| ops
        .definition(&params.index))
    .map(Json)
}

async fn create_index(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<IndexRequest>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    facet::check_single_index(&req.index).map_err(refused)?;
    search_call!(slot, Holder::Protected, |ops| ops.create_index(&req)).map(Json)
}

async fn delete_index(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<IndexRequest>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    facet::check_single_index(&req.index).map_err(refused)?;
    facet::check_confirmed(req.confirmed, "인덱스를 삭제하려면").map_err(refused)?;
    search_call!(slot, Holder::Protected, |ops| ops.delete_index(&req)).map(Json)
}

async fn open_index(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<IndexRequest>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    search_call!(slot, Holder::Protected, |ops| ops.open_index(&req)).map(Json)
}

async fn close_index(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<IndexRequest>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    facet::check_single_index(&req.index).map_err(refused)?;
    facet::check_confirmed(req.confirmed, "인덱스를 닫으려면").map_err(refused)?;
    search_call!(slot, Holder::Protected, |ops| ops.close_index(&req)).map(Json)
}

async fn refresh_index(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<IndexRequest>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    search_call!(slot, Holder::Protected, |ops| ops.refresh_index(&req)).map(Json)
}

async fn reindex(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<ReindexRequest>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    facet::check_confirmed(req.confirmed, "reindex는").map_err(refused)?;
    search_call!(slot, Holder::Protected, |ops| ops.reindex(&req)).map(Json)
}

async fn search(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<SearchRequest>,
) -> ApiResult<Json<Raw>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    search_call!(slot, Holder::Foreground, |ops| ops.search(&req)).map(Json)
}

async fn profile(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(mut req): Json<SearchRequest>,
) -> ApiResult<Json<Raw>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    req.profile = true;
    search_call!(slot, Holder::Foreground, |ops| ops.search(&req)).map(Json)
}

async fn count(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<CountRequest>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    let count = search_call!(slot, Holder::Foreground, |ops| ops.count(&req))?;
    Ok(Json(json!({ "count": count })))
}

async fn open_pit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<PitOpenRequest>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    let id = search_call!(slot, Holder::Foreground, |ops| ops.open_pit(&req))?;
    Ok(Json(json!({ "id": id })))
}

async fn close_pit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<PitCloseRequest>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    search_beside!(slot, |ops| ops.close_pit(&req.id))?;
    Ok(Json(json!({ "ok": true })))
}

async fn get_doc(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<DocRef>,
) -> ApiResult<Json<Raw>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    search_call!(slot, Holder::Foreground, |ops| ops.get_doc(&req)).map(Json)
}

async fn index_doc(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<IndexDocRequest>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    search_call!(slot, Holder::Protected, |ops| ops.index_doc(&req)).map(Json)
}

async fn update_doc(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<UpdateDocRequest>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    search_call!(slot, Holder::Protected, |ops| ops.update_doc(&req)).map(Json)
}

async fn delete_doc(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<DeleteDocRequest>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    search_call!(slot, Holder::Protected, |ops| ops.delete_doc(&req)).map(Json)
}

const BY_QUERY_CONFIRM: &str = "조건에 맞는 문서를 한꺼번에 바꾸거나 지우려면";

async fn delete_by_query(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<ByQueryRequest>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    facet::check_confirmed(req.confirmed, BY_QUERY_CONFIRM).map_err(refused)?;
    search_call!(slot, Holder::Protected, |ops| ops.delete_by_query(&req)).map(Json)
}

async fn update_by_query(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<ByQueryRequest>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    facet::check_confirmed(req.confirmed, BY_QUERY_CONFIRM).map_err(refused)?;
    search_call!(slot, Holder::Protected, |ops| ops.update_by_query(&req)).map(Json)
}

async fn explain(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<ExplainDocRequest>,
) -> ApiResult<Json<Raw>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    search_call!(slot, Holder::Foreground, |ops| ops.explain(&req)).map(Json)
}

async fn validate(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<ValidateRequest>,
) -> ApiResult<Json<Raw>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    search_call!(slot, Holder::Foreground, |ops| ops.validate(&req)).map(Json)
}

async fn analyze(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<AnalyzeRequest>,
) -> ApiResult<Json<Raw>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    search_call!(slot, Holder::Foreground, |ops| ops.analyze(&req)).map(Json)
}

async fn sql(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<SqlRequest>,
) -> ApiResult<Json<SqlResult>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    search_call!(slot, Holder::Foreground, |ops| ops.sql(&req)).map(Json)
}

async fn sql_close(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<SqlCursorRequest>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    search_beside!(slot, |ops| ops.sql_close(&req.cursor))?;
    Ok(Json(json!({ "ok": true })))
}

async fn sql_translate(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<SqlTranslateRequest>,
) -> ApiResult<Json<Raw>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    search_call!(slot, Holder::Foreground, |ops| ops
        .sql_translate(&req.query))
    .map(Json)
}

/// A raw request: classified first, a dangerous one refused unless
/// confirmed; a read runs as the page's statement, anything else as a
/// write.
async fn console(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<ConsoleRequest>,
) -> ApiResult<Json<ConsoleReply>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    let class = {
        let session = slot.engine.search().map_err(engine_error)?;
        session
            .ops()
            .classify(&req.method, &req.path, req.body.as_deref())
            .map_err(engine_error)?
    };
    if class.class == RequestClass::Danger && !req.confirmed {
        return Err(refused(EngineError::BadRequest(format!(
            "위험한 요청({})은 확인이 필요합니다 (confirmed: true)",
            class.reason
        ))));
    }
    let holder = if class.class == RequestClass::Read {
        Holder::Foreground
    } else {
        Holder::Protected
    };
    search_call!(slot, holder, |ops| ops.console(&req, &class)).map(Json)
}

async fn classify(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ClassifyParams>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    let session = slot.engine.search().map_err(engine_error)?;
    let classified = session
        .ops()
        .classify(&params.method, &params.path, None)
        .map_err(engine_error)?;
    Ok(Json(json!(classified)))
}

/// A `_bulk` body as the import sends it (NDJSON, the request's body).
async fn bulk(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<BulkParams>,
    body: String,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    search_call!(slot, Holder::Protected, |ops| ops.bulk(&params.bulk, body)).map(Json)
}

/// Streams the hits of a query as NDJSON: `{ _index, _id, _source }` a
/// line, then `{"$end": {"count": n}}`; a failure midway ends it with
/// `{"$error": {…}}` instead. The client cancels by going away: the
/// stream is dropped, and the server's cursor is let go with it.
async fn export(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<SearchExportRequest>,
) -> ApiResult<Response> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    let hits = search_beside!(slot, |ops| ops.export(&req))?;
    let line = |value: &dyn std::fmt::Display| Bytes::from(format!("{value}\n"));
    let lines = futures_util::stream::unfold(Some((hits, 0u64)), move |state| async move {
        let (mut hits, count) = state?;
        Some(match hits.next().await {
            Some(Ok(hit)) => (line(&hit), Some((hits, count + 1))),
            Some(Err(err)) => {
                let (_, Json(error)) = engine_error(err);
                (line(&json!({ "$error": error })), None)
            }
            None => (line(&json!({ "$end": { "count": count } })), None),
        })
    })
    .map(Ok::<_, std::convert::Infallible>);
    Ok((
        [(header::CONTENT_TYPE, "application/x-ndjson")],
        Body::from_stream(lines),
    )
        .into_response())
}

/// The page's Stop, beside the gate (the read it stops holds it): what the
/// server still runs for the request stopped.
async fn stop(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    search_beside!(slot, |ops| ops.stop()).map(Json)
}

#[derive(Deserialize)]
struct SecurityParams {
    conn: Option<String>,
    kind: SecurityKind,
}

async fn security(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    search_beside!(slot, |ops| ops.security()).map(Json)
}

async fn security_list(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<SecurityParams>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    search_call!(slot, Holder::Foreground, |ops| ops
        .security_list(params.kind))
    .map(Json)
}

async fn security_put(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<SecurityPutRequest>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    facet::check_confirmed(req.confirmed, "보안 설정을 바꾸려면").map_err(refused)?;
    search_call!(slot, Holder::Protected, |ops| ops.security_put(&req)).map(Json)
}

async fn security_delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<SecurityDeleteRequest>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    facet::check_confirmed(req.confirmed, "보안 설정을 지우려면").map_err(refused)?;
    search_call!(slot, Holder::Protected, |ops| ops.security_delete(&req)).map(Json)
}

async fn user_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<UserPasswordRequest>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    facet::check_confirmed(req.confirmed, "비밀번호를 바꾸려면").map_err(refused)?;
    search_call!(slot, Holder::Protected, |ops| ops.user_password(&req)).map(Json)
}

async fn user_enabled(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<UserEnabledRequest>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    facet::check_confirmed(req.confirmed, "사용자를 켜거나 끄려면").map_err(refused)?;
    search_call!(slot, Holder::Protected, |ops| ops.user_enabled(&req)).map(Json)
}

async fn create_api_key(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<ApiKeyRequest>,
) -> ApiResult<Json<Value>> {
    let slot = search_slot(&state, &headers, params.conn.as_deref()).await?;
    facet::check_confirmed(req.confirmed, "API 키를 만들려면").map_err(refused)?;
    search_call!(slot, Holder::Protected, |ops| ops.create_api_key(&req)).map(Json)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{connect_with, store, Registry, SlotOrigin};
    use tablepeek_engine::Engine;
    use tablepeek_types::ConnectRequest;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    fn state(name: &str) -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "tablepeek-search-test-{}-{name}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let mut registry = Registry::new();
        registry.insert(Arc::new(ConnSlot::new(
            "main".into(),
            "데모".into(),
            None,
            None,
            Engine::open_demo(3).unwrap(),
        )));
        let state = AppState {
            registry: Arc::new(tokio::sync::Mutex::new(registry)),
            default_conn: "main".into(),
            token: "test-token".into(),
            demo_rows: 3,
            allowed_hosts: Arc::new(vec!["127.0.0.1:1".into()]),
            store: Arc::new(tokio::sync::Mutex::new(store::StoreFile::load(&dir))),
            update: Arc::new(crate::update::UpdateChecker::new(
                &dir,
                crate::update::RELEASES_URL.into(),
                crate::update::VERSION,
                true,
            )),
        };
        (state, dir)
    }

    fn headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-tablepeek-token", "test-token".parse().unwrap());
        headers
    }

    fn conn(id: &str) -> Query<ConnQuery> {
        Query(ConnQuery {
            conn: Some(id.to_string()),
            system: None,
        })
    }

    async fn connect(state: &AppState, request: Value) -> Arc<ConnSlot> {
        let request: ConnectRequest = serde_json::from_value(request).unwrap();
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

    /// An HTTP CONNECT proxy on a free local port, as the HTTP tunnel
    /// reaches a cluster behind one; it remembers where it was asked to go.
    async fn connect_proxy() -> (u16, Arc<std::sync::Mutex<Vec<String>>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let asked = Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = asked.clone();
        tokio::spawn(async move {
            while let Ok((client, _)) = listener.accept().await {
                let seen = seen.clone();
                tokio::spawn(async move {
                    let mut client = BufReader::new(client);
                    let mut first = String::new();
                    client.read_line(&mut first).await.unwrap();
                    let target = first.split_whitespace().nth(1).unwrap().to_string();
                    loop {
                        let mut line = String::new();
                        client.read_line(&mut line).await.unwrap();
                        if line == "\r\n" || line.is_empty() {
                            break;
                        }
                    }
                    seen.lock().unwrap().push(target.clone());
                    let (host, port) = target.rsplit_once(':').unwrap();
                    let host = if host == "es.tablepeek.test" {
                        "127.0.0.1"
                    } else {
                        host
                    };
                    let mut upstream =
                        tokio::net::TcpStream::connect((host, port.parse::<u16>().unwrap()))
                            .await
                            .unwrap();
                    let mut client = client.into_inner();
                    client
                        .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                        .await
                        .unwrap();
                    let _ = tokio::io::copy_bidirectional(&mut client, &mut upstream).await;
                });
            }
        });
        (port, asked)
    }

    #[tokio::test]
    async fn search_routes_refuse_other_engines_and_unconfirmed_writes() {
        let (state, dir) = state("refuse");
        let err = cluster(State(state.clone()), headers(), conn("main"))
            .await
            .unwrap_err();
        assert_eq!(err.1 .0.code, "unsupported_capability");
        let err = delete_index(
            State(state.clone()),
            headers(),
            conn("main"),
            Json(IndexRequest {
                index: "shop".into(),
                body: None,
                confirmed: false,
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(err.1 .0.code, "bad_request");
        let err = delete_index(
            State(state.clone()),
            headers(),
            conn("main"),
            Json(IndexRequest {
                index: "logs-*".into(),
                body: None,
                confirmed: true,
            }),
        )
        .await
        .unwrap_err();
        assert!(
            err.1 .0.message.contains("인덱스 하나"),
            "{}",
            err.1 .0.message
        );
        let mut wrong = HeaderMap::new();
        wrong.insert("x-tablepeek-token", "nope".parse().unwrap());
        let err = nodes(State(state), wrong, conn("main")).await.unwrap_err();
        assert_eq!(err.0, StatusCode::UNAUTHORIZED);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The routes against a live server, connected directly and through an
    /// HTTP tunnel (by name and by IP address).
    async fn routes_against(engine: &str, config: Value, flavor: &str) {
        let (state, dir) = state(engine);
        let slot = connect(&state, json!({ "driver": engine, "config": config })).await;
        let id = slot.id.clone();

        let info = cluster(State(state.clone()), headers(), conn(&id))
            .await
            .unwrap()
            .0;
        assert_eq!(info["flavor"], flavor);
        let listed = indices(
            State(state.clone()),
            headers(),
            Query(IndexParams {
                conn: Some(id.clone()),
                index: String::new(),
                hidden: false,
                defaults: false,
            }),
        )
        .await
        .unwrap()
        .0;
        assert!(listed
            .as_array()
            .unwrap()
            .iter()
            .any(|index| index["name"] == "shop-orders"));

        let found = search(
            State(state.clone()),
            headers(),
            conn(&id),
            Json(
                serde_json::from_str(
                    &json!({
                        "index": "orders", "size": 2, "sort": [{ "order_no": "desc" }],
                        "body": { "query": { "match_all": {} } }
                    })
                    .to_string(),
                )
                .unwrap(),
            ),
        )
        .await
        .unwrap()
        .0;
        let found: Value = serde_json::from_str(found.get()).unwrap();
        assert_eq!(found["hits"]["hits"][0]["_id"], "O000500");

        // A dangerous console request needs confirming; reads come back as they are.
        let refused = console(
            State(state.clone()),
            headers(),
            conn(&id),
            Json(ConsoleRequest {
                method: "DELETE".into(),
                path: "/shop-orders".into(),
                body: None,
                confirmed: false,
            }),
        )
        .await
        .unwrap_err();
        assert_eq!(refused.1 .0.code, "bad_request");
        let read = console(
            State(state.clone()),
            headers(),
            conn(&id),
            Json(ConsoleRequest {
                method: "GET".into(),
                path: "/_cat/indices/shop-*?format=json".into(),
                body: None,
                confirmed: false,
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(read.status, 200);
        assert_eq!(read.class, RequestClass::Read);
        let classified = classify(
            State(state.clone()),
            headers(),
            Query(ClassifyParams {
                conn: Some(id.clone()),
                method: "POST".into(),
                path: "/shop/_delete_by_query".into(),
            }),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(classified["class"], "danger");

        // Errors carry the server's type as their code.
        let err = search(
            State(state.clone()),
            headers(),
            conn(&id),
            Json(serde_json::from_str(&json!({ "index": "nope-404" }).to_string()).unwrap()),
        )
        .await
        .unwrap_err();
        assert_eq!(err.1 .0.code, "es_index_not_found_exception");
        assert_eq!(err.1 .0.fields.server_code, Some(404));

        // Bulk into a scratch index, then export it as NDJSON.
        let scratch = format!("tablepeek-route-{flavor}");
        let _ = delete_index(
            State(state.clone()),
            headers(),
            conn(&id),
            Json(IndexRequest {
                index: scratch.clone(),
                body: None,
                confirmed: true,
            }),
        )
        .await;
        let lines: String = (0..25)
            .map(|n| {
                format!(
                    "{}\n{}\n",
                    json!({ "index": { "_id": n.to_string() } }),
                    json!({ "n": n })
                )
            })
            .collect();
        let summary = bulk(
            State(state.clone()),
            headers(),
            Query(BulkParams {
                conn: Some(id.clone()),
                bulk: BulkRequest {
                    index: Some(scratch.clone()),
                    refresh: Some("true".into()),
                    confirmed: false,
                },
            }),
            lines,
        )
        .await
        .unwrap()
        .0;
        assert_eq!(
            (summary["count"].as_u64(), summary["failed"].as_u64()),
            (Some(25), Some(0))
        );
        let response = export(
            State(state.clone()),
            headers(),
            conn(&id),
            Json(
                serde_json::from_str(&json!({ "index": scratch, "limit": 0 }).to_string()).unwrap(),
            ),
        )
        .await
        .unwrap();
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let text = String::from_utf8(body.to_vec()).unwrap();
        let lines: Vec<Value> = text
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines.len(), 26);
        assert_eq!(lines[25], json!({ "$end": { "count": 25 } }));
        // A document's numbers cross the routes as written, both ways. The
        // index maps only `n`, so the server leaves the rest as sent.
        let exact = r#"{"n":7,"big":18446744073709551617123,"dec":1.10,"exp":1e400}"#;
        let mapped = put_mapping(
            State(state.clone()),
            headers(),
            conn(&id),
            Json(
                serde_json::from_str(&format!(
                    r#"{{"index":"{scratch}","body":{{"dynamic":false}}}}"#
                ))
                .unwrap(),
            ),
        )
        .await
        .unwrap();
        assert_eq!(mapped.0["acknowledged"], true);
        let stored = index_doc(
            State(state.clone()),
            headers(),
            conn(&id),
            Json(
                serde_json::from_str(&format!(
                    r#"{{"index":"{scratch}","id":"exact","doc":{exact}}}"#
                ))
                .unwrap(),
            ),
        )
        .await
        .unwrap();
        assert_eq!(stored.0["result"], "created");
        let got = get_doc(
            State(state.clone()),
            headers(),
            conn(&id),
            Json(
                serde_json::from_str(&format!(r#"{{"index":"{scratch}","id":"exact"}}"#)).unwrap(),
            ),
        )
        .await
        .unwrap()
        .0;
        assert!(
            got.get().contains(&format!(r#""_source":{exact}"#)),
            "{}",
            got.get()
        );
        let response = axum::response::IntoResponse::into_response(Json(got));
        let body = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert!(String::from_utf8(body.to_vec()).unwrap().contains(exact));
        let dropped = delete_index(
            State(state.clone()),
            headers(),
            conn(&id),
            Json(IndexRequest {
                index: scratch,
                body: None,
                confirmed: true,
            }),
        )
        .await
        .unwrap();
        assert_eq!(dropped.0["acknowledged"], true);

        // The page's search reached the console, Dev Tools style.
        let (entries, _) = slot.engine.sql_log().since(None);
        assert!(
            entries
                .iter()
                .any(|entry| entry.sql.starts_with("POST /orders/_search")),
            "console"
        );

        // Through an HTTP tunnel: a name keeps itself (TLS and Host), an IP
        // address goes to the tunnel's end.
        let (proxy, asked) = connect_proxy().await;
        let port = config["port"].as_u64().unwrap();
        for host in ["es.tablepeek.test", "127.0.0.1"] {
            let mut tunnelled = config.clone();
            tunnelled["host"] = json!(host);
            let slot = connect(
                &state,
                json!({ "driver": engine, "config": tunnelled,
                        "http_tunnel": { "host": "127.0.0.1", "port": proxy } }),
            )
            .await;
            let info = cluster(State(state.clone()), headers(), conn(&slot.id))
                .await
                .unwrap()
                .0;
            assert_eq!(info["flavor"], flavor);
            assert!(asked.lock().unwrap().contains(&format!("{host}:{port}")));
            // The node the cluster publishes is reached through the
            // tunnel too, to fail over to.
            let nodes: Vec<String> = info["connection"]["nodes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|node| node["address"].as_str().unwrap().to_string())
                .collect();
            assert!(nodes.contains(&format!("127.0.0.1:{port}")), "{nodes:?}");
        }
        // Stop with nothing running, and the security screens' overview.
        let slot = connect(&state, json!({ "driver": engine, "config": config })).await;
        let stopped = stop(State(state.clone()), headers(), conn(&slot.id))
            .await
            .unwrap()
            .0;
        assert_eq!(stopped["stopped"], false, "{stopped}");
        let overview = security(State(state.clone()), headers(), conn(&slot.id))
            .await
            .unwrap()
            .0;
        assert_eq!(overview["enabled"], true, "{overview}");
        let refused = security_put(
            State(state.clone()),
            headers(),
            conn(&slot.id),
            Json(
                serde_json::from_value(json!({ "kind": "roles", "name": "x", "body": {} }))
                    .unwrap(),
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(refused.0, StatusCode::BAD_REQUEST);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn search_routes_against_elasticsearch() {
        if std::env::var("TABLEPEEK_TEST_ELASTICSEARCH").is_err() {
            return;
        }
        routes_against(
            "elasticsearch",
            json!({ "host": "127.0.0.1", "port": 9201, "auth": "basic",
                    "user": "elastic", "password": "tablepeek_test_pw" }),
            "elasticsearch",
        )
        .await;
    }

    #[tokio::test]
    async fn search_routes_against_opensearch() {
        if std::env::var("TABLEPEEK_TEST_OPENSEARCH").is_err() {
            return;
        }
        routes_against(
            "opensearch",
            json!({ "host": "127.0.0.1", "port": 9202, "tls": true, "tls_skip_verify": true,
                    "auth": "basic", "user": "admin", "password": "TablePeek_test_pw1" }),
            "opensearch",
        )
        .await;

        // Checked against the demo CA through an HTTP tunnel: by IP address
        // the certificate is checked against 127.0.0.1 (in it), by a name
        // it isn't issued for it is refused.
        let (state, dir) = state("opensearch-ca");
        let (proxy, _) = connect_proxy().await;
        let ca = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../testdb/opensearch/ca.pem"
        );
        for (host, works) in [("127.0.0.1", true), ("es.tablepeek.test", false)] {
            let request: ConnectRequest = serde_json::from_value(json!({
                "driver": "opensearch",
                "config": { "host": host, "port": 9202, "tls": true, "tls_ca_file": ca,
                            "auth": "basic", "user": "admin", "password": "TablePeek_test_pw1" },
                "http_tunnel": { "host": "127.0.0.1", "port": proxy }
            }))
            .unwrap();
            let origin = SlotOrigin {
                label: None,
                saved_id: None,
            };
            match connect_with(&state, request, origin).await {
                Ok(_) => assert!(works, "{host} connected"),
                Err(err) => {
                    assert!(!works, "{host}: {}", err.message);
                    assert!(err.message.contains("TLS"), "{}", err.message);
                }
            }
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// OpenSearch 3 (`make test-db ENGINE=opensearch-3`): API keys through
    /// the security routes — made (its token shown once), listed, revoked.
    #[tokio::test]
    async fn security_routes_against_opensearch_3() {
        if std::env::var("TABLEPEEK_TEST_OPENSEARCH_3").is_err() {
            return;
        }
        let (state, dir) = state("opensearch-3");
        let slot = connect(
            &state,
            json!({ "driver": "opensearch",
                    "config": { "host": "127.0.0.1", "port": 9207, "tls": true, "tls_skip_verify": true,
                                "auth": "basic", "user": "admin", "password": "TablePeek_test_pw1" } }),
        )
        .await;
        let overview = security(State(state.clone()), headers(), conn(&slot.id))
            .await
            .unwrap()
            .0;
        assert_eq!(
            overview["kinds"]["api_keys"]["available"], true,
            "{overview}"
        );
        let key = create_api_key(
            State(state.clone()),
            headers(),
            conn(&slot.id),
            Json(
                serde_json::from_value(json!({ "confirmed": true, "body": {
                    "name": "tablepeek-route", "cluster_permissions": ["cluster_monitor"],
                    "index_permissions": [], "duration_seconds": 600 } }))
                .unwrap(),
            ),
        )
        .await
        .unwrap()
        .0;
        assert!(
            key["token"]
                .as_str()
                .is_some_and(|token| token.starts_with("os_")),
            "{key}"
        );
        let id = key["id"].as_str().unwrap().to_string();
        let list = |state: AppState, slot: String| async move {
            security_list(
                State(state),
                headers(),
                Query(SecurityParams {
                    conn: Some(slot),
                    kind: SecurityKind::ApiKeys,
                }),
            )
            .await
            .unwrap()
            .0
        };
        let keys = list(state.clone(), slot.id.clone()).await;
        assert!(
            keys.as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["id"] == id.as_str() && entry["invalidated"] == false),
            "{keys}"
        );
        let _ = security_delete(
            State(state.clone()),
            headers(),
            conn(&slot.id),
            Json(
                serde_json::from_value(
                    json!({ "kind": "api_keys", "names": [id], "confirmed": true }),
                )
                .unwrap(),
            ),
        )
        .await
        .unwrap();
        let keys = list(state.clone(), slot.id.clone()).await;
        assert!(
            keys.as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["id"] == id.as_str() && entry["invalidated"] == true),
            "{keys}"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
