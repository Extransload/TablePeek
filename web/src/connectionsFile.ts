import type { ConnGroup } from "./connGroups";
import type { ConnMeta } from "./connMeta";
import { t } from "./i18n";
import type { ExportConnectionsRequest } from "./store";

// The encrypted connections file (".tablepeek") that "export connections"
// writes and "import" reads, sealed and opened by the server. It never holds
// passwords: none are stored.

export const CONNECTIONS_FILE_NAME = "tablepeek-connections.tablepeek";
export const CONNECTIONS_FILE_ACCEPT = ".tablepeek";
export const MIN_FILE_PASSWORD = 8;
// Well above any real file, and under the server's request limit.
export const MAX_IMPORT_BYTES = 1024 * 1024;

// What the server needs besides the profiles: each one's color, tags and group
// name. The caller scopes the groups (all of them for a full export, so empty
// groups travel too); a group left out is not named.
export function exportRequest(
  ids: string[],
  metaById: Record<string, ConnMeta>,
  groups: ConnGroup[],
  passphrase: string,
): ExportConnectionsRequest {
  const nameById = new Map(groups.map((group) => [group.id, group.name]));
  return {
    ids,
    meta: Object.fromEntries(
      ids.map((id) => {
        const meta = metaById[id];
        return [id, { color: meta?.color ?? "", tags: meta?.tags ?? [], group: nameById.get(meta?.group ?? "") ?? "" }];
      }),
    ),
    groups: groups.map((group) => ({ name: group.name, color: group.color })),
    passphrase,
  };
}

export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

// The server reports import failures in Korean; put them in the page's language.
// "N번째 연결: …" names the entry, and its reason may carry a parser detail.
export function importErrorText(code: string | null, message: string): string {
  const entry = /^(\d+)번째 연결: (.*)$/s.exec(message);
  if (code === "invalid_file" && entry !== null) {
    const [, index, problem] = entry;
    const detail = /^접속 정보가 올바르지 않습니다 \((.*)\)$/s.exec(problem);
    return t("{index}번째 연결: {problem}", {
      index,
      problem: detail !== null ? t("접속 정보가 올바르지 않습니다 ({detail})", { detail: detail[1] }) : t(problem),
    });
  }
  if (message === "HTTP 413") {
    return t("연결 파일이 너무 큽니다");
  }
  return t(message);
}
