// How a Redis value's bytes are read, as RedisInsight's formatters do:
// Unicode text, redis-cli's escaped ASCII, bits, hex, JSON, Markdown,
// MessagePack, Base64 (decoded, then read again), Python pickle, Protocol
// Buffers without a schema, PHP serialize(), Java serialization, float
// vectors and Unix timestamps. Auto picks one from the bytes; the data
// grid's kinds colour a hash's or list's values the same way. Pure
// functions, no React.

import { decode, encode, ExtData } from "@msgpack/msgpack";
import { prettyLines, type JsonInk } from "../../jsonIndex";
import { javaValue, looksLikeJava } from "./decode/java";
import type { Nest } from "./decode/nest";
import { looksLikePhp, phpValue } from "./decode/php";
import { looksLikePickle, pickleValue } from "./decode/pickle";
import { protobufValue } from "./decode/protobuf";

export type ValueFormat =
  | "text"
  | "ascii"
  | "binary"
  | "hex"
  | "json"
  | "markdown"
  | "msgpack"
  | "base64"
  | "pickle"
  | "protobuf"
  | "php"
  | "java"
  | "vector32"
  | "vector64"
  | "timestamp";
export type FormatChoice = "auto" | ValueFormat;

// RedisInsight's order, Base64 beside MessagePack.
export const FORMATS: ValueFormat[] = ["text", "ascii", "binary", "hex", "json", "markdown", "msgpack", "base64", "pickle", "protobuf", "php", "java", "vector32", "vector64", "timestamp"];

// Shown decoded and never edited in that form (Unicode, JSON or HEX edit them).
export const READ_ONLY_FORMATS: Record<string, true> = { binary: true, pickle: true, protobuf: true, php: true, java: true, vector32: true, vector64: true, timestamp: true };

export const BOM = "\uFEFF";

const UTF8 = new TextDecoder("utf-8", { fatal: true });

// The bytes as UTF-8 text, or null when they aren't UTF-8.
export function utf8(bytes: Uint8Array): string | null {
  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
}

export function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(1) : text;
}

// The JSON object or array the text holds (a byte order mark and spaces
// around it allowed); null for anything else, a lone number or string too.
export function jsonDocument(text: string): object | null {
  const trimmed = stripBom(text).trim();
  const first = trimmed.charCodeAt(0);
  if (first !== 123 && first !== 91) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// Where JSON text first goes wrong: a character offset, or -1 when it is
// valid. The engines' messages don't always carry a position.
function jsonFailureAt(text: string): number {
  let at = 0;
  const fail = (where: number): never => {
    throw where;
  };
  const space = () => {
    while (at < text.length && " \t\n\r".includes(text[at])) {
      at += 1;
    }
  };
  const value = (): void => {
    space();
    const ch = text[at];
    if (ch === "{" || ch === "[") {
      const close = ch === "{" ? "}" : "]";
      at += 1;
      space();
      if (text[at] === close) {
        at += 1;
        return;
      }
      for (;;) {
        if (ch === "{") {
          space();
          if (text[at] !== '"') {
            fail(at);
          }
          value();
          space();
          if (text[at] !== ":") {
            fail(at);
          }
          at += 1;
        }
        value();
        space();
        if (text[at] === ",") {
          at += 1;
        } else if (text[at] === close) {
          at += 1;
          return;
        } else {
          fail(at);
        }
      }
    }
    if (ch === '"') {
      at += 1;
      while (at < text.length && text[at] !== '"') {
        const code = text.charCodeAt(at);
        if (code < 0x20) {
          fail(at);
        }
        if (text[at] === "\\") {
          const next = text[at + 1];
          if (next === "u") {
            if (!/^[0-9a-fA-F]{4}$/.test(text.slice(at + 2, at + 6))) {
              fail(at);
            }
            at += 6;
            continue;
          }
          if (next === undefined || !'"\\/bfnrt'.includes(next)) {
            fail(at);
          }
          at += 2;
          continue;
        }
        at += 1;
      }
      if (at >= text.length) {
        fail(at);
      }
      at += 1;
      return;
    }
    const literal = /^(true|false|null|-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?)/.exec(text.slice(at, at + 400));
    if (literal === null) {
      fail(at);
    } else {
      at += literal[0].length;
    }
  };
  try {
    value();
    space();
    return at < text.length ? at : -1;
  } catch (where) {
    return typeof where === "number" ? where : text.length;
  }
}

// Why the text isn't JSON and where (a character offset into `text`); null
// when it is.
export function jsonError(text: string): { message: string; at: number } | null {
  const lead = text.startsWith(BOM) ? 1 : 0;
  const body = text.slice(lead);
  try {
    JSON.parse(body);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const found = jsonFailureAt(body);
    // The engine's wording without the offset, which the editor marks.
    const short = message
      .replace(/\s*\(line \d+ column \d+\)/, "")
      .replace(/\s*(in JSON )?at position \d+/, "")
      .replace(/^JSON\.parse: /, "")
      .replace(/, (\.\.\.)?"[\s\S]*" is not valid JSON$/, "");
    return { message: short, at: (found < 0 ? body.length : found) + lead };
  }
}

// Valid JSON indented two spaces a level; numbers and escapes as stored.
export function prettyJson(text: string): string {
  return prettyLines(stripBom(text).trim()).join("\n");
}

// Valid JSON on one line: the spaces between tokens dropped, strings kept.
export function minifyJson(text: string): string {
  const body = stripBom(text);
  let out = "";
  let at = 0;
  while (at < body.length) {
    const code = body.charCodeAt(at);
    if (code === 34) {
      let end = at + 1;
      while (end < body.length && body.charCodeAt(end) !== 34) {
        end += body.charCodeAt(end) === 92 ? 2 : 1;
      }
      out += body.slice(at, end + 1);
      at = end + 1;
    } else {
      if (code !== 32 && code !== 9 && code !== 10 && code !== 13) {
        out += body[at];
      }
      at += 1;
    }
  }
  return out;
}

export function looksLikeXml(text: string): boolean {
  const trimmed = stripBom(text).trim();
  return /^<[?!a-zA-Z]/.test(trimmed) && trimmed.endsWith(">");
}

const ASCII_ESCAPES: Record<number, string> = { 0x5c: "\\\\", 0x0a: "\\n", 0x0d: "\\r", 0x09: "\\t", 0x07: "\\a", 0x08: "\\b" };
const ASCII_UNESCAPES: Record<string, number> = { "\\": 0x5c, n: 0x0a, r: 0x0d, t: 0x09, a: 0x07, b: 0x08, '"': 0x22 };

// The bytes as redis-cli writes a bulk reply (without its quotes): printable
// ASCII as is, a backslash doubled, the usual control characters as \n \r
// \t \a \b, every other byte (UTF-8 too) as \xNN.
export function asciiEscape(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    const escape = ASCII_ESCAPES[byte];
    if (escape !== undefined) {
      out += escape;
    } else if (byte >= 0x20 && byte < 0x7f) {
      out += String.fromCharCode(byte);
    } else {
      out += `\\x${byte.toString(16).padStart(2, "0")}`;
    }
  }
  return out;
}

