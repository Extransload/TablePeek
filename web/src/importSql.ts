import { quoteIdent, quoteName } from "./ddl";
import { quoteLiteral } from "./export";
import { JsonNumber } from "./importParse";

// How rows that collide with an existing key are handled. TablePlus offers
// these for PostgreSQL and MySQL/MariaDB; SQLite has the same two, spelled
// its own way, CockroachDB is PostgreSQL's ON CONFLICT, SQL Server only inserts.
export type InsertMode = "insert" | "upsert" | "replace";

export function insertModes(dialect: string): InsertMode[] {
  switch (dialect) {
    case "postgres":
    case "cockroach":
      return ["insert", "upsert"];
    case "mysql":
    case "sqlite":
      return ["insert", "upsert", "replace"];
    default:
      return ["insert"];
  }
}

// ON CONFLICT needs the key to name; MySQL's ON DUPLICATE KEY and both
// REPLACEs find it themselves.
export function modeNeedsKey(mode: InsertMode, dialect: string): boolean {
  return mode === "upsert" && dialect !== "mysql";
}

function stringLiteral(text: string, dialect: string): string {
  if (dialect === "mysql") {
    // Backslash is an escape in MySQL strings unless NO_BACKSLASH_ESCAPES is set.
    return `'${text.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
  }
  if (dialect === "mssql") {
    // Without N the text goes through the database's code page.
    return `N'${text.replace(/'/g, "''")}'`;
  }
  return quoteLiteral(text);
}

export function importLiteral(value: unknown, dialect: string): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (value instanceof JsonNumber) {
    // Written as the file has it. SQLite would round anything but a 64-bit
    // integer to a REAL and SQL Server refuses numerics past 38 digits, so
    // there the digits go in as text, which the column converts.
    const integer = /^-?\d+$/.test(value.text);
    const digits = value.text.replace(/^-/, "").split(/[eE]/)[0].replace(".", "").replace(/^0+/, "").length;
    const quoted =
      (dialect === "sqlite" && !(integer && BigInt(value.text) >= -(2n ** 63n) && BigInt(value.text) < 2n ** 63n)) ||
      (dialect === "mssql" && digits > 38);
    return quoted ? stringLiteral(value.text, dialect) : value.text;
  }
  if (typeof value === "boolean") {
    if (dialect === "mssql") {
      return value ? "1" : "0";
    }
    return value ? "TRUE" : "FALSE";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : stringLiteral(String(value), dialect);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "string") {
    return stringLiteral(value, dialect);
  }
  const text = JSON.stringify(value);
  return stringLiteral(text === undefined ? String(value) : text, dialect);
}

export interface InsertSpec {
  dialect: string;
  table: string;
  columns: string[];
  // The table's primary key, for ON CONFLICT and for collapsing repeats.
  pk: string[];
  mode: InsertMode;
}

// One INSERT for rows of literals, with the collision clause the mode asks for.
export function insertStatement(spec: InsertSpec, rows: string[][]): string {
  const { dialect, mode } = spec;
  const column = (name: string): string => quoteName(dialect, name);
  const head =
    mode === "replace"
      ? dialect === "sqlite"
        ? "INSERT OR REPLACE INTO"
        : "REPLACE INTO"
      : "INSERT INTO";
  const values = rows.map((row) => `  (${row.join(", ")})`).join(",\n");
  let sql = `${head} ${quoteIdent(dialect, spec.table)} (${spec.columns.map(column).join(", ")}) VALUES\n${values}`;
  if (mode !== "upsert") {
    return sql;
  }
  const keys = new Set(spec.pk.map((name) => name.toLowerCase()));
  const updated = spec.columns.filter((name) => !keys.has(name.toLowerCase()));
  if (dialect === "mysql") {
    // Nothing but key columns: a no-op update keeps the row and skips the error.
    const sets =
      updated.length > 0
        ? updated.map((name) => `${column(name)} = VALUES(${column(name)})`)
        : [`${column(spec.columns[0])} = ${column(spec.columns[0])}`];
    sql += `\nON DUPLICATE KEY UPDATE ${sets.join(", ")}`;
    return sql;
  }
  const target = spec.pk.map(column).join(", ");
  sql +=
    updated.length > 0
      ? `\nON CONFLICT (${target}) DO UPDATE SET ${updated.map((name) => `${column(name)} = excluded.${column(name)}`).join(", ")}`
      : `\nON CONFLICT (${target}) DO NOTHING`;
  return sql;
}

