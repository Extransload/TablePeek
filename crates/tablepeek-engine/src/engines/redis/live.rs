//! Against the test servers of `make test-db ENGINE=…`: Redis 8 (`redis`,
//! 16379, on with TABLEPEEK_TEST_REDIS=1), Redis over TLS with client
//! certificates (`redis-tls`, 16380, TABLEPEEK_TEST_REDIS_TLS=1), Valkey 8
//! (`valkey`, 16381, TABLEPEEK_TEST_VALKEY=1) and Redis 6.2 (`redis-6`,
//! 16382, TABLEPEEK_TEST_REDIS_6=1), all seeded by testdb/redis-seed.sh.
//! Ports can be moved with TABLEPEEK_TEST_REDIS_PORT and the like. Writes
//! go to keys under `tp:test:` of their own, removed at the end.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{json, Value};
use tablepeek_types::ConnConfig;

use crate::driver::Driver;
use crate::keyvalue::*;
use crate::registry::{self, NetRoute};
use crate::sql_log::SqlLog;
use crate::EngineError;

const PASSWORD: &str = "tablepeek_test_pw";

fn port(var: &str, default: u16) -> u16 {
    std::env::var(var)
        .ok()
        .and_then(|port| port.parse().ok())
        .unwrap_or(default)
}

fn config(value: Value) -> ConnConfig {
    value.as_object().unwrap().clone()
}

fn plain(port: u16) -> ConnConfig {
    config(json!({ "host": "127.0.0.1", "port": port, "auth": "password", "password": PASSWORD }))
}

/// testdb/x509, from this crate's folder.
fn cert(name: &str) -> String {
    format!("{}/../../testdb/x509/{name}", env!("CARGO_MANIFEST_DIR"))
}

async fn open(config: &ConnConfig) -> Result<Arc<dyn Driver>, EngineError> {
    registry::require("redis")?
        .connect(config, &NetRoute::Direct, SqlLog::new())
        .await
}

fn bin(text: &str) -> Bin {
    Bin::from(text)
}

async fn read(
    kv: &dyn KeyValueDriver,
    key: &str,
    change: impl FnOnce(&mut ReadRequest),
) -> KeyPage {
    let mut req = ReadRequest {
        db: 0,
        key: bin(key),
        cursor: None,
        offset: 0,
        count: 200,
        pattern: None,
        rev: false,
        from: None,
        max_bytes: None,
    };
    change(&mut req);
    kv.read(&req)
        .await
        .unwrap_or_else(|err| panic!("read {key}: {err}"))
}

async fn edit(kv: &dyn KeyValueDriver, key: &str, op: EditOp) -> Result<EditOutcome, EngineError> {
    kv.edit(&EditRequest {
        db: 0,
        key: bin(key),
        op,
    })
    .await
}

async fn console(kv: &dyn KeyValueDriver, db: u32, line: &str) -> ConsoleReply {
    kv.console(&ConsoleRequest {
        db,
        line: line.into(),
        confirmed: true,
    })
    .await
    .unwrap_or_else(|err| panic!("{line}: {err}"))
}

