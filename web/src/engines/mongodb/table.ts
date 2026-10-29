// The ⊞ table view (MONGODB.md §3.5): a page of documents as rows and
// columns, and child tables for an object or array field ("drilling in").
// A drilled level has one row per object, or per array element, with the
// parent document's _id and the element's position alongside.

import { Int32, compareForSort, isDocument, typeName, type BsonDocument, type BsonTypeName, type BsonValue } from "./bson";

export interface TableColumn {
  // "field": a key of the row's document. The rest appear only in drilled
  // levels: the root document's _id, the array position, and the value of
  // elements that are not documents.
  kind: "field" | "parentId" | "index" | "value";
  // Unique among the columns of a table.
  id: string;
  // The document key for "field" columns, otherwise null.
  field: string | null;
  label: string;
  // Types of the present values, most frequent first.
  types: BsonTypeName[];
  // Share of rows where the column has a value (0–1).
  presence: number;
  // Mostly objects or arrays: the header shows › and cells open a child table.
  drill: boolean;
}

export interface TableRow {
  // Index of the root document in the page.
  doc: number;
  // Dotted path of `value` inside the root document ("" at the top level).
  base: string;
  // Position in the array the row came from, or null.
  index: number | null;
  // The row's document, or the array element.
  value: BsonValue;
  // The root document's _id.
  parentId: BsonValue | undefined;
}

export interface DocTable {
  // The page the table was built from.
  docs: BsonDocument[];
  // Field names drilled through; the breadcrumb is the collection name
  // followed by these (`orders › items`).
  path: string[];
  columns: TableColumn[];
  rows: TableRow[];
}

// Top-level keys ordered by how many documents have them, then by first
// appearance; `_id` always first.
function fieldOrder(docs: BsonDocument[]): { key: string; count: number }[] {
  const seen = new Map<string, { key: string; count: number; first: number }>();
  for (const doc of docs) {
    for (const key of Object.keys(doc)) {
      const entry = seen.get(key);
      if (entry) {
        entry.count++;
      } else {
        seen.set(key, { key, count: 1, first: seen.size });
      }
    }
  }
  return [...seen.values()].sort((a, b) => (a.key === "_id" ? -1 : b.key === "_id" ? 1 : b.count - a.count || a.first - b.first));
}

function joinPath(base: string, key: string): string {
  return base === "" ? key : `${base}.${key}`;
}

// The cell of `row` under `column`; undefined means the field is missing
// (shown as a dimmed —), which is distinct from a null value.
export function cellValue(row: TableRow, column: TableColumn): BsonValue | undefined {
  switch (column.kind) {
    case "field":
      return isDocument(row.value) && column.field !== null && Object.hasOwn(row.value, column.field) ? row.value[column.field] : undefined;
    case "parentId":
      return row.parentId;
    case "index":
      return row.index === null ? undefined : new Int32(row.index);
    case "value":
      return isDocument(row.value) ? undefined : row.value;
  }
}

// The dotted path a cell edit writes with $set (`items.0.quantity`), or
// null for cells that cannot be edited (parent _id, position, top-level _id).
export function cellPath(row: TableRow, column: TableColumn): string | null {
  if (column.kind === "value") {
    return row.base;
  }
  if (column.kind !== "field" || column.field === null || (row.base === "" && column.field === "_id")) {
    return null;
  }
  return joinPath(row.base, column.field);
}

function makeColumn(kind: TableColumn["kind"], id: string, field: string | null, label: string, rows: TableRow[]): TableColumn {
  const column: TableColumn = { kind, id, field, label, types: [], presence: 0, drill: false };
  const counts = new Map<BsonTypeName, number>();
  let present = 0;
  for (const row of rows) {
    const v = cellValue(row, column);
    if (v !== undefined) {
      present++;
      const type = typeName(v);
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
  }
  column.types = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([type]) => type);
  column.presence = rows.length === 0 ? 0 : present / rows.length;
  column.drill = kind === "field" && (column.types[0] === "Object" || column.types[0] === "Array");
  return column;
}

// The table for a page of documents, drilled through `path` (field names;
// each step opens objects in place and arrays one row per element).
export function buildTable(docs: BsonDocument[], path: string[] = []): DocTable {
  let rows: TableRow[] = docs.map((doc, i) => ({ doc: i, base: "", index: null, value: doc, parentId: doc._id }));
  for (const key of path) {
    rows = rows.flatMap((row): TableRow[] => {
      const v = isDocument(row.value) && Object.hasOwn(row.value, key) ? row.value[key] : undefined;
      const base = joinPath(row.base, key);
      if (isDocument(v)) {
        return [{ ...row, base, value: v }];
      }
      if (Array.isArray(v)) {
        return v.map((element, index) => ({ ...row, base: joinPath(base, String(index)), index, value: element }));
      }
      return [];
    });
  }
  const docValues = rows.flatMap((row) => (isDocument(row.value) ? [row.value] : []));
  const fields = fieldOrder(docValues).map(({ key }) => makeColumn("field", `field:${key}`, key, key, rows));
  if (path.length === 0) {
    return { docs, path, columns: fields, rows };
  }
  const columns = [makeColumn("parentId", "parentId", null, "_id", rows)];
  if (rows.some((row) => row.index !== null)) {
    columns.push(makeColumn("index", "index", null, "#", rows));
  }
  columns.push(...fields);
  if (rows.some((row) => !isDocument(row.value))) {
    columns.push(makeColumn("value", "value", null, "값", rows));
  }
  return { docs, path, columns, rows };
}

// The child table for an object or array column.
export function drill(table: DocTable, column: TableColumn): DocTable {
  if (column.field === null) {
    return table;
  }
  return buildTable(table.docs, [...table.path, column.field]);
}

// Rows ordered by one column in BSON order (missing sorts with null),
// keeping the order of equal rows.
export function sortRows(table: DocTable, column: TableColumn, direction: 1 | -1): DocTable {
  const keyed = table.rows.map((row) => ({ row, v: cellValue(row, column) }));
  keyed.sort((a, b) => compareForSort(a.v, b.v) * direction);
  return { ...table, rows: keyed.map((k) => k.row) };
}
