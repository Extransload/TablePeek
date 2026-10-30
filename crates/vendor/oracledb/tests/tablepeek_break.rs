//! TablePeek: the out-of-band break (`Connection::break_handle`) against the
//! Oracle test server on its own network, where TCP urgent data arrives
//! (Docker Desktop's port forwarding drops it): `make test-oracle-oob` runs
//! this in a container beside the server, with the server's DISABLE_OOB
//! turned off for the while. Skipped unless TABLEPEEK_ORACLE_OOB names the
//! server's host (on that network: oracle).

use std::thread;
use std::time::{Duration, Instant};

use oracledb::{Config, Connection};

fn connect(host: &str, tls: bool) -> Connection {
    let mut config = Config::default().set_credentials("tablepeek", "tablepeek_test_pw");
    let connect_string = if tls {
        let wallet = std::env::temp_dir().join("tablepeek-oob-wallet");
        std::fs::create_dir_all(&wallet).unwrap();
        std::fs::copy(
            concat!(env!("CARGO_MANIFEST_DIR"), "/../../../testdb/x509/ca.pem"),
            wallet.join("ewallet.pem"),
        )
        .unwrap();
        config = config.set_wallet_location(wallet.to_string_lossy().into_owned());
        format!("tcps://{host}:2484/FREEPDB1")
    } else {
        format!("{host}:1521/FREEPDB1")
    };
    oracledb::connect(config.set_connect_string(&connect_string).unwrap()).unwrap()
}

/// The session's id as the server tells it.
fn sid(conn: &Connection) -> String {
    conn.query_row("SELECT SYS_CONTEXT('USERENV', 'SID') FROM dual", &[])
        .unwrap()
        .get::<String>(0)
        .unwrap()
}

fn count(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM tp_oob", &[])
        .unwrap()
        .get::<i64>(0)
        .unwrap()
}

#[test]
fn a_break_stops_the_call_and_keeps_the_session() {
    let Ok(host) = std::env::var("TABLEPEEK_ORACLE_OOB") else {
        return;
    };
    for tls in [false, true] {
        let conn = connect(&host, tls);
        let breaker = conn
            .break_handle()
            .unwrap()
            .expect("the server took out-of-band breaks");
        let session = sid(&conn);
        let _ = conn.execute("DROP TABLE tp_oob", &[]);
        conn.execute("CREATE TABLE tp_oob (n NUMBER)", &[]).unwrap();
        conn.execute("INSERT INTO tp_oob VALUES (1)", &[]).unwrap();
        // Between calls nothing is sent.
        assert!(!breaker.break_call().unwrap());
        for sql in [
            "BEGIN DBMS_SESSION.SLEEP(20); END;",
            "SELECT COUNT(*) FROM all_objects a, all_objects b, all_objects c",
        ] {
            let late = breaker.clone();
            let breaking = thread::spawn(move || {
                thread::sleep(Duration::from_millis(1000));
                late.break_call().unwrap()
            });
            let started = Instant::now();
            let failed = conn.query(sql, &[]).and_then(|rows| rows.collect::<Result<Vec<_>, _>>());
            assert!(breaking.join().unwrap());
            let err = failed.err().expect("the call was broken").to_string();
            assert!(err.contains("ORA-01013"), "tls={tls}: {err}");
            assert!(started.elapsed() < Duration::from_secs(5), "tls={tls}: {:?}", started.elapsed());
            // Same session, transaction still open.
            assert_eq!(sid(&conn), session);
            assert_eq!(count(&conn), 1, "tls={tls}");
        }
        // Breaks landing as calls end never reach the next call.
        for step in 0..40u64 {
            let late = breaker.clone();
            let breaking = thread::spawn(move || {
                thread::sleep(Duration::from_micros(199_000 + step * 50));
                late.break_call().unwrap()
            });
            let _ = conn.execute("BEGIN DBMS_SESSION.SLEEP(0.2); END;", &[]);
            breaking.join().unwrap();
            let answer = conn
                .query_row("SELECT 40 + :1 FROM dual", &[&(step as i64)])
                .unwrap()
                .get::<i64>(0)
                .unwrap();
            assert_eq!(answer, 40 + step as i64);
        }
        conn.rollback().unwrap();
        assert_eq!(count(&conn), 0);
        conn.execute("DROP TABLE tp_oob", &[]).unwrap();
    }
}