// Escaped ASCII read back to bytes; null at a stray backslash or a
// character past ASCII (it must be written as \xNN).
export function asciiUnescape(text: string): Uint8Array | null {
  const out: number[] = [];
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    if (code > 0x7f) {
      return null;
    }
    if (code !== 0x5c) {
      out.push(code);
      continue;
    }
    const next = text[at + 1];
    if (next === "x") {
      const hex = text.slice(at + 2, at + 4);
      if (!/^[0-9a-f]{2}$/i.test(hex)) {
        return null;
      }
      out.push(parseInt(hex, 16));
      at += 3;
    } else if (next !== undefined && Object.hasOwn(ASCII_UNESCAPES, next)) {
      out.push(ASCII_UNESCAPES[next]);
      at += 1;
    } else {
      return null;
    }
  }
  return Uint8Array.from(out);
}

// Base64 (standard or URL-safe, line breaks allowed, padding optional but
// right when present) as bytes; null for anything else.
export function base64Bytes(text: string): Uint8Array | null {
  const clean = text.replace(/\s+/g, "");
  if (clean === "" || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(clean)) {
    return null;
  }
  const body = clean.replace(/=+$/, "");
  if (body.length % 4 === 1 || (clean.length !== body.length && clean.length % 4 !== 0)) {
    return null;
  }
  const standard = body.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const raw = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
      bytes[i] = raw.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let raw = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(raw);
}

function hexString(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// A decoded MessagePack value as plain JSON: 64-bit integers past 2^53 as
// strings, bytes as { $binary: hex }, timestamps as ISO text, extension
// types as { $ext, data }.
function plainJson(value: unknown, nest: Nest | null = null): unknown {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "bigint") {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : value.toString();
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }
  if (value instanceof Uint8Array) {
    return nest?.(value, false) ?? { $binary: hexString(value) };
  }
  if (typeof value === "string") {
    return nest?.(new TextEncoder().encode(value), true) ?? value;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (value instanceof ExtData) {
    return { $ext: value.type, data: hexString(value.data instanceof Uint8Array ? value.data : new Uint8Array()) };
  }
  if (Array.isArray(value)) {
    return value.map((item) => plainJson(item, nest));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = plainJson(item, nest);
    }
    return out;
  }
  return value;
}

// MessagePack map or array marks: fixmap, fixarray, array 16/32, map 16/32.
function startsContainer(byte: number): boolean {
  return (byte >= 0x80 && byte <= 0x9f) || byte === 0xdc || byte === 0xdd || byte === 0xde || byte === 0xdf;
}

