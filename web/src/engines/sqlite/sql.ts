import { SQLite } from "@codemirror/lang-sql";
import { limitWindow, quoteLiteral } from "../../dataQuery";
import {
  columnDef,
  dropIndexSql,
  fkClause,
  indexSql,
  pkList,
  quoteIdent,
  sig,
  validateDraft,
  type DiffResult,
  type StructureDraft,
} from "../../ddl";
import { parseSqlitePlan } from "../../explainPlan";
import { t } from "../../i18n";
import { functionsFor } from "../sqlFunctions";
import type { SqlDialect } from "../sqlDialect";

// Bare words SQLite reads in a DEFAULT as values, not as strings.
const SQLITE_DEFAULT_WORDS = new Set(["null", "true", "false", "current_time", "current_date", "current_timestamp"]);

// The text of a default spelled as one name: a bare word, "…" or `…` with
// their quotes doubled inside, or […].
function sqliteDefaultName(expr: string): string | null {
  const quoted = /^"((?:[^"]|"")*)"$/.exec(expr) ?? /^`((?:[^`]|``)*)`$/.exec(expr);
  if (quoted !== null) {
    const quote = expr[0];
    return quoted[1].split(quote + quote).join(quote);
  }
  const bracketed = /^\[([^\]]*)\]$/.exec(expr);
  if (bracketed !== null) {
    return bracketed[1];
  }
  return /^[A-Za-z_\u0080-\uffff][\w$\u0080-\uffff]*$/.test(expr) && !SQLITE_DEFAULT_WORDS.has(expr.toLowerCase())
    ? expr
    : null;
}

// Whether an expression holds a bind parameter (?, ?1, :x, @x, $x) outside
// its strings, quoted names and comments. Unclosed ones count.
function hasBindParameter(sql: string): boolean {
  const word = /[\w$\u0080-\uffff]/;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    const close = ch === "'" || ch === '"' || ch === "`" ? ch : ch === "[" ? "]" : null;
    if (close !== null) {
      // A doubled quote is two strings side by side.
      const end = sql.indexOf(close, i + 1);
      if (end < 0) {
        return true;
      }
      i = end;
      continue;
    }
    if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      if (end < 0) {
        return false;
      }
      i = end;
      continue;
    }
    if (sql.startsWith("/*", i)) {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) {
        return true;
      }
      i = end + 1;
      continue;
    }
    const next = sql[i + 1] ?? "";
    const startsName = word.test(next) && next !== "$";
    const afterWord = i > 0 && word.test(sql[i - 1]);
    if (ch === "?" || ((ch === ":" || ch === "@" || ch === "$") && startsName && !afterWord)) {
      return true;
    }
  }
  return false;
}

// SQLite has no `SET col = DEFAULT`: the column's declared default stands
// in, as the engine writes it when it applies one (crates/tablepeek-engine,
// sqlite_default_sql), and NULL without one. A default spelled as one name
// (DEFAULT active, "x", [x], `x`) is a string in CREATE TABLE but would name
// a column in an UPDATE, so it is written as the string. null: the default
// holds a bind parameter, which the engine refuses too.
function sqliteDefaultSql(declared: string | null): string | null {
  if (declared === null) {
    return "NULL";
  }
  const name = sqliteDefaultName(declared.trim());
  if (name !== null) {
    return `'${name.replace(/'/g, "''")}'`;
  }
  if (hasBindParameter(declared)) {
    return null;
  }
  // pragma_table_info drops the outer parentheses but keeps a trailing
  // `-- comment`, which would swallow the closing one: it ends a line here.
  return declared.includes("--") ? `(${declared}\n)` : `(${declared})`;
}

// SQLite's documented way to rebuild a table: with foreign keys off, so
// dropping the original neither cascades into child tables nor fails on them.
function rebuild(table: string, draft: StructureDraft): string[] {
  const tmp = `${table.split(".").pop() ?? table}_tablepeek_tmp`;
  const columns = draft.columns.map((column) => columnDef(sql, column));
  const pk = pkList(draft.columns);
  if (pk.length > 0) {
    columns.push(`PRIMARY KEY (${pk.map((name) => quoteIdent(sql, name)).join(", ")})`);
  }
  for (const fk of draft.foreignKeys) {
    columns.push(fkClause(sql, fk));
  }
  const copied = draft.columns.filter((column) => column.orig !== null);
  const statements = [
    "PRAGMA foreign_keys = OFF",
    `DROP TABLE IF EXISTS ${quoteIdent(sql, tmp)}`,
    `CREATE TABLE ${quoteIdent(sql, tmp)} (\n  ${columns.join(",\n  ")}\n)`,
  ];
  if (copied.length > 0) {
    statements.push(
      `INSERT INTO ${quoteIdent(sql, tmp)} (${copied
        .map((column) => quoteIdent(sql, column.name))
        .join(", ")}) SELECT ${copied
        .map((column) => quoteIdent(sql, column.orig ?? column.name))
        .join(", ")} FROM ${quoteIdent(sql, table)}`,
    );
  }
  statements.push(`DROP TABLE ${quoteIdent(sql, table)}`);
  statements.push(`ALTER TABLE ${quoteIdent(sql, tmp)} RENAME TO ${quoteIdent(sql, table)}`);
  for (const index of draft.indexes) {
    if (index.name.trim() !== "") {
      statements.push(indexSql(sql, table, index));
    }
  }
  statements.push("PRAGMA foreign_keys = ON");
  return statements;
}

