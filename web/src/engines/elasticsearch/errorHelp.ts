import type { ErrorRule, ErrorSituation } from "../../errorHelp";
import { t } from "../../i18n";

// Explanations of Elasticsearch / OpenSearch errors (docs/ERRORS.md §3). The
// server sends the error `type` as the code (`es_<type>`), the HTTP status as
// `server_code` and `{ status, root_cause, caused_by }` as `details`; both
// engines share these rules (error_code_prefix "es").

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

// The innermost reason the server gave (`caused_by` chains, the first root
// cause), when it says more than the top-level message.
function deepestReason(situation: ErrorSituation): string | null {
  const details = recordOf(situation.error.details);
  let cause = recordOf(details?.caused_by);
  let reason: string | null = null;
  while (cause !== null) {
    if (typeof cause.reason === "string") {
      reason = cause.reason;
    }
    cause = recordOf(cause.caused_by);
  }
  if (reason === null && Array.isArray(details?.root_cause)) {
    const first = recordOf(details.root_cause[0]);
    if (typeof first?.reason === "string" && first.reason !== situation.error.message) {
      reason = first.reason;
    }
  }
  return reason;
}

function inConnection(situation: ErrorSituation, here: string, elsewhere: string): string {
  return situation.where === "connect" ? t(here) : t(elsewhere);
}

