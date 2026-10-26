import type { ValueExpr, WindowedRowSource } from "./grid/windowSource";
import { booleanLiteral, escapeSqlIdentifier, quoteIdentifier, quoteLiteral, stringLiteral } from "./dataQuery";

export { escapeSqlIdentifier, quoteIdentifier, quoteLiteral };

export type ExportFormat = "csv" | "json" | "sql" | "xlsx";

// How fields are written; every option is TablePlus's CSV option of that name.
export interface CsvFormat {
  delimiter?: string;
  // What wraps a field holding the delimiter, a quote or a line break; "" never wraps.
  quote?: string;
  // Between records; CRLF unless set.
  lineBreak?: string;
  // "," writes 1.5 as 1,5.
  decimal?: string;
  // NULL as an empty field (the default) or as the word NULL.
  nullAsEmpty?: boolean;
  lineBreakAsSpace?: boolean;
}

export interface CsvOptions extends CsvFormat {
  header: boolean;
  bom: boolean;
  // Columns whose text values are numbers: NUMERIC and DECIMAL come back as text.
  numeric?: boolean[];
}

// The server's ceiling for one query's rows. Exports that can't page (an
// arbitrary SQL result, a view, a table with no key) read one pass up to it.
export const EXPORT_MAX_ROWS = 500000;

export const EXPORT_MIME: Record<ExportFormat | "zip" | "gzip", string> = {
  csv: "text/csv;charset=utf-8",
  json: "application/json;charset=utf-8",
  sql: "text/plain;charset=utf-8",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip",
  gzip: "application/gzip",
};

export const NUMERIC_TEXT = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

const CSV_EOL = "\r\n";
const INSERT_CHUNK = 1000;

function cellText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

export function csvField(value: unknown, format: CsvFormat = {}, numeric = false): string {
  if (value === null || value === undefined) {
    return format.nullAsEmpty === false ? "NULL" : "";
  }
  let text = cellText(value);
  const decimal = format.decimal ?? ".";
  if (
    decimal !== "." &&
    (typeof value === "number" || typeof value === "bigint" || (numeric && NUMERIC_TEXT.test(text.trim())))
  ) {
    text = text.replace(".", decimal);
  }
  if (format.lineBreakAsSpace) {
    text = text.replace(/\r\n|\r|\n/g, " ");
  }
  const quote = format.quote ?? '"';
  const delimiter = format.delimiter ?? ",";
  if (
    quote !== "" &&
    (text.includes(quote) || text.includes(delimiter) || text.includes("\n") || text.includes("\r"))
  ) {
    return `${quote}${text.split(quote).join(quote + quote)}${quote}`;
  }
  return text;
}

function csvRecord(row: unknown[], columnCount: number, options: CsvOptions): string {
  const fields = new Array<string>(columnCount);
  for (let c = 0; c < columnCount; c += 1) {
    fields[c] = csvField(row[c], options, options.numeric?.[c] ?? false);
  }
  return fields.join(options.delimiter ?? ",");
}

// The file's start: the BOM and the header line, each record ending its line.
export function csvHead(columns: string[], options: CsvOptions): string {
  const head = options.header
    ? `${columns.map((column) => csvField(column, options)).join(options.delimiter ?? ",")}${options.lineBreak ?? CSV_EOL}`
    : "";
  return options.bom ? `﻿${head}` : head;
}

export function csvLines(rows: unknown[][], columnCount: number, options: CsvOptions): string {
  const eol = options.lineBreak ?? CSV_EOL;
  let text = "";
  for (const row of rows) {
    text += csvRecord(row, columnCount, options) + eol;
  }
  return text;
}

export function toCsv(columns: string[], rows: unknown[][], options: CsvOptions): string {
  const lines: string[] = [];
  if (options.header) {
    lines.push(columns.map((column) => csvField(column, options)).join(options.delimiter ?? ","));
  }
  for (const row of rows) {
    lines.push(csvRecord(row, columns.length, options));
  }
  const body = lines.join(options.lineBreak ?? CSV_EOL);
  return options.bom ? `﻿${body}` : body;
}

function jsonObject(columns: string[], row: unknown[]): Record<string, unknown> {
  const item: Record<string, unknown> = {};
  for (let c = 0; c < columns.length; c += 1) {
    item[columns[c]] = row[c] === undefined ? null : row[c];
  }
  return item;
}

export function toJson(columns: string[], rows: unknown[][]): string {
  return JSON.stringify(
    rows.map((row) => jsonObject(columns, row)),
    null,
    2,
  );
}

