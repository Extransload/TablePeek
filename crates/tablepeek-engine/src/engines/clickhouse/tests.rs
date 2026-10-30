//! Live tests against the test server (`make test-db ENGINE=clickhouse`),
//! run with TABLEPEEK_TEST_CLICKHOUSE=1. They read testdb/clickhouse.sql's
//! tables and make their own in tablepeek_test.

use serde_json::{json, Value};
use tablepeek_types::{ConnConfig, EditTarget, InsertValue, PkValue, ValueExpr};

use crate::registry::{DriverFactory, NetRoute};
use crate::{Engine, EngineError};

use super::FACTORY;

static TURN: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn config(extra: Value) -> ConnConfig {
    let mut config = json!({
        "host": "127.0.0.1",
        "port": 18123,
        "user": "tablepeek",
        "password": "tablepeek_test_pw",
        "database": "tablepeek_test",
    });
    if let (Some(base), Value::Object(extra)) = (config.as_object_mut(), extra) {
        base.extend(extra);
    }
    config.as_object().cloned().unwrap()
}

async fn connect(extra: Value) -> Option<(Engine, tokio::sync::MutexGuard<'static, ()>)> {
    std::env::var("TABLEPEEK_TEST_CLICKHOUSE").ok()?;
    let turn = TURN.lock().await;
    let engine = Engine::open_demo(1).unwrap();
    engine
        .swap_to(&FACTORY, &config(extra), &NetRoute::Direct)
        .await
        .unwrap();
    Some((engine, turn))
}

fn driver_error(error: &EngineError) -> (Option<String>, Option<i64>, Option<String>, Option<u32>) {
    match error {
        EngineError::Driver { code, fields, .. } => (
            code.clone(),
            fields.server_code,
            fields.code_name.clone(),
            fields.position.and_then(|position| position.offset),
        ),
        other => panic!("not a driver error: {other:?}"),
    }
}

#[tokio::test]
async fn clickhouse_connects_and_lists() {
    let Some((engine, _turn)) = connect(json!({})).await else {
        return;
    };
    let meta = engine.meta(false).await.unwrap();
    assert_eq!(meta.kind, "clickhouse");
    assert!(meta.path.unwrap().ends_with("/tablepeek_test"));
    assert!(meta.tables.contains(&"kinds".to_string()));
    assert!(!meta.tables.contains(&"kinds_view".to_string()));
    let capabilities = meta.capabilities.unwrap();
    assert_eq!(capabilities.explain.as_deref(), Some("clickhouse"));
    assert!(capabilities.edit_by_key);
    assert!(capabilities.users);

    let objects = engine.objects(false).await.unwrap();
    assert_eq!(objects.views, vec!["kinds_view".to_string()]);
    let definition = engine
        .object_definition("view", "kinds_view")
        .await
        .unwrap()
        .unwrap();
    assert!(definition.ddl.unwrap().contains("CREATE VIEW"));

    let schema = engine.schema(false).await.unwrap();
    let kinds = schema.iter().find(|table| table.name == "kinds").unwrap();
    let id = kinds
        .columns
        .iter()
        .find(|column| column.name == "id")
        .unwrap();
    assert!(id.pk && id.not_null);
    let nickname = kinds
        .columns
        .iter()
        .find(|column| column.name == "nickname")
        .unwrap();
    assert!(!nickname.not_null);
    // The system tables, qualified.
    let with_system = engine.meta(true).await.unwrap();
    assert!(with_system.tables.contains(&"system.tables".to_string()));

    let databases = engine.databases().await.unwrap();
    assert!(databases.contains(&"shop".to_string()));
}

#[tokio::test]
async fn clickhouse_results_keep_their_types() {
    let Some((engine, _turn)) = connect(json!({})).await else {
        return;
    };
    let data = engine
        .query("SELECT * FROM kinds ORDER BY id", 100)
        .await
        .unwrap();
    assert_eq!(data.kind, "clickhouse");
    assert_eq!(data.row_count, 2);
    assert_eq!(data.source_table.as_deref(), Some("kinds"));
    assert_eq!(data.pk, Some(vec!["id".to_string()]));
    let rows = data.rows_json();
    let at = |name: &str| {
        data.columns
            .iter()
            .position(|column| column == name)
            .unwrap()
    };
    assert_eq!(rows[0][at("id")], json!(1));
    // Past i64: kept exact, as text.
    assert_eq!(rows[0][at("big")], json!("18446744073709551615"));
    assert_eq!(rows[0][at("amount")], json!("10.50"));
    assert_eq!(rows[0][at("tags")], json!("[\"a\",\"b\"]"));
    assert_eq!(rows[0][at("pair")], json!("[1,\"x\"]"));
    assert_eq!(rows[0][at("nickname")], Value::Null);
    assert_eq!(data.column_kinds[at("flag")], Some("boolean"));

    // max_rows cuts the result.
    let cut = engine
        .query("SELECT number FROM numbers(50)", 10)
        .await
        .unwrap();
    assert_eq!(cut.row_count, 10);
    assert!(cut.truncated);

    // A FORMAT of the statement's own: its lines as rows of one column.
    let csv = engine
        .query("SELECT id, name FROM kinds ORDER BY id FORMAT CSV", 100)
        .await
        .unwrap();
    assert_eq!(csv.columns, vec!["CSV".to_string()]);
    assert_eq!(csv.rows_json()[0][0], json!("1,\"one\""));

    // EXPLAIN's lines.
    let plan = engine
        .query("EXPLAIN PLAN SELECT * FROM kinds WHERE id = 1", 100)
        .await
        .unwrap();
    assert_eq!(plan.columns, vec!["explain".to_string()]);
    assert!(plan.row_count > 0);
}

