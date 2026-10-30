//! The REST client an Elasticsearch or OpenSearch connection talks through:
//! one `reqwest` client (its own connection pool) pointed at the cluster,
//! TLS as the settings ask (a CA, a certificate fingerprint, or none at
//! all), the credentials on every request, and the console line each
//! request leaves.

use std::fs::File;
use std::io::BufReader;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, PoisonError, Weak};
use std::time::{Duration, Instant};

use base64::Engine as _;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE, HOST};
use reqwest::Method;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::WebPkiServerVerifier;
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, RootCertStore, SignatureScheme};
use serde_json::value::RawValue;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tablepeek_types::{ErrorFields, ErrorPosition};
use tokio_util::sync::CancellationToken;

use super::console::{masked_body, masked_text};
use super::{nodes, Auth, Endpoint, Settings};
use crate::registry::NetRoute;
use crate::search::{raw, Raw};
use crate::sql_log::{Change, SqlLog};
use crate::EngineError;

/// How long opening a TCP connection may take.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// The header a request is tagged with, so a cancel finds its task.
pub(super) const OPAQUE_ID: &str = "X-Opaque-Id";

/// What a request leaves behind: nothing (a poll), a console line, or a
/// console line and, once it succeeded, a History entry.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Trace {
    Quiet,
    Console,
    Change,
}

/// A request's body.
pub(super) enum Body<'a> {
    None,
    Json(&'a Value),
    /// NDJSON lines (`_bulk`, `_msearch`), sent as they are.
    Lines(String),
    /// JSON as the user typed it, sent unparsed (the server says what is
    /// wrong with it).
    Text(&'a str),
    /// The same, owned (text the page typed and sent as a JSON string).
    Owned(String),
}

/// A reply as it came: status, content type and the bytes.
pub(super) struct Reply {
    pub status: u16,
    pub content_type: String,
    pub bytes: bytes::Bytes,
    pub elapsed_ms: f64,
}

impl Reply {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// The body as JSON; an empty or non-JSON body as its text.
    pub fn value(&self) -> Value {
        if self.bytes.is_empty() {
            return Value::Null;
        }
        serde_json::from_slice(&self.bytes)
            .unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&self.bytes).into_owned()))
    }

    /// The body as it came: JSON text untouched (numbers and all), any
    /// other body as a JSON string of its text, an empty one as null.
    pub fn into_raw(self) -> Raw {
        if self.bytes.is_empty() {
            return raw(&Value::Null);
        }
        match String::from_utf8(Vec::from(self.bytes)) {
            Ok(text) if serde_json::from_str::<&RawValue>(&text).is_ok() => {
                RawValue::from_string(text).unwrap_or_else(|_| raw(&Value::Null))
            }
            Ok(text) => raw(&text),
            Err(err) => raw(&String::from_utf8_lossy(err.as_bytes())),
        }
    }
}

/// The read the page waits on now: its tag and the token that stops
/// waiting for it.
struct Running {
    tag: String,
    stop: CancellationToken,
}

/// The page's latest request (a read, a write, a console request): its tag,
/// its console line, and whether its reply came back. A Stop asks the
/// server about the tasks it left running.
#[derive(Clone)]
pub(super) struct PageRequest {
    pub tag: String,
    pub text: String,
    pub answered: bool,
    /// A read the page waits on (`tracked`): stopping it cancels its tasks.
    pub read: bool,
}

/// How requests reach one node: its base URL and a client of its own (its
/// TLS name and the Host header differ through a tunnel).
#[derive(Clone)]
pub(super) struct Link {
    /// `scheme://host:port/prefix`, without a trailing slash.
    base: String,
    client: reqwest::Client,
}

/// Where requests go: straight to each node, through one local tunnel end
/// (to the seed only), or through the tunnel to each node.
enum Route {
    Direct,
    Via { host: String, port: u16 },
    Tunnel(nodes::LocalEnds),
}

/// Makes the link to a node: what every link shares.
struct Links {
    settings: Settings,
    headers: HeaderMap,
    https: bool,
    prefix: String,
    route: Route,
}

