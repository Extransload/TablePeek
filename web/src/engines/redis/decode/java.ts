// Java serialization (ObjectOutputStream, AC ED 00 05) read as data: class
// descriptors, field values, strings, arrays, enums and back-references,
// nothing loaded or run. Objects become { "__class__", …fields }; the
// common java.util collections, boxed numbers and Date are written
// readably from what their writeObject put in the stream; other custom
// data (block data) is shown as hex.

class JavaError extends Error {}

const TC_NULL = 0x70;
const TC_REFERENCE = 0x71;
const TC_CLASSDESC = 0x72;
const TC_OBJECT = 0x73;
const TC_STRING = 0x74;
const TC_ARRAY = 0x75;
const TC_CLASS = 0x76;
const TC_BLOCKDATA = 0x77;
const TC_ENDBLOCKDATA = 0x78;
const TC_RESET = 0x79;
const TC_BLOCKDATALONG = 0x7a;
const TC_EXCEPTION = 0x7b;
const TC_LONGSTRING = 0x7c;
const TC_PROXYCLASSDESC = 0x7d;
const TC_ENUM = 0x7e;
const BASE_HANDLE = 0x7e0000;

const SC_WRITE_METHOD = 0x01;
const SC_SERIALIZABLE = 0x02;
const SC_EXTERNALIZABLE = 0x04;
const SC_BLOCK_DATA = 0x08;

interface Field {
  type: string;
  name: string;
}

interface ClassDesc {
  name: string;
  flags: number;
  fields: Field[];
  superDesc: ClassDesc | null;
}

class Block {
  constructor(readonly bytes: Uint8Array) {}
}

