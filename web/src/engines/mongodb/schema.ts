// Field analysis of a document sample for the 스키마 tab (MONGODB.md §6.2):
// a path tree (nested documents and the documents inside arrays), how many
// documents have each path, the mix of types and a summary per kind of value.
// From the same analysis, a `$jsonSchema` draft for the 검증 tab, and the
// reasons a document breaks a `$jsonSchema` rule for its violation list (the
// server decides pass or fail; these only explain).

import { t } from "../../i18n";
import { BsonDate, Double, Int32, Int64, compareForSort, isDocument, typeName, type BsonDocument, type BsonTypeName, type BsonValue } from "./bson";
import { toShell } from "./format";

export const SAMPLE_SIZES = [100, 500, 1000];

// A histogram bar. `lo === hi` for a bar holding one integer value; otherwise
// it spans [lo, hi), the last bar [lo, hi].
export interface Bin {
  lo: number;
  hi: number;
  count: number;
}

export interface NumberSummary {
  count: number;
  min: number;
  max: number;
  mean: number;
  distinct: number;
  bins: Bin[];
}

// Milliseconds since the epoch.
export interface DateSummary {
  count: number;
  min: number;
  max: number;
  bins: Bin[];
}

export interface StringSummary {
  count: number;
  distinct: number;
  // Most frequent first; every value when there are at most TOP_STRINGS.
  top: { value: string; count: number }[];
  minLength: number;
  maxLength: number;
  meanLength: number;
}

export interface ObjectIdSummary {
  count: number;
  distinct: number;
  // Creation times (the id's first four bytes), milliseconds.
  first: number;
  last: number;
  examples: string[];
}

export interface BooleanSummary {
  count: number;
  trues: number;
  falses: number;
}

export interface ArraySummary {
  count: number;
  minLength: number;
  maxLength: number;
  meanLength: number;
  // Arrays of each length 0 … LENGTH_CAP, and how many are longer.
  lengths: number[];
  longer: number;
}

export interface SchemaField {
  // Dotted path; documents inside arrays share their array's path
  // (`items.sku`), as queries address them.
  path: string;
  name: string;
  depth: number;
  parent: string | null;
  // Child paths, `_id` first, then by how many documents have them.
  children: string[];
  // Documents of the sample having the path, and that share of the sample.
  count: number;
  presence: number;
  // Values seen at the path (several per document under an array) by type.
  types: Partial<Record<BsonTypeName, number>>;
  // Types of the elements of arrays at the path.
  elemTypes: Partial<Record<BsonTypeName, number>>;
  // Documents seen at the path (values and array elements); their keys are
  // the children, so a child seen in each of them is always there.
  objects: number;
  // Scalars at the path, array elements included.
  number?: NumberSummary;
  date?: DateSummary;
  string?: StringSummary;
  objectId?: ObjectIdSummary;
  boolean?: BooleanSummary;
  array?: ArraySummary;
}

export interface SchemaAnalysis {
  sampleSize: number;
  fields: Map<string, SchemaField>;
  roots: string[];
}

const TOP_STRINGS = 12;
const LENGTH_CAP = 15;
const NUMBER_BINS = 16;
const DATE_BINS = 18;

interface Acc {
  field: SchemaField;
  order: number;
  lastDoc: number;
  numbers: number[];
  dates: number[];
  strings: Map<string, number>;
  stringCount: number;
  lengthSum: number;
  minLength: number;
  maxLength: number;
  oids: Map<string, number>;
  oidCount: number;
  trues: number;
  falses: number;
  arrays: number[];
}

function bump<K extends string>(map: Partial<Record<K, number>>, key: K): void {
  map[key] = (map[key] ?? 0) + 1;
}

// A number of any BSON width as a JS number (Decimal128 through its text),
// or null for text that is not finite.
function numeric(v: BsonValue): number | null {
  if (v === null || typeof v !== "object" || Array.isArray(v) || isDocument(v)) {
    return null;
  }
  let n: number;
  switch (v.type) {
    case "Int32":
    case "Double":
      n = v.value;
      break;
    case "Int64":
      n = Number(v.value);
      break;
    case "Decimal128":
      n = Number(v.value);
      break;
    default:
      return null;
  }
  return Number.isFinite(n) ? n : null;
}

function minMax(list: number[]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const x of list) {
    if (x < min) {
      min = x;
    }
    if (x > max) {
      max = x;
    }
  }
  return { min, max };
}

