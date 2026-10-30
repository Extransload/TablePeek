//! Oracle values both ways: a fetched column as the grid's JSON cell (the
//! text forms the page reads and writes back), and a cell's text as the SQL
//! that writes it into a column of a given type.

use oracledb::{
    JsonValue, Metadata, OracleIntervalDS, OracleIntervalYM, OracleNumber, OracleTimestamp, Row,
    Vector, VectorData,
};
use serde_json::Value;
use tablepeek_types::ValueExpr;

use crate::{double_json, hex_bytes, hex_cell, not_hex, real_json, EngineError};

/// How a result column's values are read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Kind {
    /// NUMBER: a declared fraction (NUMBER(10,2)) always as its exact
    /// decimal text, so the column keeps one type; otherwise whole numbers
    /// as numbers and anything else as text.
    Number {
        decimal: bool,
    },
    Float,
    Double,
    Text,
    Bytes,
    Date,
    /// TIMESTAMP with its fractional digits; `zone`: WITH TIME ZONE, read
    /// as UTC.
    Timestamp {
        scale: u8,
        zone: bool,
    },
    IntervalDs {
        scale: u8,
    },
    IntervalYm,
    Bool,
    Json,
    Vector,
    /// CURSOR, objects and the like: named, not shown.
    Other,
}

impl Kind {
    pub(super) fn of(column: &Metadata) -> Kind {
        let db_type = column.db_type();
        if db_type == oracledb::DB_TYPE_NUMBER || db_type == oracledb::DB_TYPE_BINARY_INTEGER {
            // NUMBER(p,s) with s > 0 holds fractions; NUMBER(p) and
            // unconstrained NUMBER (COUNT(*) and the like) mostly whole ones.
            Kind::Number {
                decimal: column.precision() > 0 && column.scale() > 0,
            }
        } else if db_type == oracledb::DB_TYPE_BINARY_FLOAT {
            Kind::Float
        } else if db_type == oracledb::DB_TYPE_BINARY_DOUBLE {
            Kind::Double
        } else if db_type == oracledb::DB_TYPE_RAW
            || db_type == oracledb::DB_TYPE_LONG_RAW
            || db_type == oracledb::DB_TYPE_BLOB
        {
            Kind::Bytes
        } else if db_type == oracledb::DB_TYPE_DATE {
            Kind::Date
        } else if db_type == oracledb::DB_TYPE_TIMESTAMP
            || db_type == oracledb::DB_TYPE_TIMESTAMP_LTZ
        {
            Kind::Timestamp {
                scale: column.scale().clamp(0, 9) as u8,
                zone: false,
            }
        } else if db_type == oracledb::DB_TYPE_TIMESTAMP_TZ {
            Kind::Timestamp {
                scale: column.scale().clamp(0, 9) as u8,
                zone: true,
            }
        } else if db_type == oracledb::DB_TYPE_INTERVAL_DS {
            Kind::IntervalDs {
                scale: column.scale().clamp(0, 9) as u8,
            }
        } else if db_type == oracledb::DB_TYPE_INTERVAL_YM {
            Kind::IntervalYm
        } else if db_type == oracledb::DB_TYPE_BOOLEAN {
            Kind::Bool
        } else if db_type == oracledb::DB_TYPE_JSON {
            Kind::Json
        } else if db_type == oracledb::DB_TYPE_VECTOR {
            Kind::Vector
        } else if db_type == oracledb::DB_TYPE_CURSOR || db_type == oracledb::DB_TYPE_OBJECT {
            Kind::Other
        } else {
            // VARCHAR2, CHAR, their N forms, LONG, CLOB, NCLOB, ROWID.
            Kind::Text
        }
    }
}

