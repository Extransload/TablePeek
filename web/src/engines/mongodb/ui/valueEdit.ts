// Typed value editing shared by the cards, the table cells and the detail
// panel: the text a value is edited as, reading typed text back keeping the
// value's BSON type, and switching a value to another type.

import { t } from "../../../i18n";
import { BsonDate, Decimal128, Double, Int32, Int64, ObjectId, doubleText, isDocument, typeName, type BsonTypeName, type BsonValue } from "../bson";
import { cellText, toShell } from "../format";
import { parseValue } from "../shell/parse";

// The types the type menu offers, in Compass's order.
export const EDIT_TYPES: BsonTypeName[] = ["String", "Int32", "Int64", "Double", "Decimal128", "Boolean", "Date", "ObjectId", "Null", "Object", "Array"];

export type Coerced = { value: BsonValue } | { error: string };

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
        return { error: t("Int32 값이 아닙니다 — 정수를 쓰거나 타입을 바꾸세요") };
      }
      return { value: new Int32(n) };
    }
    case "Int64":
      if (!/^[+-]?\d+$/.test(s)) {
        return { error: t("Int64 값이 아닙니다 — 정수를 쓰세요") };
      }
      try {
        return { value: new Int64(s) };
      } catch (error) {
        return { error: (error as Error).message };
      }
    case "Double":
      if (s === "" || !(Number.isFinite(Number(s)) || /^[+-]?(Infinity|NaN)$/.test(s))) {
        return { error: t("Double 값이 아닙니다") };
      }
      return { value: new Double(Number(s)) };
    case "Decimal128":
      if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) {
        return { error: t("Decimal128 값이 아닙니다 — 예: 318.74") };
      }
      return { value: new Decimal128(s) };
    case "Boolean":
      if (!/^(true|false)$/i.test(s)) {
        return { error: t("Boolean 값은 true 또는 false입니다") };
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
        return { error: t("날짜로 읽을 수 없습니다 — 예: 2025-03-01T09:30:00Z") };
      }
      return { value: new BsonDate(ms) };
    }
    case "ObjectId":
      if (!/^[0-9a-fA-F]{24}$/.test(s)) {
        return { error: t("ObjectId는 16진수 24자리입니다") };
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
      return {};
    case "Array":
      return [];
    default:
      return null;
  }
}

// `v` as `type`: kept when the text converts (5 → "5", "12" → Int32 12),
// otherwise the type's default.
export function convertType(v: BsonValue, type: BsonTypeName): BsonValue {
  if (typeName(v) === type) {
    return v;
  }
  switch (type) {
    case "Object":
      return {};
    case "Array":
      return v === null || v === "" ? [] : [v];
    case "Null":
      return null;
    case "String":
      return editText(v);
    case "Boolean":
      return v !== null && v !== "" && v !== false && !(isDocument(v) && Object.keys(v).length === 0) && editText(v) !== "0";
  }
  const r = coerceInput(editText(v), type);
  return "error" in r ? defaultOfType(type) : r.value;
}
