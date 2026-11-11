//! An SQL file's statements, split as the page splits the editor's.
//!
//! A port of the page's web/src/sqlSplit.ts (`splitSqlRanges`),
//! web/src/sqlFile.ts (`fileStatements`) and web/src/importParse.ts
//! (`decoderFor`), rule for rule, so that a file restored on the server is cut
//! into the same statements the page would cut it into. Offsets are bytes into
//! the UTF-8 text rather than the page's UTF-16 units; every rule only looks
//! at ASCII characters, so the cuts fall in the same places.

use encoding_rs::{CoderResult, Decoder, Encoding, UTF_16LE, UTF_8};
use serde::Deserialize;

// What the engine's SQL allows, which decides what ends a statement:
// # comments, backslash escapes and /*! code */ are MySQL's, [names] SQL
// Server's and SQLite's, $tag$ bodies and E'…' strings PostgreSQL's, "/"
// lines and q'[…]' strings Oracle's. Each dialect has its own (the page's
// SqlDialect.lexing, sent as JSON); a flag left out is off.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Lexing {
    pub hash_comments: bool,
    pub backslash_escapes: bool,
    pub bracket_names: bool,
    pub dollar_quotes: bool,
    pub executable_comments: bool,
    pub escape_strings: bool,
    // A line holding just "/" ends any statement, and is the only end of a
    // PL/SQL unit (BEGIN or DECLARE blocks, CREATE PROCEDURE, PACKAGE, …),
    // whose ;s are its own and whose text keeps its final END;.
    pub slash_blocks: bool,
    // q'[…]' and nq'…' strings, closed by the delimiter's pair and a quote.
    pub q_quotes: bool,
    // `//` starts a comment to the end of the line (CQL).
    pub slash_comments: bool,
    // BEGIN [UNLOGGED | COUNTER] BATCH … APPLY BATCH is one statement whose
    // ;s are its own (CQL).
    pub batch_blocks: bool,
}

// A statement as written in the file, and where it is (byte offsets).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqlRange {
    // Its first character (comments written just before it count as part of it).
    pub from: usize,
    // Its first character that isn't a comment.
    pub code_from: usize,
    // Just past its ";" (or the "/" of the line ending it), or the end of the text.
    pub to: usize,
    // The statement itself, trimmed, without the ";".
    pub text: String,
}

// BEGIN opens a block (a trigger's or procedure's body, closed by END) when
// a statement follows it (or MariaDB's NOT ATOMIC); BEGIN; or BEGIN
// TRANSACTION starts a transaction, and "SELECT begin FROM t" is a column.
const BLOCK_STARTERS: &[&str] = &[
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "MERGE",
    "REPLACE",
    "UPSERT",
    "WITH",
    "SET",
    "DECLARE",
    "IF",
    "CASE",
    "WHILE",
    "LOOP",
    "REPEAT",
    "FOR",
    "RETURN",
    "BEGIN",
    "END",
    "CALL",
    "EXEC",
    "EXECUTE",
    "PRINT",
    "RAISERROR",
    "THROW",
    "TRY",
    "CATCH",
    "SIGNAL",
    "RESIGNAL",
    "LEAVE",
    "ITERATE",
    "OPEN",
    "FETCH",
    "CLOSE",
    "CREATE",
    "DROP",
    "ALTER",
    "TRUNCATE",
    "GRANT",
    "REVOKE",
    "LOCK",
    "PERFORM",
    "RAISE",
    "NULL",
    "WAITFOR",
    "GOTO",
    "USE",
];
// MySQL's END IF; / END LOOP lbl; close blocks whose openers aren't
// counted. SQL Server has none of them: there END, then IF @x = 1 …, is a
// block's end and the next statement; only a ; (after at most a label) tells
// the two apart.
const END_UNCOUNTED: &[&str] = &["IF", "LOOP", "WHILE", "REPEAT", "FOR"];
// END CASE closes the CASE counted at its start (and must not count as
// another), END TRY / END CATCH their BEGIN.
const END_NAMED: &[&str] = &["CASE", "TRY", "CATCH"];

// The page's `\s`: JavaScript's white space and line ends. Unlike Rust's
// `char::is_whitespace` it takes in U+FEFF and leaves out U+0085.
fn is_blank(ch: char) -> bool {
    ch == '\u{feff}' || (ch != '\u{85}' && ch.is_whitespace())
}

// The page's `String.trim`.
fn js_trim(text: &str) -> &str {
    text.trim_matches(is_blank)
}

fn is_word_start(byte: u8) -> bool {
    byte.is_ascii_alphabetic() || byte == b'_'
}

// [A-Za-z0-9_]: what `\b` and a label's neighbour are made of.
fn is_word_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || byte == b'_'
}

// [A-Za-z0-9_$]: the rest of a word after its first character.
fn is_name_char(byte: u8) -> bool {
    is_word_char(byte) || byte == b'$'
}

fn in_set(set: &[&str], word: &str) -> bool {
    set.iter().any(|item| item.eq_ignore_ascii_case(word))
}

// The next word after a point, blanks and comments aside (";" counts as
// one), as it is written, and where it ends.
struct Next<'a> {
    word: &'a str,
    end: usize,
}

impl Next<'_> {
    fn is(&self, keyword: &str) -> bool {
        self.word.eq_ignore_ascii_case(keyword)
    }
}

// Which block a BEGIN or CASE opened.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Block {
    Begin,
    Case,
}

