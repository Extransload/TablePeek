//! What an Elasticsearch or OpenSearch connection does for the page: each
//! `SearchDriver` operation as the REST requests it takes.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use async_trait::async_trait;
use reqwest::Method;
use serde_json::value::RawValue;
use serde_json::{json, Map, Value};

use super::http::{console_text, Body, Http, Trace};
use super::{console, SearchEngineDriver};
use crate::search::{
    is_object, raw, raw_object, raw_text, AliasInfo, AliasesRequest, AnalyzeRequest, ApiKeyRequest,
    BulkRequest, ByQueryRequest, Classified, ConsoleReply, ConsoleRequest, CountRequest,
    DeleteDocRequest, DocRef, ExplainDocRequest, IndexDocRequest, IndexRequest, PitOpenRequest,
    Raw, RawStream, ReindexRequest, RequestClass, SearchDriver, SearchExportRequest, SearchRequest,
    SecurityDeleteRequest, SecurityKind, SecurityPutRequest, SqlColumn, SqlRequest, SqlResult,
    UpdateDocRequest, UserEnabledRequest, UserPasswordRequest, ValidateRequest,
};
use crate::EngineError;

/// Hits an export reads per request.
const EXPORT_PAGE: u64 = 1000;
/// How long the server keeps an export's cursor between two pages.
const EXPORT_KEEP_ALIVE: &str = "2m";
/// The most bulk failures a reply lists.
const BULK_FAILURES: usize = 100;
/// The columns `/api/search/shards` reads.
const SHARD_COLUMNS: &str = "index,shard,prirep,state,docs,store,ip,node,unassigned.reason";

/// `text` with every byte outside `keep` and the unreserved characters
/// percent-encoded, for one path segment.
fn encode(text: &str, keep: &[u8]) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) || keep.contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// An index expression as a path segment: names, lists and patterns.
fn target(index: &str) -> String {
    encode(index.trim(), b",*:+")
}

/// A document id as a path segment.
pub(super) fn id_segment(id: &str) -> String {
    encode(id, b"")
}

/// A query string of the parameters that are set (`?a=1&b=x`).
fn query(params: &[(&str, Option<String>)]) -> String {
    let mut out = String::new();
    for (key, value) in params {
        if let Some(value) = value {
            out.push(if out.is_empty() { '?' } else { '&' });
            out.push_str(key);
            out.push('=');
            out.push_str(&encode(value, b",*:"));
        }
    }
    out
}

fn bad(message: impl Into<String>) -> EngineError {
    EngineError::BadRequest(message.into())
}

/// The index a request names, or the error for a missing one.
fn required(index: &str) -> Result<&str, EngineError> {
    let index = index.trim();
    if index.is_empty() {
        return Err(bad("인덱스 이름이 필요합니다"));
    }
    Ok(index)
}

/// A `_cat` number (they come as text) as a number; null stays null.
fn cat_number(value: Option<&Value>) -> Value {
    match value {
        Some(Value::String(text)) => text
            .parse::<u64>()
            .map(Value::from)
            .or_else(|_| text.parse::<f64>().map(Value::from))
            .unwrap_or(Value::Null),
        Some(Value::Number(number)) => Value::Number(number.clone()),
        _ => Value::Null,
    }
}

fn millis_since_epoch() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// The tasks of the request tagged `tag` still on the server, waiting a
/// moment for them to show up when asked right after the request. With
/// `cancel` (a read the page stopped) the ones that can be cancelled are;
/// answers `{ cancelled, running }`, each running task (one the server
/// can't cancel, or a write's) with `related`: the tasks of its tree (its
/// subtasks and the tasks it runs under) that can be cancelled.
pub(super) async fn settle_tagged(http: &Http, tag: &str, cancel: bool) -> Value {
    for _ in 0..5 {
        let Ok(listing) = http
            .json(
                Method::GET,
                "/_tasks?detailed=true",
                Body::None,
                Trace::Quiet,
                false,
            )
            .await
        else {
            break;
        };
        let tasks = flatten_tasks(&listing);
        let id_of = |task: &Value| task.get("id").and_then(Value::as_str).map(str::to_string);
        let tagged: Vec<&Value> = tasks
            .iter()
            .filter(|task| task.get("opaque_id").and_then(Value::as_str) == Some(tag))
            .collect();
        if tagged.is_empty() {
            tokio::time::sleep(Duration::from_millis(100)).await;
            continue;
        }
        let tagged_ids: HashSet<String> = tagged.iter().filter_map(|task| id_of(task)).collect();
        // Subtasks carry their parent's tag; the parents are what ran.
        let roots = tagged.into_iter().filter(|task| {
            task.get("parent_task_id")
                .and_then(Value::as_str)
                .is_none_or(|parent| !tagged_ids.contains(parent))
        });
        let mut cancelled = Vec::new();
        let mut running = Vec::new();
        for root in roots {
            let Some(id) = id_of(root) else { continue };
            if cancel && root.get("cancellable") == Some(&Value::Bool(true)) {
                let path = format!("/_tasks/{}/_cancel", id_segment(&id));
                let sent = http
                    .send(Method::POST, &path, Body::None, Trace::Console, false)
                    .await;
                if sent.is_ok_and(|reply| reply.ok()) {
                    cancelled.push(root.clone());
                    continue;
                }
            }
            let mut entry = root.clone();
            entry["related"] = Value::Array(related_tasks(&tasks, &id));
            running.push(entry);
        }
        return json!({ "cancelled": cancelled, "running": running });
    }
    json!({ "cancelled": [], "running": [] })
}

/// The tasks of `id`'s tree (its subtasks, all the way down, and the tasks
/// it runs under) that can still be cancelled.
fn related_tasks(tasks: &[Value], id: &str) -> Vec<Value> {
    let parent_of = |task: &Value| {
        task.get("parent_task_id")
            .and_then(Value::as_str)
            .map(str::to_string)
    };
    let by_id: HashMap<&str, &Value> = tasks
        .iter()
        .filter_map(|task| Some((task.get("id")?.as_str()?, task)))
        .collect();
    let mut tree: HashSet<String> = HashSet::new();
    // Up: the tasks it runs under.
    let mut up = by_id.get(id).and_then(|task| parent_of(task));
    while let Some(parent) = up {
        if !tree.insert(parent.clone()) {
            break;
        }
        up = by_id.get(parent.as_str()).and_then(|task| parent_of(task));
    }
    // Down: every subtask of it.
    let mut frontier = vec![id.to_string()];
    while let Some(current) = frontier.pop() {
        for task in tasks {
            if parent_of(task).as_deref() == Some(current.as_str()) {
                if let Some(child) = task.get("id").and_then(Value::as_str) {
                    if tree.insert(child.to_string()) {
                        frontier.push(child.to_string());
                    }
                }
            }
        }
    }
    tasks
        .iter()
        .filter(|task| {
            task.get("id")
                .and_then(Value::as_str)
                .is_some_and(|task_id| tree.contains(task_id))
        })
        .filter(|task| task.get("cancellable") == Some(&Value::Bool(true)))
        .filter(|task| task.get("cancelled") != Some(&Value::Bool(true)))
        .cloned()
        .collect()
}