/// Everything the page does, on one seeded server.
async fn exercise(config: ConnConfig, json_module: bool) {
    let driver = open(&config).await.expect("connect");
    assert_eq!(driver.id(), "redis");
    let kv = driver.keyvalue().expect("keyvalue facet");
    let meta = driver.meta(false).await.unwrap();
    assert!(meta.tables.is_empty());
    assert!(meta.path.unwrap().ends_with("/0"));

    // Databases, with the seed's counts.
    let dbs = kv.databases().await.unwrap();
    assert_eq!(dbs.current, 0);
    assert!(dbs.databases.len() >= 16);
    assert_eq!(dbs.databases[1].keys, 3);
    assert!(dbs.size >= 430, "{}", dbs.size);
    assert_eq!(dbs.databases[0].keys, dbs.size);

    // The header's overview, from one INFO.
    let overview = kv.overview().await.unwrap();
    assert!(matches!(overview.flavor.as_str(), "redis" | "valkey"));
    assert!(overview.version.contains('.'));
    assert!(overview.used_memory > 0);
    assert!(overview.connected_clients >= 1);
    assert_eq!(overview.current, 0);
    assert_eq!(overview.databases.len(), dbs.databases.len());
    assert_eq!(overview.databases[1].keys, 3);
    assert_eq!(overview.keys_total, dbs.size + 3);

    // TTL and size of a page of keys, in the order asked.
    let meta = kv
        .keys_meta(&KeysMetaRequest {
            db: 0,
            keys: vec![bin("app:session:1"), bin("no:such:key"), bin("big:hash")],
        })
        .await
        .unwrap();
    assert_eq!(meta.len(), 3);
    assert_eq!(meta[0].key, bin("app:session:1"));
    assert!(meta[0].ttl_ms > 0);
    assert_eq!((meta[1].ttl_ms, meta[1].memory), (-2, None));
    assert_eq!(meta[2].ttl_ms, -1);
    assert!(meta[2].memory.unwrap() > 10_000);
    assert!(matches!(
        kv.keys_meta(&KeysMetaRequest {
            db: 0,
            keys: vec![bin("k"); KEYS_META_LIMIT + 1],
        })
        .await,
        Err(EngineError::BadRequest(_))
    ));

    // The whole keyspace by SCAN, in steps.
    let mut cursor = "0".to_string();
    let mut seen = HashSet::new();
    loop {
        let page = kv
            .scan(&ScanRequest {
                db: 0,
                cursor: cursor.clone(),
                pattern: None,
                kind: None,
                count: 100,
            })
            .await
            .unwrap();
        for key in page.keys {
            assert_ne!(key.kind, "none");
            seen.insert(key.key);
        }
        cursor = page.cursor;
        if cursor == "0" {
            break;
        }
    }
    assert_eq!(seen.len() as u64, dbs.size);
    assert!(seen.contains(&Bin(b"bin:blob".to_vec())));
    // A pattern and a type.
    let mut users = 0;
    let mut cursor = "0".to_string();
    loop {
        let page = kv
            .scan(&ScanRequest {
                db: 0,
                cursor,
                pattern: Some(bin("app:users:*")),
                kind: Some("hash".into()),
                count: 50,
            })
            .await
            .unwrap();
        assert!(page.keys.iter().all(|key| key.kind == "hash"));
        users += page.keys.len();
        cursor = page.cursor;
        if cursor == "0" {
            break;
        }
    }
    assert_eq!(users, 120);

    // Key facts.
    let info = kv
        .key_info(&KeyRef {
            db: 0,
            key: bin("big:hash"),
        })
        .await
        .unwrap();
    assert!(info.exists);
    assert_eq!(info.kind, "hash");
    assert_eq!(info.length, Some(5000));
    assert_eq!(info.ttl_ms, -1);
    assert!(info.memory.unwrap() > 10_000);
    let session = kv
        .key_info(&KeyRef {
            db: 0,
            key: bin("app:session:1"),
        })
        .await
        .unwrap();
    assert!(session.ttl_ms > 0);
    let gone = kv
        .key_info(&KeyRef {
            db: 0,
            key: bin("no:such:key"),
        })
        .await
        .unwrap();
    assert!(!gone.exists);

    // Each type's view.
    match read(kv, "bin:blob", |_| {}).await {
        KeyPage::String {
            value,
            total,
            truncated,
        } => {
            assert_eq!(value.0, b"\x00\x01\xff\xfeTablePeek\x80\n");
            assert_eq!(total, 15);
            assert!(!truncated);
        }
        other => panic!("{other:?}"),
    }
    match read(kv, "greeting", |req| req.max_bytes = Some(5)).await {
        KeyPage::String {
            value, truncated, ..
        } => {
            assert_eq!(value, bin("hello"));
            assert!(truncated);
        }
        other => panic!("{other:?}"),
    }
    let mut fields = HashSet::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = read(kv, "big:hash", |req| {
            req.cursor = cursor.clone();
            req.count = 700;
        })
        .await;
        let KeyPage::Hash {
            entries,
            cursor: next,
            total,
        } = page
        else {
            panic!("not a hash");
        };
        assert_eq!(total, 5000);
        for entry in entries {
            fields.insert(entry.field);
        }
        if next == "0" {
            break;
        }
        cursor = Some(next);
    }
    assert_eq!(fields.len(), 5000);
    match read(kv, "big:hash", |req| req.pattern = Some(bin("field:4999"))).await {
        KeyPage::Hash { entries, .. } => {
            // A sparse pattern may need more steps; the first may be empty.
            assert!(entries.len() <= 1);
        }
        other => panic!("{other:?}"),
    }
    match read(kv, "queue:jobs", |req| {
        req.offset = 100;
        req.count = 50;
    })
    .await
    {
        KeyPage::List {
            items,
            offset,
            total,
        } => {
            assert_eq!((offset, total, items.len()), (100, 300, 50));
            assert_eq!(items[0].index, 100);
            assert_eq!(items[0].value, bin("job 101"));
        }
        other => panic!("{other:?}"),
    }
    match read(kv, "tags", |_| {}).await {
        KeyPage::Set { members, total, .. } => {
            assert_eq!(total, 5);
            assert!(members.contains(&bin("with space")));
        }
        other => panic!("{other:?}"),
    }
    match read(kv, "leaderboard", |req| req.rev = true).await {
        KeyPage::Zset {
            entries,
            total,
            cursor,
            ..
        } => {
            assert_eq!(total, 5);
            assert!(cursor.is_none());
            assert_eq!(entries[0].member, bin("top"));
            assert_eq!(entries[0].score, "inf");
            assert_eq!(entries[1].score, "250.5");
        }
        other => panic!("{other:?}"),
    }
    // A stream, forward then back, a page at a time.
    for rev in [false, true] {
        let mut ids = Vec::new();
        let mut from: Option<String> = None;
        loop {
            let page = read(kv, "events:stream", |req| {
                req.count = 100;
                req.rev = rev;
                req.from = from.clone();
            })
            .await;
            let KeyPage::Stream {
                entries,
                next,
                total,
            } = page
            else {
                panic!("not a stream");
            };
            assert_eq!(total, 250);
            ids.extend(entries.iter().map(|entry| entry.id.clone()));
            if let Some(entry) = entries.first() {
                assert_eq!(entry.fields[0].0, bin("kind"));
            }
            match next {
                Some(next) => from = Some(next),
                None => break,
            }
        }
        assert_eq!(ids.len(), 250);
        assert_eq!(ids.iter().collect::<HashSet<_>>().len(), 250);
    }
    if json_module {
        match read(kv, "doc:product", |_| {}).await {
            KeyPage::Json { text } => {
                let doc: Value = serde_json::from_str(&text).unwrap();
                assert_eq!(doc["name"], json!("Lamp"));
            }
            other => panic!("{other:?}"),
        }
        match read(kv, "metrics:temp", |_| {}).await {
            KeyPage::Other { kind } => assert_eq!(kind, "TSDB-TYPE"),
            other => panic!("{other:?}"),
        }
    }
    assert!(matches!(
        kv.read(&ReadRequest {
            db: 0,
            key: bin("no:such:key"),
            cursor: None,
            offset: 0,
            count: 10,
            pattern: None,
            rev: false,
            from: None,
            max_bytes: None,
        })
        .await,
        Err(EngineError::NotFound(_))
    ));

    // Writes, on keys of the test's own.
    for key in [
        "tp:test:s",
        "tp:test:h",
        "tp:test:l",
        "tp:test:set",
        "tp:test:z",
        "tp:test:x",
        "tp:test:j",
        "tp:test:renamed",
    ] {
        let _ = edit(kv, key, EditOp::Delete).await;
    }
    let create = |kind: &str| EditOp::Create {
        kind: kind.into(),
        value: Some(bin("v1")),
        field: Some(bin("f1")),
        score: Some("1".into()),
        fields: vec![(bin("a"), bin("1"))],
        text: Some("{\"a\":1}".into()),
        ttl_secs: None,
    };
    edit(kv, "tp:test:s", create("string")).await.unwrap();
    assert!(edit(kv, "tp:test:s", create("string")).await.is_err());
    edit(kv, "tp:test:s", EditOp::Expire { ttl_ms: 60_000 })
        .await
        .unwrap();
    edit(
        kv,
        "tp:test:s",
        EditOp::SetString {
            value: Bin(vec![0, 1, 2]),
        },
    )
    .await
    .unwrap();
    let kept = kv
        .key_info(&KeyRef {
            db: 0,
            key: bin("tp:test:s"),
        })
        .await
        .unwrap();
    assert!(kept.ttl_ms > 0, "SET keeps the expiry");
    edit(kv, "tp:test:s", EditOp::Persist).await.unwrap();
    assert!(matches!(
        edit(
            kv,
            "tp:test:s",
            EditOp::HashSet {
                field: bin("f"),
                value: bin("v"),
                only_new: false
            }
        )
        .await,
        Err(EngineError::BadRequest(_))
    ));

    edit(kv, "tp:test:h", create("hash")).await.unwrap();
    edit(
        kv,
        "tp:test:h",
        EditOp::HashSet {
            field: bin("f2"),
            value: bin("v2"),
            only_new: true,
        },
    )
    .await
    .unwrap();
    assert!(edit(
        kv,
        "tp:test:h",
        EditOp::HashSet {
            field: bin("f2"),
            value: bin("x"),
            only_new: true
        }
    )
    .await
    .is_err());
    edit(
        kv,
        "tp:test:h",
        EditOp::HashRename {
            field: bin("f2"),
            to: bin("f3"),
        },
    )
    .await
    .unwrap();
    edit(
        kv,
        "tp:test:h",
        EditOp::HashDelete {
            fields: vec![bin("f1")],
        },
    )
    .await
    .unwrap();
    match read(kv, "tp:test:h", |_| {}).await {
        KeyPage::Hash { entries, .. } => {
            assert_eq!(entries.len(), 1);
            assert_eq!(
                (entries[0].field.clone(), entries[0].value.clone()),
                (bin("f3"), bin("v2"))
            );
        }
        other => panic!("{other:?}"),
    }

    edit(kv, "tp:test:l", create("list")).await.unwrap();
    edit(
        kv,
        "tp:test:l",
        EditOp::ListPush {
            values: vec![bin("v0")],
            head: true,
        },
    )
    .await
    .unwrap();
    edit(
        kv,
        "tp:test:l",
        EditOp::ListPush {
            values: vec![bin("v2"), bin("v3")],
            head: false,
        },
    )
    .await
    .unwrap();
    edit(
        kv,
        "tp:test:l",
        EditOp::ListSet {
            index: 1,
            value: bin("one"),
            expect: Some(bin("v1")),
        },
    )
    .await
    .unwrap();
    assert!(edit(
        kv,
        "tp:test:l",
        EditOp::ListSet {
            index: 1,
            value: bin("x"),
            expect: Some(bin("v1"))
        }
    )
    .await
    .is_err());
    edit(
        kv,
        "tp:test:l",
        EditOp::ListRemove {
            index: 2,
            expect: Some(bin("v2")),
        },
    )
    .await
    .unwrap();
    match read(kv, "tp:test:l", |_| {}).await {
        KeyPage::List { items, .. } => assert_eq!(
            items.into_iter().map(|item| item.value).collect::<Vec<_>>(),
            vec![bin("v0"), bin("one"), bin("v3")]
        ),
        other => panic!("{other:?}"),
    }

    edit(kv, "tp:test:set", create("set")).await.unwrap();
    edit(
        kv,
        "tp:test:set",
        EditOp::SetAdd {
            members: vec![bin("m2"), bin("m3")],
        },
    )
    .await
    .unwrap();
    edit(
        kv,
        "tp:test:set",
        EditOp::SetReplace {
            member: bin("m2"),
            to: bin("m4"),
        },
    )
    .await
    .unwrap();
    edit(
        kv,
        "tp:test:set",
        EditOp::SetRemove {
            members: vec![bin("v1")],
        },
    )
    .await
    .unwrap();
    match read(kv, "tp:test:set", |_| {}).await {
        KeyPage::Set { members, .. } => {
            let members: HashSet<_> = members.into_iter().collect();
            assert_eq!(members, [bin("m3"), bin("m4")].into_iter().collect());
        }
        other => panic!("{other:?}"),
    }

    edit(kv, "tp:test:z", create("zset")).await.unwrap();
    edit(
        kv,
        "tp:test:z",
        EditOp::ZsetAdd {
            member: bin("b"),
            score: "-inf".into(),
            only_new: true,
        },
    )
    .await
    .unwrap();
    edit(
        kv,
        "tp:test:z",
        EditOp::ZsetAdd {
            member: bin("v1"),
            score: "5.25".into(),
            only_new: false,
        },
    )
    .await
    .unwrap();
    assert!(edit(
        kv,
        "tp:test:z",
        EditOp::ZsetAdd {
            member: bin("b"),
            score: "x".into(),
            only_new: false
        }
    )
    .await
    .is_err());
    edit(
        kv,
        "tp:test:z",
        EditOp::ZsetRename {
            member: bin("v1"),
            to: bin("c"),
            score: "5.25".into(),
        },
    )
    .await
    .unwrap();
    edit(
        kv,
        "tp:test:z",
        EditOp::ZsetRemove {
            members: vec![bin("b")],
        },
    )
    .await
    .unwrap();
    match read(kv, "tp:test:z", |_| {}).await {
        KeyPage::Zset { entries, .. } => {
            assert_eq!(entries.len(), 1);
            assert_eq!(
                (entries[0].member.clone(), entries[0].score.as_str()),
                (bin("c"), "5.25")
            );
        }
        other => panic!("{other:?}"),
    }

    edit(kv, "tp:test:x", create("stream")).await.unwrap();
    let added = edit(
        kv,
        "tp:test:x",
        EditOp::StreamAdd {
            id: None,
            fields: vec![(bin("k"), Bin(vec![0xff]))],
        },
    )
    .await
    .unwrap();
    let id = added.id.unwrap();
    edit(kv, "tp:test:x", EditOp::StreamDelete { ids: vec![id] })
        .await
        .unwrap();
    match read(kv, "tp:test:x", |_| {}).await {
        KeyPage::Stream { entries, total, .. } => assert_eq!((entries.len(), total), (1, 1)),
        other => panic!("{other:?}"),
    }

    if json_module {
        edit(kv, "tp:test:j", create("json")).await.unwrap();
        edit(
            kv,
            "tp:test:j",
            EditOp::JsonSet {
                path: None,
                value: "{\"b\":[1,2]}".into(),
            },
        )
        .await
        .unwrap();
        assert!(edit(
            kv,
            "tp:test:j",
            EditOp::JsonSet {
                path: None,
                value: "{nope".into()
            }
        )
        .await
        .is_err());
        match read(kv, "tp:test:j", |_| {}).await {
            KeyPage::Json { text } => {
                assert_eq!(
                    serde_json::from_str::<Value>(&text).unwrap(),
                    json!({ "b": [1, 2] })
                )
            }
            other => panic!("{other:?}"),
        }
    }

    edit(
        kv,
        "tp:test:s",
        EditOp::Rename {
            to: bin("tp:test:renamed"),
            overwrite: false,
        },
    )
    .await
    .unwrap();
    edit(
        kv,
        "tp:test:h",
        EditOp::Create {
            kind: "string".into(),
            value: None,
            field: None,
            score: None,
            fields: Vec::new(),
            text: None,
            ttl_secs: None,
        },
    )
    .await
    .unwrap_err();
    assert!(edit(
        kv,
        "tp:test:h",
        EditOp::Rename {
            to: bin("tp:test:renamed"),
            overwrite: false
        }
    )
    .await
    .is_err());

    // Export: the big hash as JSON, the list as text.
    let mut file = Vec::new();
    let mut stream = kv
        .export(&ExportRequest {
            db: 0,
            key: bin("big:hash"),
            format: "json".into(),
        })
        .await
        .unwrap();
    while let Some(chunk) = stream.next().await {
        file.extend(chunk.unwrap());
    }
    let exported: Value = serde_json::from_slice(&file).unwrap();
    assert_eq!(exported["type"], json!("hash"));
    assert_eq!(exported["value"].as_object().unwrap().len(), 5000);
    assert_eq!(exported["value"]["field:7"], json!("value 7"));
    let mut text = Vec::new();
    let mut stream = kv
        .export(&ExportRequest {
            db: 0,
            key: bin("queue:jobs"),
            format: "text".into(),
        })
        .await
        .unwrap();
    while let Some(chunk) = stream.next().await {
        text.extend(chunk.unwrap());
    }
    assert_eq!(String::from_utf8(text).unwrap().lines().count(), 300);
    let mut zset = Vec::new();
    let mut stream = kv
        .export(&ExportRequest {
            db: 0,
            key: bin("leaderboard"),
            format: "json".into(),
        })
        .await
        .unwrap();
    while let Some(chunk) = stream.next().await {
        zset.extend(chunk.unwrap());
    }
    let zset: Value = serde_json::from_slice(&zset).unwrap();
    assert_eq!(zset["value"][0], json!({ "member": "dee", "score": -10.0 }));

    // The console: typed replies, errors as replies, SELECT, safe mode.
    let reply = console(kv, 0, "GET counter").await;
    assert_eq!(reply.reply, Reply::Bulk(bin("42")));
    assert_eq!(reply.class, CommandClass::Read);
    let reply = console(kv, 0, "HGETALL user:1").await;
    assert!(matches!(reply.reply, Reply::Map(_) | Reply::Array(_)));
    let reply = console(kv, 0, "HSET greeting a b").await;
    assert!(matches!(&reply.reply, Reply::Error(text) if text.starts_with("WRONGTYPE")));
    let reply = console(kv, 0, "SELECT 1").await;
    assert_eq!(reply.db, 1);
    assert_eq!(
        console(kv, 1, "GET db1:hello").await.reply,
        Reply::Bulk(bin("from database 1"))
    );
    assert_eq!(
        console(kv, 0, "EXISTS db1:hello").await.reply,
        Reply::Int(0)
    );
    assert_eq!(
        kv.classify("FLUSHALL", 0).await.unwrap().class,
        CommandClass::Danger
    );
    assert_eq!(
        kv.classify("KEYS *", 1).await.unwrap().class,
        CommandClass::Read
    );
    assert_eq!(
        kv.classify("SET a b", 0).await.unwrap().class,
        CommandClass::Write
    );
    assert!(kv.classify("SUBSCRIBE news", 0).await.is_err());
    assert!(kv.classify("GET \"open", 0).await.is_err());
    if json_module {
        assert_eq!(
            kv.classify("JSON.SET a $ 1", 0).await.unwrap().class,
            CommandClass::Write
        );
        assert_eq!(
            kv.classify("TS.ADD a * 1", 0).await.unwrap().class,
            CommandClass::Write
        );
    }

    // A blocking command stops when asked to.
    let blpop = ConsoleRequest {
        db: 0,
        line: "BLPOP tp:test:never 0".into(),
        confirmed: true,
    };
    let blocked = kv.console(&blpop);
    let stopper = async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        kv.stop_console();
    };
    let (outcome, ()) = tokio::join!(blocked, stopper);
    assert!(outcome.unwrap_err().is_interrupted());
    assert_eq!(
        console(kv, 0, "PING").await.reply,
        Reply::Status("PONG".into())
    );

    // INFO, SLOWLOG, the sessions and CLIENT KILL.
    let sections = kv.info(None).await.unwrap();
    assert!(sections.iter().any(|section| section.name == "Keyspace"));
    assert!(kv.info(Some("memory")).await.unwrap()[0]
        .entries
        .iter()
        .any(|(key, _)| key == "used_memory"));
    kv.slowlog(10).await.unwrap();
    let server = driver.server_info().await.unwrap();
    assert!(server.version.unwrap().contains('.'));
    // The page's own connections are current (not killable from the
    // page); the CLI's is named apart and may be killed, which only
    // resets the CLI.
    let console_id = match console(kv, 0, "CLIENT ID").await.reply {
        Reply::Int(id) => id,
        other => panic!("{other:?}"),
    };
    let sessions = driver.server_info().await.unwrap().sessions.unwrap();
    let cli = sessions
        .iter()
        .find(|session| session.id == console_id.to_string())
        .expect("the CLI's connection is listed");
    assert!(!cli.is_current);
    assert!(
        cli.state.as_deref().unwrap().contains("tablepeek-cli"),
        "{cli:?}"
    );
    let current: Vec<_> = sessions
        .iter()
        .filter(|session| session.is_current)
        .collect();
    assert!(!current.is_empty());
    for session in &current {
        let state = session.state.as_deref().unwrap();
        assert!(
            state.contains("tablepeek") && !state.contains("tablepeek-cli"),
            "{state}"
        );
    }
    kv.kill_client(&console_id.to_string()).await.unwrap();
    assert!(matches!(
        kv.kill_client("999999999").await,
        Err(EngineError::SessionNotFound)
    ));
    // The next CLI command opens a new connection and runs.
    assert_eq!(
        console(kv, 0, "PING").await.reply,
        Reply::Status("PONG".into())
    );
    let new_id = match console(kv, 0, "CLIENT ID").await.reply {
        Reply::Int(id) => id,
        other => panic!("{other:?}"),
    };
    assert_ne!(new_id, console_id);
    // A CLI in another database keeps it after being killed.
    console(kv, 1, "PING").await;
    kv.kill_client(&new_id.to_string()).await.unwrap();
    assert_eq!(
        console(kv, 1, "GET db1:hello").await.reply,
        Reply::Bulk(bin("from database 1"))
    );

    for key in [
        "tp:test:h",
        "tp:test:l",
        "tp:test:set",
        "tp:test:z",
        "tp:test:x",
        "tp:test:j",
        "tp:test:renamed",
    ] {
        let _ = edit(kv, key, EditOp::Delete).await;
    }

    // Another database by the switch's setting (text), and a wrong password.
    let mut db1 = config.clone();
    db1.insert("database".into(), json!("1"));
    let other = open(&db1).await.unwrap();
    assert_eq!(other.keyvalue().unwrap().databases().await.unwrap().size, 3);
    let mut wrong = config.clone();
    wrong.insert("password".into(), json!("nope"));
    let err = open(&wrong).await.err().expect("wrong password");
    assert!(err.to_string().contains("Authentication failed"), "{err}");
}

