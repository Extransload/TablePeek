import { quoteIdent } from "./ddl";

export type FilterOp =
  | "="
  | "≠"
  | "LIKE"
  | "NOT LIKE"
  | ">"
  | "≥"
  | "<"
  | "≤"
  | "IN"
  | "IS NULL"
  | "IS NOT NULL"
  | "BETWEEN"
  | "NOT IN"
  | "NOT BETWEEN"
  | "CONTAINS"
  | "NOT CONTAINS"
  | "HAS PREFIX"
  | "HAS SUFFIX";

export const FILTER_OPS: FilterOp[] = [
  "=",
  "≠",
  "LIKE",
  "NOT LIKE",
  "CONTAINS",
  "NOT CONTAINS",
  "HAS PREFIX",
  "HAS SUFFIX",
  ">",
  "≥",
  "<",
  "≤",
  "IN",
  "NOT IN",
  "IS NULL",
  "IS NOT NULL",
  "BETWEEN",
  "NOT BETWEEN",
];

export type FilterLogic = "AND" | "OR";

export interface FilterRow {
  id: string;
  column: string;
  op: FilterOp;
  value: string;
  // Checked: taken by Apply All.
  enabled: boolean;
  // In effect: chosen by the last Apply (its own, or Apply All while it was
  // checked), as TablePlus marks it "Applied". Rows saved before this existed
  // count their check (see inEffect).
  applied?: boolean;
  // TablePlus's Raw SQL: `value` is a WHERE condition used as written, and
  // column and op are ignored.
  raw?: boolean;
  // The value is text (a Quick Filter on a text column): always a quoted
  // literal, so "12345" or "true" in a text column isn't read as a number or
  // a boolean. A quoted literal still compares with numbers in every dialect.
  text?: boolean;
}

export interface FilterState {
  rows: FilterRow[];
  logic: FilterLogic;
}

export const EMPTY_FILTER: FilterState = { rows: [], logic: "AND" };

export type SortDir = "asc" | "desc";

export interface SortState {
  column: string;
  dir: SortDir;
}

export interface DataSqlInput {
  kind?: string;
  table: string;
  filter?: FilterState | null;
  sorts?: SortState[] | null;
  pk?: string[] | null;
  columns?: string[] | null;
  limit: number;
  offset?: number;
}

const NUMBER_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

export function escapeSqlIdentifier(name: string, kind = "postgres"): string {
  return quoteIdent(kind, name);
}

export function quoteIdentifier(name: string, kind = "postgres"): string {
  return name.split(".").map((part) => escapeSqlIdentifier(part, kind)).join(".");
}

export function quoteLiteral(value: string): string {
  return `'${value.split("'").join("''")}'`;
}

// A text literal as each dialect reads it. MySQL takes a backslash for an
// escape (unless the server runs with NO_BACKSLASH_ESCAPES), so there it is
// doubled; SQL Server needs N or non-ASCII text (Korean) goes through the
// database's code page and no longer matches an nvarchar value.
export function stringLiteral(value: string, kind: string): string {
  if (kind === "mysql" || kind === "mariadb") {
    return quoteLiteral(value.replace(/\\/g, "\\\\"));
  }
  return kind === "mssql" ? `N${quoteLiteral(value)}` : quoteLiteral(value);
}

// SQL Server's bit takes 1 and 0; it has no TRUE.
export function booleanLiteral(value: boolean, kind: string): string {
  if (kind === "mssql") {
    return value ? "1" : "0";
  }
  return value ? "TRUE" : "FALSE";
}

export function literalValue(raw: string, kind = "postgres"): string {
  if (/^null$/i.test(raw)) {
    return "NULL";
  }
  if (/^(true|false)$/i.test(raw)) {
    return booleanLiteral(/^true$/i.test(raw), kind);
  }
  if (NUMBER_RE.test(raw.trim()) && raw.trim() !== "") {
    return raw.trim();
  }
  return stringLiteral(raw, kind);
}

// LIKE takes the pattern as typed when it has a %; otherwise it matches
// anywhere in the value.
export function likePattern(value: string): string {
  return value.includes("%") ? value : `%${value}%`;
}

