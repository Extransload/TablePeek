import type { ValueKind } from "../palette";
import type { CellKind } from "./columns";

const DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const TIME_PATTERN = /^\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// What every engine sends in place of a binary value.
const BINARY_PATTERN = /^<blob \d+ bytes>$/;
const INTEGER_TEXT = /^-?\d+$/;
const DECIMAL_TEXT = /^-?\d+\.\d+$/;
const JSON_PROBE_LIMIT = 4096;
const JSON_CACHE_LIMIT = 512;

const jsonKinds = new Map<string, ValueKind | null>();

function classifyJsonText(text: string): ValueKind | null {
  const cached = jsonKinds.get(text);
  if (cached !== undefined) {
    return cached;
  }
  const trimmed = text.trim();
  let kind: ValueKind | null = null;
  if (trimmed.length > JSON_PROBE_LIMIT) {
    kind = trimmed.startsWith("[") ? "list" : "json";
  } else {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        kind = "list";
      } else if (parsed !== null && typeof parsed === "object") {
        kind = "json";
      }
    } catch {}
  }
  if (jsonKinds.size >= JSON_CACHE_LIMIT) {
    jsonKinds.clear();
  }
  jsonKinds.set(text, kind);
  return kind;
}

export function classifyValue(value: unknown): ValueKind | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (DATE_PATTERN.test(trimmed)) {
      return "date";
    }
    if (TIME_PATTERN.test(trimmed)) {
      return "time";
    }
    if (UUID_PATTERN.test(trimmed)) {
      return "uuid";
    }
    if (BINARY_PATTERN.test(trimmed)) {
      return "binary";
    }
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      const kind = classifyJsonText(value);
      if (kind !== null) {
        return kind;
      }
    }
    if (INTEGER_TEXT.test(trimmed)) {
      return trimmed.replace(/^-/, "").length > 15 ? "bigint" : "string";
    }
    if (DECIMAL_TEXT.test(trimmed)) {
      return "float";
    }
    return "string";
  }
  if (typeof value === "bigint") {
    return "bigint";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "float";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (Array.isArray(value)) {
    return "list";
  }
  if (value !== null && typeof value === "object") {
    return "json";
  }
  return null;
}

// A cell's kind: what its column is declared as when the table says (MySQL's
// and SQLite's booleans are 1 and 0, an enum's labels are plain text), else
// what its value looks like.
export function classifyCell(value: unknown, column: CellKind | undefined): ValueKind | null {
  if (value === null || value === undefined) {
    return null;
  }
  switch (column) {
    case "boolean":
      return "boolean";
    case "enum":
    case "set":
      return "enum";
    case "date":
    case "datetime":
      return "date";
    case "time":
      return "time";
    default:
      return classifyValue(value);
  }
}