/// One cell of a fetched row as the grid shows it.
pub(super) fn cell(row: &mut Row, index: usize, kind: Kind) -> Result<Value, oracledb::Error> {
    Ok(match kind {
        Kind::Number { decimal } => match row.get::<Option<OracleNumber>>(index)? {
            None => Value::Null,
            Some(number) if decimal => Value::from(number.to_string()),
            Some(number) => number_json(number.to_string()),
        },
        Kind::Float => row
            .get::<Option<f32>>(index)?
            .map_or(Value::Null, real_json),
        Kind::Double => row
            .get::<Option<f64>>(index)?
            .map_or(Value::Null, double_json),
        Kind::Bytes => match row.get::<Option<Vec<u8>>>(index) {
            Ok(bytes) => bytes.map_or(Value::Null, |bytes| hex_cell(&bytes, false)),
            Err(_) => lob_cell(row, index)?.unwrap_or(Value::Null),
        },
        Kind::Date => row
            .get::<Option<OracleTimestamp>>(index)?
            .map_or(Value::Null, |value| {
                Value::from(timestamp_text(&value, 0, false))
            }),
        Kind::Timestamp { scale, zone } => row
            .get::<Option<OracleTimestamp>>(index)?
            .map_or(Value::Null, |value| {
                Value::from(timestamp_text(&value, scale, zone))
            }),
        Kind::IntervalDs { scale } => row
            .get::<Option<OracleIntervalDS>>(index)?
            .map_or(Value::Null, |value| {
                Value::from(interval_ds_text(&value, scale))
            }),
        Kind::IntervalYm => row
            .get::<Option<OracleIntervalYM>>(index)?
            .map_or(Value::Null, |value| Value::from(interval_ym_text(&value))),
        Kind::Bool => row
            .get::<Option<bool>>(index)?
            .map_or(Value::Null, Value::Bool),
        Kind::Json => row
            .get::<Option<JsonValue>>(index)?
            .map_or(Value::Null, |value| {
                Value::from(json_of(&value).to_string())
            }),
        Kind::Vector => row
            .get::<Option<Vector>>(index)?
            .map_or(Value::Null, |value| Value::from(vector_text(&value))),
        Kind::Text => match row.get::<Option<String>>(index) {
            Ok(text) => text.map_or(Value::Null, Value::from),
            Err(_) => lob_text(row, index)?.map_or(Value::Null, Value::from),
        },
        Kind::Other => Value::from("<object>"),
    })
}

/// A NUMBER's text as a JSON number when it is whole and fits i64, else as
/// the text itself (exact, where a float would round).
fn number_json(text: String) -> Value {
    match text.parse::<i64>() {
        Ok(number) => Value::from(number),
        Err(_) => Value::from(text),
    }
}

fn lob_text(row: &mut Row, index: usize) -> Result<Option<String>, oracledb::Error> {
    use std::io::Read;
    let Some(mut lob) = row.take::<Option<oracledb::Lob>>(index)? else {
        return Ok(None);
    };
    let mut out = String::new();
    lob.read_to_string(&mut out)
        .map_err(oracledb::Error::from)?;
    Ok(Some(out))
}

/// A BLOB as the grid shows it: its bytes, or only its size when it is too
/// big to show (crate::hex_cell), without reading it (the whole value is read
/// through cells.rs).
fn lob_cell(row: &mut Row, index: usize) -> Result<Option<Value>, oracledb::Error> {
    use std::io::Read;
    let Some(mut lob) = row.take::<Option<oracledb::Lob>>(index)? else {
        return Ok(None);
    };
    let size = lob.get_size()?;
    if size > crate::BLOB_HEX_MAX {
        return Ok(Some(Value::from(format!("<blob {size} bytes>"))));
    }
    let mut out = Vec::with_capacity(size);
    lob.read_to_end(&mut out).map_err(oracledb::Error::from)?;
    Ok(Some(hex_cell(&out, false)))
}

/// `YYYY-MM-DD HH24:MI:SS` with `scale` fractional digits, and ` +00:00`
/// for a value with a zone (the driver gives it in UTC): the session's
/// NLS formats, so the text goes back in as it came out.
pub(super) fn timestamp_text(value: &OracleTimestamp, scale: u8, zone: bool) -> String {
    let mut text = format!(
        "{:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        value.year(),
        value.month(),
        value.day(),
        value.hour(),
        value.minute(),
        value.second()
    );
    if scale > 0 {
        let digits = format!("{:09}", value.nanoseconds());
        text.push('.');
        text.push_str(&digits[..usize::from(scale.min(9))]);
    }
    if zone {
        text.push_str(" +00:00");
    }
    text
}

/// `+DD HH:MI:SS.FF` as TO_DSINTERVAL reads it.
pub(super) fn interval_ds_text(value: &OracleIntervalDS, scale: u8) -> String {
    let negative = value.days() < 0
        || value.hours() < 0
        || value.minutes() < 0
        || value.seconds() < 0
        || value.nanoseconds() < 0;
    let mut text = format!(
        "{}{:02} {:02}:{:02}:{:02}",
        if negative { '-' } else { '+' },
        value.days().unsigned_abs(),
        value.hours().unsigned_abs(),
        value.minutes().unsigned_abs(),
        value.seconds().unsigned_abs()
    );
    let scale = if scale == 0 { 6 } else { scale };
    let digits = format!("{:09}", value.nanoseconds().unsigned_abs());
    text.push('.');
    text.push_str(&digits[..usize::from(scale.min(9))]);
    text
}

