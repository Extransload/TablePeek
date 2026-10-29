import { engineById, engines, type EngineErrorHelp, type ErrorHint } from "./engines";
import { t } from "./i18n";

// Turns raw driver and server errors into an explanation a person can act
// on: what happened, the likely cause, and what to try. Rules match the
// English driver text and, where the server is localized, the error codes
// (MySQL "ERROR 1045", PostgreSQL "[SQLSTATE 28P01]", SQL Server "code: 18456").
// Rules for one engine's own errors live in engines/<id>/ (errorHelp.rules).

// An error as the TablePeek server reports it (docs/ERRORS.md §2). The field
// names are the server's JSON, so a reply body passes through unchanged.
export interface AppError {
  code: string;
  message: string;
  sqlstate?: string;
  // 1-based character offset in the statement (PostgreSQL), or line and column.
  position?: { offset?: number; line?: number; column?: number };
  // The engine's own number: MySQL errno, SQL Server number, MongoDB code.
  server_code?: number;
  // MongoDB's codeName ("DuplicateKey").
  code_name?: string;
  // MongoDB errInfo and write errors, PostgreSQL detail/constraint/column.
  details?: unknown;
  // The driver's full original text.
  raw?: string;
}

// Where the error is shown; a rule offers only the fixes that make sense there
// (no "edit the connection" inside the connection dialog).
export type ErrorContext =
  | "connect"
  | "editor"
  | "data"
  | "import"
  | "export"
  | "structure"
  | "document"
  | "shell"
  | "aggregation"
  | "admin"
  | "general";

// A fix the UI can apply for the user with one click. The screen showing the
// error decides whether it can (ErrorNotice's onFix).
export type ErrorAction = "ssl-off" | "ssl-on" | "direct-connection" | "open-validation" | "refresh-schema";

export interface ErrorHelp {
  title: string;
  cause?: string;
  fixes: string[];
  action?: ErrorAction;
}

// What a rule knows about the error it explains.
export interface ErrorSituation {
  // The text the rules read: the message and the driver's original text,
  // plus the codes as the drivers print them.
  raw: string;
  code: string;
  error: AppError;
  where: ErrorContext;
  // The engine whose error this is, when it can be told.
  engineId: string | null;
  engine: EngineErrorHelp | null;
}

export interface ErrorRule {
  // The driver's message; its groups pick out names for the explanation.
  match?: RegExp;
  // Error codes that mean the same thing when the message is localized. Codes
  // shared by different situations (PostgreSQL 57014: cancelled or timed out;
  // 23503: either side of a foreign key) are left to the message.
  code?: RegExp;
  // For a rule that needs more than one pattern to hold.
  when?(raw: string, situation: ErrorSituation): boolean;
  // Generic network wording. A database error can echo it from user data (a
  // constraint named "timed out"), so these rules skip messages with a code.
  network?: boolean;
  help(found: RegExpExecArray, situation: ErrorSituation): ErrorHelp;
}

