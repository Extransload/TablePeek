// The right-click menus and Quick Look of the document views (MONGODB.md
// §3.3–3.5), shared by the ⊞ table, the ☰ cards, the {} JSON blocks and the
// detail panel: copying a value, its path or its document, the query bar's
// filter, sort and hidden fields taken from a value, and a value in the
// app's Quick Look popover (the SQL grid's middle-click and ⌘↩). A
// workbench says through DocActionsContext what its query bar can take;
// views outside one (aggregation results, mongosh, change events) offer
// copying and Quick Look only.

import { createContext, useContext, useEffect, useMemo, useRef } from "react";
import { writeClipboard } from "../../../clipboard";
import { CellInspector, type CellAnchor } from "../../../components/CellInspector";
import type { ContextMenuItem } from "../../../components/ContextMenu";
import type { RowSource } from "../../../grid/rowSource";
import { confirmDialog } from "../../../components/ConfirmDialog";
import { t } from "../../../i18n";
import { Double, Int32, Int64, bsonDoc, isDocument, isNumber, jsonObject, stringifyJson, toEJSON, typeName, type BsonDocument, type BsonTypeName, type BsonValue } from "../bson";
import { ejsonText, toShell, toShellPretty } from "../format";
import { convertType, editText, keepsValue } from "./valueEdit";

// How a filter item uses the value: equal to it, not equal, or only whether
// the field is there at all.
export type FilterHow = "eq" | "ne" | "exists" | "missing";

export interface DocActions {
  // Plain JSON documents (the search engines): values copy as JSON only.
  json: boolean;
  // Adds a condition on `path` (array positions left out) to the query and
  // runs it.
  filter?(path: string, value: BsonValue, how: FilterHow): void;
  // Sorts the query by `path` alone; null takes `path` out of the sort.
  sort?(path: string, dir: 1 | -1 | null): void;
  // The query's direction for `path`, for the menu's check marks.
  sortOf?(path: string): 1 | -1 | null;
  // Leaves `path` out of the documents the query returns.
  hide?(path: string): void;
}

const NO_ACTIONS: DocActions = { json: false };

export const DocActionsContext = createContext<DocActions>(NO_ACTIONS);

export function useDocActions(): DocActions {
  return useContext(DocActionsContext);
}

// Calls `onChange` after a render whose `items` differ from the last one's,
// item by item (`!==`), however the array holding them was rebuilt: the
// documents shown, so a menu or Quick Look opened on one closes when a
// reload, another page or a new order puts others in its place.
export function useOnItemsChange(items: readonly unknown[], onChange: () => void): void {
  const last = useRef(items);
  useEffect(() => {
    const prev = last.current;
    last.current = items;
    if (prev.length !== items.length || prev.some((item, i) => item !== items[i])) {
      onChange();
    }
  });
}

// A sort a menu can show and change: the query's, or a drilled table's own.
export interface SortControl {
  dir: 1 | -1 | null;
  set(dir: 1 | -1 | null): void;
}

export function querySort(actions: DocActions, path: string): SortControl | null {
  const sort = actions.sort;
  return sort === undefined || path === "" ? null : { dir: actions.sortOf?.(path) ?? null, set: (dir) => sort(path, dir) };
}

// A field's path for queries: the dotted path inside `root` with the array
// positions left out (`items.0.sku` → `items.sku`), which matches any element.
export function queryPath(root: BsonValue, path: string): string {
  if (path === "") {
    return "";
  }
  const out: string[] = [];
  let v: BsonValue | undefined = root;
  for (const part of path.split(".")) {
    if (Array.isArray(v) && /^\d+$/.test(part)) {
      v = v[Number(part)];
      continue;
    }
    out.push(part);
    v = isDocument(v) ? v.get(part) : undefined;
  }
  return out.join(".");
}

function copy(text: string): void {
  void writeClipboard(text);
}

// What a value copies as by default: the text its box shows (a string
// without quotes, a date as ISO, an id's hex), documents and arrays in
// mongosh notation.
export function plainText(v: BsonValue): string {
  return Array.isArray(v) || isDocument(v) ? toShellPretty(v) : v === null ? "null" : editText(v);
}

function formatItems(v: BsonValue, json: boolean): ContextMenuItem[] {
  if (json) {
    return [{ label: "JSON", onSelect: () => copy(ejsonText(v, { relaxed: true, exactNumbers: true })) }];
  }
  return [
    { label: t("mongosh 표기"), onSelect: () => copy(toShellPretty(v)) },
    { label: "Extended JSON", onSelect: () => copy(stringifyJson(toEJSON(v), 2)) },
    { label: "JSON (relaxed)", onSelect: () => copy(ejsonText(v, { relaxed: true })) },
  ];
}

