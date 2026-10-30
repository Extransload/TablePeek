//! Elasticsearch and OpenSearch, through their REST API. One driver serves
//! both engines: which server it talks to is read from the root endpoint
//! once connected (`flavor`), and the few paths that differ (SQL, points in
//! time) follow it. Every request the page makes is written to the console
//! as Kibana's Dev Tools would show it (docs/engines/elasticsearch.md).

mod console;
mod http;
#[cfg(test)]
mod live;
mod nodes;
mod ops;
mod security;

use std::sync::{Arc, LazyLock};
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine as _;
use reqwest::Method;
use serde::Deserialize;
use serde_json::Value;
use tablepeek_types::{Capabilities, ConnConfig, EngineMeta, ServerInfo, ServerSession};

use crate::driver::{CancelRequest, Driver};
use crate::registry::{
    check_host, parse_descriptor, percent_decode, typed_config, ConfigProblem, DriverFactory,
    EngineDescriptor, NetRoute, TunnelTarget,
};
use crate::search::SearchDriver;
use crate::sql_log::SqlLog;
use crate::EngineError;
use http::{Body, Http, Trace};

pub struct Factory {
    descriptor: &'static LazyLock<EngineDescriptor>,
}

pub static FACTORY: Factory = Factory {
    descriptor: &ELASTICSEARCH,
};

pub static OPENSEARCH: Factory = Factory {
    descriptor: &OPENSEARCH_DESCRIPTOR,
};

static ELASTICSEARCH: LazyLock<EngineDescriptor> =
    LazyLock::new(|| parse_descriptor(include_str!("descriptor.json")));

static OPENSEARCH_DESCRIPTOR: LazyLock<EngineDescriptor> =
    LazyLock::new(|| parse_descriptor(include_str!("opensearch.json")));

const DEFAULT_PORT: u16 = 9200;

/// The connect form's values. Blank text counts as not given.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub(super) struct Settings {
    url: Option<String>,
    cloud_id: Option<String>,
    host: Option<String>,
    port: Option<u16>,
    tls: bool,
    path_prefix: Option<String>,
    auth: Option<String>,
    user: Option<String>,
    password: Option<String>,
    tls_ca_file: Option<String>,
    tls_fingerprint: Option<String>,
    tls_client_cert: Option<String>,
    tls_client_key: Option<String>,
    tls_skip_verify: bool,
    /// Look up the cluster's other nodes to fail over to; on unless off.
    sniff: Option<bool>,
}

fn given(value: &Option<String>) -> Option<&str> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

/// Where the cluster is: scheme, host, port and the path it sits under.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct Endpoint {
    https: bool,
    host: String,
    port: u16,
    /// `/es`, or empty.
    prefix: String,
    /// The user and password a URL carries.
    user: Option<String>,
    password: Option<String>,
}

/// A path prefix as requests append to it: one leading `/`, none trailing.
fn prefix(text: &str) -> String {
    let trimmed = text.trim().trim_matches('/');
    if trimmed.is_empty() {
        String::new()
    } else {
        format!("/{trimmed}")
    }
}

/// The cluster an Elastic Cloud ID names (`name:base64(domain$es$kibana)`).
fn cloud_endpoint(cloud_id: &str) -> Result<Endpoint, ConfigProblem> {
    let problem = || ConfigProblem::invalid("Cloud ID가 올바르지 않습니다");
    let encoded = cloud_id.rsplit(':').next().ok_or_else(problem)?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|_| problem())?;
    let decoded = String::from_utf8(decoded).map_err(|_| problem())?;
    let mut parts = decoded.split('$');
    let domain = parts
        .next()
        .filter(|part| !part.is_empty())
        .ok_or_else(problem)?;
    let cluster = parts
        .next()
        .filter(|part| !part.is_empty())
        .ok_or_else(problem)?;
    let (domain, port) = match domain.rsplit_once(':') {
        Some((domain, port)) => (domain, port.parse().map_err(|_| problem())?),
        None => (domain, 443),
    };
    Ok(Endpoint {
        https: true,
        host: format!("{cluster}.{domain}"),
        port,
        prefix: String::new(),
        user: None,
        password: None,
    })
}