const UNTRUSTED_CERT = /UnknownIssuer|unknown issuer|self[- ]signed/i;
const TLS_REQUIRED = /insecure transport|ERROR 3159\b/;
const DATABASE_CODE = /ERROR \d{4}\b|\[SQLSTATE \w{5}\]|\(code: \d+, state:/;
// Classifying looks at the start only; the full message is still shown.
const SCAN_LIMIT = 4000;

function codeOnly(raw: string): RegExpExecArray {
  return Object.assign([""], { index: 0, input: raw }) as unknown as RegExpExecArray;
}

// The local TablePeek server could not be reached (see store.ts). The
// message may arrive translated, so it is matched in both languages.
const APP_SERVER_DOWN = "서버에 연결할 수 없습니다";

// "PostgreSQL 5432", or every server engine's port when the engine isn't known.
function defaultPorts(situation: ErrorSituation): string {
  const one = situation.engineId !== null ? engineById(situation.engineId) : undefined;
  return (one?.default_port !== undefined ? [one] : engines())
    .filter((engine) => engine.default_port !== undefined)
    .map((engine) => `${engine.label} ${engine.default_port}`)
    .join(" · ");
}

// The engine's own advice for a situation, translated.
function hints(situation: ErrorSituation, hint: ErrorHint): string[] {
  return (situation.engine?.hints[hint] ?? []).map((key) => t(key));
}

// A string field of the server's details (PostgreSQL detail, constraint, …).
function detailOf(error: AppError, key: string): string {
  const details = error.details;
  if (details === null || typeof details !== "object") {
    return "";
  }
  const value = (details as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

// Where a statement runs: the fixes about SQL text (quoting, ⌘K) belong there.
function writingSql(situation: ErrorSituation): boolean {
  return situation.where === "editor" || situation.where === "general";
}

function unquote(name: string): string {
  return name.replace(/[`']/g, "");
}

// The first capture group that matched, for patterns with alternatives.
function pick(found: RegExpExecArray, ...groups: number[]): string {
  for (const group of groups) {
    const value = found[group];
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  return "";
}

function quoted(name: string): string {
  return name === "" ? "" : `‘${name}’ `;
}

function tokenHelp(): ErrorHelp {
  return {
    title: t("TablePeek이 다시 시작되어 이 창의 접속 주소가 더 이상 맞지 않습니다"),
    cause: t("TablePeek은 시작할 때마다 보안을 위해 새 접속 주소를 만듭니다. 이 창은 이전 주소로 열려 있습니다."),
    fixes: [t("TablePeek을 실행한 곳(터미널이나 앱)에 표시된 새 주소로 이 페이지를 다시 여세요.")],
  };
}

function appServerDownHelp(): ErrorHelp {
  return {
    title: t("TablePeek 서버에 연결할 수 없습니다"),
    cause: t("브라우저와 TablePeek 서버 사이의 연결이 끊겼습니다. 서버가 종료되었거나 다시 시작되는 중입니다."),
    fixes: [
      t("TablePeek이 아직 실행 중인지 확인하세요."),
      t("종료되었다면 TablePeek을 다시 실행한 뒤, 새로 표시된 주소로 여세요."),
    ],
  };
}

const ASK_ADMIN_FOR_GRANT = "DB 관리자에게 이 작업에 필요한 권한을 요청하세요.";
const USE_OTHER_ACCOUNT = "권한이 있는 다른 계정으로 연결해서 실행하세요.";

const RULES: ErrorRule[] = [
  // ── TablePeek itself ──────────────────────────────────────────────
  { match: /토큰이 유효하지 않습니다/, help: tokenHelp },
  {
    match: /허용되지 않은 Host 헤더/,
    help: () => ({
      title: t("허용되지 않은 주소로 접속했습니다"),
      cause: t("보안을 위해 TablePeek에는 이 컴퓨터의 주소(127.0.0.1 또는 localhost)로만 접속할 수 있습니다."),
      fixes: [t("주소창의 호스트 부분을 127.0.0.1로 바꿔 다시 여세요.")],
    }),
  },
  // ── SSH and proxy tunnels ─────────────────────────────────────────
  {
    match: /암호화된 SSH 키/,
    help: () => ({
      title: t("암호가 걸린 SSH 키는 아직 쓸 수 없습니다"),
      fixes: [t("암호가 없는 별도의 키를 쓰거나, SSH 비밀번호 인증으로 바꾸세요.")],
    }),
  },
  {
    match: /SSH 키를 불러올 수 없습니다/,
    help: () => ({
      title: t("SSH 키 파일을 읽을 수 없습니다"),
      fixes: [
        t("키 파일 경로가 맞는지 확인하세요."),
        t("개인 키(id_ed25519, id_rsa 등)를 지정해야 합니다. 공개 키(.pub)는 쓸 수 없습니다."),
      ],
    }),
  },
  {
    match: /SSH (?:키|비밀번호) 인증에 실패했습니다/,
    help: () => ({
      title: t("SSH 로그인에 실패했습니다"),
      cause: t("SSH 서버가 사용자 이름이나 비밀번호·키를 받아들이지 않았습니다."),
      fixes: [
        t("SSH 사용자 이름을 확인하세요. DB 사용자와 다를 수 있습니다."),
        t("키 인증이라면 그 공개 키가 서버의 ~/.ssh/authorized_keys에 등록되어 있어야 합니다."),
      ],
    }),
  },
  {
    match: /SSH 서버에 연결할 수 없습니다/,
    help: () => ({
      title: t("SSH 서버에 연결할 수 없습니다"),
      cause: t("SSH 호스트와 포트로 접속하지 못했습니다."),
      fixes: [
        t("SSH 호스트와 포트(보통 22)를 확인하세요."),
        t("VPN이 필요한 서버인지, 방화벽이 막고 있지 않은지 확인하세요."),
      ],
    }),
  },
  {
    match: /SSH 협상에 실패했습니다/,
    help: () => ({
      title: t("SSH 서버와 연결 방식을 맞추지 못했습니다"),
      fixes: [t("SSH 포트가 맞는지 확인하세요. 다른 서비스의 포트로 접속하면 이 오류가 납니다.")],
    }),
  },
  {
    match: /HTTP 프록시가 터널을 거부했습니다: (\d+)/,
    help: (found) => ({
      title: t("HTTP 프록시가 연결을 거부했습니다 ({status})", { status: found[1] }),
      fixes: [
        t("프록시 주소와 포트를 확인하세요."),
        found[1] === "407"
          ? t("407은 프록시 로그인이 필요하다는 뜻입니다. 프록시 사용자와 비밀번호를 입력하세요.")
          : t("프록시가 이 DB 주소로의 연결을 허용하는지 관리자에게 확인하세요."),
      ],
    }),
  },
  // ── TLS / SSL ─────────────────────────────────────────────────────
  {
    when: (raw) => UNTRUSTED_CERT.test(raw) && TLS_REQUIRED.test(raw),
    help: () => ({
      title: t("서버가 SSL 연결만 받는데, 서버 인증서를 신뢰할 수 없습니다"),
      cause: t(
        "이 서버는 암호화되지 않은 연결을 거부합니다. 그런데 서버 인증서를 발급한 기관(CA)을 이 컴퓨터가 알지 못해 SSL 연결도 맺지 못했습니다.",
      ),
      fixes: [
        t("서버의 CA 인증서 파일을 ‘CA 인증서’에 지정하세요. (Cloud SQL: server-ca.pem, AWS RDS: global-bundle.pem)"),
      ],
    }),
  },
  {
    match: /insecure transport are prohibited|require_secure_transport|SSL connection is required/i,
    code: /ERROR 3159\b/,
    help: () => ({
      title: t("서버가 SSL(암호화) 연결만 허용합니다"),
      cause: t("이 서버는 암호화되지 않은 연결을 거부합니다."),
      fixes: [
        t("SSL 모드를 ‘필수’로 바꾸세요."),
        t("서버 인증서가 사설 CA에서 발급되었다면 CA 인증서 파일도 지정하세요."),
      ],
      action: "ssl-on",
    }),
  },
  {
    match: /UnknownIssuer|unknown issuer|self[- ]signed certificate|unable to get local issuer|certificate verify failed|UnknownCA/i,
    help: () => ({
      title: t("서버 인증서를 신뢰할 수 없습니다"),
      cause: t(
        "SSL로 연결하면서 서버 인증서를 확인했는데, 발급 기관(CA)이 이 컴퓨터가 신뢰하는 목록에 없습니다. 자체 서명 인증서나 클라우드 DB(Cloud SQL, RDS 등)의 전용 CA에서 흔히 생깁니다.",
      ),
      fixes: [
        t("서버의 CA 인증서 파일을 ‘CA 인증서’에 지정하세요. (Cloud SQL: server-ca.pem, AWS RDS: global-bundle.pem)"),
        t("SSH 터널이나 사내망처럼 이미 안전한 경로로 접속한다면 SSL 모드를 ‘사용 안 함’으로 바꿔도 됩니다."),
      ],
      action: "ssl-off",
    }),
  },
  {
    match: /NotValidForName|not valid for name|certificate is not valid for|hostname mismatch/i,
    help: () => ({
      title: t("인증서의 서버 이름이 접속 주소와 다릅니다"),
      cause: t(
        "서버 인증서에 적힌 이름과 지금 접속한 호스트 이름이 다릅니다. IP 주소나 SSH 터널(127.0.0.1)로 접속할 때 자주 생깁니다.",
      ),
      fixes: [
        t("인증서에 적힌 호스트 이름으로 접속하세요."),
        t("SSH 터널은 이미 암호화되므로, 터널로 접속한다면 SSL 모드를 ‘사용 안 함’으로 두어도 됩니다."),
      ],
      action: "ssl-off",
    }),
  },
  {
    match: /invalid peer certificate: Expired|certificate expired|certificate has expired|NotValidYet|not valid yet/i,
    help: () => ({
      title: t("서버 인증서의 유효 기간이 맞지 않습니다"),
      cause: t("서버 인증서가 만료되었거나, 아직 유효 기간이 시작되지 않았습니다."),
      fixes: [
        t("서버 관리자에게 인증서 갱신을 요청하세요."),
        t("이 컴퓨터의 날짜와 시간이 맞는지 확인하세요."),
      ],
    }),
  },
  {
    match: /server does not support (?:TLS|SSL)|does not have this capability|NoClientSslFlagFromServer/i,
    help: () => ({
      title: t("서버가 SSL을 지원하지 않습니다"),
      fixes: [t("SSL 모드를 ‘사용 안 함’ 또는 ‘가능하면’으로 바꾸세요.")],
      action: "ssl-off",
    }),
  },
  // ── Logging in ────────────────────────────────────────────────────
  {
    match: /password has expired|must reset your password/i,
    code: /ERROR (?:1820|1862)\b/,
    help: () => ({
      title: t("비밀번호가 만료되었습니다"),
      cause: t("서버가 이 계정의 비밀번호를 바꾸기 전까지 다른 작업을 막고 있습니다."),
      fixes: [t("DB 관리자에게 비밀번호 재설정을 요청하거나, 명령줄 클라이언트에서 ALTER USER로 새 비밀번호를 지정하세요.")],
    }),
  },
  {
    match: /Host '([^']+)' is not allowed to connect/,
    code: /ERROR 1130\b/,
    help: (found) => ({
      title: t("이 위치에서는 접속이 허용되지 않습니다"),
      cause: t("서버가 {host}에서 오는 접속을 받지 않도록 설정되어 있습니다.", {
        host: found[1] ? `‘${found[1]}’` : t("이 컴퓨터"),
      }),
      fixes: [
        t("DB 관리자에게 이 주소에서 접속할 수 있는 계정을 요청하세요."),
        t("SSH 터널로 서버 내부에서 접속하는 방법도 있습니다."),
      ],
    }),
  },
  {
    match: /no pg_hba\.conf entry for host "([^"]+)"(?:[^\n]*(no encryption))?/,
    help: (found) => {
      const fixes = [
        t("DB 관리자에게 pg_hba.conf에 이 주소를 추가해 달라고 요청하세요."),
        t("클라우드 DB라면 허용 IP 목록(승인된 네트워크, 보안 그룹)에 이 컴퓨터의 공인 IP를 추가하세요."),
        t("SSH 터널로 서버 내부에서 접속하는 방법도 있습니다."),
      ];
      // A server with only SSL (hostssl) rules reports plain attempts this way too.
      if (found[2] !== undefined) {
        fixes.unshift(t("SSL 연결만 허용하는 서버일 수도 있습니다. SSL 모드를 ‘필수’로 바꿔 보세요."));
      }
      return {
        title: t("서버가 이 컴퓨터의 접속을 허용하지 않습니다"),
        cause: t("PostgreSQL 접속 규칙(pg_hba.conf)에 {host}에서 오는 접속이 없습니다.", {
          host: found[1] ? `‘${found[1]}’` : t("이 주소"),
        }),
        fixes,
        action: found[2] !== undefined ? "ssl-on" : undefined,
      };
    },
  },
  {
    match: /Access denied for user '([^']*)'@'([^']*)' to database '([^']+)'/,
    code: /ERROR 1044\b/,
    help: (found) => ({
      title: t("데이터베이스에 접근할 권한이 없습니다"),
      cause: found[3]
        ? t("‘{user}’ 계정은 ‘{db}’ 데이터베이스를 쓸 수 없습니다.", { user: found[1], db: found[3] })
        : undefined,
      fixes: [
        t("데이터베이스 이름이 맞는지 확인하세요."),
        t(ASK_ADMIN_FOR_GRANT),
        t("데이터베이스 칸을 비워 두고 연결한 뒤, 볼 수 있는 데이터베이스를 ⌘K로 고를 수도 있습니다."),
      ],
    }),
  },
  {
    match: /Access denied for user '([^']*)'@'([^']*)' \(using password|password authentication failed for user "([^"]+)"|Login failed for user '([^']*)'/,
    code: /ERROR 1045\b|\[SQLSTATE 28P01\]|code: 18456\b/,
    help: (found, situation) => {
      const user = pick(found, 1, 3, 4);
      const fixes = [t("사용자 이름과 비밀번호를 다시 확인하세요. 대소문자를 구분합니다.")];
      // Inside the connection dialog the fields are right there.
      if (situation.where !== "connect") {
        fixes.push(t("저장된 비밀번호가 바뀌었다면 연결을 편집해 새 비밀번호를 입력하세요."));
      }
      fixes.push(...hints(situation, "login_failed"));
      return {
        title: t("로그인에 실패했습니다"),
        cause:
          user !== ""
            ? t("‘{user}’ 계정의 사용자 이름 또는 비밀번호가 맞지 않습니다.", { user })
            : t("사용자 이름 또는 비밀번호가 맞지 않습니다."),
        fixes,
      };
    },
  },
  {
    match: /role "([^"]+)" does not exist/,
    help: (found) => ({
      title: t("‘{user}’ 사용자가 서버에 없습니다", { user: found[1] }),
      fixes: [t("사용자 이름의 철자를 확인하세요. PostgreSQL 사용자 이름은 대소문자를 구분합니다.")],
    }),
  },
  {
    match: /Unknown database '([^']+)'|database "([^"]+)" does not exist|Cannot open database "([^"]+)"/,
    code: /ERROR 1049\b|\[SQLSTATE 3D000\]|code: 4060\b/,
    help: (found, situation) => {
      const name = pick(found, 1, 2, 3);
      const fixes = [t("데이터베이스 이름의 철자와 대소문자를 확인하세요.")];
      fixes.push(...hints(situation, "unknown_database"));
      return { title: t("{name}데이터베이스를 찾을 수 없습니다", { name: quoted(name) }), fixes };
    },
  },
  {
    match: /Too many connections|too many clients|remaining connection slots/i,
    code: /ERROR 1040\b|\[SQLSTATE 53300\]/,
    help: () => ({
      title: t("서버의 최대 접속 수를 넘었습니다"),
      fixes: [
        t("잠시 후 다시 시도하세요."),
        t("쓰지 않는 다른 연결(다른 앱이나 창)을 닫으세요."),
      ],
    }),
  },
  // ── Permissions and read-only ─────────────────────────────────────
  {
    match: /Permission denied \(os error 13\)|Operation not permitted \(os error 1\)/i,
    help: () => ({
      title: t("파일이나 폴더에 접근할 권한이 없습니다"),
      fixes: [
        t("파일 경로와 그 파일·폴더의 권한을 확인하세요."),
        t("macOS에서는 시스템 설정 > 개인정보 보호 및 보안 > 파일 및 폴더(또는 전체 디스크 접근 권한)에서 TablePeek을 실행한 터미널을 허용해야 할 수 있습니다."),
      ],
    }),
  },
  {
    match: /(\w+) command denied to user '([^']*)'@'([^']*)' for (?:column '([^']+)' in )?table ((?:[`'][^`']+[`']\.?)+)/,
    help: (found) => ({
      title: t("권한이 없습니다"),
      cause: found[4]
        ? t("‘{user}’ 계정에는 ‘{table}’ 테이블의 ‘{column}’ 컬럼에 대한 {command} 권한이 없습니다.", {
            user: found[2],
            table: unquote(found[5]),
            column: found[4],
            command: found[1],
          })
        : t("‘{user}’ 계정에는 ‘{table}’ 테이블에 대한 {command} 권한이 없습니다.", {
            user: found[2],
            table: unquote(found[5]),
            command: found[1],
          }),
      fixes: [t(ASK_ADMIN_FOR_GRANT), t(USE_OTHER_ACCOUNT)],
    }),
  },
  {
    match: /Access denied; you need \(at least one of\) the ([\w ,]+?) privilege/,
    code: /ERROR 1227\b/,
    help: (found) => ({
      title: t("권한이 없습니다"),
      cause: found[1]
        ? t("이 작업에는 {privilege} 권한이 필요합니다.", { privilege: found[1] })
        : t("이 작업에 필요한 서버 권한이 없습니다."),
      fixes: [t(ASK_ADMIN_FOR_GRANT), t(USE_OTHER_ACCOUNT)],
    }),
  },
  {
    match: /must be owner of (\w+) ([^\s[]+)/,
    help: (found) => ({
      title: t("소유자만 할 수 있는 작업입니다"),
      cause: t("‘{name}’({kind})의 소유자만 구조를 바꾸거나 지울 수 있습니다.", {
        name: found[2],
        kind: found[1],
      }),
      fixes: [t("소유자 계정으로 연결하거나, DB 관리자에게 요청하세요.")],
    }),
  },
  {
    match: /permission denied for (\w+) ([^\s[]+)|The (\w+) permission was denied on the object '([^']+)'|permission was denied/i,
    code: /\[SQLSTATE 42501\]|code: (?:229|230|262|297)\b/,
    help: (found) => {
      const name = pick(found, 2, 4);
      return {
        title: t("권한이 없습니다"),
        cause:
          name !== ""
            ? t("지금 계정에는 ‘{name}’에 대한 이 작업 권한이 없습니다.", { name })
            : t("지금 계정에는 이 작업을 할 권한이 없습니다."),
        fixes: [t(ASK_ADMIN_FOR_GRANT), t(USE_OTHER_ACCOUNT)],
      };
    },
  },
  {
    match: /--read-only option|read-only transaction|super-read-only|attempt to write a readonly database/i,
    code: /ERROR (?:1290|1792)\b|\[SQLSTATE 25006\]/,
    help: () => ({
      title: t("읽기 전용이라 변경할 수 없습니다"),
      cause: t(
        "이 서버나 지금 트랜잭션은 데이터 변경을 허용하지 않습니다. 복제본(replica)에 연결했거나, 서버·파일이 읽기 전용으로 설정된 경우입니다.",
      ),
      fixes: [
        t("변경이 필요하면 쓰기 가능한 기본(primary) 서버로 연결하세요."),
        t("SQLite라면 파일과 폴더에 쓰기 권한이 있는지 확인하세요."),
      ],
    }),
  },
  // ── Query errors ──────────────────────────────────────────────────
  {
    match: /canceling statement due to user request|Query execution was interrupted/,
    code: /ERROR 1317\b/,
    help: () => ({
      title: t("쿼리 실행을 취소했습니다"),
      fixes: [],
    }),
  },
  {
    match: /statement timeout|maximum statement execution time exceeded/i,
    code: /ERROR 3024\b/,
    help: () => ({
      title: t("쿼리 실행 시간 제한을 넘었습니다"),
      fixes: [
        t("조건(WHERE)이나 인덱스로 처리할 데이터를 줄이세요."),
        t("서버의 실행 시간 제한(statement_timeout, max_execution_time) 설정을 확인하세요."),
      ],
    }),
  },
  {
    match: /Deadlock found|deadlock detected|was deadlocked/i,
    code: /ERROR 1213\b|\[SQLSTATE 40P01\]/,
    help: () => ({
      title: t("교착 상태(데드락)로 쿼리가 취소되었습니다"),
      cause: t("두 작업이 서로 상대가 잠근 데이터를 기다리다가, 서버가 한쪽을 취소했습니다."),
      fixes: [
        t("다시 실행하면 대부분 성공합니다."),
        t("자주 생기면 여러 테이블을 항상 같은 순서로 수정하도록 바꾸세요."),
      ],
    }),
  },
  {
    match: /Lock wait timeout exceeded|could not obtain lock|database is locked|lock timeout/i,
    code: /ERROR 1205\b|\[SQLSTATE 55P03\]/,
    help: () => ({
      title: t("다른 작업이 같은 데이터를 잠그고 있습니다"),
      fixes: [
        t("잠시 후 다시 시도하세요."),
        t("다른 창이나 앱에 끝나지 않은 트랜잭션이 있다면 커밋하거나 롤백하세요."),
        t("서버 정보 패널에서 오래 실행 중인 세션을 확인할 수 있습니다."),
      ],
    }),
  },
  {
    match: /You have an error in your SQL syntax[\s\S]*?near '([\s\S]*?)' at line (\d+)|syntax error at or near "([^"]*)"|Incorrect syntax near (?:the keyword )?'([^']*)'|near "([^"]*)": syntax error/,
    code: /ERROR 1064\b|\[SQLSTATE 42601\]|code: (?:102|156)\b/,
    help: (found, situation) => {
      const near = pick(found, 1, 3, 4, 5).trim().split("\n")[0].slice(0, 60);
      const fixes = [t("쉼표, 괄호, 따옴표의 짝이 맞는지 확인하세요.")];
      fixes.push(...hints(situation, "syntax"));
      fixes.push(t("order, user, group 같은 예약어를 이름으로 쓰려면 따옴표로 감싸세요."));
      return {
        title: t("SQL 문법 오류"),
        // MySQL counts lines from the statement's start; the editor marks the
        // place and names its own line, so the cause leaves the count out there.
        cause:
          near !== ""
            ? found[2] && situation.where !== "editor"
              ? t("{line}번째 줄 ‘{near}’ 근처를 해석하지 못했습니다.", { line: found[2], near })
              : t("‘{near}’ 근처를 해석하지 못했습니다.", { near })
            : t("문장을 해석하지 못했습니다."),
        fixes,
      };
    },
  },
  {
    match: /Table '([^']+)' doesn't exist|(?:relation|table) "([^"]+)" does not exist|no such table: (\S+)|Invalid object name '([^']+)'/,
    code: /ERROR 1146\b|\[SQLSTATE 42P01\]|code: 208\b/,
    help: (found, situation) => {
      const fixes: string[] = [];
      if (writingSql(situation)) {
        fixes.push(
          t("테이블 이름의 철자를 확인하세요."),
          t("지금 선택된 데이터베이스·스키마가 맞는지 확인하세요 (⌘K로 전환)."),
          ...hints(situation, "unknown_table"),
          t("방금 만든 테이블이라면 스키마를 새로고침하세요."),
        );
      } else {
        // Export, a data tab, a structure panel: the table was there when it opened.
        fixes.push(
          t("다른 곳에서 테이블이 지워졌거나 이름이 바뀌었을 수 있습니다."),
          t("스키마를 새로고침해 테이블 목록을 최신으로 맞춘 뒤 다시 여세요."),
        );
      }
      return {
        title: t("{name}테이블을 찾을 수 없습니다", { name: quoted(pick(found, 1, 2, 3, 4)) }),
        fixes,
        action: "refresh-schema",
      };
    },
  },
  {
    match: /Unknown column '([^']+)'|column "([^"]+)" (?:of relation "[^"]+" )?does not exist|no such column: (\S+)|Invalid column name '([^']+)'/,
    code: /ERROR 1054\b|\[SQLSTATE 42703\]|code: 207\b/,
    help: (found, situation) => {
      const fixes = [t("컬럼 이름의 철자를 확인하세요.")];
      if (writingSql(situation)) {
        fixes.push(...hints(situation, "unknown_column"));
        fixes.push(t("다른 테이블의 컬럼이라면 테이블 이름이나 별칭을 앞에 붙이세요 (예: u.name)."));
      } else {
        fixes.push(t("다른 곳에서 컬럼이 지워졌거나 이름이 바뀌었다면 스키마를 새로고침하세요."));
      }
      return {
        title: t("{name}컬럼을 찾을 수 없습니다", { name: quoted(pick(found, 1, 2, 3, 4)) }),
        fixes,
        action: writingSql(situation) ? undefined : "refresh-schema",
      };
    },
  },
  {
    match: /(?:database|relation|schema|role|type|function|index|view) "([^"]+)" already exists|Can't create database '([^']+)'; database exists|Table '([^']+)' already exists|There is already an object named '([^']+)'|Database '([^']+)' already exists|table (\S+) already exists/,
    code: /\[SQLSTATE 42(?:P04|P06|P07|710|723)\]|ERROR (?:1007|1050)\b|code: (?:1801|2714)\b/,
    help: (found, situation) => {
      const name = unquote(pick(found, 1, 2, 3, 4, 5, 6));
      const fixes = [t("다른 이름을 쓰거나, 이미 있는 것을 그대로 쓰세요.")];
      if (writingSql(situation)) {
        fixes.push(t("없을 때만 만들려면 CREATE … IF NOT EXISTS를 쓰세요."));
      }
      return {
        title: name !== "" ? t("‘{name}’이(가) 이미 있습니다", { name }) : t("같은 이름이 이미 있습니다"),
        fixes,
      };
    },
  },
  {
    match: /Duplicate entry '([^']*)' for key '([^']+)'|duplicate key value violates unique constraint "([^"]+)"|UNIQUE constraint failed: (\S+)|Violation of (?:PRIMARY KEY|UNIQUE KEY) constraint '([^']+)'|Cannot insert duplicate key/,
    code: /ERROR 1062\b|\[SQLSTATE 23505\]|code: (?:2601|2627)\b/,
    help: (found, situation) => {
      // PostgreSQL's detail names the value: Key (email)=(a@b.c) already exists.
      const pgKey = /Key \((.*?)\)=\((.*?)\) already exists/.exec(situation.raw);
      // SQL Server's message ends with it: The duplicate key value is (a@b.c).
      const mssqlValue = /duplicate key value is \((.*?)\)\.?/.exec(situation.raw)?.[1];
      const key = pick(found, 2, 3, 4, 5) || detailOf(situation.error, "constraint");
      const value = found[1] ?? pgKey?.[2] ?? mssqlValue;
      const fixes = [t("다른 값을 넣거나, 기존 행을 수정하세요.")];
      // Only a statement or an import inserts rows with an id it chose itself.
      if (writingSql(situation) || situation.where === "import") {
        fixes.push(t("자동 증가하는 id라면 값을 직접 넣지 말고 비워 두세요."));
      }
      if (situation.where === "import") {
        fixes.push(t("가져올 파일 안에 같은 값이 두 번 들어 있지 않은지도 확인하세요."));
      }
      return {
        title: t("이미 같은 값이 있어 저장할 수 없습니다"),
        cause:
          value !== undefined && pgKey !== null
            ? t("‘{column}’ 값 ‘{value}’이(가) 이미 있습니다. 이 컬럼은 고유해야 합니다 (‘{key}’).", {
                column: pgKey[1],
                value,
                key,
              })
            : value !== undefined
              ? t("값 ‘{value}’이(가) 고유해야 하는 ‘{key}’에 이미 있습니다.", { value, key })
              : key !== ""
                ? t("고유해야 하는 ‘{key}’에 같은 값이 이미 있습니다.", { key })
                : undefined,
        fixes,
      };
    },
  },
  {
    match: /new row for relation "[^"]+" violates check constraint "([^"]+)"|check constraint "([^"]+)" (?:of relation "[^"]+" )?is violated by some row|Check constraint '([^']+)' is violated|conflicted with the CHECK constraint "([^"]+)"|CHECK constraint failed: (\S+)/,
    code: /\[SQLSTATE 23514\]|ERROR 3819\b/,
    help: (found, situation) => {
      const name = pick(found, 1, 2, 3, 4, 5) || detailOf(situation.error, "constraint");
      // PostgreSQL's detail ends "contains (…)." and the message wraps it in
      // parentheses, so the row ends at the last ")." (values may hold parentheses).
      const row = /Failing row contains (\(.*\))\./.exec(situation.raw)?.[1];
      const fixes =
        situation.where === "structure"
          ? [t("이 조건에 맞지 않는 기존 행을 먼저 고친 뒤 다시 적용하세요.")]
          : [t("조건에 맞는 값으로 바꾸세요."), t("조건 내용은 테이블 구조의 제약 조건 목록에서 볼 수 있습니다.")];
      return {
        title: t("{name}검사 조건(CHECK)에 맞지 않는 값입니다", { name: quoted(name) }),
        cause:
          row !== undefined
            ? t("저장하려던 행 {row}이(가) 테이블의 CHECK 제약을 만족하지 않습니다.", { row })
            : t("저장하려던 값이 테이블의 CHECK 제약을 만족하지 않습니다."),
        fixes,
      };
    },
  },
  {
    match: /Cannot delete or update a parent row|update or delete on table "([^"]+)" violates foreign key constraint|conflicted with the REFERENCE constraint/,
    code: /ERROR 1451\b/,
    help: (_found, situation) => {
      const text = situation.raw;
      // PostgreSQL: Key (id)=(1) is still referenced from table "orders".
      const pg = /Key \((.*?)\)=\((.*?)\) is still referenced from table "([^"]+)"/.exec(text);
      // MySQL: (`db`.`orders`, CONSTRAINT …); SQL Server: table "dbo.orders", column 'user_id'.
      const table = pg?.[3] ?? /constraint fails \(`[^`]+`\.`([^`]+)`/.exec(text)?.[1] ?? /table "([^"]+)"/.exec(text)?.[1];
      return {
        title: t("다른 테이블이 참조하고 있어 지우거나 바꿀 수 없습니다"),
        cause:
          pg !== null
            ? t("‘{table}’ 테이블의 행이 아직 이 행({key} = {value})을 참조하고 있습니다.", {
                table: pg[3],
                key: pg[1],
                value: pg[2],
              })
            : table !== undefined
              ? t("‘{table}’ 테이블의 행이 아직 이 행을 참조하고 있습니다.", { table })
              : undefined,
        fixes: [
          t("이 행을 참조하는 다른 테이블의 행을 먼저 지우거나 수정하세요."),
          t("외래 키에 ON DELETE CASCADE가 없으면 참조하는 행이 함께 지워지지 않습니다."),
        ],
      };
    },
  },
  {
    match: /Cannot add or update a child row|violates foreign key constraint|FOREIGN KEY constraint failed|conflicted with the FOREIGN KEY constraint/,
    code: /ERROR 1452\b|code: 547\b/,
    help: (_found, situation) => {
      const text = situation.raw;
      // PostgreSQL: Key (user_id)=(99) is not present in table "users".
      const pg = /Key \((.*?)\)=\((.*?)\) is not present in table "([^"]+)"/.exec(text);
      // MySQL: FOREIGN KEY (`user_id`) REFERENCES `users` (`id`).
      const mysql = /FOREIGN KEY \(`([^`]+)`\) REFERENCES `([^`]+)`/.exec(text);
      // SQL Server: table "dbo.users", column 'id'.
      const table = /table "([^"]+)"/.exec(text)?.[1];
      return {
        title: t("참조하는 값이 상대 테이블에 없습니다"),
        cause:
          pg !== null
            ? t("‘{column}’ 값 ‘{value}’이(가) ‘{table}’ 테이블에 없습니다.", { column: pg[1], value: pg[2], table: pg[3] })
            : mysql !== null
              ? t("‘{column}’에 넣은 값이 ‘{table}’ 테이블에 없습니다.", { column: mysql[1], table: mysql[2] })
              : table !== undefined
                ? t("외래 키 컬럼에 넣은 값이 ‘{table}’ 테이블에 없습니다.", { table })
                : t("외래 키 컬럼에 넣은 값과 같은 행이 참조 대상 테이블에 없습니다."),
        fixes: [
          t("값이 참조 대상 테이블에 실제로 있는지 확인하세요."),
          t("참조 대상 행을 먼저 만든 뒤 다시 저장하세요."),
        ],
      };
    },
  },
  {
    match: /Column '([^']+)' cannot be null|Field '([^']+)' doesn't have a default value|null value in column "([^"]+)"[^\n]*violates not-null constraint|NOT NULL constraint failed: (\S+)|Cannot insert the value NULL into column '([^']+)'/,
    code: /ERROR (?:1048|1364)\b|\[SQLSTATE 23502\]|code: 515\b/,
    help: (found, situation) => {
      const fixes = [t("값을 채워 넣으세요.")];
      if (situation.where === "import") {
        fixes.push(t("가져올 파일에 이 컬럼이 빈 줄이 있는지, 컬럼 연결이 맞는지 확인하세요."));
      } else {
        fixes.push(t("비워 두는 일이 잦다면 컬럼에 기본값을 지정하세요."));
      }
      return {
        title: t("{name}필수 값이 비어 있습니다", {
          name: quoted(pick(found, 1, 2, 3, 4, 5) || detailOf(situation.error, "column")),
        }),
        cause: t("이 컬럼은 비워 둘 수 없고(NOT NULL), 기본값도 없습니다."),
        fixes,
      };
    },
  },
  {
    match: /Data too long for column '([^']+)'|value too long for type|String or binary data would be truncated/,
    code: /ERROR 1406\b|\[SQLSTATE 22001\]/,
    help: (found) => ({
      title: t("값이 컬럼 길이보다 깁니다"),
      cause: found[1] ? t("‘{column}’ 컬럼에 들어갈 수 있는 길이를 넘었습니다.", { column: found[1] }) : undefined,
      fixes: [t("값을 줄이거나, 컬럼 길이(예: VARCHAR(255))를 늘리세요.")],
    }),
  },
  {
    match: /Incorrect (\w+) value: '([^']*)' for column '([^']+)'|invalid input (?:syntax for type|value for enum) (\w+): "([^"]*)"|Conversion failed when converting (?:the )?(?:[\w ]+? )?value '([^']*)' to data type (\w+)|Truncated incorrect (\w+) value: '([^']*)'|Conversion failed when converting|datatype mismatch/,
    code: /ERROR (?:1366|1292)\b|\[SQLSTATE 22P02\]|code: (?:245|8114)\b/,
    help: (found, situation) => {
      const value = pick(found, 2, 5, 6, 9);
      const type = pick(found, 1, 4, 7, 8);
      const column = pick(found, 3) || detailOf(situation.error, "column");
      const fixes = [t("숫자·날짜 컬럼에는 형식에 맞는 값을 넣으세요 (날짜 예: 2026-10-21 14:30:00).")];
      if (situation.where === "import") {
        fixes.push(t("가져올 파일에서 이 컬럼의 값 형식과 컬럼 연결이 맞는지 확인하세요."));
      }
      return {
        title: t("값이 컬럼 형식과 맞지 않습니다"),
        cause:
          value !== "" && type !== ""
            ? column !== ""
              ? t("‘{value}’은(는) ‘{column}’ 컬럼의 {type} 형식으로 바꿀 수 없습니다.", { value, column, type })
              : t("‘{value}’은(는) {type} 형식으로 바꿀 수 없습니다.", { value, type })
            : undefined,
        fixes,
      };
    },
  },
  {
    match: /division by zero|Divide by zero/i,
    code: /\[SQLSTATE 22012\]/,
    help: () => ({
      title: t("0으로 나눌 수 없습니다"),
      fixes: [t("NULLIF(분모, 0)처럼 분모가 0일 때를 처리하세요.")],
    }),
  },
  {
    match: /unable to open database file/,
    help: () => ({
      title: t("SQLite 파일을 열 수 없습니다"),
      fixes: [t("파일 경로가 맞는지, 그 파일과 폴더를 읽고 쓸 권한이 있는지 확인하세요.")],
    }),
  },
  // ── Network ───────────────────────────────────────────────────────
  {
    network: true,
    match: /Connection refused|actively refused|ECONNREFUSED|os error (?:61|111|10061)\b|\(연결 거부\)/i,
    help: (_found, situation) => ({
      title: t("DB 서버에 연결할 수 없습니다 (연결 거부)"),
      cause: t("그 주소와 포트에서 기다리는 DB 서버가 없습니다."),
      fixes: [
        t("DB 서버가 실행 중인지 확인하세요."),
        t("포트 번호를 확인하세요 ({ports}).", { ports: defaultPorts(situation) }),
        t("SSH 터널로 로컬 포트에 접속한다면, 그 터널이 켜져 있는지 확인하세요."),
        ...hints(situation, "connection_refused"),
      ],
    }),
  },
  {
    network: true,
    match: /failed to lookup address|Name or service not known|nodename nor servname|No such host is known|getaddrinfo|dns error|Temporary failure in name resolution|호스트를 찾을 수 없습니다/i,
    help: () => ({
      title: t("호스트 이름을 찾을 수 없습니다"),
      fixes: [
        t("호스트 이름의 철자를 확인하세요."),
        t("사내 DNS에서만 보이는 주소라면 VPN에 연결하세요."),
      ],
    }),
  },
  {
    network: true,
    match: /timed out|deadline has elapsed|os error (?:60|110|10060)\b|응답하지 않습니다 \(시간 초과\)/i,
    help: () => ({
      title: t("서버가 응답하지 않습니다 (시간 초과)"),
      cause: t("요청이 서버에 닿지 않거나 답이 오지 않았습니다. 방화벽·보안 그룹이 막고 있거나 VPN이 필요할 때 흔합니다."),
      fixes: [
        t("호스트 주소와 포트를 확인하세요."),
        t("클라우드 DB라면 이 컴퓨터의 공인 IP가 허용 목록에 있는지 확인하세요."),
        t("사내망 DB라면 VPN에 연결되어 있는지 확인하세요."),
      ],
    }),
  },
  {
    network: true,
    match: /No route to host|Network is unreachable|os error (?:51|65|101|113)\b/i,
    help: () => ({
      title: t("네트워크로 서버에 닿을 수 없습니다"),
      fixes: [t("인터넷이나 VPN 연결을 확인하세요.")],
    }),
  },
  {
    network: true,
    match: /Connection reset|Broken pipe|connection closed|unexpected end of file|UnexpectedEof|os error (?:32|54|104)\b/i,
    help: () => ({
      title: t("서버와의 연결이 끊어졌습니다"),
      cause: t("서버가 연결을 닫았습니다. 서버 재시작, 오래 쉬던 연결의 시간 초과, 또는 SSL 설정 불일치가 원인일 수 있습니다."),
      fixes: [t("다시 시도하세요."), t("연결할 때마다 끊긴다면 SSL 모드를 바꿔 보세요.")],
    }),
  },
];

function matchRule(rule: ErrorRule, situation: ErrorSituation): RegExpExecArray | null {
  const raw = situation.raw;
  if (rule.network === true && DATABASE_CODE.test(raw)) {
    return null;
  }
  if (rule.when !== undefined && !rule.when(raw, situation)) {
    return null;
  }
  if (rule.match === undefined && rule.code === undefined) {
    return codeOnly(raw);
  }
  return rule.match?.exec(raw) ?? (rule.code?.test(raw) ? codeOnly(raw) : null);
}

function explainWith(situation: ErrorSituation): ErrorHelp | null {
  // An engine's own rules come first: they know its errors best.
  for (const rule of [...(situation.engine?.rules ?? []), ...RULES]) {
    const found = matchRule(rule, situation);
    if (found !== null) {
      return rule.help(found, situation);
    }
  }
  return null;
}

const UNKNOWN_ERROR = "알 수 없는 오류가 발생했습니다";

// Any thrown value or server reply as an AppError. Error objects keep the
// server's fields when they carry them as properties (ApiRequestError,
// MongoError, TablePeekSocketError).
export function toAppError(error: unknown, fallback?: string): AppError {
  if (typeof error === "string") {
    return { code: "", message: error };
  }
  if (error === null || typeof error !== "object") {
    return { code: "", message: fallback ?? t(UNKNOWN_ERROR) };
  }
  const fields = error as Record<string, unknown>;
  const result: AppError = {
    code: typeof fields.code === "string" ? fields.code : "",
    message: typeof fields.message === "string" && fields.message !== "" ? fields.message : (fallback ?? t(UNKNOWN_ERROR)),
  };
  if (typeof fields.sqlstate === "string" && fields.sqlstate !== "") {
    result.sqlstate = fields.sqlstate;
  }
  const position = fields.position;
  if (position !== null && typeof position === "object") {
    const { offset, line, column } = position as Record<string, unknown>;
    result.position = {
      offset: typeof offset === "number" ? offset : undefined,
      line: typeof line === "number" ? line : undefined,
      column: typeof column === "number" ? column : undefined,
    };
  }
  if (typeof fields.server_code === "number") {
    result.server_code = fields.server_code;
  }
  if (typeof fields.code_name === "string" && fields.code_name !== "") {
    result.code_name = fields.code_name;
  }
  if (fields.details !== undefined && fields.details !== null) {
    result.details = fields.details;
  }
  if (typeof fields.raw === "string" && fields.raw !== "") {
    result.raw = fields.raw;
  }
  return result;
}

// The error of a failed reply: `{ code, message, … }`, or the same nested
// under `error`.
export function appErrorFromBody(body: unknown, status: number): AppError {
  const outer = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const inner = outer.error !== null && typeof outer.error === "object" ? (outer.error as Record<string, unknown>) : outer;
  return toAppError({
    ...inner,
    code: typeof inner.code === "string" ? inner.code : `http_${status}`,
    message: typeof inner.message === "string" && inner.message !== "" ? inner.message : `HTTP ${status}`,
  });
}

// Whether the TablePeek server itself is out of reach (or restarted with a new
// token). The app's connection banner reports that once; panels don't repeat it.
export function isAppServerDown(error: unknown): boolean {
  const { code, message } = toAppError(error);
  if (code === "network" || code === "invalid_token" || code === "unauthorized") {
    return true;
  }
  const trimmed = message.trim();
  return trimmed === APP_SERVER_DOWN || trimmed === t(APP_SERVER_DOWN);
}

// The engine an error code belongs to: "postgres_error", "mongo_11000".
function engineOfCode(error: AppError): string | null {
  const prefix = /^([a-z]+)_(?:error|\d+)$/.exec(error.code)?.[1];
  const engine = prefix !== undefined ? (engineById(prefix) ?? engineById(`${prefix}db`)) : undefined;
  if (engine !== undefined) {
    return engine.id;
  }
  // Only MongoDB names its codes.
  return error.code_name !== undefined ? "mongodb" : null;
}

// The codes as the drivers print them, so rules written against the driver
// text also match a localized message.
function codeTags(error: AppError, engineId: string | null): string {
  const tags = [error.code];
  if (error.sqlstate !== undefined) {
    tags.push(`[SQLSTATE ${error.sqlstate}]`);
  }
  const number = error.server_code;
  if (number !== undefined) {
    if (engineId === "mysql") {
      tags.push(`ERROR ${number}`);
    } else if (engineId === "mssql") {
      tags.push(`(code: ${number}, state:)`);
    } else if (engineId === "mongodb") {
      tags.push(`mongo_${number}`);
    }
  }
  if (error.code_name !== undefined) {
    tags.push(error.code_name);
  }
  return tags.join(" ");
}

// An explanation of `error` for the screen it shows on, or null when there is
// nothing more helpful to say than the message itself. `engineId` names the
// engine when the caller knows it and the error may not say (a connect attempt).
export function explainError(error: unknown, where: ErrorContext = "general", engineId?: string): ErrorHelp | null {
  const appError = toAppError(error);
  if (appError.code === "invalid_token" || appError.code === "unauthorized") {
    return tokenHelp();
  }
  if (isAppServerDown(appError)) {
    return appServerDownHelp();
  }
  const known = engineId ?? engineOfCode(appError);
  const original =
    appError.raw !== undefined && !appError.raw.includes(appError.message)
      ? `${appError.message}\n${appError.raw}`
      : (appError.raw ?? appError.message);
  // PostgreSQL's detail ("Key (id)=(1) already exists.") is read with the text.
  const detail = detailOf(appError, "detail");
  const text = `${codeTags(appError, known)}\n${original}${detail !== "" ? `\n${detail}` : ""}`.slice(0, SCAN_LIMIT);
  // The engine whose error this is: named, or told by the engines' own patterns.
  const named = known !== null ? engineById(known)?.errorHelp : undefined;
  const engine = named ?? engines().find((candidate) => candidate.errorHelp?.detect.test(text))?.errorHelp ?? null;
  const situation: ErrorSituation = { raw: text, code: appError.code, error: appError, where, engineId: known, engine };
  // With "prefer", MySQL retries without TLS after a TLS failure; when that
  // retry fails too, its error is the one that matters, unless the server
  // insists on TLS (handled by the combined rule above).
  const retry = /평문 재시도 실패: ([\s\S]*)$/.exec(text);
  if (retry !== null && !TLS_REQUIRED.test(text)) {
    const help = explainWith({ ...situation, raw: retry[1] });
    if (help !== null) {
      return help;
    }
  }
  return explainWith(situation);
}