// 값 복사 and its formats.
export function copyValueItems(v: BsonValue, json: boolean): ContextMenuItem[] {
  return [
    { label: t("값 복사"), onSelect: () => copy(plainText(v)) },
    { label: t("값 복사 형식"), submenu: formatItems(v, json) },
  ];
}

export function copyPathItem(path: string): ContextMenuItem {
  return { label: t("필드 경로 복사"), onSelect: () => copy(path) };
}

// The document (or several, as an array) in the view's formats.
export function copyDocsItem(docs: BsonDocument[], json: boolean): ContextMenuItem {
  const value: BsonValue = docs.length === 1 ? docs[0] : docs;
  return {
    label: docs.length === 1 ? t("문서 복사") : t("문서 {count}개 복사", { count: docs.length.toLocaleString() }),
    submenu: formatItems(value, json),
  };
}

// The filter items for `path`: by the value, then by presence. `value` is
// undefined where there is none to filter by (a missing field, a header);
// a search index matches no whole object or array, so those filter by
// presence only there.
export function filterItems(actions: DocActions, path: string, value: BsonValue | undefined): ContextMenuItem[] {
  const filter = actions.filter;
  if (filter === undefined || path === "") {
    return [];
  }
  const items: ContextMenuItem[] = [];
  if (value !== undefined && !(actions.json && (Array.isArray(value) || isDocument(value)))) {
    items.push(
      { label: t("이 값으로 필터"), onSelect: () => filter(path, value, "eq") },
      { label: t("이 값 제외"), onSelect: () => filter(path, value, "ne") },
    );
  }
  items.push(
    { label: t("필드가 있는 문서만"), onSelect: () => filter(path, null, "exists") },
    { label: t("필드가 없는 문서만"), onSelect: () => filter(path, null, "missing") },
  );
  items[0].separatorBefore = true;
  return items;
}

// A menu as built from its groups, without a line above its first item.
export function trimSeparators(items: ContextMenuItem[]): ContextMenuItem[] {
  return items.length > 0 && items[0].separatorBefore === true ? [{ ...items[0], separatorBefore: false }, ...items.slice(1)] : items;
}

export interface DocMenuTarget {
  doc: BsonDocument;
  json: boolean;
  quickLook(): void;
  // Offered where given (an editable document).
  onEdit?(): void;
  onClone?(): void;
  onDelete?(): void;
}

// A whole document's menu (a card's head, a JSON block): copy it or its
// _id, look at it, narrow the query to it, edit, clone or delete it.
export function docMenuItems(actions: DocActions, target: DocMenuTarget): ContextMenuItem[] {
  const { doc, json } = target;
  const id = doc.get("_id");
  const filter = actions.filter;
  const items: ContextMenuItem[] = [copyDocsItem([doc], json)];
  if (id !== undefined) {
    items.push({ label: t("_id 복사"), onSelect: () => copy(json ? plainText(id) : toShell(id)) });
  }
  items.push({ label: "Quick Look", separatorBefore: true, onSelect: target.quickLook });
  if (id !== undefined && filter !== undefined) {
    items.push({ label: t("이 문서로 필터"), separatorBefore: true, onSelect: () => filter("_id", id, "eq") });
  }
  return [...items, ...docEditItems(target)];
}

// Edit as JSON, clone, delete: the ones given, after a line.
export function docEditItems({ onEdit, onClone, onDelete }: Pick<DocMenuTarget, "onEdit" | "onClone" | "onDelete">): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  if (onEdit !== undefined) {
    items.push({ label: t("JSON으로 편집"), onSelect: onEdit });
  }
  if (onClone !== undefined) {
    items.push({ label: t("문서 복제"), onSelect: onClone });
  }
  if (onDelete !== undefined) {
    items.push({ label: t("문서 삭제"), danger: true, onSelect: onDelete });
  }
  if (items.length > 0) {
    items[0].separatorBefore = true;
  }
  return items;
}

export function sortItems(control: SortControl | null): ContextMenuItem[] {
  if (control === null) {
    return [];
  }
  const items: ContextMenuItem[] = [
    { label: t("오름차순 정렬"), separatorBefore: true, checked: control.dir === 1, onSelect: () => control.set(1) },
    { label: t("내림차순 정렬"), checked: control.dir === -1, onSelect: () => control.set(-1) },
  ];
  if (control.dir !== null) {
    items.push({ label: t("정렬 해제"), onSelect: () => control.set(null) });
  }
  return items;
}

