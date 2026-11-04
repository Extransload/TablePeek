import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";
import type { ConnGroup } from "../connGroups";
import { orderConnections, type ConnMeta } from "../connMeta";
import { t } from "../i18n";
import { engineById, unsupportedEngine } from "../engines";
import { basename, fillTemplate, templateValues } from "../engines/connection";
import type { ConnSummary, SavedConnection } from "../store";
import { DriverIcon } from "./DriverIcon";
import { ChevronIcon, CloseIcon, ExternalIcon, FolderIcon } from "./icons";
import { RollingNumber } from "./RollingNumber";
import { Spinner } from "./Spinner";
import { DURATION, EASE, animate, flip, ghost, measure, reducedMotion, unhook, type Rects } from "../motion";

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

// The slot a pointer at `y` falls in among items whose middles are `mids`,
// top to bottom: before the first whose middle is below it, else after the last.
function slotAt(mids: number[], y: number): number {
  const slot = mids.findIndex((mid) => y < mid);
  return slot < 0 ? mids.length : slot;
}

// The spot that slot marks among `ids`; null when it leaves `self` where it is.
function spotAt(ids: string[], slot: number, self: string | null): Spot | null {
  if (ids.length === 0 || ids[slot] === self || ids[slot - 1] === self) {
    return null;
  }
  return slot < ids.length ? { id: ids[slot], after: false } : { id: ids[slot - 1], after: true };
}

// What's being dragged: a saved connection, or a group (by its header).
interface Drag {
  kind: "row" | "group";
  id: string;
}

// The list as a drag found it, in its scrolled content's coordinates. Drop
// spots are worked out against where things were, not where the opening gap
// has pushed them, so the gap always opens under the card.
interface Layout {
  zones: { groupId: string; bottom: number; rows: { id: string; mid: number }[] }[];
  groups: { id: string; mid: number }[];
}

function layoutOf(list: HTMLElement): Layout {
  const middle = (element: HTMLElement) => element.offsetTop + element.offsetHeight / 2;
  return {
    zones: [...list.querySelectorAll<HTMLElement>("[data-group-id]")].map((zone) => ({
      groupId: zone.dataset.groupId ?? "",
      bottom: zone.offsetTop + zone.offsetHeight,
      rows: [...zone.querySelectorAll<HTMLElement>("[data-saved-id]")].map((row) => ({
        id: row.dataset.savedId ?? "",
        mid: middle(row),
      })),
    })),
    groups: [...list.querySelectorAll<HTMLElement>(".launcher-group[data-group-id]")].map((section) => ({
      id: section.dataset.groupId ?? "",
      mid: middle(section),
    })),
  };
}

// The card that follows the pointer: a copy of the row (or group header)
// above the page, moved by `mover`, lifted and leaning by `tilt`.
interface Lift {
  layer: HTMLElement;
  mover: HTMLElement;
  tilt: HTMLElement;
  shadow: HTMLElement;
  card: HTMLElement;
  // Where the pointer holds it, and its height (its middle aims the drop).
  grabX: number;
  grabY: number;
  height: number;
  // Sideways speed, smoothed, and the lean it gives.
  lastX: number;
  swing: number;
  lean: number;
}

// A press on a row or group header, a drag once it has moved far enough.
interface Session {
  drag: Drag;
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  source: HTMLElement;
  // The group the dragged row comes from ("" for none).
  origin: string;
  stacked: boolean;
  lift: Lift | null;
  layout: Layout | null;
  spot: Spot | RowSpot | null;
  frame: number;
  unlisten(): void;
}

// How far a press moves before it's a drag rather than a click.
const DRAG_SLOP = 4;
// How far past the list the pointer may stray and still aim at it.
const DROP_SLACK = 24;
const LIFTED = "scale(1.035) rotate(-1.2deg)";
// Everything that moves when the list rearranges: rows, headers, hints (not
// the copies of ones on their way out).
const LEAVES = ".launcher-row:not(.motion-ghost), .launcher-group-head:not(.motion-ghost), .launcher-drop-hint";

function flipKey(element: HTMLElement): string | undefined {
  return element.dataset.flip;
}

