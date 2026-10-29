import descriptor from "../../../../crates/tablepeek-engine/src/engines/cockroach/descriptor.json";
import type { Engine, EngineDescriptor } from "../types";
import { icon } from "./icon";
import { sql } from "./sql";

// CockroachDB, spoken to over the PostgreSQL protocol; its errors read as
// PostgreSQL's, so PostgreSQL's error advice covers it.
export const cockroach: Engine = {
  ...(descriptor as EngineDescriptor),
  icon,
  workbench: "sql",
  subtitle: "PG 호환 · 26257",
  sql,
};