// `k` equal bars from min to max, the last one closed.
function rangeBins(list: number[], min: number, max: number, k: number, emptyStep: number): Bin[] {
  const step = (max - min) / k || emptyStep;
  const bins: Bin[] = Array.from({ length: k }, (_, i) => ({ lo: min + i * step, hi: i === k - 1 ? Math.max(max, min + k * step) : min + (i + 1) * step, count: 0 }));
  for (const x of list) {
    bins[Math.min(k - 1, Math.floor((x - min) / step))].count++;
  }
  return bins;
}

function numberSummary(list: number[]): NumberSummary | undefined {
  if (list.length === 0) {
    return undefined;
  }
  const { min, max } = minMax(list);
  const distinct = new Set(list).size;
  let bins: Bin[];
  // Few integer values close together: one bar each.
  if (list.every(Number.isInteger) && max - min <= 20 && distinct <= 16) {
    bins = Array.from({ length: max - min + 1 }, (_, i) => ({ lo: min + i, hi: min + i, count: 0 }));
    for (const x of list) {
      bins[x - min].count++;
    }
  } else {
    bins = rangeBins(list, min, max, NUMBER_BINS, 1);
  }
  return { count: list.length, min, max, mean: list.reduce((a, b) => a + b, 0) / list.length, distinct, bins };
}

function dateSummary(list: number[]): DateSummary | undefined {
  if (list.length === 0) {
    return undefined;
  }
  const { min, max } = minMax(list);
  return { count: list.length, min, max, bins: rangeBins(list, min, max, DATE_BINS, 86_400_000) };
}

function finish(acc: Acc, sampleSize: number): SchemaField {
  const f = acc.field;
  f.presence = sampleSize === 0 ? 0 : f.count / sampleSize;
  f.number = numberSummary(acc.numbers);
  f.date = dateSummary(acc.dates);
  if (acc.stringCount > 0) {
    const sorted = [...acc.strings].sort((a, b) => b[1] - a[1]);
    f.string = {
      count: acc.stringCount,
      distinct: acc.strings.size,
      top: sorted.slice(0, TOP_STRINGS).map(([value, count]) => ({ value, count })),
      minLength: acc.minLength,
      maxLength: acc.maxLength,
      meanLength: acc.lengthSum / acc.stringCount,
    };
  }
  if (acc.oidCount > 0) {
    const times = [...acc.oids.keys()].map((hex) => parseInt(hex.slice(0, 8), 16) * 1000);
    const { min, max } = minMax(times);
    f.objectId = { count: acc.oidCount, distinct: acc.oids.size, first: min, last: max, examples: [...acc.oids.keys()].slice(0, 3) };
  }
  if (acc.trues + acc.falses > 0) {
    f.boolean = { count: acc.trues + acc.falses, trues: acc.trues, falses: acc.falses };
  }
  if (acc.arrays.length > 0) {
    const { min, max } = minMax(acc.arrays);
    const lengths = new Array<number>(Math.min(max, LENGTH_CAP) + 1).fill(0);
    let longer = 0;
    for (const n of acc.arrays) {
      if (n > LENGTH_CAP) {
        longer++;
      } else {
        lengths[n]++;
      }
    }
    f.array = { count: acc.arrays.length, minLength: min, maxLength: max, meanLength: acc.arrays.reduce((a, b) => a + b, 0) / acc.arrays.length, lengths, longer };
  }
  return f;
}

