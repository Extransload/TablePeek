import { firstRowsSql } from "./dataQuery";
import { quoteIdent } from "./ddl";
import type { SqlDialect } from "./engines/sqlDialect";
import { t } from "./i18n";
import { escapeString, lexingFor, qQuoteAt } from "./sqlSplit";

export type DefinitionKind =
  | "view"
  | "materialized_view"
  | "dictionary"
  | "function"
  | "procedure"
  | "trigger"
  | "sequence"
  | "type"
  | "aggregate"
  | "synonym"
  | "package";

export const DEFINITION_KIND_LABELS: Record<DefinitionKind, string> = {
  view: "뷰",
  materialized_view: "구체화된 뷰",
  dictionary: "딕셔너리",
  function: "함수",
  procedure: "프로시저",
  trigger: "트리거",
  sequence: "시퀀스",
  type: "타입",
  aggregate: "집계 함수",
  synonym: "동의어",
  package: "패키지",
};

// Kinds whose rows open in a data tab, as a table's do.
export function opensData(kind: DefinitionKind): boolean {
  return kind === "view" || kind === "materialized_view" || kind === "dictionary";
}

export function definitionTabTitle(kind: DefinitionKind, name: string): string {
  return `${t(DEFINITION_KIND_LABELS[kind])} ${t("정의")}: ${name}`;
}

// 0: off · 1: stop before destructive statements · 2: stop before anything that writes.
export type SafeMode = 0 | 1 | 2;

export interface ReviewItem {
  sql: string;
  keyword: string;
  severity: "danger" | "write";
  // i18n key explaining what the statement does.
  reason: string;
}

const READ_KEYWORDS = new Set(["select", "explain", "show", "describe", "desc", "values", "table"]);
const SESSION_KEYWORDS = new Set([
  "begin",
  "start",
  "commit",
  "rollback",
  "savepoint",
  "release",
  "set",
  "use",
]);
const DML = /\b(insert|update|delete|merge|replace)\b/i;