export function hideItem(actions: DocActions, path: string): ContextMenuItem[] {
  const hide = actions.hide;
  return hide === undefined || path === "" ? [] : [{ label: t("이 필드 숨기기"), onSelect: () => hide(path) }];
}

// The condition a MongoDB filter takes for a filter item.
export function mongoCondition(value: BsonValue, how: FilterHow): BsonValue {
  switch (how) {
    case "eq":
      return value;
    case "ne":
      return bsonDoc({ $ne: value });
    case "exists":
      return bsonDoc({ $exists: true });
    case "missing":
      return bsonDoc({ $exists: false });
  }
}

// The projection with `path` left out, or null when it can't be: a
// projection that lists the fields to return (true, a non-zero number, an
// expression) can only drop `path` from its list, not exclude one inside a
// field it returns. Dropping the last listed field returns every field but
// `path`.
export function withHiddenField(projection: BsonDocument | null, path: string): BsonDocument | null {
  const lists = (doc: BsonDocument) => [...doc].some(([key, v]) => key !== "_id" && (v === true || (isNumber(v) && Number(v.value) !== 0) || typeof v === "string" || isDocument(v)));
  const next: BsonDocument = new Map(projection ?? []);
  if (path !== "_id" && lists(next)) {
    const before = next.size;
    for (const key of [...next.keys()]) {
      if (key === path || key.startsWith(`${path}.`)) {
        next.delete(key);
      }
    }
    if (next.size === before) {
      return null;
    }
    if (lists(next)) {
      return next;
    }
    // `_id` comes back by default; only its exclusion says anything now.
    const id = next.get("_id");
    if (!(id === false || (isNumber(id) && Number(id.value) === 0))) {
      next.delete("_id");
    }
  }
  next.set(path, new Int32(0));
  return next;
}

// `v` at `path` as `type`, for a type menu: at once when the conversion
// keeps the whole value, else after the app's confirm dialog shows the value
// now and after. Resolves to undefined when declined.
export async function confirmTypeChange(path: string, v: BsonValue, type: BsonTypeName): Promise<BsonValue | undefined> {
  const next = convertType(v, type);
  if (keepsValue(v, next)) {
    return next;
  }
  const shown = (x: BsonValue) => {
    const text = toShell(x);
    return text.length > 200 ? `${text.slice(0, 199)}…` : text;
  };
  const ok = await confirmDialog({
    title: t("타입 바꾸기"),
    message: t("{path}를 {type} 타입으로 바꾸면 지금 값의 일부나 전부가 사라집니다.\n\n지금 ({from}): {before}\n바꾼 뒤 ({type}): {after}", {
      path,
      type,
      from: typeName(v),
      before: shown(v),
      after: shown(next),
    }),
    confirmLabel: t("타입 바꾸기"),
    danger: true,
  });
  return ok ? next : undefined;
}

// A BSON value as the Quick Look tree reads it: documents and arrays as
// JSON objects and arrays, numbers as numbers where exact, everything else
// in mongosh notation (ObjectId('…'), ISODate('…')).
export function lookValue(v: BsonValue): unknown {
  if (Array.isArray(v)) {
    return v.map(lookValue);
  }
  if (isDocument(v)) {
    return jsonObject([...v].map(([key, x]): [string, unknown] => [key, lookValue(x)]));
  }
  if (v === null || typeof v === "string" || typeof v === "boolean") {
    return v;
  }
  if ((v instanceof Int32 || v instanceof Double) && Number.isFinite(v.value)) {
    return v.value;
  }
  if (v instanceof Int64 && v.value >= BigInt(Number.MIN_SAFE_INTEGER) && v.value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(v.value);
  }
  return toShell(v);
}

export interface QuickLookTarget {
  // The field's path, the popover's title.
  name: string;
  value: BsonValue;
  // The row or document position the footer names.
  position: number;
  anchor: CellAnchor | null;
}

// The SQL grid's Quick Look popover over one value: a tree beside the
// picked node's fields, Raw, and copy.
export function ValueQuickLook({ target, where, onClose }: { target: QuickLookTarget; where: string | null; onClose(): void }) {
  const source = useMemo((): RowSource => {
    const shown = lookValue(target.value);
    return { columns: [target.name], rowCount: target.position + 1, cell: (row) => (row === target.position ? shown : null) };
  }, [target]);
  return <CellInspector source={source} columns={source.columns} row={target.position} col={0} table={where} anchor={target.anchor} onClose={onClose} />;
}

// The box of an element as the popover's anchor.
export function anchorOf(element: Element | null): CellAnchor | null {
  if (element === null) {
    return null;
  }
  const r = element.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}
