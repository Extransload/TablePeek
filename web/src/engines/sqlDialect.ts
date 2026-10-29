import type { SQLDialect as EditorDialect } from "@codemirror/lang-sql";
import type { ColumnDraft, CreateTableOptions, DiffResult, StructureDraft } from "../ddl";
import type { ParsedPlan } from "../explainPlan";
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

  // ORDER BY … and the row window from `offset` on, at most `limit` rows.
  rowWindow(order: string | null, limit: number, offset: number): string;
  // A table's first rows, and that snippet's name.
  firstRows(quotedTable: string, select: string, rows: number): string;
  firstRowsName: string;
  // What orders a table that has no key, when the engine has one.
  implicitRowOrder: string | null;
  // A row with every column at its default.
  emptyInsert(quotedTable: string): string;
  // What UPDATE … SET col = writes for DEFAULT on an engine without it
  // (SQLite), from the column's declared default; null: nothing can stand
  // in. Absent: DEFAULT works.
  updateDefault?(declared: string | null): string | null;

  // A whole structure diff, for an engine that rebuilds tables (SQLite).
  diffStructure?(table: string, orig: StructureDraft, next: StructureDraft): DiffResult;
  // Whether saving a structure rewrites the whole table, so every column
  // and index is the draft's to drop.
  rebuildsTable: boolean;
  addColumn?(table: string, column: ColumnDraft): string[];
  renameColumn?(table: string, from: string, to: string): string;
  // A kept column's new type, nullability or default; problems go to `errors`.
  alterColumn?(table: string, column: ColumnDraft, change: ColumnChange, errors: string[]): string[];
  // The primary key changed; absent: the engine can't change it.
  changePrimaryKey?(table: string, orig: StructureDraft, next: StructureDraft, errors: string[]): string[];
  // Absent: DROP INDEX with the index named in its table's schema.
  dropIndex?(table: string, name: string): string;
  dropForeignKey?(table: string, name: string): string;
  // What drops a column, when ALTER TABLE … DROP COLUMN alone won't do
  // (SQL Server's default constraints go first).
  dropColumn?(table: string, column: string): string[];
  // Whether an index on a column stops it being retyped, made (not) null or
  // dropped (SQL Server): such indexes are dropped first and made again after.
  indexesHoldColumns?: boolean;
  // CREATE TABLE's options after its closing parenthesis, when the engine has any.
  tableOptions?(options: CreateTableOptions): string;
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

  // Import: the collision modes offered, how REPLACE is spelled, the upsert
  // clause, and what the engine needs around them.
  insertModes: readonly InsertMode[];
  replaceInto: string;
  upsertNeedsKey: boolean;
  upsertClause?(columns: string[], updated: string[], quote: (name: string) => string): string;
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
  blobByName: boolean;

  // EXPLAIN's prefix and the reader of its result; absent: no plan view.
  explain?: {
    prefix: string;
    parse(columns: string[], rows: unknown[][]): ParsedPlan | null;
  };

  // The editor: its SQL, what ends a statement, the functions it offers.
  editor: EditorDialect;
  lexing: Lexing;
  functions: readonly SqlFunction[];

  // User management; absent: the engine has none.
  users?: UserAdmin;
}