// PostgreSQL won't let one ON CONFLICT statement update a row twice, so of
// rows repeating a key only the last stays, as a row-at-a-time import would end.
export function collapseRepeats(spec: InsertSpec, rows: string[][]): string[][] {
  if (spec.mode !== "upsert" || (spec.dialect !== "postgres" && spec.dialect !== "cockroach")) {
    return rows;
  }
  const lower = spec.columns.map((name) => name.toLowerCase());
  const keyAt = spec.pk.map((name) => lower.indexOf(name.toLowerCase()));
  if (keyAt.length === 0 || keyAt.some((index) => index < 0)) {
    return rows;
  }
  const last = new Map<string, number>();
  rows.forEach((row, index) => last.set(JSON.stringify(keyAt.map((at) => row[at])), index));
  return rows.filter((row, index) => last.get(JSON.stringify(keyAt.map((at) => row[at]))) === index);
}

export interface ImportPlan {
  spec: InsertSpec;
  // CREATE TABLE (and its indexes) for a new table, else empty.
  create: string[];
  rowCount: number;
  // A row's values as literals, made when its chunk is sent.
  literals(row: number): string[];
  chunkRows: number;
}

// The statements run, on the connection's own session.
export interface ImportSession {
  exec(sql: string): Promise<void>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface ImportProgress {
  (done: number, locating?: boolean): void;
}

export class ImportFailure extends Error {
  // The failing row, from 0, when it could be told.
  readonly row: number | null;
  readonly stopped: boolean;
  // Why the import couldn't be undone (a ROLLBACK that failed, MySQL's new
  // table that wouldn't drop), else null: the table is as it was.
  readonly undoError: string | null;