// An object still being read: a reference to it (a cycle) shows its class.
class Pending {
  constructor(readonly name: string) {}
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Java's modified UTF-8: NUL as C0 80, other characters past the BMP as
// two encoded surrogates.
function modifiedUtf8(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const a = bytes[i];
    if (a < 0x80) {
      out += String.fromCharCode(a);
      i += 1;
    } else if ((a & 0xe0) === 0xc0 && i + 1 < bytes.length) {
      out += String.fromCharCode(((a & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if ((a & 0xf0) === 0xe0 && i + 2 < bytes.length) {
      out += String.fromCharCode(((a & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f));
      i += 3;
    } else {
      throw new JavaError("bad modified UTF-8");
    }
  }
  return out;
}

function simpleName(name: string): string {
  return name.slice(Math.max(name.lastIndexOf("."), name.lastIndexOf("$")) + 1);
}

function keyText(key: unknown): string {
  return typeof key === "string" ? key : JSON.stringify(key);
}

class Stream {
  at = 0;
  handles: unknown[] = [];
  view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  need(count: number): void {
    if (this.at + count > this.bytes.length) {
      throw new JavaError("truncated");
    }
  }
  u8(): number {
    this.need(1);
    return this.bytes[this.at++];
  }
  u16(): number {
    this.need(2);
    const out = this.view.getUint16(this.at);
    this.at += 2;
    return out;
  }
  i32(): number {
    this.need(4);
    const out = this.view.getInt32(this.at);
    this.at += 4;
    return out;
  }
  i64(): number | string {
    this.need(8);
    const out = this.view.getBigInt64(this.at);
    this.at += 8;
    return out >= BigInt(Number.MIN_SAFE_INTEGER) && out <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(out) : out.toString();
  }
  take(count: number): Uint8Array {
    if (count < 0) {
      throw new JavaError("bad length");
    }
    this.need(count);
    const out = this.bytes.subarray(this.at, this.at + count);
    this.at += count;
    return out;
  }
  utf(): string {
    return modifiedUtf8(this.take(this.u16()));
  }
  handle(value: unknown): number {
    this.handles.push(value);
    return this.handles.length - 1;
  }
  ref(): unknown {
    const index = this.i32() - BASE_HANDLE;
    if (index < 0 || index >= this.handles.length) {
      throw new JavaError("bad handle");
    }
    const found = this.handles[index];
    return found instanceof Pending ? `<${simpleName(found.name)} …>` : found;
  }

  classDesc(): ClassDesc | null {
    const tc = this.u8();
    if (tc === TC_NULL) {
      return null;
    }
    if (tc === TC_REFERENCE) {
      const found = this.ref();
      if (found === null || typeof found !== "object" || !("flags" in found)) {
        throw new JavaError("not a class descriptor");
      }
      return found as ClassDesc;
    }
    if (tc === TC_PROXYCLASSDESC) {
      const desc: ClassDesc = { name: "", flags: 0, fields: [], superDesc: null };
      this.handle(desc);
      const count = this.i32();
      const names: string[] = [];
      for (let i = 0; i < count; i++) {
        names.push(this.utf());
      }
      desc.name = `Proxy(${names.join(", ")})`;
      this.annotation();
      desc.superDesc = this.classDesc();
      return desc;
    }
    if (tc !== TC_CLASSDESC) {
      throw new JavaError("expected a class descriptor");
    }
    const desc: ClassDesc = { name: this.utf(), flags: 0, fields: [], superDesc: null };
    this.take(8); // serialVersionUID
    this.handle(desc);
    desc.flags = this.u8();
    const count = this.u16();
    for (let i = 0; i < count; i++) {
      const type = String.fromCharCode(this.u8());
      const name = this.utf();
      if (type === "L" || type === "[") {
        this.content(); // the field's class name, a string
      } else if (!"BCDFIJSZ".includes(type)) {
        throw new JavaError("bad field type");
      }
      desc.fields.push({ type, name });
    }
    this.annotation();
    desc.superDesc = this.classDesc();
    return desc;
  }

  // Contents up to TC_ENDBLOCKDATA.
  annotation(): unknown[] {
    const out: unknown[] = [];
    for (;;) {
      if (this.bytes[this.at] === TC_ENDBLOCKDATA) {
        this.at += 1;
        return out;
      }
      out.push(this.content());
    }
  }

  primitive(type: string): unknown {
    switch (type) {
      case "B":
        this.need(1);
        return this.view.getInt8(this.at++);
      case "C":
        return String.fromCharCode(this.u16());
      case "D": {
        this.need(8);
        const out = this.view.getFloat64(this.at);
        this.at += 8;
        return out;
      }
      case "F": {
        this.need(4);
        const out = this.view.getFloat32(this.at);
        this.at += 4;
        return Number(out.toPrecision(7));
      }
      case "I":
        return this.i32();
      case "J":
        return this.i64();
      case "S": {
        this.need(2);
        const out = this.view.getInt16(this.at);
        this.at += 2;
        return out;
      }
      case "Z":
        return this.u8() !== 0;
      default:
        return this.content();
    }
  }

  object(): unknown {
    const desc = this.classDesc();
    if (desc === null) {
      throw new JavaError("object without class");
    }
    const slot = this.handle(new Pending(desc.name));
    const chain: ClassDesc[] = [];
    for (let cd: ClassDesc | null = desc; cd !== null; cd = cd.superDesc) {
      chain.unshift(cd);
    }
    const fields: Record<string, unknown> = {};
    const extra: unknown[] = [];
    for (const cd of chain) {
      if (cd.flags & SC_EXTERNALIZABLE) {
        if (!(cd.flags & SC_BLOCK_DATA)) {
          throw new JavaError("old externalizable data");
        }
        extra.push(...this.annotation());
        continue;
      }
      if (cd.flags & SC_SERIALIZABLE) {
        for (const field of cd.fields) {
          const name = Object.hasOwn(fields, field.name) ? `${simpleName(cd.name)}.${field.name}` : field.name;
          fields[name] = this.primitive(field.type);
        }
        if (cd.flags & SC_WRITE_METHOD) {
          extra.push(...this.annotation());
        }
      }
    }
    const out = readable(desc.name, fields, extra);
    this.handles[slot] = out;
    return out;
  }

  array(): unknown {
    const desc = this.classDesc();
    if (desc === null) {
      throw new JavaError("array without class");
    }
    const slot = this.handle(new Pending(desc.name));
    const size = this.i32();
    if (size < 0 || size > this.bytes.length) {
      throw new JavaError("bad array size");
    }
    const component = desc.name.slice(1, 2);
    let out: unknown;
    if (component === "B") {
      out = `0x${hex(this.take(size))}`;
    } else {
      const items: unknown[] = [];
      for (let i = 0; i < size; i++) {
        items.push(this.primitive(component));
      }
      out = items;
    }
    this.handles[slot] = out;
    return out;
  }

  content(): unknown {
    const tc = this.u8();
    switch (tc) {
      case TC_NULL:
        return null;
      case TC_REFERENCE:
        return this.ref();
      case TC_STRING: {
        const out = this.utf();
        this.handle(out);
        return out;
      }
      case TC_LONGSTRING: {
        const length = this.i64();
        if (typeof length !== "number") {
          throw new JavaError("string too long");
        }
        const out = modifiedUtf8(this.take(length));
        this.handle(out);
        return out;
      }
      case TC_CLASSDESC:
      case TC_PROXYCLASSDESC: {
        this.at -= 1;
        const desc = this.classDesc();
        return { __classdesc__: desc?.name ?? null };
      }
      case TC_CLASS: {
        const desc = this.classDesc();
        const out = { __class_ref__: desc?.name ?? null };
        this.handle(out);
        return out;
      }
      case TC_ARRAY:
        return this.array();
      case TC_OBJECT:
        return this.object();
      case TC_ENUM: {
        const desc = this.classDesc();
        const slot = this.handle(null);
        const constant = this.content();
        const out = `${simpleName(desc?.name ?? "?")}.${String(constant)}`;
        this.handles[slot] = out;
        return out;
      }
      case TC_BLOCKDATA:
        return new Block(this.take(this.u8()));
      case TC_BLOCKDATALONG:
        return new Block(this.take(this.i32()));
      case TC_RESET:
        this.handles = [];
        return this.content();
      case TC_EXCEPTION:
        throw new JavaError("exception in stream");
      default:
        throw new JavaError(`unknown tag 0x${tc.toString(16)}`);
    }
  }
}

const BOXED = /^java\.lang\.(Integer|Long|Short|Byte|Double|Float|Boolean|Character)$/;
const MAPS = /^java\.util\.(HashMap|LinkedHashMap|Hashtable|TreeMap|IdentityHashMap|WeakHashMap|Properties)$/;
const LISTS = /^java\.util\.(ArrayList|LinkedList|ArrayDeque|HashSet|LinkedHashSet|TreeSet|concurrent\.CopyOnWriteArrayList)$/;

function blockText(item: Block): unknown {
  return { __block__: hex(item.bytes) };
}

function plain(item: unknown): unknown {
  return item instanceof Block ? blockText(item) : item;
}

// The stream's object as JSON, the known classes as their values.
function readable(name: string, fields: Record<string, unknown>, extra: unknown[]): unknown {
  const objects = extra.filter((item) => !(item instanceof Block));
  if (BOXED.test(name) && "value" in fields) {
    return fields.value;
  }
  if (name === "java.util.Date") {
    const block = extra.find((item): item is Block => item instanceof Block);
    if (block !== undefined && block.bytes.length >= 8) {
      const ms = Number(new DataView(block.bytes.buffer, block.bytes.byteOffset, 8).getBigInt64(0));
      const date = new Date(ms);
      if (!Number.isNaN(date.getTime())) {
        return date.toISOString();
      }
    }
  }
  if (MAPS.test(name)) {
    const out: Record<string, unknown> = {};
    for (let i = 0; i + 1 < objects.length; i += 2) {
      out[keyText(objects[i])] = objects[i + 1];
    }
    return out;
  }
  if (LISTS.test(name)) {
    // TreeSet writes its comparator first.
    return name === "java.util.TreeSet" ? objects.slice(1) : objects;
  }
  const out: Record<string, unknown> = { __class__: name, ...fields };
  if (extra.length > 0) {
    out.__data__ = extra.map(plain);
  }
  return out;
}

// The stream's contents as JSON (one object, or a list of several); null
// unless the bytes are a whole Java serialization stream.
export function javaValue(bytes: Uint8Array): { value: unknown } | null {
  if (!looksLikeJava(bytes)) {
    return null;
  }
  const stream = new Stream(bytes);
  stream.at = 4;
  try {
    const items: unknown[] = [];
    while (stream.at < bytes.length) {
      items.push(plain(stream.content()));
    }
    return { value: items.length === 1 ? items[0] : items };
  } catch (error) {
    if (error instanceof JavaError || error instanceof RangeError) {
      return null;
    }
    throw error;
  }
}

export function looksLikeJava(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0xac && bytes[1] === 0xed && bytes[2] === 0x00 && bytes[3] === 0x05;
}
