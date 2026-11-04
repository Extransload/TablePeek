import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from "react";
import type { ConnGroup } from "../connGroups";
import { orderConnections, type ConnMeta } from "../connMeta";
import { t } from "../i18n";
import { engineById, unsupportedEngine } from "../engines";
import { basename, fillTemplate, templateValues } from "../engines/connection";
import type { ConnSummary, SavedConnection } from "../store";
import { DriverIcon } from "./DriverIcon";
import { ChevronIcon, CloseIcon, ExternalIcon, FolderIcon } from "./icons";
import { Spinner } from "./Spinner";

export type ListTarget =
  | { kind: "saved"; saved: SavedConnection; groupId: string }
  | { kind: "open"; conn: ConnSummary }
  | { kind: "group"; group: ConnGroup };

// Buttons an open row shows on hover; editing and deleting live in the context menu.
export type RowAction = "newWindow" | "disconnect";

// Where a dragged connection or group lands: just before or after another.
interface Spot {
  id: string;
  after: boolean;
}

// Where a dragged connection lands: in a group ("" for none), next to one of
// its connections, or (null) in one that shows none.
interface RowSpot {
  groupId: string;
  id: string | null;
  after: boolean;
}

function sameSpot(a: Spot | RowSpot | null, b: Spot | RowSpot | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.id === b.id && a.after === b.after && ("groupId" in a ? a.groupId : "") === ("groupId" in b ? b.groupId : "");
}

// The slot a pointer at `y` falls in among `elements`, top to bottom: before
// the first whose middle is below it, else after the last.
function slotAt(elements: HTMLElement[], y: number): number {
  const slot = elements.findIndex((element) => {
    const box = element.getBoundingClientRect();
    return y < box.top + box.height / 2;
  });
  return slot < 0 ? elements.length : slot;
}

// The spot that slot marks among `ids`; null when it leaves `self` where it is.
function spotAt(ids: string[], slot: number, self: string | null): Spot | null {
  if (ids.length === 0 || ids[slot] === self || ids[slot - 1] === self) {
    return null;
  }
  return slot < ids.length ? { id: ids[slot], after: false } : { id: ids[slot - 1], after: true };
}

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
  containerRef: RefObject<HTMLDivElement | null>;
  // ↑ on the first row: back to the search box.
  onExitTop(): void;
  onActivateSaved(saved: SavedConnection): void;
  onActivateOpen(conn: ConnSummary): void;
  onToggleGroup(group: ConnGroup): void;
  onRowAction(action: RowAction, target: ListTarget): void;
  // null = empty space in the list.
  onContextMenu(target: ListTarget | null, x: number, y: number): void;
  // A connection dropped into a group ("" for none), just before or after
  // another there (null: none to go by).
  onMoveConnection(savedId: string, groupId: string, targetId: string | null, after: boolean): void;
  // A group dropped just before or after another.
  onMoveGroup(groupId: string, targetId: string, after: boolean): void;
}

// The profile's address line as its engine words it ("host : database", a
// SQLite profile's file path); an engine this page doesn't know says so.
export function savedAddress(connection: SavedConnection): string {
  const engine = engineById(connection.driver);
  if (engine === undefined) {
    return unsupportedEngine(connection.driver);
  }
  return fillTemplate(engine.connection.summary, connection.config) || t("설정 없음");
}

function savedDetail(connection: SavedConnection): string {
  const engine = engineById(connection.driver);
  if (engine === undefined) {
    return unsupportedEngine(connection.driver);
  }
  const ssh = connection.ssh ? ` · SSH ${connection.ssh.user}@${connection.ssh.host}` : "";
  return `${fillTemplate(engine.connection.detail, connection.config) || connection.name}${ssh}`;
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
  return engineById(conn.kind)?.transport === "file" && conn.path ? basename(conn.path) : conn.label;
}

export function openAddress(conn: ConnSummary): string {
  return conn.demo ? t("인메모리 데모") : (conn.path ?? conn.label);
}

