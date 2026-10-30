//! Binary cells read and replaced whole on each SQL engine, against the
//! test databases (`TABLEPEEK_TEST_PG`, `_COCKROACH`, `_MYSQL`, `_MSSQL`;
//! SQLite always): a value of several MiB both ways, an upload that breaks
//! off, and the open transaction.

use futures_util::StreamExt;
use serde_json::{json, Map, Value};
use tablepeek_types::{CellRef, PkValue};

use crate::driver::FileStream;
use crate::registry::{self, NetRoute};
use crate::{Engine, EngineError};

/// A stream of `bytes` in 64 KiB pieces, ending with `fail` if given.
fn pieces(bytes: Vec<u8>, fail: Option<EngineError>) -> FileStream {
    let mut items: Vec<Result<Vec<u8>, EngineError>> = bytes
        .chunks(64 << 10)
        .map(|piece| Ok(piece.to_vec()))
        .collect();
    if let Some(err) = fail {
        items.push(Err(err));
    }
    Box::pin(futures_util::stream::iter(items))
}

fn broken() -> Option<EngineError> {
    Some(EngineError::BadRequest("끊김".into()))
}

async fn read_whole(engine: &Engine, cell: &CellRef) -> Vec<u8> {
    let mut stream = engine.read_cell(cell).await.unwrap();
    let mut out = Vec::new();
    while let Some(piece) = stream.next().await {
        out.extend(piece.unwrap());
    }
    out
}

fn cell(table: &str, column: &str, id: i64) -> CellRef {
    CellRef {
        table: table.into(),
        pk: vec![PkValue {
            column: "id".into(),
            value: json!(id),
        }],
        column: column.into(),
    }
}

/// Bytes that aren't one value repeated, so a piece out of place shows.
fn pattern(size: usize) -> Vec<u8> {
    (0..size).map(|n| (n % 251) as u8).collect()
}

async fn connect(engine: &str, config: Value) -> Engine {
    let Value::Object(map): Value = config else {
        unreachable!("settings are an object");
    };
    let map: Map<String, Value> = map;
    let opened = Engine::open_demo(1).unwrap();
    opened
        .swap_to(registry::require(engine).unwrap(), &map, &NetRoute::Direct)
        .await
        .unwrap();
    opened
}

/// What every engine does with the binary column `column` of `table` (row
/// 1, keyed by `id`), its text column `text` beside it.
async fn round_trip(engine: &Engine, table: &str, column: &str, text: &str) {
    let target = cell(table, column, 1);
    // Several MiB, written and read back in pieces.
    let big = pattern(5 << 20);
    assert_eq!(
        engine
            .write_cell(&target, pieces(big.clone(), None))
            .await
            .unwrap(),
        1
    );
    assert_eq!(read_whole(engine, &target).await, big);
    // An upload that breaks off leaves the old value.
    assert!(engine
        .write_cell(&target, pieces(vec![9; 3 << 20], broken()))
        .await
        .is_err());
    assert_eq!(read_whole(engine, &target).await, big);
    // Inside a transaction the change joins it: a broken upload there
    // leaves what the transaction had written, and a rollback undoes it.
    engine.begin_tx().await.unwrap();
    engine
        .write_cell(&target, pieces(vec![7; 100], None))
        .await
        .unwrap();
    assert_eq!(read_whole(engine, &target).await, vec![7; 100]);
    assert!(engine
        .write_cell(&target, pieces(vec![9; 2 << 20], broken()))
        .await
        .is_err());
    assert_eq!(read_whole(engine, &target).await, vec![7; 100]);
    engine.rollback_tx().await.unwrap();
    assert_eq!(read_whole(engine, &target).await, big);
    engine.begin_tx().await.unwrap();
    engine
        .write_cell(&target, pieces(vec![5; 10], None))
        .await
        .unwrap();
    engine.commit_tx().await.unwrap();
    assert_eq!(read_whole(engine, &target).await, vec![5; 10]);
    // An empty upload empties the cell.
    engine
        .write_cell(&target, pieces(Vec::new(), None))
        .await
        .unwrap();
    assert_eq!(read_whole(engine, &target).await, Vec::<u8>::new());
    // Not a binary column, and a row that isn't there.
    assert!(engine.read_cell(&cell(table, text, 1)).await.is_err());
    assert!(engine
        .write_cell(&cell(table, text, 1), pieces(vec![1], None))
        .await
        .is_err());
    assert!(matches!(
        engine.read_cell(&cell(table, column, 2)).await,
        Err(EngineError::NotFound(_))
    ));
    assert!(matches!(
        engine
            .write_cell(&cell(table, column, 2), pieces(vec![1], None))
            .await,
        Err(EngineError::NotFound(_))
    ));
}

