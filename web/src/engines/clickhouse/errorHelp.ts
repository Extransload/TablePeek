import type { ErrorRule } from "../../errorHelp";
import { t } from "../../i18n";

// Explanations of ClickHouse's own errors (docs/ERRORS.md §3). The server
// sends ClickHouse's number as the code ("clickhouse_159") and its name
// (TIMEOUT_EXCEEDED) beside the message.
export const clickhouseRules: ErrorRule[] = [
  {
    code: /^clickhouse_159$/,
    match: /TIMEOUT_EXCEEDED|Timeout exceeded/,
    help: () => ({
      title: t("쿼리가 실행 시간 제한을 넘었습니다"),
      cause: t("max_execution_time에 걸려 서버가 쿼리를 멈췄습니다."),
      fixes: [
        t("설정의 쿼리 시간 제한(초)을 늘리거나 0으로 두면 제한이 없어집니다."),
        t("WHERE로 읽을 범위를 좁히거나 정렬 키를 쓰는 조건을 더하세요."),
      ],
    }),
  },
  {
    code: /^clickhouse_241$/,
    match: /MEMORY_LIMIT_EXCEEDED|Memory limit/,
    help: () => ({
      title: t("메모리 한도를 넘었습니다"),
      cause: t("쿼리에 필요한 메모리가 서버나 사용자의 한도보다 큽니다."),
      fixes: [
        t("GROUP BY·JOIN·ORDER BY가 다루는 행을 줄이거나 LIMIT을 두세요."),
        t("SETTINGS max_bytes_before_external_group_by로 디스크를 쓰게 할 수 있습니다."),
      ],
    }),
  },
  {
    code: /^clickhouse_420$/,
    match: /CANNOT_UPDATE_COLUMN|Cannot UPDATE key column/,
    help: () => ({
      title: t("키 컬럼은 고칠 수 없습니다"),
      cause: t("정렬 키·파티션 키에 든 컬럼은 ALTER TABLE … UPDATE로 바꿀 수 없습니다."),
      fixes: [t("행을 지우고 새 값으로 다시 넣으세요.")],
    }),
  },
  {
    code: /^clickhouse_(164|497)$/,
    match: /READONLY|ACCESS_DENIED|readonly mode|Not enough privileges/,
    help: () => ({
      title: t("이 계정으로는 할 수 없는 작업입니다"),
      cause: t("계정이 읽기 전용(readonly)이거나 이 작업의 권한(GRANT)이 없습니다."),
      fixes: [t("권한이 있는 계정으로 연결하거나 관리자에게 GRANT를 요청하세요.")],
    }),
  },
  {
    code: /^clickhouse_516$/,
    match: /AUTHENTICATION_FAILED|Authentication failed/,
    help: () => ({
      title: t("로그인하지 못했습니다"),
      cause: t("사용자 이름이나 비밀번호가 맞지 않거나, 이 주소에서의 접속이 허용되지 않았습니다."),
      fixes: [
        t("사용자와 비밀번호를 확인하세요. 기본 사용자는 default입니다."),
        t("users.xml이나 CREATE USER … HOST로 접속 주소가 막혀 있지 않은지 확인하세요."),
      ],
    }),
  },
  {
    code: /^clickhouse_252$/,
    match: /TOO_MANY_PARTS|Too many parts/,
    help: () => ({
      title: t("파트가 너무 많습니다"),
      cause: t("작은 INSERT가 너무 자주 들어와 병합이 따라가지 못합니다."),
      fixes: [t("행을 모아 한 번에 많이 넣거나 async_insert를 켜세요.")],
    }),
  },
];
