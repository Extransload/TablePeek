//! Values as SQL literals, for the INSERTs a backup writes.
//!
//! A port of the page's `toSqlInserts` (web/src/export.ts) with each engine's
//! `stringLiteral`, `binaryLiteral`, `bareHexIsBinary`, `importLiteral` and
//! `singleRowValues`, so a backup made here reads back as one made there.
//! Values reaching a backup are only nulls, whole numbers, floats and text:
//! never booleans, DEFAULT or NOW expressions, so the page's branches for
//! those (omitted columns, `emptyInsert`, `booleanLiteral`) have no part here.

use std::fmt::Write as _;
use std::io::Write as _;

use tablepeek_engine::{batch_cell, sql_log::Dialect, Cell, QueryData};

/// Rows to one INSERT statement, as the page writes them.
const INSERT_CHUNK: usize = 1000;

/// Oracle takes a text literal of at most 4000 bytes; longer text (a CLOB's)
/// goes in as TO_CLOB pieces joined with ||, each at most this many UTF-16
/// code units (at most 3000 bytes in UTF-8).
const ORACLE_LITERAL_UNITS: usize = 1000;

/// One column of the INSERTs: its quoted name, whether it holds bytes (its
/// hex text written as a binary literal) and its declared type, for CQL's
/// literals that depend on it.
#[derive(Debug, Clone)]
pub struct InsertColumn {
    pub quoted: String,
    pub binary: bool,
    pub declared: Option<String>,
}

/// Appends INSERT statements for every row of `data` to `out`, each statement followed by "\n":
/// `INSERT INTO {target} ({quoted columns joined ", "}) VALUES\n  (v, v),\n  (v, v);` with up to
/// 1000 rows per statement, or one row where `single_row`. `columns` are in the result's column
/// order (same length as data.columns). Nothing for no rows or no columns.
pub fn write_inserts(
    out: &mut String,
    dialect: Dialect,
    target: &str,
    columns: &[InsertColumn],
    single_row: bool,
    data: &QueryData,
) {
    if columns.is_empty() {
        return;
    }
    let chunk_rows = if single_row { 1 } else { INSERT_CHUNK };
    // Rows written to the statement open, 0 when none is.
    let mut in_chunk = 0;
    for batch in &data.batches {
        for row in 0..batch.num_rows() {
            if in_chunk == 0 {
                out.push_str("INSERT INTO ");
                out.push_str(target);
                out.push_str(" (");
                for (c, column) in columns.iter().enumerate() {
                    if c > 0 {
                        out.push_str(", ");
                    }
                    out.push_str(&column.quoted);
                }
                out.push_str(") VALUES\n  (");
            } else {
                out.push_str(",\n  (");
            }
            for (c, column) in columns.iter().enumerate() {
                if c > 0 {
                    out.push_str(", ");
                }
                literal(out, dialect, column, batch_cell(batch, c, row));
            }
            out.push(')');
            in_chunk += 1;
            if in_chunk == chunk_rows {
                out.push_str(";\n");
                in_chunk = 0;
            }
        }
    }
    if in_chunk > 0 {
        out.push_str(";\n");
    }
}

/// One value as a literal (exposed for tests and reuse).
pub fn literal(out: &mut String, dialect: Dialect, column: &InsertColumn, cell: Cell<'_>) {
    if dialect == Dialect::Cql && cql_import_literal(out, column.declared.as_deref(), cell) {
        return;
    }
    if column.binary {
        if let Cell::Text(text) = cell {
            if let Some(hex) = binary_hex(text, bare_hex_is_binary(dialect)) {
                binary_literal(out, dialect, hex);
                return;
            }
        }
    }
    match cell {
        Cell::Null => out.push_str("NULL"),
        Cell::Int(value) => {
            let _ = write!(out, "{value}");
        }
        Cell::Float(value) if value.is_finite() => js_number(out, value),
        Cell::Float(value) => quote_literal(out, non_finite_text(value)),
        Cell::Text(text) => string_literal(out, dialect, text),
    }
}

