// Reading `explain("executionStats")` output for the explain view
// (MONGODB.md §3.7): the stage tree with each stage's counts, the totals,
// warnings (collection scan, in-memory sort, many more read than returned)
// and an index suggestion in equality → sort → range order.

import { BsonRegex, Int32, isDocument, isNumber, setField, type BsonDocument, type BsonValue } from "./bson";

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
  const input = doc(node.inputStage);
  if (input) {
    out.push({ plan: input, shard: null });
  }
  if (Array.isArray(node.inputStages)) {
    for (const s of node.inputStages) {
      if (isDocument(s)) {
        out.push({ plan: s, shard: null });
      }
    }
  }
  if (Array.isArray(node.shards)) {
    for (const s of node.shards) {
      if (!isDocument(s)) {
        continue;
      }
      const plan = doc(s.executionStages) ?? classicPlan(doc(s.winningPlan));
      if (plan) {
        out.push({ plan, shard: text(s.shardName) });
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
  return doc(plan.queryPlan) ?? plan;
}

function readStage(node: BsonDocument, shard: string | null): PlanStage {
  const boundsDoc = doc(node.indexBounds);
  const bounds = boundsDoc
    ? Object.entries(boundsDoc).map(([field, v]) => ({
        field,
        intervals: Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : String(x))) : [String(v)],
      }))
    : [];
  return {
    stage: text(node.stage) ?? "?",
    nReturned: num(node.nReturned),
    docsExamined: num(node.docsExamined),
    keysExamined: num(node.keysExamined),
    timeMs: num(node.executionTimeMillisEstimate),
    indexName: text(node.indexName),
    keyPattern: doc(node.keyPattern),
    bounds,
    direction: text(node.direction),
    multiKey: node.isMultiKey === true,
    filter: doc(node.filter),
    sortPattern: doc(node.sortPattern),
    limitAmount: num(node.limitAmount),
    skipAmount: num(node.skipAmount),
    transformBy: doc(node.transformBy),
    usedDisk: node.usedDisk === true,
    shard,
    children: childPlans(node).map((c) => readStage(c.plan, c.shard)),
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
  const name = node ? text(node.stage) : null;
  return name !== null && name === name.toUpperCase();
}

export function summarizeExplain(raw: BsonDocument): PlanSummary {
  // An aggregate's explain holds the find part in its first stage's $cursor.
  let source = raw;
  const stages = Array.isArray(raw.stages) ? raw.stages : null;
  if (!doc(raw.queryPlanner) && stages && isDocument(stages[0]) && isDocument(stages[0].$cursor)) {
    source = stages[0].$cursor;
  }
  const planner = doc(source.queryPlanner);
  const stats = doc(source.executionStats);
  const execution = stats ? doc(stats.executionStages) : null;
  const winning = classicPlan(planner ? doc(planner.winningPlan) : null);
  const tree = isClassic(execution) ? execution : winning;
  let root = tree ? readStage(tree, null) : null;
  // The pipeline stages after $cursor sit above the find part.
  if (root && source !== raw && stages) {
    for (const s of stages.slice(1)) {
      if (!isDocument(s)) {
        continue;
      }
      const name = Object.keys(s).find((k) => k.startsWith("$"));
      if (!name) {
        continue;
      }
      root = {
        ...readStage({}, null),
        stage: name,
        nReturned: num(s.nReturned),
        timeMs: num(s.executionTimeMillisEstimate),
        children: [root],
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
  const nReturned = stats ? num(stats.nReturned) : null;
  const docsExamined = stats ? num(stats.totalDocsExamined) : null;
  const keysExamined = stats ? num(stats.totalKeysExamined) : null;
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
  return {
    root,
    nReturned,
    docsExamined,
    keysExamined,
    timeMs: stats ? num(stats.executionTimeMillis) : null,
    indexes,
    indexKeys,
    collscan,
    inMemorySort,
    warnings,
    rejectedPlans: planner && Array.isArray(planner.rejectedPlans) ? planner.rejectedPlans.length : 0,
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
  for (const [key, v] of Object.entries(filter)) {
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
    const ops = isDocument(v) ? Object.keys(v) : [];
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
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && num(a[k]) === num(b[k]));
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
  const keys: BsonDocument = {};
  const add = (field: string, dir: number): void => {
    if (!Object.hasOwn(keys, field)) {
      setField(keys, field, new Int32(dir));
    }
  };
  for (const field of equality) {
    add(field, 1);
  }
  for (const [field, v] of Object.entries(query.sort ?? {})) {
    const n = num(v);
    if (n !== null) {
      add(field, n < 0 ? -1 : 1);
    }
  }
  for (const field of range) {
    add(field, 1);
  }
  const fields = Object.keys(keys);
  if (fields.length === 0 || (fields.length === 1 && fields[0] === "_id")) {
    return null;
  }
  if (summary.indexKeys.some((k) => sameKeys(k, keys))) {
    return null;
  }
  return keys;
}