impl Links {
    async fn link(&self, host: &str, port: u16) -> Result<Link, EngineError> {
        let mut builder = reqwest::Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .pool_idle_timeout(Duration::from_secs(60))
            .user_agent(concat!("TablePeek/", env!("CARGO_PKG_VERSION")));
        let mut headers = self.headers.clone();
        let mut url_host = host.to_string();
        let mut url_port = port;
        // Through a tunnel the requests go to a local end, the Host header
        // still naming the node. A name stays in the URL, resolved to the
        // local end (the URL's port is the one used), so TLS sends it as
        // SNI and checks the certificate against it; an IP address can't be
        // resolved that way, so the URL names the local end and the
        // certificate is checked against the IP.
        let through = match &self.route {
            Route::Direct => None,
            Route::Via { host, port } => Some((host.clone(), *port)),
            Route::Tunnel(ends) => {
                let end = ends.end(host, port).await.map_err(|err| {
                    EngineError::Internal(format!("터널 로컬 포트를 열 수 없습니다: {err}"))
                })?;
                Some((end.ip().to_string(), end.port()))
            }
        };
        let mut tls_name: Option<ServerName<'static>> = None;
        if let Some((via_host, via_port)) = through {
            builder = builder.no_proxy();
            let authority = format!("{}:{port}", url_host_text(host));
            if let Ok(value) = HeaderValue::from_str(&authority) {
                headers.insert(HOST, value);
            }
            url_port = via_port;
            match host.parse::<IpAddr>() {
                Ok(ip) => {
                    tls_name = Some(ServerName::IpAddress(ip.into()));
                    url_host = via_host;
                }
                Err(_) => {
                    let ip: IpAddr = via_host.parse().map_err(|_| {
                        EngineError::Internal(format!("터널 주소가 IP가 아닙니다: {via_host}"))
                    })?;
                    builder = builder.resolve(host, SocketAddr::new(ip, via_port));
                }
            }
        }
        if self.https {
            builder = builder.use_preconfigured_tls(tls_config(&self.settings, tls_name)?);
        }
        let client = builder.default_headers(headers).build().map_err(|err| {
            EngineError::Internal(format!("HTTP 클라이언트를 만들 수 없습니다: {err}"))
        })?;
        let scheme = if self.https { "https" } else { "http" };
        Ok(Link {
            base: format!(
                "{scheme}://{}:{url_port}{}",
                url_host_text(&url_host),
                self.prefix
            ),
            client,
        })
    }
}

pub(super) struct Http {
    links: Links,
    nodes: Mutex<nodes::Nodes<Link>>,
    /// Whether the cluster's other nodes are looked up and failed over to.
    sniff: bool,
    /// The node name the seed answered with.
    seed_name: Mutex<Option<String>>,
    /// Itself, for the lookup a failover starts in the background.
    me: Weak<Http>,
    /// The engine's id, for its errors ("elasticsearch").
    pub engine: &'static str,
    pub log: SqlLog,
    next_tag: AtomicU64,
    running: Mutex<Option<Running>>,
    last: Mutex<Option<PageRequest>>,
}

impl Http {
    /// `sniff`: look up the cluster's other nodes (see `sniff`); through a
    /// single local tunnel end there is only the seed to reach.
    pub async fn new(
        engine: &'static str,
        settings: &Settings,
        endpoint: &Endpoint,
        auth: &Auth,
        net: &NetRoute,
        sniff: bool,
        log: SqlLog,
    ) -> Result<Arc<Self>, EngineError> {
        let mut headers = HeaderMap::new();
        if let Some(value) = auth.header()? {
            let mut value = HeaderValue::from_str(&value).map_err(|_| {
                EngineError::BadRequest("인증 정보에 쓸 수 없는 글자가 있습니다".into())
            })?;
            value.set_sensitive(true);
            headers.insert(AUTHORIZATION, value);
        }
        let route = match net {
            NetRoute::Direct => Route::Direct,
            NetRoute::Via { host, port } => Route::Via {
                host: host.clone(),
                port: *port,
            },
            NetRoute::Tunnel(forwarder) => {
                Route::Tunnel(nodes::LocalEnds::new(forwarder.clone(), endpoint.https))
            }
        };
        let sniff = sniff && !matches!(route, Route::Via { .. });
        let links = Links {
            settings: settings.clone(),
            headers,
            https: endpoint.https,
            prefix: endpoint.prefix.clone(),
            route,
        };
        let seed = links.link(&endpoint.host, endpoint.port).await?;
        let seed = nodes::Node {
            host: endpoint.host.clone(),
            port: endpoint.port,
            name: None,
            seed: true,
            link: seed,
            down_since: None,
        };
        Ok(Arc::new_cyclic(|me| Self {
            links,
            nodes: Mutex::new(nodes::Nodes::new(seed)),
            sniff,
            seed_name: Mutex::new(None),
            me: me.clone(),
            engine,
            log,
            next_tag: AtomicU64::new(1),
            running: Mutex::new(None),
            last: Mutex::new(None),
        }))
    }

    fn nodes(&self) -> std::sync::MutexGuard<'_, nodes::Nodes<Link>> {
        self.nodes.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The node name the seed answered `GET /` with.
    pub fn set_seed_name(&self, name: Option<String>) {
        *self
            .seed_name
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = name;
    }

