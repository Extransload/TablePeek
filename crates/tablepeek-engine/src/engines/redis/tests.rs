//! Unit tests: command lines, replies, the wire form of bytes and the
//! connection settings. The live tests are in live.rs.

use ::redis::{Value, VerbatimFormat};
use serde_json::json;
use tablepeek_types::ConnConfig;

use super::command::{command_name, command_text, kind_of, quote_arg, split_args, Kind};
use super::ops::{id_after, id_before};
use super::reply::{info_sections, items, keyspace, keyspace_numbers, pairs, reply_of, scan_reply};
use super::{settings, url_endpoint, Endpoint, FACTORY};
use crate::keyvalue::{Bin, CommandClass, EditOp, EditRequest, KeyPage, Reply};
use crate::registry::{factory, DriverFactory, TunnelTarget};

fn args(line: &str) -> Vec<Vec<u8>> {
    split_args(line).unwrap()
}

fn config(value: serde_json::Value) -> ConnConfig {
    value.as_object().unwrap().clone()
}

#[test]
fn lines_split_as_redis_cli_splits_them() {
    assert_eq!(
        args(r#"SET  "a key"  'it\'s' "\x00\xff\n\"q\"" plain"#),
        vec![
            b"SET".to_vec(),
            b"a key".to_vec(),
            b"it's".to_vec(),
            b"\x00\xff\n\"q\"".to_vec(),
            b"plain".to_vec(),
        ]
    );
    assert_eq!(
        args(r#"SET k """#),
        vec![b"SET".to_vec(), b"k".to_vec(), Vec::new()]
    );
    assert!(args("   ").is_empty());
    assert_eq!(split_args(r#"GET "open"#), Err("닫는 큰따옴표가 없습니다"));
    assert_eq!(split_args("GET 'open"), Err("닫는 작은따옴표가 없습니다"));
    assert_eq!(
        split_args(r#"GET "a"b"#),
        Err("닫는 큰따옴표 뒤에는 공백이 와야 합니다")
    );
    // Unicode stays as its bytes.
    assert_eq!(
        args("GET 키"),
        vec![b"GET".to_vec(), "키".as_bytes().to_vec()]
    );
}

#[test]
fn arguments_are_written_back_so_they_split_the_same() {
    for arg in [
        b"plain".to_vec(),
        b"two words".to_vec(),
        b"\x00\x01\xff\xfeTablePeek\x80\n".to_vec(),
        b"quote \" and \\ back".to_vec(),
        "값 · 値".as_bytes().to_vec(),
        Vec::new(),
    ] {
        let line = format!("SET {}", quote_arg(&arg));
        assert_eq!(args(&line)[1], arg, "{line}");
    }
    assert_eq!(quote_arg(b"user:1"), "user:1");
    assert_eq!(quote_arg(b"a b"), "\"a b\"");
    assert_eq!(quote_arg(b"\xff"), "\"\\xff\"");
    assert_eq!(quote_arg(b""), "\"\"");
}

#[test]
fn passwords_never_reach_the_log() {
    let text = |line: &str| {
        let parts = args(line);
        let refs: Vec<&[u8]> = parts.iter().map(Vec::as_slice).collect();
        command_text(&refs)
    };
    assert_eq!(text("AUTH s3cret"), "AUTH ********");
    assert_eq!(text("AUTH app s3cret"), "AUTH app ********");
    assert_eq!(text("HELLO 3 AUTH app s3cret"), "HELLO 3 AUTH app ********");
    assert_eq!(
        text("MIGRATE h 6379 k 0 5000 AUTH pw"),
        "MIGRATE h 6379 k 0 5000 AUTH ********"
    );
    assert_eq!(
        text("MIGRATE h 6379 k 0 5000 AUTH2 u pw"),
        "MIGRATE h 6379 k 0 5000 AUTH2 u ********"
    );
    assert_eq!(text(r#"SET "a b" 1"#), r#"SET "a b" 1"#);
}

#[test]
fn commands_are_classified_for_safe_mode() {
    let class = |line: &str| kind_of(&args(line));
    assert_eq!(class("get k"), Kind::Known(CommandClass::Read, None));
    assert_eq!(class("HGETALL k"), Kind::Known(CommandClass::Read, None));
    assert_eq!(
        class("CONFIG GET maxmemory"),
        Kind::Known(CommandClass::Read, None)
    );
    assert_eq!(class("set k v"), Kind::Known(CommandClass::Write, None));
    assert_eq!(
        class("SLOWLOG RESET"),
        Kind::Known(CommandClass::Write, None)
    );
    assert_eq!(class("DEL a b c"), Kind::Known(CommandClass::Write, None));
    assert!(matches!(
        class("DEL a b c d e f g h i j"),
        Kind::Known(CommandClass::Danger, Some(_))
    ));
    for danger in [
        "FLUSHALL",
        "flushdb async",
        "SHUTDOWN NOSAVE",
        "CONFIG SET maxmemory 1",
        "DEBUG SLEEP 1",
        "SWAPDB 0 1",
        "CLIENT KILL ID 3",
        "SCRIPT FLUSH",
        "ACL DELUSER x",
    ] {
        assert!(
            matches!(class(danger), Kind::Known(CommandClass::Danger, Some(_))),
            "{danger}"
        );
    }
    assert_eq!(class("KEYS *"), Kind::Keys);
    for refused in [
        "SUBSCRIBE ch",
        "MONITOR",
        "AUTH pw",
        "HELLO 3",
        "QUIT",
        "CLIENT REPLY OFF",
    ] {
        assert!(matches!(class(refused), Kind::Refused(_)), "{refused}");
    }
    assert_eq!(class("JSON.GET doc"), Kind::Known(CommandClass::Read, None));
    assert_eq!(class("MYMODULE.DO x"), Kind::Unknown);
    assert_eq!(command_name(&args("config set a b")), "CONFIG SET");
    assert_eq!(command_name(&args("get k")), "GET");
}

#[test]
fn replies_keep_the_type_the_server_sent() {
    let value = Value::Array(vec![
        Value::Nil,
        Value::Int(7),
        Value::BulkString(b"\xff\x00".to_vec()),
        Value::SimpleString("PONG".into()),
        Value::Okay,
        Value::Double(f64::INFINITY),
        Value::Double(1.5),
        Value::Boolean(true),
        Value::Map(vec![(
            Value::BulkString(b"field".to_vec()),
            Value::BulkString(b"value".to_vec()),
        )]),
        Value::Set(vec![Value::BulkString(b"m".to_vec())]),
        Value::VerbatimString {
            format: VerbatimFormat::Text,
            text: "hello".into(),
        },
        Value::BigNumber(b"123456789012345678901234567890".to_vec()),
    ]);
    let reply = reply_of(value);
    assert_eq!(
        serde_json::to_value(&reply).unwrap(),
        json!({ "t": "array", "v": [
            { "t": "nil" },
            { "t": "int", "v": 7 },
            { "t": "bulk", "v": { "b64": "/wA=" } },
            { "t": "status", "v": "PONG" },
            { "t": "status", "v": "OK" },
            { "t": "double", "v": "inf" },
            { "t": "double", "v": "1.5" },
            { "t": "bool", "v": true },
            { "t": "map", "v": [[{ "t": "bulk", "v": "field" }, { "t": "bulk", "v": "value" }]] },
            { "t": "set", "v": [{ "t": "bulk", "v": "m" }] },
            { "t": "verbatim", "v": { "format": "txt", "text": "hello" } },
            { "t": "bignum", "v": "123456789012345678901234567890" },
        ]})
    );
    assert_eq!(
        serde_json::from_value::<Reply>(serde_json::to_value(&reply).unwrap()).unwrap(),
        reply
    );
}

#[test]
fn replies_read_alike_under_resp2_and_resp3() {
    // HGETALL: a flat array (RESP2) or a map (RESP3).
    let flat = Value::Array(vec![
        Value::BulkString(b"a".to_vec()),
        Value::BulkString(b"1".to_vec()),
    ]);
    let map = Value::Map(vec![(
        Value::BulkString(b"a".to_vec()),
        Value::BulkString(b"1".to_vec()),
    )]);
    assert_eq!(pairs(flat), pairs(map));
    // ZRANGE … WITHSCORES: flat (RESP2) or pairs with doubles (RESP3).
    let nested = Value::Array(vec![Value::Array(vec![
        Value::BulkString(b"m".to_vec()),
        Value::Double(2.5),
    ])]);
    assert_eq!(pairs(nested).len(), 1);
    let (cursor, found) = scan_reply(Value::Array(vec![
        Value::BulkString(b"17".to_vec()),
        Value::Array(vec![Value::BulkString(b"k".to_vec())]),
    ]));
    assert_eq!(cursor, "17");
    assert_eq!(found.len(), 1);
    assert_eq!(items(Value::Nil).len(), 0);
}

#[test]
fn info_reads_in_sections() {
    let text = "# Server\r\nredis_version:8.0.2\r\nredis_mode:standalone\r\n\r\n# Keyspace\r\ndb0:keys=3,expires=1,avg_ttl=10\r\n";
    let sections = info_sections(text);
    assert_eq!(sections.len(), 2);
    assert_eq!(sections[0].name, "Server");
    assert_eq!(
        sections[0].entries[0],
        ("redis_version".to_string(), "8.0.2".to_string())
    );
    assert_eq!(sections[1].entries[0].0, "db0");
    let counts = keyspace(text);
    assert_eq!(counts.get(&0), Some(&(3, 1)));
    assert_eq!(counts.len(), 1);
    assert!(keyspace("# Keyspace\r\ndbx:keys=1\r\n").is_empty());
    let numbers: Vec<_> = keyspace_numbers("keys=3,expires=1,avg_ttl=10").collect();
    assert_eq!(numbers, vec![("keys", 3), ("expires", 1), ("avg_ttl", 10)]);
}

#[test]
fn bytes_travel_as_text_or_base64() {
    assert_eq!(
        serde_json::to_value(Bin::from("user:1")).unwrap(),
        json!("user:1")
    );
    assert_eq!(
        serde_json::to_value(Bin(vec![0, 255])).unwrap(),
        json!({ "b64": "AP8=" })
    );
    assert_eq!(
        serde_json::from_value::<Bin>(json!({ "b64": "AP8=" })).unwrap(),
        Bin(vec![0, 255])
    );
    assert!(serde_json::from_value::<Bin>(json!({ "hex": "00 ff 0x" })).is_err());
    assert_eq!(
        serde_json::from_value::<Bin>(json!({ "hex": "0x00ff41" })).unwrap(),
        Bin(vec![0, 255, b'A'])
    );
    assert!(serde_json::from_value::<Bin>(json!(12)).is_err());
    let edit: EditRequest = serde_json::from_value(json!({
        "db": 2, "key": { "b64": "AP8=" }, "op": "hash_set", "field": "f", "value": "v"
    }))
    .unwrap();
    assert_eq!(edit.db, 2);
    assert!(matches!(
        edit.op,
        EditOp::HashSet {
            only_new: false,
            ..
        }
    ));
    let page = KeyPage::Stream {
        entries: Vec::new(),
        next: None,
        total: 0,
    };
    assert_eq!(serde_json::to_value(page).unwrap()["type"], json!("stream"));
}

#[test]
fn urls_name_the_server() {
    assert_eq!(
        url_endpoint("redis://:s3cret@cache.example.com:6380/2").unwrap(),
        Endpoint {
            tls: false,
            host: "cache.example.com".into(),
            port: 6380,
            user: None,
            password: Some("s3cret".into()),
            db: Some(2),
        }
    );
    let tls = url_endpoint("rediss://app:p%40ss@[::1]?db=3").unwrap();
    assert!(tls.tls);
    assert_eq!(tls.host, "::1");
    assert_eq!(tls.port, 6379);
    assert_eq!(tls.user.as_deref(), Some("app"));
    assert_eq!(tls.password.as_deref(), Some("p@ss"));
    assert_eq!(tls.db, Some(3));
    assert!(url_endpoint("unix:///tmp/redis.sock").is_err());
    assert!(url_endpoint("redis://a:1,b:2").is_err());
    assert!(url_endpoint("http://a").is_err());
    assert!(url_endpoint("redis://h/x").is_err());
}

#[test]
fn settings_infer_the_login_and_take_the_database_as_text() {
    let (s, endpoint) = settings(&config(
        json!({ "host": "h", "port": 6390, "database": "3" }),
    ))
    .unwrap();
    assert_eq!(endpoint.db, Some(3));
    assert_eq!(s.auth_kind(&endpoint), Ok("none"));
    // A database switch writes the number as text; it wins over the URL's.
    let (_, endpoint) =
        settings(&config(json!({ "uri": "redis://h/1", "database": "4" }))).unwrap();
    assert_eq!(endpoint.db, Some(4));
    let (s, endpoint) = settings(&config(json!({ "host": "h", "user": "app" }))).unwrap();
    assert_eq!(s.auth_kind(&endpoint), Ok("password"));
    assert!(settings(&config(json!({ "host": "h", "auth": "kerberos" }))).is_err());
    assert!(settings(&config(json!({ "host": "redis://h" }))).is_err());
    assert!(settings(&config(json!({ "host": "h", "database": "x" }))).is_err());

    assert!(!FACTORY.needs_password(&config(json!({ "host": "h", "auth": "none" }))));
    assert!(FACTORY.needs_password(&config(json!({ "host": "h", "auth": "password" }))));
    let mut old = config(json!({ "host": "h", "password": "x" }));
    FACTORY.upgrade_config(&mut old);
    assert_eq!(old["auth"], json!("password"));
    assert_eq!(
        FACTORY.address(&config(
            json!({ "host": "h", "port": 6390, "auth": "password", "user": "app", "tls": true, "database": 2 })
        )),
        "rediss://app@h:6390/2"
    );
    assert_eq!(
        FACTORY.tunnel_target(&config(json!({ "uri": "redis://cache:6400/0" }))),
        Ok(TunnelTarget::Address("cache".into(), 6400))
    );
}

#[test]
fn the_engine_is_registered_with_its_alias() {
    let engine = factory("valkey").unwrap().descriptor();
    assert_eq!(engine.id, "redis");
    assert_eq!(engine.paradigm, "keyvalue");
    assert_eq!(engine.secret_keys().collect::<Vec<_>>(), vec!["password"]);
    let mut typed = config(json!({ "uri": "redis://app:s3cret@h:6379/0" }));
    engine.secure_config(&mut typed);
    assert_eq!(typed["uri"], json!("redis://app@h:6379/0"));
    assert_eq!(typed["password"], json!("s3cret"));
}

#[test]
fn stream_pages_continue_past_the_last_id() {
    assert_eq!(id_after("1700-5").as_deref(), Some("1700-6"));
    assert_eq!(
        id_after(&format!("1700-{}", u64::MAX)).as_deref(),
        Some("1701-0")
    );
    assert_eq!(id_before("1700-5").as_deref(), Some("1700-4"));
    assert_eq!(id_before("1700-0"), Some(format!("1699-{}", u64::MAX)));
    assert_eq!(id_before("0-0"), None);
    assert_eq!(id_after("nonsense"), None);
}
