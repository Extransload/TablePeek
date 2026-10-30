//! The console log: every statement an engine sends to its database, in the
//! order sent, plus the data changes that belong in History.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tokio::sync::{broadcast, mpsc};

/// Entries kept; the oldest fall off first.
pub const LOG_CAP: usize = 1_000;
/// Statements longer than this many characters are kept as a short note.
const LONG_STATEMENT: usize = 20_000;
/// How much of a long statement the note keeps.
const LONG_KEEP: usize = 2_000;
/// Shell commands (`db.c.insertMany([…])`) longer than this many characters
/// keep only their head in the console and History; a page that shows
/// hundreds of entries can't hold megabytes of documents.
pub const COMMAND_CAP: usize = 4_000;
/// Statements a subscriber may fall behind by before it is told it lagged.
const CHANNEL_CAP: usize = 1_024;
/// What a redacted password shows as.
const REDACTED: &str = "'********'";

#[derive(Clone, Debug, Serialize)]
pub struct LogEntry {
    /// Strictly increasing for the life of the engine, never reused.
    pub seq: u64,
    /// Unix epoch milliseconds, taken when the statement was sent.
    pub at_ms: u64,
    pub sql: String,
}

/// A data change that went through, for History: a GUI cell edit, row insert
/// or delete, or a statement the GUI ran asking for History.
#[derive(Clone, Debug, PartialEq)]
pub struct Change {
    /// As sent, with bound values inlined.
    pub sql: String,
    pub ms: u64,
    pub rows: u64,
}

/// Cheap to clone: every clone feeds the same log.
#[derive(Clone)]
pub struct SqlLog(Arc<Shared>);

struct Shared {
    ring: Mutex<Ring>,
    statements: broadcast::Sender<LogEntry>,
    changes: Mutex<Changes>,
}

struct Ring {
    entries: VecDeque<LogEntry>,
    next_seq: u64,
    // next_seq when the log was last cleared: a reader whose newest entry is
    // older than this still shows entries that are gone.
    cleared_at: u64,
}

// Changes travel apart from statements, on a channel that never drops any:
// a bulk delete must not lose History to console traffic.
struct Changes {
    // Held back until their transaction ends.
    pending: Vec<Change>,
    sender: mpsc::UnboundedSender<Change>,
    receiver: Option<mpsc::UnboundedReceiver<Change>>,
    // Transactions ended so far, and whether the last one committed.
    ends: u64,
    last_committed: bool,
}

impl Default for SqlLog {
    fn default() -> Self {
        Self::new()
    }
}

impl SqlLog {
    pub fn new() -> Self {
        let (statements, _) = broadcast::channel(CHANNEL_CAP);
        let (sender, receiver) = mpsc::unbounded_channel();
        Self(Arc::new(Shared {
            ring: Mutex::new(Ring {
                entries: VecDeque::new(),
                next_seq: 1,
                cleared_at: 0,
            }),
            statements,
            changes: Mutex::new(Changes {
                pending: Vec::new(),
                sender,
                receiver: Some(receiver),
                ends: 0,
                last_committed: false,
            }),
        }))
    }

    fn ring(&self) -> MutexGuard<'_, Ring> {
        self.0.ring.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn changes(&self) -> MutexGuard<'_, Changes> {
        self.0
            .changes
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
    }

    /// Adds a statement about to be sent, read by `dialect`'s rules. The
    /// console shows passwords it carries as '********'.
    pub fn record(&self, sql: &str, dialect: Dialect) {
        let Some(sql) = console_text(sql, dialect) else {
            return;
        };
        self.push(sql);
    }

    /// Adds an operation of an engine that speaks no SQL, written as its
    /// own shell would (`db.orders.find({…})`), as it is.
    pub fn record_command(&self, text: &str) {
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        self.push(clip_command(text).into_owned());
    }

    /// Every entry, SQL or not, shows a URL's password as `****`.
    fn push(&self, sql: String) {
        let sql = crate::registry::redact_uri_passwords(&sql);
        let at_ms = unix_ms();
        let mut ring = self.ring();
        let entry = LogEntry {
            seq: ring.next_seq,
            at_ms,
            sql,
        };
        ring.next_seq += 1;
        if ring.entries.len() == LOG_CAP {
            ring.entries.pop_front();
        }
        ring.entries.push_back(entry.clone());
        // Sent under the lock so subscribers receive entries in seq order.
        let _ = self.0.statements.send(entry);
    }

    /// A change that went through. Made inside an open transaction it waits
    /// for `settle`; otherwise it goes out at once. Like the console, History
    /// never keeps a URL's password.
    pub fn changed(&self, mut change: Change, in_tx: bool) {
        change.sql = crate::registry::redact_uri_passwords(&change.sql);
        let mut changes = self.changes();
        if in_tx {
            changes.pending.push(change);
        } else {
            let _ = changes.sender.send(change);
        }
    }

    /// Settles the changes held back: they go out if `committed` and are
    /// dropped otherwise. For leftovers no open transaction owns (a swapped
    /// backend, a stale BEGIN); a transaction that ends calls `ended`.
    pub fn settle(&self, committed: bool) {
        let mut changes = self.changes();
        let pending = std::mem::take(&mut changes.pending);
        if committed {
            for change in pending {
                let _ = changes.sender.send(change);
            }
        }
    }

    /// The connection's open transaction ended: settles what it held and
    /// notes the outcome for `ended_since`.
    pub fn ended(&self, committed: bool) {
        {
            let mut changes = self.changes();
            changes.ends += 1;
            changes.last_committed = committed;
        }
        self.settle(committed);
    }

    /// A mark to pass to `ended_since` later.
    pub fn ends(&self) -> u64 {
        self.changes().ends
    }

    /// Whether a transaction ended since `ends` returned `mark` and, if so,
    /// whether the last one committed.
    pub fn ended_since(&self, mark: u64) -> Option<bool> {
        let changes = self.changes();
        (changes.ends != mark).then_some(changes.last_committed)
    }

    /// Whether changes are waiting for their transaction to end.
    pub fn has_pending(&self) -> bool {
        !self.changes().pending.is_empty()
    }

    /// Every change that goes out, in order; only the first caller gets it.
    /// Until then they queue up.
    pub fn take_changes(&self) -> Option<mpsc::UnboundedReceiver<Change>> {
        self.changes().receiver.take()
    }

    /// Entries after `seq`, the newest a reader already has. With `reset` the
    /// reader must replace its list with the entries returned (the whole
    /// ring): it had none, entries after `seq` already fell off, or the log
    /// was cleared since.
    pub fn since(&self, seq: Option<u64>) -> (Vec<LogEntry>, bool) {
        let ring = self.ring();
        let oldest = ring
            .entries
            .front()
            .map_or(ring.next_seq, |entry| entry.seq);
        let reset = match seq {
            None => true,
            Some(seen) => {
                seen < ring.cleared_at || seen.saturating_add(1) < oldest || seen >= ring.next_seq
            }
        };
        let entries = match seq {
            Some(seen) if !reset => ring
                .entries
                .iter()
                .filter(|entry| entry.seq > seen)
                .cloned()
                .collect(),
            _ => ring.entries.iter().cloned().collect(),
        };
        (entries, reset)
    }

    /// Empties the log; sequence numbers carry on where they were.
    pub fn clear(&self) {
        let mut ring = self.ring();
        ring.entries.clear();
        ring.cleared_at = ring.next_seq;
    }

    pub fn subscribe(&self) -> broadcast::Receiver<LogEntry> {
        self.0.statements.subscribe()
    }
}