    /// `_nodes/http`, from the node in use, without failing over (a
    /// failover is what starts a lookup).
    async fn list_nodes(&self) -> Result<Value, EngineError> {
        let (_, link) = self.nodes().pick();
        let response = link
            .client
            .get(format!(
                "{}/_nodes/http?filter_path=nodes.*.name,nodes.*.roles,nodes.*.http.publish_address",
                link.base
            ))
            .send()
            .await
            .map_err(|err| self.transport(&link.base, err))?;
        let status = response.status().as_u16();
        let bytes = response
            .bytes()
            .await
            .map_err(|err| self.transport(&link.base, err))?;
        if !(200..300).contains(&status) {
            return Err(server_error(self.engine, status, &bytes));
        }
        serde_json::from_slice(&bytes)
            .map_err(|err| EngineError::Internal(format!("노드 목록을 읽을 수 없습니다: {err}")))
    }

    /// Reads the cluster's nodes into the list a request fails over along.
    /// Without the right to list them (or sniffing off) the seed stays the
    /// only node; the reason is kept for the cluster tab.
    pub async fn sniff(&self) {
        if !self.sniff {
            return;
        }
        let reply = self.list_nodes().await;
        let listed = match reply {
            Ok(reply) => nodes::listed_nodes(&reply),
            Err(err) => {
                let mut nodes = self.nodes();
                nodes.sniffed = Some(Instant::now());
                nodes.sniff_error = Some(err.to_string());
                return;
            }
        };
        let new: Vec<(String, String, u16)> = {
            let nodes = self.nodes();
            listed
                .iter()
                .filter(|(_, host, port)| !nodes.has(host, *port))
                .cloned()
                .collect()
        };
        let mut added = Vec::with_capacity(new.len());
        for (name, host, port) in new {
            // A node whose link can't be made (its tunnel end) is left out.
            if let Ok(link) = self.links.link(&host, port).await {
                added.push(nodes::Node {
                    host,
                    port,
                    name: Some(name),
                    seed: false,
                    link,
                    down_since: None,
                });
            }
        }
        let seed_name = self
            .seed_name
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone();
        let mut nodes = self.nodes();
        nodes.merge(&listed, seed_name.as_deref(), added);
        nodes.sniffed = Some(Instant::now());
        nodes.sniff_error = None;
        nodes.stale = false;
    }

    /// Reads the node list again when it is older than `SNIFF_EVERY`.
    pub async fn sniff_if_old(&self) {
        let due = self
            .nodes()
            .sniffed
            .is_none_or(|at| at.elapsed() >= nodes::SNIFF_EVERY);
        if due {
            self.sniff().await;
        }
    }

    /// The nodes as the cluster tab shows them.
    pub fn connection(&self) -> Value {
        self.nodes().describe(self.sniff)
    }

    /// The node answering now (`host:port`) when it isn't the address the
    /// settings name (requests failed over to it).
    pub fn answering(&self) -> Option<String> {
        let nodes = self.nodes();
        let node = &nodes.list[nodes.current.min(nodes.list.len() - 1)];
        (!node.seed).then(|| node.address())
    }

    /// Node `index` couldn't be reached on the `tried`th try: moves on to
    /// the next node, noting it in the console. False when every node has
    /// had its try.
    fn fail_over(&self, index: usize, tried: usize) -> bool {
        let mut nodes = self.nodes();
        let failed = nodes.list[index.min(nodes.list.len() - 1)].address();
        let Some(next) = nodes.fail_over(index, tried) else {
            return false;
        };
        drop(nodes);
        self.log.record_command(&format!(
            "# {failed}에 연결할 수 없어 노드 {next}로 바꿉니다"
        ));
        true
    }

