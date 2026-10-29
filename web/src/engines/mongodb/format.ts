// Text for BSON values: mongosh notation (cards, JSON view, console), relaxed
// and canonical Extended JSON (JSON view's EJSON mode, copy), one-line
// previews for folded values, and the view limits of MONGODB.md §5.

import { t } from "../../i18n";
import { Decimal128, Int64, ObjectId, doubleText, isDocument, jsonKeys, toEJSON, type BsonDocument, type BsonValue, type EJSON } from "./bson";

// ---- View limits ----

export interface ViewLimits {
  // Documents larger than this (BSON bytes) show only their leading fields.
  docBytes: number;
  // Arrays longer than this show only their first elements.
  arrayItems: number;
}

export const VIEW_LIMITS: ViewLimits = { docBytes: 1024 * 1024, arrayItems: 1000 };

// What the card and JSON views leave out of a document until "전체 보기".
export interface Truncation {
  // BSON size of the whole document.
  bytes: number;
  // Leading top-level fields shown; the rest are folded into one marker.
  shownFields: number;
  totalFields: number;
  // Dotted paths of arrays cut to `arrayItems`, with their full length.
  arrays: { path: string; length: number }[];
}

// UTF-8 length without encoding the string.
function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) {
      n += 1;
    } else if (c < 0x800) {
      n += 2;
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else {
      n += 3;
    }
  }
  return n;
}

// Bytes a value takes in BSON (for documents and arrays, the whole
// encoded document). `arrayItems` counts only that many elements of each
// array, which is what a truncated view shows.
export function bsonSize(v: BsonValue, arrayItems = Infinity): number {
  if (v === null) {
    return 0;
  }
  if (typeof v === "string") {
    return 4 + utf8Length(v) + 1;
  }
  if (typeof v === "boolean") {
    return 1;
  }
  if (Array.isArray(v)) {
    let size = 5;
    const shown = Math.min(v.length, arrayItems);
    for (let i = 0; i < shown; i++) {
      size += 1 + String(i).length + 1 + bsonSize(v[i], arrayItems);
    }
    return size;
  }
  if (isDocument(v)) {
    let size = 5;
    for (const [key, value] of v) {
      size += 1 + utf8Length(key) + 1 + bsonSize(value, arrayItems);
    }
    return size;
  }
  switch (v.type) {
    case "ObjectId":
      return 12;
    case "Int32":
      return 4;
    case "Int64":
    case "Double":
    case "Date":
    case "Timestamp":
      return 8;
    case "Decimal128":
      return 16;
    case "Binary":
      // Subtype 2 (old binary) repeats the length inside the payload.
      return 4 + 1 + v.byteLength() + (v.subType === 2 ? 4 : 0);
    case "Regex":
      return utf8Length(v.pattern) + 1 + v.options.length + 1;
    case "Code":
      return v.scope === null ? 4 + utf8Length(v.code) + 1 : 4 + 4 + utf8Length(v.code) + 1 + bsonSize(v.scope, arrayItems);
    case "MinKey":
    case "MaxKey":
    case "Undefined":
      return 0;
  }
}

// What a view of `doc` leaves out under `limits`, or null when it shows
// everything. `_id` is always shown.
export function truncation(doc: BsonDocument, limits: ViewLimits = VIEW_LIMITS): Truncation | null {
  const arrays: { path: string; length: number }[] = [];
  const findArrays = (v: BsonValue, path: string) => {
    if (Array.isArray(v)) {
      if (v.length > limits.arrayItems) {
        arrays.push({ path, length: v.length });
      }
      v.slice(0, limits.arrayItems).forEach((x, i) => findArrays(x, `${path}.${i}`));
    } else if (isDocument(v)) {
      for (const [key, value] of v) {
        findArrays(value, path ? `${path}.${key}` : key);
      }
    }
  };
  findArrays(doc, "");
  const bytes = bsonSize(doc);
  let shownFields = doc.size;
  if (bytes > limits.docBytes) {
    let used = 5;
    shownFields = 0;
    for (const [key, value] of doc) {
      used += 1 + utf8Length(key) + 1 + bsonSize(value, limits.arrayItems);
      if (used > limits.docBytes && key !== "_id" && shownFields > 0) {
        break;
      }
      shownFields++;
    }
  }
  if (arrays.length === 0 && shownFields === doc.size) {
    return null;
  }
  return { bytes, shownFields, totalFields: doc.size, arrays };
}