/// The tasks of a `_tasks` reply, grouped by node or not, one object each.
fn flatten_tasks(listing: &Value) -> Vec<Value> {
    let mut tasks: Vec<(&str, &Value)> = Vec::new();
    if let Some(nodes) = listing.get("nodes").and_then(Value::as_object) {
        for node in nodes.values() {
            if let Some(map) = node.get("tasks").and_then(Value::as_object) {
                tasks.extend(map.iter().map(|(id, task)| (id.as_str(), task)));
            }
        }
    } else if let Some(map) = listing.get("tasks").and_then(Value::as_object) {
        tasks.extend(map.iter().map(|(id, task)| (id.as_str(), task)));
    }
    let mut out: Vec<Value> = tasks
        .into_iter()
        .map(|(id, task)| {
            json!({
                "id": id,
                "node": task.get("node"),
                "action": task.get("action"),
                "description": task.get("description").cloned().unwrap_or(Value::Null),
                "start_time_ms": task.get("start_time_in_millis"),
                "running_time_ms": task
                    .get("running_time_in_nanos")
                    .and_then(Value::as_u64)
                    .map(|nanos| nanos / 1_000_000),
                "cancellable": task.get("cancellable").and_then(Value::as_bool).unwrap_or(false),
                "cancelled": task.get("cancelled").and_then(Value::as_bool).unwrap_or(false),
                "parent_task_id": task.get("parent_task_id").cloned().unwrap_or(Value::Null),
                "opaque_id": task.pointer("/headers/X-Opaque-Id").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    out.sort_by_key(|task| {
        std::cmp::Reverse(
            task.get("running_time_ms")
                .and_then(Value::as_u64)
                .unwrap_or(0),
        )
    });
    out
}

/// Settings the server sets itself, left out of an index's definition.
const SERVER_SETTINGS: [&str; 8] = [
    "uuid",
    "creation_date",
    "creation_date_string",
    "version",
    "provided_name",
    "resize",
    "history_uuid",
    "verified_before_close",
];

/// A summary of a `_bulk` reply: counts and the first failures, each with
/// its position (0-based) among the request's actions.
fn bulk_summary(reply: &Value) -> Value {
    let items = reply
        .get("items")
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let mut failures = Vec::new();
    let mut failed = 0usize;
    for (position, item) in items.iter().enumerate() {
        let Some(result) = item.as_object().and_then(|item| item.values().next()) else {
            continue;
        };
        let Some(error) = result.get("error") else {
            continue;
        };
        failed += 1;
        if failures.len() < BULK_FAILURES {
            failures.push(json!({
                "position": position,
                "index": result.get("_index"),
                "id": result.get("_id"),
                "status": result.get("status"),
                "type": error.get("type"),
                "reason": error.get("reason").cloned().unwrap_or_else(|| error.clone()),
            }));
        }
    }
    json!({
        "took": reply.get("took"),
        "errors": reply.get("errors").and_then(Value::as_bool).unwrap_or(failed > 0),
        "count": items.len(),
        "failed": failed,
        "failures": failures,
    })
}

/// Sums the nodes' stats into the numbers the performance tab charts.
fn perf_totals(stats: &Value) -> Value {
    let nodes: Vec<&Value> = stats
        .get("nodes")
        .and_then(Value::as_object)
        .map(|nodes| nodes.values().collect())
        .unwrap_or_default();
    let sum = |pointer: &str| -> u64 {
        nodes
            .iter()
            .filter_map(|node| node.pointer(pointer).and_then(Value::as_u64))
            .sum()
    };
    let cpus: Vec<f64> = nodes
        .iter()
        .filter_map(|node| {
            node.pointer("/os/cpu/percent")
                .or_else(|| node.pointer("/process/cpu/percent"))
                .and_then(Value::as_f64)
        })
        .collect();
    let cpu = if cpus.is_empty() {
        Value::Null
    } else {
        json!((cpus.iter().sum::<f64>() / cpus.len() as f64).round())
    };
    let pool = |name: &str| {
        json!({
            "active": sum(&format!("/thread_pool/{name}/active")),
            "queue": sum(&format!("/thread_pool/{name}/queue")),
            "rejected": sum(&format!("/thread_pool/{name}/rejected")),
        })
    };
    json!({
        "time": millis_since_epoch(),
        "nodes": nodes.len(),
        "docs": sum("/indices/docs/count"),
        "store_bytes": sum("/indices/store/size_in_bytes"),
        "search": {
            "query_total": sum("/indices/search/query_total"),
            "query_time_ms": sum("/indices/search/query_time_in_millis"),
            "fetch_total": sum("/indices/search/fetch_total"),
            "scroll_total": sum("/indices/search/scroll_total"),
            "current": sum("/indices/search/query_current"),
        },
        "indexing": {
            "index_total": sum("/indices/indexing/index_total"),
            "index_time_ms": sum("/indices/indexing/index_time_in_millis"),
            "delete_total": sum("/indices/indexing/delete_total"),
            "current": sum("/indices/indexing/index_current"),
        },
        "get_total": sum("/indices/get/total"),
        "refresh_total": sum("/indices/refresh/total"),
        "merges_current": sum("/indices/merges/current"),
        "heap_used_bytes": sum("/jvm/mem/heap_used_in_bytes"),
        "heap_max_bytes": sum("/jvm/mem/heap_max_in_bytes"),
        "cpu_percent": cpu,
        "open_fds": sum("/process/open_file_descriptors"),
        "http_open": sum("/http/current_open"),
        "thread_pools": { "search": pool("search"), "write": pool("write") },
    })
}

/// A JSON object reply with `elapsed_ms` put first, the rest of its text
/// untouched.
fn with_elapsed(reply: Raw, elapsed_ms: f64) -> Raw {
    let text = reply.get().trim_start();
    let Some(rest) = text.strip_prefix('{') else {
        return reply;
    };
    let separator = if rest.trim_start().starts_with('}') {
        ""
    } else {
        ","
    };
    raw_text(format!(
        "{{\"elapsed_ms\":{}{separator}{rest}",
        raw(&elapsed_ms).get()
    ))
    .unwrap_or(reply)
}

impl SearchEngineDriver {
    async fn get(&self, path: &str, trace: Trace) -> Result<Value, EngineError> {
        self.http
            .json(Method::GET, path, Body::None, trace, false)
            .await
    }

    /// The page's read, logged and stopped by a cancel, whose reply goes
    /// back as it came; `body` is JSON text, sent as it is.
    async fn read_raw(&self, method: Method, path: &str, body: &str) -> Result<Raw, EngineError> {
        self.http
            .raw(method, path, Body::Text(body), Trace::Console, true)
            .await
    }

    /// A write of JSON text as it is: logged, and filed in History once it
    /// succeeded.
    async fn write(
        &self,
        method: Method,
        path: &str,
        body: Option<&str>,
    ) -> Result<Value, EngineError> {
        let body = body.map_or(Body::None, Body::Text);
        self.http
            .json(method, path, body, Trace::Change, false)
            .await
    }

    /// The SQL endpoint: OpenSearch's plugin, Elasticsearch's, or before
    /// 7.0 its X-Pack one.
    fn sql_path(&self) -> &'static str {
        if self.opensearch() {
            "/_plugins/_sql"
        } else if self.typed() {
            "/_xpack/sql"
        } else {
            "/_sql"
        }
    }

    /// `include_type_name=false` after `lead` (`?` or `&`) for a server
    /// with mapping types, whose mappings the page reads and writes
    /// typeless; nothing for the others.
    fn typeless(&self, lead: &str) -> String {
        if self.typed() {
            format!("{lead}include_type_name=false")
        } else {
            String::new()
        }
    }

    /// `&expand_wildcards=…` for `_cat/indices`, which took it from
    /// Elasticsearch 7.7; before, it lists open and closed indices anyway.
    pub(super) fn cat_expand(&self, expand: &str) -> String {
        if !self.opensearch() && self.version < super::Version(7, 7) {
            String::new()
        } else {
            format!("&expand_wildcards={expand}")
        }
    }

    fn require_pit(&self) -> Result<(), EngineError> {
        if self.has_pit() {
            Ok(())
        } else {
            Err(EngineError::Unsupported(format!(
                "이 서버({} {})는 point in time을 지원하지 않습니다",
                self.flavor, self.version_text
            )))
        }
    }
}

#[async_trait]
impl SearchDriver for SearchEngineDriver {
    fn flavor(&self) -> &'static str {
        self.flavor
    }

    fn classify(
        &self,
        method: &str,
        path: &str,
        body: Option<&RawValue>,
    ) -> Result<Classified, EngineError> {
        console::classify(method, path, body)
    }

    async fn cluster(&self) -> Result<Value, EngineError> {
        let root = self.get("/", Trace::Quiet).await?;
        let health = self.get("/_cluster/health", Trace::Quiet).await?;
        // Nodes join and leave: the list to fail over along is read again
        // as the cluster tab polls.
        self.http.sniff_if_old().await;
        Ok(json!({
            "flavor": self.flavor,
            "version": root.pointer("/version/number"),
            "distribution": root.pointer("/version/distribution").cloned().unwrap_or_else(|| json!("elasticsearch")),
            "build_flavor": root.pointer("/version/build_flavor"),
            "lucene_version": root.pointer("/version/lucene_version"),
            "cluster_name": root.get("cluster_name"),
            "cluster_uuid": root.get("cluster_uuid"),
            "node_name": root.get("name"),
            "tagline": root.get("tagline"),
            "health": health,
            "connection": self.http.connection(),
        }))
    }

    async fn nodes(&self) -> Result<Value, EngineError> {
        let rows = self
            .get(
                "/_cat/nodes?format=json&full_id=true&h=id,name,ip,node.role,master,version,heap.percent,ram.percent,cpu,load_1m,disk.used_percent,uptime",
                Trace::Quiet,
            )
            .await?;
        // Full role names; `_cat` gives them as letters.
        let roles = self
            .get("/_nodes?filter_path=nodes.*.roles", Trace::Quiet)
            .await
            .unwrap_or(Value::Null);
        let nodes: Vec<Value> = rows
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .map(|row| {
                let id = row.get("id").and_then(Value::as_str).unwrap_or_default();
                json!({
                    "id": id,
                    "name": row.get("name"),
                    "ip": row.get("ip"),
                    "roles": roles
                        .pointer(&format!("/nodes/{id}/roles"))
                        .cloned()
                        .unwrap_or_else(|| row.get("node.role").cloned().unwrap_or(Value::Null)),
                    "master": row.get("master").and_then(Value::as_str) == Some("*"),
                    "version": row.get("version"),
                    "heap_percent": cat_number(row.get("heap.percent")),
                    "ram_percent": cat_number(row.get("ram.percent")),
                    "cpu": cat_number(row.get("cpu")),
                    "load_1m": cat_number(row.get("load_1m")),
                    "disk_used_percent": cat_number(row.get("disk.used_percent")),
                    "uptime": row.get("uptime"),
                })
            })
            .collect();
        Ok(Value::Array(nodes))
    }

    async fn perf(&self) -> Result<Value, EngineError> {
        let stats = self
            .get(
                "/_nodes/stats/indices,jvm,os,process,thread_pool,http",
                Trace::Quiet,
            )
            .await?;
        Ok(perf_totals(&stats))
    }

    async fn indices(&self, hidden: bool) -> Result<Vec<Value>, EngineError> {
        let expand = if hidden { "all" } else { "open,closed" };
        let rows = self
            .get(
                &format!("/_cat/indices?format=json&bytes=b{}&h=health,status,index,uuid,pri,rep,docs.count,docs.deleted,store.size,pri.store.size", self.cat_expand(expand)),
                Trace::Console,
            )
            .await?;
        let mut aliases: HashMap<String, Vec<String>> = HashMap::new();
        for alias in self.aliases().await? {
            aliases.entry(alias.index).or_default().push(alias.alias);
        }
        let mut streams: HashMap<String, Value> = HashMap::new();
        if let Some(list) = self.data_streams().await?.as_array() {
            for stream in list {
                let name = stream.get("name").cloned().unwrap_or(Value::Null);
                for backing in stream
                    .get("indices")
                    .and_then(Value::as_array)
                    .map(Vec::as_slice)
                    .unwrap_or_default()
                {
                    if let Some(index) = backing.get("index_name").and_then(Value::as_str) {
                        streams.insert(index.to_string(), name.clone());
                    }
                }
            }
        }
        let hidden_flags = if hidden {
            self.get(
                "/_all/_settings/index.hidden?expand_wildcards=all&flat_settings=true",
                Trace::Console,
            )
            .await
            .unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        // `_cat` counts Lucene documents, nested ones included; a terms
        // aggregation on `_index` counts the documents a search finds.
        let counts: Option<HashMap<String, u64>> = self
            .http
            .json(
                Method::POST,
                &format!(
                    "/_search?expand_wildcards={}&ignore_unavailable=true&allow_no_indices=true",
                    if hidden { "open,hidden" } else { "open" }
                ),
                Body::Json(&json!({
                    "size": 0,
                    "track_total_hits": false,
                    "aggs": { "indices": { "terms": { "field": "_index", "size": 65535 } } },
                })),
                Trace::Console,
                false,
            )
            .await
            .ok()
            .map(|reply| {
                reply
                    .pointer("/aggregations/indices/buckets")
                    .and_then(Value::as_array)
                    .map(Vec::as_slice)
                    .unwrap_or_default()
                    .iter()
                    .filter_map(|bucket| {
                        Some((
                            bucket.get("key")?.as_str()?.to_string(),
                            bucket.get("doc_count")?.as_u64()?,
                        ))
                    })
                    .collect()
            });
        let mut out: Vec<Value> = rows
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .filter_map(|row| {
                let name = row.get("index").and_then(Value::as_str)?;
                let is_hidden = hidden_flags
                    .pointer(&format!(
                        "/{}/settings/index.hidden",
                        name.replace('~', "~0").replace('/', "~1")
                    ))
                    .and_then(Value::as_str)
                    == Some("true");
                Some(json!({
                    "name": name,
                    "health": row.get("health"),
                    "status": row.get("status"),
                    "uuid": row.get("uuid"),
                    "docs": match (&counts, row.get("status").and_then(Value::as_str)) {
                        (_, Some("close")) => Value::Null,
                        (Some(counts), _) => json!(counts.get(name).copied().unwrap_or(0)),
                        (None, _) => cat_number(row.get("docs.count")),
                    },
                    "deleted": cat_number(row.get("docs.deleted")),
                    "size": cat_number(row.get("store.size")),
                    "pri_size": cat_number(row.get("pri.store.size")),
                    "primaries": cat_number(row.get("pri")),
                    "replicas": cat_number(row.get("rep")),
                    "aliases": aliases.get(name).cloned().unwrap_or_default(),
                    "data_stream": streams.get(name).cloned().unwrap_or(Value::Null),
                    "hidden": is_hidden || name.starts_with('.'),
                }))
            })
            .collect();
        out.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
        Ok(out)
    }

    async fn aliases(&self) -> Result<Vec<AliasInfo>, EngineError> {
        #[derive(serde::Deserialize)]
        struct Entry {
            #[serde(default)]
            aliases: std::collections::BTreeMap<String, Options>,
        }
        #[derive(serde::Deserialize)]
        struct Options {
            filter: Option<Raw>,
            index_routing: Option<String>,
            search_routing: Option<String>,
            is_write_index: Option<bool>,
            is_hidden: Option<bool>,
        }
        let reply = self
            .http
            .raw(
                Method::GET,
                "/_alias?expand_wildcards=all",
                Body::None,
                Trace::Console,
                false,
            )
            .await?;
        let indices: std::collections::BTreeMap<String, Entry> = serde_json::from_str(reply.get())
            .map_err(|err| EngineError::Internal(format!("별칭 목록을 읽을 수 없습니다: {err}")))?;
        let mut out: Vec<AliasInfo> = indices
            .into_iter()
            .flat_map(|(index, entry)| {
                entry
                    .aliases
                    .into_iter()
                    .map(move |(alias, options)| AliasInfo {
                        alias,
                        index: index.clone(),
                        filter: options.filter,
                        index_routing: options.index_routing,
                        search_routing: options.search_routing,
                        is_write_index: options.is_write_index,
                        is_hidden: options.is_hidden,
                    })
            })
            .collect();
        out.sort_by(|a, b| (&a.alias, &a.index).cmp(&(&b.alias, &b.index)));
        Ok(out)
    }

    /// None on a server without data streams (or the right to see them).
    async fn data_streams(&self) -> Result<Value, EngineError> {
        let reply = self
            .http
            .send(
                Method::GET,
                // OpenSearch lists hidden ones anyway and refuses the
                // parameter, as Elasticsearch did before 7.11.
                if self.opensearch() || self.version < super::Version(7, 11) {
                    "/_data_stream"
                } else {
                    "/_data_stream?expand_wildcards=all"
                },
                Body::None,
                Trace::Console,
                false,
            )
            .await?;
        if !reply.ok() {
            return if matches!(reply.status, 400 | 403 | 404 | 405) {
                Ok(json!([]))
            } else {
                Err(self.http.error(&reply))
            };
        }
        Ok(reply
            .value()
            .get("data_streams")
            .cloned()
            .unwrap_or_else(|| json!([])))
    }

    async fn mapping(&self, index: &str) -> Result<Raw, EngineError> {
        let path = format!(
            "/{}/_mapping{}",
            target(required(index)?),
            self.typeless("?")
        );
        self.http
            .raw(Method::GET, &path, Body::None, Trace::Console, false)
            .await
    }

    async fn settings(&self, index: &str, defaults: bool) -> Result<Raw, EngineError> {
        let path = format!(
            "/{}/_settings{}",
            target(required(index)?),
            query(&[("include_defaults", defaults.then(|| "true".to_string()))])
        );
        self.http
            .raw(Method::GET, &path, Body::None, Trace::Console, false)
            .await
    }

    async fn definition(&self, index: &str) -> Result<Raw, EngineError> {
        #[derive(serde::Deserialize)]
        struct Entry {
            aliases: Option<Raw>,
            mappings: Option<Raw>,
            #[serde(default)]
            settings: Settings,
        }
        #[derive(serde::Deserialize, Default)]
        struct Settings {
            #[serde(default)]
            index: std::collections::BTreeMap<String, Raw>,
        }
        let index = required(index)?;
        let reply = self
            .http
            .raw(
                Method::GET,
                &format!("/{}{}", target(index), self.typeless("?")),
                Body::None,
                Trace::Console,
                false,
            )
            .await?;
        let indices: std::collections::BTreeMap<String, Entry> = serde_json::from_str(reply.get())
            .map_err(|err| {
                EngineError::Internal(format!("인덱스 정의를 읽을 수 없습니다: {err}"))
            })?;
        let entry = indices
            .into_values()
            .next()
            .ok_or_else(|| EngineError::NotFound(index.to_string()))?;
        let mut settings = entry.settings.index;
        for key in SERVER_SETTINGS {
            settings.remove(key);
        }
        let empty = || raw(&json!({}));
        Ok(raw(&json!({
            "settings": { "index": settings },
            "mappings": entry.mappings.unwrap_or_else(empty),
            "aliases": entry.aliases.unwrap_or_else(empty),
        })))
    }

    async fn put_mapping(&self, req: &IndexRequest) -> Result<Value, EngineError> {
        let body = req
            .body
            .as_ref()
            .ok_or_else(|| bad("매핑 본문이 필요합니다"))?;
        let path = format!(
            "/{}/_mapping{}",
            target(required(&req.index)?),
            self.typeless("?")
        );
        self.write(Method::PUT, &path, Some(body.get())).await
    }

    async fn put_settings(&self, req: &IndexRequest) -> Result<Value, EngineError> {
        let body = req
            .body
            .as_ref()
            .ok_or_else(|| bad("설정 본문이 필요합니다"))?;
        let path = format!("/{}/_settings", target(required(&req.index)?));
        self.write(Method::PUT, &path, Some(body.get())).await
    }

    async fn search(&self, req: &SearchRequest) -> Result<Raw, EngineError> {
        // The body's own keys stay as written; the request's win over them.
        let mut body = raw_object(req.body.as_deref(), "검색 본문")?;
        let mut set = |key: &str, value: Option<Raw>| {
            if let Some(value) = value {
                body.insert(key.to_string(), value);
            }
        };
        set("from", req.from.map(|from| raw(&from)));
        set("size", req.size.map(|size| raw(&size)));
        set("sort", req.sort.clone());
        set("search_after", req.search_after.clone());
        set("_source", req.source.clone());
        set("highlight", req.highlight.clone());
        set("track_total_hits", req.track_total_hits.clone());
        set(
            "pit",
            req.pit.as_ref().map(|pit| {
                raw(&json!({ "id": pit.id, "keep_alive": pit.keep_alive.as_deref().unwrap_or("1m") }))
            }),
        );
        if req.profile {
            set("profile", Some(raw(&true)));
        }
        let index = req
            .index
            .as_deref()
            .map(str::trim)
            .filter(|index| !index.is_empty());
        let path = match index {
            Some(index) if req.pit.is_none() => format!("/{}/_search", target(index)),
            _ => "/_search".to_string(),
        };
        let body = serde_json::to_string(&body).expect("JSON text always serializes");
        let started = Instant::now();
        let reply = self.read_raw(Method::POST, &path, &body).await?;
        let elapsed = started.elapsed().as_secs_f64() * 1000.0;
        Ok(with_elapsed(reply, elapsed))
    }

    async fn count(&self, req: &CountRequest) -> Result<u64, EngineError> {
        let path = format!("/{}/_count", target(required(&req.index)?));
        let body = match &req.query {
            Some(query) if query.get().trim() != "null" => format!("{{\"query\":{}}}", query.get()),
            _ => "{}".to_string(),
        };
        let reply = self
            .http
            .json(Method::POST, &path, Body::Text(&body), Trace::Console, true)
            .await?;
        reply
            .get("count")
            .and_then(Value::as_u64)
            .ok_or_else(|| EngineError::Internal("count가 없는 응답입니다".into()))
    }

    async fn open_pit(&self, req: &PitOpenRequest) -> Result<String, EngineError> {
        self.require_pit()?;
        let keep_alive = Some(req.keep_alive.clone().unwrap_or_else(|| "1m".into()));
        let index = target(required(&req.index)?);
        let (path, key) = if self.opensearch() {
            (format!("/{index}/_search/point_in_time"), "pit_id")
        } else {
            (format!("/{index}/_pit"), "id")
        };
        let path = format!("{path}{}", query(&[("keep_alive", keep_alive)]));
        let reply = self
            .http
            .json(Method::POST, &path, Body::None, Trace::Console, true)
            .await?;
        reply
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| EngineError::Internal("point in time id가 없는 응답입니다".into()))
    }

    async fn close_pit(&self, id: &str) -> Result<(), EngineError> {
        self.require_pit()?;
        let (path, body) = if self.opensearch() {
            ("/_search/point_in_time", json!({ "pit_id": [id] }))
        } else {
            ("/_pit", json!({ "id": id }))
        };
        self.http
            .json(
                Method::DELETE,
                path,
                Body::Json(&body),
                Trace::Console,
                false,
            )
            .await
            .map(|_| ())
    }

    async fn get_doc(&self, req: &DocRef) -> Result<Raw, EngineError> {
        let path = format!(
            "/{}/_doc/{}{}",
            target(required(&req.index)?),
            id_segment(&req.id),
            query(&[("routing", req.routing.clone())])
        );
        let reply = self
            .http
            .send(Method::GET, &path, Body::None, Trace::Console, true)
            .await?;
        // A missing document is an answer, not an error.
        if reply.ok()
            || (reply.status == 404 && reply.value().get("found") == Some(&Value::Bool(false)))
        {
            return Ok(reply.into_raw());
        }
        Err(self.http.error(&reply))
    }

    async fn index_doc(&self, req: &IndexDocRequest) -> Result<Value, EngineError> {
        if !is_object(&req.doc) {
            return Err(bad("문서는 JSON 객체여야 합니다"));
        }
        let index = target(required(&req.index)?);
        let params = query(&[
            ("if_seq_no", req.if_seq_no.map(|n| n.to_string())),
            (
                "if_primary_term",
                req.if_primary_term.map(|n| n.to_string()),
            ),
            ("routing", req.routing.clone()),
            (
                "refresh",
                Some(req.refresh.clone().unwrap_or_else(|| "wait_for".into())),
            ),
        ]);
        let create = req.op_type.as_deref() == Some("create");
        let (method, path) = match &req.id {
            // Before 7.0 the endpoint sits under the type.
            Some(id) if create && self.typed() => (
                Method::PUT,
                format!("/{index}/_doc/{}/_create{params}", id_segment(id)),
            ),
            Some(id) if create => (
                Method::PUT,
                format!("/{index}/_create/{}{params}", id_segment(id)),
            ),
            Some(id) => (
                Method::PUT,
                format!("/{index}/_doc/{}{params}", id_segment(id)),
            ),
            None => (Method::POST, format!("/{index}/_doc{params}")),
        };
        self.write(method, &path, Some(req.doc.get())).await
    }

    async fn update_doc(&self, req: &UpdateDocRequest) -> Result<Value, EngineError> {
        if !is_object(&req.doc) {
            return Err(bad("바꿀 필드는 JSON 객체여야 합니다"));
        }
        // Before 7.0 the endpoint sits under the type: `/{index}/_doc/{id}/_update`.
        let index = target(required(&req.index)?);
        let id = id_segment(&req.id);
        let endpoint = if self.typed() {
            format!("/{index}/_doc/{id}/_update")
        } else {
            format!("/{index}/_update/{id}")
        };
        let path = format!(
            "{endpoint}{}",
            query(&[
                ("if_seq_no", req.if_seq_no.map(|n| n.to_string())),
                (
                    "if_primary_term",
                    req.if_primary_term.map(|n| n.to_string())
                ),
                ("routing", req.routing.clone()),
                (
                    "refresh",
                    Some(req.refresh.clone().unwrap_or_else(|| "wait_for".into()))
                ),
            ])
        );
        let body = format!("{{\"doc\":{}}}", req.doc.get());
        self.write(Method::POST, &path, Some(&body)).await
    }

    async fn delete_doc(&self, req: &DeleteDocRequest) -> Result<Value, EngineError> {
        let path = format!(
            "/{}/_doc/{}{}",
            target(required(&req.index)?),
            id_segment(&req.id),
            query(&[
                ("if_seq_no", req.if_seq_no.map(|n| n.to_string())),
                (
                    "if_primary_term",
                    req.if_primary_term.map(|n| n.to_string())
                ),
                ("routing", req.routing.clone()),
                (
                    "refresh",
                    Some(req.refresh.clone().unwrap_or_else(|| "wait_for".into()))
                ),
            ])
        );
        self.write(Method::DELETE, &path, None).await
    }

    async fn delete_by_query(&self, req: &ByQueryRequest) -> Result<Value, EngineError> {
        by_query(self, req, "_delete_by_query").await
    }

    async fn update_by_query(&self, req: &ByQueryRequest) -> Result<Value, EngineError> {
        by_query(self, req, "_update_by_query").await
    }

    async fn create_index(&self, req: &IndexRequest) -> Result<Value, EngineError> {
        crate::search::check_single_index(&req.index)?;
        let path = format!("/{}{}", target(&req.index), self.typeless("?"));
        self.write(Method::PUT, &path, req.body.as_deref().map(RawValue::get))
            .await
    }

    async fn delete_index(&self, req: &IndexRequest) -> Result<Value, EngineError> {
        crate::search::check_single_index(&req.index)?;
        let path = format!("/{}", target(&req.index));
        self.write(Method::DELETE, &path, None).await
    }

    async fn open_index(&self, req: &IndexRequest) -> Result<Value, EngineError> {
        let path = format!("/{}/_open", target(required(&req.index)?));
        self.write(Method::POST, &path, None).await
    }

    async fn close_index(&self, req: &IndexRequest) -> Result<Value, EngineError> {
        crate::search::check_single_index(&req.index)?;
        let path = format!("/{}/_close", target(&req.index));
        self.write(Method::POST, &path, None).await
    }

    async fn refresh_index(&self, req: &IndexRequest) -> Result<Value, EngineError> {
        let path = format!("/{}/_refresh", target(required(&req.index)?));
        self.http
            .json(Method::POST, &path, Body::None, Trace::Console, false)
            .await
    }

    async fn reindex(&self, req: &ReindexRequest) -> Result<Value, EngineError> {
        let parts = raw_object(Some(&req.body), "reindex 본문")?;
        if !parts.get("source").is_some_and(|part| is_object(part))
            || !parts.get("dest").is_some_and(|part| is_object(part))
        {
            return Err(bad("reindex 본문에는 source와 dest가 있어야 합니다"));
        }
        let path = format!(
            "/_reindex{}",
            query(&[
                ("wait_for_completion", Some(req.wait.to_string())),
                ("refresh", req.wait.then(|| "true".to_string())),
            ])
        );
        self.write(Method::POST, &path, Some(req.body.get())).await
    }

    async fn update_aliases(&self, req: &AliasesRequest) -> Result<Value, EngineError> {
        crate::search::check_alias_actions(req)?;
        let body = serde_json::to_string(&json!({ "actions": req.actions }))
            .expect("JSON text always serializes");
        self.write(Method::POST, "/_aliases", Some(&body)).await
    }

    async fn analyze(&self, req: &AnalyzeRequest) -> Result<Raw, EngineError> {
        let path = match req
            .index
            .as_deref()
            .map(str::trim)
            .filter(|index| !index.is_empty())
        {
            Some(index) => format!("/{}/_analyze", target(index)),
            None => "/_analyze".to_string(),
        };
        self.read_raw(Method::POST, &path, req.body.get()).await
    }

    async fn explain(&self, req: &ExplainDocRequest) -> Result<Raw, EngineError> {
        let index = target(required(&req.index)?);
        let id = id_segment(&req.id);
        let path = if self.typed() {
            format!("/{index}/_doc/{id}/_explain")
        } else {
            format!("/{index}/_explain/{id}")
        };
        let body = format!("{{\"query\":{}}}", req.query.get());
        self.read_raw(Method::POST, &path, &body).await
    }

    async fn validate(&self, req: &ValidateRequest) -> Result<Raw, EngineError> {
        let path = match req
            .index
            .as_deref()
            .map(str::trim)
            .filter(|index| !index.is_empty())
        {
            Some(index) => format!("/{}/_validate/query?explain=true", target(index)),
            None => "/_validate/query?explain=true".to_string(),
        };
        let body = format!("{{\"query\":{}}}", req.query.get());
        self.read_raw(Method::POST, &path, &body).await
    }

    async fn sql(&self, req: &SqlRequest) -> Result<SqlResult, EngineError> {
        let body = match (&req.cursor, &req.query) {
            (Some(cursor), _) if !cursor.is_empty() => json!({ "cursor": cursor }),
            (_, Some(query)) if !query.trim().is_empty() => {
                let mut body = json!({ "query": query });
                // Elasticsearch pages by 1,000 rows unless told; OpenSearch
                // pages only when asked (and not for every query).
                match (req.fetch_size, self.opensearch()) {
                    (Some(size), _) => body["fetch_size"] = json!(size),
                    (None, false) => body["fetch_size"] = json!(1000),
                    (None, true) => {}
                }
                body
            }
            _ => return Err(bad("SQL 문이 필요합니다")),
        };
        let path = if self.opensearch() {
            "/_plugins/_sql?format=jdbc".to_string()
        } else {
            format!("{}?format=json", self.sql_path())
        };
        #[derive(serde::Deserialize)]
        struct Page {
            #[serde(default, alias = "schema")]
            columns: Vec<Value>,
            #[serde(default, alias = "datarows")]
            rows: Vec<Raw>,
            #[serde(default)]
            cursor: Option<String>,
        }
        let started = Instant::now();
        let reply = self
            .http
            .raw(Method::POST, &path, Body::Json(&body), Trace::Console, true)
            .await?;
        let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
        // Rows stay as the server wrote them; only the columns are read.
        let page: Page = serde_json::from_str(reply.get())
            .map_err(|err| EngineError::Internal(format!("SQL 응답을 읽을 수 없습니다: {err}")))?;
        let column = |entry: &Value| SqlColumn {
            name: entry
                .get("alias")
                .or_else(|| entry.get("name"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            kind: entry
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        };
        Ok(SqlResult {
            columns: page.columns.iter().map(column).collect(),
            rows: page.rows,
            cursor: page.cursor.filter(|cursor| !cursor.is_empty()),
            elapsed_ms,
        })
    }

    async fn sql_close(&self, cursor: &str) -> Result<(), EngineError> {
        let path = format!("{}/close", self.sql_path());
        self.http
            .json(
                Method::POST,
                &path,
                Body::Json(&json!({ "cursor": cursor })),
                Trace::Console,
                false,
            )
            .await
            .map(|_| ())
    }

    async fn sql_translate(&self, query: &str) -> Result<Raw, EngineError> {
        let path = if self.opensearch() {
            "/_plugins/_sql/_explain".to_string()
        } else {
            format!("{}/translate", self.sql_path())
        };
        let body =
            serde_json::to_string(&json!({ "query": query })).expect("JSON text always serializes");
        self.read_raw(Method::POST, &path, &body).await
    }

    async fn console(
        &self,
        req: &ConsoleRequest,
        class: &Classified,
    ) -> Result<ConsoleReply, EngineError> {
        let method = Method::from_bytes(req.method.trim().to_ascii_uppercase().as_bytes())
            .map_err(|_| bad(format!("지원하지 않는 메서드입니다: {}", req.method)))?;
        let lines = req.path.contains("_bulk")
            || req.path.contains("_msearch")
            || req.path.contains("_mtermvectors");
        // A JSON string is the text the user typed (NDJSON, or JSON the
        // server should judge); any other JSON goes exactly as it came.
        let typed: Option<String> = req
            .body
            .as_deref()
            .filter(|body| body.get().trim_start().starts_with('"'))
            .and_then(|body| serde_json::from_str(body.get()).ok());
        let body = match (&req.body, typed) {
            _ if method == Method::HEAD => Body::None,
            (None, _) => Body::None,
            (Some(raw), _) if raw.get().trim() == "null" => Body::None,
            (_, Some(text)) if text.trim().is_empty() => Body::None,
            (_, Some(text)) if lines => Body::Lines(text),
            (_, Some(text)) => Body::Owned(text),
            (Some(raw), None) => Body::Text(raw.get()),
        };
        let writes = class.class != RequestClass::Read;
        let text = writes.then(|| console_text(&method, &req.path, &body));
        let reply = self
            .http
            .send(method, &req.path, body, Trace::Console, !writes)
            .await?;
        if let Some(text) = text.filter(|_| reply.ok()) {
            self.http.changed(text, reply.elapsed_ms, 1);
        }
        Ok(ConsoleReply {
            status: reply.status,
            content_type: reply.content_type.clone(),
            elapsed_ms: reply.elapsed_ms,
            class: class.class,
            body: reply.into_raw(),
        })
    }

    async fn bulk(&self, req: &BulkRequest, body: String) -> Result<Value, EngineError> {
        if body.trim().is_empty() {
            return Err(bad("bulk 본문이 비어 있습니다"));
        }
        if console::ndjson_deletes(&body) {
            crate::search::check_confirmed(req.confirmed, "delete 동작이 있는 bulk는")?;
        }
        let index = req
            .index
            .as_deref()
            .map(str::trim)
            .filter(|index| !index.is_empty());
        let path = format!(
            "{}{}",
            match index {
                // Before 7.0 the type `_doc` is the lines' default too.
                Some(index) if self.typed() => format!("/{}/_doc/_bulk", target(index)),
                Some(index) => format!("/{}/_bulk", target(index)),
                None => "/_bulk".to_string(),
            },
            query(&[("refresh", req.refresh.clone())])
        );
        let body = if self.typed() && index.is_none() {
            Body::Lines(console::typed_bulk(&body))
        } else {
            Body::Lines(body)
        };
        let text = console_text(&Method::POST, &path, &body);
        let reply = self
            .http
            .send(Method::POST, &path, body, Trace::Console, false)
            .await?;
        if !reply.ok() {
            return Err(self.http.error(&reply));
        }
        let summary = bulk_summary(&reply.value());
        let count = summary["count"].as_u64().unwrap_or(0);
        let failed = summary["failed"].as_u64().unwrap_or(0);
        if count > failed {
            self.http.changed(text, reply.elapsed_ms, count - failed);
        }
        Ok(summary)
    }

    async fn export(&self, req: &SearchExportRequest) -> Result<RawStream, EngineError> {
        let index = required(&req.index)?.to_string();
        let mut cursor = Export {
            http: self.http.clone(),
            opensearch: self.opensearch(),
            pit: self.has_pit() && !self.opensearch(),
            index,
            query: req
                .query
                .clone()
                .filter(|query| query.get().trim() != "null"),
            sort: req.sort.clone().filter(|sort| sort.get().trim() != "null"),
            source: req.source.clone(),
            remaining: req.limit.filter(|limit| *limit > 0),
            open: Open::None,
            search_after: None,
            buffer: VecDeque::new(),
            done: false,
        };
        // The first page now: a wrong query fails the request itself.
        cursor.fill().await?;
        let stream = futures_util::stream::unfold(cursor, |mut cursor| async move {
            if cursor.buffer.is_empty() && !cursor.done {
                if let Err(err) = cursor.fill().await {
                    cursor.done = true;
                    return Some((Err(err), cursor));
                }
            }
            let hit = cursor.buffer.pop_front()?;
            Some((Ok(hit), cursor))
        });
        Ok(Box::pin(stream))
    }

    async fn tasks(&self, actions: Option<&str>) -> Result<Vec<Value>, EngineError> {
        let path = format!(
            "/_tasks?detailed=true{}",
            match actions.map(str::trim).filter(|actions| !actions.is_empty()) {
                Some(actions) => format!("&actions={}", encode(actions, b",*:")),
                None => String::new(),
            }
        );
        let listing = self.get(&path, Trace::Quiet).await?;
        Ok(flatten_tasks(&listing))
    }

    async fn cancel_task(&self, id: &str) -> Result<Value, EngineError> {
        let id = id.trim();
        if id.is_empty() || !id.contains(':') {
            return Err(bad(format!("작업 ID가 올바르지 않습니다: {id}")));
        }
        let path = format!("/_tasks/{}/_cancel", id_segment(id));
        self.write(Method::POST, &path, None).await
    }

    async fn hot_threads(
        &self,
        threads: Option<u32>,
        interval: Option<&str>,
    ) -> Result<String, EngineError> {
        let path = format!(
            "/_nodes/hot_threads{}",
            query(&[
                ("threads", threads.map(|n| n.to_string())),
                ("interval", interval.map(str::to_string)),
            ])
        );
        let reply = self
            .http
            .send(Method::GET, &path, Body::None, Trace::Quiet, false)
            .await?;
        if !reply.ok() {
            return Err(self.http.error(&reply));
        }
        Ok(String::from_utf8_lossy(&reply.bytes).into_owned())
    }

    async fn shards(&self, index: Option<&str>) -> Result<Value, EngineError> {
        let path = match index.map(str::trim).filter(|index| !index.is_empty()) {
            Some(index) => format!("/_cat/shards/{}", target(index)),
            None => "/_cat/shards".to_string(),
        };
        let rows = self
            .get(
                &format!("{path}?format=json&bytes=b&h={SHARD_COLUMNS}"),
                Trace::Quiet,
            )
            .await?;
        let rows: Vec<Value> = rows
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .map(|row| {
                let mut row = row.clone();
                for key in ["shard", "docs", "store"] {
                    let number = cat_number(row.get(key));
                    row[key] = number;
                }
                row
            })
            .collect();
        Ok(Value::Array(rows))
    }

    async fn privileges(&self, index: Option<&str>) -> Result<Value, EngineError> {
        const INDEX_PRIVILEGES: [&str; 5] =
            ["read", "write", "create_index", "delete_index", "manage"];
        let all = |allowed: bool| {
            json!({
                "known": true,
                "cluster": { "monitor": allowed, "manage": allowed },
                "index": INDEX_PRIVILEGES.iter().map(|name| (name.to_string(), json!(allowed))).collect::<Map<_, _>>(),
            })
        };
        let unknown = json!({ "known": false, "cluster": {}, "index": {} });
        let index = index
            .map(str::trim)
            .filter(|index| !index.is_empty())
            .unwrap_or("*");
        if self.opensearch() {
            // The security plugin names roles, not privileges: only its
            // `all_access` role says for sure.
            let reply = self
                .http
                .send(
                    Method::GET,
                    "/_plugins/_security/api/account",
                    Body::None,
                    Trace::Quiet,
                    false,
                )
                .await?;
            return Ok(match reply.status {
                200 => {
                    let roles = reply.value();
                    let admin = roles
                        .get("roles")
                        .and_then(Value::as_array)
                        .is_some_and(|roles| roles.iter().any(|role| role == "all_access"));
                    if admin {
                        all(true)
                    } else {
                        unknown
                    }
                }
                // No security plugin: everyone may do everything.
                400 | 404 => all(true),
                _ => unknown,
            });
        }
        let body = json!({
            "cluster": ["monitor", "manage"],
            "index": [{ "names": [index], "privileges": INDEX_PRIVILEGES }],
        });
        let reply = self
            .http
            .send(
                Method::POST,
                "/_security/user/_has_privileges",
                Body::Json(&body),
                Trace::Quiet,
                false,
            )
            .await?;
        if !reply.ok() {
            let text = String::from_utf8_lossy(&reply.bytes).to_lowercase();
            // Security switched off: no user, no limits.
            let disabled = text.contains("security")
                && (text.contains("not enabled") || text.contains("disabled"));
            return Ok(if disabled { all(true) } else { unknown });
        }
        let reply = reply.value();
        let flag = |value: Option<&Value>| value.and_then(Value::as_bool).unwrap_or(false);
        let index_rights = reply
            .pointer("/index")
            .and_then(Value::as_object)
            .and_then(|map| map.values().next());
        Ok(json!({
            "known": true,
            "cluster": {
                "monitor": flag(reply.pointer("/cluster/monitor")),
                "manage": flag(reply.pointer("/cluster/manage")),
            },
            "index": INDEX_PRIVILEGES
                .iter()
                .map(|name| (name.to_string(), json!(flag(index_rights.and_then(|rights| rights.get(*name))))))
                .collect::<Map<_, _>>(),
        }))
    }

    async fn stop(&self) -> Result<Value, EngineError> {
        let Some(request) = self.http.stop() else {
            return Ok(json!({ "stopped": false, "cancelled": [], "running": [] }));
        };
        // A read's tasks are cancelled; a write's are left to the user, who
        // sees them still running.
        let mut report = settle_tagged(&self.http, &request.tag, request.read).await;
        report["stopped"] = json!(true);
        report["request"] = json!(request.text);
        Ok(report)
    }

    async fn security(&self) -> Result<Value, EngineError> {
        self.security_overview().await
    }

    async fn security_list(&self, kind: SecurityKind) -> Result<Value, EngineError> {
        self.security_entries(kind).await
    }

    async fn security_put(&self, req: &SecurityPutRequest) -> Result<Value, EngineError> {
        self.put_entry(req).await
    }

    async fn security_delete(&self, req: &SecurityDeleteRequest) -> Result<Value, EngineError> {
        self.delete_entries(req).await
    }

    async fn user_password(&self, req: &UserPasswordRequest) -> Result<Value, EngineError> {
        self.set_password(req).await
    }

    async fn user_enabled(&self, req: &UserEnabledRequest) -> Result<Value, EngineError> {
        self.set_enabled(req).await
    }

    async fn create_api_key(&self, req: &ApiKeyRequest) -> Result<Value, EngineError> {
        self.new_api_key(req).await
    }
}

/// `_delete_by_query` or `_update_by_query`.
async fn by_query(
    driver: &SearchEngineDriver,
    req: &ByQueryRequest,
    endpoint: &str,
) -> Result<Value, EngineError> {
    crate::search::check_confirmed(
        req.confirmed,
        "조건에 맞는 문서를 한꺼번에 바꾸거나 지우려면",
    )?;
    if let Some(conflicts) = req.conflicts.as_deref() {
        if !matches!(conflicts, "abort" | "proceed") {
            return Err(bad("conflicts는 abort 또는 proceed입니다"));
        }
    }
    let given = |raw: &Option<Raw>| raw.clone().filter(|raw| raw.get().trim() != "null");
    let mut body = std::collections::BTreeMap::new();
    body.insert(
        "query",
        given(&req.query).unwrap_or_else(|| raw(&json!({ "match_all": {} }))),
    );
    if endpoint == "_update_by_query" {
        if let Some(script) = given(&req.script) {
            body.insert("script", script);
        }
    }
    let body = serde_json::to_string(&body).expect("JSON text always serializes");
    let path = format!(
        "/{}/{endpoint}{}",
        target(required(&req.index)?),
        query(&[
            ("conflicts", req.conflicts.clone()),
            ("max_docs", req.max_docs.map(|n| n.to_string())),
            ("refresh", req.refresh.map(|refresh| refresh.to_string())),
        ])
    );
    driver.write(Method::POST, &path, Some(&body)).await
}

/// What an export holds open on the server.
enum Open {
    None,
    Pit(String),
    Scroll(String),
}

/// An export reading page by page: a point in time read with
/// `search_after` (Elasticsearch 7.10 and later), else a scroll.
struct Export {
    http: Arc<Http>,
    opensearch: bool,
    pit: bool,
    index: String,
    query: Option<Raw>,
    sort: Option<Raw>,
    source: Option<Raw>,
    /// Hits still to read; None for all.
    remaining: Option<u64>,
    open: Open,
    search_after: Option<Raw>,
    buffer: VecDeque<Raw>,
    done: bool,
}

impl Export {
    /// Reads the next page into the buffer, or notes that there is none.
    async fn fill(&mut self) -> Result<(), EngineError> {
        let size = self
            .remaining
            .map_or(EXPORT_PAGE, |left| left.min(EXPORT_PAGE));
        if size == 0 {
            self.done = true;
            return Ok(());
        }
        let first = matches!(self.open, Open::None);
        // Only the first request goes to the console.
        let trace = if first { Trace::Console } else { Trace::Quiet };
        let mut body: std::collections::BTreeMap<&str, Raw> = std::collections::BTreeMap::new();
        body.insert("size", raw(&size));
        if let Some(query) = &self.query {
            body.insert("query", query.clone());
        }
        if let Some(source) = &self.source {
            body.insert("_source", source.clone());
        }
        let reply = if self.pit {
            if first {
                let path = format!(
                    "/{}/_pit?keep_alive={EXPORT_KEEP_ALIVE}",
                    target(&self.index)
                );
                let opened = self
                    .http
                    .json(Method::POST, &path, Body::None, Trace::Console, false)
                    .await?;
                let id = opened.get("id").and_then(Value::as_str).ok_or_else(|| {
                    EngineError::Internal("point in time id가 없는 응답입니다".into())
                })?;
                self.open = Open::Pit(id.to_string());
            }
            let Open::Pit(id) = &self.open else {
                unreachable!("opened above")
            };
            let mut sort: Vec<Raw> = match &self.sort {
                Some(sort) => {
                    serde_json::from_str(sort.get()).unwrap_or_else(|_| vec![sort.clone()])
                }
                None => Vec::new(),
            };
            sort.push(raw(&json!({ "_shard_doc": "asc" })));
            body.insert("sort", raw(&sort));
            body.insert(
                "pit",
                raw(&json!({ "id": id, "keep_alive": EXPORT_KEEP_ALIVE })),
            );
            body.insert("track_total_hits", raw(&false));
            if let Some(after) = &self.search_after {
                body.insert("search_after", after.clone());
            }
            let body = serde_json::to_string(&body).expect("JSON text always serializes");
            self.http
                .raw(Method::POST, "/_search", Body::Text(&body), trace, false)
                .await?
        } else if let Open::Scroll(id) = &self.open {
            let body = json!({ "scroll": EXPORT_KEEP_ALIVE, "scroll_id": id });
            self.http
                .raw(
                    Method::POST,
                    "/_search/scroll",
                    Body::Json(&body),
                    trace,
                    false,
                )
                .await?
        } else {
            body.insert(
                "sort",
                self.sort.clone().unwrap_or_else(|| raw(&json!(["_doc"]))),
            );
            let body = serde_json::to_string(&body).expect("JSON text always serializes");
            let path = format!(
                "/{}/_search?scroll={EXPORT_KEEP_ALIVE}",
                target(&self.index)
            );
            self.http
                .raw(Method::POST, &path, Body::Text(&body), trace, false)
                .await?
        };
        // The hits' `_source` and `sort` stay as the server wrote them.
        #[derive(serde::Deserialize)]
        struct Page {
            pit_id: Option<String>,
            _scroll_id: Option<String>,
            hits: Hits,
        }
        #[derive(serde::Deserialize)]
        struct Hits {
            hits: Vec<Hit>,
        }
        #[derive(serde::Deserialize, serde::Serialize)]
        struct Hit {
            _index: String,
            _id: String,
            #[serde(default)]
            _source: Option<Raw>,
            #[serde(default, skip_serializing)]
            sort: Option<Raw>,
        }
        let page: Page = serde_json::from_str(reply.get())
            .map_err(|err| EngineError::Internal(format!("검색 응답을 읽을 수 없습니다: {err}")))?;
        match (self.pit, page.pit_id, page._scroll_id) {
            (true, Some(id), _) => self.open = Open::Pit(id),
            (false, _, Some(id)) => self.open = Open::Scroll(id),
            _ => {}
        }
        let mut hits = page.hits.hits;
        if hits.is_empty() {
            self.done = true;
            return Ok(());
        }
        // A scroll's later pages are as large as its first; a limit may
        // end inside one.
        let take = self
            .remaining
            .map_or(hits.len(), |left| left.min(hits.len() as u64) as usize);
        self.search_after = hits.last_mut().and_then(|hit| hit.sort.take());
        for mut hit in hits.into_iter().take(take) {
            hit._source.get_or_insert_with(|| raw(&Value::Null));
            self.buffer.push_back(raw(&hit));
        }
        if let Some(left) = self.remaining.as_mut() {
            *left -= take as u64;
            if *left == 0 {
                self.done = true;
            }
        }
        Ok(())
    }
}

/// Lets go of the point in time or scroll once the export is done or the
/// page went away.
impl Drop for Export {
    fn drop(&mut self) {
        let open = std::mem::replace(&mut self.open, Open::None);
        let (path, body) = match open {
            Open::None => return,
            Open::Pit(id) if self.opensearch => {
                ("/_search/point_in_time", json!({ "pit_id": [id] }))
            }
            Open::Pit(id) => ("/_pit", json!({ "id": id })),
            Open::Scroll(id) => ("/_search/scroll", json!({ "scroll_id": [id] })),
        };
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            return;
        };
        let http = self.http.clone();
        runtime.spawn(async move {
            let _ = http
                .send(Method::DELETE, path, Body::Json(&body), Trace::Quiet, false)
                .await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_segments_and_query_strings_are_encoded() {
        assert_eq!(target("shop,logs-*"), "shop,logs-*");
        assert_eq!(target("a b#c"), "a%20b%23c");
        assert_eq!(id_segment("a/b?c"), "a%2Fb%3Fc");
        assert_eq!(id_segment("한"), "%ED%95%9C");
        assert_eq!(
            query(&[
                ("a", Some("1".into())),
                ("b", None),
                ("c", Some("x y".into()))
            ]),
            "?a=1&c=x%20y"
        );
        assert_eq!(query(&[("a", None)]), "");
    }

    #[test]
    fn bulk_replies_are_summarized_with_positions() {
        let reply = json!({
            "took": 5, "errors": true,
            "items": [
                { "index": { "_index": "s", "_id": "1", "status": 201 } },
                { "create": { "_index": "s", "_id": "2", "status": 409,
                    "error": { "type": "version_conflict_engine_exception", "reason": "exists" } } },
            ]
        });
        let summary = bulk_summary(&reply);
        assert_eq!(summary["count"], 2);
        assert_eq!(summary["failed"], 1);
        assert_eq!(summary["failures"][0]["position"], 1);
        assert_eq!(
            summary["failures"][0]["type"],
            "version_conflict_engine_exception"
        );
    }

    #[test]
    fn tasks_flatten_from_nodes_and_carry_their_tag() {
        let listing = json!({ "nodes": { "n1": { "tasks": {
            "n1:7": { "node": "n1", "id": 7, "action": "indices:data/read/search",
                      "running_time_in_nanos": 5_000_000, "cancellable": true,
                      "headers": { "X-Opaque-Id": "tablepeek:3" } },
            "n1:8": { "node": "n1", "id": 8, "action": "cluster:monitor/tasks/lists",
                      "running_time_in_nanos": 1_000_000, "cancellable": false, "headers": {} }
        } } } });
        let tasks = flatten_tasks(&listing);
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0]["id"], "n1:7");
        assert_eq!(tasks[0]["running_time_ms"], 5);
        assert_eq!(tasks[0]["opaque_id"], "tablepeek:3");
        assert_eq!(tasks[1]["opaque_id"], Value::Null);
    }

    #[test]
    fn perf_sums_nodes_and_averages_cpu() {
        let stats = json!({ "nodes": {
            "a": { "indices": { "search": { "query_total": 3 } }, "os": { "cpu": { "percent": 10 } },
                   "jvm": { "mem": { "heap_used_in_bytes": 5 } } },
            "b": { "indices": { "search": { "query_total": 4 } }, "os": { "cpu": { "percent": 30 } },
                   "jvm": { "mem": { "heap_used_in_bytes": 7 } } }
        } });
        let perf = perf_totals(&stats);
        assert_eq!(perf["nodes"], 2);
        assert_eq!(perf["search"]["query_total"], 7);
        assert_eq!(perf["heap_used_bytes"], 12);
        assert_eq!(perf["cpu_percent"], 20.0);
    }
}
