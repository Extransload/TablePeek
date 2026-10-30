import type { ErrorRule } from "../../errorHelp";
import { t } from "../../i18n";
import type { EngineErrorHelp } from "../types";

// Explanations of Cassandra's and ScyllaDB's own errors (docs/ERRORS.md §3).
// The server sends the CQL error code as `cql_<hex>` (cql_2200 Invalid,
// cql_2000 syntax, cql_0100 bad credentials, cql_1000 unavailable,
// cql_1200 read timeout …); the rules read the message, which both servers
// write in English.
const rules: ErrorRule[] = [
  {
    match: /ALLOW FILTERING/,
    help: () => ({
      title: t("키가 아닌 컬럼으로 거르려면 ALLOW FILTERING이 필요합니다"),
      cause: t("CQL은 파티션 키·클러스터링 키 조건으로만 바로 찾습니다. 다른 컬럼 조건은 테이블 전체를 훑어야 합니다."),
      fixes: [
        t("파티션 키를 = 조건으로 넣어 범위를 좁히세요."),
        t("데이터 탭에서는 필터 막대의 ‘ALLOW FILTERING’ 스위치를 켜고, 쿼리에서는 문장 끝에 ALLOW FILTERING을 붙이세요. 큰 테이블에서는 느리거나 시간 초과가 날 수 있습니다."),
        t("자주 거르는 컬럼이면 보조 인덱스(SAI)를 만드세요."),
      ],
    }),
  },
  {
    match: /ORDER BY is only supported when the partition key is restricted|Order by is currently only supported/i,
    help: () => ({
      title: t("파티션 키를 고정해야 정렬할 수 있습니다"),
      cause: t("CQL은 한 파티션 안에서만, 클러스터링 키 순서로만 정렬합니다."),
      fixes: [
        t("파티션 키를 = 또는 IN 조건으로 걸러 한 파티션만 읽은 뒤 클러스터링 키로 정렬하세요."),
        t("정렬을 지우면 저장된 순서(파티션 토큰 순)로 읽습니다."),
      ],
    }),
  },
  {
    match: /(?:Some partition key parts are missing|Cannot execute this query as it might involve|PRIMARY KEY column "?([\w]+)"? cannot be restricted|Missing (?:mandatory )?PRIMARY KEY part ([\w]+)|Some clustering keys are missing)/,
    help: (found) => ({
      title: t("기본 키 조건이 부족합니다"),
      cause: found[1] ?? found[2]
        ? t("키 컬럼 {name}의 조건이 없거나 순서가 맞지 않습니다.", { name: found[1] ?? found[2] })
        : t("UPDATE·DELETE는 기본 키 전체를, 조회는 앞쪽 키부터 차례로 조건을 줘야 합니다."),
      fixes: [t("파티션 키의 모든 컬럼을 = 조건으로 넣고, 클러스터링 키는 앞에서부터 차례로 거르세요.")],
    }),
  },
  {
    match: /Undefined column name ([\w"]+)/,
    help: (found) => ({
      title: t("컬럼 {name}이(가) 없습니다", { name: found[1] }),
      cause: t("대문자나 공백이 든 이름은 \"큰따옴표\"로 감싸야 그대로 읽힙니다. 따옴표 없는 이름은 소문자로 바뀝니다."),
      fixes: [t("구조 탭에서 컬럼 이름을 확인하세요.")],
      action: "refresh-schema",
    }),
  },
  {
    match: /(?:unconfigured table|table) ([\w.]+)(?: does not exist)?/,
    when: (raw) => /unconfigured table|does not exist/.test(raw) && !/[Kk]eyspace/.test(raw),
    help: (found) => ({
      title: t("테이블 {name}이(가) 없습니다", { name: found[1] }),
      cause: t("다른 키스페이스의 테이블이면 키스페이스.테이블 로 쓰거나 USE 키스페이스 로 바꾸세요."),
      fixes: [t("사이드바를 새로고침해 테이블 목록을 확인하세요.")],
      action: "refresh-schema",
    }),
  },
  {
    match: /Keyspace '?"?([\w]+)"?'? does not exist/i,
    help: (found) => ({
      title: t("키스페이스 {name}이(가) 없습니다", { name: found[1] }),
      fixes: [t("연결의 ‘키스페이스’ 칸을 비우면 모든 키스페이스를 볼 수 있습니다.")],
    }),
  },
  {
    match: /Cannot achieve consistency level (\w+)|Not enough replicas available/,
    code: /\bcql_1000\b/,
    help: (found) => ({
      title: t("일관성 수준 {level}을(를) 맞출 복제본이 부족합니다", { level: found[1] ?? "" }),
      cause: t("살아 있는 복제본이 요청한 일관성 수준보다 적습니다. 노드가 내려갔거나 키스페이스의 복제 계수가 작습니다."),
      fixes: [t("탭 막대의 일관성 수준을 ONE이나 LOCAL_ONE으로 낮추거나, 내려간 노드를 확인하세요.")],
    }),
  },
  {
    match: /Operation timed out|ReadTimeout|WriteTimeout|timed out/,
    code: /\bcql_1(?:100|200)\b/,
    help: () => ({
      title: t("서버가 시간 안에 답하지 못했습니다"),
      cause: t("복제본이 제때 응답하지 않았습니다. ALLOW FILTERING으로 넓게 훑거나 큰 파티션을 읽으면 자주 생깁니다."),
      fixes: [t("파티션 키 조건으로 범위를 좁히거나, 설정의 쿼리 시간 제한을 늘리세요.")],
    }),
  },
  {
    match: /Provided username .* incorrect|Bad credentials|Authentication failed|Username and\/or password are incorrect/i,
    code: /\bcql_0100\b/,
    help: () => ({
      title: t("로그인에 실패했습니다"),
      cause: t("사용자 이름이나 비밀번호가 맞지 않습니다."),
      fixes: [t("인증을 켠 클러스터에서는 사용자와 비밀번호를 넣으세요. 기본 관리자는 cassandra / cassandra입니다.")],
    }),
  },
  {
    match: /Required key not provided|Required authentication|requires authentication/i,
    help: () => ({
      title: t("이 클러스터는 로그인이 필요합니다"),
      fixes: [t("연결을 편집해 사용자와 비밀번호를 넣으세요.")],
    }),
  },
  {
    match: /Invalid STRING constant|Invalid INTEGER constant|Invalid (?:unset )?value for column|cannot be passed as argument|Expected \d+ or \d+ byte|Unable to make (\w+) from/,
    help: () => ({
      title: t("값이 컬럼 타입에 맞지 않습니다"),
      cause: t("CQL은 값의 타입을 엄격히 봅니다: uuid는 따옴표 없이, 텍스트는 '작은따옴표'로, 컬렉션은 [..], {..}로 씁니다."),
      fixes: [t("셀에서 컬렉션·UDT는 JSON으로 입력하세요 (예: [\"a\",\"b\"], {\"key\":\"value\"}).")],
    }),
  },
  {
    match: /Cannot use selection function writeTime on|counter|Cannot set the value of counter/i,
    when: (raw) => /counter/i.test(raw) && /Cannot|Invalid/.test(raw),
    help: () => ({
      title: t("counter 컬럼은 더하기·빼기로만 바뀝니다"),
      fixes: [t("UPDATE … SET c = c + 1 처럼 쓰세요. counter 테이블에는 INSERT가 없습니다.")],
    }),
  },
  {
    match: /User defined functions are disabled|user_defined_functions_enabled|enable_user_defined_functions/,
    help: () => ({
      title: t("서버에서 사용자 정의 함수가 꺼져 있습니다"),
      fixes: [t("Cassandra는 cassandra.yaml의 user_defined_functions_enabled, ScyllaDB는 experimental-features udf를 켜야 합니다.")],
    }),
  },
  {
    match: /Materialized views are disabled/,
    help: () => ({
      title: t("서버에서 구체화된 뷰가 꺼져 있습니다"),
      fixes: [t("cassandra.yaml에서 materialized_views_enabled: true로 켜세요.")],
    }),
  },
];

export const cqlErrorHelp: EngineErrorHelp = {
  detect: /Cassandra|ScyllaDB|cql_[0-9A-F]{4}|ALLOW FILTERING|unconfigured table/,
  hints: {
    syntax: ["CQL에서 이름은 \"큰따옴표\"로, 문자열은 '작은따옴표'로 감쌉니다. JOIN·서브쿼리·OR는 없습니다."],
    connection_refused: ["Cassandra의 기본 포트는 9042입니다. 노드가 막 켜졌다면 1분쯤 뒤에 다시 시도하세요."],
    unknown_table: ["키스페이스를 고르지 않은 연결에서는 테이블을 키스페이스.테이블 로 씁니다."],
  },
  rules,
};
