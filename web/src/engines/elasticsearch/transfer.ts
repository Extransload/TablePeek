// Files in and out of an index (가져오기 · 내보내기 · 덤프).
//
// Reading: a file is decoded as it streams, so a large one never sits in
// memory whole. JSON input is one scanner for every shape a search tool
// writes: a JSON array of documents, one document per line (NDJSON), a
// `_bulk` file (action lines, each but `delete` followed by its source), a
// search reply (`{ hits: { hits: [ … ] } }`) and export lines
// (`{ _index, _id, _source }`). A dump is a `_bulk` file whose first lines
// are `# PUT /<index>` and `# <definition JSON>`; the comment lines are read
// apart and skipped by the document reader. CSV/TSV is read record by record
// with the MongoDB reader (the same RFC 4180 rules), each column has a type
// and dotted headers can make nested objects.
//
// Writing: the server's export stream sends `{ _index, _id, _source }` per
// line; the writers here turn those into NDJSON (sources, or the lines as
// they are), a JSON array, CSV (fields flattened to dotted paths, arrays and
// objects as JSON text) or `_bulk` lines that import again.

import { csvField } from "../../export";
import { t } from "../../i18n";
import { jsonKeys, parseJson, stringifyJson } from "../mongodb/bson";
import { guessDelimiter } from "../mongodb/transfer";
import { rec, type Json } from "./json";

// ---- Index names ----