#[tokio::test]
async fn clickhouse_errors_say_code_and_place() {
    let Some((engine, _turn)) = connect(json!({})).await else {
        return;
    };
    let error = engine.query("SELECT FROM kinds", 10).await.err().unwrap();
    let (code, server_code, code_name, offset) = driver_error(&error);
    assert_eq!(code.as_deref(), Some("62"));
    assert_eq!(server_code, Some(62));
    assert_eq!(code_name.as_deref(), Some("SYNTAX_ERROR"));
    assert!(offset.is_some());
    let error = engine
        .query("SELECT * FROM no_such_table", 10)
        .await
        .err()
        .unwrap();
    assert_eq!(driver_error(&error).1, Some(60));
    // An error after rows were sent still fails the statement.
    let error = engine
        .query(
            "SELECT number, throwIf(number = 3, 'boom') FROM numbers(10) SETTINGS max_block_size = 1",
            100,
        )
        .await
        .err()
        .unwrap();
    assert_eq!(driver_error(&error).1, Some(395));
    // A wrong password.
    if std::env::var("TABLEPEEK_TEST_CLICKHOUSE").is_ok() {
        let other = Engine::open_demo(1).unwrap();
        let error = other
            .swap_to(
                &FACTORY,
                &config(json!({ "password": "wrong" })),
                &NetRoute::Direct,
            )
            .await
            .unwrap_err();
        assert_eq!(driver_error(&error).1, Some(516));
    }
}

#[tokio::test]
async fn clickhouse_session_keeps_use_and_settings() {
    let Some((engine, _turn)) = connect(json!({})).await else {
        return;
    };
    engine.query("USE shop", 1).await.unwrap();
    let meta = engine.meta(false).await.unwrap();
    assert!(meta.path.unwrap().ends_with("/shop"));
    assert!(meta.tables.contains(&"orders".to_string()));
    let objects = engine.objects(false).await.unwrap();
    assert!(objects
        .materialized_views
        .contains(&"daily_sales_mv".to_string()));
    assert!(objects.dictionaries.contains(&"category_names".to_string()));
    engine.query("SET max_threads = 3", 1).await.unwrap();
    let data = engine
        .query("SELECT getSetting('max_threads'), currentDatabase()", 1)
        .await
        .unwrap();
    assert_eq!(data.rows_json()[0], vec![json!(3), json!("shop")]);

    let detail = engine.table_detail("orders").await.unwrap();
    let property = |name: &str| {
        detail
            .properties
            .iter()
            .find(|property| property.name == name)
            .map(|property| property.value.clone())
    };
    assert_eq!(property("엔진").as_deref(), Some("MergeTree"));
    assert_eq!(
        property("ORDER BY").as_deref(),
        Some("customer_id, ordered_at, id")
    );
    assert_eq!(
        property("PARTITION BY").as_deref(),
        Some("toYYYYMM(ordered_at)")
    );
    assert!(property("TTL").is_some());
    assert!(detail.ddl.unwrap().contains("ENGINE = MergeTree"));
    assert_eq!(detail.row_count_estimate, Some(6000));
    let products = engine.table_detail("products").await.unwrap();
    assert_eq!(products.indexes[0].name, "products_sku");
    let customers = engine.table_detail("customers").await.unwrap();
    let tier = customers
        .columns
        .iter()
        .find(|column| column.name == "tier")
        .unwrap();
    assert_eq!(
        tier.enum_values,
        Some(vec![
            "free".to_string(),
            "pro".to_string(),
            "enterprise".to_string()
        ])
    );
    let dictionary = engine
        .object_definition("dictionary", "category_names")
        .await
        .unwrap()
        .unwrap();
    assert!(dictionary.ddl.unwrap().contains("CREATE DICTIONARY"));
    engine.query("USE tablepeek_test", 1).await.unwrap();
}

