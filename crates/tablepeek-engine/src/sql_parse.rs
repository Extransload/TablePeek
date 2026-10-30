use crate::sql_log::{lexemes, Dialect, Lexeme};

pub(crate) fn trim_ident(name: &str) -> String {
    name.trim_matches(|c| matches!(c, '`' | '"' | '\'' | '[' | ']'))
        .to_string()
}

pub(crate) fn parse_single_table(sql: &str) -> Option<(Option<String>, String)> {
    if first_word(sql) != "select" {
        return None;
    }
    if find_keyword(sql, "join", 0).is_some() || find_keyword(sql, "union", 0).is_some() {
        return None;
    }
    let from_pos = find_keyword(sql, "from", 0)?;
    let rest = sql[from_pos + 4..].trim_start();
    if rest.is_empty() || rest.starts_with('(') {
        return None;
    }
    let (mut parts, after) = dotted_name(rest)?;
    if after.trim_start().starts_with(',') {
        return None;
    }
    match parts.len() {
        1 => Some((None, parts.remove(0))),
        2 => {
            let table = parts.remove(1);
            Some((Some(parts.remove(0)), table))
        }
        _ => None,
    }
}

/// The name `text` starts with, schema-qualified or not, as its unquoted
/// parts, and the text after it. A part is bare, or quoted in [], `` or ""
/// with the closing quote doubled inside (`[Edge Cases]`, `[a]]b]`).
fn dotted_name(text: &str) -> Option<(Vec<String>, &str)> {
    let mut parts = Vec::new();
    let mut rest = text;
    loop {
        let (part, after) = name_part(rest)?;
        if part.is_empty() {
            return None;
        }
        parts.push(part);
        match after.strip_prefix('.') {
            Some(next) => rest = next,
            None => return Some((parts, after)),
        }
    }
}

fn name_part(text: &str) -> Option<(String, &str)> {
    let close = match text.chars().next()? {
        '[' => ']',
        quote @ ('`' | '"') => quote,
        _ => {
            let end = text
                .find(|c: char| c.is_whitespace() || matches!(c, '.' | ',' | '(' | ')' | ';'))
                .unwrap_or(text.len());
            return Some((text[..end].to_string(), &text[end..]));
        }
    };
    let mut name = String::new();
    let mut chars = text.char_indices().skip(1);
    while let Some((at, c)) = chars.next() {
        if c != close {
            name.push(c);
        } else if text[at + 1..].starts_with(close) {
            name.push(close);
            chars.next();
        } else {
            return Some((name, &text[at + 1..]));
        }
    }
    None
}

fn first_word(sql: &str) -> String {
    sql.trim_start()
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_')
        .collect::<String>()
        .to_lowercase()
}

fn find_keyword(sql: &str, keyword: &str, target_depth: usize) -> Option<usize> {
    let bytes = sql.as_bytes();
    let keyword = keyword.as_bytes();
    if keyword.is_empty() {
        return None;
    }
    let mut depth = 0usize;
    let mut quote: Option<u8> = None;
    let mut index = 0usize;
    while index < bytes.len() {
        let byte = bytes[index];
        match quote {
            Some(active) => {
                if byte == b'\\' && active != b'`' {
                    index += 2;
                    continue;
                }
                if byte == active {
                    quote = None;
                }
            }
            None => match byte {
                b'\'' | b'"' | b'`' | b'[' => quote = Some(if byte == b'[' { b']' } else { byte }),
                b'(' => {
                    depth += 1;
                }
                b')' => {
                    depth = depth.saturating_sub(1);
                }
                _ => {
                    if depth == target_depth
                        && byte.eq_ignore_ascii_case(&keyword[0])
                        && index + keyword.len() <= bytes.len()
                        && bytes[index..index + keyword.len()].eq_ignore_ascii_case(keyword)
                    {
                        let before_ok = index == 0
                            || bytes[index - 1].is_ascii_whitespace()
                            || bytes[index - 1] == b'(';
                        let after = index + keyword.len();
                        let after_ok = after == bytes.len()
                            || bytes[after].is_ascii_whitespace()
                            || bytes[after] == b'(';
                        if before_ok && after_ok {
                            return Some(index);
                        }
                    }
                }
            },
        }
        index += 1;
    }
    None
}

