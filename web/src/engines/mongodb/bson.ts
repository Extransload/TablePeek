// BSON values held in the web app. Strings, booleans, null and arrays stand
// for themselves; a document is a `Map` so its fields keep their order even
// when a name looks like a number ("2024", "0"), which a plain JS object
// would move to the front. Every other BSON type is a small class whose
// `type` field is the name Compass shows, so values never collapse into JS
// numbers or Dates and Decimal128 is never turned into a float.
//
// Documents travel as canonical Extended JSON (spec: MONGODB.md §5). The
// JSON text is read with `parseJson` and written with `stringifyJson`, which
// keep key order where `JSON.parse`/`JSON.stringify` would not. `fromEJSON`
// also accepts relaxed and legacy forms so pasted text works; `toEJSON`
// always writes canonical form.

import { phrase, phraseError, say, type Phrase } from "../../i18n";

export class ObjectId {
  readonly type = "ObjectId" as const;
  readonly hex: string;
  constructor(hex: string) {
    if (!/^[0-9a-fA-F]{24}$/.test(hex)) {
      throw phraseError(phrase("ObjectId는 16진수 24자리여야 합니다: {text}", { text: hex }));
    }
    this.hex = hex.toLowerCase();
  }
  // A new id the way drivers make one: seconds, 5 random bytes, counter.
  static generate(): ObjectId {
    objectIdCounter = (objectIdCounter + 1) % 0xffffff;
    const seconds = Math.floor(Date.now() / 1000).toString(16).padStart(8, "0");
    return new ObjectId(seconds + objectIdProcess + objectIdCounter.toString(16).padStart(6, "0"));
  }
  timestamp(): Date {
    return new Date(parseInt(this.hex.slice(0, 8), 16) * 1000);
  }
}

let objectIdCounter = Math.floor(Math.random() * 0xffffff);
const objectIdProcess = Array.from({ length: 10 }, () => Math.floor(Math.random() * 16).toString(16)).join("");

export class Int32 {
  readonly type = "Int32" as const;
  readonly value: number;
  constructor(value: number) {
    if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) {
      throw phraseError(phrase("Int32 범위를 벗어난 값입니다: {text}", { text: value }));
    }
    // -0 is not an integer value BSON can hold.
    this.value = value === 0 ? 0 : value;
  }
}

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

export class Int64 {
  readonly type = "Int64" as const;
  readonly value: bigint;
  constructor(value: bigint | number | string) {
    let big: bigint;
    try {
      big = typeof value === "bigint" ? value : BigInt(typeof value === "number" ? value : value.trim());
    } catch {
      throw phraseError(phrase("Int64로 읽을 수 없는 값입니다: {text}", { text: String(value) }));
    }
    if (big < INT64_MIN || big > INT64_MAX) {
      throw phraseError(phrase("Int64 범위를 벗어난 값입니다: {text}", { text: String(value) }));
    }
    this.value = big;
  }
}

export class Double {
  readonly type = "Double" as const;
  constructor(readonly value: number) {}
}

