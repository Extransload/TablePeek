import { SQLDialect } from "@codemirror/lang-sql";
import { quoteLiteral } from "../../dataQuery";
import { quoteIdent } from "../../ddl";
import type { ParsedPlan, PlanNode } from "../../explainPlan";
import { t } from "../../i18n";
import type { SqlDialect, UserAdmin } from "../sqlDialect";
import type { SqlFunction } from "../sqlFunctions";

// CQL's own types; anything else a column is declared as names a UDT.
const NATIVE_TYPES = new Set([
  "ascii", "bigint", "blob", "boolean", "counter", "date", "decimal", "double", "duration", "float",
  "inet", "int", "smallint", "text", "time", "timestamp", "timeuuid", "tinyint", "uuid", "varchar", "varint",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_TYPES = new Set(["tinyint", "smallint", "int", "bigint", "varint", "counter", "float", "double", "decimal"]);
const DURATION = /^-?(?:\d+(?:y|mo|w|d|h|m|s|ms|us|µs|ns))+$/i;

// A CQL type that holds JSON-shaped values: collections, tuples, vectors,
// frozen values and UDTs.
function structured(declared: string): boolean {
  const type = declared.trim().toLowerCase();
  return /^(frozen|list|set|map|tuple|vector)\s*</.test(type) || !NATIVE_TYPES.has(type);
}

const KEYWORDS =
  "add aggregate all allow alter and apply as asc ascii authorize batch begin by called clustering columnfamily " +
  "compact contains count counter create custom delete desc describe distinct drop entries execute exists filtering " +
  "finalfunc from frozen full function functions grant if in index initcond input insert into is json key keys " +
  "keyspace keyspaces language limit list login materialized modify nan norecursive nosuperuser not null of on or " +
  "order partition password per permission permissions primary rename replace returns revoke role roles schema " +
  "select set sfunc static storage stype superuser table tables text to token trigger truncate ttl tuple type unlogged " +
  "update use user users using values view where with writetime maxwritetime infinity consistency serial tracing explain";
const TYPES =
  "ascii bigint blob boolean counter date decimal double duration float inet int smallint text time timestamp " +
  "timeuuid tinyint uuid varchar varint list set map tuple frozen vector";

// What CQL's functions take and do: the editor's completion and its help.
const FUNCTIONS: SqlFunction[] = [
  { name: "COUNT", args: "* | column", about: "행 수" },
  { name: "MIN", args: "column", about: "최솟값" },
  { name: "MAX", args: "column", about: "최댓값" },
  { name: "SUM", args: "column", about: "합계" },
  { name: "AVG", args: "column", about: "평균" },
  { name: "now", args: "", about: "지금 시각의 timeuuid" },
  { name: "uuid", args: "", about: "무작위 UUID (버전 4)" },
  { name: "currentTimestamp", args: "", about: "현재 시각 (timestamp)" },
  { name: "currentDate", args: "", about: "오늘 날짜 (date)" },
  { name: "currentTime", args: "", about: "현재 시각 (time)" },
  { name: "toTimestamp", args: "timeuuid | date", about: "timestamp로 변환" },
  { name: "toDate", args: "timeuuid | timestamp", about: "date로 변환" },
  { name: "toUnixTimestamp", args: "timeuuid | timestamp | date", about: "1970년부터의 밀리초" },
  { name: "minTimeuuid", args: "timestamp", about: "그 시각의 가장 작은 timeuuid (범위 조회용)" },
  { name: "maxTimeuuid", args: "timestamp", about: "그 시각의 가장 큰 timeuuid (범위 조회용)" },
  { name: "token", args: "partition_key, …", about: "파티션 키의 토큰 (토큰 범위 조회)" },
  { name: "writetime", args: "column", about: "값을 쓴 시각 (마이크로초)" },
  { name: "ttl", args: "column", about: "값이 사라지기까지 남은 초" },
  { name: "toJson", args: "value", about: "값을 JSON 문자열로" },
  { name: "fromJson", args: "'json'", about: "JSON 문자열을 컬럼 타입의 값으로 (INSERT·UPDATE 값)" },
  { name: "CAST", args: "value AS type", about: "다른 타입으로 변환" },
  { name: "blobAsText", args: "blob", about: "blob을 text로" },
  { name: "textAsBlob", args: "text", about: "text를 blob으로" },
  { name: "bigintAsBlob", args: "bigint", about: "bigint를 blob으로" },
];

// A trace (TablePeek's EXPLAIN, rows of activity, source, source_elapsed,
// thread, the request's total last) as a tree: the request, then each node
// that worked on it with its steps in order. A step's time is the gap since
// the node's previous one; the slow ones are marked.
export function parseCqlTrace(columns: string[], rows: unknown[][]): ParsedPlan | null {
  const at = (name: string): number => columns.indexOf(name);
  const [activity, source, elapsed, thread] = [at("activity"), at("source"), at("source_elapsed"), at("thread")];
  if (activity < 0 || elapsed < 0 || rows.length === 0) {
    return null;
  }
  const micros = (row: unknown[]): number => Number(row[elapsed] ?? 0) || 0;
  const totalRow = rows.find((row) => row[thread] === "total");
  const events = rows.filter((row) => row !== totalRow);
  const total = totalRow !== undefined ? micros(totalRow) : Math.max(0, ...events.map(micros));
  const bySource = new Map<string, PlanNode[]>();
  const previous = new Map<string, number>();
  for (const row of events) {
    const node = String(row[source] ?? "?");
    const now = micros(row);
    const step = Math.max(0, now - (previous.get(node) ?? 0));
    previous.set(node, now);
    const share = total > 0 ? step / total : 0;
    const steps = bySource.get(node) ?? [];
    steps.push({
      label: String(row[activity] ?? ""),
      subtitle: row[thread] === null || row[thread] === undefined ? undefined : String(row[thread]),
      actualMs: now / 1000,
      detail: t("+{us}µs", { us: step.toLocaleString() }),
      severity: share >= 0.3 && step >= 1000 ? "hot" : share >= 0.1 ? "warn" : "ok",
      children: [],
    });
    bySource.set(node, steps);
  }
  const nodes: PlanNode[] = [...bySource.entries()].map(([node, steps]) => ({
    label: node,
    subtitle: t("이벤트 {count}개", { count: steps.length }),
    actualMs: Math.max(...steps.map((step) => step.actualMs ?? 0)),
    children: steps,
  }));
  return {
    engine: "cql",
    nodes: [
      {
        label: totalRow !== undefined ? String(totalRow[activity] ?? "") : t("요청"),
        subtitle: totalRow !== undefined && totalRow[source] !== null ? t("코디네이터 {node}", { node: String(totalRow[source]) }) : undefined,
        actualMs: total / 1000,
        children: nodes,
      },
    ],
    actualLabel: t("경과 (ms)"),
  };
}

// Roles, as LIST ROLES shows them (role, super, login, …).
const users: UserAdmin = {
  listSql: "LIST ROLES",
  readRow: (row) => {
    const flag = (value: unknown): boolean => value === true || value === "true" || value === "True";
    return {
      name: String(row[0] ?? ""),
      extra: flag(row[1]) ? "SUPERUSER" : flag(row[2]) ? "LOGIN" : "",
    };
  },
  extraLabel: "유형",
  hostField: false,
  superUserOption: true,
  createSql: (name, password, _host, superUser) => [
    {
      sql: `CREATE ROLE ${sql.quotePart(name)} WITH PASSWORD = ${quoteLiteral(password)} AND LOGIN = true AND SUPERUSER = ${superUser}`,
      secret: true,
    },
  ],
  dropSql: (row) => `DROP ROLE ${sql.quotePart(row.name)}`,
  passwordSql: (row, password) => ({
    sql: `ALTER ROLE ${sql.quotePart(row.name)} WITH PASSWORD = ${quoteLiteral(password)}`,
    secret: true,
  }),
  createdInfo: "역할을 생성했습니다: {name}",
  droppedInfo: "역할을 삭제했습니다: {name}",
};

// Apache Cassandra's and ScyllaDB's CQL: "…" names, '…' strings, $$ bodies,
// // comments, BEGIN … APPLY BATCH, pages by the server's paging state (no
// LIMIT on a data tab: LIMIT would end the paging), no transactions.
export const sql: SqlDialect = {
  quotePart: (part) => `"${part.replace(/"/g, '""')}"`,
  // The connection's keyspace is left out of names; others are qualified.
  defaultSchema: null,

  stringLiteral: quoteLiteral,
  booleanLiteral: (value) => (value ? "true" : "false"),
  binaryLiteral: (hex) => `0x${hex.toLowerCase()}`,
  bareHexIsBinary: true,
  nowSql: "toTimestamp(now())",
  nowLabel: "toTimestamp(now())",

  likeSpecials: /[!%_]/g,

  rowWindow: (order) => (order === null ? "" : `ORDER BY ${order}`),
  firstRows: (quotedTable, select, rows) => `SELECT ${select} FROM ${quotedTable} LIMIT ${rows};`,
  firstRowsName: "SELECT LIMIT",
  implicitRowOrder: null,
  keyOrder: false,
  filterOps: ["=", ">", "≥", "<", "≤", "IN", "CONTAINS"],
  filterLogics: ["AND"],
  containsSql: (quotedColumn, literal) => `${quotedColumn} CONTAINS ${literal}`,
  allowFilteringClause: "ALLOW FILTERING",
  consistencyLevels: [
    "ONE", "LOCAL_ONE", "TWO", "THREE", "QUORUM", "LOCAL_QUORUM", "EACH_QUORUM", "ALL", "ANY", "SERIAL", "LOCAL_SERIAL",
  ],
  // CQL has no table rename (ALTER TABLE only adds, drops and renames
  // columns). A copy is TablePeek's own CREATE TABLE … AS SELECT * FROM …,
  // which the driver runs: the structure, then every row by token pages.
  noTableRename: true,
  copyTable: (quotedTarget, quotedSource) => `CREATE TABLE ${quotedTarget} AS SELECT * FROM ${quotedSource}`,
  // One replica in every datacenter: a keyspace any single node can serve;
  // ALTER KEYSPACE raises it for a real cluster.
  createDatabase: (quotedName) =>
    `CREATE KEYSPACE ${quotedName} WITH replication = {'class': 'NetworkTopologyStrategy', 'replication_factor': 1}`,
  dropDatabase: (quotedName) => `DROP KEYSPACE ${quotedName}`,
  newKeyType: "int",
  noForeignKeys: true,
  fixedColumns: true,
  fixedKeys: true,
  addsTo: (declType) => declType.trim().toLowerCase() === "counter",
  // CQL has no NOT NULL (key columns are never null) and no DEFAULT.
  columnDef: (column) => `${sql.quotePart(column.name.trim())} ${column.type.trim()}`,
  emptyInsert: (quotedTable, quotedColumn) => `INSERT INTO ${quotedTable} (${quotedColumn}) VALUES (?);`,
  singleRowValues: true,
  batchStatements: (inserts) => `BEGIN UNLOGGED BATCH\n${inserts.map((insert) => `  ${insert};`).join("\n")}\nAPPLY BATCH`,
  importLiteral: (declared, value) => {
    if (declared === null || value === null || value === undefined) {
      return null;
    }
    const type = declared.trim().toLowerCase();
    const text = typeof value === "string" ? value.trim() : null;
    if ((type === "uuid" || type === "timeuuid") && text !== null && UUID.test(text)) {
      return text;
    }
    if (type === "blob" && text !== null && /^0x[0-9a-f]*$/i.test(text)) {
      return text;
    }
    if (type === "duration" && text !== null && DURATION.test(text)) {
      return text;
    }
    // A file's (or a dump's) text for a number or a boolean: CQL won't take
    // it quoted; NaN and Infinity are its own float literals.
    if (
      text !== null &&
      NUMERIC_TYPES.has(type) &&
      /^(?:[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|NaN|-?Infinity)$/i.test(text)
    ) {
      return text;
    }
    if (text !== null && type === "boolean" && /^(?:true|false)$/i.test(text)) {
      return text.toLowerCase();
    }
    if (structured(type)) {
      return `fromJson(${quoteLiteral(typeof value === "string" ? value : JSON.stringify(value))})`;
    }
    return null;
  },
  requiresPrimaryKey: true,

  rebuildsTable: false,
  addColumn: (table, column) => [`ALTER TABLE ${quoteIdent(sql, table)} ADD ${sql.quotePart(column.name.trim())} ${column.type.trim()}`],
  renameColumn: (table, from, to) => `ALTER TABLE ${quoteIdent(sql, table)} RENAME ${sql.quotePart(from)} TO ${sql.quotePart(to)}`,
  dropColumn: (table, column) => [`ALTER TABLE ${quoteIdent(sql, table)} DROP ${sql.quotePart(column)}`],
  // An index belongs to its keyspace, not its table.
  dropIndex: (table, name) => {
    const keyspace = table.includes(".") ? `${sql.quotePart(table.split(".")[0])}.` : "";
    return `DROP INDEX ${keyspace}${sql.quotePart(name)}`;
  },
  truncateStatement: "TRUNCATE TABLE",
  truncateTogether: false,
  dropIfExists: (quoted, object) => `DROP ${object === "view" ? "MATERIALIZED VIEW" : "TABLE"} IF EXISTS ${quoted}`,
  columnTypes: [
    "int", "bigint", "smallint", "tinyint", "varint", "decimal", "float", "double", "counter", "boolean", "text",
    "ascii", "uuid", "timeuuid", "date", "time", "timestamp", "duration", "inet", "blob", "list<text>", "set<text>",
    "map<text, text>", "frozen<tuple<int, text>>",
  ],
  columnDefaults: [],

  keysInCreate: true,

  templates: {
    materialized_view: [
      "CREATE MATERIALIZED VIEW mv_name AS",
      "  SELECT * FROM table_name",
      "  WHERE key_column IS NOT NULL AND other_column IS NOT NULL",
      "  PRIMARY KEY ((other_column), key_column);",
    ].join("\n"),
    type: "CREATE TYPE type_name (\n  field_one text,\n  field_two int\n);",
    function: [
      "CREATE FUNCTION fn_name(x int)",
      "  RETURNS NULL ON NULL INPUT",
      "  RETURNS int",
      "  LANGUAGE java",
      "  AS 'return x + 1;';",
    ].join("\n"),
    aggregate: "CREATE AGGREGATE agg_name(double)\n  SFUNC state_fn\n  STYPE double\n  INITCOND 0;",
    trigger: "CREATE TRIGGER trg_name ON table_name USING 'org.example.TriggerClass';",
  },
  dropKeywords: { materialized_view: "MATERIALIZED VIEW", type: "TYPE", aggregate: "AGGREGATE" },

  // Every CQL INSERT overwrites a row with the same key.
  insertModes: ["insert"],
  replaceInto: "INSERT INTO",
  upsertNeedsKey: false,
  collapseRepeats: false,
  ddlInTransaction: false,
  importType: (profile) =>
    ({
      integer: "int",
      bigint: "bigint",
      decimal: "decimal",
      double: "double",
      boolean: "boolean",
      date: "date",
      datetime: "timestamp",
      datetimetz: "timestamp",
      text: "text",
    })[profile.kind],
  importExtraTypes: ["uuid", "timeuuid", "varint", "inet", "list<text>", "set<text>", "map<text, text>"],
  importBitIsBoolean: false,

  booleanOptions: ["true", "false"],
  gridBitIsBoolean: false,
  timestampIsVersion: false,
  blobByName: false,
  cellKind: (declType) => {
    const type = declType.trim().toLowerCase();
    if (type === "varint" || type === "counter") {
      return { kind: "number" };
    }
    if (type === "duration" || type === "inet" || type === "uuid" || type === "timeuuid") {
      return { kind: "text" };
    }
    return structured(type) ? { kind: "json" } : null;
  },

  // TablePeek's EXPLAIN runs the statement traced and returns its events.
  explain: { prefix: "EXPLAIN ", parse: parseCqlTrace },

  editor: SQLDialect.define({
    keywords: KEYWORDS,
    types: TYPES,
    builtin: FUNCTIONS.map((fn) => fn.name.toLowerCase()).join(" "),
    slashComments: true,
    doubleDollarQuotedStrings: true,
    doubleQuotedStrings: false,
    caseInsensitiveIdentifiers: true,
  }),
  lexing: {
    hashComments: false,
    backslashEscapes: false,
    bracketNames: false,
    dollarQuotes: true,
    executableComments: false,
    escapeStrings: false,
    slashComments: true,
    batchBlocks: true,
  },
  functions: FUNCTIONS,

  users,
};
