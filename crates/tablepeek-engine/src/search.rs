//! The operations of a search engine (Elasticsearch, OpenSearch): indices
//! rather than tables or collections, queries as JSON, documents by `_id`.
//! An engine of this paradigm answers `Driver::search()` with itself. The
//! request and reply shapes are the `/api/search/*` bodies
//! (docs/engines/elasticsearch.md §4). Documents, queries and the server's
//! replies pass through as the JSON text they came as (`Raw`): a number past
//! i64/u64 or written `1.10` reaches the other side byte for byte, never
//! through f64.

use std::collections::BTreeMap;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::Value;

use crate::EngineError;

/// JSON kept as the text it came as.
pub type Raw = Box<RawValue>;

/// Hits read one by one, each as its JSON text.
pub type RawStream = futures_util::stream::BoxStream<'static, Result<Raw, EngineError>>;

/// `value` as JSON text.
pub fn raw(value: &impl Serialize) -> Raw {
    serde_json::value::to_raw_value(value).expect("JSON values always serialize")
}

/// JSON text the server or the page sent, kept as it is.
pub fn raw_text(text: String) -> Result<Raw, EngineError> {
    RawValue::from_string(text)
        .map_err(|err| EngineError::Internal(format!("JSON이 아닌 응답입니다: {err}")))
}

/// The top-level keys of a JSON object, each value kept as its text; none
/// for null or absent. `what` names it in the error for anything else.
pub fn raw_object(
    raw: Option<&RawValue>,
    what: &str,
) -> Result<BTreeMap<String, Raw>, EngineError> {
    let Some(raw) = raw.filter(|raw| raw.get().trim() != "null") else {
        return Ok(BTreeMap::new());
    };
    serde_json::from_str(raw.get())
        .map_err(|_| EngineError::BadRequest(format!("{what}은 JSON 객체여야 합니다")))
}

/// Whether `raw` is a JSON object.
pub fn is_object(raw: &RawValue) -> bool {
    raw.get().trim_start().starts_with('{')
}

#[async_trait]
pub trait SearchDriver: Send + Sync {
    /// What the server said it is once connected ("elasticsearch",
    /// "opensearch"), which may differ from the engine the profile names.
    fn flavor(&self) -> &'static str;

    /// How a raw request of the console would act; an error for one the
    /// console may not send at all (a URL instead of a path, say).
    fn classify(
        &self,
        method: &str,
        path: &str,
        body: Option<&RawValue>,
    ) -> Result<Classified, EngineError>;

    /// The root endpoint and the cluster's health.
    async fn cluster(&self) -> Result<Value, EngineError>;
    async fn nodes(&self) -> Result<Value, EngineError>;
    /// Totals over the nodes' stats for the performance tab; not logged.
    async fn perf(&self) -> Result<Value, EngineError>;
    async fn indices(&self, hidden: bool) -> Result<Vec<Value>, EngineError>;
    async fn aliases(&self) -> Result<Vec<AliasInfo>, EngineError>;
    async fn data_streams(&self) -> Result<Value, EngineError>;
    async fn mapping(&self, index: &str) -> Result<Raw, EngineError>;
    async fn settings(&self, index: &str, defaults: bool) -> Result<Raw, EngineError>;
    /// The body that would create `index` again: its settings (without
    /// the ones the server sets), mappings and aliases.
    async fn definition(&self, index: &str) -> Result<Raw, EngineError>;
    async fn put_mapping(&self, req: &IndexRequest) -> Result<Value, EngineError>;
    async fn put_settings(&self, req: &IndexRequest) -> Result<Value, EngineError>;

    /// The server's reply, `elapsed_ms` added.
    async fn search(&self, req: &SearchRequest) -> Result<Raw, EngineError>;
    async fn count(&self, req: &CountRequest) -> Result<u64, EngineError>;
    /// A point in time's id.
    async fn open_pit(&self, req: &PitOpenRequest) -> Result<String, EngineError>;
    async fn close_pit(&self, id: &str) -> Result<(), EngineError>;

