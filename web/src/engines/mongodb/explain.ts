// Reading `explain("executionStats")` output for the explain view
// (MONGODB.md §3.7): the stage tree with each stage's counts, the totals,
// warnings (collection scan, in-memory sort, many more read than returned)
// and an index suggestion in equality → sort → range order.

import { BsonRegex, Int32, isDocument, isNumber, type BsonDocument, type BsonValue } from "./bson";

export interface PlanStage {
  stage: string;
  nReturned: number | null;
  docsExamined: number | null;
  keysExamined: number | null;
  // executionTimeMillisEstimate of the stage.
  timeMs: number | null;
  indexName: string | null;
  keyPattern: BsonDocument | null;
  // Index bounds per field, each field's intervals as the server wrote them.
  bounds: { field: string; intervals: string[] }[];
  direction: string | null;
  multiKey: boolean;
  filter: BsonDocument | null;
  sortPattern: BsonDocument | null;
  limitAmount: number | null;
  skipAmount: number | null;
  transformBy: BsonDocument | null;
  // A sort that went to disk.
  usedDisk: boolean;
  // Shard name, for the plan of one shard.
  shard: string | null;
  children: PlanStage[];
  // The stage's own fields as the server wrote them, its inputs left out
  // (what the detail panel shows for a picked stage).
  raw: BsonDocument;
}

export type PlanWarning =
  | { kind: "collscan" }
  | { kind: "sort" }
  | { kind: "ratio"; ratio: number; examined: number; returned: number };

export interface PlanSummary {
  root: PlanStage | null;
  nReturned: number | null;
  docsExamined: number | null;
  keysExamined: number | null;
  timeMs: number | null;
  // Indexes the winning plan reads, in tree order.
  indexes: string[];
  // Key patterns of those indexes.
  indexKeys: BsonDocument[];
  collscan: boolean;
  inMemorySort: boolean;
  warnings: PlanWarning[];
  rejectedPlans: number;
}

// Examined over returned past this (with enough examined to matter) is
// worth a warning.
const RATIO_WARN = 4;
const RATIO_MIN_EXAMINED = 100;

function num(v: BsonValue | undefined): number | null {
  if (!isNumber(v)) {
    return null;
  }
  const n = Number(v.value);
  return Number.isFinite(n) ? n : null;
}

function doc(v: BsonValue | undefined): BsonDocument | null {
  return isDocument(v) ? v : null;
}

function text(v: BsonValue | undefined): string | null {
  return typeof v === "string" ? v : null;
}

// The child plans of a stage: one input, several (OR, SORT_MERGE), or one
// per shard on a sharded cluster.
function childPlans(node: BsonDocument): { plan: BsonDocument; shard: string | null }[] {
  const out: { plan: BsonDocument; shard: string | null }[] = [];
  const input = doc(node.get("inputStage"));
  if (input) {
    out.push({ plan: input, shard: null });
  }
  const inputStages = node.get("inputStages");
  if (Array.isArray(inputStages)) {
    for (const s of inputStages) {
      if (isDocument(s)) {
        out.push({ plan: s, shard: null });
      }
    }
  }
  const shards = node.get("shards");
  if (Array.isArray(shards)) {
    for (const s of shards) {
      if (!isDocument(s)) {
        continue;
      }
      const plan = doc(s.get("executionStages")) ?? classicPlan(doc(s.get("winningPlan")));
      if (plan) {
        out.push({ plan, shard: text(s.get("shardName")) });
      }
    }
  }
  return out;
}

// The classic-style tree of a winning plan; the slot-based engine nests it
// under `queryPlan`.
function classicPlan(plan: BsonDocument | null): BsonDocument | null {
  if (!plan) {
    return null;
  }
  return doc(plan.get("queryPlan")) ?? plan;
}