/// The cluster a URL names.
fn url_endpoint(url: &str) -> Result<Endpoint, ConfigProblem> {
    let parsed = reqwest::Url::parse(url.trim())
        .map_err(|err| ConfigProblem::invalid(format!("URL이 올바르지 않습니다: {err}")))?;
    let https = match parsed.scheme() {
        "https" => true,
        "http" => false,
        other => {
            return Err(ConfigProblem::invalid(format!(
                "URL은 http:// 또는 https://여야 합니다 ({other}://)"
            )))
        }
    };
    let host = parsed
        .host_str()
        .filter(|host| !host.is_empty())
        .ok_or_else(|| ConfigProblem::invalid("URL에 호스트가 없습니다"))?
        .trim_matches(['[', ']'])
        .to_string();
    Ok(Endpoint {
        https,
        host,
        port: parsed
            .port()
            .unwrap_or(if https { 443 } else { DEFAULT_PORT }),
        prefix: prefix(parsed.path()),
        user: Some(percent_decode(parsed.username())).filter(|user| !user.is_empty()),
        password: parsed.password().map(percent_decode),
    })
}

impl Settings {
    /// Where to connect: a Cloud ID, else a URL, else the host fields.
    fn endpoint(&self) -> Result<Endpoint, ConfigProblem> {
        if let Some(cloud_id) = given(&self.cloud_id) {
            return cloud_endpoint(cloud_id);
        }
        if let Some(url) = given(&self.url) {
            let mut endpoint = url_endpoint(url)?;
            if let Some(path) = given(&self.path_prefix) {
                if endpoint.prefix.is_empty() {
                    endpoint.prefix = prefix(path);
                }
            }
            return Ok(endpoint);
        }
        let host = given(&self.host).unwrap_or("127.0.0.1");
        check_host(host)?;
        Ok(Endpoint {
            https: self.tls,
            host: host.trim_matches(['[', ']']).to_string(),
            port: self.port.unwrap_or(DEFAULT_PORT),
            prefix: given(&self.path_prefix).map(prefix).unwrap_or_default(),
            user: None,
            password: None,
        })
    }

    /// Whether the connection looks up the cluster's other nodes: unless
    /// turned off, or the cluster sits behind something that hides them
    /// (Elastic Cloud's proxy, a path prefix's reverse proxy).
    fn sniffs(&self, endpoint: &Endpoint) -> bool {
        self.sniff != Some(false) && given(&self.cloud_id).is_none() && endpoint.prefix.is_empty()
    }

    /// The authentication method: as chosen, or, for a profile without a
    /// choice, a password login when there is a user and none otherwise.
    fn auth_kind(&self, endpoint: &Endpoint) -> Result<&'static str, ConfigProblem> {
        match given(&self.auth) {
            Some("none") => Ok("none"),
            Some("basic") => Ok("basic"),
            Some("api_key") => Ok("api_key"),
            Some("bearer") => Ok("bearer"),
            Some(other) => Err(ConfigProblem::invalid(format!(
                "지원하지 않는 인증 방식입니다: {other}"
            ))),
            None if given(&self.user).is_some() || endpoint.user.is_some() => Ok("basic"),
            None => Ok("none"),
        }
    }
}

/// How requests prove who sends them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Auth {
    None,
    Basic {
        user: String,
        password: String,
    },
    /// Encoded as Kibana shows it, or `id:api_key`.
    ApiKey(String),
    Bearer(String),
}

