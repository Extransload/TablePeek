//! Statement preparation, value text and settings, then live tests against
//! the test server (`make test-db ENGINE=oracle`), run with
//! TABLEPEEK_TEST_ORACLE=1. The live tests read testdb/oracle.sql's
//! TABLEPEEK schema and make their own tables in it.

use std::time::Duration;

use serde_json::{json, Value};
use tablepeek_types::{ConnConfig, EditTarget, InsertValue, PkValue, ValueExpr};

use super::query::{prepare, Plsql};
use super::values::{write_sql, Binds, Bound, Target};
use super::{resolve, settings, FACTORY};
use crate::registry::{DriverFactory, NetRoute, TunnelTarget};
use crate::sql_log::{inline_params, Dialect, LogParam};
use crate::{Engine, EngineError};

fn form(value: Value) -> ConnConfig {
    value.as_object().cloned().unwrap()
}

#[test]
fn statements_lose_their_terminators_but_plsql_keeps_end() {
    assert_eq!(prepare("SELECT 1 FROM dual;").sql, "SELECT 1 FROM dual");
    assert_eq!(prepare("SELECT 1 FROM dual\n/").sql, "SELECT 1 FROM dual");
    assert_eq!(
        prepare("  UPDATE t SET a = 1 ;  ").sql,
        "  UPDATE t SET a = 1"
    );
    let block = prepare("BEGIN\n  NULL;\nEND;\n/\n");
    assert_eq!(block.sql, "BEGIN\n  NULL;\nEND;");
    assert_eq!(block.plsql, Some(Plsql::Block));
    assert_eq!(
        prepare("DECLARE x NUMBER; BEGIN x := 1; END;").plsql,
        Some(Plsql::Block)
    );
    let call = prepare("CALL p(1);");
    assert_eq!(call.sql, "CALL p(1)");
    let exec = prepare("exec shop.mark_shipped(5);");
    assert_eq!(exec.sql, "BEGIN shop.mark_shipped(5); END;");
    assert!(exec.rewritten);
    assert!(prepare("EXPLAIN PLAN FOR SELECT 1 FROM dual").explain);
    // A comment that mentions a `;` stays.
    assert_eq!(
        prepare("SELECT 1 FROM dual -- ok;").sql,
        "SELECT 1 FROM dual -- ok"
    );
}

#[test]
fn created_units_are_named_for_their_compile_errors() {
    let unit = |sql: &str| prepare(sql).plsql;
    assert_eq!(
        unit("CREATE OR REPLACE PROCEDURE p AS BEGIN NULL; END;"),
        Some(Plsql::Unit {
            kind: "PROCEDURE",
            owner: None,
            name: "P".into(),
            line: 1
        })
    );
    assert_eq!(
        unit("-- note\nCREATE OR REPLACE EDITIONABLE PACKAGE BODY hr.\"Pkg\" AS END;"),
        Some(Plsql::Unit {
            kind: "PACKAGE BODY",
            owner: Some("HR".into()),
            name: "Pkg".into(),
            line: 2
        })
    );
    assert_eq!(
        unit("create type point_t as object (x number);"),
        Some(Plsql::Unit {
            kind: "TYPE",
            owner: None,
            name: "POINT_T".into(),
            line: 1
        })
    );
    // CREATE TYPE keeps its `;`; CREATE VIEW, being SQL, loses it.
    assert!(prepare("create type point_t as object (x number);")
        .sql
        .ends_with(';'));
    let view = prepare("CREATE OR REPLACE FORCE VIEW v AS SELECT 1 a FROM dual;");
    assert_eq!(
        view.sql,
        "CREATE OR REPLACE FORCE VIEW v AS SELECT 1 a FROM dual"
    );
    assert!(matches!(view.plsql, Some(Plsql::Unit { kind: "VIEW", .. })));
    assert_eq!(unit("CREATE TABLE t (a NUMBER)"), None);
}

#[test]
fn cell_text_becomes_typed_sql() {
    let written = |target: Target, value: Option<&str>, expr: Option<ValueExpr>| {
        let mut binds = Binds::default();
        let sql = write_sql(target, value, expr, &mut binds).unwrap();
        let texts: Vec<Option<String>> = binds
            .values
            .iter()
            .map(|bound| match bound {
                Bound::Text(text) => text.clone(),
                Bound::Bytes(bytes) => bytes.as_ref().map(|bytes| format!("{bytes:?}")),
            })
            .collect();
        (sql, texts)
    };
    assert_eq!(
        written(Target::Date, Some("2024-02-29T10:30"), None),
        (
            "TO_DATE(:1, 'YYYY-MM-DD HH24:MI:SS')".into(),
            vec![Some("2024-02-29 10:30:00".into())]
        )
    );
    assert_eq!(
        written(Target::TimestampTz, Some("2024-02-29 10:30:00.5Z"), None).1,
        vec![Some("2024-02-29 10:30:00.5 +00:00".into())]
    );
    assert_eq!(
        written(Target::TimestampTz, Some("2024-02-29 10:30:00 +0900"), None).1,
        vec![Some("2024-02-29 10:30:00.0 +09:00".into())]
    );
    assert_eq!(
        written(Target::Timestamp, Some("2024-02-29"), None).1,
        vec![Some("2024-02-29 00:00:00.0".into())]
    );
    assert_eq!(
        written(Target::Number, Some(" 12.5 "), None).0,
        "TO_NUMBER(:1)"
    );
    assert_eq!(
        written(Target::Binary, Some("0x00FF"), None).1,
        vec![Some("[0, 255]".into())]
    );
    assert_eq!(written(Target::Text, None, None), (":1".into(), vec![None]));
    assert_eq!(
        written(Target::Timestamp, None, Some(ValueExpr::Now)).0,
        "SYSTIMESTAMP"
    );
    assert_eq!(
        written(Target::Date, None, Some(ValueExpr::Now)).0,
        "SYSDATE"
    );
    assert_eq!(
        written(Target::Text, None, Some(ValueExpr::Default)).0,
        "DEFAULT"
    );
    assert_eq!(written(Target::Bool, Some("yes"), None).0, "TRUE");
    let long = "가".repeat(2500);
    let (sql, binds) = written(Target::Clob, Some(&long), None);
    assert_eq!(sql, "TO_CLOB(:1) || TO_CLOB(:2) || TO_CLOB(:3)");
    assert_eq!(binds.len(), 3);
    let mut binds = Binds::default();
    assert!(write_sql(Target::Binary, Some("not hex"), None, &mut binds).is_err());
    // A BLOB value past a RAW bind goes into a temporary BLOB, in pieces.
    let mut binds = Binds::default();
    let hex = format!("0x{}", "AB".repeat(40_000));
    assert_eq!(
        write_sql(Target::Blob, Some(&hex), None, &mut binds).unwrap(),
        "blob1"
    );
    assert_eq!(binds.lob_values.len(), 2);
    assert!(binds.values.is_empty());
    assert!(binds.lobs[0].starts_with("DBMS_LOB.CREATETEMPORARY(blob1, TRUE);"));
    assert!(binds.lobs[0].contains("UTL_RAW.LENGTH(:blob1_2), :blob1_2"));
}