/// A statement that opens or ends a transaction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TxControl {
    Begin,
    Commit,
    Rollback,
    /// ROLLBACK TO SAVEPOINT: the transaction carries on, past its error.
    RollbackToSavepoint,
    /// A MySQL statement that commits the open transaction before it runs
    /// (DDL, GRANT, LOCK TABLES and the like).
    ImplicitCommit,
}

/// The transaction control statements in `sql`, in order (COMMIT AND CHAIN
/// is a commit and then a begin). For SQL Server, where control flow may come
/// first (IF @@TRANCOUNT > 0 ROLLBACK) and statements need no `;`, at most
/// one: the last COMMIT or ROLLBACK, else a BEGIN TRAN; its caller asks the
/// server how many transactions are open.
pub(crate) fn tx_controls(sql: &str, dialect: Dialect) -> Vec<TxControl> {
    if dialect == Dialect::Mssql {
        return mssql_tx_control(sql).into_iter().collect();
    }
    let mut controls = Vec::new();
    let mut head: Vec<String> = Vec::new();
    let mut lexemes = lexemes(sql, dialect).peekable();
    while let Some(lexeme) = lexemes.next() {
        if let Lexeme::Word(word) = lexeme {
            if head.len() < HEAD_WORDS {
                head.push(word.to_ascii_uppercase());
            }
        }
        let ends = matches!(lexeme, Lexeme::End) || lexemes.peek().is_none();
        if ends && !head.is_empty() {
            classify(&head, dialect, &mut controls);
            // PostgreSQL and Oracle run one statement per query, `;`s of a
            // BEGIN ATOMIC body or a PL/SQL block included; a MySQL
            // routine's body runs only when called.
            if matches!(dialect, Dialect::Postgres | Dialect::Oracle) || defines_routine(&head) {
                break;
            }
            head.clear();
        }
    }
    controls
}

/// Words of a statement's start worth reading: enough to get past
/// CREATE DEFINER = `user`@`host` to PROCEDURE.
const HEAD_WORDS: usize = 8;

/// CREATE or ALTER of a procedure, function, trigger or event.
fn defines_routine(head: &[String]) -> bool {
    matches!(head.first().map(String::as_str), Some("CREATE" | "ALTER"))
        && head.iter().any(|word| {
            matches!(
                word.as_str(),
                "PROCEDURE" | "FUNCTION" | "TRIGGER" | "EVENT"
            )
        })
}

fn classify(head: &[String], dialect: Dialect, controls: &mut Vec<TxControl>) {
    let control = control_of(head, dialect);
    controls.extend(control);
    let chain = head
        .windows(2)
        .any(|pair| pair[0] == "AND" && pair[1] == "CHAIN");
    if chain && matches!(control, Some(TxControl::Commit | TxControl::Rollback)) {
        controls.push(TxControl::Begin);
    }
}