#[tokio::test]
async fn clickhouse_edits_rows_by_sorting_key() {
    let Some((engine, _turn)) = connect(json!({})).await else {
        return;
    };
    for sql in [
        "DROP TABLE IF EXISTS tp_edit",
        "CREATE TABLE tp_edit (id UInt32, part String, note Nullable(String), \
         tags Array(String), made DateTime DEFAULT now(), n UInt8 DEFAULT 7) \
         ENGINE = MergeTree ORDER BY (id, part)",
        "INSERT INTO tp_edit (id, part, note, tags) VALUES (1, 'a', 'one', ['x']), (2, 'b', NULL, []), \
         (3, 'c', 'dup', []), (3, 'c', 'dup2', [])",
    ] {
        engine.query(sql, 1).await.unwrap();
    }
    let data = engine.query("SELECT * FROM tp_edit", 100).await.unwrap();
    assert_eq!(data.pk, Some(vec!["id".to_string(), "part".to_string()]));
    let key = |id: u32, part: &str| {
        vec![
            PkValue {
                column: "id".into(),
                value: json!(id),
            },
            PkValue {
                column: "part".into(),
                value: json!(part),
            },
        ]
    };
    let edit = |id: u32, part: &str, column: &str, value: Option<&str>| EditTarget {
        table: "tp_edit".into(),
        pk: key(id, part),
        column: column.into(),
        value: value.map(str::to_string),
        expr: None,
    };
    assert_eq!(
        engine
            .edit(&edit(1, "a", "note", Some("it's")))
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        engine
            .edit(&edit(2, "b", "tags", Some("[\"p\",\"q\"]")))
            .await
            .unwrap(),
        1
    );
    assert_eq!(engine.edit(&edit(1, "a", "note", None)).await.unwrap(), 1);
    let mut defaulted = edit(1, "a", "n", Some("1"));
    defaulted.expr = Some(ValueExpr::Default);
    assert_eq!(engine.edit(&defaulted).await.unwrap(), 1);
    // A key matching no row changes nothing; one matching two is refused.
    assert_eq!(
        engine.edit(&edit(9, "z", "note", Some("x"))).await.unwrap(),
        0
    );
    assert!(matches!(
        engine.edit(&edit(3, "c", "note", Some("x"))).await,
        Err(EngineError::NotEditable(_))
    ));
    // Not the table's key.
    let mut wrong = edit(1, "a", "note", Some("x"));
    wrong.pk.pop();
    assert!(matches!(
        engine.edit(&wrong).await,
        Err(EngineError::NotEditable(_))
    ));
    let rows = engine
        .query(
            "SELECT id, note, tags, n FROM tp_edit ORDER BY id, note",
            100,
        )
        .await
        .unwrap()
        .rows_json();
    assert_eq!(
        rows[0],
        vec![json!(1), Value::Null, json!("[\"x\"]"), json!(7)]
    );
    assert_eq!(rows[1][2], json!("[\"p\",\"q\"]"));

    let inserted = engine
        .insert_values(
            "tp_edit",
            &[
                InsertValue {
                    column: "id".into(),
                    value: Some("4".into()),
                    expr: None,
                },
                InsertValue {
                    column: "part".into(),
                    value: Some("d".into()),
                    expr: None,
                },
                InsertValue {
                    column: "made".into(),
                    value: None,
                    expr: Some(ValueExpr::Now),
                },
            ],
        )
        .await
        .unwrap();
    assert_eq!(inserted, 1);
    assert_eq!(engine.insert_values("tp_edit", &[]).await.unwrap(), 1);
    assert_eq!(engine.delete_row("tp_edit", &key(4, "d")).await.unwrap(), 1);
    assert_eq!(engine.table_count("tp_edit").await.unwrap(), 5);
    engine.query("DROP TABLE tp_edit", 1).await.unwrap();
}

/// The rows of a column, as JSON, in the order the statement reads them.
async fn column(engine: &Engine, sql: &str) -> Vec<Value> {
    engine
        .query(sql, 100)
        .await
        .unwrap()
        .rows_json()
        .into_iter()
        .map(|mut row| row.remove(0))
        .collect()
}