// Oracle's q'[…]' text, as sqlSplit's qQuoteAt reads it.
const Q_QUOTED = /(?<![\w$#])[nN]?[qQ]'(?:\[[\s\S]*?\]|\{[\s\S]*?\}|\([\s\S]*?\)|<[\s\S]*?>|(\S)[\s\S]*?\1)'/g;

// Comments and quoted text can't trigger or hide keywords.
// # starts a comment only in MySQL (and when the engine isn't known); in
// PostgreSQL it's an operator and in SQL Server a temporary table's name.
// Oracle's q'[…]' text goes first, before the plain quotes misread it.
function scanText(sql: string, dialect?: SqlDialect): string {
  const lex = lexingFor(dialect);
  let text = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(lex.hashComments ? /(--|#)[^\n]*/g : /--[^\n]*/g, " ");
  if (lex.slashComments === true) {
    text = text.replace(/\/\/[^\n]*/g, " ");
  }
  return (lex.qQuotes === true ? text.replace(Q_QUOTED, "''") : text)
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/`[^`]*`/g, "``")
    .trim()
    .replace(/^\(+\s*/, "");
}

// Statements after which the database's tables, views or columns may differ.
const SCHEMA_KEYWORDS = new Set(["create", "drop", "alter", "rename"]);

export function changesSchema(sql: string, dialect?: SqlDialect): boolean {
  const keyword = (/^([a-z]+)/i.exec(scanText(sql, dialect))?.[1] ?? "").toLowerCase();
  return SCHEMA_KEYWORDS.has(keyword);
}

export function classifyStatement(sql: string, dialect?: SqlDialect): ReviewItem | null {
  const scan = scanText(sql, dialect);
  const keyword = (/^([a-z]+)/i.exec(scan)?.[1] ?? "").toLowerCase();
  // Oracle's BEGIN opens a PL/SQL block, which runs code, not a transaction;
  // CQL's BEGIN … BATCH writes every statement in it.
  const lex = lexingFor(dialect);
  const block = keyword === "begin" && (lex.slashBlocks === true || lex.batchBlocks === true);
  // PL/SQL runs whatever its statements do: read them.
  if (lex.slashBlocks === true && PLSQL_STARTS.has(keyword)) {
    return classifyPlsql(sql, scan, keyword);
  }
  // cqlsh's commands (CONSISTENCY, SERIAL CONSISTENCY, TRACING) set the
  // session; LIST ROLES and LIST PERMISSIONS read.
  const cqlSession = lex.batchBlocks === true && ["consistency", "serial", "tracing", "list"].includes(keyword);
  if (keyword === "" || cqlSession || (SESSION_KEYWORDS.has(keyword) && !block)) {
    return null;
  }
  const item = (severity: ReviewItem["severity"], reason: string): ReviewItem => ({
    sql,
    keyword: keyword.toUpperCase(),
    severity,
    reason,
  });
  if (keyword === "pragma") {
    return scan.includes("=") ? item("write", "설정을 변경합니다") : null;
  }
  if (keyword === "with" || keyword === "explain") {
    // WITH ... DELETE, and EXPLAIN ANALYZE, actually run the data change; so
    // does CQL's EXPLAIN, which traces the statement as it runs.
    const runs =
      keyword === "with" || lex.batchBlocks === true || /^explain\s+(\(.*?\)\s*)?analy[sz]e\b/i.test(scan);
    return runs && DML.test(scan) ? item("write", "데이터를 변경합니다") : null;
  }
  if (READ_KEYWORDS.has(keyword)) {
    return null;
  }
  const hasWhere = /\bwhere\b/i.test(scan);
  switch (keyword) {
    case "update":
      return hasWhere
        ? item("write", "조건에 맞는 행을 수정합니다")
        : item("danger", "WHERE 절이 없어 테이블의 모든 행을 수정합니다");
    case "delete":
      return hasWhere
        ? item("write", "조건에 맞는 행을 삭제합니다")
        : item("danger", "WHERE 절이 없어 테이블의 모든 행을 삭제합니다");
    case "drop":
      return item("danger", "객체를 영구히 삭제합니다");
    case "truncate":
      return item("danger", "테이블의 모든 행을 삭제합니다");
    case "alter":
      return item("danger", "테이블이나 객체의 구조를 변경합니다");
    case "insert":
      return item("write", "행을 추가합니다");
    case "create":
      return item("write", "새 객체를 만듭니다");
    default:
      return item("write", "데이터나 스키마를 변경합니다");
  }
}

// What opens PL/SQL in an Oracle script: a block, or a procedure called by
// CALL or SQL*Plus's EXEC.
const PLSQL_STARTS = new Set(["begin", "declare", "call", "exec", "execute"]);

// Built-ins a block may call without changing anything.
const PLSQL_READ_CALLS = /^(dbms_output|dbms_application_info)\.|^(dbms_session|dbms_lock)\.sleep$|^raise_application_error$/;

// Words that only steer a block (or declare in it): what follows the last
// of them in a piece is the statement.
const PLSQL_FLOW = /^(begin|declare|then|else|loop|exception|is|as)$/;
const PLSQL_SKIP = new Set([
  "end", "if", "elsif", "null", "return", "exit", "continue", "goto", "raise", "open", "fetch", "close",
  "cursor", "type", "subtype", "pragma", "procedure", "function", "while", "for", "case", "when",
]);

// A PL/SQL block (or CALL/EXEC) judged by the statements in it, as each
// would be on its own: the most dangerous one decides. Dynamic SQL and
// calls to procedures other than read-only built-ins can't be read, so they
// count as writes (EXECUTE IMMEDIATE, which may drop or alter, as danger).
function classifyPlsql(sql: string, scan: string, keyword: string): ReviewItem | null {
  const item = (severity: ReviewItem["severity"], reason: string, word: string): ReviewItem => ({
    sql,
    keyword: word.toUpperCase(),
    severity,
    reason,
  });
  if (keyword !== "begin" && keyword !== "declare") {
    const callee = (/^\w+\s+([\w$#."]+)/.exec(scan)?.[1] ?? "").replace(/"/g, "").toLowerCase();
    return PLSQL_READ_CALLS.test(callee) ? null : item("write", "프로시저를 호출합니다 (무엇을 바꾸는지 알 수 없습니다)", keyword);
  }
  let found: ReviewItem | null = null;
  for (const piece of scan.split(";")) {
    // The statement after the block's last steering word (THEN, LOOP, …).
    const words = piece.trim().split(/\s+/);
    let start = 0;
    words.forEach((word, at) => {
      if (PLSQL_FLOW.test(word.toLowerCase())) {
        start = at + 1;
      }
    });
    const statement = words.slice(start).join(" ").trim();
    const first = (/^([a-z_]+)/i.exec(statement)?.[1] ?? "").toLowerCase();
    if (first === "" || PLSQL_SKIP.has(first)) {
      continue;
    }
    let next: ReviewItem | null = null;
    if (first === "select") {
      next = /\bfor\s+update\b/i.test(statement) ? item("write", "행을 잠급니다", first) : null;
    } else if (first === "execute" || /^dbms_sql\./i.test(statement)) {
      next = item("danger", "동적 SQL을 실행합니다 (무엇을 바꾸는지 알 수 없습니다)", "execute");
    } else if (["update", "delete", "insert", "merge", "drop", "truncate", "alter", "create"].includes(first)) {
      next = classifyStatement(statement);
    } else if (["commit", "rollback", "savepoint"].includes(first)) {
      next = item("write", "트랜잭션을 끝냅니다", first);
    } else if (!statement.includes(":=")) {
      // A call (proc(…), pkg.proc) or a declaration (n NUMBER): a call is
      // a name followed by its arguments or nothing.
      const call = /^([\w$#."]+)\s*(\(|$)/.exec(statement);
      const callee = (call?.[1] ?? "").replace(/"/g, "").toLowerCase();
      if (call !== null && !PLSQL_READ_CALLS.test(callee)) {
        next = item("write", "프로시저를 호출합니다 (무엇을 바꾸는지 알 수 없습니다)", callee);
      }
    }
    if (next !== null && (found === null || (found.severity === "write" && next.severity === "danger"))) {
      found = { ...next, sql };
    }
  }
  return found;
}

export function reviewStatements(statements: string[], mode: SafeMode, dialect?: SqlDialect): ReviewItem[] {
  if (mode === 0) {
    return [];
  }
  return statements
    .map((statement) => classifyStatement(statement, dialect))
    .filter(
      (item): item is ReviewItem => item !== null && (mode === 2 || item.severity === "danger"),
    );
}

// Leading comments ("-- why\nEXPLAIN …", MySQL's "# why") don't hide an
// EXPLAIN; no statement starts with #, so it is skipped in any dialect. A
// scan, not a regex: one over repeated comment lines can backtrack for seconds.
export function isExplainSql(sql: string): boolean {
  let at = 0;
  for (;;) {
    while (at < sql.length && /\s/.test(sql[at])) {
      at += 1;
    }
    if (sql.startsWith("--", at) || sql[at] === "#") {
      const end = sql.indexOf("\n", at);
      at = end < 0 ? sql.length : end + 1;
    } else if (sql.startsWith("/*", at)) {
      const end = sql.indexOf("*/", at + 2);
      at = end < 0 ? sql.length : end + 2;
    } else {
      return /^explain\b/i.test(sql.slice(at, at + 8));
    }
  }
}

export function planSqlFor(sql: string, prefix: string): string {
  const trimmed = sql.trim();
  if (isExplainSql(trimmed)) {
    return trimmed;
  }
  return `${prefix}${trimmed}`;
}

export interface Snippet {
  name: string;
  sql: string;
}

export function snippetList(table: string, explainPrefix: string, dialect: SqlDialect): Snippet[] {
  const quoted = quoteIdent(dialect, table);
  if (dialect.snippets !== undefined) {
    return [
      { name: dialect.firstRowsName, sql: firstRowsSql(dialect, quoted) },
      ...dialect.snippets(quoted),
      { name: "EXPLAIN", sql: `${explainPrefix}SELECT * FROM ${quoted};` },
    ];
  }
  return [
    { name: dialect.firstRowsName, sql: firstRowsSql(dialect, quoted) },
    { name: "COUNT", sql: `SELECT count(*) FROM ${quoted};` },
    { name: "INSERT", sql: `INSERT INTO ${quoted} (column1, column2) VALUES (value1, value2);` },
    { name: "UPDATE WHERE", sql: `UPDATE ${quoted} SET column1 = value1 WHERE id = 1;` },
    {
      name: "CREATE INDEX",
      sql: `CREATE INDEX ${quoteIdent(dialect, `idx_${table}_column1`)} ON ${quoted} (column1);`,
    },
    { name: "EXPLAIN", sql: `${explainPrefix}SELECT * FROM ${quoted};` },
  ];
}

const FORMAT_BREAK_BEFORE = [
  "SELECT",
  "FROM",
  "WHERE",
  "GROUP BY",
  "HAVING",
  "ORDER BY",
  "LIMIT",
  "OFFSET",
  "UNION ALL",
  "UNION",
  "INSERT INTO",
  "VALUES",
  "UPDATE",
  "SET",
  "DELETE FROM",
  "RETURNING",
  "ON CONFLICT",
  "LEFT OUTER JOIN",
  "RIGHT OUTER JOIN",
  "FULL OUTER JOIN",
  "LEFT JOIN",
  "RIGHT JOIN",
  "INNER JOIN",
  "FULL JOIN",
  "CROSS JOIN",
  "JOIN",
  "CREATE TABLE",
  "ALTER TABLE",
  "DROP TABLE",
];

const FORMAT_INDENT_BEFORE = ["AND", "OR", "ON"];

const FORMAT_KEYWORDS = [
  ...FORMAT_BREAK_BEFORE,
  "AS",
  "NULL",
  "NOT",
  "IN",
  "IS",
  "LIKE",
  "BETWEEN",
  "EXISTS",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "ASC",
  "DESC",
  "DISTINCT",
  "COUNT",
  "SUM",
  "AVG",
  "MIN",
  "MAX",
  "COALESCE",
  "CAST",
  "INTERVAL",
  "WITH",
  "RECURSIVE",
  "BEGIN",
  "COMMIT",
  "ROLLBACK",
  "IF",
  "PRIMARY",
  "KEY",
  "FOREIGN",
  "REFERENCES",
  "DEFAULT",
  "CONSTRAINT",
  "INDEX",
  "UNIQUE",
  "CHECK",
  "VIEW",
  "TRIGGER",
  "FUNCTION",
  "PROCEDURE",
];

interface SqlChunk {
  kind: "text" | "string" | "comment";
  text: string;
}

// Text, string literals (quoted names too) and comments, so a rewrite (keywords
// upper-cased, lines broken, parameters bound) touches only the text. What
// counts as a quote or a comment is the dialect's, as when splitting statements.
function chunkSql(sql: string, dialect?: SqlDialect): SqlChunk[] {
  const lex = lexingFor(dialect);
  const chunks: SqlChunk[] = [];
  let current = "";
  let index = 0;
  const len = sql.length;
  function flushText(): void {
    if (current !== "") {
      chunks.push({ kind: "text", text: current });
      current = "";
    }
  }
  while (index < len) {
    const ch = sql[index];
    const next = index + 1 < len ? sql[index + 1] : "";
    if ((ch === "-" && next === "-") || (ch === "#" && lex.hashComments)) {
      const end = sql.indexOf("\n", index);
      const stop = end < 0 ? len : end;
      flushText();
      chunks.push({ kind: "comment", text: sql.slice(index, stop) });
      index = stop;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", index + 2);
      const stop = end < 0 ? len : end + 2;
      flushText();
      chunks.push({ kind: "comment", text: sql.slice(index, stop) });
      index = stop;
      continue;
    }
    if (ch === "[" && lex.bracketNames) {
      const end = sql.indexOf("]", index + 1);
      const stop = end < 0 ? len : end + 1;
      flushText();
      chunks.push({ kind: "string", text: sql.slice(index, stop) });
      index = stop;
      continue;
    }
    if (ch === "$" && lex.dollarQuotes) {
      const tag = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(index, index + 64))?.[0];
      if (tag !== undefined) {
        const end = sql.indexOf(tag, index + tag.length);
        const stop = end < 0 ? len : end + tag.length;
        flushText();
        chunks.push({ kind: "string", text: sql.slice(index, stop) });
        index = stop;
        continue;
      }
    }
    if (lex.qQuotes === true && /[nNqQ]/.test(ch)) {
      const q = qQuoteAt(sql, index);
      if (q !== null) {
        const end = sql.indexOf(q.close, q.body);
        const stop = end < 0 ? len : end + q.close.length;
        flushText();
        chunks.push({ kind: "string", text: sql.slice(index, stop) });
        index = stop;
        continue;
      }
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      const escapes = (lex.backslashEscapes && quote !== "`") || (lex.escapeStrings && escapeString(sql, index));
      let cursor = index + 1;
      while (cursor < len) {
        if (sql[cursor] === "\\" && escapes) {
          cursor += 2;
          continue;
        }
        if (sql[cursor] === quote) {
          if (sql[cursor + 1] === quote) {
            cursor += 2;
            continue;
          }
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      flushText();
      chunks.push({ kind: "string", text: sql.slice(index, cursor) });
      index = cursor;
      continue;
    }
    current += ch;
    index += 1;
  }
  flushText();
  return chunks;
}

interface SqlToken {
  // name: a variable, parameter or column after a dot (@from, :limit, $1,
  // .order), which is never a keyword however it's spelled.
  kind: "word" | "name" | "space" | "punct" | "string" | "comment" | "line";
  text: string;
}

const TOKEN = /\s+|::|@@?[A-Za-z_][A-Za-z0-9_$#@]*|:[A-Za-z_][A-Za-z0-9_]*|\$[A-Za-z0-9_]+|\.[A-Za-z_][A-Za-z0-9_$]*|[A-Za-z_][A-Za-z0-9_$]*|\d[\d.]*|[\s\S]/g;

// The SQL as tokens: words, names, blanks and punctuation from its text, and
// its strings and comments whole, never looked into.
function tokenizeSql(sql: string, dialect?: SqlDialect): SqlToken[] {
  const tokens: SqlToken[] = [];
  for (const chunk of chunkSql(sql, dialect)) {
    if (chunk.kind === "string") {
      tokens.push({ kind: "string", text: chunk.text });
      continue;
    }
    if (chunk.kind === "comment") {
      tokens.push({ kind: chunk.text.startsWith("/*") ? "comment" : "line", text: chunk.text });
      continue;
    }
    for (const match of chunk.text.matchAll(TOKEN)) {
      const text = match[0];
      tokens.push({
        kind: /^\s/.test(text)
          ? "space"
          : /^[A-Za-z_\d]/.test(text)
            ? "word"
            : text.length > 1 && /^[@:$.]/.test(text) && text !== "::"
              ? "name"
              : "punct",
        text,
      });
    }
  }
  return tokens;
}

const KEYWORD_SET = new Set([...FORMAT_KEYWORDS, ...FORMAT_INDENT_BEFORE].flatMap((keyword) => keyword.split(" ")));
const BREAK_WORDS = FORMAT_BREAK_BEFORE.map((keyword) => keyword.split(" "));
const INDENT_WORDS = new Set(FORMAT_INDENT_BEFORE);

// How many tokens from `at` spell one of `phrases` (blanks between its words
// allowed), longest phrase first; 0 for none.
function phraseAt(tokens: SqlToken[], at: number, phrases: string[][]): number {
  for (const words of [...phrases].sort((a, b) => b.length - a.length)) {
    let cursor = at;
    let matched = true;
    for (let index = 0; index < words.length; index += 1) {
      if (index > 0) {
        if (tokens[cursor]?.kind !== "space") {
          matched = false;
          break;
        }
        cursor += 1;
      }
      const token = tokens[cursor];
      if (token?.kind !== "word" || token.text.toUpperCase() !== words[index]) {
        matched = false;
        break;
      }
      cursor += 1;
    }
    if (matched) {
      return cursor - at;
    }
  }
  return 0;
}

// Keywords upper-cased in the text alone; strings and comments as written.
export function uppercaseSql(sql: string, dialect?: SqlDialect): string {
  return tokenizeSql(sql, dialect)
    .map((token) => (token.kind === "word" && KEYWORD_SET.has(token.text.toUpperCase()) ? token.text.toUpperCase() : token.text))
    .join("");
}

// Beautify: each clause on its own line (AND/OR/ON indented under it), only
// outside parentheses, blanks squeezed to one and keywords upper-cased.
// Minify: one line, letter case as written (uppercaseSql is the caller's call). Neither changes a string literal or a comment; a -- or #
// comment becomes /* … */ on one line, so the code after it isn't commented out.
export function formatSql(sql: string, mode: "beautify" | "minify", dialect?: SqlDialect): string {
  const tokens = tokenizeSql(sql, dialect);
  const lines: string[] = [];
  let line = "";
  let gap = false;
  // The blank before this token held a line break, and the token before it
  // was a string: 'a'\n'b' is one string in PostgreSQL, 'a' 'b' an error.
  let brokenGap = false;
  let previous: SqlToken["kind"] | null = null;
  let depth = 0;
  const breakLine = (indent = ""): void => {
    if (line.trim() !== "") {
      lines.push(line.trimEnd());
    }
    line = indent;
    gap = false;
  };
  const put = (text: string, tight = false): void => {
    if (gap && !tight && line.trim() !== "" && !/[(.]$/.test(line)) {
      line += " ";
    }
    line += text;
    gap = false;
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === "space") {
      gap = true;
      brokenGap = brokenGap || token.text.includes("\n");
      continue;
    }
    const afterString = previous === "string" && brokenGap;
    previous = token.kind;
    brokenGap = false;
    if (token.kind === "line") {
      if (mode === "minify") {
        const body = token.text.replace(/^(--|#)\s?/, "").replaceAll("*/", "* /").replaceAll("/*", "/ *");
        put(`/* ${body} */`);
        continue;
      }
      put(token.text);
      breakLine();
      continue;
    }
    if (token.kind === "string" && afterString) {
      line += "\n";
      put(token.text, true);
      continue;
    }
    if (token.kind === "comment" || token.kind === "string" || token.kind === "name") {
      put(token.text);
      continue;
    }
    if (token.kind === "punct") {
      if (token.text === ",") {
        put(",", true);
        gap = true;
        continue;
      }
      if (token.text === "(") {
        depth += 1;
        put("(");
        continue;
      }
      if (token.text === ")") {
        depth = Math.max(0, depth - 1);
        put(")", true);
        continue;
      }
      if (token.text === ";") {
        put(";", true);
        if (mode === "beautify") {
          breakLine();
          lines.push("");
        }
        depth = 0;
        continue;
      }
      if (token.text === ".") {
        put(".", true);
        continue;
      }
      put(token.text);
      continue;
    }
    // A word.
    if (mode === "beautify" && depth === 0) {
      const span = phraseAt(tokens, index, BREAK_WORDS);
      if (span > 0) {
        breakLine();
        put(tokens.slice(index, index + span).filter((part) => part.kind === "word").map((part) => part.text.toUpperCase()).join(" "));
        index += span - 1;
        continue;
      }
      if (INDENT_WORDS.has(token.text.toUpperCase())) {
        breakLine("  ");
        put(token.text.toUpperCase());
        continue;
      }
    }
    put(mode === "beautify" && KEYWORD_SET.has(token.text.toUpperCase()) ? token.text.toUpperCase() : token.text);
  }
  breakLine();
  return (mode === "minify" ? lines.join(" ") : lines.join("\n")).replace(/\n{3,}/g, "\n\n").trim();
}

export function extractParams(sql: string, dialect?: SqlDialect): string[] {
  const chunks = chunkSql(sql, dialect);
  const names: string[] = [];
  for (const chunk of chunks) {
    if (chunk.kind !== "text") {
      continue;
    }
    const pattern = /(^|[^:\w]):([A-Za-z_][A-Za-z0-9_]*)/g;
    let match = pattern.exec(chunk.text);
    while (match !== null) {
      if (!names.includes(match[2])) {
        names.push(match[2]);
      }
      match = pattern.exec(chunk.text);
    }
  }
  return names;
}

export function bindParams(
  sql: string,
  values: Record<string, string>,
  literal: (value: string) => string,
  dialect?: SqlDialect,
): string {
  const chunks = chunkSql(sql, dialect);
  return chunks
    .map((chunk) => {
      if (chunk.kind !== "text") {
        return chunk.text;
      }
      return chunk.text.replace(/(^|[^:\w]):([A-Za-z_][A-Za-z0-9_]*)/g, (whole, prefix: string, name: string) => {
        if (!(name in values)) {
          return whole;
        }
        return `${prefix}${literal(values[name])}`;
      });
    })
    .join("");
}