// ALTER TABLE in SQLite adds columns and little else: any other change to a
// column, the key or the foreign keys rebuilds the table.
function diffStructure(table: string, orig: StructureDraft, next: StructureDraft): DiffResult {
  const errors = validateDraft(next);
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
  if (needsRebuild || removed) {
    return {
      statements: errors.length === 0 ? rebuild(table, next) : [],
      errors,
    };
  }
  const statements: string[] = [];
  if (added) {
    for (const column of next.columns) {
      if (column.orig === null && column.name.trim() !== "") {
        statements.push(
          `ALTER TABLE ${quoteIdent(sql, table)} ADD COLUMN ${columnDef(sql, column)}`,
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
        statements.push(indexSql(sql, table, index));
      } else if (sig(before) !== sig(index)) {
        statements.push(dropIndexSql(sql, table, before.name));
        statements.push(indexSql(sql, table, index));
      }
    }
    for (const index of orig.indexes) {
      if (
        !next.indexes.some(
          (candidate) => candidate.orig === (index.orig ?? index.name),
        )
      ) {
        statements.push(dropIndexSql(sql, table, index.name));
      }
    }
  }
  return { statements, errors };
}

// SQLite, whose names take "…" (and [ … ]), whose columns hold any type and
// whose ALTER TABLE rebuilds the table for most changes.
export const sql: SqlDialect = {
  quotePart: (part) => `"${part.replace(/"/g, '""')}"`,
  defaultSchema: null,

  stringLiteral: quoteLiteral,
  booleanLiteral: (value) => (value ? "TRUE" : "FALSE"),
  binaryLiteral: (hex) => `X'${hex.toUpperCase()}'`,
  bareHexIsBinary: false,
  nowSql: "CURRENT_TIMESTAMP",
  nowLabel: "CURRENT_TIMESTAMP",

  likeSpecials: /[!%_]/g,

  rowWindow: limitWindow,
  firstRows: (quotedTable, select, rows) => `SELECT ${select} FROM ${quotedTable} LIMIT ${rows};`,
  firstRowsName: "SELECT LIMIT",
  // A table without a declared key still has its rowid.
  implicitRowOrder: "rowid",
  emptyInsert: (quotedTable) => `INSERT INTO ${quotedTable} DEFAULT VALUES;`,
  updateDefault: sqliteDefaultSql,

  diffStructure,
  rebuildsTable: true,
  truncateStatement: "DELETE FROM",
  truncateTogether: false,
  columnTypes: ["INTEGER", "TEXT", "REAL", "NUMERIC", "BLOB", "BOOLEAN", "VARCHAR(255)", "DATE", "DATETIME", "JSON"],
  columnDefaults: ["CURRENT_TIMESTAMP", "CURRENT_DATE"],

  // As SQLite's own .dump starts: its keys can't be added after the rows.
  dumpBefore: "PRAGMA foreign_keys = OFF;",
  keysInCreate: true,
  sessionSnapshot: "PRAGMA foreign_keys",
  restoreSession: (row) =>
    row[0] === 0 || row[0] === 1 ? `PRAGMA foreign_keys = ${row[0] === 1 ? "ON" : "OFF"}` : null,

  templates: {
    view: "CREATE VIEW v_name AS\nSELECT 1 AS one;",
    trigger: "CREATE TRIGGER trg_name\nAFTER INSERT ON table_name\nBEGIN\n  SELECT 1;\nEND;",
  },

  insertModes: ["insert", "upsert", "replace"],
  replaceInto: "INSERT OR REPLACE INTO",
  upsertNeedsKey: true,
  collapseRepeats: false,
  ddlInTransaction: true,
  // SQLite would round anything but a 64-bit integer to a REAL.
  numberAsText: (text) => !(/^-?\d+$/.test(text) && BigInt(text) >= -(2n ** 63n) && BigInt(text) < 2n ** 63n),
  importType: (profile) =>
    ({
      integer: "INTEGER",
      bigint: "INTEGER",
      decimal: "REAL",
      double: "REAL",
      boolean: "BOOLEAN",
      date: "DATE",
      datetime: "DATETIME",
      datetimetz: "DATETIME",
      text: "TEXT",
    })[profile.kind],
  importExtraTypes: [],
  importBitIsBoolean: false,

  booleanOptions: ["1", "0"],
  gridBitIsBoolean: false,
  timestampIsVersion: false,
  // Any type naming BLOB, as SQLite's affinity rule (and the engine) reads it.
  blobByName: true,

  explain: { prefix: "EXPLAIN QUERY PLAN ", parse: parseSqlitePlan },

  editor: SQLite,
  lexing: {
    hashComments: false,
    backslashEscapes: false,
    bracketNames: true,
    dollarQuotes: false,
    executableComments: false,
    escapeStrings: false,
  },
  functions: functionsFor("sqlite"),
};