/// The settings as the connection uses them, checked.
fn settings(
    descriptor: &EngineDescriptor,
    config: &ConnConfig,
) -> Result<(Settings, Endpoint), ConfigProblem> {
    let settings: Settings = typed_config(descriptor, config)?;
    let endpoint = settings.endpoint()?;
    if let Some(fingerprint) = given(&settings.tls_fingerprint) {
        http::parse_fingerprint(fingerprint)?;
    }
    if given(&settings.cloud_id).is_some() && descriptor.id != "elasticsearch" {
        return Err(ConfigProblem::invalid(
            "Cloud ID는 Elasticsearch에만 있습니다",
        ));
    }
    settings.auth_kind(&endpoint)?;
    Ok((settings, endpoint))
}

/// The credentials, now that the password (the first secret) is in.
fn auth(settings: &Settings, endpoint: &Endpoint) -> Result<Auth, EngineError> {
    let bad = |message: &str| EngineError::BadRequest(message.into());
    let secret = given(&settings.password)
        .map(str::to_string)
        .or_else(|| endpoint.password.clone());
    Ok(
        match settings
            .auth_kind(endpoint)
            .map_err(|problem| EngineError::BadRequest(problem.message))?
        {
            "basic" => Auth::Basic {
                user: given(&settings.user)
                    .map(str::to_string)
                    .or_else(|| endpoint.user.clone())
                    .ok_or_else(|| bad("사용자를 입력하세요"))?,
                password: secret.unwrap_or_default(),
            },
            "api_key" => Auth::ApiKey(secret.ok_or_else(|| bad("API 키를 입력하세요"))?),
            "bearer" => Auth::Bearer(secret.ok_or_else(|| bad("토큰을 입력하세요"))?),
            _ => Auth::None,
        },
    )
}

#[async_trait]
impl DriverFactory for Factory {
    fn descriptor(&self) -> &'static EngineDescriptor {
        self.descriptor
    }

    fn validate(&self, config: &ConnConfig) -> Result<(), ConfigProblem> {
        settings(self.descriptor(), config).map(|_| ())
    }

    /// A profile without an authentication choice gets the one its
    /// settings imply (see `Settings::auth_kind`).
    fn upgrade_config(&self, config: &mut ConnConfig) {
        if config.contains_key("auth") {
            return;
        }
        if let Ok((settings, endpoint)) = settings(self.descriptor(), config) {
            if let Ok(kind) = settings.auth_kind(&endpoint) {
                config.insert("auth".into(), Value::String(kind.into()));
            }
        }
    }

    /// Every method but none takes the secret (a password, key or token).
    fn needs_password(&self, config: &ConnConfig) -> bool {
        match settings(self.descriptor(), config) {
            Ok((settings, endpoint)) => settings.auth_kind(&endpoint) != Ok("none"),
            Err(_) => true,
        }
    }

    /// Through a tunnel, a connection that looks up the other nodes takes
    /// the tunnel itself and leads a local end through it to each node;
    /// one that doesn't, a local end to its one address.
    fn tunnel_target(&self, config: &ConnConfig) -> Result<TunnelTarget, ConfigProblem> {
        let (settings, endpoint) = settings(self.descriptor(), config)?;
        if settings.sniffs(&endpoint) {
            return Ok(TunnelTarget::Members);
        }
        Ok(TunnelTarget::Address(endpoint.host, endpoint.port))
    }

    /// From a URL or a Cloud ID, its user, host and port, never a password.
    fn address(&self, config: &ConnConfig) -> String {
        match settings(self.descriptor(), config) {
            Ok((settings, endpoint)) => {
                let scheme = if endpoint.https { "https" } else { "http" };
                let basic = settings.auth_kind(&endpoint) == Ok("basic");
                let user = given(&settings.user)
                    .map(str::to_string)
                    .or_else(|| endpoint.user.clone())
                    .filter(|_| basic);
                match user {
                    Some(user) => format!(
                        "{scheme}://{user}@{}:{}{}",
                        endpoint.host, endpoint.port, endpoint.prefix
                    ),
                    None => format!(
                        "{scheme}://{}:{}{}",
                        endpoint.host, endpoint.port, endpoint.prefix
                    ),
                }
            }
            Err(_) => self.descriptor().detail(config),
        }
    }

    async fn connect(
        &self,
        config: &ConnConfig,
        net: &NetRoute,
        log: SqlLog,
    ) -> Result<Arc<dyn Driver>, EngineError> {
        let descriptor: &'static EngineDescriptor = self.descriptor;
        let (settings, endpoint) = settings(descriptor, config)
            .map_err(|problem| EngineError::BadRequest(problem.message))?;
        let auth = auth(&settings, &endpoint)?;
        let label = self.address(config);
        let driver =
            SearchEngineDriver::open(descriptor, &settings, &endpoint, &auth, net, label, log)
                .await?;
        Ok(Arc::new(driver))
    }
}