const DECIMAL_TEXT = /^[+-]?(?:(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|inf|infinity|nan)$/i;

// Decimal128 keeps the exact text it was given (as the server printed it).
export class Decimal128 {
  readonly type = "Decimal128" as const;
  readonly value: string;
  constructor(value: string) {
    const text = value.trim();
    if (!DECIMAL_TEXT.test(text)) {
      throw phraseError(phrase("Decimal128로 읽을 수 없는 값입니다: {text}", { text: value }));
    }
    const digits = text.replace(/[eE].*$/, "").replace(/[^0-9]/g, "").replace(/^0+/, "");
    if (digits.length > 34) {
      throw phraseError(phrase("Decimal128은 유효 숫자 34자리까지입니다: {text}", { text: value }));
    }
    this.value = text;
  }
}

// Milliseconds since the epoch as BSON stores them (int64), so dates outside
// the range a JS Date can hold still round-trip.
export class BsonDate {
  readonly type = "Date" as const;
  readonly ms: bigint;
  constructor(ms: bigint | number) {
    this.ms = typeof ms === "bigint" ? ms : BigInt(Math.trunc(ms));
  }
  static fromDate(date: Date): BsonDate {
    return new BsonDate(date.getTime());
  }
  toDate(): Date {
    return new Date(Number(this.ms));
  }
  // ISO text, or null when a JS Date cannot represent the instant.
  iso(): string | null {
    const date = this.toDate();
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
}

export class Binary {
  readonly type = "Binary" as const;
  constructor(
    readonly base64: string,
    readonly subType: number,
  ) {
    if (!Number.isInteger(subType) || subType < 0 || subType > 255) {
      throw phraseError(phrase("Binary 하위 타입은 0–255입니다: {text}", { text: subType }));
    }
  }
  static fromUuid(text: string): Binary {
    const hex = text.replace(/-/g, "");
    if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
      throw phraseError(phrase("UUID 형식이 아닙니다: {text}", { text }));
    }
    return new Binary(hexToBase64(hex), 4);
  }
  static fromHex(hex: string, subType = 0): Binary {
    if (!/^(?:[0-9a-fA-F]{2})*$/.test(hex)) {
      throw phraseError(phrase("16진수 바이트가 아닙니다: {text}", { text: hex }));
    }
    return new Binary(hexToBase64(hex), subType);
  }
  // Standard UUID text for subtype 4 holding 16 bytes, otherwise null.
  uuid(): string | null {
    if (this.subType !== 4) {
      return null;
    }
    const hex = base64ToHex(this.base64);
    if (hex === null || hex.length !== 32) {
      return null;
    }
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  byteLength(): number {
    const clean = this.base64.replace(/=+$/, "");
    return Math.floor((clean.length * 3) / 4);
  }
}

// BSON regex options are a sorted subset of "ilmsux"; the pattern is kept as
// text because it need not be a valid JavaScript RegExp.
export class BsonRegex {
  readonly type = "Regex" as const;
  readonly options: string;
  constructor(
    readonly pattern: string,
    options = "",
  ) {
    if (!/^[ilmsux]*$/.test(options)) {
      throw phraseError(phrase("정규식 옵션은 i, l, m, s, u, x만 쓸 수 있습니다: {text}", { text: options }));
    }
    this.options = [...new Set(options)].sort().join("");
  }
}

export class Timestamp {
  readonly type = "Timestamp" as const;
  // Seconds since the epoch and the ordinal within that second.
  readonly t: number;
  readonly i: number;
  constructor(seconds: number, ordinal: number) {
    for (const part of [seconds, ordinal]) {
      if (!Number.isInteger(part) || part < 0 || part > 0xffffffff) {
        throw phraseError(phrase("Timestamp 값은 0–4294967295 정수입니다: {text}", { text: part }));
      }
    }
    this.t = seconds;
    this.i = ordinal;
  }
}

export class Code {
  readonly type = "Code" as const;
  constructor(
    readonly code: string,
    readonly scope: BsonDocument | null = null,
  ) {}
}

export class MinKey {
  readonly type = "MinKey" as const;
}

export class MaxKey {
  readonly type = "MaxKey" as const;
}

export class BsonUndefined {
  readonly type = "Undefined" as const;
}

export const MIN_KEY = new MinKey();
export const MAX_KEY = new MaxKey();
export const UNDEFINED = new BsonUndefined();

export type BsonScalar =
  | ObjectId
  | Int32
  | Int64
  | Double
  | Decimal128
  | BsonDate
  | Binary
  | BsonRegex
  | Timestamp
  | Code
  | MinKey
  | MaxKey
  | BsonUndefined;

export type BsonValue = string | boolean | null | BsonScalar | BsonValue[] | BsonDocument;

// A document: field names in their stored order. Copy before changing one
// that is shared (`new Map(doc).set(key, value)`).
export type BsonDocument = Map<string, BsonValue>;

// A document from fields written as an object literal. Only for names that
// do not look like array indices, whose order a JS object keeps.
export function bsonDoc(fields: Record<string, BsonValue> = {}): BsonDocument {
  return new Map(Object.entries(fields));
}

export type BsonNumber = Int32 | Int64 | Double | Decimal128;

export type BsonTypeName =
  | "String"
  | "Boolean"
  | "Null"
  | "Object"
  | "Array"
  | BsonScalar["type"];

export function isDocument(v: unknown): v is BsonDocument {
  return v instanceof Map;
}

export function isNumber(v: BsonValue | undefined): v is BsonNumber {
  return v instanceof Int32 || v instanceof Int64 || v instanceof Double || v instanceof Decimal128;
}

// The type name Compass shows for a value.
export function typeName(v: BsonValue): BsonTypeName {
  if (v === null) {
    return "Null";
  }
  if (typeof v === "string") {
    return "String";
  }
  if (typeof v === "boolean") {
    return "Boolean";
  }
  if (Array.isArray(v)) {
    return "Array";
  }
  if (isDocument(v)) {
    return "Object";
  }
  return v.type;
}

// ---- Canonical Extended JSON ----

export type EJSON = string | number | boolean | null | EJSON[] | { [key: string]: EJSON };

// A value from canonical (or relaxed/legacy) Extended JSON as `parseJson`
// returns it. Wrapper objects are recognised only with their exact key set;
// anything else stays a document, so a query such as
// `{ $regex: "a", $options: "i" }` is untouched.
export function fromEJSON(json: unknown): BsonValue {
  if (json === null || typeof json === "string" || typeof json === "boolean") {
    return json;
  }
  if (typeof json === "number") {
    return relaxedNumber(json);
  }
  // A whole number past 2^53, read exactly (`parseJson` with `bigints`).
  if (typeof json === "bigint") {
    return json >= INT64_MIN && json <= INT64_MAX ? new Int64(json) : new Decimal128(json.toString());
  }
  if (Array.isArray(json)) {
    return json.map(fromEJSON);
  }
  if (typeof json !== "object") {
    throw phraseError(phrase("Extended JSON 값이 아닙니다: {text}", { text: String(json) }));
  }
  const record = json as Record<string, unknown>;
  const entries = jsonKeys(record).map((key): [string, unknown] => [key, record[key]]);
  const wrapped = entries.length > 0 && entries[0][0].startsWith("$") ? fromWrapper(json, entries) : undefined;
  if (wrapped !== undefined) {
    return wrapped;
  }
  return new Map(entries.map(([key, value]) => [key, fromEJSON(value)]));
}

// Relaxed numbers: integers that fit int32 or int64 keep that type, the rest
// are doubles (Extended JSON spec, "relaxed" parsing).
function relaxedNumber(n: number): BsonValue {
  if (Number.isInteger(n) && !Object.is(n, -0)) {
    if (n >= -2147483648 && n <= 2147483647) {
      return new Int32(n);
    }
    if (Number.isSafeInteger(n)) {
      return new Int64(BigInt(n));
    }
  }
  return new Double(n);
}

function fromWrapper(obj: object, entries: [string, unknown][]): BsonValue | undefined {
  const one = entries.length === 1 ? entries[0][0] : null;
  const x = one === null ? undefined : entries[0][1];
  const str = (v: unknown, what: string): string => {
    if (typeof v !== "string") {
      throw phraseError(phrase("{name} 값은 문자열이어야 합니다", { name: what }));
    }
    return v;
  };
  switch (one) {
    case "$oid":
      return new ObjectId(str(x, "$oid"));
    case "$numberInt":
      return new Int32(Number(str(x, "$numberInt")));
    case "$numberLong":
      return new Int64(str(x, "$numberLong"));
    case "$numberDouble":
      return new Double(parseDoubleText(str(x, "$numberDouble")));
    case "$numberDecimal":
      return new Decimal128(str(x, "$numberDecimal"));
    case "$date":
      return dateFromEJSON(x);
    case "$binary":
      if (hasExactKeys(x, ["base64", "subType"])) {
        return new Binary(str(x.base64, "$binary.base64"), parseInt(str(x.subType, "$binary.subType"), 16));
      }
      return undefined;
    case "$uuid":
      return Binary.fromUuid(str(x, "$uuid"));
    case "$regularExpression":
      if (hasExactKeys(x, ["pattern", "options"])) {
        return new BsonRegex(str(x.pattern, "pattern"), str(x.options, "options"));
      }
      return undefined;
    case "$timestamp":
      if (hasExactKeys(x, ["t", "i"]) && typeof x.t === "number" && typeof x.i === "number") {
        return new Timestamp(x.t, x.i);
      }
      return undefined;
    case "$code":
      return new Code(str(x, "$code"));
    case "$minKey":
      return x === 1 ? MIN_KEY : undefined;
    case "$maxKey":
      return x === 1 ? MAX_KEY : undefined;
    case "$undefined":
      return x === true ? UNDEFINED : undefined;
  }
  if (hasExactKeys(obj, ["$code", "$scope"])) {
    const scope = fromEJSON(obj.$scope);
    if (!isDocument(scope)) {
      throw phraseError(phrase("$scope 값은 문서여야 합니다"));
    }
    return new Code(str(obj.$code, "$code"), scope);
  }
  // Legacy binary: { "$binary": "<base64>", "$type": "<hex>" }.
  if (hasExactKeys(obj, ["$binary", "$type"]) && typeof obj.$binary === "string" && typeof obj.$type === "string") {
    return new Binary(obj.$binary, parseInt(obj.$type, 16));
  }
  return undefined;
}

// An object holding exactly these keys, in any order.
function hasExactKeys(v: unknown, want: string[]): v is Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    return false;
  }
  const keys = Object.keys(v);
  return keys.length === want.length && want.every((k) => keys.includes(k));
}

