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
  | "BETWEEN";

export const FILTER_OPS: FilterOp[] = [
  "=",
  "≠",
  "LIKE",
  "NOT LIKE",
  ">",
  "≥",
  "<",
  "≤",
  "IN",
  "IS NULL",
  "IS NOT NULL",
  "BETWEEN",
];

export type FilterLogic = "AND" | "OR";

export interface FilterRow {
  id: string;
  column: string;
  op: FilterOp;
  value: string;
  enabled: boolean;
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

export function literalValue(raw: string): string {
  if (/^null$/i.test(raw)) {
    return "NULL";
  }
  if (/^(true|false)$/i.test(raw)) {
    return raw.toUpperCase();
  }
  if (NUMBER_RE.test(raw.trim()) && raw.trim() !== "") {
    return raw.trim();
  }
  return quoteLiteral(raw);
}

export function likePattern(value: string): string {
  return value.includes("%") ? value : `%${value}%`;
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

export function buildFragment(row: FilterRow, kind = "postgres"): string | null {
  const column = escapeSqlIdentifier(row.column, kind);
  switch (row.op) {
    case "=":
      return `${column} = ${literalValue(row.value)}`;
    case "≠":
      return `${column} <> ${literalValue(row.value)}`;
    case "LIKE":
      return `${column} LIKE ${quoteLiteral(likePattern(row.value))}`;
    case "NOT LIKE":
      return `${column} NOT LIKE ${quoteLiteral(likePattern(row.value))}`;
    case ">":
      return `${column} > ${literalValue(row.value)}`;
    case "≥":
      return `${column} >= ${literalValue(row.value)}`;
    case "<":
      return `${column} < ${literalValue(row.value)}`;
    case "≤":
      return `${column} <= ${literalValue(row.value)}`;
    case "IN": {
      const items = splitList(row.value);
      if (items.length === 0) {
        return null;
      }
      return `${column} IN (${items.map(literalValue).join(", ")})`;
    }
    case "IS NULL":
      return `${column} IS NULL`;
    case "IS NOT NULL":
      return `${column} IS NOT NULL`;
    case "BETWEEN": {
      const parts = row.value.split(",");
      if (parts.length < 2) {
        return null;
      }
      const from = parts[0].trim();
      const to = parts.slice(1).join(",").trim();
      if (from === "" || to === "") {
        return null;
      }
      return `${column} BETWEEN ${literalValue(from)} AND ${literalValue(to)}`;
    }
  }
}

export function buildWhere(filter?: FilterState | null, kind = "postgres"): string | null {
  if (!filter) {
    return null;
  }
  const fragments: string[] = [];
  for (const row of filter.rows) {
    if (!row.enabled) {
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
  if (order !== null) {
    parts.push(`ORDER BY ${order}`);
  }
  parts.push(`LIMIT ${sanitizeLimit(input.limit)}`);
  const offset = sanitizeOffset(input.offset);
  if (offset > 0) {
    parts.push(`OFFSET ${offset}`);
  }
  return parts.join(" ");
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
