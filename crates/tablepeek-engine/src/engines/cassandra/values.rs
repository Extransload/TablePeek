//! CQL values to and from what the page shows and sends. A cell is a JSON
//! scalar where the value is one (numbers, text, booleans; times, UUIDs and
//! addresses as text), and JSON text for collections, UDTs, tuples and
//! vectors, written as Cassandra's own `toJson()` writes them. Edits come
//! back as text and are read against the column's type.

use std::net::IpAddr;

use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Timelike, Utc};
use scylla::frame::response::result::{CollectionType, ColumnType, NativeType, UserDefinedType};
use scylla::value::{
    Counter, CqlDate, CqlDecimal, CqlDuration, CqlTime, CqlTimestamp, CqlTimeuuid, CqlValue,
    CqlVarint,
};
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::sql_log::LogParam;
use crate::EngineError;

/// Days CQL's `date` counts from: 2^31 is 1970-01-01.
const DATE_EPOCH: i64 = 1 << 31;

const NANOS_PER_DAY: i64 = 86_400_000_000_000;

fn bad_value(text: &str, kind: &str) -> EngineError {
    EngineError::BadRequest(format!("{kind} 값이 아닙니다: {text}"))
}

/// A cell as the grid shows it.
pub(crate) fn cell(value: Option<&CqlValue>) -> Value {
    match value {
        None | Some(CqlValue::Empty) => Value::Null,
        Some(
            value @ (CqlValue::List(_)
            | CqlValue::Set(_)
            | CqlValue::Map(_)
            | CqlValue::UserDefinedType { .. }
            | CqlValue::Tuple(_)
            | CqlValue::Vector(_)),
        ) => Value::String(json(value).to_string()),
        Some(value) => json(value),
    }
}

/// A value as Cassandra's JSON writes it: numbers as numbers (varint and
/// decimal too, at full precision), times, UUIDs, addresses and blobs as
/// strings, maps as objects keyed by their keys' text.
pub(crate) fn json(value: &CqlValue) -> Value {
    match value {
        CqlValue::Ascii(text) | CqlValue::Text(text) => Value::String(text.clone()),
        CqlValue::Boolean(flag) => Value::Bool(*flag),
        CqlValue::Blob(bytes) => Value::String(blob_text(bytes)),
        CqlValue::Counter(Counter(number)) | CqlValue::BigInt(number) => Value::from(*number),
        CqlValue::Int(number) => Value::from(*number),
        CqlValue::SmallInt(number) => Value::from(*number),
        CqlValue::TinyInt(number) => Value::from(*number),
        CqlValue::Float(number) => crate::real_json(*number),
        CqlValue::Double(number) => crate::double_json(*number),
        CqlValue::Decimal(decimal) => exact_number(decimal_text(decimal)),
        CqlValue::Varint(varint) => exact_number(varint_text(varint.as_signed_bytes_be_slice())),
        CqlValue::Date(date) => Value::String(date_text(*date)),
        CqlValue::Time(time) => Value::String(time_text(*time)),
        CqlValue::Timestamp(stamp) => Value::String(timestamp_text(*stamp)),
        CqlValue::Duration(duration) => Value::String(duration_text(duration)),
        CqlValue::Inet(address) => Value::String(address.to_string()),
        CqlValue::Uuid(uuid) => Value::String(uuid.to_string()),
        CqlValue::Timeuuid(uuid) => Value::String(uuid.to_string()),
        CqlValue::Empty => Value::Null,
        CqlValue::List(items) | CqlValue::Set(items) | CqlValue::Vector(items) => {
            Value::Array(items.iter().map(json).collect())
        }
        CqlValue::Tuple(items) => Value::Array(
            items
                .iter()
                .map(|item| item.as_ref().map_or(Value::Null, json))
                .collect(),
        ),
        CqlValue::Map(pairs) => {
            let mut object = Map::with_capacity(pairs.len());
            for (key, item) in pairs {
                let key = match json(key) {
                    Value::String(text) => text,
                    other => other.to_string(),
                };
                object.insert(key, json(item));
            }
            Value::Object(object)
        }
        CqlValue::UserDefinedType { fields, .. } => {
            let mut object = Map::with_capacity(fields.len());
            for (name, item) in fields {
                object.insert(name.clone(), item.as_ref().map_or(Value::Null, json));
            }
            Value::Object(object)
        }
        // Kinds a later driver adds: as the driver writes them.
        other => Value::String(other.to_string()),
    }
}

