import descriptor from "../../../../crates/tablepeek-engine/src/engines/mysql/descriptor.json";
import type { Engine, EngineDescriptor } from "../types";
import { icon } from "./icon";
import { sql } from "./sql";

// MySQL and MariaDB.
export const mysql: Engine = {
  ...(descriptor as EngineDescriptor),
  icon,
  workbench: "sql",
  subtitle: "MariaDB · 3306",
  sql,
  errorHelp: {
    detect: /MySQL/,
    hints: {
      login_failed: [
        "MySQL 계정은 ‘사용자@접속 위치’ 단위입니다. 다른 곳에서는 되던 비밀번호도 이 위치(또는 SSH 서버)에서는 다른 계정으로 취급될 수 있습니다.",
      ],
      unknown_database: ["데이터베이스 칸을 비워 두고 연결한 뒤 ⌘K로 고를 수 있습니다."],
      syntax: ["MySQL에서 이름은 `백틱`으로, 문자열은 '작은따옴표'로 감쌉니다."],
      connection_refused: ["Cloud SQL 프록시로 로컬 포트(예: 127.0.0.1:3307)에 접속한다면, 프록시가 켜져 있는지 확인하세요."],
    },
  },
};