/// `+YY-MM` as TO_YMINTERVAL reads it.
pub(super) fn interval_ym_text(value: &OracleIntervalYM) -> String {
    let negative = value.years() < 0 || value.months() < 0;
    format!(
        "{}{:02}-{:02}",
        if negative { '-' } else { '+' },
        value.years().unsigned_abs(),
        value.months().unsigned_abs()
    )
}

/// A JSON column's value as JSON (Oracle's own scalars as text).
fn json_of(value: &JsonValue) -> Value {
    match value {
        JsonValue::Null => Value::Null,
        JsonValue::Boolean(flag) => Value::Bool(*flag),
        JsonValue::String(text) => Value::from(text.clone()),
        JsonValue::Number(number) => {
            let text = number.to_string();
            serde_json::from_str::<serde_json::Number>(&text)
                .map_or_else(|_| Value::from(text), Value::Number)
        }
        JsonValue::BinaryDouble(value) => double_json(*value),
        JsonValue::BinaryFloat(value) => real_json(*value),
        JsonValue::IntervalDS(value) => Value::from(interval_ds_text(value, 6)),
        JsonValue::IntervalYM(value) => Value::from(interval_ym_text(value)),
        JsonValue::Timestamp(value) => Value::from(timestamp_text(value, 6, value.is_utc())),
        JsonValue::Raw(bytes) | JsonValue::JsonId(bytes) => {
            Value::from(crate::hex_text(bytes, false))
        }
        JsonValue::Vector(vector) => Value::from(vector_text(vector)),
        JsonValue::JsonArray(items) => Value::Array(items.iter().map(json_of).collect()),
        JsonValue::JsonObject(map) => Value::Object(
            map.iter()
                .map(|(key, value)| (key.clone(), json_of(value)))
                .collect(),
        ),
    }
}

/// A VECTOR as Oracle writes one: `[1,2,3]`; a sparse one as
/// `[dimensions,[indices],[values]]`.
fn vector_text(vector: &Vector) -> String {
    fn values(data: &VectorData) -> String {
        let parts: Vec<String> = match data {
            VectorData::Float32(values) => values.iter().map(ToString::to_string).collect(),
            VectorData::Float64(values) => values.iter().map(ToString::to_string).collect(),
            VectorData::Int8(values) => values.iter().map(ToString::to_string).collect(),
            VectorData::Binary(values) => values.iter().map(ToString::to_string).collect(),
        };
        format!("[{}]", parts.join(","))
    }
    match vector {
        Vector::Dense(data) => values(data),
        Vector::Sparse(sparse) => {
            let indices: Vec<String> = sparse.indices().iter().map(ToString::to_string).collect();
            format!(
                "[{},[{}],{}]",
                sparse.num_dimensions(),
                indices.join(","),
                values(sparse.values())
            )
        }
    }
}

/// A column's type as the catalog spells it (ALL_TAB_COLUMNS.DATA_TYPE),
/// sorted by how a value is written into it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Target {
    Date,
    Timestamp,
    TimestampTz,
    IntervalDs,
    IntervalYm,
    Number,
    Float,
    Double,
    Binary,
    Blob,
    Clob,
    Bool,
    Text,
}

impl Target {
    pub(super) fn of(data_type: &str) -> Target {
        let upper = data_type.to_ascii_uppercase();
        match upper.as_str() {
            "DATE" => Target::Date,
            "NUMBER" | "FLOAT" | "INTEGER" | "DECIMAL" => Target::Number,
            "BINARY_FLOAT" => Target::Float,
            "BINARY_DOUBLE" => Target::Double,
            "RAW" | "LONG RAW" => Target::Binary,
            "BLOB" => Target::Blob,
            "CLOB" | "NCLOB" => Target::Clob,
            "BOOLEAN" => Target::Bool,
            _ if upper.starts_with("TIMESTAMP")
                && upper.ends_with("WITH TIME ZONE")
                && !upper.contains("LOCAL") =>
            {
                Target::TimestampTz
            }
            _ if upper.starts_with("TIMESTAMP") => Target::Timestamp,
            _ if upper.starts_with("INTERVAL DAY") => Target::IntervalDs,
            _ if upper.starts_with("INTERVAL YEAR") => Target::IntervalYm,
            _ => Target::Text,
        }
    }
}