/// A number serde_json keeps exactly (an integer that fits), else its text:
/// a varint or decimal wider than a double stays whole.
fn exact_number(text: String) -> Value {
    if let Ok(number) = text.parse::<i64>() {
        return Value::from(number);
    }
    Value::String(text)
}

pub(crate) fn blob_text(bytes: &[u8]) -> String {
    let mut text = String::with_capacity(2 + bytes.len() * 2);
    text.push_str("0x");
    for byte in bytes {
        text.push_str(&format!("{byte:02x}"));
    }
    text
}

fn date_text(date: CqlDate) -> String {
    let days = i64::from(date.0) - DATE_EPOCH;
    NaiveDate::from_yo_opt(1970, 1)
        .and_then(|epoch| epoch.checked_add_signed(chrono::Duration::days(days)))
        .map_or_else(
            || days.to_string(),
            |day| day.format("%Y-%m-%d").to_string(),
        )
}

fn time_text(time: CqlTime) -> String {
    let nanos = time.0;
    format!(
        "{:02}:{:02}:{:02}.{:09}",
        nanos / 3_600_000_000_000,
        nanos / 60_000_000_000 % 60,
        nanos / 1_000_000_000 % 60,
        nanos % 1_000_000_000
    )
}

/// As Cassandra's JSON and cqlsh write it, in UTC.
fn timestamp_text(stamp: CqlTimestamp) -> String {
    DateTime::<Utc>::from_timestamp_millis(stamp.0).map_or_else(
        || stamp.0.to_string(),
        |time| time.format("%Y-%m-%d %H:%M:%S%.3fZ").to_string(),
    )
}

/// CQL's own duration form: `1y2mo3d4h5m6s7ms8us9ns`, units left out at 0.
pub(crate) fn duration_text(duration: &CqlDuration) -> String {
    let negative = duration.months < 0 || duration.days < 0 || duration.nanoseconds < 0;
    let mut out = String::new();
    if negative {
        out.push('-');
    }
    let months = i64::from(duration.months).abs();
    let units: [(i64, &str); 2] = [(months / 12, "y"), (months % 12, "mo")];
    for (amount, unit) in units {
        if amount != 0 {
            out.push_str(&format!("{amount}{unit}"));
        }
    }
    let days = i64::from(duration.days).abs();
    if days != 0 {
        out.push_str(&format!("{days}d"));
    }
    let mut nanos = duration.nanoseconds.abs();
    for (size, unit) in [
        (3_600_000_000_000, "h"),
        (60_000_000_000, "m"),
        (1_000_000_000, "s"),
        (1_000_000, "ms"),
        (1_000, "us"),
        (1, "ns"),
    ] {
        let amount = nanos / size;
        nanos %= size;
        if amount != 0 {
            out.push_str(&format!("{amount}{unit}"));
        }
    }
    if out.is_empty() || out == "-" {
        return "0s".into();
    }
    out
}

/// A big-endian two's complement integer as decimal text.
fn varint_text(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return "0".into();
    }
    let negative = bytes[0] & 0x80 != 0;
    // The magnitude, big-endian.
    let mut magnitude: Vec<u8> = if negative {
        let mut inverted: Vec<u8> = bytes.iter().map(|byte| !byte).collect();
        for byte in inverted.iter_mut().rev() {
            let (sum, carry) = byte.overflowing_add(1);
            *byte = sum;
            if !carry {
                break;
            }
        }
        inverted
    } else {
        bytes.to_vec()
    };
    let mut digits = Vec::new();
    while magnitude.iter().any(|byte| *byte != 0) {
        let mut remainder = 0u32;
        for byte in magnitude.iter_mut() {
            let current = (remainder << 8) | u32::from(*byte);
            *byte = (current / 10) as u8;
            remainder = current % 10;
        }
        digits.push(b'0' + remainder as u8);
    }
    if digits.is_empty() {
        digits.push(b'0');
    }
    if negative {
        digits.push(b'-');
    }
    digits.reverse();
    String::from_utf8(digits).unwrap_or_default()
}

