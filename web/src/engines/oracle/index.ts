import descriptor from "../../../../crates/tablepeek-engine/src/engines/oracle/descriptor.json";
import type { Engine, EngineDescriptor } from "../types";
import { oracleErrorRules } from "./errorHelp";
import { icon } from "./icon";
import { sql } from "./sql";

// Oracle Database.
export const oracle: Engine = {
  ...(descriptor as EngineDescriptor),
  icon,
  workbench: "sql",
  subtitle: "기본 포트 1521",
  sql,
  errorHelp: {
    detect: /ORA-\d{5}|DPY-\d{4}|DPI-\d{4}|Oracle/,
    hints: {
      login_failed: [
        "SYS로 접속하려면 고급 설정의 접속 권한을 SYSDBA로 고르세요.",
        "PDB에 만든 사용자라면 서비스 이름이 그 PDB(예: FREEPDB1)여야 합니다.",
      ],
      unknown_table: [
        "Oracle은 따옴표 없는 이름을 대문자로 바꿉니다. 소문자로 만든 테이블이라면 \"orders\"처럼 따옴표로 감싸세요.",
        "다른 스키마의 테이블은 소유자를 앞에 붙이세요 (예: HR.EMPLOYEES). 읽을 권한이 없을 때도 이 오류가 납니다.",
      ],
      syntax: [
        "Oracle은 LIMIT 대신 FETCH FIRST n ROWS ONLY를 씁니다.",
        "테이블 없이 계산할 때도 FROM이 필요합니다: SELECT 1 FROM DUAL.",
        "PL/SQL 블록(BEGIN … END;)과 CREATE PROCEDURE 같은 정의는 END; 다음 줄에 / 만 써서 끝내세요.",
      ],
      connection_refused: ["Oracle 리스너의 포트(기본 1521)와 리스너가 켜져 있는지(lsnrctl status) 확인하세요."],
    },
    rules: oracleErrorRules,
  },
};
