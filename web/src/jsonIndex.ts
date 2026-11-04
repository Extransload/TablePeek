// A parsed JSON document flattened once into pre-order arrays, so a large
// value (hundreds of thousands of nodes) can be expanded, searched and
// scrolled without walking objects or building path strings per render.
// Node 0 is the root; a node's subtree is the ids [id, ends[id]).

export type JsonKind = "object" | "array" | "string" | "number" | "boolean" | "null";

const KINDS: JsonKind[] = ["object", "array", "string", "number", "boolean", "null"];
const OBJECT = 0;
const ARRAY = 1;

export interface JsonIndex {
  count: number;
  keys: string[];
  values: unknown[];
  kinds: Uint8Array;
  depths: Uint16Array;
  parents: Int32Array;
  ends: Int32Array;
  // Direct children of a container, 0 for anything else.
  sizes: Int32Array;
  maxDepth: number;
}

function kindCode(value: unknown): number {
  if (value === null || value === undefined) {
    return 5;
  }
  if (Array.isArray(value)) {
    return ARRAY;
  }
  switch (typeof value) {
    case "object":
      return OBJECT;
    case "number":
    case "bigint":
      return 3;
    case "boolean":
      return 4;
    default:
      return 2;
  }
}

export function kindAt(index: JsonIndex, id: number): JsonKind {
  return KINDS[index.kinds[id]];
}

export function kindOf(value: unknown): JsonKind {
  return KINDS[kindCode(value)];
}

// A container's member count as its row shows it after the key: {3}, [3].
export function containerSize(kind: JsonKind, count: number): string {
  return kind === "array" ? `[${count.toLocaleString()}]` : `{${count.toLocaleString()}}`;
}

// A primitive as a tree row shows it: strings quoted and cut short.
export function inlineText(kind: JsonKind, value: unknown): string {
  if (kind === "string") {
    const text = String(value);
    return `"${text.length > 300 ? `${text.slice(0, 300)}…` : text}"`;
  }
  return kind === "null" ? "null" : String(value);
}

// The data grid's colour (its --type-* ink) a JSON value is drawn in, or a
// key or punctuation in indented JSON.
export type JsonInk = "string" | "integer" | "float" | "bigint" | "boolean" | "null" | "json" | "list" | "key" | "punct";

export function inkOf(kind: JsonKind, value: unknown): JsonInk {
  switch (kind) {
    case "number":
      return typeof value !== "number" || !Number.isInteger(value)
        ? "float"
        : Number.isSafeInteger(value)
          ? "integer"
          : "bigint";
    case "object":
      return "json";
    case "array":
      return "list";
    default:
      return kind;
  }
}

export interface JsonSpan {
  from: number;
  to: number;
  ink: JsonInk;
}

// { } [ ] , :
function isPunctuation(code: number): boolean {
  return code === 123 || code === 125 || code === 91 || code === 93 || code === 44 || code === 58;
}

// The coloured ranges of JSON text (indented or not, and possibly cut off
// mid-value); whitespace between them stays plain.
export function jsonSpans(text: string): JsonSpan[] {
  const spans: JsonSpan[] = [];
  const n = text.length;
  let at = 0;
  while (at < n) {
    const code = text.charCodeAt(at);
    let end = at + 1;
    let ink: JsonInk | null = null;
    if (code === 34) {
      while (end < n && text.charCodeAt(end) !== 34) {
        end += text.charCodeAt(end) === 92 ? 2 : 1;
      }
      end = Math.min(end + 1, n);
      let next = end;
      while (next < n && isSpace(text.charCodeAt(next))) {
        next += 1;
      }
      ink = text.charCodeAt(next) === 58 ? "key" : "string";
    } else if (code === 45 || (code >= 48 && code <= 57)) {
      let fraction = false;
      for (; end < n; end += 1) {
        const next = text.charCodeAt(end);
        if (next === 46 || next === 101 || next === 69 || next === 43 || next === 45) {
          fraction = true;
        } else if (next < 48 || next > 57) {
          break;
        }
      }
      ink = fraction ? "float" : Number.isSafeInteger(Number(text.slice(at, end))) ? "integer" : "bigint";
    } else if (text.startsWith("true", at) || text.startsWith("false", at)) {
      end = at + (code === 116 ? 4 : 5);
      ink = "boolean";
    } else if (text.startsWith("null", at)) {
      end = at + 4;
      ink = "null";
    } else if (isPunctuation(code)) {
      // A run of brackets and commas (with the spaces between) is one span.
      while (end < n && (isPunctuation(text.charCodeAt(end)) || isSpace(text.charCodeAt(end)))) {
        end += 1;
      }
      ink = "punct";
    }
    if (ink !== null) {
      spans.push({ from: at, to: end, ink });
    }
    at = end;
  }
  return spans;
}