// Statements split on ";" outside quotes, comments and BEGIN … END bodies
// (triggers, procedures), with their places. A stretch holding only comments
// isn't a statement: it would run as nothing, or fail. MySQL's /*! … */ is
// code, which mysqldump writes its SET and CREATE VIEW statements in. Where
// "/" lines end statements (Oracle), a PL/SQL unit ends only at one.
pub fn split_sql_ranges(input: &str, lex: &Lexing) -> Vec<SqlRange> {
    Splitter {
        input,
        bytes: input.as_bytes(),
        lex,
        ranges: Vec::new(),
        start: None,
        code_start: None,
        open: Vec::new(),
        unit: false,
    }
    .run()
}

struct Splitter<'a> {
    input: &'a str,
    bytes: &'a [u8],
    lex: &'a Lexing,
    ranges: Vec<SqlRange>,
    start: Option<usize>,
    code_start: Option<usize>,
    // The blocks open at this point, innermost last: a BEGIN body or a CASE.
    open: Vec<Block>,
    // The statement is a PL/SQL unit: its ;s don't end it.
    unit: bool,
}

impl<'a> Splitter<'a> {
    fn find(&self, needle: &str, from: usize) -> Option<usize> {
        self.input[from..].find(needle).map(|at| at + from)
    }

    fn char_at(&self, at: usize) -> Option<char> {
        self.input[at..].chars().next()
    }

    // Where the word ([A-Za-z_][A-Za-z0-9_$]*) starting at `at` ends; `at`
    // when none starts there.
    fn word_end(&self, at: usize) -> usize {
        if at >= self.bytes.len() || !is_word_start(self.bytes[at]) {
            return at;
        }
        let mut end = at + 1;
        while end < self.bytes.len() && is_name_char(self.bytes[end]) {
            end += 1;
        }
        end
    }

    fn flush(&mut self, end: usize, to: usize) {
        if let (Some(start), Some(code_from)) = (self.start, self.code_start) {
            self.ranges.push(SqlRange {
                from: start,
                code_from,
                to,
                text: js_trim(&self.input[start..end]).to_owned(),
            });
        }
        self.start = None;
        self.code_start = None;
        self.open.clear();
        self.unit = false;
    }

    // Marks where a statement begins (its first non-blank character), and
    // where its first code is.
    fn begin(&mut self, at: usize, code: bool) {
        if self.start.is_none() {
            self.start = Some(at);
        }
        if code && self.code_start.is_none() {
            self.code_start = Some(at);
            self.unit = self.lex.slash_blocks && plsql_unit_at(self.input, at);
        }
    }

    // Whether a ; (or the end of the text) follows `from`, after at most one
    // word: END IF; or END LOOP lbl; rather than END, then IF @x = 1.
    fn ends_statement(&self, from: usize) -> bool {
        let at_end = |next: &Next| {
            next.word == ";" || (next.word.is_empty() && next.end >= self.bytes.len())
        };
        let next = self.next_word(from);
        at_end(&next) || (!next.word.is_empty() && at_end(&self.next_word(next.end)))
    }

