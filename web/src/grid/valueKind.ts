import type { ValueKind } from "../palette";

const DATE_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const TIME_PATTERN = /^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/;
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
    if (DATE_PATTERN.test(trimmed) || TIME_PATTERN.test(trimmed)) {
      return "date";
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