// The value's own % and _ (and SQL Server's [ character classes) as plain
// characters, behind the ! the LIKE names as its escape: unlike a backslash,
// it means the same in every dialect and server mode.
function likeEscaped(value: string, kind: string): string {
  return value.replace(kind === "mssql" ? /[!%_[]/g : /[!%_]/g, (ch) => `!${ch}`);
}

// Contains, Has prefix, Has suffix: the value matched as text, whatever the
// column's type (PostgreSQL has no LIKE for numbers or dates).
function textMatch(column: string, pattern: string, negate: boolean, kind: string): string {
  const target = kind === "postgres" || kind === "cockroach" ? `CAST(${column} AS TEXT)` : column;
  return `${target} ${negate ? "NOT LIKE" : "LIKE"} ${stringLiteral(pattern, kind)} ESCAPE '!'`;
}

// "a,b" → ["a", "b"]: BETWEEN's bounds, split at the first comma.
function bounds(value: string): [string, string] | null {
  const parts = value.split(",");
  if (parts.length < 2) {
    return null;
  }
  const from = parts[0].trim();
  const to = parts.slice(1).join(",").trim();
  return from === "" || to === "" ? null : [from, to];
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

export function buildFragment(row: FilterRow, kind = "postgres"): string | null {
  if (row.raw) {
    const condition = row.value.trim();
    if (condition === "") {
      return null;
    }
    // A trailing -- comment would swallow the closing parenthesis.
    return condition.includes("--") ? `(${condition}\n)` : `(${condition})`;
  }
  const column = escapeSqlIdentifier(row.column, kind);
  const literal = (value: string): string =>
    row.text ? stringLiteral(value, kind) : literalValue(value, kind);
  switch (row.op) {
    case "=":
      return `${column} = ${literal(row.value)}`;
    case "≠":
      return `${column} <> ${literal(row.value)}`;
    case "LIKE":
      return `${column} LIKE ${stringLiteral(likePattern(row.value), kind)}`;
    case "NOT LIKE":
      return `${column} NOT LIKE ${stringLiteral(likePattern(row.value), kind)}`;
    case "CONTAINS":
      return textMatch(column, `%${likeEscaped(row.value, kind)}%`, false, kind);
    case "NOT CONTAINS":
      return textMatch(column, `%${likeEscaped(row.value, kind)}%`, true, kind);
    case "HAS PREFIX":
      return textMatch(column, `${likeEscaped(row.value, kind)}%`, false, kind);
    case "HAS SUFFIX":
      return textMatch(column, `%${likeEscaped(row.value, kind)}`, false, kind);
    case ">":
      return `${column} > ${literal(row.value)}`;
    case "≥":
      return `${column} >= ${literal(row.value)}`;
    case "<":
      return `${column} < ${literal(row.value)}`;
    case "≤":
      return `${column} <= ${literal(row.value)}`;
    case "IN":
    case "NOT IN": {
      const items = splitList(row.value);
      if (items.length === 0) {
        return null;
      }
      return `${column} ${row.op} (${items.map(literal).join(", ")})`;
    }
    case "IS NULL":
      return `${column} IS NULL`;
    case "IS NOT NULL":
      return `${column} IS NOT NULL`;
    case "BETWEEN":
    case "NOT BETWEEN": {
      const range = bounds(row.value);
      if (range === null) {
        return null;
      }
      return `${column} ${row.op} ${literal(range[0])} AND ${literal(range[1])}`;
    }
  }
}

// Whether a row filters the data now.
export function inEffect(row: FilterRow): boolean {
  return row.applied ?? row.enabled;
}

export function buildWhere(filter?: FilterState | null, kind = "postgres"): string | null {
  if (!filter) {
    return null;
  }
  const fragments: string[] = [];
  for (const row of filter.rows) {
    if (!inEffect(row)) {
      continue;
    }
    const fragment = buildFragment(row, kind);
    if (fragment !== null) {
      fragments.push(fragment);
    }
  }
  if (fragments.length === 0) {
    return null;
  }
  return fragments.join(` ${filter.logic} `);
}

export function buildOrderBy(sorts?: SortState[] | null, kind = "postgres"): string | null {
  if (!sorts || sorts.length === 0) {
    return null;
  }
  return sorts
    .map((sort) => `${escapeSqlIdentifier(sort.column, kind)} ${sort.dir === "desc" ? "DESC" : "ASC"}`)
    .join(", ");
}

function buildPkOrder(pk?: string[] | null, kind = "postgres"): string | null {
  if (!pk || pk.length === 0) {
    return null;
  }
  return pk.map((column) => escapeSqlIdentifier(column, kind)).join(", ");
}

function sanitizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return 100;
  }
  return Math.max(1, Math.trunc(limit));
}

function sanitizeOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset)) {
    return 0;
  }
  return Math.max(0, Math.trunc(offset));
}

export function selectList(columns?: string[] | null, kind = "postgres"): string {
  if (!columns || columns.length === 0) {
    return "*";
  }
  return columns.map((column) => quoteIdentifier(column, kind)).join(", ");
}

export function buildDataSql(input: DataSqlInput): string {
  const kind = input.kind ?? "postgres";
  const parts = [`SELECT ${selectList(input.columns, kind)} FROM ${quoteIdentifier(input.table, kind)}`];
  const where = buildWhere(input.filter, kind);
  if (where !== null) {
    parts.push(`WHERE ${where}`);
  }
  const order = buildOrderBy(input.sorts, kind) ?? buildPkOrder(input.pk, kind);
  parts.push(rowWindowSql(kind, order, sanitizeLimit(input.limit), sanitizeOffset(input.offset)));
  return parts.join(" ");
}

// The ordered rows from `offset` on, at most `limit` of them. SQL Server has
// no LIMIT: it pages with OFFSET … FETCH, which needs an ORDER BY, so a table
// with no order to give is read as it comes.
export function rowWindowSql(kind: string, order: string | null, limit: number, offset = 0): string {
  if (kind === "mssql") {
    return `ORDER BY ${order ?? "(SELECT NULL)"} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
  }
  const window = offset > 0 ? `LIMIT ${limit} OFFSET ${offset}` : `LIMIT ${limit}`;
  return order === null ? window : `ORDER BY ${order} ${window}`;
}

// A table's first rows, the query the editor opens a table with.
export function firstRowsSql(kind: string, quotedTable: string, select = "*", rows = 100): string {
  return kind === "mssql"
    ? `SELECT TOP ${rows} ${select} FROM ${quotedTable};`
    : `SELECT ${select} FROM ${quotedTable} LIMIT ${rows};`;
}

// What a table view's total counts: its rows under the same filter.
export function buildCountSql(input: Pick<DataSqlInput, "kind" | "table" | "filter">): string {
  const kind = input.kind ?? "postgres";
  const where = buildWhere(input.filter, kind);
  return `SELECT COUNT(*) FROM ${quoteIdentifier(input.table, kind)}${where === null ? "" : ` WHERE ${where}`}`;
}

export function buildDataSqlUnlimited(input: Omit<DataSqlInput, "limit" | "offset">): string {
  const kind = input.kind ?? "postgres";
  const parts = [`SELECT ${selectList(input.columns, kind)} FROM ${quoteIdentifier(input.table, kind)}`];
  const where = buildWhere(input.filter, kind);
  if (where !== null) {
    parts.push(`WHERE ${where}`);
  }
  const order = buildOrderBy(input.sorts, kind) ?? buildPkOrder(input.pk, kind);
  if (order !== null) {
    parts.push(`ORDER BY ${order}`);
  }
  return parts.join(" ");
}

export function cycleSort(current: SortState[], column: string, append: boolean): SortState[] {
  const index = current.findIndex((sort) => sort.column === column);
  if (!append) {
    if (index === 0 && current.length === 1) {
      return current[0].dir === "asc" ? [{ column, dir: "desc" }] : [];
    }
    return [{ column, dir: "asc" }];
  }
  if (index < 0) {
    return [...current, { column, dir: "asc" }];
  }
  const existing = current[index];
  if (existing.dir === "asc") {
    const next = current.slice();
    next[index] = { column, dir: "desc" };
    return next;
  }
  return current.filter((sort) => sort.column !== column);
}
