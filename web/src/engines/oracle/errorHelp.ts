import type { ErrorRule, ErrorSituation } from "../../errorHelp";
import { t } from "../../i18n";

// Explanations of Oracle's own errors (docs/ERRORS.md §3), tried before the
// shared rules, which know Oracle's ORA- numbers for the situations they
// share (login, unknown table, syntax, locks, …). The server sends the ORA
// number as `server_code`; the message starts with it.

// Where a statement runs: the fixes about SQL text belong there.
function writingSql(situation: ErrorSituation): boolean {
  return situation.where === "editor" || situation.where === "general";
}

// The last name of Oracle's "OWNER"."TABLE"."COLUMN": the column.
function lastQuoted(path: string): string {
  const names = [...path.matchAll(/"([^"]*)"/g)].map((found) => found[1]);
  return names[names.length - 1] ?? path;
}

export const oracleErrorRules: ErrorRule[] = [
  {
    match: /ORA-00001: unique constraint \(([^)]+)\) violated/,
    help: (found, situation) => {
      const fixes = [t("다른 값을 넣거나, 기존 행을 수정하세요.")];
      if (writingSql(situation) || situation.where === "import") {
        fixes.push(t("자동 증가하는 id라면 값을 직접 넣지 말고 비워 두세요."));
      }
      if (situation.where === "import") {
        fixes.push(t("가져올 파일 안에 같은 값이 두 번 들어 있지 않은지도 확인하세요."));
      }
      return {
        title: t("이미 같은 값이 있어 저장할 수 없습니다"),
        cause: t("고유해야 하는 ‘{key}’에 같은 값이 이미 있습니다.", { key: found[1] }),
        fixes,
      };
    },
  },
  {
    match: /ORA-01400: cannot insert NULL into \(([^)]*)\)|ORA-01407: cannot update \(([^)]*)\) to NULL/,
    help: (found, situation) => {
      const fixes = [t("값을 채워 넣으세요."), t("Oracle은 빈 문자열('')을 NULL로 저장합니다. 비워 둘 수 없는 컬럼에는 빈 문자열도 넣을 수 없습니다.")];
      if (situation.where === "import") {
        fixes.push(t("가져올 파일에 이 컬럼이 빈 줄이 있는지, 컬럼 연결이 맞는지 확인하세요."));
      }
      const column = lastQuoted(found[1] ?? found[2] ?? "");
      return {
        title: t("{name}필수 값이 비어 있습니다", { name: column === "" ? "" : `‘${column}’ ` }),
        cause: t("이 컬럼은 비워 둘 수 없고(NOT NULL), 기본값도 없습니다."),
        fixes,
      };
    },
  },
  {
    match: /ORA-02291: integrity constraint \(([^)]+)\) violated/,
    help: (found) => ({
      title: t("참조하는 값이 상대 테이블에 없습니다"),
      cause: t("외래 키 ‘{key}’가 가리키는 행이 참조 대상 테이블에 없습니다.", { key: found[1] }),
      fixes: [t("값이 참조 대상 테이블에 실제로 있는지 확인하세요."), t("참조 대상 행을 먼저 만든 뒤 다시 저장하세요.")],
    }),
  },
  {
    match: /ORA-02292: integrity constraint \(([^)]+)\) violated/,
    help: (found) => ({
      title: t("다른 테이블이 참조하고 있어 지우거나 바꿀 수 없습니다"),
      cause: t("외래 키 ‘{key}’로 이 행을 참조하는 행이 아직 있습니다.", { key: found[1] }),
      fixes: [
        t("이 행을 참조하는 다른 테이블의 행을 먼저 지우거나 수정하세요."),
        t("외래 키에 ON DELETE CASCADE가 없으면 참조하는 행이 함께 지워지지 않습니다."),
      ],
    }),
  },
  {
    match: /ORA-02290: check constraint \(([^)]+)\) violated/,
    help: (found, situation) => ({
      title: t("{name}검사 조건(CHECK)에 맞지 않는 값입니다", { name: `‘${found[1]}’ ` }),
      cause: t("저장하려던 값이 테이블의 CHECK 제약을 만족하지 않습니다."),
      fixes:
        situation.where === "structure"
          ? [t("이 조건에 맞지 않는 기존 행을 먼저 고친 뒤 다시 적용하세요.")]
          : [t("조건에 맞는 값으로 바꾸세요."), t("조건 내용은 테이블 구조의 제약 조건 목록에서 볼 수 있습니다.")],
    }),
  },
  {
    match: /ORA-12899: value too large for column ((?:"[^"]*"\.?)+) \(actual: (\d+), maximum: (\d+)\)/,
    help: (found) => ({
      title: t("값이 컬럼 길이보다 깁니다"),
      cause: t("‘{column}’ 컬럼에는 {max}까지 들어가는데 {actual}인 값을 넣으려 했습니다.", {
        column: lastQuoted(found[1]),
        max: found[3],
        actual: found[2],
      }),
      fixes: [
        t("값을 줄이거나, 컬럼 길이(예: VARCHAR(255))를 늘리세요."),
        t("VARCHAR2(n)은 바이트로 셀 수 있습니다. 한글은 한 글자가 3바이트이니 VARCHAR2(n CHAR)로 늘리세요."),
      ],
    }),
  },
  {
    match: /ORA-01722: invalid number/,
    help: (_found, situation) => {
      const fixes = [t("숫자 컬럼에는 숫자만 넣으세요. 문자열 컬럼을 숫자와 비교할 때도 생깁니다 (예: WHERE code = 1 대신 WHERE code = '1').")];
      if (situation.where === "import") {
        fixes.push(t("가져올 파일에서 이 컬럼의 값 형식과 컬럼 연결이 맞는지 확인하세요."));
      }
      return {
        title: t("값이 컬럼 형식과 맞지 않습니다"),
        cause: t("숫자가 아닌 문자열을 숫자로 바꾸려 했습니다."),
        fixes,
      };
    },
  },
  {
    match: /ORA-01(?:821|830|839|84[0137]|85[08]|861)\b/,
    help: () => ({
      title: t("날짜·시간 형식이 맞지 않습니다"),
      cause: t("문자열을 날짜로 바꾸는 서식(NLS_DATE_FORMAT 또는 TO_DATE의 서식)과 값이 맞지 않습니다."),
      fixes: [
        t("TO_DATE('2026-10-21 14:30:00', 'YYYY-MM-DD HH24:MI:SS')처럼 서식을 함께 쓰거나, DATE '2026-10-21' 리터럴을 쓰세요."),
      ],
    }),
  },
  {
    match: /ORA-00904: ((?:"[^"]*"\.?)+|\S+): invalid identifier/,
    help: (found, situation) => {
      const fixes = [
        t("컬럼 이름의 철자를 확인하세요."),
        t("Oracle은 따옴표 없는 이름을 대문자로 바꿉니다. 소문자로 만든 이름은 \"name\"처럼 따옴표로 감싸세요."),
      ];
      if (writingSql(situation)) {
        fixes.push(t("다른 테이블의 컬럼이라면 테이블 이름이나 별칭을 앞에 붙이세요 (예: u.name)."));
      } else {
        fixes.push(t("다른 곳에서 컬럼이 지워졌거나 이름이 바뀌었다면 스키마를 새로고침하세요."));
      }
      return {
        title: t("{name}컬럼을 찾을 수 없습니다", { name: `‘${lastQuoted(found[1])}’ ` }),
        fixes,
        action: writingSql(situation) ? undefined : "refresh-schema",
      };
    },
  },
  {
    match: /ORA-28000\b/,
    help: () => ({
      title: t("계정이 잠겨 있습니다"),
      cause: t("로그인 실패가 반복되었거나 관리자가 계정을 잠갔습니다."),
      fixes: [t("DB 관리자에게 계정 잠금 해제(ALTER USER … ACCOUNT UNLOCK)를 요청하세요.")],
    }),
  },
  {
    match: /ORA-12514\b/,
    help: () => ({
      title: t("리스너가 이 서비스 이름을 모릅니다"),
      cause: t("호스트와 포트의 리스너에는 닿았지만, 그 이름으로 등록된 데이터베이스 서비스가 없습니다."),
      fixes: [
        t("서비스 이름을 확인하세요 (예: FREEPDB1, ORCLPDB1). 서버에서 lsnrctl services로 등록된 이름을 볼 수 있습니다."),
        t("SID로 접속하는 서버라면 접속 방식을 ‘SID’로 바꾸세요."),
        t("DB가 막 시작되었다면 리스너에 등록될 때까지 잠시 뒤 다시 시도하세요."),
      ],
    }),
  },
  {
    match: /ORA-12505\b/,
    help: () => ({
      title: t("리스너가 이 SID를 모릅니다"),
      cause: t("호스트와 포트의 리스너에는 닿았지만, 그 SID로 등록된 인스턴스가 없습니다."),
      fixes: [
        t("SID의 철자를 확인하세요."),
        t("PDB(예: FREEPDB1)에는 SID가 아니라 서비스 이름으로 접속합니다. 접속 방식을 ‘서비스 이름’으로 바꾸세요."),
      ],
    }),
  },
  {
    match: /ORA-04098: trigger '([^']+)' is invalid/,
    help: (found) => ({
      title: t("트리거 ‘{name}’에 컴파일 오류가 있습니다", { name: found[1] }),
      cause: t("이 테이블에 걸린 트리거가 INVALID 상태라, 트리거가 실행되는 작업이 모두 실패합니다."),
      fixes: [
        t("사이드바에서 트리거 정의를 열어 고친 뒤 다시 만드세요."),
        t("오류 내용은 USER_ERRORS 뷰에서 볼 수 있습니다."),
      ],
    }),
  },
  {
    match: /ORA-06550: line (\d+), column (\d+):\s*([^\n]*)/,
    help: (found) => ({
      title: t("PL/SQL 컴파일 오류 ({line}번째 줄, {column}번째 열)", { line: found[1], column: found[2] }),
      cause: found[3].trim() !== "" ? found[3].trim() : undefined,
      fixes: [
        t("줄 번호는 블록의 첫 줄(BEGIN 또는 DECLARE)부터 셉니다."),
        t("PL/SQL 블록은 끝의 END;까지가 한 문장입니다. 스크립트에서는 블록 다음 줄에 / 만 쓰세요."),
      ],
    }),
  },
  {
    match: /ORA-24344\b/,
    help: () => ({
      title: t("만들었지만 컴파일 오류가 있습니다"),
      cause: t("객체는 저장되었지만 INVALID 상태라 실행할 수 없습니다."),
      fixes: [
        t("오류 내용은 USER_ERRORS 뷰에서 볼 수 있습니다."),
        t("고친 뒤 CREATE OR REPLACE로 다시 실행하세요."),
      ],
    }),
  },
  {
    match: /ORA-01950\b/,
    help: () => ({
      title: t("테이블스페이스에 쓸 권한이 없습니다"),
      cause: t("이 계정에는 테이블스페이스 할당량(QUOTA)이 없어 행이나 테이블을 저장할 수 없습니다."),
      fixes: [t("DB 관리자에게 ALTER USER … QUOTA UNLIMITED ON 테이블스페이스를 요청하세요.")],
    }),
  },
];
