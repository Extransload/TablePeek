// Python pickle (protocols 0–5) read by a small opcode interpreter that only
// builds data: a class or function named by GLOBAL / STACK_GLOBAL is never
// looked up or called. REDUCE, NEWOBJ and BUILD make a description of the
// instance ({ "__class__", "args", "state" }); the standard library's
// common types (datetime, date, time, timedelta, timezone, Decimal, UUID,
// set, frozenset, bytearray, OrderedDict, defaultdict, Counter) are written
// readably instead. The result is plain JSON for the explorer tree.

import type { Nest } from "./nest";

class PyBytes {
  constructor(
    readonly bytes: Uint8Array,
    readonly array = false,
  ) {}
}

class PyTuple {
  constructor(readonly items: Value[]) {}
}

class PyDict {
  entries: [Value, Value][] = [];
}

class PySet {
  items: Value[] = [];
  constructor(readonly frozen = false) {}
}

class PyGlobal {
  constructor(
    readonly module: string,
    readonly name: string,
  ) {}
  get path(): string {
    return `${this.module}.${this.name}`;
  }
}

// An instance: what made it (a class, or a function called with args) and
// what was set on it after.
class PyObj {
  state: Value | undefined;
  list: Value[] | null = null;
  dict: PyDict | null = null;
  constructor(
    readonly maker: Value,
    readonly args: Value[],
    readonly kwargs: Value | null = null,
  ) {}
}

// A value whose readable form is already known (a datetime as ISO text).
class PyShown {
  constructor(readonly value: unknown) {}
}

class PersistentId {
  constructor(readonly id: Value) {}
}

type Value = null | boolean | number | bigint | string | PyBytes | Value[] | PyTuple | PyDict | PySet | PyGlobal | PyObj | PyShown | PersistentId;

const MARK = Symbol("mark");
type Slot = Value | typeof MARK;

export class PickleError extends Error {}

const LATIN1 = new TextDecoder("latin1");
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

function bytesOf(value: Value): Uint8Array | null {
  if (value instanceof PyBytes) {
    return value.bytes;
  }
  // Protocol 0–2 pickles of Python 3 carry bytes as latin-1 text.
  if (typeof value === "string") {
    const out = new Uint8Array(value.length);
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code > 0xff) {
        return null;
      }
      out[i] = code;
    }
    return out;
  }
  return null;
}

function num(value: Value | undefined): number | null {
  return typeof value === "number" ? value : typeof value === "bigint" ? Number(value) : null;
}

// A tzinfo argument as "+09:00", "Z", or the zone's name.
function zoneText(tz: Value | undefined): string {
  if (tz === undefined || tz === null) {
    return "";
  }
  if (tz instanceof PyShown && typeof tz.value === "string" && /^([+-]|Z$)/.test(tz.value)) {
    return tz.value;
  }
  if (tz instanceof PyObj && tz.maker instanceof PyGlobal) {
    const first = tz.args[0];
    if (typeof first === "string") {
      return `[${first}]`;
    }
    return `[${tz.maker.path}]`;
  }
  return "";
}

function deltaSeconds(delta: Value | undefined): number | null {
  if (delta instanceof PyObj && delta.maker instanceof PyGlobal && delta.maker.path === "datetime.timedelta") {
    const [days, seconds, micro] = delta.args.map((arg) => num(arg) ?? 0);
    return days * 86400 + seconds + micro / 1e6;
  }
  return null;
}

function offsetText(seconds: number): string {
  if (seconds === 0) {
    return "Z";
  }
  const sign = seconds < 0 ? "-" : "+";
  const abs = Math.abs(seconds);
  return `${sign}${pad(Math.floor(abs / 3600))}:${pad(Math.floor((abs % 3600) / 60))}`;
}