#[tokio::test]
async fn clickhouse_tells_rows_sharing_a_key_apart() {
    let Some((engine, _turn)) = connect(json!({})).await else {
        return;
    };
    for sql in [
        "DROP TABLE IF EXISTS tp_dup",
        "CREATE TABLE tp_dup (id UInt32, note String) ENGINE = MergeTree ORDER BY id",
        "INSERT INTO tp_dup VALUES (1, 'a'), (1, 'b'), (2, 'c')",
    ] {
        engine.query(sql, 1).await.unwrap();
    }
    // The data tab's statement: the part and offset after the columns.
    let read = "SELECT *, _part, _part_offset FROM tp_dup ORDER BY note";
    let data = engine.query(read, 100).await.unwrap();
    assert_eq!(
        data.pk,
        Some(vec!["id".into(), "_part".into(), "_part_offset".into()])
    );
    let rows = data.rows_json();
    let identity = |row: &[Value]| {
        vec![
            PkValue {
                column: "id".into(),
                value: row[0].clone(),
            },
            PkValue {
                column: "_part".into(),
                value: row[2].clone(),
            },
            PkValue {
                column: "_part_offset".into(),
                value: row[3].clone(),
            },
        ]
    };
    let second = identity(&rows[1]);
    let edit = EditTarget {
        table: "tp_dup".into(),
        pk: second.clone(),
        column: "note".into(),
        value: Some("b2".into()),
        expr: None,
    };
    // By key alone the two rows with id 1 can't be told apart; with the
    // part and offset exactly one is changed.
    let mut by_key = edit.clone();
    by_key.pk.truncate(1);
    assert!(matches!(
        engine.edit(&by_key).await,
        Err(EngineError::NotEditable(_))
    ));
    assert_eq!(engine.edit(&edit).await.unwrap(), 1);
    assert_eq!(
        column(&engine, "SELECT note FROM tp_dup ORDER BY note").await,
        vec![json!("a"), json!("b2"), json!("c")]
    );
    // The edit rewrote the part under a new name; the rows kept their
    // places, so the other row with id 1 is still found by what was read.
    let mut first = edit.clone();
    first.pk = identity(&rows[0]);
    first.value = Some("a1".into());
    assert_eq!(engine.edit(&first).await.unwrap(), 1);
    assert_eq!(
        column(&engine, "SELECT note FROM tp_dup ORDER BY note").await,
        vec![json!("a1"), json!("b2"), json!("c")]
    );
    // A merge makes a new part: the row is no longer found by its old place
    // alone, but by its key and every value the grid last knew.
    engine
        .query("OPTIMIZE TABLE tp_dup FINAL", 1)
        .await
        .unwrap();
    assert_eq!(engine.edit(&edit).await.unwrap(), 0);
    let seen = |id: Value, note: &str| {
        vec![
            PkValue {
                column: "id".into(),
                value: id,
            },
            PkValue {
                column: "note".into(),
                value: json!(note),
            },
            PkValue {
                column: "_part".into(),
                value: json!("gone"),
            },
        ]
    };
    let mut moved = edit.clone();
    moved.value = Some("b3".into());
    assert_eq!(
        engine
            .edit_seen(&moved, &seen(json!(1), "b2"))
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        column(&engine, "SELECT note FROM tp_dup ORDER BY note").await,
        vec![json!("a1"), json!("b3"), json!("c")]
    );
    // Values that no longer hold find nothing.
    assert_eq!(
        engine
            .edit_seen(&moved, &seen(json!(1), "b2"))
            .await
            .unwrap(),
        0
    );
    // By key alone (a SELECT without the part) the values tell the two
    // rows with id 1 apart too.
    let mut by_values = by_key.clone();
    by_values.value = Some("b".into());
    assert_eq!(
        engine
            .edit_seen(&by_values, &seen(json!(1), "b3"))
            .await
            .unwrap(),
        1
    );
    // Rows equal in every column can't be told apart once merged.
    engine
        .query("INSERT INTO tp_dup VALUES (3, 'x'), (3, 'x')", 1)
        .await
        .unwrap();
    engine
        .query("OPTIMIZE TABLE tp_dup FINAL", 1)
        .await
        .unwrap();
    let mut twin = by_key.clone();
    twin.pk[0].value = json!(3);
    assert!(matches!(
        engine.edit_seen(&twin, &seen(json!(3), "x")).await,
        Err(EngineError::NotEditable(_))
    ));
    assert!(matches!(
        engine
            .delete_row_seen("tp_dup", &twin.pk, &seen(json!(3), "x"))
            .await,
        Err(EngineError::NotEditable(_))
    ));
    engine
        .query("DELETE FROM tp_dup WHERE id = 3", 1)
        .await
        .unwrap();
    engine
        .query(
            "ALTER TABLE tp_dup UPDATE note = 'b2' WHERE note = 'b' SETTINGS mutations_sync = 2",
            1,
        )
        .await
        .unwrap();

    // A copied row leaves the part and offset to the server.
    let mut copied: Vec<InsertValue> = ["id", "note", "_part", "_part_offset"]
        .iter()
        .zip(&rows[0])
        .map(|(column, value)| InsertValue {
            column: (*column).into(),
            value: value
                .as_str()
                .map(str::to_string)
                .or(Some(value.to_string())),
            expr: None,
        })
        .collect();
    copied[1].value = Some("a2".into());
    assert_eq!(engine.insert_values("tp_dup", &copied).await.unwrap(), 1);

    let rows = engine.query(read, 100).await.unwrap().rows_json();
    assert_eq!(rows[0][1], json!("a1"));
    assert_eq!(
        engine
            .delete_row("tp_dup", &identity(&rows[0]))
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        column(&engine, "SELECT note FROM tp_dup ORDER BY note").await,
        vec![json!("a2"), json!("b2"), json!("c")]
    );
    engine.query("DROP TABLE tp_dup", 1).await.unwrap();
}

