import { useCallback, useEffect, useRef, useState } from "react";
import {
  createGroup,
  deleteGroup,
  findGroupByName,
  GROUP_COLORS,
  isGroupNameTaken,
  listGroups,
  subscribeGroups,
  updateGroup,
  type ConnGroup,
} from "../connGroups";
import { listConnMeta, setConnGroup, setConnMeta, subscribeConnMeta } from "../connMeta";
import {
  CONNECTIONS_FILE_ACCEPT,
  CONNECTIONS_FILE_NAME,
  MAX_IMPORT_BYTES,
  downloadText,
  exportRequest,
  importErrorText,
} from "../connectionsFile";
import { t } from "../i18n";
import { inputFromSaved } from "../savedInput";
import { ApiRequestError, store, type ConnSummary, type Driver, type SavedConnection } from "../store";
import { BrandMark } from "./BrandLogo";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { ErrorNotice } from "./ErrorNotice";
import { ExportConnectionsModal } from "./ExportConnectionsModal";
import { HomeConnectionList, type ListTarget, type RowAction } from "./HomeConnectionList";
import { HomeWelcome } from "./HomeWelcome";
import { CloseIcon, DownloadIcon, PlusIcon, SearchIcon, UploadIcon } from "./icons";
import { PromptModal } from "./PromptModal";
import { Spinner } from "./Spinner";

// Names for GROUP_COLORS, in the same order.
const COLOR_NAMES = ["주황", "파랑", "초록", "보라", "빨강", "청록", "분홍", "회색"];


type Prompt =
  | { kind: "newGroup" }
  | { kind: "rename"; group: ConnGroup }
  | { kind: "url"; group: string }
  | { kind: "filePassword"; file: string; fileName: string };

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

export interface NewConnectionOptions {
  driver?: Driver;
  // Group id the new connection goes into.
  group?: string;
  // Connection URL to fill the dialog from.
  url?: string;
}

interface HomeScreenProps {
  conns: ConnSummary[];
  busySaved: string | null;
  onOpenConn(id: string): void;
  onOpenNewWindow(id: string): void;
  onCloseConn(id: string): void;
  onOpenFile(): void;
  onNewConnection(options?: NewConnectionOptions): void;
  onConnectSaved(id: string): void;
  onEditConnection(connection: SavedConnection): void;
  onBackupOrRestore(kind: "backup" | "restore"): void;
  // Bumped when the connection dialog saved a profile, so the list reloads.
  savedVersion: number;
  // The app's latest error, shown here instead of in a corner toast.
  appError: string | null;
  onDismissAppError(): void;
}