function parseDoubleText(text: string): number {
  const n = Number(text);
  if (Number.isNaN(n) && text.trim() !== "NaN") {
    throw phraseError(phrase("Double로 읽을 수 없는 값입니다: {text}", { text }));
  }
  return n;
}

function dateFromEJSON(x: unknown): BsonDate {
  if (typeof x === "string") {
    const ms = Date.parse(x);
    if (Number.isNaN(ms)) {
      throw phraseError(phrase("날짜로 읽을 수 없습니다: {text}", { text: x }));
    }
    return new BsonDate(ms);
  }
  if (typeof x === "number") {
    return new BsonDate(x);
  }
  if (hasExactKeys(x, ["$numberLong"]) && typeof x.$numberLong === "string") {
    return new BsonDate(new Int64(x.$numberLong).value);
  }
  throw phraseError(phrase("$date 값을 읽을 수 없습니다"));
}

// Canonical Extended JSON for a value, to be written with `stringifyJson`
// (documents keep their field order only through it).
export function toEJSON(v: BsonValue): EJSON {
  if (v === null || typeof v === "string" || typeof v === "boolean") {
    return v;
  }
  if (Array.isArray(v)) {
    return v.map(toEJSON);
  }
  if (isDocument(v)) {
    return jsonObject(Array.from(v, ([key, value]): [string, EJSON] => [key, toEJSON(value)]));
  }
  switch (v.type) {
    case "ObjectId":
      return { $oid: v.hex };
    case "Int32":
      return { $numberInt: String(v.value) };
    case "Int64":
      return { $numberLong: v.value.toString() };
    case "Double":
      return { $numberDouble: doubleText(v.value) };
    case "Decimal128":
      return { $numberDecimal: v.value };
    case "Date":
      return { $date: { $numberLong: v.ms.toString() } };
    case "Binary":
      return { $binary: { base64: v.base64, subType: v.subType.toString(16).padStart(2, "0") } };
    case "Regex":
      return { $regularExpression: { pattern: v.pattern, options: v.options } };
    case "Timestamp":
      return { $timestamp: { t: v.t, i: v.i } };
    case "Code":
      return v.scope ? { $code: v.code, $scope: toEJSON(v.scope) } : { $code: v.code };
    case "MinKey":
      return { $minKey: 1 };
    case "MaxKey":
      return { $maxKey: 1 };
    case "Undefined":
      return { $undefined: true };
  }
}