    // The next word after `from`, blanks and comments aside, and where it ends.
    fn next_word(&self, from: usize) -> Next<'a> {
        let length = self.bytes.len();
        let mut at = from;
        while at < length {
            let ch = self.char_at(at).unwrap_or_default();
            if is_blank(ch) {
                at += ch.len_utf8();
            } else if self.bytes[at..].starts_with(b"--")
                || (ch == '#' && self.lex.hash_comments)
                || (self.lex.slash_comments && self.bytes[at..].starts_with(b"//"))
            {
                at = self.find("\n", at).unwrap_or(length);
            } else if self.bytes[at..].starts_with(b"/*") {
                at = self.find("*/", at + 2).map_or(length, |end| end + 2);
            } else {
                break;
            }
        }
        if at < length && self.bytes[at] == b';' {
            return Next {
                word: &self.input[at..at + 1],
                end: at + 1,
            };
        }
        let end = self.word_end(at);
        Next {
            word: &self.input[at..end],
            end,
        }
    }

    // Whether the "/" at `at` is alone on its line (blanks aside), as SQL*Plus
    // ends a PL/SQL unit, or any statement, with.
    fn lone_slash_at(&self, at: usize) -> bool {
        if self.bytes[at] != b'/' {
            return false;
        }
        let line_start = self.input[..at]
            .rfind('\n')
            .map_or(0, |newline| newline + 1);
        let line_end = self.find("\n", at).unwrap_or(self.bytes.len());
        self.input[line_start..at].chars().all(is_blank)
            && self.input[at + 1..line_end].chars().all(is_blank)
    }

    // Oracle's q'[…]' text (nq'…' too) starting at `at`: where its body starts
    // and what closes it (the delimiter, or its pair, then a quote); none when
    // none starts there.
    fn q_quote_at(&self, at: usize) -> Option<(usize, String)> {
        let bytes = self.bytes;
        let q = if matches!(bytes[at], b'n' | b'N') {
            at + 1
        } else {
            at
        };
        if !matches!(bytes.get(q), Some(b'q' | b'Q'))
            || bytes.get(q + 1) != Some(&b'\'')
            || (at > 0 && (is_name_char(bytes[at - 1]) || bytes[at - 1] == b'#'))
        {
            return None;
        }
        let open = self.char_at(q + 2)?;
        if is_blank(open) {
            return None;
        }
        let close = match open {
            '[' => ']',
            '{' => '}',
            '(' => ')',
            '<' => '>',
            other => other,
        };
        Some((q + 2 + open.len_utf8(), format!("{close}'")))
    }

    fn run(mut self) -> Vec<SqlRange> {
        let input = self.input;
        let bytes = self.bytes;
        let lex = self.lex;
        let length = bytes.len();
        let mut index = 0;

        while index < length {
            let ch = bytes[index];
            let next = bytes.get(index + 1).copied();

            if (ch == b'-' && next == Some(b'-'))
                || (ch == b'#' && lex.hash_comments)
                || (ch == b'/' && next == Some(b'/') && lex.slash_comments)
            {
                self.begin(index, false);
                index = self.find("\n", index).unwrap_or(length);
                continue;
            }
            if ch == b'/' && next == Some(b'*') {
                let executable = lex.executable_comments
                    && (bytes.get(index + 2) == Some(&b'!')
                        || bytes[index + 2..].starts_with(b"M!"));
                self.begin(index, executable);
                index = self.find("*/", index + 2).map_or(length, |end| end + 2);
                continue;
            }
            if ch == b'/' && lex.slash_blocks && self.lone_slash_at(index) {
                self.flush(index, index + 1);
                index += 1;
                continue;
            }
            if lex.q_quotes && matches!(ch, b'n' | b'N' | b'q' | b'Q') {
                if let Some((body, close)) = self.q_quote_at(index) {
                    self.begin(index, true);
                    index = self
                        .find(&close, body)
                        .map_or(length, |end| end + close.len());
                    continue;
                }
            }
            if matches!(ch, b'\'' | b'"' | b'`') {
                self.begin(index, true);
                let quote = ch;
                let escapes = (lex.backslash_escapes && quote != b'`')
                    || (lex.escape_strings && escape_string(bytes, index));
                let mut cursor = index + 1;
                // Byte by byte: a backslash may skip the first byte of a
                // character, whose other bytes are never a quote or a
                // backslash, so the quote found is the same.
                while cursor < length {
                    let inner = bytes[cursor];
                    if inner == b'\\' && escapes && cursor + 1 < length {
                        cursor += 2;
                        continue;
                    }
                    if inner == quote {
                        if bytes.get(cursor + 1) == Some(&quote) {
                            cursor += 2;
                            continue;
                        }
                        cursor += 1;
                        break;
                    }
                    cursor += 1;
                }
                index = cursor;
                continue;
            }
            if ch == b'[' && lex.bracket_names {
                self.begin(index, true);
                index = self.find("]", index + 1).map_or(length, |end| end + 1);
                continue;
            }
            if ch == b'$' && lex.dollar_quotes {
                // A $tag$ ($[A-Za-z0-9_]*$) opens a body closed by the same tag.
                let mut tag_end = index + 1;
                while tag_end < length && is_word_char(bytes[tag_end]) {
                    tag_end += 1;
                }
                if bytes.get(tag_end) == Some(&b'$') {
                    self.begin(index, true);
                    let tag = &input[index..=tag_end];
                    index = self
                        .find(tag, tag_end + 1)
                        .map_or(length, |end| end + tag.len());
                    continue;
                }
            }
            if ch == b';' {
                if !self.open.is_empty() || self.unit {
                    index += 1;
                    continue;
                }
                self.flush(index, index + 1);
                index += 1;
                continue;
            }
            if is_word_start(ch) {
                self.begin(index, true);
                let after = self.word_end(index);
                let word = &input[index..after];
                // A PL/SQL unit's words don't matter: only a "/" line ends it.
                if self.unit {
                    index = after;
                    continue;
                }
                // @end, NEW.end, :begin, #case… are names, not keywords; lbl:BEGIN
                // is a label and its block.
                let before = if index > 0 {
                    Some(bytes[index - 1])
                } else {
                    None
                };
                if matches!(before, Some(b'@' | b'.' | b'$' | b'#'))
                    || (before == Some(b':') && !(index >= 2 && is_word_char(bytes[index - 2])))
                {
                    index = after;
                    continue;
                }
                if word.eq_ignore_ascii_case("BEGIN") {
                    let mut next = self.next_word(after);
                    // A labelled statement (MySQL's "l: LOOP"): the word after the label.
                    if !next.word.is_empty() {
                        let colon = self.input[next.end..]
                            .char_indices()
                            .find(|&(_, ch)| !is_blank(ch))
                            .map(|(at, _)| at + next.end);
                        if let Some(colon) = colon {
                            if bytes[colon] == b':'
                                && bytes.get(colon + 1) != Some(&b':')
                                && bytes.get(colon + 1) != Some(&b'=')
                            {
                                next = self.next_word(colon + 1);
                            }
                        }
                    }
                    let batch = lex.batch_blocks
                        && (next.is("BATCH")
                            || ((next.is("UNLOGGED") || next.is("COUNTER"))
                                && self.next_word(next.end).is("BATCH")));
                    let block = if next.is("NOT") {
                        self.next_word(next.end).is("ATOMIC")
                    } else {
                        in_set(BLOCK_STARTERS, next.word)
                    };
                    if batch || block {
                        self.open.push(Block::Begin);
                    }
                } else if word.eq_ignore_ascii_case("APPLY")
                    && lex.batch_blocks
                    && self.next_word(after).is("BATCH")
                {
                    self.open.pop();
                } else if word.eq_ignore_ascii_case("CASE") {
                    self.open.push(Block::Case);
                } else if word.eq_ignore_ascii_case("END") {
                    let named = self.next_word(after);
                    // SQL Server's END CONVERSATION @h is a statement, not a block's end.
                    if named.is("CONVERSATION") {
                        index = named.end;
                        continue;
                    }
                    // Inside a CASE, END IF; / END LOOP l; close a block in one of its
                    // branches (a CASE statement's), and any other END closes the CASE:
                    // CASE … END FOR UPDATE; is a locking read, not MySQL's END FOR, which
                    // counts here only with nothing between it and its ";".
                    if self.open.last() == Some(&Block::Case) {
                        let in_branch = (in_set(END_UNCOUNTED, named.word)
                            && !named.is("FOR")
                            && self.ends_statement(named.end))
                            || (named.is("FOR") && self.next_word(named.end).word == ";");
                        if in_branch {
                            index = named.end;
                            continue;
                        }
                        self.open.pop();
                        index = if named.is("CASE") { named.end } else { after };
                        continue;
                    }
                    let uncounted =
                        in_set(END_UNCOUNTED, named.word) && self.ends_statement(named.end);
                    if !uncounted {
                        self.open.pop();
                    }
                    if uncounted || in_set(END_NAMED, named.word) {
                        index = named.end;
                        continue;
                    }
                }
                index = after;
                continue;
            }
            let ch = self.char_at(index).unwrap_or_default();
            if !is_blank(ch) {
                self.begin(index, true);
            }
            index += ch.len_utf8();
        }
        self.flush(length, length);
        self.ranges
    }
}