// The standard library's types whose pickled form is known, made readable;
// null for anything else.
function known(path: string, args: Value[]): Value | null {
  switch (path) {
    case "datetime.datetime": {
      const raw = bytesOf(args[0]);
      if (raw === null || raw.length !== 10) {
        return null;
      }
      const year = raw[0] * 256 + raw[1];
      const micro = (raw[7] << 16) | (raw[8] << 8) | raw[9];
      const fraction = micro === 0 ? "" : `.${pad(micro, 6)}`;
      return new PyShown(`${pad(year, 4)}-${pad(raw[2])}-${pad(raw[3])}T${pad(raw[4])}:${pad(raw[5])}:${pad(raw[6])}${fraction}${zoneText(args[1])}`);
    }
    case "datetime.date": {
      const raw = bytesOf(args[0]);
      return raw === null || raw.length !== 4 ? null : new PyShown(`${pad(raw[0] * 256 + raw[1], 4)}-${pad(raw[2])}-${pad(raw[3])}`);
    }
    case "datetime.time": {
      const raw = bytesOf(args[0]);
      if (raw === null || raw.length !== 6) {
        return null;
      }
      const micro = (raw[3] << 16) | (raw[4] << 8) | raw[5];
      return new PyShown(`${pad(raw[0])}:${pad(raw[1])}:${pad(raw[2])}${micro === 0 ? "" : `.${pad(micro, 6)}`}${zoneText(args[1])}`);
    }
    case "datetime.timezone": {
      const seconds = deltaSeconds(args[0]);
      return seconds === null ? null : new PyShown(offsetText(seconds));
    }
    case "decimal.Decimal":
      return typeof args[0] === "string" ? new PyShown(`Decimal('${args[0]}')`) : null;
    case "builtins.set":
    case "__builtin__.set":
    case "builtins.frozenset":
    case "__builtin__.frozenset": {
      const set = new PySet(path.endsWith("frozenset"));
      const items = args[0];
      if (Array.isArray(items)) {
        set.items.push(...items);
      } else if (items instanceof PyTuple) {
        set.items.push(...items.items);
      }
      return set;
    }
    case "builtins.bytearray":
    case "__builtin__.bytearray": {
      if (args.length === 0) {
        return new PyBytes(new Uint8Array(), true);
      }
      const raw = bytesOf(args[0]);
      return raw === null ? null : new PyBytes(raw, true);
    }
    case "_codecs.encode": {
      // bytes in protocol 0–2 from Python 3: encode(text, "latin1").
      const raw = typeof args[0] === "string" ? bytesOf(args[0]) : null;
      return raw === null ? null : new PyBytes(raw);
    }
    case "builtins.complex":
    case "__builtin__.complex":
      return new PyShown(`(${num(args[0]) ?? 0}${(num(args[1]) ?? 0) < 0 ? "-" : "+"}${Math.abs(num(args[1]) ?? 0)}j)`);
    default:
      return null;
  }
}

const DICT_CLASSES: Record<string, true> = { "collections.OrderedDict": true, "collections.defaultdict": true, "collections.Counter": true, "builtins.dict": true };

function makeObject(maker: Value, args: Value[], kwargs: Value | null = null): Value {
  if (maker instanceof PyGlobal) {
    const found = known(maker.path, args);
    if (found !== null) {
      return found;
    }
    // copyreg._reconstructor(cls, base, state): an instance of cls.
    if (maker.path === "copyreg._reconstructor" || maker.path === "copy_reg._reconstructor") {
      const object = new PyObj(args[0] ?? null, []);
      if (args[2] !== undefined && args[2] !== null) {
        object.state = args[2];
      }
      return object;
    }
    if (maker.path === "copyreg.__newobj__" || maker.path === "copy_reg.__newobj__") {
      return makeObject(args[0] ?? null, args.slice(1));
    }
  }
  return new PyObj(maker, args, kwargs);
}

function tupleItems(value: Value): Value[] {
  if (value instanceof PyTuple) {
    return value.items;
  }
  if (Array.isArray(value)) {
    return value;
  }
  throw new PickleError("expected a tuple");
}

class Reader {
  at = 0;
  constructor(readonly bytes: Uint8Array) {}
  need(count: number): void {
    if (this.at + count > this.bytes.length) {
      throw new PickleError("truncated");
    }
  }
  byte(): number {
    this.need(1);
    return this.bytes[this.at++];
  }
  take(count: number): Uint8Array {
    this.need(count);
    const out = this.bytes.subarray(this.at, this.at + count);
    this.at += count;
    return out;
  }
  uint(size: 1 | 2 | 4 | 8): number {
    const raw = this.take(size);
    let out = 0;
    for (let i = size - 1; i >= 0; i--) {
      out = out * 256 + raw[i];
    }
    if (size === 8 && out > Number.MAX_SAFE_INTEGER) {
      throw new PickleError("too long");
    }
    return out;
  }
  int32(): number {
    const raw = this.take(4);
    return new DataView(raw.buffer, raw.byteOffset, 4).getInt32(0, true);
  }
  line(): string {
    const end = this.bytes.indexOf(0x0a, this.at);
    if (end < 0) {
      throw new PickleError("no line end");
    }
    const text = LATIN1.decode(this.bytes.subarray(this.at, end));
    this.at = end + 1;
    return text;
  }
}