/// A `major.minor` version, for the features that came with one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(super) struct Version(u32, u32);

impl Version {
    fn parse(text: &str) -> Self {
        let mut parts = text.split(['.', '-']).map(|part| part.parse().unwrap_or(0));
        Version(parts.next().unwrap_or(0), parts.next().unwrap_or(0))
    }
}

pub(crate) struct SearchEngineDriver {
    descriptor: &'static EngineDescriptor,
    http: Arc<Http>,
    /// "elasticsearch" or "opensearch", as the server said.
    flavor: &'static str,
    version: Version,
    version_text: String,
    cluster_name: String,
    label: String,
}

impl SearchEngineDriver {
    async fn open(
        descriptor: &'static EngineDescriptor,
        settings: &Settings,
        endpoint: &Endpoint,
        auth: &Auth,
        net: &NetRoute,
        label: String,
        log: SqlLog,
    ) -> Result<Self, EngineError> {
        let engine: &'static str = descriptor.id.as_str();
        let http = Http::new(
            engine,
            settings,
            endpoint,
            auth,
            net,
            settings.sniffs(endpoint),
            log,
        )
        .await?;
        let reply = tokio::time::timeout(
            Duration::from_secs(30),
            http.send(Method::GET, "/", Body::None, Trace::Console, false),
        )
        .await
        .map_err(|_| EngineError::Driver {
            engine,
            code: None,
            message: format!(
                "{}:{}에서 응답이 없습니다 (시간 초과)",
                endpoint.host, endpoint.port
            ),
            interrupted: false,
            fields: Box::default(),
        })??;
        if reply.status == 401 {
            // The server prompts for the password again on this wording.
            return Err(http.error(&reply).prefixed("Authentication failed: "));
        }
        if !reply.ok() {
            return Err(http.error(&reply));
        }
        let root = reply.value();
        let Some(number) = root.pointer("/version/number").and_then(Value::as_str) else {
            return Err(EngineError::Driver {
                engine,
                code: None,
                message: "Elasticsearch·OpenSearch 서버의 응답이 아닙니다".into(),
                interrupted: false,
                fields: Box::new(tablepeek_types::ErrorFields {
                    raw: Some(String::from_utf8_lossy(&reply.bytes).into_owned()),
                    ..Default::default()
                }),
            });
        };
        let flavor = if root
            .pointer("/version/distribution")
            .and_then(Value::as_str)
            == Some("opensearch")
        {
            "opensearch"
        } else {
            "elasticsearch"
        };
        http.set_seed_name(root.get("name").and_then(Value::as_str).map(str::to_string));
        // The other nodes, to fail over to; a cluster that won't list them
        // (no monitor right) leaves the seed alone.
        let _ = tokio::time::timeout(Duration::from_secs(10), http.sniff()).await;
        Ok(Self {
            descriptor,
            http,
            flavor,
            version: Version::parse(number),
            version_text: number.to_string(),
            cluster_name: root
                .get("cluster_name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            label,
        })
    }

    fn opensearch(&self) -> bool {
        self.flavor == "opensearch"
    }

    /// Whether the server still has mapping types (Elasticsearch before
    /// 7.0): the page's indices are typeless (`_doc`), a few endpoints sit
    /// under the type, and mappings are read and written typeless.
    fn typed(&self) -> bool {
        !self.opensearch() && self.version < Version(7, 0)
    }

    /// Whether points in time are there: Elasticsearch 7.10, OpenSearch 2.4.
    fn has_pit(&self) -> bool {
        if self.opensearch() {
            self.version >= Version(2, 4)
        } else {
            self.version >= Version(7, 10)
        }
    }
}

#[async_trait]
impl Driver for SearchEngineDriver {
    fn id(&self) -> &'static str {
        self.descriptor.id.as_str()
    }

