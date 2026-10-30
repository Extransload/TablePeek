//! Reading CQL text: where statements end, what a statement is, and the
//! cqlsh commands TablePeek answers itself (CONSISTENCY, SERIAL
//! CONSISTENCY, TRACING) along with its EXPLAIN, which traces a statement.

/// Where the quoted string, quoted name, `$$` body or comment starting at
/// `i` ends; None when none starts there.
fn skip_at(bytes: &[u8], i: usize) -> Option<usize> {
    let next = bytes.get(i + 1).copied();
    match bytes[i] {
        quote @ (b'\'' | b'"') => {
            let mut at = i + 1;
            while at < bytes.len() {
                if bytes[at] == quote {
                    if bytes.get(at + 1) == Some(&quote) {
                        at += 2;
                        continue;
                    }
                    return Some(at + 1);
                }
                at += 1;
            }
            Some(bytes.len())
        }
        b'$' if next == Some(b'$') => Some(
            bytes[i + 2..]
                .windows(2)
                .position(|pair| pair == b"$$")
                .map_or(bytes.len(), |offset| i + 2 + offset + 2),
        ),
        b'-' if next == Some(b'-') => Some(line_end(bytes, i)),
        b'/' if next == Some(b'/') => Some(line_end(bytes, i)),
        b'/' if next == Some(b'*') => Some(
            bytes[i + 2..]
                .windows(2)
                .position(|pair| pair == b"*/")
                .map_or(bytes.len(), |offset| i + 2 + offset + 2),
        ),
        _ => None,
    }
}

fn line_end(bytes: &[u8], i: usize) -> usize {
    bytes[i..]
        .iter()
        .position(|byte| *byte == b'\n')
        .map_or(bytes.len(), |offset| i + offset)
}

/// The words of `sql` outside strings and comments, upper-cased, each with
/// where it starts.
fn words(sql: &str) -> Vec<(usize, String)> {
    let bytes = sql.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        if let Some(end) = skip_at(bytes, i) {
            i = end;
            continue;
        }
        if bytes[i].is_ascii_alphabetic() || bytes[i] == b'_' {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                i += 1;
            }
            out.push((start, sql[start..i].to_ascii_uppercase()));
            continue;
        }
        i += 1;
    }
    out
}

/// The statements of `sql`, split at semicolons outside strings, names,
/// `$$` bodies, comments and BEGIN … APPLY BATCH; blank ones left out.
pub(crate) fn split(sql: &str) -> Vec<&str> {
    let bytes = sql.as_bytes();
    let mut out = Vec::new();
    let mut start = 0;
    let mut i = 0;
    let mut in_batch = false;
    // The last two words, to spot BEGIN … BATCH and APPLY BATCH.
    let mut previous: Option<String> = None;
    let mut first_word: Option<String> = None;
    while i < bytes.len() {
        if let Some(end) = skip_at(bytes, i) {
            i = end;
            continue;
        }
        let byte = bytes[i];
        if byte.is_ascii_alphabetic() || byte == b'_' {
            let word_start = i;
            while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == b'_') {
                i += 1;
            }
            let word = sql[word_start..i].to_ascii_uppercase();
            if first_word.is_none() {
                first_word = Some(word.clone());
            }
            if word == "BATCH" {
                if first_word.as_deref() == Some("BEGIN") && !in_batch {
                    in_batch = true;
                } else if previous.as_deref() == Some("APPLY") {
                    in_batch = false;
                }
            }
            previous = Some(word);
            continue;
        }
        if byte == b';' && !in_batch {
            push_statement(&mut out, &sql[start..i]);
            start = i + 1;
            first_word = None;
            previous = None;
        }
        i += 1;
    }
    push_statement(&mut out, &sql[start..]);
    out
}

fn push_statement<'a>(out: &mut Vec<&'a str>, text: &'a str) {
    let trimmed = text.trim();
    if !words(trimmed).is_empty() || trimmed.contains("$$") {
        out.push(trimmed);
    }
}

/// What a statement asks of TablePeek.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Command<'a> {
    /// `CONSISTENCY [level]`: show or set the level statements run at.
    Consistency(Option<String>),
    /// `SERIAL CONSISTENCY [level]`: the same for lightweight transactions.
    SerialConsistency(Option<String>),
    /// `TRACING [ON | OFF]`: whether statements are traced into the console.
    Tracing(Option<bool>),
    /// `EXPLAIN <statement>`: the statement run traced, its trace as rows.
    Explain(&'a str),
    /// `USE keyspace`.
    Use(String),
    /// `CREATE TABLE new AS SELECT * FROM old`, which CQL lacks: TablePeek
    /// makes the table with the old one's structure and copies its rows.
    /// Each name as (keyspace, table).
    CopyTable {
        target: (Option<String>, String),
        source: (Option<String>, String),
    },
    /// Anything else goes to the server as written.
    Cql,
}

