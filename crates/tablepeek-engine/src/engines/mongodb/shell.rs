//! Operations as the MongoDB shell writes them, for the console and History:
//! `db.getSiblingDB("shop").orders.find({ status: "paid" })`.

use mongodb::bson::spec::BinarySubtype;
use mongodb::bson::{Bson, Document};

/// A value in shell notation: `ObjectId("…")`, `ISODate("…")`,
/// `NumberLong("…")`, `{ key: value }`, ….
pub(super) fn value(value: &Bson) -> String {
    let mut out = String::new();
    write_value(&mut out, value);
    out
}

pub(super) fn document(doc: &Document) -> String {
    let mut out = String::new();
    write_document(&mut out, doc);
    out
}

/// `db.getSiblingDB("db").coll`, or `.getCollection("…")` for a name the
/// shell can't read as a property.
pub(super) fn collection(db: &str, coll: &str) -> String {
    if is_identifier(coll) && !coll.starts_with("get") {
        format!("db.getSiblingDB({}).{coll}", quote(db))
    } else {
        format!(
            "db.getSiblingDB({}).getCollection({})",
            quote(db),
            quote(coll)
        )
    }
}

pub(super) fn database(db: &str) -> String {
    format!("db.getSiblingDB({})", quote(db))
}

pub(super) fn quote(text: &str) -> String {
    serde_json::to_string(text).unwrap_or_else(|_| format!("\"{text}\""))
}

fn is_identifier(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_' || first == '$')
        && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '$')
}

fn write_document(out: &mut String, doc: &Document) {
    if doc.is_empty() {
        out.push_str("{}");
        return;
    }
    out.push_str("{ ");
    for (index, (key, value)) in doc.iter().enumerate() {
        if index > 0 {
            out.push_str(", ");
        }
        if is_identifier(key) {
            out.push_str(key);
        } else {
            out.push_str(&quote(key));
        }
        out.push_str(": ");
        write_value(out, value);
    }
    out.push_str(" }");
}

fn write_value(out: &mut String, value: &Bson) {
    match value {
        Bson::Document(doc) => write_document(out, doc),
        Bson::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push_str(", ");
                }
                write_value(out, item);
            }
            out.push(']');
        }
        Bson::String(text) => out.push_str(&quote(text)),
        Bson::ObjectId(id) => out.push_str(&format!("ObjectId(\"{id}\")")),
        Bson::DateTime(at) => match at.try_to_rfc3339_string() {
            Ok(text) => out.push_str(&format!("ISODate(\"{text}\")")),
            Err(_) => out.push_str(&format!("new Date({})", at.timestamp_millis())),
        },
        Bson::Int32(n) => out.push_str(&n.to_string()),
        Bson::Int64(n) => out.push_str(&format!("NumberLong(\"{n}\")")),
        Bson::Double(n) => out.push_str(&double(*n)),
        Bson::Decimal128(n) => out.push_str(&format!("NumberDecimal(\"{n}\")")),
        Bson::Boolean(flag) => out.push_str(if *flag { "true" } else { "false" }),
        Bson::Null => out.push_str("null"),
        Bson::Undefined => out.push_str("undefined"),
        Bson::RegularExpression(regex) => {
            out.push_str(&regex_literal(&regex.pattern, &regex.options))
        }
        Bson::Binary(binary)
            if binary.subtype == BinarySubtype::Uuid && binary.bytes.len() == 16 =>
        {
            let mut bytes = [0u8; 16];
            bytes.copy_from_slice(&binary.bytes);
            out.push_str(&format!(
                "UUID(\"{}\")",
                mongodb::bson::Uuid::from_bytes(bytes)
            ));
        }
        other => out.push_str(&other.clone().into_relaxed_extjson().to_string()),
    }
}

/// A double the shell reads back as a double: a whole number keeps a `.0`
/// (`1` would come back an Int32), `-0` stays negative, and infinities and
/// NaN are the shell's own names.
fn double(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    let text = n.to_string();
    if text.contains(['.', 'e', 'E']) {
        text
    } else {
        format!("{text}.0")
    }
}

/// A regex as `/pattern/flags`, a slash in the pattern written `\/`. Where
/// that literal can't carry the pattern unchanged (it is empty or opens like
/// a comment, holds a line break, or already has a `\/` the shell would read
/// as a plain slash), `RegExp("pattern", "flags")` instead.
fn regex_literal(pattern: &str, flags: &str) -> String {
    let literal_safe = !pattern.is_empty()
        && !pattern.starts_with('*')
        && !pattern.contains(['\n', '\r'])
        && !pattern.contains("\\/");
    if literal_safe {
        format!("/{}/{flags}", pattern.replace('/', "\\/"))
    } else {
        format!("RegExp({}, {})", quote(pattern), quote(flags))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::bson::{doc, oid::ObjectId, Decimal128};

    #[test]
    fn writes_shell_notation() {
        let id = ObjectId::parse_str("64b7f0c2a1b2c3d4e5f60718").unwrap();
        let filter = doc! {
            "_id": id,
            "total": "12.50".parse::<Decimal128>().unwrap(),
            "n": 5_i64,
            "items.0.qty": 2,
            "tags": ["a"],
        };
        assert_eq!(
            document(&filter),
            "{ _id: ObjectId(\"64b7f0c2a1b2c3d4e5f60718\"), total: NumberDecimal(\"12.50\"), \
             n: NumberLong(\"5\"), \"items.0.qty\": 2, tags: [\"a\"] }"
        );
        assert_eq!(
            collection("shop", "orders"),
            "db.getSiblingDB(\"shop\").orders"
        );
        assert_eq!(
            collection("shop", "order-items"),
            "db.getSiblingDB(\"shop\").getCollection(\"order-items\")"
        );
    }

    #[test]
    fn doubles_stay_doubles() {
        for (n, shown) in [
            (1.0, "1.0"),
            (-3.0, "-3.0"),
            (0.0, "0.0"),
            (-0.0, "-0.0"),
            (2.5, "2.5"),
            (1e21, "1000000000000000000000.0"),
            (1.5e-7, "0.00000015"),
            (f64::INFINITY, "Infinity"),
            (f64::NEG_INFINITY, "-Infinity"),
            (f64::NAN, "NaN"),
        ] {
            assert_eq!(value(&Bson::Double(n)), shown, "{n}");
        }
        assert_eq!(value(&Bson::Int32(1)), "1");
    }

    #[test]
    fn regexes_keep_their_pattern() {
        let regex = |pattern: &str, options: &str| {
            value(&Bson::RegularExpression(mongodb::bson::Regex {
                pattern: pattern.into(),
                options: options.into(),
            }))
        };
        assert_eq!(regex("^ab", "i"), "/^ab/i");
        assert_eq!(regex("a/b[/]", ""), "/a\\/b[\\/]/");
        assert_eq!(regex("a\\.b", "m"), "/a\\.b/m");
        // What a literal can't carry goes through RegExp().
        assert_eq!(regex("a\\/b", ""), "RegExp(\"a\\\\/b\", \"\")");
        assert_eq!(regex("", "i"), "RegExp(\"\", \"i\")");
        assert_eq!(regex("*x", ""), "RegExp(\"*x\", \"\")");
        assert_eq!(regex("a\nb", "s"), "RegExp(\"a\\nb\", \"s\")");
    }
}
