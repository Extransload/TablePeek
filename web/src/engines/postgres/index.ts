import descriptor from "../../../../crates/tablepeek-engine/src/engines/postgres/descriptor.json";
import type { Engine, EngineDescriptor } from "../types";
import { icon } from "./icon";
import { sql } from "./sql";

// PostgreSQL.
export const postgres: Engine = {
  ...(descriptor as EngineDescriptor),
  icon,
  workbench: "sql",
  subtitle: "기본 포트 5432",
  sql,
  errorHelp: {
    detect: /PostgreSQL|SQLSTATE/,
    hints: {
      unknown_database: ["기본 데이터베이스 ‘postgres’로 먼저 연결한 뒤 ⌘K로 바꿀 수 있습니다."],
      syntax: ["PostgreSQL에서 이름은 \"큰따옴표\"로, 문자열은 '작은따옴표'로 감쌉니다."],
      unknown_table: [
        "PostgreSQL은 따옴표 없는 이름을 소문자로 바꿉니다. 대문자가 섞인 이름은 \"MyTable\"처럼 큰따옴표로 감싸세요.",
      ],
      unknown_column: ["PostgreSQL에서 큰따옴표(\"…\")는 이름을 뜻합니다. 문자열 값은 작은따옴표('…')로 감싸세요."],
      connection_refused: ["Cloud SQL 프록시로 로컬 포트(예: 127.0.0.1:5433)에 접속한다면, 프록시가 켜져 있는지 확인하세요."],
    },
  },
};
