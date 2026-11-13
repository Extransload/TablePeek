//! Key-value stores (`/api/kv/*`, docs/engines/redis.md §4): Redis and
//! Valkey. Only changes and console commands reach the console log and
//! History; the browser's reads (scans, pages, key facts, the overview
//! polled every few seconds) don't. Every route runs beside whatever holds
//! the connection: the engine multiplexes its commands, and the console has
//! a connection of its own, so a long command there (BLPOP) holds nothing
//! else up. A
//! dangerous console command (FLUSHALL, CONFIG SET, …) goes only once
//! confirmed; `/api/kv/stop` stops the console command running.

use std::sync::Arc;

use axum::body::{Body, Bytes};
use axum::extract::{Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::post;
use axum::Router;
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use tablepeek_engine::keyvalue::{
    CommandClass, ConsoleReply, ConsoleRequest, EditRequest, ExportRequest, KeyRef,
    KeysMetaRequest, ReadRequest, ScanRequest,
};
use tablepeek_engine::EngineError;
use tablepeek_types::ApiError;

use super::{
    attachment, authorized, engine_error, slot_for, unauthorized, AppState, ConnQuery, ConnSlot,
    InflightGuard,
};

type ApiResult<T> = Result<T, (StatusCode, Json<ApiError>)>;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/api/kv/databases", post(databases))
        .route("/api/kv/overview", post(overview))
        .route("/api/kv/scan", post(scan))
        .route("/api/kv/keys/meta", post(keys_meta))
        .route("/api/kv/key", post(key_info))
        .route("/api/kv/read", post(read))
        .route("/api/kv/edit", post(edit))
        .route("/api/kv/classify", post(classify))
        .route("/api/kv/console", post(console))
        .route("/api/kv/stop", post(stop))
        .route("/api/kv/info", post(info))
        .route("/api/kv/slowlog", post(slowlog))
        .route("/api/kv/slowlog/reset", post(slowlog_reset))
        .route("/api/kv/export", post(export))
}

/// Runs `$body` with the slot's key-value operations as `$ops`.
macro_rules! kv_call {
    ($slot:expr, |$ops:ident| $body:expr) => {{
        let slot = &$slot;
        let _inflight = InflightGuard::new(slot.inflight.clone());
        async {
            let session = slot.engine.keyvalue()?;
            let $ops = session.ops();
            $body.await
        }
        .await
        .map_err(engine_error)
    }};
}

async fn kv_slot(
    state: &AppState,
    headers: &HeaderMap,
    conn: Option<&str>,
) -> ApiResult<Arc<ConnSlot>> {
    if !authorized(state, headers, None) {
        return Err(unauthorized());
    }
    slot_for(state, conn).await
}

async fn databases(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
) -> ApiResult<Json<Value>> {
    let slot = kv_slot(&state, &headers, params.conn.as_deref()).await?;
    kv_call!(slot, |ops| ops.databases()).map(|listed| Json(json!(listed)))
}

/// The header's numbers, polled every few seconds; not logged.
async fn overview(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
) -> ApiResult<Json<Value>> {
    let slot = kv_slot(&state, &headers, params.conn.as_deref()).await?;
    kv_call!(slot, |ops| ops.overview()).map(|overview| Json(json!(overview)))
}

async fn keys_meta(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<KeysMetaRequest>,
) -> ApiResult<Json<Value>> {
    let slot = kv_slot(&state, &headers, params.conn.as_deref()).await?;
    kv_call!(slot, |ops| ops.keys_meta(&req)).map(|meta| Json(json!(meta)))
}

async fn scan(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<ScanRequest>,
) -> ApiResult<Json<Value>> {
    let slot = kv_slot(&state, &headers, params.conn.as_deref()).await?;
    kv_call!(slot, |ops| ops.scan(&req)).map(|page| Json(json!(page)))
}

async fn key_info(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<KeyRef>,
) -> ApiResult<Json<Value>> {
    let slot = kv_slot(&state, &headers, params.conn.as_deref()).await?;
    kv_call!(slot, |ops| ops.key_info(&req)).map(|info| Json(json!(info)))
}

