import type { SQLDialect as EditorDialect } from "@codemirror/lang-sql";
import type { FilterLogic, FilterOp } from "../dataQuery";
import type { ColumnDraft, CreateTableOptions, DiffResult, IndexDraft, StructureDraft } from "../ddl";
import type { ParsedPlan } from "../explainPlan";
import type { GridColumnSpec } from "../grid/columns";
import type { InsertMode } from "../importSql";
import type { ColumnProfile } from "../importTypes";
import type { SqlFunction } from "./sqlFunctions";
import type { Lexing } from "../sqlSplit";
import type { TableDetailForeignKey } from "../store";
import type { ObjectKind } from "../templates";

// A user (or login, or role) as the user manager lists it: its name and the
// host (MySQL) or type it is shown with.
export interface UserRow {
  name: string;
  extra: string;
}

// A statement carrying a password runs but stays out of History.
export type UserStatement = string | { sql: string; secret: true };

// How an engine lists, makes, drops and re-passwords its users.
export interface UserAdmin {
  listSql: string;
  readRow(row: unknown[]): UserRow;
  // The second column's heading (a Korean i18n key).
  extraLabel: string;
  // A host to make the user for (MySQL's user@host).
  hostField: boolean;
  // A SUPERUSER box on the create form.
  superUserOption: boolean;
  createSql(name: string, password: string, host: string, superUser: boolean): UserStatement[];
  dropSql(row: UserRow): string;
  passwordSql(row: UserRow, password: string): UserStatement;
  // What was made and dropped (Korean i18n keys taking {name}).
  createdInfo: string;
  droppedInfo: string;
}

// Servers grouped into clusters a structure change can run on all at once
// (ClickHouse's ON CLUSTER).
export interface ClusterDdl {
  // The cluster names, one per row.
  listSql: string;
  // The statement run on every server of `cluster`; one the clause doesn't
  // fit, or that already names a cluster, comes back as it was.
  onCluster(statement: string, cluster: string): string;
}

// A table property's one-click change (SqlDialect.propertyAction); the
// texts are the dialect's Korean, translated where shown.
export interface PropertyAction {
  label: string;
  title: string;
  message: string;
  statement: string;
}

// A column change the generic ALTER TABLE path asks a dialect to write.
export interface ColumnChange {
  type: boolean;
  notNull: boolean;
  def: boolean;
}

// An engine's SQL: how it quotes and spells values, pages, changes
// structure, imports, dumps and explains, and how its editor reads it. The
// helpers (ddl.ts, dataQuery.ts, export.ts, …) take one of these instead of
// the engine's name; optional members fall back to the helper's standard SQL.
export interface SqlDialect {
  // One name, quoted, its quote characters doubled inside.
  quotePart(part: string): string;
  // Whether a name reads the same unquoted, for an engine whose bare names
  // aren't lower case (Oracle's are upper case); absent: lang-sql's rule.
  bareName?(name: string): boolean;
  // The schema names are shown without (null: names are never qualified).
  defaultSchema: string | null;

  // A text literal as the engine reads it.
  stringLiteral(value: string): string;
  booleanLiteral(value: boolean): string;
  // Bytes, given as an even number of hex digits.
  binaryLiteral(hex: string): string;
  // Bare hex digits in a binary column are bytes (not on SQLite, whose
  // columns hold text too).
  bareHexIsBinary: boolean;
  // NOW() as the engine writes it when it applies one, and the label the
  // grid's menu shows for it.
  nowSql: string;
  nowLabel: string;

  // The characters a LIKE pattern escapes behind "!".
  likeSpecials: RegExp;
  // A column matched as text by Contains and the like; absent: as it is.
  textMatchColumn?(column: string): string;
  // LIKE takes no ESCAPE clause: the specials are escaped by a backslash
  // (ClickHouse).
  backslashLike?: boolean;