/// A shell command cut to COMMAND_CAP characters, the rest noted in a
/// comment the shell would skip.
pub fn clip_command(text: &str) -> std::borrow::Cow<'_, str> {
    if text.len() <= COMMAND_CAP {
        return text.into();
    }
    match text.char_indices().nth(COMMAND_CAP) {
        Some((cut, _)) => {
            let rest = text[cut..].chars().count();
            format!("{} /* … {rest}자 생략 */", &text[..cut]).into()
        }
        None => text.into(),
    }
}

fn console_text(sql: &str, dialect: Dialect) -> Option<String> {
    let redacted = redact_secrets(sql, dialect);
    let sql = redacted.as_deref().unwrap_or(sql).trim();
    if sql.is_empty() {
        return None;
    }
    if sql.len() > LONG_STATEMENT {
        let total = sql.chars().count();
        if total > LONG_STATEMENT {
            let cut = sql
                .char_indices()
                .nth(LONG_KEEP)
                .map_or(sql.len(), |(index, _)| index);
            return Some(format!(
                "{}\n-- … {} more characters",
                &sql[..cut],
                total - LONG_KEEP
            ));
        }
    }
    // A terminator after a trailing line comment would land inside it.
    Some(
        if sql.ends_with(';') || ends_in_line_comment(sql, dialect) {
            sql.to_string()
        } else {
            format!("{sql};")
        },
    )
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// A bound parameter, as the console and History show it.
#[derive(Clone, Debug, PartialEq)]
pub enum LogParam {
    Null,
    Int(i64),
    UInt(u64),
    Float(f64),
    Bool(bool),
    Text(String),
    Blob(Vec<u8>),
    /// A value already written as the dialect's own literal (a CQL
    /// collection or UDT), shown as it is.
    Literal(String),
}

/// Placeholder, quoting, comment and literal rules of the SQL a driver sends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dialect {
    /// `?NNN` and `?`; '…', "…", `…` and […] quoting.
    Sqlite,
    /// `$N`; '…' (E'…' with backslash escapes), "…" and $tag$…$tag$ quoting.
    Postgres,
    /// `?`; '…' and "…" with backslash escapes, `…` quoting, `#` comments,
    /// `--` comments only when followed by a space or control character.
    MySql,
    /// `@PN`; '…', "…" and […] quoting; text as N'…'.
    Mssql,
    /// No placeholders (values are written in); '…', "…" and `…` with
    /// backslash escapes, $tag$…$tag$ heredocs, `#` comments before a space
    /// or `!`.
    ClickHouse,
    /// Cassandra's CQL: `?`; '…' and "…" quoting, $$…$$ bodies, `//`
    /// comments; blobs as 0x….
    Cql,
    /// `:N` and `:name`; '…' and q'[…]' literals, "…" names; binary as
    /// HEXTORAW('…').
    Oracle,
}