#[tokio::test]
async fn clickhouse_updates_lightweight_where_the_table_allows() {
    let Some((engine, _turn)) = connect(json!({})).await else {
        return;
    };
    for sql in [
        "DROP TABLE IF EXISTS tp_lw",
        "DROP TABLE IF EXISTS tp_heavy",
        "CREATE TABLE tp_lw (id UInt32, note String) ENGINE = MergeTree ORDER BY id \
         SETTINGS enable_block_number_column = 1, enable_block_offset_column = 1",
        "CREATE TABLE tp_heavy (id UInt32, note String) ENGINE = MergeTree ORDER BY id",
        "INSERT INTO tp_lw VALUES (1, 'a'), (2, 'b')",
        "INSERT INTO tp_heavy VALUES (1, 'a'), (2, 'b')",
    ] {
        engine.query(sql, 1).await.unwrap();
    }
    for table in ["tp_lw", "tp_heavy"] {
        let edit = EditTarget {
            table: table.into(),
            pk: vec![PkValue {
                column: "id".into(),
                value: json!(2),
            }],
            column: "note".into(),
            value: Some("b2".into()),
            expr: None,
        };
        assert_eq!(engine.edit(&edit).await.unwrap(), 1, "{table}");
        assert_eq!(
            column(&engine, &format!("SELECT note FROM {table} ORDER BY id")).await,
            vec![json!("a"), json!("b2")],
            "{table}"
        );
    }
    // The lightweight UPDATE wrote a patch part, not a mutation.
    assert_eq!(
        column(
            &engine,
            "SELECT table, count() FROM system.mutations \
             WHERE database = 'tablepeek_test' AND table IN ('tp_lw', 'tp_heavy') \
             GROUP BY table ORDER BY table"
        )
        .await,
        vec![json!("tp_heavy")]
    );
    // The structure pane says which takes lightweight UPDATE, and its
    // one-click change (web/src/engines/clickhouse/sql.ts propertyAction)
    // turns the block columns on for a table made without them: the next
    // edit of its existing part is a lightweight UPDATE too.
    let property = |detail: &tablepeek_types::TableDetail| {
        detail
            .properties
            .iter()
            .find(|property| property.name == "경량 UPDATE")
            .map(|property| property.value.clone())
    };
    let heavy = engine.table_detail("tp_heavy").await.unwrap();
    assert_eq!(property(&heavy).as_deref(), Some("꺼짐"));
    assert_eq!(
        property(&engine.table_detail("tp_lw").await.unwrap()).as_deref(),
        Some("켜짐")
    );
    engine
        .query(
            "ALTER TABLE `tp_heavy` MODIFY SETTING enable_block_number_column = 1, enable_block_offset_column = 1",
            1,
        )
        .await
        .unwrap();
    assert_eq!(
        property(&engine.table_detail("tp_heavy").await.unwrap()).as_deref(),
        Some("켜짐")
    );
    let edit = EditTarget {
        table: "tp_heavy".into(),
        pk: vec![PkValue {
            column: "id".into(),
            value: json!(1),
        }],
        column: "note".into(),
        value: Some("a2".into()),
        expr: None,
    };
    assert_eq!(engine.edit(&edit).await.unwrap(), 1);
    assert_eq!(
        column(&engine, "SELECT note FROM tp_heavy ORDER BY id").await,
        vec![json!("a2"), json!("b2")]
    );
    assert_eq!(
        column(
            &engine,
            "SELECT count() FROM system.mutations \
             WHERE database = 'tablepeek_test' AND table = 'tp_heavy'"
        )
        .await,
        vec![json!(1)]
    );
    engine.query("DROP TABLE tp_lw", 1).await.unwrap();
    engine.query("DROP TABLE tp_heavy", 1).await.unwrap();
}

/// A server of the two-server cluster (`make test-db ENGINE=clickhouse-cluster`),
/// run with TABLEPEEK_TEST_CLICKHOUSE_CLUSTER=1.
async fn cluster_node(port: u16) -> Option<Engine> {
    std::env::var("TABLEPEEK_TEST_CLICKHOUSE_CLUSTER").ok()?;
    let engine = Engine::open_demo(1).unwrap();
    engine
        .swap_to(
            &FACTORY,
            &config(json!({ "port": port, "database": "default", "cluster": "tp_cluster" })),
            &NetRoute::Direct,
        )
        .await
        .unwrap();
    Some(engine)
}

