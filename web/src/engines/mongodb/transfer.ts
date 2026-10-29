// Files in and out of a collection (MONGODB.md §6.2 가져오기 · 내보내기).
//
// Reading: a file is decoded as it streams, so a large one never sits in
// memory whole. JSON input is one scanner for every shape mongoexport and
// Compass write: a JSON array of documents, one document per line (NDJSON),
// or pretty-printed documents one after another — values are canonical or
// relaxed Extended JSON. CSV/TSV is read record by record (quoted fields may
// hold delimiters and line breaks); each column has a type, either guessed
// from the first rows or chosen, and dotted headers (`address.city`) can
// build nested documents.
//
// Writing: the server's export stream sends one canonical EJSON document per
// line; JSON and NDJSON in canonical form pass those lines through as they
// are, relaxed form and CSV convert each document. CSV flattens nested
// documents to dotted paths and writes arrays as JSON text.

import { t } from "../../i18n";
import { csvField } from "../../export";
import { BsonDate, Decimal128, Double, Int32, Int64, ObjectId, fromEJSON, isDocument, parseJson, type BsonDocument, type BsonValue } from "./bson";
import { ejsonText } from "./format";

// ---- Reading files ----

export type ImportFormat = "json" | "csv";

// Decoded text of a file as it streams, with the bytes read so far.
async function* blobText(blob: Blob, signal?: AbortSignal): AsyncGenerator<{ text: string; bytes: number }> {
  const reader = blob.stream().getReader();
  // The decoder drops a leading byte order mark.
  const decoder = new TextDecoder("utf-8");
  let bytes = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      const text = decoder.decode(value, { stream: true });
      if (text !== "") {
        yield { text, bytes };
      }
    }
    const tail = decoder.decode();
    if (tail !== "") {
      yield { text: tail, bytes };
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

// What a file most likely is, from its name and its first characters.
export function guessFormat(name: string, head: string): { format: ImportFormat; delimiter: string } {
  const lower = name.toLowerCase();
  const text = head.replace(/^\uFEFF/, "").trimStart();
  if (lower.endsWith(".tsv") || lower.endsWith(".tab")) {
    return { format: "csv", delimiter: "\t" };
  }
  if (lower.endsWith(".json") || lower.endsWith(".ndjson") || lower.endsWith(".jsonl") || (!lower.endsWith(".csv") && (text.startsWith("{") || text.startsWith("[")))) {
    return { format: "json", delimiter: "," };
  }
  return { format: "csv", delimiter: guessDelimiter(text) };
}

// The delimiter the header line uses most (outside quotes).
export function guessDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const unquoted = firstLine.replace(/"[^"]*"/g, "");
  let best = ",";
  let bestCount = 0;
  for (const d of [",", "\t", ";", "|"]) {
    const n = unquoted.split(d).length - 1;
    if (n > bestCount) {
      best = d;
      bestCount = n;
    }
  }
  return best;
}

// One record read from a file: the document, or why it could not be made.
// `line` is where the record starts (1-based); `bytes` how far the file has
// been read, for progress.
export interface ImportItem {
  line: number;
  doc: BsonDocument | null;
  error: string | null;
  bytes: number;
}

function jsonItem(text: string, line: number, bytes: number): ImportItem {
  try {
    const value = fromEJSON(parseJson(text));
    if (!isDocument(value)) {
      return { line, doc: null, error: t("문서({ … })가 아닙니다"), bytes };
    }
    return { line, doc: value, error: null, bytes };
  } catch (error) {
    return { line, doc: null, error: error instanceof Error ? error.message : String(error), bytes };
  }
}

