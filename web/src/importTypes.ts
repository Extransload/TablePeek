import { JsonNumber } from "./importParse";

// Column types for a table made from an imported file, guessed from its
// values: integer, decimal, boolean, date or datetime when every non-empty
// value reads as one, else text. Numbers with leading zeros (zip codes,
// phone numbers) stay text so the zeros survive.

export type ValueKind =
  | "integer"
  | "bigint"
  | "decimal"
  | "double"
  | "boolean"
  | "date"
  | "datetime"
  | "datetimetz"
  | "text";

export interface ColumnProfile {
  kind: ValueKind;
  // Longest value, in characters.
  maxLength: number;
  // Digits before and after the point, for a decimal's precision and scale.
  intDigits: number;
  scale: number;
  // Most fractional-second digits a datetime had.
  fraction: number;
}

const INT_RE = /^[+-]?(?:0|[1-9]\d*)$/;
const DEC_RE = /^[+-]?(?:0|[1-9]\d*)\.(\d+)$/;
const EXP_RE = /^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?[eE][+-]?\d+$/;
const BOOL_RE = /^(?:true|false)$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;

const INT32_MAX = 2147483647n;
const INT64_MAX = 9223372036854775807n;

function validDate(year: string, month: string, day: string): boolean {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (m < 1 || m > 12 || d < 1) {
    return false;
  }
  // Day 0 of the next month is this month's last day.
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

interface ValueReading {
  kind: ValueKind;
  intDigits: number;
  scale: number;
  fraction: number;
}

function digitsOf(text: string): string {
  return text.replace(/^[+-]/, "");
}

function integerKind(text: string): ValueReading {
  const magnitude = BigInt(digitsOf(text));
  const limit = text.startsWith("-") ? 1n : 0n;
  if (magnitude <= INT32_MAX + limit) {
    return { kind: "integer", intDigits: digitsOf(text).length, scale: 0, fraction: 0 };
  }
  if (magnitude <= INT64_MAX + limit) {
    return { kind: "bigint", intDigits: digitsOf(text).length, scale: 0, fraction: 0 };
  }
  return { kind: "decimal", intDigits: digitsOf(text).length, scale: 0, fraction: 0 };
}

function readText(text: string): ValueReading {
  const plain: ValueReading = { kind: "text", intDigits: 0, scale: 0, fraction: 0 };
  if (INT_RE.test(text)) {
    return integerKind(text);
  }
  const decimal = DEC_RE.exec(text);
  if (decimal !== null) {
    const whole = digitsOf(text).split(".")[0];
    return { kind: "decimal", intDigits: whole.length, scale: decimal[1].length, fraction: 0 };
  }
  if (EXP_RE.test(text)) {
    return { ...plain, kind: "double" };
  }
  if (BOOL_RE.test(text)) {
    return { ...plain, kind: "boolean" };
  }
  const date = DATE_RE.exec(text);
  if (date !== null) {
    return validDate(date[1], date[2], date[3]) ? { ...plain, kind: "date" } : plain;
  }
  const stamp = DATETIME_RE.exec(text);
  if (stamp !== null) {
    const timeOk =
      Number(stamp[4]) < 24 && Number(stamp[5]) < 60 && (stamp[6] === undefined || Number(stamp[6]) < 60);
    if (!validDate(stamp[1], stamp[2], stamp[3]) || !timeOk) {
      return plain;
    }
    return {
      ...plain,
      kind: stamp[8] === undefined ? "datetime" : "datetimetz",
      fraction: stamp[7]?.length ?? 0,
    };
  }
  return plain;
}

// null: an empty value, which says nothing about the column's type.
function readValue(value: unknown): ValueReading | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  if (typeof value === "boolean") {
    return { kind: "boolean", intDigits: 0, scale: 0, fraction: 0 };
  }
  // Read as written: a 19-digit id is a bigint, not a double, and a long
  // decimal with an exponent a decimal too.
  if (value instanceof JsonNumber) {
    return readText(value.plain);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return { kind: "text", intDigits: 0, scale: 0, fraction: 0 };
    }
    const text = String(value);
    if (Number.isSafeInteger(value)) {
      return integerKind(text);
    }
    return DEC_RE.test(text) ? readText(text) : { kind: "double", intDigits: 0, scale: 0, fraction: 0 };
  }
  if (typeof value === "bigint") {
    return integerKind(value.toString());
  }
  if (typeof value === "string") {
    return readText(value);
  }
  return { kind: "text", intDigits: 0, scale: 0, fraction: 0 };
}

const NUMERIC_RANK: Partial<Record<ValueKind, number>> = { integer: 0, bigint: 1, decimal: 2, double: 3 };

// The narrowest kind that holds both.
function widen(a: ValueKind, b: ValueKind): ValueKind {
  if (a === b) {
    return a;
  }
  const rankA = NUMERIC_RANK[a];
  const rankB = NUMERIC_RANK[b];
  if (rankA !== undefined && rankB !== undefined) {
    return rankA >= rankB ? a : b;
  }
  if ((a === "date" && b === "datetime") || (a === "datetime" && b === "date")) {
    return "datetime";
  }
  if ((a === "date" && b === "datetimetz") || (a === "datetimetz" && b === "date")) {
    return "datetimetz";
  }
  return "text";
}

