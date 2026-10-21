import { isHexColor, type ConnGroup } from "./connGroups";
import type { ConnMeta } from "./connMeta";
import { t } from "./i18n";
import { inputFromSaved } from "./savedInput";
import type { ConnectInput, Driver, SavedConnection } from "./store";

// The file "export connections" writes and "import from file" reads. It holds
// connection settings, names, colors, tags and groups. Never secrets.

export const CONNECTIONS_FILE_FORMAT = "tablepeek-connections";
export const CONNECTIONS_FILE_VERSION = 1;

export interface ExportedConnection {
  name: string;
  connect: ConnectInput;
  color: string;
  tags: string[];
  // Group name, or "" for none.
  group: string;
}

export interface ConnectionsFile {
  format: typeof CONNECTIONS_FILE_FORMAT;
  version: number;
  groups: { name: string; color: string }[];
  connections: ExportedConnection[];
}

export class ConnectionsFileError extends Error {}

const DRIVERS: Driver[] = ["postgres", "mysql", "cockroach", "mssql"];

export function stripSecrets(input: ConnectInput): ConnectInput {
  const copy = structuredClone(input);
  for (const driver of DRIVERS) {
    delete copy[driver]?.password;
  }
  delete copy.ssh?.password;
  delete copy.http_tunnel?.password;
  return copy;
}

// The caller scopes the export: which connections, and which groups to keep
// (all of them for a full export, so empty groups travel too).
export function buildConnectionsFile(
  saved: SavedConnection[],
  metaById: Record<string, ConnMeta>,
  groups: ConnGroup[],
): ConnectionsFile {
  const nameById = new Map(groups.map((group) => [group.id, group.name]));
  return {
    format: CONNECTIONS_FILE_FORMAT,
    version: CONNECTIONS_FILE_VERSION,
    groups: groups.map((group) => ({ name: group.name, color: group.color })),
    connections: saved.map((connection) => {
      const meta = metaById[connection.id];
      return {
        name: connection.name,
        connect: stripSecrets(inputFromSaved(connection)),
        color: meta?.color ?? "",
        tags: meta?.tags ?? [],
        group: nameById.get(meta?.group ?? "") ?? "",
      };
    }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const SSL_MODES = ["disable", "prefer", "require"];

function isPort(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

// An SSH or HTTP tunnel: absent, or host, port and the optional strings the server takes.
function tunnelProblem(value: unknown, kind: "ssh" | "http"): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const label = kind === "ssh" ? "SSH" : "HTTP";
  if (!isRecord(value) || typeof value.host !== "string" || value.host.trim() === "") {
    return t("{label} 터널의 호스트가 없습니다", { label });
  }
  if (!isPort(value.port)) {
    return t("{label} 터널의 포트가 올바르지 않습니다", { label });
  }
  const fine =
    kind === "ssh"
      ? typeof value.user === "string" && isOptionalString(value.private_key_path)
      : isOptionalString(value.username);
  return fine ? null : t("{label} 터널 설정이 올바르지 않습니다", { label });
}

// Mirrors what the server accepts when saving, so an import never stops halfway.
function connectionProblem(value: unknown): string | null {
  if (!isRecord(value)) {
    return t("연결 정보가 객체가 아닙니다");
  }
  if (typeof value.name !== "string" || value.name.trim() === "") {
    return t("이름이 없습니다");
  }
  const connect = value.connect;
  if (!isRecord(connect) || !DRIVERS.includes(connect.driver as Driver)) {
    return t("지원하지 않는 데이터베이스 종류입니다 ({driver})", {
      driver: isRecord(connect) ? String(connect.driver) : t("없음"),
    });
  }
  const db = connect[connect.driver as Driver];
  if (!isRecord(db) || typeof db.host !== "string" || db.host.trim() === "") {
    return t("호스트가 없습니다");
  }
  if (db.host.includes("://") || /[\s/@?]/.test(db.host)) {
    return t("호스트에는 주소만 입력하세요 (URL·계정 정보 제외)");
  }
  if (!isPort(db.port)) {
    return t("포트가 올바르지 않습니다");
  }
  if (typeof db.user !== "string") {
    return t("사용자 이름이 없습니다");
  }
  if (typeof db.database !== "string") {
    return t("데이터베이스 이름이 없습니다");
  }
  if (connect.driver === "mssql") {
    if (db.encrypt !== undefined && typeof db.encrypt !== "boolean") {
      return t("암호화 설정이 올바르지 않습니다");
    }
  } else {
    if (db.ssl_mode !== undefined && !SSL_MODES.includes(db.ssl_mode as string)) {
      return t("SSL 모드가 올바르지 않습니다 ({mode})", { mode: String(db.ssl_mode) });
    }
    if (![db.ssl_root_cert, db.ssl_client_cert, db.ssl_client_key].every(isOptionalString)) {
      return t("인증서 경로가 올바르지 않습니다");
    }
  }
  const tunnel = tunnelProblem(connect.ssh, "ssh") ?? tunnelProblem(connect.http_tunnel, "http");
  if (tunnel !== null) {
    return tunnel;
  }
  if (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string"))) {
    return t("태그 형식이 올바르지 않습니다");
  }
  return null;
}

// All or nothing: a file with one bad connection imports none of them.
export function parseConnectionsFile(text: string): ConnectionsFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ConnectionsFileError(t("연결 파일을 읽을 수 없습니다. JSON 형식이 아닙니다."));
  }
  if (!isRecord(data) || data.format !== CONNECTIONS_FILE_FORMAT) {
    throw new ConnectionsFileError(t("TablePeek 연결 파일이 아닙니다."));
  }
  if (data.version !== CONNECTIONS_FILE_VERSION) {
    throw new ConnectionsFileError(
      t("지원하지 않는 연결 파일 버전입니다 ({version}).", { version: String(data.version) }),
    );
  }
  if (!Array.isArray(data.connections) || (data.groups !== undefined && !Array.isArray(data.groups))) {
    throw new ConnectionsFileError(t("연결 파일의 구성이 올바르지 않습니다."));
  }
  data.connections.forEach((connection, index) => {
    const problem = connectionProblem(connection);
    if (problem !== null) {
      throw new ConnectionsFileError(t("{index}번째 연결: {problem}", { index: index + 1, problem }));
    }
  });
  const groups = (data.groups ?? []) as unknown[];
  return {
    format: CONNECTIONS_FILE_FORMAT,
    version: CONNECTIONS_FILE_VERSION,
    groups: groups
      .filter((group): group is Record<string, unknown> => isRecord(group) && typeof group.name === "string")
      .map((group) => ({ name: group.name as string, color: isHexColor(group.color) ? group.color : "" })),
    connections: (data.connections as Record<string, unknown>[]).map((connection) => ({
      name: connection.name as string,
      connect: connection.connect as ConnectInput,
      color: isHexColor(connection.color) ? connection.color : "",
      tags: (connection.tags as string[] | undefined) ?? [],
      group: typeof connection.group === "string" ? connection.group : "",
    })),
  };
}

// The name an imported connection gets when its own is taken:
// "name (가져옴)", then "name (가져옴 2)", "name (가져옴 3)", …
export function importName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) {
    return name;
  }
  let candidate = `${name} ${t("(가져옴)")}`;
  for (let n = 2; taken.has(candidate); n += 1) {
    candidate = `${name} ${t("(가져옴 {n})", { n })}`;
  }
  return candidate;
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
