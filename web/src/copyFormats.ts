import type { SqlDialect } from "./engines/sqlDialect";
import { SqlExpression, toCsv, toJson, toSqlInserts } from "./export";
import type { WindowedRowSource } from "./grid/windowSource";
import { cellToString } from "./rowOps";

// The most rows one copy takes, from the grid or its menu.
export const COPY_MAX_ROWS = 100_000;

// TablePlus's "Copy Rows As" / "Copy Selected Cells As" formats.
export type CopyFormat = "text" | "json" | "html" | "markdown" | "csv" | "csvHeader" | "insert";

export interface CopyTable {
  columns: string[];
  rows: unknown[][];
}

// The table an INSERT copy writes into, which copied columns hold bytes, and
// their declared types (see toSqlInserts).
export interface InsertTarget {
  table: string;
  dialect: SqlDialect;
  binary?: boolean[];
  declared?: (string | null)[];
}

// A cell as a copy takes it. For SQL (`keywords`) a staged DEFAULT or NOW()
// is that expression rather than the label shown, and a new row's untouched
// column is DEFAULT, as applying the row leaves it out.
export function copyValue(source: WindowedRowSource, row: number, col: number, keywords: boolean): unknown {
  if (keywords) {
    const staged = source.stagedExpr(row, col);
    if (staged !== null) {
      return new SqlExpression(staged.expr);
    }
    if (source.isInserted(row) && source.cellState(row, col) === "default") {
      return new SqlExpression("default");
    }
  }
  return source.cell(row, col) ?? null;
}

function cellText(value: unknown): string {
  return cellToString(value) ?? "";
}

function isNull(value: unknown): boolean {
  return value === null || value === undefined;
}

// A field that would break the tab-separated layout is quoted, as spreadsheets
// write and read it.
function tsvField(text: string): string {
  return /[\t\n\r]/.test(text) || text.startsWith('"') ? `"${text.split('"').join('""')}"` : text;
}

// What ⌘C copies: tab-separated, NULL as an empty field. A single cell comes
// out exactly as it is, line breaks and quotes included.
export function toPlainText(rows: unknown[][]): string {
  if (rows.length === 1 && rows[0].length === 1) {
    return cellText(rows[0][0]);
  }
  return rows.map((row) => row.map((value) => tsvField(cellText(value))).join("\t")).join("\n");
}

function htmlEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function toHtmlTable(columns: string[], rows: unknown[][]): string {
  const cell = (value: unknown): string => (isNull(value) ? "NULL" : htmlEscape(cellText(value)));
  return [
    "<table>",
    "  <thead>",
    `    <tr>${columns.map((column) => `<th>${htmlEscape(column)}</th>`).join("")}</tr>`,
    "  </thead>",
    "  <tbody>",
    ...rows.map((row) => `    <tr>${columns.map((_, c) => `<td>${cell(row[c])}</td>`).join("")}</tr>`),
    "  </tbody>",
    "</table>",
  ].join("\n");
}

// A pipe would end the cell and a line break the row; backslashes are
// escaped first so one before a pipe can't undo that pipe's escape.
function markdownCell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r\n|\r|\n/g, "<br>");
}

export function toMarkdownTable(columns: string[], rows: unknown[][]): string {
  const line = (cells: string[]): string => `| ${cells.join(" | ")} |`;
  const cell = (value: unknown): string => (isNull(value) ? "NULL" : markdownCell(cellText(value)));
  return [
    line(columns.map(markdownCell)),
    line(columns.map(() => "---")),
    ...rows.map((row) => line(columns.map((_, c) => cell(row[c])))),
  ].join("\n");
}

// "" for INSERT without a table to write into.
export function formatCopy(format: CopyFormat, table: CopyTable, target: InsertTarget | null): string {
  const { columns, rows } = table;
  switch (format) {
    case "text":
      return toPlainText(rows);
    case "json":
      return toJson(columns, rows);
    case "html":
      return toHtmlTable(columns, rows);
    case "markdown":
      return toMarkdownTable(columns, rows);
    case "csv":
      return toCsv(columns, rows, { header: false, bom: false });
    case "csvHeader":
      return toCsv(columns, rows, { header: true, bom: false });
    case "insert":
      return target === null
        ? ""
        : toSqlInserts(target.table, columns, rows, target.dialect, target.binary, target.declared);
  }
}

// RFC 4180 fields split on `delimiter`. A field is quoted only when it opens
// with a quote and closes before a delimiter or line end; otherwise its quotes
// are plain text (a value like 5" screen).
function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;
  const n = text.length;
  for (;;) {
    let field = "";
    let end = -1;
    if (text[i] === '"') {
      let j = i + 1;
      let value = "";
      let closed = false;
      while (j < n) {
        if (text[j] === '"') {
          if (text[j + 1] === '"') {
            value += '"';
            j += 2;
            continue;
          }
          closed = true;
          j += 1;
          break;
        }
        value += text[j];
        j += 1;
      }
      if (closed && (j >= n || text[j] === delimiter || text[j] === "\n" || text[j] === "\r")) {
        field = value;
        end = j;
      }
    }
    if (end < 0) {
      let j = i;
      while (j < n && text[j] !== delimiter && text[j] !== "\n" && text[j] !== "\r") {
        j += 1;
      }
      field = text.slice(i, j);
      end = j;
    }
    row.push(field);
    if (end >= n) {
      rows.push(row);
      return rows;
    }
    if (text[end] === delimiter) {
      i = end + 1;
      continue;
    }
    rows.push(row);
    row = [];
    i = text[end] === "\r" && text[end + 1] === "\n" ? end + 2 : end + 1;
  }
}

// Clipboard text as rows of fields: one line without tabs is a single value;
// otherwise tab-separated (what grids and spreadsheets copy), else
// comma-separated when every line splits into the same number of fields,
// else one value per line.
export function parseClipboardTable(text: string): string[][] {
  const body = text.replace(/(\r\n|\r|\n)$/, "");
  if (!/[\t\r\n]/.test(body)) {
    return [[body]];
  }
  if (body.includes("\t")) {
    return parseDelimited(body, "\t");
  }
  const csv = parseDelimited(body, ",");
  if (csv.length > 1 && csv[0].length > 1 && csv.every((row) => row.length === csv[0].length)) {
    return csv;
  }
  // No tabs in the text: each line is one field, quoted ones kept whole.
  return parseDelimited(body, "\t");
}