/// Whether the engine reads bare hex in a binary column as bytes: not SQLite,
/// whose columns hold text too, nor ClickHouse, whose String holds bytes and
/// text alike.
fn bare_hex_is_binary(dialect: Dialect) -> bool {
    !matches!(dialect, Dialect::Sqlite | Dialect::ClickHouse)
}

/// The hex digits of a binary column's text as the engines take hex
/// (`\x00ff`, `0x00FF`, `X'00FF'`, or bare where `bare` allows), or None for
/// text that isn't whole bytes of hex.
fn binary_hex(text: &str, bare: bool) -> Option<&str> {
    let text = js_trim(text);
    let hex = if let Some(rest) = text
        .strip_prefix("\\x")
        .or_else(|| text.strip_prefix("0x"))
        .or_else(|| text.strip_prefix("0X"))
    {
        rest
    } else if let Some(rest) = text
        .strip_prefix("x'")
        .or_else(|| text.strip_prefix("X'"))
        .and_then(|rest| rest.strip_suffix('\''))
    {
        rest
    } else if bare {
        text
    } else {
        return None;
    };
    (hex.bytes().all(|b| b.is_ascii_hexdigit()) && hex.len() % 2 == 0).then_some(hex)
}

fn binary_literal(out: &mut String, dialect: Dialect, hex: &str) {
    let upper = |out: &mut String| out.extend(hex.chars().map(|c| c.to_ascii_uppercase()));
    let lower = |out: &mut String| out.extend(hex.chars().map(|c| c.to_ascii_lowercase()));
    match dialect {
        Dialect::Sqlite | Dialect::MySql => {
            out.push_str("X'");
            upper(out);
            out.push('\'');
        }
        Dialect::Postgres => {
            out.push_str("'\\x");
            lower(out);
            out.push('\'');
        }
        Dialect::Mssql => {
            out.push_str("0x");
            upper(out);
        }
        Dialect::Oracle => {
            out.push_str("HEXTORAW('");
            upper(out);
            out.push_str("')");
        }
        Dialect::ClickHouse => {
            out.push_str("unhex('");
            upper(out);
            out.push_str("')");
        }
        Dialect::Cql => {
            out.push_str("0x");
            lower(out);
        }
    }
}

fn string_literal(out: &mut String, dialect: Dialect, text: &str) {
    match dialect {
        Dialect::Sqlite | Dialect::Postgres | Dialect::Cql => quote_literal(out, text),
        // MySQL reads backslashes as escapes in a quoted string.
        Dialect::MySql => {
            out.push('\'');
            for c in text.chars() {
                match c {
                    '\\' => out.push_str("\\\\"),
                    '\'' => out.push_str("''"),
                    c => out.push(c),
                }
            }
            out.push('\'');
        }
        Dialect::Mssql => {
            out.push('N');
            quote_literal(out, text);
        }
        Dialect::ClickHouse => {
            out.push('\'');
            for c in text.chars() {
                match c {
                    '\\' => out.push_str("\\\\"),
                    '\'' => out.push_str("\\'"),
                    c => out.push(c),
                }
            }
            out.push('\'');
        }
        Dialect::Oracle => oracle_string_literal(out, text),
    }
}

/// Oracle text, as TO_CLOB pieces past ORACLE_LITERAL_UNITS UTF-16 units (as
/// JavaScript counts a string's length), a surrogate pair kept in one piece.
fn oracle_string_literal(out: &mut String, text: &str) {
    let units: usize = text.chars().map(char::len_utf16).sum();
    if units <= ORACLE_LITERAL_UNITS {
        quote_literal(out, text);
        return;
    }
    let mut rest = text;
    let mut first = true;
    while !rest.is_empty() {
        let mut taken = 0;
        let mut end = rest.len();
        for (at, c) in rest.char_indices() {
            if taken + c.len_utf16() > ORACLE_LITERAL_UNITS {
                end = at;
                break;
            }
            taken += c.len_utf16();
        }
        if !first {
            out.push_str(" || ");
        }
        first = false;
        out.push_str("TO_CLOB(");
        quote_literal(out, &rest[..end]);
        out.push(')');
        rest = &rest[end..];
    }
}

