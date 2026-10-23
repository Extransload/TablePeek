//! What a result's source table resolved to, kept per connection (MySQL and
//! SQL Server, whose lookups go by name; PostgreSQL's go by oid, one query per
//! SELECT, and aren't kept): the catalog lookups that make a grid editable run
//! once per table instead of after every SELECT. Nothing here sees a table
//! changed by another session, so edits check the key again before they write
//! (`key_unchanged`).

use std::collections::HashMap;
use std::hash::Hash;
use std::sync::{Mutex, MutexGuard, PoisonError};

use tablepeek_types::PkValue;

use crate::sql_log::{lexemes, Dialect, Lexeme};

/// What an edit says when the table's primary key isn't the one its grid
/// was given.
pub(crate) const KEY_CHANGED: &str =
    "테이블의 기본 키가 바뀌었습니다. 쿼리를 다시 실행한 뒤 편집하세요";

/// Whether the columns an edit or delete keys its rows on are the table's
/// primary key now. A grid's key comes from a lookup that may be older than
/// the table (a cached one, or one made before another session altered it),
/// and an old key can match more rows than the one on screen.
pub(crate) fn key_unchanged(current: &[String], sent: &[PkValue], ignore_case: bool) -> bool {
    let fold = |name: &str| {
        if ignore_case {
            name.to_lowercase()
        } else {
            name.to_string()
        }
    };
    let mut current: Vec<String> = current.iter().map(|name| fold(name)).collect();
    let mut sent: Vec<String> = sent.iter().map(|pk| fold(&pk.column)).collect();
    current.sort();
    sent.sort();
    !current.is_empty() && current == sent
}

/// Lookups by table. Anything that may have changed a table, the current
/// database or a transaction holding a schema change empties it.
pub(crate) struct SourceCache<K, V> {
    entries: Mutex<HashMap<K, V>>,
}

impl<K, V> Default for SourceCache<K, V> {
    fn default() -> Self {
        Self {
            entries: Mutex::new(HashMap::new()),
        }
    }
}

impl<K: Eq + Hash, V: Clone> SourceCache<K, V> {
    pub(crate) fn get(&self, key: &K) -> Option<V> {
        self.entries().get(key).cloned()
    }

    pub(crate) fn put(&self, key: K, value: V) {
        self.entries().insert(key, value);
    }

    pub(crate) fn clear(&self) {
        self.entries().clear();
    }

    /// Before an editor statement is sent: empties the cache unless the
    /// statement keeps tables as they are, and says whether it did. Before,
    /// not after: a request dropped while the statement runs on the server
    /// would skip the clear.
    pub(crate) fn before_statement(&self, sql: &str, dialect: Dialect) -> bool {
        let changed = !keeps_tables(sql, dialect);
        if changed {
            self.clear();
        }
        changed
    }

