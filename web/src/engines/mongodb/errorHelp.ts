import type { ErrorRule, ErrorSituation } from "../../errorHelp";
import { t } from "../../i18n";
import { stringifyJson } from "./bson";

// Explanations of MongoDB's own errors (docs/ERRORS.md §3). The server sends
// MongoDB's code as `server_code` and errInfo as `details`; the rules also
// read the driver's text for the code when only that is known.

// A canonical Extended JSON value as a person would write it: -5, "a@b",
// ObjectId("…").
function ejsonText(value: unknown): string {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 1) {
      const [key, inner] = entries[0];
      if (key === "$numberInt" || key === "$numberLong" || key === "$numberDouble" || key === "$numberDecimal") {
        return String(inner);
      }
      if (key === "$oid") {
        return `ObjectId("${String(inner)}")`;
      }
      if (key === "$date") {
        return typeof inner === "string" ? inner : ejsonText(inner);
      }
    }
  }
  const text = value === undefined ? String(value) : stringifyJson(value);
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// Which parts of a $jsonSchema or query validator a document failed, from the
// errInfo of error 121: "age: minimum 0 (값 -5)", "필수 필드 없음: name".
function validationSummary(details: unknown): string[] {
  const outer = recordOf(details);
  const errInfo =
    recordOf(outer?.errInfo) ?? recordOf(recordOf(listOf(outer?.writeErrors)[0])?.errInfo) ?? outer;
  const lines: string[] = [];
  const visit = (node: unknown, path: string): void => {
    const item = recordOf(node);
    if (item === null || lines.length >= 4) {
      return;
    }
    const field = typeof item.propertyName === "string" ? (path === "" ? item.propertyName : `${path}.${item.propertyName}`) : path;
    if (typeof item.description === "string" && item.description !== "" && field !== "") {
      lines.push(`${field}: ${item.description}`);
      return;
    }
    const missing = listOf(item.missingProperties);
    if (missing.length > 0) {
      lines.push(t("필수 필드 없음: {fields}", { fields: missing.map((name) => (path === "" ? String(name) : `${path}.${String(name)}`)).join(", ") }));
      return;
    }
    const extra = listOf(item.additionalProperties);
    if (item.operatorName === "additionalProperties" && extra.length > 0) {
      lines.push(t("허용되지 않은 필드: {fields}", { fields: extra.map(String).join(", ") }));
      return;
    }
    const children = [
      ...listOf(item.schemaRulesNotSatisfied),
      ...listOf(item.propertiesNotSatisfied),
      ...listOf(item.clausesNotSatisfied),
      ...listOf(item.details),
      ...listOf(item.itemsNotSatisfied),
    ];
    const single = recordOf(item.details);
    if (single !== null) {
      children.push(single);
    }
    if (children.length > 0) {
      for (const child of children) {
        visit(child, field);
      }
      return;
    }
    if (typeof item.operatorName !== "string") {
      return;
    }
    const specified = recordOf(item.specifiedAs);
    const rule =
      specified !== null && item.operatorName in specified
        ? `${item.operatorName} ${ejsonText(specified[item.operatorName])}`
        : specified !== null
          ? ejsonText(specified)
          : item.operatorName;
    const considered = "consideredValue" in item ? t(" (값 {value})", { value: ejsonText(item.consideredValue) }) : "";
    lines.push(field !== "" ? `${field}: ${rule}${considered}` : `${rule}${considered}`);
  };
  visit(recordOf(errInfo?.details) ?? errInfo, "");
  return lines;
}

// Operators and stages people use most, for "did you mean".
const KNOWN_OPERATORS = [
  "$match", "$group", "$project", "$sort", "$limit", "$skip", "$lookup", "$unwind", "$addFields", "$set", "$unset",
  "$count", "$facet", "$replaceRoot", "$sample", "$out", "$merge", "$bucket", "$sortByCount",
  "$eq", "$ne", "$gt", "$gte", "$lt", "$lte", "$in", "$nin", "$and", "$or", "$not", "$nor", "$exists", "$type",
  "$regex", "$expr", "$elemMatch", "$size", "$all", "$text", "$sum", "$avg", "$min", "$max", "$first", "$last",
  "$push", "$addToSet", "$concat", "$cond", "$ifNull", "$toString", "$toInt", "$dateToString", "$inc", "$pull",
];

function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[b.length];
}

// The known operator closest to a misspelt one, when it is close enough.
function closestOperator(name: string): string | null {
  let best: string | null = null;
  let bestDistance = 3;
  for (const known of KNOWN_OPERATORS) {
    const distance = editDistance(name.toLowerCase(), known.toLowerCase());
    if (distance < bestDistance) {
      best = known;
      bestDistance = distance;
    }
  }
  return best === name ? null : best;
}