fn control_of(head: &[String], dialect: Dialect) -> Option<TxControl> {
    let word = |index: usize| head.get(index).map(String::as_str);
    let to_savepoint = head.iter().any(|word| word == "TO");
    let control = match (dialect, word(0)?) {
        (Dialect::Postgres | Dialect::MySql, "BEGIN") => TxControl::Begin,
        (Dialect::Postgres | Dialect::MySql, "START") if word(1) == Some("TRANSACTION") => {
            TxControl::Begin
        }
        // Two-phase commit acts on a prepared transaction, not this one.
        (Dialect::Postgres, "COMMIT" | "END" | "ROLLBACK" | "ABORT")
            if word(1) == Some("PREPARED") =>
        {
            return None
        }
        (Dialect::Postgres, "COMMIT" | "END") | (Dialect::MySql, "COMMIT") => TxControl::Commit,
        (Dialect::Postgres | Dialect::MySql, "ROLLBACK") if to_savepoint => {
            TxControl::RollbackToSavepoint
        }
        (Dialect::Postgres, "ROLLBACK" | "ABORT") | (Dialect::MySql, "ROLLBACK") => {
            TxControl::Rollback
        }
        // PREPARE TRANSACTION hands the work to a later COMMIT PREPARED.
        (Dialect::Postgres, "PREPARE") if word(1) == Some("TRANSACTION") => TxControl::Rollback,
        (Dialect::MySql, "CREATE" | "DROP") if word(1) == Some("TEMPORARY") => return None,
        (
            Dialect::MySql,
            "CREATE" | "ALTER" | "DROP" | "RENAME" | "TRUNCATE" | "GRANT" | "REVOKE" | "LOCK"
            | "ANALYZE" | "OPTIMIZE" | "REPAIR" | "FLUSH" | "INSTALL" | "UNINSTALL",
        ) => TxControl::ImplicitCommit,
        (Dialect::Oracle, "COMMIT") => TxControl::Commit,
        (Dialect::Oracle, "ROLLBACK") if to_savepoint => TxControl::RollbackToSavepoint,
        (Dialect::Oracle, "ROLLBACK") => TxControl::Rollback,
        (Dialect::Oracle, "SET") if word(1) == Some("TRANSACTION") => TxControl::Begin,
        // Session and system settings commit nothing; every other DDL
        // commits the open transaction first.
        (Dialect::Oracle, "ALTER") if matches!(word(1), Some("SESSION" | "SYSTEM")) => return None,
        (
            Dialect::Oracle,
            "CREATE" | "ALTER" | "DROP" | "RENAME" | "TRUNCATE" | "GRANT" | "REVOKE" | "COMMENT"
            | "ANALYZE" | "AUDIT" | "NOAUDIT" | "PURGE" | "FLASHBACK" | "ASSOCIATE"
            | "DISASSOCIATE",
        ) => TxControl::ImplicitCommit,
        _ => return None,
    };
    Some(control)
}

fn mssql_tx_control(sql: &str) -> Option<TxControl> {
    let mut found = None;
    let mut previous = String::new();
    for lexeme in lexemes(sql, Dialect::Mssql) {
        let Lexeme::Word(word) = lexeme else {
            continue;
        };
        let word = word.to_ascii_uppercase();
        match word.as_str() {
            "COMMIT" => found = Some(TxControl::Commit),
            "ROLLBACK" => found = Some(TxControl::Rollback),
            "TRAN" | "TRANSACTION"
                if found.is_none() && matches!(previous.as_str(), "BEGIN" | "DISTRIBUTED") =>
            {
                found = Some(TxControl::Begin)
            }
            _ => {}
        }
        previous = word;
    }
    found
}

/// A single statement that only reads: what the MCP server lets an AI run,
/// and what the page may still run while a job's transaction is open.
/// Conservative: anything it can't tell (a `;`, a write keyword anywhere)
/// counts as a write.
pub fn is_read_only(sql: &str) -> bool {
    let trimmed = sql.trim();
    if trimmed.contains(';') {
        return false;
    }
    let upper = trimmed.to_ascii_uppercase();
    let first = upper.split_whitespace().next().unwrap_or("");
    if !READ_ONLY_PREFIXES.contains(&first) {
        return false;
    }
    !FORBIDDEN_WORDS
        .iter()
        .any(|word| contains_word(&upper, word))
}

const READ_ONLY_PREFIXES: [&str; 6] = ["SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN"];
// CQL's EXPLAIN (TablePeek's tracing) runs the statement it names, so the
// words that change schema, rights or rows anywhere make it a write.
const FORBIDDEN_WORDS: [&str; 12] = [
    "INSERT", "UPDATE", "DELETE", "MERGE", "INTO", "DROP", "ALTER", "TRUNCATE", "CREATE", "GRANT",
    "REVOKE", "BATCH",
];