pub(crate) fn command(statement: &str) -> Command<'_> {
    let words = words(statement);
    let word = |index: usize| words.get(index).map(|(_, word)| word.as_str());
    match (word(0), word(1)) {
        (Some("CONSISTENCY"), level) if words.len() <= 2 => {
            Command::Consistency(level.map(str::to_string))
        }
        (Some("SERIAL"), Some("CONSISTENCY")) if words.len() <= 3 => {
            Command::SerialConsistency(word(2).map(str::to_string))
        }
        (Some("TRACING"), switch) if words.len() <= 2 => Command::Tracing(match switch {
            Some("ON") => Some(true),
            Some("OFF") => Some(false),
            _ => None,
        }),
        (Some("EXPLAIN"), Some(_)) => {
            let (start, _) = words[1];
            Command::Explain(statement[start..].trim())
        }
        // The name may be quoted, which `words` skips: everything after USE.
        (Some("USE"), _) => {
            let rest = statement[words[0].0 + 3..]
                .trim()
                .trim_end_matches(';')
                .trim();
            if rest.is_empty() {
                Command::Cql
            } else {
                Command::Use(unquote(rest))
            }
        }
        (Some("CREATE"), Some("TABLE")) => copy_table(statement, words[1].0 + "TABLE".len())
            .map_or(Command::Cql, |(target, source)| Command::CopyTable {
                target,
                source,
            }),
        _ => Command::Cql,
    }
}

/// The names of `CREATE TABLE new AS SELECT * FROM old`, the CREATE TABLE
/// ending at `after_table`.
#[allow(clippy::type_complexity)]
fn copy_table(
    statement: &str,
    after_table: usize,
) -> Option<((Option<String>, String), (Option<String>, String))> {
    let (keyspace, table, rest) = qualified_name_rest(statement[after_table..].trim_start())?;
    let mut rest = rest.trim_start();
    for keyword in ["AS", "SELECT", "*", "FROM"] {
        let head = rest.get(..keyword.len())?;
        if !head.eq_ignore_ascii_case(keyword) {
            return None;
        }
        rest = rest[keyword.len()..].trim_start();
    }
    let (source_keyspace, source, rest) = qualified_name_rest(rest)?;
    rest.trim()
        .trim_end_matches(';')
        .trim()
        .is_empty()
        .then_some(((keyspace, table), (source_keyspace, source)))
}

/// A name as written (`"Shop"`, `shop`): its quotes undone, or folded to
/// lower case without them, as CQL reads it.
pub(crate) fn unquote(name: &str) -> String {
    match name
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
    {
        Some(inner) => inner.replace("\"\"", "\""),
        None => name.to_lowercase(),
    }
}

/// The first word of a statement, upper-cased.
pub(crate) fn first_word(statement: &str) -> Option<String> {
    words(statement).into_iter().next().map(|(_, word)| word)
}

/// Whether a statement changes schema: the cached table list goes stale.
pub(crate) fn changes_schema(statement: &str) -> bool {
    matches!(
        first_word(statement).as_deref(),
        Some("CREATE" | "ALTER" | "DROP" | "TRUNCATE" | "USE")
    )
}

/// What a single-table SELECT reads: the table (keyspace-qualified when it
/// is) and the columns it names, `None` for `*`. None for anything else (a
/// JSON or DISTINCT read, functions or aliases among the columns).
pub(crate) fn select_source(
    statement: &str,
) -> Option<(Option<String>, String, Option<Vec<String>>)> {
    let words = words(statement);
    if words.first().map(|(_, word)| word.as_str()) != Some("SELECT") {
        return None;
    }
    let from = words.iter().position(|(_, word)| word == "FROM")?;
    if words[1..from].iter().any(|(_, word)| {
        matches!(
            word.as_str(),
            "JSON" | "DISTINCT" | "AS" | "WRITETIME" | "TTL" | "CAST"
        )
    }) {
        return None;
    }
    let select_end = words[from].0;
    let select_start = words[0].0 + "SELECT".len();
    let list = statement[select_start..select_end].trim();
    let columns = if list == "*" {
        None
    } else {
        if list.contains('(') {
            return None;
        }
        Some(
            list.split(',')
                .map(|part| unquote(part.trim()))
                .collect::<Vec<_>>(),
        )
    };
    let after_from = &statement[words[from].0 + 4..];
    let name = qualified_name(after_from.trim_start())?;
    Some((name.0, name.1, columns))
}