// A double as Extended JSON writes it: integral values keep ".0" so the
// text still reads as a double, -0 keeps its sign.
export function doubleText(n: number): string {
  if (Number.isNaN(n)) {
    return "NaN";
  }
  if (!Number.isFinite(n)) {
    return n > 0 ? "Infinity" : "-Infinity";
  }
  if (Object.is(n, -0)) {
    return "-0.0";
  }
  const text = String(n);
  return /[.eE]/.test(text) ? text : `${text}.0`;
}

// ---- JSON text in true key order ----

// JS objects list array-index keys ("0", "2024") first, in numeric order,
// whatever order they were written in. Objects holding such keys carry their
// true order under this symbol, set by `parseJson` and `toEJSON` and read by
// `jsonKeys` and `stringifyJson`. It is enumerable so a spread copy keeps it.
const KEY_ORDER = Symbol("keyOrder");

function isIndexKey(key: string): boolean {
  return /^(?:0|[1-9]\d{0,9})$/.test(key) && Number(key) < 4294967295;
}

// A plain object from entries, in their order (see KEY_ORDER), for JSON
// written with `stringifyJson`. A later duplicate overwrites the value but
// keeps the first position, as JSON.parse does.
export function jsonObject<T>(entries: [string, T][]): Record<string, T> {
  const out: Record<string, T> = {};
  const keys: string[] = [];
  let reordered = false;
  for (const [key, value] of entries) {
    if (!Object.hasOwn(out, key)) {
      keys.push(key);
      reordered ||= isIndexKey(key);
    }
    // defineProperty so `__proto__` stays an ordinary key.
    Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
  }
  if (reordered) {
    (out as Record<symbol, unknown>)[KEY_ORDER] = keys;
  }
  return out;
}

