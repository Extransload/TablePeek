import { MySQL } from "@codemirror/lang-sql";
import { limitWindow, quoteLiteral } from "../../dataQuery";
import { columnDef, pkList, quoteIdent, type CreateTableOptions, type StructureDraft } from "../../ddl";
import { parseMysqlPlan } from "../../explainPlan";
import { functionsFor } from "../sqlFunctions";
import type { SqlDialect } from "../sqlDialect";

// Session settings mysqldump's files set for their own run (and put back by
// their last lines), kept around a restore.
const SESSION_SETTINGS = [
  "foreign_key_checks",
  "unique_checks",
  "sql_mode",
  "time_zone",
  "sql_notes",
  "character_set_client",
  "character_set_results",
  "collation_connection",
];

function settingValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  const text = String(value);
  return /^\d+$/.test(text) ? text : quoteLiteral(text);
}

// Text as MySQL reads it: a backslash is an escape (unless the server runs
// with NO_BACKSLASH_ESCAPES), so it is doubled.
function stringLiteral(value: string): string {
  return quoteLiteral(value.replace(/\\/g, "\\\\"));
}

function changePrimaryKey(table: string, orig: StructureDraft, next: StructureDraft): string[] {
  const statements: string[] = [];
  const nextPk = pkList(next.columns);
  if (pkList(orig.columns).length > 0) {
    statements.push(`ALTER TABLE ${quoteIdent(sql, table)} DROP PRIMARY KEY`);
  }
  if (nextPk.length > 0) {
    statements.push(
      `ALTER TABLE ${quoteIdent(sql, table)} ADD PRIMARY KEY (${nextPk.map((name) => quoteIdent(sql, name)).join(", ")})`,
    );
  }
  return statements;
}