// Why a name cannot be an index's, or null (the rules Elasticsearch and
// OpenSearch check on create).
export function indexNameProblem(name: string): string | null {
  if (name === "") {
    return t("인덱스 이름을 쓰세요");
  }
  if (name !== name.toLowerCase()) {
    return t("인덱스 이름에는 소문자만 쓸 수 있습니다");
  }
  if (/[\\/*?"<>| ,#:]/.test(name)) {
    return t('인덱스 이름에 쓸 수 없는 글자가 있습니다 (\\ / * ? " < > | 공백 , # :)');
  }
  if (/^[-_+]/.test(name)) {
    return t("인덱스 이름은 - _ + 로 시작할 수 없습니다");
  }
  if (name === "." || name === "..") {
    return t("인덱스 이름으로 . 이나 .. 은 쓸 수 없습니다");
  }
  if (new TextEncoder().encode(name).length > 255) {
    return t("인덱스 이름은 255바이트를 넘을 수 없습니다");
  }
  return null;
}

// ---- Reading files ----

// "json": documents (an array, NDJSON, a search reply, export lines);
// "bulk": a `_bulk` file (or a dump); "csv": CSV/TSV.
export type ImportFormat = "json" | "bulk" | "csv";

export type BulkOp = "index" | "create" | "update" | "delete";

const BULK_OPS: Record<string, true> = { index: true, create: true, update: true, delete: true };
// Keys a `_bulk` action's metadata may hold (7.x–9.x, OpenSearch).
const BULK_META: Record<string, true> = {
  _index: true,
  _id: true,
  _type: true,
  routing: true,
  _routing: true,
  pipeline: true,
  require_alias: true,
  require_data_stream: true,
  if_seq_no: true,
  if_primary_term: true,
  version: true,
  version_type: true,
  retry_on_conflict: true,
  dynamic_templates: true,
  list_executed_pipelines: true,
  op_type: true,
  _source: true,
};

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

// A `_bulk` action line: one operation key whose value is its metadata.
export function isBulkAction(value: unknown): value is Record<string, Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || !Object.hasOwn(BULK_OPS, keys[0])) {
    return false;
  }
  const meta = (value as Record<string, unknown>)[keys[0]];
  return meta !== null && typeof meta === "object" && !Array.isArray(meta) && Object.keys(meta).every((key) => Object.hasOwn(BULK_META, key));
}

// What a file most likely is, from its name and its first characters: CSV
// by name or shape, a `_bulk` file when its first line (after a dump's
// comment lines) is an action, else JSON documents.
export function guessImport(name: string, head: string): { format: ImportFormat; delimiter: string } {
  const lower = name.toLowerCase();
  const text = head.replace(/^\uFEFF/, "").trimStart();
  if (lower.endsWith(".tsv") || lower.endsWith(".tab")) {
    return { format: "csv", delimiter: "\t" };
  }
  const looksJson = text.startsWith("{") || text.startsWith("[") || text.startsWith("#");
  if (lower.endsWith(".csv") || (!looksJson && !/\.(json|ndjson|jsonl|bulk)$/.test(lower))) {
    return { format: "csv", delimiter: guessDelimiter(text) };
  }
  const first = text.split(/\r?\n/).find((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
  if (first !== undefined) {
    try {
      if (isBulkAction(parseJson(first))) {
        return { format: "bulk", delimiter: "," };
      }
    } catch {
      // Not one JSON value per line: documents across lines.
    }
  }
  return { format: "json", delimiter: "," };
}

// One top-level value cut out of a JSON file, a value that could not be
// cut out, or a `#` comment line outside any value (a dump's head).
type FileItem = { kind: "value"; line: number; text: string; bytes: number } | { kind: "bad"; line: number; error: string; bytes: number } | { kind: "comment"; line: number; text: string; bytes: number };

// Values of a JSON file: the items of a top-level array, or top-level values
// one after another (NDJSON, or pretty-printed). Each is cut out by bracket
// depth, so one broken value fails only itself: outside an array, a `{` at
// the start of a line while a value is still open means that value was cut
// short (a broken NDJSON line).
async function* readJsonItems(blob: Blob, signal?: AbortSignal): AsyncGenerator<FileItem> {
  // "start": nothing read yet; "array": inside a top-level [ … ]; "stream":
  // values one after another; "done": after the array's closing ].
  let mode: "start" | "array" | "stream" | "done" = "start";
  let inItem = false;
  let inString = false;
  let escaped = false;
  let depth = 0;
  let line = 1;
  let itemLine = 1;
  let parts: string[] = [];
  // Set after a stray value until the next one starts.
  let skipping = false;
  // Inside a `#` line; `commentParts` gathers it across chunks.
  let inComment = false;
  let commentParts: string[] = [];
  let bytes = 0;
  // The previous character ended a line.
  let lineStart = true;
  for await (const chunk of blobText(blob, signal)) {
    const text = chunk.text;
    bytes = chunk.bytes;
    let start = inItem ? 0 : -1;
    let commentStart = inComment ? 0 : -1;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      const atLineStart = lineStart;
      lineStart = c === 10;
      if (inComment) {
        if (c === 10) {
          commentParts.push(text.slice(commentStart, i));
          yield { kind: "comment", line, text: commentParts.join("").replace(/\r$/, ""), bytes };
          commentParts = [];
          inComment = false;
          line++;
        }
        continue;
      }
      if (inItem && atLineStart && c === 123 && mode === "stream") {
        yield { kind: "bad", line: itemLine, error: t("값이 닫히기 전에 다음 줄의 값이 시작됩니다"), bytes };
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
            yield { kind: "value", line: itemLine, text: item, bytes };
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
      if (c === 35 && atLineStart && mode !== "array") {
        inComment = true;
        commentStart = i + 1;
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
        yield { kind: "bad", line, error: t("문서({ … })가 아닙니다"), bytes };
      }
    }
    if (inItem) {
      parts.push(text.slice(start));
    }
    if (inComment) {
      commentParts.push(text.slice(commentStart));
    }
  }
  if (inComment) {
    yield { kind: "comment", line, text: commentParts.join("").replace(/\r$/, ""), bytes };
  }
  if (inItem) {
    yield { kind: "bad", line: itemLine, error: t("파일이 끝났는데 값이 닫히지 않았습니다"), bytes };
  }
}

// JSON text on one line: whitespace outside strings dropped, the rest as
// written (so large numbers keep every digit).
function compactJson(text: string): string {
  if (!text.includes("\n") && !text.includes("\r")) {
    return text;
  }
  let out = "";
  let from = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === 92) {
        escaped = true;
      } else if (c === 34) {
        inString = false;
      }
      continue;
    }
    if (c === 34) {
      inString = true;
    } else if (c === 32 || c === 9 || c === 10 || c === 13) {
      out += text.slice(from, i);
      from = i + 1;
    }
  }
  return out + text.slice(from);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// One record of an import: a document (the dialog's op type applies) or a
// `_bulk` action with its body. `meta` is the action's metadata or what the
// file said about a document (`_id`, `routing` from an export line or hit).
export interface ImportRecord {
  line: number;
  bytes: number;
  // Null: a document; the import's op type applies.
  op: BulkOp | null;
  meta: Record<string, unknown>;
  // The source (or an update's body); null for a delete or a failure.
  doc: Record<string, unknown> | null;
  // `doc` exactly as the file wrote it, on one line, when it was a whole
  // value of the file.
  text: string | null;
  error: string | null;
}

function failed(line: number, bytes: number, error: string): ImportRecord {
  return { line, bytes, op: null, meta: {}, doc: null, text: null, error };
}

// A hit or export line as a document with its `_id` (and routing).
function hitRecord(hit: Record<string, unknown>, line: number, bytes: number): ImportRecord {
  const meta: Record<string, unknown> = {};
  if (typeof hit._id === "string" || typeof hit._id === "number") {
    meta._id = String(hit._id);
  }
  if (typeof hit._routing === "string") {
    meta.routing = hit._routing;
  }
  if (!isObject(hit._source)) {
    return { ...failed(line, bytes, t("_source가 없습니다 (저장하지 않는 인덱스의 결과)")), meta };
  }
  return { line, bytes, op: null, meta, doc: hit._source, text: null, error: null };
}

// Records of a JSON or `_bulk` file. Comment lines (a dump's head) are left
// to `readDumpHeader`.
export async function* readRecords(blob: Blob, format: "json" | "bulk", signal?: AbortSignal): AsyncGenerator<ImportRecord> {
  // A `_bulk` action waiting for its source line.
  let pending: { op: BulkOp; meta: Record<string, unknown>; line: number } | null = null;
  for await (const item of readJsonItems(blob, signal)) {
    if (item.kind === "comment") {
      continue;
    }
    if (item.kind === "bad") {
      yield failed(item.line, item.bytes, item.error);
      continue;
    }
    let value: unknown;
    try {
      value = parseJson(item.text, { bigints: true });
    } catch (error) {
      yield failed(item.line, item.bytes, error instanceof Error ? error.message : String(error));
      pending = null;
      continue;
    }
    if (format === "bulk") {
      if (pending !== null) {
        const action = pending;
        pending = null;
        if (!isObject(value)) {
          yield { ...failed(action.line, item.bytes, t("{line}번째 줄: 동작 다음 줄이 문서({ … })가 아닙니다", { line: item.line })), op: action.op, meta: action.meta };
        } else {
          yield { line: action.line, bytes: item.bytes, op: action.op, meta: action.meta, doc: value, text: compactJson(item.text), error: null };
        }
        continue;
      }
      if (!isBulkAction(value)) {
        yield failed(item.line, item.bytes, t("_bulk 동작 줄({ \"index\": { … } })이 아닙니다"));
        continue;
      }
      const op = Object.keys(value)[0] as BulkOp;
      const meta = { ...value[op] };
      if (op === "delete") {
        yield { line: item.line, bytes: item.bytes, op, meta, doc: null, text: null, error: null };
      } else {
        pending = { op, meta, line: item.line };
      }
      continue;
    }
    if (!isObject(value)) {
      yield failed(item.line, item.bytes, t("문서({ … })가 아닙니다"));
      continue;
    }
    const hits = rec(value.hits).hits;
    if (Array.isArray(hits) && value._source === undefined) {
      for (const hit of hits) {
        yield isObject(hit) ? hitRecord(hit, item.line, item.bytes) : failed(item.line, item.bytes, t("문서({ … })가 아닙니다"));
      }
      continue;
    }
    if (isObject(value._source) && (value._id !== undefined || value._index !== undefined)) {
      yield hitRecord(value, item.line, item.bytes);
      continue;
    }
    yield { line: item.line, bytes: item.bytes, op: null, meta: {}, doc: value, text: compactJson(item.text), error: null };
  }
  if (pending !== null) {
    yield { ...failed(pending.line, blob.size, t("파일이 동작 줄에서 끝났습니다 (문서 줄이 없음)")), op: pending.op, meta: pending.meta };
  }
}

// ---- Dumps ----

export interface DumpHeader {
  index: string;
  // `{ settings, mappings, aliases }` as `PUT /<index>` takes it.
  definition: Record<string, unknown> | null;
  // Why the definition line did not read.
  error: string | null;
}

// A dump's head: `# PUT /<index>` and the definition JSON on the `#` lines
// after it (or on the same line). Null when the file starts otherwise.
export async function readDumpHeader(blob: Blob, signal?: AbortSignal): Promise<DumpHeader | null> {
  const comments: string[] = [];
  let partial = "";
  let more = true;
  for await (const chunk of blobText(blob, signal)) {
    const lines = (partial + chunk.text).split("\n");
    partial = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.replace(/\r$/, "").replace(/^\uFEFF/, "");
      if (line.trim() === "") {
        continue;
      }
      if (!line.trimStart().startsWith("#")) {
        more = false;
        break;
      }
      comments.push(line.trimStart().slice(1).trim());
    }
    if (!more) {
      break;
    }
  }
  if (more && partial.trimStart().startsWith("#")) {
    comments.push(partial.trimStart().slice(1).trim());
  }
  const head = /^PUT\s+\/?([^\s/?]+)\s*(.*)$/i.exec(comments[0] ?? "");
  if (head === null) {
    return null;
  }
  const body = [head[2], ...comments.slice(1)].join("\n").trim();
  if (body === "") {
    return { index: decodeURIComponent(head[1]), definition: null, error: null };
  }
  try {
    const value = parseJson(body);
    return isObject(value) ? { index: decodeURIComponent(head[1]), definition: value, error: null } : { index: decodeURIComponent(head[1]), definition: null, error: t("인덱스 정의는 객체여야 합니다") };
  } catch (error) {
    return { index: decodeURIComponent(head[1]), definition: null, error: error instanceof Error ? error.message : String(error) };
  }
}

// The dump's first lines.
export function dumpHead(index: string, definition: unknown): string {
  return `# PUT /${index}\n# ${stringifyJson(definition)}\n`;
}

// ---- Building `_bulk` lines ----

// The value at a dotted path: a key written with dots first, then through
// objects.
export function valueAt(doc: Record<string, unknown>, path: string): unknown {
  if (Object.hasOwn(doc, path)) {
    return doc[path];
  }
  const dot = path.indexOf(".");
  let at = dot;
  while (at > 0) {
    const head = path.slice(0, at);
    const inner = doc[head];
    if (Object.hasOwn(doc, head) && isObject(inner)) {
      const found = valueAt(inner, path.slice(at + 1));
      if (found !== undefined) {
        return found;
      }
    }
    at = path.indexOf(".", at + 1);
  }
  return undefined;
}

// A copy of the document without the field at the path (the `_id` field,
// when asked to drop it).
function withoutPath(doc: Record<string, unknown>, path: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of jsonKeys(doc)) {
    if (key === path) {
      continue;
    }
    const inner = doc[key];
    out[key] = path.startsWith(`${key}.`) && isObject(inner) ? withoutPath(inner, path.slice(key.length + 1)) : inner;
  }
  return out;
}

export interface BulkOptions {
  // For documents: how they go in.
  op: "index" | "create";
  // A field whose value becomes `_id` ("" for the file's own or automatic).
  idField: string;
  // Leave the `_id` field out of the source.
  dropIdField: boolean;
  // Keep a `_bulk` file's `_index` (else the dialog's target takes them).
  keepIndex: boolean;
}

// The `_bulk` lines of a record (action, then source unless a delete), each
// ending in a line break, with the `_id` it names; throws why it cannot.
export function bulkEntry(record: ImportRecord, options: BulkOptions): { text: string; id: string } {
  const meta: Record<string, unknown> = { ...record.meta };
  if (!options.keepIndex) {
    delete meta._index;
  }
  delete meta._type;
  let doc = record.doc;
  let text = record.text;
  if (record.op === null && options.idField !== "" && doc !== null) {
    const value = valueAt(doc, options.idField);
    if (typeof value === "string" ? value === "" : typeof value !== "number") {
      throw new Error(value === undefined ? t("_id로 쓸 필드 {field}가 없습니다", { field: options.idField }) : t("_id로 쓸 필드 {field}가 문자열이나 수가 아닙니다", { field: options.idField }));
    }
    meta._id = String(value);
    if (options.dropIdField) {
      doc = withoutPath(doc, options.idField);
      text = null;
    }
  }
  const op = record.op ?? options.op;
  const action = `${stringifyJson({ [op]: meta })}\n`;
  const id = typeof meta._id === "string" || typeof meta._id === "number" ? String(meta._id) : "";
  if (op === "delete") {
    return { text: action, id };
  }
  return { text: `${action}${text ?? stringifyJson(doc ?? {})}\n`, id };
}

// ---- CSV columns ----

// A column's type: "auto" guesses each value on its own; "json" reads the
// text as a JSON value; "skip" leaves the column out.
export type CsvType = "auto" | "string" | "number" | "boolean" | "date" | "json" | "skip";

export const CSV_TYPES: { value: CsvType; label: string }[] = [
  { value: "auto", label: "자동 (값마다 추정)" },
  { value: "string", label: "문자열" },
  { value: "number", label: "수" },
  { value: "boolean", label: "불리언" },
  { value: "date", label: "날짜" },
  { value: "json", label: "JSON" },
  { value: "skip", label: "건너뛰기" },
];

export interface CsvColumn {
  name: string;
  type: CsvType;
}

// What an empty field becomes: no field at all, "" (strings) / null, or null.
export type CsvBlanks = "omit" | "empty" | "null";

export interface CsvOptions {
  // `a.b` headers make nested objects.
  nested: boolean;
  blanks: CsvBlanks;
}

const NUMBER_TEXT = /^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

// An integer text with a leading zero ("007", a postcode) stays text when
// guessing.
function leadingZero(text: string): boolean {
  return /^[+-]?0\d/.test(text);
}

// A number, or its text when JSON numbers would lose digits (Elasticsearch
// reads numeric text into numeric fields).
function parseNumber(text: string): Json {
  if (!NUMBER_TEXT.test(text)) {
    throw new Error(t("수가 아닙니다: {text}", { text }));
  }
  const n = Number(text);
  if (!Number.isFinite(n)) {
    throw new Error(t("수가 아닙니다: {text}", { text }));
  }
  return /^[+-]?\d+$/.test(text) && !Number.isSafeInteger(n) ? BigInt(text.replace(/^\+/, "")) : n;
}

// ISO 8601 text as it is (Elasticsearch's default date format reads it);
// other dates `Date` understands as ISO text in UTC; digits as epoch millis.
function parseDate(text: string): Json {
  if (ISO_DATE.test(text)) {
    return text;
  }
  if (/^\d+$/.test(text)) {
    return Number(text);
  }
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) {
    throw new Error(t("날짜가 아닙니다: {text}", { text }));
  }
  return new Date(ms).toISOString();
}

function parseBoolean(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower === "true" || lower === "1" || lower === "yes") {
    return true;
  }
  if (lower === "false" || lower === "0" || lower === "no") {
    return false;
  }
  throw new Error(t("불리언이 아닙니다: {text}", { text }));
}

// A value guessed from its text: true/false, numbers (not with a leading
// zero), null; else the text.
function guessValue(text: string): Json {
  const trimmed = text.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "true" || lower === "false") {
    return lower === "true";
  }
  if (lower === "null") {
    return null;
  }
  if (NUMBER_TEXT.test(trimmed) && !leadingZero(trimmed)) {
    return parseNumber(trimmed);
  }
  return text;
}

// The value of a non-empty field under a column type; throws when the text
// does not fit the type.
export function csvValue(text: string, type: CsvType): Json {
  switch (type) {
    case "auto":
      return guessValue(text);
    case "number":
      return parseNumber(text.trim());
    case "boolean":
      return parseBoolean(text.trim());
    case "date":
      return parseDate(text.trim());
    case "json":
      return parseJson(text, { bigints: true }) as Json;
    default:
      return text;
  }
}

// One type for a column from sample values: the narrowest every non-empty
// value fits, else 문자열.
export function guessColumnType(values: string[]): CsvType {
  let seen = 0;
  const fits = { boolean: true, number: true, date: true, json: true };
  for (const raw of values) {
    const text = raw.trim();
    if (text === "") {
      continue;
    }
    seen++;
    const lower = text.toLowerCase();
    fits.boolean &&= lower === "true" || lower === "false";
    fits.number &&= NUMBER_TEXT.test(text) && !leadingZero(text);
    fits.date &&= ISO_DATE.test(text);
    if (fits.json) {
      try {
        fits.json = (text.startsWith("{") || text.startsWith("[")) && parseJson(text) !== undefined;
      } catch {
        fits.json = false;
      }
    }
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
  if (fits.date) {
    return "date";
  }
  if (fits.json) {
    return "json";
  }
  return "string";
}

// Puts `value` at a dotted path, making the objects on the way; a path
// through a value that is not an object is an error.
function setPath(doc: Record<string, Json>, path: string, value: Json): void {
  const keys = path.split(".");
  let at = doc;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    const next = at[key];
    if (next === undefined) {
      const child: Record<string, Json> = {};
      at[key] = child;
      at = child;
    } else if (isObject(next)) {
      at = next as Record<string, Json>;
    } else {
      throw new Error(t("{path}: 이미 값이 있어 하위 필드를 만들 수 없습니다", { path: keys.slice(0, i + 1).join(".") }));
    }
  }
  const last = keys[keys.length - 1];
  if (isObject(at[last])) {
    throw new Error(t("{path}: 이미 하위 필드가 있습니다", { path }));
  }
  at[last] = value;
}

// A record as a document under the columns; throws with the column named.
export function csvDoc(columns: CsvColumn[], cells: string[], options: CsvOptions): Record<string, Json> {
  const doc: Record<string, Json> = {};
  for (let i = 0; i < columns.length; i++) {
    const column = columns[i];
    if (column.type === "skip" || column.name === "") {
      continue;
    }
    const text = cells[i] ?? "";
    let value: Json;
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
      doc[column.name] = value;
    }
  }
  return doc;
}

// ---- Writing files ----

// "ndjson": a source per line; "ndjson-meta": the export lines as they are
// (`{ _index, _id, _source }`); "json": an array of sources; "csv"; "bulk":
// action and source lines; "dump": the definition, then "bulk".
export type ExportFormat = "ndjson" | "ndjson-meta" | "json" | "csv" | "bulk" | "dump";

export const EXPORT_MIME: Record<ExportFormat, string> = {
  ndjson: "application/x-ndjson;charset=utf-8",
  "ndjson-meta": "application/x-ndjson;charset=utf-8",
  json: "application/json;charset=utf-8",
  csv: "text/csv;charset=utf-8",
  bulk: "application/x-ndjson;charset=utf-8",
  dump: "application/x-ndjson;charset=utf-8",
};

export const EXPORT_EXTENSION: Record<ExportFormat, string> = {
  ndjson: "ndjson",
  "ndjson-meta": "ndjson",
  json: "json",
  csv: "csv",
  bulk: "bulk.ndjson",
  dump: "dump.ndjson",
};

// A file being written from the export stream's lines: `start` once, then
// `line` for every `{ _index, _id, _source }` line, then `end`.
export interface ExportWriter {
  start: string;
  line(raw: string): string;
  end(): string;
}

// A CSV field's text: strings as they are, numbers and booleans as written,
// arrays and objects as one line of JSON.
function csvText(v: unknown): string | null {
  if (v === undefined || v === null) {
    return null;
  }
  if (typeof v === "string") {
    return v;
  }
  if (typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  return stringifyJson(v);
}

// `fields` (CSV): the dotted paths to write; `withId` puts `_id` first.
export function exportWriter(format: ExportFormat, fields: string[], withId: boolean): ExportWriter {
  const hit = (raw: string) => rec(parseJson(raw, { bigints: true }));
  // A line's `_source` alone, on one line.
  const source = (raw: string) => stringifyJson(hit(raw)._source ?? {});
  if (format === "ndjson-meta") {
    return { start: "", line: (raw) => `${raw}\n`, end: () => "" };
  }
  if (format === "ndjson") {
    return { start: "", line: (raw) => `${source(raw)}\n`, end: () => "" };
  }
  if (format === "bulk" || format === "dump") {
    return {
      start: "",
      line(raw) {
        const h = hit(raw);
        const meta: Record<string, unknown> = { _id: h._id };
        if (typeof h._routing === "string") {
          meta.routing = h._routing;
        }
        return `${stringifyJson({ index: meta })}\n${stringifyJson(h._source ?? {})}\n`;
      },
      end: () => "",
    };
  }
  if (format === "csv") {
    const columns = withId ? ["_id", ...fields] : fields;
    return {
      start: `${columns.map((f) => csvField(f)).join(",")}\r\n`,
      line(raw) {
        const h = hit(raw);
        const doc = rec(h._source);
        const cells = fields.map((f) => csvField(csvText(valueAt(doc, f))));
        if (withId) {
          cells.unshift(csvField(csvText(h._id)));
        }
        return `${cells.join(",")}\r\n`;
      },
      end: () => "",
    };
  }
  let first = true;
  return {
    start: "[",
    line(raw) {
      const lead = first ? "\n  " : ",\n  ";
      first = false;
      return lead + source(raw);
    },
    end: () => (first ? "]\n" : "\n]\n"),
  };
}