/// A value bound into a statement.
pub(super) enum Bound {
    Text(Option<String>),
    Bytes(Option<Vec<u8>>),
}

impl Bound {
    pub(super) fn as_param(&self) -> &dyn oracledb::ToDbValue {
        match self {
            Bound::Text(text) => text,
            Bound::Bytes(bytes) => bytes,
        }
    }

    pub(super) fn log_param(&self) -> crate::sql_log::LogParam {
        use crate::sql_log::LogParam;
        match self {
            Bound::Text(Some(text)) => LogParam::Text(text.clone()),
            Bound::Bytes(Some(bytes)) => LogParam::Blob(bytes.clone()),
            Bound::Text(None) | Bound::Bytes(None) => LogParam::Null,
        }
    }
}

/// The values a written statement binds. `lobs` builds the temporary BLOBs
/// (`blob1`, …) a value too long for a RAW bind goes in as, from
/// `lob_values`; a statement with any runs as a PL/SQL block that builds
/// them first (see edit.rs), so their values bind before `values`.
#[derive(Default)]
pub(super) struct Binds {
    pub(super) values: Vec<Bound>,
    pub(super) lobs: Vec<String>,
    pub(super) lob_values: Vec<Bound>,
}

impl Binds {
    fn push(&mut self, bound: Bound) -> String {
        self.values.push(bound);
        format!(":{}", self.values.len())
    }
}

/// The most characters one text bind carries into a CLOB: longer text goes
/// in as several, joined (a plain VARCHAR2 bind stops at 4000 bytes).
const CLOB_PIECE: usize = 1000;

/// The bytes a RAW bind takes in SQL; a longer BLOB value is written into a
/// temporary BLOB in pieces of LOB_PIECE, as PL/SQL's RAW takes.
const RAW_MAX: usize = 2000;
const LOB_PIECE: usize = 32767;

/// The SQL that writes a cell's value (or expression) into a column of type
/// `target`, with the values it binds pushed onto `binds` (placeholders
/// `:N` counted from the values' length).
pub(super) fn write_sql(
    target: Target,
    value: Option<&str>,
    expr: Option<ValueExpr>,
    binds: &mut Binds,
) -> Result<String, EngineError> {
    match expr {
        Some(ValueExpr::Default) => return Ok("DEFAULT".into()),
        Some(ValueExpr::Now) => {
            return Ok(match target {
                Target::Timestamp | Target::TimestampTz => "SYSTIMESTAMP".into(),
                _ => "SYSDATE".into(),
            })
        }
        None => {}
    }
    let Some(text) = value else {
        return Ok(binds.push(match target {
            Target::Binary | Target::Blob => Bound::Bytes(None),
            _ => Bound::Text(None),
        }));
    };
    // A BLOB value too long for a RAW bind goes into a temporary BLOB.
    let long_blob = match target {
        Target::Blob => hex_bytes(text).filter(|bytes| bytes.len() > RAW_MAX),
        _ => None,
    };
    if let Some(bytes) = long_blob {
        let name = format!("blob{}", binds.lobs.len() + 1);
        let mut code = format!("DBMS_LOB.CREATETEMPORARY({name}, TRUE);");
        for (at, piece) in bytes.chunks(LOB_PIECE).enumerate() {
            let placeholder = format!(":{name}_{}", at + 1);
            binds.lob_values.push(Bound::Bytes(Some(piece.to_vec())));
            code.push_str(&format!(
                " DBMS_LOB.WRITEAPPEND({name}, UTL_RAW.LENGTH({placeholder}), {placeholder});"
            ));
        }
        binds.lobs.push(code);
        return Ok(name);
    }
    let mut bind = |bound: Bound| binds.push(bound);
    Ok(match target {
        Target::Binary | Target::Blob => {
            bind(Bound::Bytes(Some(hex_bytes(text).ok_or_else(not_hex)?)))
        }
        Target::Date => format!(
            "TO_DATE({}, 'YYYY-MM-DD HH24:MI:SS')",
            bind(Bound::Text(Some(date_time_text(text, false, false))))
        ),
        Target::Timestamp => format!(
            "TO_TIMESTAMP({}, 'YYYY-MM-DD HH24:MI:SS.FF')",
            bind(Bound::Text(Some(date_time_text(text, true, false))))
        ),
        Target::TimestampTz => format!(
            "TO_TIMESTAMP_TZ({}, 'YYYY-MM-DD HH24:MI:SS.FF TZH:TZM')",
            bind(Bound::Text(Some(date_time_text(text, true, true))))
        ),
        Target::IntervalDs => format!(
            "TO_DSINTERVAL({})",
            bind(Bound::Text(Some(text.trim().into())))
        ),
        Target::IntervalYm => format!(
            "TO_YMINTERVAL({})",
            bind(Bound::Text(Some(text.trim().into())))
        ),
        Target::Number => format!("TO_NUMBER({})", bind(Bound::Text(Some(text.trim().into())))),
        Target::Float => format!(
            "TO_BINARY_FLOAT({})",
            bind(Bound::Text(Some(text.trim().into())))
        ),
        Target::Double => format!(
            "TO_BINARY_DOUBLE({})",
            bind(Bound::Text(Some(text.trim().into())))
        ),
        Target::Bool => {
            let flag = match text.trim().to_ascii_lowercase().as_str() {
                "true" | "1" | "yes" | "y" | "on" => "TRUE",
                "false" | "0" | "no" | "n" | "off" => "FALSE",
                _ => {
                    return Err(EngineError::BadRequest(
                        "BOOLEAN 값은 true 또는 false로 입력하세요".into(),
                    ))
                }
            };
            flag.into()
        }
        Target::Clob if text.chars().count() > CLOB_PIECE => {
            let chars: Vec<char> = text.chars().collect();
            chars
                .chunks(CLOB_PIECE)
                .map(|piece| {
                    format!(
                        "TO_CLOB({})",
                        bind(Bound::Text(Some(piece.iter().collect())))
                    )
                })
                .collect::<Vec<_>>()
                .join(" || ")
        }
        Target::Clob | Target::Text => bind(Bound::Text(Some(text.to_string()))),
    })
}