// An object's keys in the order they were written. Keys added after the
// order was recorded (say, to a spread copy) follow in JS order.
export function jsonKeys(obj: object): string[] {
  const keys = Object.keys(obj);
  const order = (obj as Record<symbol, unknown>)[KEY_ORDER];
  if (!Array.isArray(order)) {
    return keys;
  }
  const own = new Set(keys);
  const out = (order as string[]).filter((key) => own.has(key));
  if (out.length < keys.length) {
    const seen = new Set(out);
    out.push(...keys.filter((key) => !seen.has(key)));
  }
  return out;
}

// A JSON text that does not parse; `offset` is where reading stopped.
export class JsonSyntaxError extends SyntaxError {
  // The message as a phrase, translated where it shows.
  readonly phrase: Phrase;
  constructor(readonly offset: number) {
    const p = phrase("JSON을 읽을 수 없습니다 ({offset}번째 글자)", { offset: offset + 1 });
    super(say(p));
    this.phrase = p;
  }
}

// `JSON.parse` that keeps key order: objects with index-like keys record
// their written order (read it with `jsonKeys`; `fromEJSON` does). Text
// without such keys goes straight to JSON.parse. Bad text throws
// `JsonSyntaxError`. With `bigints`, whole numbers beyond 2^53 come back
// as exact `bigint`s instead of rounded doubles (documents of the search
// engines, whose longs are plain JSON numbers).
export function parseJson(text: string, options: { bigints?: boolean } = {}): unknown {
  const bigints = options.bigints === true && /\d{16}/.test(text);
  // An index-like key is digits, each written plainly or as \u003X.
  if (!bigints && !/"\d+"\s*:|\\u003\d/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      // Read again below for the error's position.
    }
  }
  const reader = new JsonReader(text, bigints);
  const value = reader.value();
  reader.end();
  return value;
}

class JsonReader {
  private pos = 0;
  private static readonly NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

  constructor(
    private readonly text: string,
    private readonly bigints = false,
  ) {}

