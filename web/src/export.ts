import type { WindowedRowSource } from "./grid/windowSource";
import { escapeSqlIdentifier, quoteIdentifier, quoteLiteral } from "./dataQuery";

export { escapeSqlIdentifier, quoteIdentifier, quoteLiteral };

export type ExportFormat = "csv" | "json" | "xml" | "sql";

export interface CsvOptions {
  header: boolean;
  bom: boolean;
  delimiter?: string;
}

export const EXPORT_MAX_ROWS = 200000;

export const EXPORT_MIME: Record<ExportFormat, string> = {
  csv: "text/csv;charset=utf-8",
  json: "application/json;charset=utf-8",
  xml: "application/xml;charset=utf-8",
  sql: "text/plain;charset=utf-8",
};

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

export function csvField(value: unknown): string {
  const text = cellText(value);
  if (text.includes('"') || text.includes(",") || text.includes("\n") || text.includes("\r")) {
    return `"${text.split('"').join('""')}"`;
  }
  return text;
}

export function toCsv(columns: string[], rows: unknown[][], options: CsvOptions): string {
  const delimiter = options.delimiter ?? ",";
  const lines: string[] = [];
  if (options.header) {
    lines.push(columns.map(csvField).join(delimiter));
  }
  for (const row of rows) {
    const fields = new Array<string>(columns.length);
    for (let c = 0; c < columns.length; c += 1) {
      fields[c] = csvField(row[c]);
    }
    lines.push(fields.join(delimiter));
  }
  const body = lines.join(CSV_EOL);
  return options.bom ? `\uFEFF${body}` : body;
}

function xmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function xmlTagName(name: string): string {
  const cleaned = name.replace(/[^0-9A-Za-z가-힣_.-]/g, "_");
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

export function toXml(columns: string[], rows: unknown[][]): string {
  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', "<rows>"];
  for (const row of rows) {
    lines.push("  <row>");
    for (let c = 0; c < columns.length; c += 1) {
      const tag = xmlTagName(columns[c]);
      const value = row[c];
      if (value === null || value === undefined) {
        lines.push(`    <${tag}/>`);
      } else {
        lines.push(`    <${tag}>${xmlEscape(cellText(value))}</${tag}>`);
      }
    }
    lines.push("  </row>");
  }
  lines.push("</rows>");
  return lines.join("\n");
}

export function toJson(columns: string[], rows: unknown[][]): string {
  const items = rows.map((row) => {
    const item: Record<string, unknown> = {};
    for (let c = 0; c < columns.length; c += 1) {
      item[columns[c]] = row[c] === undefined ? null : row[c];
    }
    return item;
  });
  return JSON.stringify(items, null, 2);
}

export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : quoteLiteral(String(value));
  }
  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "string") {
    return quoteLiteral(value);
  }
  try {
    const text = JSON.stringify(value);
    return quoteLiteral(text === undefined ? String(value) : text);
  } catch {
    return quoteLiteral(String(value));
  }
}

function rowValues(row: unknown[], columnCount: number): string[] {
  const values = new Array<string>(columnCount);
  for (let c = 0; c < columnCount; c += 1) {
    values[c] = sqlLiteral(row[c]);
  }
  return values;
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
  const head = `INSERT INTO ${quoteIdentifier(table, kind)} (${columns.map((column) => escapeSqlIdentifier(column, kind)).join(", ")}) VALUES`;
  const chunks: string[] = [];
  for (let start = 0; start < rows.length; start += INSERT_CHUNK) {
    const end = Math.min(rows.length, start + INSERT_CHUNK);
    const lines = new Array<string>(end - start);
    for (let r = start; r < end; r += 1) {
      lines[r - start] = `  (${rowValues(rows[r], columns.length).join(", ")})`;
    }
    chunks.push(`${head}\n${lines.join(",\n")};`);
  }
  return chunks.join("\n");
}

export function buildUpdateSql(
  table: string,
  columns: string[],
  row: unknown[],
  pk: string[],
  kind = "postgres",
): string | null {
  if (pk.length === 0) {
    return null;
  }
  const pkSet = new Set(pk);
  const sets: string[] = [];
  for (let c = 0; c < columns.length; c += 1) {
    if (!pkSet.has(columns[c])) {
      sets.push(`${escapeSqlIdentifier(columns[c], kind)} = ${sqlLiteral(row[c])}`);
    }
  }
  if (sets.length === 0) {
    return null;
  }
  const wheres: string[] = [];
  for (const key of pk) {
    const index = columns.indexOf(key);
    wheres.push(`${escapeSqlIdentifier(key, kind)} = ${sqlLiteral(index >= 0 ? row[index] : null)}`);
  }
  return `UPDATE ${quoteIdentifier(table, kind)} SET ${sets.join(", ")} WHERE ${wheres.join(" AND ")};`;
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

export function suggestFilename(title: string, format: ExportFormat, date = new Date()): string {
  const stamp = `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}_${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
  const base =
    title
      .trim()
      .replace(/[^0-9A-Za-z가-힣._-]+/g, "_")
      .replace(/^_+|_+$/g, "") || "export";
  return `${base}_${stamp}.${format}`;
}

export function downloadBlob(filename: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

export async function collectRows(
  source: WindowedRowSource,
  onProgress?: (done: number, total: number) => void,
): Promise<unknown[][]> {
  const columnCount = source.columns.length;
  const total = source.rowCount;
  if (columnCount === 0 || total === 0) {
    onProgress?.(0, total);
    return [];
  }
  const rows = new Array<unknown[]>(total);
  for (let r = 0; r < total; r += 1) {
    let first = source.cell(r, 0);
    if (first === undefined) {
      await source.ensureRow(r);
      first = source.cell(r, 0);
    }
    const row = new Array<unknown>(columnCount);
    row[0] = first === undefined ? null : first;
    for (let c = 1; c < columnCount; c += 1) {
      const value = source.cell(r, c);
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