export function HomeScreen({
  conns,
  busySaved,
  onOpenConn,
  onOpenNewWindow,
  onCloseConn,
  onOpenFile,
  onNewConnection,
  onConnectSaved,
  onEditConnection,
  onBackupOrRestore,
  savedVersion,
  appError,
  onDismissAppError,
}: HomeScreenProps) {
  const [saved, setSaved] = useState<SavedConnection[] | null>(null);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [plusMenu, setPlusMenu] = useState<{ x: number; y: number; anchor: Element } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; target: ListTarget | null } | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  // Connections (and groups) chosen for an export, waiting for the file password.
  const [exporting, setExporting] = useState<{ title: string; ids: string[]; groups: ConnGroup[] } | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [version, setVersion] = useState(0);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const loadSaved = useCallback(async (): Promise<void> => {
    try {
      const connections = await store.listConnections();
      setSaved(connections);
      setSavedError(null);
    } catch (err) {
      setSavedError(err instanceof Error && err.message ? err.message : t("저장된 연결을 불러오지 못했습니다"));
    }
  }, []);

  useEffect(() => {
    void loadSaved();
  }, [loadSaved, savedVersion]);

  useEffect(() => {
    const bump = () => setVersion((value) => value + 1);
    const offMeta = subscribeConnMeta(bump);
    const offGroups = subscribeGroups(bump);
    return () => {
      offMeta();
      offGroups();
    };
  }, []);

  async function deleteSaved(connection: SavedConnection): Promise<void> {
    if (
      !window.confirm(
        t("{name} 연결을 삭제할까요? 열려 있는 세션은 유지됩니다.", {
          name: connection.name,
        }),
      )
    ) {
      return;
    }
    setDeleting(connection.id);
    setSavedError(null);
    try {
      await store.deleteConnection(connection.id);
      setConnMeta(connection.id, { group: "", color: "", tags: [] });
      setSaved((current) =>
        current === null ? current : current.filter((item) => item.id !== connection.id),
      );
    } catch (err) {
      setSavedError(
        err instanceof Error && err.message ? err.message : t("저장된 연결을 삭제하지 못했습니다"),
      );
    } finally {
      setDeleting(null);
    }
  }

  void version;
  const groups = listGroups();
  const metaById = listConnMeta();
  const failed = savedError !== null;
  const savedIds = new Set((saved ?? []).map((connection) => connection.id));
  const openBySaved = new Map<string, ConnSummary>();
  for (const conn of conns) {
    if (conn.saved_id !== undefined && savedIds.has(conn.saved_id)) {
      openBySaved.set(conn.saved_id, conn);
    }
  }
  // Open without a profile: files, the demo, and profiles deleted (or failing
  // to load) while their connection is still open.
  const listKnown = saved !== null || failed;
  const unsaved = conns.filter(
    (conn) => conn.saved_id === undefined || (listKnown && !savedIds.has(conn.saved_id)),
  );
  const empty = saved !== null && saved.length === 0 && unsaved.length === 0 && groups.length === 0;

  function activateSaved(connection: SavedConnection): void {
    const open = openBySaved.get(connection.id);
    if (open !== undefined) {
      onOpenConn(open.id);
    } else if (busySaved === null) {
      onConnectSaved(connection.id);
    }
  }

  function rowAction(action: RowAction, target: ListTarget): void {
    const open =
      target.kind === "open" ? target.conn : target.kind === "saved" ? openBySaved.get(target.saved.id) : undefined;
    if (action === "newWindow" && open !== undefined) {
      onOpenNewWindow(open.id);
    } else if (action === "disconnect" && open !== undefined) {
      onCloseConn(open.id);
    } else if (action === "edit" && target.kind === "saved") {
      onEditConnection(target.saved);
    } else if (action === "delete" && target.kind === "saved") {
      void deleteSaved(target.saved);
    }
  }

  function moveToGroup(savedId: string, groupId: string): void {
    // Dropping a connection where it already is changes nothing.
    if ((metaById[savedId]?.group ?? "") !== groupId) {
      setConnGroup(savedId, groupId);
    }
  }

  function removeGroup(group: ConnGroup): void {
    if (
      window.confirm(
        t("‘{name}’ 그룹을 삭제할까요? 안의 연결은 그룹 밖으로 옮겨집니다.", { name: group.name }),
      )
    ) {
      deleteGroup(group.id);
    }
  }

  async function duplicate(connection: SavedConnection): Promise<void> {
    setNotice(null);
    try {
      const id = await store.createConnection(t("{name} 복사본", { name: connection.name }), inputFromSaved(connection));
      const meta = metaById[connection.id];
      if (meta !== undefined) {
        setConnMeta(id, { ...meta });
      }
      await loadSaved();
    } catch (err) {
      setNotice({ kind: "error", text: errorText(err, t("연결을 복제하지 못했습니다")) });
    }
  }

  function exportScope(title: string, connections: SavedConnection[], scopeGroups: ConnGroup[]): void {
    setNotice(null);
    setExporting({ title, ids: connections.map((connection) => connection.id), groups: scopeGroups });
  }

  async function runExport(passphrase: string): Promise<string | null> {
    if (exporting === null) {
      return null;
    }
    try {
      const result = await store.exportConnections(exportRequest(exporting.ids, metaById, exporting.groups, passphrase));
      downloadText(CONNECTIONS_FILE_NAME, result.file);
      setNotice({ kind: "ok", text: t("연결 {count}개를 내보냈습니다", { count: result.count }) });
      return null;
    } catch (err) {
      return t(errorText(err, t("내보내지 못했습니다")));
    }
  }

  async function pickImportFile(file: File): Promise<void> {
    setNotice(null);
    if (file.size > MAX_IMPORT_BYTES) {
      setNotice({ kind: "error", text: t("연결 파일이 너무 큽니다") });
      return;
    }
    try {
      setPrompt({ kind: "filePassword", file: await file.text(), fileName: file.name });
    } catch (err) {
      setNotice({ kind: "error", text: errorText(err, t("파일을 읽지 못했습니다")) });
    }
  }

  // The server opens the file and saves every connection or none; groups,
  // colors and tags (kept here) are applied after it succeeds.
  async function runImport(file: string, passphrase: string): Promise<string | null> {
    let result;
    try {
      result = await store.importConnections(file, passphrase, t("가져옴"));
    } catch (err) {
      return importErrorText(
        err instanceof ApiRequestError ? err.code : null,
        errorText(err, t("연결을 가져오지 못했습니다")),
      );
    }
    const groupIdFor = (name: string, color?: string): string =>
      name === "" ? "" : (findGroupByName(name) ?? createGroup(name, color)).id;
    for (const group of result.groups) {
      groupIdFor(group.name, group.color || undefined);
    }
    for (const connection of result.connections) {
      setConnMeta(connection.id, {
        group: groupIdFor(connection.group),
        color: connection.color,
        tags: connection.tags,
      });
    }
    await loadSaved();
    setNotice({ kind: "ok", text: t("연결 {count}개를 가져왔습니다", { count: result.connections.length }) });
    return null;
  }

  function importItems(groupId: string): ContextMenuItem[] {
    return [
      { label: t("URL에서…"), onSelect: () => setPrompt({ kind: "url", group: groupId }) },
      { label: t("파일에서…"), onSelect: () => fileRef.current?.click() },
    ];
  }

  // "New ›": a connection made inside a group goes into that group.
  function newSubmenu(groupId: string): ContextMenuItem {
    return {
      label: t("새로 만들기"),
      submenu: [
        { label: t("그룹…"), onSelect: () => setPrompt({ kind: "newGroup" }) },
        { label: t("연결…"), onSelect: () => onNewConnection(groupId === "" ? undefined : { group: groupId }) },
        { label: t("연결 가져오기"), submenu: importItems(groupId) },
      ],
    };
  }

  function exportSubmenu(group: ConnGroup | null, connection: SavedConnection | null): ContextMenuItem {
    const all = saved ?? [];
    const items: ContextMenuItem[] = [
      {
        label: t("전체 내보내기…"),
        disabled: all.length === 0 && groups.length === 0,
        onSelect: () => exportScope(t("전체 내보내기"), all, groups),
      },
    ];
    if (group !== null) {
      items.push({
        label: t("이 그룹 내보내기…"),
        separatorBefore: true,
        onSelect: () =>
          exportScope(
            t("‘{name}’ 그룹 내보내기", { name: group.name }),
            all.filter((item) => metaById[item.id]?.group === group.id),
            [group],
          ),
      });
    }
    if (connection !== null) {
      const own = groups.find((item) => item.id === metaById[connection.id]?.group);
      items.push({
        label: t("이 연결 내보내기…"),
        separatorBefore: group === null,
        onSelect: () =>
          exportScope(t("‘{name}’ 내보내기", { name: connection.name }), [connection], own === undefined ? [] : [own]),
      });
    }
    return { label: t("내보내기"), submenu: items };
  }

  function menuItems(target: ListTarget | null): ContextMenuItem[] {
    if (target === null) {
      return [newSubmenu(""), exportSubmenu(null, null)];
    }
    if (target.kind === "group") {
      const group = target.group;
      return [
        { label: t("이름 바꾸기…"), onSelect: () => setPrompt({ kind: "rename", group }) },
        {
          label: t("색 바꾸기"),
          submenu: GROUP_COLORS.map((color, index) => ({
            label: t(COLOR_NAMES[index]),
            checked: group.color === color,
            onSelect: () => updateGroup(group.id, { color }),
          })),
        },
        { label: t("그룹 삭제"), danger: true, onSelect: () => removeGroup(group) },
        { ...newSubmenu(group.id), separatorBefore: true },
        exportSubmenu(group, null),
      ];
    }
    if (target.kind === "open") {
      const conn = target.conn;
      return [
        { label: t("열기"), onSelect: () => onOpenConn(conn.id) },
        { label: t("새 창에서 열기"), onSelect: () => onOpenNewWindow(conn.id) },
        ...(conn.is_default ? [] : [{ label: t("연결 끊기"), onSelect: () => onCloseConn(conn.id) }]),
        { ...newSubmenu(""), separatorBefore: true },
        exportSubmenu(null, null),
      ];
    }
    const connection = target.saved;
    const open = openBySaved.get(connection.id);
    const group = groups.find((item) => item.id === target.groupId) ?? null;
    return [
      { label: t("열기"), onSelect: () => activateSaved(connection) },
      ...(open !== undefined ? [{ label: t("새 창에서 열기"), onSelect: () => onOpenNewWindow(open.id) }] : []),
      { label: t("편집…"), onSelect: () => onEditConnection(connection) },
      { label: t("복제"), onSelect: () => void duplicate(connection) },
      {
        label: t("그룹으로 이동"),
        submenu: [
          ...groups.map((item) => ({
            label: item.name,
            checked: item.id === target.groupId,
            onSelect: () => moveToGroup(connection.id, item.id),
          })),
          {
            label: t("그룹 없음"),
            checked: target.groupId === "",
            separatorBefore: groups.length > 0,
            onSelect: () => moveToGroup(connection.id, ""),
          },
        ],
      },
      { ...newSubmenu(target.groupId), separatorBefore: true },
      exportSubmenu(group, connection),
      { label: t("삭제"), danger: true, separatorBefore: true, onSelect: () => void deleteSaved(connection) },
    ];
  }

  function plusItems(): ContextMenuItem[] {
    return [
      { label: t("새 연결…"), onSelect: () => onNewConnection() },
      { label: t("새 그룹…"), onSelect: () => setPrompt({ kind: "newGroup" }) },
      { label: t("SQLite 파일 열기…"), onSelect: onOpenFile },
      { label: t("연결 가져오기"), separatorBefore: true, submenu: importItems("") },
    ];
  }

  let listArea;
  if (saved === null && !failed) {
    listArea = (
      <div className="launcher-loading">
        <Spinner size={12} />
        <span>{t("불러오는 중…")}</span>
      </div>
    );
  } else if (empty && !failed) {
    listArea = (
      <HomeWelcome
        onNewConnection={onNewConnection}
        onOpenFile={onOpenFile}
        onImportFile={() => fileRef.current?.click()}
      />
    );
  } else {
    listArea = (
      <HomeConnectionList
        unsaved={unsaved}
        saved={saved ?? []}
        openBySaved={openBySaved}
        groups={groups}
        metaById={metaById}
        query={query}
        busySaved={busySaved}
        deleting={deleting}
        containerRef={listRef}
        onExitTop={() => searchRef.current?.focus()}
        onActivateSaved={activateSaved}
        onActivateOpen={(conn) => onOpenConn(conn.id)}
        onToggleGroup={(group) => updateGroup(group.id, { collapsed: !group.collapsed })}
        onRowAction={rowAction}
        onContextMenu={(target, x, y) => setMenu({ x, y, target })}
        onMoveToGroup={moveToGroup}
      />
    );
  }

  return (
    <div className="home">
      {appError !== null && appError !== savedError ? (
        <div className="home-notice">
          <ErrorNotice message={appError} onClose={onDismissAppError} />
        </div>
      ) : null}
      <div className="launcher">
        <aside className="launcher-side">
          <BrandMark size={64} className="launcher-mark" />
          <div className="launcher-word" aria-hidden="true">
            Table<span className="brand-word-peek">Peek</span>
          </div>
          <div className="launcher-tagline">{t("로컬 DB 클라이언트")}</div>
          <div className="launcher-actions">
            <button type="button" className="launcher-action" onClick={() => onNewConnection()}>
              <span className="launcher-action-icon" aria-hidden="true">
                <PlusIcon size={11} />
              </span>
              {t("새 연결 만들기…")}
            </button>
            <button type="button" className="launcher-action" onClick={() => onBackupOrRestore("backup")}>
              <span className="launcher-action-icon" aria-hidden="true">
                <DownloadIcon size={11} />
              </span>
              {t("데이터베이스 백업…")}
            </button>
            <button type="button" className="launcher-action" onClick={() => onBackupOrRestore("restore")}>
              <span className="launcher-action-icon" aria-hidden="true">
                <UploadIcon size={11} />
              </span>
              {t("데이터베이스 복원…")}
            </button>
          </div>
        </aside>
        <section className="launcher-main">
          <div className="launcher-top">
            <button
              type="button"
              className={`launcher-plus${plusMenu !== null ? " active" : ""}`}
              title={t("새로 만들기")}
              aria-label={t("새로 만들기")}
              onClick={(event) => {
                const anchor = event.currentTarget;
                const rect = anchor.getBoundingClientRect();
                setPlusMenu(plusMenu !== null ? null : { x: rect.left, y: rect.bottom + 4, anchor });
              }}
            >
              <PlusIcon size={11} />
            </button>
            <label className="launcher-search">
              <SearchIcon size={10} className="launcher-search-icon" />
              <input
                ref={searchRef}
                value={query}
                placeholder={t("연결 검색 (이름·호스트·태그)")}
                spellCheck={false}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    const first = listRef.current?.querySelector<HTMLElement>("[data-nav]");
                    if (first) {
                      event.preventDefault();
                      first.focus();
                    }
                  } else if (event.key === "Escape" && query !== "") {
                    event.stopPropagation();
                    setQuery("");
                  }
                }}
              />
            </label>
          </div>
          {notice !== null ? (
            <div className="launcher-notice">
              {notice.kind === "error" ? (
                <ErrorNotice message={notice.text} variant="compact" onClose={() => setNotice(null)} />
              ) : (
                <div className="launcher-notice-ok" role="status">
                  <span>{notice.text}</span>
                  <button type="button" className="icon-button" onClick={() => setNotice(null)} title={t("닫기")}>
                    <CloseIcon size={9} />
                  </button>
                </div>
              )}
            </div>
          ) : null}
          {failed ? (
            <div className="launcher-load-error">
              <ErrorNotice message={savedError} variant="compact" />
              <button type="button" onClick={() => void loadSaved()}>
                {t("다시 시도")}
              </button>
            </div>
          ) : null}
          {listArea}
        </section>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept={CONNECTIONS_FILE_ACCEPT}
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file !== undefined) {
            void pickImportFile(file);
          }
        }}
      />
      {exporting !== null ? (
        <ExportConnectionsModal
          title={exporting.title}
          count={exporting.ids.length}
          onExport={runExport}
          onClose={() => setExporting(null)}
        />
      ) : null}
      {menu !== null ? (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.target)} onClose={() => setMenu(null)} />
      ) : null}
      {prompt?.kind === "newGroup" ? (
        <PromptModal
          title={t("새 그룹")}
          label={t("그룹 이름")}
          confirmLabel={t("만들기")}
          validate={(name) => (isGroupNameTaken(name) ? t("같은 이름의 그룹이 이미 있습니다") : null)}
          onSubmit={(name) => {
            createGroup(name);
          }}
          onClose={() => setPrompt(null)}
        />
      ) : prompt?.kind === "rename" ? (
        <PromptModal
          title={t("그룹 이름 바꾸기")}
          label={t("그룹 이름")}
          initial={prompt.group.name}
          confirmLabel={t("바꾸기")}
          validate={(name) => (isGroupNameTaken(name, prompt.group.id) ? t("같은 이름의 그룹이 이미 있습니다") : null)}
          onSubmit={(name) => updateGroup(prompt.group.id, { name })}
          onClose={() => setPrompt(null)}
        />
      ) : prompt?.kind === "filePassword" ? (
        <PromptModal
          title={t("연결 가져오기")}
          label={t("‘{name}’의 파일 암호", { name: prompt.fileName })}
          confirmLabel={t("가져오기")}
          secret
          onSubmit={(passphrase) => runImport(prompt.file, passphrase)}
          onClose={() => setPrompt(null)}
        />
      ) : prompt?.kind === "url" ? (
        <PromptModal
          title={t("URL에서 연결 가져오기")}
          label={t("연결 URL")}
          placeholder="postgres://user@host:5432/database"
          confirmLabel={t("열기")}
          onSubmit={(url) => onNewConnection({ url, group: prompt.group === "" ? undefined : prompt.group })}
          onClose={() => setPrompt(null)}
        />
      ) : null}
      {plusMenu !== null ? (
        <ContextMenu
          x={plusMenu.x}
          y={plusMenu.y}
          anchor={plusMenu.anchor}
          items={plusItems()}
          onClose={() => setPlusMenu(null)}
        />
      ) : null}
    </div>
  );
}