    /// Sends a request and answers what came back, whatever its status. A
    /// `tracked` one is the page's read: tagged so a cancel finds its task,
    /// and given up on at once when cancelled. A node that refuses the
    /// connection hands the request to the next node the cluster listed
    /// (it never reached the server, so a write is safe to send again).
    pub async fn send(
        &self,
        method: Method,
        path: &str,
        body: Body<'_>,
        trace: Trace,
        tracked: bool,
    ) -> Result<Reply, EngineError> {
        if trace != Trace::Quiet {
            self.log.record_command(&console_text(&method, path, &body));
        }
        let payload: Option<(&'static str, bytes::Bytes)> = match body {
            Body::None => None,
            Body::Json(value) => Some(("application/json", value.to_string().into())),
            Body::Lines(mut text) => {
                if !text.ends_with('\n') {
                    text.push('\n');
                }
                Some(("application/x-ndjson", text.into()))
            }
            Body::Text(text) => Some(("application/json", text.to_string().into())),
            Body::Owned(text) => Some(("application/json", text.into())),
        };
        // Every request is tagged, so the task list can tell TablePeek's own.
        let tag = format!(
            "tablepeek:{}",
            self.next_tag.fetch_add(1, Ordering::Relaxed)
        );
        if trace != Trace::Quiet {
            *self.last.lock().unwrap_or_else(PoisonError::into_inner) = Some(PageRequest {
                tag: tag.clone(),
                text: format!("{method} {path}"),
                answered: false,
                read: tracked,
            });
        }
        let tracking = tracked.then(|| {
            let stop = CancellationToken::new();
            *self.running.lock().unwrap_or_else(PoisonError::into_inner) = Some(Running {
                tag: tag.clone(),
                stop: stop.clone(),
            });
            stop
        });
        let started = Instant::now();
        let exchange = async {
            let mut tried = 0;
            loop {
                let (index, link) = self.nodes().pick();
                let mut request = link
                    .client
                    .request(method.clone(), format!("{}{path}", link.base))
                    .header(OPAQUE_ID, &tag);
                if let Some((content_type, bytes)) = &payload {
                    request = request
                        .header(CONTENT_TYPE, *content_type)
                        .body(bytes.clone());
                }
                let response = match request.send().await {
                    Ok(response) => response,
                    Err(err) if err.is_connect() => {
                        tried += 1;
                        if self.fail_over(index, tried) {
                            continue;
                        }
                        return Err(self.transport(&link.base, err));
                    }
                    Err(err) => return Err(self.transport(&link.base, err)),
                };
                if response.headers().contains_key(nodes::TUNNEL_ERROR) {
                    // The tunnel couldn't reach the node: the request never
                    // left this machine.
                    let why = response.text().await.unwrap_or_default();
                    tried += 1;
                    if self.fail_over(index, tried) {
                        continue;
                    }
                    return Err(EngineError::Driver {
                        engine: self.engine,
                        code: None,
                        message: why,
                        interrupted: false,
                        fields: Box::default(),
                    });
                }
                let stale = {
                    let mut nodes = self.nodes();
                    nodes.answered(index);
                    std::mem::take(&mut nodes.stale)
                };
                if stale {
                    // A node went away: read the list again for the next
                    // failover, beside this request.
                    if let Some(me) = self.me.upgrade() {
                        tokio::spawn(async move { me.sniff().await });
                    }
                }
                let status = response.status().as_u16();
                let content_type = response
                    .headers()
                    .get(CONTENT_TYPE)
                    .and_then(|value| value.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                let bytes = response
                    .bytes()
                    .await
                    .map_err(|err| self.transport(&link.base, err))?;
                return Ok(Reply {
                    status,
                    content_type,
                    bytes,
                    elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
                });
            }
        };
        let outcome = match tracking {
            None => exchange.await,
            // Dropping the request closes its connection, which also stops
            // a search on the server.
            Some(stop) => {
                let outcome = tokio::select! {
                    outcome = exchange => outcome,
                    () = stop.cancelled() => Err(self.interrupted()),
                };
                let mut running = self.running.lock().unwrap_or_else(PoisonError::into_inner);
                if running.as_ref().is_some_and(|run| run.tag == tag) {
                    *running = None;
                }
                outcome
            }
        };
        if trace != Trace::Quiet && !outcome.as_ref().is_err_and(EngineError::is_interrupted) {
            let mut last = self.last.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some(last) = last.as_mut().filter(|last| last.tag == tag) {
                last.answered = true;
            }
        }
        outcome
    }

    /// Sends a request and answers its JSON, a status other than 2xx as
    /// the server's error. A `Trace::Change` request that succeeded goes
    /// to History too.
    pub async fn json(
        &self,
        method: Method,
        path: &str,
        body: Body<'_>,
        trace: Trace,
        tracked: bool,
    ) -> Result<Value, EngineError> {
        let text = (trace == Trace::Change).then(|| console_text(&method, path, &body));
        let reply = self.send(method, path, body, trace, tracked).await?;
        if !reply.ok() {
            return Err(self.error(&reply));
        }
        let value = reply.value();
        if let Some(text) = text {
            self.changed(text, reply.elapsed_ms, changed_rows(&value));
        }
        Ok(value)
    }

    /// A read whose reply goes back as it came (see `Reply::into_raw`), a
    /// status other than 2xx as the server's error.
    pub async fn raw(
        &self,
        method: Method,
        path: &str,
        body: Body<'_>,
        trace: Trace,
        tracked: bool,
    ) -> Result<Raw, EngineError> {
        let reply = self.send(method, path, body, trace, tracked).await?;
        if !reply.ok() {
            return Err(self.error(&reply));
        }
        Ok(reply.into_raw())
    }

    /// A change the page made, for History.
    pub fn changed(&self, text: String, elapsed_ms: f64, rows: u64) {
        self.log.changed(
            Change {
                sql: text,
                ms: elapsed_ms.round() as u64,
                rows,
            },
            false,
        );
    }

    /// The tag of the read the page waits on now, and stops waiting for
    /// it: the reply it would get is now an interruption.
    pub fn stop_running(&self) -> Option<String> {
        let running = self.running.lock().unwrap_or_else(PoisonError::into_inner);
        running.as_ref().map(|run| {
            run.stop.cancel();
            run.tag.clone()
        })
    }

    /// The page's Stop: stops waiting for the read it waits on (as
    /// `stop_running`), and answers the page's latest request when its reply
    /// never came, so the server can be asked what it left running.
    pub fn stop(&self) -> Option<PageRequest> {
        self.stop_running();
        self.last
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
            .filter(|last| !last.answered)
    }

    pub fn interrupted(&self) -> EngineError {
        EngineError::Driver {
            engine: self.engine,
            code: Some("task_cancelled_exception".into()),
            message: "요청을 취소했습니다".into(),
            interrupted: true,
            fields: Box::default(),
        }
    }

    /// A reply whose status is an error, as the engine's error: the
    /// server's `error.type` and `reason` (the first root cause's when the
    /// search as a whole failed), its root causes as details, and where a
    /// parse error points.
    pub fn error(&self, reply: &Reply) -> EngineError {
        server_error(self.engine, reply.status, &reply.bytes)
    }

    /// A request that got no answer: refused, timed out, or its TLS failed.
    fn transport(&self, base: &str, err: reqwest::Error) -> EngineError {
        transport_error(self.engine, base, err)
    }
}

/// `host` as a URL writes it: an IPv6 address in brackets.
fn url_host_text(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_string()
    }
}