/// The browser's reads stay out of the console log; changes and console
/// commands go in.
async fn only_changes_are_logged(config: &ConnConfig) {
    let log = SqlLog::new();
    let driver = registry::require("redis")
        .unwrap()
        .connect(config, &NetRoute::Direct, log.clone())
        .await
        .unwrap();
    let kv = driver.keyvalue().unwrap();
    log.clear();
    kv.databases().await.unwrap();
    kv.overview().await.unwrap();
    kv.scan(&ScanRequest {
        db: 0,
        cursor: "0".into(),
        pattern: None,
        kind: None,
        count: 50,
    })
    .await
    .unwrap();
    kv.keys_meta(&KeysMetaRequest {
        db: 0,
        keys: vec![bin("greeting")],
    })
    .await
    .unwrap();
    kv.key_info(&KeyRef {
        db: 0,
        key: bin("big:hash"),
    })
    .await
    .unwrap();
    read(kv, "big:hash", |_| {}).await;
    kv.info(None).await.unwrap();
    kv.slowlog(5).await.unwrap();
    kv.classify("GET a", 0).await.unwrap();
    driver.server_info().await.unwrap();
    assert!(log.since(None).0.is_empty(), "{:?}", log.since(None).0);
    let _ = edit(kv, "tp:log:s", EditOp::Delete).await;
    edit(
        kv,
        "tp:log:s",
        EditOp::Create {
            kind: "string".into(),
            value: Some(bin("v")),
            field: None,
            score: None,
            fields: Vec::new(),
            text: None,
            ttl_secs: None,
        },
    )
    .await
    .unwrap();
    console(kv, 0, "GET tp:log:s").await;
    let logged: Vec<String> = log
        .since(None)
        .0
        .into_iter()
        .map(|entry| entry.sql)
        .collect();
    assert!(
        logged.iter().any(|sql| sql == "SET tp:log:s v NX"),
        "{logged:?}"
    );
    assert!(logged.iter().any(|sql| sql == "GET tp:log:s"), "{logged:?}");
    assert!(
        !logged
            .iter()
            .any(|sql| sql.starts_with("TYPE") || sql.starts_with("EXISTS")),
        "{logged:?}"
    );
    edit(kv, "tp:log:s", EditOp::Delete).await.unwrap();
}

