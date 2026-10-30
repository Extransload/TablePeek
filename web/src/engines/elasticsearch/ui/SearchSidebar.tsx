// The Items pane of a search connection: 인덱스 (health dot, document count),
// 별칭 (with the indices behind each) and 데이터 스트림, with a search box and a
// toggle for hidden and system indices. Click opens an index tab (the open
// one if there is one); as on the SQL sidebar a middle-click, ⌘-click or
// ⌘↩ opens another tab beside it. The context menus offer the console,
// import/export and the management dialogs, which App shows through
// `onAdmin`.

import { useEffect, useMemo, useState, useSyncExternalStore, type ReactElement } from "react";
import { ContextMenu, type ContextMenuItem } from "../../../components/ContextMenu";
import { ErrorNotice, notifyError } from "../../../components/ErrorNotice";
import { ChevronIcon, EyeIcon, LinkIcon, ListIcon, MoreIcon, SearchIcon } from "../../../components/icons";
import { LoadingState, Spinner } from "../../../components/Spinner";
import { formatBytes } from "../../../format";
import { t } from "../../../i18n";
import { store } from "../../../store";
import { aliases as listAliases, dataStreams as listDataStreams, indexAction, indices as listIndices, isAbort, privileges, updateAliases, type AliasRow, type DataStreamRow, type IndexRow, type Privileges } from "../api";
import { jsonObject } from "../../mongodb/bson";
import { needsConfirm, requestText, type SearchHost } from "./common";
import type { SearchAdminRequest, TargetKind } from "./types";
import "./search.css";

interface SearchSidebarProps {
  host: SearchHost;
  // Bumped to read everything again (F5, after a change).
  refreshKey: number;
  // The tab in front, highlighted.
  active: { index: string; kind: TargetKind } | null;
  // `newTab`: another tab even when one shows it already.
  onOpen(index: string, kind: TargetKind, newTab?: boolean): void;
  // A new console tab, its text seeded when an index was picked.
  onOpenConsole(text?: string): void;
  onOpenCluster(): void;
  // The 보안 tab (users, roles, role mappings, API keys).
  onOpenSecurity(): void;
  onAdmin(request: SearchAdminRequest): void;
  // Something changed here (an alias removed, an index refreshed).
  onChanged(): void;
}

interface Lists {
  indices: IndexRow[];
  aliases: AliasRow[];
  streams: DataStreamRow[];
}

// Per connection while the app runs: hidden indices shown, sections folded.
const hiddenByConn = new Map<string, boolean>();
const foldedByConn = new Map<string, Set<string>>();

