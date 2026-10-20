import { quoteIdent } from "./ddl";
import { t } from "./i18n";

export type DefinitionKind = "view" | "function" | "procedure" | "trigger" | "sequence";

export const DEFINITION_KIND_LABELS: Record<DefinitionKind, string> = {
  view: "뷰",
  function: "함수",
  procedure: "프로시저",
  trigger: "트리거",
  sequence: "시퀀스",
};

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

// Comments and quoted text can't trigger or hide keywords.
function scanText(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(--|#)[^\n]*/g, " ")
    .replace(/'(?:[^'\\]|\\.|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""')
    .replace(/`[^`]*`/g, "``")
    .trim()
    .replace(/^\(+\s*/, "");
}

export function classifyStatement(sql: string): ReviewItem | null {
  const scan = scanText(sql);
  const keyword = (/^([a-z]+)/i.exec(scan)?.[1] ?? "").toLowerCase();
  if (keyword === "" || SESSION_KEYWORDS.has(keyword)) {
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
    // WITH ... DELETE, and EXPLAIN ANALYZE, actually run the data change.
    const runs = keyword === "with" || /^explain\s+(\(.*?\)\s*)?analy[sz]e\b/i.test(scan);
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

export function reviewStatements(statements: string[], mode: SafeMode): ReviewItem[] {
  if (mode === 0) {
    return [];
  }
  return statements
    .map(classifyStatement)
    .filter(
      (item): item is ReviewItem => item !== null && (mode === 2 || item.severity === "danger"),
    );
}

export function explainPrefixFor(engineKind: string): string | null {
  const kind = engineKind.trim().toLowerCase();
  if (kind === "sqlite") {
    return "EXPLAIN QUERY PLAN ";
  }
  if (
    kind === "postgres" ||
    kind === "postgresql" ||
    kind === "cockroach" ||
    kind === "cockroachdb" ||
    kind === "mysql"
  ) {
    return "EXPLAIN ";
  }
  return null;
}

export function isExplainSql(sql: string): boolean {
  return /^\s*explain\b/i.test(sql);
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

export function snippetList(table: string, explainPrefix: string, kind = "postgres"): Snippet[] {
  const quoted = quoteIdent(kind, table);
  return [
    { name: "SELECT LIMIT", sql: `SELECT * FROM ${quoted} LIMIT 100;` },
    { name: "COUNT", sql: `SELECT count(*) FROM ${quoted};` },
    { name: "INSERT", sql: `INSERT INTO ${quoted} (column1, column2) VALUES (value1, value2);` },
    { name: "UPDATE WHERE", sql: `UPDATE ${quoted} SET column1 = value1 WHERE id = 1;` },
    {
      name: "CREATE INDEX",
      sql: `CREATE INDEX ${quoteIdent(kind, `idx_${table}_column1`)} ON ${quoted} (column1);`,
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

function chunkSql(sql: string): SqlChunk[] {
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
    if (ch === "-" && next === "-") {
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
    if (ch === "'" || ch === '"' || ch === "`") {
      const quote = ch;
      let cursor = index + 1;
      while (cursor < len) {
        if (sql[cursor] === "\\") {
          cursor += 2;
          continue;
        }
        if (sql[cursor] === quote) {
          if (quote === "'" && sql[cursor + 1] === "'") {
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

function uppercaseKeywords(text: string): string {
  let result = text;
  for (const keyword of FORMAT_KEYWORDS) {
    const pattern = new RegExp(`\\b${keyword.replace(/ /g, "\\\\s+")}\\b`, "gi");
    result = result.replace(pattern, keyword);
  }
  return result;
}

export function uppercaseSql(sql: string): string {
  return chunkSql(sql)
    .map((chunk) => (chunk.kind === "text" ? uppercaseKeywords(chunk.text) : chunk.text))
    .join("");
}

export function formatSql(sql: string, mode: "beautify" | "minify"): string {
  const chunks = chunkSql(sql);
  if (mode === "minify") {
    return chunks
      .map((chunk) => {
        if (chunk.kind === "text") {
          return chunk.text.replace(/\s+/g, " ");
        }
        return chunk.text;
      })
      .join("")
      .replace(/\s*,\s*/g, ", ")
      .replace(/\(\s+/g, "(")
      .replace(/\s+\)/g, ")")
      .trim();
  }
  let text = chunks
    .map((chunk) => (chunk.kind === "text" ? chunk.text : `\u0000${chunk.text}\u0000`))
    .join("");
  text = text.replace(/\s+/g, " ").trim();
  const pieces = text.split("\u0000");
  const lines: string[] = [];
  for (const piece of pieces) {
    if (piece === "") {
      continue;
    }
    if (piece.length > 1 && (piece.startsWith("--") || piece.startsWith("/*"))) {
      lines.push(piece.trim());
      continue;
    }
    let segment = uppercaseKeywords(piece);
    for (const keyword of FORMAT_BREAK_BEFORE) {
      const pattern = new RegExp(`\\b${keyword.replace(/ /g, "\\\\s+")}\\b`, "gi");
      segment = segment.replace(pattern, `\n${keyword}`);
    }
    for (const keyword of FORMAT_INDENT_BEFORE) {
      const pattern = new RegExp(`\\b${keyword}\\b`, "gi");
      segment = segment.replace(pattern, `\n  ${keyword}`);
    }
    for (const raw of segment.split("\n")) {
      const line = raw.trim().replace(/\s*,\s*/g, ", ");
      if (line !== "") {
        lines.push(line);
      }
    }
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function extractParams(sql: string): string[] {
  const chunks = chunkSql(sql);
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

export function bindParams(sql: string, values: Record<string, string>, literal: (value: string) => string): string {
  const chunks = chunkSql(sql);
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