/// `sql` with its placeholders replaced by `params` as SQL literals, for
/// display only (execution keeps binding them). Placeholders inside quoted
/// strings, quoted identifiers and comments are left alone, as is one with
/// no matching parameter.
pub fn inline_params(sql: &str, params: &[LogParam], dialect: Dialect) -> String {
    if params.is_empty() {
        return sql.to_string();
    }
    let bytes = sql.as_bytes();
    let mut out = String::with_capacity(sql.len() + params.len() * 8);
    let mut copied = 0;
    let mut positional = 0usize;
    let mut i = 0;
    while i < bytes.len() {
        if let Some((_, end)) = span_at(bytes, i, dialect) {
            i = end;
            continue;
        }
        let placeholder = match bytes[i] {
            b'?' if matches!(dialect, Dialect::Sqlite | Dialect::MySql | Dialect::Cql) => {
                match digits(bytes, i + 1).filter(|_| dialect == Dialect::Sqlite) {
                    Some((number, end)) => {
                        positional = positional.max(number);
                        Some((number, end))
                    }
                    None => {
                        positional += 1;
                        Some((positional, i + 1))
                    }
                }
            }
            b'$' if dialect == Dialect::Postgres && !ident_before(bytes, i) => digits(bytes, i + 1),
            b':' if dialect == Dialect::Oracle
                && !ident_before(bytes, i)
                && (i == 0 || bytes[i - 1] != b':') =>
            {
                digits(bytes, i + 1)
                    .filter(|(_, end)| !bytes.get(*end).is_some_and(|b| is_ident(*b)))
            }
            b'@' if dialect == Dialect::Mssql
                && matches!(bytes.get(i + 1), Some(b'P' | b'p'))
                && !ident_before(bytes, i)
                && (i == 0 || bytes[i - 1] != b'@') =>
            {
                digits(bytes, i + 2)
                    .filter(|(_, end)| !bytes.get(*end).is_some_and(|b| is_ident(*b)))
            }
            _ => None,
        };
        match placeholder {
            Some((number, end)) => {
                if let Some(param) = number.checked_sub(1).and_then(|index| params.get(index)) {
                    out.push_str(&sql[copied..i]);
                    out.push_str(&render(param, dialect));
                    copied = end;
                }
                i = end;
            }
            None => i += 1,
        }
    }
    out.push_str(&sql[copied..]);
    out
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Span {
    Literal,
    Identifier,
    Comment,
}

/// The quoted string, quoted identifier or comment starting at `i`, and
/// where it ends; None when none starts there.
fn span_at(bytes: &[u8], i: usize, dialect: Dialect) -> Option<(Span, usize)> {
    let next = bytes.get(i + 1).copied();
    match bytes[i] {
        b'\'' => {
            // PostgreSQL reads backslash escapes only in E'…' strings.
            let backslash = matches!(dialect, Dialect::MySql | Dialect::ClickHouse)
                || (dialect == Dialect::Postgres
                    && i > 0
                    && matches!(bytes[i - 1], b'E' | b'e')
                    && !ident_before(bytes, i - 1));
            Some((Span::Literal, skip_quoted(bytes, i, b'\'', backslash)))
        }
        // Oracle's q'[…]' and Nq'[…]': no quote inside needs doubling.
        b'q' | b'Q'
            if dialect == Dialect::Oracle && next == Some(b'\'') && !ident_before(bytes, i) =>
        {
            Some((Span::Literal, q_quote_end(bytes, i)))
        }
        b'N' | b'n'
            if dialect == Dialect::Oracle
                && matches!(next, Some(b'q' | b'Q'))
                && bytes.get(i + 2) == Some(&b'\'')
                && !ident_before(bytes, i) =>
        {
            Some((Span::Literal, q_quote_end(bytes, i + 1)))
        }
        b'"' if dialect == Dialect::MySql => {
            Some((Span::Literal, skip_quoted(bytes, i, b'"', true)))
        }
        b'"' if dialect == Dialect::ClickHouse => {
            Some((Span::Identifier, skip_quoted(bytes, i, b'"', true)))
        }
        b'"' => Some((Span::Identifier, skip_quoted(bytes, i, b'"', false))),
        b'`' if matches!(
            dialect,
            Dialect::Sqlite | Dialect::MySql | Dialect::ClickHouse
        ) =>
        {
            let backslash = dialect == Dialect::ClickHouse;
            Some((Span::Identifier, skip_quoted(bytes, i, b'`', backslash)))
        }
        b'[' if matches!(dialect, Dialect::Sqlite | Dialect::Mssql) => {
            Some((Span::Identifier, skip_quoted(bytes, i, b']', false)))
        }
        // MySQL takes "--" as a comment only before a space or control
        // character ("1--1" is arithmetic).
        b'-' if next == Some(b'-')
            && (dialect != Dialect::MySql || bytes.get(i + 2).is_none_or(|b| *b <= b' ')) =>
        {
            Some((Span::Comment, line_end(bytes, i)))
        }
        b'#' if dialect == Dialect::MySql => Some((Span::Comment, line_end(bytes, i))),
        b'#' if dialect == Dialect::ClickHouse && matches!(next, Some(b' ' | b'!')) => {
            Some((Span::Comment, line_end(bytes, i)))
        }
        b'/' if next == Some(b'*') => Some((Span::Comment, block_comment_end(bytes, i))),
        b'/' if next == Some(b'/') && dialect == Dialect::Cql => {
            Some((Span::Comment, line_end(bytes, i)))
        }
        b'$' if matches!(
            dialect,
            Dialect::Postgres | Dialect::ClickHouse | Dialect::Cql
        ) && !ident_before(bytes, i) =>
        {
            dollar_quote_end(bytes, i).map(|end| (Span::Literal, end))
        }
        _ => None,
    }
}

fn ends_in_line_comment(sql: &str, dialect: Dialect) -> bool {
    let bytes = sql.as_bytes();
    let hashes = matches!(dialect, Dialect::MySql | Dialect::ClickHouse) && bytes.contains(&b'#');
    let slashes = dialect == Dialect::Cql && bytes.windows(2).any(|pair| pair == b"//");
    if !hashes && !slashes && !bytes.windows(2).any(|pair| pair == b"--") {
        return false;
    }
    let mut i = 0;
    while i < bytes.len() {
        match span_at(bytes, i, dialect) {
            Some((Span::Comment, end))
                if end == bytes.len() && bytes.get(i..i + 2) != Some(b"/*".as_slice()) =>
            {
                return true
            }
            Some((_, end)) => i = end,
            None => i += 1,
        }
    }
    false
}

#[derive(Clone, Copy)]
enum Token {
    Word(usize, usize),
    /// From the opening quote (past any N/E/_charset prefix) to the end.
    Literal(usize, usize),
    Punct(u8),
}

/// `sql` with the literals that carry passwords shown as '********', or None
/// when it has none. Covers user and login management in every dialect
/// (PASSWORD '…', PASSWORD = N'…', IDENTIFIED [WITH plugin] BY|AS '…', SET
/// PASSWORD [FOR …] = '…', PASSWORD('…'), REPLACE '…'), SQL Server
/// credentials (SECRET = '…') and login procedures (sp_password,
/// sp_addlogin, sp_addlinkedsrvlogin, any @…password… = '…'), connection
/// strings in a literal (password=…, PWD=…, scheme://user:password@host)
/// and, erring on the side of hiding, any literal given to something named
/// *password.
fn redact_secrets(sql: &str, dialect: Dialect) -> Option<String> {
    if !mentions(sql, "password")
        && !mentions(sql, "identified")
        && !mentions(sql, "secret")
        && !mentions(sql, "pwd")
        && !mentions(sql, "sp_addlogin")
        && !mentions(sql, "linkedsrvlogin")
        && !mentions(sql, "approle")
        && !mentions(sql, "change_users_login")
        && !sql.contains("://")
    {
        return None;
    }
    let tokens = tokenize(sql, dialect);
    let word = |index: usize| -> Option<String> {
        match tokens.get(index) {
            Some(Token::Word(start, end)) => Some(sql[*start..*end].to_ascii_uppercase()),
            _ => None,
        }
    };
    let is_password = |word: &str| word == "PASSWORD" || word.ends_with("_PASSWORD");
    // The literal a password clause gives, past any "=", "(" and PASSWORD(.
    let value = |mut index: usize| -> Option<(usize, usize)> {
        loop {
            match tokens.get(index)? {
                Token::Punct(b'=' | b'(') => {}
                Token::Word(..) if word(index).is_some_and(|word| is_password(&word)) => {}
                Token::Literal(start, end) => return Some((*start, *end)),
                _ => return None,
            }
            index += 1;
        }
    };
    let mut hidden: Vec<(usize, usize)> = Vec::new();
    for index in 0..tokens.len() {
        match tokens[index] {
            Token::Literal(start, end) => {
                if connection_secret(&sql[start..end]) {
                    hidden.push((start, end));
                }
                continue;
            }
            // SQL Server's @password = '…', @rmtpassword = '…', @pwd = '…'
            // (DECLARE @password nvarchar(50) = '…': past the type)
            Token::Punct(b'@') => {
                let named = word(index + 1)
                    .is_some_and(|name| name.contains("PASSW") || name.contains("PWD"));
                if named {
                    let mut at = index + 2;
                    while matches!(
                        tokens.get(at),
                        Some(Token::Word(..) | Token::Punct(b'(' | b')'))
                    ) {
                        at += 1;
                    }
                    if matches!(tokens.get(at), Some(Token::Punct(b'='))) {
                        hidden.extend(value(at));
                    }
                }
                continue;
            }
            _ => {}
        }
        let Some(current) = word(index) else {
            continue;
        };
        let procedure = current.trim_matches(|c| matches!(c, '[' | ']' | '"' | '`'));
        if let Some((positions, names)) = login_procedure(procedure) {
            procedure_secrets(sql, &tokens, index + 1, positions, names, &mut hidden);
            continue;
        }
        let found = if is_password(&current) {
            if word(index + 1).as_deref() == Some("FOR") {
                // SET PASSWORD FOR account = '…': past the account.
                tokens[index + 1..]
                    .iter()
                    .position(|token| matches!(token, Token::Punct(b'=' | b';')))
                    .map(|offset| index + 1 + offset)
                    .filter(|at| matches!(tokens[*at], Token::Punct(b'=')))
                    .and_then(value)
            } else {
                value(index + 1)
            }
        } else if current == "IDENTIFIED" {
            let mut at = index + 1;
            if word(at).as_deref() == Some("WITH") {
                at += 2;
            }
            match word(at).as_deref() {
                // Oracle's password is a name: IDENTIFIED BY "pw" or bare pw.
                Some("BY") if dialect == Dialect::Oracle => match tokens.get(at + 1) {
                    Some(Token::Word(start, end) | Token::Literal(start, end)) => {
                        Some((*start, *end))
                    }
                    _ => None,
                },
                Some("BY" | "AS") => value(at + 1),
                _ => None,
            }
        } else if current == "SECRET" {
            // CREATE [DATABASE SCOPED] CREDENTIAL … SECRET = '…'
            value(index + 1)
        } else if current == "REPLACE" {
            // ALTER USER … REPLACE 'current password'
            match tokens.get(index + 1) {
                Some(Token::Literal(start, end)) => Some((*start, *end)),
                _ => None,
            }
        } else {
            None
        };
        hidden.extend(found);
    }
    if hidden.is_empty() {
        return None;
    }
    hidden.sort_unstable();
    hidden.dedup();
    let mut out = String::with_capacity(sql.len());
    let mut copied = 0;
    for (start, end) in hidden {
        out.push_str(&sql[copied..start]);
        out.push_str(REDACTED);
        copied = end;
    }
    out.push_str(&sql[copied..]);
    Some(out)
}

/// SQL Server procedures that take passwords: which positional arguments
/// (from 0) and which named ones carry them.
fn login_procedure(name: &str) -> Option<(&'static [usize], &'static [&'static str])> {
    match name {
        "SP_PASSWORD" => Some((&[0, 1], &["OLD", "NEW"])),
        "SP_ADDLOGIN" => Some((&[1], &["PASSWD"])),
        "SP_ADDLINKEDSRVLOGIN" => Some((&[4], &["RMTPASSWORD"])),
        "SP_SETAPPROLE" | "SP_ADDAPPROLE" => Some((&[1], &["PASSWORD"])),
        "SP_APPROLEPASSWORD" => Some((&[1], &["NEWPWD"])),
        "SP_CHANGE_USERS_LOGIN" => Some((&[3], &["PASSWORD"])),
        _ => None,
    }
}

/// Collects the password literals among a procedure call's arguments, which
/// start at `at`: by position, or by name (@new = '…').
fn procedure_secrets(
    sql: &str,
    tokens: &[Token],
    mut at: usize,
    positions: &[usize],
    names: &[&str],
    hidden: &mut Vec<(usize, usize)>,
) {
    let mut position = 0;
    loop {
        let mut name = None;
        if let (Some(Token::Punct(b'@')), Some(Token::Word(start, end)), Some(Token::Punct(b'='))) =
            (tokens.get(at), tokens.get(at + 1), tokens.get(at + 2))
        {
            name = Some(sql[*start..*end].to_ascii_uppercase());
            at += 3;
        }
        match tokens.get(at) {
            Some(Token::Literal(start, end)) => {
                let secret = match &name {
                    Some(name) => names.contains(&name.as_str()),
                    None => positions.contains(&position),
                };
                if secret {
                    hidden.push((*start, *end));
                }
                at += 1;
            }
            // NULL, DEFAULT, or a variable's name
            Some(Token::Word(..)) => at += 1,
            Some(Token::Punct(b'@')) => at += 2,
            _ => return,
        }
        if !matches!(tokens.get(at), Some(Token::Punct(b','))) {
            return;
        }
        position += 1;
        at += 1;
    }
}

/// A literal holding a connection string with a password in it: libpq's
/// `password=…` (dblink, CREATE SUBSCRIPTION … CONNECTION), ODBC/OLE DB's
/// `PWD=…` or `Password=…` (OPENROWSET, OPENDATASOURCE) or a URI's
/// `user:password@`.
fn connection_secret(literal: &str) -> bool {
    let lower = literal.to_ascii_lowercase();
    let assigned = |key: &str| {
        let mut rest = lower.as_str();
        while let Some(at) = rest.find(key) {
            rest = &rest[at + key.len()..];
            if rest.trim_start().starts_with('=') {
                return true;
            }
        }
        false
    };
    if assigned("password") || assigned("pwd") {
        return true;
    }
    let Some(at) = lower.find("://") else {
        return false;
    };
    let authority = lower[at + 3..]
        .split(['/', '?', '#', ' ', '\''])
        .next()
        .unwrap_or("");
    authority
        .rsplit_once('@')
        .is_some_and(|(userinfo, _)| userinfo.contains(':'))
}

fn mentions(sql: &str, word: &str) -> bool {
    sql.as_bytes()
        .windows(word.len())
        .any(|window| window.eq_ignore_ascii_case(word.as_bytes()))
}

fn tokenize(sql: &str, dialect: Dialect) -> Vec<Token> {
    Tokens {
        bytes: sql.as_bytes(),
        dialect,
        i: 0,
    }
    .collect()
}

/// A statement's words, statement ends and anything else, comments left out:
/// enough to tell what kind of statement each one is.
pub(crate) enum Lexeme<'a> {
    /// A keyword or name, a quoted one with its quotes.
    Word(&'a str),
    /// A `;`.
    End,
    Other,
}

pub(crate) fn lexemes(sql: &str, dialect: Dialect) -> impl Iterator<Item = Lexeme<'_>> {
    Tokens {
        bytes: sql.as_bytes(),
        dialect,
        i: 0,
    }
    .map(move |token| match token {
        Token::Word(start, end) => Lexeme::Word(&sql[start..end]),
        Token::Punct(b';') => Lexeme::End,
        _ => Lexeme::Other,
    })
}

struct Tokens<'a> {
    bytes: &'a [u8],
    dialect: Dialect,
    i: usize,
}