  value(): unknown {
    this.space();
    switch (this.text[this.pos]) {
      case "{":
        return this.object();
      case "[":
        return this.array();
      case '"':
        return this.string();
      case "t":
        return this.word("true", true);
      case "f":
        return this.word("false", false);
      case "n":
        return this.word("null", null);
    }
    JsonReader.NUMBER.lastIndex = this.pos;
    const m = JsonReader.NUMBER.exec(this.text);
    if (!m) {
      this.fail();
    }
    this.pos += m[0].length;
    const n = Number(m[0]);
    return this.bigints && !Number.isSafeInteger(n) && /^-?\d+$/.test(m[0]) ? BigInt(m[0]) : n;
  }

  end(): void {
    this.space();
    if (this.pos < this.text.length) {
      this.fail();
    }
  }

  private object(): Record<string, unknown> {
    this.pos++;
    const entries: [string, unknown][] = [];
    this.space();
    if (this.text[this.pos] === "}") {
      this.pos++;
      return {};
    }
    for (;;) {
      this.space();
      if (this.text[this.pos] !== '"') {
        this.fail();
      }
      const key = this.string();
      this.expect(":");
      entries.push([key, this.value()]);
      if (this.next() === "}") {
        return jsonObject(entries);
      }
    }
  }

  private array(): unknown[] {
    this.pos++;
    const out: unknown[] = [];
    this.space();
    if (this.text[this.pos] === "]") {
      this.pos++;
      return out;
    }
    for (;;) {
      out.push(this.value());
      if (this.next() === "]") {
        return out;
      }
    }
  }

  // The separator after a member: "," or the given closer.
  private next(): string {
    this.space();
    const c = this.text[this.pos++];
    if (c !== "," && c !== "}" && c !== "]") {
      this.pos--;
      this.fail();
    }
    return c;
  }

  private string(): string {
    const start = this.pos;
    let escaped = false;
    let i = start + 1;
    for (;;) {
      const c = this.text.charCodeAt(i);
      if (Number.isNaN(c) || c < 0x20) {
        this.pos = i;
        this.fail();
      }
      if (c === 0x22) {
        break;
      }
      if (c === 0x5c) {
        escaped = true;
        i += 2;
      } else {
        i++;
      }
    }
    this.pos = i + 1;
    if (!escaped) {
      return this.text.slice(start + 1, i);
    }
    try {
      return JSON.parse(this.text.slice(start, this.pos)) as string;
    } catch {
      this.pos = start;
      this.fail();
    }
  }

  private word<T>(word: string, value: T): T {
    if (!this.text.startsWith(word, this.pos)) {
      this.fail();
    }
    this.pos += word.length;
    return value;
  }

  private expect(c: string): void {
    this.space();
    if (this.text[this.pos] !== c) {
      this.fail();
    }
    this.pos++;
  }

  private space(): void {
    for (;;) {
      const c = this.text.charCodeAt(this.pos);
      if (c !== 0x20 && c !== 0x0a && c !== 0x0d && c !== 0x09) {
        return;
      }
      this.pos++;
    }
  }

  private fail(): never {
    throw new JsonSyntaxError(this.pos);
  }
}

// `JSON.stringify` that writes keys in the order `jsonKeys` gives (only
// plain data: no replacer, `toJSON` honoured, `undefined` skipped).
export function stringifyJson(value: unknown, indent: number | string = ""): string {
  const gap = typeof indent === "number" ? " ".repeat(Math.min(10, indent)) : indent.slice(0, 10);
  return writeJson(value, gap, "") ?? "null";
}

function writeJson(value: unknown, gap: string, at: string): string | undefined {
  if (value !== null && typeof value === "object" && "toJSON" in value && typeof value.toJSON === "function") {
    value = value.toJSON();
  }
  if (value === null || typeof value !== "object") {
    // An exact whole number (see parseJson's `bigints`), written as digits.
    return typeof value === "bigint" ? value.toString() : JSON.stringify(value);
  }
  // A document must go through toEJSON first; written as is it would be `{}`.
  if (value instanceof Map) {
    throw new TypeError("stringifyJson: a Map (BsonDocument) needs toEJSON first");
  }
  const inner = at + gap;
  const open = gap ? `\n${inner}` : "";
  const close = gap ? `\n${at}` : "";
  const sep = gap ? `,\n${inner}` : ",";
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    return `[${open}${value.map((x) => writeJson(x, gap, inner) ?? "null").join(sep)}${close}]`;
  }
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of jsonKeys(record)) {
    const text = writeJson(record[key], gap, inner);
    if (text !== undefined) {
      parts.push(`${JSON.stringify(key)}:${gap ? " " : ""}${text}`);
    }
  }
  return parts.length === 0 ? "{}" : `{${open}${parts.join(sep)}${close}}`;
}

