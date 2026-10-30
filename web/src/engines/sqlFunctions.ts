// The engine families whose functions the table below tells apart.
export type SqlFunctionFamily = "postgres" | "mysql" | "mssql" | "sqlite" | "oracle";

// Functions people reach for, with their arguments and what they do; `only`
// the families that have them (all when absent).
export interface SqlFunction {
  name: string;
  args: string;
  about: string;
  only?: SqlFunctionFamily[];
  // Called with OVER (…): a window function.
  window?: boolean;
}

const FUNCTIONS: SqlFunction[] = [
  { name: "COUNT", args: "expr | *", about: "행 수 (NULL이 아닌 값의 수)" },
  { name: "SUM", args: "expr", about: "합계" },
  { name: "AVG", args: "expr", about: "평균" },
  { name: "MIN", args: "expr", about: "최솟값" },
  { name: "MAX", args: "expr", about: "최댓값" },
  { name: "COALESCE", args: "value, fallback, …", about: "NULL이 아닌 첫 값" },
  { name: "NULLIF", args: "a, b", about: "a와 b가 같으면 NULL, 아니면 a" },
  { name: "CAST", args: "expr AS type", about: "다른 타입으로 변환" },
  { name: "LOWER", args: "text", about: "소문자로" },
  { name: "UPPER", args: "text", about: "대문자로" },
  { name: "LENGTH", args: "text", about: "문자열 길이", only: ["postgres", "mysql", "sqlite", "oracle"] },
  { name: "LEN", args: "text", about: "문자열 길이 (끝 공백 제외)", only: ["mssql"] },
  { name: "SUBSTRING", args: "text, start, length", about: "부분 문자열", only: ["postgres", "mysql", "mssql", "sqlite"] },
  { name: "SUBSTR", args: "text, start, length", about: "부분 문자열", only: ["sqlite", "mysql", "postgres", "oracle"] },
  { name: "TRIM", args: "text", about: "앞뒤 공백 제거" },
  { name: "REPLACE", args: "text, from, to", about: "문자열 바꾸기" },
  { name: "CONCAT", args: "a, b, …", about: "문자열 잇기" },
  { name: "ROUND", args: "number, digits", about: "반올림" },
  { name: "ABS", args: "number", about: "절댓값" },
  { name: "NOW", args: "", about: "현재 시각", only: ["postgres", "mysql"] },
  { name: "DATE_TRUNC", args: "'day', timestamp", about: "단위로 자른 시각", only: ["postgres"] },
  { name: "EXTRACT", args: "field FROM timestamp", about: "시각에서 연·월·일 등을 꺼냄", only: ["postgres", "mysql", "oracle"] },
  { name: "TO_CHAR", args: "value, format", about: "서식에 맞춘 문자열", only: ["postgres", "oracle"] },
  { name: "DATE_FORMAT", args: "date, format", about: "서식에 맞춘 문자열", only: ["mysql"] },
  { name: "STRFTIME", args: "format, time", about: "서식에 맞춘 시각 문자열", only: ["sqlite"] },
  { name: "DATE", args: "time", about: "날짜 부분", only: ["sqlite", "mysql"] },
  { name: "DATEDIFF", args: "a, b", about: "두 날짜의 차이", only: ["mysql", "mssql"] },
  { name: "DATEADD", args: "part, amount, date", about: "날짜에 더하기", only: ["mssql"] },
  { name: "GETDATE", args: "", about: "현재 시각", only: ["mssql"] },
  { name: "IFNULL", args: "value, fallback", about: "NULL이면 fallback", only: ["mysql", "sqlite"] },
  { name: "ISNULL", args: "value, fallback", about: "NULL이면 fallback", only: ["mssql"] },
  { name: "STRING_AGG", args: "expr, separator", about: "값을 구분자로 이어 붙임", only: ["postgres", "mssql"] },
  { name: "GROUP_CONCAT", args: "expr", about: "값을 쉼표로 이어 붙임", only: ["mysql", "sqlite"] },
  { name: "ARRAY_AGG", args: "expr", about: "값을 배열로 모음", only: ["postgres"] },
  { name: "JSON_EXTRACT", args: "json, path", about: "JSON에서 값 꺼내기", only: ["mysql", "sqlite"] },
  { name: "JSONB_EXTRACT_PATH", args: "jsonb, key, …", about: "JSONB에서 값 꺼내기", only: ["postgres"] },
  { name: "NVL", args: "value, fallback", about: "NULL이면 fallback", only: ["oracle"] },
  { name: "NVL2", args: "value, if_not_null, if_null", about: "NULL이 아니면 둘째 값, NULL이면 셋째 값", only: ["oracle"] },
  { name: "DECODE", args: "expr, search, result, …, default", about: "값에 따라 결과를 고름 (CASE의 짧은 꼴)", only: ["oracle"] },
  { name: "TO_DATE", args: "text, 'YYYY-MM-DD HH24:MI:SS'", about: "문자열을 서식대로 날짜로", only: ["oracle"] },
  { name: "TO_TIMESTAMP", args: "text, 'YYYY-MM-DD HH24:MI:SS.FF'", about: "문자열을 서식대로 타임스탬프로", only: ["oracle"] },
  { name: "TO_NUMBER", args: "text", about: "문자열을 숫자로", only: ["oracle"] },
  { name: "ADD_MONTHS", args: "date, months", about: "날짜에 개월 수 더하기", only: ["oracle"] },
  { name: "MONTHS_BETWEEN", args: "a, b", about: "두 날짜 사이의 개월 수", only: ["oracle"] },
  { name: "TRUNC", args: "date | number, 'DD'", about: "날짜를 단위로, 숫자를 자릿수로 자름", only: ["oracle"] },
  { name: "LAST_DAY", args: "date", about: "그 달의 마지막 날", only: ["oracle"] },
  { name: "INSTR", args: "text, search", about: "부분 문자열의 위치 (없으면 0)", only: ["oracle"] },
  { name: "LPAD", args: "text, length, pad", about: "왼쪽을 채워 길이 맞추기", only: ["oracle"] },
  { name: "INITCAP", args: "text", about: "단어 첫 글자만 대문자로", only: ["oracle"] },
  { name: "REGEXP_LIKE", args: "text, pattern", about: "정규식에 맞는지 (WHERE 조건)", only: ["oracle"] },
  { name: "REGEXP_SUBSTR", args: "text, pattern", about: "정규식에 맞는 부분", only: ["oracle"] },
  { name: "REGEXP_REPLACE", args: "text, pattern, replacement", about: "정규식에 맞는 부분 바꾸기", only: ["oracle"] },
  { name: "LISTAGG", args: "expr, separator", about: "값을 구분자로 이어 붙임 (뒤에 WITHIN GROUP (ORDER BY …))", only: ["oracle"] },
  { name: "JSON_VALUE", args: "json, '$.path'", about: "JSON에서 값 꺼내기", only: ["oracle"] },
  { name: "JSON_QUERY", args: "json, '$.path'", about: "JSON에서 객체·배열 꺼내기", only: ["oracle"] },
  { name: "JSON_TABLE", args: "json, '$[*]' COLUMNS (…)", about: "JSON을 행과 열로 펼침", only: ["oracle"] },
  { name: "SYS_GUID", args: "", about: "새 고유 ID (RAW(16))", only: ["oracle"] },
  { name: "GREATEST", args: "a, b, …", about: "가장 큰 값", only: ["oracle"] },
  { name: "ROW_NUMBER", args: "", about: "창 안에서의 행 번호", window: true },
  { name: "RANK", args: "", about: "창 안에서의 순위 (같으면 건너뜀)", window: true },
  { name: "DENSE_RANK", args: "", about: "창 안에서의 순위 (건너뛰지 않음)", window: true },
  { name: "LAG", args: "expr, offset", about: "앞 행의 값", window: true },
  { name: "LEAD", args: "expr, offset", about: "뒤 행의 값", window: true },
];

// The functions an engine family offers, for a dialect's `functions`.
export function functionsFor(family: SqlFunctionFamily): readonly SqlFunction[] {
  return FUNCTIONS.filter((fn) => fn.only === undefined || fn.only.includes(family));
}

// With no connection the editor reads SQLite's SQL (see SqlEditor), so it
// offers SQLite's functions.
export const FUNCTIONS_WITHOUT_ENGINE = functionsFor("sqlite");
