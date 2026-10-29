import type { SqlDialect } from "../engines/sqlDialect";
import type { TableDetail } from "../store";

// What a grid knows about a column beyond its name, as TablePlus shows it:
// key columns in their own colour, ⌃⌄ on dates (a picker) and on enum and
// boolean cells (a list), → on foreign keys (open the row it points at).
export type CellKind =
  | "text"
  | "number"
  | "boolean"
  | "enum"
  | "set"
  | "date"
  | "datetime"
  | "time"
  | "json"
  | "binary";

export interface GridColumnSpec {
  kind: CellKind;
  pk?: boolean;
  // A foreign key column.
  link?: boolean;
  // The values an enum, set or boolean cell offers.
  options?: string[];
  nullable?: boolean;
  // The column declares a default (Set Value ▸ DEFAULT means something).
  hasDefault?: boolean;
}

export function isDateKind(kind: CellKind): boolean {
  return kind === "date" || kind === "datetime" || kind === "time";
}

// enum('a','b') / set('x','y') → their labels, quotes undone.
function enumLabels(declType: string): string[] | null {
  const match = /^\s*(?:enum|set)\s*\((.*)\)\s*$/is.exec(declType);
  if (match === null) {
    return null;
  }
  const labels: string[] = [];
  const body = match[1];
  const pattern = /'((?:[^']|'')*)'/g;
  for (let found = pattern.exec(body); found !== null; found = pattern.exec(body)) {
    labels.push(found[1].replace(/''/g, "'"));
  }
  return labels.length > 0 ? labels : null;
}

export function kindOfType(declType: string | null, dialect: SqlDialect): Pick<GridColumnSpec, "kind" | "options"> {
  const type = (declType ?? "").trim().toLowerCase();
  // Arrays (PostgreSQL's "boolean[]", "time[]") are edited as text.
  if (type === "" || type.endsWith("[]")) {
    return { kind: "text" };
  }
  // Labels keep their case; only the type name is matched in lower case.
  const labels = enumLabels(declType ?? "");
  if (labels !== null) {
    return { kind: /^set\b/.test(type) ? "set" : "enum", options: labels };
  }
  if (/^(bool|boolean)\b/.test(type) || /^tinyint\s*\(\s*1\s*\)/.test(type) || (dialect.gridBitIsBoolean && /^bit\b/.test(type))) {
    return { kind: "boolean", options: [...dialect.booleanOptions] };
  }
  if (/^date$/.test(type)) {
    return { kind: "date" };
  }
  // SQL Server's timestamp is rowversion, a binary counter, not a time.
  if (dialect.timestampIsVersion && /^(timestamp|rowversion)\b/.test(type)) {
    return { kind: "text" };
  }
  if (/^(datetime|datetime2|smalldatetime|datetimeoffset|timestamp|timestamptz)\b/.test(type)) {
    return { kind: "datetime" };
  }
  if (/^(time|timetz)\b/.test(type)) {
    return { kind: "time" };
  }
  if (/^jsonb?\b/.test(type)) {
    return { kind: "json" };
  }
  if (
    /^(tinyint|smallint|mediumint|int|integer|bigint|serial|bigserial|smallserial|real|float|double|decimal|numeric|money|smallmoney|number)\b/.test(
      type,
    )
  ) {
    return { kind: "number" };
  }
  // Bytes, which every engine shows as hex; on SQLite any type naming BLOB,
  // as its affinity rule (and the engine) reads it.
  if (
    /^(bytea|bytes|binary|varbinary|image|tinyblob|blob|mediumblob|longblob)\b/.test(type) ||
    (dialect.blobByName && type.includes("blob"))
  ) {
    return { kind: "binary" };
  }
  return { kind: "text" };
}

// Specs for columns the table's structure doesn't cover (a query's result, an
// alias) from what the driver said of them: MySQL's TINYINT(1) is a boolean.
// Its colour only: with no structure to go by, no list of values to pick from.
export function withResultKinds(
  specs: (GridColumnSpec | null)[] | null,
  kinds: (string | null)[] | undefined,
  count: number,
): (GridColumnSpec | null)[] | null {
  if (kinds === undefined || !kinds.includes("boolean")) {
    return specs;
  }
  return Array.from({ length: count }, (_, index) =>
    specs?.[index] ?? (kinds[index] === "boolean" ? { kind: "boolean" } : null),
  );
}

// Which of a result's columns the table's structure declares of `kind`.
export function declaredAs(
  kind: CellKind,
  columns: string[],
  detail: TableDetail | undefined | null,
  dialect: SqlDialect,
): boolean[] {
  const types = new Map((detail?.columns ?? []).map((column) => [column.name, column.decl_type]));
  return columns.map((name) => types.has(name) && kindOfType(types.get(name) ?? null, dialect).kind === kind);
}

// Specs for a result's columns, from what the table's structure says; columns
// the structure doesn't name (an alias, a computed one) get none.
export function specsForTable(
  columns: string[],
  detail: TableDetail | undefined | null,
  dialect: SqlDialect,
): (GridColumnSpec | null)[] | null {
  if (!detail) {
    return null;
  }
  const byName = new Map(detail.columns.map((column) => [column.name, column]));
  const linked = new Set(detail.foreign_keys.flatMap((fk) => fk.columns));
  return columns.map((name) => {
    const column = byName.get(name);
    if (column === undefined) {
      return null;
    }
    const declared = kindOfType(column.decl_type, dialect);
    // PostgreSQL names its enum types; the driver sends their labels.
    const labels = column.enum_values ?? null;
    const enumKind = labels !== null && labels.length > 0 && declared.kind === "text";
    return {
      kind: enumKind ? "enum" : declared.kind,
      options: enumKind ? labels : declared.options,
      pk: column.pk,
      link: linked.has(name),
      // A key column never takes NULL, whatever SQLite's PRAGMA says of an
      // INTEGER PRIMARY KEY.
      nullable: !column.not_null && !column.pk,
      hasDefault: column.default !== null && column.default !== undefined,
    };
  });
}
