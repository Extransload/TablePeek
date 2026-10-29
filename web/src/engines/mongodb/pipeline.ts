// The aggregation builder's pipeline (MONGODB.md §6.2 집계) as plain data:
// stages as typed (operator, body text, on/off), their starting templates,
// the round trip with the whole pipeline as one text, the mongosh code, and
// the pipelines saved per collection in localStorage.

import { t } from "../../i18n";
import { isDocument, setField, type BsonDocument } from "./bson";
import { STAGES, type FieldStat } from "./complete";
import { shellCollection, shellKey, toShell, toShellPretty } from "./format";
import { parseValue, type ShellError } from "./shell/parse";

export interface Stage {
  id: number;
  op: string;
  // The stage's argument as typed (`{ status: "paid" }` for $match).
  text: string;
  on: boolean;
}

let stageSeq = 0;

export function newStage(op: string, text: string, on = true): Stage {
  stageSeq += 1;
  return { id: stageSeq, op, text, on };
}

// Stages that write the result into a collection. They come last, and the
// server runs a pipeline holding one only when the request is `confirmed`.
export const WRITE_STAGES = ["$out", "$merge"];

export function stageOp(stage: BsonDocument): string {
  return Object.keys(stage)[0] ?? "";
}

// The argument of a stage's reference example: `{ $match: { status: "paid" } }`
// gives `{ status: "paid" }`.
function exampleArgument(op: string): string | null {
  const example = STAGES[op]?.[1];
  if (example === undefined) {
    return null;
  }
  const parsed = parseValue(example);
  return parsed.ok && isDocument(parsed.value) && parsed.value[op] !== undefined ? toShellPretty(parsed.value[op]) : null;
}

const mainType = (field: FieldStat) => field.types.find((x) => x.type !== "Null")?.type ?? "Null";

// A starting body for `op` built from the fields the stage receives (the
// previous stage's preview, else a sample of the collection), so the
// template already names real fields.
export function stageTemplate(op: string, fields: FieldStat[], coll: string): string {
  const roots = fields.filter((f) => f.depth === 0 && f.path !== "_id");
  const ofType = (...types: string[]) => roots.find((f) => types.includes(mainType(f)));
  const label = roots.find((f) => mainType(f) === "String" && f.values.length > 0) ?? roots[0];
  const amount = ofType("Decimal128") ?? ofType("Double") ?? roots.find((f) => (mainType(f) === "Int32" || mainType(f) === "Int64") && !/(No|Id|At)$/.test(f.path));
  const list = ofType("Array");
  const sub = ofType("Object");
  const first = roots[0]?.path ?? "field";
  const ref = (path: string) => JSON.stringify(`$${path}`);
  switch (op) {
    case "$match":
      return label !== undefined && label.values.length > 0 ? `{ ${shellKey(label.path)}: ${toShell(label.values[0])} }` : "{ }";
    case "$project":
      return roots.length > 0 ? `{ ${roots.slice(0, 3).map((f) => `${shellKey(f.path)}: 1`).join(", ")} }` : "{ }";
    case "$addFields":
    case "$set":
      return list !== undefined ? `{ ${shellKey(`${list.path}Count`)}: { $size: ${ref(list.path)} } }` : `{ newField: ${ref(first)} }`;
    case "$unset":
      return JSON.stringify(first);
    case "$group":
      return `{\n  _id: ${ref(label?.path ?? first)},\n  count: { $sum: 1 }${amount !== undefined ? `,\n  total: { $sum: ${ref(amount.path)} }` : ""}\n}`;
    case "$sort":
      return `{ ${shellKey(amount?.path ?? first)}: -1 }`;
    case "$skip":
    case "$limit":
      return "10";
    case "$unwind":
      return ref(list?.path ?? first);
    case "$count":
      return '"count"';
    case "$sortByCount":
      return ref(label?.path ?? first);
    case "$replaceRoot":
      return `{ newRoot: ${ref(sub?.path ?? first)} }`;
    case "$sample":
      return "{ size: 10 }";
    case "$out":
      return JSON.stringify(`${coll}_out`);
    case "$merge":
      return `{ into: ${JSON.stringify(`${coll}_merged`)}, whenMatched: "replace", whenNotMatched: "insert" }`;
  }
  return exampleArgument(op) ?? "{ }";
}

export type StageCheck = { ok: true; stage: BsonDocument } | { ok: false; error: ShellError };

// One card as the stage document it sends, or why its text does not parse.
export function parseStage(stage: Stage): StageCheck {
  if (stage.text.trim() === "") {
    return { ok: false, error: { message: t("단계 내용이 비었습니다"), from: 0, to: 0 } };
  }
  const parsed = parseValue(stage.text);
  if (!parsed.ok) {
    return parsed;
  }
  const doc: BsonDocument = {};
  setField(doc, stage.op, parsed.value);
  return { ok: true, stage: doc };
}