// Connections a search shows: name, the parts of its address line (host and
// database, a SQLite file's path), tags or group name containing the query,
// ignoring case. A matching group shows all of its own.
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
    const summary = engineById(connection.driver)?.connection.summary ?? "";
    const haystack = [
      connection.name,
      ...templateValues(summary, connection.config),
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

export function HomeConnectionList({
  unsaved,
  saved,
  openBySaved,
  groups,
  metaById,
  query,
  busySaved,
  containerRef,
  onExitTop,
  onActivateSaved,
  onActivateOpen,
  onToggleGroup,
  onRowAction,
  onContextMenu,
  onMoveConnection,
  onMoveGroup,
}: HomeConnectionListProps) {
  // Saved connection being dragged, and where it would land.
  const [dragId, setDragId] = useState<string | null>(null);
  const [rowSpot, setRowSpot] = useState<RowSpot | null>(null);
  // Group being dragged to a new place, and where it would land.
  const [dragGroupId, setDragGroupId] = useState<string | null>(null);
  const [groupSpot, setGroupSpot] = useState<Spot | null>(null);
  // The row or group header ⌥↑↓ just moved, focused again once it's re-rendered.
  const refocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (refocus.current !== null) {
      containerRef.current?.querySelector<HTMLElement>(refocus.current)?.focus();
      refocus.current = null;
    }
  });
  const needle = query.trim().toLowerCase();
  const searching = needle !== "";
  // Groups folded during the current search only; the saved state returns when it clears.
  const [searchFolded, setSearchFolded] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!searching) {
      setSearchFolded(new Set());
    }
  }, [searching]);
  const shown = filterConnections(saved, metaById, groups, query);
  const groupIds = new Set(groups.map((group) => group.id));
  const visibleOpen = unsaved.filter((conn) => openMatches(conn, needle));
  const ordered = orderConnections(saved);
  const allUngrouped = ordered.filter((connection) => !groupIds.has(metaById[connection.id]?.group ?? ""));
  const ungrouped = allUngrouped.filter((connection) => shown.has(connection.id));
  const grouped = groups.map((group) => ({
    group,
    members: ordered.filter((connection) => metaById[connection.id]?.group === group.id),
  }));

  function toggleGroup(group: ConnGroup): void {
    if (!searching) {
      onToggleGroup(group);
      return;
    }
    setSearchFolded((current) => {
      const next = new Set(current);
      if (!next.delete(group.id)) {
        next.add(group.id);
      }
      return next;
    });
  }

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

  // ↑↓ walk the rows and group headers in screen order; ⌥↑↓ move the
  // connection (within its group) or group under focus one place.
  function onListKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    if (event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
      event.preventDefault();
      moveFocused(event.key === "ArrowUp");
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

  function moveFocused(up: boolean): void {
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement) || !focused.hasAttribute("data-nav")) {
      return;
    }
    const savedId = focused.dataset.savedId;
    const zone = focused.closest<HTMLElement>("[data-group-id]");
    if (savedId !== undefined && zone !== null) {
      const rows = [...zone.querySelectorAll<HTMLElement>("[data-saved-id]")];
      const other = rows[rows.indexOf(focused) + (up ? -1 : 1)]?.dataset.savedId;
      if (other !== undefined) {
        refocus.current = `[data-saved-id="${CSS.escape(savedId)}"]`;
        onMoveConnection(savedId, zone.dataset.groupId ?? "", other, !up);
      }
      return;
    }
    const groupId = zone?.dataset.groupId;
    if (groupId !== undefined && zone?.classList.contains("launcher-group")) {
      const sections = [...(containerRef.current?.querySelectorAll<HTMLElement>(".launcher-group[data-group-id]") ?? [])];
      const other = sections[sections.indexOf(zone) + (up ? -1 : 1)]?.dataset.groupId;
      if (other !== undefined) {
        refocus.current = `.launcher-group[data-group-id="${CSS.escape(groupId)}"] > .launcher-group-head`;
        onMoveGroup(groupId, other, !up);
      }
    }
  }

  function endDrag(): void {
    setDragId(null);
    setRowSpot(null);
    setDragGroupId(null);
    setGroupSpot(null);
  }

  // Where a dragged group lands: by the pointer's height against the groups'
  // middles, so above the first one (over the connections outside any
  // group too) is the top and below the last one the bottom.
  function groupSpotAt(y: number): Spot | null {
    const sections = [...(containerRef.current?.querySelectorAll<HTMLElement>(".launcher-group[data-group-id]") ?? [])];
    return spotAt(
      sections.map((section) => section.dataset.groupId ?? ""),
      slotAt(sections, y),
      dragGroupId,
    );
  }

  // Where a dragged connection lands: in the group (or the place for none)
  // under the pointer, the next one down in a gap, the last one below them
  // all; there, by the pointer's height against its rows' middles. A group
  // showing none of its rows (folded, or empty) takes it on top.
  function rowSpotAt(y: number): RowSpot | null {
    const zones = [...(containerRef.current?.querySelectorAll<HTMLElement>("[data-group-id]") ?? [])];
    const zone = zones.find((element) => y < element.getBoundingClientRect().bottom) ?? zones.at(-1);
    if (zone === undefined) {
      return null;
    }
    const groupId = zone.dataset.groupId ?? "";
    const rows = [...zone.querySelectorAll<HTMLElement>("[data-saved-id]")];
    if (rows.length === 0) {
      const members = groupId === "" ? allUngrouped : (grouped.find((entry) => entry.group.id === groupId)?.members ?? []);
      const first = members.find((connection) => connection.id !== dragId);
      return { groupId, id: first?.id ?? null, after: false };
    }
    const spot = spotAt(
      rows.map((row) => row.dataset.savedId ?? ""),
      slotAt(rows, y),
      dragId,
    );
    return spot === null ? null : { groupId, ...spot };
  }

  const dropHandlers = {
    onDragOver(event: DragEvent<HTMLElement>) {
      if (dragGroupId === null && dragId === null) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (dragGroupId !== null) {
        const spot = groupSpotAt(event.clientY);
        if (!sameSpot(spot, groupSpot)) {
          setGroupSpot(spot);
        }
      } else {
        const spot = rowSpotAt(event.clientY);
        if (!sameSpot(spot, rowSpot)) {
          setRowSpot(spot);
        }
      }
    },
    onDragLeave(event: DragEvent<HTMLElement>) {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
        setRowSpot(null);
        setGroupSpot(null);
      }
    },
    onDrop(event: DragEvent<HTMLElement>) {
      event.preventDefault();
      if (dragGroupId !== null) {
        const spot = groupSpotAt(event.clientY);
        if (spot !== null) {
          onMoveGroup(dragGroupId, spot.id, spot.after);
        }
      } else if (dragId !== null) {
        const spot = rowSpotAt(event.clientY);
        if (spot !== null) {
          onMoveConnection(dragId, spot.groupId, spot.id, spot.after);
        }
      }
      endDrag();
    },
  };

  // Open connections only: a saved one that isn't open keeps its state on hover.
  function rowActions(target: ListTarget, open: ConnSummary | undefined): ReactNode {
    if (open === undefined) {
      return null;
    }
    const button = (action: RowAction, label: string, icon: ReactNode) => (
      <button
        type="button"
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
        {button("newWindow", t("새 창에서 열기"), <ExternalIcon size={11} />)}
        {!open.is_default ? button("disconnect", t("연결 끊기"), <CloseIcon size={10} />) : null}
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
        className="launcher-row is-open has-actions"
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
        className={`launcher-row${open !== undefined ? " is-open has-actions" : ""}${groupId !== "" ? " in-group" : ""}${
          rowSpot?.id === connection.id && rowSpot.groupId === groupId ? (rowSpot.after ? " drop-after" : " drop-before") : ""
        }${dragId === connection.id ? " dragging" : ""}`}
        role="button"
        tabIndex={0}
        data-nav=""
        data-saved-id={connection.id}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData("text/plain", connection.id);
          event.dataTransfer.effectAllowed = "move";
          // Chrome drops a drag whose page changes during dragstart, so the drop
          // zones show up a tick later.
          window.setTimeout(() => setDragId(connection.id), 0);
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

  // A group (or the place for none) lights up as a whole when the dragged
  // connection lands next to none of the rows it shows.
  function dropTarget(groupId: string, rows: SavedConnection[]): string {
    return rowSpot !== null && rowSpot.groupId === groupId && !rows.some((row) => row.id === rowSpot.id)
      ? " drop-target"
      : "";
  }

  const groupSections = grouped
    .map(({ group, members }) => {
      const visible = members.filter((connection) => shown.has(connection.id));
      // While searching, groups without a hit drop out and the rest open up.
      if (searching && visible.length === 0) {
        return null;
      }
      const expanded = searching ? !searchFolded.has(group.id) : !group.collapsed;
      const target: ListTarget = { kind: "group", group };
      return (
        <div
          className={`launcher-group${dropTarget(group.id, expanded ? visible : [])}${
            groupSpot?.id === group.id ? (groupSpot.after ? " drop-after" : " drop-before") : ""
          }${dragGroupId === group.id ? " dragging" : ""}`}
          key={`group:${group.id}`}
          data-group-id={group.id}
        >
          <div
            className="launcher-group-head"
            role="button"
            tabIndex={0}
            data-nav=""
            aria-expanded={expanded}
            aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData("text/plain", group.name);
              event.dataTransfer.effectAllowed = "move";
              // As for a row: Chrome drops a drag whose page changes during dragstart.
              window.setTimeout(() => setDragGroupId(group.id), 0);
            }}
            onDragEnd={endDrag}
            onClick={() => toggleGroup(group)}
            onKeyDown={(event) => activateKeys(event, () => toggleGroup(group))}
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
      {...dropHandlers}
    >
      {nothing && searching ? <div className="launcher-empty">{t("검색 결과가 없습니다")}</div> : null}
      {visibleOpen.length > 0 || ungrouped.length > 0 ? (
        <div className={`launcher-ungrouped${dropTarget("", ungrouped)}`} data-group-id="">
          {visibleOpen.map(renderOpen)}
          {ungrouped.map((connection) => renderSaved(connection, ""))}
        </div>
      ) : null}
      {groupSections}
      {/* Below everything, so showing it never moves the row being dragged. */}
      {dragId !== null && ungrouped.length === 0 ? (
        <div
          className={`launcher-ungrouped launcher-drop-hint${dropTarget("", [])}`}
          data-group-id=""
        >
          {t("여기에 놓으면 그룹에서 빠집니다")}
        </div>
      ) : null}
    </div>
  );
}