/// The page's `quoteLiteral`: text in single quotes, quotes doubled.
fn quote_literal(out: &mut String, text: &str) {
    out.push('\'');
    for c in text.chars() {
        if c == '\'' {
            out.push('\'');
        }
        out.push(c);
    }
    out.push('\'');
}

fn non_finite_text(value: f64) -> &'static str {
    if value.is_nan() {
        "NaN"
    } else if value > 0.0 {
        "Infinity"
    } else {
        "-Infinity"
    }
}

/// A finite float as JavaScript's `String(number)` writes it: the shortest
/// digits that read back the same, in exponent form from 1e21 and below 1e-6.
fn js_number(out: &mut String, value: f64) {
    if value == 0.0 {
        // -0 too.
        out.push('0');
        return;
    }
    // `{:e}` gives the shortest round-trip digits as `d[.ddd]e[-]n`.
    let mut buf = [0u8; 40];
    let len = {
        let mut cursor = std::io::Cursor::new(&mut buf[..]);
        let _ = write!(cursor, "{:e}", value.abs());
        cursor.position() as usize
    };
    let text = std::str::from_utf8(&buf[..len]).unwrap_or("0e0");
    let (mantissa, exponent) = text.split_once('e').unwrap_or((text, "0"));
    let exponent: i32 = exponent.parse().unwrap_or(0);
    let (lead, fraction) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits_len = 1 + fraction.len() as i32;
    let push_digits = |out: &mut String| {
        out.push_str(lead);
        out.push_str(fraction);
    };
    // As ECMAScript's Number::toString: k digits, the point after n of them.
    let n = exponent + 1;
    if value < 0.0 {
        out.push('-');
    }
    if digits_len <= n && n <= 21 {
        push_digits(out);
        out.extend(std::iter::repeat('0').take((n - digits_len) as usize));
    } else if 0 < n && n <= 21 {
        let all: String = [lead, fraction].concat();
        out.push_str(&all[..n as usize]);
        out.push('.');
        out.push_str(&all[n as usize..]);
    } else if -6 < n && n <= 0 {
        out.push_str("0.");
        out.extend(std::iter::repeat('0').take((-n) as usize));
        push_digits(out);
    } else {
        out.push_str(lead);
        if !fraction.is_empty() {
            out.push('.');
            out.push_str(fraction);
        }
        let _ = write!(
            out,
            "e{}{}",
            if n - 1 < 0 { '-' } else { '+' },
            (n - 1).abs()
        );
    }
}

/// JavaScript's `String.prototype.trim`: its whitespace and line terminators,
/// which take in U+FEFF but not U+0085.
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}'))
}

const CQL_NATIVE_TYPES: &[&str] = &[
    "ascii",
    "bigint",
    "blob",
    "boolean",
    "counter",
    "date",
    "decimal",
    "double",
    "duration",
    "float",
    "inet",
    "int",
    "smallint",
    "text",
    "time",
    "timestamp",
    "timeuuid",
    "tinyint",
    "uuid",
    "varchar",
    "varint",
];
const CQL_NUMERIC_TYPES: &[&str] = &[
    "tinyint", "smallint", "int", "bigint", "varint", "counter", "float", "double", "decimal",
];

