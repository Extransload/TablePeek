// Typed value editing shared by the cards, the table cells and the detail
// panel: the text a value is edited as, reading typed text back keeping the
// value's BSON type, and switching a value to another type.

import { errorPhrase, phrase, type Phrase } from "../../../i18n";
import { BsonDate, Decimal128, Double, Int32, Int64, ObjectId, deepEqual, doubleText, isDocument, isNumber, typeName, type BsonTypeName, type BsonValue } from "../bson";
import { cellText, toShell } from "../format";
import { parseValue } from "../shell/parse";

// The types the type menu offers, in Compass's order.
export const EDIT_TYPES: BsonTypeName[] = ["String", "Int32", "Int64", "Double", "Decimal128", "Boolean", "Date", "ObjectId", "Null", "Object", "Array"];

// `error` is translated where it shows, so it follows a language switch.
export type Coerced = { value: BsonValue } | { error: Phrase };

// A constructor typed out (`NumberLong(5)`, `ISODate("…")`) says the type
// itself, whatever the field held before.
const EXPLICIT_CTOR = /^\s*(new\s+Date|ObjectId|ISODate|NumberDecimal|Decimal128|NumberInt|NumberLong|Int32|Long|Double|UUID|Timestamp|BinData|Binary)\s*\(/;

function parsed(text: string): Coerced {
  const r = parseValue(text);
  return r.ok ? { value: r.value } : { error: r.error.message };
}

// The value `text` means for a field of type `type`. Plain `null` clears any
// non-string field; strings take the text as typed.
export function coerceInput(text: string, type: BsonTypeName): Coerced {
  if (EXPLICIT_CTOR.test(text)) {
    return parsed(text);
  }
  const s = text.trim();
  if (type !== "String" && s === "null") {
    return { value: null };
  }
  switch (type) {
    case "String":
      return { value: text };
    case "Int32": {
      const n = Number(s);
      if (!/^[+-]?\d+$/.test(s) || n < -2147483648 || n > 2147483647) {
        return { error: phrase("Int32 값이 아닙니다 — 정수를 쓰거나 타입을 바꾸세요") };
      }
      return { value: new Int32(n) };
    }
    case "Int64":
      if (!/^[+-]?\d+$/.test(s)) {
        return { error: phrase("Int64 값이 아닙니다 — 정수를 쓰세요") };
      }
      try {
        return { value: new Int64(s) };
      } catch (error) {
        return { error: errorPhrase(error) };
      }
    case "Double":
      if (s === "" || !(Number.isFinite(Number(s)) || /^[+-]?(Infinity|NaN)$/.test(s))) {
        return { error: phrase("Double 값이 아닙니다") };
      }
      return { value: new Double(Number(s)) };
    case "Decimal128":
      if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) {
        return { error: phrase("Decimal128 값이 아닙니다 — 예: 318.74") };
      }
      return { value: new Decimal128(s) };
    case "Boolean":
      if (!/^(true|false)$/i.test(s)) {
        return { error: phrase("Boolean 값은 true 또는 false입니다") };
      }
      return { value: s.toLowerCase() === "true" };
    case "Date": {
      let iso = s.replace(" ", "T");
      if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
        iso += "T00:00:00Z";
      } else if (/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(iso)) {
        iso += "Z";
      }
      const ms = Date.parse(iso);
      if (Number.isNaN(ms)) {
        return { error: phrase("날짜로 읽을 수 없습니다 — 예: 2025-03-01T09:30:00Z") };
      }
      return { value: new BsonDate(ms) };
    }
    case "ObjectId":
      if (!/^[0-9a-fA-F]{24}$/.test(s)) {
        return { error: phrase("ObjectId는 16진수 24자리입니다") };
      }
      return { value: new ObjectId(s) };
    case "Null":
      return { value: null };
    default:
      return s === "" ? { value: "" } : parsed(s);
  }
}

// The text a value is edited as: bare digits, ISO dates, the hex of an id;
// documents and arrays in mongosh notation.
export function editText(v: BsonValue | undefined): string {
  if (v === undefined || v === null) {
    return "";
  }
  if (typeof v === "string") {
    return v;
  }
  if (v instanceof BsonDate) {
    return v.iso() ?? toShell(v);
  }
  if (v instanceof Double) {
    return doubleText(v.value);
  }
  if (v instanceof Int32 || v instanceof Int64 || v instanceof Decimal128) {
    return String(v.value);
  }
  if (v instanceof ObjectId) {
    return v.hex;
  }
  if (typeof v === "boolean") {
    return String(v);
  }
  return toShell(v);
}

