import { quoteIdent, quoteName } from "./ddl";
import type { SqlDialect } from "./engines/sqlDialect";
import { JsonNumber } from "./importParse";

// How rows that collide with an existing key are handled. TablePlus offers
// these for PostgreSQL and MySQL/MariaDB; SQLite has the same two, spelled
// its own way, CockroachDB is PostgreSQL's ON CONFLICT, SQL Server only
// inserts (SqlDialect.insertModes).
export type InsertMode = "insert" | "upsert" | "replace";

// ON CONFLICT needs the key to name; MySQL's ON DUPLICATE KEY and both
// REPLACEs find it themselves.
export function modeNeedsKey(mode: InsertMode, dialect: SqlDialect): boolean {
  return mode === "upsert" && dialect.upsertNeedsKey;
}

export function importLiteral(value: unknown, dialect: SqlDialect): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (value instanceof JsonNumber) {
    // The file's digits, without an exponent (which MySQL and SQL Server
    // would read as a float), or as text where the engine would lose them
    // (SqlDialect.numberAsText); the column converts the text.
    const text = value.plain;
    return dialect.numberAsText?.(text) === true ? dialect.stringLiteral(text) : text;
  }
  if (typeof value === "boolean") {
    return dialect.booleanLiteral(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : dialect.stringLiteral(String(value));
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "string") {
    return dialect.stringLiteral(value);
  }
  const text = JSON.stringify(value);
  return dialect.stringLiteral(text === undefined ? String(value) : text);
}

export interface InsertSpec {
  dialect: SqlDialect;
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
  const head = mode === "replace" ? dialect.replaceInto : "INSERT INTO";
  const values = rows.map((row) => `  (${row.join(", ")})`).join(",\n");
  let sql = `${head} ${quoteIdent(dialect, spec.table)} (${spec.columns.map(column).join(", ")}) VALUES\n${values}`;
  if (mode !== "upsert") {
    return sql;
  }
  const keys = new Set(spec.pk.map((name) => name.toLowerCase()));
  const updated = spec.columns.filter((name) => !keys.has(name.toLowerCase()));
  if (dialect.upsertClause !== undefined) {
    return `${sql}\n${dialect.upsertClause(spec.columns, updated, column)}`;
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
  if (spec.mode !== "upsert" || !spec.dialect.collapseRepeats) {
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
  // The COMMIT went out but whether it went through is not known (the
  // connection dropped with it): the rows, and a new table, may be there.
  readonly outcomeUnknown: boolean;
  // The database's own error for the failing row (its SQLSTATE, column, …),
  // when there was one.
  readonly source: unknown;

  constructor(
    message: string,
    row: number | null,
    stopped = false,
    undoError: string | null = null,
    outcomeUnknown = false,
    source: unknown = undefined,
  ) {
    super(message);
    this.row = row;
    this.stopped = stopped;
    this.undoError = undoError;
    this.outcomeUnknown = outcomeUnknown;
    this.source = source;
  }
}

// What an ImportSession's commit throws when the COMMIT may have gone
// through: anything but a rollback the server is sure of.
export class CommitOutcomeUnknown extends Error {}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
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
  // MySQL commits around DDL, so its CREATE TABLE can't be part of the
  // transaction; it runs first, and the table goes again if the import doesn't.
  const ddlInTransaction = dialect.ddlInTransaction;
  const created = plan.create.length > 0;
  const stopped = (): ImportFailure => new ImportFailure("stopped", null, true);
  // Each returns why it couldn't, or null.
  const dropCreated = async (): Promise<string | null> => {
    if (!created || ddlInTransaction) {
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

  if (created && !ddlInTransaction) {
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
    if (created && ddlInTransaction) {
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
    // A stop that interrupted the statement in flight fails it: still a stop.
    const stop = signal.aborted || (error instanceof ImportFailure && error.stopped);
    const rollbackError = await rollback();
    if (rollbackError !== null) {
      // Nothing more is tried on a transaction that may still be open.
      throw new ImportFailure(
        stop ? "stopped" : messageOf(error),
        failedAt >= 0 ? failedAt : null,
        stop,
        rollbackError,
      );
    }
    if (stop || error instanceof ImportFailure || failedAt < 0) {
      const undoError = await dropCreated();
      if (stop) {
        throw new ImportFailure("stopped", null, true, undoError);
      }
      if (undoError !== null) {
        throw new ImportFailure(messageOf(error), null, false, undoError);
      }
      throw error;
    }
    const found = await locate(plan, session, signal, failedAt, onProgress);
    const undoError = found.undoError ?? (await dropCreated());
    if (found.row === null) {
      throw new ImportFailure(messageOf(error), failedAt, false, undoError, false, error);
    }
    throw new ImportFailure(messageOf(found.error), found.row, false, undoError, false, found.error);
  }
  try {
    await session.commit();
  } catch (error) {
    if (error instanceof CommitOutcomeUnknown) {
      // The table (MySQL's new one included) is left as the COMMIT left it.
      throw new ImportFailure(messageOf(error), null, false, null, true);
    }
    // Rolled back for certain: MySQL's new table goes too.
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
      if (plan.create.length > 0 && plan.spec.dialect.ddlInTransaction) {
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
