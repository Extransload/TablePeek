import { quoteIdent } from "./ddl";
import type { SqlDialect } from "./engines/sqlDialect";

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
  // The data tab's "allow filtering" switch: the dialect's
  // allowFilteringClause goes at the end of its reads (CQL's ALLOW
  // FILTERING, which scans the whole table).
  allowFiltering?: boolean;
}

export const EMPTY_FILTER: FilterState = { rows: [], logic: "AND" };

export type SortDir = "asc" | "desc";

export interface SortState {
  column: string;
  dir: SortDir;
}

export interface DataSqlInput {
  dialect: SqlDialect;
  table: string;
  filter?: FilterState | null;
  sorts?: SortState[] | null;
  pk?: string[] | null;
  columns?: string[] | null;
  // Columns read after the table's own that tell its rows apart
  // (SqlDialect.rowIdentity); none by default.
  identity?: readonly string[];
  limit: number;
  offset?: number;
}

const NUMBER_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

export function escapeSqlIdentifier(name: string, dialect: SqlDialect): string {
  return quoteIdent(dialect, name);
}

export function quoteIdentifier(name: string, dialect: SqlDialect): string {
  return name.split(".").map((part) => escapeSqlIdentifier(part, dialect)).join(".");
}

export function quoteLiteral(value: string): string {
  return `'${value.split("'").join("''")}'`;
}

export function literalValue(raw: string, dialect: SqlDialect): string {
  if (/^null$/i.test(raw)) {
    return "NULL";
  }
  if (/^(true|false)$/i.test(raw)) {
    return dialect.booleanLiteral(/^true$/i.test(raw));
  }
  if (NUMBER_RE.test(raw.trim()) && raw.trim() !== "") {
    return raw.trim();
  }
  return dialect.stringLiteral(raw);
}

// LIKE takes the pattern as typed when it has a %; otherwise it matches
// anywhere in the value.
export function likePattern(value: string): string {
  return value.includes("%") ? value : `%${value}%`;
}

// The value's own % and _ (and SQL Server's [ character classes) as plain
// characters, behind the ! the LIKE names as its escape: unlike a backslash,
// it means the same in every dialect and server mode.
function likeEscaped(value: string, dialect: SqlDialect): string {
  const escape = dialect.backslashLike === true ? "\\" : "!";
  return value.replace(dialect.likeSpecials, (ch) => `${escape}${ch}`);
}