function readStage(node: BsonDocument, shard: string | null): PlanStage {
  const boundsDoc = doc(node.get("indexBounds"));
  const bounds = boundsDoc
    ? [...boundsDoc].map(([field, v]) => ({
        field,
        intervals: Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : String(x))) : [String(v)],
      }))
    : [];
  return {
    stage: text(node.get("stage")) ?? "?",
    nReturned: num(node.get("nReturned")),
    docsExamined: num(node.get("docsExamined")),
    keysExamined: num(node.get("keysExamined")),
    timeMs: num(node.get("executionTimeMillisEstimate")),
    indexName: text(node.get("indexName")),
    keyPattern: doc(node.get("keyPattern")),
    bounds,
    direction: text(node.get("direction")),
    multiKey: node.get("isMultiKey") === true,
    filter: doc(node.get("filter")),
    sortPattern: doc(node.get("sortPattern")),
    limitAmount: num(node.get("limitAmount")),
    skipAmount: num(node.get("skipAmount")),
    transformBy: doc(node.get("transformBy")),
    usedDisk: node.get("usedDisk") === true,
    shard,
    children: childPlans(node).map((c) => readStage(c.plan, c.shard)),
    raw: new Map([...node].filter(([key]) => key !== "inputStage" && key !== "inputStages" && key !== "shards")),
  };
}

function walk(stage: PlanStage | null, visit: (s: PlanStage) => void): void {
  if (!stage) {
    return;
  }
  visit(stage);
  for (const child of stage.children) {
    walk(child, visit);
  }
}

// A classic stage tree has upper-case stage names; the slot-based engine's
// execution tree does not, and its stages say little, so the winning plan's
// shape is shown instead.
function isClassic(node: BsonDocument | null): node is BsonDocument {
  const name = node ? text(node.get("stage")) : null;
  return name !== null && name === name.toUpperCase();
}

export function summarizeExplain(raw: BsonDocument): PlanSummary {
  // An aggregate's explain holds the find part in its first stage's $cursor.
  let source = raw;
  const pipeline = raw.get("stages");
  const stages = Array.isArray(pipeline) ? pipeline : null;
  const first = stages?.[0];
  const cursor = isDocument(first) ? doc(first.get("$cursor")) : null;
  if (!doc(raw.get("queryPlanner")) && cursor) {
    source = cursor;
  }
  const planner = doc(source.get("queryPlanner"));
  const stats = doc(source.get("executionStats"));
  const execution = stats ? doc(stats.get("executionStages")) : null;
  const winning = classicPlan(planner ? doc(planner.get("winningPlan")) : null);
  const tree = isClassic(execution) ? execution : winning;
  let root = tree ? readStage(tree, null) : null;
  // The pipeline stages after $cursor sit above the find part.
  if (root && source !== raw && stages) {
    for (const s of stages.slice(1)) {
      if (!isDocument(s)) {
        continue;
      }
      const name = [...s.keys()].find((k) => k.startsWith("$"));
      if (!name) {
        continue;
      }
      root = {
        ...readStage(new Map(), null),
        stage: name,
        nReturned: num(s.get("nReturned")),
        timeMs: num(s.get("executionTimeMillisEstimate")),
        children: [root],
        raw: s,
      };
    }
  }
  const indexes: string[] = [];
  const indexKeys: BsonDocument[] = [];
  let collscan = false;
  let inMemorySort = false;
  walk(root, (s) => {
    if (s.stage === "COLLSCAN") {
      collscan = true;
    }
    if (s.stage === "SORT" || s.stage === "$sort") {
      inMemorySort = true;
    }
    if (s.indexName !== null && !indexes.includes(s.indexName)) {
      indexes.push(s.indexName);
      if (s.keyPattern) {
        indexKeys.push(s.keyPattern);
      }
    }
  });
  const nReturned = stats ? num(stats.get("nReturned")) : null;
  const docsExamined = stats ? num(stats.get("totalDocsExamined")) : null;
  const keysExamined = stats ? num(stats.get("totalKeysExamined")) : null;
  const warnings: PlanWarning[] = [];
  if (collscan) {
    warnings.push({ kind: "collscan" });
  }
  if (inMemorySort) {
    warnings.push({ kind: "sort" });
  }
  const examined = Math.max(docsExamined ?? 0, keysExamined ?? 0);
  const returned = nReturned ?? 0;
  const ratio = returned > 0 ? examined / returned : examined;
  if (examined > RATIO_MIN_EXAMINED && ratio > RATIO_WARN) {
    warnings.push({ kind: "ratio", ratio, examined, returned });
  }
  const rejected = planner?.get("rejectedPlans");
  return {
    root,
    nReturned,
    docsExamined,
    keysExamined,
    timeMs: stats ? num(stats.get("executionTimeMillis")) : null,
    indexes,
    indexKeys,
    collscan,
    inMemorySort,
    warnings,
    rejectedPlans: Array.isArray(rejected) ? rejected.length : 0,
  };
}