export function SearchSidebar({ host, refreshKey, active, onOpen, onOpenConsole, onOpenCluster, onOpenSecurity, onAdmin, onChanged }: SearchSidebarProps) {
  const { conn } = host;
  const [lists, setLists] = useState<Lists | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [filter, setFilter] = useState("");
  const [showHidden, setShowHidden] = useState(() => hiddenByConn.get(conn) ?? false);
  const [folded, setFolded] = useState<Set<string>>(() => foldedByConn.get(conn) ?? new Set());
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [nonce, setNonce] = useState(0);
  // The user's rights across indices: writes, creating and deleting hide
  // when the server says they are not allowed.
  const [rights, setRights] = useState<Privileges | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    privileges(conn, "*", controller.signal).then(setRights, () => setRights(null));
    return () => controller.abort();
  }, [conn]);
  const known = rights?.known === true;
  const readOnly = host.readOnly || (known && rights !== null && !rights.index.write);
  const cannotCreate = host.readOnly || (known && rights !== null && !rights.index.create_index);
  const cannotDelete = host.readOnly || (known && rights !== null && !rights.index.delete_index);
  // Bumps when the TablePeek server answers again after being down.
  const serverEpoch = useSyncExternalStore(store.subscribe, () => store.getState().server.epoch);

  useEffect(() => {
    hiddenByConn.set(conn, showHidden);
    foldedByConn.set(conn, folded);
  }, [conn, showHidden, folded]);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    Promise.all([listIndices(conn, showHidden, controller.signal), listAliases(conn, controller.signal), listDataStreams(conn, controller.signal)]).then(
      ([indices, aliases, streams]) => setLists({ indices, aliases, streams }),
      (reason: unknown) => {
        if (!isAbort(reason)) {
          setError(reason);
        }
      },
    );
    return () => controller.abort();
  }, [conn, showHidden, refreshKey, nonce, serverEpoch]);

  const query = filter.trim().toLowerCase();
  const shown = useMemo(() => {
    if (lists === null) {
      return null;
    }
    const match = (name: string) => query === "" || name.toLowerCase().includes(query);
    // Backing indices of a data stream sit under the stream; hidden ones
    // only show with the toggle on.
    const indices = lists.indices.filter((row) => match(row.name) && (showHidden || (!row.hidden && !row.name.startsWith(".")))).sort((a, b) => a.name.localeCompare(b.name));
    const aliasNames = new Map<string, AliasRow[]>();
    for (const row of lists.aliases) {
      if ((showHidden || (!row.is_hidden && !row.alias.startsWith("."))) && match(row.alias)) {
        aliasNames.set(row.alias, [...(aliasNames.get(row.alias) ?? []), row]);
      }
    }
    const streams = lists.streams.filter((row) => match(row.name) && (showHidden || (!row.hidden && !row.name.startsWith("."))));
    return { indices, aliases: [...aliasNames.entries()].sort((a, b) => a[0].localeCompare(b[0])), streams };
  }, [lists, query, showHidden]);

  const toggle = (section: string) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (!next.delete(section)) {
        next.add(section);
      }
      return next;
    });

  const consoleText = (name: string) => `GET /${name}/_search\n{\n  "query": {\n    "match_all": {}\n  }\n}\n`;

  // Small actions run here with the safe-mode rule; bigger ones open a dialog.
  const runAction = async (action: "refresh" | "open", name: string) => {
    if (needsConfirm("write", host.safeMode)) {
      const ok = await host.confirm({
        title: action === "refresh" ? t("인덱스 새로 고침") : t("인덱스 열기"),
        message: action === "refresh" ? t("최근 색인한 문서가 검색에 보이게 합니다.") : t("닫힌 인덱스를 다시 엽니다."),
        command: requestText("POST", `/${name}/${action === "refresh" ? "_refresh" : "_open"}`),
        okLabel: action === "refresh" ? t("새로 고침") : t("열기"),
      });
      if (!ok) {
        return;
      }
    }
    try {
      await indexAction(conn, action, name);
      host.notify(action === "refresh" ? t("인덱스를 새로 고쳤습니다") : t("인덱스를 열었습니다"));
      setNonce((n) => n + 1);
      onChanged();
    } catch (reason) {
      notifyError(reason, { context: "admin" });
    }
  };

  const removeAlias = async (row: AliasRow) => {
    const actions = [jsonObject([["remove", jsonObject([["index", row.index], ["alias", row.alias]])]])];
    if (needsConfirm("write", host.safeMode)) {
      const ok = await host.confirm({
        title: t("별칭 지우기"),
        message: t("{index}에서 별칭 {alias}를 지웁니다. 인덱스와 문서는 그대로입니다.", { index: row.index, alias: row.alias }),
        command: requestText("POST", "/_aliases", jsonObject([["actions", actions]])),
        okLabel: t("지우기"),
      });
      if (!ok) {
        return;
      }
    }
    try {
      await updateAliases(conn, actions);
      host.notify(t("별칭을 지웠습니다"));
      setNonce((n) => n + 1);
      onChanged();
    } catch (reason) {
      notifyError(reason, { context: "admin" });
    }
  };

  const indexMenu = (row: IndexRow): ContextMenuItem[] => {
    const writable = !readOnly;
    const closed = row.status === "close";
    return [
      { label: t("열기 [탭]"), onSelect: () => onOpen(row.name, "index") },
      { label: t("새 탭에서 열기"), onSelect: () => onOpen(row.name, "index", true) },
      { label: t("새 콘솔 탭"), onSelect: () => onOpenConsole(consoleText(row.name)) },
      { label: t("통계…"), onSelect: () => onAdmin({ kind: "stats", index: row.name }) },
      { label: t("가져오기 (NDJSON·JSON·CSV)…"), separatorBefore: true, disabled: !writable || closed, onSelect: () => onAdmin({ kind: "import", index: row.name }) },
      { label: t("내보내기 (NDJSON·JSON·CSV)…"), disabled: closed, onSelect: () => onAdmin({ kind: "export", index: row.name }) },
      { label: t("새로 고침 (_refresh)"), separatorBefore: true, disabled: !writable || closed, onSelect: () => void runAction("refresh", row.name) },
      closed ? { label: t("인덱스 열기 (_open)"), disabled: !writable, onSelect: () => void runAction("open", row.name) } : { label: t("인덱스 닫기 (_close)…"), disabled: !writable, onSelect: () => onAdmin({ kind: "close", index: row.name }) },
      { label: t("별칭 추가…"), disabled: !writable, onSelect: () => onAdmin({ kind: "alias", index: row.name }) },
      { label: t("재색인 (_reindex)…"), disabled: !writable || closed, onSelect: () => onAdmin({ kind: "reindex", index: row.name }) },
      { label: t("같은 설정·매핑으로 새 인덱스…"), disabled: !writable, onSelect: () => onAdmin({ kind: "clone-mapping", index: row.name }) },
      { label: t("인덱스 삭제…"), separatorBefore: true, danger: true, disabled: cannotDelete, onSelect: () => onAdmin({ kind: "delete", index: row.name }) },
    ];
  };

  const aliasMenu = (name: string, rows: AliasRow[]): ContextMenuItem[] => [
    { label: t("열기 [탭]"), onSelect: () => onOpen(name, "alias") },
    { label: t("새 탭에서 열기"), onSelect: () => onOpen(name, "alias", true) },
    { label: t("새 콘솔 탭"), onSelect: () => onOpenConsole(consoleText(name)) },
    { label: t("내보내기 (NDJSON·JSON·CSV)…"), onSelect: () => onAdmin({ kind: "export", index: name }) },
    ...rows.map((row, i) => ({ label: t("{index}에서 별칭 지우기…", { index: row.index }), separatorBefore: i === 0, danger: true, disabled: readOnly, onSelect: () => void removeAlias(row) })),
  ];

  const streamMenu = (row: DataStreamRow): ContextMenuItem[] => [
    { label: t("열기 [탭]"), onSelect: () => onOpen(row.name, "data_stream") },
    { label: t("새 탭에서 열기"), onSelect: () => onOpen(row.name, "data_stream", true) },
    { label: t("새 콘솔 탭"), onSelect: () => onOpenConsole(consoleText(row.name)) },
    { label: t("가져오기 (NDJSON·JSON·CSV)…"), separatorBefore: true, disabled: readOnly, onSelect: () => onAdmin({ kind: "import", index: row.name }) },
    { label: t("내보내기 (NDJSON·JSON·CSV)…"), onSelect: () => onAdmin({ kind: "export", index: row.name }) },
    { label: t("데이터 스트림 삭제…"), separatorBefore: true, danger: true, disabled: cannotDelete, onSelect: () => onAdmin({ kind: "delete", index: row.name }) },
  ];

  const item = (key: string, name: string, kind: TargetKind, icon: ReactElement, extra: ReactElement | null, title: string, items: () => ContextMenuItem[], dim = false) => {
    const isActive = active !== null && active.index === name && active.kind === kind;
    return (
      <div className="schema-table" key={key}>
        <div
          className={`schema-table-row${isActive ? " active" : ""}${dim ? " es-dim" : ""}`}
          aria-current={isActive ? "true" : undefined}
          role="button"
          tabIndex={0}
          title={title}
          onClick={(event) => onOpen(name, kind, event.metaKey || event.ctrlKey)}
          onAuxClick={(event) => {
            if (event.button === 1) {
              event.preventDefault();
              onOpen(name, kind, true);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onOpen(name, kind, event.metaKey || event.ctrlKey);
            }
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY, items: items() });
          }}
        >
          {icon}
          <span className="schema-table-name">{name}</span>
          {extra}
        </div>
      </div>
    );
  };

  const section = (id: string, label: string, count: number, body: ReactElement[] | ReactElement) => {
    const isOpen = !folded.has(id) || query !== "";
    return (
      <div className="schema-section" key={id}>
        <div
          className="schema-section-head"
          role="button"
          tabIndex={0}
          aria-expanded={isOpen}
          onClick={() => toggle(id)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              toggle(id);
            }
          }}
        >
          <span className={`schema-toggle${isOpen ? " open" : ""}`}>
            <ChevronIcon size={10} />
          </span>
          <span className="schema-section-label">{label}</span>
          <span className="schema-section-count">{count}</span>
        </div>
        {isOpen ? body : null}
      </div>
    );
  };

  let content: ReactElement;
  if (error !== null) {
    content = (
      <div className="schema-error-slot">
        <ErrorNotice error={error} context="general" engine="elasticsearch" variant="compact" onRetry={() => setNonce((n) => n + 1)} />
      </div>
    );
  } else if (shown === null) {
    content = <LoadingState variant="compact" label={t("인덱스를 불러오는 중…")} />;
  } else {
    const empty = (text: string) => <div className="schema-empty">{query === "" ? text : t("검색 결과가 없습니다")}</div>;
    content = (
      <>
        {section(
          "indices",
          t("인덱스"),
          shown.indices.length,
          shown.indices.length === 0
            ? empty(t("인덱스가 없습니다"))
            : shown.indices.map((row) =>
                item(
                  `i:${row.name}`,
                  row.name,
                  "index",
                  <span className={`es-side-dot ${row.health}`} aria-label={row.health} />,
                  <>
                    {row.status === "close" ? <span className="mg-side-badge">{t("닫힘")}</span> : null}
                    {row.hidden || row.name.startsWith(".") ? <span className="mg-side-badge">{t("숨김")}</span> : null}
                    {row.docs !== null ? <span className="schema-section-count mg-side-count">{row.docs.toLocaleString()}</span> : null}
                  </>,
                  [
                    row.name,
                    t("상태 {health} · {status}", { health: row.health, status: row.status }),
                    row.docs !== null ? t("문서 {count}개 · {size}", { count: row.docs.toLocaleString(), size: formatBytes(row.size ?? 0) ?? "—" }) : "",
                    row.aliases.length > 0 ? t("별칭: {names}", { names: row.aliases.join(", ") }) : "",
                    row.data_stream ? t("데이터 스트림: {name}", { name: row.data_stream }) : "",
                  ]
                    .filter((line) => line !== "")
                    .join("\n"),
                  () => indexMenu(row),
                  row.status === "close",
                ),
              ),
        )}
        {section(
          "aliases",
          t("별칭"),
          shown.aliases.length,
          shown.aliases.length === 0
            ? empty(t("별칭이 없습니다"))
            : shown.aliases.map(([name, rows]) =>
                item(
                  `a:${name}`,
                  name,
                  "alias",
                  <LinkIcon size={11} className="schema-table-icon" />,
                  rows.some((row) => row.is_write_index === true) ? <span className="mg-side-badge">{t("쓰기")}</span> : <span className="schema-section-count mg-side-count">{rows.length}</span>,
                  `${name} → ${rows.map((row) => `${row.index}${row.is_write_index ? " (write)" : ""}${row.filter ? " (filter)" : ""}`).join(", ")}`,
                  () => aliasMenu(name, rows),
                ),
              ),
        )}
        {shown.streams.length > 0 || (lists?.streams.length ?? 0) > 0
          ? section(
              "streams",
              t("데이터 스트림"),
              shown.streams.length,
              shown.streams.length === 0
                ? empty(t("데이터 스트림이 없습니다"))
                : shown.streams.map((row) =>
                    item(
                      `d:${row.name}`,
                      row.name,
                      "data_stream",
                      <ListIcon size={11} className="schema-table-icon" />,
                      <span className="schema-section-count mg-side-count">{row.indices.length}</span>,
                      [row.name, t("상태 {health}", { health: row.status.toLowerCase() }), row.template ? t("템플릿: {name}", { name: row.template }) : "", t("뒤에 있는 인덱스 {count}개", { count: row.indices.length })].filter((line) => line !== "").join("\n"),
                      () => streamMenu(row),
                    ),
                  ),
            )
          : null}
      </>
    );
  }

  return (
    <div className="sidebar-pane es-side">
      <div className="schema-search">
        <SearchIcon size={11} className="schema-search-icon" />
        <input value={filter} placeholder={t("인덱스·별칭 검색")} spellCheck={false} onChange={(event) => setFilter(event.target.value)} />
        <button
          type="button"
          className={`icon-button schema-more${showHidden ? " active" : ""}`}
          title={showHidden ? t("숨은 인덱스 감추기") : t("숨은·시스템 인덱스 보기")}
          aria-pressed={showHidden}
          onClick={() => setShowHidden(!showHidden)}
        >
          <EyeIcon size={12} />
        </button>
        <button
          type="button"
          className="icon-button schema-more"
          title={t("더 보기")}
          aria-haspopup="menu"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({
              x: rect.left,
              y: rect.bottom + 4,
              items: [
                { label: t("인덱스 만들기…"), disabled: cannotCreate, onSelect: () => onAdmin({ kind: "create" }) },
                { label: t("파일에서 가져오기…"), disabled: readOnly, onSelect: () => onAdmin({ kind: "import", index: null }) },
                { label: t("새 콘솔 탭"), separatorBefore: true, onSelect: () => onOpenConsole() },
                { label: t("클러스터"), onSelect: onOpenCluster },
                { label: t("보안 (사용자·역할·API 키)"), onSelect: onOpenSecurity },
                { label: t("숨은·시스템 인덱스 보기"), checked: showHidden, separatorBefore: true, onSelect: () => setShowHidden(!showHidden) },
                { label: t("새로 고침"), onSelect: () => setNonce((n) => n + 1) },
              ],
            });
          }}
        >
          {lists === null && error === null ? <Spinner size={11} /> : <MoreIcon size={13} />}
        </button>
      </div>
      <div className="schema-list">{content}</div>
      {menu !== null ? <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}