export const searchErrorRules: ErrorRule[] = [
  {
    code: /\bes_index_not_found_exception\b/,
    match: /no such index \[([^\]]+)\]/,
    help: (found) => ({
      title: t("인덱스가 없습니다"),
      cause: found?.[1] ? t("‘{name}’ 인덱스(또는 별칭·데이터 스트림)가 이 클러스터에 없습니다.", { name: found[1] }) : t("요청한 인덱스(또는 별칭·데이터 스트림)가 이 클러스터에 없습니다."),
      fixes: [t("이름의 철자와 대소문자를 확인하세요. 인덱스 이름은 모두 소문자입니다."), t("사이드바를 새로 고쳐 지금 있는 인덱스를 확인하세요.")],
      action: "refresh-schema",
    }),
  },
  {
    code: /\bes_version_conflict_engine_exception\b/,
    help: () => ({
      title: t("다른 곳에서 바뀌었습니다"),
      cause: t("문서를 읽은 뒤 다른 곳에서 고쳐 _seq_no·_primary_term이 맞지 않습니다."),
      fixes: [t("문서를 다시 불러와 지금 값을 확인한 뒤 고치세요.")],
    }),
  },
  {
    code: /\bes_(parsing_exception|x_content_parse_exception|json_parse_exception|named_object_not_found_exception)\b/,
    help: (_found, situation) => {
      const deeper = deepestReason(situation);
      const unknown = /unknown query \[([^\]]+)\]|\[(\w+)\] query malformed|unknown field \[([^\]]+)\]|no \[query\] registered for \[([^\]]+)\]/.exec(`${situation.error.message} ${deeper ?? ""}`);
      const name = unknown?.slice(1).find((x) => x !== undefined);
      return {
        title: t("Query DSL을 읽을 수 없습니다"),
        cause: name ? t("‘{name}’은(는) 이 자리에 쓸 수 없는 키입니다.", { name }) : (deeper ?? undefined),
        fixes: [t("JSON 구조와 키 이름을 확인하세요. 자동완성(⌃Space)이 이 자리에 쓸 수 있는 키를 보여줍니다.")],
      };
    },
  },
  {
    code: /\bes_search_phase_execution_exception\b/,
    help: (_found, situation) => {
      const deeper = deepestReason(situation);
      const text = deeper ?? situation.error.message;
      if (/Text fields are not optimised for operations|Fielddata is disabled on \[([^\]]+)\]/.test(text)) {
        const field = /\[([^\]]+)\]/.exec(text)?.[1];
        return {
          title: t("text 필드로는 정렬·집계할 수 없습니다"),
          cause: field ? t("‘{field}’는 분석되는 text 필드라 정렬·집계에 쓸 값이 없습니다.", { field }) : t("분석되는 text 필드라 정렬·집계에 쓸 값이 없습니다."),
          fixes: [t("같은 필드의 keyword 하위 필드(예: name.keyword)로 정렬·집계하세요.")],
        };
      }
      if (/Result window is too large/.test(text)) {
        return {
          title: t("너무 뒤 페이지를 요청했습니다"),
          cause: t("from + size가 index.max_result_window(기본 10,000)를 넘습니다."),
          fixes: [t("정렬을 정하고 search_after로 넘기거나, 내보내기를 쓰세요. 필요하면 설정 탭에서 max_result_window를 늘리세요.")],
        };
      }
      if (/No mapping found for \[([^\]]+)\] in order to sort on/.test(text)) {
        return {
          title: t("정렬할 필드가 매핑에 없습니다"),
          cause: text,
          fixes: [t("필드 이름을 확인하거나 sort에 \"unmapped_type\"을 주세요.")],
        };
      }
      return { title: t("검색이 샤드에서 실패했습니다"), cause: text, fixes: [] };
    },
  },
  {
    code: /\bes_illegal_argument_exception\b/,
    help: (_found, situation) => ({
      title: t("요청 값이 올바르지 않습니다"),
      cause: deepestReason(situation) ?? situation.error.message,
      fixes: [],
    }),
  },
  {
    code: /\bes_mapper_parsing_exception\b|\bes_document_parsing_exception\b/,
    help: (_found, situation) => ({
      title: t("문서가 매핑과 맞지 않습니다"),
      cause: deepestReason(situation) ?? situation.error.message,
      fixes: [t("필드 값의 타입이 매핑의 타입과 같은지 확인하세요. 매핑 탭에서 필드 타입을 볼 수 있습니다.")],
    }),
  },
  {
    code: /\bes_resource_already_exists_exception\b/,
    help: () => ({ title: t("같은 이름의 인덱스가 이미 있습니다"), fixes: [t("다른 이름을 쓰거나 기존 인덱스를 지운 뒤 다시 만드세요.")] }),
  },
  {
    code: /\bes_invalid_index_name_exception\b/,
    help: (_found, situation) => ({
      title: t("인덱스 이름을 쓸 수 없습니다"),
      cause: situation.error.message,
      fixes: [t("소문자만 쓰고, \\ / * ? \" < > | 공백 , #는 뺍니다. -, _, +로 시작할 수 없습니다.")],
    }),
  },
  {
    code: /\bes_cluster_block_exception\b/,
    match: /blocked by: \[([^\]]+)\]|index \[[^\]]+\] blocked/,
    help: (_found, situation) => ({
      title: t("인덱스가 잠겨 쓸 수 없습니다"),
      cause: /read-only-allow-delete|disk usage exceeded/.test(situation.raw) ? t("디스크 사용량이 한도를 넘어 Elasticsearch가 인덱스를 읽기 전용으로 바꿨습니다.") : situation.error.message,
      fixes: [t("디스크 공간을 확보한 뒤 설정 탭에서 index.blocks.read_only_allow_delete를 지우세요.")],
    }),
  },
  {
    code: /\bes_index_closed_exception\b/,
    help: () => ({ title: t("닫힌 인덱스입니다"), fixes: [t("사이드바의 인덱스 메뉴에서 열기를 고르세요.")] }),
  },
  {
    code: /\bes_security_exception\b/,
    match: /action \[([^\]]+)\] is unauthorized for user \[([^\]]+)\]/,
    help: (found, situation) =>
      situation.error.server_code === 401 || /missing authentication|unable to authenticate/i.test(situation.raw)
        ? {
            title: t("로그인에 실패했습니다"),
            cause: t("사용자 이름·비밀번호, API 키 또는 토큰이 맞지 않습니다."),
            fixes: [inConnection(situation, "인증 방식과 비밀번호(또는 API 키)를 다시 확인하세요.", "연결을 편집해 인증 방식과 비밀번호(또는 API 키)를 확인하세요.")],
          }
        : {
            title: t("권한이 없습니다"),
            cause: found?.[1] ? t("사용자 ‘{user}’에게 {action} 권한이 없습니다.", { user: found[2] ?? "", action: found[1] }) : situation.error.message,
            fixes: [t("관리자에게 이 인덱스에 대한 역할(read, write, manage)을 받으세요.")],
          },
  },
  {
    match: /Authentication failed/,
    code: /\bes_http_401\b/,
    help: (_found, situation) => ({
      title: t("로그인에 실패했습니다"),
      cause: t("사용자 이름·비밀번호, API 키 또는 토큰이 맞지 않습니다."),
      fixes: [inConnection(situation, "인증 방식과 비밀번호(또는 API 키)를 다시 확인하세요.", "연결을 편집해 인증 방식과 비밀번호(또는 API 키)를 확인하세요.")],
    }),
  },
  {
    code: /\bes_(circuit_breaking_exception|es_rejected_execution_exception|too_many_requests)\b|\bes_http_429\b/,
    help: (_found, situation) => ({
      title: t("클러스터가 바빠 요청을 거절했습니다"),
      cause: deepestReason(situation) ?? situation.error.message,
      fixes: [t("잠시 뒤 다시 하거나, 한 번에 가져오는 문서 수(size)·가져오기 묶음 크기를 줄이세요.")],
    }),
  },
  {
    code: /\bes_http_(404|405)\b/,
    match: /no handler found for uri|Incorrect HTTP method/,
    help: () => ({
      title: t("이 서버에 없는 API입니다"),
      cause: t("경로나 메서드를 이 버전의 서버가 모릅니다. OpenSearch와 Elasticsearch는 일부 API 경로가 다릅니다(예: _plugins/_sql과 _sql)."),
      fixes: [t("경로와 메서드를 확인하세요.")],
    }),
  },
];
