import { t } from "./i18n";

// Turns raw driver and server errors into an explanation a person can act
// on: what happened, the likely cause, and what to try. Rules match the
// English driver text and, where the server is localized, the error codes
// (MySQL "ERROR 1045", PostgreSQL "[SQLSTATE 28P01]", SQL Server "code: 18456").

// A fix the UI can apply for the user, e.g. in the connection dialog.
export type ErrorAction = "ssl-off" | "ssl-on";

export interface ErrorHelp {
  title: string;
  cause?: string;
  fixes: string[];
  action?: ErrorAction;
}

type Driver = "mysql" | "postgres" | "mssql" | "sqlite" | null;

interface Context {
  raw: string;
  code: string;
  driver: Driver;
}

interface Rule {
  // The driver's message; its groups pick out names for the explanation.
  match?: RegExp;
  // Error codes that mean the same thing when the message is localized. Codes
  // shared by different situations (PostgreSQL 57014: cancelled or timed out;
  // 23503: either side of a foreign key) are left to the message.
  code?: RegExp;
  // For a rule that needs more than one pattern to hold.
  when?(raw: string): boolean;
  // Generic network wording. A database error can echo it from user data (a
  // constraint named "timed out"), so these rules skip messages with a code.
  network?: boolean;
  help(found: RegExpExecArray, context: Context): ErrorHelp;
}

const UNTRUSTED_CERT = /UnknownIssuer|unknown issuer|self[- ]signed/i;
const TLS_REQUIRED = /insecure transport|ERROR 3159\b/;
const DATABASE_CODE = /ERROR \d{4}\b|\[SQLSTATE \w{5}\]|\(code: \d+, state:/;
// Classifying looks at the start only; the full message is still shown.
const SCAN_LIMIT = 2000;

function codeOnly(raw: string): RegExpExecArray {
  return Object.assign([""], { index: 0, input: raw }) as unknown as RegExpExecArray;
}

// The local TablePeek server could not be reached (see store.ts). The
// message may arrive translated, so it is matched in both languages.
const APP_SERVER_DOWN = "서버에 연결할 수 없습니다";

const DEFAULT_PORTS = "MySQL 3306 · PostgreSQL 5432 · SQL Server 1433 · CockroachDB 26257";

function driverOf(raw: string): Driver {
  if (/MySQL/.test(raw)) {
    return "mysql";
  }
  if (/PostgreSQL|SQLSTATE/.test(raw)) {
    return "postgres";
  }
  if (/SQL Server|code: \d+, state:/.test(raw)) {
    return "mssql";
  }
  if (/SQLite/.test(raw)) {
    return "sqlite";
  }
  return null;
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
    title: t("접속 토큰이 맞지 않습니다"),
    cause: t(
      "TablePeek 서버가 다시 시작되면 보안을 위해 접속 주소의 토큰이 새로 만들어집니다. 이 창은 이전 토큰을 쓰고 있습니다.",
    ),
    fixes: [
      t("서버를 실행한 터미널에 표시된 새 주소(…/?token=…)로 다시 여세요."),
      t("make run으로 실행했다면 자동으로 새로 열린 브라우저 탭을 사용하세요."),
    ],
  };
}

function appServerDownHelp(): ErrorHelp {
  return {
    title: t("TablePeek 서버에 연결할 수 없습니다"),
    cause: t("브라우저와 TablePeek 서버 사이의 연결이 끊겼습니다. 서버가 종료되었거나 다시 시작되는 중입니다."),
    fixes: [
      t("서버를 실행한 터미널이 아직 켜져 있는지 확인하세요."),
      t("꺼졌다면 make run으로 다시 실행한 뒤, 새로 표시된 주소로 여세요."),
    ],
  };
}

const ASK_ADMIN_FOR_GRANT = "DB 관리자에게 이 작업에 필요한 권한을 요청하세요.";
const USE_OTHER_ACCOUNT = "권한이 있는 다른 계정으로 연결해서 실행하세요.";