// Fields of `docs` (the sample) with their presence, types and summaries.
export function analyzeSchema(docs: BsonDocument[]): SchemaAnalysis {
  const accs = new Map<string, Acc>();
  const touch = (path: string, name: string, depth: number, parent: string | null): Acc => {
    let acc = accs.get(path);
    if (!acc) {
      acc = {
        field: { path, name, depth, parent, children: [], count: 0, presence: 0, types: {}, elemTypes: {}, objects: 0 },
        order: accs.size,
        lastDoc: -1,
        numbers: [],
        dates: [],
        strings: new Map(),
        stringCount: 0,
        lengthSum: 0,
        minLength: Infinity,
        maxLength: 0,
        oids: new Map(),
        oidCount: 0,
        trues: 0,
        falses: 0,
        arrays: [],
      };
      accs.set(path, acc);
      if (parent !== null) {
        accs.get(parent)?.field.children.push(path);
      }
    }
    return acc;
  };
  const record = (acc: Acc, v: BsonValue): void => {
    const n = numeric(v);
    if (n !== null) {
      acc.numbers.push(n);
    } else if (typeof v === "string") {
      acc.strings.set(v, (acc.strings.get(v) ?? 0) + 1);
      acc.stringCount++;
      const length = [...v].length;
      acc.lengthSum += length;
      acc.minLength = Math.min(acc.minLength, length);
      acc.maxLength = Math.max(acc.maxLength, length);
    } else if (typeof v === "boolean") {
      if (v) {
        acc.trues++;
      } else {
        acc.falses++;
      }
    } else if (v instanceof BsonDate) {
      acc.dates.push(Number(v.ms));
    } else if (v !== null && typeof v === "object" && !Array.isArray(v) && !isDocument(v) && v.type === "ObjectId") {
      acc.oids.set(v.hex, (acc.oids.get(v.hex) ?? 0) + 1);
      acc.oidCount++;
    }
  };
  const visit = (obj: BsonDocument, prefix: string | null, depth: number, docIndex: number): void => {
    for (const key of Object.keys(obj)) {
      const path = prefix === null ? key : `${prefix}.${key}`;
      const acc = touch(path, key, depth, prefix);
      const f = acc.field;
      if (acc.lastDoc !== docIndex) {
        acc.lastDoc = docIndex;
        f.count++;
      }
      const v = obj[key];
      bump(f.types, typeName(v));
      if (isDocument(v)) {
        f.objects++;
        visit(v, path, depth + 1, docIndex);
      } else if (Array.isArray(v)) {
        acc.arrays.push(v.length);
        for (const el of v) {
          bump(f.elemTypes, typeName(el));
          if (isDocument(el)) {
            f.objects++;
            visit(el, path, depth + 1, docIndex);
          } else if (!Array.isArray(el)) {
            record(acc, el);
          }
        }
      } else {
        record(acc, v);
      }
    }
  };
  docs.forEach((doc, i) => visit(doc, null, 0, i));
  const fields = new Map<string, SchemaField>();
  for (const [path, acc] of accs) {
    fields.set(path, finish(acc, docs.length));
  }
  const rank = (a: string, b: string): number => {
    const x = accs.get(a);
    const y = accs.get(b);
    if (!x || !y) {
      return 0;
    }
    return Number(b === "_id") - Number(a === "_id") || y.field.count - x.field.count || x.order - y.order;
  };
  for (const f of fields.values()) {
    f.children.sort(rank);
  }
  const roots = [...fields.values()].filter((f) => f.parent === null).map((f) => f.path).sort(rank);
  return { sampleSize: docs.length, fields, roots };
}

// Types by how often they were seen, most first.
export function typesByCount(types: Partial<Record<BsonTypeName, number>>): [BsonTypeName, number][] {
  return (Object.entries(types) as [BsonTypeName, number][]).sort((a, b) => b[1] - a[1]);
}

// A number as a filter value: integers as Int32 (Int64 past its range), the
// rest as doubles. The server compares numbers of any width by value.
export function filterNumber(n: number): BsonValue {
  if (Number.isInteger(n)) {
    return n >= -2147483648 && n <= 2147483647 ? new Int32(n) : Number.isSafeInteger(n) ? new Int64(BigInt(n)) : new Double(n);
  }
  return new Double(n);
}

// The analysis as plain JSON for 내보내기: dates as ISO text.
export function schemaExport(a: SchemaAnalysis, meta: { db: string; coll: string; filter: BsonDocument; at: Date }): string {
  const iso = (ms: number) => new Date(ms).toISOString();
  const fields = [...a.fields.values()].map((f) => ({
    path: f.path,
    count: f.count,
    presence: f.presence,
    types: f.types,
    ...(Object.keys(f.elemTypes).length > 0 ? { elemTypes: f.elemTypes } : {}),
    ...(f.number ? { number: f.number } : {}),
    ...(f.date ? { date: { ...f.date, min: iso(f.date.min), max: iso(f.date.max), bins: f.date.bins.map((b) => ({ lo: iso(b.lo), hi: iso(b.hi), count: b.count })) } } : {}),
    ...(f.string ? { string: f.string } : {}),
    ...(f.objectId ? { objectId: { ...f.objectId, first: iso(f.objectId.first), last: iso(f.objectId.last) } } : {}),
    ...(f.boolean ? { boolean: f.boolean } : {}),
    ...(f.array ? { array: f.array } : {}),
  }));
  return `${JSON.stringify({ db: meta.db, collection: meta.coll, filter: toShell(meta.filter), analyzedAt: meta.at.toISOString(), sampleSize: a.sampleSize, fields }, null, 2)}\n`;
}

// ---- $jsonSchema ----