#[tokio::test]
async fn clickhouse_structure_changes_run_on_the_cluster() {
    let Some(first) = cluster_node(18124).await else {
        return;
    };
    let second = cluster_node(18125).await.unwrap();
    assert!(column(
        &first,
        "SELECT DISTINCT cluster FROM system.clusters ORDER BY cluster"
    )
    .await
    .contains(&json!("tp_cluster")));
    // The statements as the app writes them with ON CLUSTER tp_cluster
    // picked (SqlDialect.clusters in web/src/engines/clickhouse/sql.ts).
    for sql in [
        "DROP DATABASE IF EXISTS tp_on_cluster ON CLUSTER tp_cluster SYNC",
        "CREATE DATABASE tp_on_cluster ON CLUSTER tp_cluster",
        "CREATE TABLE tp_on_cluster.items ON CLUSTER tp_cluster (\n  `id` UInt32,\n  `note` String\n)\n\
         ENGINE = ReplicatedMergeTree\nORDER BY (`id`)",
        "ALTER TABLE tp_on_cluster.items ON CLUSTER tp_cluster ADD COLUMN `qty` UInt16 DEFAULT 1",
        "INSERT INTO tp_on_cluster.items (id, note) VALUES (1, 'a'), (2, 'b')",
    ] {
        first.query(sql, 1).await.unwrap();
    }
    // Both servers have the table with the added column, and the rows
    // replicated to the other.
    second
        .query("SYSTEM SYNC REPLICA tp_on_cluster.items", 1)
        .await
        .unwrap();
    assert_eq!(
        column(&second, "SELECT note FROM tp_on_cluster.items ORDER BY id").await,
        vec![json!("a"), json!("b")]
    );
    assert_eq!(
        column(&second, "SELECT qty FROM tp_on_cluster.items ORDER BY id").await,
        vec![json!(1), json!(1)]
    );
    // An edit on the other server reaches the first through replication.
    let edit = EditTarget {
        table: "tp_on_cluster.items".into(),
        pk: vec![PkValue {
            column: "id".into(),
            value: json!(2),
        }],
        column: "note".into(),
        value: Some("b2".into()),
        expr: None,
    };
    assert_eq!(second.edit(&edit).await.unwrap(), 1);
    first
        .query("SYSTEM SYNC REPLICA tp_on_cluster.items", 1)
        .await
        .unwrap();
    assert_eq!(
        column(&first, "SELECT note FROM tp_on_cluster.items ORDER BY id").await,
        vec![json!("a"), json!("b2")]
    );
    for sql in [
        "RENAME TABLE tp_on_cluster.items TO tp_on_cluster.renamed ON CLUSTER tp_cluster",
        "TRUNCATE TABLE tp_on_cluster.renamed ON CLUSTER tp_cluster",
    ] {
        first.query(sql, 1).await.unwrap();
    }
    assert_eq!(
        second.table_count("tp_on_cluster.renamed").await.unwrap(),
        0
    );
    first
        .query("DROP TABLE tp_on_cluster.renamed ON CLUSTER tp_cluster;", 1)
        .await
        .unwrap();
    assert!(column(
        &second,
        "SELECT name FROM system.tables WHERE database = 'tp_on_cluster'"
    )
    .await
    .is_empty());
    first
        .query("DROP DATABASE tp_on_cluster ON CLUSTER tp_cluster SYNC", 1)
        .await
        .unwrap();
}

/// `column = value` pairs, as the grid sends a row's key and values.
fn pairs(values: &[(&str, Value)]) -> Vec<PkValue> {
    values
        .iter()
        .map(|(column, value)| PkValue {
            column: (*column).into(),
            value: value.clone(),
        })
        .collect()
}

