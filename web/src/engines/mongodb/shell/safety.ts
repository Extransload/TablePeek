// Which mongosh requests safe mode stops before (MONGODB.md §3.9), shared by
// the mongosh tab's single statements, which ask in a dialog, and its
// scripts, which cannot ask mid-run and refuse instead (§8.2).

import type { ReviewItem, SafeMode } from "../../../sqlTools";
import type { BsonDocument, BsonValue } from "../bson";
import type { ShellRequest } from "./parse";

// What the safe-mode dialog says about a request, or null when it runs
// without asking.
export function review(req: ShellRequest, source: string, mode: SafeMode): ReviewItem | null {
  if (mode === 0) {
    return null;
  }
  const empty = (filter: BsonDocument) => filter.size === 0;
  switch (req.kind) {
    case "updateMany":
      if (empty(req.filter)) {
        return { sql: source, keyword: "updateMany", severity: "danger", reason: "조건 없이 모든 문서를 바꿉니다" };
      }
      break;
    case "deleteMany":
      if (empty(req.filter)) {
        return { sql: source, keyword: "deleteMany", severity: "danger", reason: "조건 없이 모든 문서를 지웁니다" };
      }
      break;
    case "updateOne":
      if (empty(req.filter)) {
        return { sql: source, keyword: "updateOne", severity: "danger", reason: "조건 없이 처음 찾은 문서를 바꿉니다" };
      }
      break;
    case "replaceOne":
      if (empty(req.filter)) {
        return { sql: source, keyword: "replaceOne", severity: "danger", reason: "조건 없이 처음 찾은 문서를 통째로 바꿉니다" };
      }
      break;
    case "deleteOne":
      if (empty(req.filter)) {
        return { sql: source, keyword: "deleteOne", severity: "danger", reason: "조건 없이 처음 찾은 문서를 지웁니다" };
      }
      break;
    case "drop":
      return { sql: source, keyword: "drop", severity: "danger", reason: "컬렉션과 그 인덱스를 모두 지웁니다" };
    case "dropIndex":
      return { sql: source, keyword: "dropIndex", severity: "danger", reason: "인덱스를 지웁니다" };
  }
  if (mode === 2 && ["insertOne", "insertMany", "updateOne", "updateMany", "replaceOne", "deleteOne", "deleteMany", "createIndex"].includes(req.kind)) {
    return { sql: source, keyword: req.kind, severity: "write", reason: "데이터를 바꿉니다" };
  }
  return null;
}

// Whether an aggregation writes (`$out`, `$merge`): the server runs it only
// once confirmed.
export function pipelineWrites(pipeline: BsonValue[]): boolean {
  return pipeline.some((stage) => stage instanceof Map && (stage.has("$out") || stage.has("$merge")));
}

// Commands the server runs only once confirmed (driver.rs
// `confirmation_needed`): they drop, rename, change or stop something;
// `profile` unless it only reads the level (-1).
export function commandNeedsConfirm(cmd: BsonDocument): boolean {
  const name = cmd.keys().next().value;
  if (name === "profile") {
    const level = cmd.get("profile");
    const n = level !== null && typeof level === "object" && "value" in level ? Number(level.value) : NaN;
    return n !== -1;
  }
  return name === "drop" || name === "dropDatabase" || name === "renameCollection" || name === "collMod" || name === "killOp";
}
