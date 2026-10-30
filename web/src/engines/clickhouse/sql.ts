import { SQLDialect, StandardSQL } from "@codemirror/lang-sql";
import { limitWindow } from "../../dataQuery";
import { pkList, quoteIdent, quoteName, splitList, type ColumnDraft, type IndexDraft, type StructureDraft } from "../../ddl";
import type { GridColumnSpec } from "../../grid/columns";
import { JsonNumber } from "../../importParse";
import type { ColumnChange, SqlDialect } from "../sqlDialect";
import { EXPLAIN_PREFIX, parseClickHousePlan } from "./explain";
import { CLICKHOUSE_FUNCTIONS } from "./functions";

// ClickHouse's own words beside standard SQL's, for highlighting and completion.
const KEYWORDS =
  "select from where prewhere group by having order limit offset with totals rollup cube settings format " +
  "into outfile final sample array join left right full inner outer cross semi anti any all asof global " +
  "using on as distinct union intersect except insert values table tables database databases create " +
  "replace alter drop detach attach rename exchange truncate optimize deduplicate partition part update " +
  "delete modify column columns add clear materialize index projection constraint ttl comment codec " +
  "engine primary key if not exists temporary view materialized live window dictionary function " +
  "source lifetime layout range populate to engine show describe desc explain plan pipeline estimate ast " +
  "syntax query tree kill sync async system flush logs reload dictionaries merges fetches watch use set " +
  "grant revoke user role quota profile policy identified by sha256_password plaintext_password " +
  "default materialized alias ephemeral interval case when then else end and or not between like ilike " +
  "in is null nulls first last asc desc collate over partition rows range unbounded preceding following " +
  "current row qualify lightweight cluster freeze unfreeze move volume disk regexp limit by";

// Types, wrappers included, as the structure grid and completion offer them.
const TYPES =
  "UInt8 UInt16 UInt32 UInt64 UInt128 UInt256 Int8 Int16 Int32 Int64 Int128 Int256 Float32 Float64 " +
  "BFloat16 Decimal Decimal32 Decimal64 Decimal128 Decimal256 Bool Boolean String FixedString UUID Date " +
  "Date32 DateTime DateTime64 Time Time64 Enum Enum8 Enum16 IPv4 IPv6 Array Map Tuple Nested Nullable " +
  "LowCardinality JSON Object Dynamic Variant Point Ring Polygon MultiPolygon LineString " +
  "AggregateFunction SimpleAggregateFunction Nothing Interval";

// Bare words ClickHouse reads without a column: formats and table engines,
// so they highlight and complete after FORMAT and ENGINE =.
const BUILTIN =
  "TabSeparated TabSeparatedWithNames CSV CSVWithNames JSON JSONEachRow JSONCompact JSONCompactEachRow " +
  "JSONCompactEachRowWithNamesAndTypes JSONStrings Pretty PrettyCompact PrettySpace Vertical Values " +
  "Parquet Arrow ORC Native RowBinary TSV Markdown XML " +
  "MergeTree ReplacingMergeTree SummingMergeTree AggregatingMergeTree CollapsingMergeTree " +
  "VersionedCollapsingMergeTree GraphiteMergeTree ReplicatedMergeTree Memory Log TinyLog StripeLog " +
  "Distributed Merge Buffer Null Set Join URL File S3 Kafka Dictionary MaterializedView View " +
  "true false NULL";

const editor = SQLDialect.define({
  ...StandardSQL.spec,
  keywords: KEYWORDS,
  types: TYPES,
  builtin: BUILTIN,
  backslashEscapes: true,
  hashComments: true,
  doubleQuotedStrings: false,
  identifierQuotes: "`\"",
  // Names are case-sensitive but need no quotes for upper case.
  caseInsensitiveIdentifiers: true,
});

const BARE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED = new Set(KEYWORDS.split(" ").map((word) => word.toLowerCase()));

// A name that reads the same unquoted: letters, digits and _, and no keyword.
function bareName(name: string): boolean {
  return BARE.test(name) && !RESERVED.has(name.toLowerCase());
}