// Documents of a JSON file: the items of a top-level array, or top-level
// documents one after another (NDJSON, or pretty-printed). Each item is cut
// out by bracket depth and parsed alone, so one broken document fails only
// itself: outside an array, a `{` at the start of a line while a document
// is still open means that document was cut short (a broken NDJSON line).
export async function* readJsonDocs(blob: Blob, signal?: AbortSignal): AsyncGenerator<ImportItem> {
  // "start": nothing read yet; "array": inside a top-level [ … ]; "stream":
  // documents one after another; "done": after the array's closing ].
  let mode: "start" | "array" | "stream" | "done" = "start";
  let inItem = false;
  let inString = false;
  let escaped = false;
  let depth = 0;
  let line = 1;
  let itemLine = 1;
  let parts: string[] = [];
  // Set after a stray value until the next document starts.
  let skipping = false;
  let bytes = 0;
  // The previous character ended a line.
  let lineStart = true;
  for await (const chunk of blobText(blob, signal)) {
    const text = chunk.text;
    bytes = chunk.bytes;
    let start = inItem ? 0 : -1;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      const atLineStart = lineStart;
      lineStart = c === 10;
      if (inItem && atLineStart && c === 123 && mode === "stream") {
        yield { line: itemLine, doc: null, error: t("문서가 닫히기 전에 다음 줄의 문서가 시작됩니다"), bytes };
        parts = [];
        inItem = false;
        inString = false;
        escaped = false;
      }
      if (inItem) {
        if (inString) {
          if (escaped) {
            escaped = false;
          } else if (c === 92) {
            escaped = true;
          } else if (c === 34) {
            inString = false;
          } else if (c === 10) {
            line++;
          }
          continue;
        }
        if (c === 34) {
          inString = true;
        } else if (c === 123 || c === 91) {
          depth++;
        } else if (c === 125 || c === 93) {
          depth--;
          if (depth === 0) {
            parts.push(text.slice(start, i + 1));
            const item = parts.join("");
            parts = [];
            inItem = false;
            yield jsonItem(item, itemLine, bytes);
          }
        } else if (c === 10) {
          line++;
        }
        continue;
      }
      if (c === 10) {
        line++;
        continue;
      }
      if (c === 32 || c === 9 || c === 13 || c === 0xfeff) {
        continue;
      }
      if (mode === "done") {
        continue;
      }
      if (mode === "start") {
        if (c === 91) {
          mode = "array";
          continue;
        }
        mode = "stream";
      }
      if (c === 123 || c === 91) {
        inItem = true;
        skipping = false;
        depth = 1;
        start = i;
        itemLine = line;
        continue;
      }
      if (mode === "array" && c === 44) {
        skipping = false;
        continue;
      }
      if (mode === "array" && c === 93) {
        mode = "done";
        continue;
      }
      if (!skipping) {
        skipping = true;
        yield { line, doc: null, error: t("문서({ … })가 아닙니다"), bytes };
      }
    }
    if (inItem) {
      parts.push(text.slice(start));
    }
  }
  if (inItem) {
    yield { line: itemLine, doc: null, error: t("파일이 끝났는데 문서가 닫히지 않았습니다"), bytes };
  }
}

// Records of a CSV/TSV file as their fields, RFC 4180 quoting: a field
// starting with `"` runs to the next lone `"`, and `""` inside is a quote.
// Empty lines are skipped. `line` is where the record starts.
export async function* readCsvRows(blob: Blob, delimiter: string, signal?: AbortSignal): AsyncGenerator<{ line: number; cells: string[]; bytes: number }> {
  const delim = delimiter.charCodeAt(0);
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  // A `"` inside quotes: an escaped quote if the next one is `"` too.
  let quotePending = false;
  // The field has had no character yet (a `"` here opens quotes).
  let fieldStart = true;
  let afterCR = false;
  let line = 1;
  let rowLine = 1;
  let bytes = 0;
  const endRow = function* (): Generator<{ line: number; cells: string[]; bytes: number }> {
    row.push(field);
    if (!(row.length === 1 && row[0] === "")) {
      yield { line: rowLine, cells: row, bytes };
    }
    row = [];
    field = "";
    fieldStart = true;
  };
  for await (const chunk of blobText(blob, signal)) {
    const text = chunk.text;
    bytes = chunk.bytes;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (afterCR) {
        afterCR = false;
        if (c === 10) {
          continue;
        }
      }
      if (inQuotes) {
        if (quotePending) {
          quotePending = false;
          if (c === 34) {
            field += '"';
            continue;
          }
          inQuotes = false;
        } else {
          if (c === 34) {
            quotePending = true;
          } else {
            if (c === 10) {
              line++;
            }
            field += text[i];
          }
          continue;
        }
      }
      if (c === 34 && fieldStart) {
        inQuotes = true;
        fieldStart = false;
      } else if (c === delim) {
        row.push(field);
        field = "";
        fieldStart = true;
      } else if (c === 10 || c === 13) {
        afterCR = c === 13;
        line++;
        yield* endRow();
        rowLine = line;
      } else {
        field += text[i];
        fieldStart = false;
      }
    }
  }
  if (field !== "" || row.length > 0 || inQuotes) {
    yield* endRow();
  }
}

