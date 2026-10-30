import type { SqlDialect } from "./engines/sqlDialect";
import { t } from "./i18n";
import type { TableDetail, TableDetailForeignKey } from "./store";

export interface ColumnDraft {
  key: string;
  orig: string | null;
  name: string;
  type: string;
  notNull: boolean;
  pk: boolean;
  def: string;
}

export interface IndexDraft {
  key: string;
  orig: string | null;
  name: string;
  unique: boolean;
  columns: string;
}

export interface FkDraft {
  key: string;
  orig: string | null;
  name: string;
  columns: string;
  refTable: string;
  refColumns: string;
}

export interface StructureDraft {
  columns: ColumnDraft[];
  indexes: IndexDraft[];
  foreignKeys: FkDraft[];
  // The primary key constraint's own name, when the table has one.
  primaryName?: string;
}

export interface DiffResult {
  statements: string[];
  errors: string[];
}

let draftSeq = 0;

export function sig(value: unknown): string {
  return JSON.stringify(value, (key, item) =>
    key === "key" ? undefined : item,
  );
}

export function draftKey(): string {
  draftSeq += 1;
  return `d-${draftSeq}`;
}

export function quoteIdent(dialect: SqlDialect, name: string): string {
  return name
    .split(".")
    .map((part) => dialect.quotePart(part.trim()))
    .join(".");
}

// A column's name, never schema-qualified: a dot in it is part of the name.
export function quoteName(dialect: SqlDialect, name: string): string {
  return dialect.quotePart(name.trim());
}