#[test]
fn settings_make_connect_strings() {
    let descriptor = FACTORY.descriptor();
    let service = settings(
        descriptor,
        &form(json!({ "host": "db.example.com", "port": 1522, "database": "ORCLPDB1", "user": "hr", "tls": true })),
    )
    .unwrap();
    let resolved = resolve(&service);
    assert_eq!(
        resolved.connect_string,
        "tcps://db.example.com:1522/ORCLPDB1"
    );
    assert!(resolved.wallet_dir.is_none());
    let sid = settings(
        descriptor,
        &form(
            json!({ "connect_mode": "sid", "host": "::1", "database": "ORCL", "user": "hr",
                      "privilege": "sysdba" }),
        ),
    )
    .unwrap();
    let resolved = resolve(&sid);
    assert_eq!(
        resolved.connect_string,
        "(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=[::1])(PORT=1521))(CONNECT_DATA=(SID=ORCL)))"
    );
    assert_eq!(resolved.auth_mode, oracledb::AUTH_MODE_SYSDBA);
    let alias = settings(
        descriptor,
        &form(json!({ "connect_mode": "descriptor", "connect_string": " PROD ", "user": "app",
                      "tnsnames_file": "/etc/oracle/tnsnames.ora", "wallet_file": "/w/ewallet.pem" })),
    )
    .unwrap();
    let resolved = resolve(&alias);
    assert_eq!(resolved.connect_string, "PROD");
    assert_eq!(resolved.config_dir.as_deref(), Some("/etc/oracle"));
    assert_eq!(resolved.wallet_dir.as_deref(), Some("/w"));

    // Strings with credentials and missing parts.
    assert!(settings(
        descriptor,
        &form(json!({ "connect_mode": "descriptor", "connect_string": "scott/tiger@db/x" }))
    )
    .is_err());
    assert!(settings(descriptor, &form(json!({ "host": "db", "user": "hr" }))).is_err());
    assert!(settings(
        descriptor,
        &form(json!({ "host": "oracle://db", "database": "x" }))
    )
    .is_err());

    // A tunnel on a string leads to each address in it: one gets a local
    // end, several get the tunnel (one local end each, made by the driver).
    let target = |extra: Value| {
        let mut fields = json!({ "connect_mode": "descriptor", "user": "app" });
        fields
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        FACTORY.tunnel_target(&form(fields))
    };
    assert_eq!(
        target(json!({ "connect_string": "tcps://db.example.com:2484/ORCL" })).unwrap(),
        TunnelTarget::Address("db.example.com".into(), 2484)
    );
    let tns = std::env::temp_dir().join(format!("tablepeek-oracle-tns-{}", std::process::id()));
    std::fs::create_dir_all(&tns).unwrap();
    std::fs::write(
        tns.join("tnsnames.ora"),
        "PROD = (DESCRIPTION = (ADDRESS_LIST = (ADDRESS = (PROTOCOL = TCP)(HOST = a.example)(PORT = 1521))\n  \
         (ADDRESS = (PROTOCOL = TCPS)(HOST = b.example)(PORT = 2484)))\n  (CONNECT_DATA = (SERVICE_NAME = prod)))\n",
    )
    .unwrap();
    let tnsnames = tns.join("tnsnames.ora").to_string_lossy().into_owned();
    assert_eq!(
        target(json!({ "connect_string": "PROD", "tnsnames_file": tnsnames })).unwrap(),
        TunnelTarget::Members
    );
    let prod = settings(
        descriptor,
        &form(
            json!({ "connect_mode": "descriptor", "connect_string": "PROD", "user": "app",
                      "tnsnames_file": tnsnames }),
        ),
    )
    .unwrap();
    let mut resolved = resolve(&prod);
    let addresses = resolved.addresses().unwrap();
    assert_eq!(
        addresses,
        vec![
            ("a.example".to_string(), 1521),
            ("b.example".to_string(), 2484)
        ]
    );
    // Through a tunnel each address is dialed through a local end, and the
    // descriptor keeps the server's names (TCPS checks against them).
    for ((host, port), local) in addresses.into_iter().zip([10001_u16, 10002]) {
        resolved.routes.push((
            host,
            port,
            std::net::SocketAddr::from(([127, 0, 0, 1], local)),
        ));
    }
    let full = resolved.driver_config().unwrap().get_connect_descriptor();
    std::fs::remove_dir_all(&tns).unwrap();
    assert!(
        full.contains("(PROTOCOL=tcp)(HOST=a.example)(PORT=1521)"),
        "{full}"
    );
    assert!(
        full.contains("(PROTOCOL=tcps)(HOST=b.example)(PORT=2484)"),
        "{full}"
    );
    assert!(full.contains("(SERVICE_NAME=prod)"), "{full}");
    assert!(target(
        json!({ "connect_string": "NOPE", "tnsnames_file": "/nonexistent/tnsnames.ora" })
    )
    .is_err());
}