/// `keyspace.table`, `"Key Space"."Table"` or `table` at the start of
/// `text`.
fn qualified_name(text: &str) -> Option<(Option<String>, String)> {
    qualified_name_rest(text).map(|(keyspace, table, _)| (keyspace, table))
}

/// `qualified_name`, with the text after the name.
fn qualified_name_rest(text: &str) -> Option<(Option<String>, String, &str)> {
    let (first, rest) = name_at(text)?;
    if let Some(after_dot) = rest.trim_start().strip_prefix('.') {
        let (second, rest) = name_at(after_dot.trim_start())?;
        return Some((Some(first), second, rest));
    }
    Some((None, first, rest))
}

/// A `SELECT COUNT(*)` of one table, as the data tab writes it.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct CountShape<'a> {
    pub(crate) keyspace: Option<String>,
    pub(crate) table: String,
    /// The table as the statement writes it, to write it again.
    pub(crate) name: &'a str,
    /// What follows WHERE, without ALLOW FILTERING.
    pub(crate) condition: Option<&'a str>,
    pub(crate) allow_filtering: bool,
}

/// What a `SELECT COUNT(*) FROM t [WHERE …] [ALLOW FILTERING]` counts;
/// None for any other statement, a LIMIT, GROUP BY or PER PARTITION LIMIT
/// among them (counting those in token ranges would change the answer).
pub(crate) fn count_shape(statement: &str) -> Option<CountShape<'_>> {
    let statement = statement.trim().trim_end_matches(';').trim_end();
    let words = words(statement);
    let word = |index: usize| words.get(index).map(|(_, word)| word.as_str());
    if word(0) != Some("SELECT") || word(1) != Some("COUNT") || word(2) != Some("FROM") {
        return None;
    }
    let selected: String = statement[words[1].0..words[2].0]
        .chars()
        .filter(|ch| !ch.is_whitespace())
        .collect();
    if !selected.eq_ignore_ascii_case("count(*)") && !selected.eq_ignore_ascii_case("count(1)") {
        return None;
    }
    let after_from = words[2].0 + "FROM".len();
    let text = &statement[after_from..];
    let name_start = after_from + (text.len() - text.trim_start().len());
    let (keyspace, table, rest) = qualified_name_rest(&statement[name_start..])?;
    let name_end = statement.len() - rest.len();
    let tail: Vec<&(usize, String)> = words.iter().filter(|(at, _)| *at >= name_end).collect();
    let allow_filtering = tail.len() >= 2
        && tail[tail.len() - 2].1 == "ALLOW"
        && tail[tail.len() - 1].1 == "FILTERING";
    let (body, end) = if allow_filtering {
        (&tail[..tail.len() - 2], tail[tail.len() - 2].0)
    } else {
        (&tail[..], statement.len())
    };
    let condition = match body.first() {
        None if statement[name_end..end].trim().is_empty() => None,
        Some((at, word)) if word == "WHERE" && statement[name_end..*at].trim().is_empty() => {
            if body
                .iter()
                .any(|(_, word)| matches!(word.as_str(), "LIMIT" | "GROUP" | "PER" | "ORDER"))
            {
                return None;
            }
            Some(statement[at + "WHERE".len()..end].trim())
        }
        _ => return None,
    };
    Some(CountShape {
        keyspace,
        table,
        name: statement[name_start..name_end].trim_end(),
        condition,
        allow_filtering,
    })
}

/// Whether `condition` restricts a token or one of `columns` (as CQL
/// reads names: quoted as written, bare folded to lower case).
pub(crate) fn restricts(condition: &str, columns: &[&str]) -> bool {
    let words = words(condition);
    if words.iter().any(|(_, word)| word == "TOKEN") {
        return true;
    }
    columns.iter().any(|name| {
        let quoted = format!("\"{}\"", name.replace('"', "\"\""));
        condition.contains(&quoted)
            || (*name == name.to_lowercase()
                && words
                    .iter()
                    .any(|(_, word)| word.eq_ignore_ascii_case(name)))
    })
}

fn name_at(text: &str) -> Option<(String, &str)> {
    if text.starts_with('"') {
        let bytes = text.as_bytes();
        let end = skip_at(bytes, 0)?;
        return Some((unquote(&text[..end]), &text[end..]));
    }
    let end = text
        .find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_'))
        .unwrap_or(text.len());
    (end > 0).then(|| (text[..end].to_lowercase(), &text[end..]))
}

