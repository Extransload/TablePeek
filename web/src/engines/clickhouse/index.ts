import descriptor from "../../../../crates/tablepeek-engine/src/engines/clickhouse/descriptor.json";
import type { Engine, EngineDescriptor } from "../types";
import { clickhouseRules } from "./errorHelp";
import { icon } from "./icon";
import { sql } from "./sql";

// ClickHouse, over its HTTP interface.
export const clickhouse: Engine = {
  ...(descriptor as EngineDescriptor),
  icon,
  workbench: "sql",
  subtitle: "HTTP 8123 · HTTPS 8443",
  sql,
  errorHelp: {
    detect: /ClickHouse|DB::Exception|clickhouse_\d+/,
    hints: {
      syntax: ["ClickHouse에서 이름은 `백틱`으로, 문자열은 '작은따옴표'로 감쌉니다. 함수 이름은 대소문자를 가립니다."],
      unknown_table: ["다른 데이터베이스의 테이블은 db.table로 쓰거나 ⌘K로 데이터베이스를 바꾸세요."],
      connection_refused: ["HTTP 포트(8123, HTTPS는 8443)로 연결하세요. 9000은 네이티브 프로토콜 포트입니다."],
      login_failed: ["ClickHouse의 기본 사용자는 default이며, 비밀번호가 없을 수 있습니다."],
    },
    rules: clickhouseRules,
  },
};
