// PHP's serialize() format read without running anything: N; b:; i:; d:;
// s:len:"…"; a:n:{…}; O:len:"Class":n:{…}; C:len:"Class":len:{…};
// E:len:"Class:Case"; and the r: / R: back-references. Arrays with keys
// 0…n-1 become JSON arrays, others objects; objects are { "__class__",
// …properties } with private and protected names shown as PHP prints them.

import type { Nest } from "./nest";

class PhpError extends Error {}

const UTF8 = new TextDecoder("utf-8", { fatal: true });
const LATIN1 = new TextDecoder("latin1");

function text(bytes: Uint8Array): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    return LATIN1.decode(bytes);
  }
}

// "\0Class\0prop" (private) → "prop:Class", "\0*\0prop" (protected) → "prop:protected".
function propName(name: string): string {
  if (!name.startsWith("\0")) {
    return name;
  }
  const end = name.indexOf("\0", 1);
  if (end < 0) {
    return name;
  }
  const owner = name.slice(1, end);
  return `${name.slice(end + 1)}:${owner === "*" ? "protected" : owner}`;
}

class Parser {
  at = 0;
  // Every value read, in order, for r: and R: (1-based).
  values: unknown[] = [];
  constructor(
    readonly bytes: Uint8Array,
    readonly nest: Nest | null,
  ) {}

  expect(char: string): void {
    if (this.bytes[this.at] !== char.charCodeAt(0)) {
      throw new PhpError(`expected ${char}`);
    }
    this.at += 1;
  }

  until(char: string): string {
    const end = this.bytes.indexOf(char.charCodeAt(0), this.at);
    if (end < 0) {
      throw new PhpError(`no ${char}`);
    }
    const out = LATIN1.decode(this.bytes.subarray(this.at, end));
    this.at = end + 1;
    return out;
  }

  int(stop: string): number {
    const raw = this.until(stop);
    if (!/^[+-]?\d+$/.test(raw)) {
      throw new PhpError("bad number");
    }
    return Number(raw);
  }

  quoted(length: number): Uint8Array {
    this.expect('"');
    if (this.at + length > this.bytes.length) {
      throw new PhpError("truncated");
    }
    const raw = this.bytes.subarray(this.at, this.at + length);
    this.at += length;
    this.expect('"');
    return raw;
  }

  members(count: number, object: boolean): unknown {
    this.expect("{");
    const entries: [string, unknown][] = [];
    let list = !object;
    for (let i = 0; i < count; i++) {
      const key = this.value(false);
      if (typeof key !== "string" && typeof key !== "number") {
        throw new PhpError("bad key");
      }
      if (key !== i) {
        list = false;
      }
      entries.push([object ? propName(String(key)) : String(key), this.value()]);
    }
    this.expect("}");
    return list ? entries.map(([, item]) => item) : Object.fromEntries(entries);
  }

  value(counted = true): unknown {
    const type = String.fromCharCode(this.bytes[this.at] ?? 0);
    this.at += 1;
    let out: unknown;
    switch (type) {
      case "N":
        this.expect(";");
        out = null;
        break;
      case "b": {
        this.expect(":");
        const raw = this.until(";");
        if (raw !== "0" && raw !== "1") {
          throw new PhpError("bad bool");
        }
        out = raw === "1";
        break;
      }
      case "i":
        this.expect(":");
        out = this.int(";");
        break;
      case "d": {
        this.expect(":");
        const raw = this.until(";");
        const value = raw === "INF" ? Infinity : raw === "-INF" ? -Infinity : raw === "NAN" ? NaN : Number(raw);
        if (raw === "" || (Number.isNaN(value) && raw !== "NAN")) {
          throw new PhpError("bad float");
        }
        out = Number.isFinite(value) ? value : raw;
        break;
      }
      case "s": {
        this.expect(":");
        const raw = this.quoted(this.int(":"));
        this.expect(";");
        const str = text(raw);
        out = counted ? (this.nest?.(raw, true) ?? str) : str;
        break;
      }
      case "a": {
        this.expect(":");
        const slot = this.values.length;
        this.values.push(null);
        out = this.members(this.int(":"), false);
        this.values[slot] = out;
        return out;
      }
      case "O": {
        this.expect(":");
        const name = text(this.quoted(this.int(":")));
        this.expect(":");
        const slot = this.values.length;
        this.values.push(null);
        const props = this.members(this.int(":"), true) as Record<string, unknown>;
        out = { __class__: name, ...props };
        this.values[slot] = out;
        return out;
      }
      case "C": {
        // A Serializable class's own string.
        this.expect(":");
        const name = text(this.quoted(this.int(":")));
        this.expect(":");
        const length = this.int(":");
        this.expect("{");
        const raw = this.bytes.subarray(this.at, this.at + length);
        this.at += length;
        this.expect("}");
        out = { __class__: name, data: this.nest?.(raw, true) ?? text(raw) };
        break;
      }
      case "E": {
        this.expect(":");
        out = text(this.quoted(this.int(":")));
        this.expect(";");
        break;
      }
      case "r":
      case "R": {
        this.expect(":");
        const index = this.int(";");
        if (index < 1 || index > this.values.length) {
          throw new PhpError("bad reference");
        }
        out = this.values[index - 1];
        break;
      }
      default:
        throw new PhpError(`unknown type ${type}`);
    }
    if (counted) {
      this.values.push(out);
    }
    return out;
  }
}

// The serialized PHP value as JSON; null unless the bytes are exactly one.
export function phpValue(bytes: Uint8Array, nest: Nest | null = null): { value: unknown } | null {
  try {
    const parser = new Parser(bytes, nest);
    const value = parser.value();
    return parser.at === bytes.length ? { value } : null;
  } catch (error) {
    if (error instanceof PhpError) {
      return null;
    }
    throw error;
  }
}

// What serialize() output starts with, for Auto: an array, an object or a
// string (a lone "i:5;" is left as text).
export function looksLikePhp(text: string): boolean {
  return /^(a:\d+:\{|O:\d+:"|C:\d+:"|s:\d+:")/.test(text) && /[;}]$/.test(text);
}