/// The console line of a request, Dev Tools style: `METHOD /path`, then
/// its body on the next line (passwords masked; NDJSON as its line count).
pub(super) fn console_text(method: &Method, path: &str, body: &Body<'_>) -> String {
    match body {
        Body::None => format!("{method} {path}"),
        Body::Json(value) => format!("{method} {path}\n{}", masked_body(value)),
        Body::Lines(text) => {
            let lines = text.lines().filter(|line| !line.trim().is_empty()).count();
            format!("{method} {path}\n# NDJSON {lines}줄")
        }
        Body::Text(text) => format!("{method} {path}\n{}", masked_text(text)),
        Body::Owned(text) => format!("{method} {path}\n{}", masked_text(text)),
    }
}

/// How many documents a write's reply says it changed.
fn changed_rows(value: &Value) -> u64 {
    let number = |key: &str| value.get(key).and_then(Value::as_u64);
    if let Some(total) = number("total") {
        // delete_by_query, update_by_query, reindex
        return number("deleted")
            .or_else(|| Some(number("updated").unwrap_or(0) + number("created").unwrap_or(0)))
            .unwrap_or(total);
    }
    1
}

/// See `Http::error`.
pub(super) fn server_error(engine: &'static str, status: u16, bytes: &[u8]) -> EngineError {
    let raw = String::from_utf8_lossy(bytes).into_owned();
    let parsed: Option<Value> = serde_json::from_slice(bytes).ok();
    let mut fields = ErrorFields {
        server_code: Some(i64::from(status)),
        raw: Some(raw.clone()),
        ..ErrorFields::default()
    };
    let error = parsed.as_ref().and_then(|body| body.get("error"));
    let (code, message) = match error {
        Some(Value::Object(error)) => {
            let root_causes = error
                .get("root_cause")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let mut kind = error
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or("error")
                .to_string();
            let mut reason = error
                .get("reason")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            // "all shards failed" says nothing; the first cause does.
            let first = root_causes.first();
            if kind == "search_phase_execution_exception" || reason.is_empty() {
                if let Some(cause) = first {
                    if let Some(cause_kind) = cause.get("type").and_then(Value::as_str) {
                        kind = cause_kind.to_string();
                    }
                    if let Some(cause_reason) = cause.get("reason").and_then(Value::as_str) {
                        reason = cause_reason.to_string();
                    }
                }
            }
            // OpenSearch's SQL plugin puts the useful part in `details`.
            if let Some(details) = error.get("details").and_then(Value::as_str) {
                if !details.is_empty() && !reason.contains(details) {
                    reason = format!("{reason}: {details}");
                }
            }
            fields.position = error_position(&Value::Object(error.clone()))
                .or_else(|| first.and_then(error_position))
                .or_else(|| text_position(&reason));
            let mut details = json!({ "status": status, "root_cause": root_causes });
            for key in ["caused_by", "failed_shards", "index", "resource.id"] {
                if let Some(value) = error.get(key) {
                    details[key] = value.clone();
                }
            }
            fields.details = Some(details);
            fields.code_name = Some(kind.clone());
            (kind, reason)
        }
        Some(Value::String(reason)) => (format!("http_{status}"), reason.clone()),
        _ => {
            let first_line = raw
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty() && !line.starts_with('<'))
                .unwrap_or("")
                .to_string();
            let message = if first_line.is_empty() {
                format!("HTTP {status}")
            } else {
                format!("HTTP {status}: {first_line}")
            };
            (format!("http_{status}"), message)
        }
    };
    let interrupted = code == "task_cancelled_exception";
    EngineError::Driver {
        engine,
        code: Some(code),
        message: if message.is_empty() {
            format!("HTTP {status}")
        } else {
            message
        },
        interrupted,
        fields: Box::new(fields),
    }
}