  constructor(message: string, row: number | null, stopped = false, undoError: string | null = null) {
    super(message);
    this.row = row;
    this.stopped = stopped;
    this.undoError = undoError;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

// MySQL commits around DDL, so its CREATE TABLE can't be part of the
// transaction; it runs first, and the table goes again if the import doesn't.
function ddlInTransaction(dialect: string): boolean {
  return dialect !== "mysql";
}

function chunkSql(plan: ImportPlan, from: number, to: number): string {
  const rows: string[][] = [];
  for (let row = from; row < to; row += 1) {
    rows.push(plan.literals(row));
  }
  return insertStatement(plan.spec, collapseRepeats(plan.spec, rows));
}

// Every row in one transaction: a failure or a stop rolls it all back, so
// the table is as it was. The failing row is found afterwards by trying the
// failed chunk's rows one at a time, first by themselves and, if none fails
// alone (a key repeated from an earlier chunk), after the chunks before them.
// A ROLLBACK (or MySQL's DROP of the new table) that fails is never passed
// off as undone: the failure carries why, and the transaction may be open.
// The stop signal is not looked at once the COMMIT is sent.
export async function runImport(
  plan: ImportPlan,
  session: ImportSession,
  signal: AbortSignal,
  onProgress: ImportProgress,
): Promise<void> {
  const { dialect } = plan.spec;
  const created = plan.create.length > 0;
  const stopped = (): ImportFailure => new ImportFailure("stopped", null, true);
  // Each returns why it couldn't, or null.
  const dropCreated = async (): Promise<string | null> => {
    if (!created || ddlInTransaction(dialect)) {
      return null;
    }
    try {
      await session.exec(`DROP TABLE ${quoteIdent(dialect, plan.spec.table)}`);
      return null;
    } catch (error) {
      return messageOf(error);
    }
  };
  const rollback = async (): Promise<string | null> => {
    try {
      await session.rollback();
      return null;
    } catch (error) {
      return messageOf(error);
    }
  };

  if (created && !ddlInTransaction(dialect)) {
    for (const statement of plan.create) {
      await session.exec(statement);
    }
  }
  try {
    await session.begin();
  } catch (error) {
    const undoError = await dropCreated();
    throw undoError === null ? error : new ImportFailure(messageOf(error), null, false, undoError);
  }
  let failedAt = -1;
  try {
    if (created && ddlInTransaction(dialect)) {
      for (const statement of plan.create) {
        await session.exec(statement);
      }
    }
    for (let from = 0; from < plan.rowCount; from += plan.chunkRows) {
      if (signal.aborted) {
        throw stopped();
      }
      failedAt = from;
      await session.exec(chunkSql(plan, from, Math.min(plan.rowCount, from + plan.chunkRows)));
      failedAt = -1;
      onProgress(Math.min(plan.rowCount, from + plan.chunkRows));
    }
    if (signal.aborted) {
      throw stopped();
    }
  } catch (error) {
    const rollbackError = await rollback();
    if (rollbackError !== null) {
      // Nothing more is tried on a transaction that may still be open.
      throw new ImportFailure(
        error instanceof ImportFailure && error.stopped ? "stopped" : messageOf(error),
        failedAt >= 0 ? failedAt : null,
        error instanceof ImportFailure && error.stopped,
        rollbackError,
      );
    }
    if (error instanceof ImportFailure || failedAt < 0) {
      const undoError = await dropCreated();
      if (undoError !== null) {
        const stop = error instanceof ImportFailure && error.stopped;
        throw new ImportFailure(stop ? "stopped" : messageOf(error), null, stop, undoError);
      }
      throw error;
    }
    const found = await locate(plan, session, signal, failedAt, onProgress);
    const undoError = found.undoError ?? (await dropCreated());
    if (found.row === null) {
      throw new ImportFailure(messageOf(error), failedAt, false, undoError);
    }
    throw new ImportFailure(messageOf(found.error), found.row, false, undoError);
  }
  try {
    await session.commit();
  } catch (error) {
    const undoError = await dropCreated();
    throw undoError === null ? error : new ImportFailure(messageOf(error), null, false, undoError);
  }
}

interface Located {
  row: number | null;
  error: unknown;
  // A probe's ROLLBACK that failed: its rows may still be in an open transaction.
  undoError: string | null;
}

async function locate(
  plan: ImportPlan,
  session: ImportSession,
  signal: AbortSignal,
  from: number,
  onProgress: ImportProgress,
): Promise<Located> {
  const to = Math.min(plan.rowCount, from + plan.chunkRows);
  const passes = from === 0 ? [false] : [false, true];
  const none: Located = { row: null, error: null, undoError: null };
  for (const afterEarlier of passes) {
    if (signal.aborted) {
      return none;
    }
    onProgress(from, true);
    try {
      await session.begin();
    } catch {
      return none;
    }
    let found: Located | null = null;
    let replayFailed = false;
    try {
      if (plan.create.length > 0 && ddlInTransaction(plan.spec.dialect)) {
        for (const statement of plan.create) {
          await session.exec(statement);
        }
      }
      if (afterEarlier) {
        for (let start = 0; start < from && !signal.aborted; start += plan.chunkRows) {
          await session.exec(chunkSql(plan, start, Math.min(from, start + plan.chunkRows)));
        }
      }
      for (let row = from; row < to && !signal.aborted && found === null; row += 1) {
        try {
          await session.exec(insertStatement(plan.spec, [plan.literals(row)]));
        } catch (error) {
          found = { row, error, undoError: null };
        }
      }
    } catch {
      // The rows before the failed chunk didn't go in again: nothing to tell.
      replayFailed = true;
    }
    try {
      await session.rollback();
    } catch (error) {
      return { ...(found ?? none), undoError: messageOf(error) };
    }
    if (found !== null) {
      return found;
    }
    if (replayFailed || signal.aborted) {
      return none;
    }
  }
  return none;
}
