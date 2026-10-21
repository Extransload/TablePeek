import { useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from "react";
import type { ConnGroup } from "../connGroups";
import type { ConnMeta } from "../connMeta";
import { t } from "../i18n";
import type { ConnSummary, SavedConnection } from "../store";
import { DriverIcon } from "./DriverIcon";
import { ChevronIcon, CloseIcon, ExternalIcon, FolderIcon, PencilIcon, TrashIcon } from "./icons";
import { Spinner } from "./Spinner";

export type ListTarget =
  | { kind: "saved"; saved: SavedConnection; groupId: string }
  | { kind: "open"; conn: ConnSummary }
  | { kind: "group"; group: ConnGroup };

export type RowAction = "newWindow" | "disconnect" | "edit" | "delete";

interface HomeConnectionListProps {
  // Open connections with no saved profile (the demo, SQLite files, or a
  // profile deleted while open).
  unsaved: ConnSummary[];
  saved: SavedConnection[];
  openBySaved: Map<string, ConnSummary>;
  groups: ConnGroup[];
  metaById: Record<string, ConnMeta>;
  query: string;
  busySaved: string | null;
  deleting: string | null;
  containerRef: RefObject<HTMLDivElement | null>;
  // ↑ on the first row: back to the search box.
  onExitTop(): void;
  onActivateSaved(saved: SavedConnection): void;
  onActivateOpen(conn: ConnSummary): void;
  onToggleGroup(group: ConnGroup): void;
  onRowAction(action: RowAction, target: ListTarget): void;
  // null = empty space in the list.
  onContextMenu(target: ListTarget | null, x: number, y: number): void;
  onMoveToGroup(savedId: string, groupId: string): void;
}

function savedTarget(connection: SavedConnection) {
  return connection.postgres ?? connection.cockroach ?? connection.mysql ?? connection.mssql ?? null;
}

// "host : database", as TablePlus lists connections.
export function savedAddress(connection: SavedConnection): string {
  const db = savedTarget(connection);
  if (db === null) {
    return t("설정 없음");
  }
  return db.database ? `${db.host} : ${db.database}` : db.host;
}

function savedDetail(connection: SavedConnection): string {
  const db = savedTarget(connection);
  if (db === null) {
    return connection.name;
  }
  const ssh = connection.ssh ? ` · SSH ${connection.ssh.user}@${connection.ssh.host}` : "";
  return `${db.user}@${db.host}:${db.port}/${db.database}${ssh}`;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function relativeTime(at: number | undefined): string | null {
  if (at === undefined || at <= 0) {
    return null;
  }
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - at);
  if (seconds < 60) {
    return t("방금 전");
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return t("{count}분 전", { count: minutes });
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return t("{count}시간 전", { count: hours });
  }
  return t("{count}일 전", { count: Math.floor(hours / 24) });
}

export function openName(conn: ConnSummary): string {
  if (conn.demo) {
    return t("데모 데이터베이스");
  }
  // A file's name reads better than its full path; server connections keep their label.
  return conn.kind === "sqlite" && conn.path ? basename(conn.path) : conn.label;
}

export function openAddress(conn: ConnSummary): string {
  return conn.demo ? t("인메모리 데모") : (conn.path ?? conn.label);
}

// Connections a search shows: name, host, database, tags or group name
// containing the query, ignoring case. A matching group shows all of its own.
export function filterConnections(
  saved: SavedConnection[],
  metaById: Record<string, ConnMeta>,
  groups: ConnGroup[],
  query: string,
): Set<string> {
  const needle = query.trim().toLowerCase();
  const groupName = new Map(groups.map((group) => [group.id, group.name.toLowerCase()]));
  const shown = new Set<string>();
  for (const connection of saved) {
    const meta = metaById[connection.id];
    const db = savedTarget(connection);
    const haystack = [
      connection.name,
      db?.host ?? "",
      db?.database ?? "",
      ...(meta?.tags ?? []),
      groupName.get(meta?.group ?? "") ?? "",
    ];
    if (needle === "" || haystack.some((text) => text.toLowerCase().includes(needle))) {
      shown.add(connection.id);
    }
  }
  return shown;
}

export function openMatches(conn: ConnSummary, needle: string): boolean {
  return needle === "" || [openName(conn), openAddress(conn), conn.kind].some((text) => text.toLowerCase().includes(needle));
}

// Tags as pills carrying the connection's color; a color without tags shows as a dot.
export function tagPills(meta: ConnMeta | undefined): ReactNode {
  if (meta === undefined) {
    return null;
  }
  if (meta.tags.length === 0) {
    return meta.color ? (
      <span className="launcher-color-dot" style={{ background: meta.color }} aria-hidden="true" />
    ) : null;
  }
  const style = meta.color ? ({ "--tag-color": meta.color } as CSSProperties) : undefined;
  return meta.tags.map((tag) => (
    <span key={tag} className={`launcher-tag${meta.color ? " colored" : ""}`} style={style}>
      {tag}
    </span>
  ));
}

export function byLastUsed(a: SavedConnection, b: SavedConnection): number {
  return (b.last_used ?? 0) - (a.last_used ?? 0);
}

export function HomeConnectionList({
  unsaved,
  saved,
  openBySaved,
  groups,
  metaById,
  query,
  busySaved,
  deleting,
  containerRef,
  onExitTop,
  onActivateSaved,
  onActivateOpen,
  onToggleGroup,
  onRowAction,
  onContextMenu,
  onMoveToGroup,
}: HomeConnectionListProps) {
  // Saved connection being dragged, and the zone under it: a group id, or ""
  // for "no group".
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropZone, setDropZone] = useState<string | null>(null);
  const needle = query.trim().toLowerCase();
  const searching = needle !== "";
  const shown = filterConnections(saved, metaById, groups, query);
  const groupIds = new Set(groups.map((group) => group.id));
  const visibleOpen = unsaved.filter((conn) => openMatches(conn, needle));
  const ungrouped = saved
    .filter((connection) => !groupIds.has(metaById[connection.id]?.group ?? "") && shown.has(connection.id))
    .sort(byLastUsed);
  const grouped = groups.map((group) => ({
    group,
    members: saved.filter((connection) => metaById[connection.id]?.group === group.id).sort(byLastUsed),
  }));

  function menuAt(event: MouseEvent, target: ListTarget | null): void {
    event.preventDefault();
    event.stopPropagation();
    onContextMenu(target, event.clientX, event.clientY);
  }

  function activateKeys(event: KeyboardEvent, activate: () => void): void {
    if ((event.key === "Enter" || event.key === " ") && event.target === event.currentTarget) {
      event.preventDefault();
      activate();
    }
  }

  // ↑↓ walk the rows and group headers in screen order.
  function onListKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    const items = [...(containerRef.current?.querySelectorAll<HTMLElement>("[data-nav]") ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (index < 0) {
      return;
    }
    event.preventDefault();
    if (event.key === "ArrowUp" && index === 0) {
      onExitTop();
      return;
    }
    items[Math.max(0, Math.min(items.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus();
  }

  function endDrag(): void {
    setDragId(null);
    setDropZone(null);
  }

  // Props that make an element a drop zone for one group ("" = no group).
  function dropZoneProps(zone: string) {
    return {
      onDragOver(event: DragEvent<HTMLElement>) {
        if (dragId === null) {
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        if (dropZone !== zone) {
          setDropZone(zone);
        }
      },
      onDragLeave(event: DragEvent<HTMLElement>) {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setDropZone((current) => (current === zone ? null : current));
        }
      },
      onDrop(event: DragEvent<HTMLElement>) {
        event.preventDefault();
        if (dragId !== null) {
          onMoveToGroup(dragId, zone);
        }
        endDrag();
      },
    };
  }

  function rowActions(target: ListTarget, open: ConnSummary | undefined): ReactNode {
    const button = (action: RowAction, label: string, icon: ReactNode, danger = false) => (
      <button
        type="button"
        className={danger ? "danger" : undefined}
        disabled={action === "delete" && deleting !== null}
        onClick={(event) => {
          event.stopPropagation();
          onRowAction(action, target);
        }}
        title={label}
        aria-label={label}
      >
        {icon}
      </button>
    );
    return (
      <div className="launcher-row-actions">
        {open !== undefined ? button("newWindow", t("새 창에서 열기"), <ExternalIcon size={11} />) : null}
        {open !== undefined && !open.is_default ? button("disconnect", t("연결 끊기"), <CloseIcon size={10} />) : null}
        {target.kind === "saved" ? button("edit", t("연결 편집"), <PencilIcon size={11} />) : null}
        {target.kind === "saved"
          ? button(
              "delete",
              t("저장된 연결 삭제"),
              deleting === target.saved.id ? <Spinner size={10} /> : <TrashIcon size={11} />,
              true,
            )
          : null}
      </div>
    );
  }

  function connectedState(): ReactNode {
    return (
      <span className="launcher-state">
        <span className="launcher-state-dot" aria-hidden="true" />
        {t("연결됨")}
      </span>
    );
  }

  function renderOpen(conn: ConnSummary): ReactNode {
    const target: ListTarget = { kind: "open", conn };
    return (
      <div
        key={`open:${conn.id}`}
        className="launcher-row is-open"
        role="button"
        tabIndex={0}
        data-nav=""
        title={`${openName(conn)} — ${openAddress(conn)}`}
        onClick={() => onActivateOpen(conn)}
        onKeyDown={(event) => activateKeys(event, () => onActivateOpen(conn))}
        onContextMenu={(event) => menuAt(event, target)}
      >
        <DriverIcon kind={conn.kind} size={34} className="launcher-logo" />
        <div className="launcher-row-body">
          <div className="launcher-row-title">
            <span className="launcher-row-name">{openName(conn)}</span>
          </div>
          <div className="launcher-row-sub">
            <span className="launcher-row-address">{openAddress(conn)}</span>
          </div>
        </div>
        <div className="launcher-row-side">
          {rowActions(target, conn)}
          {connectedState()}
        </div>
      </div>
    );
  }

  function renderSaved(connection: SavedConnection, groupId: string): ReactNode {
    const open = openBySaved.get(connection.id);
    const target: ListTarget = { kind: "saved", saved: connection, groupId };
    const activate = () => onActivateSaved(connection);
    const recent = relativeTime(connection.last_used);
    return (
      <div
        key={`saved:${connection.id}`}
        className={`launcher-row${open !== undefined ? " is-open" : ""}${groupId !== "" ? " in-group" : ""}`}
        role="button"
        tabIndex={0}
        data-nav=""
        data-saved-id={connection.id}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData("text/plain", connection.id);
          event.dataTransfer.effectAllowed = "move";
          setDragId(connection.id);
        }}
        onDragEnd={endDrag}
        title={`${connection.name} — ${savedDetail(connection)}`}
        onClick={activate}
        onKeyDown={(event) => activateKeys(event, activate)}
        onContextMenu={(event) => menuAt(event, target)}
      >
        <DriverIcon kind={connection.driver} size={34} className="launcher-logo" />
        <div className="launcher-row-body">
          <div className="launcher-row-title">
            <span className="launcher-row-name">{connection.name}</span>
            {tagPills(metaById[connection.id])}
          </div>
          <div className="launcher-row-sub">
            <span className="launcher-row-address">{savedAddress(connection)}</span>
            {connection.ssh ? <span className="launcher-ssh">SSH</span> : null}
          </div>
        </div>
        <div className="launcher-row-side">
          {rowActions(target, open)}
          {busySaved === connection.id ? (
            <span className="launcher-state idle">
              <Spinner size={10} />
              {t("연결 중…")}
            </span>
          ) : open !== undefined ? (
            connectedState()
          ) : recent !== null ? (
            <span className="launcher-state idle">{recent}</span>
          ) : null}
        </div>
      </div>
    );
  }

  const groupSections = grouped
    .map(({ group, members }) => {
      const visible = members.filter((connection) => shown.has(connection.id));
      // While searching, groups without a hit drop out and the rest open up.
      if (searching && visible.length === 0) {
        return null;
      }
      const expanded = searching || !group.collapsed;
      const target: ListTarget = { kind: "group", group };
      return (
        <div
          className={`launcher-group${dropZone === group.id ? " drop-target" : ""}`}
          key={`group:${group.id}`}
          data-group-id={group.id}
          {...dropZoneProps(group.id)}
        >
          <div
            className="launcher-group-head"
            role="button"
            tabIndex={0}
            data-nav=""
            aria-expanded={expanded}
            onClick={() => onToggleGroup(group)}
            onKeyDown={(event) => activateKeys(event, () => onToggleGroup(group))}
            onContextMenu={(event) => menuAt(event, target)}
          >
            <span className={`launcher-chevron${expanded ? " open" : ""}`} aria-hidden="true">
              <ChevronIcon size={9} />
            </span>
            <span className="launcher-group-icon" style={{ "--group-color": group.color } as CSSProperties}>
              <FolderIcon size={9} />
            </span>
            <span className="launcher-group-name">{group.name}</span>
            {!expanded || members.length === 0 ? (
              <span className="launcher-group-count">{members.length}</span>
            ) : null}
          </div>
          {expanded ? visible.map((connection) => renderSaved(connection, group.id)) : null}
        </div>
      );
    })
    .filter((section) => section !== null);

  const nothing =
    visibleOpen.length === 0 && ungrouped.length === 0 && groupSections.length === 0;

  return (
    <div
      className="launcher-list"
      ref={containerRef}
      onKeyDown={onListKeyDown}
      onContextMenu={(event) => menuAt(event, null)}
    >
      {nothing && searching ? <div className="launcher-empty">{t("검색 결과가 없습니다")}</div> : null}
      {visibleOpen.length > 0 || ungrouped.length > 0 || dragId !== null ? (
        <div
          className={`launcher-ungrouped${dropZone === "" ? " drop-target" : ""}`}
          data-group-id=""
          {...dropZoneProps("")}
        >
          {visibleOpen.map(renderOpen)}
          {ungrouped.map((connection) => renderSaved(connection, ""))}
          {dragId !== null && ungrouped.length === 0 ? (
            <div className="launcher-drop-hint">{t("여기에 놓으면 그룹에서 빠집니다")}</div>
          ) : null}
        </div>
      ) : null}
      {groupSections}
    </div>
  );
}
