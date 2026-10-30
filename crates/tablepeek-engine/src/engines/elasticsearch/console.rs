//! The Dev Tools console's rules: which raw requests it may send, and how
//! each one acts (reads, writes, or is dangerous), so safe mode can ask
//! first and the server can refuse a dangerous one sent without asking
//! (docs/engines/elasticsearch.md §4.6).

use serde_json::value::RawValue;
use serde_json::Value;

use crate::search::{Classified, RequestClass};
use crate::EngineError;

/// Endpoints that only read, though sent with POST or PUT (a body is
/// easier to send that way); a path matches one that it equals or that
/// it continues with `/`.
const READ_ENDPOINTS: [&str; 26] = [
    "_search",
    "_msearch",
    "_count",
    "_explain",
    "_validate/query",
    "_analyze",
    "_field_caps",
    "_mget",
    "_termvectors",
    "_mtermvectors",
    "_render/template",
    "_pit",
    "_async_search",
    "_eql/search",
    "_query",
    "_knn_search",
    "_terms_enum",
    "_rank_eval",
    "_sql",
    "_plugins/_sql",
    "_plugins/_ppl",
    "_plugins/_asynchronous_search",
    "_search_shards",
    "_resolve/index",
    "_mapping/field",
    "_cat",
];

/// Cursors a DELETE closes: reading leaves them behind, closing them
/// changes nothing.
const CLOSING_DELETES: [&str; 5] = [
    "_search/scroll",
    "_pit",
    "_search/point_in_time",
    "_async_search",
    "_plugins/_asynchronous_search",
];

/// Endpoints that delete, close, rewrite or shut down something in a way
/// that is hard to take back.
const DANGER_ENDPOINTS: [&str; 12] = [
    "_delete_by_query",
    "_update_by_query",
    "_reindex",
    "_close",
    "_shrink",
    "_split",
    "_restore",
    "_shutdown",
    "_cluster/settings",
    "_cluster/voting_config_exclusions",
    "_cluster/reroute",
    "_security",
];

/// Whether `path` may be sent at all: a path on the cluster (with its query
/// string), not a URL elsewhere or one that climbs out of a prefix.
pub(super) fn check_path(path: &str) -> Result<(), EngineError> {
    let bad = |why: &str| EngineError::BadRequest(format!("요청 경로가 올바르지 않습니다: {why}"));
    if !path.starts_with('/') {
        return Err(bad("/로 시작해야 합니다"));
    }
    if path.contains("://") || path.starts_with("//") {
        return Err(bad("주소가 아닌 경로만 쓸 수 있습니다"));
    }
    if path
        .chars()
        .any(|ch| ch.is_whitespace() || ch.is_control() || ch == '#')
    {
        return Err(bad("공백이나 #이 있습니다"));
    }
    let route = path.split('?').next().unwrap_or(path);
    if route
        .split('/')
        .any(|segment| segment == ".." || segment == "." || segment.eq_ignore_ascii_case("%2e%2e"))
    {
        return Err(bad(".. 구간은 쓸 수 없습니다"));
    }
    Ok(())
}

/// The API part of a path: from its first `_` segment on
/// (`/shop/_doc/1` → `_doc/1`); empty for a bare index (`PUT /shop`).
fn endpoint(path: &str) -> String {
    let route = path.split('?').next().unwrap_or(path);
    let segments: Vec<&str> = route
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect();
    match segments.iter().position(|segment| segment.starts_with('_')) {
        Some(start) => segments[start..].join("/"),
        None => String::new(),
    }
}

/// Whether `endpoint` is `name` or continues it with `/`.
fn is(endpoint: &str, name: &str) -> bool {
    endpoint == name
        || endpoint
            .strip_prefix(name)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// Whether one segment of `endpoint` is `name` (`_snapshot/repo/s/_restore`).
fn has_segment(endpoint: &str, name: &str) -> bool {
    endpoint.split('/').any(|segment| segment == name)
}

/// Whether an action line is `{ "delete": … }`.
fn is_delete(line: &Value) -> bool {
    line.as_object()
        .is_some_and(|object| object.len() == 1 && object.contains_key("delete"))
}

/// Whether NDJSON `_bulk` lines delete.
pub(super) fn ndjson_deletes(text: &str) -> bool {
    text.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .any(|line| is_delete(&line))
}

/// `_bulk` lines for a server with mapping types (Elasticsearch before
/// 7.0), sent without a default index: every action line without a
/// `_type` gets `_doc`. Document lines pass untouched.
pub(super) fn typed_bulk(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + text.len() / 8);
    let mut document_next = false;
    for line in text.lines() {
        if line.trim().is_empty() {
            continue;
        }
        if document_next {
            out.push_str(line);
            out.push('\n');
            document_next = false;
            continue;
        }
        match serde_json::from_str::<Value>(line) {
            Ok(Value::Object(mut action)) if action.len() == 1 => {
                let (kind, meta) = action.iter_mut().next().expect("one key");
                document_next = kind != "delete";
                match meta.as_object_mut() {
                    Some(meta) if !meta.contains_key("_type") => {
                        meta.insert("_type".into(), Value::String("_doc".into()));
                        out.push_str(&Value::Object(action).to_string());
                    }
                    _ => out.push_str(line),
                }
            }
            _ => out.push_str(line),
        }
        out.push('\n');
    }
    out
}