export function splitList(text: string): string[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

// DEFAULT comes before NOT NULL: standard SQL's order, and the only one
// Oracle takes.
export function columnDef(dialect: SqlDialect, column: ColumnDraft): string {
  if (dialect.columnDef !== undefined) {
    return dialect.columnDef(column);
  }
  const parts = [quoteName(dialect, column.name), column.type.trim()];
  if (column.def.trim() !== "") {
    parts.push(`DEFAULT ${column.def.trim()}`);
  }
  if (column.notNull) {
    parts.push("NOT NULL");
  }
  return parts.join(" ");
}

export function draftsFromDetail(detail: TableDetail): StructureDraft {
  return {
    columns: detail.columns.map((column) => ({
      key: draftKey(),
      orig: column.name,
      name: column.name,
      type: column.decl_type ?? "TEXT",
      notNull: column.not_null,
      pk: column.pk,
      def: column.default ?? "",
    })),
    indexes: detail.indexes
      .filter((index) => !index.primary)
      .map((index) => ({
        key: draftKey(),
        orig: index.name,
        name: index.name,
        unique: index.unique,
        columns: index.columns.join(", "),
      })),
    foreignKeys: detail.foreign_keys.map((fk) => ({
      key: draftKey(),
      orig: fk.name,
      name: fk.name,
      columns: fk.columns.join(", "),
      refTable: fk.ref_table,
      refColumns: fk.ref_columns.join(", "),
    })),
    primaryName: detail.indexes.find((index) => index.primary)?.name,
  };
}

// A new table's draft: an `id` key column of `keyType` (the engine's own
// spelling of an integer where INTEGER isn't one, as on CQL).
export function emptyDrafts(keyType = "INTEGER"): StructureDraft {
  return {
    columns: [
      {
        key: draftKey(),
        orig: null,
        name: "id",
        type: keyType,
        notNull: true,
        pk: true,
        def: "",
      },
    ],
    indexes: [],
    foreignKeys: [],
  };
}

export function validateDraft(draft: StructureDraft): string[] {
  const errors: string[] = [];
  const names = new Set<string>();
  for (const column of draft.columns) {
    const name = column.name.trim();
    if (name === "") {
      errors.push(t("컬럼 이름이 비어 있습니다"));
      continue;
    }
    if (names.has(name)) {
      errors.push(t("컬럼 이름이 중복됩니다: {name}", { name }));
    }
    names.add(name);
    if (column.type.trim() === "") {
      errors.push(t("컬럼 타입이 비어 있습니다: {name}", { name }));
    }
  }
  if (draft.columns.length === 0) {
    errors.push(t("컬럼이 하나 이상 필요합니다"));
  }
  for (const index of draft.indexes) {
    if (index.name.trim() === "") {
      errors.push(t("인덱스 이름이 비어 있습니다"));
    }
    if (splitList(index.columns).length === 0) {
      errors.push(
        t("인덱스 컬럼이 비어 있습니다: {name}", { name: index.name || t("(이름 없음)") }),
      );
    }
  }
  const indexNames = new Set<string>();
  for (const index of draft.indexes) {
    if (indexNames.has(index.name)) {
      errors.push(t("인덱스 이름이 중복됩니다: {name}", { name: index.name }));
    }
    indexNames.add(index.name);
  }
  for (const fk of draft.foreignKeys) {
    if (splitList(fk.columns).length === 0 || fk.refTable.trim() === "") {
      errors.push(t("외래 키 정의가 불완전합니다: {name}", { name: fk.name || t("(이름 없음)") }));
    }
  }
  return errors;
}

export function pkList(columns: ColumnDraft[]): string[] {
  return columns
    .filter((column) => column.pk)
    .map((column) => column.name.trim());
}

// The key's columns by identity, so renaming a key column isn't a new key.
function pkIdentity(columns: ColumnDraft[]): string {
  return columns
    .filter((column) => column.pk)
    .map((column) => column.orig ?? `new:${column.key}`)
    .join(",");
}

export function indexSql(dialect: SqlDialect, table: string, index: IndexDraft): string {
  if (dialect.createIndex !== undefined) {
    return dialect.createIndex(table, index);
  }
  return `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quoteIdent(dialect, index.name)} ON ${quoteIdent(dialect, table)} (${splitList(
    index.columns,
  )
    .map((column) => quoteIdent(dialect, column))
    .join(", ")})`;
}

// An index lives in its table's schema (PostgreSQL, CockroachDB, an attached
// SQLite database), so DROP INDEX names it there.
export function dropIndexSql(dialect: SqlDialect, table: string, name: string): string {
  if (dialect.dropIndex !== undefined) {
    return dialect.dropIndex(table, name);
  }
  const dot = table.lastIndexOf(".");
  const schema = dot < 0 ? "" : `${quoteIdent(dialect, table.slice(0, dot))}.`;
  return `DROP INDEX ${schema}${quoteName(dialect, name)}`;
}

// A FOREIGN KEY clause, as CREATE TABLE and ALTER TABLE … ADD write it.
export function fkClause(dialect: SqlDialect, fk: FkDraft): string {
  const name =
    fk.name.trim() === "" ? "" : `CONSTRAINT ${quoteIdent(dialect, fk.name)} `;
  const columns = splitList(fk.columns)
    .map((column) => quoteIdent(dialect, column))
    .join(", ");
  const refColumns = splitList(fk.refColumns)
    .map((column) => quoteIdent(dialect, column))
    .join(", ");
  return `${name}FOREIGN KEY (${columns}) REFERENCES ${quoteIdent(dialect, fk.refTable)} (${refColumns})`;
}

function fkAddSql(dialect: SqlDialect, table: string, fk: FkDraft): string {
  return `ALTER TABLE ${quoteIdent(dialect, table)} ADD ${fkClause(dialect, fk)}`;
}

function fkDropSql(dialect: SqlDialect, table: string, name: string): string {
  return (
    dialect.dropForeignKey?.(table, name) ??
    `ALTER TABLE ${quoteIdent(dialect, table)} DROP CONSTRAINT ${quoteIdent(dialect, name)}`
  );
}

export function diffStructure(
  dialect: SqlDialect,
  table: string,
  orig: StructureDraft,
  next: StructureDraft,
): DiffResult {
  if (dialect.diffStructure !== undefined) {
    return dialect.diffStructure(table, orig, next);
  }
  const errors = validateDraft(next);
  const statements: string[] = [];
  if (errors.length > 0) {
    return { statements, errors };
  }

  const quotedTable = quoteIdent(dialect, table);
  const dropped = orig.columns.filter(
    (column) => !next.columns.some((candidate) => candidate.orig === (column.orig ?? column.name)),
  );
  const droppedNames = new Set(dropped.map((column) => column.name));
  // Each kept column's draft before the save, and its new name by its old one.
  const befores = new Map<ColumnDraft, ColumnDraft>();
  const renamed = new Map<string, string>();
  // The columns whose indexes have to go first: on SQL Server an index stops
  // its column being retyped, made (not) null or dropped.
  const held = new Set<string>();
  for (const column of next.columns) {
    const before =
      column.orig === null
        ? undefined
        : orig.columns.find((candidate) => (candidate.orig ?? candidate.name) === column.orig);
    if (before === undefined) {
      continue;
    }
    befores.set(column, before);
    renamed.set(before.name, column.name);
    if (dialect.indexesHoldColumns && (before.type !== column.type || before.notNull !== column.notNull)) {
      held.add(before.name);
    }
  }
  if (dialect.indexesHoldColumns) {
    droppedNames.forEach((name) => held.add(name));
  }

  // What goes comes off first, foreign keys before the indexes they may need,
  // so no column change or drop runs into either. What is added or made again
  // comes after the columns, under their new names.
  const origFks = new Map(orig.foreignKeys.map((fk) => [fk.orig ?? fk.name, fk]));
  const fkAdds: string[] = [];
  for (const fk of next.foreignKeys) {
    const before = fk.orig === null ? undefined : origFks.get(fk.orig);
    if (before === undefined) {
      fkAdds.push(fkAddSql(dialect, table, fk));
    } else if (
      before.columns !== fk.columns ||
      before.refTable !== fk.refTable ||
      before.refColumns !== fk.refColumns ||
      before.name !== fk.name
    ) {
      statements.push(fkDropSql(dialect, table, before.name));
      fkAdds.push(fkAddSql(dialect, table, fk));
    }
  }
  for (const fk of orig.foreignKeys) {
    if (!next.foreignKeys.some((candidate) => candidate.orig === (fk.orig ?? fk.name))) {
      statements.push(fkDropSql(dialect, table, fk.name));
    }
  }

  const origIndexes = new Map(orig.indexes.map((index) => [index.orig ?? index.name, index]));
  const indexAdds: string[] = [];
  for (const index of next.indexes) {
    const before = index.orig === null ? undefined : origIndexes.get(index.orig);
    if (before === undefined) {
      indexAdds.push(indexSql(dialect, table, index));
    } else if (before.unique !== index.unique || before.columns !== index.columns || before.name !== index.name) {
      statements.push(dropIndexSql(dialect, table, before.name));
      indexAdds.push(indexSql(dialect, table, index));
    } else if (splitList(before.columns).some((name) => held.has(name))) {
      // Made again as it was, unless one of its columns went (PostgreSQL
      // drops such an index with the column too).
      statements.push(dropIndexSql(dialect, table, before.name));
      const columns = splitList(before.columns);
      if (!columns.some((name) => droppedNames.has(name))) {
        indexAdds.push(
          indexSql(dialect, table, { ...index, columns: columns.map((name) => renamed.get(name) ?? name).join(", ") }),
        );
      }
    }
  }
  for (const index of orig.indexes) {
    if (!next.indexes.some((candidate) => candidate.orig === (index.orig ?? index.name))) {
      statements.push(dropIndexSql(dialect, table, index.name));
    }
  }

  for (const column of next.columns) {
    const before = befores.get(column);
    if (before === undefined) {
      statements.push(
        ...(dialect.addColumn?.(table, column) ?? [`ALTER TABLE ${quotedTable} ADD COLUMN ${columnDef(dialect, column)}`]),
      );
      continue;
    }
    if (before.name !== column.name) {
      statements.push(
        dialect.renameColumn?.(table, before.name, column.name) ??
          `ALTER TABLE ${quotedTable} RENAME COLUMN ${quoteIdent(dialect, before.name)} TO ${quoteIdent(dialect, column.name)}`,
      );
    }
    const change = {
      type: before.type !== column.type,
      notNull: before.notNull !== column.notNull,
      def: before.def !== column.def,
    };
    if (!change.type && !change.notNull && !change.def) {
      continue;
    }
    if (dialect.alterColumn === undefined) {
      errors.push(t("이 엔진은 컬럼 변경을 지원하지 않습니다: {name}", { name: column.name }));
      continue;
    }
    statements.push(...dialect.alterColumn(table, column, change, errors));
  }

  // The key changes before any column goes: dropping a key column would take
  // the key with it (PostgreSQL) or be refused (CockroachDB).
  if (pkIdentity(orig.columns) !== pkIdentity(next.columns)) {
    if (dialect.changePrimaryKey !== undefined) {
      statements.push(...dialect.changePrimaryKey(table, orig, next, errors));
    } else {
      errors.push(t("이 엔진은 기본 키 변경을 지원하지 않습니다"));
    }
  }

  for (const column of dropped) {
    statements.push(
      ...(dialect.dropColumn?.(table, column.name) ?? [
        `ALTER TABLE ${quotedTable} DROP COLUMN ${quoteIdent(dialect, column.name)}`,
      ]),
    );
  }

  statements.push(...indexAdds, ...fkAdds);

  return { statements, errors };
}

// CREATE TABLE's own options, written where the engine has them (MySQL's
// ENGINE=, DEFAULT CHARSET= and the rest).
export interface CreateTableOptions {
  engine?: string;
  charset?: string;
  collation?: string;
  rowFormat?: string;
  comment?: string;
}

export function createTableSql(
  dialect: SqlDialect,
  table: string,
  draft: StructureDraft,
  options: CreateTableOptions = {},
): DiffResult {
  const errors = validateDraft(draft);
  if (errors.length > 0) {
    return { statements: [], errors };
  }
  const body = draft.columns.map((column) => columnDef(dialect, column));
  const pk = pkList(draft.columns);
  if (pk.length > 0) {
    body.push(
      `PRIMARY KEY (${pk.map((name) => quoteIdent(dialect, name)).join(", ")})`,
    );
  }
  for (const fk of draft.foreignKeys) {
    body.push(fkClause(dialect, fk));
  }
  const suffix = dialect.tableOptions?.(options) ?? dialect.tableSuffix?.(draft) ?? "";
  const statements = [
    `CREATE TABLE ${quoteIdent(dialect, table)} (\n  ${body.join(",\n  ")}\n)${suffix}`,
  ];
  for (const index of draft.indexes) {
    if (index.name.trim() !== "" && splitList(index.columns).length > 0) {
      statements.push(indexSql(dialect, table, index));
    }
  }
  return { statements, errors };
}

export function renameTableSql(
  dialect: SqlDialect,
  table: string,
  newName: string,
): string {
  if (dialect.renameTable !== undefined) {
    return dialect.renameTable(table, newName);
  }
  const short = newName.split(".").pop() ?? newName;
  return `ALTER TABLE ${quoteIdent(dialect, table)} RENAME TO ${quoteIdent(dialect, short)}`;
}

export function dropTableSql(dialect: SqlDialect, table: string): string {
  return `DROP TABLE ${quoteIdent(dialect, table)}`;
}

// Tables ordered so each comes after the ones it references among them:
// parents are created and filled before their children. A cycle is broken
// where it is met; otherwise the given order stands.
export function dependencyOrder(names: string[], references: (name: string) => string[]): string[] {
  const known = new Set(names);
  const placed = new Set<string>();
  const order: string[] = [];
  const visit = (name: string): void => {
    if (placed.has(name)) {
      return;
    }
    placed.add(name);
    for (const parent of references(name)) {
      if (parent !== name && known.has(parent)) {
        visit(parent);
      }
    }
    order.push(name);
  };
  names.forEach(visit);
  return order;
}

// A table's secondary indexes, for a dump to make after the table's rows (no
// index kept up to date row by row) and before the foreign keys, which may
// need a unique one. The servers' CREATE TABLE text carries none; SQLite's
// stored definition does (none here). The engine's own statement is taken
// where it gives one (PostgreSQL, CockroachDB); otherwise the statement is
// written from the key parts (MySQL's prefixes and expressions), the
// included columns and the predicate (SQL Server's filtered indexes). An
// index with no key to write is left out.
export function dumpIndexSql(dialect: SqlDialect, table: string, detail: TableDetail): string[] {
  if (dialect.keysInCreate) {
    return [];
  }
  const statements: string[] = [];
  for (const index of detail.indexes) {
    if (index.primary) {
      continue;
    }
    if (index.definition !== undefined && index.definition.trim() !== "") {
      statements.push(index.definition.trim().replace(/;$/, ""));
      continue;
    }
    const keys =
      index.parts?.map(
        (part) =>
          `${
            part.expression !== undefined
              ? `(${part.expression})`
              : `${quoteName(dialect, part.column ?? "")}${part.prefix_length !== undefined ? `(${part.prefix_length})` : ""}`
          }${part.descending === true ? " DESC" : ""}`,
      ) ?? index.columns.map((column) => quoteName(dialect, column));
    if (keys.length === 0) {
      continue;
    }
    const included =
      index.included !== undefined && index.included.length > 0
        ? ` INCLUDE (${index.included.map((column) => quoteName(dialect, column)).join(", ")})`
        : "";
    const where = index.where !== undefined && index.where.trim() !== "" ? ` WHERE ${index.where.trim()}` : "";
    statements.push(
      `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quoteName(dialect, index.name)} ON ${quoteIdent(dialect, table)} (${keys.join(", ")})${included}${where}`,
    );
  }
  return statements;
}

// A foreign key added once every table exists and holds its rows, as a dump
// does: rows then go in any order, and a table may reference itself or be
// one of two that reference each other. SQLite can't add one this way; its
// CREATE TABLE already carries them.
export function foreignKeySql(dialect: SqlDialect, table: string, fk: TableDetailForeignKey): string {
  const list = (columns: string[]): string => columns.map((column) => quoteIdent(dialect, column)).join(", ");
  const name = fk.name.trim() === "" ? "" : `CONSTRAINT ${quoteIdent(dialect, fk.name)} `;
  return `ALTER TABLE ${quoteIdent(dialect, table)} ADD ${name}FOREIGN KEY (${list(fk.columns)}) REFERENCES ${quoteIdent(dialect, fk.ref_table)} (${list(fk.ref_columns)})`;
}

// Two tables that reference each other can't be dropped in either order, so
// the reference goes first. MySQL drops with its key checks off and SQLite
// doesn't hold DROP to them, so they need none (null).
export function dropForeignKeySql(dialect: SqlDialect, table: string, fk: TableDetailForeignKey): string | null {
  if (fk.name.trim() === "") {
    return null;
  }
  return dialect.dropForeignKeyIfExists?.(table, fk) ?? null;
}

// What an export's "Drop" writes before CREATE, so the file runs again on a
// database that already has the object.
export function dropIfExistsSql(dialect: SqlDialect, name: string, object: "table" | "view" = "table"): string {
  const quoted = quoteIdent(dialect, name);
  return dialect.dropIfExists?.(quoted, object) ?? `DROP ${object === "view" ? "VIEW" : "TABLE"} IF EXISTS ${quoted}`;
}

export function truncateTableSql(dialect: SqlDialect, table: string): string {
  return `${dialect.truncateStatement} ${quoteIdent(dialect, table)}`;
}

function laravelString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function laravelType(decl: string | null): { method: string; args: string[] } {
  const text = (decl ?? "").trim().toLowerCase();
  const base = text.replace(/\(.*\)$/, "").trim();
  const argsText = /\(([^)]*)\)/.exec(text)?.[1] ?? "";
  const args = argsText
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  if (/^(tinyint\(1\)|bool|boolean)$/.test(text)) {
    return { method: "boolean", args: [] };
  }
  if (/^(bigint|int8|bigserial|serial8)$/.test(base)) {
    return { method: "bigInteger", args: [] };
  }
  if (/^(smallint|int2|smallserial|serial2)$/.test(base)) {
    return { method: "smallInteger", args: [] };
  }
  if (base === "tinyint") {
    return { method: "tinyInteger", args: [] };
  }
  if (/^(integer|int|int4|serial|serial4)$/.test(base)) {
    return { method: "integer", args: [] };
  }
  if (
    /^(varchar|character varying|nvarchar|national character varying)$/.test(
      base,
    )
  ) {
    return { method: "string", args: args.length > 0 ? [args[0]] : [] };
  }
  if (/^(char|character|nchar|national character)$/.test(base)) {
    return { method: "char", args: args.length > 0 ? [args[0]] : [] };
  }
  if (/^(text|tinytext|mediumtext|longtext|citext)$/.test(base)) {
    return { method: "text", args: [] };
  }
  if (/^(timestamp with time zone|timestamptz|datetimeoffset)$/.test(base)) {
    return { method: "dateTimeTz", args: [] };
  }
  if (/^(timestamp|timestamp without time zone|datetime|datetime2|smalldatetime)$/.test(base)) {
    return { method: "dateTime", args: args.length > 0 ? [args[0]] : [] };
  }
  if (base === "date") {
    return { method: "date", args: [] };
  }
  if (/^(time|time without time zone)$/.test(base)) {
    return { method: "time", args: [] };
  }
  if (/^(numeric|decimal|money)$/.test(base) && args.length >= 2) {
    return { method: "decimal", args: [args[0], args[1]] };
  }
  if (/^(numeric|decimal)$/.test(base)) {
    return { method: "decimal", args: args.length > 0 ? [args[0]] : [] };
  }
  if (/^(double precision|float8|double)$/.test(base)) {
    return { method: "double", args: [] };
  }
  if (/^(real|float4|float)$/.test(base)) {
    return { method: "float", args: [] };
  }
  if (base === "jsonb") {
    return { method: "jsonb", args: [] };
  }
  if (base === "json") {
    return { method: "json", args: [] };
  }
  if (base === "uuid") {
    return { method: "uuid", args: [] };
  }
  if (
    /^(bytea|blob|tinyblob|mediumblob|longblob|binary|varbinary)$/.test(base)
  ) {
    return { method: "binary", args: [] };
  }
  return { method: "string", args: [] };
}