/// CQL's literal for a value by its column's declared type (the page's
/// `importLiteral`), written to `out`; false when the value takes the usual
/// literal.
fn cql_import_literal(out: &mut String, declared: Option<&str>, cell: Cell<'_>) -> bool {
    let Some(declared) = declared else {
        return false;
    };
    if cell == Cell::Null {
        return false;
    }
    let declared_type = js_trim(declared).to_lowercase();
    let r#type = declared_type.as_str();
    let text = match cell {
        Cell::Text(text) => Some(js_trim(text)),
        _ => None,
    };
    if let Some(text) = text {
        // Uuids, blobs' 0x hex and durations go in bare, as do a number's
        // or a boolean's text: CQL won't take them quoted; NaN and Infinity
        // are its own float literals.
        let bare = ((r#type == "uuid" || r#type == "timeuuid") && is_uuid(text))
            || (r#type == "blob" && is_blob_hex(text))
            || (r#type == "duration" && is_duration(text))
            || (CQL_NUMERIC_TYPES.contains(&r#type) && is_cql_number(text));
        if bare {
            out.push_str(text);
            return true;
        }
        if r#type == "boolean"
            && (text.eq_ignore_ascii_case("true") || text.eq_ignore_ascii_case("false"))
        {
            out.push_str(&text.to_ascii_lowercase());
            return true;
        }
    }
    if cql_structured(r#type) {
        out.push_str("fromJson(");
        match cell {
            Cell::Text(value) => quote_literal(out, value),
            // JSON.stringify of a number: NaN and the infinities are null.
            Cell::Int(value) => {
                let _ = write!(out, "'{value}'");
            }
            Cell::Float(value) if value.is_finite() => {
                out.push('\'');
                js_number(out, value);
                out.push('\'');
            }
            Cell::Float(_) => out.push_str("'null'"),
            Cell::Null => {}
        }
        out.push(')');
        return true;
    }
    false
}

/// A CQL type that holds JSON-shaped values: collections, tuples, vectors,
/// frozen values and UDTs (`type` already trimmed and lower-cased).
fn cql_structured(r#type: &str) -> bool {
    ["frozen", "list", "set", "map", "tuple", "vector"]
        .iter()
        .any(|name| {
            r#type
                .strip_prefix(name)
                .is_some_and(|rest| rest.trim_start_matches(js_space).starts_with('<'))
        })
        || !CQL_NATIVE_TYPES.contains(&r#type)
}

/// JavaScript's `\s`.
fn js_space(c: char) -> bool {
    c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}')
}

fn is_uuid(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => *b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}

fn is_blob_hex(text: &str) -> bool {
    text.strip_prefix("0x")
        .or_else(|| text.strip_prefix("0X"))
        .is_some_and(|hex| hex.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// CQL's duration form, `-?(\d+unit)+`, units y mo w d h m s ms us µs ns in
/// any case (µ as JavaScript's /i folds it: µ, μ or Μ).
fn is_duration(text: &str) -> bool {
    let mut rest = text.strip_prefix('-').unwrap_or(text);
    if rest.is_empty() {
        return false;
    }
    while !rest.is_empty() {
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return false;
        }
        rest = &rest[digits..];
        let unit_end = rest
            .char_indices()
            .find(|(_, c)| c.is_ascii_digit())
            .map_or(rest.len(), |(at, _)| at);
        let unit = rest[..unit_end].to_lowercase();
        if !is_duration_units(&unit) {
            return false;
        }
        rest = &rest[unit_end..];
    }
    true
}

/// Whether `unit` (lower-cased, the letters between two numbers) is one
/// duration unit: a number comes before each, so units never run together.
fn is_duration_units(units: &str) -> bool {
    matches!(
        units,
        "y" | "mo" | "w" | "d" | "h" | "m" | "s" | "ms" | "us" | "µs" | "μs" | "ns"
    )
}

/// A number as CQL takes it bare:
/// `[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?`, NaN or -?Infinity, in any case.
fn is_cql_number(text: &str) -> bool {
    if text.eq_ignore_ascii_case("nan") {
        return true;
    }
    let unsigned = text.strip_prefix('-').unwrap_or(text);
    if unsigned.eq_ignore_ascii_case("infinity") {
        return true;
    }
    let b = text.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let digits = |i: &mut usize| {
        let start = *i;
        while *i < b.len() && b[*i].is_ascii_digit() {
            *i += 1;
        }
        *i - start
    };
    let whole = digits(&mut i);
    if whole > 0 {
        if i < b.len() && b[i] == b'.' {
            i += 1;
            digits(&mut i);
        }
    } else {
        if i >= b.len() || b[i] != b'.' {
            return false;
        }
        i += 1;
        if digits(&mut i) == 0 {
            return false;
        }
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        if digits(&mut i) == 0 {
            return false;
        }
    }
    i == b.len()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tablepeek_engine::Engine;

    fn column(binary: bool, declared: Option<&str>) -> InsertColumn {
        InsertColumn {
            quoted: "\"c\"".into(),
            binary,
            declared: declared.map(str::to_string),
        }
    }

    fn lit(dialect: Dialect, column: &InsertColumn, cell: Cell<'_>) -> String {
        let mut out = String::new();
        literal(&mut out, dialect, column, cell);
        out
    }

    fn text(dialect: Dialect, value: &str) -> String {
        lit(dialect, &column(false, None), Cell::Text(value))
    }

    fn bin(dialect: Dialect, value: &str) -> String {
        lit(dialect, &column(true, None), Cell::Text(value))
    }

    fn cql(declared: &str, cell: Cell<'_>) -> String {
        lit(Dialect::Cql, &column(false, Some(declared)), cell)
    }

    fn float(value: f64) -> String {
        lit(Dialect::Postgres, &column(false, None), Cell::Float(value))
    }

    #[test]
    fn strings_escape_per_dialect() {
        assert_eq!(text(Dialect::Sqlite, r"it's \n"), r"'it''s \n'");
        assert_eq!(text(Dialect::Postgres, "a''b"), "'a''''b'");
        assert_eq!(text(Dialect::MySql, r"it's \n"), r"'it''s \\n'");
        assert_eq!(text(Dialect::Mssql, "it's 한"), "N'it''s 한'");
        assert_eq!(text(Dialect::ClickHouse, r"it's \n"), r"'it\'s \\n'");
        assert_eq!(text(Dialect::Oracle, "it's"), "'it''s'");
        assert_eq!(text(Dialect::Cql, "it's"), "'it''s'");
        // Text keeps its spaces; only hex and CQL's bare forms are trimmed.
        assert_eq!(text(Dialect::Sqlite, " x "), "' x '");
    }

    #[test]
    fn plain_values() {
        let c = column(false, None);
        assert_eq!(lit(Dialect::Mssql, &c, Cell::Null), "NULL");
        assert_eq!(
            lit(Dialect::Mssql, &c, Cell::Int(i64::MIN)),
            "-9223372036854775808"
        );
        assert_eq!(lit(Dialect::Mssql, &c, Cell::Float(f64::NAN)), "'NaN'");
        assert_eq!(
            lit(Dialect::Mssql, &c, Cell::Float(f64::INFINITY)),
            "'Infinity'"
        );
        assert_eq!(
            lit(Dialect::Mssql, &c, Cell::Float(f64::NEG_INFINITY)),
            "'-Infinity'"
        );
        // A binary column's null or number is no hex.
        assert_eq!(
            lit(Dialect::Postgres, &column(true, None), Cell::Null),
            "NULL"
        );
        assert_eq!(
            lit(Dialect::Postgres, &column(true, None), Cell::Int(12)),
            "12"
        );
    }

    #[test]
    fn binary_forms_per_dialect() {
        assert_eq!(bin(Dialect::Postgres, " \\x00Ff "), "'\\x00ff'");
        assert_eq!(bin(Dialect::Postgres, "0XAB"), "'\\xab'");
        assert_eq!(bin(Dialect::MySql, "x'0aff'"), "X'0AFF'");
        assert_eq!(bin(Dialect::Mssql, "00ff"), "0x00FF");
        assert_eq!(bin(Dialect::Oracle, "0x00ff"), "HEXTORAW('00FF')");
        assert_eq!(bin(Dialect::ClickHouse, "\\x0a"), "unhex('0A')");
        assert_eq!(bin(Dialect::Sqlite, "X'0a'"), "X'0A'");
        assert_eq!(bin(Dialect::Cql, "0x0A"), "0x0a");
        // Empty hex is zero bytes.
        assert_eq!(bin(Dialect::Mssql, "0x"), "0x");
        assert_eq!(bin(Dialect::Mssql, ""), "0x");
    }

    #[test]
    fn binary_falls_back_to_text() {
        // Odd length or not hex: the text as it is.
        assert_eq!(bin(Dialect::Postgres, "\\x0"), "'\\x0'");
        assert_eq!(bin(Dialect::Mssql, "abc"), "N'abc'");
        assert_eq!(bin(Dialect::MySql, "0xzz"), "'0xzz'");
        assert_eq!(bin(Dialect::MySql, "X'0a"), "'X''0a'");
        assert_eq!(bin(Dialect::Postgres, "\\X00"), "'\\X00'");
        // SQLite and ClickHouse don't take bare hex as bytes.
        assert_eq!(bin(Dialect::Sqlite, "00ff"), "'00ff'");
        assert_eq!(bin(Dialect::ClickHouse, "00ff"), "'00ff'");
        assert_eq!(bin(Dialect::ClickHouse, "0x00ff"), "unhex('00FF')");
    }

    #[test]
    fn oracle_long_text_goes_in_clob_pieces() {
        let exact = "a".repeat(1000);
        assert_eq!(text(Dialect::Oracle, &exact), format!("'{exact}'"));
        let over = "a".repeat(1001);
        assert_eq!(
            text(Dialect::Oracle, &over),
            format!("TO_CLOB('{}') || TO_CLOB('a')", "a".repeat(1000))
        );
        // A surrogate pair straddling unit 1000 moves to the next piece.
        let straddle = format!("{}😀b", "a".repeat(999));
        assert_eq!(
            text(Dialect::Oracle, &straddle),
            format!("TO_CLOB('{}') || TO_CLOB('😀b')", "a".repeat(999))
        );
        // Ending exactly at unit 1000, it stays.
        let fits = format!("{}😀b", "a".repeat(998));
        assert_eq!(
            text(Dialect::Oracle, &fits),
            format!("TO_CLOB('{}😀') || TO_CLOB('b')", "a".repeat(998))
        );
        // 1000 units counted as UTF-16: 500 emoji fit in one literal.
        let emoji = "😀".repeat(500);
        assert_eq!(text(Dialect::Oracle, &emoji), format!("'{emoji}'"));
        // Quotes double inside the pieces.
        let quoted = format!("{}'", "a".repeat(1000));
        assert_eq!(
            text(Dialect::Oracle, &quoted),
            format!("TO_CLOB('{}') || TO_CLOB('''')", "a".repeat(1000))
        );
    }

    #[test]
    fn cql_literals_by_declared_type() {
        let uuid = "123e4567-E89b-12d3-a456-426614174000";
        assert_eq!(cql("uuid", Cell::Text(&format!(" {uuid} "))), uuid);
        assert_eq!(cql(" TimeUUID ", Cell::Text(uuid)), uuid);
        assert_eq!(cql("uuid", Cell::Text("not-a-uuid")), "'not-a-uuid'");
        assert_eq!(cql("blob", Cell::Text("0xAbC")), "0xAbC");
        assert_eq!(cql("blob", Cell::Text("abc")), "'abc'");
        assert_eq!(cql("duration", Cell::Text("1h30m")), "1h30m");
        assert_eq!(cql("duration", Cell::Text("-2MO5µs")), "-2MO5µs");
        assert_eq!(cql("duration", Cell::Text("1x")), "'1x'");
        assert_eq!(cql("duration", Cell::Text("h")), "'h'");
        for number in [
            "12",
            "-1.5e+3",
            ".5",
            "5.",
            "+7E2",
            "NaN",
            "nan",
            "Infinity",
            "-INFINITY",
        ] {
            assert_eq!(cql("double", Cell::Text(number)), number);
        }
        for not in ["+Infinity", "-NaN", "1e", ".", "1.2.3", "0x10"] {
            assert_eq!(cql("int", Cell::Text(not)), format!("'{not}'"));
        }
        assert_eq!(cql("bigint", Cell::Int(5)), "5");
        assert_eq!(cql("boolean", Cell::Text(" TRUE ")), "true");
        assert_eq!(cql("boolean", Cell::Text("yes")), "'yes'");
        assert_eq!(cql("list<int>", Cell::Text("[1, 2]")), "fromJson('[1, 2]')");
        assert_eq!(
            cql("frozen <address>", Cell::Text("{\"a\":\"it's\"}")),
            "fromJson('{\"a\":\"it''s\"}')"
        );
        assert_eq!(cql("my_udt", Cell::Int(3)), "fromJson('3')");
        assert_eq!(cql("my_udt", Cell::Float(f64::NAN)), "fromJson('null')");
        assert_eq!(cql("my_udt", Cell::Null), "NULL");
        assert_eq!(cql("text", Cell::Text("abc")), "'abc'");
        // Without a declared type, the usual literals (binary included).
        assert_eq!(
            lit(Dialect::Cql, &column(true, None), Cell::Text("00ff")),
            "0x00ff"
        );
    }

    #[test]
    fn floats_as_javascript_writes_them() {
        assert_eq!(float(100.0), "100");
        assert_eq!(float(-0.0), "0");
        assert_eq!(float(0.1 + 0.2), "0.30000000000000004");
        assert_eq!(float(-1.5), "-1.5");
        assert_eq!(float(1e21), "1e+21");
        assert_eq!(float(1.5e21), "1.5e+21");
        assert_eq!(float(1e20), "100000000000000000000");
        assert_eq!(float(123456789012345680000.0), "123456789012345680000");
        assert_eq!(float(1e-6), "0.000001");
        assert_eq!(float(1.5e-7), "1.5e-7");
        assert_eq!(float(-1e-7), "-1e-7");
        assert_eq!(float(f64::MAX), "1.7976931348623157e+308");
        assert_eq!(float(5e-324), "5e-324");
        assert_eq!(float(123.456), "123.456");
    }

    async fn rows(sql: &str) -> QueryData {
        let engine = Engine::open_demo(1).unwrap();
        engine.query(sql, usize::MAX).await.unwrap()
    }

    fn inserts(single_row: bool, data: &QueryData) -> String {
        let columns = vec![
            InsertColumn {
                quoted: "\"a\"".into(),
                binary: false,
                declared: None,
            },
            InsertColumn {
                quoted: "\"b\"".into(),
                binary: false,
                declared: None,
            },
        ];
        let mut out = String::new();
        write_inserts(
            &mut out,
            Dialect::Postgres,
            "\"t\"",
            &columns,
            single_row,
            data,
        );
        out
    }

    fn series(rows: usize) -> String {
        format!(
            "WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < {rows}) \
             SELECT n AS a, 'v' || n AS b FROM s"
        )
    }

    #[tokio::test]
    async fn statements_chunk_by_a_thousand_rows() {
        let two = rows("SELECT 1 AS a, 'x' AS b UNION ALL SELECT 2.5, NULL").await;
        assert_eq!(
            inserts(false, &two),
            "INSERT INTO \"t\" (\"a\", \"b\") VALUES\n  (1, 'x'),\n  (2.5, NULL);\n"
        );
        assert_eq!(
            inserts(true, &two),
            "INSERT INTO \"t\" (\"a\", \"b\") VALUES\n  (1, 'x');\n\
             INSERT INTO \"t\" (\"a\", \"b\") VALUES\n  (2.5, NULL);\n"
        );

        let thousand = inserts(false, &rows(&series(1000)).await);
        assert_eq!(thousand.matches("INSERT INTO").count(), 1);
        assert!(thousand.ends_with("  (1000, 'v1000');\n"));

        let more = inserts(false, &rows(&series(1001)).await);
        assert_eq!(more.matches("INSERT INTO").count(), 2);
        assert!(more.contains(
            "  (1000, 'v1000');\nINSERT INTO \"t\" (\"a\", \"b\") VALUES\n  (1001, 'v1001');\n"
        ));

        let none = rows("SELECT 1 AS a, 2 AS b WHERE 0").await;
        assert_eq!(inserts(false, &none), "");
        let mut out = String::new();
        write_inserts(&mut out, Dialect::Postgres, "\"t\"", &[], false, &two);
        assert_eq!(out, "");
    }
}