// ENGINE=, DEFAULT CHARSET=, COLLATE=, ROW_FORMAT= and COMMENT= after
// CREATE TABLE's closing parenthesis.
function tableOptions(options: CreateTableOptions): string {
  const parts: string[] = [];
  if (options.engine && options.engine.trim() !== "") {
    parts.push(`ENGINE=${options.engine.trim()}`);
  }
  if (options.charset && options.charset.trim() !== "") {
    parts.push(`DEFAULT CHARSET=${options.charset.trim()}`);
  }
  if (options.collation && options.collation.trim() !== "") {
    parts.push(`COLLATE=${options.collation.trim()}`);
  }
  if (options.rowFormat && options.rowFormat.trim() !== "") {
    parts.push(`ROW_FORMAT=${options.rowFormat.trim().toUpperCase()}`);
  }
  if (options.comment && options.comment.trim() !== "") {
    // A quote escaped with a backslash, as MySQL also reads it.
    parts.push(`COMMENT='${options.comment.trim().replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`);
  }
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

// MySQL and MariaDB: `…` names, backslash escapes and # comments, ON
// DUPLICATE KEY upserts, and DDL that commits around itself.
export const sql: SqlDialect = {
  quotePart: (part) => `\`${part.replace(/`/g, "``")}\``,
  defaultSchema: null,

  stringLiteral,
  booleanLiteral: (value) => (value ? "TRUE" : "FALSE"),
  binaryLiteral: (hex) => `X'${hex.toUpperCase()}'`,
  bareHexIsBinary: true,
  nowSql: "NOW()",
  nowLabel: "NOW()",

  likeSpecials: /[!%_]/g,

  rowWindow: limitWindow,
  firstRows: (quotedTable, select, rows) => `SELECT ${select} FROM ${quotedTable} LIMIT ${rows};`,
  firstRowsName: "SELECT LIMIT",
  implicitRowOrder: null,
  emptyInsert: (quotedTable) => `INSERT INTO ${quotedTable} () VALUES ();`,

  rebuildsTable: false,
  alterColumn: (table, column) => [`ALTER TABLE ${quoteIdent(sql, table)} MODIFY COLUMN ${columnDef(sql, column)}`],
  changePrimaryKey,
  // MySQL names the table an index belongs to: DROP INDEX i ON t.
  dropIndex: (table, name) => `DROP INDEX ${quoteIdent(sql, name)} ON ${quoteIdent(sql, table)}`,
  dropForeignKey: (table, name) => `ALTER TABLE ${quoteIdent(sql, table)} DROP FOREIGN KEY ${quoteIdent(sql, name)}`,
  tableOptions,
  renameTable: (table, newName) => `RENAME TABLE ${quoteIdent(sql, table)} TO ${quoteIdent(sql, newName)}`,
  truncateStatement: "TRUNCATE TABLE",
  truncateTogether: false,
  laravelEngine: "InnoDB",
  columnTypes: [
    "int", "bigint", "smallint", "tinyint(1)", "decimal(10,2)", "float", "double",
    "varchar(255)", "char(32)", "text", "longtext", "json", "date", "datetime",
    "datetime(6)", "timestamp", "time", "blob",
  ],
  columnDefaults: ["CURRENT_TIMESTAMP", "CURRENT_TIMESTAMP(6)", "(UUID())"],

  // Foreign key checks go off while a dump runs, so tables and rows load in
  // any order; DROP needs no unlinking under them either.
  dumpBefore: "SET FOREIGN_KEY_CHECKS = 0;",
  dumpAfter: "SET FOREIGN_KEY_CHECKS = 1;",
  keysInCreate: false,
  sessionSnapshot: `SELECT ${SESSION_SETTINGS.map((name) => `@@SESSION.${name}`).join(", ")}`,
  restoreSession: (row) =>
    `SET SESSION ${SESSION_SETTINGS.map((name, index) => `${name} = ${settingValue(row[index])}`).join(", ")}`,

  templates: {
    view: "CREATE OR REPLACE VIEW v_name AS\nSELECT 1 AS one;",
    function: "CREATE FUNCTION fn_name(x INT) RETURNS INT\nDETERMINISTIC\nRETURN x + 1;",
    procedure: "CREATE PROCEDURE sp_name(IN x INT)\nSELECT x;",
    trigger: "CREATE TRIGGER trg_name\nAFTER INSERT ON table_name FOR EACH ROW\nSET @flag = 1;",
  },

  insertModes: ["insert", "upsert", "replace"],
  replaceInto: "REPLACE INTO",
  upsertNeedsKey: false,
  upsertClause: (columns, updated, quote) => {
    // Nothing but key columns: a no-op update keeps the row and skips the error.
    const sets =
      updated.length > 0
        ? updated.map((name) => `${quote(name)} = VALUES(${quote(name)})`)
        : [`${quote(columns[0])} = ${quote(columns[0])}`];
    return `ON DUPLICATE KEY UPDATE ${sets.join(", ")}`;
  },
  collapseRepeats: false,
  ddlInTransaction: false,
  importType: (profile) => {
    const { kind } = profile;
    const precision = profile.intDigits + profile.scale;
    if (kind === "decimal") {
      return precision > 0 && precision <= 65 && profile.scale <= 30
        ? `decimal(${Math.max(precision, 1)},${profile.scale})`
        : "double";
    }
    if (kind === "datetime") {
      return profile.fraction > 0 ? `datetime(${Math.min(profile.fraction, 6)})` : "datetime";
    }
    if (kind === "text" || kind === "datetimetz") {
      // TEXT holds 65,535 bytes: 16,383 characters of four bytes each.
      return profile.maxLength > 16383 ? "longtext" : "text";
    }
    return { integer: "int", bigint: "bigint", double: "double", boolean: "tinyint(1)", date: "date" }[kind];
  },
  importExtraTypes: ["varchar(255)", "json"],
  importBitIsBoolean: true,

  // MySQL stores booleans as 1/0.
  booleanOptions: ["1", "0"],
  gridBitIsBoolean: false,
  timestampIsVersion: false,
  blobByName: false,

  // The plan view reads the JSON form; plain EXPLAIN's table it can't draw.
  explain: { prefix: "EXPLAIN FORMAT=JSON ", parse: (_columns, rows) => parseMysqlPlan(rows) },

  editor: MySQL,
  lexing: {
    hashComments: true,
    backslashEscapes: true,
    bracketNames: false,
    dollarQuotes: false,
    executableComments: true,
    escapeStrings: false,
  },
  functions: functionsFor("mysql"),

  users: {
    listSql: "SELECT user, host FROM mysql.user ORDER BY user, host",
    readRow: (row) => ({ name: String(row[0] ?? ""), extra: String(row[1] ?? "") }),
    extraLabel: "호스트",
    hostField: true,
    superUserOption: false,
    createSql: (name, password, host) => [
      {
        sql: `CREATE USER ${quoteLiteral(name)}@${quoteLiteral(host.trim() || "%")} IDENTIFIED BY ${quoteLiteral(password)}`,
        secret: true,
      },
    ],
    dropSql: (row) => `DROP USER ${quoteLiteral(row.name)}@${quoteLiteral(row.extra)}`,
    passwordSql: (row, password) => ({
      sql: `ALTER USER ${quoteLiteral(row.name)}@${quoteLiteral(row.extra)} IDENTIFIED BY ${quoteLiteral(password)}`,
      secret: true,
    }),
    createdInfo: "사용자를 생성했습니다: {name}",
    droppedInfo: "사용자를 삭제했습니다: {name}",
  },
};
