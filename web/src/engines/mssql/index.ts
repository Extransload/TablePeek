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
      connection_refused: ["Cloud SQL 프록시로 로컬 포트(예: 127.0.0.1:1433)에 접속한다면, 프록시가 켜져 있는지 확인하세요."],
    },
  },
};