#[test]
fn the_console_shows_oracle_binds_quotes_and_hides_passwords() {
    let shown = inline_params(
        "UPDATE t SET a = :1, b = q'[it's :2]' WHERE id = :2",
        &[LogParam::Text("x'y".into()), LogParam::Int(7)],
        Dialect::Oracle,
    );
    assert_eq!(
        shown,
        "UPDATE t SET a = 'x''y', b = q'[it's :2]' WHERE id = 7"
    );
    let log = crate::sql_log::SqlLog::new();
    log.record(
        "CREATE USER bob IDENTIFIED BY \"S3cret pw\"",
        Dialect::Oracle,
    );
    log.record(
        "ALTER USER bob IDENTIFIED BY plain_pw ACCOUNT UNLOCK",
        Dialect::Oracle,
    );
    let (entries, _) = log.since(None);
    assert!(!entries[0].sql.contains("S3cret"), "{}", entries[0].sql);
    assert!(!entries[1].sql.contains("plain_pw"), "{}", entries[1].sql);
    assert!(entries[1].sql.contains("ACCOUNT UNLOCK"));
}

// Live tests.

static TURN: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn config(extra: Value) -> ConnConfig {
    let mut config = json!({
        "host": "127.0.0.1",
        "port": 15210,
        "database": "FREEPDB1",
        "user": "tablepeek",
        "password": "tablepeek_test_pw",
    });
    if let (Some(base), Value::Object(extra)) = (config.as_object_mut(), extra) {
        base.extend(extra);
    }
    config.as_object().cloned().unwrap()
}

async fn connect(extra: Value) -> Option<(Engine, tokio::sync::MutexGuard<'static, ()>)> {
    std::env::var("TABLEPEEK_TEST_ORACLE").ok()?;
    let turn = TURN.lock().await;
    let engine = Engine::open_demo(1).unwrap();
    engine
        .swap_to(&FACTORY, &config(extra), &NetRoute::Direct)
        .await
        .unwrap();
    Some((engine, turn))
}

fn driver_error(
    error: &EngineError,
) -> (
    Option<String>,
    Option<i64>,
    Option<tablepeek_types::ErrorPosition>,
    bool,
) {
    match error {
        EngineError::Driver {
            code,
            fields,
            interrupted,
            ..
        } => (
            code.clone(),
            fields.server_code,
            fields.position,
            *interrupted,
        ),
        other => panic!("not a driver error: {other:?}"),
    }
}