export function profileColumn(values: Iterable<unknown>): ColumnProfile {
  let kind: ValueKind | null = null;
  let maxLength = 0;
  let intDigits = 0;
  let scale = 0;
  let fraction = 0;
  for (const value of values) {
    if (value !== null && value !== undefined) {
      const length = typeof value === "string" ? value.length : String(value).length;
      maxLength = Math.max(maxLength, length);
    }
    if (kind === "text") {
      continue;
    }
    const reading = readValue(value);
    if (reading === null) {
      continue;
    }
    kind = kind === null ? reading.kind : widen(kind, reading.kind);
    intDigits = Math.max(intDigits, reading.intDigits);
    scale = Math.max(scale, reading.scale);
    fraction = Math.max(fraction, reading.fraction);
  }
  return { kind: kind ?? "text", maxLength, intDigits, scale, fraction };
}

export function textProfile(maxLength = 0): ColumnProfile {
  return { kind: "text", maxLength, intDigits: 0, scale: 0, fraction: 0 };
}

function family(dialect: string): "postgres" | "mysql" | "sqlite" | "mssql" {
  if (dialect === "postgres" || dialect === "cockroach") {
    return "postgres";
  }
  return dialect === "mysql" || dialect === "mssql" ? dialect : "sqlite";
}

// The type the dialect spells for a profile.
export function typeName(profile: ColumnProfile, dialect: string): string {
  const { kind } = profile;
  const precision = profile.intDigits + profile.scale;
  switch (family(dialect)) {
    case "postgres":
      return {
        integer: "integer",
        bigint: "bigint",
        decimal: "numeric",
        double: "double precision",
        boolean: "boolean",
        date: "date",
        datetime: "timestamp",
        datetimetz: "timestamptz",
        text: "text",
      }[kind];
    case "mysql":
      if (kind === "decimal") {
        return precision > 0 && precision <= 65 && profile.scale <= 30
          ? `decimal(${Math.max(precision, 1)},${profile.scale})`
          : "double";
      }
      if (kind === "datetime") {
        return profile.fraction > 0 ? `datetime(${Math.min(profile.fraction, 6)})` : "datetime";
      }
      if (kind === "text" || kind === "datetimetz") {
        // TEXT holds 65,535 bytes: 16,383 characters of four bytes each.
        return profile.maxLength > 16383 ? "longtext" : "text";
      }
      return { integer: "int", bigint: "bigint", double: "double", boolean: "tinyint(1)", date: "date" }[kind];
    case "mssql":
      if (kind === "decimal") {
        return precision > 0 && precision <= 38 ? `decimal(${precision},${profile.scale})` : "float";
      }
      if (kind === "text") {
        return profile.maxLength > 4000 ? "nvarchar(max)" : profile.maxLength > 255 ? "nvarchar(4000)" : "nvarchar(255)";
      }
      return {
        integer: "int",
        bigint: "bigint",
        double: "float",
        boolean: "bit",
        date: "date",
        datetime: "datetime2",
        datetimetz: "datetimeoffset",
      }[kind];
    default:
      return {
        integer: "INTEGER",
        bigint: "INTEGER",
        decimal: "REAL",
        double: "REAL",
        boolean: "BOOLEAN",
        date: "DATE",
        datetime: "DATETIME",
        datetimetz: "DATETIME",
        text: "TEXT",
      }[kind];
  }
}

// The types a new column's menu offers, with the guessed one among them.
export function typeChoices(dialect: string, guessed: string): string[] {
  const kinds: ValueKind[] = ["text", "integer", "bigint", "decimal", "double", "boolean", "date", "datetime", "datetimetz"];
  const names = kinds.map((kind) => typeName({ ...textProfile(), kind, intDigits: 10, scale: 2 }, dialect));
  if (family(dialect) === "postgres") {
    names.push("varchar(255)", "jsonb");
  } else if (family(dialect) === "mysql") {
    names.push("varchar(255)", "json");
  }
  return [...new Set([guessed, ...names])];
}

// What a destination column's declared type wants from text values: booleans
// written as true/false or yes/no become the engine's TRUE/FALSE (MySQL's
// TINYINT(1) and SQLite won't read the word), the rest go in as written.
// BIT is a flag only in SQL Server and MySQL; PostgreSQL's bit(n) is a bit
// string, which takes '1' and refuses TRUE.
export function wantsBoolean(declType: string | null, dialect = ""): boolean {
  const type = (declType ?? "").trim().toLowerCase();
  if (/^bit\b/.test(type)) {
    return dialect === "mssql" || dialect === "mysql";
  }
  return /^(bool|boolean)\b/.test(type) || /^tinyint\s*\(\s*1\s*\)/.test(type);
}

const TRUE_RE = /^(?:true|t|yes|y|on|1)$/i;
const FALSE_RE = /^(?:false|f|no|n|off|0)$/i;

export function asBoolean(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const text = value.trim();
  if (TRUE_RE.test(text)) {
    return true;
  }
  return FALSE_RE.test(text) ? false : value;
}