// Whether the text at `at` starts a PL/SQL unit, as SQL*Plus reads one (it
// runs to a "/" line): BEGIN, DECLARE, or CREATE [OR REPLACE] [AND RESOLVE |
// COMPILE] [NOFORCE] [[NON]EDITIONABLE] PROCEDURE | FUNCTION | PACKAGE |
// TRIGGER | TYPE | LIBRARY | JAVA, the last word whole. The optional words
// can't start any word after them, so taking each one that is there is the
// only way the whole can match.
fn plsql_unit_at(input: &str, at: usize) -> bool {
    let bytes = input.as_bytes();
    let keyword = |at: usize, word: &str| -> Option<usize> {
        let end = at + word.len();
        (end <= bytes.len() && bytes[at..end].eq_ignore_ascii_case(word.as_bytes())).then_some(end)
    };
    // One or more blanks.
    let blanks = |at: usize| -> Option<usize> {
        let end = input[at..]
            .char_indices()
            .find(|&(_, ch)| !is_blank(ch))
            .map_or(input.len(), |(end, _)| at + end);
        (end > at).then_some(end)
    };
    let whole = |end: usize| !bytes.get(end).is_some_and(|&byte| is_word_char(byte));
    let any_whole = |at: usize, words: &[&str]| {
        words
            .iter()
            .any(|word| keyword(at, word).is_some_and(whole))
    };

    if any_whole(at, &["BEGIN", "DECLARE"]) {
        return true;
    }
    let Some(mut cursor) = keyword(at, "CREATE").and_then(blanks) else {
        return false;
    };
    if let Some(end) = keyword(cursor, "OR")
        .and_then(blanks)
        .and_then(|at| keyword(at, "REPLACE"))
        .and_then(blanks)
    {
        cursor = end;
    }
    if let Some(end) = keyword(cursor, "AND")
        .and_then(blanks)
        .and_then(|at| keyword(at, "RESOLVE").or_else(|| keyword(at, "COMPILE")))
        .and_then(blanks)
    {
        cursor = end;
    }
    if let Some(end) = keyword(cursor, "NOFORCE").and_then(blanks) {
        cursor = end;
    }
    let editionable = keyword(cursor, "NON").unwrap_or(cursor);
    if let Some(end) = keyword(editionable, "EDITIONABLE").and_then(blanks) {
        cursor = end;
    } else if let Some(end) = keyword(cursor, "EDITIONABLE").and_then(blanks) {
        cursor = end;
    }
    any_whole(
        cursor,
        &[
            "PROCEDURE",
            "FUNCTION",
            "PACKAGE",
            "TRIGGER",
            "TYPE",
            "LIBRARY",
            "JAVA",
        ],
    )
}

// Whether the quote at `at` opens PostgreSQL's E'…' string, where a
// backslash escapes: an E (or e) right before it that isn't a name's end.
fn escape_string(bytes: &[u8], at: usize) -> bool {
    bytes[at] == b'\''
        && at >= 1
        && matches!(bytes[at - 1], b'E' | b'e')
        && !(at >= 2 && is_name_char(bytes[at - 2]))
}

// How much of a file is split at a time: a dump runs to gigabytes, more than
// is worth holding as one string.
const PIECE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileStatement {
    // The statement, trimmed, without its ";".
    pub text: String,
    // The line its code starts on, from 1.
    pub line: usize,
    // How far into the file reading had got when it was split off.
    pub bytes_read: u64,
}

/// Push-based reader of an SQL file's statements: bytes in as they arrive,
/// statements out.
///
/// The bytes are split a piece at a time. A piece's last statement may run
/// on into the next piece, so it waits for it: the text is split again from
/// that statement's start, where no quote, comment or BEGIN … END block is
/// open.
pub struct StatementReader {
    // The encoding picked; a BOM at the file's start overrides it.
    encoding: &'static Encoding,
    lexing: Lexing,
    piece: usize,
    // Made from the first piece, which may start with a BOM.
    decoder: Option<Decoder>,
    // Bytes received but not yet a whole piece.
    pending: Vec<u8>,
    // The text not yet split off: the statement that waits for the next piece.
    carry: String,
    // The line `carry` starts on.
    line: usize,
    // The file's bytes decoded so far.
    offset: u64,
}