// Contains, Has prefix, Has suffix: the value matched as text, whatever the
// column's type (PostgreSQL has no LIKE for numbers or dates).
function textMatch(column: string, pattern: string, negate: boolean, dialect: SqlDialect): string {
  const target = dialect.textMatchColumn?.(column) ?? column;
  const escape = dialect.backslashLike === true ? "" : " ESCAPE '!'";
  return `${target} ${negate ? "NOT LIKE" : "LIKE"} ${dialect.stringLiteral(pattern)}${escape}`;
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

export function buildFragment(row: FilterRow, dialect: SqlDialect): string | null {
  if (row.raw) {
    const condition = row.value.trim();
    if (condition === "") {
      return null;
    }
    // A trailing -- comment would swallow the closing parenthesis.
    return condition.includes("--") ? `(${condition}\n)` : `(${condition})`;
  }
  const column = escapeSqlIdentifier(row.column, dialect);
  const literal = (value: string): string =>
    row.text ? dialect.stringLiteral(value) : literalValue(value, dialect);
  switch (row.op) {
    case "=":
      return `${column} = ${literal(row.value)}`;
    case "≠":
      return `${column} <> ${literal(row.value)}`;
    case "LIKE":
      return `${column} LIKE ${dialect.stringLiteral(likePattern(row.value))}`;
    case "NOT LIKE":
      return `${column} NOT LIKE ${dialect.stringLiteral(likePattern(row.value))}`;
    case "CONTAINS":
      return dialect.containsSql !== undefined
        ? dialect.containsSql(column, literal(row.value))
        : textMatch(column, `%${likeEscaped(row.value, dialect)}%`, false, dialect);
    case "NOT CONTAINS":
      return textMatch(column, `%${likeEscaped(row.value, dialect)}%`, true, dialect);
    case "HAS PREFIX":
      return textMatch(column, `${likeEscaped(row.value, dialect)}%`, false, dialect);
    case "HAS SUFFIX":
      return textMatch(column, `%${likeEscaped(row.value, dialect)}`, false, dialect);
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

export function buildWhere(filter: FilterState | null | undefined, dialect: SqlDialect): string | null {
  if (!filter) {
    return null;
  }
  const fragments: string[] = [];
  for (const row of filter.rows) {
    if (!inEffect(row)) {
      continue;
    }
    const fragment = buildFragment(row, dialect);
    if (fragment !== null) {
      fragments.push(fragment);
    }
  }
  if (fragments.length === 0) {
    return null;
  }
  return fragments.join(` ${filter.logic} `);
}

export function buildOrderBy(sorts: SortState[] | null | undefined, dialect: SqlDialect): string | null {
  if (!sorts || sorts.length === 0) {
    return null;
  }
  return sorts
    .map((sort) => `${escapeSqlIdentifier(sort.column, dialect)} ${sort.dir === "desc" ? "DESC" : "ASC"}`)
    .join(", ");
}

function buildPkOrder(pk: string[] | null | undefined, dialect: SqlDialect): string | null {
  if (!pk || pk.length === 0 || dialect.keyOrder === false) {
    return null;
  }
  return pk.map((column) => escapeSqlIdentifier(column, dialect)).join(", ");
}

// The clause the filter's "allow filtering" switch puts last, when it is on
// and the engine has one.
export function filteringClause(filter: FilterState | null | undefined, dialect: SqlDialect): string | null {
  return filter?.allowFiltering === true ? (dialect.allowFilteringClause ?? null) : null;
}

// What a count was taken under: the WHERE and the "allow filtering" switch.
export function filterKey(filter: FilterState | null | undefined, dialect: SqlDialect): string {
  const where = buildWhere(filter, dialect) ?? "";
  const clause = filteringClause(filter, dialect);
  return clause === null ? where : `${where} ${clause}`;
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

export function selectList(columns: string[] | null | undefined, dialect: SqlDialect): string {
  if (!columns || columns.length === 0) {
    return "*";
  }
  return columns.map((column) => quoteIdentifier(column, dialect)).join(", ");
}

export function buildDataSql(input: DataSqlInput): string {
  const { dialect } = input;
  const identity = (input.identity ?? []).map((column) => `, ${column}`).join("");
  const parts = [`SELECT ${selectList(input.columns, dialect)}${identity} FROM ${quoteIdentifier(input.table, dialect)}`];
  const where = buildWhere(input.filter, dialect);
  if (where !== null) {
    parts.push(`WHERE ${where}`);
  }
  const order = buildOrderBy(input.sorts, dialect) ?? buildPkOrder(input.pk, dialect);
  parts.push(rowWindowSql(dialect, order, sanitizeLimit(input.limit), sanitizeOffset(input.offset)));
  const clause = filteringClause(input.filter, dialect);
  if (clause !== null) {
    parts.push(clause);
  }
  return parts.filter((part) => part !== "").join(" ");
}

// The ordered rows from `offset` on, at most `limit` of them.
export function rowWindowSql(dialect: SqlDialect, order: string | null, limit: number, offset = 0): string {
  return dialect.rowWindow(order, limit, offset);
}

// LIMIT … OFFSET …, as most engines page.
export function limitWindow(order: string | null, limit: number, offset: number): string {
  const window = offset > 0 ? `LIMIT ${limit} OFFSET ${offset}` : `LIMIT ${limit}`;
  return order === null ? window : `ORDER BY ${order} ${window}`;
}

// A table's first rows, the query the editor opens a table with.
export function firstRowsSql(dialect: SqlDialect, quotedTable: string, select = "*", rows = 100): string {
  return dialect.firstRows(quotedTable, select, rows);
}

// What a table view's total counts: its rows under the same filter.
export function buildCountSql(input: Pick<DataSqlInput, "dialect" | "table" | "filter">): string {
  const where = buildWhere(input.filter, input.dialect);
  const clause = filteringClause(input.filter, input.dialect);
  return `SELECT COUNT(*) FROM ${quoteIdentifier(input.table, input.dialect)}${where === null ? "" : ` WHERE ${where}`}${
    clause === null ? "" : ` ${clause}`
  }`;
}

export function buildDataSqlUnlimited(input: Omit<DataSqlInput, "limit" | "offset">): string {
  const { dialect } = input;
  const parts = [`SELECT ${selectList(input.columns, dialect)} FROM ${quoteIdentifier(input.table, dialect)}`];
  const where = buildWhere(input.filter, dialect);
  if (where !== null) {
    parts.push(`WHERE ${where}`);
  }
  const order = buildOrderBy(input.sorts, dialect) ?? buildPkOrder(input.pk, dialect);
  if (order !== null) {
    parts.push(`ORDER BY ${order}`);
  }
  const clause = filteringClause(input.filter, dialect);
  if (clause !== null) {
    parts.push(clause);
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