#[tokio::test]
async fn oracle_lists_schemas_objects_and_structure() {
    let Some((engine, _turn)) = connect(json!({})).await else {
        return;
    };
    let meta = engine.meta(false).await.unwrap();
    assert_eq!(meta.kind, "oracle");
    assert!(
        meta.tables.contains(&"USERS".to_string()),
        "{:?}",
        meta.tables
    );
    assert!(meta.tables.contains(&"KINDS".to_string()));
    // Another schema's tables, qualified; the MV's container table left out.
    assert!(meta.tables.contains(&"SHOP.CUSTOMERS".to_string()));
    assert!(!meta.tables.contains(&"USER_TOTALS".to_string()));
    let capabilities = meta.capabilities.unwrap();
    assert_eq!(capabilities.explain.as_deref(), Some("oracle"));

    let objects = engine.objects(false).await.unwrap();
    assert!(
        objects.views.contains(&"ACTIVE_USERS".to_string()),
        "{objects:?}"
    );
    assert!(objects
        .materialized_views
        .contains(&"USER_TOTALS".to_string()));
    assert!(objects.sequences.contains(&"KINDS_SEQ".to_string()));
    assert!(objects.synonyms.contains(&"CUSTOMERS".to_string()));
    assert!(objects.packages.contains(&"TP_PKG".to_string()));
    assert!(objects.procedures.contains(&"TP_PROC".to_string()));
    assert!(objects.functions.contains(&"TP_DOUBLE".to_string()));
    assert!(objects.triggers.contains(&"KINDS_BI".to_string()));
    assert!(objects.types.contains(&"POINT_T".to_string()));

    let package = engine
        .object_definition("package", "TP_PKG")
        .await
        .unwrap()
        .unwrap();
    let ddl = package.ddl.unwrap();
    assert!(
        ddl.contains("PACKAGE") && ddl.contains("PACKAGE BODY"),
        "{ddl}"
    );
    assert!(ddl.trim_end().ends_with('/'));
    for (kind, name) in [
        ("view", "ACTIVE_USERS"),
        ("materialized_view", "USER_TOTALS"),
        ("sequence", "KINDS_SEQ"),
        ("synonym", "CUSTOMERS"),
        ("procedure", "TP_PROC"),
        ("function", "TP_DOUBLE"),
        ("trigger", "KINDS_BI"),
        ("type", "POINT_T"),
    ] {
        let found = engine.object_definition(kind, name).await.unwrap();
        assert!(
            found.is_some_and(|found| found.ddl.is_some()),
            "{kind} {name}"
        );
    }
    assert!(engine
        .object_definition("view", "NO_SUCH")
        .await
        .unwrap()
        .is_none());

    let schema = engine.schema(false).await.unwrap();
    let kinds = schema.iter().find(|table| table.name == "KINDS").unwrap();
    let id = kinds
        .columns
        .iter()
        .find(|column| column.name == "ID")
        .unwrap();
    assert!(id.pk && id.not_null);
    assert_eq!(id.decl_type.as_deref(), Some("NUMBER(10)"));
    let label = kinds
        .columns
        .iter()
        .find(|column| column.name == "LABEL")
        .unwrap();
    assert_eq!(label.decl_type.as_deref(), Some("VARCHAR2(40 CHAR)"));
    assert_eq!(label.default.as_deref(), Some("'none'"));

    let relations = engine.relations(false).await.unwrap();
    assert!(relations
        .iter()
        .any(|relation| relation.table == "ORDERS" && relation.ref_table == "USERS"));

    let detail = engine.table_detail("ORDERS").await.unwrap();
    assert_eq!(detail.foreign_keys[0].ref_table, "USERS");
    assert!(detail.indexes.iter().any(|index| index.primary));
    assert!(detail.indexes.iter().any(|index| index
        .parts
        .as_ref()
        .is_some_and(|parts| parts.iter().any(|part| part.descending))));
    assert!(
        detail.ddl.as_deref().unwrap().starts_with("CREATE TABLE"),
        "{:?}",
        detail.ddl
    );
    assert_eq!(detail.comment.as_deref(), Some("Orders the tests read"));
    let kinds_detail = engine.table_detail("KINDS").await.unwrap();
    assert_eq!(kinds_detail.triggers[0].name, "KINDS_BI");
    assert_eq!(kinds_detail.triggers[0].timing.as_deref(), Some("BEFORE"));
    let other = engine.table_detail("SHOP.CUSTOMERS").await.unwrap();
    assert_eq!(other.schema.as_deref(), Some("SHOP"));
    assert!(matches!(
        engine.table_detail("NOPE").await,
        Err(EngineError::TableNotFound)
    ));
    assert_eq!(engine.table_count("USERS").await.unwrap(), 5000);

    // DDL is kept per object: a second look doesn't ask DBMS_METADATA again
    // (most of the first look's time), and a statement that changes the
    // table makes the next look read it anew.
    for sql in [
        "BEGIN EXECUTE IMMEDIATE 'DROP TABLE tp_ddl PURGE'; EXCEPTION WHEN OTHERS THEN NULL; END;",
        "CREATE TABLE tp_ddl (id NUMBER PRIMARY KEY)",
    ] {
        engine.query(sql, 1).await.unwrap();
    }
    let started = std::time::Instant::now();
    let first = engine.table_detail("TP_DDL").await.unwrap().ddl.unwrap();
    let first_took = started.elapsed();
    let started = std::time::Instant::now();
    let again = engine.table_detail("TP_DDL").await.unwrap().ddl.unwrap();
    let again_took = started.elapsed();
    assert_eq!(first, again);
    assert!(
        again_took < first_took.mul_f32(0.75),
        "{first_took:?} then {again_took:?}"
    );
    assert!(!first.contains("EXTRA"));
    engine
        .query("ALTER TABLE tp_ddl ADD (extra NUMBER)", 1)
        .await
        .unwrap();
    let changed = engine.table_detail("TP_DDL").await.unwrap().ddl.unwrap();
    assert!(changed.contains("\"EXTRA\""), "{changed}");
    engine.query("DROP TABLE tp_ddl PURGE", 1).await.unwrap();
}

#[tokio::test]
async fn oracle_reads_every_type_and_pages() {
    let Some((engine, _turn)) = connect(json!({})).await else {
        return;
    };
    let data = engine
        .query("SELECT * FROM kinds WHERE id = 1", 10)
        .await
        .unwrap();
    assert_eq!(data.source_table.as_deref(), Some("KINDS"));
    assert_eq!(data.pk, Some(vec!["ID".to_string()]));
    let row = &data.rows_json()[0];
    let at = |name: &str| {
        row[data
            .columns
            .iter()
            .position(|column| column == name)
            .unwrap()]
        .clone()
    };
    assert_eq!(at("ID"), json!(1));
    assert_eq!(at("D"), json!("2024-02-29 13:45:10"));
    assert_eq!(at("TS"), json!("2024-02-29 13:45:10.123456"));
    assert_eq!(at("TSTZ"), json!("2024-02-29 04:45:10.123 +00:00"));
    assert_eq!(at("IDS"), json!("+01 02:03:04.500000"));
    assert_eq!(at("IYM"), json!("+02-03"));
    assert_eq!(at("N"), json!("12345678901234567890.123"));
    // NUMBER keeps no trailing zeros.
    assert_eq!(at("PRICE"), json!("9.9"));
    assert_eq!(at("F"), json!(1.5));
    assert_eq!(at("R"), json!("0x00FF10"));
    assert_eq!(at("C"), json!("긴 텍스트 CLOB"));
    assert_eq!(at("B"), json!("0xDEADBEEF"));
    assert_eq!(at("NV"), json!("한글"));
    assert_eq!(at("FLAG"), json!("true"));
    assert_eq!(at("DOC"), json!("{\"a\":[1,2]}"));

    let page = engine
        .query(
            "SELECT id FROM users ORDER BY id OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY",
            300,
        )
        .await
        .unwrap();
    assert_eq!(page.rows_json()[0][0], json!(11));
    assert_eq!(page.row_count, 5);
    let cut = engine.query("SELECT id FROM users", 10).await.unwrap();
    assert!(cut.truncated && cut.row_count == 10);
    let count = engine
        .query("SELECT COUNT(*) FROM orders", 1)
        .await
        .unwrap();
    assert_eq!(count.rows_json()[0][0], json!(20000));
}