impl Iterator for Tokens<'_> {
    type Item = Token;

    fn next(&mut self) -> Option<Token> {
        let (bytes, dialect) = (self.bytes, self.dialect);
        while self.i < bytes.len() {
            let i = self.i;
            let byte = bytes[i];
            if byte.is_ascii_whitespace() {
                self.i += 1;
                continue;
            }
            if let Some((span, end)) = span_at(bytes, i, dialect) {
                self.i = end;
                match span {
                    Span::Literal => return Some(Token::Literal(i, end)),
                    Span::Identifier => return Some(Token::Word(i, end)),
                    Span::Comment => continue,
                }
            }
            if is_ident(byte) && byte != b'$' {
                let mut end = i;
                while end < bytes.len() && is_ident(bytes[end]) {
                    end += 1;
                }
                // A prefix (N'…', E'…', _utf8mb4'…') belongs to its literal.
                let prefix = &bytes[i..end];
                let is_prefix = matches!(prefix, [b'N' | b'n' | b'E' | b'e'])
                    || (dialect == Dialect::MySql && prefix.starts_with(b"_"));
                if is_prefix && bytes.get(end) == Some(&b'\'') {
                    let backslash = dialect == Dialect::MySql
                        || (dialect == Dialect::Postgres && prefix.eq_ignore_ascii_case(b"e"));
                    let literal_end = skip_quoted(bytes, end, b'\'', backslash);
                    self.i = literal_end;
                    return Some(Token::Literal(end, literal_end));
                }
                self.i = end;
                return Some(Token::Word(i, end));
            }
            self.i += 1;
            return Some(Token::Punct(byte));
        }
        None
    }
}

fn is_ident(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'$' || byte >= 0x80
}

fn ident_before(bytes: &[u8], at: usize) -> bool {
    at > 0 && is_ident(bytes[at - 1])
}

// A run of ASCII digits starting at `start`: its value and where it ends.
fn digits(bytes: &[u8], start: usize) -> Option<(usize, usize)> {
    let end = start
        + bytes[start.min(bytes.len())..]
            .iter()
            .take_while(|byte| byte.is_ascii_digit())
            .count();
    if end == start {
        return None;
    }
    std::str::from_utf8(&bytes[start..end])
        .ok()?
        .parse()
        .ok()
        .map(|number| (number, end))
}

// Past the quote opened at `start` and closed by `close`; a doubled closing
// quote stays inside, as does a backslash-escaped byte where allowed.
fn skip_quoted(bytes: &[u8], start: usize, close: u8, backslash: bool) -> usize {
    let mut i = start + 1;
    while i < bytes.len() {
        if backslash && bytes[i] == b'\\' {
            i += 2;
            continue;
        }
        if bytes[i] == close {
            if bytes.get(i + 1) == Some(&close) {
                i += 2;
                continue;
            }
            return i + 1;
        }
        i += 1;
    }
    bytes.len()
}

fn line_end(bytes: &[u8], start: usize) -> usize {
    bytes[start..]
        .iter()
        .position(|byte| *byte == b'\n')
        .map_or(bytes.len(), |offset| start + offset + 1)
}

