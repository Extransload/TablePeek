import { PLSQL, SQLDialect } from "@codemirror/lang-sql";
import { quoteLiteral } from "../../dataQuery";
import { columnDef, pkList, quoteIdent, quoteName, type ColumnDraft, type StructureDraft } from "../../ddl";
import { parseOraclePlan } from "../../explainPlan";
import { functionsFor } from "../sqlFunctions";
import type { ColumnChange, SqlDialect } from "../sqlDialect";

// Words Oracle won't take as a bare name (its SQL Reference's reserved words).
const RESERVED = new Set(
  (
    "ACCESS ADD ALL ALTER AND ANY AS ASC AUDIT BETWEEN BY CHAR CHECK CLUSTER COLUMN COLUMN_VALUE COMMENT " +
    "COMPRESS CONNECT CREATE CURRENT DATE DECIMAL DEFAULT DELETE DESC DISTINCT DROP ELSE EXCLUSIVE EXISTS " +
    "FILE FLOAT FOR FROM GRANT GROUP HAVING IDENTIFIED IMMEDIATE IN INCREMENT INDEX INITIAL INSERT INTEGER " +
    "INTERSECT INTO IS LEVEL LIKE LOCK LONG MAXEXTENTS MINUS MLSLABEL MODE MODIFY NESTED_TABLE_ID NOAUDIT " +
    "NOCOMPRESS NOT NOWAIT NULL NUMBER OF OFFLINE ON ONLINE OPTION OR ORDER PCTFREE PRIOR PUBLIC RAW RENAME " +
    "RESOURCE REVOKE ROW ROWID ROWNUM ROWS SELECT SESSION SET SHARE SIZE SMALLINT START SUCCESSFUL SYNONYM " +
    "SYSDATE TABLE THEN TO TRIGGER UID UNION UNIQUE UPDATE USER VALIDATE VALUES VARCHAR VARCHAR2 VIEW " +
    "WHENEVER WHERE WITH"
  ).split(" "),
);