const RULES: Rule[] = [
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
    help: (found, context) => {
      const user = pick(found, 1, 3, 4);
      const fixes = [
        t("사용자 이름과 비밀번호를 다시 확인하세요. 대소문자를 구분합니다."),
        t("저장된 비밀번호가 바뀌었다면 연결을 편집해 새 비밀번호를 입력하세요."),
      ];
      if (context.driver === "mysql") {
        fixes.push(
          t("MySQL 계정은 ‘사용자@접속 위치’ 단위입니다. 다른 곳에서는 되던 비밀번호도 이 위치(또는 SSH 서버)에서는 다른 계정으로 취급될 수 있습니다."),
        );
      }
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
    help: (found, context) => {
      const name = pick(found, 1, 2, 3);
      const fixes = [t("데이터베이스 이름의 철자와 대소문자를 확인하세요.")];
      if (context.driver === "mysql") {
        fixes.push(t("데이터베이스 칸을 비워 두고 연결한 뒤 ⌘K로 고를 수 있습니다."));
      } else if (context.driver === "postgres") {
        fixes.push(t("기본 데이터베이스 ‘postgres’로 먼저 연결한 뒤 ⌘K로 바꿀 수 있습니다."));
      }
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
    help: (found, context) => {
      const near = pick(found, 1, 3, 4, 5).trim().split("\n")[0].slice(0, 60);
      const fixes = [t("쉼표, 괄호, 따옴표의 짝이 맞는지 확인하세요.")];
      if (context.driver === "mysql") {
        fixes.push(t("MySQL에서 이름은 `백틱`으로, 문자열은 '작은따옴표'로 감쌉니다."));
      } else if (context.driver === "postgres") {
        fixes.push(t("PostgreSQL에서 이름은 \"큰따옴표\"로, 문자열은 '작은따옴표'로 감쌉니다."));
      } else if (context.driver === "mssql") {
        fixes.push(t("SQL Server는 LIMIT 대신 TOP이나 OFFSET … FETCH를 씁니다."));
      }
      fixes.push(t("order, user, group 같은 예약어를 이름으로 쓰려면 따옴표로 감싸세요."));
      return {
        title: t("SQL 문법 오류"),
        cause:
          near !== ""
            ? found[2]
              ? t("{line}번째 줄 ‘{near}’ 근처를 해석하지 못했습니다.", { line: found[2], near })
              : t("‘{near}’ 근처를 해석하지 못했습니다.", { near })
            : t("문장을 해석하지 못했습니다."),
        fixes,
      };
    },
  },
  {
    match: /Table '([^']+)' doesn't exist|relation "([^"]+)" does not exist|no such table: (\S+)|Invalid object name '([^']+)'/,
    code: /ERROR 1146\b|\[SQLSTATE 42P01\]|code: 208\b/,
    help: (found, context) => {
      const fixes = [
        t("테이블 이름의 철자를 확인하세요."),
        t("지금 선택된 데이터베이스·스키마가 맞는지 확인하세요 (⌘K로 전환)."),
      ];
      if (context.driver === "postgres") {
        fixes.push(t("PostgreSQL은 따옴표 없는 이름을 소문자로 바꿉니다. 대문자가 섞인 이름은 \"MyTable\"처럼 큰따옴표로 감싸세요."));
      }
      fixes.push(t("방금 만든 테이블이라면 스키마를 새로고침하세요."));
      return {
        title: t("{name}테이블을 찾을 수 없습니다", { name: quoted(pick(found, 1, 2, 3, 4)) }),
        fixes,
      };
    },
  },
  {
    match: /Unknown column '([^']+)'|column "([^"]+)" (?:of relation "[^"]+" )?does not exist|no such column: (\S+)|Invalid column name '([^']+)'/,
    code: /ERROR 1054\b|\[SQLSTATE 42703\]|code: 207\b/,
    help: (found, context) => {
      const fixes = [t("컬럼 이름의 철자를 확인하세요.")];
      if (context.driver === "postgres") {
        fixes.push(t("PostgreSQL에서 큰따옴표(\"…\")는 이름을 뜻합니다. 문자열 값은 작은따옴표('…')로 감싸세요."));
      }
      fixes.push(t("다른 테이블의 컬럼이라면 테이블 이름이나 별칭을 앞에 붙이세요 (예: u.name)."));
      return {
        title: t("{name}컬럼을 찾을 수 없습니다", { name: quoted(pick(found, 1, 2, 3, 4)) }),
        fixes,
      };
    },
  },
  {
    match: /Duplicate entry '([^']*)' for key '([^']+)'|duplicate key value violates unique constraint "([^"]+)"|UNIQUE constraint failed: (\S+)|Violation of (?:PRIMARY KEY|UNIQUE KEY) constraint '([^']+)'|Cannot insert duplicate key/,
    code: /ERROR 1062\b|\[SQLSTATE 23505\]|code: (?:2601|2627)\b/,
    help: (found) => {
      const key = pick(found, 2, 3, 4, 5);
      return {
        title: t("이미 같은 값이 있어 저장할 수 없습니다"),
        cause:
          found[1] !== undefined
            ? t("값 ‘{value}’이(가) 고유해야 하는 ‘{key}’에 이미 있습니다.", { value: found[1], key })
            : key !== ""
              ? t("고유해야 하는 ‘{key}’에 같은 값이 이미 있습니다.", { key })
              : undefined,
        fixes: [
          t("다른 값을 넣거나, 기존 행을 수정하세요."),
          t("자동 증가하는 id라면 값을 직접 넣지 말고 비워 두세요."),
        ],
      };
    },
  },
  {
    match: /Cannot delete or update a parent row|update or delete on table "([^"]+)" violates foreign key constraint|conflicted with the REFERENCE constraint/,
    code: /ERROR 1451\b/,
    help: () => ({
      title: t("다른 테이블이 참조하고 있어 지우거나 바꿀 수 없습니다"),
      fixes: [
        t("이 행을 참조하는 다른 테이블의 행을 먼저 지우거나 수정하세요."),
        t("외래 키에 ON DELETE CASCADE가 없으면 참조하는 행이 함께 지워지지 않습니다."),
      ],
    }),
  },
  {
    match: /Cannot add or update a child row|violates foreign key constraint|FOREIGN KEY constraint failed|conflicted with the FOREIGN KEY constraint/,
    code: /ERROR 1452\b|code: 547\b/,
    help: () => ({
      title: t("참조하는 값이 상대 테이블에 없습니다"),
      cause: t("외래 키 컬럼에 넣은 값과 같은 행이 참조 대상 테이블에 없습니다."),
      fixes: [
        t("값이 참조 대상 테이블에 실제로 있는지 확인하세요."),
        t("참조 대상 행을 먼저 만든 뒤 다시 저장하세요."),
      ],
    }),
  },
  {
    match: /Column '([^']+)' cannot be null|Field '([^']+)' doesn't have a default value|null value in column "([^"]+)"[^\n]*violates not-null constraint|NOT NULL constraint failed: (\S+)|Cannot insert the value NULL into column '([^']+)'/,
    code: /ERROR (?:1048|1364)\b|\[SQLSTATE 23502\]|code: 515\b/,
    help: (found) => ({
      title: t("{name}필수 값이 비어 있습니다", { name: quoted(pick(found, 1, 2, 3, 4, 5)) }),
      cause: t("이 컬럼은 비워 둘 수 없고(NOT NULL), 기본값도 없습니다."),
      fixes: [
        t("값을 채워 넣으세요."),
        t("비워 두는 일이 잦다면 컬럼에 기본값을 지정하세요."),
      ],
    }),
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
    match: /Incorrect (\w+) value: '([^']*)' for column '([^']+)'|invalid input syntax for type (\w+): "([^"]*)"|Conversion failed when converting/,
    code: /ERROR 1366\b|\[SQLSTATE 22P02\]/,
    help: (found) => {
      const value = pick(found, 2, 5);
      const type = pick(found, 1, 4);
      return {
        title: t("값이 컬럼 형식과 맞지 않습니다"),
        cause:
          value !== "" && type !== ""
            ? t("‘{value}’은(는) {type} 형식으로 바꿀 수 없습니다.", { value, type })
            : undefined,
        fixes: [t("숫자·날짜 컬럼에는 형식에 맞는 값을 넣으세요 (날짜 예: 2026-10-21 14:30:00).")],
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
    match: /Connection refused|actively refused|ECONNREFUSED|os error (?:61|111|10061)\b/i,
    help: () => ({
      title: t("DB 서버에 연결할 수 없습니다 (연결 거부)"),
      cause: t("그 주소와 포트에서 기다리는 DB 서버가 없습니다."),
      fixes: [
        t("DB 서버가 실행 중인지 확인하세요."),
        t("포트 번호를 확인하세요 ({ports}).", { ports: DEFAULT_PORTS }),
        t("SSH 터널이나 Cloud SQL 프록시처럼 로컬 포트(예: 127.0.0.1:3307)로 접속한다면, 그 터널이 켜져 있는지 확인하세요."),
      ],
    }),
  },
  {
    network: true,
    match: /failed to lookup address|Name or service not known|nodename nor servname|No such host is known|getaddrinfo|dns error|Temporary failure in name resolution/i,
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
    match: /timed out|deadline has elapsed|os error (?:60|110|10060)\b/i,
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

function matchRule(rule: Rule, raw: string): RegExpExecArray | null {
  if (rule.network === true && DATABASE_CODE.test(raw)) {
    return null;
  }
  if (rule.when !== undefined) {
    return rule.when(raw) ? codeOnly(raw) : null;
  }
  return rule.match?.exec(raw) ?? (rule.code?.test(raw) ? codeOnly(raw) : null);
}

function explainWith(raw: string, code: string, driver: Driver): ErrorHelp | null {
  if (code === "unauthorized") {
    return tokenHelp();
  }
  const trimmed = raw.trim();
  if (trimmed === APP_SERVER_DOWN || trimmed === t(APP_SERVER_DOWN)) {
    return appServerDownHelp();
  }
  const context: Context = { raw, code, driver };
  for (const rule of RULES) {
    const found = matchRule(rule, raw);
    if (found !== null) {
      return rule.help(found, context);
    }
  }
  return null;
}

// An explanation for `raw`, or null when there is nothing more helpful to say
// than the message itself.
export function explainError(raw: string, code = ""): ErrorHelp | null {
  const text = raw.slice(0, SCAN_LIMIT);
  const driver = driverOf(text);
  // With "prefer", MySQL retries without TLS after a TLS failure; when that
  // retry fails too, its error is the one that matters, unless the server
  // insists on TLS (handled by the combined rule above).
  const retry = /평문 재시도 실패: ([\s\S]*)$/.exec(text);
  if (retry !== null && !TLS_REQUIRED.test(text)) {
    const help = explainWith(retry[1], code, driver);
    if (help !== null) {
      return help;
    }
  }
  return explainWith(text, code, driver);
}