impl StatementReader {
    // `encoding` is a label as the page offers them (utf-8, euc-kr, utf-16le,
    // windows-1252, macintosh, shift_jis, …); one the decoder doesn't know
    // reads as UTF-8.
    pub fn new(encoding: &str, lexing: Lexing) -> Self {
        Self::with_piece(encoding, lexing, PIECE_BYTES)
    }

    pub(crate) fn with_piece(encoding: &str, lexing: Lexing, piece: usize) -> Self {
        Self {
            encoding: Encoding::for_label_no_replacement(encoding.as_bytes()).unwrap_or(UTF_8),
            lexing,
            piece: piece.max(1),
            decoder: None,
            pending: Vec::new(),
            carry: String::new(),
            line: 1,
            offset: 0,
        }
    }

    // Takes the next bytes of the file, and gives the statements they finish.
    // Nothing is decoded or split until a whole piece is in, so a long
    // statement arriving in many small chunks is split once a piece.
    pub fn push(&mut self, bytes: &[u8]) -> Vec<FileStatement> {
        let mut statements = Vec::new();
        self.pending.extend_from_slice(bytes);
        let whole = self.pending.len() / self.piece * self.piece;
        if whole == 0 {
            return statements;
        }
        let mut pending = std::mem::take(&mut self.pending);
        for piece in pending[..whole].chunks(self.piece) {
            self.read_piece(piece, false, &mut statements);
        }
        pending.drain(..whole);
        self.pending = pending;
        statements
    }

    // The end of the file: every statement left, the last one included.
    pub fn finish(mut self) -> Vec<FileStatement> {
        let mut statements = Vec::new();
        let rest = std::mem::take(&mut self.pending);
        self.read_piece(&rest, true, &mut statements);
        statements
    }

    fn read_piece(&mut self, bytes: &[u8], last: bool, statements: &mut Vec<FileStatement>) {
        let encoding = self.encoding;
        let decoder = self
            .decoder
            .get_or_insert_with(|| decoder_for(bytes, encoding));
        self.offset += bytes.len() as u64;
        decode_into(decoder, bytes, last, &mut self.carry);

        let text = &self.carry;
        let ranges = split_sql_ranges(text, &self.lexing);
        let ready = if last {
            ranges.len()
        } else {
            ranges.len().saturating_sub(1)
        };
        let keep = if last {
            text.len()
        } else {
            ranges.last().map_or(0, |range| range.from)
        };
        let mut counted = 0;
        for range in ranges.into_iter().take(ready) {
            self.line += newlines(text, counted, range.code_from);
            counted = range.code_from;
            statements.push(FileStatement {
                text: range.text,
                line: self.line,
                bytes_read: self.offset,
            });
        }
        self.line += newlines(text, counted, keep);
        self.carry.drain(..keep);
    }
}

fn newlines(text: &str, from: usize, to: usize) -> usize {
    text.as_bytes()[from..to]
        .iter()
        .filter(|&&byte| byte == b'\n')
        .count()
}

// The decoder for a file, from its first bytes: a BOM decides the encoding
// whatever was picked (EF BB BF UTF-8, FF FE UTF-16LE), and is not part of
// the text, as the page's TextDecoder reads it.
fn decoder_for(head: &[u8], encoding: &'static Encoding) -> Decoder {
    let chosen = if head.starts_with(&[0xef, 0xbb, 0xbf]) {
        UTF_8
    } else if head.starts_with(&[0xff, 0xfe]) {
        UTF_16LE
    } else {
        encoding
    };
    chosen.new_decoder_with_bom_removal()
}