/// Decimal text (an optional sign and digits) as big-endian two's complement.
fn varint_bytes(text: &str) -> Option<Vec<u8>> {
    let (negative, digits) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text.strip_prefix('+').unwrap_or(text)),
    };
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    // Little-endian magnitude, grown digit by digit.
    let mut magnitude: Vec<u8> = vec![0];
    for digit in digits.bytes() {
        let mut carry = u32::from(digit - b'0');
        for byte in magnitude.iter_mut() {
            let current = u32::from(*byte) * 10 + carry;
            *byte = (current & 0xff) as u8;
            carry = current >> 8;
        }
        while carry > 0 {
            magnitude.push((carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    // Room for the sign bit.
    if magnitude.last().is_some_and(|byte| byte & 0x80 != 0) {
        magnitude.push(0);
    }
    if negative {
        for byte in magnitude.iter_mut() {
            *byte = !*byte;
        }
        for byte in magnitude.iter_mut() {
            let (sum, carry) = byte.overflowing_add(1);
            *byte = sum;
            if !carry {
                break;
            }
        }
    }
    magnitude.reverse();
    Some(magnitude)
}

fn decimal_text(decimal: &CqlDecimal) -> String {
    let (bytes, scale) = decimal.as_signed_be_bytes_slice_and_exponent();
    let unscaled = varint_text(bytes);
    if scale <= 0 {
        let zeros = "0".repeat(scale.unsigned_abs() as usize);
        return if unscaled == "0" {
            unscaled
        } else {
            format!("{unscaled}{zeros}")
        };
    }
    let (sign, digits) = match unscaled.strip_prefix('-') {
        Some(rest) => ("-", rest),
        None => ("", unscaled.as_str()),
    };
    let scale = scale as usize;
    let padded = if digits.len() <= scale {
        format!("{}{digits}", "0".repeat(scale + 1 - digits.len()))
    } else {
        digits.to_string()
    };
    let point = padded.len() - scale;
    format!("{sign}{}.{}", &padded[..point], &padded[point..])
}

fn decimal_value(text: &str) -> Option<CqlDecimal> {
    let text = text.trim();
    let (mantissa, exponent) = match text.find(['e', 'E']) {
        Some(at) => (&text[..at], text[at + 1..].parse::<i32>().ok()?),
        None => (text, 0),
    };
    let (whole, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    if !fraction.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let digits = if whole.is_empty() || whole == "-" || whole == "+" {
        format!("{whole}0{fraction}")
    } else {
        format!("{whole}{fraction}")
    };
    let bytes = varint_bytes(&digits)?;
    let scale = i32::try_from(fraction.len()).ok()?.checked_sub(exponent)?;
    Some(CqlDecimal::from_signed_be_bytes_and_exponent(bytes, scale))
}

/// What the console and History show for a bound value: a CQL literal.
pub(crate) fn log_param(value: Option<&CqlValue>) -> LogParam {
    match value {
        None | Some(CqlValue::Empty) => LogParam::Null,
        Some(CqlValue::Int(number)) => LogParam::Int(i64::from(*number)),
        Some(CqlValue::BigInt(number)) | Some(CqlValue::Counter(Counter(number))) => {
            LogParam::Int(*number)
        }
        Some(CqlValue::SmallInt(number)) => LogParam::Int(i64::from(*number)),
        Some(CqlValue::TinyInt(number)) => LogParam::Int(i64::from(*number)),
        Some(CqlValue::Float(number)) => LogParam::Float(f64::from(*number)),
        Some(CqlValue::Double(number)) => LogParam::Float(*number),
        Some(CqlValue::Boolean(flag)) => LogParam::Bool(*flag),
        Some(CqlValue::Blob(bytes)) => LogParam::Blob(bytes.clone()),
        Some(CqlValue::Ascii(text)) | Some(CqlValue::Text(text)) => LogParam::Text(text.clone()),
        Some(value) => LogParam::Literal(literal(value)),
    }
}

/// A value written as a CQL literal.
pub(crate) fn literal(value: &CqlValue) -> String {
    let quoted = |text: &str| format!("'{}'", text.replace('\'', "''"));
    let join = |items: &mut dyn Iterator<Item = String>| items.collect::<Vec<_>>().join(", ");
    match value {
        CqlValue::Ascii(text) | CqlValue::Text(text) => quoted(text),
        CqlValue::Date(_) | CqlValue::Time(_) | CqlValue::Timestamp(_) | CqlValue::Inet(_) => {
            match json(value) {
                Value::String(text) => quoted(&text),
                other => other.to_string(),
            }
        }
        CqlValue::Blob(bytes) => blob_text(bytes),
        CqlValue::Empty => "NULL".into(),
        CqlValue::Decimal(decimal) => decimal_text(decimal),
        CqlValue::Varint(varint) => varint_text(varint.as_signed_bytes_be_slice()),
        CqlValue::Duration(duration) => duration_text(duration),
        CqlValue::Uuid(uuid) => uuid.to_string(),
        CqlValue::Timeuuid(uuid) => uuid.to_string(),
        CqlValue::Float(_) | CqlValue::Double(_) => match json(value) {
            Value::String(text) => text,
            other => other.to_string(),
        },
        CqlValue::Boolean(flag) => flag.to_string(),
        CqlValue::Int(_)
        | CqlValue::BigInt(_)
        | CqlValue::SmallInt(_)
        | CqlValue::TinyInt(_)
        | CqlValue::Counter(_) => json(value).to_string(),
        CqlValue::List(items) | CqlValue::Vector(items) => {
            format!("[{}]", join(&mut items.iter().map(literal)))
        }
        CqlValue::Set(items) => format!("{{{}}}", join(&mut items.iter().map(literal))),
        CqlValue::Map(pairs) => format!(
            "{{{}}}",
            join(&mut pairs.iter().map(|(key, item)| format!(
                "{}: {}",
                literal(key),
                literal(item)
            )))
        ),
        CqlValue::Tuple(items) => format!(
            "({})",
            join(
                &mut items
                    .iter()
                    .map(|item| item.as_ref().map_or_else(|| "NULL".into(), literal))
            )
        ),
        CqlValue::UserDefinedType { fields, .. } => format!(
            "{{{}}}",
            join(&mut fields.iter().map(|(name, item)| format!(
                "{}: {}",
                quote_name(name),
                item.as_ref().map_or_else(|| "NULL".into(), literal)
            )))
        ),
        other => other.to_string(),
    }
}

/// A name as CQL writes it: bare when it is lower case letters, digits and
/// underscores (as CQL folds unquoted names), quoted otherwise.
pub(crate) fn quote_name(name: &str) -> String {
    let plain = name
        .chars()
        .next()
        .is_some_and(|first| first.is_ascii_lowercase())
        && name
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '_');
    if plain && !RESERVED.contains(&name) {
        name.to_string()
    } else {
        format!("\"{}\"", name.replace('"', "\"\""))
    }
}

/// CQL's reserved words: a name spelled like one is quoted.
const RESERVED: &[&str] = &[
    "add",
    "allow",
    "alter",
    "and",
    "apply",
    "asc",
    "authorize",
    "batch",
    "begin",
    "by",
    "columnfamily",
    "create",
    "default",
    "delete",
    "desc",
    "describe",
    "drop",
    "entries",
    "execute",
    "from",
    "full",
    "grant",
    "if",
    "in",
    "index",
    "infinity",
    "insert",
    "into",
    "is",
    "keyspace",
    "limit",
    "materialized",
    "mbean",
    "mbeans",
    "modify",
    "nan",
    "norecursive",
    "not",
    "null",
    "of",
    "on",
    "or",
    "order",
    "primary",
    "rename",
    "replace",
    "revoke",
    "schema",
    "select",
    "set",
    "table",
    "to",
    "token",
    "truncate",
    "unlogged",
    "unset",
    "update",
    "use",
    "using",
    "view",
    "where",
    "with",
];

/// The value of a cell as typed (or as the grid sends a key), read for a
/// column of type `typ`. Collections, UDTs, tuples and vectors take JSON.
pub(crate) fn from_text(typ: &ColumnType<'_>, text: &str) -> Result<CqlValue, EngineError> {
    match typ {
        ColumnType::Native(native) => native_from_text(native, text),
        _ => {
            let parsed: Value = serde_json::from_str(text.trim()).map_err(|err| {
                EngineError::BadRequest(format!(
                    "{} 값은 JSON으로 입력하세요 ({err})",
                    type_name(typ)
                ))
            })?;
            from_json(typ, &parsed)?
                .ok_or_else(|| EngineError::BadRequest("NULL을 넣을 수 없는 자리입니다".into()))
        }
    }
}

/// A key value the grid sent (as it read the cell), for a column of `typ`.
pub(crate) fn from_cell(
    typ: &ColumnType<'_>,
    value: &Value,
) -> Result<Option<CqlValue>, EngineError> {
    match value {
        Value::Null => Ok(None),
        Value::String(text) => from_text(typ, text).map(Some),
        other => from_json(typ, other),
    }
}

/// A JSON value read for a column of `typ`, as `fromJson()` reads one.
pub(crate) fn from_json(
    typ: &ColumnType<'_>,
    value: &Value,
) -> Result<Option<CqlValue>, EngineError> {
    if value.is_null() {
        return Ok(None);
    }
    let mismatch = || {
        EngineError::BadRequest(format!(
            "{} 자리에 맞지 않는 값입니다: {value}",
            type_name(typ)
        ))
    };
    let items = |inner: &ColumnType<'_>| -> Result<Vec<CqlValue>, EngineError> {
        let Value::Array(items) = value else {
            return Err(mismatch());
        };
        items
            .iter()
            .map(|item| from_json(inner, item)?.ok_or_else(mismatch))
            .collect()
    };
    Ok(Some(match typ {
        ColumnType::Native(native) => match value {
            Value::String(text) => native_from_text(native, text)?,
            Value::Bool(flag) if *native == NativeType::Boolean => CqlValue::Boolean(*flag),
            Value::Number(number) => native_from_text(native, &number.to_string())?,
            _ => return Err(mismatch()),
        },
        ColumnType::Collection { typ, .. } => match typ {
            CollectionType::List(inner) => CqlValue::List(items(inner)?),
            CollectionType::Set(inner) => CqlValue::Set(items(inner)?),
            CollectionType::Map(key_type, item_type) => {
                let mut pairs = Vec::new();
                match value {
                    Value::Object(object) => {
                        for (key, item) in object {
                            let key = from_text(key_type, key)?;
                            let item = from_json(item_type, item)?.ok_or_else(mismatch)?;
                            pairs.push((key, item));
                        }
                    }
                    // [[key, value], …], for keys JSON can't name.
                    Value::Array(entries) => {
                        for entry in entries {
                            let Some([key, item]) = entry.as_array().map(Vec::as_slice) else {
                                return Err(mismatch());
                            };
                            let key = from_json(key_type, key)?.ok_or_else(mismatch)?;
                            let item = from_json(item_type, item)?.ok_or_else(mismatch)?;
                            pairs.push((key, item));
                        }
                    }
                    _ => return Err(mismatch()),
                }
                CqlValue::Map(pairs)
            }
            _ => return Err(mismatch()),
        },
        ColumnType::Vector { typ, dimensions } => {
            let items = items(typ)?;
            if items.len() != usize::from(*dimensions) {
                return Err(EngineError::BadRequest(format!(
                    "벡터에는 값이 {dimensions}개 있어야 합니다"
                )));
            }
            CqlValue::Vector(items)
        }
        ColumnType::UserDefinedType { definition, .. } => udt_from_json(definition, value)?,
        ColumnType::Tuple(types) => {
            let Value::Array(items) = value else {
                return Err(mismatch());
            };
            if items.len() > types.len() {
                return Err(mismatch());
            }
            let mut out = Vec::with_capacity(types.len());
            for (index, inner) in types.iter().enumerate() {
                out.push(match items.get(index) {
                    Some(item) => from_json(inner, item)?,
                    None => None,
                });
            }
            CqlValue::Tuple(out)
        }
        _ => return Err(mismatch()),
    }))
}

fn udt_from_json(definition: &UserDefinedType<'_>, value: &Value) -> Result<CqlValue, EngineError> {
    let Value::Object(object) = value else {
        return Err(EngineError::BadRequest(format!(
            "{} 값은 JSON 객체로 입력하세요",
            definition.name
        )));
    };
    if let Some(unknown) = object.keys().find(|key| {
        !definition
            .field_types
            .iter()
            .any(|(name, _)| name == key.as_str())
    }) {
        return Err(EngineError::BadRequest(format!(
            "{} 타입에 {unknown} 필드가 없습니다",
            definition.name
        )));
    }
    let mut fields = Vec::with_capacity(definition.field_types.len());
    for (name, field_type) in &definition.field_types {
        let item = match object.get(name.as_ref()) {
            Some(item) => from_json(field_type, item)?,
            None => None,
        };
        fields.push((name.to_string(), item));
    }
    Ok(CqlValue::UserDefinedType {
        keyspace: definition.keyspace.to_string(),
        name: definition.name.to_string(),
        fields,
    })
}

fn native_from_text(native: &NativeType, raw: &str) -> Result<CqlValue, EngineError> {
    let text = raw.trim();
    let int = |kind: &str| text.parse::<i64>().map_err(|_| bad_value(raw, kind));
    Ok(match native {
        NativeType::Ascii => {
            if !raw.is_ascii() {
                return Err(bad_value(raw, "ascii"));
            }
            CqlValue::Ascii(raw.to_string())
        }
        NativeType::Text => CqlValue::Text(raw.to_string()),
        NativeType::Boolean => match text.to_ascii_lowercase().as_str() {
            "true" | "1" => CqlValue::Boolean(true),
            "false" | "0" => CqlValue::Boolean(false),
            _ => return Err(bad_value(raw, "boolean")),
        },
        NativeType::Blob => CqlValue::Blob(
            crate::shown_hex_bytes(text)
                .or_else(|| crate::hex_bytes(text))
                .ok_or_else(crate::not_hex)?,
        ),
        NativeType::Counter => CqlValue::Counter(Counter(int("counter")?)),
        NativeType::BigInt => CqlValue::BigInt(int("bigint")?),
        NativeType::Int => {
            CqlValue::Int(i32::try_from(int("int")?).map_err(|_| bad_value(raw, "int"))?)
        }
        NativeType::SmallInt => CqlValue::SmallInt(
            i16::try_from(int("smallint")?).map_err(|_| bad_value(raw, "smallint"))?,
        ),
        NativeType::TinyInt => {
            CqlValue::TinyInt(i8::try_from(int("tinyint")?).map_err(|_| bad_value(raw, "tinyint"))?)
        }
        NativeType::Float => {
            CqlValue::Float(float(text).map_err(|_| bad_value(raw, "float"))? as f32)
        }
        NativeType::Double => CqlValue::Double(float(text).map_err(|_| bad_value(raw, "double"))?),
        NativeType::Decimal => {
            CqlValue::Decimal(decimal_value(text).ok_or_else(|| bad_value(raw, "decimal"))?)
        }
        NativeType::Varint => CqlValue::Varint(CqlVarint::from_signed_bytes_be(
            varint_bytes(text).ok_or_else(|| bad_value(raw, "varint"))?,
        )),
        NativeType::Uuid => {
            CqlValue::Uuid(Uuid::parse_str(text).map_err(|_| bad_value(raw, "uuid"))?)
        }
        NativeType::Timeuuid => {
            let uuid = Uuid::parse_str(text).map_err(|_| bad_value(raw, "timeuuid"))?;
            if uuid.get_version_num() != 1 {
                return Err(bad_value(raw, "timeuuid (버전 1 UUID)"));
            }
            CqlValue::Timeuuid(CqlTimeuuid::from(uuid))
        }
        NativeType::Inet => {
            CqlValue::Inet(text.parse::<IpAddr>().map_err(|_| bad_value(raw, "inet"))?)
        }
        NativeType::Date => CqlValue::Date(date_value(text).ok_or_else(|| bad_value(raw, "date"))?),
        NativeType::Time => CqlValue::Time(time_value(text).ok_or_else(|| bad_value(raw, "time"))?),
        NativeType::Timestamp => {
            CqlValue::Timestamp(timestamp_value(text).ok_or_else(|| bad_value(raw, "timestamp"))?)
        }
        NativeType::Duration => {
            CqlValue::Duration(duration_value(text).ok_or_else(|| bad_value(raw, "duration"))?)
        }
        _ => {
            return Err(EngineError::BadRequest(format!(
                "이 타입은 편집할 수 없습니다: {native:?}"
            )))
        }
    })
}

fn float(text: &str) -> Result<f64, std::num::ParseFloatError> {
    match text.to_ascii_lowercase().as_str() {
        "nan" => Ok(f64::NAN),
        "infinity" | "inf" => Ok(f64::INFINITY),
        "-infinity" | "-inf" => Ok(f64::NEG_INFINITY),
        _ => text.parse(),
    }
}

fn date_value(text: &str) -> Option<CqlDate> {
    let day = NaiveDate::parse_from_str(text, "%Y-%m-%d").ok()?;
    let epoch = NaiveDate::from_yo_opt(1970, 1)?;
    let days = DATE_EPOCH + day.signed_duration_since(epoch).num_days();
    u32::try_from(days).ok().map(CqlDate)
}

fn time_value(text: &str) -> Option<CqlTime> {
    let time = ["%H:%M:%S%.f", "%H:%M"]
        .iter()
        .find_map(|format| NaiveTime::parse_from_str(text, format).ok())?;
    let nanos =
        i64::from(time.num_seconds_from_midnight()) * 1_000_000_000 + i64::from(time.nanosecond());
    (nanos < NANOS_PER_DAY).then_some(CqlTime(nanos))
}

/// The forms cqlsh and Cassandra's JSON take: with or without `T`, seconds
/// and fractions, a `Z` or an offset (`+0900`, `+09:00`); no offset is UTC;
/// a bare date is its midnight; a number is milliseconds since 1970.
fn timestamp_value(text: &str) -> Option<CqlTimestamp> {
    if let Ok(millis) = text.parse::<i64>() {
        return Some(CqlTimestamp(millis));
    }
    let text = text.replace('T', " ");
    let zoned = [
        "%Y-%m-%d %H:%M:%S%.f%z",
        "%Y-%m-%d %H:%M:%S%z",
        "%Y-%m-%d %H:%M%z",
    ];
    let normalized = match text.strip_suffix('Z') {
        Some(rest) => format!("{rest}+0000"),
        None => text.clone(),
    };
    for format in zoned {
        if let Ok(time) = DateTime::parse_from_str(&normalized, format) {
            return Some(CqlTimestamp(time.timestamp_millis()));
        }
    }
    for format in [
        "%Y-%m-%d %H:%M:%S%.f",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
    ] {
        if let Ok(time) = NaiveDateTime::parse_from_str(&text, format) {
            return Some(CqlTimestamp(time.and_utc().timestamp_millis()));
        }
    }
    NaiveDate::parse_from_str(&text, "%Y-%m-%d")
        .ok()
        .and_then(|day| day.and_hms_opt(0, 0, 0))
        .map(|time| CqlTimestamp(time.and_utc().timestamp_millis()))
}

/// `1y2mo3w4d5h6m7s8ms9us10ns` (µs too), with an optional leading `-`.
fn duration_value(text: &str) -> Option<CqlDuration> {
    let (negative, mut rest) = match text.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, text),
    };
    if rest.is_empty() {
        return None;
    }
    let (mut months, mut days, mut nanos) = (0i64, 0i64, 0i64);
    while !rest.is_empty() {
        let digits = rest.find(|ch: char| !ch.is_ascii_digit())?;
        if digits == 0 {
            return None;
        }
        let amount: i64 = rest[..digits].parse().ok()?;
        rest = &rest[digits..];
        let unit_len = rest
            .find(|ch: char| ch.is_ascii_digit())
            .unwrap_or(rest.len());
        let unit = rest[..unit_len].to_ascii_lowercase();
        rest = &rest[unit_len..];
        match unit.as_str() {
            "y" => months += amount * 12,
            "mo" => months += amount,
            "w" => days += amount * 7,
            "d" => days += amount,
            "h" => nanos += amount * 3_600_000_000_000,
            "m" => nanos += amount * 60_000_000_000,
            "s" => nanos += amount * 1_000_000_000,
            "ms" => nanos += amount * 1_000_000,
            "us" | "µs" => nanos += amount * 1_000,
            "ns" => nanos += amount,
            _ => return None,
        }
    }
    let sign = if negative { -1 } else { 1 };
    Some(CqlDuration {
        months: i32::try_from(months * sign).ok()?,
        days: i32::try_from(days * sign).ok()?,
        nanoseconds: nanos * sign,
    })
}