#[tokio::test]
async fn clickhouse_row_edits_reach_the_cluster() {
    let Some(first) = cluster_node(18124).await else {
        return;
    };
    let second = cluster_node(18125).await.unwrap();
    for sql in [
        "DROP DATABASE IF EXISTS tp_rows ON CLUSTER tp_cluster SYNC",
        "CREATE DATABASE tp_rows ON CLUSTER tp_cluster",
        // Each server's own rows: made ON CLUSTER, not replicated.
        "CREATE TABLE tp_rows.plain ON CLUSTER tp_cluster (id UInt32, note String) \
         ENGINE = MergeTree ORDER BY id",
        "CREATE TABLE tp_rows.plain_all ON CLUSTER tp_cluster AS tp_rows.plain \
         ENGINE = Distributed(tp_cluster, tp_rows, plain)",
        "CREATE TABLE tp_rows.shared ON CLUSTER tp_cluster (id UInt32, note String) \
         ENGINE = ReplicatedMergeTree ORDER BY id",
        "CREATE TABLE tp_rows.shared_all ON CLUSTER tp_cluster AS tp_rows.shared \
         ENGINE = Distributed('tp_cluster', 'tp_rows', 'shared', rand())",
        "INSERT INTO tp_rows.shared VALUES (1, 'a'), (2, 'b')",
    ] {
        first.query(sql, 1).await.unwrap();
    }
    for node in [&first, &second] {
        node.query("INSERT INTO tp_rows.plain VALUES (1, 'a'), (2, 'b')", 1)
            .await
            .unwrap();
    }
    let notes = |table: &'static str| {
        let first = &first;
        let second = &second;
        async move {
            let sql = format!("SELECT note FROM tp_rows.{table} ORDER BY id");
            (column(first, &sql).await, column(second, &sql).await)
        }
    };

    // A table every server keeps apart: an edit on one changes the row on
    // each (ON CLUSTER), found by its key and values.
    let edit = EditTarget {
        table: "tp_rows.plain".into(),
        pk: pairs(&[("id", json!(2))]),
        column: "note".into(),
        value: Some("b2".into()),
        expr: None,
    };
    let seen = pairs(&[("id", json!(2)), ("note", json!("b"))]);
    assert_eq!(first.edit_seen(&edit, &seen).await.unwrap(), 1);
    assert_eq!(
        notes("plain").await,
        (vec![json!("a"), json!("b2")], vec![json!("a"), json!("b2")])
    );
    // Values that no longer hold anywhere find nothing.
    assert_eq!(first.edit_seen(&edit, &seen).await.unwrap(), 0);
    assert_eq!(
        first
            .delete_row_seen(
                "tp_rows.plain",
                &pairs(&[("id", json!(1))]),
                &pairs(&[("id", json!(1)), ("note", json!("a"))]),
            )
            .await
            .unwrap(),
        1
    );
    assert_eq!(notes("plain").await, (vec![json!("b2")], vec![json!("b2")]));

    // A Distributed table: keyed by its local table's sorting key, its
    // edits go to the local table on every server.
    let read = first
        .query("SELECT * FROM tp_rows.plain_all ORDER BY id", 10)
        .await
        .unwrap();
    assert_eq!(read.pk, Some(vec!["id".to_string()]));
    let detail = first.table_detail("tp_rows.plain_all").await.unwrap();
    assert!(detail
        .columns
        .iter()
        .any(|column| column.name == "id" && column.pk));
    let through = EditTarget {
        table: "tp_rows.plain_all".into(),
        pk: pairs(&[("id", json!(2))]),
        column: "note".into(),
        value: Some("b3".into()),
        expr: None,
    };
    assert_eq!(
        second
            .edit_seen(&through, &pairs(&[("id", json!(2)), ("note", json!("b2"))]))
            .await
            .unwrap(),
        1
    );
    assert_eq!(notes("plain").await, (vec![json!("b3")], vec![json!("b3")]));

    // Over a replicated local table, with the part and offset read through
    // the Distributed table: the change runs on one replica and replicates.
    let read = second
        .query(
            "SELECT *, _part, _part_offset FROM tp_rows.shared_all ORDER BY id",
            10,
        )
        .await
        .unwrap();
    assert_eq!(
        read.pk,
        Some(vec!["id".into(), "_part".into(), "_part_offset".into()])
    );
    let row = read.rows_json()[0].clone();
    let shared = EditTarget {
        table: "tp_rows.shared_all".into(),
        pk: pairs(&[
            ("id", row[0].clone()),
            ("_part", row[2].clone()),
            ("_part_offset", row[3].clone()),
        ]),
        column: "note".into(),
        value: Some("a2".into()),
        expr: None,
    };
    let seen = pairs(&[
        ("id", row[0].clone()),
        ("note", row[1].clone()),
        ("_part", row[2].clone()),
        ("_part_offset", row[3].clone()),
    ]);
    assert_eq!(second.edit_seen(&shared, &seen).await.unwrap(), 1);
    for node in [&first, &second] {
        node.query("SYSTEM SYNC REPLICA tp_rows.shared", 1)
            .await
            .unwrap();
    }
    assert_eq!(
        notes("shared").await,
        (vec![json!("a2"), json!("b")], vec![json!("a2"), json!("b")])
    );
    assert_eq!(
        first
            .delete_row_seen(
                "tp_rows.shared_all",
                &pairs(&[("id", json!(2))]),
                &pairs(&[("id", json!(2)), ("note", json!("b"))]),
            )
            .await
            .unwrap(),
        1
    );
    for node in [&first, &second] {
        node.query("SYSTEM SYNC REPLICA tp_rows.shared", 1)
            .await
            .unwrap();
    }
    assert_eq!(
        notes("shared").await,
        (vec![json!("a2")], vec![json!("a2")])
    );
    // New rows go in where the page writes them: through the Distributed
    // table (its sharding) or into the connected server's table.
    first
        .insert_values(
            "tp_rows.shared_all",
            &[
                InsertValue {
                    column: "id".into(),
                    value: Some("3".into()),
                    expr: None,
                },
                InsertValue {
                    column: "note".into(),
                    value: Some("c".into()),
                    expr: None,
                },
            ],
        )
        .await
        .unwrap();
    first
        .query("DROP DATABASE tp_rows ON CLUSTER tp_cluster SYNC", 1)
        .await
        .unwrap();
}

#[tokio::test]
async fn clickhouse_cancels_and_times_out() {
    let Some((engine, _turn)) = connect(json!({})).await else {
        return;
    };
    let engine = std::sync::Arc::new(engine);
    let running = {
        let engine = engine.clone();
        tokio::spawn(async move {
            engine
                .query(
                    "SELECT sleepEachRow(1) FROM numbers(30) SETTINGS max_block_size = 1",
                    10,
                )
                .await
        })
    };
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    // The running statement shows among the server's queries.
    let info = engine.server_info().await.unwrap();
    let sessions = info.sessions.unwrap();
    assert!(sessions.iter().any(|session| session
        .query
        .as_deref()
        .is_some_and(|query| query.contains("sleepEachRow"))));
    assert!(sessions.iter().any(|session| session.is_current));
    engine.cancel();
    let error = running.await.unwrap().err().unwrap();
    assert!(error.is_interrupted(), "{error:?}");

    engine.set_query_timeout(1);
    let error = engine
        .query(
            "SELECT sleepEachRow(1) FROM numbers(5) SETTINGS max_block_size = 1",
            10,
        )
        .await
        .err()
        .unwrap();
    assert_eq!(driver_error(&error).1, Some(159));
    engine.set_query_timeout(0);
    assert!(matches!(
        engine.kill_session("no-such-query").await,
        Err(EngineError::SessionNotFound)
    ));
    assert!(engine.begin_tx().await.is_err());
}