// Text as ClickHouse reads it: backslashes and quotes escaped by a backslash.
function stringLiteral(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

// A type without Nullable(…) / LowCardinality(…) around it.
function baseType(declared: string): string {
  let type = declared.trim();
  for (;;) {
    const match = /^(?:Nullable|LowCardinality)\((.*)\)$/s.exec(type);
    if (match === null) {
      return type;
    }
    type = match[1].trim();
  }
}

// The type with nullability as the draft says: ClickHouse writes it into
// the type (Nullable(String), LowCardinality(Nullable(String))).
function typeWithNullability(type: string, notNull: boolean): string {
  const trimmed = type.trim();
  const low = /^LowCardinality\((.*)\)$/s.exec(trimmed);
  if (low !== null) {
    return `LowCardinality(${typeWithNullability(low[1], notNull)})`;
  }
  const nullable = /^Nullable\((.*)\)$/s.exec(trimmed);
  if (notNull) {
    return nullable === null ? trimmed : nullable[1].trim();
  }
  // Arrays, maps and tuples can't be Nullable; their elements can.
  return nullable !== null || /^(Array|Map|Tuple|Nested)\(/.test(trimmed) ? trimmed : `Nullable(${trimmed})`;
}

// The default clause: DEFAULT unless the text names its kind already
// (MATERIALIZED a + 1, ALIAS …, EPHEMERAL).
function defaultClause(def: string): string {
  const text = def.trim();
  if (text === "") {
    return "";
  }
  return /^(DEFAULT|MATERIALIZED|ALIAS|EPHEMERAL)\b/i.test(text) ? ` ${text}` : ` DEFAULT ${text}`;
}

function columnDef(column: ColumnDraft): string {
  return `${quoteName(sql, column.name)} ${typeWithNullability(column.type, column.notNull)}${defaultClause(column.def)}`;
}

// MODIFY COLUMN restates the type (nullability inside it); a cleared
// default is removed on its own.
function alterColumn(table: string, column: ColumnDraft, change: ColumnChange): string[] {
  const target = `ALTER TABLE ${quoteIdent(sql, table)} MODIFY COLUMN ${quoteName(sql, column.name)}`;
  const statements: string[] = [];
  if (change.type || change.notNull) {
    statements.push(`${target} ${typeWithNullability(column.type, column.notNull)}`);
  }
  if (change.def) {
    statements.push(column.def.trim() === "" ? `${target} REMOVE DEFAULT` : `${target}${defaultClause(column.def)}`);
  }
  return statements;
}

// The sorting key stands for the primary key; ClickHouse changes it only by
// appending columns added in the same ALTER, which the server checks.
function changePrimaryKey(table: string, _orig: StructureDraft, next: StructureDraft): string[] {
  const key = pkList(next.columns).map((name) => quoteName(sql, name));
  return [`ALTER TABLE ${quoteIdent(sql, table)} MODIFY ORDER BY ${key.length === 0 ? "tuple()" : `(${key.join(", ")})`}`];
}

// A data skipping index over the columns (minmax); existing parts get it
// with ALTER TABLE … MATERIALIZE INDEX.
function createIndex(table: string, index: IndexDraft): string {
  const columns = splitList(index.columns).map((name) => quoteName(sql, name));
  const expression = columns.length === 1 ? columns[0] : `(${columns.join(", ")})`;
  return `ALTER TABLE ${quoteIdent(sql, table)} ADD INDEX ${quoteName(sql, index.name)} ${expression} TYPE minmax GRANULARITY 1`;
}

// MergeTree, sorted by the draft's key, or by nothing (tuple()) without one.
function tableSuffix(draft: StructureDraft): string {
  return pkList(draft.columns).length > 0 ? "\nENGINE = MergeTree" : "\nENGINE = MergeTree\nORDER BY tuple()";
}

// The grid's reading of ClickHouse types.
function cellKind(declType: string): Pick<GridColumnSpec, "kind" | "options"> | null {
  const type = baseType(declType);
  if (type === "Bool" || type === "Boolean") {
    return { kind: "boolean", options: ["true", "false"] };
  }
  if (/^Enum(8|16)?\(/.test(type)) {
    const labels: string[] = [];
    const pattern = /'((?:[^'\\]|\\.)*)'\s*=/g;
    for (let found = pattern.exec(type); found !== null; found = pattern.exec(type)) {
      labels.push(found[1].replace(/\\(.)/g, "$1"));
    }
    return { kind: "enum", options: labels };
  }
  if (/^Date(32)?$/.test(type)) {
    return { kind: "date" };
  }
  if (/^DateTime(64)?\b/.test(type)) {
    return { kind: "datetime" };
  }
  if (/^Time(64)?\b/.test(type)) {
    return { kind: "time" };
  }
  if (/^(U?Int(8|16|32|64|128|256)|Float(32|64)|BFloat16|Decimal(32|64|128|256)?)\b/.test(type)) {
    return { kind: "number" };
  }
  if (/^(Array|Map|Tuple|Nested|JSON|Object)\b/.test(type)) {
    return { kind: "json" };
  }
  return { kind: "text" };
}

