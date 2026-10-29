import { MSSQL } from "@codemirror/lang-sql";
import { quoteLiteral } from "../../dataQuery";
import { columnDef, quoteIdent, type ColumnDraft } from "../../ddl";
import { functionsFor } from "../sqlFunctions";
import type { ColumnChange, SqlDialect } from "../sqlDialect";

// A default is a named constraint in T-SQL; one made here is named after
// its table and column.
function defaultName(table: string, column: string): string {
  return sql.quotePart(`DF_${table.replace(/\./g, "_")}_${column}`);
}

// T-SQL adds a column with a bare ADD, and its default goes in as a named
// constraint in the same statement, so a NOT NULL column fills existing rows.
function addColumn(table: string, column: ColumnDraft): string[] {
  const def = column.def.trim();
  const constraint = def === "" ? "" : ` CONSTRAINT ${defaultName(table, column.name)} DEFAULT ${def}`;
  return [`ALTER TABLE ${quoteIdent(sql, table)} ADD ${columnDef(sql, { ...column, def: "" })}${constraint}`];
}

// A column's default constraint, whatever the server named it, looked up in
// sys.default_constraints and dropped in the same batch (no ; inside, so the
// editor keeps it one statement). EXEC takes no function call, so the
// statement is built first.
function dropDefault(table: string, column: string): string {
  const quoted = quoteIdent(sql, table);
  return [
    `DECLARE @drop nvarchar(max) = (SELECT ${sql.stringLiteral(`ALTER TABLE ${quoted} DROP CONSTRAINT `)} + QUOTENAME(dc.name)`,
    "FROM sys.default_constraints dc",
    "JOIN sys.columns c ON c.object_id = dc.parent_object_id AND c.column_id = dc.parent_column_id",
    `WHERE dc.parent_object_id = OBJECT_ID(${sql.stringLiteral(quoted)}) AND c.name = ${sql.stringLiteral(column)})`,
    "IF @drop IS NOT NULL EXEC(@drop)",
  ].join("\n");
}

// ALTER COLUMN restates the type and nullability; a new default replaces the
// old constraint.
function alterColumn(table: string, column: ColumnDraft, change: ColumnChange): string[] {
  const statements: string[] = [];
  if (change.type || change.notNull) {
    statements.push(
      `ALTER TABLE ${quoteIdent(sql, table)} ALTER COLUMN ${quoteIdent(sql, column.name)} ${column.type.trim()} ${column.notNull ? "NOT NULL" : "NULL"}`,
    );
  }
  if (change.def) {
    statements.push(dropDefault(table, column.name));
    if (column.def.trim() !== "") {
      statements.push(
        `ALTER TABLE ${quoteIdent(sql, table)} ADD CONSTRAINT ${defaultName(table, column.name)} DEFAULT ${column.def.trim()} FOR ${quoteIdent(sql, column.name)}`,
      );
    }
  }
  return statements;
}

// sp_rename takes the new name alone, in the table's own schema.
function renameTable(table: string, newName: string): string {
  const target = newName.includes(".")
    ? newName
    : table.split(".")[0]
      ? `${table.split(".")[0]}.${newName}`
      : newName;
  return `EXEC sp_rename N'${table}', N'${target.split(".").pop() ?? target}'`;
}