#[tokio::test]
async fn clickhouse_over_https() {
    let ca = concat!(env!("CARGO_MANIFEST_DIR"), "/../../testdb/x509/ca.pem");
    let Some((engine, _turn)) =
        connect(json!({ "port": 18443, "tls": true, "tls_ca_file": ca })).await
    else {
        return;
    };
    let data = engine.query("SELECT 1", 1).await.unwrap();
    assert_eq!(data.rows_json()[0][0], json!(1));
    // The system's roots don't know the test CA.
    let other = Engine::open_demo(1).unwrap();
    let error = other
        .swap_to(
            &FACTORY,
            &config(json!({ "port": 18443, "tls": true })),
            &NetRoute::Direct,
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("TLS"), "{error}");
    other
        .swap_to(
            &FACTORY,
            &config(json!({ "port": 18443, "tls": true, "tls_skip_verify": true })),
            &NetRoute::Direct,
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn clickhouse_writes_exports_itself() {
    use futures_util::StreamExt;
    let Some((engine, _turn)) = connect(json!({})).await else {
        return;
    };
    let read = |format: &str, header: bool| crate::driver::NativeExport {
        format: format.into(),
        header,
        delimiter: ';',
        crlf: false,
        null_word: false,
        nested_json: false,
    };
    let collect = |stream: crate::driver::FileStream| async move {
        let chunks: Vec<_> = stream.collect().await;
        let mut bytes = Vec::new();
        for chunk in chunks {
            bytes.extend(chunk?);
        }
        Ok::<_, EngineError>(String::from_utf8(bytes).unwrap())
    };
    let csv = engine
        .export_native(
            "SELECT id, name, nickname FROM kinds ORDER BY id",
            &read("csv", true),
        )
        .await
        .unwrap();
    assert_eq!(
        collect(csv).await.unwrap(),
        "\"id\";\"name\";\"nickname\"\n1;\"one\";\n2;\"two\";\"Deux\"\n"
    );
    let json = engine
        .export_native(
            "SELECT id, name FROM kinds ORDER BY id;",
            &read("json", false),
        )
        .await
        .unwrap();
    let parsed: Value = serde_json::from_str(&collect(json).await.unwrap()).unwrap();
    assert_eq!(
        parsed,
        json!([{ "id": 1, "name": "one" }, { "id": 2, "name": "two" }])
    );
    // Only reads.
    assert!(engine
        .export_native("DROP TABLE kinds", &read("csv", true))
        .await
        .is_err());
    // An error after the first rows ends the stream with it.
    let failing = engine
        .export_native(
            "SELECT number, throwIf(number = 50000, 'boom') FROM numbers(100000) SETTINGS max_block_size = 1000",
            &read("csv", false),
        )
        .await
        .unwrap();
    assert!(collect(failing).await.is_err());
    // Arrays, maps and tuples in the server's own text, or as JSON when
    // asked (as the grid shows them).
    let nested = "SELECT 1 AS id, ['a', 'b'] AS tags, map('k', 2) AS m, tuple(1, 'x') AS t";
    let own = engine
        .export_native(nested, &read("csv", false))
        .await
        .unwrap();
    assert_eq!(
        collect(own).await.unwrap(),
        "1;\"['a','b']\";\"{'k':2}\";\"(1,'x')\"\n"
    );
    let mut as_json = read("csv", false);
    as_json.nested_json = true;
    let json_text = engine.export_native(nested, &as_json).await.unwrap();
    assert_eq!(
        collect(json_text).await.unwrap(),
        "1;\"[\"\"a\"\",\"\"b\"\"]\";\"{\"\"k\"\":2}\";\"[1,\"\"x\"\"]\"\n"
    );
    // A result without any keeps its statement.
    let plain = engine
        .export_native("SELECT id FROM kinds ORDER BY id", &as_json)
        .await
        .unwrap();
    assert_eq!(collect(plain).await.unwrap(), "1\n2\n");
}

#[test]
fn part_condition_follows_mutations() {
    use super::rows::part_condition;
    assert_eq!(
        part_condition("all_1_1_0", true),
        "(_part = 'all_1_1_0' OR startsWith(_part, 'all_1_1_0_'))"
    );
    assert_eq!(
        part_condition("202401_3_7_1_12", true),
        "(_part = '202401_3_7_1' OR startsWith(_part, '202401_3_7_1_'))"
    );
    // Before lightweight deletes, or a name of another shape: only itself.
    assert_eq!(part_condition("all_1_1_0", false), "_part = 'all_1_1_0'");
    assert_eq!(part_condition("odd", true), "_part = 'odd'");
}

#[test]
fn settings_are_checked() {
    assert!(FACTORY.validate(&config(json!({}))).is_ok());
    assert!(FACTORY
        .validate(&config(json!({ "host": "http://h:8123" })))
        .is_err());
    let mut missing = config(json!({}));
    missing.remove("port");
    assert!(FACTORY.validate(&missing).is_err());
}