    async fn get_doc(&self, req: &DocRef) -> Result<Raw, EngineError>;
    /// Stores a whole document; with `if_seq_no`/`if_primary_term` only if
    /// nobody changed it since it was read (else a version conflict).
    async fn index_doc(&self, req: &IndexDocRequest) -> Result<Value, EngineError>;
    async fn update_doc(&self, req: &UpdateDocRequest) -> Result<Value, EngineError>;
    async fn delete_doc(&self, req: &DeleteDocRequest) -> Result<Value, EngineError>;
    /// `_delete_by_query`; checked by `check_confirmed` first.
    async fn delete_by_query(&self, req: &ByQueryRequest) -> Result<Value, EngineError>;
    async fn update_by_query(&self, req: &ByQueryRequest) -> Result<Value, EngineError>;

    async fn create_index(&self, req: &IndexRequest) -> Result<Value, EngineError>;
    async fn delete_index(&self, req: &IndexRequest) -> Result<Value, EngineError>;
    async fn open_index(&self, req: &IndexRequest) -> Result<Value, EngineError>;
    async fn close_index(&self, req: &IndexRequest) -> Result<Value, EngineError>;
    async fn refresh_index(&self, req: &IndexRequest) -> Result<Value, EngineError>;
    async fn reindex(&self, req: &ReindexRequest) -> Result<Value, EngineError>;
    async fn update_aliases(&self, req: &AliasesRequest) -> Result<Value, EngineError>;

    async fn analyze(&self, req: &AnalyzeRequest) -> Result<Raw, EngineError>;
    async fn explain(&self, req: &ExplainDocRequest) -> Result<Raw, EngineError>;
    async fn validate(&self, req: &ValidateRequest) -> Result<Raw, EngineError>;

    /// A SQL query (or the next page of one) as columns and rows.
    async fn sql(&self, req: &SqlRequest) -> Result<SqlResult, EngineError>;
    async fn sql_close(&self, cursor: &str) -> Result<(), EngineError>;
    /// The query the SQL becomes.
    async fn sql_translate(&self, query: &str) -> Result<Raw, EngineError>;

    /// A raw request as the console sends it, already checked by
    /// `classify` (and confirmed where it is dangerous). An error status is
    /// a reply like any other; only a request that got no answer fails.
    async fn console(
        &self,
        req: &ConsoleRequest,
        class: &Classified,
    ) -> Result<ConsoleReply, EngineError>;
    /// A `_bulk` body as given (NDJSON).
    async fn bulk(&self, req: &BulkRequest, body: String) -> Result<Value, EngineError>;
    /// Every hit of a query, one by one, read a page at a time as the
    /// stream is consumed; dropping it lets go of the server's cursor.
    async fn export(&self, req: &SearchExportRequest) -> Result<RawStream, EngineError>;

    async fn tasks(&self, actions: Option<&str>) -> Result<Vec<Value>, EngineError>;
    async fn cancel_task(&self, id: &str) -> Result<Value, EngineError>;
    async fn hot_threads(
        &self,
        threads: Option<u32>,
        interval: Option<&str>,
    ) -> Result<String, EngineError>;
    async fn shards(&self, index: Option<&str>) -> Result<Value, EngineError>;
    /// What the user may do, cluster-wide and on `index`: `{ known,
    /// cluster: { monitor, manage }, index: { read, write, create_index,
    /// delete_index, manage } }`. `known: false` when the server can't say.
    async fn privileges(&self, index: Option<&str>) -> Result<Value, EngineError>;

    /// The page's Stop: stops waiting for the read it waits on and asks the
    /// server about the tasks of the page's latest request whose reply
    /// never came: a read's are cancelled, and what still runs (a write, a
    /// task the server can't cancel) is answered with the related tasks
    /// that can be: `{ stopped, request, cancelled, running }`.
    async fn stop(&self) -> Result<Value, EngineError>;