/// A syntax error's place, as Cassandra and ScyllaDB write it ("line 1:7
/// no viable alternative …"): its line, and its column counted from 1.
pub(crate) fn error_position(message: &str) -> Option<(u32, u32)> {
    let at = message.find("line ")?;
    let rest = &message[at + 5..];
    let (line, rest) = rest.split_once(':')?;
    let column: String = rest.chars().take_while(char::is_ascii_digit).collect();
    Some((line.trim().parse().ok()?, column.parse::<u32>().ok()? + 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_outside_strings_bodies_and_batches() {
        let sql = "SELECT 'a;b' FROM t; -- c;\nBEGIN UNLOGGED BATCH INSERT INTO t (a) VALUES (1); \
                   INSERT INTO t (a) VALUES (2); APPLY BATCH; CREATE FUNCTION f(a int) RETURNS NULL ON NULL INPUT \
                   RETURNS int LANGUAGE java AS $$ return a; $$;  ;";
        let parts = split(sql);
        assert_eq!(parts.len(), 3, "{parts:?}");
        assert_eq!(parts[0], "SELECT 'a;b' FROM t");
        assert!(
            parts[1].starts_with("-- c;\nBEGIN UNLOGGED BATCH")
                && parts[1].ends_with("APPLY BATCH")
        );
        assert!(parts[2].ends_with("$$ return a; $$"));
    }

    #[test]
    fn reads_the_commands_tablepeek_answers() {
        assert_eq!(command("CONSISTENCY"), Command::Consistency(None));
        assert_eq!(
            command("consistency local_quorum"),
            Command::Consistency(Some("LOCAL_QUORUM".into()))
        );
        assert_eq!(
            command("SERIAL CONSISTENCY LOCAL_SERIAL"),
            Command::SerialConsistency(Some("LOCAL_SERIAL".into()))
        );
        assert_eq!(command("TRACING ON"), Command::Tracing(Some(true)));
        assert_eq!(
            command("EXPLAIN SELECT * FROM t"),
            Command::Explain("SELECT * FROM t")
        );
        assert_eq!(command("USE \"Shop\""), Command::Use("Shop".into()));
        assert_eq!(command("USE Shop"), Command::Use("shop".into()));
        assert_eq!(command("SELECT consistency FROM t"), Command::Cql);
    }

    #[test]
    fn finds_the_table_a_select_reads() {
        assert_eq!(
            select_source("SELECT * FROM shop.orders WHERE id = 1"),
            Some((Some("shop".into()), "orders".into(), None))
        );
        assert_eq!(
            select_source("SELECT id, \"Mixed\" FROM \"Edge Cases\" LIMIT 5"),
            Some((
                None,
                "Edge Cases".into(),
                Some(vec!["id".into(), "Mixed".into()])
            ))
        );
        assert_eq!(select_source("SELECT count(*) FROM t"), None);
        assert_eq!(select_source("SELECT JSON * FROM t"), None);
    }

    #[test]
    fn reads_the_counts_the_data_tab_writes() {
        assert_eq!(
            count_shape("SELECT COUNT(*) FROM \"shop\".\"orders\""),
            Some(CountShape {
                keyspace: Some("shop".into()),
                table: "orders".into(),
                name: "\"shop\".\"orders\"",
                condition: None,
                allow_filtering: false,
            })
        );
        let filtered =
            count_shape("SELECT COUNT(*) FROM items WHERE \"note\" = 'a where b' ALLOW FILTERING;")
                .unwrap();
        assert_eq!(filtered.condition, Some("\"note\" = 'a where b'"));
        assert!(filtered.allow_filtering);
        assert_eq!(filtered.name, "items");
        assert_eq!(count_shape("SELECT COUNT(*) FROM t LIMIT 5"), None);
        assert_eq!(
            count_shape("SELECT COUNT(*) FROM t WHERE a = 1 PER PARTITION LIMIT 1"),
            None
        );
        assert_eq!(count_shape("SELECT a FROM t"), None);
        assert!(restricts("\"pk\" = 1", &["pk"]));
        assert!(restricts("pk IN (1, 2)", &["pk"]));
        assert!(restricts("token(pk) > 0", &["other"]));
        assert!(!restricts("\"note\" = 'pk'", &["pk"]));
        assert!(!restricts("\"Pk\" = 1", &["pk"]));
    }

    #[test]
    fn reads_syntax_error_positions() {
        assert_eq!(
            error_position("line 1:7 no viable alternative at input 'FORM'"),
            Some((1, 8))
        );
        assert_eq!(error_position("Undefined column name x"), None);
    }
}