// SQL Server: [names], N'…' text, bit for booleans, OFFSET … FETCH paging
// and T-SQL's own spellings for renames, copies and conditional drops.
export const sql: SqlDialect = {
  quotePart: (part) => `[${part.replace(/]/g, "]]")}]`,
  defaultSchema: "dbo",

  // Without N, non-ASCII text (Korean) goes through the database's code
  // page and no longer matches an nvarchar value.
  stringLiteral: (value) => `N${quoteLiteral(value)}`,
  // bit takes 1 and 0; there is no TRUE.
  booleanLiteral: (value) => (value ? "1" : "0"),
  binaryLiteral: (hex) => `0x${hex.toUpperCase()}`,
  bareHexIsBinary: true,
  nowSql: "GETDATE()",
  nowLabel: "GETDATE()",

  // [ opens a character class in SQL Server's LIKE.
  likeSpecials: /[!%_[]/g,

  // No LIMIT: OFFSET … FETCH pages, and needs an ORDER BY, so a table with
  // no order to give is read as it comes.
  rowWindow: (order, limit, offset) =>
    `ORDER BY ${order ?? "(SELECT NULL)"} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`,
  firstRows: (quotedTable, select, rows) => `SELECT TOP ${rows} ${select} FROM ${quotedTable};`,
  firstRowsName: "SELECT TOP",
  implicitRowOrder: null,
  emptyInsert: (quotedTable) => `INSERT INTO ${quotedTable} DEFAULT VALUES;`,

  rebuildsTable: false,
  addColumn,
  renameColumn: (table, from, to) => `EXEC sp_rename N'${table}.${from}', N'${to}', 'COLUMN'`,
  alterColumn,
  dropIndex: (table, name) => `DROP INDEX ${quoteIdent(sql, name)} ON ${quoteIdent(sql, table)}`,
  // A column with a default can't go before its constraint does.
  dropColumn: (table, column) => [
    dropDefault(table, column),
    `ALTER TABLE ${quoteIdent(sql, table)} DROP COLUMN ${quoteIdent(sql, column)}`,
  ],
  indexesHoldColumns: true,
  renameTable,
  truncateStatement: "TRUNCATE TABLE",
  truncateTogether: false,
  copyTable: (quotedTarget, quotedSource) => `SELECT * INTO ${quotedTarget} FROM ${quotedSource};`,
  // DROP … IF EXISTS needs SQL Server 2016; OBJECT_ID works on older servers too.
  dropIfExists: (quoted, object) =>
    `IF OBJECT_ID(N'${quoted.replace(/'/g, "''")}', N'${object === "view" ? "V" : "U"}') IS NOT NULL DROP ${object === "view" ? "VIEW" : "TABLE"} ${quoted}`,
  dropForeignKeyIfExists: (table, fk) => {
    // A constraint is named within its table's schema.
    const name = quoteIdent(sql, fk.name);
    const dot = table.lastIndexOf(".");
    const qualified = dot < 0 ? name : `${quoteIdent(sql, table.slice(0, dot))}.${name}`;
    return `IF OBJECT_ID(N'${qualified.replace(/'/g, "''")}', N'F') IS NOT NULL ALTER TABLE ${quoteIdent(sql, table)} DROP CONSTRAINT ${name}`;
  },
  columnTypes: [
    "int", "bigint", "smallint", "bit", "decimal(18,2)", "float", "nvarchar(255)",
    "varchar(255)", "nvarchar(max)", "char(32)", "date", "datetime2", "datetimeoffset",
    "uniqueidentifier", "varbinary(max)",
  ],
  columnDefaults: ["GETDATE()", "SYSDATETIME()", "NEWID()"],

  keysInCreate: false,

  templates: {
    view: "CREATE VIEW dbo.v_name AS\nSELECT 1 AS one;",
    function: [
      "CREATE FUNCTION dbo.fn_name (@x INT)",
      "RETURNS INT",
      "AS",
      "BEGIN",
      "  RETURN @x + 1;",
      "END;",
    ].join("\n"),
    procedure: [
      "CREATE PROCEDURE dbo.sp_name",
      "  @x INT",
      "AS",
      "BEGIN",
      "  SELECT @x AS x;",
      "END;",
    ].join("\n"),
    trigger: [
      "CREATE TRIGGER dbo.trg_name",
      "ON dbo.table_name",
      "AFTER INSERT",
      "AS",
      "BEGIN",
      "  SET NOCOUNT ON;",
      "END;",
    ].join("\n"),
    sequence: "CREATE SEQUENCE dbo.seq_name\n  AS BIGINT\n  START WITH 1\n  INCREMENT BY 1;",
  },

  // Only plain inserts: no upsert or REPLACE.
  insertModes: ["insert"],
  replaceInto: "REPLACE INTO",
  upsertNeedsKey: true,
  collapseRepeats: false,
  ddlInTransaction: true,
  // Numerics stop at 38 digits.
  numberAsText: (text) => text.replace(/^-/, "").split(/[eE]/)[0].replace(".", "").replace(/^0+/, "").length > 38,
  importType: (profile) => {
    const { kind } = profile;
    const precision = profile.intDigits + profile.scale;
    if (kind === "decimal") {
      return precision > 0 && precision <= 38 ? `decimal(${precision},${profile.scale})` : "float";
    }
    if (kind === "text") {
      return profile.maxLength > 4000 ? "nvarchar(max)" : profile.maxLength > 255 ? "nvarchar(4000)" : "nvarchar(255)";
    }
    return {
      integer: "int",
      bigint: "bigint",
      double: "float",
      boolean: "bit",
      date: "date",
      datetime: "datetime2",
      datetimetz: "datetimeoffset",
    }[kind];
  },
  importExtraTypes: [],
  importBitIsBoolean: true,

  // bit comes back as true/false.
  booleanOptions: ["true", "false"],
  gridBitIsBoolean: true,
  // timestamp is rowversion, a binary counter, not a time.
  timestampIsVersion: true,
  blobByName: false,

  editor: MSSQL,
  lexing: {
    hashComments: false,
    backslashEscapes: false,
    bracketNames: true,
    dollarQuotes: false,
    executableComments: false,
    escapeStrings: false,
  },
  functions: functionsFor("mssql"),

  users: {
    listSql: "SELECT name, type_desc FROM sys.server_principals WHERE type IN ('S','U','G') ORDER BY name",
    readRow: (row) => ({ name: String(row[0] ?? ""), extra: String(row[1] ?? "") }),
    extraLabel: "유형",
    hostField: false,
    superUserOption: false,
    createSql: (name, password) => [
      { sql: `CREATE LOGIN ${sql.quotePart(name)} WITH PASSWORD = ${quoteLiteral(password)}`, secret: true },
    ],
    dropSql: (row) => `DROP LOGIN ${sql.quotePart(row.name)}`,
    passwordSql: (row, password) => ({
      sql: `ALTER LOGIN ${sql.quotePart(row.name)} WITH PASSWORD = ${quoteLiteral(password)}`,
      secret: true,
    }),
    createdInfo: "로그인을 생성했습니다: {name}",
    droppedInfo: "로그인을 삭제했습니다: {name}",
  },
};