// toJson's text written a page at a time: "[", the items, then jsonEnd.
export function jsonItems(columns: string[], rows: unknown[][], first: boolean): string {
  let text = "";
  let lead = first ? "\n  " : ",\n  ";
  for (const row of rows) {
    text += lead + JSON.stringify(jsonObject(columns, row), null, 2).replace(/\n/g, "\n  ");
    lead = ",\n  ";
  }
  return text;
}

export function jsonEnd(empty: boolean): string {
  return empty ? "]" : "\n]";
}

// A staged DEFAULT or NOW() on its way into SQL: the keyword, or the
// dialect's current time, where the grid shows a label. `sql` stands in for
// either where a dialect needs its own (SQLite's UPDATE has no DEFAULT).
export class SqlExpression {
  readonly expr: ValueExpr;
  readonly sql: string | null;

  constructor(expr: ValueExpr, sql: string | null = null) {
    this.expr = expr;
    this.sql = sql;
  }
}

// NOW() as each server writes it when it applies one.
export function nowSql(kind: string): string {
  if (kind === "postgres" || kind === "cockroach") {
    return "now()";
  }
  if (kind === "mysql" || kind === "mariadb") {
    return "NOW()";
  }
  return kind === "mssql" ? "GETDATE()" : "CURRENT_TIMESTAMP";
}

function isDefault(value: unknown): boolean {
  return value instanceof SqlExpression && value.expr === "default" && value.sql === null;
}

export function sqlLiteral(value: unknown, kind = "postgres"): string {
  if (value instanceof SqlExpression) {
    return value.sql ?? (value.expr === "now" ? nowSql(kind) : "DEFAULT");
  }
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : quoteLiteral(String(value));
  }
  if (typeof value === "boolean") {
    return booleanLiteral(value, kind);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  return stringLiteral(typeof value === "string" ? value : cellText(value), kind);
}

// The columns a row leaves out: those at DEFAULT, as applying a new row does.
function omitted(row: unknown[], columnCount: number): string {
  let key = "";
  for (let c = 0; c < columnCount; c += 1) {
    if (isDefault(row[c])) {
      key += `${c},`;
    }
  }
  return key;
}

export function toSqlInserts(
  table: string,
  columns: string[],
  rows: unknown[][],
  kind = "postgres",
): string {
  if (columns.length === 0) {
    return "";
  }
  const target = quoteIdentifier(table, kind);
  const chunks: string[] = [];
  // Rows leaving out the same columns share a statement, up to INSERT_CHUNK.
  for (let start = 0; start < rows.length; ) {
    const key = omitted(rows[start], columns.length);
    let end = start + 1;
    while (end < rows.length && end - start < INSERT_CHUNK && omitted(rows[end], columns.length) === key) {
      end += 1;
    }
    const kept = columns.map((_, c) => c).filter((c) => !isDefault(rows[start][c]));
    if (kept.length === 0) {
      // Every column at its default; MySQL spells it its own way.
      const statement = kind === "mysql" || kind === "mariadb" ? `INSERT INTO ${target} () VALUES ();` : `INSERT INTO ${target} DEFAULT VALUES;`;
      for (let r = start; r < end; r += 1) {
        chunks.push(statement);
      }
    } else {
      const head = `INSERT INTO ${target} (${kept.map((c) => escapeSqlIdentifier(columns[c], kind)).join(", ")}) VALUES`;
      const lines = new Array<string>(end - start);
      for (let r = start; r < end; r += 1) {
        lines[r - start] = `  (${kept.map((c) => sqlLiteral(rows[r][c], kind)).join(", ")})`;
      }
      chunks.push(`${head}\n${lines.join(",\n")};`);
    }
    start = end;
  }
  return chunks.join("\n");
}