// ---- Equality and ordering ----

// Exact equality: same BSON types, same key order, NaN equals NaN.
export function deepEqual(a: BsonValue | undefined, b: BsonValue | undefined): boolean {
  if (a === undefined || b === undefined || a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return a === b;
  }
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isDocument(a)) {
    if (!isDocument(b) || a.size !== b.size) {
      return false;
    }
    const kb = [...b.keys()];
    let i = 0;
    for (const [key, value] of a) {
      if (key !== kb[i++] || !deepEqual(value, b.get(key))) {
        return false;
      }
    }
    return true;
  }
  if (a instanceof ObjectId) {
    return b instanceof ObjectId && a.hex === b.hex;
  }
  if (a instanceof Int32 || a instanceof Double) {
    return (b instanceof Int32 || b instanceof Double) && a.type === b.type && Object.is(a.value, b.value);
  }
  if (a instanceof Int64 || a instanceof Decimal128) {
    return (b instanceof Int64 || b instanceof Decimal128) && a.type === b.type && a.value === b.value;
  }
  if (a instanceof BsonDate) {
    return b instanceof BsonDate && a.ms === b.ms;
  }
  if (a instanceof Binary) {
    return b instanceof Binary && a.subType === b.subType && a.base64 === b.base64;
  }
  if (a instanceof BsonRegex) {
    return b instanceof BsonRegex && a.pattern === b.pattern && a.options === b.options;
  }
  if (a instanceof Timestamp) {
    return b instanceof Timestamp && a.t === b.t && a.i === b.i;
  }
  if (a instanceof Code) {
    return b instanceof Code && a.code === b.code && (a.scope === null || b.scope === null ? a.scope === b.scope : deepEqual(a.scope, b.scope));
  }
  // MinKey, MaxKey and Undefined carry no value.
  return !Array.isArray(b) && !isDocument(b) && a.type === b.type;
}

// MongoDB's canonical type order for comparisons (missing sorts as null).
function typeRank(v: BsonValue | undefined): number {
  if (v === undefined || v === null) {
    return 5;
  }
  switch (typeName(v)) {
    case "MinKey":
      return -1;
    case "Undefined":
      return 0;
    case "Int32":
    case "Int64":
    case "Double":
    case "Decimal128":
      return 10;
    case "String":
      return 15;
    case "Object":
      return 20;
    case "Array":
      return 25;
    case "Binary":
      return 30;
    case "ObjectId":
      return 35;
    case "Boolean":
      return 40;
    case "Date":
      return 45;
    case "Timestamp":
      return 47;
    case "Regex":
      return 50;
    case "Code":
      return 60;
    case "MaxKey":
      return 127;
    default:
      return 5;
  }
}