/// A column type as CQL writes it.
pub(crate) fn type_name(typ: &ColumnType<'_>) -> String {
    match typ {
        ColumnType::Native(native) => native_name(native).to_string(),
        ColumnType::Collection { frozen, typ } => {
            let inner = match typ {
                CollectionType::List(item) => format!("list<{}>", type_name(item)),
                CollectionType::Set(item) => format!("set<{}>", type_name(item)),
                CollectionType::Map(key, item) => {
                    format!("map<{}, {}>", type_name(key), type_name(item))
                }
                _ => "collection".into(),
            };
            if *frozen {
                format!("frozen<{inner}>")
            } else {
                inner
            }
        }
        ColumnType::Vector { typ, dimensions } => {
            format!("vector<{}, {dimensions}>", type_name(typ))
        }
        ColumnType::UserDefinedType { frozen, definition } => {
            if *frozen {
                format!("frozen<{}>", definition.name)
            } else {
                definition.name.to_string()
            }
        }
        ColumnType::Tuple(items) => format!(
            "tuple<{}>",
            items.iter().map(type_name).collect::<Vec<_>>().join(", ")
        ),
        _ => "unknown".into(),
    }
}

fn native_name(native: &NativeType) -> &'static str {
    match native {
        NativeType::Ascii => "ascii",
        NativeType::Boolean => "boolean",
        NativeType::Blob => "blob",
        NativeType::Counter => "counter",
        NativeType::Date => "date",
        NativeType::Decimal => "decimal",
        NativeType::Double => "double",
        NativeType::Duration => "duration",
        NativeType::Float => "float",
        NativeType::Int => "int",
        NativeType::BigInt => "bigint",
        NativeType::Text => "text",
        NativeType::Timestamp => "timestamp",
        NativeType::Inet => "inet",
        NativeType::SmallInt => "smallint",
        NativeType::TinyInt => "tinyint",
        NativeType::Time => "time",
        NativeType::Timeuuid => "timeuuid",
        NativeType::Uuid => "uuid",
        NativeType::Varint => "varint",
        _ => "unknown",
    }
}