// How a value reads in a card's value box.
export function valueText(v: BsonValue): string {
  if (v === null) {
    return "null";
  }
  if (v instanceof BsonDate) {
    return v.iso() ?? toShell(v);
  }
  if (v instanceof ObjectId) {
    return `ObjectId('${v.hex}')`;
  }
  // A non-breaking space keeps an empty string's box its height.
  if (typeof v === "string") {
    return v === "" ? "\u00a0" : v;
  }
  return cellText(v);
}

// A fresh value of `type`, for a new field or a failed conversion.
export function defaultOfType(type: BsonTypeName): BsonValue {
  switch (type) {
    case "String":
      return "";
    case "Int32":
      return new Int32(0);
    case "Int64":
      return new Int64(0n);
    case "Double":
      return new Double(0);
    case "Decimal128":
      return new Decimal128("0");
    case "Boolean":
      return false;
    case "Date":
      return new BsonDate(Math.floor(Date.now() / 1000) * 1000);
    case "ObjectId":
      return ObjectId.generate();
    case "Object":
      return new Map();
    case "Array":
      return [];
    default:
      return null;
  }
}

// `v` as `type`: kept when the text converts (5 → "5", "12" → Int32 12),
// a number made an integer drops its fraction toward zero as mongosh's
// NumberInt/NumberLong do (1.5 → 1, -2.7 → -2), otherwise the type's default.
export function convertType(v: BsonValue, type: BsonTypeName): BsonValue {
  if (typeName(v) === type) {
    return v;
  }
  switch (type) {
    case "Object":
      return new Map();
    case "Array":
      return v === null || v === "" ? [] : [v];
    case "Null":
      return null;
    case "String":
      return editText(v);
    case "Boolean":
      return v !== null && v !== "" && v !== false && !(isDocument(v) && v.size === 0) && editText(v) !== "0";
  }
  const text = (type === "Int32" || type === "Int64") && isNumber(v) ? wholePart(exactNumber(v)) : editText(v);
  const r = coerceInput(text, type);
  return "error" in r ? defaultOfType(type) : r.value;
}

// The integer part of a number's text, toward zero ("-0.5" → "0"). Text in
// exponent form (a huge Double, a Decimal128 like "1.5E+3") goes through the
// number's value; NaN and infinities are left for the type check to refuse.
function wholePart(text: string): string {
  if (/[eE]/.test(text)) {
    const n = Number(text);
    return Number.isFinite(n) ? BigInt(Math.trunc(n)).toString() : text;
  }
  const whole = text.split(".")[0];
  return whole === "-0" || whole === "-" || whole === "" ? "0" : whole;
}

// A number's exact value as decimal text, the same for every type that can
// hold it (Int32 7, Double 7, Int64 7, Decimal128 "7.00" all read "7").
function exactNumber(n: Int32 | Int64 | Double | Decimal128): string {
  if (n instanceof Int64) {
    return n.value.toString();
  }
  if (n instanceof Decimal128) {
    const m = /^([+-]?)0*(\d*?)(?:\.(\d*?)0*)?$/.exec(n.value);
    if (m === null) {
      return n.value;
    }
    const whole = m[2] === "" ? "0" : m[2];
    const text = m[3] ? `${whole}.${m[3]}` : whole;
    return m[1] === "-" && text !== "0" ? `-${text}` : text;
  }
  return Number.isSafeInteger(n.value) ? BigInt(n.value).toString() : String(n.value);
}

// Whether `next`, `v` converted to another type, still holds all of `v`:
// the same number, a string that reads back as the same text or number,
// `v` converting back from it unchanged, or `v` wrapped in an array. Null,
// an empty string, document or array hold nothing to lose. A string that
// does not read as the target, a fraction made whole, a number past the
// target's precision, a document made a scalar do not.
export function keepsValue(v: BsonValue, next: BsonValue): boolean {
  if (v === null || v === "" || (Array.isArray(v) && v.length === 0) || (isDocument(v) && v.size === 0)) {
    return true;
  }
  if (Array.isArray(next) && next.length === 1 && deepEqual(next[0], v)) {
    return true;
  }
  if (isNumber(v) && isNumber(next)) {
    return exactNumber(v) === exactNumber(next);
  }
  if (typeof v === "string") {
    return editText(next) === v || (isNumber(next) && exactNumber(next) === v);
  }
  return deepEqual(convertType(next, typeName(v)), v);
}
