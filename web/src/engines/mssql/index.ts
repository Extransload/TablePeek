import descriptor from "../../../../crates/tablepeek-engine/src/engines/mssql/descriptor.json";
import type { Engine, EngineDescriptor } from "../types";
import { icon } from "./icon";
import { sql } from "./sql";

// Microsoft SQL Server.
export const mssql: Engine = {
  ...(descriptor as EngineDescriptor),
  icon,
  workbench: "sql",
  subtitle: "기본 포트 1433",
  sql,
  errorHelp: {
    detect: /SQL Server|code: \d+, state:/,
    hints: {
      syntax: ["SQL Server는 LIMIT 대신 TOP이나 OFFSET … FETCH를 씁니다."],
    },
  },
};