    fn capabilities(&self) -> Capabilities {
        self.descriptor.capabilities.clone()
    }

    /// The indices (and data streams), hidden ones only with system objects.
    async fn meta(&self, include_system: bool) -> Result<EngineMeta, EngineError> {
        let expand = if include_system { "all" } else { "open,closed" };
        let rows = self
            .http
            .json(
                Method::GET,
                &format!(
                    "/_cat/indices?format=json&h=index{}",
                    self.cat_expand(expand)
                ),
                Body::None,
                Trace::Console,
                false,
            )
            .await?;
        let mut tables: Vec<String> = rows
            .as_array()
            .map(|rows| {
                rows.iter()
                    .filter_map(|row| row.get("index").and_then(Value::as_str))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default();
        tables.sort();
        Ok(EngineMeta {
            kind: self.id().into(),
            path: Some(self.label.clone()),
            demo: false,
            tables,
            capabilities: None,
        })
    }

    /// Stops waiting for the page's read and cancels its task on the
    /// server, found by the request's `X-Opaque-Id`.
    fn cancel(&self) -> CancelRequest {
        let Some(tag) = self.http.stop_running() else {
            return CancelRequest::Done;
        };
        let http = self.http.clone();
        let request = tokio::spawn(async move {
            ops::settle_tagged(&http, &tag, true).await;
        });
        CancelRequest::Sent {
            request,
            lands_later: false,
        }
    }

    async fn server_info(&self) -> Result<ServerInfo, EngineError> {
        let stats = self
            .http
            .json(
                Method::GET,
                "/_cluster/stats?filter_path=nodes.count.total,nodes.jvm.max_uptime_in_millis,indices.store.size_in_bytes",
                Body::None,
                Trace::Console,
                false,
            )
            .await
            .ok();
        let number = |pointer: &str| {
            stats
                .as_ref()
                .and_then(|stats| stats.pointer(pointer))
                .and_then(Value::as_i64)
        };
        let nodes = number("/nodes/count/total");
        let sessions = self.sessions().await;
        Ok(ServerInfo {
            driver: self.id().into(),
            version: Some(format!(
                "{} {}",
                if self.opensearch() {
                    "OpenSearch"
                } else {
                    "Elasticsearch"
                },
                self.version_text
            )),
            database: Some(self.cluster_name.clone()),
            encoding: None,
            uptime: number("/nodes/jvm/max_uptime_in_millis")
                .map(|millis| crate::humanize_uptime_ko(millis / 1000)),
            size_bytes: number("/indices/store/size_in_bytes"),
            can_kill: sessions.is_some(),
            sessions,
            topology: nodes.map(|nodes| {
                if nodes == 1 {
                    "single_node".into()
                } else {
                    format!("cluster ({nodes} nodes)")
                }
            }),
            host: self.http.answering(),
        })
    }

    fn search(&self) -> Option<&dyn SearchDriver> {
        Some(self)
    }
}

impl SearchEngineDriver {
    /// The running tasks as sessions; None without the right to list them.
    async fn sessions(&self) -> Option<Vec<ServerSession>> {
        let tasks = SearchDriver::tasks(self, None).await.ok()?;
        Some(
            tasks
                .into_iter()
                .filter(|task| task.get("parent_task_id").is_none_or(Value::is_null))
                .map(|task| {
                    let text =
                        |key: &str| task.get(key).and_then(Value::as_str).map(str::to_string);
                    let action = text("action").unwrap_or_default();
                    ServerSession {
                        id: text("id").unwrap_or_default(),
                        user: text("opaque_id"),
                        database: text("node"),
                        is_current: action.starts_with("cluster:monitor/tasks/lists"),
                        state: Some(action),
                        query: text("description").filter(|text| !text.is_empty()),
                        elapsed_ms: task.get("running_time_ms").and_then(Value::as_i64),
                    }
                })
                .collect(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config(value: Value) -> ConnConfig {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn endpoints_come_from_a_cloud_id_a_url_or_the_host_fields() {
        let es = FACTORY.descriptor();
        let (_, endpoint) = settings(
            es,
            &config(json!({ "host": "db", "port": 9201, "tls": true, "path_prefix": "es/" })),
        )
        .unwrap();
        assert_eq!(
            (
                endpoint.https,
                endpoint.host.as_str(),
                endpoint.port,
                endpoint.prefix.as_str()
            ),
            (true, "db", 9201, "/es")
        );
        let (_, endpoint) = settings(
            es,
            &config(json!({ "url": "https://el%40stic:p%40ss@search.example.com/proxy/es/" })),
        )
        .unwrap();
        assert_eq!(endpoint.host, "search.example.com");
        assert_eq!(endpoint.port, 443);
        assert_eq!(endpoint.prefix, "/proxy/es");
        assert_eq!(endpoint.user.as_deref(), Some("el@stic"));
        assert_eq!(endpoint.password.as_deref(), Some("p@ss"));
        let (_, endpoint) = settings(es, &config(json!({ "url": "http://[::1]:9200" }))).unwrap();
        assert_eq!((endpoint.host.as_str(), endpoint.port), ("::1", 9200));
        assert!(settings(es, &config(json!({ "url": "ftp://x" }))).is_err());
        assert!(settings(es, &config(json!({ "host": "http://x:9200" }))).is_err());

        // name:base64("us-east-1.aws.found.io$abc123$def456")
        let cloud = format!(
            "my:{}",
            base64::engine::general_purpose::STANDARD
                .encode("us-east-1.aws.found.io$abc123$def456")
        );
        let (_, endpoint) = settings(es, &config(json!({ "cloud_id": cloud }))).unwrap();
        assert_eq!(endpoint.host, "abc123.us-east-1.aws.found.io");
        assert!(endpoint.https && endpoint.port == 443);
        assert!(settings(
            OPENSEARCH.descriptor(),
            &config(json!({ "cloud_id": cloud }))
        )
        .is_err());
        assert!(settings(es, &config(json!({ "cloud_id": "nonsense" }))).is_err());
        assert!(settings(es, &config(json!({ "host": "h", "tls_fingerprint": "zz" }))).is_err());
    }

    #[test]
    fn the_password_is_asked_for_by_every_method_but_none() {
        let with = |value: Value| FACTORY.needs_password(&config(value));
        assert!(with(
            json!({ "host": "h", "auth": "basic", "user": "elastic" })
        ));
        assert!(with(json!({ "host": "h", "auth": "api_key" })));
        assert!(with(json!({ "host": "h", "auth": "bearer" })));
        assert!(!with(json!({ "host": "h", "auth": "none" })));
        // Without a choice: a user means a password login.
        assert!(with(json!({ "host": "h", "user": "elastic" })));
        assert!(!with(json!({ "host": "h" })));
        let mut old = config(json!({ "host": "h", "user": "admin" }));
        FACTORY.upgrade_config(&mut old);
        assert_eq!(old["auth"], json!("basic"));
        let mut old = config(json!({ "host": "h" }));
        OPENSEARCH.upgrade_config(&mut old);
        assert_eq!(old["auth"], json!("none"));
    }

    #[test]
    fn credentials_come_from_the_fields_or_the_url() {
        let (settings_, endpoint) = settings(
            FACTORY.descriptor(),
            &config(json!({ "url": "https://ann:pw@h:9200", "auth": "basic" })),
        )
        .unwrap();
        assert_eq!(
            auth(&settings_, &endpoint).unwrap(),
            Auth::Basic {
                user: "ann".into(),
                password: "pw".into()
            }
        );
        let (settings_, endpoint) = settings(
            FACTORY.descriptor(),
            &config(json!({ "host": "h", "auth": "api_key" })),
        )
        .unwrap();
        assert!(auth(&settings_, &endpoint).is_err());
        let (settings_, endpoint) = settings(
            FACTORY.descriptor(),
            &config(json!({ "host": "h", "auth": "bearer", "password": "t0k" })),
        )
        .unwrap();
        assert_eq!(
            auth(&settings_, &endpoint).unwrap(),
            Auth::Bearer("t0k".into())
        );
    }

    #[test]
    fn addresses_and_tunnels_never_show_the_password() {
        let url =
            config(json!({ "url": "https://ann:pw@search.example.com:9243/es", "auth": "basic" }));
        assert_eq!(
            FACTORY.address(&url),
            "https://ann@search.example.com:9243/es"
        );
        assert_eq!(
            FACTORY.tunnel_target(&url).unwrap(),
            TunnelTarget::Address("search.example.com".into(), 9243)
        );
        let plain = config(json!({ "host": "10.0.0.5", "auth": "none" }));
        assert_eq!(OPENSEARCH.address(&plain), "http://10.0.0.5:9200");
        // Looking up the other nodes, a tunnel leads to each of them; with
        // that off, to the one address.
        assert_eq!(
            OPENSEARCH.tunnel_target(&plain).unwrap(),
            TunnelTarget::Members
        );
        let single = config(json!({ "host": "10.0.0.5", "auth": "none", "sniff": false }));
        assert_eq!(
            OPENSEARCH.tunnel_target(&single).unwrap(),
            TunnelTarget::Address("10.0.0.5".into(), 9200)
        );
    }

    /// A node of a pretend cluster: answers `GET /`, `_nodes/http` (both
    /// nodes, by name) and anything else with its own name, one request
    /// per connection. Stops when the returned handle is aborted.
    async fn fake_node(name: &'static str) -> (u16, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                tokio::spawn(async move {
                    let mut head = Vec::new();
                    let mut byte = [0u8; 1];
                    while !head.ends_with(b"\r\n\r\n") {
                        if stream.read(&mut byte).await.unwrap_or(0) == 0 {
                            return;
                        }
                        head.push(byte[0]);
                    }
                    let head = String::from_utf8_lossy(&head);
                    let path = head.split(' ').nth(1).unwrap_or("/");
                    let body = if path == "/" {
                        json!({ "name": name, "cluster_name": "pretend", "version": { "number": "8.17.4" } })
                    } else if path.starts_with("/_nodes/http") {
                        json!({ "nodes": {
                            "a": { "name": "node-a", "roles": ["data", "master"], "http": { "publish_address": "node-a/10.9.0.1:9200" } },
                            "b": { "name": "node-b", "roles": ["data"], "http": { "publish_address": "node-b/10.9.0.2:9200" } },
                            "m": { "name": "node-m", "roles": ["master"], "http": { "publish_address": "node-m/10.9.0.3:9200" } }
                        } })
                    } else if path.starts_with("/_cluster/health") {
                        json!({ "status": "green" })
                    } else {
                        json!({ "answered_by": name })
                    }
                    .to_string();
                    let reply = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(reply.as_bytes()).await;
                });
            }
        });
        (port, task)
    }

    /// Leads node names to the pretend nodes' ports; a node not (or no
    /// longer) there can't be reached.
    struct Tunnel {
        ports: std::sync::Mutex<std::collections::HashMap<String, u16>>,
        asked: std::sync::Mutex<Vec<String>>,
    }

    #[async_trait]
    impl crate::registry::Forwarder for Tunnel {
        async fn connect(
            &self,
            host: &str,
            port: u16,
        ) -> Result<Box<dyn crate::registry::TunnelStream>, String> {
            self.asked.lock().unwrap().push(format!("{host}:{port}"));
            let local = self
                .ports
                .lock()
                .unwrap()
                .get(host)
                .copied()
                .ok_or_else(|| format!("{host}: no route"))?;
            let stream = tokio::net::TcpStream::connect(("127.0.0.1", local))
                .await
                .map_err(|err| err.to_string())?;
            Ok(Box::new(stream))
        }
    }

    #[tokio::test]
    async fn requests_fail_over_to_the_nodes_the_cluster_lists_through_a_tunnel() {
        let (port_a, node_a) = fake_node("node-a").await;
        let (port_b, _node_b) = fake_node("node-b").await;
        let tunnel = Arc::new(Tunnel {
            ports: std::sync::Mutex::new(
                [
                    ("node-a".to_string(), port_a),
                    ("node-b".to_string(), port_b),
                ]
                .into(),
            ),
            asked: std::sync::Mutex::new(Vec::new()),
        });
        let driver = FACTORY
            .connect(
                &config(json!({ "host": "node-a", "port": 9200, "auth": "none" })),
                &NetRoute::Tunnel(tunnel.clone()),
                SqlLog::new(),
            )
            .await
            .expect("connects through the tunnel");
        let search = driver.search().unwrap();
        let cluster = search.cluster().await.unwrap();
        let connection = &cluster["connection"];
        assert_eq!(connection["current"], "node-a:9200");
        let listed: Vec<&str> = connection["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|node| node["address"].as_str().unwrap())
            .collect();
        // The seed, and the other data node by the name it publishes; the
        // dedicated master is left out.
        assert_eq!(listed, ["node-a:9200", "node-b:9200"]);
        assert_eq!(connection["nodes"][0]["name"], "node-a");

        // node-a goes away: the next request lands on node-b.
        node_a.abort();
        tunnel.ports.lock().unwrap().remove("node-a");
        let answered = search.cluster().await.unwrap();
        assert_eq!(answered["node_name"], "node-b");
        assert_eq!(answered["connection"]["current"], "node-b:9200");
        assert_eq!(answered["connection"]["failovers"], 1);
        assert_eq!(answered["connection"]["nodes"][0]["down"], true);
        assert_eq!(
            driver.server_info().await.unwrap().host.as_deref(),
            Some("node-b:9200")
        );
        assert!(tunnel
            .asked
            .lock()
            .unwrap()
            .iter()
            .any(|asked| asked == "node-b:9200"));

        // With every node gone the request fails with the tunnel's reason.
        tunnel.ports.lock().unwrap().clear();
        let err = search.cluster().await.unwrap_err();
        assert!(err.to_string().contains("연결할 수 없습니다"), "{err}");
    }

    #[tokio::test]
    async fn without_sniffing_the_seed_is_the_only_node() {
        let (port, _node) = fake_node("node-a").await;
        let driver = FACTORY
            .connect(
                &config(
                    json!({ "host": "127.0.0.1", "port": port, "auth": "none", "sniff": false }),
                ),
                &NetRoute::Direct,
                SqlLog::new(),
            )
            .await
            .unwrap();
        let cluster = driver.search().unwrap().cluster().await.unwrap();
        assert_eq!(cluster["connection"]["sniff"], false);
        assert_eq!(cluster["connection"]["nodes"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn versions_compare_by_major_and_minor() {
        assert!(Version::parse("7.10.2") >= Version(7, 10));
        assert!(Version::parse("8.17.4") > Version(7, 10));
        assert!(Version::parse("2.3.0") < Version(2, 4));
        assert_eq!(Version::parse("9.0.0-SNAPSHOT"), Version(9, 0));
    }
}
