// Conflict guards for edits (MONGODB.md §4). The screen keeps each document
// as it was loaded; saving sends the change with the original value of every
// changed path in the filter, so a document changed elsewhere matches
// nothing (matchedCount 0) instead of being overwritten.

import { t } from "../../i18n";
import { BsonRegex, deepEqual, isDocument, setField, type BsonDocument, type BsonValue } from "./bson";

// One change made in a card, the JSON editor or a table cell. Paths are
// dotted; numeric parts index arrays ("items.0.quantity").
export type DocEdit =
  // Change the value at a path (an existing field or array element).
  | { op: "set"; path: string; value: BsonValue }
  // A new field, or a new array element at the end of its array.
  | { op: "add"; path: string; value: BsonValue }
  // Remove a field, or an array element (later elements move up).
  | { op: "unset"; path: string }
  // Give a field a new key in the same parent document.
  | { op: "rename"; path: string; name: string };

export interface GuardedUpdate {
  filter: BsonDocument;
  update: BsonDocument;
}

export interface GuardedReplace {
  filter: BsonDocument;
  replacement: BsonDocument;
}

function clone(v: BsonValue): BsonValue {
  if (Array.isArray(v)) {
    return v.map(clone);
  }
  // Every other BSON value is immutable and can be shared.
  return isDocument(v) ? cloneDoc(v) : v;
}

function cloneDoc(doc: BsonDocument): BsonDocument {
  const out: BsonDocument = {};
  for (const key of Object.keys(doc)) {
    setField(out, key, clone(doc[key]));
  }
  return out;
}

// The value at a dotted path, or undefined when the path is missing.
export function valueAt(root: BsonValue, path: string): BsonValue | undefined {
  let v: BsonValue | undefined = root;
  for (const part of path.split(".")) {
    if (Array.isArray(v) && /^\d+$/.test(part)) {
      v = v[Number(part)];
    } else if (isDocument(v) && Object.hasOwn(v, part)) {
      v = v[part];
    } else {
      return undefined;
    }
  }
  return v;
}

// The container holding the last part of `path`, creating missing parent
// documents when `create` is set.
function parentOf(root: BsonDocument, parts: string[], create: boolean): BsonDocument | BsonValue[] {
  let v: BsonDocument | BsonValue[] = root;
  for (const part of parts.slice(0, -1)) {
    let child: BsonValue | undefined = Array.isArray(v) ? (/^\d+$/.test(part) ? v[Number(part)] : undefined) : Object.hasOwn(v, part) ? v[part] : undefined;
    if (child === undefined && create && isDocument(v)) {
      child = {};
      setField(v, part, child);
    }
    if (!Array.isArray(child) && !isDocument(child)) {
      throw new Error(t("경로를 찾을 수 없습니다: {path}", { path: parts.join(".") }));
    }
    v = child;
  }
  return v;
}

function checkPath(path: string): string[] {
  const parts = path.split(".");
  if (parts[0] === "_id") {
    throw new Error(t("_id는 바꿀 수 없습니다"));
  }
  if (parts.some((p) => p === "")) {
    throw new Error(t("잘못된 경로입니다: {path}", { path }));
  }
  return parts;
}

// Applies the edits in order to a copy of `original` (each path refers to
// the document as the earlier edits left it) and returns the copy with the
// paths each edit writes. Removing an array element rewrites the whole
// array, since every later element moves.
function applyAll(original: BsonDocument, edits: DocEdit[]): { draft: BsonDocument; written: string[] } {
  const draft = cloneDoc(original);
  const written: string[] = [];
  for (const edit of edits) {
    const parts = checkPath(edit.path);
    const key = parts[parts.length - 1];
    const parent = parentOf(draft, parts, edit.op === "add" || edit.op === "set");
    switch (edit.op) {
      case "set":
      case "add":
        if (Array.isArray(parent)) {
          const index = /^\d+$/.test(key) ? Number(key) : -1;
          if (index < 0 || index > parent.length) {
            throw new Error(t("배열 범위를 벗어난 위치입니다: {path}", { path: edit.path }));
          }
          parent[index] = clone(edit.value);
        } else {
          setField(parent, key, clone(edit.value));
        }
        written.push(edit.path);
        break;
      case "unset":
        if (Array.isArray(parent)) {
          parent.splice(Number(key), 1);
          written.push(parts.slice(0, -1).join("."));
        } else {
          delete parent[key];
          written.push(edit.path);
        }
        break;
      case "rename": {
        if (Array.isArray(parent) || !Object.hasOwn(parent, key)) {
          throw new Error(t("이름을 바꿀 수 없는 경로입니다: {path}", { path: edit.path }));
        }
        const target = [...parts.slice(0, -1), edit.name].join(".");
        checkPath(target);
        if (edit.name.includes(".") || edit.name.startsWith("$") || Object.hasOwn(parent, edit.name)) {
          throw new Error(t("쓸 수 없는 필드 이름입니다: {name}", { name: edit.name }));
        }
        // The renamed field moves to the end, as $unset + $set leave it.
        const value = parent[key];
        delete parent[key];
        setField(parent, edit.name, value);
        written.push(edit.path, target);
        break;
      }
    }
  }
  return { draft, written };
}

