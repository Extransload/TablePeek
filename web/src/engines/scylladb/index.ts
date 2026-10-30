import descriptor from "../../../../crates/tablepeek-engine/src/engines/scylladb/descriptor.json";
import { cqlErrorHelp } from "../cassandra/errorHelp";
import { sql } from "../cassandra/sql";
import type { Engine, EngineDescriptor } from "../types";
import { icon } from "./icon";

// ScyllaDB: Cassandra's CQL, dialect and error advice (docs/engines/cassandra.md).
export const scylladb: Engine = {
  ...(descriptor as EngineDescriptor),
  icon,
  workbench: "sql",
  subtitle: "CQL · 9042",
  sql,
  errorHelp: cqlErrorHelp,
};