function cmp<T extends string | number | bigint>(a: T, b: T): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Total order used for client-side sorting: BSON type order first, then
// value. Numbers of different types compare by value; arrays and documents
// compare element by element.
export function compareForSort(a: BsonValue | undefined, b: BsonValue | undefined): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) {
    return ra < rb ? -1 : 1;
  }
  if (typeof a === "string" && typeof b === "string") {
    return cmp(a, b);
  }
  if (typeof a === "boolean" && typeof b === "boolean") {
    return cmp(Number(a), Number(b));
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = compareForSort(a[i], b[i]);
      if (c !== 0) {
        return c;
      }
    }
    return cmp(a.length, b.length);
  }
  if (isDocument(a) && isDocument(b)) {
    const ea = [...a];
    const eb = [...b];
    for (let i = 0; i < Math.min(ea.length, eb.length); i++) {
      const [ka, va] = ea[i];
      const [kb, vb] = eb[i];
      const c = cmp(typeRank(va), typeRank(vb)) || cmp(ka, kb) || compareForSort(va, vb);
      if (c !== 0) {
        return c;
      }
    }
    return cmp(ea.length, eb.length);
  }
  if (isNumber(a) && isNumber(b)) {
    return compareNumbers(a, b);
  }
  if (a instanceof ObjectId && b instanceof ObjectId) {
    return cmp(a.hex, b.hex);
  }
  if (a instanceof BsonDate && b instanceof BsonDate) {
    return cmp(a.ms, b.ms);
  }
  if (a instanceof Timestamp && b instanceof Timestamp) {
    return cmp(a.t, b.t) || cmp(a.i, b.i);
  }
  if (a instanceof Binary && b instanceof Binary) {
    return cmp(a.byteLength(), b.byteLength()) || cmp(a.subType, b.subType) || cmp(base64ToHex(a.base64) ?? "", base64ToHex(b.base64) ?? "");
  }
  if (a instanceof BsonRegex && b instanceof BsonRegex) {
    return cmp(a.pattern, b.pattern) || cmp(a.options, b.options);
  }
  if (a instanceof Code && b instanceof Code) {
    return cmp(a.code, b.code);
  }
  return 0;
}

// A number as sign × coefficient × 10^exponent, or a special value.
type Exact = { kind: "nan" } | { kind: "inf"; neg: boolean } | { kind: "finite"; coef: bigint; exp: number };

function exactOf(v: BsonNumber): Exact {
  switch (v.type) {
    case "Int32":
      return { kind: "finite", coef: BigInt(v.value), exp: 0 };
    case "Int64":
      return { kind: "finite", coef: v.value, exp: 0 };
    case "Double":
      if (Number.isNaN(v.value)) {
        return { kind: "nan" };
      }
      if (!Number.isFinite(v.value)) {
        return { kind: "inf", neg: v.value < 0 };
      }
      return exactFromText(String(v.value));
    case "Decimal128":
      return exactFromText(v.value);
  }
}

function exactFromText(text: string): Exact {
  const lower = text.toLowerCase();
  if (lower.endsWith("nan")) {
    return { kind: "nan" };
  }
  if (lower.endsWith("inf") || lower.endsWith("infinity")) {
    return { kind: "inf", neg: lower.startsWith("-") };
  }
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/.exec(lower);
  if (!m) {
    return { kind: "nan" };
  }
  const frac = m[3] ?? "";
  return { kind: "finite", coef: BigInt(`${m[1]}${m[2] || "0"}${frac}`), exp: (m[4] ? parseInt(m[4], 10) : 0) - frac.length };
}

function compareNumbers(a: BsonNumber, b: BsonNumber): number {
  const x = exactOf(a);
  const y = exactOf(b);
  // NaN sorts below every other number, as in MongoDB.
  const rank = (e: Exact) => (e.kind === "nan" ? 0 : e.kind === "inf" ? (e.neg ? 1 : 3) : 2);
  if (rank(x) !== rank(y) || x.kind !== "finite" || y.kind !== "finite") {
    return cmp(rank(x), rank(y));
  }
  const exp = Math.min(x.exp, y.exp);
  return cmp(x.coef * 10n ** BigInt(x.exp - exp), y.coef * 10n ** BigInt(y.exp - exp));
}

// ---- Bytes ----

function hexToBase64(hex: string): string {
  let bin = "";
  for (let i = 0; i < hex.length; i += 2) {
    bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  }
  return btoa(bin);
}

export function base64ToHex(base64: string): string | null {
  try {
    const bin = atob(base64);
    let hex = "";
    for (let i = 0; i < bin.length; i++) {
      hex += bin.charCodeAt(i).toString(16).padStart(2, "0");
    }
    return hex;
  } catch {
    return null;
  }
}