/// `line` and `col` of a parsing error.
fn error_position(error: &Value) -> Option<ErrorPosition> {
    let line = error.get("line").and_then(Value::as_u64)?;
    let column = error.get("col").and_then(Value::as_u64);
    Some(ErrorPosition {
        offset: None,
        line: u32::try_from(line).ok(),
        column: column.and_then(|column| u32::try_from(column).ok()),
    })
}

/// A position a reason writes in its text: `[1:15]` (JSON parsing) or
/// `line 1:15:` (SQL).
fn text_position(reason: &str) -> Option<ErrorPosition> {
    let numbers = |text: &str| -> Option<(u32, u32)> {
        let (line, rest) = text.split_once(':')?;
        let column: String = rest.chars().take_while(char::is_ascii_digit).collect();
        Some((line.trim().parse().ok()?, column.parse().ok()?))
    };
    let found = if let Some(start) = reason.find("line ") {
        numbers(&reason[start + 5..])
    } else if let Some(rest) = reason.strip_prefix('[') {
        numbers(rest)
    } else {
        None
    }?;
    Some(ErrorPosition {
        offset: None,
        line: Some(found.0),
        column: Some(found.1),
    })
}

/// See `Http::transport`.
pub(super) fn transport_error(
    engine: &'static str,
    base: &str,
    err: reqwest::Error,
) -> EngineError {
    let mut causes: Vec<String> = Vec::new();
    let mut current: Option<&(dyn std::error::Error + 'static)> = Some(&err);
    while let Some(cause) = current {
        let text = cause.to_string();
        if !text.is_empty() && !causes.iter().any(|known| known.contains(&text)) {
            causes.push(text);
        }
        current = cause.source();
    }
    let raw = causes.join(": ");
    let lower = raw.to_lowercase();
    let address = base.split("://").nth(1).unwrap_or(base);
    let message = if lower.contains("certificate")
        || lower.contains("invalidcontenttype")
        || lower.contains("corrupt message")
        || lower.contains("handshake")
        || lower.contains("tls")
    {
        let why = causes.last().cloned().unwrap_or_default();
        let hint = if lower.contains("corrupt message") || lower.contains("invalidcontenttype") {
            " (서버가 TLS를 쓰지 않는 것 같습니다: TLS를 끄세요)"
        } else {
            ""
        };
        format!("TLS 연결 실패: {why}{hint}")
    } else if err.is_timeout() {
        format!("{address}에서 응답이 없습니다 (시간 초과)")
    } else if err.is_connect() {
        let why = causes.last().cloned().unwrap_or_default();
        format!("{address}에 연결할 수 없습니다: {why}")
    } else if lower.contains("connection closed before message completed")
        || lower.contains("connection reset")
    {
        format!(
            "{address}가 연결을 끊었습니다 (서버가 HTTPS만 받는다면 TLS를 켜세요): {}",
            causes.last().cloned().unwrap_or_default()
        )
    } else {
        causes.last().cloned().unwrap_or_else(|| err.to_string())
    };
    EngineError::Driver {
        engine,
        code: None,
        message,
        interrupted: false,
        fields: Box::new(ErrorFields {
            raw: Some(raw),
            ..ErrorFields::default()
        }),
    }
}

impl Auth {
    /// The Authorization header, if the method sends one.
    fn header(&self) -> Result<Option<String>, EngineError> {
        let base64 = base64::engine::general_purpose::STANDARD;
        Ok(match self {
            Auth::None => None,
            Auth::Basic { user, password } => Some(format!(
                "Basic {}",
                base64.encode(format!("{user}:{password}"))
            )),
            // An encoded key as Kibana shows it, or its id and secret.
            Auth::ApiKey(key) => Some(if key.contains(':') {
                format!("ApiKey {}", base64.encode(key))
            } else {
                format!("ApiKey {key}")
            }),
            Auth::Bearer(token) => Some(format!("Bearer {token}")),
        })
    }
}

/// The TLS settings: the server's certificate checked against the given
/// CA (or the system's roots), against a fingerprint, or not at all; the
/// client certificate, when there is one. `name`: the name to check the
/// certificate against instead of the one connected to (an IP address
/// reached through a tunnel).
fn tls_config(
    settings: &Settings,
    name: Option<ServerName<'static>>,
) -> Result<rustls::ClientConfig, EngineError> {
    crate::ensure_crypto_provider();
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let bad = |message: String| EngineError::BadRequest(message);
    let verifier: Arc<dyn ServerCertVerifier> = if settings.tls_skip_verify {
        Arc::new(Unchecked(provider.clone()))
    } else if let Some(fingerprint) = super::given(&settings.tls_fingerprint) {
        Arc::new(Fingerprint {
            expected: parse_fingerprint(fingerprint).map_err(|problem| bad(problem.message))?,
            provider: provider.clone(),
        })
    } else {
        let mut roots = RootCertStore::empty();
        match super::given(&settings.tls_ca_file) {
            Some(path) => {
                for cert in read_certs(path, "CA 인증서")? {
                    roots
                        .add(cert)
                        .map_err(|err| bad(format!("TLS CA 인증서 오류: {err}")))?;
                }
            }
            None => {
                let native = rustls_native_certs::load_native_certs();
                if native.certs.is_empty() {
                    return Err(bad(
                        "시스템 루트 인증서를 불러오지 못했습니다. CA 인증서 경로를 지정하세요"
                            .into(),
                    ));
                }
                for cert in native.certs {
                    let _ = roots.add(cert);
                }
            }
        }
        WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider.clone())
            .build()
            .map_err(|err| bad(format!("TLS 설정 오류: {err}")))?
    };
    let verifier: Arc<dyn ServerCertVerifier> = match name {
        Some(name) => Arc::new(Renamed {
            inner: verifier,
            name,
        }),
        None => verifier,
    };
    let builder = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|err| bad(format!("TLS 설정 오류: {err}")))?
        .dangerous()
        .with_custom_certificate_verifier(verifier);
    match (
        super::given(&settings.tls_client_cert),
        super::given(&settings.tls_client_key),
    ) {
        (Some(cert_path), Some(key_path)) => {
            let chain = read_certs(cert_path, "클라이언트 인증서")?;
            let mut reader = BufReader::new(File::open(key_path).map_err(|err| {
                bad(format!(
                    "TLS 클라이언트 키를 열 수 없습니다({key_path}): {err}"
                ))
            })?);
            let key = rustls_pemfile::private_key(&mut reader)
                .map_err(|err| bad(format!("TLS 클라이언트 키 형식 오류: {err}")))?
                .ok_or_else(|| {
                    bad(format!(
                        "TLS 클라이언트 키에 private key가 없습니다: {key_path}"
                    ))
                })?;
            builder
                .with_client_auth_cert(chain, key)
                .map_err(|err| bad(format!("TLS 클라이언트 인증서 오류: {err}")))
        }
        (None, None) => Ok(builder.with_no_client_auth()),
        _ => Err(bad(
            "TLS 클라이언트 인증서와 키는 함께 지정해야 합니다".into()
        )),
    }
}