// CSV fields for INSERT … FORMAT CSV: ClickHouse reads each by its column's
// type, NULL as \N.
function csvField(value: unknown): string {
  if (value === null || value === undefined) {
    return "\\N";
  }
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  const text = typeof value === "string" ? value : value instanceof JsonNumber ? value.plain : JSON.stringify(value);
  return `"${text.replace(/"/g, '""')}"`;
}

// One name: `…` or "…" with backslash escapes, or a bare word.
const NAME = String.raw`(?:\x60(?:[^\x60\\]|\\.)*\x60|"(?:[^"\\]|\\.)*"|[A-Za-z_][\w$]*)`;
// A structure statement up to the object it names, where ON CLUSTER goes.
const CLUSTER_HEAD = new RegExp(
  String.raw`^\s*(?:CREATE(?:\s+OR\s+REPLACE)?|REPLACE|ALTER|DROP|TRUNCATE|ATTACH|DETACH)\s+` +
    String.raw`(?:TEMPORARY\s+)?(?:TABLE|VIEW|MATERIALIZED\s+VIEW|DICTIONARY|DATABASE)\s+` +
    String.raw`(?:IF\s+(?:NOT\s+)?EXISTS\s+)?${NAME}(?:\s*\.\s*${NAME})?`,
  "i",
);
// RENAME and EXCHANGE take the clause after their last name.
const CLUSTER_TAIL = /^\s*(?:RENAME|EXCHANGE)\s+(?:TABLES?|DICTIONARY|DATABASE)\b/i;

// `statement` run on every server of `cluster`. Another statement (INSERT,
// one that names a cluster already) comes back as it was.
function onCluster(statement: string, cluster: string): string {
  if (/\bON\s+CLUSTER\b/i.test(statement)) {
    return statement;
  }
  const clause = ` ON CLUSTER ${quoteName(sql, cluster)}`;
  const head = CLUSTER_HEAD.exec(statement);
  if (head !== null) {
    return `${head[0]}${clause}${statement.slice(head[0].length)}`;
  }
  if (CLUSTER_TAIL.test(statement)) {
    const body = statement.replace(/\s*;?\s*$/, "");
    return `${body}${clause}${statement.slice(body.length)}`;
  }
  return statement;
}