/// What NOW means for a column of `typ`: the CQL function that writes the
/// current time in it, or None where it has none.
pub(crate) fn now_function(typ: &ColumnType<'_>) -> Option<&'static str> {
    match typ {
        ColumnType::Native(NativeType::Timestamp) => Some("toTimestamp(now())"),
        ColumnType::Native(NativeType::Date) => Some("toDate(now())"),
        ColumnType::Native(NativeType::Timeuuid) => Some("now()"),
        ColumnType::Native(NativeType::Time) => Some("currentTime()"),
        ColumnType::Native(NativeType::BigInt) => Some("toUnixTimestamp(now())"),
        _ => None,
    }
}

/// A counter's value: what an edit's new value is measured against.
pub(crate) fn counter_of(value: &CqlValue) -> Option<i64> {
    match value {
        CqlValue::Counter(Counter(number)) | CqlValue::BigInt(number) => Some(*number),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn varints_round_trip_through_text() {
        for text in [
            "0",
            "1",
            "-1",
            "127",
            "128",
            "-128",
            "-129",
            "255",
            "123456789012345678901234567890",
            "-98765432109876543210",
        ] {
            let bytes = varint_bytes(text).unwrap();
            assert_eq!(varint_text(&bytes), text, "{text}");
        }
    }

    #[test]
    fn decimals_keep_their_scale() {
        for text in ["12.50", "-0.001", "100", "0.5", "-12345678901234567890.123"] {
            let decimal = decimal_value(text).unwrap();
            assert_eq!(decimal_text(&decimal), text, "{text}");
        }
        assert_eq!(decimal_text(&decimal_value("1.5e3").unwrap()), "1500");
    }

    #[test]
    fn durations_read_and_write_cql_units() {
        let duration = duration_value("1y2mo3d4h5m6s7ms8us9ns").unwrap();
        assert_eq!(duration.months, 14);
        assert_eq!(duration.days, 3);
        assert_eq!(duration_text(&duration), "1y2mo3d4h5m6s7ms8us9ns");
        assert_eq!(duration_text(&duration_value("-90m").unwrap()), "-1h30m");
        assert!(duration_value("5x").is_none());
    }

    #[test]
    fn timestamps_take_the_usual_forms() {
        let utc = timestamp_value("2024-03-01 12:00:00.000Z").unwrap();
        assert_eq!(timestamp_text(utc), "2024-03-01 12:00:00.000Z");
        assert_eq!(timestamp_value("2024-03-01T21:00:00+09:00"), Some(utc));
        assert_eq!(timestamp_value("2024-03-01 12:00:00"), Some(utc));
        assert_eq!(timestamp_value(&utc.0.to_string()), Some(utc));
    }

    #[test]
    fn collections_read_json_against_their_type() {
        let typ = ColumnType::Collection {
            frozen: false,
            typ: CollectionType::Map(
                Box::new(ColumnType::Native(NativeType::Int)),
                Box::new(ColumnType::Collection {
                    frozen: true,
                    typ: CollectionType::List(Box::new(ColumnType::Native(NativeType::Text))),
                }),
            ),
        };
        let value = from_text(&typ, r#"{"1": ["a", "b"]}"#).unwrap();
        assert_eq!(literal(&value), "{1: ['a', 'b']}");
        assert_eq!(
            cell(Some(&value)),
            Value::String(r#"{"1":["a","b"]}"#.into())
        );
        assert!(from_text(&typ, r#"{"x": []}"#).is_err());
    }

    #[test]
    fn names_are_quoted_only_when_cql_needs_it() {
        assert_eq!(quote_name("orders"), "orders");
        assert_eq!(quote_name("Edge Cases"), "\"Edge Cases\"");
        assert_eq!(quote_name("select"), "\"select\"");
        assert_eq!(quote_name("Mixed"), "\"Mixed\"");
    }
}
