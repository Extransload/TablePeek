import type { ErrorRule } from "../../errorHelp";
import { t } from "../../i18n";

// Explanations of Redis's own errors (docs/ERRORS.md §3). The server sends
// the reply's error prefix as the code (`redis_WRONGTYPE`, `redis_NOPERM`),
// `redis_error` when there is none (a refused connection), `not_found` for
// a key that is gone.

export const redisErrorRules: ErrorRule[] = [
  {
    code: /\bredis_WRONGTYPE\b/,
    help: () => ({
      title: t("키의 타입이 명령과 맞지 않습니다"),
      cause: t("이 명령은 다른 타입의 키에 씁니다 (예: 해시에 GET)."),
      fixes: [t("TYPE으로 키의 타입을 확인하고 그 타입의 명령을 쓰세요.")],
    }),
  },
  {
    code: /\bredis_NOPERM\b/,
    help: () => ({
      title: t("권한이 없습니다"),
      cause: t("이 ACL 사용자에게는 이 명령이나 키를 쓸 권한이 없습니다."),
      fixes: [t("ACL WHOAMI·ACL GETUSER로 권한을 확인하거나, 권한이 있는 사용자로 접속하세요.")],
    }),
  },
  {
    code: /\bredis_READONLY\b/,
    match: /읽기 전용 복제 서버/,
    help: () => ({
      title: t("읽기 전용 서버입니다"),
      cause: t("읽기 전용 복제 서버(replica)에는 쓸 수 없습니다."),
      fixes: [t("바꾸려면 마스터에 접속하세요.")],
    }),
  },
  {
    code: /\bredis_(NOAUTH|WRONGPASS)\b/,
    help: () => ({
      title: t("Redis 인증에 실패했습니다"),
      cause: t("비밀번호가 없거나 틀렸습니다 (requirepass 또는 ACL 사용자)."),
      fixes: [t("연결 설정의 인증 방식, 사용자, 비밀번호를 확인하세요.")],
    }),
  },
  {
    code: /\bredis_NOSCRIPT\b/,
    help: () => ({
      title: t("스크립트가 없습니다"),
      cause: t("EVALSHA가 가리키는 스크립트가 서버의 스크립트 캐시에 없습니다."),
      fixes: [t("EVAL로 스크립트를 보내거나 SCRIPT LOAD로 먼저 올리세요.")],
    }),
  },
  {
    code: /\bredis_OOM\b/,
    help: () => ({
      title: t("서버 메모리가 가득 찼습니다"),
      cause: t("maxmemory에 닿아 서버가 쓰기를 받지 않습니다."),
      fixes: [t("필요 없는 키를 지우거나 만료를 걸고, maxmemory와 maxmemory-policy 설정을 확인하세요.")],
    }),
  },
  {
    code: /\bredis_BUSY\b/,
    help: () => ({
      title: t("서버가 스크립트를 실행하고 있습니다"),
      cause: t("오래 걸리는 Lua 스크립트나 함수가 끝날 때까지 다른 명령을 받지 않습니다."),
      fixes: [t("콘솔에서 SCRIPT KILL 또는 FUNCTION KILL로 멈추세요.")],
    }),
  },
  {
    code: /\bredis_LOADING\b/,
    help: () => ({
      title: t("서버가 데이터를 읽어 들이고 있습니다"),
      cause: t("재시작한 서버가 디스크의 데이터(RDB·AOF)를 아직 다 읽지 못했습니다."),
      fixes: [t("잠시 뒤 다시 시도하세요.")],
    }),
  },
  {
    code: /\bredis_MISCONF\b/,
    help: () => ({
      title: t("서버가 쓰기를 멈췄습니다"),
      cause: t("RDB 스냅숏을 디스크에 저장하지 못해 서버가 쓰기를 받지 않습니다."),
      fixes: [t("서버 로그, 디스크 공간, dir 설정을 확인하세요.")],
    }),
  },
  {
    code: /\bredis_(MOVED|ASK|CLUSTERDOWN|CROSSSLOT)\b/,
    match: /Redis Cluster 모드의 서버입니다/,
    help: () => ({
      title: t("Redis Cluster 서버입니다"),
      cause: t("키가 클러스터의 다른 노드에 있습니다. TablePeek은 Redis Cluster를 다루지 않습니다."),
      fixes: [t("클러스터 모드가 꺼진 서버(또는 복제 서버)에 접속하세요.")],
    }),
  },
  {
    code: /\bnot_found\b/,
    match: /키가 없습니다/,
    help: () => ({
      title: t("키가 없습니다"),
      cause: t("목록을 읽은 뒤 지워졌거나 만료되었습니다."),
      fixes: [t("키 목록을 새로 고치세요.")],
    }),
  },
];
