import { t } from "./i18n";
import type { TableDetail } from "./store";

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

function sig(value: unknown): string {
  return JSON.stringify(value, (key, item) =>
    key === "key" ? undefined : item,
  );
}

export function draftKey(): string {
  draftSeq += 1;
  return `d-${draftSeq}`;
}

function quotePart(kind: string, part: string): string {
  if (kind === "mysql") {
    return `\`${part.replace(/`/g, "``")}\``;
  }
  if (kind === "mssql") {
    return `[${part.replace(/]/g, "]]")}]`;
  }
  return `"${part.replace(/"/g, '""')}"`;
}

export function quoteIdent(kind: string, name: string): string {
  return name
    .split(".")
    .map((part) => quotePart(kind, part.trim()))
    .join(".");
}

export function splitList(text: string): string[] {
  return text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

function columnDef(kind: string, column: ColumnDraft): string {
  const parts = [quoteIdent(kind, column.name), column.type.trim()];
  if (column.notNull) {
    parts.push("NOT NULL");
  }
  if (column.def.trim() !== "") {
    parts.push(`DEFAULT ${column.def.trim()}`);
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

export function emptyDrafts(): StructureDraft {
  return {
    columns: [
      {
        key: draftKey(),
        orig: null,
        name: "id",
        type: "INTEGER",
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

function pkList(columns: ColumnDraft[]): string[] {
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

function indexSql(kind: string, table: string, index: IndexDraft): string {
  return `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${quoteIdent(kind, index.name)} ON ${quoteIdent(kind, table)} (${splitList(
    index.columns,
  )
    .map((column) => quoteIdent(kind, column))
    .join(", ")})`;
}

function dropIndexSql(kind: string, table: string, name: string): string {
  if (kind === "mssql") {
    return `DROP INDEX ${quoteIdent(kind, name)} ON ${quoteIdent(kind, table)}`;
  }
  return `DROP INDEX ${quoteIdent(kind, name)}`;
}

function fkAddSql(kind: string, table: string, fk: FkDraft): string {
  const name =
    fk.name.trim() === "" ? "" : `CONSTRAINT ${quoteIdent(kind, fk.name)} `;
  const columns = splitList(fk.columns)
    .map((column) => quoteIdent(kind, column))
    .join(", ");
  const refColumns = splitList(fk.refColumns)
    .map((column) => quoteIdent(kind, column))
    .join(", ");
  return `ALTER TABLE ${quoteIdent(kind, table)} ADD ${name}FOREIGN KEY (${columns}) REFERENCES ${quoteIdent(kind, fk.refTable)} (${refColumns})`;
}

function fkDropSql(kind: string, table: string, name: string): string {
  if (kind === "mysql") {
    return `ALTER TABLE ${quoteIdent(kind, table)} DROP FOREIGN KEY ${quoteIdent(kind, name)}`;
  }
  return `ALTER TABLE ${quoteIdent(kind, table)} DROP CONSTRAINT ${quoteIdent(kind, name)}`;
}

function rebuildSqlite(table: string, draft: StructureDraft): string[] {
  const tmp = `${table.split(".").pop() ?? table}_tablepeek_tmp`;
  const columns = draft.columns.map((column) => columnDef("sqlite", column));
  const pk = pkList(draft.columns);
  if (pk.length > 0) {
    columns.push(
      `PRIMARY KEY (${pk.map((name) => quoteIdent("sqlite", name)).join(", ")})`,
    );
  }
  for (const fk of draft.foreignKeys) {
    const columnsList = splitList(fk.columns)
      .map((column) => quoteIdent("sqlite", column))
      .join(", ");
    const refColumns = splitList(fk.refColumns)
      .map((column) => quoteIdent("sqlite", column))
      .join(", ");
    const name =
      fk.name.trim() === ""
        ? ""
        : `CONSTRAINT ${quoteIdent("sqlite", fk.name)} `;
    columns.push(
      `${name}FOREIGN KEY (${columnsList}) REFERENCES ${quoteIdent("sqlite", fk.refTable)} (${refColumns})`,
    );
  }
  const copied = draft.columns.filter((column) => column.orig !== null);
  // SQLite's documented way to rebuild a table: with foreign keys off, so
  // dropping the original neither cascades into child tables nor fails on them.
  const statements = [
    "PRAGMA foreign_keys = OFF",
    `DROP TABLE IF EXISTS ${quoteIdent("sqlite", tmp)}`,
    `CREATE TABLE ${quoteIdent("sqlite", tmp)} (\n  ${columns.join(",\n  ")}\n)`,
  ];
  if (copied.length > 0) {
    statements.push(
      `INSERT INTO ${quoteIdent("sqlite", tmp)} (${copied
        .map((column) => quoteIdent("sqlite", column.name))
        .join(", ")}) SELECT ${copied
        .map((column) => quoteIdent("sqlite", column.orig ?? column.name))
        .join(", ")} FROM ${quoteIdent("sqlite", table)}`,
    );
  }
  statements.push(`DROP TABLE ${quoteIdent("sqlite", table)}`);
  statements.push(
    `ALTER TABLE ${quoteIdent("sqlite", tmp)} RENAME TO ${quoteIdent("sqlite", table)}`,
  );
  for (const index of draft.indexes) {
    if (index.name.trim() !== "") {
      statements.push(indexSql("sqlite", table, index));
    }
  }
  statements.push("PRAGMA foreign_keys = ON");
  return statements;
}

export function diffStructure(
  kind: string,
  table: string,
  orig: StructureDraft,
  next: StructureDraft,
): DiffResult {
  const errors = validateDraft(next);
  if (kind === "sqlite") {
    for (const column of next.columns) {
      if (column.orig === null && column.notNull && column.def.trim() === "") {
        errors.push(
          t("SQLite는 기본값 없는 NOT NULL 컬럼을 추가할 수 없습니다: {name}", { name: column.name }),
        );
      }
    }
    const origByName = new Map(
      orig.columns.map((column) => [column.orig ?? column.name, column]),
    );
    let needsRebuild = false;
    for (const column of next.columns) {
      const before =
        column.orig === null ? undefined : origByName.get(column.orig);
      if (before === undefined) {
        continue;
      }
      if (
        before.type !== column.type ||
        before.notNull !== column.notNull ||
        before.def !== column.def ||
        before.pk !== column.pk ||
        before.name !== column.name
      ) {
        needsRebuild = true;
      }
    }
    const origPk = pkList(orig.columns).join(",");
    if (origPk !== pkList(next.columns).join(",")) {
      needsRebuild = true;
    }
    const removed = orig.columns.some(
      (column) =>
        !next.columns.some(
          (candidate) => candidate.orig === (column.orig ?? column.name),
        ),
    );
    const added = next.columns.some((column) => column.orig === null);
    // SQLite cannot alter a foreign key; the rebuild writes the new ones.
    if (sig(orig.foreignKeys) !== sig(next.foreignKeys)) {
      needsRebuild = true;
    }
    const indexChanged = sig(orig.indexes) !== sig(next.indexes);
    if (needsRebuild) {
      return {
        statements: errors.length === 0 ? rebuildSqlite(table, next) : [],
        errors,
      };
    }
    const statements: string[] = [];
    if (added || removed) {
      if (removed) {
        return {
          statements: errors.length === 0 ? rebuildSqlite(table, next) : [],
          errors,
        };
      }
      for (const column of next.columns) {
        if (column.orig === null && column.name.trim() !== "") {
          statements.push(
            `ALTER TABLE ${quoteIdent(kind, table)} ADD COLUMN ${columnDef(kind, column)}`,
          );
        }
      }
    }
    if (indexChanged && errors.length === 0) {
      const origIndexes = new Map(
        orig.indexes.map((index) => [index.orig ?? index.name, index]),
      );
      for (const index of next.indexes) {
        const before =
          index.orig === null ? undefined : origIndexes.get(index.orig);
        if (before === undefined) {
          statements.push(indexSql(kind, table, index));
        } else if (sig(before) !== sig(index)) {
          statements.push(dropIndexSql(kind, table, before.name));
          statements.push(indexSql(kind, table, index));
        }
      }
      for (const index of orig.indexes) {
        if (
          !next.indexes.some(
            (candidate) => candidate.orig === (index.orig ?? index.name),
          )
        ) {
          statements.push(dropIndexSql(kind, table, index.name));
        }
      }
    }
    return { statements, errors };
  }

  const statements: string[] = [];
  if (errors.length > 0) {
    return { statements, errors };
  }

  for (const column of next.columns) {
    const before =
      column.orig === null
        ? undefined
        : orig.columns.find(
            (candidate) => (candidate.orig ?? candidate.name) === column.orig,
          );
    if (before === undefined) {
      statements.push(
        `ALTER TABLE ${quoteIdent(kind, table)} ADD COLUMN ${columnDef(kind, column)}`,
      );
      if (kind === "mssql" && column.def.trim() !== "") {
        statements.push(
          `ALTER TABLE ${quoteIdent(kind, table)} ADD CONSTRAINT ${quotePart(
            kind,
            `DF_${table.replace(/\./g, "_")}_${column.name}`,
          )} DEFAULT ${column.def.trim()} FOR ${quoteIdent(kind, column.name)}`,
        );
      }
      continue;
    }
    if (before.name !== column.name) {
      if (kind === "mssql") {
        statements.push(
          `EXEC sp_rename N'${table}.${before.name}', N'${column.name}', 'COLUMN'`,
        );
      } else {
        statements.push(
          `ALTER TABLE ${quoteIdent(kind, table)} RENAME COLUMN ${quoteIdent(kind, before.name)} TO ${quoteIdent(kind, column.name)}`,
        );
      }
    }
    const typeChanged = before.type !== column.type;
    const nullChanged = before.notNull !== column.notNull;
    const defChanged = before.def !== column.def;
    if (!typeChanged && !nullChanged && !defChanged) {
      continue;
    }
    if (kind === "postgres" || kind === "cockroach") {
      if (typeChanged) {
        statements.push(
          `ALTER TABLE ${quoteIdent(kind, table)} ALTER COLUMN ${quoteIdent(kind, column.name)} TYPE ${column.type.trim()}`,
        );
      }
      if (nullChanged) {
        statements.push(
          `ALTER TABLE ${quoteIdent(kind, table)} ALTER COLUMN ${quoteIdent(kind, column.name)} ${column.notNull ? "SET" : "DROP"} NOT NULL`,
        );
      }
      if (defChanged) {
        statements.push(
          column.def.trim() === ""
            ? `ALTER TABLE ${quoteIdent(kind, table)} ALTER COLUMN ${quoteIdent(kind, column.name)} DROP DEFAULT`
            : `ALTER TABLE ${quoteIdent(kind, table)} ALTER COLUMN ${quoteIdent(kind, column.name)} SET DEFAULT ${column.def.trim()}`,
        );
      }
      continue;
    }
    if (kind === "mysql") {
      statements.push(
        `ALTER TABLE ${quoteIdent(kind, table)} MODIFY COLUMN ${columnDef(kind, column)}`,
      );
      continue;
    }
    if (kind === "mssql") {
      if (defChanged) {
        errors.push(t("MSSQL은 기본값 변경을 지원하지 않습니다: {name}", { name: column.name }));
        continue;
      }
      statements.push(
        `ALTER TABLE ${quoteIdent(kind, table)} ALTER COLUMN ${quoteIdent(kind, column.name)} ${column.type.trim()} ${column.notNull ? "NOT NULL" : "NULL"}`,
      );
    }
  }

  // The key changes before any column goes: dropping a key column would take
  // the key with it (PostgreSQL) or be refused (CockroachDB).
  const origPk = pkList(orig.columns);
  const nextPk = pkList(next.columns);
  if (pkIdentity(orig.columns) !== pkIdentity(next.columns)) {
    if (kind === "mysql") {
      if (origPk.length > 0) {
        statements.push(
          `ALTER TABLE ${quoteIdent(kind, table)} DROP PRIMARY KEY`,
        );
      }
      if (nextPk.length > 0) {
        statements.push(
          `ALTER TABLE ${quoteIdent(kind, table)} ADD PRIMARY KEY (${nextPk
            .map((name) => quoteIdent(kind, name))
            .join(", ")})`,
        );
      }
    } else if (kind === "cockroach") {
      // CockroachDB swaps a primary key in one statement and keeps one always;
      // its columns must be NOT NULL first (others make them so themselves).
      if (nextPk.length > 0) {
        for (const column of next.columns) {
          if (column.pk && !column.notNull) {
            statements.push(
              `ALTER TABLE ${quoteIdent(kind, table)} ALTER COLUMN ${quoteIdent(kind, column.name.trim())} SET NOT NULL`,
            );
          }
        }
        statements.push(
          `ALTER TABLE ${quoteIdent(kind, table)} ALTER PRIMARY KEY USING COLUMNS (${nextPk
            .map((name) => quoteIdent(kind, name))
            .join(", ")})`,
        );
      } else {
        errors.push(t("CockroachDB 테이블에서는 기본 키를 없앨 수 없습니다"));
      }
    } else if (kind === "postgres") {
      // The old key goes first: a table can't hold two. Its real name, when
      // known; a renamed table keeps its key's old one.
      if (origPk.length > 0) {
        const short = table.split(".").pop() ?? table;
        const constraint = orig.primaryName ?? `${short}_pkey`;
        statements.push(
          `ALTER TABLE ${quoteIdent(kind, table)} DROP CONSTRAINT IF EXISTS ${quotePart(kind, constraint)}`,
        );
      }
      if (nextPk.length > 0) {
        statements.push(
          `ALTER TABLE ${quoteIdent(kind, table)} ADD PRIMARY KEY (${nextPk
            .map((name) => quoteIdent(kind, name))
            .join(", ")})`,
        );
      }
    } else {
      errors.push(t("이 엔진은 기본 키 변경을 지원하지 않습니다"));
    }
  }

  for (const column of orig.columns) {
    if (
      !next.columns.some(
        (candidate) => candidate.orig === (column.orig ?? column.name),
      )
    ) {
      statements.push(
        `ALTER TABLE ${quoteIdent(kind, table)} DROP COLUMN ${quoteIdent(kind, column.name)}`,
      );
    }
  }

  const origIndexes = new Map(
    orig.indexes.map((index) => [index.orig ?? index.name, index]),
  );
  for (const index of next.indexes) {
    const before =
      index.orig === null ? undefined : origIndexes.get(index.orig);
    if (before === undefined) {
      statements.push(indexSql(kind, table, index));
    } else if (
      before.unique !== index.unique ||
      before.columns !== index.columns ||
      before.name !== index.name
    ) {
      statements.push(dropIndexSql(kind, table, before.name));
      statements.push(indexSql(kind, table, index));
    }
  }
  for (const index of orig.indexes) {
    if (
      !next.indexes.some(
        (candidate) => candidate.orig === (index.orig ?? index.name),
      )
    ) {
      statements.push(dropIndexSql(kind, table, index.name));
    }
  }

  const origFks = new Map(
    orig.foreignKeys.map((fk) => [fk.orig ?? fk.name, fk]),
  );
  for (const fk of next.foreignKeys) {
    const before = fk.orig === null ? undefined : origFks.get(fk.orig);
    if (before === undefined) {
      statements.push(fkAddSql(kind, table, fk));
    } else if (
      before.columns !== fk.columns ||
      before.refTable !== fk.refTable ||
      before.refColumns !== fk.refColumns ||
      before.name !== fk.name
    ) {
      statements.push(fkDropSql(kind, table, before.name));
      statements.push(fkAddSql(kind, table, fk));
    }
  }
  for (const fk of orig.foreignKeys) {
    if (
      !next.foreignKeys.some(
        (candidate) => candidate.orig === (fk.orig ?? fk.name),
      )
    ) {
      statements.push(fkDropSql(kind, table, fk.name));
    }
  }

  return { statements, errors };
}

export interface CreateTableOptions {
  mysqlEngine?: string;
  mysqlCharset?: string;
  mysqlCollation?: string;
  mysqlRowFormat?: string;
  mysqlComment?: string;
}

export function createTableSql(
  kind: string,
  table: string,
  draft: StructureDraft,
  options: CreateTableOptions = {},
): DiffResult {
  const errors = validateDraft(draft);
  if (errors.length > 0) {
    return { statements: [], errors };
  }
  const body = draft.columns.map((column) => columnDef(kind, column));
  const pk = pkList(draft.columns);
  if (pk.length > 0) {
    body.push(
      `PRIMARY KEY (${pk.map((name) => quoteIdent(kind, name)).join(", ")})`,
    );
  }
  for (const fk of draft.foreignKeys) {
    const columnsList = splitList(fk.columns)
      .map((column) => quoteIdent(kind, column))
      .join(", ");
    const refColumns = splitList(fk.refColumns)
      .map((column) => quoteIdent(kind, column))
      .join(", ");
    const name =
      fk.name.trim() === "" ? "" : `CONSTRAINT ${quoteIdent(kind, fk.name)} `;
    body.push(
      `${name}FOREIGN KEY (${columnsList}) REFERENCES ${quoteIdent(kind, fk.refTable)} (${refColumns})`,
    );
  }
  let suffix = "";
  if (kind === "mysql") {
    const parts: string[] = [];
    if (options.mysqlEngine && options.mysqlEngine.trim() !== "") {
      parts.push(`ENGINE=${options.mysqlEngine.trim()}`);
    }
    if (options.mysqlCharset && options.mysqlCharset.trim() !== "") {
      parts.push(`DEFAULT CHARSET=${options.mysqlCharset.trim()}`);
    }
    if (options.mysqlCollation && options.mysqlCollation.trim() !== "") {
      parts.push(`COLLATE=${options.mysqlCollation.trim()}`);
    }
    if (options.mysqlRowFormat && options.mysqlRowFormat.trim() !== "") {
      parts.push(`ROW_FORMAT=${options.mysqlRowFormat.trim().toUpperCase()}`);
    }
    if (options.mysqlComment && options.mysqlComment.trim() !== "") {
      parts.push(`COMMENT=${laravelString(options.mysqlComment.trim())}`);
    }
    if (parts.length > 0) {
      suffix = ` ${parts.join(" ")}`;
    }
  }
  const statements = [
    `CREATE TABLE ${quoteIdent(kind, table)} (\n  ${body.join(",\n  ")}\n)${suffix}`,
  ];
  for (const index of draft.indexes) {
    if (index.name.trim() !== "" && splitList(index.columns).length > 0) {
      statements.push(indexSql(kind, table, index));
    }
  }
  return { statements, errors };
}

export function renameTableSql(
  kind: string,
  table: string,
  newName: string,
): string {
  if (kind === "mysql") {
    return `RENAME TABLE ${quoteIdent(kind, table)} TO ${quoteIdent(kind, newName)}`;
  }
  if (kind === "mssql") {
    const target = newName.includes(".")
      ? newName
      : table.split(".")[0]
        ? `${table.split(".")[0]}.${newName}`
        : newName;
    return `EXEC sp_rename N'${table}', N'${target.split(".").pop() ?? target}'`;
  }
  const short = newName.split(".").pop() ?? newName;
  return `ALTER TABLE ${quoteIdent(kind, table)} RENAME TO ${quoteIdent(kind, short)}`;
}

export function dropTableSql(kind: string, table: string): string {
  return `DROP TABLE ${quoteIdent(kind, table)}`;
}

export function truncateTableSql(kind: string, table: string): string {
  if (kind === "sqlite") {
    return `DELETE FROM ${quoteIdent(kind, table)}`;
  }
  return `TRUNCATE TABLE ${quoteIdent(kind, table)}`;
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
  if (/^(timestamp with time zone|timestamptz)$/.test(base)) {
    return { method: "dateTimeTz", args: [] };
  }
  if (/^(timestamp|datetime)$/.test(base)) {
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

function laravelDefault(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const text = value.trim();
  if (text === "" || /^null$/i.test(text)) {
    return null;
  }
  if (/^(true|false)$/i.test(text)) {
    return text.toLowerCase();
  }
  if (/^-?\d+(\.\d+)?$/.test(text)) {
    return text;
  }
  const cast = /^'(.*)'::[a-z0-9 _[\]]+$/i.exec(text);
  if (cast) {
    return laravelString(cast[1].replace(/''/g, "'"));
  }
  if (/^'.*'$/s.test(text)) {
    return laravelString(text.slice(1, -1).replace(/''/g, "'"));
  }
  if (/^(now\(\)|current_timestamp)$/i.test(text)) {
    return "DB::raw('CURRENT_TIMESTAMP')";
  }
  return null;
}

export function laravelSchemaScript(detail: TableDetail, kind: string): string {
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
    const modifiers: string[] = [];
    if (column.pk && primary.length === 1) {
      modifiers.push("primary");
    }
    if (!column.not_null) {
      modifiers.push("nullable");
    }
    const fallback = laravelDefault(column.default);
    if (fallback !== null) {
      modifiers.push(`default(${fallback})`);
    }
    if (
      /^(serial|bigserial|smallserial)/i.test((column.decl_type ?? "").trim())
    ) {
      modifiers.push("autoIncrement");
    }
    const suffix = modifiers.length > 0 ? `->${modifiers.join("->")}()` : "";
    lines.push(`    $table->${type.method}(${args})${suffix};`);
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
  if (kind === "mysql") {
    lines.push("    $table->engine = 'InnoDB';");
  }
  lines.push("});");
  return lines.join("\n");
}