async fn read(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<ReadRequest>,
) -> ApiResult<Json<Value>> {
    let slot = kv_slot(&state, &headers, params.conn.as_deref()).await?;
    kv_call!(slot, |ops| ops.read(&req)).map(|page| Json(json!(page)))
}

async fn edit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<EditRequest>,
) -> ApiResult<Json<Value>> {
    let slot = kv_slot(&state, &headers, params.conn.as_deref()).await?;
    kv_call!(slot, |ops| ops.edit(&req)).map(|outcome| Json(json!(outcome)))
}

#[derive(Deserialize)]
struct ClassifyRequest {
    #[serde(default)]
    db: u32,
    line: String,
}

async fn classify(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<ClassifyRequest>,
) -> ApiResult<Json<Value>> {
    let slot = kv_slot(&state, &headers, params.conn.as_deref()).await?;
    kv_call!(slot, |ops| ops.classify(&req.line, req.db)).map(|class| Json(json!(class)))
}

async fn console(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<ConsoleRequest>,
) -> ApiResult<Json<ConsoleReply>> {
    let slot = kv_slot(&state, &headers, params.conn.as_deref()).await?;
    let classified = kv_call!(slot, |ops| ops.classify(&req.line, req.db))?;
    if classified.class == CommandClass::Danger && !req.confirmed {
        return Err(engine_error(EngineError::BadRequest(format!(
            "위험한 명령({})은 확인이 필요합니다 (confirmed: true)",
            classified.command
        ))));
    }
    kv_call!(slot, |ops| ops.console(&req)).map(Json)
}

async fn stop(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
) -> ApiResult<Json<Value>> {
    let slot = kv_slot(&state, &headers, params.conn.as_deref()).await?;
    let session = slot.engine.keyvalue().map_err(engine_error)?;
    session.ops().stop_console();
    Ok(Json(json!({})))
}

#[derive(Deserialize, Default)]
struct InfoRequest {
    #[serde(default)]
    section: Option<String>,
}

async fn info(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    body: Option<Json<InfoRequest>>,
) -> ApiResult<Json<Value>> {
    let slot = kv_slot(&state, &headers, params.conn.as_deref()).await?;
    let req = body.map(|Json(req)| req).unwrap_or_default();
    kv_call!(slot, |ops| ops.info(req.section.as_deref()))
        .map(|sections| Json(json!({ "sections": sections })))
}

#[derive(Deserialize, Default)]
struct SlowlogRequest {
    #[serde(default)]
    count: Option<u32>,
}

async fn slowlog(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    body: Option<Json<SlowlogRequest>>,
) -> ApiResult<Json<Value>> {
    let slot = kv_slot(&state, &headers, params.conn.as_deref()).await?;
    let count = body.and_then(|Json(req)| req.count).unwrap_or(128);
    kv_call!(slot, |ops| ops.slowlog(count)).map(|entries| Json(json!({ "entries": entries })))
}

async fn slowlog_reset(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
) -> ApiResult<Json<Value>> {
    let slot = kv_slot(&state, &headers, params.conn.as_deref()).await?;
    kv_call!(slot, |ops| ops.slowlog_reset()).map(|()| Json(json!({})))
}

/// A key's whole value as a file. A failure midway cuts the response off,
/// so a part is never taken for the whole.
async fn export(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(params): Query<ConnQuery>,
    Json(req): Json<ExportRequest>,
) -> ApiResult<Response> {
    let slot = kv_slot(&state, &headers, params.conn.as_deref()).await?;
    let stream = kv_call!(slot, |ops| ops.export(&req))?;
    let bytes = stream.map(|chunk| {
        chunk
            .map(Bytes::from)
            .map_err(|err| std::io::Error::other(err.to_string()))
    });
    let mut response = Body::from_stream(bytes).into_response();
    let reply = response.headers_mut();
    let json = req.format == "json";
    reply.insert(
        header::CONTENT_TYPE,
        header::HeaderValue::from_static(if json {
            "application/json"
        } else {
            "application/octet-stream"
        }),
    );
    let name = format!(
        "{}.{}",
        file_stem(&req.key.lossy()),
        if json { "json" } else { "txt" }
    );
    if let Ok(disposition) = header::HeaderValue::from_str(&attachment(&name)) {
        reply.insert(header::CONTENT_DISPOSITION, disposition);
    }
    Ok(response)
}