// The modifier a column's default becomes, or null when it has none Laravel
// can write (an expression, a sequence).
function laravelDefault(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  let text = value.trim();
  // SQL Server keeps a default in parentheses: ((0)), (N'x'), (getdate()).
  while (text.startsWith("(") && text.endsWith(")")) {
    let depth = 0;
    let closes = -1;
    for (let at = 0; at < text.length && closes < 0; at += 1) {
      depth += text[at] === "(" ? 1 : text[at] === ")" ? -1 : 0;
      closes = depth === 0 ? at : -1;
    }
    if (closes !== text.length - 1) {
      break;
    }
    text = text.slice(1, -1).trim();
  }
  if (text === "" || /^null$/i.test(text)) {
    return null;
  }
  if (/^(true|false)$/i.test(text)) {
    return `default(${text.toLowerCase()})`;
  }
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    return `default(${text})`;
  }
  const cast = /^'(.*)'::[a-z0-9 _[\]]+$/is.exec(text);
  if (cast) {
    return `default(${laravelString(cast[1].replace(/''/g, "'"))})`;
  }
  if (/^N?'.*'$/s.test(text)) {
    return `default(${laravelString(text.slice(text.indexOf("'") + 1, -1).replace(/''/g, "'"))})`;
  }
  if (/^(now\(\)|current_timestamp(\(\d*\))?|getdate\(\)|sysdatetime\(\))$/i.test(text)) {
    return "useCurrent()";
  }
  return null;
}

