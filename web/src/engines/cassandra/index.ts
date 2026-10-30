import descriptor from "../../../../crates/tablepeek-engine/src/engines/cassandra/descriptor.json";
import type { Engine, EngineDescriptor } from "../types";
import { cqlErrorHelp } from "./errorHelp";
import { icon } from "./icon";
import { sql } from "./sql";

// Apache Cassandra, over CQL (docs/engines/cassandra.md).
export const cassandra: Engine = {
  ...(descriptor as EngineDescriptor),
  icon,
  workbench: "sql",
  subtitle: "CQL · 9042",
  sql,
  errorHelp: cqlErrorHelp,
};
