import { PostgreSQL } from "@codemirror/lang-sql";
import { limitWindow, quoteLiteral } from "../../dataQuery";
import { pkList, quoteIdent, type ColumnDraft, type StructureDraft } from "../../ddl";
import { parsePostgresPlan } from "../../explainPlan";
import { functionsFor } from "../sqlFunctions";
import type { ColumnChange, SqlDialect, UserAdmin } from "../sqlDialect";

// Session settings pg_dump's files set for their own run (an empty
// search_path, never put back, and the rest), kept around a restore.
const SESSION_SETTINGS = [
  "search_path",
  "row_security",
  "check_function_bodies",
  "client_min_messages",
  "standard_conforming_strings",
  "client_encoding",
  "xmloption",
  "statement_timeout",
  "lock_timeout",
  "idle_in_transaction_session_timeout",
];

function alterColumn(table: string, column: ColumnDraft, change: ColumnChange): string[] {
  const target = `ALTER TABLE ${quoteIdent(sql, table)} ALTER COLUMN ${quoteIdent(sql, column.name)}`;
  const statements: string[] = [];
  if (change.type) {
    statements.push(`${target} TYPE ${column.type.trim()}`);
  }
  if (change.notNull) {
    statements.push(`${target} ${column.notNull ? "SET" : "DROP"} NOT NULL`);
  }
  if (change.def) {
    statements.push(column.def.trim() === "" ? `${target} DROP DEFAULT` : `${target} SET DEFAULT ${column.def.trim()}`);
  }
  return statements;
}

// The old key goes first: a table can't hold two. Its real name, when
// known; a renamed table keeps its key's old one.
function changePrimaryKey(table: string, orig: StructureDraft, next: StructureDraft): string[] {
  const statements: string[] = [];
  const nextPk = pkList(next.columns);
  if (pkList(orig.columns).length > 0) {
    const short = table.split(".").pop() ?? table;
    const constraint = orig.primaryName ?? `${short}_pkey`;
    statements.push(`ALTER TABLE ${quoteIdent(sql, table)} DROP CONSTRAINT IF EXISTS ${sql.quotePart(constraint)}`);
  }
  if (nextPk.length > 0) {
    statements.push(
      `ALTER TABLE ${quoteIdent(sql, table)} ADD PRIMARY KEY (${nextPk.map((name) => quoteIdent(sql, name)).join(", ")})`,
    );
  }
  return statements;
}

// Roles that can log in, as pg_user lists them.
export const postgresUsers: UserAdmin = {
  listSql: "SELECT usename, usesuper FROM pg_user ORDER BY usename",
  // /api/exec sends booleans as text ("true"); "t" is psql's spelling.
  readRow: (row) => ({
    name: String(row[0] ?? ""),
    extra: row[1] === true || row[1] === "true" || row[1] === "t" ? "SUPERUSER" : "",
  }),
  extraLabel: "유형",
  hostField: false,
  superUserOption: true,
  createSql: (name, password, _host, superUser) => [
    { sql: `CREATE ROLE ${sql.quotePart(name)} LOGIN PASSWORD ${quoteLiteral(password)}`, secret: true },
    ...(superUser ? [`ALTER ROLE ${sql.quotePart(name)} SUPERUSER`] : []),
  ],
  dropSql: (row) => `DROP ROLE ${sql.quotePart(row.name)}`,
  passwordSql: (row, password) => ({
    sql: `ALTER ROLE ${sql.quotePart(row.name)} WITH PASSWORD ${quoteLiteral(password)}`,
    secret: true,
  }),
  createdInfo: "역할을 생성했습니다: {name}",
  droppedInfo: "역할을 삭제했습니다: {name}",
};