// The MessagePack map or array the bytes hold, as JSON; null when they
// aren't one (a lone scalar is too easily any other bytes).
export function msgpackDocument(bytes: Uint8Array, nest: Nest | null = null): object | null {
  if (bytes.length < 1 || !startsContainer(bytes[0])) {
    return null;
  }
  try {
    const value = decode(bytes, {
      useBigInt64: true,
      mapKeyConverter: (key) => (typeof key === "string" || typeof key === "number" ? key : JSON.stringify(plainJson(key))),
    });
    const plain = plainJson(value, nest);
    return plain !== null && typeof plain === "object" ? plain : null;
  } catch {
    return null;
  }
}

// How much of the text a person reads: control characters (but tab and
// line breaks) and replacement marks count against it.
function readableShare(text: string): number {
  if (text.length === 0) {
    return 1;
  }
  let bad = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code < 0x20 && code !== 9 && code !== 10 && code !== 13) || code === 0x7f || code === 0xfffd) {
      bad += 1;
    }
  }
  return 1 - bad / text.length;
}

function asciiShare(bytes: Uint8Array): number {
  if (bytes.length === 0) {
    return 1;
  }
  let good = 0;
  for (const byte of bytes) {
    if ((byte >= 0x20 && byte < 0x7f) || byte === 9 || byte === 10 || byte === 13) {
      good += 1;
    }
  }
  return good / bytes.length;
}

// What Base64 text decodes to, when it decodes to something worth showing
// that way: readable text, JSON or MessagePack. Short or plain words never
// count, though many are valid Base64.
export function base64Meaningful(text: string): Uint8Array | null {
  const trimmed = text.trim();
  if (trimmed.length < 8 || !/[A-Z]/.test(trimmed) || !/[a-z0-9]/.test(trimmed)) {
    return null;
  }
  const bytes = base64Bytes(trimmed);
  if (bytes === null || bytes.length < 4) {
    return null;
  }
  const inner = utf8(bytes);
  if (inner !== null) {
    return jsonDocument(inner) !== null || (readableShare(inner) >= 0.97 && /[\p{L}\p{N}]/u.test(inner)) ? bytes : null;
  }
  return msgpackDocument(bytes) !== null ? bytes : null;
}

// Whether a decoded value is worth a tree: an object or an array.
function isDocument(found: { value: unknown } | null): boolean {
  return found !== null && found.value !== null && typeof found.value === "object";
}

// The format Auto picks for the bytes. `nested` is a Base64 value's
// decoded bytes: they are never read as Base64 again. Serialized formats
// are only picked when the whole value decodes, so text never reads as one.
export function detectFormat(bytes: Uint8Array, nested = false): ValueFormat {
  const text = utf8(bytes);
  if (text !== null) {
    if (jsonDocument(text) !== null) {
      return "json";
    }
    if (looksLikePhp(text) && phpValue(bytes) !== null) {
      return "php";
    }
    // Protocol 0 pickles are ASCII.
    if (looksLikePickle(bytes) && isDocument(pickleValue(bytes))) {
      return "pickle";
    }
    if (!nested && base64Meaningful(text) !== null) {
      return "base64";
    }
    if (readableShare(text) >= 0.9) {
      return "text";
    }
    return protobufLike(bytes) ? "protobuf" : "ascii";
  }
  if (looksLikePickle(bytes) && pickleValue(bytes) !== null) {
    return "pickle";
  }
  if (looksLikeJava(bytes) && javaValue(bytes) !== null) {
    return "java";
  }
  if (msgpackDocument(bytes) !== null) {
    return "msgpack";
  }
  if (protobufLike(bytes)) {
    return "protobuf";
  }
  return asciiShare(bytes) >= 0.85 ? "ascii" : "hex";
}

// A whole message whose field numbers are the small ones schemas use.
function protobufLike(bytes: Uint8Array): boolean {
  const found = bytes.length >= 2 ? protobufValue(bytes) : null;
  return found !== null && Object.keys(found.value).every((field) => Number(field) <= 10_000);
}

// A string or bytes inside a decoded value that hold JSON, a pickle, PHP
// or MessagePack, decoded and tagged with the format.
export const nestedValue: Nest = (bytes, text) => {
  if (bytes.length < 2) {
    return undefined;
  }
  const str = utf8(bytes);
  if (str !== null) {
    const doc = jsonDocument(str);
    if (doc !== null) {
      return { __json__: doc };
    }
    const php = looksLikePhp(str) ? phpValue(bytes, nestedValue) : null;
    if (php !== null) {
      return { __php__: php.value };
    }
  }
  const pickle = looksLikePickle(bytes) ? pickleValue(bytes, nestedValue) : null;
  if (pickle !== null && (str === null || isDocument(pickle))) {
    return { __pickle__: pickle.value };
  }
  if (!text && str === null) {
    const packed = msgpackDocument(bytes, nestedValue);
    if (packed !== null) {
      return { __msgpack__: packed };
    }
  }
  return undefined;
};

