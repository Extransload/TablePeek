//! The server's replies: as the console shows them (`Reply`, typed as the
//! server sent them), read as bytes, numbers and lists for the key views,
//! and its errors as the engine's.

use ::redis::{RedisError, Value};
use tablepeek_types::ErrorFields;

use crate::keyvalue::{Bin, Reply};
use crate::EngineError;

/// A reply as the console shows it.
pub(super) fn reply_of(value: Value) -> Reply {
    match value {
        Value::Nil => Reply::Nil,
        Value::Int(number) => Reply::Int(number),
        Value::BulkString(bytes) => Reply::Bulk(Bin(bytes)),
        Value::Array(items) => Reply::Array(items.into_iter().map(reply_of).collect()),
        Value::SimpleString(text) => Reply::Status(text),
        Value::Okay => Reply::Status("OK".into()),
        Value::Map(pairs) => Reply::Map(
            pairs
                .into_iter()
                .map(|(key, value)| (reply_of(key), reply_of(value)))
                .collect(),
        ),
        Value::Attribute { data, .. } => reply_of(*data),
        Value::Set(items) => Reply::Set(items.into_iter().map(reply_of).collect()),
        Value::Double(number) => Reply::Double(double_text(number)),
        Value::Boolean(flag) => Reply::Bool(flag),
        Value::VerbatimString { format, text } => Reply::Verbatim {
            format: format.to_string(),
            text,
        },
        Value::BigNumber(number) => Reply::Bignum(bignum_text(&number)),
        Value::Push { kind, data } => Reply::Push {
            kind: kind.to_string(),
            data: data.into_iter().map(reply_of).collect(),
        },
        Value::ServerError(err) => Reply::Error(
            match err.details() {
                Some(detail) => format!("{} {detail}", err.code()),
                None => err.code().to_string(),
            }
            .trim()
            .to_string(),
        ),
        #[allow(unreachable_patterns)]
        other => Reply::Status(format!("{other:?}")),
    }
}

/// A RESP3 big number, as the decimal text it came as.
fn bignum_text(number: &[u8]) -> String {
    String::from_utf8_lossy(number).into_owned()
}

/// A double as Redis writes it: `inf`, `-inf`, `nan`, else the shortest
/// text that reads back the same.
pub(super) fn double_text(number: f64) -> String {
    if number.is_nan() {
        "nan".into()
    } else if number.is_infinite() {
        if number > 0.0 { "inf" } else { "-inf" }.into()
    } else {
        number.to_string()
    }
}

/// A reply's bytes: a bulk or simple string, or a number as text.
pub(super) fn bytes(value: Value) -> Option<Vec<u8>> {
    match value {
        Value::BulkString(bytes) => Some(bytes),
        Value::SimpleString(text) => Some(text.into_bytes()),
        Value::Okay => Some(b"OK".to_vec()),
        Value::Int(number) => Some(number.to_string().into_bytes()),
        Value::Double(number) => Some(double_text(number).into_bytes()),
        Value::VerbatimString { text, .. } => Some(text.into_bytes()),
        Value::BigNumber(number) => Some(bignum_text(&number).into_bytes()),
        Value::Attribute { data, .. } => bytes(*data),
        _ => None,
    }
}