function utf8(bytes: Uint8Array): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new PickleError("bad UTF-8");
  }
}

// Little-endian two's complement bytes (LONG1, LONG4) as an integer.
function longOf(raw: Uint8Array): number | bigint {
  if (raw.length === 0) {
    return 0;
  }
  let out = 0n;
  for (let i = raw.length - 1; i >= 0; i--) {
    out = (out << 8n) | BigInt(raw[i]);
  }
  if (raw[raw.length - 1] & 0x80) {
    out -= 1n << BigInt(raw.length * 8);
  }
  return out >= BigInt(Number.MIN_SAFE_INTEGER) && out <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(out) : out;
}

// A protocol 0 STRING argument: a Python literal in quotes.
function stringLiteral(text: string): string {
  const quote = text[0];
  if ((quote !== "'" && quote !== '"') || text[text.length - 1] !== quote || text.length < 2) {
    throw new PickleError("bad string");
  }
  return text.slice(1, -1).replace(/\\(x[0-9a-fA-F]{2}|[0-7]{1,3}|.)/g, (_, esc: string) => {
    if (esc[0] === "x") {
      return String.fromCharCode(parseInt(esc.slice(1), 16));
    }
    if (/^[0-7]/.test(esc)) {
      return String.fromCharCode(parseInt(esc, 8));
    }
    return ({ n: "\n", r: "\r", t: "\t", "\\": "\\", "'": "'", '"': '"', a: "\x07", b: "\b", f: "\f", v: "\v" } as Record<string, string>)[esc] ?? `\\${esc}`;
  });
}

// raw-unicode-escape (protocol 0 UNICODE): \uXXXX and \UXXXXXXXX only.
function rawUnicode(text: string): string {
  return text.replace(/\\u([0-9a-fA-F]{4})|\\U([0-9a-fA-F]{8})/g, (_, short?: string, long?: string) => String.fromCodePoint(parseInt(short ?? long ?? "0", 16)));
}

function intLine(text: string): number | bigint | boolean {
  if (text === "01") {
    return true;
  }
  if (text === "00") {
    return false;
  }
  const clean = text.replace(/L$/, "");
  if (!/^[+-]?\d+$/.test(clean)) {
    throw new PickleError("bad int");
  }
  const big = BigInt(clean);
  return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
}