// PostgreSQL: "…" names, E'…' and $tag$ strings, ON CONFLICT upserts and a
// public schema names are shown without.
export const sql: SqlDialect = {
  quotePart: (part) => `"${part.replace(/"/g, '""')}"`,
  defaultSchema: "public",

  stringLiteral: quoteLiteral,
  booleanLiteral: (value) => (value ? "TRUE" : "FALSE"),
  binaryLiteral: (hex) => `'\\x${hex.toLowerCase()}'`,
  bareHexIsBinary: true,
  nowSql: "now()",
  nowLabel: "NOW()",

  likeSpecials: /[!%_]/g,
  // PostgreSQL has no LIKE for numbers or dates.
  textMatchColumn: (column) => `CAST(${column} AS TEXT)`,

  rowWindow: limitWindow,
  firstRows: (quotedTable, select, rows) => `SELECT ${select} FROM ${quotedTable} LIMIT ${rows};`,
  firstRowsName: "SELECT LIMIT",
  implicitRowOrder: null,
  emptyInsert: (quotedTable) => `INSERT INTO ${quotedTable} DEFAULT VALUES;`,

  rebuildsTable: false,
  alterColumn,
  changePrimaryKey,
  truncateStatement: "TRUNCATE TABLE",
  // One TRUNCATE empties tables that reference each other, which it won't do one at a time.
  truncateTogether: true,
  dropForeignKeyIfExists: (table, fk) =>
    `ALTER TABLE IF EXISTS ${quoteIdent(sql, table)} DROP CONSTRAINT IF EXISTS ${quoteIdent(sql, fk.name)}`,
  columnTypes: [
    "integer", "bigint", "smallint", "serial", "bigserial", "numeric(10,2)", "real",
    "double precision", "boolean", "text", "varchar(255)", "char(32)", "uuid", "date",
    "time", "timestamp", "timestamptz", "json", "jsonb", "bytea",
  ],
  columnDefaults: ["now()", "CURRENT_TIMESTAMP", "gen_random_uuid()", "true", "false"],

  keysInCreate: false,
  // Missing settings (an older server) read as NULL and are left alone.
  sessionSnapshot: `SELECT ${SESSION_SETTINGS.map((name) => `current_setting('${name}', true)`).join(", ")}`,
  restoreSession: (row) => {
    const sets = SESSION_SETTINGS.flatMap((name, index) =>
      row[index] === null || row[index] === undefined
        ? []
        : [`set_config('${name}', ${quoteLiteral(String(row[index]))}, false)`],
    );
    return sets.length === 0 ? null : `SELECT ${sets.join(", ")}`;
  },

  templates: {
    view: "CREATE OR REPLACE VIEW v_name AS\nSELECT 1 AS one;",
    function: [
      "CREATE OR REPLACE FUNCTION fn_name(x integer) RETURNS integer AS $$",
      "BEGIN",
      "  RETURN x + 1;",
      "END;",
      "$$ LANGUAGE plpgsql;",
    ].join("\n"),
    procedure: [
      "CREATE OR REPLACE PROCEDURE sp_name(x integer) AS $$",
      "BEGIN",
      "  RAISE NOTICE '%', x;",
      "END;",
      "$$ LANGUAGE plpgsql;",
    ].join("\n"),
    trigger: [
      "CREATE OR REPLACE FUNCTION trg_fn() RETURNS trigger AS $$",
      "BEGIN",
      "  RETURN NEW;",
      "END;",
      "$$ LANGUAGE plpgsql;",
      "",
      "CREATE TRIGGER trg_name",
      "AFTER INSERT ON table_name",
      "FOR EACH ROW EXECUTE FUNCTION trg_fn();",
    ].join("\n"),
    sequence: "CREATE SEQUENCE seq_name\n  START WITH 1\n  INCREMENT BY 1;",
  },

  insertModes: ["insert", "upsert"],
  replaceInto: "REPLACE INTO",
  upsertNeedsKey: true,
  collapseRepeats: true,
  ddlInTransaction: true,
  importType: (profile) =>
    ({
      integer: "integer",
      bigint: "bigint",
      decimal: "numeric",
      double: "double precision",
      boolean: "boolean",
      date: "date",
      datetime: "timestamp",
      datetimetz: "timestamptz",
      text: "text",
    })[profile.kind],
  importExtraTypes: ["varchar(255)", "jsonb"],
  // PostgreSQL's bit(n) is a bit string, which takes '1' and refuses TRUE.
  importBitIsBoolean: false,

  booleanOptions: ["true", "false"],
  gridBitIsBoolean: false,
  timestampIsVersion: false,
  blobByName: false,

  // The plan view reads the JSON form; plain EXPLAIN's text it can't draw.
  explain: { prefix: "EXPLAIN (FORMAT JSON) ", parse: (_columns, rows) => parsePostgresPlan(rows) },

  editor: PostgreSQL,
  lexing: {
    hashComments: false,
    backslashEscapes: false,
    bracketNames: false,
    dollarQuotes: true,
    executableComments: false,
    escapeStrings: true,
  },
  functions: functionsFor("postgres"),

  users: postgresUsers,
};
