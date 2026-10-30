// Elasticsearch and OpenSearch keep documents as plain JSON. The document
// views shared with MongoDB (cards, JSON blocks, the table and its detail
// panel) hold `BsonValue`s, so a `_source` is turned into one on the way in
// (numbers become Int32, Int64 or Double by their shape, objects keep their
// key order) and back into plain JSON on the way out. Values only BSON has,
// picked from a card's type menu, are written the way Elasticsearch reads
// them: dates as ISO text, ids as hex, binary as base64.

import {
  Binary,
  BsonDate,
  BsonRegex,
  Code,
  Decimal128,
  Double,
  Int32,
  Int64,
  ObjectId,
  Timestamp,
  isDocument,
  jsonKeys,
  jsonObject,
  parseJson,
  stringifyJson,
  type BsonDocument,
  type BsonValue,
} from "../mongodb/bson";

// `bigint`: a whole number past 2^53, read and written exactly (a `long` or
// `unsigned_long` value).
export type Json = string | number | bigint | boolean | null | Json[] | { [key: string]: Json };

// A number as the card views type it: whole numbers that fit 32 bits are
// Int32, larger safe ones Int64, everything else Double.
function numberValue(n: number): BsonValue {
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

// A value from parsed JSON (read with `parseJson` so key order holds).
export function fromJson(json: unknown): BsonValue {
  if (json === null || json === undefined) {
    return null;
  }
  if (typeof json === "string" || typeof json === "boolean") {
    return json;
  }
  if (typeof json === "number") {
    return numberValue(json);
  }
  if (typeof json === "bigint") {
    return json >= -(2n ** 63n) && json < 2n ** 63n ? new Int64(json) : new Decimal128(json.toString());
  }
  if (Array.isArray(json)) {
    return json.map(fromJson);
  }
  if (typeof json === "object") {
    const obj = json as Record<string, unknown>;
    const doc: BsonDocument = new Map();
    for (const key of jsonKeys(obj)) {
      doc.set(key, fromJson(obj[key]));
    }
    return doc;
  }
  return String(json);
}

// A JSON object as a document; anything else as an empty one.
export function docFromJson(json: unknown): BsonDocument {
  const value = fromJson(json);
  return isDocument(value) ? value : new Map();
}

// Plain JSON for a value, keeping document key order for `stringifyJson`.
export function toJson(v: BsonValue): Json {
  if (v === null || typeof v === "string" || typeof v === "boolean") {
    return v;
  }
  if (Array.isArray(v)) {
    return v.map(toJson);
  }
  if (isDocument(v)) {
    return jsonObject([...v].map(([key, value]): [string, Json] => [key, toJson(value)]));
  }
  if (v instanceof Int32 || v instanceof Double) {
    return Number.isFinite(v.value) ? v.value : String(v.value);
  }
  if (v instanceof Int64) {
    const n = Number(v.value);
    return Number.isSafeInteger(n) ? n : v.value;
  }
  if (v instanceof Decimal128) {
    const n = Number(v.value);
    if (Number.isFinite(n) && String(n) === v.value) {
      return n;
    }
    return /^-?\d+$/.test(v.value) ? BigInt(v.value) : v.value;
  }
  if (v instanceof BsonDate) {
    return v.iso() ?? String(v.ms);
  }
  if (v instanceof ObjectId) {
    return v.hex;
  }
  if (v instanceof Binary) {
    return v.base64;
  }
  if (v instanceof BsonRegex) {
    return v.pattern;
  }
  if (v instanceof Code) {
    return v.code;
  }
  if (v instanceof Timestamp) {
    return v.t;
  }
  return null;
}

// Pretty JSON text (two-space indent), keys in their order.
export function jsonText(v: BsonValue, indent = 2): string {
  return stringifyJson(toJson(v), indent);
}

// JSON text as a value; throws `JsonSyntaxError` (with the offset) when the
// text does not parse.
export function parseJsonValue(text: string): BsonValue {
  return fromJson(parseJson(text, { bigints: true }));
}

// A plain number from a JSON-ish value (counts, sizes), or null.
export function num(v: unknown): number | null {
  if (typeof v === "number") {
    return v;
  }
  if (typeof v === "bigint") {
    return Number(v);
  }
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Number(v);
  }
  return null;
}

// A record from a JSON-ish value, or an empty one.
export function rec(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function list(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

export function str(v: unknown): string {
  return typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
}