// The document after the edits, for showing a card's draft.
export function applyEdits(original: BsonDocument, edits: DocEdit[]): BsonDocument {
  return applyAll(original, edits).draft;
}

// Paths without those already covered by an ancestor in the list, first
// occurrence order kept.
function outermost(paths: string[]): string[] {
  const unique = [...new Set(paths)];
  return unique.filter((p) => !unique.some((q) => q !== p && p.startsWith(`${q}.`)));
}

// Where the guard for a written path goes: a path through an array guards
// the whole element it passes through (catches reordered arrays).
function guardPath(original: BsonDocument, path: string): string {
  const parts = path.split(".");
  let v: BsonValue | undefined = original;
  for (let i = 0; i < parts.length; i++) {
    if (Array.isArray(v)) {
      return parts.slice(0, i + 1).join(".");
    }
    v = isDocument(v) && Object.hasOwn(v, parts[i]) ? v[parts[i]] : undefined;
  }
  return path;
}

// The filter condition that matches exactly the original value: missing
// fields by $exists, null by type (plain null also matches missing), and
// regexes or $-keyed documents by $eq so they are not read as operators.
function originalCondition(v: BsonValue | undefined): BsonValue {
  if (v === undefined) {
    return { $exists: false };
  }
  if (v === null) {
    return { $type: "null" };
  }
  if (v instanceof BsonRegex || (isDocument(v) && Object.keys(v).some((k) => k.startsWith("$")))) {
    return { $eq: v };
  }
  return v;
}

// updateOne filter and update for `edits` made to `original`: $set for
// changed and added values (dotted paths), $unset for removed fields, and a
// filter holding `_id` plus the original value of every changed path.
// Null when the edits change nothing.
export function guardUpdate(original: BsonDocument, edits: DocEdit[]): GuardedUpdate | null {
  if (original._id === undefined) {
    throw new Error(t("_id가 없는 문서는 편집할 수 없습니다"));
  }
  const { draft, written } = applyAll(original, edits);
  const $set: BsonDocument = {};
  const $unset: BsonDocument = {};
  const guards: string[] = [];
  for (const path of outermost(written)) {
    const before = valueAt(original, path);
    const after = valueAt(draft, path);
    if (deepEqual(before, after)) {
      continue;
    }
    if (after === undefined) {
      setField($unset, path, "");
    } else {
      setField($set, path, after);
    }
    guards.push(guardPath(original, path));
  }
  if (guards.length === 0) {
    return null;
  }
  const filter: BsonDocument = { _id: original._id };
  for (const path of outermost(guards)) {
    setField(filter, path, originalCondition(valueAt(original, path)));
  }
  const update: BsonDocument = {};
  if (Object.keys($set).length > 0) {
    update.$set = $set;
  }
  if (Object.keys($unset).length > 0) {
    update.$unset = $unset;
  }
  return { filter, update };
}

// replaceOne for the JSON editor: the filter holds `_id` and the original
// value of each top-level field (not the whole document as one value).
export function guardReplace(original: BsonDocument, replacement: BsonDocument): GuardedReplace {
  if (original._id === undefined) {
    throw new Error(t("_id가 없는 문서는 편집할 수 없습니다"));
  }
  if (replacement._id !== undefined && !deepEqual(replacement._id, original._id)) {
    throw new Error(t("_id는 바꿀 수 없습니다"));
  }
  const filter: BsonDocument = { _id: original._id };
  for (const key of Object.keys(original)) {
    if (key !== "_id") {
      setField(filter, key, originalCondition(original[key]));
    }
  }
  return { filter, replacement };
}