export function isContainer(index: JsonIndex, id: number): boolean {
  return index.kinds[id] <= ARRAY;
}

export function buildIndex(doc: unknown): JsonIndex {
  const keys: string[] = [];
  const values: unknown[] = [];
  const kinds: number[] = [];
  const depths: number[] = [];
  const parents: number[] = [];
  const sizes: number[] = [];
  let maxDepth = 0;
  // Children go on the stack last-first so they come off in document order.
  const stack: { value: unknown; key: string; depth: number; parent: number }[] = [
    { value: doc, key: "ROOT", depth: 0, parent: -1 },
  ];
  while (stack.length > 0) {
    const { value, key, depth, parent } = stack.pop()!;
    const id = values.length;
    const kind = kindCode(value);
    keys.push(key);
    values.push(value);
    kinds.push(kind);
    depths.push(depth);
    parents.push(parent);
    if (depth > maxDepth) {
      maxDepth = depth;
    }
    if (kind === ARRAY) {
      const items = value as unknown[];
      sizes.push(items.length);
      for (let i = items.length - 1; i >= 0; i -= 1) {
        stack.push({ value: items[i], key: String(i), depth: depth + 1, parent: id });
      }
    } else if (kind === OBJECT) {
      const record = value as Record<string, unknown>;
      const names = Object.keys(record);
      sizes.push(names.length);
      for (let i = names.length - 1; i >= 0; i -= 1) {
        stack.push({ value: record[names[i]], key: names[i], depth: depth + 1, parent: id });
      }
    } else {
      sizes.push(0);
    }
  }
  const count = values.length;
  const parentIds = Int32Array.from(parents);
  // Subtree sizes from the leaves up give each node the id past its subtree.
  const spans = new Int32Array(count).fill(1);
  for (let id = count - 1; id > 0; id -= 1) {
    spans[parentIds[id]] += spans[id];
  }
  const ends = new Int32Array(count);
  for (let id = 0; id < count; id += 1) {
    ends[id] = id + spans[id];
  }
  return {
    count,
    keys,
    values,
    kinds: Uint8Array.from(kinds),
    depths: Uint16Array.from(depths),
    parents: parentIds,
    ends,
    sizes: Int32Array.from(sizes),
    maxDepth,
  };
}

// The nodes the tree shows, in order: every node whose ancestors are open.
export function visibleIds(index: JsonIndex, open: Uint8Array): Int32Array {
  const out = new Int32Array(index.count);
  let shown = 0;
  let id = 0;
  while (id < index.count) {
    out[shown] = id;
    shown += 1;
    id = index.kinds[id] <= ARRAY && open[id] === 1 ? id + 1 : index.ends[id];
  }
  return out.subarray(0, shown);
}

// Where a node sits in a sorted id list, or -1.
export function positionOf(ids: Int32Array, id: number): number {
  let low = 0;
  let high = ids.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (ids[mid] === id) {
      return mid;
    }
    if (ids[mid] < id) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return -1;
}

// Opens every ancestor of a node so the tree shows it.
export function openTo(index: JsonIndex, open: Uint8Array, id: number): void {
  for (let parent = index.parents[id]; parent >= 0; parent = index.parents[parent]) {
    open[parent] = 1;
  }
}

// Containers down to `depth` open, deeper ones closed.
export function openToDepth(index: JsonIndex, open: Uint8Array, depth: number): void {
  for (let id = 0; id < index.count; id += 1) {
    open[id] = index.depths[id] < depth ? 1 : 0;
  }
}

export function setSubtree(index: JsonIndex, open: Uint8Array, id: number, value: 0 | 1): void {
  open.fill(value, id, index.ends[id]);
}

// A container's direct children, in document order (none for a primitive).
export function childIds(index: JsonIndex, id: number): Int32Array {
  const ids = new Int32Array(index.sizes[id]);
  let at = 0;
  for (let child = id + 1; child < index.ends[id]; child = index.ends[child]) {
    ids[at] = child;
    at += 1;
  }
  return ids;
}

// What a node's value reads as on one line or in the value pane.
export function primitiveText(value: unknown): string {
  return value === null || value === undefined ? "null" : String(value);
}

// Lower-cased text per node, built on the first search: a key (array indexes
// don't count) and a primitive's value, split by a character no query holds.
const haystacks = new WeakMap<JsonIndex, string[]>();

function haystackOf(index: JsonIndex): string[] {
  let texts = haystacks.get(index);
  if (texts === undefined) {
    texts = new Array<string>(index.count);
    for (let id = 0; id < index.count; id += 1) {
      const parent = index.parents[id];
      const key = parent >= 0 && index.kinds[parent] === OBJECT ? index.keys[id] : "";
      const value = index.kinds[id] <= ARRAY ? "" : primitiveText(index.values[id]);
      texts[id] = `${key}\u0001${value}`.toLowerCase();
    }
    haystacks.set(index, texts);
  }
  return texts;
}