// Signs that a server-selection failure is really a refused port or an
// unknown host, which the shared network rules explain better.
const NETWORK_CAUSE = /Connection refused|actively refused|os error \d+|failed to lookup address|nodename nor servname|Name or service not known|No such host/i;

// The fix for the connection's settings: a button-sized hint inside the
// connection dialog, "edit the connection" anywhere else.
function inConnection(situation: ErrorSituation, here: string, elsewhere: string): string {
  return situation.where === "connect" ? t(here) : t(elsewhere);
}

export const mongoErrorRules: ErrorRule[] = [
  {
    match: /Authentication failed|SCRAM failure|AuthenticationFailed/,
    code: /\bmongo_18\b/,
    help: (_found, situation) => {
      // The driver names the mechanism ("MONGODB-AWS failure: …"); the
      // authentication database means nothing to the $external ones.
      if (/MONGODB-AWS/.test(situation.raw)) {
        return {
          title: t("로그인에 실패했습니다"),
          cause: t("AWS 액세스 키 ID, 비밀 액세스 키 또는 세션 토큰이 맞지 않거나, 그 자격 증명의 ARN으로 된 사용자가 서버에 없습니다."),
          fixes: [
            t("액세스 키 ID와 비밀 액세스 키를 다시 확인하세요. 임시 자격 증명이면 세션 토큰도 넣어야 합니다."),
            t("서버의 $external에 그 IAM 사용자나 역할의 ARN으로 사용자가 있는지 확인하세요."),
          ],
        };
      }
      if (/\bPLAIN\b/.test(situation.raw)) {
        return {
          title: t("로그인에 실패했습니다"),
          cause: t("LDAP 사용자 이름이나 비밀번호가 맞지 않습니다."),
          fixes: [t("LDAP 사용자 이름과 비밀번호를 다시 확인하세요. 대소문자를 구분합니다.")],
        };
      }
      if (/MONGODB-X509/.test(situation.raw)) {
        return {
          title: t("로그인에 실패했습니다"),
          cause: t("클라이언트 인증서의 주체(subject)와 같은 이름의 사용자가 서버의 $external에 없습니다."),
          fixes: [t("인증서를 확인하거나, 서버에 그 주체 이름으로 $external 사용자를 만드세요.")],
        };
      }
      return {
        title: t("로그인에 실패했습니다"),
        cause: t("사용자 이름, 비밀번호 또는 인증 DB가 맞지 않습니다."),
        fixes: [
          t("사용자 이름과 비밀번호를 다시 확인하세요. 대소문자를 구분합니다."),
          inConnection(
            situation,
            "‘인증 DB’가 사용자를 만든 데이터베이스인지 확인하세요. 보통 admin입니다.",
            "연결을 편집해 비밀번호와 ‘인증 DB’(보통 admin)를 확인하세요.",
          ),
        ],
      };
    },
  },
  {
    match: /ReplicaSetNoPrimary|no reachable primary|No primary available|None of the available servers suitable for criteria|닿을 수 있는 프라이머리가 없습니다/i,
    help: (_found, situation) => {
      // The members the driver found, from the server's topology details.
      const members = listOf(recordOf(situation.error.details)?.servers)
        .map((server) => recordOf(server)?.address)
        .filter((address): address is string => typeof address === "string");
      return {
        title: t("레플리카셋의 기본(primary) 서버에 닿을 수 없습니다"),
        cause:
          members.length > 0
            ? t("서버는 응답했지만 레플리카셋 구성원 주소({members})로는 이 컴퓨터에서 접속할 수 없습니다.", {
                members: members.join(", "),
              })
            : t(
                "서버는 응답했지만 레플리카셋 구성에 적힌 구성원 주소(컨테이너·내부 호스트 이름 등)로는 이 컴퓨터에서 접속할 수 없습니다.",
              ),
        fixes: [
          inConnection(
            situation,
            "‘직접 연결’을 켜면 입력한 주소의 서버에만 바로 연결합니다.",
            "연결을 편집해 ‘직접 연결’을 켜면 입력한 주소의 서버에만 바로 연결합니다.",
          ),
          t("레플리카셋 전체를 쓰려면 구성원 주소(rs.conf())가 이 컴퓨터에서 보이는지 확인하세요."),
          t("기본 서버를 다시 뽑는 중이라면 잠시 후 다시 시도하세요."),
        ],
        action: "direct-connection",
      };
    },
  },
  {
    match: /Server selection timeout|No available servers/i,
    when: (raw) => !NETWORK_CAUSE.test(raw),
    help: () => ({
      title: t("MongoDB 서버를 찾지 못했습니다 (시간 초과)"),
      cause: t("정해진 시간 안에 응답하는 서버가 없었습니다. 방화벽·VPN이나 TLS 설정이 맞지 않을 때 흔합니다."),
      fixes: [
        t("호스트 주소와 포트를 확인하세요."),
        t("Atlas 같은 클라우드라면 이 컴퓨터의 공인 IP가 접속 허용 목록에 있는지 확인하세요."),
        t("서버가 TLS를 요구하는지 확인하세요."),
      ],
    }),
  },
  {
    match: /E11000 duplicate key error(?: collection: (\S+))?(?: index: (\S+))?(?: dup key: (\{.*?\}))?/,
    code: /\bmongo_(?:11000|11001|12582)\b|\bDuplicateKey\b/,
    help: (found, situation) => {
      const index = found[2];
      const value = found[3]?.replace(/^\{\s*|\s*\}$/g, "");
      const onId = index === "_id_";
      const fixes = [t("값을 바꾸거나, 이미 있는 문서를 수정하세요.")];
      if (onId && situation.where !== "data") {
        fixes.push(t("새 문서라면 _id를 빼고 저장하세요. 새 ObjectId가 만들어집니다."));
      }
      if (situation.where === "import") {
        fixes.push(t("가져올 파일 안에 같은 키가 두 번 들어 있지 않은지도 확인하세요."));
      }
      return {
        title: onId ? t("같은 _id를 가진 문서가 이미 있습니다") : t("같은 키를 가진 문서가 이미 있습니다"),
        cause:
          index !== undefined && value !== undefined
            ? t("‘{index}’ 인덱스에 {value} 값이 이미 있습니다. 이 인덱스는 값이 겹치면 안 됩니다.", { index, value })
            : index !== undefined
              ? t("값이 겹치면 안 되는 ‘{index}’ 인덱스에 같은 값이 이미 있습니다.", { index })
              : undefined,
        fixes,
      };
    },
  },
  {
    match: /Document failed validation/,
    code: /\bmongo_121\b|\bDocumentValidationFailure\b/,
    help: (_found, situation) => {
      const failed = validationSummary(situation.error.details);
      return {
        title: t("컬렉션의 검증 규칙에 맞지 않는 문서입니다"),
        cause:
          failed.length > 0
            ? t("맞지 않는 부분: {rules}", { rules: failed.join("; ") })
            : t("서버가 어느 규칙이 어긋났는지 알려 주지 않았습니다."),
        fixes: [
          t("문서를 검증 규칙에 맞게 고친 뒤 다시 저장하세요."),
          t("규칙은 컬렉션의 ‘검증’ 탭에서 볼 수 있습니다."),
        ],
        action: "open-validation",
      };
    },
  },
  {
    match: /unknown (?:top level )?operator: (\$[\w.]+)|Unrecognized pipeline stage name: '([^']+)'|Unrecognized expression '([^']+)'|unknown group operator '([^']+)'|Unrecognized accumulator operator '?([^'\s]+)'?/,
    code: /\bmongo_(?:40324|168|15952)\b|\bInvalidPipelineOperator\b/,
    help: (found) => {
      const name = found[1] ?? found[2] ?? found[3] ?? found[4] ?? found[5] ?? "";
      const stage = found[2] !== undefined;
      const closest = name !== "" ? closestOperator(name) : null;
      const fixes: string[] = [];
      if (closest !== null) {
        fixes.push(t("‘{closest}’을(를) 쓰려던 것인지 확인하세요.", { closest }));
      }
      fixes.push(
        stage
          ? t("단계 이름의 철자를 확인하세요 (예: $match, $group, $project, $sort, $lookup).")
          : t("연산자 이름의 철자와 대소문자를 확인하세요 (예: $eq, $in, $gt, $regex, $sum)."),
      );
      if (!stage) {
        fixes.push(t("필드를 가리키려면 이름 앞에 $를 붙이지 말고, 값 자리에 ‘$필드’로 쓰세요."));
      }
      return {
        title: stage
          ? t("알 수 없는 집계 단계 ‘{name}’", { name })
          : name !== ""
            ? t("알 수 없는 연산자 ‘{name}’", { name })
            : t("알 수 없는 연산자입니다"),
        cause: stage
          ? t("집계 파이프라인에 이런 단계가 없습니다. 철자가 틀렸거나 이 서버 버전에서 지원하지 않는 단계입니다.")
          : t("MongoDB가 모르는 연산자입니다. 철자가 틀렸거나 이 서버 버전에서 지원하지 않는 연산자입니다."),
        fixes,
      };
    },
  },
];
