//! Live tests against the compose profiles (`make test-db ENGINE=cassandra`
//! or `ENGINE=scylladb`), on with TABLEPEEK_TEST_CASSANDRA=1 or
//! TABLEPEEK_TEST_SCYLLADB=1. They make their own tables in tablepeek_test.

use serde_json::{json, Value};
use tablepeek_types::{ConnConfig, EditTarget, InsertValue, PkValue};

use super::*;
use crate::engines::scylladb;

fn config(port: u16) -> ConnConfig {
    let Value::Object(map) = json!({
        "host": "127.0.0.1",
        "port": port,
        "user": "tablepeek",
        "password": "tablepeek_test_pw",
        "database": "tablepeek_test",
    }) else {
        unreachable!()
    };
    map
}

/// The servers whose flag is on: the factory and its port.
fn servers() -> Vec<(&'static Factory, u16)> {
    let mut out = Vec::new();
    if std::env::var("TABLEPEEK_TEST_CASSANDRA").is_ok() {
        out.push((&FACTORY, 9043));
    }
    if std::env::var("TABLEPEEK_TEST_SCYLLADB").is_ok() {
        out.push((&scylladb::FACTORY, 9044));
    }
    out
}

fn cell(data: &QueryData, row: usize, column: &str) -> Option<String> {
    let index = data.columns.iter().position(|name| name == column)?;
    data.cell_string(row, index)
}