// Little-endian float32 or float64 values; null when the length doesn't fit.
export function vectorValues(bytes: Uint8Array, bits: 32 | 64): number[] | null {
  const size = bits / 8;
  if (bytes.length === 0 || bytes.length % size !== 0) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: number[] = [];
  for (let at = 0; at < bytes.length; at += size) {
    // A float32 to the digits it holds (0.1, not 0.10000000149011612).
    out.push(bits === 32 ? Number(view.getFloat32(at, true).toPrecision(7)) : view.getFloat64(at, true));
  }
  return out;
}

export interface Timestamp {
  unit: "s" | "ms" | "µs" | "ns";
  ms: number;
  utc: string;
  local: string;
}

// A Unix time (seconds, milliseconds, microseconds or nanoseconds, told by
// its size) as a date; null when the text isn't a number or the date is
// out of range.
export function timestampOf(text: string, zone?: string): Timestamp | null {
  const trimmed = text.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    return null;
  }
  const value = Number(trimmed);
  const whole = Math.abs(Math.trunc(value));
  const [unit, scale]: [Timestamp["unit"], number] = whole < 1e11 ? ["s", 1000] : whole < 1e14 ? ["ms", 1] : whole < 1e17 ? ["µs", 1e-3] : ["ns", 1e-6];
  const ms = value * scale;
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const local = new Intl.DateTimeFormat("sv-SE", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    fractionalSecondDigits: 3,
    timeZoneName: "longOffset",
  }).format(date);
  return { unit, ms, utc: date.toISOString(), local };
}

// The bytes as bits, a byte a group, eight bytes a line.
export function bitsText(bytes: Uint8Array): string {
  const lines: string[] = [];
  for (let at = 0; at < bytes.length; at += 8) {
    lines.push(Array.from(bytes.subarray(at, at + 8), (byte) => byte.toString(2).padStart(8, "0")).join(" "));
  }
  return lines.join("\n");
}

// A serialized format decoded to JSON for the explorer, inner values
// decoded too when `nest` is on; null when the bytes aren't that format.
export function decodeDocument(bytes: Uint8Array, format: ValueFormat, nest: boolean): { value: unknown } | null {
  const inner = nest ? nestedValue : null;
  switch (format) {
    case "msgpack": {
      const doc = msgpackDocument(bytes, inner);
      return doc === null ? null : { value: doc };
    }
    case "pickle":
      return pickleValue(bytes, inner);
    case "php":
      return phpValue(bytes, inner);
    case "java":
      return javaValue(bytes);
    case "protobuf":
      return protobufValue(bytes);
    case "vector32":
    case "vector64": {
      const values = vectorValues(bytes, format === "vector32" ? 32 : 64);
      return values === null ? null : { value: values };
    }
    default:
      return null;
  }
}

// JSON typed to save as MessagePack: the bytes, or null when the JSON
// holds what JSON can't say back (bytes, extension types).
export function msgpackFromJson(text: string): Uint8Array | null {
  try {
    const value: unknown = JSON.parse(stripBom(text));
    const special = JSON.stringify(value).includes('"$binary"') || JSON.stringify(value).includes('"$ext"');
    return special ? null : encode(value);
  } catch {
    return null;
  }
}

// Whether a MessagePack value can be edited as JSON and saved back the same:
// no bytes, extension types or integers past 2^53 in it.
export function msgpackEditable(bytes: Uint8Array): boolean {
  const doc = msgpackDocument(bytes);
  if (doc === null) {
    return false;
  }
  const again = msgpackFromJson(JSON.stringify(doc));
  return again !== null && hexString(again) === hexString(bytes);
}

// What a value in a hash's, list's, set's or stream's row reads as, for its
// colour (the data grid's ink for that kind).
export type CellInk = JsonInk | "empty" | "binary";

const FLOAT = /^-?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)$|^-?(\d+\.\d+|\.\d+)$/;

export function cellInk(text: string): CellInk {
  if (text === "") {
    return "empty";
  }
  if (/^-?\d+$/.test(text)) {
    return text.length > 1 && /^-?0\d/.test(text) ? "string" : Number.isSafeInteger(Number(text)) ? "integer" : "bigint";
  }
  if (FLOAT.test(text)) {
    return "float";
  }
  if (/^(true|false)$/i.test(text)) {
    return "boolean";
  }
  if (/^(null|nil|none|undefined)$/i.test(text)) {
    return "null";
  }
  const doc = jsonDocument(text);
  if (doc !== null) {
    return Array.isArray(doc) ? "list" : "json";
  }
  return "string";
}