function div(className: string): HTMLDivElement {
  const element = document.createElement("div");
  element.className = className;
  return element;
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
  // What's being dragged, and where it would land (null: back where it was).
  const [drag, setDrag] = useState<Drag | null>(null);
  const [rowSpot, setRowSpot] = useState<RowSpot | null>(null);
  const [groupSpot, setGroupSpot] = useState<Spot | null>(null);
  // A dropped row or group ("row:<id>", "group:<id>") hidden while its card lands on it.
  const [settling, setSettling] = useState<string | null>(null);
  const dragRow = drag?.kind === "row" ? drag.id : null;
  const dragGroup = drag?.kind === "group" ? drag.id : null;
  const session = useRef<Session | null>(null);
  // Cards still landing, taken away if the list goes first.
  const layers = useRef(new Set<HTMLElement>());
  // Where things were just before a change, to move them from there once
  // it's drawn; and copies of the rows it takes away, to see them out.
  const pending = useRef<{ rects: Rects; leaving: (() => void)[]; at: number } | null>(null);
  // The row or group header ⌥↑↓ just moved, focused again once it's re-rendered.
  const refocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (refocus.current !== null) {
      containerRef.current?.querySelector<HTMLElement>(refocus.current)?.focus();
      refocus.current = null;
    }
    const plan = pending.current;
    const list = containerRef.current;
    pending.current = null;
    // A plan nothing re-rendered for straight away is stale.
    if (plan === null || list === null || performance.now() - plan.at > 150) {
      return;
    }
    flip(list.querySelectorAll<HTMLElement>(LEAVES), flipKey, plan.rects, { onEnter: arrive });
    for (const play of plan.leaving) {
      play();
    }
  });
  useEffect(() => {
    const cards = layers.current;
    return () => {
      session.current?.unlisten();
      session.current?.lift?.layer.remove();
      session.current = null;
      document.documentElement.classList.remove("launcher-dragging");
      for (const layer of cards) {
        layer.remove();
      }
    };
  }, []);
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
  // What a drag (running from window listeners) reads of the latest render.
  const latest = useRef({ allUngrouped, grouped, onMoveConnection, onMoveGroup });
  latest.current = { allUngrouped, grouped, onMoveConnection, onMoveGroup };

  // Notes where everything is before a change that rearranges the list; the
  // render it causes moves them on from there (rows and headers glide, new
  // ones fade in, `leaving` ones fade out).
  function prepareMotion(leaving: HTMLElement[] = []): void {
    const list = containerRef.current;
    if (list === null || reducedMotion()) {
      return;
    }
    pending.current = {
      rects: measure(list.querySelectorAll<HTMLElement>(LEAVES), flipKey),
      leaving: leaving.map((element) =>
        ghost(element, [{ opacity: 1 }, { opacity: 0, transform: "translateY(-6px) scale(0.98)" }], {
          duration: DURATION.base,
          easing: EASE.out,
        }),
      ),
      at: performance.now(),
    };
  }

  // How something new in the list arrives: the gap a drag opens swells in,
  // rows a group unfolds drop in one after another.
  function arrive(element: HTMLElement, index: number): void {
    if (element.closest(".is-settling") !== null) {
      return;
    }
    if (element.closest(".is-placeholder") !== null) {
      animate(element, [{ opacity: 0, transform: "scale(0.94)" }, { opacity: 1, transform: "none" }], {
        duration: DURATION.slow,
        easing: EASE.spring,
      });
      return;
    }
    animate(element, [{ opacity: 0, transform: "translateY(-6px)" }, { opacity: 1, transform: "none" }], {
      duration: DURATION.slow,
      easing: EASE.out,
      delay: Math.min(index, 10) * 18,
      fill: "backwards",
    });
  }

  function toggleGroup(group: ConnGroup): void {
    const section = containerRef.current?.querySelector<HTMLElement>(
      `.launcher-group[data-group-id="${CSS.escape(group.id)}"]`,
    );
    prepareMotion([...(section?.querySelectorAll<HTMLElement>(".launcher-row") ?? [])]);
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
        prepareMotion();
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
        prepareMotion();
        onMoveGroup(groupId, other, !up);
      }
    }
  }

  // Where a dragged group lands: by the card's height against the groups'
  // middles, so above the first one (over the connections outside any
  // group too) is the top and below the last one the bottom.
  function groupSpotAt(layout: Layout, y: number, self: string): Spot | null {
    return spotAt(
      layout.groups.map((group) => group.id),
      slotAt(
        layout.groups.map((group) => group.mid),
        y,
      ),
      self,
    );
  }

  // Where a dragged connection lands: in the group (or the place for none)
  // under the card, the next one down in a gap, the last one below them
  // all; there, by the card's height against its rows' middles. A group
  // showing none of its rows (folded, or empty) takes it on top.
  function rowSpotAt(layout: Layout, y: number, self: string): RowSpot | null {
    const zone = layout.zones.find((entry) => y < entry.bottom) ?? layout.zones.at(-1);
    if (zone === undefined) {
      return null;
    }
    if (zone.rows.length === 0) {
      const { allUngrouped: none, grouped: all } = latest.current;
      const members = zone.groupId === "" ? none : (all.find((entry) => entry.group.id === zone.groupId)?.members ?? []);
      const first = members.find((connection) => connection.id !== self);
      return { groupId: zone.groupId, id: first?.id ?? null, after: false };
    }
    const spot = spotAt(
      zone.rows.map((row) => row.id),
      slotAt(
        zone.rows.map((row) => row.mid),
        y,
      ),
      self,
    );
    return spot === null ? null : { groupId: zone.groupId, ...spot };
  }

  // A press on a row or group header: a click unless it moves, then a drag
  // (pointer-driven, so the card, the gap and the landing are all ours).
  function press(event: PointerEvent<HTMLElement>, target: Drag): void {
    if (
      event.button !== 0 ||
      event.pointerType === "touch" ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      session.current !== null ||
      (event.target as Element).closest("button") !== null
    ) {
      return;
    }
    const move = (e: globalThis.PointerEvent) => follow(e);
    const up = (e: globalThis.PointerEvent) => release(e.pointerId, false);
    const cancel = (e: globalThis.PointerEvent) => release(e.pointerId, true);
    const key = (e: globalThis.KeyboardEvent) => {
      const current = session.current;
      if (e.key === "Escape" && current?.lift) {
        e.preventDefault();
        e.stopPropagation();
        release(current.pointerId, true);
      }
    };
    const blur = () => {
      if (session.current !== null) {
        release(session.current.pointerId, true);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", blur);
    const { grouped: all } = latest.current;
    session.current = {
      drag: target,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      source: event.currentTarget,
      origin: event.currentTarget.closest<HTMLElement>("[data-group-id]")?.dataset.groupId ?? "",
      stacked: target.kind === "group" && (all.find((entry) => entry.group.id === target.id)?.members.length ?? 0) > 0,
      lift: null,
      layout: null,
      spot: null,
      frame: 0,
      unlisten() {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("keydown", key, true);
        window.removeEventListener("blur", blur);
      },
    };
  }

  function follow(event: globalThis.PointerEvent): void {
    const current = session.current;
    if (current === null || event.pointerId !== current.pointerId) {
      return;
    }
    current.x = event.clientX;
    current.y = event.clientY;
    if (current.lift === null && Math.hypot(current.x - current.startX, current.y - current.startY) >= DRAG_SLOP) {
      pickUp(current);
    }
  }

  // The row (or header) comes up off the list as a card under the pointer;
  // its place stays open as the gap, which then goes where it would land.
  function pickUp(current: Session): void {
    const list = containerRef.current;
    if (list === null) {
      return;
    }
    window.getSelection()?.removeAllRanges();
    const rect = current.source.getBoundingClientRect();
    const grabX = current.startX - rect.left;
    const grabY = current.startY - rect.top;
    const layer = div("launcher-drag-layer");
    const mover = div(`launcher-drag-lift${current.stacked ? " has-stack" : ""}`);
    const tilt = div("launcher-drag-tilt");
    const shadow = div("launcher-drag-shadow");
    const card = current.source.cloneNode(true) as HTMLElement;
    unhook(card);
    card.classList.add("launcher-drag-card");
    mover.style.width = `${rect.width}px`;
    mover.style.transformOrigin = `${grabX}px ${grabY}px`;
    mover.style.transform = `translate3d(${rect.left}px, ${rect.top}px, 0)`;
    tilt.style.transformOrigin = `${grabX}px ${grabY}px`;
    tilt.style.transform = LIFTED;
    tilt.append(shadow, card);
    mover.append(tilt);
    layer.append(mover);
    document.body.append(layer);
    animate(tilt, [{ transform: "none" }, { transform: LIFTED }], { duration: DURATION.spring, easing: EASE.springBouncy });
    animate(shadow, [{ opacity: 0 }, { opacity: 1 }], { duration: DURATION.slow, easing: EASE.out });
    current.lift = { layer, mover, tilt, shadow, card, grabX, grabY, height: rect.height, lastX: current.x, swing: 0, lean: 0 };
    document.documentElement.classList.add("launcher-dragging");
    prepareMotion();
    flushSync(() => setDrag(current.drag));
    current.layout = layoutOf(list);
    current.frame = requestAnimationFrame(tick);
  }

  // Each frame of a drag: the card follows the pointer, leaning into
  // sideways moves; the list scrolls at its edges; the gap follows the card.
  function tick(): void {
    const current = session.current;
    const list = containerRef.current;
    if (current?.lift == null || list === null) {
      return;
    }
    const lift = current.lift;
    lift.swing = lift.swing * 0.8 + (current.x - lift.lastX) * 0.2;
    lift.lastX = current.x;
    const lean = reducedMotion() ? 0 : Math.max(-7, Math.min(7, lift.swing * 0.7));
    lift.lean += (lean - lift.lean) * 0.2;
    lift.mover.style.transform = `translate3d(${current.x - lift.grabX}px, ${current.y - lift.grabY}px, 0) rotate(${lift.lean.toFixed(2)}deg)`;
    const box = list.getBoundingClientRect();
    const edge = 40;
    const over = current.y < box.top + edge ? current.y - box.top - edge : current.y > box.bottom - edge ? current.y - box.bottom + edge : 0;
    if (over !== 0 && current.x >= box.left && current.x <= box.right) {
      list.scrollTop += Math.sign(over) * Math.min(18, Math.ceil(Math.abs(over) / 3));
    }
    const outside =
      current.x < box.left - DROP_SLACK ||
      current.x > box.right + DROP_SLACK ||
      current.y < box.top - DROP_SLACK ||
      current.y > box.bottom + DROP_SLACK;
    const y = current.y - lift.grabY + lift.height / 2 - box.top - list.clientTop + list.scrollTop;
    const spot =
      outside || current.layout === null
        ? null
        : current.drag.kind === "group"
          ? groupSpotAt(current.layout, y, current.drag.id)
          : rowSpotAt(current.layout, y, current.drag.id);
    if (!sameSpot(spot, current.spot)) {
      current.spot = spot;
      if (current.drag.kind === "row") {
        // The card takes on the indent of the place it's over.
        lift.card.classList.toggle("in-group", (spot !== null && "groupId" in spot ? spot.groupId : current.origin) !== "");
      }
      prepareMotion();
      flushSync(() => {
        if (current.drag.kind === "group") {
          setGroupSpot(spot !== null && !("groupId" in spot) ? spot : null);
        } else {
          setRowSpot(spot !== null && "groupId" in spot ? spot : null);
        }
      });
      // Over a group that shows no rows the card shrinks back and thins,
      // letting the group's pulse show through.
      lift.mover.classList.toggle("is-over-folder", list.querySelector(".drop-target") !== null);
    }
    current.frame = requestAnimationFrame(tick);
  }

  // The pointer lets go (or Esc, or the window loses it): the move happens
  // at once, and the card settles onto where it went (back, if cancelled).
  function release(pointerId: number, cancelled: boolean): void {
    const current = session.current;
    if (current === null || pointerId !== current.pointerId) {
      return;
    }
    session.current = null;
    current.unlisten();
    cancelAnimationFrame(current.frame);
    document.documentElement.classList.remove("launcher-dragging");
    const lift = current.lift;
    if (lift === null) {
      return;
    }
    // The press ends on a row; it isn't a click on it.
    const swallow = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("click", swallow, { capture: true, once: true });
    window.setTimeout(() => window.removeEventListener("click", swallow, true), 0);
    const spot = cancelled ? null : current.spot;
    const { drag: moved } = current;
    prepareMotion();
    flushSync(() => {
      if (spot !== null) {
        if ("groupId" in spot) {
          latest.current.onMoveConnection(moved.id, spot.groupId, spot.id, spot.after);
        } else {
          latest.current.onMoveGroup(moved.id, spot.id, spot.after);
        }
      }
      setDrag(null);
      setRowSpot(null);
      setGroupSpot(null);
      setSettling(reducedMotion() ? null : `${moved.kind}:${moved.id}`);
    });
    land(lift, moved, spot !== null && "groupId" in spot ? spot.groupId : current.origin);
  }

  // The card springs onto the row (or header) where the move put it; into a
  // folded group, it drops into the folder, which gives a little bounce.
  function land(lift: Lift, moved: Drag, groupId: string): void {
    const list = containerRef.current;
    const head = (id: string) =>
      list?.querySelector<HTMLElement>(`.launcher-group[data-group-id="${CSS.escape(id)}"] > .launcher-group-head`) ?? null;
    const row =
      moved.kind === "row"
        ? (list?.querySelector<HTMLElement>(`.launcher-row[data-saved-id="${CSS.escape(moved.id)}"]`) ?? null)
        : head(moved.id);
    const folder = row === null && moved.kind === "row" ? head(groupId) : null;
    layers.current.add(lift.layer);
    let finished = false;
    const done = () => {
      if (finished) {
        return;
      }
      finished = true;
      lift.layer.remove();
      layers.current.delete(lift.layer);
      setSettling(null);
      const icon = folder?.querySelector<HTMLElement>(".launcher-group-icon");
      if (icon != null) {
        animate(icon, [{ transform: "scale(1)" }, { transform: "scale(1.35)" }, { transform: "scale(1)" }], {
          duration: DURATION.slower,
          easing: EASE.out,
        });
      }
    };
    const target = row ?? folder;
    if (target === null || reducedMotion()) {
      done();
      return;
    }
    const from = lift.mover.style.transform;
    let flight: Animation;
    if (row !== null) {
      const to = row.getBoundingClientRect();
      lift.card.classList.add("is-landing");
      flight = lift.mover.animate(
        [{ transform: from }, { transform: `translate3d(${to.left}px, ${to.top}px, 0) rotate(0deg)` }],
        { duration: DURATION.spring, easing: EASE.spring, fill: "forwards" },
      );
      lift.tilt.animate([{ transform: LIFTED }, { transform: "none" }], {
        duration: DURATION.spring,
        easing: EASE.spring,
        fill: "forwards",
      });
      lift.shadow.animate([{ opacity: 1 }, { opacity: 0 }], { duration: DURATION.slow, easing: EASE.out, fill: "forwards" });
    } else {
      const icon = (target.querySelector<HTMLElement>(".launcher-group-icon") ?? target).getBoundingClientRect();
      const x = icon.left + icon.width / 2 - lift.grabX;
      const y = icon.top + icon.height / 2 - lift.grabY;
      flight = lift.mover.animate(
        [
          { transform: from, opacity: 1 },
          { transform: `translate3d(${x}px, ${y}px, 0) rotate(0deg) scale(0.2)`, opacity: 0 },
        ],
        { duration: DURATION.slower, easing: EASE.inOut, fill: "forwards" },
      );
    }
    flight.onfinish = done;
    flight.oncancel = done;
    // A hidden window may hold the animation; the row mustn't stay hidden.
    window.setTimeout(done, DURATION.slower + 400);
  }

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
        data-flip={`open:${conn.id}`}
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
    const placeholder = dragRow === connection.id;
    return (
      <div
        key={`saved:${connection.id}`}
        className={`launcher-row${open !== undefined ? " is-open has-actions" : ""}${groupId !== "" ? " in-group" : ""}${
          placeholder ? " is-placeholder" : ""
        }${settling === `row:${connection.id}` ? " is-settling" : ""}`}
        role="button"
        tabIndex={0}
        data-nav=""
        data-saved-id={connection.id}
        // The gap is new wherever it opens; it swells in rather than sliding over.
        data-flip={placeholder ? undefined : `row:${connection.id}`}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        onPointerDown={(event) => press(event, { kind: "row", id: connection.id })}
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

  // The rows a zone shows ("" for the connections outside any group).
  function shownIn(groupId: string): SavedConnection[] {
    if (groupId === "") {
      return ungrouped;
    }
    const entry = grouped.find(({ group }) => group.id === groupId);
    const expanded = entry !== undefined && (searching ? !searchFolded.has(groupId) : !entry.group.collapsed);
    return expanded ? entry.members.filter((connection) => shown.has(connection.id)) : [];
  }

  // A zone's rows as the drag would leave them: the dragged one taken out,
  // and put back where it would land when that's among them. Bound for a
  // group showing no rows, it keeps its own gap, so nothing shifts under
  // the pointer while that group lights up.
  function arranged(groupId: string, rows: SavedConnection[]): SavedConnection[] {
    if (
      dragRow === null ||
      rowSpot === null ||
      !shownIn(rowSpot.groupId).some((connection) => connection.id === rowSpot.id && connection.id !== dragRow)
    ) {
      return rows;
    }
    const moving = saved.find((connection) => connection.id === dragRow);
    const rest = rows.filter((connection) => connection.id !== dragRow);
    const at = rowSpot.groupId === groupId ? rest.findIndex((connection) => connection.id === rowSpot.id) : -1;
    if (moving !== undefined && at >= 0) {
      rest.splice(rowSpot.after ? at + 1 : at, 0, moving);
    }
    return rest;
  }

  // A group (or the place for none) lights up as a whole when the dragged
  // connection lands next to none of the rows it shows.
  function dropTarget(groupId: string, rows: SavedConnection[]): string {
    return rowSpot !== null && rowSpot.groupId === groupId && !rows.some((row) => row.id === rowSpot.id)
      ? " drop-target"
      : "";
  }

  // The groups as a group drag would leave them.
  let sectionOrder = grouped;
  if (dragGroup !== null && groupSpot !== null) {
    const moving = grouped.find((entry) => entry.group.id === dragGroup);
    const rest = grouped.filter((entry) => entry !== moving);
    const at = rest.findIndex((entry) => entry.group.id === groupSpot.id);
    if (moving !== undefined && at >= 0) {
      rest.splice(groupSpot.after ? at + 1 : at, 0, moving);
      sectionOrder = rest;
    }
  }

  const groupSections = sectionOrder
    .map(({ group, members }) => {
      const visible = members.filter((connection) => shown.has(connection.id));
      // While searching, groups without a hit drop out and the rest open up.
      if (searching && visible.length === 0) {
        return null;
      }
      const expanded = searching ? !searchFolded.has(group.id) : !group.collapsed;
      const target: ListTarget = { kind: "group", group };
      // A dragged group travels as its header; its rows wait folded away.
      const placeholder = dragGroup === group.id;
      return (
        <div
          className={`launcher-group${dropTarget(group.id, expanded ? visible : [])}${placeholder ? " is-placeholder" : ""}${
            settling === `group:${group.id}` ? " is-settling" : ""
          }`}
          key={`group:${group.id}`}
          data-group-id={group.id}
        >
          <div
            className="launcher-group-head"
            role="button"
            tabIndex={0}
            data-nav=""
            data-flip={placeholder ? undefined : `head:${group.id}`}
            aria-expanded={expanded}
            aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
            onPointerDown={(event) => press(event, { kind: "group", id: group.id })}
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
              <RollingNumber className="launcher-group-count" value={members.length} />
            ) : null}
          </div>
          {expanded && !placeholder ? arranged(group.id, visible).map((connection) => renderSaved(connection, group.id)) : null}
        </div>
      );
    })
    .filter((section) => section !== null);

  const nothing =
    visibleOpen.length === 0 && ungrouped.length === 0 && groupSections.length === 0;

  return (
    <div
      className={`launcher-list${drag !== null ? " is-dragging" : ""}`}
      ref={containerRef}
      onKeyDown={onListKeyDown}
      onContextMenu={(event) => menuAt(event, null)}
    >
      {nothing && searching ? <div className="launcher-empty">{t("검색 결과가 없습니다")}</div> : null}
      {visibleOpen.length > 0 || ungrouped.length > 0 ? (
        <div className={`launcher-ungrouped${dropTarget("", ungrouped)}`} data-group-id="">
          {visibleOpen.map(renderOpen)}
          {arranged("", ungrouped).map((connection) => renderSaved(connection, ""))}
        </div>
      ) : null}
      {groupSections}
      {/* Below everything, so showing it never moves the row being dragged. */}
      {dragRow !== null && ungrouped.length === 0 ? (
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