// ClickHouse: `…` names (backslash escapes), '…' text with backslash
// escapes, no transactions, MergeTree tables keyed by their sorting key.
export const sql: SqlDialect = {
  quotePart: (part) => (bareName(part) ? part : `\`${part.replace(/\\/g, "\\\\").replace(/`/g, "\\`")}\``),
  bareName,
  defaultSchema: null,

  stringLiteral,
  booleanLiteral: (value) => (value ? "true" : "false"),
  binaryLiteral: (hex) => `unhex('${hex.toUpperCase()}')`,
  // String holds bytes and text alike.
  bareHexIsBinary: false,
  nowSql: "now()",
  nowLabel: "now()",

  likeSpecials: /[\\%_]/g,
  backslashLike: true,
  // LIKE takes strings only.
  textMatchColumn: (column) => `toString(${column})`,

  rowWindow: limitWindow,
  firstRows: (quotedTable, select, rows) => `SELECT ${select} FROM ${quotedTable} LIMIT ${rows};`,
  firstRowsName: "SELECT LIMIT",
  implicitRowOrder: null,
  // A row's part and its place in it: rows sharing a sorting key stay editable.
  rowIdentity: ["_part", "_part_offset"],
  clusters: { listSql: "SELECT DISTINCT cluster FROM system.clusters ORDER BY cluster", onCluster },
  // The structure pane's "경량 UPDATE: 꺼짐" (25.7+ servers, MergeTree
  // tables) offers to turn on the two block columns lightweight UPDATE
  // finds rows by, so cell edits stop rewriting parts.
  propertyAction: (property, table) =>
    property.name === "경량 UPDATE" && property.value === "꺼짐"
      ? {
          label: "켜기",
          title: "경량 UPDATE 켜기",
          message:
            "테이블 설정 enable_block_number_column과 enable_block_offset_column을 켭니다. 그 뒤 셀 수정은 파트 전체를 다시 쓰는 뮤테이션(ALTER TABLE … UPDATE) 대신 바뀐 행만 패치 파트로 쓰는 경량 UPDATE(UPDATE … SET)로 바로 끝납니다. 행마다 블록 번호와 위치가 저장되어 디스크를 조금 더 쓰며, 이미 있는 파트도 그대로 경량 UPDATE를 받습니다.",
          statement: `ALTER TABLE ${quoteIdent(sql, table)} MODIFY SETTING enable_block_number_column = 1, enable_block_offset_column = 1`,
        }
      : null,
  emptyInsert: (quotedTable) => `INSERT INTO ${quotedTable} FORMAT JSONEachRow {}`,
  insertRows: (quotedTable, quotedColumns, rows) =>
    `INSERT INTO ${quotedTable} (${quotedColumns.join(", ")}) FORMAT CSV\n${rows.map((row) => row.map(csvField).join(",")).join("\n")}`,
  importChunkRows: 10000,
  nativeExport: true,
  snippets: (quoted) => [
    { name: "COUNT", sql: `SELECT count() FROM ${quoted};` },
    { name: "INSERT", sql: `INSERT INTO ${quoted} (column1, column2) VALUES (value1, value2);` },
    { name: "ALTER UPDATE", sql: `ALTER TABLE ${quoted} UPDATE column1 = value1 WHERE id = 1 SETTINGS mutations_sync = 2;` },
    { name: "DELETE WHERE", sql: `DELETE FROM ${quoted} WHERE id = 1;` },
    { name: "ADD INDEX", sql: `ALTER TABLE ${quoted} ADD INDEX idx_column1 column1 TYPE minmax GRANULARITY 1;` },
    { name: "OPTIMIZE FINAL", sql: `OPTIMIZE TABLE ${quoted} FINAL;` },
    { name: "EXPLAIN PIPELINE", sql: `EXPLAIN PIPELINE SELECT * FROM ${quoted};` },
    { name: "EXPLAIN ESTIMATE", sql: `EXPLAIN ESTIMATE SELECT * FROM ${quoted};` },
  ],

  rebuildsTable: false,
  columnDef,
  alterColumn,
  changePrimaryKey,
  createIndex,
  dropIndex: (table, name) => `ALTER TABLE ${quoteIdent(sql, table)} DROP INDEX ${quoteName(sql, name)}`,
  tableSuffix,
  renameTable: (table, newName) => {
    const dot = table.lastIndexOf(".");
    const target = newName.includes(".") || dot < 0 ? newName : `${table.slice(0, dot)}.${newName}`;
    return `RENAME TABLE ${quoteIdent(sql, table)} TO ${quoteIdent(sql, target)}`;
  },
  truncateStatement: "TRUNCATE TABLE",
  truncateTogether: false,
  copyTable: (quotedTarget, quotedSource) => `CREATE TABLE ${quotedTarget} AS ${quotedSource};\nINSERT INTO ${quotedTarget} SELECT * FROM ${quotedSource}`,
  dropIfExists: (quoted, object) => `DROP ${object === "view" ? "VIEW" : "TABLE"} IF EXISTS ${quoted}`,
  columnTypes: [
    "UInt32", "UInt64", "Int32", "Int64", "Float64", "Decimal(18, 2)", "Bool", "String",
    "LowCardinality(String)", "FixedString(16)", "UUID", "Date", "DateTime", "DateTime64(3)",
    "Enum8('a' = 1, 'b' = 2)", "Array(String)", "Map(String, String)", "Tuple(a UInt32, b String)",
    "IPv4", "IPv6", "JSON",
  ],
  columnDefaults: ["now()", "now64(3)", "today()", "generateUUIDv4()", "''", "0"],

  keysInCreate: true,

  templates: {
    view: "CREATE VIEW v_name AS\nSELECT 1 AS one;",
    materialized_view: [
      "CREATE MATERIALIZED VIEW mv_name TO target_table AS",
      "SELECT toDate(ts) AS day, count() AS hits",
      "FROM source_table",
      "GROUP BY day;",
    ].join("\n"),
    dictionary: [
      "CREATE DICTIONARY dict_name",
      "(",
      "  id UInt64,",
      "  name String",
      ")",
      "PRIMARY KEY id",
      "SOURCE(CLICKHOUSE(TABLE 'source_table'))",
      "LIFETIME(MIN 300 MAX 600)",
      "LAYOUT(HASHED());",
    ].join("\n"),
    function: "CREATE FUNCTION fn_name AS (x) -> x + 1;",
  },
  dropKeywords: { materialized_view: "VIEW" },

  insertModes: ["insert"],
  replaceInto: "INSERT INTO",
  upsertNeedsKey: false,
  collapseRepeats: false,
  ddlInTransaction: false,
  importType: (profile) => {
    const { kind } = profile;
    if (kind === "decimal") {
      const precision = profile.intDigits + profile.scale;
      return precision > 0 && precision <= 76 ? `Decimal(${Math.max(precision, 1)}, ${profile.scale})` : "Float64";
    }
    if (kind === "datetime") {
      return profile.fraction > 0 ? `DateTime64(${Math.min(profile.fraction, 9)})` : "DateTime";
    }
    const types: Record<string, string> = {
      integer: "Int32",
      bigint: "Int64",
      double: "Float64",
      boolean: "Bool",
      date: "Date",
      datetimetz: "DateTime64(3)",
      text: "String",
    };
    return types[kind] ?? "String";
  },
  importExtraTypes: ["LowCardinality(String)", "UInt64", "JSON"],
  importBitIsBoolean: false,

  booleanOptions: ["true", "false"],
  gridBitIsBoolean: false,
  timestampIsVersion: false,
  blobByName: false,
  cellKind,

  explain: { prefix: EXPLAIN_PREFIX, parse: parseClickHousePlan },

  editor,
  lexing: {
    hashComments: true,
    backslashEscapes: true,
    bracketNames: false,
    dollarQuotes: true,
    executableComments: false,
    escapeStrings: false,
  },
  functions: CLICKHOUSE_FUNCTIONS,
  namesKeepCase: [...TYPES.split(" "), ...BUILTIN.split(" ")],

  users: {
    listSql: "SELECT name, auth_type FROM system.users ORDER BY name",
    // auth_type is an array since 24.x (["sha256_password"]), one word before.
    readRow: (row) => ({
      name: String(row[0] ?? ""),
      extra: String(row[1] ?? "").replace(/^\[|\]$/g, "").replace(/"/g, "").replace(/,/g, ", "),
    }),
    extraLabel: "인증 방식",
    hostField: false,
    superUserOption: false,
    createSql: (name, password) => [
      {
        sql: `CREATE USER ${quoteName(sql, name)} IDENTIFIED WITH sha256_password BY ${stringLiteral(password)}`,
        secret: true,
      },
    ],
    dropSql: (row) => `DROP USER ${quoteName(sql, row.name)}`,
    passwordSql: (row, password) => ({
      sql: `ALTER USER ${quoteName(sql, row.name)} IDENTIFIED WITH sha256_password BY ${stringLiteral(password)}`,
      secret: true,
    }),
    createdInfo: "사용자를 생성했습니다: {name}",
    droppedInfo: "사용자를 삭제했습니다: {name}",
  },
};