#[tokio::test]
async fn oracle_edits_by_key_and_follows_transactions() {
    let Some((engine, _turn)) = connect(json!({})).await else {
        return;
    };
    for sql in [
        "BEGIN EXECUTE IMMEDIATE 'DROP TABLE tp_edit PURGE'; EXCEPTION WHEN OTHERS THEN NULL; END;",
        "CREATE TABLE tp_edit (id NUMBER(10) PRIMARY KEY, name VARCHAR2(40), at DATE, \
         stamp TIMESTAMP WITH TIME ZONE, bytes RAW(8), memo CLOB, note VARCHAR2(20) DEFAULT 'n/a', pic BLOB)",
    ] {
        engine.query(sql, 1).await.unwrap();
    }
    let value = |column: &str, text: Option<&str>| InsertValue {
        column: column.into(),
        value: text.map(str::to_string),
        expr: None,
    };
    engine
        .insert_values(
            "TP_EDIT",
            &[
                value("ID", Some("1")),
                value("NAME", Some("first")),
                value("BYTES", Some("0xCAFE")),
            ],
        )
        .await
        .unwrap();
    let key = vec![PkValue {
        column: "ID".into(),
        value: json!(1),
    }];
    let edit = |column: &str, text: Option<&str>, expr: Option<ValueExpr>| EditTarget {
        table: "TP_EDIT".into(),
        pk: key.clone(),
        column: column.into(),
        value: text.map(str::to_string),
        expr,
    };
    assert_eq!(
        engine
            .edit(&edit("AT", Some("2025-01-02 03:04:05"), None))
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        engine
            .edit(&edit("STAMP", Some("2025-01-02T03:04:05+09:00"), None))
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        engine
            .edit(&edit("MEMO", Some(&"x".repeat(5000)), None))
            .await
            .unwrap(),
        1
    );
    assert_eq!(
        engine
            .edit(&edit("NOTE", None, Some(ValueExpr::Default)))
            .await
            .unwrap(),
        1
    );
    assert_eq!(engine.edit(&edit("NAME", None, None)).await.unwrap(), 1);
    // 40,002 bytes: past a RAW bind and a PL/SQL RAW, so two pieces.
    let picture = format!("0x{}", "C0FFEE".repeat(13_334));
    assert_eq!(
        engine
            .edit(&edit("PIC", Some(&picture), None))
            .await
            .unwrap(),
        1
    );
    let row = engine
        .query(
            "SELECT at, stamp, bytes, LENGTH(memo), note, name, DBMS_LOB.GETLENGTH(pic), \
             RAWTOHEX(DBMS_LOB.SUBSTR(pic, 3, 39999)) FROM tp_edit WHERE id = 1",
            1,
        )
        .await
        .unwrap()
        .rows_json()[0]
        .clone();
    assert_eq!(
        row,
        vec![
            json!("2025-01-02 03:04:05"),
            json!("2025-01-01 18:04:05.000000 +00:00"),
            json!("0xCAFE"),
            json!(5000),
            json!("n/a"),
            Value::Null,
            json!(40_002),
            json!("EEC0FF"),
        ]
    );
    // A bad value names its ORA code.
    let error = engine
        .edit(&edit("AT", Some("not a date"), None))
        .await
        .unwrap_err();
    assert!(driver_error(&error).1.is_some(), "{error:?}");

    // Inside a transaction the change waits for COMMIT; ROLLBACK undoes it.
    engine.begin_tx().await.unwrap();
    engine
        .edit(&edit("NAME", Some("in tx"), None))
        .await
        .unwrap();
    engine.rollback_tx().await.unwrap();
    let name = engine
        .query("SELECT name FROM tp_edit WHERE id = 1", 1)
        .await
        .unwrap();
    assert_eq!(name.rows_json()[0][0], Value::Null);
    engine.begin_tx().await.unwrap();
    engine
        .edit(&edit("NAME", Some("kept"), None))
        .await
        .unwrap();
    engine.commit_tx().await.unwrap();
    // COMMIT and DDL from the editor end a transaction too.
    engine.begin_tx().await.unwrap();
    engine
        .query("UPDATE tp_edit SET name = 'via editor'", 1)
        .await
        .unwrap();
    engine.query("COMMIT", 1).await.unwrap();
    assert!(matches!(
        engine.commit_tx().await,
        Err(EngineError::BadRequest(_))
    ));

    assert_eq!(engine.delete_row("TP_EDIT", &key).await.unwrap(), 1);
    engine.query("DROP TABLE tp_edit PURGE", 1).await.unwrap();
}