// Decodes `bytes` onto the end of `out`, malformed bytes as U+FFFD. A
// character cut at the end is held for the next call, unless `last`.
fn decode_into(decoder: &mut Decoder, mut bytes: &[u8], last: bool, out: &mut String) {
    loop {
        out.reserve(
            decoder
                .max_utf8_buffer_length(bytes.len())
                .unwrap_or(bytes.len()),
        );
        let (result, read, _) = decoder.decode_to_string(bytes, out, last);
        bytes = &bytes[read..];
        if let CoderResult::InputEmpty = result {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mysql() -> Lexing {
        Lexing {
            hash_comments: true,
            backslash_escapes: true,
            executable_comments: true,
            ..Lexing::default()
        }
    }

    fn postgres() -> Lexing {
        Lexing {
            dollar_quotes: true,
            escape_strings: true,
            ..Lexing::default()
        }
    }

    fn mssql() -> Lexing {
        Lexing {
            bracket_names: true,
            ..Lexing::default()
        }
    }

    fn oracle() -> Lexing {
        Lexing {
            slash_blocks: true,
            q_quotes: true,
            ..Lexing::default()
        }
    }

    fn cql() -> Lexing {
        Lexing {
            slash_comments: true,
            batch_blocks: true,
            ..Lexing::default()
        }
    }

    fn texts(input: &str, lex: &Lexing) -> Vec<String> {
        split_sql_ranges(input, lex)
            .into_iter()
            .map(|range| range.text)
            .collect()
    }

    #[test]
    fn lexing_reads_the_pages_json() {
        let lex: Lexing =
            serde_json::from_str(r#"{"hashComments":true,"slashBlocks":true,"qQuotes":true}"#)
                .unwrap();
        assert!(lex.hash_comments && lex.slash_blocks && lex.q_quotes);
        assert!(!lex.backslash_escapes && !lex.batch_blocks);
    }

    #[test]
    fn quotes_hide_semicolons() {
        let lex = Lexing::default();
        assert_eq!(
            texts(
                "SELECT 'a;b'; SELECT \"x;y\"; SELECT 'it''s;'; SELECT `c;d`",
                &lex
            ),
            [
                "SELECT 'a;b'",
                "SELECT \"x;y\"",
                "SELECT 'it''s;'",
                "SELECT `c;d`"
            ]
        );
        // An unclosed quote runs to the end.
        assert_eq!(
            texts("SELECT 1; SELECT 'a; b", &lex),
            ["SELECT 1", "SELECT 'a; b"]
        );
    }

    #[test]
    fn ranges_carry_leading_comments_and_offsets() {
        let input = "  -- c;\n  SELECT 1;  SELECT 2";
        let ranges = split_sql_ranges(input, &Lexing::default());
        assert_eq!(ranges.len(), 2);
        assert_eq!(ranges[0].from, 2);
        assert_eq!(ranges[0].code_from, input.find("SELECT 1").unwrap());
        assert_eq!(ranges[0].to, input.find("1;").unwrap() + 2);
        assert_eq!(ranges[0].text, "-- c;\n  SELECT 1");
        assert_eq!(ranges[1].from, input.find("SELECT 2").unwrap());
        assert_eq!(ranges[1].to, input.len());
        assert_eq!(ranges[1].text, "SELECT 2");
    }

    #[test]
    fn comment_only_text_is_no_statement() {
        let lex = mysql();
        assert!(texts("-- only\n/* x; */\n# y;\n  ;  ", &lex).is_empty());
        assert_eq!(texts("SELECT 1; -- trailing; note", &lex), ["SELECT 1"]);
        assert_eq!(
            texts("/* a */ SELECT 1 /* ; */;", &lex),
            ["/* a */ SELECT 1 /* ; */"]
        );
    }

    #[test]
    fn hash_comments_and_backslashes_are_mysqls() {
        assert_eq!(texts("# c;\nSELECT 1", &mysql()), ["# c;\nSELECT 1"]);
        assert_eq!(
            texts("SELECT 1 # x; SELECT 2", &Lexing::default()),
            ["SELECT 1 # x", "SELECT 2"]
        );
        assert_eq!(
            texts("SELECT 'a\\';b'; SELECT 2", &mysql()),
            ["SELECT 'a\\';b'", "SELECT 2"]
        );
        assert_eq!(
            texts("SELECT 'a\\';b'; SELECT 2", &Lexing::default()),
            ["SELECT 'a\\'", "b'; SELECT 2"]
        );
        // A backslash doesn't escape in a `name`.
        assert_eq!(
            texts("SELECT `a\\`; SELECT 2", &mysql()),
            ["SELECT `a\\`", "SELECT 2"]
        );
    }

    #[test]
    fn executable_comments_are_code() {
        let input = "/*!40101 SET x=1 */;\n/* plain */;\n/*M!100000 SET y=2 */;";
        assert_eq!(
            texts(input, &mysql()),
            ["/*!40101 SET x=1 */", "/*M!100000 SET y=2 */"]
        );
        assert!(texts(input, &Lexing::default()).is_empty());
    }

    #[test]
    fn bracket_names_are_sql_servers() {
        assert_eq!(
            texts("SELECT [a;b] FROM t; SELECT 2", &mssql()),
            ["SELECT [a;b] FROM t", "SELECT 2"]
        );
        assert_eq!(
            texts("SELECT [a;b] FROM t", &Lexing::default()),
            ["SELECT [a", "b] FROM t"]
        );
    }

    #[test]
    fn dollar_quotes_and_escape_strings_are_postgres() {
        let lex = postgres();
        assert_eq!(
            texts("CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; $body$ LANGUAGE sql; SELECT $$a;b$$", &lex),
            ["CREATE FUNCTION f() RETURNS int AS $body$ SELECT 1; $body$ LANGUAGE sql", "SELECT $$a;b$$"]
        );
        // $1 is a parameter, not a tag.
        assert_eq!(
            texts("SELECT $1; SELECT 2", &lex),
            ["SELECT $1", "SELECT 2"]
        );
        assert_eq!(
            texts("SELECT E'a\\';b'; SELECT 2", &lex),
            ["SELECT E'a\\';b'", "SELECT 2"]
        );
        assert_eq!(
            texts("SELECT (e'a\\';b'); SELECT 2", &lex),
            ["SELECT (e'a\\';b')", "SELECT 2"]
        );
        // A name ending in E is no E string.
        assert_eq!(
            texts("SELECT xe'a\\'; SELECT 2", &lex),
            ["SELECT xe'a\\'", "SELECT 2"]
        );
    }

    #[test]
    fn mysql_bodies_keep_their_semicolons() {
        let lex = mysql();
        let trigger = "CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN IF NEW.a > 0 THEN SET NEW.b = 1; END IF; SET NEW.end = 2; END";
        assert_eq!(
            texts(&format!("{trigger}; SELECT 1"), &lex),
            [trigger, "SELECT 1"]
        );
        let procedure =
            "CREATE PROCEDURE p() lbl: BEGIN l2: LOOP LEAVE l2; END LOOP l2; WHILE 1 DO SELECT 1; END WHILE; END lbl";
        assert_eq!(
            texts(&format!("{procedure};\nSELECT 2;"), &lex),
            [procedure, "SELECT 2"]
        );
        let case = "CREATE PROCEDURE p() BEGIN CASE x WHEN 1 THEN IF y THEN SELECT 1; END IF; ELSE BEGIN END; END CASE; END";
        assert_eq!(
            texts(&format!("{case}; SELECT 2"), &lex),
            [case, "SELECT 2"]
        );
        assert_eq!(
            texts("BEGIN NOT ATOMIC SELECT 1; END; SELECT 2", &lex),
            ["BEGIN NOT ATOMIC SELECT 1; END", "SELECT 2"]
        );
    }

    #[test]
    fn begin_alone_is_a_transaction_or_a_name() {
        let lex = mysql();
        assert_eq!(
            texts("BEGIN; INSERT INTO t VALUES (1); COMMIT;", &lex),
            ["BEGIN", "INSERT INTO t VALUES (1)", "COMMIT"]
        );
        assert_eq!(
            texts("BEGIN TRANSACTION; SELECT 1", &lex),
            ["BEGIN TRANSACTION", "SELECT 1"]
        );
        assert_eq!(
            texts("SELECT begin, @end FROM t; SELECT 2", &lex),
            ["SELECT begin, @end FROM t", "SELECT 2"]
        );
        assert_eq!(
            texts(
                "SELECT CASE WHEN a THEN 1 END FROM t FOR UPDATE; SELECT 2",
                &lex
            ),
            [
                "SELECT CASE WHEN a THEN 1 END FROM t FOR UPDATE",
                "SELECT 2"
            ]
        );
    }

    #[test]
    fn sql_server_blocks() {
        let lex = mssql();
        let tried = "CREATE PROCEDURE p AS BEGIN BEGIN TRY SELECT 1; END TRY BEGIN CATCH SELECT 2; END CATCH END";
        assert_eq!(
            texts(&format!("{tried}; SELECT 3"), &lex),
            [tried, "SELECT 3"]
        );
        // END, then IF @y …: the inner block's end and the next statement of the outer one.
        let branches =
            "CREATE PROCEDURE p AS BEGIN IF @x = 1 BEGIN SELECT 1; END IF @y = 2 SELECT 2; END";
        assert_eq!(
            texts(&format!("{branches}; SELECT 3"), &lex),
            [branches, "SELECT 3"]
        );
        assert_eq!(
            texts("END CONVERSATION @h; SELECT 1", &lex),
            ["END CONVERSATION @h", "SELECT 1"]
        );
    }

    #[test]
    fn oracle_units_end_at_slash_lines() {
        let lex = oracle();
        let input = "BEGIN\n  x := 1;\nEND;\n/\nSELECT 4 / 2 FROM dual;\nSELECT q'[a;b]', nq'{c;}' FROM dual\n/\n\
                     CREATE OR REPLACE NONEDITIONABLE PROCEDURE p AS BEGIN NULL; END;\n  /  \n\
                     CREATE TABLE t (a int); DECLARE y int; BEGIN NULL; END;\n/";
        assert_eq!(
            texts(input, &lex),
            [
                "BEGIN\n  x := 1;\nEND;",
                "SELECT 4 / 2 FROM dual",
                "SELECT q'[a;b]', nq'{c;}' FROM dual",
                "CREATE OR REPLACE NONEDITIONABLE PROCEDURE p AS BEGIN NULL; END;",
                "CREATE TABLE t (a int)",
                "DECLARE y int; BEGIN NULL; END;",
            ]
        );
        assert_eq!(
            texts("SELECT q'!a;b!' FROM dual; SELECT 2", &lex),
            ["SELECT q'!a;b!' FROM dual", "SELECT 2"]
        );
        // A word ending in q is no q-quote: 'x;' is a plain string after it.
        assert_eq!(
            texts("SELECT aq'x;' FROM dual; SELECT 2", &lex),
            ["SELECT aq'x;' FROM dual", "SELECT 2"]
        );
        // A CREATE that isn't a unit ends at its ;.
        assert_eq!(
            texts("CREATE TYPES x; SELECT 1", &lex),
            ["CREATE TYPES x", "SELECT 1"]
        );
    }

    #[test]
    fn plsql_unit_starts() {
        for unit in [
            "begin",
            "DECLARE",
            "CREATE PROCEDURE",
            "create or replace function",
            "CREATE AND COMPILE JAVA",
            "CREATE OR REPLACE AND RESOLVE NOFORCE EDITIONABLE PACKAGE",
            "CREATE\n\tTRIGGER",
            "CREATE TYPE",
        ] {
            assert!(plsql_unit_at(unit, 0), "{unit}");
        }
        for other in [
            "BEGINS",
            "CREATE TABLE",
            "CREATE TYPES",
            "CREATEPROCEDURE",
            "CREATE OR PROCEDURE",
        ] {
            assert!(!plsql_unit_at(other, 0), "{other}");
        }
    }

    #[test]
    fn cql_batches_and_slash_comments() {
        let lex = cql();
        let batch = "BEGIN UNLOGGED BATCH INSERT INTO t (a) VALUES (1); UPDATE t SET a = 2 WHERE k = 1; APPLY BATCH";
        assert_eq!(
            texts(&format!("{batch}; // note; x\nSELECT * FROM t;"), &lex),
            [batch, "// note; x\nSELECT * FROM t"]
        );
        assert_eq!(
            texts(
                "BEGIN BATCH INSERT INTO t (a) VALUES (1); APPLY BATCH",
                &lex
            )
            .len(),
            1
        );
        // Without the flags a batch's ;s end statements and // is code.
        assert_eq!(
            texts(
                "BEGIN BATCH INSERT INTO t (a) VALUES (1); APPLY BATCH",
                &Lexing::default()
            )
            .len(),
            2
        );
        assert_eq!(texts("// a; b", &Lexing::default()), ["// a", "b"]);
    }

    #[test]
    fn unicode_blanks_and_text() {
        let lex = Lexing::default();
        let ranges = split_sql_ranges("\u{3000}SELECT '한;글';\u{feff} SELECT 2\u{a0}", &lex);
        assert_eq!(ranges[0].from, '\u{3000}'.len_utf8());
        assert_eq!(
            ranges
                .iter()
                .map(|range| range.text.as_str())
                .collect::<Vec<_>>(),
            ["SELECT '한;글'", "SELECT 2"]
        );
    }

    fn read_all(reader: &mut StatementReader, bytes: &[u8], chunk: usize) -> Vec<FileStatement> {
        bytes
            .chunks(chunk.max(1))
            .flat_map(|part| reader.push(part))
            .collect()
    }

    fn summary(statements: &[FileStatement]) -> Vec<(&str, usize, u64)> {
        statements
            .iter()
            .map(|s| (s.text.as_str(), s.line, s.bytes_read))
            .collect()
    }

    #[test]
    fn reader_waits_for_the_next_piece() {
        let input = b"SELECT 1;\nSELECT 22;\nSELECT 3";
        let expected = [
            ("SELECT 1", 1, 20),
            ("SELECT 22", 2, 29),
            ("SELECT 3", 3, 29),
        ];
        for chunk in [1, 3, 10, input.len()] {
            let mut reader = StatementReader::with_piece("utf-8", Lexing::default(), 10);
            let mut statements = read_all(&mut reader, input, chunk);
            statements.extend(reader.finish());
            assert_eq!(summary(&statements), expected, "chunk {chunk}");
        }
    }

    #[test]
    fn reader_joins_statements_spanning_many_pieces() {
        let input = "-- head\nSELECT 'aaaaaaaaaaaaaaaaaaaa;bbbbbbbbb';\n\n/* c; */\nCREATE TRIGGER t BEGIN SET NEW.a = 1; END;\nSELECT\n2";
        let mut reader = StatementReader::with_piece("utf-8", mysql(), 4);
        let mut statements = read_all(&mut reader, input.as_bytes(), 1);
        statements.extend(reader.finish());
        let got: Vec<_> = statements.iter().map(|s| s.text.as_str()).collect();
        assert_eq!(got, texts(input, &mysql()));
        assert_eq!(
            statements.iter().map(|s| s.line).collect::<Vec<_>>(),
            [2, 5, 6]
        );
        assert!(statements
            .iter()
            .all(|s| s.bytes_read <= input.len() as u64));
        assert_eq!(statements.last().unwrap().bytes_read, input.len() as u64);
    }

    #[test]
    fn reader_holds_a_cut_character() {
        let input = "SELECT '한글';\nSELECT 'é'";
        let mut reader = StatementReader::with_piece("utf-8", Lexing::default(), 1);
        let mut statements = read_all(&mut reader, input.as_bytes(), 1);
        statements.extend(reader.finish());
        // Split off once the next statement's first byte (the 18th) is in.
        assert_eq!(summary(&statements)[..1], [("SELECT '한글'", 1, 18)]);
        assert_eq!(statements[1].text, "SELECT 'é'");
    }

    #[test]
    fn reader_decodes_the_picked_encoding_and_boms() {
        let text = "SELECT '한글';\nSELECT 2";
        let expected = [("SELECT '한글'", 1), ("SELECT 2", 2)];
        let lines = |statements: Vec<FileStatement>| -> Vec<(String, usize)> {
            statements.into_iter().map(|s| (s.text, s.line)).collect()
        };
        let expected: Vec<(String, usize)> =
            expected.iter().map(|&(t, l)| (t.to_owned(), l)).collect();

        let (euc_kr, _, _) = encoding_rs::EUC_KR.encode(text);
        let mut reader = StatementReader::with_piece("euc-kr", Lexing::default(), 3);
        let mut statements = read_all(&mut reader, &euc_kr, 2);
        statements.extend(reader.finish());
        assert_eq!(lines(statements), expected);

        // A UTF-16LE BOM wins over the encoding picked, and isn't text.
        let mut utf16 = vec![0xff, 0xfe];
        utf16.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
        let mut reader = StatementReader::with_piece("euc-kr", Lexing::default(), 5);
        let mut statements = read_all(&mut reader, &utf16, 3);
        statements.extend(reader.finish());
        assert_eq!(lines(statements), expected);

        // So does UTF-8's.
        let mut utf8 = vec![0xef, 0xbb, 0xbf];
        utf8.extend_from_slice(text.as_bytes());
        let mut reader = StatementReader::new("shift_jis", Lexing::default());
        let mut statements = reader.push(&utf8);
        statements.extend(reader.finish());
        assert_eq!(lines(statements), expected);

        // An unknown label reads as UTF-8; malformed bytes become U+FFFD.
        let mut reader = StatementReader::new("no-such-encoding", Lexing::default());
        let mut statements = reader.push("SELECT 'é';".as_bytes());
        statements.extend(reader.push(b"SELECT '\xff'"));
        statements.extend(reader.finish());
        assert_eq!(
            statements
                .iter()
                .map(|s| s.text.as_str())
                .collect::<Vec<_>>(),
            ["SELECT 'é'", "SELECT '\u{fffd}'"]
        );
    }

    #[test]
    fn reader_of_nothing() {
        assert!(StatementReader::new("utf-8", Lexing::default())
            .finish()
            .is_empty());
        let mut reader = StatementReader::with_piece("utf-8", Lexing::default(), 4);
        assert!(reader.push(b"-- only a comment\n").is_empty());
        assert!(reader.finish().is_empty());
    }
}