    /// Whether the server has security on and what of it the screens can
    /// manage: `{ flavor, enabled, reason, user, manage, kinds }`.
    async fn security(&self) -> Result<Value, EngineError>;
    /// The users, roles, role mappings or API keys, one object each.
    async fn security_list(&self, kind: SecurityKind) -> Result<Value, EngineError>;
    async fn security_put(&self, req: &SecurityPutRequest) -> Result<Value, EngineError>;
    async fn security_delete(&self, req: &SecurityDeleteRequest) -> Result<Value, EngineError>;
    async fn user_password(&self, req: &UserPasswordRequest) -> Result<Value, EngineError>;
    async fn user_enabled(&self, req: &UserEnabledRequest) -> Result<Value, EngineError>;
    /// The new key as the server answers it once (with its secret).
    async fn create_api_key(&self, req: &ApiKeyRequest) -> Result<Value, EngineError>;
}

/// What a console request does: reads, changes something, or deletes,
/// closes or rewrites in a way that is hard to take back.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RequestClass {
    Read,
    Write,
    Danger,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Classified {
    pub class: RequestClass,
    /// Why, in a few words ("_delete_by_query").
    pub reason: String,
}

/// One alias of one index.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AliasInfo {
    pub alias: String,
    pub index: String,
    pub filter: Option<Raw>,
    pub index_routing: Option<String>,
    pub search_routing: Option<String>,
    pub is_write_index: Option<bool>,
    pub is_hidden: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SearchRequest {
    #[serde(default)]
    pub index: Option<String>,
    /// The Query DSL body; the keys below win over its own.
    #[serde(default)]
    pub body: Option<Raw>,
    #[serde(default)]
    pub from: Option<u64>,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub sort: Option<Raw>,
    #[serde(default)]
    pub search_after: Option<Raw>,
    /// `_source`: a bool, a field list or `{ includes, excludes }`.
    #[serde(default)]
    pub source: Option<Raw>,
    #[serde(default)]
    pub highlight: Option<Raw>,
    #[serde(default)]
    pub track_total_hits: Option<Raw>,
    #[serde(default)]
    pub pit: Option<PitRef>,
    #[serde(default)]
    pub profile: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PitRef {
    pub id: String,
    #[serde(default)]
    pub keep_alive: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CountRequest {
    pub index: String,
    #[serde(default)]
    pub query: Option<Raw>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PitOpenRequest {
    pub index: String,
    #[serde(default)]
    pub keep_alive: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PitCloseRequest {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DocRef {
    pub index: String,
    pub id: String,
    #[serde(default)]
    pub routing: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexDocRequest {
    pub index: String,
    /// None lets the server pick one.
    #[serde(default)]
    pub id: Option<String>,
    pub doc: Raw,
    /// "index" (replace or create) or "create" (fail if it exists).
    #[serde(default)]
    pub op_type: Option<String>,
    #[serde(default)]
    pub if_seq_no: Option<i64>,
    #[serde(default)]
    pub if_primary_term: Option<i64>,
    #[serde(default)]
    pub routing: Option<String>,
    /// "true", "false" or "wait_for" (the default).
    #[serde(default)]
    pub refresh: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdateDocRequest {
    pub index: String,
    pub id: String,
    /// The fields to change, merged into the stored document.
    pub doc: Raw,
    #[serde(default)]
    pub if_seq_no: Option<i64>,
    #[serde(default)]
    pub if_primary_term: Option<i64>,
    #[serde(default)]
    pub routing: Option<String>,
    #[serde(default)]
    pub refresh: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeleteDocRequest {
    pub index: String,
    pub id: String,
    #[serde(default)]
    pub if_seq_no: Option<i64>,
    #[serde(default)]
    pub if_primary_term: Option<i64>,
    #[serde(default)]
    pub routing: Option<String>,
    #[serde(default)]
    pub refresh: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ByQueryRequest {
    pub index: String,
    #[serde(default)]
    pub query: Option<Raw>,
    /// For an update: the script each document goes through.
    #[serde(default)]
    pub script: Option<Raw>,
    #[serde(default)]
    pub confirmed: bool,
    /// "abort" (the default) or "proceed" past version conflicts.
    #[serde(default)]
    pub conflicts: Option<String>,
    #[serde(default)]
    pub max_docs: Option<u64>,
    #[serde(default)]
    pub refresh: Option<bool>,
}

/// An index to create (with `body`: settings, mappings, aliases), drop,
/// open, close or refresh, or whose mapping or settings `body` changes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IndexRequest {
    pub index: String,
    #[serde(default)]
    pub body: Option<Raw>,
    #[serde(default)]
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReindexRequest {
    /// The `_reindex` body: `source`, `dest`, and the rest.
    pub body: Raw,
    #[serde(default)]
    pub confirmed: bool,
    /// Wait for it to finish (the default), or answer its task at once.
    #[serde(default = "yes")]
    pub wait: bool,
}

fn yes() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AliasesRequest {
    pub actions: Vec<Raw>,
    #[serde(default)]
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalyzeRequest {
    #[serde(default)]
    pub index: Option<String>,
    pub body: Raw,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExplainDocRequest {
    pub index: String,
    pub id: String,
    pub query: Raw,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValidateRequest {
    #[serde(default)]
    pub index: Option<String>,
    pub query: Raw,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlRequest {
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub fetch_size: Option<u32>,
    /// The next page of an earlier query; `query` is then left out.
    #[serde(default)]
    pub cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlColumn {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlResult {
    pub columns: Vec<SqlColumn>,
    /// Each row as its JSON array text.
    pub rows: Vec<Raw>,
    /// Where the next page starts; None on the last.
    pub cursor: Option<String>,
    pub elapsed_ms: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlCursorRequest {
    pub cursor: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SqlTranslateRequest {
    pub query: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsoleRequest {
    pub method: String,
    /// A path with its query string (`/shop/_search?size=5`).
    pub path: String,
    /// JSON, or a string of NDJSON lines (`_bulk`, `_msearch`).
    #[serde(default)]
    pub body: Option<Raw>,
    #[serde(default)]
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsoleReply {
    pub status: u16,
    /// JSON when the reply is JSON (as it came), else its text as a string.
    pub body: Raw,
    pub content_type: String,
    pub elapsed_ms: f64,
    pub class: RequestClass,
}

/// `/api/search/bulk`'s query: the default index of the lines, how to
/// refresh, and the confirmation a body with deletes needs.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct BulkRequest {
    #[serde(default)]
    pub index: Option<String>,
    #[serde(default)]
    pub refresh: Option<String>,
    #[serde(default)]
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchExportRequest {
    pub index: String,
    #[serde(default)]
    pub query: Option<Raw>,
    #[serde(default)]
    pub sort: Option<Raw>,
    #[serde(default)]
    pub source: Option<Raw>,
    /// The most hits; none or 0 for all.
    #[serde(default)]
    pub limit: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskCancelRequest {
    pub id: String,
    #[serde(default)]
    pub confirmed: bool,
}

/// What the security screens manage: the users, roles and role mappings of
/// Elasticsearch security or the OpenSearch security plugin, and API keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SecurityKind {
    Users,
    Roles,
    RoleMappings,
    ApiKeys,
}

/// Creates or replaces one user, role or role mapping with `body` as the
/// server takes it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecurityPutRequest {
    pub kind: SecurityKind,
    pub name: String,
    pub body: Raw,
    #[serde(default)]
    pub confirmed: bool,
}

/// Deletes users, roles or role mappings by name, or invalidates API keys
/// by id.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecurityDeleteRequest {
    pub kind: SecurityKind,
    pub names: Vec<String>,
    #[serde(default)]
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserPasswordRequest {
    pub name: String,
    pub password: String,
    #[serde(default)]
    pub confirmed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserEnabledRequest {
    pub name: String,
    pub enabled: bool,
    #[serde(default)]
    pub confirmed: bool,
}

/// A new API key: `body` as the server takes it (`name`, `expiration`,
/// `role_descriptors`… or OpenSearch's `cluster_permissions`…).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKeyRequest {
    pub body: Raw,
    #[serde(default)]
    pub confirmed: bool,
}

/// The rule of a search engine's destructive operations (deleting or
/// closing an index, a by-query write, a reindex, cancelling a task):
/// only once the user confirmed. `what` names it with its particle
/// ("인덱스를 삭제하려면").
pub fn check_confirmed(confirmed: bool, what: &str) -> Result<(), EngineError> {
    if !confirmed {
        return Err(EngineError::BadRequest(format!(
            "{what} 확인이 필요합니다 (confirmed: true)"
        )));
    }
    Ok(())
}

/// The rule of an index name an operation creates or drops: one concrete
/// name, never a pattern or a list that could reach other indices.
pub fn check_single_index(index: &str) -> Result<(), EngineError> {
    let index = index.trim();
    if index.is_empty() {
        return Err(EngineError::BadRequest("인덱스 이름이 필요합니다".into()));
    }
    if index == "_all" || index.contains(['*', ',', '?']) {
        return Err(EngineError::BadRequest(format!(
            "인덱스 하나의 이름만 쓸 수 있습니다: {index}"
        )));
    }
    Ok(())
}

/// The rule of `/api/search/aliases`: removing an index through it needs
/// the user's confirmation.
pub fn check_alias_actions(req: &AliasesRequest) -> Result<(), EngineError> {
    if req.actions.is_empty() {
        return Err(EngineError::BadRequest("별칭 동작이 없습니다".into()));
    }
    let removes_index = req.actions.iter().any(|action| {
        raw_object(Some(action), "별칭 동작")
            .is_ok_and(|action| action.contains_key("remove_index"))
    });
    if removes_index {
        check_confirmed(req.confirmed, "remove_index 동작은")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn destructive_operations_need_a_confirmation_and_one_name() {
        assert!(check_confirmed(false, "인덱스를 삭제하려면").is_err());
        assert!(check_confirmed(true, "인덱스를 삭제하려면").is_ok());
        for name in ["", "logs-*", "a,b", "_all", "x?"] {
            assert!(check_single_index(name).is_err(), "{name}");
        }
        assert!(check_single_index("shop-orders").is_ok());
        let add = AliasesRequest {
            actions: vec![raw(&json!({ "add": { "index": "a", "alias": "b" } }))],
            confirmed: false,
        };
        assert!(check_alias_actions(&add).is_ok());
        let remove = AliasesRequest {
            actions: vec![raw(&json!({ "remove_index": { "index": "a" } }))],
            confirmed: false,
        };
        assert!(check_alias_actions(&remove).is_err());
    }

    #[test]
    fn requests_read_with_their_defaults() {
        let req: ReindexRequest =
            serde_json::from_str(r#"{ "body": { "source": {}, "dest": {} } }"#).unwrap();
        assert!(req.wait && !req.confirmed);
        let req: SearchRequest =
            serde_json::from_str(r#"{ "index": "shop", "body": null }"#).unwrap();
        assert!(req.body.is_none() && !req.profile);
    }

    #[test]
    fn documents_keep_their_numbers_as_written() {
        let text =
            r#"{ "index": "s", "doc": {"big":18446744073709551617123,"dec":1.10,"exp":1e400} }"#;
        let req: IndexDocRequest = serde_json::from_str(text).unwrap();
        assert_eq!(
            req.doc.get(),
            r#"{"big":18446744073709551617123,"dec":1.10,"exp":1e400}"#
        );
        let keys = raw_object(Some(&req.doc), "문서").unwrap();
        assert_eq!(keys["dec"].get(), "1.10");
        assert_eq!(
            serde_json::to_string(&keys).unwrap(),
            r#"{"big":18446744073709551617123,"dec":1.10,"exp":1e400}"#
        );
        assert!(raw_object(Some(&raw(&json!([1]))), "본문").is_err());
        assert!(raw_object(Some(&raw(&json!(null))), "본문")
            .unwrap()
            .is_empty());
    }
}