/// The certificates of a PEM file; `what` names it in messages.
fn read_certs(path: &str, what: &str) -> Result<Vec<CertificateDer<'static>>, EngineError> {
    let file = File::open(path).map_err(|err| {
        EngineError::BadRequest(format!("TLS {what}를 열 수 없습니다({path}): {err}"))
    })?;
    let certs = rustls_pemfile::certs(&mut BufReader::new(file))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|err| EngineError::BadRequest(format!("TLS {what} 형식 오류: {err}")))?;
    if certs.is_empty() {
        return Err(EngineError::BadRequest(format!(
            "TLS {what}에 인증서가 없습니다: {path}"
        )));
    }
    Ok(certs)
}

/// A SHA-256 fingerprint as people copy it: hex, with or without colons.
pub(super) fn parse_fingerprint(text: &str) -> Result<[u8; 32], crate::registry::ConfigProblem> {
    let hex: String = text
        .chars()
        .filter(|ch| !matches!(ch, ':' | ' ' | '-'))
        .collect();
    let problem = || {
        crate::registry::ConfigProblem::invalid("인증서 지문은 SHA-256 16진수 64자리여야 합니다")
    };
    if hex.len() != 64 {
        return Err(problem());
    }
    let mut out = [0u8; 32];
    for (index, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).map_err(|_| problem())?;
    }
    Ok(out)
}

fn verify12(
    provider: &CryptoProvider,
    message: &[u8],
    cert: &CertificateDer<'_>,
    dss: &DigitallySignedStruct,
) -> Result<HandshakeSignatureValid, rustls::Error> {
    rustls::crypto::verify_tls12_signature(
        message,
        cert,
        dss,
        &provider.signature_verification_algorithms,
    )
}

fn verify13(
    provider: &CryptoProvider,
    message: &[u8],
    cert: &CertificateDer<'_>,
    dss: &DigitallySignedStruct,
) -> Result<HandshakeSignatureValid, rustls::Error> {
    rustls::crypto::verify_tls13_signature(
        message,
        cert,
        dss,
        &provider.signature_verification_algorithms,
    )
}

/// Trusts a server whose chain holds a certificate with this SHA-256
/// fingerprint (the cluster's CA, as Elasticsearch prints it on first
/// start, or its own certificate), whatever its name.
#[derive(Debug)]
struct Fingerprint {
    expected: [u8; 32],
    provider: Arc<CryptoProvider>,
}