fn scratch(name: &str) -> String {
    format!("tp_cells_{name}_{}", std::process::id())
}

#[tokio::test]
async fn postgres_binary_cells_go_whole_both_ways() {
    if std::env::var("TABLEPEEK_TEST_PG").is_err() {
        return;
    }
    let engine = connect(
        "postgres",
        json!({
            "host": "127.0.0.1", "port": 5433, "user": "tablepeek",
            "password": "tablepeek_test_pw", "database": "tablepeek_test", "ssl_mode": "disable",
        }),
    )
    .await;
    let table = scratch("pg");
    engine
        .execute(
            &format!("CREATE TABLE {table} (id INT PRIMARY KEY, b BYTEA, t TEXT)"),
            1,
        )
        .await
        .unwrap();
    engine
        .execute(
            &format!("INSERT INTO {table} VALUES (1, '\\x0102', 'x')"),
            1,
        )
        .await
        .unwrap();
    round_trip(&engine, &table, "b", "t").await;
    // A NULL has no value to read.
    engine
        .execute(&format!("UPDATE {table} SET b = NULL"), 1)
        .await
        .unwrap();
    assert!(engine.read_cell(&cell(&table, "b", 1)).await.is_err());
    engine
        .execute(&format!("DROP TABLE {table}"), 1)
        .await
        .unwrap();
}

#[tokio::test]
async fn cockroach_binary_cells_go_whole_both_ways() {
    if std::env::var("TABLEPEEK_TEST_COCKROACH").is_err() {
        return;
    }
    let engine = connect(
        "cockroach",
        json!({
            "host": "127.0.0.1", "port": 26258, "user": "root",
            "database": "defaultdb", "ssl_mode": "disable",
        }),
    )
    .await;
    let table = scratch("crdb");
    engine
        .execute(
            &format!("CREATE TABLE {table} (id INT8 PRIMARY KEY, b BYTES, t STRING)"),
            1,
        )
        .await
        .unwrap();
    engine
        .execute(&format!("INSERT INTO {table} VALUES (1, b'\\x01', 'x')"), 1)
        .await
        .unwrap();
    round_trip(&engine, &table, "b", "t").await;
    // Past what one statement can carry, the upload stops with the setting
    // that limits it before anything is sent, and the old value stays.
    let err = engine
        .write_cell(&cell(&table, "b", 1), pieces(vec![1; 20 << 20], None))
        .await
        .unwrap_err();
    assert!(
        err.to_string()
            .contains("sql.conn.max_read_buffer_message_size"),
        "{err}"
    );
    assert_eq!(
        read_whole(&engine, &cell(&table, "b", 1)).await,
        Vec::<u8>::new()
    );
    engine
        .execute(&format!("DROP TABLE {table}"), 1)
        .await
        .unwrap();
}