/// A reply as text, invalid UTF-8 replaced.
pub(super) fn text(value: Value) -> Option<String> {
    bytes(value).map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

/// A reply as an integer: an integer, or a string holding one.
pub(super) fn int(value: &Value) -> Option<i64> {
    match value {
        Value::Int(number) => Some(*number),
        Value::BulkString(bytes) => std::str::from_utf8(bytes).ok()?.trim().parse().ok(),
        Value::SimpleString(text) => text.trim().parse().ok(),
        Value::Double(number) => Some(*number as i64),
        Value::Attribute { data, .. } => int(data),
        _ => None,
    }
}

/// The elements of an array or set reply; a map's keys and values in turn
/// (HGETALL and CONFIG GET answer with one under RESP3, a flat array under
/// RESP2).
pub(super) fn items(value: Value) -> Vec<Value> {
    match value {
        Value::Array(items) | Value::Set(items) => items,
        Value::Map(pairs) => pairs
            .into_iter()
            .flat_map(|(key, value)| [key, value])
            .collect(),
        Value::Attribute { data, .. } => items(*data),
        _ => Vec::new(),
    }
}

/// Pairs of a reply: a map's, a flat array's in twos, or an array of
/// two-element arrays (ZRANGE … WITHSCORES under RESP3).
pub(super) fn pairs(value: Value) -> Vec<(Value, Value)> {
    match value {
        Value::Map(pairs) => pairs,
        other => {
            let list = items(other);
            if list
                .iter()
                .all(|item| matches!(item, Value::Array(inner) if inner.len() == 2))
            {
                list.into_iter()
                    .filter_map(|item| {
                        let mut inner = items(item).into_iter();
                        Some((inner.next()?, inner.next()?))
                    })
                    .collect()
            } else {
                let mut out = Vec::with_capacity(list.len() / 2);
                let mut iter = list.into_iter();
                while let (Some(key), Some(value)) = (iter.next(), iter.next()) {
                    out.push((key, value));
                }
                out
            }
        }
    }
}

/// A SCAN-family reply: the next cursor and the elements.
pub(super) fn scan_reply(value: Value) -> (String, Vec<Value>) {
    let mut parts = items(value).into_iter();
    let cursor = parts.next().and_then(text).unwrap_or_else(|| "0".into());
    let elements = parts.next().map(items).unwrap_or_default();
    (cursor, elements)
}

/// The text of an INFO reply, in sections: `# Name` lines start one,
/// `key:value` lines fill it.
pub(super) fn info_sections(text: &str) -> Vec<crate::keyvalue::InfoSection> {
    let mut sections: Vec<crate::keyvalue::InfoSection> = Vec::new();
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(name) = line.strip_prefix('#') {
            sections.push(crate::keyvalue::InfoSection {
                name: name.trim().to_string(),
                entries: Vec::new(),
            });
        } else if let Some((key, value)) = line.split_once(':') {
            if sections.is_empty() {
                sections.push(crate::keyvalue::InfoSection {
                    name: String::new(),
                    entries: Vec::new(),
                });
            }
            if let Some(section) = sections.last_mut() {
                section.entries.push((key.to_string(), value.to_string()));
            }
        }
    }
    sections
}

/// One field of INFO's text (`redis_version`), wherever it is.
pub(super) fn info_field<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    text.lines().find_map(|line| {
        let (name, value) = line.trim_end_matches('\r').split_once(':')?;
        (name == key).then_some(value)
    })
}

/// The keyspace lines of an INFO text (`db0:keys=3,expires=1,…`): each
/// database's key and expiry counts.
pub(super) fn keyspace(text: &str) -> std::collections::BTreeMap<u32, (u64, u64)> {
    let mut counts = std::collections::BTreeMap::new();
    for line in text.lines() {
        let Some((name, numbers)) = line.trim_end_matches('\r').split_once(':') else {
            continue;
        };
        let Some(index) = name
            .strip_prefix("db")
            .and_then(|index| index.parse::<u32>().ok())
        else {
            continue;
        };
        let mut keys = 0;
        let mut expires = 0;
        for (field, number) in keyspace_numbers(numbers) {
            match field {
                "keys" => keys = number,
                "expires" => expires = number,
                _ => {}
            }
        }
        counts.insert(index, (keys, expires));
    }
    counts
}

/// A `db0:keys=1,expires=0,avg_ttl=0` line's numbers, by name.
pub(super) fn keyspace_numbers(value: &str) -> impl Iterator<Item = (&str, u64)> {
    value.split(',').filter_map(|part| {
        let (name, number) = part.split_once('=')?;
        Some((name, number.parse().ok()?))
    })
}

/// Whether the server turned the login down: the server then asks for the
/// password again (it looks for "Authentication failed").
fn auth_refused(err: &RedisError) -> bool {
    matches!(err.code(), Some("WRONGPASS" | "NOAUTH"))
        || err.kind() == ::redis::ErrorKind::AuthenticationFailed
        || err
            .detail()
            .is_some_and(|detail| detail.contains("invalid password"))
}

/// The engine's error for one the server or the client library gave: the
/// server's code (`WRONGTYPE`, `NOPERM`) as the error's, its text (code
/// first, as redis-cli shows it) as the message.
pub(super) fn engine_error(err: RedisError) -> EngineError {
    let code = err.code().map(str::to_string);
    let mut message = match (err.code(), err.detail()) {
        (Some(code), Some(detail)) => format!("{code} {detail}"),
        (Some(code), None) => code.to_string(),
        _ => err.to_string(),
    };
    if auth_refused(&err) {
        message = format!("Authentication failed: {message}");
    }
    let raw = err.to_string();
    EngineError::Driver {
        engine: "redis",
        code,
        interrupted: false,
        fields: Box::new(ErrorFields {
            raw: (raw != message).then_some(raw),
            ..Default::default()
        }),
        message,
    }
}

/// An error of this engine with no server code (a connection that failed).
pub(super) fn driver_error(message: impl Into<String>) -> EngineError {
    EngineError::Driver {
        engine: "redis",
        code: None,
        message: message.into(),
        interrupted: false,
        fields: Box::default(),
    }
}