#[tokio::test]
async fn redis_8() {
    if std::env::var("TABLEPEEK_TEST_REDIS").is_err() {
        return;
    }
    let port = port("TABLEPEEK_TEST_REDIS_PORT", 16379);
    exercise(plain(port), true).await;
    only_changes_are_logged(&plain(port)).await;
    // The ACL user, and a connection string with the password in it.
    let acl = config(
        json!({ "host": "127.0.0.1", "port": port, "auth": "password",
                              "user": "tablepeek", "password": PASSWORD }),
    );
    let driver = open(&acl).await.unwrap();
    let reply = driver
        .keyvalue()
        .unwrap()
        .console(&ConsoleRequest {
            db: 0,
            line: "ACL WHOAMI".into(),
            confirmed: false,
        })
        .await
        .unwrap();
    assert_eq!(reply.reply, Reply::Bulk(bin("tablepeek")));
    let uri = config(json!({ "uri": format!("redis://:{PASSWORD}@127.0.0.1:{port}/1") }));
    let driver = open(&uri).await.unwrap();
    assert_eq!(
        driver
            .keyvalue()
            .unwrap()
            .databases()
            .await
            .unwrap()
            .current,
        1
    );
    let none = config(json!({ "host": "127.0.0.1", "port": port, "auth": "none" }));
    // Without a password the server refuses the login (and the page asks
    // for one).
    let err = open(&none).await.err().expect("no password");
    assert!(err.to_string().contains("Authentication failed"), "{err}");
    // A database past the server's count.
    let mut far = plain(port);
    far.insert("database".into(), json!(99));
    assert!(open(&far).await.err().unwrap().to_string().contains("99"));
}