export function laravelSchemaScript(detail: TableDetail, dialect: SqlDialect): string {
  const tableName = (detail.name.split(".").pop() ?? detail.name).trim();
  const lines: string[] = [
    `Schema::create(${laravelString(tableName)}, function (Blueprint $table) {`,
  ];
  const primary = detail.columns
    .filter((column) => column.pk)
    .map((column) => column.name);
  for (const column of detail.columns) {
    const type = laravelType(column.decl_type);
    const args = [laravelString(column.name), ...type.args].join(", ");
    // Each modifier is its own call: ->primary()->nullable()->default(5).
    const modifiers: string[] = [];
    // A sequence's column (PostgreSQL's serial reads back as nextval()) is
    // autoIncrement, which makes it the key by itself.
    const increments =
      /^(serial|bigserial|smallserial)/i.test((column.decl_type ?? "").trim()) ||
      /^nextval\(/i.test((column.default ?? "").trim());
    if (column.pk && primary.length === 1 && !increments) {
      modifiers.push("primary()");
    }
    if (!column.not_null) {
      modifiers.push("nullable()");
    }
    const fallback = laravelDefault(column.default);
    if (fallback !== null) {
      modifiers.push(fallback);
    }
    if (increments) {
      modifiers.push("autoIncrement()");
    }
    lines.push(`    $table->${type.method}(${args})${modifiers.map((call) => `->${call}`).join("")};`);
  }
  if (primary.length > 1) {
    lines.push(
      `    $table->primary([${primary.map(laravelString).join(", ")}]);`,
    );
  }
  for (const index of detail.indexes) {
    if (index.primary) {
      continue;
    }
    const columns = `[${index.columns.map(laravelString).join(", ")}]`;
    const method = index.unique ? "unique" : "index";
    lines.push(
      `    $table->${method}(${columns}, ${laravelString(index.name)});`,
    );
  }
  for (const fk of detail.foreign_keys) {
    const columns = `[${fk.columns.map(laravelString).join(", ")}]`;
    const refs = `[${fk.ref_columns.map(laravelString).join(", ")}]`;
    const target = (fk.ref_table.split(".").pop() ?? fk.ref_table).trim();
    lines.push(
      `    $table->foreign(${columns}, ${laravelString(fk.name)})->references(${refs})->on(${laravelString(target)});`,
    );
  }
  if (dialect.laravelEngine !== undefined) {
    lines.push(`    $table->engine = '${dialect.laravelEngine}';`);
  }
  lines.push("});");
  return lines.join("\n");
}