  // ORDER BY … and the row window from `offset` on, at most `limit` rows.
  rowWindow(order: string | null, limit: number, offset: number): string;
  // A table's first rows, and that snippet's name.
  firstRows(quotedTable: string, select: string, rows: number): string;
  firstRowsName: string;
  // What orders a table that has no key, when the engine has one.
  implicitRowOrder: string | null;
  // Columns the database keeps per row that tell rows apart where the key
  // may not (ClickHouse's _part and _part_offset): a data tab of a table
  // with a key reads them after its own columns, and edits find the row by
  // them too. Exports leave them out.
  rowIdentity?: readonly string[];
  // Clusters the structure changes the app writes (create, structure,
  // rename, copy, empty, drop) can run on; the connection's `cluster`
  // setting picks one by default.
  clusters?: ClusterDdl;
  // A one-click change a table property offers in the structure pane's
  // "테이블 속성" (ClickHouse: turn on lightweight UPDATE), or null: its
  // button, the confirmation's title and explanation, and the statement,
  // run on the cluster the pane's DDL preview picks.
  propertyAction?(property: { name: string; value: string }, table: string): PropertyAction | null;
  // false: a data tab is ordered only by the sort picked, never by its key
  // (CQL orders rows only inside one partition). Absent: by the key.
  keyOrder?: boolean;
  // The filter operators and AND/OR the engine takes (CQL: no OR, no
  // LIKE without an index); absent: all of them.
  filterOps?: readonly FilterOp[];
  filterLogics?: readonly FilterLogic[];
  // CONTAINS as the engine writes it (CQL's collection CONTAINS); absent:
  // a LIKE '%…%' text match.
  containsSql?(quotedColumn: string, literal: string): string;
  // The clause a data tab's "allow filtering" switch appends (CQL's ALLOW
  // FILTERING, needed to filter off the key); absent: no switch.
  allowFilteringClause?: string;
  // The consistency levels a connection can pick in the tab bar, set with
  // `CONSISTENCY <level>` (CQL); absent: no picker.
  consistencyLevels?: readonly string[];
  // Table actions the engine lacks (CQL renames no table and has no
  // CREATE TABLE … AS): their menu entries are left out.
  noTableRename?: boolean;
  noTableCopy?: boolean;
  // What creates and drops a database (CQL's keyspaces, which need a
  // replication); absent: CREATE DATABASE and DROP DATABASE.
  createDatabase?(quotedName: string): string;
  dropDatabase?(quotedName: string): string;
  // The type a new table's `id` key column starts as; absent: INTEGER.
  newKeyType?: string;
  // The type a column added in the structure grid or the create-table form
  // starts as; absent: TEXT (which Oracle has no type of).
  newColumnType?: string;
  // The engine has no foreign keys (CQL): the structure grid leaves out
  // their column.
  noForeignKeys?: boolean;
  // Columns have no NOT NULL or default, and an existing one keeps its type
  // and its place in the key (CQL): the structure grid leaves nullability
  // and default out and doesn't offer those changes.
  fixedColumns?: boolean;
  // A stored row's key columns can't change (CQL: the key places the row):
  // the grid doesn't edit them.
  fixedKeys?: boolean;
  // Whether a column of this declared type changes by addition only (CQL's
  // counter): the cell menu offers "더할 값…", an increment the database
  // applies atomically, and a typed value is written as the difference from
  // the one the grid showed.
  addsTo?(declType: string): boolean;
  // A row with every column at its default; `quotedColumn` is the table's
  // first, for an engine with no DEFAULT VALUES (Oracle).
  emptyInsert(quotedTable: string, quotedColumn: string): string;
  // An import chunk of plain inserts in the engine's own data format, the
  // rows' values as the file gave them (ClickHouse's INSERT … FORMAT CSV);
  // absent: INSERT … VALUES of literals.
  insertRows?(quotedTable: string, quotedColumns: string[], rows: unknown[][]): string;
  // Rows an import sends per statement, where the engine wants more than
  // the usual (ClickHouse makes a part per insert).
  importChunkRows?: number;
  // Exports of whole tables to CSV and JSON are written by the database
  // itself and streamed (POST /api/sql/export), with no row limit.
  nativeExport?: boolean;
  // The editor's snippets between the first rows and EXPLAIN, where the
  // standard COUNT, INSERT, UPDATE and CREATE INDEX don't fit the engine.
  snippets?(quotedTable: string): { name: string; sql: string }[];
  // VALUES takes one row (Oracle before 23ai): a file writes an INSERT per
  // row, and an import sends its chunk's rows as one PL/SQL block.
  singleRowValues?: boolean;
  // Several INSERTs as the one statement an import chunk sends (CQL's BEGIN
  // BATCH … APPLY BATCH); absent: a PL/SQL block.
  batchStatements?(inserts: string[]): string;
  // An imported value as a literal for a column declared `declared` (CQL's
  // uuid, collections and UDTs); null or absent: the standard literal.
  importLiteral?(declared: string | null, value: unknown): string | null;
  // A table must have a primary key (CQL): an import into a new table makes
  // its first column the key.
  requiresPrimaryKey?: boolean;
  // What UPDATE … SET col = writes for DEFAULT on an engine without it
  // (SQLite), from the column's declared default; null: nothing can stand
  // in. Absent: DEFAULT works.
  updateDefault?(declared: string | null): string | null;