// Filter operators that test one value (the index can seek straight to it).
const EQUALITY_OPS: Record<string, true> = { $eq: true, $in: true };
// The rest of the per-field operators read a range of the index.
const RANGE_OPS: Record<string, true> = {
  $gt: true,
  $gte: true,
  $lt: true,
  $lte: true,
  $ne: true,
  $nin: true,
  $regex: true,
  $exists: true,
  $type: true,
  $all: true,
  $elemMatch: true,
  $size: true,
  $mod: true,
};

// Equality and range fields of a filter, in the order they appear. $or,
// $nor, $expr and $text conditions are left out: one compound index does
// not serve them.
function filterFields(filter: BsonDocument, equality: string[], range: string[]): void {
  for (const [key, v] of filter) {
    if (key === "$and" && Array.isArray(v)) {
      for (const part of v) {
        if (isDocument(part)) {
          filterFields(part, equality, range);
        }
      }
      continue;
    }
    if (key.startsWith("$")) {
      continue;
    }
    const ops = isDocument(v) ? [...v.keys()] : [];
    const operators = ops.length > 0 && ops.every((k) => k.startsWith("$"));
    if (!operators) {
      // A plain value is equality; a regex literal reads a range.
      (v instanceof BsonRegex ? range : equality).push(key);
      continue;
    }
    const equal = ops.some((k) => Object.hasOwn(EQUALITY_OPS, k));
    if (equal && !ops.some((k) => Object.hasOwn(RANGE_OPS, k))) {
      equality.push(key);
    } else if (equal || ops.some((k) => Object.hasOwn(RANGE_OPS, k))) {
      range.push(key);
    }
  }
}

function sameKeys(a: BsonDocument, b: BsonDocument): boolean {
  const ka = [...a.keys()];
  const kb = [...b.keys()];
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && num(a.get(k)) === num(b.get(k)));
}

// The compound index the query would want, equality fields first, then the
// sort, then range fields (the ESR rule); null when the plan has nothing to
// gain or the query names no field it could use.
export function suggestIndex(
  query: { filter: BsonDocument; sort: BsonDocument | null },
  summary: PlanSummary,
): BsonDocument | null {
  if (summary.warnings.length === 0) {
    return null;
  }
  const equality: string[] = [];
  const range: string[] = [];
  filterFields(query.filter, equality, range);
  const keys: BsonDocument = new Map();
  const add = (field: string, dir: number): void => {
    if (!keys.has(field)) {
      keys.set(field, new Int32(dir));
    }
  };
  for (const field of equality) {
    add(field, 1);
  }
  for (const [field, v] of query.sort ?? []) {
    const n = num(v);
    if (n !== null) {
      add(field, n < 0 ? -1 : 1);
    }
  }
  for (const field of range) {
    add(field, 1);
  }
  const fields = [...keys.keys()];
  if (fields.length === 0 || (fields.length === 1 && fields[0] === "_id")) {
    return null;
  }
  if (summary.indexKeys.some((k) => sameKeys(k, keys))) {
    return null;
  }
  return keys;
}