impl ServerCertVerifier for Fingerprint {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let matches = std::iter::once(end_entity)
            .chain(intermediates)
            .any(|cert| Sha256::digest(cert.as_ref()).as_slice() == self.expected);
        if matches {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(
                "서버 인증서의 지문이 설정한 지문과 다릅니다".into(),
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify12(&self.provider, message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify13(&self.provider, message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// Takes any certificate (the settings' "don't check"); the handshake's
/// signatures are still checked.
#[derive(Debug)]
struct Unchecked(Arc<CryptoProvider>);

impl ServerCertVerifier for Unchecked {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify12(&self.0, message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify13(&self.0, message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// Checks the certificate against `name` rather than the address the
/// connection went to.
#[derive(Debug)]
struct Renamed {
    inner: Arc<dyn ServerCertVerifier>,
    name: ServerName<'static>,
}

impl ServerCertVerifier for Renamed {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        self.inner
            .verify_server_cert(end_entity, intermediates, &self.name, ocsp_response, now)
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_errors_keep_type_reason_causes_and_position() {
        let body = br#"{"error":{"root_cause":[{"type":"parsing_exception","reason":"unknown query [mach]","line":1,"col":12}],"type":"parsing_exception","reason":"unknown query [mach]","line":1,"col":12},"status":400}"#;
        let EngineError::Driver {
            code,
            message,
            fields,
            interrupted,
            ..
        } = server_error("elasticsearch", 400, body)
        else {
            panic!("driver error");
        };
        assert_eq!(code.as_deref(), Some("parsing_exception"));
        assert_eq!(message, "unknown query [mach]");
        assert!(!interrupted);
        assert_eq!(fields.server_code, Some(400));
        let position = fields.position.unwrap();
        assert_eq!((position.line, position.column), (Some(1), Some(12)));
        assert_eq!(
            fields.details.unwrap()["root_cause"][0]["type"],
            "parsing_exception"
        );

        // A failed search says why through its first root cause.
        let body = br#"{"error":{"root_cause":[{"type":"query_shard_exception","reason":"failed to create query: For input string: \"x\"","index":"shop"}],"type":"search_phase_execution_exception","reason":"all shards failed","phase":"query"},"status":400}"#;
        let EngineError::Driver { code, message, .. } = server_error("opensearch", 400, body)
        else {
            panic!("driver error");
        };
        assert_eq!(code.as_deref(), Some("query_shard_exception"));
        assert!(message.starts_with("failed to create query"));

        // SQL's position is in its text.
        let body = br#"{"error":{"root_cause":[{"type":"verification_exception","reason":"Found 1 problem\nline 1:15: Unknown index [nope]"}],"type":"verification_exception","reason":"Found 1 problem\nline 1:15: Unknown index [nope]"},"status":400}"#;
        let EngineError::Driver { fields, .. } = server_error("elasticsearch", 400, body) else {
            panic!("driver error");
        };
        let position = fields.position.unwrap();
        assert_eq!((position.line, position.column), (Some(1), Some(15)));

        // Not JSON (a proxy's page): the status and the first line of text.
        let EngineError::Driver { code, message, .. } =
            server_error("elasticsearch", 502, b"<html>\nBad Gateway\n</html>")
        else {
            panic!("driver error");
        };
        assert_eq!(code.as_deref(), Some("http_502"));
        assert_eq!(message, "HTTP 502: Bad Gateway");

        // A cancelled task reads as an interruption.
        let body =
            br#"{"error":{"type":"task_cancelled_exception","reason":"cancelled"},"status":400}"#;
        assert!(server_error("elasticsearch", 400, body).is_interrupted());
    }

    #[test]
    fn fingerprints_read_with_or_without_colons() {
        let plain = "a".repeat(64);
        assert_eq!(parse_fingerprint(&plain).unwrap(), [0xaa; 32]);
        let colons = vec!["AA"; 32].join(":");
        assert_eq!(parse_fingerprint(&colons).unwrap(), [0xaa; 32]);
        assert!(parse_fingerprint("abc").is_err());
        assert!(parse_fingerprint(&"g".repeat(64)).is_err());
    }

    #[test]
    fn api_keys_are_encoded_when_given_as_id_and_secret() {
        assert_eq!(
            Auth::ApiKey("id:secret".into()).header().unwrap().unwrap(),
            "ApiKey aWQ6c2VjcmV0"
        );
        assert_eq!(
            Auth::ApiKey("aWQ6c2VjcmV0".into())
                .header()
                .unwrap()
                .unwrap(),
            "ApiKey aWQ6c2VjcmV0"
        );
        assert_eq!(
            Auth::Basic {
                user: "elastic".into(),
                password: "pw".into()
            }
            .header()
            .unwrap()
            .unwrap(),
            "Basic ZWxhc3RpYzpwdw=="
        );
    }
}