function moreItemsText(count: number): string {
  return t("… {count}개 더", { count: count.toLocaleString("en-US") });
}

function moreFieldsText(count: number): string {
  return t("… 필드 {count}개 더", { count: count.toLocaleString("en-US") });
}

// ---- mongosh notation ----

const PLAIN_KEY = /^[A-Za-z_$][\w$]*$/;

// A key as mongosh writes it: bare when it is an identifier.
export function shellKey(key: string): string {
  return PLAIN_KEY.test(key) ? key : JSON.stringify(key);
}

// `db.orders`, or `db.getCollection("order items")` for a name that is not
// an identifier (mongosh reads `db.a.b` as a collection named "a.b" too, but
// the explicit form never confuses a reader).
export function shellCollection(coll: string): string {
  return PLAIN_KEY.test(coll) ? `db.${coll}` : `db.getCollection(${JSON.stringify(coll)})`;
}

function shellQuote(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")}'`;
}

// A regex as a /literal/ with each `/` written `\/`, or RegExp('…') when a
// literal cannot carry the pattern unchanged: empty, opening like a comment,
// holding a line break, or already holding a `\/` that would read back as `/`.
function regexText(pattern: string, options: string): string {
  if (pattern === "" || pattern.startsWith("*") || /[\n\r\u2028\u2029]/.test(pattern) || pattern.includes("\\/")) {
    return `RegExp(${shellQuote(pattern)}, ${shellQuote(options)})`;
  }
  return `/${pattern.replaceAll("/", "\\/")}/${options}`;
}

// A double the way mongosh reads it back as a double: a whole number (or
// -0) in a literal would be stored as Int32, so it goes inside Double().
function shellDouble(n: number): string {
  return Number.isFinite(n) && Number.isInteger(n) ? `Double(${Object.is(n, -0) ? "-0" : String(n)})` : String(n);
}

// Scalars in mongosh notation; null for documents and arrays.
function shellScalar(v: BsonValue): string | null {
  if (v === null) {
    return "null";
  }
  if (typeof v === "string") {
    return JSON.stringify(v);
  }
  if (typeof v === "boolean") {
    return String(v);
  }
  if (Array.isArray(v) || isDocument(v)) {
    return null;
  }
  switch (v.type) {
    case "ObjectId":
      return `ObjectId('${v.hex}')`;
    case "Int32":
      return String(v.value);
    case "Int64":
      return `Long('${v.value}')`;
    case "Double":
      return shellDouble(v.value);
    case "Decimal128":
      return `NumberDecimal('${v.value}')`;
    case "Date": {
      const iso = v.iso();
      // Beyond a JS Date's range: the milliseconds, exact.
      return iso === null ? `new Date(Long('${v.ms}'))` : `ISODate('${iso}')`;
    }
    case "Binary": {
      const uuid = v.uuid();
      return uuid === null ? `Binary.createFromBase64('${v.base64}', ${v.subType})` : `UUID('${uuid}')`;
    }
    case "Regex":
      return regexText(v.pattern, v.options);
    case "Timestamp":
      return `Timestamp({ t: ${v.t}, i: ${v.i} })`;
    case "Code":
      return v.scope === null ? `Code(${shellQuote(v.code)})` : `Code(${shellQuote(v.code)}, ${toShell(v.scope)})`;
    case "MinKey":
      return "MinKey()";
    case "MaxKey":
      return "MaxKey()";
    case "Undefined":
      return "undefined";
  }
}

// How a notation writes values: scalars, keys, and spacing.
interface Notation {
  // Text for a scalar; null for documents and arrays.
  leaf: (v: BsonValue) => string | null;
  key: (key: string) => string;
  // Spaces inside brackets and after ":" and ",".
  spaced: boolean;
}

const SHELL: Notation = { leaf: shellScalar, key: shellKey, spaced: true };

// One-line mongosh text: { _id: ObjectId('…'), status: "paid" }.
export function toShell(v: BsonValue): string {
  return inlineText(v, Infinity, SHELL) ?? "";
}