#[tokio::test]
async fn oracle_reports_errors_plans_output_and_compile_errors() {
    let Some((engine, _turn)) = connect(json!({})).await else {
        return;
    };
    let error = engine
        .query("SELECT * FROM no_such_table", 1)
        .await
        .err()
        .unwrap();
    let (code, server_code, position, _) = driver_error(&error);
    assert_eq!(code.as_deref(), Some("942"));
    assert_eq!(server_code, Some(942));
    assert_eq!(position.and_then(|position| position.offset), Some(15));
    assert!(error.to_string().contains("ORA-00942"), "{error}");

    let plan = engine
        .query("EXPLAIN PLAN FOR SELECT * FROM orders o JOIN users u ON u.id = o.user_id WHERE u.id = 3", 100)
        .await
        .unwrap();
    assert_eq!(plan.columns, vec!["PLAN_TABLE_OUTPUT".to_string()]);
    let text: Vec<String> = plan
        .rows_json()
        .iter()
        .map(|row| row[0].as_str().unwrap_or_default().to_string())
        .collect();
    assert!(text.iter().any(|line| line.contains("| Id")), "{text:?}");

    let output = engine
        .query(
            "BEGIN DBMS_OUTPUT.PUT_LINE('hello'); DBMS_OUTPUT.PUT_LINE('세계'); END;",
            10,
        )
        .await
        .unwrap();
    assert_eq!(output.columns, vec!["DBMS_OUTPUT".to_string()]);
    assert_eq!(
        output.rows_json(),
        vec![vec![json!("hello")], vec![json!("세계")]]
    );
    let exec = engine.query("EXEC tp_proc(2)", 10).await.unwrap();
    assert_eq!(exec.rows_json(), vec![vec![json!("tp_proc 4")]]);

    let broken = engine
        .query(
            "CREATE OR REPLACE PROCEDURE tp_broken AS\nBEGIN\n  no_such_thing;\nEND;",
            1,
        )
        .await
        .err()
        .unwrap();
    let (code, _, position, _) = driver_error(&broken);
    assert_eq!(code.as_deref(), Some("24344"));
    assert_eq!(position.and_then(|position| position.line), Some(3));
    engine.query("DROP PROCEDURE tp_broken", 1).await.unwrap();

    let info = engine.server_info().await.unwrap();
    assert!(info.version.unwrap().contains("Oracle"));
    let sessions = info.sessions.unwrap();
    let mine = sessions.iter().find(|session| session.is_current).unwrap();
    assert!(mine.id.contains(','));
    assert!(info.can_kill);
    assert!(matches!(
        engine.kill_session(&mine.id).await,
        Err(EngineError::BadRequest(_))
    ));
    assert!(matches!(
        engine.kill_session("nope").await,
        Err(EngineError::BadRequest(_))
    ));
}