// An unquoted name is read in upper case, so a name already in upper case
// (and no reserved word) reads the same bare: generated SQL says PRODUCTS,
// not "PRODUCTS". Any other name is quoted, which keeps its case.
function bareName(name: string): boolean {
  return /^[A-Z][A-Z0-9_$#]*$/.test(name) && !RESERVED.has(name);
}

// SQL takes a text literal of at most 4000 bytes; longer text (a CLOB's)
// goes in as TO_CLOB pieces joined with ||, each at most 3000 bytes in UTF-8.
const LITERAL_UNITS = 1000;

function stringLiteral(value: string): string {
  if (value.length <= LITERAL_UNITS) {
    return quoteLiteral(value);
  }
  const pieces: string[] = [];
  for (let at = 0; at < value.length; ) {
    let end = Math.min(value.length, at + LITERAL_UNITS);
    // A surrogate pair stays in one piece.
    const last = value.charCodeAt(end - 1);
    if (end < value.length && last >= 0xd800 && last <= 0xdbff) {
      end -= 1;
    }
    pieces.push(`TO_CLOB(${quoteLiteral(value.slice(at, end))})`);
    at = end;
  }
  return pieces.join(" || ");
}

// A DDL statement that may fail because what it drops isn't there, as a
// PL/SQL block ignoring those errors (Oracle before 23ai has no IF EXISTS).
// A file ends it with a "/" line (sqlSplit's scriptStatement).
function ignoring(statement: string, codes: number[]): string {
  return [
    "BEGIN",
    `  EXECUTE IMMEDIATE ${quoteLiteral(statement)};`,
    "EXCEPTION",
    "  WHEN OTHERS THEN",
    `    IF SQLCODE NOT IN (${codes.map((code) => `-${code}`).join(", ")}) THEN`,
    "      RAISE;",
    "    END IF;",
    "END;",
  ].join("\n");
}

// MODIFY restates only what changed: a NOT NULL column made NOT NULL again
// is an error (ORA-01442). DEFAULT NULL takes a default away.
function alterColumn(table: string, column: ColumnDraft, change: ColumnChange): string[] {
  const parts = [quoteName(sql, column.name)];
  if (change.type) {
    parts.push(column.type.trim());
  }
  if (change.def) {
    parts.push(`DEFAULT ${column.def.trim() === "" ? "NULL" : column.def.trim()}`);
  }
  if (change.notNull) {
    parts.push(column.notNull ? "NOT NULL" : "NULL");
  }
  return [`ALTER TABLE ${quoteIdent(sql, table)} MODIFY (${parts.join(" ")})`];
}

// The key is dropped by what it is, whatever its constraint is named.
function changePrimaryKey(table: string, orig: StructureDraft, next: StructureDraft): string[] {
  const quoted = quoteIdent(sql, table);
  const nextPk = pkList(next.columns);
  return [
    ...(pkList(orig.columns).length > 0 ? [`ALTER TABLE ${quoted} DROP PRIMARY KEY`] : []),
    ...(nextPk.length > 0 ? [`ALTER TABLE ${quoted} ADD PRIMARY KEY (${nextPk.map((name) => quoteName(sql, name)).join(", ")})`] : []),
  ];
}

// The session's formats dumps write DATE and TIMESTAMP values in, so their
// plain '…' literals load back; a restore puts the old ones back after.
const NLS_FORMATS: [string, string][] = [
  ["NLS_DATE_FORMAT", "YYYY-MM-DD HH24:MI:SS"],
  ["NLS_TIMESTAMP_FORMAT", "YYYY-MM-DD HH24:MI:SS.FF"],
  ["NLS_TIMESTAMP_TZ_FORMAT", "YYYY-MM-DD HH24:MI:SS.FF TZH:TZM"],
];

const editor = SQLDialect.define({
  ...PLSQL.spec,
  keywords:
    `${PLSQL.spec.keywords ?? ""} fetch first next offset rows only merge matched using returning pivot unpivot ` +
    "within bulk collect forall pipelined deterministic editionable noneditionable synonym package body " +
    "materialized refresh identity generated purge cascade constraints",
  types:
    `${PLSQL.spec.types ?? ""} nchar nclob clob raw binary_float binary_double timestamp interval pls_integer ` +
    "binary_integer boolean json urowid xmltype",
  builtin: "sysdate systimestamp current_date current_timestamp localtimestamp user uid rownum rowid level dual sqlcode sqlerrm",
  // "…" is a name in Oracle, not text (lang-sql's PLSQL reads it as text).
  doubleQuotedStrings: false,
});

// Oracle: upper-case bare names, '…' text (TO_CLOB pieces past 4000 bytes),
// OFFSET … FETCH paging, PL/SQL blocks ended by "/" lines and conditional
// drops written as blocks.
export const sql: SqlDialect = {
  quotePart: (part) => (bareName(part) ? part : `"${part.replace(/"/g, '""')}"`),
  bareName,
  // The schema is the user logged in, which names are listed without.
  defaultSchema: null,

  stringLiteral,
  // NUMBER(1) flags take 1 and 0, and 23ai's BOOLEAN takes them too.
  booleanLiteral: (value) => (value ? "1" : "0"),
  binaryLiteral: (hex) => `HEXTORAW('${hex.toUpperCase()}')`,
  bareHexIsBinary: true,
  nowSql: "SYSDATE",
  nowLabel: "SYSDATE",

  likeSpecials: /[!%_]/g,

  // OFFSET … FETCH (12c and later) needs no ORDER BY.
  rowWindow: (order, limit, offset) => {
    const window = offset > 0 ? `OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY` : `FETCH FIRST ${limit} ROWS ONLY`;
    return order === null ? window : `ORDER BY ${order} ${window}`;
  },
  firstRows: (quotedTable, select, rows) => `SELECT ${select} FROM ${quotedTable} FETCH FIRST ${rows} ROWS ONLY;`,
  firstRowsName: "FETCH FIRST",
  implicitRowOrder: null,
  // No DEFAULT VALUES: one column at its default fills the rest with theirs.
  emptyInsert: (quotedTable, quotedColumn) => `INSERT INTO ${quotedTable} (${quotedColumn}) VALUES (DEFAULT);`,
  singleRowValues: true,

  rebuildsTable: false,
  addColumn: (table, column) => [`ALTER TABLE ${quoteIdent(sql, table)} ADD (${columnDef(sql, column)})`],
  alterColumn,
  changePrimaryKey,
  truncateStatement: "TRUNCATE TABLE",
  truncateTogether: false,
  // ORA-00942: no such table or view.
  dropIfExists: (quoted, object) => ignoring(`DROP ${object === "view" ? "VIEW" : "TABLE"} ${quoted}`, [942]),
  // ORA-02443: no such constraint.
  dropForeignKeyIfExists: (table, fk) =>
    ignoring(`ALTER TABLE ${quoteIdent(sql, table)} DROP CONSTRAINT ${quoteName(sql, fk.name)}`, [942, 2443]),
  newColumnType: "VARCHAR2(255 CHAR)",
  columnTypes: [
    "NUMBER(10)", "NUMBER(19)", "NUMBER(12,2)", "NUMBER", "NUMBER GENERATED BY DEFAULT AS IDENTITY",
    "VARCHAR2(255 CHAR)", "NVARCHAR2(255)", "CHAR(1)", "CLOB", "BLOB", "RAW(16)", "DATE", "TIMESTAMP",
    "TIMESTAMP WITH TIME ZONE", "INTERVAL DAY TO SECOND", "BINARY_DOUBLE", "BOOLEAN", "JSON",
  ],
  columnDefaults: ["SYSDATE", "SYSTIMESTAMP", "SYS_GUID()", "USER"],

  dumpBefore: `ALTER SESSION SET ${NLS_FORMATS.map(([name, format]) => `${name} = '${format}'`).join(" ")};`,
  keysInCreate: false,
  sessionSnapshot: `SELECT ${NLS_FORMATS.map(([name]) => `(SELECT VALUE FROM NLS_SESSION_PARAMETERS WHERE PARAMETER = '${name}')`).join(", ")} FROM DUAL`,
  restoreSession: (row) => {
    const sets = NLS_FORMATS.flatMap(([name], index) => {
      const value = row[index];
      return typeof value === "string" && value !== "" ? [`${name} = ${quoteLiteral(value)}`] : [];
    });
    return sets.length === 0 ? null : `ALTER SESSION SET ${sets.join(" ")}`;
  },

  // PL/SQL units end with a "/" line, as SQL*Plus and the editor read them.
  templates: {
    view: "CREATE OR REPLACE VIEW V_NAME AS\nSELECT 1 AS ONE FROM DUAL;",
    materialized_view: [
      "CREATE MATERIALIZED VIEW MV_NAME",
      "  BUILD IMMEDIATE",
      "  REFRESH COMPLETE ON DEMAND",
      "AS",
      "SELECT 1 AS ONE FROM DUAL;",
    ].join("\n"),
    sequence: "CREATE SEQUENCE SEQ_NAME\n  START WITH 1\n  INCREMENT BY 1\n  NOCACHE;",
    synonym: "CREATE OR REPLACE SYNONYM SYN_NAME FOR OWNER_NAME.TABLE_NAME;",
    function: [
      "CREATE OR REPLACE FUNCTION FN_NAME (p_x IN NUMBER) RETURN NUMBER IS",
      "BEGIN",
      "  RETURN p_x + 1;",
      "END;",
      "/",
    ].join("\n"),
    procedure: [
      "CREATE OR REPLACE PROCEDURE SP_NAME (p_x IN NUMBER) IS",
      "BEGIN",
      "  DBMS_OUTPUT.PUT_LINE(p_x);",
      "END;",
      "/",
    ].join("\n"),
    package: [
      "CREATE OR REPLACE PACKAGE PKG_NAME AS",
      "  FUNCTION add_one (p_x IN NUMBER) RETURN NUMBER;",
      "END PKG_NAME;",
      "/",
      "",
      "CREATE OR REPLACE PACKAGE BODY PKG_NAME AS",
      "  FUNCTION add_one (p_x IN NUMBER) RETURN NUMBER IS",
      "  BEGIN",
      "    RETURN p_x + 1;",
      "  END add_one;",
      "END PKG_NAME;",
      "/",
    ].join("\n"),
    trigger: [
      "CREATE OR REPLACE TRIGGER TRG_NAME",
      "BEFORE INSERT ON TABLE_NAME",
      "FOR EACH ROW",
      "BEGIN",
      "  :NEW.CREATED_AT := SYSDATE;",
      "END;",
      "/",
    ].join("\n"),
    type: [
      "CREATE OR REPLACE TYPE T_NAME AS OBJECT (",
      "  id NUMBER,",
      "  name VARCHAR2(100 CHAR)",
      ");",
      "/",
    ].join("\n"),
  },

  // Plain inserts, and upserts as a MERGE per row (Oracle has no collision
  // clause on INSERT).
  insertModes: ["insert", "upsert"],
  upsertRow: (table, columns, keys, row) => {
    const source = columns.map((column, at) => `${row[at]} AS ${column}`).join(", ");
    const on = keys.map((key) => `t.${key} = s.${key}`).join(" AND ");
    const updated = columns.filter((column) => !keys.includes(column));
    const matched =
      updated.length > 0
        ? ` WHEN MATCHED THEN UPDATE SET ${updated.map((column) => `t.${column} = s.${column}`).join(", ")}`
        : "";
    return (
      `MERGE INTO ${table} t USING (SELECT ${source} FROM DUAL) s ON (${on})${matched}` +
      ` WHEN NOT MATCHED THEN INSERT (${columns.join(", ")}) VALUES (${columns.map((column) => `s.${column}`).join(", ")})`
    );
  },
  replaceInto: "REPLACE INTO",
  upsertNeedsKey: true,
  collapseRepeats: false,
  // DDL commits the transaction around it.
  ddlInTransaction: false,
  // NUMBER stops at 38 digits.
  numberAsText: (text) => text.replace(/^-/, "").split(/[eE]/)[0].replace(".", "").replace(/^0+/, "").length > 38,
  importType: (profile) => {
    const { kind } = profile;
    const precision = profile.intDigits + profile.scale;
    if (kind === "decimal") {
      return precision > 0 && precision <= 38 ? `NUMBER(${precision},${profile.scale})` : "BINARY_DOUBLE";
    }
    if (kind === "text") {
      // VARCHAR2 holds 4000 bytes: 1000 characters of up to four bytes each.
      return profile.maxLength > 1000 ? "CLOB" : profile.maxLength > 255 ? "VARCHAR2(1000 CHAR)" : "VARCHAR2(255 CHAR)";
    }
    if (kind === "datetime") {
      // DATE keeps whole seconds.
      return profile.fraction > 0 ? `TIMESTAMP(${Math.min(profile.fraction, 9)})` : "DATE";
    }
    return {
      integer: "NUMBER(10)",
      bigint: "NUMBER(19)",
      double: "BINARY_DOUBLE",
      boolean: "NUMBER(1)",
      date: "DATE",
      datetimetz: "TIMESTAMP WITH TIME ZONE",
    }[kind];
  },
  importExtraTypes: ["VARCHAR2(4000 CHAR)", "CLOB", "TIMESTAMP"],
  importBitIsBoolean: false,

  // 23ai's BOOLEAN comes back as true/false.
  booleanOptions: ["true", "false"],
  gridBitIsBoolean: false,
  timestampIsVersion: false,
  dateHasTime: true,
  blobByName: false,

  // EXPLAIN PLAN fills PLAN_TABLE; the server reads it back through
  // DBMS_XPLAN.DISPLAY, a line of text per row.
  explain: { prefix: "EXPLAIN PLAN FOR ", parse: parseOraclePlan },

  editor,
  lexing: {
    hashComments: false,
    backslashEscapes: false,
    bracketNames: false,
    dollarQuotes: false,
    executableComments: false,
    escapeStrings: false,
    slashBlocks: true,
    qQuotes: true,
  },
  functions: functionsFor("oracle"),

  // Accounts Oracle doesn't maintain itself (ORACLE_MAINTAINED, 12c and later).
  users: {
    listSql: "SELECT USERNAME, TO_CHAR(CREATED, 'YYYY-MM-DD') FROM ALL_USERS WHERE ORACLE_MAINTAINED = 'N' ORDER BY USERNAME",
    readRow: (row) => ({ name: String(row[0] ?? ""), extra: String(row[1] ?? "") }),
    extraLabel: "생성일",
    hostField: false,
    superUserOption: false,
    // A password is a quoted name, never a '…' literal; it can't hold a ".
    createSql: (name, password) => [
      { sql: `CREATE USER ${sql.quotePart(name)} IDENTIFIED BY "${password}"`, secret: true },
      `GRANT CREATE SESSION TO ${sql.quotePart(name)}`,
    ],
    dropSql: (row) => `DROP USER ${sql.quotePart(row.name)} CASCADE`,
    passwordSql: (row, password) => ({
      sql: `ALTER USER ${sql.quotePart(row.name)} IDENTIFIED BY "${password}"`,
      secret: true,
    }),
    createdInfo: "사용자를 생성했습니다: {name}",
    droppedInfo: "사용자를 삭제했습니다: {name}",
  },
};