#[tokio::test]
async fn redis_tls() {
    if std::env::var("TABLEPEEK_TEST_REDIS_TLS").is_err() {
        return;
    }
    let port = port("TABLEPEEK_TEST_REDIS_TLS_PORT", 16380);
    let tls = config(
        json!({ "host": "127.0.0.1", "port": port, "auth": "password", "password": PASSWORD,
                              "tls": true, "tls_ca_file": cert("ca.pem"),
                              "tls_client_cert": cert("client.pem"), "tls_client_key": cert("client.pem") }),
    );
    exercise(tls.clone(), true).await;
    // The server wants a client certificate.
    let mut without = tls.clone();
    without.remove("tls_client_cert");
    without.remove("tls_client_key");
    assert!(open(&without).await.is_err());
    // Its certificate isn't from the system's roots.
    let mut system = tls.clone();
    system.remove("tls_ca_file");
    assert!(open(&system).await.is_err());
    let mut skip = system.clone();
    skip.insert("tls_skip_verify".into(), json!(true));
    open(&skip).await.expect("unchecked certificate");
    let mut uri = tls.clone();
    uri.remove("host");
    uri.remove("tls");
    uri.insert("uri".into(), json!(format!("rediss://127.0.0.1:{port}")));
    open(&uri).await.expect("rediss:// turns TLS on");
    // Plain TCP to a TLS port fails rather than hanging.
    let mut plain_to_tls = tls;
    plain_to_tls.insert("tls".into(), json!(false));
    assert!(
        tokio::time::timeout(Duration::from_secs(90), open(&plain_to_tls))
            .await
            .expect("no hang")
            .is_err()
    );
}

#[tokio::test]
async fn valkey_8() {
    if std::env::var("TABLEPEEK_TEST_VALKEY").is_err() {
        return;
    }
    let config = plain(port("TABLEPEEK_TEST_VALKEY_PORT", 16381));
    let driver = open(&config).await.unwrap();
    let server = driver.server_info().await.unwrap();
    assert!(server.version.unwrap().starts_with("Valkey "));
    exercise(config, false).await;
}

#[tokio::test]
async fn redis_6() {
    if std::env::var("TABLEPEEK_TEST_REDIS_6").is_err() {
        return;
    }
    exercise(plain(port("TABLEPEEK_TEST_REDIS_6_PORT", 16382)), false).await;
}
