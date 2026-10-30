//! Against the test servers of `make test-db ENGINE=…`: Elasticsearch 8
//! over HTTP (`elasticsearch`, 9201) and HTTPS (`elasticsearch-tls`, 9203),
//! Elasticsearch 7.9 (`elasticsearch-7`, 9204) and 6.8 (`elasticsearch-6`,
//! 9206), OpenSearch 2 (`opensearch`, 9202) and 1.3 (`opensearch-1`, 9205),
//! all seeded with the shop indices. Writes go to a scratch index of their
//! own. What a server's version lacks (points in time, data streams) is
//! checked to fail the way the page explains it.

use std::sync::Arc;

use futures_util::StreamExt;
use serde_json::value::RawValue;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tablepeek_types::ConnConfig;

use super::Version;
use crate::driver::Driver;
use crate::registry::{self, NetRoute};
use crate::search::*;
use crate::sql_log::SqlLog;
use crate::EngineError;

/// A raw reply read as JSON, to look into.
fn v(raw: &RawValue) -> Value {
    serde_json::from_str(raw.get()).unwrap()
}

fn config(value: Value) -> ConnConfig {
    value.as_object().unwrap().clone()
}

fn es_config() -> ConnConfig {
    config(json!({ "host": "127.0.0.1", "port": 9201, "auth": "basic",
                   "user": "elastic", "password": "tablepeek_test_pw" }))
}

fn os_config() -> ConnConfig {
    config(
        json!({ "host": "127.0.0.1", "port": 9202, "tls": true, "tls_skip_verify": true,
                   "auth": "basic", "user": "admin", "password": "TablePeek_test_pw1" }),
    )
}

async fn open(engine: &str, config: &ConnConfig) -> Result<Arc<dyn Driver>, EngineError> {
    registry::require(engine)?
        .connect(config, &NetRoute::Direct, SqlLog::new())
        .await
}

fn code(err: &EngineError) -> Option<&str> {
    match err {
        EngineError::Driver { code, .. } => code.as_deref(),
        _ => None,
    }
}