// The `bsonType` alias of each type.
const BSON_ALIAS: Record<BsonTypeName, string> = {
  String: "string",
  Boolean: "bool",
  Null: "null",
  Object: "object",
  Array: "array",
  ObjectId: "objectId",
  Int32: "int",
  Int64: "long",
  Double: "double",
  Decimal128: "decimal",
  Date: "date",
  Binary: "binData",
  Regex: "regex",
  Timestamp: "timestamp",
  Code: "javascript",
  MinKey: "minKey",
  MaxKey: "maxKey",
  Undefined: "undefined",
};

function bsonTypeOf(types: Partial<Record<BsonTypeName, number>>): BsonValue {
  const names = typesByCount(types).map(([type]) => BSON_ALIAS[type]);
  return names.length === 1 ? names[0] : names;
}

// A `$jsonSchema` from the sample: each field's types, `required` for fields
// every document (or every document at that level) had, the documents
// inside objects and arrays, and `enum` for top-level text fields with a
// handful of values in a sample large enough to trust.
export function draftJsonSchema(a: SchemaAnalysis): BsonDocument {
  const level = (paths: string[], containers: number): BsonDocument => {
    const properties: BsonDocument = {};
    const required: string[] = [];
    for (const path of paths) {
      const f = a.fields.get(path);
      if (!f) {
        continue;
      }
      const seen = Object.values(f.types).reduce((x, y) => x + (y ?? 0), 0);
      if (containers > 0 && seen >= containers) {
        required.push(f.name);
      }
      const schema: BsonDocument = { bsonType: bsonTypeOf(f.types) };
      const main = typesByCount(f.types)[0]?.[0];
      if (main === "Object" && f.children.length > 0) {
        Object.assign(schema, level(f.children, f.objects));
      } else if (main === "Array" && Object.keys(f.elemTypes).length > 0) {
        const items: BsonDocument = { bsonType: bsonTypeOf(f.elemTypes) };
        if (f.elemTypes.Object !== undefined && f.children.length > 0) {
          Object.assign(items, level(f.children, f.objects));
        }
        schema.items = items;
      }
      if (f.depth === 0 && main === "String" && Object.keys(f.types).length === 1 && f.string && f.string.distinct <= 6 && a.sampleSize >= 50) {
        schema.enum = f.string.top.map((x) => x.value).sort();
      }
      properties[f.name] = schema;
    }
    const out: BsonDocument = {};
    if (required.length > 0) {
      out.required = required;
    }
    out.properties = properties;
    return out;
  };
  return { bsonType: "object", ...level(a.roots, a.sampleSize) };
}

const JSON_TYPES: Record<string, (v: BsonValue) => boolean> = {
  object: (v) => isDocument(v),
  array: (v) => Array.isArray(v),
  string: (v) => typeof v === "string",
  boolean: (v) => typeof v === "boolean",
  null: (v) => v === null,
  number: (v) => numeric(v) !== null,
};

function aliasOf(v: BsonValue): string {
  return BSON_ALIAS[typeName(v)];
}

function matchesBsonType(want: BsonValue, v: BsonValue): boolean {
  if (Array.isArray(want)) {
    return want.some((w) => matchesBsonType(w, v));
  }
  if (typeof want !== "string") {
    return true;
  }
  if (want === "number") {
    return ["Int32", "Int64", "Double", "Decimal128"].includes(typeName(v));
  }
  return want === aliasOf(v);
}

function matchesJsonType(want: BsonValue, v: BsonValue): boolean {
  if (Array.isArray(want)) {
    return want.some((w) => matchesJsonType(w, v));
  }
  return typeof want !== "string" || (JSON_TYPES[want]?.(v) ?? true);
}

// Why `doc` breaks the `$jsonSchema` of `validator` (bsonType, type,
// required, properties, additionalProperties, enum, minimum/maximum,
// lengths, pattern, items, item counts, allOf/anyOf/oneOf/not). Empty when
// the rule is not a `$jsonSchema` or nothing it checks is broken.
export function jsonSchemaReasons(validator: BsonDocument, doc: BsonDocument): string[] {
  const out: string[] = [];
  if (isDocument(validator.$jsonSchema)) {
    check(validator.$jsonSchema, doc, "", out);
  }
  return out;
}

