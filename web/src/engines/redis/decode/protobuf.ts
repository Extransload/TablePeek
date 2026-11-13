// A Protocol Buffers message read without its schema: each field number
// with what its wire type gives. Varints as integers; 32- and 64-bit
// fields as a float or double when that reads as an ordinary number, else
// as integers; length-delimited fields as a nested message when they parse
// as one, as text when they are readable UTF-8, as packed varints when
// they decode cleanly to several, else as hex. A field seen more than once
// becomes a list.

class ProtoError extends Error {}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function varint(bytes: Uint8Array, start: number): [bigint, number] {
  let out = 0n;
  let shift = 0n;
  for (let at = start; at < bytes.length && at < start + 10; at++) {
    const byte = bytes[at];
    out |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return [out, at + 1];
    }
    shift += 7n;
  }
  throw new ProtoError("bad varint");
}

function small(value: bigint): number | string {
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

// A float that reads as a number someone stored (not a bit pattern of an
// integer): finite and within ordinary magnitudes, or zero.
function ordinary(value: number): boolean {
  return value === 0 || (Number.isFinite(value) && Math.abs(value) >= 1e-12 && Math.abs(value) <= 1e15);
}

function readable(text: string): boolean {
  return !/[\x00-\x08\x0e-\x1f\x7f\ufffd]/.test(text);
}

interface Parsed {
  fields: Map<number, unknown[]>;
}

function parse(bytes: Uint8Array, depth: number): Parsed {
  if (depth > 32) {
    throw new ProtoError("too deep");
  }
  const fields = new Map<number, unknown[]>();
  let at = 0;
  while (at < bytes.length) {
    const [key, next] = varint(bytes, at);
    at = next;
    const field = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (field < 1 || field > 536_870_911) {
      throw new ProtoError("bad field number");
    }
    let value: unknown;
    if (wire === 0) {
      const [raw, after] = varint(bytes, at);
      at = after;
      value = small(raw);
    } else if (wire === 1) {
      if (at + 8 > bytes.length) {
        throw new ProtoError("truncated");
      }
      const view = new DataView(bytes.buffer, bytes.byteOffset + at, 8);
      const double = view.getFloat64(0, true);
      value = ordinary(double) ? double : small(view.getBigUint64(0, true));
      at += 8;
    } else if (wire === 5) {
      if (at + 4 > bytes.length) {
        throw new ProtoError("truncated");
      }
      const view = new DataView(bytes.buffer, bytes.byteOffset + at, 4);
      const float = view.getFloat32(0, true);
      value = ordinary(float) ? Number(float.toPrecision(7)) : view.getUint32(0, true);
      at += 4;
    } else if (wire === 2) {
      const [length, after] = varint(bytes, at);
      at = after;
      if (BigInt(at) + length > BigInt(bytes.length)) {
        throw new ProtoError("truncated");
      }
      const body = bytes.subarray(at, at + Number(length));
      at += Number(length);
      value = lengthDelimited(body, depth);
    } else {
      // Groups (3, 4) are long deprecated; 6 and 7 don't exist.
      throw new ProtoError("unsupported wire type");
    }
    const list = fields.get(field);
    if (list === undefined) {
      fields.set(field, [value]);
    } else {
      list.push(value);
    }
  }
  return { fields };
}

function lengthDelimited(body: Uint8Array, depth: number): unknown {
  if (body.length === 0) {
    return "";
  }
  let text: string | null = null;
  try {
    text = UTF8.decode(body);
  } catch {
    text = null;
  }
  // Readable text wins: short text often parses as a message too.
  if (text !== null && readable(text)) {
    return text;
  }
  try {
    return toJson(parse(body, depth + 1));
  } catch {
    // Not a message.
  }
  const packed: (number | string)[] = [];
  try {
    for (let at = 0; at < body.length; ) {
      const [value, next] = varint(body, at);
      packed.push(small(value));
      at = next;
    }
    if (packed.length > 1) {
      return packed;
    }
  } catch {
    // Not packed varints.
  }
  return `0x${hex(body)}`;
}

function toJson(parsed: Parsed): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, values] of [...parsed.fields].sort(([a], [b]) => a - b)) {
    out[String(field)] = values.length === 1 ? values[0] : values;
  }
  return out;
}

// The message as { "field number": value }; null unless every byte is part
// of a field.
export function protobufValue(bytes: Uint8Array): { value: Record<string, unknown> } | null {
  if (bytes.length === 0) {
    return null;
  }
  try {
    return { value: toJson(parse(bytes, 0)) };
  } catch (error) {
    if (error instanceof ProtoError || error instanceof RangeError) {
      return null;
    }
    throw error;
  }
}