fn contains_word(text: &str, word: &str) -> bool {
    text.match_indices(word).any(|(index, _)| {
        let before = text[..index].chars().next_back();
        let after = text[index + word.len()..].chars().next();
        !before.is_some_and(|value| value.is_alphanumeric() || value == '_')
            && !after.is_some_and(|value| value.is_alphanumeric() || value == '_')
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use TxControl::*;

    #[test]
    fn single_table_names_keep_their_quoted_spaces_and_dots() {
        let table = |sql: &str| parse_single_table(sql);
        let named =
            |schema: Option<&str>, name: &str| Some((schema.map(String::from), name.to_string()));
        assert_eq!(table("SELECT * FROM users"), named(None, "users"));
        assert_eq!(table("SELECT * FROM users;"), named(None, "users"));
        assert_eq!(
            table("select id from shop.orders o where id = 1"),
            named(Some("shop"), "orders")
        );
        assert_eq!(
            table("SELECT * FROM [shop].[Edge Cases] ORDER BY [id] OFFSET 0 ROWS FETCH NEXT 300 ROWS ONLY;"),
            named(Some("shop"), "Edge Cases")
        );
        assert_eq!(
            table("SELECT * FROM `shop`.`Edge Cases` LIMIT 300"),
            named(Some("shop"), "Edge Cases")
        );
        assert_eq!(
            table(r#"SELECT * FROM "a.b"."c d""e""#),
            named(Some("a.b"), "c d\"e")
        );
        assert_eq!(
            table("SELECT * FROM [bracket]]inside]"),
            named(None, "bracket]inside")
        );
        assert_eq!(
            table("SELECT * FROM `back``tick`"),
            named(None, "back`tick")
        );
        assert_eq!(table("SELECT * FROM [한글 표]"), named(None, "한글 표"));
        // Not one table, or not a name it can read.
        assert_eq!(table("SELECT * FROM a, b"), None);
        assert_eq!(table("SELECT * FROM a JOIN b ON a.id = b.id"), None);
        assert_eq!(table("SELECT * FROM (SELECT 1) AS t"), None);
        assert_eq!(table("SELECT * FROM a.b.c"), None);
        assert_eq!(table("SELECT * FROM [unclosed"), None);
        assert_eq!(table("SELECT * FROM []"), None);
    }

    #[test]
    fn postgres_transaction_statements() {
        let pg = |sql: &str| tx_controls(sql, Dialect::Postgres);
        assert_eq!(pg("BEGIN"), vec![Begin]);
        assert_eq!(
            pg("  -- go\nbegin isolation level serializable"),
            vec![Begin]
        );
        assert_eq!(pg("START TRANSACTION READ ONLY"), vec![Begin]);
        assert_eq!(pg("commit"), vec![Commit]);
        assert_eq!(pg("END WORK;"), vec![Commit]);
        assert_eq!(pg("ROLLBACK"), vec![Rollback]);
        assert_eq!(pg("abort"), vec![Rollback]);
        assert_eq!(pg("ROLLBACK TO SAVEPOINT a"), vec![RollbackToSavepoint]);
        assert_eq!(pg("rollback work to b"), vec![RollbackToSavepoint]);
        assert_eq!(pg("PREPARE TRANSACTION 'x'"), vec![Rollback]);
        assert!(pg("COMMIT PREPARED 'x'").is_empty());
        assert!(pg("ROLLBACK PREPARED 'x'").is_empty());
        assert!(pg("DO $$ BEGIN PERFORM 1; END $$").is_empty());
        // One statement per query: a BEGIN ATOMIC body's END is no commit.
        assert!(pg("CREATE FUNCTION f() RETURNS int LANGUAGE sql \
                    BEGIN ATOMIC SELECT 1; END")
        .is_empty());
        assert_eq!(pg("COMMIT AND CHAIN"), vec![Commit, Begin]);
        assert_eq!(pg("end and chain"), vec![Commit, Begin]);
        assert_eq!(pg("ROLLBACK AND CHAIN"), vec![Rollback, Begin]);
        assert_eq!(pg("ROLLBACK AND NO CHAIN"), vec![Rollback]);
        assert!(pg("SELECT 'BEGIN', \"commit\" FROM t /* ROLLBACK */").is_empty());
        assert!(pg("CREATE TABLE t (a int)").is_empty());
        assert!(pg("").is_empty());
    }

    #[test]
    fn mysql_transaction_statements_and_implicit_commits() {
        let my = |sql: &str| tx_controls(sql, Dialect::MySql);
        assert_eq!(my("BEGIN WORK"), vec![Begin]);
        assert_eq!(
            my("START TRANSACTION WITH CONSISTENT SNAPSHOT"),
            vec![Begin]
        );
        assert_eq!(my("COMMIT"), vec![Commit]);
        assert_eq!(my("ROLLBACK"), vec![Rollback]);
        assert_eq!(
            my("ROLLBACK WORK TO SAVEPOINT s"),
            vec![RollbackToSavepoint]
        );
        assert_eq!(my("BEGIN; UPDATE t SET a = 1; COMMIT"), vec![Begin, Commit]);
        assert_eq!(my("ALTER TABLE t ADD c INT"), vec![ImplicitCommit]);
        assert_eq!(my("drop table t"), vec![ImplicitCommit]);
        assert_eq!(my("TRUNCATE t"), vec![ImplicitCommit]);
        assert_eq!(my("LOCK TABLES t WRITE"), vec![ImplicitCommit]);
        assert!(my("CREATE TEMPORARY TABLE t (a INT)").is_empty());
        assert_eq!(my("COMMIT AND CHAIN"), vec![Commit, Begin]);
        assert_eq!(my("ROLLBACK WORK AND CHAIN"), vec![Rollback, Begin]);
        // A routine's body runs when called, not now.
        assert_eq!(
            my("CREATE PROCEDURE p() BEGIN START TRANSACTION; UPDATE t SET a = 1; COMMIT; END"),
            vec![ImplicitCommit]
        );
        assert_eq!(
            my("CREATE DEFINER=`root`@`%` TRIGGER tr BEFORE INSERT ON t \
                FOR EACH ROW BEGIN SET NEW.a = 1; END"),
            vec![ImplicitCommit]
        );
        assert!(my("DROP TEMPORARY TABLE t").is_empty());
        assert!(my("SELECT 'COMMIT' # COMMIT\n").is_empty());
        assert!(my("UPDATE t SET `begin` = 1").is_empty());
    }

    #[test]
    fn mssql_transaction_statements() {
        let ms = |sql: &str| tx_controls(sql, Dialect::Mssql);
        assert_eq!(ms("BEGIN TRAN"), vec![Begin]);
        assert_eq!(ms("BEGIN DISTRIBUTED TRANSACTION"), vec![Begin]);
        assert_eq!(ms("COMMIT TRANSACTION"), vec![Commit]);
        assert_eq!(ms("COMMIT"), vec![Commit]);
        assert_eq!(
            ms("IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION"),
            vec![Rollback]
        );
        assert_eq!(
            ms("BEGIN TRAN UPDATE t SET a = 1 COMMIT TRAN"),
            vec![Commit]
        );
        assert!(ms("BEGIN TRY SELECT 1 END TRY BEGIN CATCH SELECT 2 END CATCH").is_empty());
        assert!(ms("SAVE TRANSACTION s").is_empty());
        assert!(ms("SELECT 'COMMIT', [rollback] FROM t").is_empty());
    }

    #[test]
    fn sqlite_is_tracked_by_its_autocommit_flag_instead() {
        assert!(tx_controls("BEGIN", Dialect::Sqlite).is_empty());
    }
}