    fn entries(&self) -> MutexGuard<'_, HashMap<K, V>> {
        self.entries.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// First words of a statement that only reads.
const READS: &[&str] = &[
    "SELECT", "WITH", "SHOW", "EXPLAIN", "DESCRIBE", "DESC", "VALUES", "TABLE", "PRAGMA",
];

/// Words that change a table or the session even inside a statement that
/// starts as a read: SELECT … INTO makes a table, EXPLAIN ANALYZE runs what
/// it explains, and SQL Server takes `SELECT 1 DROP TABLE t` as two
/// statements with no `;` between them.
const CHANGES: &[&str] = &[
    "INTO", "CREATE", "ALTER", "DROP", "RENAME", "TRUNCATE", "USE", "SET", "EXEC", "EXECUTE",
    "CALL", "COMMIT", "ROLLBACK", "GRANT", "REVOKE", "DENY",
];

/// Whether `sql` leaves tables, their keys and the session's database as
/// they were: every statement starts with a word in READS and none has a word
/// in CHANGES, comments and quoted text aside. Anything in doubt counts as a
/// change; that costs a lookup, not a stale key.
///
/// Not a read-only check: rows may change (`WITH d AS (DELETE …) SELECT`,
/// `EXPLAIN ANALYZE DELETE`, SQL Server's `SELECT 1 DELETE FROM t`), which
/// no cached key depends on. Nor can it see into a function a SELECT calls;
/// edits check the key again before they write.
fn keeps_tables(sql: &str, dialect: Dialect) -> bool {
    if dialect == Dialect::MySql {
        // MySQL runs the body of a /*! … */ comment, MariaDB a /*M! … */ one.
        if sql.contains("/*!") || sql.contains("/*M!") || sql.contains("/*m!") {
            return false;
        }
        // Where a string ends depends on NO_BACKSLASH_ESCAPES, which the
        // lexer can't know: 'C:\'; USE other is two statements without it.
        if sql.contains('\\') {
            return false;
        }
    } else if nested_comment(sql) {
        // PostgreSQL and SQL Server nest comments; the lexer doesn't.
        return false;
    }
    let words: Vec<Lexeme<'_>> = lexemes(sql, dialect).collect();
    let upper = |index: usize| match words.get(index) {
        Some(Lexeme::Word(word)) => word.to_ascii_uppercase(),
        _ => String::new(),
    };
    let mut at_start = true;
    for (index, lexeme) in words.iter().enumerate() {
        match lexeme {
            Lexeme::End => at_start = true,
            Lexeme::Word(_) => {
                let word = upper(index);
                let word = word.as_str();
                let harmless = match word {
                    // MySQL's USE INDEX (…) / USE KEY (…) hints.
                    "USE" => matches!(upper(index + 1).as_str(), "INDEX" | "KEY"),
                    // CAST(… CHARACTER SET …), CONVERT(… USING …) aside, and
                    // SQL Server's SET NOCOUNT ON before a SELECT.
                    "SET" => {
                        (index > 0 && upper(index - 1) == "CHARACTER")
                            || (at_start
                                && dialect == Dialect::Mssql
                                && upper(index + 1) == "NOCOUNT")
                    }
                    _ => false,
                };
                if !harmless
                    && ((at_start && !READS.contains(&word))
                        || (!at_start && CHANGES.contains(&word)))
                {
                    return false;
                }
                at_start = false;
            }
            Lexeme::Other if at_start => return false,
            Lexeme::Other => {}
        }
    }
    true
}

/// Whether a block comment holds another `/*`, so where it ends depends on
/// nesting. Strings aren't told apart: a `/*` in one costs a lookup.
fn nested_comment(sql: &str) -> bool {
    let mut rest = sql;
    while let Some(open) = rest.find("/*") {
        let body = &rest[open + 2..];
        let close = body.find("*/").unwrap_or(body.len());
        if body[..close].contains("/*") {
            return true;
        }
        rest = &body[close..];
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_are_told_apart_from_everything_else() {
        let reads = |sql: &str, dialect: Dialect| keeps_tables(sql, dialect);
        for dialect in [Dialect::MySql, Dialect::Postgres, Dialect::Mssql] {
            assert!(reads("SELECT * FROM t", dialect));
            assert!(reads("select id from t where name = 'x'", dialect));
            assert!(reads("  -- note\n  SELECT 1", dialect));
            assert!(reads("/* USE other */ select 1", dialect));
            assert!(reads("WITH x AS (SELECT 1 AS a) SELECT a FROM x", dialect));
            assert!(reads("with x as (select 1) select * from x", dialect));
            assert!(reads("SHOW TABLES", dialect));
            assert!(reads("EXPLAIN SELECT 1", dialect));
            assert!(reads("DESCRIBE t", dialect));
            assert!(reads("desc t", dialect));
            assert!(reads("VALUES (1)", dialect));
            assert!(reads("TABLE t", dialect));
            assert!(reads("SELECT 'DROP TABLE t', 'USE x' FROM t", dialect));
            assert!(reads("SELECT 1; SELECT 2;", dialect));
            assert!(reads(
                "SELECT * FROM t ORDER BY id DESC FOR UPDATE",
                dialect
            ));

            assert!(!reads("USE other", dialect));
            assert!(!reads("use other", dialect));
            assert!(!reads("-- switch\nUSE other", dialect));
            assert!(!reads("SET search_path TO app", dialect));
            assert!(!reads("set search_path = app, public", dialect));
            assert!(!reads("CREATE TABLE t (a int)", dialect));
            assert!(!reads("alter table t add primary key (a)", dialect));
            assert!(!reads("DROP TABLE t", dialect));
            assert!(!reads("INSERT INTO t VALUES (1)", dialect));
            assert!(!reads("UPDATE t SET a = 1", dialect));
            assert!(!reads("DELETE FROM t", dialect));
            assert!(!reads("SELECT 1; DROP TABLE t", dialect));
            assert!(!reads("select 1;\n-- then\nuse other", dialect));
            assert!(!reads("SELECT * INTO t2 FROM t", dialect));
            assert!(!reads(
                "WITH x AS (SELECT 1) SELECT * INTO y FROM x",
                dialect
            ));
            assert!(!reads("BEGIN", dialect));
            assert!(!reads("COMMIT", dialect));
            assert!(!reads("ROLLBACK", dialect));
            assert!(!reads("CALL p()", dialect));
            // Not one to vouch for: a lookup again, nothing worse.
            assert!(!reads("(SELECT 1)", dialect));
        }
        // SQL Server needs no `;` between statements.
        assert!(!reads("SELECT 1 DROP TABLE t", Dialect::Mssql));
        assert!(!reads("SELECT * FROM t USE other", Dialect::Mssql));
        assert!(!reads("SELECT 1 EXEC sp_rename 't', 'u'", Dialect::Mssql));
        assert!(!reads("SELECT 1 ROLLBACK", Dialect::Mssql));
        assert!(!reads("EXEC sp_rename 't', 'u'", Dialect::Mssql));
        assert!(reads("SELECT [use], [set] FROM t", Dialect::Mssql));
        // Quoted names are names, not keywords.
        assert!(reads("SELECT `use`, `set` FROM t", Dialect::MySql));
        assert!(reads("SELECT \"use\", \"set\" FROM t", Dialect::Postgres));
        assert!(reads("SELECT 1 # USE other\n", Dialect::MySql));
        // MySQL runs what an executable comment holds.
        assert!(!reads(
            "/*!40101 SET NAMES utf8 */ SELECT 1",
            Dialect::MySql
        ));
        assert!(!reads("SELECT 1 /*!50000 , 2 */", Dialect::MySql));
        assert!(!reads(
            "EXPLAIN ANALYZE CREATE TABLE t AS SELECT 1",
            Dialect::Postgres
        ));
        assert!(!reads("DO $$ BEGIN PERFORM 1; END $$", Dialect::Postgres));
        assert!(reads("SELECT $$ DROP TABLE t $$", Dialect::Postgres));
        // MariaDB runs /*M! … */ too.
        assert!(!reads("/*M! USE other */ SELECT 1", Dialect::MySql));
        assert!(!reads("SELECT 1; /*M!100100 USE other */", Dialect::MySql));
        // With NO_BACKSLASH_ESCAPES the string ends at the backslash.
        assert!(!reads("SELECT 'C:\\'; USE other", Dialect::MySql));
        assert!(!reads(
            "SELECT 'C:\\'; ALTER TABLE t DROP PRIMARY KEY",
            Dialect::MySql
        ));
        // A nested comment hides what follows it from a lexer that doesn't nest.
        assert!(!reads("/* /* */ SELECT 1 */ ABORT", Dialect::Postgres));
        assert!(!reads(
            "/* /* */ SELECT 1 */ sp_rename 't','u'",
            Dialect::Mssql
        ));
        assert!(reads("/* one */ SELECT 1 /* two */", Dialect::Postgres));
        // Hints and casts that only look like USE and SET.
        assert!(reads(
            "SELECT * FROM t USE INDEX (ix) WHERE a = 1",
            Dialect::MySql
        ));
        assert!(reads("SELECT * FROM t use key (ix)", Dialect::MySql));
        assert!(reads(
            "SELECT CAST(a AS CHAR CHARACTER SET utf8mb4) FROM t",
            Dialect::MySql
        ));
        assert!(reads("SET NOCOUNT ON; SELECT * FROM t", Dialect::Mssql));
        assert!(!reads("SET NOCOUNT ON; USE other", Dialect::Mssql));
        assert!(!reads("SET NOCOUNT ON", Dialect::Postgres));
        // Rows may change; tables and keys can't: not a read-only check.
        assert!(reads(
            "WITH d AS (DELETE FROM t RETURNING id) SELECT * FROM d",
            Dialect::Postgres
        ));
        assert!(reads("EXPLAIN ANALYZE DELETE FROM t", Dialect::Postgres));
        assert!(reads("SELECT 1 DELETE FROM t", Dialect::Mssql));
    }

    #[test]
    fn an_edit_keyed_on_an_old_primary_key_is_told_apart() {
        let sent = |columns: &[&str]| -> Vec<PkValue> {
            columns
                .iter()
                .map(|column| PkValue {
                    column: (*column).into(),
                    value: serde_json::Value::from(1),
                })
                .collect()
        };
        let key = |columns: &[&str]| -> Vec<String> {
            columns.iter().map(|column| (*column).to_string()).collect()
        };
        assert!(key_unchanged(&key(&["id"]), &sent(&["id"]), false));
        assert!(key_unchanged(&key(&["a", "b"]), &sent(&["b", "a"]), false));
        assert!(key_unchanged(&key(&["ID"]), &sent(&["id"]), true));
        assert!(!key_unchanged(&key(&["ID"]), &sent(&["id"]), false));
        // The key grew, shrank, moved or went.
        assert!(!key_unchanged(&key(&["id", "rev"]), &sent(&["id"]), false));
        assert!(!key_unchanged(&key(&["id"]), &sent(&["id", "rev"]), false));
        assert!(!key_unchanged(&key(&["code"]), &sent(&["id"]), false));
        assert!(!key_unchanged(&[], &sent(&["id"]), false));
    }

    #[test]
    fn a_statement_that_is_not_a_read_empties_the_cache() {
        let cache: SourceCache<u32, Vec<String>> = SourceCache::default();
        cache.put(7, vec!["id".into()]);

        assert!(!cache.before_statement("SELECT * FROM t", Dialect::Mssql));
        assert_eq!(cache.get(&7), Some(vec!["id".into()]));

        assert!(cache.before_statement("ALTER TABLE t DROP CONSTRAINT t_pkey", Dialect::Mssql));
        assert_eq!(cache.get(&7), None);

        cache.put(7, vec!["id".into()]);
        assert!(cache.before_statement("USE other", Dialect::MySql));
        assert_eq!(cache.get(&7), None);

        cache.put(7, vec!["id".into()]);
        cache.clear();
        assert_eq!(cache.get(&7), None);
    }
}