// One-line text, or null as soon as it grows past `max` characters (so a
// long array is not rendered just to learn it does not fit).
function inlineText(v: BsonValue, max: number, notation: Notation): string | null {
  const leaf = notation.leaf(v);
  if (leaf !== null) {
    return leaf.length > max ? null : leaf;
  }
  const entries = isDocument(v) ? [...v] : null;
  const count = Array.isArray(v) ? v.length : (entries?.length ?? 0);
  const [open, close] = Array.isArray(v) ? ["[", "]"] : ["{", "}"];
  if (count === 0) {
    return open + close;
  }
  const [inner, colon, comma] = notation.spaced ? [" ", ": ", ", "] : ["", ":", ","];
  let out = open + inner;
  for (let i = 0; i < count; i++) {
    const prefix = entries === null ? "" : notation.key(entries[i][0]) + colon;
    const value = Array.isArray(v) ? v[i] : entries !== null ? entries[i][1] : null;
    const item = inlineText(value, max - out.length - prefix.length, notation);
    if (item === null) {
      return null;
    }
    out += (i > 0 ? comma : "") + prefix + item;
    if (out.length > max) {
      return null;
    }
  }
  out += inner + close;
  return out.length > max ? null : out;
}

export interface PrettyOptions {
  // Containers that fit within this many columns stay on one line.
  width?: number;
  // Leave out what MONGODB.md §5 folds; null shows everything.
  limits?: ViewLimits | null;
}

interface PrettyView {
  width: number;
  limits: ViewLimits | null;
  // Top-level fields shown when the document is folded for size.
  shownFields: number | null;
}

function prettyView(v: BsonValue, options: PrettyOptions): PrettyView {
  const limits = options.limits ?? null;
  const cut = isDocument(v) && limits !== null ? truncation(v, limits) : null;
  return { width: options.width ?? 72, limits, shownFields: cut?.shownFields ?? null };
}

// Multi-line mongosh text, two-space indent, short containers on one line.
export function toShellPretty(v: BsonValue, options: PrettyOptions = {}): string {
  return prettyText(v, 0, SHELL, prettyView(v, options));
}

function prettyText(v: BsonValue, depth: number, notation: Notation, view: PrettyView): string {
  const leaf = notation.leaf(v);
  if (leaf !== null) {
    return leaf;
  }
  const indent = "  ".repeat(depth);
  const folded = depth === 0 && view.shownFields !== null;
  // A cut array is never short enough for one line, so `limits` only
  // matters below.
  if (!folded) {
    const one = inlineText(v, view.width - indent.length, notation);
    if (one !== null) {
      return one;
    }
  }
  const pad = "  ".repeat(depth + 1);
  const lines: string[] = [];
  if (Array.isArray(v)) {
    const shown = view.limits === null ? v.length : Math.min(v.length, view.limits.arrayItems);
    for (let i = 0; i < shown; i++) {
      lines.push(pad + prettyText(v[i], depth + 1, notation, view));
    }
    if (shown < v.length) {
      lines.push(pad + moreItemsText(v.length - shown));
    }
  } else if (isDocument(v)) {
    const entries = [...v];
    const shown = folded && view.shownFields !== null ? view.shownFields : entries.length;
    for (const [key, value] of entries.slice(0, shown)) {
      lines.push(`${pad}${notation.key(key)}: ${prettyText(value, depth + 1, notation, view)}`);
    }
    if (shown < entries.length) {
      lines.push(pad + moreFieldsText(entries.length - shown));
    }
  }
  // Markers are not values, so the line before one takes no comma.
  const body = lines.map((line, i) => (i < lines.length - 1 && !lines[i + 1].startsWith(`${pad}…`) ? `${line},` : line)).join("\n");
  return Array.isArray(v) ? `[\n${body}\n${indent}]` : `{\n${body}\n${indent}}`;
}

// ---- Extended JSON text ----

export interface EJSONTextOptions extends PrettyOptions {
  // Relaxed: numbers and recent dates as plain JSON, as in Compass.
  relaxed?: boolean;
  // 0 writes one compact line.
  indent?: number;
}

// Inline JSON for a wrapper such as { "$oid": "…" }.
function jsonInline(x: EJSON, compact: boolean): string {
  if (x === null || typeof x !== "object") {
    return JSON.stringify(x);
  }
  const [colon, comma] = compact ? [":", ","] : [": ", ", "];
  if (Array.isArray(x)) {
    return `[${x.map((y) => jsonInline(y, compact)).join(comma)}]`;
  }
  return `{${jsonKeys(x)
    .map((k) => `${JSON.stringify(k)}${colon}${jsonInline(x[k], compact)}`)
    .join(comma)}}`;
}

