// Bytes as the /api/kv/* routes carry them (crates/tablepeek-engine/src/keyvalue.rs):
// a JSON string when they are UTF-8, `{ b64 }` otherwise; the page may also
// send `{ hex }`. Keys, fields, members and values are all of this kind, so
// a binary key is shown, compared and sent back without losing a byte.

export type Bin = string | { b64: string } | { hex: string };

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const ENCODER = new TextEncoder();

export function isText(bin: Bin): bin is string {
  return typeof bin === "string";
}

function fromBase64(b64: string): Uint8Array {
  const raw = atob(b64.trim());
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    bytes[i] = raw.charCodeAt(i);
  }
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  let raw = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(raw);
}

// Hex digits (spaces and a leading 0x allowed) as bytes; null for anything else.
function parseHex(text: string): Uint8Array | null {
  const digits = text.trim().replace(/^0x/i, "").replace(/\s+/g, "");
  if (digits.length % 2 !== 0 || /[^0-9a-f]/i.test(digits)) {
    return null;
  }
  const bytes = new Uint8Array(digits.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(digits.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function binBytes(bin: Bin): Uint8Array {
  if (typeof bin === "string") {
    return ENCODER.encode(bin);
  }
  if ("b64" in bin) {
    return fromBase64(bin.b64);
  }
  return parseHex(bin.hex) ?? new Uint8Array();
}

// Bytes as the server would send them: text when they are UTF-8.
export function binFromBytes(bytes: Uint8Array): Bin {
  try {
    return UTF8.decode(bytes);
  } catch {
    return { b64: toBase64(bytes) };
  }
}

// Hex digits typed by hand as a value to send; null when they aren't hex.
export function binFromHex(text: string): Bin | null {
  const bytes = parseHex(text);
  return bytes === null ? null : binFromBytes(bytes);
}

// The bytes as spaced hex pairs ("0a ff 3c").
export function hexOf(bin: Bin, limit = Infinity): string {
  const bytes = binBytes(bin);
  const shown = bytes.length > limit ? bytes.subarray(0, limit) : bytes;
  return Array.from(shown, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

// The same bytes, whichever way they were written.
export function binId(bin: Bin): string {
  return typeof bin === "string" ? `s${bin}` : `b${toBase64(binBytes(bin))}`;
}

const ESCAPES: Record<number, string> = { 0x5c: "\\\\", 0x22: '\\"', 0x0a: "\\n", 0x0d: "\\r", 0x09: "\\t", 0x07: "\\a", 0x08: "\\b" };

// Text a person reads: UTF-8 as it is (control characters escaped), other
// bytes as redis-cli writes them (`\xff`). `quoted` wraps it in double
// quotes and escapes quotes and backslashes too, as redis-cli shows a bulk
// reply; the result can be typed back into the console.
export function binText(bin: Bin, quoted = false): string {
  if (typeof bin === "string") {
    let out = "";
    for (const ch of bin) {
      const code = ch.codePointAt(0) ?? 0;
      if (quoted && (code === 0x5c || code === 0x22)) {
        out += ESCAPES[code];
      } else if (code < 0x20 || code === 0x7f) {
        out += quoted && ESCAPES[code] !== undefined ? ESCAPES[code] : `\\x${code.toString(16).padStart(2, "0")}`;
      } else {
        out += ch;
      }
    }
    return quoted ? `"${out}"` : out;
  }
  let out = "";
  for (const byte of binBytes(bin)) {
    if (quoted && ESCAPES[byte] !== undefined) {
      out += ESCAPES[byte];
    } else if (byte >= 0x20 && byte < 0x7f) {
      out += String.fromCharCode(byte);
    } else {
      out += `\\x${byte.toString(16).padStart(2, "0")}`;
    }
  }
  return quoted ? `"${out}"` : out;
}

// A key or value written for a console line: bare when it has no spaces,
// quotes or escapes, else quoted as redis-cli reads it.
export function consoleArg(bin: Bin): string {
  const plain = typeof bin === "string" && bin !== "" && /^[^\s"'\\\x00-\x1f\x7f]+$/.test(bin);
  return plain ? (bin as string) : binText(bin, true);
}
