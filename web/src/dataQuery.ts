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
  table: string;
  filter?: FilterState | null;
  sorts?: SortState[] | null;
  pageSize: number;
  page?: number;
}

const NUMBER_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

export function escapeSqlIdentifier(name: string): string {
  return `"${name.split('"').join('""')}"`;
}

export function quoteIdentifier(name: string): string {
  return name.split(".").map(escapeSqlIdentifier).join(".");
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

export function buildFragment(row: FilterRow): string | null {
  const column = escapeSqlIdentifier(row.column);
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

export function buildWhere(filter?: FilterState | null): string | null {
  if (!filter) {
    return null;
  }
  const fragments: string[] = [];
  for (const row of filter.rows) {
    if (!row.enabled) {
      continue;
    }
    const fragment = buildFragment(row);
    if (fragment !== null) {
      fragments.push(fragment);
    }
  }
  if (fragments.length === 0) {
    return null;
  }
  return fragments.join(` ${filter.logic} `);
}

export function buildOrderBy(sorts?: SortState[] | null): string | null {
  if (!sorts || sorts.length === 0) {
    return null;
  }
  return sorts
    .map((sort) => `${escapeSqlIdentifier(sort.column)} ${sort.dir === "desc" ? "DESC" : "ASC"}`)
    .join(", ");
}

function sanitizePageSize(pageSize: number): number {
  if (!Number.isFinite(pageSize)) {
    return 100;
  }
  return Math.max(1, Math.trunc(pageSize));
}

function sanitizePage(page: number | undefined): number {
  if (page === undefined || !Number.isFinite(page)) {
    return 0;
  }
  return Math.max(0, Math.trunc(page));
}

export function buildDataSql(input: DataSqlInput): string {
  const parts = [`SELECT * FROM ${quoteIdentifier(input.table)}`];
  const where = buildWhere(input.filter);
  if (where !== null) {
    parts.push(`WHERE ${where}`);
  }
  const order = buildOrderBy(input.sorts);
  if (order !== null) {
    parts.push(`ORDER BY ${order}`);
  }
  const size = sanitizePageSize(input.pageSize);
  const page = sanitizePage(input.page);
  parts.push(`LIMIT ${size}`);
  if (page > 0) {
    parts.push(`OFFSET ${page * size}`);
  }
  return parts.join(" ");
}

export function buildDataSqlUnlimited(input: Omit<DataSqlInput, "pageSize" | "page">): string {
  const parts = [`SELECT * FROM ${quoteIdentifier(input.table)}`];
  const where = buildWhere(input.filter);
  if (where !== null) {
    parts.push(`WHERE ${where}`);
  }
  const order = buildOrderBy(input.sorts);
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