// Ids of the nodes whose key or value holds the query, in document order.
export function searchIndex(index: JsonIndex, query: string): Int32Array {
  const needle = query.toLowerCase();
  const texts = haystackOf(index);
  const found = new Int32Array(index.count);
  let count = 0;
  for (let id = 1; id < index.count; id += 1) {
    if (texts[id].includes(needle)) {
      found[count] = id;
      count += 1;
    }
  }
  return found.subarray(0, count);
}

// Ids from the root down to the node.
export function lineage(index: JsonIndex, id: number): number[] {
  const chain: number[] = [];
  for (let at = id; at >= 0; at = index.parents[at]) {
    chain.push(at);
  }
  return chain.reverse();
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

// A JSONPath-style path: $.items[3].name, with odd keys bracketed.
export function pathOf(index: JsonIndex, id: number): string {
  let path = "$";
  for (const at of lineage(index, id).slice(1)) {
    const key = index.keys[at];
    if (index.kinds[index.parents[at]] === ARRAY) {
      path += `[${key}]`;
    } else {
      path += IDENTIFIER.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`;
    }
  }
  return path;
}

// Where each node sits in the document's indented lines (prettyLines, or
// JSON.stringify with two spaces): the line it starts on and the line it
// ends on, which for a non-empty container is its closing bracket.
export interface LineSpans {
  starts: Int32Array;
  closes: Int32Array;
  total: number;
}

export function lineSpans(index: JsonIndex): LineSpans {
  const { count, ends, sizes, kinds } = index;
  const starts = new Int32Array(count);
  const closes = new Int32Array(count);
  const stack = new Int32Array(index.maxDepth + 1);
  let depth = 0;
  let line = 0;
  for (let id = 0; id < count; id += 1) {
    while (depth > 0 && ends[stack[depth - 1]] <= id) {
      depth -= 1;
      closes[stack[depth]] = line;
      line += 1;
    }
    starts[id] = line;
    closes[id] = line;
    line += 1;
    if (kinds[id] <= ARRAY && sizes[id] > 0) {
      stack[depth] = id;
      depth += 1;
    }
  }
  while (depth > 0) {
    depth -= 1;
    closes[stack[depth]] = line;
    line += 1;
  }
  return { starts, closes, total: line };
}

const PADS: string[] = [""];

function pad(depth: number): string {
  while (PADS.length <= depth) {
    PADS.push(`${PADS[PADS.length - 1]}  `);
  }
  return PADS[depth];
}

function isSpace(code: number): boolean {
  return code === 32 || code === 10 || code === 13 || code === 9;
}

// Valid JSON text indented two spaces a level, one line per member. It works
// on the text itself, so numbers past 2^53 and escapes stay as stored.
export function prettyLines(text: string): string[] {
  const lines: string[] = [];
  const length = text.length;
  let line = "";
  let depth = 0;
  let at = 0;
  while (at < length) {
    const code = text.charCodeAt(at);
    if (isSpace(code)) {
      at += 1;
    } else if (code === 34) {
      // A string runs to the first quote not escaped by an odd run of backslashes.
      let end = at + 1;
      for (;;) {
        end = text.indexOf('"', end);
        if (end < 0) {
          end = length - 1;
          break;
        }
        let slashes = 0;
        while (text.charCodeAt(end - 1 - slashes) === 92) {
          slashes += 1;
        }
        if (slashes % 2 === 0) {
          break;
        }
        end += 1;
      }
      line += text.slice(at, end + 1);
      at = end + 1;
    } else if (code === 123 || code === 91) {
      let next = at + 1;
      while (next < length && isSpace(text.charCodeAt(next))) {
        next += 1;
      }
      const close = code === 123 ? 125 : 93;
      if (text.charCodeAt(next) === close) {
        line += code === 123 ? "{}" : "[]";
        at = next + 1;
      } else {
        lines.push(line + text[at]);
        depth += 1;
        line = pad(depth);
        at += 1;
      }
    } else if (code === 125 || code === 93) {
      lines.push(line);
      depth = Math.max(0, depth - 1);
      line = pad(depth) + text[at];
      at += 1;
    } else if (code === 44) {
      lines.push(`${line},`);
      line = pad(depth);
      at += 1;
    } else if (code === 58) {
      line += ": ";
      at += 1;
    } else {
      let end = at + 1;
      while (end < length) {
        const next = text.charCodeAt(end);
        if (isSpace(next) || next === 44 || next === 58 || next === 93 || next === 125) {
          break;
        }
        end += 1;
      }
      line += text.slice(at, end);
      at = end;
    }
  }
  if (line.trim() !== "") {
    lines.push(line);
  }
  return lines;
}