  // A whole structure diff, for an engine that rebuilds tables (SQLite).
  diffStructure?(table: string, orig: StructureDraft, next: StructureDraft): DiffResult;
  // Whether saving a structure rewrites the whole table, so every column
  // and index is the draft's to drop.
  rebuildsTable: boolean;
  // A column as CREATE TABLE and ADD COLUMN write it; absent: name, type,
  // DEFAULT and NOT NULL (ClickHouse writes nullability into the type).
  columnDef?(column: ColumnDraft): string;
  addColumn?(table: string, column: ColumnDraft): string[];
  renameColumn?(table: string, from: string, to: string): string;
  // A kept column's new type, nullability or default; problems go to `errors`.
  alterColumn?(table: string, column: ColumnDraft, change: ColumnChange, errors: string[]): string[];
  // The primary key changed; absent: the engine can't change it.
  changePrimaryKey?(table: string, orig: StructureDraft, next: StructureDraft, errors: string[]): string[];
  // Absent: DROP INDEX with the index named in its table's schema.
  dropIndex?(table: string, name: string): string;
  // What makes an index; absent: CREATE [UNIQUE] INDEX … ON table (columns).
  createIndex?(table: string, index: IndexDraft): string;
  dropForeignKey?(table: string, name: string): string;
  // What drops a column, when ALTER TABLE … DROP COLUMN alone won't do
  // (SQL Server's default constraints go first).
  dropColumn?(table: string, column: string): string[];
  // Whether an index on a column stops it being retyped, made (not) null or
  // dropped (SQL Server): such indexes are dropped first and made again after.
  indexesHoldColumns?: boolean;
  // CREATE TABLE's options after its closing parenthesis, when the engine has any.
  tableOptions?(options: CreateTableOptions): string;
  // What CREATE TABLE ends with on an engine without options to pick
  // (ClickHouse's ENGINE = MergeTree and its sorting key).
  tableSuffix?(draft: StructureDraft): string;
  renameTable?(table: string, newName: string): string;
  // TRUNCATE TABLE or what the engine empties a table with.
  truncateStatement: string;
  // Several tables emptied by one TRUNCATE (tables referencing each other).
  truncateTogether: boolean;
  // A new table holding a copy of another's rows.
  copyTable?(quotedTarget: string, quotedSource: string): string;
  dropIfExists?(quoted: string, object: "table" | "view"): string;
  // A foreign key dropped before its table, for a file that drops tables
  // referencing each other; absent: none needed.
  dropForeignKeyIfExists?(table: string, fk: TableDetailForeignKey): string;
  // Laravel's $table->engine, when the engine has one.
  laravelEngine?: string;
  // The types and defaults the structure grid offers.
  columnTypes: readonly string[];
  columnDefaults: readonly string[];

  // Dumps: what goes before and after the statements, and whether CREATE
  // TABLE carries the foreign keys and indexes (SQLite's stored definition
  // does; else the indexes follow each table's rows and the keys all rows).
  dumpBefore?: string;
  dumpAfter?: string;
  keysInCreate: boolean;
  // A restore keeps the session settings a dump changes: the query reading
  // them, and the statement putting a row of them back.
  sessionSnapshot?: string;
  restoreSession?(row: unknown[]): string | null;

  // CREATE templates for the sidebar's object sections.
  templates: Partial<Record<ObjectKind, string>>;
  // DROP's object word where the engine spells it otherwise (ClickHouse
  // drops a materialized view with DROP VIEW).
  dropKeywords?: Partial<Record<ObjectKind, string>>;

  // Import: the collision modes offered, how REPLACE is spelled, the upsert
  // clause, and what the engine needs around them.
  insertModes: readonly InsertMode[];
  replaceInto: string;
  upsertNeedsKey: boolean;
  upsertClause?(columns: string[], updated: string[], quote: (name: string) => string): string;
  // An upsert written as one statement per row (Oracle's MERGE … USING
  // DUAL), for an engine with no collision clause on INSERT: the quoted
  // table, the columns and key columns (quoted) and the row's literals.
  upsertRow?(table: string, columns: string[], keys: string[], row: string[]): string;
  // Rows repeating a key collapsed to the last (one ON CONFLICT can't update a row twice).
  collapseRepeats: boolean;
  // Whether CREATE TABLE can run inside the import's transaction.
  ddlInTransaction: boolean;
  // A file's number that goes in as text (`text` has no exponent).
  numberAsText?(text: string): boolean;
  // The type an imported column gets, the extra types its menu offers, and
  // whether a bit column takes true/false.
  importType(profile: ColumnProfile): string;
  importExtraTypes: readonly string[];
  importBitIsBoolean: boolean;

  // The grid: how booleans show, whether bit is one, whether timestamp is a
  // row version (not a time), whether any type naming BLOB holds bytes.
  booleanOptions: readonly string[];
  gridBitIsBoolean: boolean;
  timestampIsVersion: boolean;
  // DATE holds a time of day too (Oracle), so it is edited as a datetime.
  dateHasTime?: boolean;
  blobByName: boolean;
  // How the grid shows and edits a declared type the shared reading doesn't
  // know (ClickHouse's UInt32, Nullable(DateTime64(3)), Enum8(…)); null
  // falls back to it.
  cellKind?(declType: string): Pick<GridColumnSpec, "kind" | "options"> | null;

  // EXPLAIN's prefix and the reader of its result; absent: no plan view.
  explain?: {
    prefix: string;
    parse(columns: string[], rows: unknown[][]): ParsedPlan | null;
  };

  // The editor: its SQL, what ends a statement, the functions it offers.
  editor: EditorDialect;
  lexing: Lexing;
  functions: readonly SqlFunction[];
  // Names whose case matters, offered as written (ClickHouse's types,
  // formats and engines); when set, function names keep their case too.
  namesKeepCase?: readonly string[];

  // User management; absent: the engine has none.
  users?: UserAdmin;
}