/// Whether a console `_bulk` body deletes: NDJSON in a string, or the
/// lines as an array.
fn bulk_deletes(body: Option<&RawValue>) -> bool {
    let Some(body) = body.and_then(|body| serde_json::from_str::<Value>(body.get()).ok()) else {
        return false;
    };
    match &body {
        Value::String(text) => ndjson_deletes(text),
        Value::Array(lines) => lines.iter().any(is_delete),
        line => is_delete(line),
    }
}

/// See `SearchDriver::classify`.
pub(super) fn classify(
    method: &str,
    path: &str,
    body: Option<&RawValue>,
) -> Result<Classified, EngineError> {
    check_path(path)?;
    let method = method.trim().to_ascii_uppercase();
    let endpoint = endpoint(path);
    let class = |class: RequestClass, reason: &str| {
        Ok(Classified {
            class,
            reason: reason.to_string(),
        })
    };
    match method.as_str() {
        "GET" | "HEAD" => class(RequestClass::Read, &method),
        "DELETE" => match CLOSING_DELETES.iter().find(|name| is(&endpoint, name)) {
            Some(name) => class(RequestClass::Read, name),
            None => class(RequestClass::Danger, "DELETE"),
        },
        "POST" | "PUT" => {
            if let Some(name) = DANGER_ENDPOINTS
                .iter()
                .find(|name| is(&endpoint, name) || has_segment(&endpoint, name))
            {
                return class(RequestClass::Danger, name);
            }
            if is(&endpoint, "_plugins/_security") || has_segment(&endpoint, "shutdown") {
                return class(RequestClass::Danger, "_plugins/_security");
            }
            if has_segment(&endpoint, "_bulk") && bulk_deletes(body) {
                return class(RequestClass::Danger, "_bulk delete");
            }
            match READ_ENDPOINTS.iter().find(|name| is(&endpoint, name)) {
                Some(name) => class(RequestClass::Read, name),
                None if endpoint.is_empty() => class(RequestClass::Write, &method),
                None => class(
                    RequestClass::Write,
                    endpoint.split('/').next().unwrap_or(&method),
                ),
            }
        }
        other => Err(EngineError::BadRequest(format!(
            "지원하지 않는 메서드입니다: {other} (GET·HEAD·POST·PUT·DELETE)"
        ))),
    }
}

/// Keys whose values never reach the console.
const SECRET_KEYS: [&str; 5] = [
    "password",
    "new_password",
    "password_hash",
    "api_key",
    "hash",
];

/// A JSON Patch operation setting a secret (OpenSearch's
/// `{ "op": "add", "path": "/password", "value": … }`).
fn sets_secret(map: &serde_json::Map<String, Value>) -> bool {
    map.get("path")
        .and_then(Value::as_str)
        .and_then(|path| path.rsplit('/').next())
        .is_some_and(|key| SECRET_KEYS.contains(&key))
        && map.contains_key("value")
}

/// `body` as one line of JSON with every password in it masked.
pub(super) fn masked_body(body: &Value) -> String {
    fn mask(value: &mut Value) {
        match value {
            Value::Object(map) => {
                let patch = sets_secret(map);
                for (key, value) in map.iter_mut() {
                    let secret = SECRET_KEYS.contains(&key.as_str()) || (patch && key == "value");
                    if secret && value.is_string() {
                        *value = Value::String("****".into());
                    } else {
                        mask(value);
                    }
                }
            }
            Value::Array(items) => items.iter_mut().for_each(mask),
            _ => {}
        }
    }
    let mut body = body.clone();
    mask(&mut body);
    body.to_string()
}