// `original`, when given, is the row as the database has it: the key it
// names finds the row, and a key column staged to something else is set.
export function buildUpdateSql(
  table: string,
  columns: string[],
  row: unknown[],
  pk: string[],
  kind = "postgres",
  original?: unknown[],
): string | null {
  if (pk.length === 0) {
    return null;
  }
  const pkSet = new Set(pk);
  const sets: string[] = [];
  for (let c = 0; c < columns.length; c += 1) {
    if (!pkSet.has(columns[c]) || (original !== undefined && row[c] !== original[c])) {
      sets.push(`${escapeSqlIdentifier(columns[c], kind)} = ${sqlLiteral(row[c], kind)}`);
    }
  }
  if (sets.length === 0) {
    return null;
  }
  const keyRow = original ?? row;
  const wheres: string[] = [];
  for (const key of pk) {
    const index = columns.indexOf(key);
    wheres.push(`${escapeSqlIdentifier(key, kind)} = ${sqlLiteral(index >= 0 ? keyRow[index] : null, kind)}`);
  }
  return `UPDATE ${quoteIdentifier(table, kind)} SET ${sets.join(", ")} WHERE ${wheres.join(" AND ")};`;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

// "title_YYYYMMDD_HHMMSS", for a file name without its extension.
export function exportBaseName(title: string, date = new Date()): string {
  const stamp = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}_${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
  const base =
    title
      .trim()
      .replace(/[^0-9A-Za-z가-힣._-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "export";
  return `${base}_${stamp}`;
}

export function suggestFilename(title: string, format: ExportFormat | string, date = new Date()): string {
  return `${exportBaseName(title, date)}.${format}`;
}

// A name a file system takes as it is: a table's name inside a zip, say.
export function safeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_")
    .trim()
    .replace(/^\.+|\.+$/g, "");
  return cleaned === "" ? "export" : cleaned;
}

export function downloadBlob(filename: string, data: string | Blob, mime = "application/octet-stream"): void {
  const blob = typeof data === "string" ? new Blob([data], { type: mime }) : data;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  // A large file may still be reading from the URL once click() returns.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// About 1M characters per part.
const BLOB_PART = 1 << 20;

// Text gathered into Blob parts as it is written, so a large export never
// sits in one string; the browser may move the parts to disk.
export class TextBlobBuilder {
  private readonly parts: Blob[] = [];
  private pending: string[] = [];
  private pendingLength = 0;

  push(text: string): void {
    if (text === "") {
      return;
    }
    this.pending.push(text);
    this.pendingLength += text.length;
    if (this.pendingLength >= BLOB_PART) {
      this.flush();
    }
  }

  private flush(): void {
    if (this.pending.length > 0) {
      this.parts.push(new Blob([this.pending.join("")]));
      this.pending = [];
      this.pendingLength = 0;
    }
  }

  blob(type = ""): Blob {
    this.flush();
    return new Blob(this.parts, { type });
  }
}

export async function gzipBlob(blob: Blob): Promise<Blob> {
  const stream = blob.stream().pipeThrough(new CompressionStream("gzip"));
  return new Blob([await new Response(stream).blob()], { type: EXPORT_MIME.gzip });
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

// Rows [start, end) as the database returned them (staged edits aside),
// only the given columns when `pick` is set.
export async function readRows(
  source: WindowedRowSource,
  start: number,
  end: number,
  pick?: number[],
): Promise<unknown[][]> {
  const columns = pick ?? source.columns.map((_, index) => index);
  const last = Math.min(end, source.baseRowCount);
  const rows: unknown[][] = [];
  if (source.columns.length === 0) {
    return rows;
  }
  for (let r = start; r < last; r += 1) {
    if (source.baseCell(r, 0) === undefined) {
      await source.ensureRow(r);
    }
    const row = new Array<unknown>(columns.length);
    for (let c = 0; c < columns.length; c += 1) {
      const value = source.baseCell(r, columns[c]);
      row[c] = value === undefined ? null : value;
    }
    rows.push(row);
  }
  return rows;
}

export async function collectRows(
  source: WindowedRowSource,
  onProgress?: (done: number, total: number) => void,
): Promise<unknown[][]> {
  const columnCount = source.columns.length;
  // Exports reflect what the database returned, not unapplied staged edits.
  const total = source.baseRowCount;
  if (columnCount === 0 || total === 0) {
    onProgress?.(0, total);
    return [];
  }
  const rows = new Array<unknown[]>(total);
  for (let r = 0; r < total; r += 1) {
    let first = source.baseCell(r, 0);
    if (first === undefined) {
      await source.ensureRow(r);
      first = source.baseCell(r, 0);
    }
    const row = new Array<unknown>(columnCount);
    row[0] = first === undefined ? null : first;
    for (let c = 1; c < columnCount; c += 1) {
      const value = source.baseCell(r, c);
      row[c] = value === undefined ? null : value;
    }
    rows[r] = row;
    if (onProgress && (r + 1) % 1000 === 0) {
      onProgress(r + 1, total);
      await yieldToUi();
    }
  }
  onProgress?.(total, total);
  return rows;
}