// ---- CSV columns ----

// A column's type: "auto" guesses each value on its own; "skip" leaves the
// column out.
export type CsvType = "auto" | "string" | "number" | "decimal" | "date" | "boolean" | "objectId" | "skip";

export const CSV_TYPES: { value: CsvType; label: string }[] = [
  { value: "auto", label: "자동 (값마다 추정)" },
  { value: "string", label: "문자열" },
  { value: "number", label: "수 (Int32·Int64·Double)" },
  { value: "decimal", label: "Decimal128" },
  { value: "date", label: "날짜" },
  { value: "boolean", label: "불리언" },
  { value: "objectId", label: "ObjectId" },
  { value: "skip", label: "건너뛰기" },
];

export interface CsvColumn {
  name: string;
  type: CsvType;
}

// What an empty field becomes: no field at all, "" (strings) / null, or null.
export type CsvBlanks = "omit" | "empty" | "null";

export interface CsvOptions {
  // `a.b` headers make nested documents.
  nested: boolean;
  blanks: CsvBlanks;
}

const INT_TEXT = /^[+-]?\d+$/;
const FLOAT_TEXT = /^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const HEX24 = /^[0-9a-fA-F]{24}$/;
const OBJECT_ID_CALL = /^ObjectId\(\s*["']([0-9a-fA-F]{24})["']\s*\)$/;

// An integer text with a leading zero ("007", a postcode) is kept as text
// when guessing.
function leadingZero(text: string): boolean {
  return /^[+-]?0\d/.test(text);
}

function parseNumber(text: string): BsonValue {
  if (INT_TEXT.test(text)) {
    const big = BigInt(text);
    if (big >= -2147483648n && big <= 2147483647n) {
      return new Int32(Number(big));
    }
    if (big >= -(2n ** 63n) && big < 2n ** 63n) {
      return new Int64(big);
    }
    return new Double(Number(text));
  }
  if (FLOAT_TEXT.test(text)) {
    return new Double(Number(text));
  }
  throw new Error(t("수로 읽을 수 없습니다: {text}", { text }));
}

// ISO 8601 text; without a zone it is taken as UTC, so the same file gives
// the same instants wherever it is imported.
function parseIsoDate(text: string): BsonDate | null {
  const m = ISO_DATE.exec(text);
  if (m === null) {
    return null;
  }
  let iso = text.replace(" ", "T");
  if (text.length === 10) {
    iso += "T00:00:00Z";
  } else if (m[1] === undefined) {
    iso += "Z";
  }
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new BsonDate(ms);
}

function parseDate(text: string): BsonDate {
  const iso = parseIsoDate(text);
  if (iso !== null) {
    return iso;
  }
  // Milliseconds since the epoch, then whatever the browser can read.
  if (INT_TEXT.test(text)) {
    return new BsonDate(BigInt(text));
  }
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) {
    throw new Error(t("날짜로 읽을 수 없습니다: {text}", { text }));
  }
  return new BsonDate(ms);
}

function parseBoolean(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower === "true" || lower === "yes" || lower === "y" || lower === "1") {
    return true;
  }
  if (lower === "false" || lower === "no" || lower === "n" || lower === "0") {
    return false;
  }
  throw new Error(t("불리언으로 읽을 수 없습니다: {text}", { text }));
}