/// A date and time as typed, in the form the TO_DATE/TO_TIMESTAMP formats
/// above read: ISO's `T` and `Z` accepted, missing seconds and fraction
/// filled in, and a zone (`+00:00` unless one is given) when `zone`. Text it
/// can't read goes as it is, for Oracle to say what's wrong.
fn date_time_text(text: &str, fraction: bool, zone: bool) -> String {
    let trimmed = text.trim();
    let (body, offset) = split_zone(trimmed);
    let body = body.replacen('T', " ", 1);
    let (date, time) = match body.split_once(' ') {
        Some((date, time)) => (date.to_string(), time.trim().to_string()),
        None => (body.clone(), String::new()),
    };
    if date.split('-').count() != 3 {
        return trimmed.to_string();
    }
    let (clock, frac) = match time.split_once('.') {
        Some((clock, frac)) => (clock.to_string(), frac.to_string()),
        None => (time.clone(), String::new()),
    };
    let mut parts: Vec<&str> = if clock.is_empty() {
        Vec::new()
    } else {
        clock.split(':').collect()
    };
    if parts.len() > 3
        || !parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_digit()))
    {
        return trimmed.to_string();
    }
    while parts.len() < 3 {
        parts.push("00");
    }
    let mut out = format!("{date} {}", parts.join(":"));
    if fraction {
        out.push('.');
        out.push_str(if frac.is_empty() { "0" } else { &frac });
    }
    if zone {
        out.push(' ');
        out.push_str(offset.as_deref().unwrap_or("+00:00"));
    }
    out
}

/// A trailing zone: `Z`, ` +09:00`, `+0900`, `-05`; the text before it and
/// the zone as TZH:TZM.
fn split_zone(text: &str) -> (&str, Option<String>) {
    if let Some(body) = text.strip_suffix('Z').or_else(|| text.strip_suffix('z')) {
        return (body.trim_end(), Some("+00:00".into()));
    }
    let bytes = text.as_bytes();
    for start in (0..bytes.len()).rev() {
        if matches!(bytes[start], b'+' | b'-') && start > 10 {
            let zone = &text[start..];
            let digits: String = zone[1..].chars().filter(char::is_ascii_digit).collect();
            if digits.len() == 2 || digits.len() == 4 {
                let formatted = format!(
                    "{}{}:{}",
                    &zone[..1],
                    &digits[..2],
                    if digits.len() == 4 {
                        &digits[2..]
                    } else {
                        "00"
                    }
                );
                return (text[..start].trim_end(), Some(formatted));
            }
            break;
        }
    }
    (text, None)
}