/// Everything the page does, on one server.
async fn exercise(engine: &str, config: ConnConfig, flavor: &str) {
    let driver = open(engine, &config).await.expect("connect");
    let search = driver.search().expect("search facet");
    assert_eq!(search.flavor(), flavor);
    assert_eq!(driver.id(), engine);
    let version = Version::parse(search.cluster().await.unwrap()["version"].as_str().unwrap());
    let opensearch = flavor == "opensearch";
    let has_streams = opensearch || version >= Version(7, 9);
    let has_pit = if opensearch {
        version >= Version(2, 4)
    } else {
        version >= Version(7, 10)
    };

    let meta = driver.meta(false).await.unwrap();
    for index in [
        "shop-customers",
        "shop-orders",
        "shop-products",
        "shop-reviews",
    ] {
        assert!(
            meta.tables.iter().any(|name| name == index),
            "{index}: {:?}",
            meta.tables
        );
    }
    let info = driver.server_info().await.unwrap();
    assert!(info.version.unwrap().to_lowercase().contains(flavor));
    assert!(info.sessions.is_some());

    let cluster = search.cluster().await.unwrap();
    assert_eq!(cluster["flavor"], flavor);
    assert!(cluster["health"]["status"].is_string());
    let nodes = search.nodes().await.unwrap();
    assert_eq!(nodes.as_array().unwrap().len(), 1);
    assert!(nodes[0]["roles"].is_array(), "{nodes}");
    let perf = search.perf().await.unwrap();
    assert!(perf["heap_max_bytes"].as_u64().unwrap() > 0);
    assert!(perf["docs"].as_u64().unwrap() >= 1100);
    let rights = search.privileges(Some("shop-orders")).await.unwrap();
    assert_eq!(rights["known"], true, "{rights}");
    assert_eq!(rights["index"]["write"], true, "{rights}");
    assert_eq!(rights["cluster"]["monitor"], true, "{rights}");

    // Indices with their aliases and the data stream's backing indices.
    let indices = search.indices(false).await.unwrap();
    let orders = indices
        .iter()
        .find(|index| index["name"] == "shop-orders")
        .unwrap();
    assert_eq!(orders["docs"], 500);
    assert!(orders["size"].as_u64().unwrap() > 0);
    let aliases: Vec<&str> = orders["aliases"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(
        aliases.contains(&"orders") && aliases.contains(&"shop"),
        "{aliases:?}"
    );
    let hidden = search.indices(true).await.unwrap();
    let streams = search.data_streams().await.unwrap();
    if has_streams {
        let backing = hidden
            .iter()
            .find(|index| index["data_stream"] == "logs-shop-default")
            .expect("a backing index");
        assert_eq!(backing["hidden"], true);
        assert!(streams
            .as_array()
            .unwrap()
            .iter()
            .any(|stream| stream["name"] == "logs-shop-default"));
    } else {
        // A server before data streams lists none, without an error.
        assert_eq!(streams, json!([]));
    }
    let alias_rows = search.aliases().await.unwrap();
    assert!(alias_rows
        .iter()
        .any(|row| row.alias == "orders" && row.is_write_index == Some(true)));

    let mapping = search.mapping("shop-orders").await.unwrap();
    let mapping = v(&mapping);
    assert_eq!(
        mapping["shop-orders"]["mappings"]["properties"]["items"]["type"],
        "nested"
    );
    let definition = search.definition("shop-orders").await.unwrap();
    let definition = v(&definition);
    assert!(definition["settings"]["index"].get("uuid").is_none());
    assert_eq!(definition["settings"]["index"]["number_of_shards"], "2");
    assert!(definition["aliases"]["orders"].is_object());
    let settings = v(&search.settings("shop-orders", false).await.unwrap());
    assert!(settings["shop-orders"]["settings"]["index"]["uuid"].is_string());

    // Search: sort, paging, _source filtering, highlight, and search_after.
    let page = search
        .search(&SearchRequest {
            index: Some("shop-orders".into()),
            body: Some(raw(&json!({ "query": { "term": { "status": "paid" } } }))),
            size: Some(5),
            from: Some(5),
            sort: Some(raw(&json!([{ "order_no": "asc" }]))),
            source: Some(raw(&json!(["order_no", "status"]))),
            track_total_hits: Some(raw(&json!(true))),
            ..SearchRequest::default()
        })
        .await
        .unwrap();
    let page = v(&page);
    let hits = page["hits"]["hits"].as_array().unwrap();
    assert_eq!(hits.len(), 5);
    assert!(hits[0]["_source"].get("items").is_none());
    assert_eq!(hits[0]["_source"]["status"], "paid");
    assert!(page["elapsed_ms"].as_f64().is_some());
    // Elasticsearch 6 counts as a bare number.
    let paid = page["hits"]["total"]["value"]
        .as_u64()
        .or_else(|| page["hits"]["total"].as_u64())
        .unwrap();
    let counted = search
        .count(&CountRequest {
            index: "shop-orders".into(),
            query: Some(raw(&json!({ "term": { "status": "paid" } }))),
        })
        .await
        .unwrap();
    assert_eq!(paid, counted);
    let after = search
        .search(&SearchRequest {
            index: Some("shop-orders".into()),
            size: Some(2),
            sort: Some(raw(&json!([{ "order_no": "asc" }]))),
            search_after: Some(raw(&json!(["ORD-000002"]))),
            ..SearchRequest::default()
        })
        .await
        .unwrap();
    let after = v(&after);
    assert_eq!(after["hits"]["hits"][0]["_id"], "O000003");
    let highlighted = search
        .search(&SearchRequest {
            index: Some("shop-products".into()),
            body: Some(raw(
                &json!({ "query": { "match": { "description": "travel" } } }),
            )),
            highlight: Some(raw(&json!({ "fields": { "description": {} } }))),
            size: Some(1),
            ..SearchRequest::default()
        })
        .await
        .unwrap();
    let highlighted = v(&highlighted);
    assert!(
        highlighted["hits"]["hits"][0]["highlight"]["description"][0]
            .as_str()
            .unwrap()
            .contains("<em>")
    );

    // A point in time, read through and closed; a server without them says
    // so instead.
    let opened = search
        .open_pit(&PitOpenRequest {
            index: "shop-orders".into(),
            keep_alive: None,
        })
        .await;
    if has_pit {
        let pit = opened.unwrap();
        let in_pit = search
            .search(&SearchRequest {
                pit: Some(PitRef {
                    id: pit.clone(),
                    keep_alive: None,
                }),
                size: Some(3),
                sort: Some(raw(&json!([{ "order_no": "asc" }]))),
                ..SearchRequest::default()
            })
            .await
            .unwrap();
        let in_pit = v(&in_pit);
        assert_eq!(in_pit["hits"]["hits"].as_array().unwrap().len(), 3);
        search.close_pit(&pit).await.unwrap();
    } else {
        assert!(
            matches!(opened, Err(EngineError::Unsupported(_))),
            "{opened:?}"
        );
    }

    // Errors keep the server's type, reason and position.
    let missing = search
        .search(&SearchRequest {
            index: Some("nope-404".into()),
            ..SearchRequest::default()
        })
        .await
        .unwrap_err();
    assert_eq!(code(&missing), Some("index_not_found_exception"));
    let parse = search
        .search(&SearchRequest {
            index: Some("shop-orders".into()),
            body: Some(raw(&json!({ "query": { "mach": {} } }))),
            ..SearchRequest::default()
        })
        .await
        .unwrap_err();
    assert_eq!(code(&parse), Some("parsing_exception"));
    let EngineError::Driver { fields, .. } = &parse else {
        unreachable!()
    };
    assert!(fields.position.is_some(), "{fields:?}");

    // Documents, guarded by sequence number and primary term.
    let scratch = format!("tablepeek-test-{flavor}");
    let _ = search
        .delete_index(&IndexRequest {
            index: scratch.clone(),
            body: None,
            confirmed: true,
        })
        .await;
    search
        .create_index(&IndexRequest {
            index: scratch.clone(),
            body: Some(raw(&json!({ "settings": { "number_of_replicas": 0 },
                               "mappings": { "properties": { "n": { "type": "integer" }, "tag": { "type": "keyword" } } } }))),
            confirmed: false,
        })
        .await
        .unwrap();
    let created = search
        .index_doc(&IndexDocRequest {
            index: scratch.clone(),
            id: Some("a".into()),
            doc: raw(&json!({ "n": 1, "tag": "x" })),
            op_type: Some("create".into()),
            if_seq_no: None,
            if_primary_term: None,
            routing: None,
            refresh: None,
        })
        .await
        .unwrap();
    assert_eq!(created["result"], "created");
    let read = search
        .get_doc(&DocRef {
            index: scratch.clone(),
            id: "a".into(),
            routing: None,
        })
        .await
        .unwrap();
    let read = v(&read);
    let (seq_no, term) = (
        read["_seq_no"].as_i64().unwrap(),
        read["_primary_term"].as_i64().unwrap(),
    );
    search
        .update_doc(&UpdateDocRequest {
            index: scratch.clone(),
            id: "a".into(),
            doc: raw(&json!({ "n": 2 })),
            if_seq_no: Some(seq_no),
            if_primary_term: Some(term),
            routing: None,
            refresh: None,
        })
        .await
        .unwrap();
    // The same, stale guard now conflicts.
    let stale = search
        .update_doc(&UpdateDocRequest {
            index: scratch.clone(),
            id: "a".into(),
            doc: raw(&json!({ "n": 3 })),
            if_seq_no: Some(seq_no),
            if_primary_term: Some(term),
            routing: None,
            refresh: None,
        })
        .await
        .unwrap_err();
    assert_eq!(code(&stale), Some("version_conflict_engine_exception"));
    let replaced = search
        .index_doc(&IndexDocRequest {
            index: scratch.clone(),
            id: Some("a".into()),
            doc: raw(&json!({ "n": 9, "tag": "y" })),
            op_type: None,
            if_seq_no: None,
            if_primary_term: None,
            routing: None,
            refresh: None,
        })
        .await
        .unwrap();
    assert_eq!(replaced["result"], "updated");
    let auto = search
        .index_doc(&IndexDocRequest {
            index: scratch.clone(),
            id: None,
            doc: raw(&json!({ "n": 5, "tag": "x" })),
            op_type: None,
            if_seq_no: None,
            if_primary_term: None,
            routing: None,
            refresh: None,
        })
        .await
        .unwrap();
    assert!(auto["_id"].as_str().is_some_and(|id| !id.is_empty()));

    // Numbers no f64 holds, and decimals as written, go and come back byte
    // for byte: stored in an object the mapping leaves alone, read back by
    // get, search, the console, export, and after a bulk.
    let exact_index = format!("{scratch}-exact");
    let _ = search
        .delete_index(&IndexRequest {
            index: exact_index.clone(),
            body: None,
            confirmed: true,
        })
        .await;
    search
        .create_index(&IndexRequest {
            index: exact_index.clone(),
            body: Some(raw_text(r#"{"settings":{"number_of_replicas":0},"mappings":{"dynamic":false,"properties":{"n":{"type":"integer"}}}}"#.into()).unwrap()),
            confirmed: false,
        })
        .await
        .unwrap();
    let exact = r#"{"big":18446744073709551617123,"dec":1.10,"exp":1e400,"neg":-0.0,"long":9223372036854775807,"tiny":5e-324}"#;
    let doc = format!(r#"{{"n":1,"exact":{exact}}}"#);
    search
        .index_doc(&IndexDocRequest {
            index: exact_index.clone(),
            id: Some("x".into()),
            doc: raw_text(doc.clone()).unwrap(),
            op_type: None,
            if_seq_no: None,
            if_primary_term: None,
            routing: None,
            refresh: None,
        })
        .await
        .unwrap();
    let got = search
        .get_doc(&DocRef {
            index: exact_index.clone(),
            id: "x".into(),
            routing: None,
        })
        .await
        .unwrap();
    assert!(
        got.get().contains(&format!(r#""_source":{doc}"#)),
        "{}",
        got.get()
    );
    let found = search
        .search(&SearchRequest {
            index: Some(exact_index.clone()),
            body: Some(raw_text(r#"{"query":{"term":{"n":1}}}"#.into()).unwrap()),
            ..SearchRequest::default()
        })
        .await
        .unwrap();
    assert!(
        found.get().starts_with(r#"{"elapsed_ms":"#),
        "{}",
        found.get()
    );
    assert!(found.get().contains(exact), "{}", found.get());
    let class = search.classify("GET", "/x/_doc/x", None).unwrap();
    let reply = search
        .console(
            &ConsoleRequest {
                method: "GET".into(),
                path: format!("/{exact_index}/_doc/x"),
                body: None,
                confirmed: false,
            },
            &class,
        )
        .await
        .unwrap();
    assert!(reply.body.get().contains(exact), "{}", reply.body.get());
    let class = search.classify("PUT", "/x/_doc/y", None).unwrap();
    let reply = search
        .console(
            &ConsoleRequest {
                method: "PUT".into(),
                path: format!("/{exact_index}/_doc/y?refresh=true"),
                body: Some(raw_text(doc.clone()).unwrap()),
                confirmed: false,
            },
            &class,
        )
        .await
        .unwrap();
    assert_eq!(reply.status, 201, "{}", reply.body.get());
    let lines = format!("{}\n{doc}\n", json!({ "index": { "_id": "z" } }));
    search
        .bulk(
            &BulkRequest {
                index: Some(exact_index.clone()),
                refresh: Some("true".into()),
                confirmed: false,
            },
            lines,
        )
        .await
        .unwrap();
    for id in ["y", "z"] {
        let got = search
            .get_doc(&DocRef {
                index: exact_index.clone(),
                id: id.into(),
                routing: None,
            })
            .await
            .unwrap();
        assert!(got.get().contains(exact), "{id}: {}", got.get());
    }
    let exported: Vec<String> = search
        .export(&SearchExportRequest {
            index: exact_index.clone(),
            query: None,
            sort: None,
            source: None,
            limit: None,
        })
        .await
        .unwrap()
        .map(|hit| hit.unwrap().get().to_string())
        .collect()
        .await;
    assert_eq!(exported.len(), 3);
    assert!(
        exported.iter().all(|line| line.contains(exact)),
        "{exported:?}"
    );
    search
        .delete_index(&IndexRequest {
            index: exact_index,
            body: None,
            confirmed: true,
        })
        .await
        .unwrap();

    // Bulk with one failing action; positions count actions from 0.
    let lines = format!(
        "{}\n{}\n{}\n{}\n",
        json!({ "index": { "_id": "b" } }),
        json!({ "n": 10, "tag": "z" }),
        json!({ "create": { "_id": "a" } }),
        json!({ "n": 11 }),
    );
    let bulk = search
        .bulk(
            &BulkRequest {
                index: Some(scratch.clone()),
                refresh: Some("true".into()),
                confirmed: false,
            },
            lines,
        )
        .await
        .unwrap();
    assert_eq!(
        (bulk["count"].as_u64(), bulk["failed"].as_u64()),
        (Some(2), Some(1))
    );
    assert_eq!(bulk["failures"][0]["position"], 1);
    let deletes = format!("{}\n", json!({ "delete": { "_id": "b" } }));
    assert!(search
        .bulk(
            &BulkRequest {
                index: Some(scratch.clone()),
                refresh: None,
                confirmed: false
            },
            deletes
        )
        .await
        .is_err());

    // By-query writes, only once confirmed.
    let refused = search
        .update_by_query(&ByQueryRequest {
            index: scratch.clone(),
            query: None,
            script: None,
            confirmed: false,
            conflicts: None,
            max_docs: None,
            refresh: None,
        })
        .await;
    assert!(matches!(refused, Err(EngineError::BadRequest(_))));
    let updated = search
        .update_by_query(&ByQueryRequest {
            index: scratch.clone(),
            query: Some(raw(&json!({ "term": { "tag": "x" } }))),
            script: Some(raw(&json!({ "source": "ctx._source.n += 100" }))),
            confirmed: true,
            conflicts: Some("proceed".into()),
            max_docs: None,
            refresh: Some(true),
        })
        .await
        .unwrap();
    assert_eq!(updated["updated"], 1);
    let deleted = search
        .delete_by_query(&ByQueryRequest {
            index: scratch.clone(),
            query: Some(raw(&json!({ "term": { "tag": "z" } }))),
            script: None,
            confirmed: true,
            conflicts: None,
            max_docs: None,
            refresh: Some(true),
        })
        .await
        .unwrap();
    assert_eq!(deleted["deleted"], 1);
    let gone = search
        .delete_doc(&DeleteDocRequest {
            index: scratch.clone(),
            id: "a".into(),
            if_seq_no: None,
            if_primary_term: None,
            routing: None,
            refresh: None,
        })
        .await
        .unwrap();
    assert_eq!(gone["result"], "deleted");
    let missing = search
        .get_doc(&DocRef {
            index: scratch.clone(),
            id: "a".into(),
            routing: None,
        })
        .await
        .unwrap();
    let missing = v(&missing);
    assert_eq!(missing["found"], false);

    // Mapping, settings, aliases, close and open, analyze, explain, validate.
    search
        .put_mapping(&IndexRequest {
            index: scratch.clone(),
            body: Some(raw(
                &json!({ "properties": { "added": { "type": "keyword" } } }),
            )),
            confirmed: false,
        })
        .await
        .unwrap();
    search
        .put_settings(&IndexRequest {
            index: scratch.clone(),
            body: Some(raw(&json!({ "index": { "refresh_interval": "2s" } }))),
            confirmed: false,
        })
        .await
        .unwrap();
    search
        .update_aliases(&AliasesRequest {
            actions: vec![raw(
                &json!({ "add": { "index": scratch, "alias": format!("{scratch}-alias") } }),
            )],
            confirmed: false,
        })
        .await
        .unwrap();
    search
        .close_index(&IndexRequest {
            index: scratch.clone(),
            body: None,
            confirmed: true,
        })
        .await
        .unwrap();
    let closed = search.indices(false).await.unwrap();
    let row = closed
        .iter()
        .find(|index| index["name"] == scratch.as_str())
        .unwrap();
    assert_eq!(row["status"], "close");
    search
        .open_index(&IndexRequest {
            index: scratch.clone(),
            body: None,
            confirmed: false,
        })
        .await
        .unwrap();
    let tokens = search
        .analyze(&AnalyzeRequest {
            index: None,
            body: raw(&json!({ "analyzer": "standard", "text": "Quick Brown 여우" })),
        })
        .await
        .unwrap();
    let tokens = v(&tokens);
    assert_eq!(tokens["tokens"].as_array().unwrap().len(), 3);
    let explained = search
        .explain(&ExplainDocRequest {
            index: "shop-orders".into(),
            id: "O000001".into(),
            query: raw(&json!({ "match_all": {} })),
        })
        .await
        .unwrap();
    let explained = v(&explained);
    assert_eq!(explained["matched"], true);
    let invalid = search
        .validate(&ValidateRequest {
            index: Some("shop-orders".into()),
            query: raw(&json!({ "range": { "ordered_at": { "gte": "not a date" } } })),
        })
        .await
        .unwrap();
    let invalid = v(&invalid);
    assert_eq!(invalid["valid"], false);
    let profiled = search
        .search(&SearchRequest {
            index: Some("shop-orders".into()),
            body: Some(raw(
                &json!({ "query": { "match": { "items.name": "Pro" } } }),
            )),
            profile: true,
            size: Some(1),
            ..SearchRequest::default()
        })
        .await
        .unwrap();
    let profiled = v(&profiled);
    assert!(profiled["profile"]["shards"]
        .as_array()
        .is_some_and(|shards| !shards.is_empty()));

    // SQL, paged by a cursor. Elasticsearch quotes a name with a hyphen in
    // double quotes; OpenSearch's SQL reads those as text and takes it bare.
    let orders = if flavor == "opensearch" {
        "shop-orders"
    } else {
        "\"shop-orders\""
    };
    let first = search
        .sql(&SqlRequest {
            query: Some(format!(
                "SELECT order_no, status, total FROM {orders} ORDER BY order_no"
            )),
            fetch_size: Some(200),
            cursor: None,
        })
        .await
        .unwrap();
    assert_eq!(first.columns.len(), 3);
    assert_eq!(first.columns[0].name, "order_no");
    assert_eq!(first.rows.len(), 200);
    assert_eq!(v(&first.rows[0])[0], "ORD-000001");
    let mut rows = first.rows.len();
    let mut cursor = first.cursor.clone();
    while let Some(next) = cursor {
        let page = search
            .sql(&SqlRequest {
                query: None,
                fetch_size: None,
                cursor: Some(next),
            })
            .await
            .unwrap();
        rows += page.rows.len();
        cursor = page.cursor;
    }
    assert_eq!(rows, 500);
    let early = search
        .sql(&SqlRequest {
            query: Some(format!("SELECT order_no FROM {orders}")),
            fetch_size: Some(10),
            cursor: None,
        })
        .await
        .unwrap();
    search.sql_close(&early.cursor.unwrap()).await.unwrap();
    let dsl = search
        .sql_translate(&format!(
            "SELECT order_no FROM {orders} WHERE status = 'paid'"
        ))
        .await
        .unwrap();
    assert!(dsl.to_string().contains("paid"), "{dsl}");
    let bad_sql = search
        .sql(&SqlRequest {
            query: Some(format!("SELECT nope FROM {orders}")),
            fetch_size: None,
            cursor: None,
        })
        .await
        .unwrap_err();
    assert!(code(&bad_sql).is_some(), "{bad_sql:?}");

    // The console: replies of any status come back as they are.
    let classified = search.classify("GET", "/shop-orders/_count", None).unwrap();
    let reply = search
        .console(
            &ConsoleRequest {
                method: "GET".into(),
                path: "/shop-orders/_count".into(),
                body: None,
                confirmed: false,
            },
            &classified,
        )
        .await
        .unwrap();
    assert_eq!(
        (reply.status, v(&reply.body)["count"].as_u64()),
        (200, Some(500))
    );
    let reply = search
        .console(
            &ConsoleRequest {
                method: "GET".into(),
                path: "/nope-404/_search".into(),
                body: None,
                confirmed: false,
            },
            &classified,
        )
        .await
        .unwrap();
    assert_eq!(reply.status, 404);
    assert_eq!(v(&reply.body)["error"]["type"], "index_not_found_exception");
    let text = search
        .classify("POST", "/shop-orders/_search", None)
        .unwrap();
    let reply = search
        .console(
            &ConsoleRequest {
                method: "POST".into(),
                path: "/shop-orders/_search?size=1".into(),
                body: Some(raw(&json!("{ \"query\": { \"match_all\": {} } }"))),
                confirmed: false,
            },
            &text,
        )
        .await
        .unwrap();
    assert_eq!(reply.status, 200);
    assert_eq!(v(&reply.body)["hits"]["hits"].as_array().unwrap().len(), 1);

    // Export: every hit once, and a limit.
    let mut all = search
        .export(&SearchExportRequest {
            index: "shop-orders".into(),
            query: None,
            sort: None,
            source: Some(raw(&json!(["order_no"]))),
            limit: None,
        })
        .await
        .unwrap();
    let mut ids = std::collections::HashSet::new();
    while let Some(hit) = all.next().await {
        let hit = v(&hit.unwrap());
        assert!(hit["_source"]["order_no"].is_string());
        ids.insert(hit["_id"].as_str().unwrap().to_string());
    }
    assert_eq!(ids.len(), 500);
    let limited = search
        .export(&SearchExportRequest {
            index: "shop-customers".into(),
            query: Some(raw(&json!({ "term": { "tier": "pro" } }))),
            sort: Some(raw(&json!([{ "customer_no": "asc" }]))),
            source: None,
            limit: Some(7),
        })
        .await
        .unwrap();
    let hits: Vec<Value> = limited.map(|hit| v(&hit.unwrap())).collect().await;
    assert_eq!(hits.len(), 7);
    assert_eq!(hits[0]["_source"]["tier"], "pro");

    // Tasks, hot threads and shards for the cluster screens.
    let tasks = search.tasks(None).await.unwrap();
    assert!(tasks.iter().any(|task| task["action"]
        .as_str()
        .is_some_and(|action| action.starts_with("cluster:monitor/tasks"))));
    assert!(search.cancel_task("nonsense").await.is_err());
    let hot = search.hot_threads(Some(1), Some("50ms")).await.unwrap();
    assert!(hot.contains("Hot threads"), "{hot}");
    let shards = search.shards(Some("shop-orders")).await.unwrap();
    assert_eq!(shards.as_array().unwrap().len(), 2);
    assert!(shards[0]["docs"].is_number());

    // A slow search, cancelled: the page stops waiting at once, and its
    // task (found by its X-Opaque-Id) is cancelled on the server.
    let running = driver.clone();
    let slow = tokio::spawn(async move {
        running
            .search()
            .unwrap()
            .search(&SearchRequest {
                index: Some("shop-orders".into()),
                // function_score: script_score as a query came with 7.0.
                body: Some(raw(&json!({ "query": { "function_score": {
                    "query": { "match_all": {} },
                    "script_score": { "script": { "source": "double s = 0; for (int i = 0; i < 400000; ++i) { s += Math.sqrt(i + doc['total'].value); } return s;" } }
                } } }))),
                size: Some(1),
                ..SearchRequest::default()
            })
            .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    let started = std::time::Instant::now();
    match driver.cancel() {
        crate::driver::CancelRequest::Sent { request, .. } => request.await.unwrap(),
        crate::driver::CancelRequest::Done => panic!("nothing was running"),
    }
    let outcome = slow.await.unwrap();
    assert!(outcome.unwrap_err().is_interrupted());
    assert!(started.elapsed() < std::time::Duration::from_secs(5));
    // Cancelled on the server: marked so (7.12 and later say `cancelled`),
    // and gone once the shards notice.
    let settled = |tasks: &[Value]| {
        tasks.iter().all(|task| {
            task["cancelled"] == true
                || task["opaque_id"].is_null()
                || task["action"]
                    .as_str()
                    .is_some_and(|action| action.starts_with("cluster:monitor"))
        })
    };
    let mut left = search.tasks(Some("*search*")).await.unwrap();
    for _ in 0..40 {
        if settled(&left) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        left = search.tasks(Some("*search*")).await.unwrap();
    }
    assert!(settled(&left), "{left:?}");

    // Reindex, then the scratch indices go.
    let copy = format!("{scratch}-copy");
    let reindexed = search
        .reindex(&ReindexRequest {
            body: raw(
                &json!({ "source": { "index": "shop-products" }, "dest": { "index": copy } }),
            ),
            confirmed: true,
            wait: true,
        })
        .await
        .unwrap();
    assert_eq!(reindexed["created"], 100);
    for index in [copy, scratch] {
        search
            .delete_index(&IndexRequest {
                index,
                body: None,
                confirmed: true,
            })
            .await
            .unwrap();
    }
}

/// Connecting: wrong passwords and TLS that doesn't match fail the way the
/// page explains them.
async fn connect_failures(engine: &str, good: ConnConfig) {
    let mut wrong = good.clone();
    wrong.insert("password".into(), json!("wrong"));
    let err = open(engine, &wrong).await.err().unwrap();
    assert!(err.to_string().contains("Authentication failed"), "{err}");
    let mut flipped = good.clone();
    let tls = good.get("tls").and_then(Value::as_bool).unwrap_or(false);
    flipped.insert("tls".into(), json!(!tls));
    flipped.insert("tls_skip_verify".into(), json!(true));
    let err = open(engine, &flipped).await.err().unwrap();
    let text = err.to_string();
    assert!(text.contains("TLS") || text.contains("HTTPS"), "{text}");
    let mut refused = good;
    refused.insert("port".into(), json!(1));
    let err = open(engine, &refused).await.err().unwrap();
    assert!(err.to_string().contains("연결할 수 없습니다"), "{err}");
}

/// A TCP proxy on a free local port to the server's `port`; aborting the
/// handle closes it and every connection through it.
async fn proxy(port: u16) -> (u16, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let local = listener.local_addr().unwrap().port();
    let task = tokio::spawn(async move {
        let mut streams = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let Ok((mut client, _)) = accepted else { break };
                    streams.spawn(async move {
                        if let Ok(mut server) = tokio::net::TcpStream::connect(("127.0.0.1", port)).await {
                            let _ = tokio::io::copy_bidirectional(&mut client, &mut server).await;
                        }
                    });
                }
                Some(_) = streams.join_next() => {}
            }
        }
    });
    (local, task)
}

/// Connected through a proxy that then goes away: the node list the
/// cluster gave (its published 127.0.0.1:`port`) takes the requests over.
async fn failover(engine: &str, config: &ConnConfig, port: u16) {
    let (local, gate) = proxy(port).await;
    let mut through = config.clone();
    through.insert("host".into(), json!("127.0.0.1"));
    through.insert("port".into(), json!(local));
    let driver = open(engine, &through)
        .await
        .expect("connect through the proxy");
    let search = driver.search().unwrap();
    let connection = search.cluster().await.unwrap()["connection"].clone();
    let listed: Vec<String> = connection["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|node| node["address"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(connection["sniff"], true, "{connection}");
    assert_eq!(
        listed,
        [format!("127.0.0.1:{local}"), format!("127.0.0.1:{port}")],
        "{connection}"
    );
    gate.abort();
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let meta = driver.meta(false).await.expect("read after the failover");
    assert!(meta.tables.iter().any(|name| name == "shop-orders"));
    let connection = search.cluster().await.unwrap()["connection"].clone();
    assert_eq!(connection["current"], format!("127.0.0.1:{port}"));
    assert!(connection["failovers"].as_u64().unwrap() >= 1);
    assert_eq!(connection["nodes"][0]["down"], true, "{connection}");
    assert_eq!(
        driver.server_info().await.unwrap().host,
        Some(format!("127.0.0.1:{port}"))
    );
    // With sniffing off there is only the address given.
    let mut single = config.clone();
    single.insert("sniff".into(), json!(false));
    let driver = open(engine, &single).await.unwrap();
    let connection = driver.search().unwrap().cluster().await.unwrap()["connection"].clone();
    assert_eq!(connection["nodes"].as_array().unwrap().len(), 1);
}

/// The security screens' requests: users, roles, role mappings and API
/// keys made, changed, logged in with and deleted.
async fn security(engine: &str, config: &ConnConfig, flavor: &str) {
    let driver = open(engine, config).await.unwrap();
    let search = driver.search().unwrap();
    let opensearch = flavor == "opensearch";
    let overview = search.security().await.unwrap();
    assert_eq!(overview["enabled"], true, "{overview}");
    assert_eq!(overview["manage"], true, "{overview}");
    let users = search.security_list(SecurityKind::Users).await.unwrap();
    let admin = if opensearch { "admin" } else { "elastic" };
    let builtin = users
        .as_array()
        .unwrap()
        .iter()
        .find(|user| user["name"] == admin)
        .unwrap_or_else(|| panic!("{users}"));
    if !opensearch {
        assert_eq!(builtin["reserved"], true, "{builtin}");
    }
    assert!(builtin["body"].get("hash").is_none());

    let (role, user, mapping) = (
        "tablepeek_sec_role",
        "tablepeek_sec_user",
        "tablepeek_sec_map",
    );
    let mapping = if opensearch { role } else { mapping };
    for (kind, name) in [
        (SecurityKind::RoleMappings, mapping),
        (SecurityKind::Users, user),
        (SecurityKind::Roles, role),
    ] {
        let _ = search
            .security_delete(&SecurityDeleteRequest {
                kind,
                names: vec![name.into()],
                confirmed: true,
            })
            .await;
    }
    let put = |kind: SecurityKind, name: &str, body: Value, confirmed: bool| SecurityPutRequest {
        kind,
        name: name.into(),
        body: raw(&body),
        confirmed,
    };
    let role_body = if opensearch {
        json!({ "cluster_permissions": ["cluster_monitor"],
                "index_permissions": [{ "index_patterns": ["shop-*"], "allowed_actions": ["read"] }] })
    } else {
        json!({ "cluster": ["monitor"], "indices": [{ "names": ["shop-*"], "privileges": ["read", "view_index_metadata"] }] })
    };
    let unconfirmed = search
        .security_put(&put(SecurityKind::Roles, role, role_body.clone(), false))
        .await;
    assert!(matches!(unconfirmed, Err(EngineError::BadRequest(_))));
    search
        .security_put(&put(SecurityKind::Roles, role, role_body, true))
        .await
        .unwrap();
    let roles = search.security_list(SecurityKind::Roles).await.unwrap();
    let made = roles
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == role)
        .unwrap_or_else(|| panic!("{roles}"));
    assert_eq!(made["indices"], json!(["shop-*"]), "{made}");
    assert_eq!(made["reserved"], false);

    let password = "Sec_test_pw1!";
    let user_body = if opensearch {
        json!({ "password": password, "opendistro_security_roles": [role], "description": "live" })
    } else {
        json!({ "password": password, "roles": [role], "full_name": "Live Test" })
    };
    search
        .security_put(&put(SecurityKind::Users, user, user_body, true))
        .await
        .unwrap();
    // Changed without a password: the password stays.
    let edited = if opensearch {
        json!({ "opendistro_security_roles": [role], "description": "edited" })
    } else {
        json!({ "roles": [role], "full_name": "Edited" })
    };
    search
        .security_put(&put(SecurityKind::Users, user, edited, true))
        .await
        .unwrap();
    let users = search.security_list(SecurityKind::Users).await.unwrap();
    let listed = users
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == user)
        .unwrap_or_else(|| panic!("{users}"));
    if opensearch {
        assert_eq!(listed["description"], "edited", "{listed}");
    } else {
        assert_eq!(listed["full_name"], "Edited", "{listed}");
        assert_eq!(listed["enabled"], true);
    }
    let login = |password: &str| {
        let mut login = config.clone();
        login.insert("user".into(), json!(user));
        login.insert("password".into(), json!(password));
        login
    };
    open(engine, &login(password))
        .await
        .expect("the new user logs in");
    let renewed = "Sec_test_pw2!";
    search
        .user_password(&UserPasswordRequest {
            name: user.into(),
            password: renewed.into(),
            confirmed: true,
        })
        .await
        .unwrap();
    open(engine, &login(renewed))
        .await
        .expect("the new password logs in");
    let old = open(engine, &login(password)).await.err().unwrap();
    assert!(old.to_string().contains("Authentication failed"), "{old}");
    let switched = search
        .user_enabled(&UserEnabledRequest {
            name: user.into(),
            enabled: false,
            confirmed: true,
        })
        .await;
    if opensearch {
        assert!(
            matches!(switched, Err(EngineError::Unsupported(_))),
            "{switched:?}"
        );
    } else {
        switched.unwrap();
        let off = open(engine, &login(renewed)).await.err().unwrap();
        assert!(off.to_string().contains("Authentication failed"), "{off}");
        search
            .user_enabled(&UserEnabledRequest {
                name: user.into(),
                enabled: true,
                confirmed: true,
            })
            .await
            .unwrap();
        open(engine, &login(renewed)).await.unwrap();
    }

    let mapping_body = if opensearch {
        json!({ "users": [user], "backend_roles": ["ops"] })
    } else {
        json!({ "roles": [role], "enabled": true, "rules": { "field": { "username": user } } })
    };
    search
        .security_put(&put(
            SecurityKind::RoleMappings,
            mapping,
            mapping_body,
            true,
        ))
        .await
        .unwrap();
    let mappings = search
        .security_list(SecurityKind::RoleMappings)
        .await
        .unwrap();
    let listed = mappings
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == mapping)
        .unwrap_or_else(|| panic!("{mappings}"));
    if opensearch {
        assert_eq!(listed["users"], json!([user]), "{listed}");
    } else {
        assert_eq!(listed["roles"], json!([role]), "{listed}");
    }

    // API keys: Elasticsearch's; OpenSearch's only from 3.7.
    let os_keys = opensearch
        && Version::parse(search.cluster().await.unwrap()["version"].as_str().unwrap())
            >= Version(3, 7);
    let key_body = if opensearch {
        json!({ "name": "tablepeek-sec", "cluster_permissions": ["cluster_monitor"],
                "index_permissions": [{ "index_pattern": ["shop-*"], "allowed_actions": ["read"] }],
                "duration_seconds": 3600 })
    } else {
        json!({ "name": "tablepeek-sec", "expiration": "1h" })
    };
    let key = search
        .create_api_key(&ApiKeyRequest {
            body: raw(&key_body),
            confirmed: true,
        })
        .await;
    if opensearch && !os_keys {
        assert_eq!(overview["kinds"]["api_keys"]["available"], false);
        assert!(matches!(key, Err(EngineError::Unsupported(_))), "{key:?}");
    } else {
        let key = key.unwrap();
        // The secret, shown once: Elasticsearch's encoded key, OpenSearch's
        // `os_` token. Either logs in.
        let secret = if opensearch {
            &key["token"]
        } else {
            &key["encoded"]
        };
        let secret = secret
            .as_str()
            .unwrap_or_else(|| panic!("{key}"))
            .to_string();
        let mut by_key = config.clone();
        by_key.remove("user");
        by_key.insert("auth".into(), json!("api_key"));
        by_key.insert("password".into(), json!(secret));
        let keyed = open(engine, &by_key).await.expect("the new key logs in");
        keyed.search().unwrap().cluster().await.unwrap();
        let id = key["id"]
            .as_str()
            .unwrap_or_else(|| panic!("{key}"))
            .to_string();
        let keys = search.security_list(SecurityKind::ApiKeys).await.unwrap();
        let listed = keys
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["id"] == id.as_str())
            .unwrap_or_else(|| panic!("{keys}"));
        assert_eq!(listed["invalidated"], false, "{listed}");
        assert!(listed["expires_ms"].as_i64().is_some(), "{listed}");
        search
            .security_delete(&SecurityDeleteRequest {
                kind: SecurityKind::ApiKeys,
                names: vec![id.clone()],
                confirmed: true,
            })
            .await
            .unwrap();
        let keys = search.security_list(SecurityKind::ApiKeys).await.unwrap();
        assert!(
            keys.as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["id"] == id.as_str() && entry["invalidated"] == true),
            "{keys}"
        );
        let refused = open(engine, &by_key)
            .await
            .err()
            .expect("a revoked key is refused");
        assert!(
            refused.to_string().contains("Authentication failed"),
            "{refused}"
        );
    }

    for (kind, name) in [
        (SecurityKind::RoleMappings, mapping),
        (SecurityKind::Users, user),
        (SecurityKind::Roles, role),
    ] {
        search
            .security_delete(&SecurityDeleteRequest {
                kind,
                names: vec![name.into()],
                confirmed: true,
            })
            .await
            .unwrap();
    }
    let users = search.security_list(SecurityKind::Users).await.unwrap();
    assert!(!users
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["name"] == user));
}

/// The page's Stop: a read's tasks are cancelled; a write the server keeps
/// running is answered with its task, cancelled afterwards on request.
async fn stop(engine: &str, config: &ConnConfig, flavor: &str) {
    let driver = open(engine, config).await.unwrap();
    let search = driver.search().unwrap();
    let idle = search.stop().await.unwrap();
    assert_eq!(idle["stopped"], false, "{idle}");

    let scratch = format!("tablepeek-stop-{flavor}");
    let _ = search
        .delete_index(&IndexRequest {
            index: scratch.clone(),
            body: None,
            confirmed: true,
        })
        .await;
    let lines: String = (0..40)
        .map(|n| {
            format!(
                "{}\n{}\n",
                json!({ "index": { "_id": n.to_string() } }),
                json!({ "n": n })
            )
        })
        .collect();
    search
        .bulk(
            &BulkRequest {
                index: Some(scratch.clone()),
                refresh: Some("true".into()),
                confirmed: false,
            },
            lines,
        )
        .await
        .unwrap();

    // A throttled update by query: a write, left running by the Stop.
    let path = format!(
        "/{scratch}/_update_by_query?requests_per_second=2&scroll_size=1&conflicts=proceed"
    );
    let class = search.classify("POST", &path, None).unwrap();
    let running = driver.clone();
    let write = tokio::spawn(async move {
        running
            .search()
            .unwrap()
            .console(
                &ConsoleRequest {
                    method: "POST".into(),
                    path,
                    body: Some(raw(
                        &json!({ "script": { "source": "ctx._source.n += 1" } }),
                    )),
                    confirmed: true,
                },
                &class,
            )
            .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
    let report = search.stop().await.unwrap();
    assert_eq!(report["stopped"], true, "{report}");
    assert!(
        report["request"]
            .as_str()
            .is_some_and(|text| text.contains("_update_by_query")),
        "{report}"
    );
    assert_eq!(report["cancelled"], json!([]), "{report}");
    let task = report["running"]
        .as_array()
        .unwrap()
        .iter()
        .find(|task| {
            task["action"]
                .as_str()
                .is_some_and(|action| action.contains("byquery"))
        })
        .unwrap_or_else(|| panic!("{report}"))
        .clone();
    assert_eq!(task["cancellable"], true, "{task}");
    search
        .cancel_task(task["id"].as_str().unwrap())
        .await
        .unwrap();
    let reply = tokio::time::timeout(std::time::Duration::from_secs(20), write)
        .await
        .expect("the cancelled write returns")
        .unwrap()
        .unwrap();
    let body = v(&reply.body);
    assert!(
        body["canceled"].is_string() || body["failures"].is_array(),
        "{body}"
    );

    // A slow read, stopped: the page stops waiting, its task is cancelled.
    let running = driver.clone();
    let slow = tokio::spawn(async move {
        running
            .search()
            .unwrap()
            .search(&SearchRequest {
                index: Some("shop-orders".into()),
                body: Some(raw(&json!({ "query": { "function_score": {
                    "query": { "match_all": {} },
                    "script_score": { "script": { "source": "double s = 0; for (int i = 0; i < 400000; ++i) { s += Math.sqrt(i + doc['total'].value); } return s;" } }
                } } }))),
                size: Some(1),
                ..SearchRequest::default()
            })
            .await
    });
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    let report = search.stop().await.unwrap();
    assert_eq!(report["stopped"], true, "{report}");
    assert!(slow.await.unwrap().unwrap_err().is_interrupted());
    // Whatever still ran is something the server can't cancel, offered
    // with the related tasks it can.
    for task in report["running"].as_array().unwrap() {
        assert_eq!(task["cancellable"], false, "{report}");
        assert!(task["related"]
            .as_array()
            .unwrap()
            .iter()
            .all(|related| related["cancellable"] == true));
    }
    assert!(
        !report["cancelled"].as_array().unwrap().is_empty()
            || !report["running"].as_array().unwrap().is_empty()
            || search
                .tasks(Some("*search*"))
                .await
                .unwrap()
                .iter()
                .all(|task| task["opaque_id"].is_null()
                    || task["action"]
                        .as_str()
                        .is_some_and(|action| action.starts_with("cluster:monitor"))),
        "{report}"
    );
    search
        .delete_index(&IndexRequest {
            index: scratch,
            body: None,
            confirmed: true,
        })
        .await
        .unwrap();
}

/// One older or differently set up server: everything the page does, the
/// way connections fail, failover, security and Stop.
async fn whole(engine: &str, config: ConnConfig, flavor: &str, port: u16) {
    exercise(engine, config.clone(), flavor).await;
    connect_failures(engine, config.clone()).await;
    failover(engine, &config, port).await;
    security(engine, &config, flavor).await;
    stop(engine, &config, flavor).await;
}

#[tokio::test]
async fn elasticsearch_live() {
    if std::env::var("TABLEPEEK_TEST_ELASTICSEARCH").is_err() {
        return;
    }
    whole("elasticsearch", es_config(), "elasticsearch", 9201).await;
    // An API key made for the test reads as well.
    let driver = open("elasticsearch", &es_config()).await.unwrap();
    let search = driver.search().unwrap();
    let classified = search.classify("POST", "/_security/api_key", None).unwrap();
    assert_eq!(classified.class, RequestClass::Danger);
    let key = search
        .console(
            &ConsoleRequest {
                method: "POST".into(),
                path: "/_security/api_key".into(),
                body: Some(raw(
                    &json!({ "name": "tablepeek-live", "expiration": "1h" }),
                )),
                confirmed: true,
            },
            &classified,
        )
        .await
        .unwrap();
    let encoded = v(&key.body)["encoded"].as_str().unwrap().to_string();
    let id_and_key = format!(
        "{}:{}",
        v(&key.body)["id"].as_str().unwrap(),
        v(&key.body)["api_key"].as_str().unwrap()
    );
    for secret in [encoded, id_and_key] {
        let config = config(
            json!({ "host": "127.0.0.1", "port": 9201, "auth": "api_key", "password": secret }),
        );
        let driver = open("elasticsearch", &config).await.unwrap();
        assert!(driver
            .meta(false)
            .await
            .unwrap()
            .tables
            .iter()
            .any(|name| name == "shop-orders"));
    }
    // A user who may only read: the privileges say so, and a write fails
    // with the server's security error.
    for (path, body) in [
        (
            "/_security/role/tablepeek_reader",
            json!({ "cluster": ["monitor"], "indices": [{ "names": ["shop-*"], "privileges": ["read", "view_index_metadata"] }] }),
        ),
        (
            "/_security/user/tablepeek_reader",
            json!({ "password": "reader_test_pw", "roles": ["tablepeek_reader"] }),
        ),
    ] {
        let class = search.classify("PUT", path, None).unwrap();
        let reply = search
            .console(
                &ConsoleRequest {
                    method: "PUT".into(),
                    path: path.into(),
                    body: Some(raw(&body)),
                    confirmed: true,
                },
                &class,
            )
            .await
            .unwrap();
        assert_eq!(reply.status, 200, "{}", reply.body);
    }
    let reader = config(json!({ "host": "127.0.0.1", "port": 9201, "auth": "basic",
                                "user": "tablepeek_reader", "password": "reader_test_pw" }));
    let driver = open("elasticsearch", &reader).await.unwrap();
    let reading = driver.search().unwrap();
    let rights = reading.privileges(Some("shop-orders")).await.unwrap();
    assert_eq!(rights["index"]["read"], true, "{rights}");
    assert_eq!(rights["index"]["write"], false, "{rights}");
    assert_eq!(rights["cluster"]["manage"], false, "{rights}");
    let refused = reading
        .delete_doc(&DeleteDocRequest {
            index: "shop-orders".into(),
            id: "O000001".into(),
            if_seq_no: None,
            if_primary_term: None,
            routing: None,
            refresh: None,
        })
        .await
        .unwrap_err();
    assert_eq!(code(&refused), Some("security_exception"));
    // The other engine's descriptor still reaches the server, and says what it is.
    let driver = open("opensearch", &es_config()).await.unwrap();
    assert_eq!(driver.search().unwrap().flavor(), "elasticsearch");
    assert_eq!(driver.id(), "opensearch");
}

#[tokio::test]
async fn opensearch_live() {
    if std::env::var("TABLEPEEK_TEST_OPENSEARCH").is_err() {
        return;
    }
    whole("opensearch", os_config(), "opensearch", 9202).await;
    // The self-signed certificate: refused by default, taken by its fingerprint.
    let mut checked = os_config();
    checked.remove("tls_skip_verify");
    let err = open("opensearch", &checked).await.err().unwrap();
    assert!(err.to_string().contains("TLS 연결 실패"), "{err}");
    let pem = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../testdb/opensearch/node.pem"
    ))
    .expect("testdb/opensearch/node.pem (make test-db ENGINE=opensearch copies it)");
    let der = rustls_pemfile::certs(&mut pem.as_slice())
        .next()
        .unwrap()
        .unwrap();
    let fingerprint: Vec<String> = Sha256::digest(der.as_ref())
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect();
    checked.insert("tls_fingerprint".into(), json!(fingerprint.join(":")));
    let driver = open("opensearch", &checked).await.unwrap();
    assert!(!driver.meta(false).await.unwrap().tables.is_empty());
    checked.insert("tls_fingerprint".into(), json!("00".repeat(32)));
    let err = open("opensearch", &checked).await.err().unwrap();
    assert!(err.to_string().contains("지문"), "{err}");
    // The demo CA, with the name the certificate carries (127.0.0.1 and
    // localhost are in it), and a client certificate on top.
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/../../testdb/opensearch");
    for host in ["127.0.0.1", "localhost"] {
        let mut with_ca = os_config();
        with_ca.remove("tls_skip_verify");
        with_ca.insert("host".into(), json!(host));
        with_ca.insert("tls_ca_file".into(), json!(format!("{dir}/ca.pem")));
        let driver = open("opensearch", &with_ca).await.unwrap();
        assert!(!driver.meta(false).await.unwrap().tables.is_empty());
        with_ca.insert("tls_client_cert".into(), json!(format!("{dir}/client.pem")));
        with_ca.insert(
            "tls_client_key".into(),
            json!(format!("{dir}/client-key.pem")),
        );
        let driver = open("opensearch", &with_ca).await.unwrap();
        assert!(!driver.meta(false).await.unwrap().tables.is_empty());
        with_ca.remove("tls_client_key");
        let err = open("opensearch", &with_ca).await.err().unwrap();
        assert!(matches!(err, EngineError::BadRequest(_)), "{err}");
    }
}

fn fingerprint_of(path: &str) -> String {
    let pem = std::fs::read(path).unwrap_or_else(|err| panic!("{path}: {err}"));
    let der = rustls_pemfile::certs(&mut pem.as_slice())
        .next()
        .unwrap()
        .unwrap();
    Sha256::digest(der.as_ref())
        .iter()
        .map(|byte| format!("{byte:02X}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// Elasticsearch with HTTPS (`make test-db ENGINE=elasticsearch-tls`): the
/// whole suite over TLS checked against the test CA, then each way a
/// certificate is trusted or refused, and a PKI login by client
/// certificate.
#[tokio::test]
async fn elasticsearch_tls_live() {
    if std::env::var("TABLEPEEK_TEST_ELASTICSEARCH_TLS").is_err() {
        return;
    }
    let testdb = concat!(env!("CARGO_MANIFEST_DIR"), "/../../testdb");
    let ca = format!("{testdb}/x509/ca.pem");
    let base = config(
        json!({ "host": "127.0.0.1", "port": 9203, "tls": true, "tls_ca_file": ca,
                              "auth": "basic", "user": "elastic", "password": "tablepeek_test_pw" }),
    );
    whole("elasticsearch", base.clone(), "elasticsearch", 9203).await;
    // By the name the certificate carries too.
    let mut by_name = base.clone();
    by_name.insert("host".into(), json!("localhost"));
    open("elasticsearch", &by_name).await.expect("localhost");
    // The system's roots don't know the test CA.
    let mut system = base.clone();
    system.remove("tls_ca_file");
    let err = open("elasticsearch", &system).await.err().unwrap();
    assert!(err.to_string().contains("TLS 연결 실패"), "{err}");
    // A fingerprint of the CA (as Elasticsearch prints it) or of the node's
    // own certificate; a wrong one is refused.
    for pem in [
        ca.clone(),
        format!("{testdb}/elasticsearch-tls/certs/node.crt"),
    ] {
        let mut pinned = system.clone();
        pinned.insert("tls_fingerprint".into(), json!(fingerprint_of(&pem)));
        let driver = open("elasticsearch", &pinned).await.expect(&pem);
        assert!(!driver.meta(false).await.unwrap().tables.is_empty());
    }
    let mut wrong = system.clone();
    wrong.insert("tls_fingerprint".into(), json!("00".repeat(32)));
    let err = open("elasticsearch", &wrong).await.err().unwrap();
    assert!(err.to_string().contains("지문"), "{err}");
    let mut unchecked = system.clone();
    unchecked.insert("tls_skip_verify".into(), json!(true));
    open("elasticsearch", &unchecked).await.expect("unchecked");
    // A client certificate logs in by itself (the PKI realm maps
    // tablepeek-client to superuser); without its key it is refused.
    let client = format!("{testdb}/x509/client.pem");
    let pki = config(
        json!({ "host": "127.0.0.1", "port": 9203, "tls": true, "tls_ca_file": ca,
                             "auth": "none", "tls_client_cert": client, "tls_client_key": client }),
    );
    let driver = open("elasticsearch", &pki).await.expect("PKI login");
    let overview = driver.search().unwrap().security().await.unwrap();
    assert_eq!(overview["user"]["name"], "tablepeek-client", "{overview}");
    let mut keyless = pki.clone();
    keyless.remove("tls_client_key");
    let err = open("elasticsearch", &keyless).await.err().unwrap();
    assert!(matches!(err, EngineError::BadRequest(_)), "{err}");
}

/// Elasticsearch 7.9 (`make test-db ENGINE=elasticsearch-7`): no point in
/// time, so exports read by scroll.
#[tokio::test]
async fn elasticsearch_7_live() {
    if std::env::var("TABLEPEEK_TEST_ELASTICSEARCH_7").is_err() {
        return;
    }
    let config = config(json!({ "host": "127.0.0.1", "port": 9204, "auth": "basic",
                                "user": "elastic", "password": "tablepeek_test_pw" }));
    whole("elasticsearch", config, "elasticsearch", 9204).await;
}

/// Elasticsearch 6.8 (`make test-db ENGINE=elasticsearch-6`): mapping
/// types, X-Pack SQL, no data streams.
#[tokio::test]
async fn elasticsearch_6_live() {
    if std::env::var("TABLEPEEK_TEST_ELASTICSEARCH_6").is_err() {
        return;
    }
    let config = config(json!({ "host": "127.0.0.1", "port": 9206, "auth": "basic",
                                "user": "elastic", "password": "tablepeek_test_pw" }));
    whole("elasticsearch", config.clone(), "elasticsearch", 9206).await;
    // A bulk without a default index names the type itself.
    let driver = open("elasticsearch", &config).await.unwrap();
    let search = driver.search().unwrap();
    let lines = format!(
        "{}\n{}\n",
        json!({ "index": { "_index": "tablepeek-typed", "_id": "1" } }),
        json!({ "n": 1 })
    );
    let reply = search
        .bulk(
            &BulkRequest {
                index: None,
                refresh: Some("true".into()),
                confirmed: false,
            },
            lines,
        )
        .await
        .unwrap();
    assert_eq!(reply["failed"], 0, "{reply}");
    search
        .delete_index(&IndexRequest {
            index: "tablepeek-typed".into(),
            body: None,
            confirmed: true,
        })
        .await
        .unwrap();
}

/// OpenSearch 1.3 (`make test-db ENGINE=opensearch-1`): no point in time,
/// the demo security of its day.
#[tokio::test]
async fn opensearch_1_live() {
    if std::env::var("TABLEPEEK_TEST_OPENSEARCH_1").is_err() {
        return;
    }
    let config = config(
        json!({ "host": "127.0.0.1", "port": 9205, "tls": true, "tls_skip_verify": true,
                                "auth": "basic", "user": "admin", "password": "admin" }),
    );
    whole("opensearch", config, "opensearch", 9205).await;
}

/// OpenSearch 3 (`make test-db ENGINE=opensearch-3`): the whole suite, with
/// API keys (3.7 and later, switched on in the test server's security
/// config) made, logged in with, listed and revoked.
#[tokio::test]
async fn opensearch_3_live() {
    if std::env::var("TABLEPEEK_TEST_OPENSEARCH_3").is_err() {
        return;
    }
    let config = config(
        json!({ "host": "127.0.0.1", "port": 9207, "tls": true, "tls_skip_verify": true,
                "auth": "basic", "user": "admin", "password": "TablePeek_test_pw1" }),
    );
    let overview = open("opensearch", &config)
        .await
        .unwrap()
        .search()
        .unwrap()
        .security()
        .await
        .unwrap();
    assert_eq!(
        overview["kinds"]["api_keys"]["available"], true,
        "{overview}"
    );
    whole("opensearch", config, "opensearch", 9207).await;
}
