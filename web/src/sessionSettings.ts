import { quoteLiteral } from "./export";

// Session settings a dump sets for its own run: mysqldump's
// FOREIGN_KEY_CHECKS=0 and the rest (put back by its last lines), pg_dump's
// empty search_path (never put back), our backups' PRAGMA foreign_keys =
// OFF. The connection's session outlives the restore, so a restore reads
// them first and puts them back after, whether the file got to its end or not.

const MYSQL = [
  "foreign_key_checks",
  "unique_checks",
  "sql_mode",
  "time_zone",
  "sql_notes",
  "character_set_client",
  "character_set_results",
  "collation_connection",
];

const POSTGRES = [
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

// One row of the settings, or null where the engine has none worth keeping.
export function snapshotSql(kind: string): string | null {
  switch (kind) {
    case "mysql":
      return `SELECT ${MYSQL.map((name) => `@@SESSION.${name}`).join(", ")}`;
    case "postgres":
      // Missing settings (an older server) read as NULL and are left alone.
      return `SELECT ${POSTGRES.map((name) => `current_setting('${name}', true)`).join(", ")}`;
    case "cockroach":
      return "SELECT current_setting('search_path')";
    case "sqlite":
      return "PRAGMA foreign_keys";
    default:
      return null;
  }
}

function settingValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  const text = String(value);
  return /^\d+$/.test(text) ? text : quoteLiteral(text);
}

// The statement that puts the snapshot back, or null.
export function restoreSql(kind: string, row: unknown[] | undefined): string | null {
  if (row === undefined) {
    return null;
  }
  switch (kind) {
    case "mysql":
      return `SET SESSION ${MYSQL.map((name, index) => `${name} = ${settingValue(row[index])}`).join(", ")}`;
    case "postgres": {
      const sets = POSTGRES.flatMap((name, index) =>
        row[index] === null || row[index] === undefined
          ? []
          : [`set_config('${name}', ${quoteLiteral(String(row[index]))}, false)`],
      );
      return sets.length === 0 ? null : `SELECT ${sets.join(", ")}`;
    }
    case "cockroach":
      // As SHOW gives it: a list of names, quoted where they need it.
      return typeof row[0] === "string" && row[0].trim() !== "" ? `SET search_path = ${row[0]}` : null;
    case "sqlite":
      return row[0] === 0 || row[0] === 1 ? `PRAGMA foreign_keys = ${row[0] === 1 ? "ON" : "OFF"}` : null;
    default:
      return null;
  }
}