function check(schema: BsonDocument, v: BsonValue, path: string, out: string[]): void {
  const at = path === "" ? t("(문서)") : path;
  if (schema.bsonType !== undefined && !matchesBsonType(schema.bsonType, v)) {
    out.push(t("{path}: 타입이 {want}여야 합니다 (지금 {got})", { path: at, want: toShell(schema.bsonType), got: aliasOf(v) }));
    return;
  }
  if (schema.type !== undefined && !matchesJsonType(schema.type, v)) {
    out.push(t("{path}: 타입이 {want}여야 합니다 (지금 {got})", { path: at, want: toShell(schema.type), got: aliasOf(v) }));
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((x) => compareForSort(x, v) === 0)) {
    out.push(t("{path}: 허용된 값({values})이 아닙니다", { path: at, values: schema.enum.map(toShell).join(", ") }));
  }
  const n = numeric(v);
  if (n !== null) {
    const min = numeric(schema.minimum ?? null);
    const max = numeric(schema.maximum ?? null);
    if (min !== null && (schema.exclusiveMinimum === true ? n <= min : n < min)) {
      const limit = toShell(schema.minimum ?? null);
      out.push(schema.exclusiveMinimum === true ? t("{path}: {limit}보다 커야 합니다", { path: at, limit }) : t("{path}: {limit} 이상이어야 합니다", { path: at, limit }));
    }
    if (max !== null && (schema.exclusiveMaximum === true ? n >= max : n > max)) {
      const limit = toShell(schema.maximum ?? null);
      out.push(schema.exclusiveMaximum === true ? t("{path}: {limit}보다 작아야 합니다", { path: at, limit }) : t("{path}: {limit} 이하여야 합니다", { path: at, limit }));
    }
  }
  if (typeof v === "string") {
    const length = [...v].length;
    const min = numeric(schema.minLength ?? null);
    const max = numeric(schema.maxLength ?? null);
    if (min !== null && length < min) {
      out.push(t("{path}: 길이가 {limit}자 이상이어야 합니다", { path: at, limit: min }));
    }
    if (max !== null && length > max) {
      out.push(t("{path}: 길이가 {limit}자 이하여야 합니다", { path: at, limit: max }));
    }
    if (typeof schema.pattern === "string") {
      let re: RegExp | null = null;
      try {
        re = new RegExp(schema.pattern, "u");
      } catch {
        re = null;
      }
      if (re !== null && !re.test(v)) {
        out.push(t("{path}: 패턴 {pattern}에 맞지 않습니다", { path: at, pattern: schema.pattern }));
      }
    }
  }
  if (Array.isArray(v)) {
    const min = numeric(schema.minItems ?? null);
    const max = numeric(schema.maxItems ?? null);
    if (min !== null && v.length < min) {
      out.push(t("{path}: 원소가 {limit}개 이상이어야 합니다", { path: at, limit: min }));
    }
    if (max !== null && v.length > max) {
      out.push(t("{path}: 원소가 {limit}개 이하여야 합니다", { path: at, limit: max }));
    }
    if (isDocument(schema.items)) {
      const items = schema.items;
      v.forEach((el, i) => check(items, el, path === "" ? String(i) : `${path}.${i}`, out));
    }
  }
  if (isDocument(v)) {
    const child = (key: string) => (path === "" ? key : `${path}.${key}`);
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && v[key] === undefined) {
          out.push(t("{path}: 필수 필드가 없습니다", { path: child(key) }));
        }
      }
    }
    const props = isDocument(schema.properties) ? schema.properties : {};
    for (const [key, sub] of Object.entries(props)) {
      if (isDocument(sub) && v[key] !== undefined) {
        check(sub, v[key], child(key), out);
      }
    }
    const patterns = isDocument(schema.patternProperties) ? Object.keys(schema.patternProperties) : [];
    const extra = Object.keys(v).filter((key) => props[key] === undefined && !patterns.some((p) => safeTest(p, key)));
    if (schema.additionalProperties === false) {
      for (const key of extra) {
        out.push(t("{path}: 허용되지 않은 필드입니다", { path: child(key) }));
      }
    } else if (isDocument(schema.additionalProperties)) {
      const sub = schema.additionalProperties;
      for (const key of extra) {
        check(sub, v[key], child(key), out);
      }
    }
  }
  const passes = (sub: BsonValue): boolean => {
    if (!isDocument(sub)) {
      return true;
    }
    const inner: string[] = [];
    check(sub, v, path, inner);
    return inner.length === 0;
  };
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) {
      if (isDocument(sub)) {
        check(sub, v, path, out);
      }
    }
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some(passes)) {
    out.push(t("{path}: anyOf 조건 중 맞는 것이 없습니다", { path: at }));
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter(passes).length !== 1) {
    out.push(t("{path}: oneOf 조건 중 정확히 하나에 맞아야 합니다", { path: at }));
  }
  if (isDocument(schema.not) && passes(schema.not)) {
    out.push(t("{path}: not 조건에 맞으면 안 됩니다", { path: at }));
  }
}

function safeTest(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern, "u").test(text);
  } catch {
    return false;
  }
}