fn block_comment_end(bytes: &[u8], start: usize) -> usize {
    bytes[start + 2..]
        .windows(2)
        .position(|pair| pair == b"*/")
        .map_or(bytes.len(), |offset| start + 2 + offset + 2)
}

// Past a PostgreSQL dollar-quoted string ($$…$$ or $tag$…$tag$) opened at
// `start`, or None when the `$` opens none (a tag never starts with a digit:
// that is a placeholder).
fn dollar_quote_end(bytes: &[u8], start: usize) -> Option<usize> {
    if bytes.get(start + 1).is_some_and(u8::is_ascii_digit) {
        return None;
    }
    let tag_len = bytes[start + 1..]
        .iter()
        .take_while(|byte| byte.is_ascii_alphanumeric() || **byte == b'_' || **byte >= 0x80)
        .count();
    let tag_end = start + 1 + tag_len;
    if bytes.get(tag_end) != Some(&b'$') {
        return None;
    }
    let tag = &bytes[start..=tag_end];
    let body = tag_end + 1;
    Some(
        bytes[body..]
            .windows(tag.len())
            .position(|window| window == tag)
            .map_or(bytes.len(), |offset| body + offset + tag.len()),
    )
}

// Past an Oracle q-quoted string opened at `start` (the q of q'[…]'): the
// character after the quote opens it, and its closing partner ([ ], { },
// ( ), < >, else the same character) followed by a quote ends it.
fn q_quote_end(bytes: &[u8], start: usize) -> usize {
    let Some(&open) = bytes.get(start + 2) else {
        return bytes.len();
    };
    let close = match open {
        b'[' => b']',
        b'{' => b'}',
        b'(' => b')',
        b'<' => b'>',
        other => other,
    };
    let body = start + 3;
    bytes
        .get(body..)
        .unwrap_or_default()
        .windows(2)
        .position(|pair| pair[0] == close && pair[1] == b'\'')
        .map_or(bytes.len(), |offset| body + offset + 2)
}

fn render(param: &LogParam, dialect: Dialect) -> String {
    match param {
        LogParam::Null => "NULL".into(),
        LogParam::Int(value) => value.to_string(),
        LogParam::UInt(value) => value.to_string(),
        LogParam::Float(value) if value.is_finite() => value.to_string(),
        LogParam::Float(value) => quote_text(&value.to_string(), dialect),
        LogParam::Bool(value) => match (dialect, value) {
            (Dialect::Postgres | Dialect::Cql, true) => "TRUE".into(),
            (Dialect::Postgres | Dialect::Cql, false) => "FALSE".into(),
            (_, true) => "1".into(),
            (_, false) => "0".into(),
        },
        LogParam::Text(text) => quote_text(text, dialect),
        LogParam::Blob(bytes) => {
            let hex: String = bytes.iter().map(|byte| format!("{byte:02X}")).collect();
            match dialect {
                Dialect::Postgres => format!("'\\x{hex}'::bytea"),
                Dialect::Mssql | Dialect::Cql => format!("0x{hex}"),
                Dialect::Oracle => format!("HEXTORAW('{hex}')"),
                Dialect::Sqlite | Dialect::MySql | Dialect::ClickHouse => format!("X'{hex}'"),
            }
        }
        LogParam::Literal(text) => text.clone(),
    }
}