#[tokio::test]
async fn oracle_cancels_with_and_without_the_right_to() {
    // From this machine the test server takes no out-of-band breaks (its
    // image sets DISABLE_OOB=ON, and Docker Desktop's port forwarding drops
    // TCP urgent data): TABLEPEEK stops the call with ALTER SYSTEM CANCEL
    // SQL and keeps its session and transaction; SHOP, without the right,
    // can only give its session up. The out-of-band break itself is tested
    // on the test network (make test-oracle-oob).
    for (user, password, keeps_session) in [
        ("tablepeek", "tablepeek_test_pw", true),
        ("shop", "tablepeek_test_pw", false),
    ] {
        let Some((engine, _turn)) = connect(json!({ "user": user, "password": password })).await
        else {
            return;
        };
        assert_eq!(
            engine.capabilities().unwrap().cancel_ends_session,
            !keeps_session,
            "{user}"
        );
        let _ = engine
            .query("BEGIN EXECUTE IMMEDIATE 'DROP TABLE tp_cancel'; EXCEPTION WHEN OTHERS THEN NULL; END;", 1)
            .await;
        engine
            .query("CREATE TABLE tp_cancel (n NUMBER)", 1)
            .await
            .unwrap();
        engine.begin_tx().await.unwrap();
        engine
            .query("INSERT INTO tp_cancel VALUES (7)", 1)
            .await
            .unwrap();
        let engine = std::sync::Arc::new(engine);
        let running = {
            let engine = engine.clone();
            tokio::spawn(async move { engine.query("BEGIN DBMS_SESSION.SLEEP(10); END;", 1).await })
        };
        tokio::time::sleep(Duration::from_millis(1500)).await;
        let started = std::time::Instant::now();
        engine.cancel();
        let outcome = tokio::time::timeout(Duration::from_secs(10), running)
            .await
            .expect("the cancel landed")
            .unwrap();
        let error = outcome.err().unwrap();
        assert!(error.is_interrupted(), "{user}: {error:?}");
        if keeps_session {
            assert!(
                started.elapsed() < Duration::from_secs(4),
                "{user}: {:?}",
                started.elapsed()
            );
            assert_eq!(driver_error(&error).0.as_deref(), Some("1013"), "{error:?}");
            assert!(error.to_string().contains("트랜잭션은 그대로"), "{error}");
            // The transaction is still open, with its row.
            assert!(engine.in_tx().await.unwrap());
            let rows = engine
                .query("SELECT COUNT(*) FROM tp_cancel", 1)
                .await
                .unwrap();
            assert_eq!(rows.rows_json()[0][0], json!(1));
            engine.rollback_tx().await.unwrap();
        } else {
            assert!(!engine.in_tx().await.unwrap());
            let _ = engine.rollback_tx().await;
        }
        // The connection works on, in the same session or a new one.
        let rows = engine
            .query("SELECT COUNT(*) FROM tp_cancel", 1)
            .await
            .unwrap();
        assert_eq!(rows.rows_json()[0][0], json!(0), "{user}");
        // A session given up holds its row's lock until its call ends.
        let mut dropped = engine.query("DROP TABLE tp_cancel", 1).await;
        for _ in 0..30 {
            if dropped.is_ok() {
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
            dropped = engine.query("DROP TABLE tp_cancel", 1).await;
        }
        dropped.unwrap();
    }
}

#[tokio::test]
async fn oracle_stops_at_the_query_time_limit() {
    let Some((engine, _turn)) = connect(json!({})).await else {
        return;
    };
    engine.set_query_timeout(1);
    let error = engine
        .query("BEGIN DBMS_SESSION.SLEEP(5); END;", 1)
        .await
        .err()
        .unwrap();
    assert!(error.is_interrupted(), "{error:?}");
    engine.set_query_timeout(0);
    assert_eq!(
        engine
            .query("SELECT 2 FROM dual", 1)
            .await
            .unwrap()
            .rows_json()[0][0],
        json!(2)
    );
}

#[tokio::test]
async fn oracle_connects_by_sid_and_string_and_reports_bad_logins() {
    if std::env::var("TABLEPEEK_TEST_ORACLE").is_err() {
        return;
    }
    let _turn = TURN.lock().await;
    let engine = Engine::open_demo(1).unwrap();
    let wrong = engine
        .swap_to(
            &FACTORY,
            &config(json!({ "password": "wrong" })),
            &NetRoute::Direct,
        )
        .await
        .unwrap_err();
    assert_eq!(driver_error(&wrong).1, Some(1017), "{wrong:?}");
    let missing = engine
        .swap_to(
            &FACTORY,
            &config(json!({ "database": "NO_SUCH_SERVICE" })),
            &NetRoute::Direct,
        )
        .await
        .unwrap_err();
    assert_eq!(driver_error(&missing).1, Some(12514), "{missing:?}");
    let no_sid = engine
        .swap_to(
            &FACTORY,
            &config(json!({ "connect_mode": "sid", "database": "NOSUCH" })),
            &NetRoute::Direct,
        )
        .await
        .unwrap_err();
    assert_eq!(driver_error(&no_sid).1, Some(12505), "{no_sid:?}");
    // The CDB by its SID, as SYSTEM (a common user).
    engine
        .swap_to(
            &FACTORY,
            &config(json!({ "connect_mode": "sid", "database": "FREE",
                            "user": "system", "password": "Oracle_test_pw1" })),
            &NetRoute::Direct,
        )
        .await
        .unwrap();
    let container = engine
        .query("SELECT SYS_CONTEXT('USERENV', 'CON_NAME') FROM dual", 1)
        .await
        .unwrap();
    assert_eq!(container.rows_json()[0][0], json!("CDB$ROOT"));
    // Easy Connect typed out.
    engine
        .swap_to(
            &FACTORY,
            &config(json!({ "connect_mode": "descriptor", "connect_string": "127.0.0.1:15210/FREEPDB1" })),
            &NetRoute::Direct,
        )
        .await
        .unwrap();
    assert_eq!(
        engine
            .query("SELECT 3 FROM dual", 1)
            .await
            .unwrap()
            .rows_json()[0][0],
        json!(3)
    );
}

/// A wallet folder for the TCPS tests holding `pem` as its ewallet.pem.
fn wallet(name: &str, pem: &str) -> String {
    let dir = std::env::temp_dir().join(format!("tablepeek-oracle-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let source = format!("{}/../../testdb/x509/{pem}", env!("CARGO_MANIFEST_DIR"));
    let file = dir.join("ewallet.pem");
    std::fs::copy(source, &file).unwrap();
    file.to_string_lossy().into_owned()
}

#[tokio::test]
async fn oracle_tcps_checks_the_server_certificate() {
    let Some((engine, _turn)) = connect(json!({})).await else {
        return;
    };
    // The TCPS listener (127.0.0.1:15211), with the test CA as the wallet.
    let trusted = wallet("ca", "ca.pem");
    engine
        .swap_to(
            &FACTORY,
            &config(json!({ "port": 15211, "tls": true, "wallet_file": trusted })),
            &NetRoute::Direct,
        )
        .await
        .unwrap();
    let protocol = engine
        .query(
            "SELECT SYS_CONTEXT('USERENV', 'NETWORK_PROTOCOL') FROM dual",
            1,
        )
        .await
        .unwrap();
    assert_eq!(protocol.rows_json()[0][0], json!("tcps"));
    // A string naming TCPS goes the same way.
    engine
        .swap_to(
            &FACTORY,
            &config(
                json!({ "connect_mode": "descriptor", "wallet_file": trusted,
                            "connect_string": "tcps://localhost:15211/FREEPDB1" }),
            ),
            &NetRoute::Direct,
        )
        .await
        .unwrap();
    // A wallet without the CA (only another certificate it signed) does
    // not let the server's certificate through.
    let untrusted = wallet("client", "client.pem");
    let refused = engine
        .swap_to(
            &FACTORY,
            &config(json!({ "port": 15211, "tls": true, "wallet_file": untrusted })),
            &NetRoute::Direct,
        )
        .await
        .unwrap_err();
    for file in [trusted, untrusted] {
        let _ = std::fs::remove_dir_all(std::path::Path::new(&file).parent().unwrap());
    }
    assert!(refused.to_string().contains("UnknownIssuer"), "{refused:?}");
}

#[tokio::test]
async fn oracle_tcps_through_a_route_checks_the_server_name() {
    let Some((engine, _turn)) = connect(json!({})).await else {
        return;
    };
    // The TCPS listener reached through a local end (as through a tunnel):
    // the certificate is checked against the descriptor's HOST, not the
    // address dialed. localhost is in it; another name is not, though the
    // address dialed (127.0.0.1) is.
    let trusted = wallet("route", "ca.pem");
    let via = NetRoute::Via {
        host: "127.0.0.1".into(),
        port: 15211,
    };
    let string = |host: &str| {
        config(
            json!({ "connect_mode": "descriptor", "wallet_file": trusted,
                       "connect_string": format!("tcps://{host}:2484/FREEPDB1") }),
        )
    };
    engine
        .swap_to(&FACTORY, &string("localhost"), &via)
        .await
        .unwrap();
    let protocol = engine
        .query(
            "SELECT SYS_CONTEXT('USERENV', 'NETWORK_PROTOCOL') FROM dual",
            1,
        )
        .await
        .unwrap();
    assert_eq!(protocol.rows_json()[0][0], json!("tcps"));
    let refused = engine
        .swap_to(&FACTORY, &string("tablepeek-not-in-cert.test"), &via)
        .await
        .unwrap_err();
    let _ = std::fs::remove_dir_all(std::path::Path::new(&trusted).parent().unwrap());
    assert!(refused.to_string().contains("TLS"), "{refused:?}");
}

/// A stream of `bytes` in 64 KiB pieces, ending with `fail` if given.
fn pieces(bytes: Vec<u8>, fail: Option<EngineError>) -> crate::driver::FileStream {
    let mut items: Vec<Result<Vec<u8>, EngineError>> = bytes
        .chunks(64 << 10)
        .map(|piece| Ok(piece.to_vec()))
        .collect();
    if let Some(err) = fail {
        items.push(Err(err));
    }
    Box::pin(futures_util::stream::iter(items))
}

async fn read_whole(engine: &Engine, cell: &tablepeek_types::CellRef) -> Vec<u8> {
    use futures_util::StreamExt;
    let mut stream = engine.read_cell(cell).await.unwrap();
    let mut out = Vec::new();
    while let Some(piece) = stream.next().await {
        out.extend(piece.unwrap());
    }
    out
}

#[tokio::test]
async fn oracle_reads_and_replaces_binary_cells_of_any_size() {
    let Some((engine, _turn)) = connect(json!({})).await else {
        return;
    };
    let _ = engine
        .query(
            "BEGIN EXECUTE IMMEDIATE 'DROP TABLE tp_cells'; EXCEPTION WHEN OTHERS THEN NULL; END;",
            1,
        )
        .await;
    engine
        .query(
            "CREATE TABLE tp_cells (id NUMBER PRIMARY KEY, b BLOB, r RAW(100))",
            1,
        )
        .await
        .unwrap();
    engine
        .query(
            "INSERT INTO tp_cells VALUES (1, HEXTORAW('0102'), HEXTORAW('AA'))",
            1,
        )
        .await
        .unwrap();
    let cell = |column: &str| tablepeek_types::CellRef {
        table: "TP_CELLS".into(),
        pk: vec![PkValue {
            column: "ID".into(),
            value: json!(1),
        }],
        column: column.into(),
    };
    // 5 MiB, written and read back in pieces.
    let big: Vec<u8> = (0..5 << 20).map(|n: u32| (n % 251) as u8).collect();
    assert_eq!(
        engine
            .write_cell(&cell("B"), pieces(big.clone(), None))
            .await
            .unwrap(),
        1
    );
    assert_eq!(read_whole(&engine, &cell("B")).await, big);
    // The grid shows only its size.
    let shown = engine.query("SELECT b FROM tp_cells", 1).await.unwrap();
    assert_eq!(
        shown.rows_json()[0][0],
        json!(format!("<blob {} bytes>", 5 << 20))
    );
    // An upload that breaks off leaves the old value, in a transaction too.
    let broken = EngineError::BadRequest("끊김".into());
    assert!(engine
        .write_cell(&cell("B"), pieces(vec![9; 3 << 20], Some(broken)))
        .await
        .is_err());
    assert_eq!(read_whole(&engine, &cell("B")).await, big);
    engine.begin_tx().await.unwrap();
    engine
        .write_cell(&cell("B"), pieces(vec![7; 100], None))
        .await
        .unwrap();
    assert_eq!(read_whole(&engine, &cell("B")).await, vec![7; 100]);
    engine.rollback_tx().await.unwrap();
    assert_eq!(read_whole(&engine, &cell("B")).await, big);
    // RAW takes the value whole, up to its size.
    engine
        .write_cell(&cell("R"), pieces(vec![0xAB; 100], None))
        .await
        .unwrap();
    assert_eq!(read_whole(&engine, &cell("R")).await, vec![0xAB; 100]);
    assert!(engine
        .write_cell(&cell("R"), pieces(vec![1; 101], None))
        .await
        .is_err());
    // Not a binary column, and a row that isn't there.
    assert!(engine.read_cell(&cell("ID")).await.is_err());
    let mut gone = cell("B");
    gone.pk[0].value = json!(2);
    assert!(matches!(
        engine.read_cell(&gone).await,
        Err(EngineError::NotFound(_))
    ));
    engine.query("DROP TABLE tp_cells", 1).await.unwrap();
}

#[tokio::test]
async fn oracle_ddl_follows_changes_made_by_other_sessions() {
    let Some((engine, _turn)) = connect(json!({})).await else {
        return;
    };
    let other = Engine::open_demo(1).unwrap();
    other
        .swap_to(&FACTORY, &config(json!({})), &NetRoute::Direct)
        .await
        .unwrap();
    engine
        .query(
            "CREATE OR REPLACE VIEW tp_stamp AS SELECT 1 AS first_version FROM dual",
            1,
        )
        .await
        .unwrap();
    // Older than a second, so the definition is kept.
    tokio::time::sleep(Duration::from_millis(2100)).await;
    let ddl =
        |definition: Option<tablepeek_types::ObjectDefinition>| definition.unwrap().ddl.unwrap();
    let first = ddl(engine.object_definition("view", "TP_STAMP").await.unwrap());
    assert!(first.contains("FIRST_VERSION"), "{first}");
    // Another session replaces it; this one's next look sees the change.
    other
        .query(
            "CREATE OR REPLACE VIEW tp_stamp AS SELECT 2 AS second_version FROM dual",
            1,
        )
        .await
        .unwrap();
    let second = ddl(engine.object_definition("view", "TP_STAMP").await.unwrap());
    assert!(second.contains("SECOND_VERSION"), "{second}");
    engine.query("DROP VIEW tp_stamp", 1).await.unwrap();
}