#[tokio::test]
async fn mysql_binary_cells_go_whole_both_ways() {
    if std::env::var("TABLEPEEK_TEST_MYSQL").is_err() {
        return;
    }
    let port: u16 = std::env::var("TABLEPEEK_TEST_MYSQL_PORT")
        .ok()
        .and_then(|port| port.parse().ok())
        .unwrap_or(3307);
    let engine = connect(
        "mysql",
        json!({
            "host": "127.0.0.1", "port": port, "user": "root",
            "password": "root_pw", "database": "tablepeek_test", "ssl_mode": "disable",
        }),
    )
    .await;
    let table = scratch("my");
    engine
        .execute(
            &format!(
                "CREATE TABLE {table} (id INT PRIMARY KEY, b LONGBLOB, small VARBINARY(10), t TEXT) ENGINE=InnoDB"
            ),
            1,
        )
        .await
        .unwrap();
    engine
        .execute(
            &format!("INSERT INTO {table} VALUES (1, X'0102', X'01', 'x')"),
            1,
        )
        .await
        .unwrap();
    round_trip(&engine, &table, "b", "t").await;
    // A column takes what it was declared to.
    let small = cell(&table, "small", 1);
    engine
        .write_cell(&small, pieces(vec![3; 10], None))
        .await
        .unwrap();
    assert_eq!(read_whole(&engine, &small).await, vec![3; 10]);
    let err = engine
        .write_cell(&small, pieces(vec![3; 11], None))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("10바이트"), "{err}");
    engine
        .execute(&format!("DROP TABLE {table}"), 1)
        .await
        .unwrap();
}

#[tokio::test]
async fn mssql_binary_cells_go_whole_both_ways() {
    if std::env::var("TABLEPEEK_TEST_MSSQL").is_err() {
        return;
    }
    // Its key checks read the catalog under READ COMMITTED, which another
    // test's DDL can deadlock or stall: the server's tests take turns.
    let _turn = crate::tests::MSSQL_TURN.lock().await;
    let engine = connect(
        "mssql",
        json!({
            "host": "127.0.0.1", "port": 14330, "user": "sa",
            "password": "MsSql_test_pw1", "database": "tablepeek_test", "encrypt": false,
        }),
    )
    .await;
    let table = scratch("ms");
    engine
        .execute(
            &format!(
                "CREATE TABLE {table} (id INT PRIMARY KEY, b VARBINARY(MAX), img IMAGE, \
                 small VARBINARY(10), t NVARCHAR(10))"
            ),
            1,
        )
        .await
        .unwrap();
    engine
        .execute(
            &format!("INSERT INTO {table} VALUES (1, 0x0102, 0x0304, 0x05, N'x')"),
            1,
        )
        .await
        .unwrap();
    round_trip(&engine, &table, "b", "t").await;
    round_trip(&engine, &table, "img", "t").await;
    let small = cell(&table, "small", 1);
    engine
        .write_cell(&small, pieces(vec![3; 10], None))
        .await
        .unwrap();
    assert_eq!(read_whole(&engine, &small).await, vec![3; 10]);
    let err = engine
        .write_cell(&small, pieces(vec![3; 11], None))
        .await
        .unwrap_err();
    assert!(err.to_string().contains("10바이트"), "{err}");
    engine
        .execute(&format!("DROP TABLE {table}"), 1)
        .await
        .unwrap();
}

#[tokio::test]
async fn sqlite_binary_cells_go_whole_both_ways() {
    let path = std::env::temp_dir().join(format!(
        "tablepeek-cells-{}-{}.db",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    {
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE files (id INTEGER PRIMARY KEY, b BLOB, t TEXT);
             INSERT INTO files VALUES (1, X'0102', 'x');
             CREATE TABLE keyed (id TEXT PRIMARY KEY, b BLOB, t TEXT) WITHOUT ROWID;
             INSERT INTO keyed VALUES ('1', X'0102', 'x');",
        )
        .unwrap();
    }
    let engine = Engine::open_file(&path).unwrap();
    round_trip(&engine, "files", "b", "t").await;
    // A table without rowids goes through its key instead.
    round_trip(&engine, "keyed", "b", "t").await;
    drop(engine);
    let _ = std::fs::remove_file(&path);
}