#[tokio::test]
async fn reads_pages_edits_and_traces() {
    for (factory, port) in servers() {
        let driver = factory
            .connect(&config(port), &NetRoute::Direct, SqlLog::new())
            .await
            .expect("connects");
        let sql = driver.sql().expect("a SQL engine");
        sql.query(
            "DROP TABLE IF EXISTS items; CREATE TABLE items (pk int, ck int, tags set<text>, note text, PRIMARY KEY ((pk), ck))",
            10,
        )
        .await
        .expect("makes the table");
        for ck in 0..25 {
            sql.query(
                &format!("INSERT INTO items (pk, ck, tags, note) VALUES (1, {ck}, {{'a', 'b'}}, 'n{ck}')"),
                1,
            )
            .await
            .expect("inserts");
        }

        // Pages follow the paging state, not OFFSET.
        let first = sql
            .query("SELECT * FROM items WHERE pk = 1", 10)
            .await
            .unwrap();
        assert_eq!(first.row_count, 10);
        assert_eq!(first.source_table.as_deref(), Some("items"));
        assert_eq!(first.pk, Some(vec!["pk".into(), "ck".into()]));
        let token = first.next_page.clone().expect("more rows");
        let second = sql
            .query_from("SELECT * FROM items WHERE pk = 1", 10, &token)
            .await
            .unwrap();
        assert_eq!(cell(&second, 0, "ck").as_deref(), Some("10"));
        assert_eq!(cell(&first, 0, "tags").as_deref(), Some(r#"["a","b"]"#));

        // Edits go by the whole key; IF EXISTS refuses a row that isn't there.
        let key = |ck: i64| {
            vec![
                PkValue {
                    column: "pk".into(),
                    value: json!(1),
                },
                PkValue {
                    column: "ck".into(),
                    value: json!(ck),
                },
            ]
        };
        let edit = |ck: i64, column: &str, value: &str| EditTarget {
            table: "items".into(),
            pk: key(ck),
            column: column.into(),
            value: Some(value.into()),
            expr: None,
        };
        assert_eq!(sql.edit(&edit(3, "note", "changed")).await.unwrap(), 1);
        assert_eq!(sql.edit(&edit(3, "tags", r#"["x"]"#)).await.unwrap(), 1);
        assert_eq!(sql.edit(&edit(99, "note", "ghost")).await.unwrap(), 0);
        assert!(sql.edit(&edit(3, "ck", "4")).await.is_err());
        let row = sql
            .query("SELECT note, tags FROM items WHERE pk = 1 AND ck = 3", 1)
            .await
            .unwrap();
        assert_eq!(cell(&row, 0, "note").as_deref(), Some("changed"));
        assert_eq!(cell(&row, 0, "tags").as_deref(), Some(r#"["x"]"#));
        let insert = [
            InsertValue {
                column: "pk".into(),
                value: Some("2".into()),
                expr: None,
            },
            InsertValue {
                column: "ck".into(),
                value: Some("1".into()),
                expr: None,
            },
        ];
        assert_eq!(sql.insert_row("items", &insert).await.unwrap(), 1);
        assert!(sql.insert_row("items", &insert).await.is_err());
        assert_eq!(sql.delete_row("items", &key(4)).await.unwrap(), 1);
        assert_eq!(sql.delete_row("items", &key(4)).await.unwrap(), 0);

        // Filtering off the key needs ALLOW FILTERING, and the error says so.
        let refused = sql
            .query("SELECT * FROM items WHERE note = 'n5'", 10)
            .await
            .err()
            .expect("refused");
        assert!(refused.to_string().contains("ALLOW FILTERING"), "{refused}");
        let syntax = sql
            .query("SELECT * FORM items", 10)
            .await
            .err()
            .expect("syntax error");
        let EngineError::Driver { fields, code, .. } = &syntax else {
            panic!("{syntax}");
        };
        assert_eq!(code.as_deref(), Some("2000"));
        assert_eq!(fields.position.as_ref().and_then(|at| at.line), Some(1));

        // TablePeek's own commands.
        let level = sql.query("CONSISTENCY ONE", 1).await.unwrap();
        assert_eq!(cell(&level, 0, "consistency").as_deref(), Some("ONE"));
        let trace = sql
            .query("EXPLAIN SELECT * FROM items WHERE pk = 1", 1)
            .await
            .unwrap();
        assert!(trace.row_count > 1, "trace events");
        assert_eq!(trace.columns[0], "activity");

        // Structure and objects.
        let detail = sql.table_detail("items").await.unwrap();
        assert!(detail.ddl.as_deref().unwrap_or("").contains("CREATE TABLE"));
        assert_eq!(detail.indexes[0].columns, ["pk", "ck"]);
        assert!(sql
            .databases()
            .await
            .unwrap()
            .contains(&"tablepeek_test".to_string()));
        assert!(!sql.in_tx().await.unwrap());
        assert!(sql.tx(TxOp::Begin).await.is_err());
        let info = driver.server_info().await.unwrap();
        let product = if factory.descriptor().id == "scylladb" {
            "ScyllaDB"
        } else {
            "Apache Cassandra"
        };
        assert!(
            info.version.as_deref().unwrap_or("").starts_with(product),
            "{info:?}"
        );
        sql.query("DROP TABLE items", 1).await.unwrap();
    }
}

#[tokio::test]
async fn walks_counts_estimates_and_adds() {
    for (factory, port) in servers() {
        let driver = factory
            .connect(&config(port), &NetRoute::Direct, SqlLog::new())
            .await
            .expect("connects");
        let sql = driver.sql().expect("a SQL engine");
        sql.query(
            "DROP TABLE IF EXISTS spread; CREATE TABLE spread (pk int, ck int, v text, PRIMARY KEY ((pk), ck))",
            10,
        )
        .await
        .expect("makes the table");
        for pk in 0..200 {
            let rows: Vec<String> = (0..5)
                .map(|ck| {
                    let v = if ck == 0 { "x" } else { "y" };
                    format!("INSERT INTO spread (pk, ck, v) VALUES ({pk}, {ck}, '{v}');")
                })
                .collect();
            sql.query(
                &format!("BEGIN UNLOGGED BATCH {} APPLY BATCH", rows.join(" ")),
                1,
            )
            .await
            .expect("inserts");
        }
        let statement = "SELECT * FROM spread";
        let all = sql.query(statement, 5000).await.unwrap();
        assert_eq!(all.row_count, 1000);
        let row_key = |data: &QueryData, row: usize| {
            (
                cell(data, row, "pk").unwrap(),
                cell(data, row, "ck").unwrap(),
            )
        };

        // A walk passes rows without returning them, noting tokens at
        // multiples of the page size; reading on from where it stopped gives
        // the row that many rows in.
        let walked = sql
            .skip_rows(
                statement,
                &SkipRequest {
                    page: None,
                    offset: 0,
                    rows: 637,
                    mark_every: 100,
                },
                Duration::from_secs(60),
            )
            .await
            .unwrap();
        assert_eq!(walked.skipped, 637);
        let offsets: Vec<usize> = walked.marks.iter().map(|(at, _)| *at).collect();
        // A token a request at most; the walk stops at the last multiple of
        // the page size before the target, so that page has one.
        assert_eq!(offsets, [600]);
        let there = sql
            .query_from(statement, 3, walked.page.as_deref().expect("more rows"))
            .await
            .unwrap();
        assert_eq!(row_key(&there, 0), row_key(&all, 637));
        let (_, at_600) = &walked.marks[0];
        let from_mark = sql.query_from(statement, 1, at_600).await.unwrap();
        assert_eq!(row_key(&from_mark, 0), row_key(&all, 600));
        // From a noted token, onward; past the end, the rows there are.
        let onward = sql
            .skip_rows(
                statement,
                &SkipRequest {
                    page: Some(at_600.clone()),
                    offset: 600,
                    rows: 5000,
                    mark_every: 300,
                },
                Duration::from_secs(60),
            )
            .await
            .unwrap();
        assert_eq!((onward.page.as_deref(), onward.skipped), (None, 400));
        assert!(onward.marks.iter().all(|(at, _)| at % 300 == 0));
        // With no time left a walk stops after one request and says where
        // (here at the mark boundary 900, counting from offset 5).
        let short = sql
            .skip_rows(
                statement,
                &SkipRequest {
                    page: None,
                    offset: 5,
                    rows: 900,
                    mark_every: 10,
                },
                Duration::ZERO,
            )
            .await
            .unwrap();
        assert_eq!(short.skipped, 895, "{short:?}");
        assert!(short.page.is_some());

        // A count in token ranges, several steps, adds up to COUNT(*); with
        // ALLOW FILTERING too; one naming the partition is counted whole.
        let counted = |count: &'static str, first: Option<&'static str>| async move {
            let mut total = 0;
            let mut steps = 0;
            let mut cursor = first.map(str::to_string);
            loop {
                let step = sql
                    .count_step(count, cursor.as_deref(), Duration::ZERO)
                    .await
                    .unwrap();
                total += step.rows;
                steps += 1;
                match step.cursor {
                    Some(next) => cursor = Some(next),
                    None => return (total, steps),
                }
            }
        };
        assert_eq!(counted("SELECT COUNT(*) FROM spread", None).await.0, 1000);
        let (total, steps) = counted("SELECT COUNT(*) FROM spread", Some("64:0")).await;
        assert_eq!((total, steps), (1000, 4));
        let (filtered, _) = counted(
            "SELECT COUNT(*) FROM spread WHERE \"v\" = 'x' ALLOW FILTERING",
            Some("32:0"),
        )
        .await;
        assert_eq!(filtered, 200);
        assert_eq!(
            counted("SELECT COUNT(*) FROM spread WHERE \"pk\" = 3", Some("32:0")).await,
            (5, 1)
        );
        assert_eq!(sql.table_count("spread").await.unwrap(), 1000);

        // The estimate samples the ring: 200 partitions, 5 rows each.
        let detail = sql.table_detail("spread").await.unwrap();
        assert_eq!(detail.row_count_estimate, Some(1000));

        // Counters: a typed value changes by its difference from the one the
        // grid showed, refused once the counter moved; an amount adds.
        sql.query(
            "DROP TABLE IF EXISTS hits; CREATE TABLE hits (k int PRIMARY KEY, n counter)",
            10,
        )
        .await
        .unwrap();
        let row = [
            InsertValue {
                column: "k".into(),
                value: Some("1".into()),
                expr: None,
            },
            InsertValue {
                column: "n".into(),
                value: Some("5".into()),
                expr: None,
            },
        ];
        assert_eq!(sql.insert_row("hits", &row).await.unwrap(), 1);
        assert!(sql.insert_row("hits", &row).await.is_err(), "row exists");
        let target = |value: &str| EditTarget {
            table: "hits".into(),
            pk: vec![PkValue {
                column: "k".into(),
                value: json!(1),
            }],
            column: "n".into(),
            value: Some(value.into()),
            expr: None,
        };
        let seen = |n: i64| {
            vec![
                PkValue {
                    column: "k".into(),
                    value: json!(1),
                },
                PkValue {
                    column: "n".into(),
                    value: json!(n),
                },
            ]
        };
        let value_now = || async {
            let data = sql
                .query("SELECT n FROM hits WHERE k = 1", 1)
                .await
                .unwrap();
            cell(&data, 0, "n").unwrap()
        };
        assert_eq!(sql.edit_seen(&target("8"), &seen(5)).await.unwrap(), 1);
        assert_eq!(value_now().await, "8");
        let moved = sql
            .edit_seen(&target("20"), &seen(5))
            .await
            .expect_err("moved");
        assert!(moved.to_string().contains("8"), "{moved}");
        assert_eq!(value_now().await, "8");
        assert_eq!(sql.edit_add(&target("-3")).await.unwrap(), 1);
        assert_eq!(value_now().await, "5");
        assert!(
            sql.edit(&target("9")).await.is_err(),
            "needs the shown value"
        );
        let note = EditTarget {
            table: "spread".into(),
            pk: vec![
                PkValue {
                    column: "pk".into(),
                    value: json!(1),
                },
                PkValue {
                    column: "ck".into(),
                    value: json!(1),
                },
            ],
            column: "v".into(),
            value: Some("1".into()),
            expr: None,
        };
        assert!(sql.edit_add(&note).await.is_err(), "adds only to counters");
        // CREATE TABLE … AS SELECT copies structure and rows, counters too.
        sql.query(
            "DROP TABLE IF EXISTS spread_copy; DROP TABLE IF EXISTS hits_copy",
            1,
        )
        .await
        .unwrap();
        let copied = sql
            .query("CREATE TABLE spread_copy AS SELECT * FROM spread", 1)
            .await
            .unwrap();
        assert_eq!(cell(&copied, 0, "copied").as_deref(), Some("1000"));
        assert_eq!(sql.table_count("spread_copy").await.unwrap(), 1000);
        sql.query("CREATE TABLE hits_copy AS SELECT * FROM hits", 1)
            .await
            .unwrap();
        let counter = sql
            .query("SELECT n FROM hits_copy WHERE k = 1", 1)
            .await
            .unwrap();
        assert_eq!(cell(&counter, 0, "n").as_deref(), Some("5"));
        sql.query(
            "DROP TABLE hits; DROP TABLE spread; DROP TABLE hits_copy; DROP TABLE spread_copy",
            1,
        )
        .await
        .unwrap();
    }
}