fn quote_text(text: &str, dialect: Dialect) -> String {
    let escaped = if matches!(dialect, Dialect::MySql | Dialect::ClickHouse) {
        text.replace('\\', "\\\\").replace('\'', "''")
    } else {
        text.replace('\'', "''")
    };
    if dialect == Dialect::Mssql {
        format!("N'{escaped}'")
    } else {
        format!("'{escaped}'")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const LITE: Dialect = Dialect::Sqlite;

    fn seqs(entries: &[LogEntry]) -> Vec<u64> {
        entries.iter().map(|entry| entry.seq).collect()
    }

    #[test]
    fn record_normalises_text() {
        let log = SqlLog::new();
        log.record("  SELECT 1  ", LITE);
        log.record("SELECT 2;\n", LITE);
        log.record("   ", LITE);
        let (entries, _) = log.since(None);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].sql, "SELECT 1;");
        assert_eq!(entries[1].sql, "SELECT 2;");
        assert!(entries[0].at_ms > 1_600_000_000_000);

        let long = format!("SELECT '{}'", "é".repeat(LONG_STATEMENT));
        log.record(&long, LITE);
        let (entries, _) = log.since(Some(2));
        let note = &entries[0].sql;
        let (kept, tail) = note.split_once('\n').unwrap();
        assert_eq!(kept.chars().count(), LONG_KEEP);
        assert!(long.starts_with(kept));
        let rest = long.chars().count() - LONG_KEEP;
        assert_eq!(tail, format!("-- … {rest} more characters"));

        // Exactly at the limit is still shown in full.
        let edge = "x".repeat(LONG_STATEMENT - 1);
        log.record(&edge, LITE);
        assert_eq!(log.since(Some(3)).0[0].sql, format!("{edge};"));
    }

    #[test]
    fn long_shell_commands_keep_their_head() {
        let log = SqlLog::new();
        let short = "db.c.insertOne({ a: 1 })";
        log.record_command(short);
        let long = format!("db.c.insertMany([{}])", "{ é: 1 }, ".repeat(1_000));
        log.record_command(&long);
        let (entries, _) = log.since(None);
        assert_eq!(entries[0].sql, short);
        let (kept, note) = entries[1].sql.split_once(" /* … ").unwrap();
        assert_eq!(kept.chars().count(), COMMAND_CAP);
        assert!(long.starts_with(kept));
        let rest = long.chars().count() - COMMAND_CAP;
        assert_eq!(note, format!("{rest}자 생략 */"));
    }

    #[test]
    fn terminator_stays_out_of_a_trailing_line_comment() {
        let shown = |sql: &str, dialect: Dialect| console_text(sql, dialect).unwrap();
        assert_eq!(shown("SELECT 1 -- note", LITE), "SELECT 1 -- note");
        assert_eq!(shown("-- note\nSELECT 1", LITE), "-- note\nSELECT 1;");
        assert_eq!(shown("SELECT '--'", LITE), "SELECT '--';");
        assert_eq!(shown("SELECT 1 /* c */", LITE), "SELECT 1 /* c */;");
        assert_eq!(shown("SELECT 1--1", LITE), "SELECT 1--1");
        assert_eq!(shown("SELECT 1 # note", Dialect::MySql), "SELECT 1 # note");
        // MySQL: "--" without a space after it is not a comment.
        assert_eq!(shown("SELECT 1--1", Dialect::MySql), "SELECT 1--1;");
        assert_eq!(shown("SELECT 1 --", Dialect::MySql), "SELECT 1 --");
        assert_eq!(shown("SELECT 1 # x", LITE), "SELECT 1 # x;");
    }

    #[test]
    fn ring_keeps_the_newest_entries_with_increasing_seq() {
        let log = SqlLog::new();
        for index in 0..(LOG_CAP + 5) {
            log.record(&format!("SELECT {index}"), LITE);
        }
        let (entries, reset) = log.since(None);
        assert!(reset);
        assert_eq!(entries.len(), LOG_CAP);
        assert_eq!(entries[0].seq, 6);
        assert_eq!(entries[0].sql, "SELECT 5;");
        assert!(entries
            .windows(2)
            .all(|pair| pair[1].seq == pair[0].seq + 1));
        assert_eq!(entries.last().unwrap().seq, (LOG_CAP + 5) as u64);
    }

    #[test]
    fn since_resets_when_entries_were_lost() {
        let log = SqlLog::new();
        for index in 0..3 {
            log.record(&format!("SELECT {index}"), LITE);
        }
        // Caught up and appending.
        let (entries, reset) = log.since(Some(1));
        assert!(!reset);
        assert_eq!(seqs(&entries), vec![2, 3]);
        let (entries, reset) = log.since(Some(3));
        assert!(!reset);
        assert!(entries.is_empty());
        let (entries, reset) = log.since(Some(0));
        assert!(!reset);
        assert_eq!(seqs(&entries), vec![1, 2, 3]);

        // A seq this log never handed out (another engine's): start over.
        let (entries, reset) = log.since(Some(99));
        assert!(reset);
        assert_eq!(seqs(&entries), vec![1, 2, 3]);

        // Entries after the reader's newest fell off the ring.
        for index in 0..LOG_CAP {
            log.record(&format!("SELECT {index}"), LITE);
        }
        let (entries, reset) = log.since(Some(2));
        assert!(reset);
        assert_eq!(entries.len(), LOG_CAP);
        assert_eq!(entries[0].seq, 4);
        // The oldest kept entry follows right after: nothing was lost.
        let (entries, reset) = log.since(Some(3));
        assert!(!reset);
        assert_eq!(entries.len(), LOG_CAP);
    }

    #[test]
    fn clear_empties_the_ring_but_never_reuses_seq() {
        let log = SqlLog::new();
        log.record("SELECT 1", LITE);
        log.record("SELECT 2", LITE);
        log.clear();
        let (entries, reset) = log.since(None);
        assert!(reset);
        assert!(entries.is_empty());
        // A reader still showing pre-clear entries must drop them.
        let (entries, reset) = log.since(Some(2));
        assert!(reset);
        assert!(entries.is_empty());

        log.record("SELECT 3", LITE);
        let (entries, reset) = log.since(Some(2));
        assert!(reset);
        assert_eq!(seqs(&entries), vec![3]);
        assert_eq!(entries[0].sql, "SELECT 3;");
        let (entries, reset) = log.since(Some(3));
        assert!(!reset);
        assert!(entries.is_empty());
    }

    #[tokio::test]
    async fn subscribers_get_statements_in_order() {
        let log = SqlLog::new();
        let mut statements = log.subscribe();
        log.record("SELECT 1", LITE);
        log.record("SELECT 2", LITE);
        let first = statements.recv().await.unwrap();
        assert_eq!((first.seq, first.sql.as_str()), (1, "SELECT 1;"));
        assert_eq!(statements.recv().await.unwrap().seq, 2);
    }

    fn change(sql: &str) -> Change {
        Change {
            sql: sql.into(),
            ms: 1,
            rows: 1,
        }
    }

    fn drain(changes: &mut mpsc::UnboundedReceiver<Change>) -> Vec<String> {
        std::iter::from_fn(|| changes.try_recv().ok())
            .map(|change| change.sql)
            .collect()
    }

    #[test]
    fn ended_transactions_are_counted_with_their_outcome() {
        let log = SqlLog::new();
        let mut changes = log.take_changes().unwrap();
        let mark = log.ends();
        assert_eq!(log.ended_since(mark), None);
        log.changed(change("A"), true);
        // Settling leftovers is no transaction ending.
        log.settle(false);
        assert_eq!(log.ended_since(mark), None);
        log.changed(change("B"), true);
        log.ended(true);
        assert_eq!(log.ended_since(mark), Some(true));
        assert_eq!(drain(&mut changes), vec!["B"]);
        let mark = log.ends();
        log.ended(false);
        assert_eq!(log.ended_since(mark), Some(false));
    }

    #[test]
    fn changes_wait_for_their_transaction() {
        let log = SqlLog::new();
        // Queued until someone takes the receiver, and only one can.
        log.changed(change("A"), false);
        let mut changes = log.take_changes().unwrap();
        assert!(log.take_changes().is_none());
        assert_eq!(drain(&mut changes), vec!["A"]);

        log.changed(change("B"), true);
        log.changed(change("C"), true);
        assert!(drain(&mut changes).is_empty());
        log.settle(true);
        assert_eq!(drain(&mut changes), vec!["B", "C"]);

        log.changed(change("D"), true);
        log.settle(false);
        log.settle(true);
        assert!(drain(&mut changes).is_empty());

        // Many at once, none dropped.
        for index in 0..5_000 {
            log.changed(change(&index.to_string()), true);
        }
        log.settle(true);
        let all = drain(&mut changes);
        assert_eq!(all.len(), 5_000);
        assert_eq!(all[4_999], "4999");
        // Changes are not part of the console.
        assert!(log.since(None).0.is_empty());
    }

    fn redacted(sql: &str, dialect: Dialect) -> String {
        redact_secrets(sql, dialect).unwrap_or_else(|| sql.to_string())
    }

    #[test]
    fn redacts_postgres_role_passwords() {
        let pg = Dialect::Postgres;
        assert_eq!(
            redacted(
                "CREATE ROLE app WITH LOGIN ENCRYPTED PASSWORD 'se''cret' VALID UNTIL '2030-01-01'",
                pg
            ),
            "CREATE ROLE app WITH LOGIN ENCRYPTED PASSWORD '********' VALID UNTIL '2030-01-01'"
        );
        assert_eq!(
            redacted("ALTER USER bob PASSWORD E'it\\'s'", pg),
            "ALTER USER bob PASSWORD E'********'"
        );
        assert_eq!(
            redacted("alter role bob with password $pw$x'y$pw$", pg),
            "alter role bob with password '********'"
        );
        // A standard string ends at its quote even after a backslash.
        assert_eq!(
            redacted("ALTER ROLE r PASSWORD 'a\\'; SELECT 'b'", pg),
            "ALTER ROLE r PASSWORD '********'; SELECT 'b'"
        );
        // An apostrophe in a comment does not open a string.
        assert_eq!(
            redacted("-- don't log this\nALTER ROLE r PASSWORD 'pw'", pg),
            "-- don't log this\nALTER ROLE r PASSWORD '********'"
        );
        assert_eq!(
            redacted(
                "CREATE USER MAPPING FOR u SERVER s OPTIONS (user 'u', password 'p')",
                pg
            ),
            "CREATE USER MAPPING FOR u SERVER s OPTIONS (user 'u', password '********')"
        );
        assert!(redact_secrets("ALTER ROLE r PASSWORD NULL", pg).is_none());
    }

    #[test]
    fn redacts_mysql_account_passwords() {
        let my = Dialect::MySql;
        assert_eq!(
            redacted(
                "CREATE USER 'u'@'%' IDENTIFIED BY 'p\\'w''d' REQUIRE SSL",
                my
            ),
            "CREATE USER 'u'@'%' IDENTIFIED BY '********' REQUIRE SSL"
        );
        assert_eq!(
            redacted(
                "ALTER USER u IDENTIFIED WITH caching_sha2_password BY \"pw\" \
                 REPLACE 'old' RETAIN CURRENT PASSWORD",
                my
            ),
            "ALTER USER u IDENTIFIED WITH caching_sha2_password BY '********' \
             REPLACE '********' RETAIN CURRENT PASSWORD"
        );
        assert_eq!(
            redacted(
                "CREATE USER u IDENTIFIED WITH 'mysql_native_password' AS '*ABC'",
                my
            ),
            "CREATE USER u IDENTIFIED WITH 'mysql_native_password' AS '********'"
        );
        assert_eq!(
            redacted("SET PASSWORD FOR 'u'@'localhost' = 'new'", my),
            "SET PASSWORD FOR 'u'@'localhost' = '********'"
        );
        assert_eq!(
            redacted("set password = PASSWORD('x')", my),
            "set password = PASSWORD('********')"
        );
        assert_eq!(
            redacted(
                "GRANT ALL ON *.* TO u IDENTIFIED BY PASSWORD _utf8mb4'*hash'",
                my
            ),
            "GRANT ALL ON *.* TO u IDENTIFIED BY PASSWORD _utf8mb4'********'"
        );
        assert!(redact_secrets("ALTER USER u IDENTIFIED BY RANDOM PASSWORD", my).is_none());
        assert!(redact_secrets("ALTER USER u PASSWORD EXPIRE INTERVAL 90 DAY", my).is_none());
    }

    #[test]
    fn redacts_mssql_login_passwords() {
        let ms = Dialect::Mssql;
        assert_eq!(
            redacted(
                "CREATE LOGIN [app] WITH PASSWORD = N'p''w' MUST_CHANGE, CHECK_POLICY = ON",
                ms
            ),
            "CREATE LOGIN [app] WITH PASSWORD = N'********' MUST_CHANGE, CHECK_POLICY = ON"
        );
        assert_eq!(
            redacted(
                "ALTER LOGIN app WITH PASSWORD = 'new' OLD_PASSWORD = 'old'",
                ms
            ),
            "ALTER LOGIN app WITH PASSWORD = '********' OLD_PASSWORD = '********'"
        );
    }

    #[test]
    fn redacts_connection_strings_and_credentials() {
        let pg = Dialect::Postgres;
        assert_eq!(
            redacted(
                "CREATE SUBSCRIPTION s CONNECTION 'host=db user=rep password=s3cret dbname=app' \
                 PUBLICATION p",
                pg
            ),
            "CREATE SUBSCRIPTION s CONNECTION '********' PUBLICATION p"
        );
        assert_eq!(
            redacted("SELECT dblink_connect('c', 'dbname=app PASSWORD = x')", pg),
            "SELECT dblink_connect('c', '********')"
        );
        assert_eq!(
            redacted(
                "SELECT dblink_connect('postgresql://rep:s3cret@db/app')",
                pg
            ),
            "SELECT dblink_connect('********')"
        );
        assert!(redact_secrets("SELECT 'https://example.com/a@b', 'x://u@h'", pg).is_none());
        assert!(redact_secrets("SELECT 'password reset sent'", pg).is_none());

        let ms = Dialect::Mssql;
        assert_eq!(
            redacted(
                "CREATE DATABASE SCOPED CREDENTIAL c WITH IDENTITY = 'app', SECRET = N'k''ey'",
                ms
            ),
            "CREATE DATABASE SCOPED CREDENTIAL c WITH IDENTITY = 'app', SECRET = N'********'"
        );
        assert_eq!(
            redacted("ALTER CREDENTIAL c WITH IDENTITY = 'u', SECRET = 'x'", ms),
            "ALTER CREDENTIAL c WITH IDENTITY = 'u', SECRET = '********'"
        );
    }

    #[test]
    fn redacts_sql_server_login_procedures_and_driver_strings() {
        let ms = Dialect::Mssql;
        assert_eq!(
            redacted(
                "SELECT * FROM OPENROWSET('SQLNCLI', 'Server=s;UID=u;PWD=p@ss;', 'SELECT 1')",
                ms
            ),
            "SELECT * FROM OPENROWSET('SQLNCLI', '********', 'SELECT 1')"
        );
        assert_eq!(
            redacted(
                "SELECT * FROM OPENDATASOURCE('SQLNCLI', 'Data Source=s;User ID=u;Password=x').d.dbo.t",
                ms
            ),
            "SELECT * FROM OPENDATASOURCE('SQLNCLI', '********').d.dbo.t"
        );
        assert_eq!(
            redacted("EXEC sp_password 'old', 'new', 'app'", ms),
            "EXEC sp_password '********', '********', 'app'"
        );
        assert_eq!(
            redacted("EXEC sp_password NULL, N'n''ew', 'app'", ms),
            "EXEC sp_password NULL, N'********', 'app'"
        );
        assert_eq!(
            redacted(
                "EXEC sys.sp_password @old = 'a', @new = 'b', @loginame = 'app'",
                ms
            ),
            "EXEC sys.sp_password @old = '********', @new = '********', @loginame = 'app'"
        );
        assert_eq!(
            redacted("EXEC sp_addlogin 'app', 'pw', 'appdb'", ms),
            "EXEC sp_addlogin 'app', '********', 'appdb'"
        );
        assert_eq!(
            redacted("EXEC sp_addlogin @loginame = 'app', @passwd = 'pw'", ms),
            "EXEC sp_addlogin @loginame = 'app', @passwd = '********'"
        );
        assert_eq!(
            redacted(
                "EXEC sp_addlinkedsrvlogin 'srv', 'false', NULL, 'rmt', 'pw'",
                ms
            ),
            "EXEC sp_addlinkedsrvlogin 'srv', 'false', NULL, 'rmt', '********'"
        );
        assert_eq!(
            redacted(
                "EXEC sp_addlinkedsrvlogin @rmtsrvname = N'srv', @useself = N'False', \
                 @rmtuser = N'rmt', @rmtpassword = N'pw'",
                ms
            ),
            "EXEC sp_addlinkedsrvlogin @rmtsrvname = N'srv', @useself = N'False', \
             @rmtuser = N'rmt', @rmtpassword = N'********'"
        );
        assert!(redact_secrets("EXEC sp_addlinkedsrvlogin 'srv', 'true'", ms).is_none());
        assert_eq!(
            redacted("EXEC [sp_password] 'old', 'new'", ms),
            "EXEC [sp_password] '********', '********'"
        );
        assert_eq!(
            redacted("EXEC sp_setapprole 'reports', N'pw'", ms),
            "EXEC sp_setapprole 'reports', N'********'"
        );
        assert_eq!(
            redacted("EXEC sp_addapprole 'reports', 'pw'", ms),
            "EXEC sp_addapprole 'reports', '********'"
        );
        assert_eq!(
            redacted("EXEC sp_approlepassword 'reports', 'pw'", ms),
            "EXEC sp_approlepassword 'reports', '********'"
        );
        assert_eq!(
            redacted(
                "EXEC sp_change_users_login 'Auto_Fix', 'app', NULL, 'pw'",
                ms
            ),
            "EXEC sp_change_users_login 'Auto_Fix', 'app', NULL, '********'"
        );
        assert_eq!(
            redacted(
                "DECLARE @password nvarchar(50) = N'pw', @user sysname = 'app'",
                ms
            ),
            "DECLARE @password nvarchar(50) = N'********', @user sysname = 'app'"
        );
        assert!(redact_secrets("SELECT 1 WHERE @password IS NULL", ms).is_none());
        assert!(redact_secrets("SELECT 'cd $PWD/bin'", ms).is_none());
    }

    #[test]
    fn console_and_history_hide_url_passwords() {
        let log = SqlLog::new();
        let mut changes = log.take_changes().unwrap();
        log.record_command(
            "db.getSiblingDB(\"s\").c.insertOne({ link: \"mongodb://app:s3cret@db/x\" })",
        );
        log.record("SELECT 'postgres://u:pw@h/d'", Dialect::Postgres);
        let shown: Vec<String> = log.since(None).0.into_iter().map(|e| e.sql).collect();
        assert_eq!(
            shown,
            [
                "db.getSiblingDB(\"s\").c.insertOne({ link: \"mongodb://app:****@db/x\" })",
                "SELECT '********';",
            ]
        );
        log.changed(
            Change {
                sql: "x mongodb://a:b@c".into(),
                ms: 1,
                rows: 1,
            },
            false,
        );
        assert_eq!(changes.try_recv().unwrap().sql, "x mongodb://a:****@c");
    }

    #[test]
    fn redaction_errs_on_the_side_of_hiding_and_reaches_the_console() {
        assert!(redact_secrets("SELECT password FROM users WHERE name = 'bob'", LITE).is_none());
        assert!(redact_secrets("SELECT 'IDENTIFIED BY x'", LITE).is_none());
        assert_eq!(
            redacted("UPDATE users SET password = 'x' WHERE id = 1", LITE),
            "UPDATE users SET password = '********' WHERE id = 1"
        );
        let log = SqlLog::new();
        log.record("CREATE USER u IDENTIFIED BY 'pw'", Dialect::MySql);
        assert_eq!(
            log.since(None).0[0].sql,
            "CREATE USER u IDENTIFIED BY '********';"
        );
    }

    #[test]
    fn inlines_sqlite_numbered_and_bare_placeholders() {
        let params = [LogParam::Text("it's".into()), LogParam::Int(5)];
        assert_eq!(
            inline_params(
                "UPDATE \"t?1\" SET \"a\" = ?1 WHERE [id?2] = ?2 AND `n?1` = '?1' -- ?2\n/* ?1 */",
                &params,
                Dialect::Sqlite,
            ),
            "UPDATE \"t?1\" SET \"a\" = 'it''s' WHERE [id?2] = 5 AND `n?1` = '?1' -- ?2\n/* ?1 */"
        );
        assert_eq!(
            inline_params("SELECT ?, ?, ?", &params, Dialect::Sqlite),
            "SELECT 'it''s', 5, ?"
        );
        assert_eq!(
            inline_params(
                "SELECT ?2, ?1, ?10",
                &[LogParam::Null, LogParam::Float(1.5)],
                Dialect::Sqlite
            ),
            "SELECT 1.5, NULL, ?10"
        );
        assert_eq!(
            inline_params(
                "SELECT ?1",
                &[LogParam::Blob(vec![0xab, 0x01])],
                Dialect::Sqlite
            ),
            "SELECT X'AB01'"
        );
        // SQLite takes "--" as a comment even without a space.
        assert_eq!(
            inline_params("SELECT 2--?\n, ?", &[LogParam::Int(1)], Dialect::Sqlite),
            "SELECT 2--?\n, 1"
        );
    }

    #[test]
    fn inlines_postgres_dollar_placeholders() {
        let params = [
            LogParam::Text("public".into()),
            LogParam::UInt(16384),
            LogParam::Bool(true),
        ];
        assert_eq!(
            inline_params(
                "SELECT $1, $2::oid, $3, '$1', \"$2\", $$ $1 $$, $tag$ $2 $tag$, col$1, $4, $10 \
                 -- $1\n FROM t /* $2 */ WHERE a = ($1::text)::integer",
                &params,
                Dialect::Postgres,
            ),
            "SELECT 'public', 16384::oid, TRUE, '$1', \"$2\", $$ $1 $$, $tag$ $2 $tag$, col$1, $4, $10 \
             -- $1\n FROM t /* $2 */ WHERE a = ('public'::text)::integer"
        );
        assert_eq!(
            inline_params(
                "SELECT $1",
                &[LogParam::Blob(vec![0xff])],
                Dialect::Postgres
            ),
            "SELECT '\\xFF'::bytea"
        );
    }

    #[test]
    fn postgres_backslashes_escape_only_in_e_strings() {
        let five = [LogParam::Int(5)];
        assert_eq!(
            inline_params("SELECT E'it\\'s $1', e'\\\\', $1", &five, Dialect::Postgres),
            "SELECT E'it\\'s $1', e'\\\\', 5"
        );
        assert_eq!(
            inline_params("SELECT 'C:\\', $1", &five, Dialect::Postgres),
            "SELECT 'C:\\', 5"
        );
        // An identifier ending in E is no prefix.
        assert_eq!(
            inline_params("SELECT note'C:\\', $1", &five, Dialect::Postgres),
            "SELECT note'C:\\', 5"
        );
    }

    #[test]
    fn inlines_mysql_question_marks_with_backslash_strings() {
        let params = [
            LogParam::Text("O'Re\\illy".into()),
            LogParam::Null,
            LogParam::UInt(7),
        ];
        assert_eq!(
            inline_params(
                "SELECT ? FROM `a?` WHERE b = 'x\\'?' AND c <=> ? # ?\nAND d = \"?\" AND e = ?",
                &params,
                Dialect::MySql,
            ),
            "SELECT 'O''Re\\\\illy' FROM `a?` WHERE b = 'x\\'?' AND c <=> NULL # ?\nAND d = \"?\" AND e = 7"
        );
        // ?1 is not a MySQL placeholder form: the ? binds, the 1 stays.
        assert_eq!(
            inline_params("SELECT ?1", &[LogParam::Int(4)], Dialect::MySql),
            "SELECT 41"
        );
        // "--" starts a comment only before whitespace, a control character
        // or the end.
        let two = [LogParam::Int(1), LogParam::Int(3)];
        assert_eq!(
            inline_params("SELECT 2--?, ? -- ?\n", &two, Dialect::MySql),
            "SELECT 2--1, 3 -- ?\n"
        );
        assert_eq!(
            inline_params("SELECT ?--\t?\n, ? --", &two, Dialect::MySql),
            "SELECT 1--\t?\n, 3 --"
        );
    }

    #[test]
    fn inlines_mssql_at_p_placeholders() {
        let params = [
            LogParam::Text("dbo".into()),
            LogParam::Text("한글".into()),
            LogParam::Bool(false),
        ];
        assert_eq!(
            inline_params(
                "SELECT @P1, @p2, [col@P1]]x], '@P2', @@P1, x@P1, @P1x, @P3, @P4 \
                 FROM t WHERE (c = CAST(@P2 AS NVARCHAR(MAX)) OR (c IS NULL AND @P2 IS NULL))",
                &params,
                Dialect::Mssql,
            ),
            "SELECT N'dbo', N'한글', [col@P1]]x], '@P2', @@P1, x@P1, @P1x, 0, @P4 \
             FROM t WHERE (c = CAST(N'한글' AS NVARCHAR(MAX)) OR (c IS NULL AND N'한글' IS NULL))"
        );
    }

    #[test]
    fn leaves_sql_alone_without_params_or_with_unterminated_quotes() {
        assert_eq!(inline_params("SELECT ?", &[], Dialect::MySql), "SELECT ?");
        assert_eq!(
            inline_params("SELECT ?1, 'open ?1", &[LogParam::Int(1)], Dialect::Sqlite),
            "SELECT 1, 'open ?1"
        );
        assert_eq!(
            inline_params(
                "SELECT $1 /* open $1",
                &[LogParam::Int(1)],
                Dialect::Postgres
            ),
            "SELECT 1 /* open $1"
        );
    }
}