/// JSON text as one console line: as written (line breaks, which JSON
/// only has between tokens, made spaces), or re-written with its
/// passwords masked when it has any.
pub(super) fn masked_text(text: &str) -> String {
    fn has_secret(value: &Value) -> bool {
        match value {
            Value::Object(map) => {
                sets_secret(map)
                    || map.iter().any(|(key, value)| {
                        SECRET_KEYS.contains(&key.as_str()) || has_secret(value)
                    })
            }
            Value::Array(items) => items.iter().any(has_secret),
            _ => false,
        }
    }
    match serde_json::from_str::<Value>(text) {
        Ok(value) if has_secret(&value) => masked_body(&value),
        _ => text.trim().replace(['\n', '\r'], " "),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn class_of(method: &str, path: &str, body: Option<Value>) -> RequestClass {
        let body = body.map(|body| crate::search::raw(&body));
        classify(method, path, body.as_deref()).unwrap().class
    }

    #[test]
    fn requests_are_classified_by_method_and_endpoint() {
        use RequestClass::*;
        assert_eq!(class_of("GET", "/_cat/indices?v", None), Read);
        assert_eq!(class_of("head", "/shop", None), Read);
        assert_eq!(class_of("POST", "/shop/_search", None), Read);
        assert_eq!(class_of("POST", "/shop,logs-*/_search?size=0", None), Read);
        assert_eq!(class_of("POST", "/_search/scroll", None), Read);
        assert_eq!(class_of("POST", "/_sql?format=txt", None), Read);
        assert_eq!(class_of("POST", "/_sql/translate", None), Read);
        assert_eq!(class_of("POST", "/_plugins/_sql/_explain", None), Read);
        assert_eq!(class_of("POST", "/shop/_explain/1", None), Read);
        assert_eq!(class_of("POST", "/shop/_validate/query", None), Read);
        assert_eq!(class_of("DELETE", "/_search/scroll", None), Read);
        assert_eq!(class_of("DELETE", "/_pit", None), Read);

        assert_eq!(class_of("PUT", "/shop", None), Write);
        assert_eq!(class_of("PUT", "/shop/_doc/1", None), Write);
        assert_eq!(class_of("POST", "/shop/_update/1", None), Write);
        assert_eq!(class_of("PUT", "/shop/_mapping", None), Write);
        assert_eq!(class_of("POST", "/shop/_refresh", None), Write);
        assert_eq!(class_of("POST", "/_tasks/n1:5/_cancel", None), Write);
        assert_eq!(class_of("POST", "/_search_template_x", None), Write);
        let index_line = json!("{\"index\":{\"_index\":\"shop\"}}\n{\"a\":1}\n");
        assert_eq!(class_of("POST", "/_bulk", Some(index_line)), Write);

        assert_eq!(class_of("DELETE", "/shop", None), Danger);
        assert_eq!(class_of("DELETE", "/shop/_doc/1", None), Danger);
        assert_eq!(class_of("POST", "/shop/_delete_by_query", None), Danger);
        assert_eq!(
            class_of("POST", "/shop/_update_by_query?conflicts=proceed", None),
            Danger
        );
        assert_eq!(class_of("POST", "/_reindex", None), Danger);
        assert_eq!(class_of("POST", "/shop/_close", None), Danger);
        assert_eq!(class_of("PUT", "/_cluster/settings", None), Danger);
        assert_eq!(class_of("POST", "/_security/user/ann", None), Danger);
        assert_eq!(
            class_of("PUT", "/_plugins/_security/api/internalusers/ann", None),
            Danger
        );
        assert_eq!(
            class_of("POST", "/_snapshot/repo/snap/_restore", None),
            Danger
        );
        assert_eq!(class_of("PUT", "/_nodes/n1/shutdown", None), Danger);
        let delete_line = json!("{\"delete\":{\"_index\":\"shop\",\"_id\":\"1\"}}\n");
        assert_eq!(class_of("POST", "/shop/_bulk", Some(delete_line)), Danger);
    }

    #[test]
    fn only_paths_on_the_cluster_and_known_methods_go() {
        for path in [
            "shop/_search",
            "http://evil/_search",
            "//evil/_search",
            "/shop/../_cluster/settings",
            "/a b",
            "/x#y",
        ] {
            assert!(classify("GET", path, None).is_err(), "{path}");
        }
        assert!(classify("PATCH", "/shop", None).is_err());
        assert!(classify("TRACE", "/", None).is_err());
    }

    #[test]
    fn passwords_never_reach_the_console() {
        let body =
            json!({ "password": "s3cret", "roles": ["x"], "nested": { "new_password": "n" } });
        let shown = masked_body(&body);
        assert!(
            !shown.contains("s3cret") && !shown.contains("\"n\""),
            "{shown}"
        );
        assert!(shown.contains("****"));
        // OpenSearch's password patch and stored hashes.
        let patch = json!([{ "op": "add", "path": "/password", "value": "p4tch" },
                           { "op": "add", "path": "/backend_roles", "value": ["ops"] }]);
        let shown = masked_body(&patch);
        assert!(!shown.contains("p4tch") && shown.contains("ops"), "{shown}");
        let text = masked_text(&patch.to_string());
        assert!(!text.contains("p4tch"), "{text}");
        assert!(!masked_text(r#"{"hash":"$2y$12$abc"}"#).contains("$2y$"));
    }

    #[test]
    fn bulk_lines_for_mapping_types_name_doc() {
        let text = concat!(
            "{\"index\":{\"_index\":\"a\",\"_id\":\"1\"}}\n",
            "{\"n\":18446744073709551617123,\"delete\":{}}\n",
            "{\"delete\":{\"_index\":\"a\",\"_id\":\"2\"}}\n",
            "{\"create\":{\"_index\":\"a\",\"_type\":\"doc\"}}\n",
            "{\"n\":1}\n",
        );
        let typed: Vec<String> = typed_bulk(text).lines().map(str::to_string).collect();
        assert_eq!(typed.len(), 5);
        assert!(typed[0].contains("\"_type\":\"_doc\""), "{}", typed[0]);
        // A document line passes as written, whatever its keys.
        assert_eq!(typed[1], "{\"n\":18446744073709551617123,\"delete\":{}}");
        assert!(typed[2].contains("\"_type\":\"_doc\""));
        assert!(typed[3].contains("\"_type\":\"doc\""));
        assert_eq!(typed[4], "{\"n\":1}");
    }
}