// Runs the pickle in `bytes` to its STOP; every byte must be used.
export function unpickle(bytes: Uint8Array): Value {
  const reader = new Reader(bytes);
  const stack: Slot[] = [];
  const marks: number[] = [];
  const memo = new Map<number, Value>();
  const pop = (): Value => {
    const top = stack.pop();
    if (top === undefined || top === MARK) {
      throw new PickleError("stack underflow");
    }
    return top;
  };
  const top = (): Value => {
    const value = stack[stack.length - 1];
    if (value === undefined || value === MARK) {
      throw new PickleError("stack underflow");
    }
    return value;
  };
  const popMark = (): Value[] => {
    const at = marks.pop();
    if (at === undefined) {
      throw new PickleError("no mark");
    }
    const items = stack.splice(at) as Slot[];
    items.shift();
    if (items.some((item) => item === MARK)) {
      throw new PickleError("stray mark");
    }
    return items as Value[];
  };
  const push = (value: Value) => stack.push(value);
  const setItems = (target: Value, items: Value[]) => {
    const dict = target instanceof PyDict ? target : target instanceof PyObj ? (target.dict ??= new PyDict()) : null;
    if (dict === null) {
      throw new PickleError("SETITEM on a non-dict");
    }
    for (let i = 0; i + 1 < items.length; i += 2) {
      dict.entries.push([items[i], items[i + 1]]);
    }
  };
  const appendItems = (target: Value, items: Value[]) => {
    if (Array.isArray(target)) {
      target.push(...items);
    } else if (target instanceof PyObj) {
      (target.list ??= []).push(...items);
    } else if (target instanceof PySet) {
      target.items.push(...items);
    } else {
      throw new PickleError("APPEND on a non-list");
    }
  };

  for (;;) {
    const op = reader.byte();
    switch (op) {
      case 0x80: // PROTO
        if (reader.byte() > 5) {
          throw new PickleError("unknown protocol");
        }
        break;
      case 0x95: // FRAME
        reader.uint(8);
        break;
      case 0x2e: // STOP
        if (reader.at !== bytes.length || stack.length !== 1) {
          throw new PickleError("data after STOP");
        }
        return pop();
      case 0x28: // MARK
        marks.push(stack.length);
        stack.push(MARK);
        break;
      case 0x30: // POP
        if (stack[stack.length - 1] === MARK) {
          stack.pop();
          marks.pop();
        } else {
          pop();
        }
        break;
      case 0x31: // POP_MARK
        popMark();
        break;
      case 0x32: // DUP
        push(top());
        break;
      case 0x4e: // NONE
        push(null);
        break;
      case 0x88: // NEWTRUE
        push(true);
        break;
      case 0x89: // NEWFALSE
        push(false);
        break;
      case 0x49: // INT
        push(intLine(reader.line()));
        break;
      case 0x4a: // BININT
        push(reader.int32());
        break;
      case 0x4b: // BININT1
        push(reader.byte());
        break;
      case 0x4d: // BININT2
        push(reader.uint(2));
        break;
      case 0x4c: // LONG
        push(intLine(reader.line()) as number | bigint);
        break;
      case 0x8a: // LONG1
        push(longOf(reader.take(reader.byte())));
        break;
      case 0x8b: // LONG4
        push(longOf(reader.take(reader.uint(4))));
        break;
      case 0x46: {
        // FLOAT
        const value = Number(reader.line());
        if (Number.isNaN(value)) {
          throw new PickleError("bad float");
        }
        push(value);
        break;
      }
      case 0x47: {
        // BINFLOAT (big-endian)
        const raw = reader.take(8);
        push(new DataView(raw.buffer, raw.byteOffset, 8).getFloat64(0, false));
        break;
      }
      case 0x53: // STRING
        push(stringLiteral(reader.line()));
        break;
      case 0x54: // BINSTRING
        push(LATIN1.decode(reader.take(reader.uint(4))));
        break;
      case 0x55: // SHORT_BINSTRING
        push(LATIN1.decode(reader.take(reader.byte())));
        break;
      case 0x56: // UNICODE
        push(rawUnicode(reader.line()));
        break;
      case 0x58: // BINUNICODE
        push(utf8(reader.take(reader.uint(4))));
        break;
      case 0x8c: // SHORT_BINUNICODE
        push(utf8(reader.take(reader.byte())));
        break;
      case 0x8d: // BINUNICODE8
        push(utf8(reader.take(reader.uint(8))));
        break;
      case 0x42: // BINBYTES
        push(new PyBytes(reader.take(reader.uint(4)).slice()));
        break;
      case 0x43: // SHORT_BINBYTES
        push(new PyBytes(reader.take(reader.byte()).slice()));
        break;
      case 0x8e: // BINBYTES8
        push(new PyBytes(reader.take(reader.uint(8)).slice()));
        break;
      case 0x96: // BYTEARRAY8
        push(new PyBytes(reader.take(reader.uint(8)).slice(), true));
        break;
      case 0x97: // NEXT_BUFFER: out-of-band data isn't in the value
        push(new PyShown("<out-of-band buffer>"));
        break;
      case 0x98: // READONLY_BUFFER
        break;
      case 0x29: // EMPTY_TUPLE
        push(new PyTuple([]));
        break;
      case 0x74: // TUPLE
        push(new PyTuple(popMark()));
        break;
      case 0x85: // TUPLE1
        push(new PyTuple([pop()]));
        break;
      case 0x86: {
        // TUPLE2
        const second = pop();
        push(new PyTuple([pop(), second]));
        break;
      }
      case 0x87: {
        // TUPLE3
        const third = pop();
        const second = pop();
        push(new PyTuple([pop(), second, third]));
        break;
      }
      case 0x5d: // EMPTY_LIST
        push([]);
        break;
      case 0x6c: // LIST
        push(popMark());
        break;
      case 0x61: {
        // APPEND
        const item = pop();
        appendItems(top(), [item]);
        break;
      }
      case 0x65: {
        // APPENDS
        const items = popMark();
        appendItems(top(), items);
        break;
      }
      case 0x7d: // EMPTY_DICT
        push(new PyDict());
        break;
      case 0x64: {
        // DICT
        const dict = new PyDict();
        setItems(dict, popMark());
        push(dict);
        break;
      }
      case 0x73: {
        // SETITEM
        const value = pop();
        const key = pop();
        setItems(top(), [key, value]);
        break;
      }
      case 0x75: {
        // SETITEMS
        const items = popMark();
        setItems(top(), items);
        break;
      }
      case 0x8f: // EMPTY_SET
        push(new PySet());
        break;
      case 0x90: {
        // ADDITEMS
        const items = popMark();
        appendItems(top(), items);
        break;
      }
      case 0x91: {
        // FROZENSET
        const set = new PySet(true);
        set.items.push(...popMark());
        push(set);
        break;
      }
      case 0x67: {
        // GET
        const key = Number(reader.line());
        if (!memo.has(key)) {
          throw new PickleError("memo miss");
        }
        push(memo.get(key) as Value);
        break;
      }
      case 0x68: // BINGET
      case 0x6a: {
        // LONG_BINGET
        const key = op === 0x68 ? reader.byte() : reader.uint(4);
        if (!memo.has(key)) {
          throw new PickleError("memo miss");
        }
        push(memo.get(key) as Value);
        break;
      }
      case 0x70: // PUT
        memo.set(Number(reader.line()), top());
        break;
      case 0x71: // BINPUT
        memo.set(reader.byte(), top());
        break;
      case 0x72: // LONG_BINPUT
        memo.set(reader.uint(4), top());
        break;
      case 0x94: // MEMOIZE
        memo.set(memo.size, top());
        break;
      case 0x63: {
        // GLOBAL
        const module = reader.line();
        push(new PyGlobal(module, reader.line()));
        break;
      }
      case 0x93: {
        // STACK_GLOBAL
        const name = pop();
        const module = pop();
        if (typeof module !== "string" || typeof name !== "string") {
          throw new PickleError("bad STACK_GLOBAL");
        }
        push(new PyGlobal(module, name));
        break;
      }
      case 0x82: // EXT1
      case 0x83: // EXT2
      case 0x84: {
        // EXT4
        const code = reader.uint(op === 0x82 ? 1 : op === 0x83 ? 2 : 4);
        push(new PyGlobal("copyreg.extension", String(code)));
        break;
      }
      case 0x52: {
        // REDUCE
        const args = tupleItems(pop());
        push(makeObject(pop(), args));
        break;
      }
      case 0x81: {
        // NEWOBJ
        const args = tupleItems(pop());
        push(makeObject(pop(), args));
        break;
      }
      case 0x92: {
        // NEWOBJ_EX
        const kwargs = pop();
        const args = tupleItems(pop());
        push(makeObject(pop(), args, kwargs instanceof PyDict && kwargs.entries.length === 0 ? null : kwargs));
        break;
      }
      case 0x69: {
        // INST
        const module = reader.line();
        const name = reader.line();
        push(makeObject(new PyGlobal(module, name), popMark()));
        break;
      }
      case 0x6f: {
        // OBJ
        const items = popMark();
        if (items.length === 0) {
          throw new PickleError("OBJ without class");
        }
        push(makeObject(items[0], items.slice(1)));
        break;
      }
      case 0x62: {
        // BUILD
        const state = pop();
        const target = top();
        if (target instanceof PyObj) {
          target.state = state;
        } else if (!(target instanceof PyShown)) {
          throw new PickleError("BUILD on a non-object");
        }
        break;
      }
      case 0x50: // PERSID
        push(new PersistentId(reader.line()));
        break;
      case 0x51: // BINPERSID
        push(new PersistentId(pop()));
        break;
      default:
        throw new PickleError(`unknown opcode 0x${op.toString(16)}`);
    }
  }
}