// The stages that are on, as the pipeline to send, or the first that does
// not parse.
export function buildPipeline(stages: Stage[]): { ok: true; pipeline: BsonDocument[] } | { ok: false; index: number; message: string } {
  const pipeline: BsonDocument[] = [];
  for (const [index, stage] of stages.entries()) {
    if (!stage.on) {
      continue;
    }
    const checked = parseStage(stage);
    if (!checked.ok) {
      return { ok: false, index, message: t("{n}단계 {op}: {message}", { n: index + 1, op: stage.op, message: checked.error.message }) };
    }
    pipeline.push(checked.stage);
  }
  return { ok: true, pipeline };
}

// Every card, off ones included, as one pipeline array for the text mode.
// A card whose text does not parse goes in as typed so nothing is lost.
export function pipelineText(stages: Stage[]): string {
  if (stages.length === 0) {
    return "[\n]";
  }
  const checked = stages.map(parseStage);
  if (checked.every((c) => c.ok)) {
    return toShellPretty(checked.map((c) => (c.ok ? c.stage : {})));
  }
  return `[\n${stages.map((s) => `  { ${s.op}: ${s.text.trim().replace(/\n/g, "\n  ")}\n  }`).join(",\n")}\n]`;
}

// The text mode's array back as cards. An array has no "off", so a stage
// that comes back exactly as an off card of `previous` stays off.
export function stagesFromText(text: string, previous: Stage[]): { ok: true; stages: Stage[] } | { ok: false; error: ShellError } {
  const parsed = parseValue(text);
  if (!parsed.ok) {
    return parsed;
  }
  const whole = { from: 0, to: text.length };
  if (!Array.isArray(parsed.value)) {
    return { ok: false, error: { message: t("파이프라인은 [ … ] 배열이어야 합니다"), ...whole } };
  }
  const off = new Set<string>();
  for (const stage of previous) {
    const checked = stage.on ? null : parseStage(stage);
    if (checked?.ok) {
      off.add(toShell(checked.stage));
    }
  }
  const stages: Stage[] = [];
  for (const [i, value] of parsed.value.entries()) {
    const keys = isDocument(value) ? Object.keys(value) : [];
    if (!isDocument(value) || keys.length !== 1 || !keys[0].startsWith("$")) {
      return { ok: false, error: { message: t("{n}번째 단계는 { $단계: … } 하나여야 합니다", { n: i + 1 }), ...whole } };
    }
    stages.push(newStage(keys[0], toShellPretty(value[keys[0]]), !off.has(toShell(value))));
  }
  return { ok: true, stages };
}

// The collection a $out or $merge stage writes to, as written in it
// (`db.coll` for another database); null for a reading stage.
export function writeTarget(stage: BsonDocument): string | null {
  const op = stageOp(stage);
  if (!WRITE_STAGES.includes(op)) {
    return null;
  }
  const arg = stage[op];
  const into = op === "$merge" && isDocument(arg) ? arg.into : arg;
  if (typeof into === "string") {
    return into;
  }
  if (isDocument(into) && typeof into.coll === "string") {
    return typeof into.db === "string" ? `${into.db}.${into.coll}` : into.coll;
  }
  return toShell(arg);
}

export function aggregateCode(coll: string, pipeline: BsonDocument[]): string {
  return `${shellCollection(coll)}.aggregate(${toShellPretty(pipeline)})`;
}

// The leading $match and a $sort right after it: the part the server can
// serve from an index, for the plan's index suggestion.
export function leadingQuery(pipeline: BsonDocument[]): { filter: BsonDocument; sort: BsonDocument | null } {
  const match = pipeline[0]?.$match;
  const filter = isDocument(match) ? match : {};
  const sort = pipeline[isDocument(match) ? 1 : 0]?.$sort;
  return { filter, sort: isDocument(sort) ? sort : null };
}

// ---- Saved pipelines ----

const STORE_KEY = "tablepeek.mongo.pipelines";

// A stage as stored (saved pipelines, a tab's draft): no id.
export interface StoredStage {
  op: string;
  text: string;
  on: boolean;
}

// The pipeline a collection tab's 집계 is editing, kept with the tab so it
// comes back after a page reload.
export interface AggDraft {
  stages: StoredStage[];
  mode: "stages" | "text";
  // The text mode's array as typed.
  text: string;
}

export interface SavedPipeline {
  name: string;
  stages: StoredStage[];
  at: number;
}

function readSaved(): Record<string, SavedPipeline[]> {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(STORE_KEY) ?? "{}");
    return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, SavedPipeline[]>) : {};
  } catch {
    return {};
  }
}

// The pipelines saved for `ns` (`db.coll`), newest first.
export function savedPipelines(ns: string): SavedPipeline[] {
  const list = readSaved()[ns];
  return Array.isArray(list) ? list.filter((p) => p !== null && typeof p === "object" && typeof p.name === "string" && Array.isArray(p.stages)) : [];
}

export function writeSavedPipelines(ns: string, list: SavedPipeline[]): void {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify({ ...readSaved(), [ns]: list }));
  } catch {
    // Not remembered; the pipeline is still on screen.
  }
}
