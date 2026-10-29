import descriptor from "../../../../crates/tablepeek-engine/src/engines/sqlite/descriptor.json";
import type { Engine, EngineDescriptor } from "../types";
import { icon } from "./icon";
import { sql } from "./sql";

// The file types the pickers offer for a SQLite database.
export const SQLITE_EXTENSIONS = ["db", "sqlite", "sqlite3", "db3"];

// SQLite: a database file on this machine.
export const sqlite: Engine = {
  ...(descriptor as EngineDescriptor),
  icon,
  workbench: "sql",
  subtitle: "",
  fileExtensions: SQLITE_EXTENSIONS,
  sql,
  errorHelp: {
    detect: /SQLite/,
    hints: {},
  },
};