// Python's repr of bytes: b'…' with printable ASCII as is.
export function bytesRepr(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    if (byte === 0x5c) {
      out += "\\\\";
    } else if (byte === 0x27) {
      out += "\\'";
    } else if (byte === 0x0a) {
      out += "\\n";
    } else if (byte === 0x0d) {
      out += "\\r";
    } else if (byte === 0x09) {
      out += "\\t";
    } else if (byte >= 0x20 && byte < 0x7f) {
      out += String.fromCharCode(byte);
    } else {
      out += `\\x${byte.toString(16).padStart(2, "0")}`;
    }
  }
  return `b'${out}'`;
}

function keyText(key: Value, nest: Nest | null, seen: Set<object>): string {
  if (typeof key === "string") {
    return key;
  }
  const json = toJson(key, nest, seen);
  return typeof json === "string" ? json : JSON.stringify(json);
}

function toJson(value: Value, nest: Nest | null, seen: Set<object>): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return typeof value === "number" && !Number.isFinite(value) ? String(value) : value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "string") {
    return nest?.(new TextEncoder().encode(value), true) ?? value;
  }
  if (value instanceof PyShown) {
    return value.value;
  }
  if (value instanceof PyBytes) {
    const inner = value.array ? undefined : nest?.(value.bytes, false);
    return inner ?? (value.array ? `bytearray(${bytesRepr(value.bytes)})` : bytesRepr(value.bytes));
  }
  if (value instanceof PyGlobal) {
    return { __global__: value.path };
  }
  if (value instanceof PersistentId) {
    return { __persistent_id__: toJson(value.id, nest, seen) };
  }
  if (seen.has(value)) {
    return "<recursion>";
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => toJson(item, nest, seen));
    }
    if (value instanceof PyTuple) {
      return value.items.map((item) => toJson(item, nest, seen));
    }
    if (value instanceof PyDict) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of value.entries) {
        out[keyText(key, nest, seen)] = toJson(item, nest, seen);
      }
      return out;
    }
    if (value instanceof PySet) {
      return { [value.frozen ? "__frozenset__" : "__set__"]: value.items.map((item) => toJson(item, nest, seen)) };
    }
    // An instance.
    const path = value.maker instanceof PyGlobal ? value.maker.path : null;
    if (path === "uuid.UUID" && value.state instanceof PyDict) {
      const int = value.state.entries.find(([key]) => key === "int")?.[1];
      if (typeof int === "bigint" || typeof int === "number") {
        const hex = BigInt(int).toString(16).padStart(32, "0");
        return `UUID('${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}')`;
      }
    }
    if (path !== null && Object.hasOwn(DICT_CLASSES, path) && value.state === undefined && value.list === null) {
      const items = value.dict === null ? {} : toJson(value.dict, nest, seen);
      return path === "builtins.dict" ? items : { __class__: path, items };
    }
    const out: Record<string, unknown> = { __class__: path ?? toJson(value.maker, nest, seen) };
    if (value.args.length > 0) {
      out.args = value.args.map((item) => toJson(item, nest, seen));
    }
    if (value.kwargs !== null) {
      out.kwargs = toJson(value.kwargs, nest, seen);
    }
    if (value.state !== undefined) {
      out.state = toJson(value.state, nest, seen);
    }
    if (value.list !== null) {
      out.items = value.list.map((item) => toJson(item, nest, seen));
    }
    if (value.dict !== null) {
      out.items = toJson(value.dict, nest, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

// The pickle as plain JSON; null when the bytes aren't a whole pickle.
// `nest` reads strings and bytes inside it that hold JSON or another
// pickle.
export function pickleValue(bytes: Uint8Array, nest: Nest | null = null): { value: unknown } | null {
  try {
    return { value: toJson(unpickle(bytes), nest, new Set()) };
  } catch (error) {
    if (error instanceof PickleError || error instanceof RangeError) {
      return null;
    }
    throw error;
  }
}

// Whether the bytes start like a pickle: PROTO 2–5, or a protocol 0/1
// pickle (ASCII opcodes) that ends in STOP.
export function looksLikePickle(bytes: Uint8Array): boolean {
  if (bytes.length < 2 || bytes[bytes.length - 1] !== 0x2e) {
    return false;
  }
  if (bytes[0] === 0x80) {
    return bytes[1] >= 2 && bytes[1] <= 5;
  }
  // Protocol 0/1 starts with a container, a mark, a global or a value.
  return [0x28, 0x5d, 0x7d, 0x29, 0x63, 0x4e, 0x49, 0x4c, 0x46, 0x53, 0x56, 0x58, 0x55, 0x54, 0x4a, 0x4b].includes(bytes[0]);
}