function parseObjectId(text: string): ObjectId {
  const call = OBJECT_ID_CALL.exec(text);
  return new ObjectId(call !== null ? call[1] : text);
}

// A value guessed from its text: true/false, integers and decimals (not
// with a leading zero), ISO dates, 24-hex ObjectIds, null; else the text.
function guessValue(text: string): BsonValue {
  const lower = text.toLowerCase();
  if (lower === "true" || lower === "false") {
    return lower === "true";
  }
  if (lower === "null") {
    return null;
  }
  if (FLOAT_TEXT.test(text) && !leadingZero(text)) {
    return parseNumber(text);
  }
  if (HEX24.test(text)) {
    return new ObjectId(text);
  }
  const date = parseIsoDate(text);
  if (date !== null) {
    return date;
  }
  return text;
}

// The value of a non-empty field under a column type; throws when the text
// does not fit the type.
export function csvValue(text: string, type: CsvType): BsonValue {
  switch (type) {
    case "auto":
      return guessValue(text);
    case "number":
      return parseNumber(text.trim());
    case "decimal":
      return new Decimal128(text.trim());
    case "date":
      return parseDate(text.trim());
    case "boolean":
      return parseBoolean(text.trim());
    case "objectId":
      return parseObjectId(text.trim());
    default:
      return text;
  }
}

// One type for a column from sample values: the narrowest every non-empty
// value fits, else 문자열. Numbers with a fraction or exponent stay "number"
// (Double); choose Decimal128 by hand for exact amounts.
export function guessColumnType(values: string[]): CsvType {
  let seen = 0;
  const fits = { boolean: true, number: true, date: true, objectId: true };
  for (const raw of values) {
    const text = raw.trim();
    if (text === "") {
      continue;
    }
    seen++;
    const lower = text.toLowerCase();
    fits.boolean &&= lower === "true" || lower === "false";
    fits.number &&= FLOAT_TEXT.test(text) && !leadingZero(text);
    fits.date &&= parseIsoDate(text) !== null;
    fits.objectId &&= HEX24.test(text);
  }
  if (seen === 0) {
    return "string";
  }
  if (fits.boolean) {
    return "boolean";
  }
  if (fits.number) {
    return "number";
  }
  if (fits.objectId) {
    return "objectId";
  }
  if (fits.date) {
    return "date";
  }
  return "string";
}

// Puts `value` at a dotted path, making the documents on the way; a path
// through a value that is not a document is an error.
function setPath(doc: BsonDocument, path: string, value: BsonValue): void {
  const keys = path.split(".");
  let at = doc;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    const next = at.get(key);
    if (next === undefined) {
      const child: BsonDocument = new Map();
      at.set(key, child);
      at = child;
    } else if (isDocument(next)) {
      at = next;
    } else {
      throw new Error(t("{path}: 이미 값이 있어 하위 필드를 만들 수 없습니다", { path: keys.slice(0, i + 1).join(".") }));
    }
  }
  const last = keys[keys.length - 1];
  if (isDocument(at.get(last))) {
    throw new Error(t("{path}: 이미 하위 필드가 있습니다", { path }));
  }
  at.set(last, value);
}