/// A key as a file name: characters file systems refuse become `_`.
fn file_stem(key: &str) -> String {
    let stem: String = key
        .chars()
        .map(|ch| {
            if ch.is_control() || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            {
                '_'
            } else {
                ch
            }
        })
        .take(120)
        .collect();
    if stem.trim().is_empty() {
        "key".into()
    } else {
        stem
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{connect_with, store, Registry, SlotOrigin};
    use axum::body::to_bytes;
    use tablepeek_engine::Engine;
    use tablepeek_types::ConnectRequest;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    #[test]
    fn key_names_become_safe_file_names() {
        assert_eq!(file_stem("user:1:profile"), "user_1_profile");
        assert_eq!(file_stem(""), "key");
        assert_eq!(file_stem("a/b\\c"), "a_b_c");
    }

    fn state(name: &str) -> (AppState, std::path::PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("tablepeek-kv-test-{}-{name}", std::process::id()));
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
            ui_writers: Arc::default(),
            window_material: None,
            ai: Arc::new(crate::ai::AiSettings::load(&dir)),
        };
        (state, dir)
    }

    fn call<T: serde::de::DeserializeOwned>(value: Value) -> Json<T> {
        Json(serde_json::from_value(value).unwrap())
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

    async fn connect(state: &AppState, request: Value) -> Result<Arc<ConnSlot>, String> {
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
        .map(|(slot, _)| slot)
        .map_err(|err| err.message)
    }

    /// An HTTP CONNECT proxy on a free local port, as an HTTP tunnel goes
    /// through one.
    async fn connect_proxy() -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((client, _)) = listener.accept().await {
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
                    let (host, port) = target.rsplit_once(':').unwrap();
                    let host = if host == "redis.tablepeek.test" {
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
        port
    }

    #[tokio::test]
    async fn kv_routes_refuse_other_engines() {
        let (state, dir) = state("refuse");
        let refused = databases(State(state.clone()), headers(), conn("main"))
            .await
            .unwrap_err();
        assert_eq!(refused.0, StatusCode::BAD_REQUEST);
        assert_eq!(refused.1 .0.code, "unsupported_capability");
        let stranger = databases(State(state), HeaderMap::new(), conn("main"))
            .await
            .unwrap_err();
        assert_eq!(stranger.0, StatusCode::UNAUTHORIZED);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The routes the workbench calls, against `make test-db` (Redis 8 on
    /// 16379): reads, an edit, the console's confirmation rule, the
    /// database switch, CLIENT KILL through the sessions route, an export.
    #[tokio::test]
    async fn kv_routes_against_redis() {
        if std::env::var("TABLEPEEK_TEST_REDIS").is_err() {
            return;
        }
        let (state, dir) = state("redis");
        let slot = connect(
            &state,
            json!({ "driver": "redis",
                    "config": { "host": "127.0.0.1", "port": 16379, "auth": "password",
                                "password": "tablepeek_test_pw" } }),
        )
        .await
        .unwrap();
        let id = slot.id.clone();

        let Json(listed) = databases(State(state.clone()), headers(), conn(&id))
            .await
            .unwrap();
        assert_eq!(listed["current"], json!(0));
        assert_eq!(listed["databases"][1]["keys"], json!(3));
        let Json(head) = overview(State(state.clone()), headers(), conn(&id))
            .await
            .unwrap();
        assert_eq!(head["flavor"], json!("redis"));
        assert_eq!(head["databases"][1]["keys"], json!(3));
        assert!(head["keys_total"].as_u64().unwrap() > 400);
        let Json(meta) = keys_meta(
            State(state.clone()),
            headers(),
            conn(&id),
            call(json!({ "db": 0, "keys": ["greeting", { "b64": "AAH//lRhYmxlUGVla4AK" }, "bin:blob"] })),
        )
        .await
        .unwrap();
        assert_eq!(meta.as_array().unwrap().len(), 3);
        assert!(meta[0]["ttl_ms"].as_i64().unwrap() > 0);
        assert_eq!(meta[1]["ttl_ms"], json!(-2));
        assert_eq!(meta[2]["key"], json!("bin:blob"));
        assert!(meta[2]["memory"].as_u64().unwrap() > 0);
        let too_many = keys_meta(
            State(state.clone()),
            headers(),
            conn(&id),
            call(json!({ "db": 0, "keys": vec!["k"; 501] })),
        )
        .await
        .unwrap_err();
        assert_eq!(too_many.0, StatusCode::BAD_REQUEST);
        let Json(page) = scan(
            State(state.clone()),
            headers(),
            conn(&id),
            call(json!({ "db": 0, "cursor": "0", "pattern": "user:*", "count": 100 })),
        )
        .await
        .unwrap();
        assert!(page["keys"]
            .as_array()
            .unwrap()
            .iter()
            .all(|key| key["type"] == "hash"));
        let Json(blob) = read(
            State(state.clone()),
            headers(),
            conn(&id),
            call(json!({ "db": 0, "key": "bin:blob" })),
        )
        .await
        .unwrap();
        assert_eq!(blob["type"], json!("string"));
        assert_eq!(blob["value"], json!({ "b64": "AAH//lRhYmxlUGVla4AK" }));
        let Json(facts) = key_info(
            State(state.clone()),
            headers(),
            conn(&id),
            call(json!({ "db": 0, "key": { "b64": "AAH//lRhYmxlUGVla4AK" } })),
        )
        .await
        .unwrap();
        assert_eq!(facts["exists"], json!(false));
        let missing = read(
            State(state.clone()),
            headers(),
            conn(&id),
            call(json!({ "db": 0, "key": "no:such:key" })),
        )
        .await
        .unwrap_err();
        assert_eq!(missing.0, StatusCode::NOT_FOUND);

        let _ = edit(
            State(state.clone()),
            headers(),
            conn(&id),
            call(json!({ "db": 0, "key": "tp:route:h", "op": "delete" })),
        )
        .await
        .unwrap();
        let _ = edit(
            State(state.clone()),
            headers(),
            conn(&id),
            call(
                json!({ "db": 0, "key": "tp:route:h", "op": "create", "kind": "hash",
                         "field": "a", "value": "1", "ttl_secs": 60 }),
            ),
        )
        .await
        .unwrap();
        let wrong = edit(
            State(state.clone()),
            headers(),
            conn(&id),
            call(json!({ "db": 0, "key": "tp:route:h", "op": "set_string", "value": "x" })),
        )
        .await
        .unwrap_err();
        assert_eq!(wrong.1 .0.code, "bad_request");

        let console_call = |line: &str, confirmed: bool| -> Json<ConsoleRequest> {
            call(json!({ "db": 0, "line": line, "confirmed": confirmed }))
        };
        let Json(reply) = console(
            State(state.clone()),
            headers(),
            conn(&id),
            console_call("HGET tp:route:h a", false),
        )
        .await
        .unwrap();
        assert_eq!(
            reply.reply,
            tablepeek_engine::keyvalue::Reply::Bulk("1".into())
        );
        let unconfirmed = console(
            State(state.clone()),
            headers(),
            conn(&id),
            console_call("CONFIG SET slowlog-max-len 128", false),
        )
        .await
        .unwrap_err();
        assert_eq!(unconfirmed.0, StatusCode::BAD_REQUEST);
        let _ = console(
            State(state.clone()),
            headers(),
            conn(&id),
            console_call("CONFIG SET slowlog-max-len 128", true),
        )
        .await
        .unwrap();
        let refused = classify(
            State(state.clone()),
            headers(),
            conn(&id),
            call(json!({ "line": "MONITOR" })),
        )
        .await
        .unwrap_err();
        assert_eq!(refused.1 .0.code, "bad_request");
        let Json(sections) = info(
            State(state.clone()),
            headers(),
            conn(&id),
            Some(call(json!({ "section": "keyspace" }))),
        )
        .await
        .unwrap();
        assert_eq!(sections["sections"][0]["name"], json!("Keyspace"));
        let _ = slowlog(State(state.clone()), headers(), conn(&id), None)
            .await
            .unwrap();

        let response = export(
            State(state.clone()),
            headers(),
            conn(&id),
            call(json!({ "db": 0, "key": "tp:route:h", "format": "json" })),
        )
        .await
        .unwrap();
        assert!(response.headers()[header::CONTENT_DISPOSITION]
            .to_str()
            .unwrap()
            .contains("tp_route_h.json"));
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        let exported: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(exported["value"], json!({ "a": "1" }));
        assert!(exported["ttl_ms"].as_i64().unwrap() > 0);

        // The sessions route ends a client by its CLIENT ID.
        let Json(reply) = console(
            State(state.clone()),
            headers(),
            conn(&id),
            console_call("CLIENT ID", false),
        )
        .await
        .unwrap();
        let tablepeek_engine::keyvalue::Reply::Int(client) = reply.reply else {
            panic!("CLIENT ID");
        };
        let _ = crate::kill_route(
            State(state.clone()),
            headers(),
            conn(&id),
            Json(crate::KillRequest {
                session_id: client.to_string(),
            }),
        )
        .await
        .unwrap();

        // The app's database switch reconnects to another database.
        let Json(switched) = crate::switch_db_route(
            State(state.clone()),
            headers(),
            conn(&id),
            Json(crate::SwitchDbRequest {
                database: "1".into(),
            }),
        )
        .await
        .unwrap();
        assert!(switched["meta"]["path"].as_str().unwrap().ends_with("/1"));
        let Json(listed) = databases(State(state.clone()), headers(), conn(&id))
            .await
            .unwrap();
        assert_eq!(
            (listed["current"].clone(), listed["size"].clone()),
            (json!(1), json!(3))
        );
        let _ = edit(
            State(state.clone()),
            headers(),
            conn(&id),
            call(json!({ "db": 0, "key": "tp:route:h", "op": "delete" })),
        )
        .await
        .unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// Redis over TLS (`make test-db ENGINE=redis-tls`) through an HTTP
    /// tunnel: the certificate is checked against the name the settings
    /// give, not the tunnel's local end.
    #[tokio::test]
    async fn kv_tls_through_an_http_tunnel() {
        if std::env::var("TABLEPEEK_TEST_REDIS_TLS").is_err() {
            return;
        }
        let (state, dir) = state("redis-tls");
        let proxy = connect_proxy().await;
        let cert = |name: &str| format!("{}/../../testdb/x509/{name}", env!("CARGO_MANIFEST_DIR"));
        for (host, works) in [("127.0.0.1", true), ("redis.tablepeek.test", false)] {
            let outcome = connect(
                &state,
                json!({ "driver": "redis",
                        "config": { "host": host, "port": 16380, "auth": "password",
                                    "password": "tablepeek_test_pw", "tls": true,
                                    "tls_ca_file": cert("ca.pem"),
                                    "tls_client_cert": cert("client.pem"),
                                    "tls_client_key": cert("client.pem") },
                        "http_tunnel": { "host": "127.0.0.1", "port": proxy } }),
            )
            .await;
            match outcome {
                Ok(slot) => {
                    assert!(works, "{host} connected");
                    let Json(listed) = databases(State(state.clone()), headers(), conn(&slot.id))
                        .await
                        .unwrap();
                    assert!(listed["size"].as_u64().unwrap() > 400);
                }
                Err(message) => {
                    assert!(!works, "{host}: {message}");
                    assert!(message.contains("TLS"), "{message}");
                }
            }
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