function ejsonLeaf(v: BsonValue, relaxed: boolean, compact: boolean): string | null {
  if (Array.isArray(v) || isDocument(v)) {
    return null;
  }
  if (relaxed && v !== null && typeof v === "object") {
    switch (v.type) {
      case "Int32":
        return String(v.value);
      case "Int64":
        if (v.value >= BigInt(Number.MIN_SAFE_INTEGER) && v.value <= BigInt(Number.MAX_SAFE_INTEGER)) {
          return v.value.toString();
        }
        break;
      case "Double":
        if (Number.isFinite(v.value)) {
          return doubleText(v.value);
        }
        break;
      case "Date": {
        const iso = v.iso();
        const year = iso === null ? 0 : Number(iso.slice(0, 4));
        if (iso !== null && year >= 1970 && year <= 9999 && !iso.startsWith("+")) {
          return jsonInline({ $date: iso }, compact);
        }
        break;
      }
    }
  }
  return jsonInline(toEJSON(v), compact);
}

function ejsonNotation(relaxed: boolean, compact: boolean): Notation {
  return { leaf: (v) => ejsonLeaf(v, relaxed, compact), key: (key) => JSON.stringify(key), spaced: !compact };
}

// Extended JSON text. Canonical by default (what the server exchanges);
// with `indent: 0` a single compact line.
export function ejsonText(v: BsonValue, options: EJSONTextOptions = {}): string {
  const relaxed = options.relaxed ?? false;
  const indent = options.indent ?? 2;
  if (indent === 0) {
    return inlineText(v, Infinity, ejsonNotation(relaxed, true)) ?? "";
  }
  const text = prettyText(v, 0, ejsonNotation(relaxed, false), prettyView(v, options));
  return indent === 2 ? text : text.replace(/^((?: {2})+)/gm, (lead: string) => " ".repeat((lead.length / 2) * indent));
}

// ---- Previews and cells ----

// A short value inside a preview: nested containers only as their size.
function previewItem(v: BsonValue): string {
  if (typeof v === "string") {
    return JSON.stringify(v.length > 24 ? `${v.slice(0, 23)}…` : v);
  }
  if (Array.isArray(v)) {
    return `[${v.length}]`;
  }
  if (isDocument(v)) {
    return "{…}";
  }
  return shellScalar(v) ?? "";
}

// A folded document or array for cards and cells: badge `{4}` / `[3]` and
// as many leading entries as fit `budget` characters (at least one), e.g.
// `{ city: "東京", … }`.
export function preview(v: BsonDocument | BsonValue[], budget = 30): { badge: string; text: string } {
  const isArray = Array.isArray(v);
  const entries = isArray ? [] : [...v];
  const count = isArray ? v.length : entries.length;
  const badge = isArray ? `[${count}]` : `{${count}}`;
  if (count === 0) {
    return { badge, text: isArray ? "[]" : "{}" };
  }
  const parts: string[] = [];
  let used = 0;
  for (let i = 0; i < count; i++) {
    const part = isArray ? previewItem(v[i]) : `${shellKey(entries[i][0])}: ${previewItem(entries[i][1])}`;
    if (parts.length > 0 && used + 2 + part.length > budget) {
      break;
    }
    parts.push(part);
    used += (parts.length > 1 ? 2 : 0) + part.length;
  }
  const more = parts.length < count ? ", …" : "";
  return { badge, text: isArray ? `[ ${parts.join(", ")}${more} ]` : `{ ${parts.join(", ")}${more} }` };
}

// Short one-line text for a grid cell (the grid styles null and missing).
export function cellText(v: BsonValue): string {
  if (typeof v === "string") {
    return v;
  }
  if (Array.isArray(v) || isDocument(v)) {
    const { badge, text } = preview(v, 60);
    return `${badge} ${text}`;
  }
  if (v instanceof ObjectId) {
    return v.hex;
  }
  if (v instanceof Int64 || v instanceof Decimal128) {
    return String(v.value);
  }
  return shellScalar(v) ?? "";
}