// A record as a document under the columns; throws with the column named.
export function csvDoc(columns: CsvColumn[], cells: string[], options: CsvOptions): BsonDocument {
  const doc: BsonDocument = new Map();
  for (let i = 0; i < columns.length; i++) {
    const column = columns[i];
    if (column.type === "skip" || column.name === "") {
      continue;
    }
    const text = cells[i] ?? "";
    let value: BsonValue;
    if (text === "") {
      if (options.blanks === "omit") {
        continue;
      }
      value = options.blanks === "empty" && (column.type === "string" || column.type === "auto") ? "" : null;
    } else {
      try {
        value = csvValue(text, column.type);
      } catch (error) {
        throw new Error(`${column.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (options.nested && column.name.includes(".")) {
      setPath(doc, column.name, value);
    } else {
      doc.set(column.name, value);
    }
  }
  return doc;
}

// ---- Writing files ----

export type ExportFileFormat = "json" | "ndjson" | "csv";

export const EXPORT_FILE_MIME: Record<ExportFileFormat, string> = {
  json: "application/json;charset=utf-8",
  ndjson: "application/x-ndjson;charset=utf-8",
  csv: "text/csv;charset=utf-8",
};

// A file being written from the export stream's lines: `start` once, then
// `line` for every canonical EJSON line, then `end`.
export interface ExportWriter {
  start: string;
  line(raw: string): string;
  end(): string;
}

// Dotted paths of a document's leaves in order: nested documents open into
// their fields, arrays and every other value are one leaf.
export function leafPaths(doc: BsonDocument, prefix = "", out: string[] = []): string[] {
  for (const [key, value] of doc) {
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (isDocument(value) && value.size > 0) {
      leafPaths(value, path, out);
    } else {
      out.push(path);
    }
  }
  return out;
}

// Paths of sampled documents, in the order they first appear.
export function samplePaths(docs: BsonDocument[]): string[] {
  const seen = new Set<string>();
  for (const doc of docs) {
    for (const path of leafPaths(doc)) {
      seen.add(path);
    }
  }
  return [...seen];
}

// The value at a dotted path, through documents only.
function valueAt(doc: BsonDocument, path: string): BsonValue | undefined {
  let at: BsonValue | undefined = doc;
  for (const key of path.split(".")) {
    if (!isDocument(at)) {
      return undefined;
    }
    at = at.get(key);
  }
  return at;
}

// A CSV field's text: strings as they are, numbers as digits (Decimal128
// exactly), dates as ISO, ObjectIds as hex; arrays, documents and the other
// types as one line of relaxed Extended JSON.
function csvText(v: BsonValue | undefined): string | null {
  if (v === undefined || v === null) {
    return null;
  }
  if (typeof v === "string") {
    return v;
  }
  if (typeof v === "boolean") {
    return String(v);
  }
  if (v instanceof Int32 || v instanceof Double) {
    return String(v.value);
  }
  if (v instanceof Int64 || v instanceof Decimal128) {
    return String(v.value);
  }
  if (v instanceof ObjectId) {
    return v.hex;
  }
  if (v instanceof BsonDate) {
    return v.iso() ?? String(v.ms);
  }
  return ejsonText(v, { relaxed: true, indent: 0 });
}

export function exportWriter(format: ExportFileFormat, relaxed: boolean, fields: string[]): ExportWriter {
  const relax = (raw: string) => ejsonText(fromEJSON(parseJson(raw)), { relaxed: true, indent: 0 });
  if (format === "csv") {
    return {
      start: `${fields.map((f) => csvField(f)).join(",")}\r\n`,
      line(raw) {
        const doc = fromEJSON(parseJson(raw));
        const cells = fields.map((f) => csvField(isDocument(doc) ? csvText(valueAt(doc, f)) : null));
        return `${cells.join(",")}\r\n`;
      },
      end: () => "",
    };
  }
  if (format === "ndjson") {
    return { start: "", line: (raw) => `${relaxed ? relax(raw) : raw}\n`, end: () => "" };
  }
  let first = true;
  return {
    start: "[",
    line(raw) {
      const lead = first ? "\n  " : ",\n  ";
      first = false;
      return lead + (relaxed ? relax(raw) : raw);
    },
    end: () => (first ? "]\n" : "\n]\n"),
  };
}
