import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { layoutDiagram, type Point } from "../erLayout";
import { t } from "../i18n";
import { loadRelations, loadSchema, peekRelations, peekSchema } from "../schemaCache";
import type { Relation, TableSchema } from "../store";
import { ErrorNotice } from "./ErrorNotice";
import { FitIcon, KeyIcon, LinkIcon, MinusIcon, PlusIcon, RefreshIcon, SearchIcon, TableIcon } from "./icons";
import { LoadingState, Spinner } from "./Spinner";

interface ErDiagramProps {
  conn: string;
  // The connection's meta key: a new one reloads the schema.
  refreshKey: string;
  // What moved cards are remembered under (the connection's stable key).
  storageKey: string;
  tabId: string;
  // A table to centre and pick; each new request bumps `focusSeq`.
  focus?: string;
  focusSeq?: number;
  onOpenData(table: string): void;
}

interface CardRow {
  name: string;
  type: string;
  pk: boolean;
  fk: boolean;
}

interface Card {
  name: string;
  rows: CardRow[];
  // Columns left out under "keys only".
  hidden: number;
  width: number;
  height: number;
}

// One column pair of a foreign key: row `fromRow` of `from` refers to row
// `toRow` of `to` (-1: the column isn't shown, the line meets the header).
interface Link {
  key: string;
  from: string;
  fromRow: number;
  to: string;
  toRow: number;
}

interface Model {
  cards: Card[];
  byName: Map<string, Card>;
  links: Link[];
  relationCount: number;
}

// Card geometry in px. Rows have fixed heights so lines can be aimed at a
// row without measuring the DOM; styles.css uses the same numbers.
const BORDER = 1;
const HEAD_H = 28;
const ROW_H = 20;
const PAD_B = 4;
const MIN_W = 150;
const MAX_W = 380;

const MIN_ZOOM = 0.08;
const MAX_ZOOM = 2.5;
// Below this zoom the rows' text is too small to read and is not painted.
const FAR_ZOOM = 0.45;
const GRID = 20;

const POSITIONS_KEY = "tablepeek.er-positions";
const KEYS_ONLY_KEY = "tablepeek.er-keys-only";

interface View {
  x: number;
  y: number;
  k: number;
}

// Where each diagram tab was looking, so switching tabs and back keeps it;
// `seq` is the last focus request it handled.
const views = new Map<string, View & { seq: number }>();

function errorOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function loadKeysOnly(): boolean {
  try {
    return window.localStorage.getItem(KEYS_ONLY_KEY) === "1";
  } catch {
    return false;
  }
}

type SavedPositions = Record<string, Point>;

function readAllPositions(): Record<string, Record<string, [number, number]>> {
  try {
    const raw = window.localStorage.getItem(POSITIONS_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, Record<string, [number, number]>>) : {};
  } catch {
    return {};
  }
}

function loadPositions(key: string): SavedPositions {
  const entry = readAllPositions()[key];
  const result: SavedPositions = {};
  if (entry === undefined || entry === null || typeof entry !== "object") {
    return result;
  }
  for (const [table, point] of Object.entries(entry)) {
    if (Array.isArray(point) && typeof point[0] === "number" && typeof point[1] === "number") {
      result[table] = { x: point[0], y: point[1] };
    }
  }
  return result;
}

function savePositions(key: string, positions: SavedPositions): void {
  const all = readAllPositions();
  const entries = Object.entries(positions);
  if (entries.length === 0) {
    delete all[key];
  } else {
    all[key] = Object.fromEntries(entries.map(([table, point]) => [table, [Math.round(point.x), Math.round(point.y)]]));
  }
  try {
    window.localStorage.setItem(POSITIONS_KEY, JSON.stringify(all));
  } catch {
    /* 저장 실패는 무시 */
  }
}

let measureContext: CanvasRenderingContext2D | null | undefined;

// Text widths for sizing cards, in the fonts the cards are drawn with.
function textWidths(texts: string[], font: string): number[] {
  if (measureContext === undefined) {
    measureContext = document.createElement("canvas").getContext("2d");
  }
  if (measureContext === null) {
    return texts.map((text) => text.length * 7.2);
  }
  measureContext.font = font;
  return texts.map((text) => measureContext!.measureText(text).width);
}

function cardHeight(rows: number, hidden: number): number {
  return BORDER * 2 + HEAD_H + (rows + (hidden > 0 ? 1 : 0)) * ROW_H + PAD_B;
}

// The y a line meets row `row` of a card at `top` (the header for -1).
function rowY(top: number, row: number): number {
  return row < 0 ? top + BORDER + HEAD_H / 2 : top + BORDER + HEAD_H + row * ROW_H + ROW_H / 2;
}

function buildModel(tables: TableSchema[], relations: Relation[], keysOnly: boolean): Model {
  const schemas = new Map(tables.map((table) => [table.name, table]));
  const valid = relations.filter(
    (relation) => schemas.has(relation.table) && schemas.has(relation.ref_table) && relation.columns.length > 0,
  );
  // A key naming no columns refers to the other table's primary key.
  const targetsOf = (relation: Relation): string[] =>
    relation.ref_columns.length > 0
      ? relation.ref_columns
      : schemas.get(relation.ref_table)!.columns.filter((column) => column.pk).map((column) => column.name);
  const foreign = new Map<string, Set<string>>();
  const referenced = new Map<string, Set<string>>();
  for (const relation of valid) {
    const own = foreign.get(relation.table) ?? new Set<string>();
    relation.columns.forEach((column) => own.add(column));
    foreign.set(relation.table, own);
    const target = referenced.get(relation.ref_table) ?? new Set<string>();
    targetsOf(relation).forEach((column) => target.add(column));
    referenced.set(relation.ref_table, target);
  }

  const mono = getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "monospace";
  const ui = getComputedStyle(document.documentElement).getPropertyValue("--ui").trim() || "sans-serif";
  const cards = tables.map((table): Card => {
    const fks = foreign.get(table.name);
    const refs = referenced.get(table.name);
    const rows = table.columns
      .filter((column) => !keysOnly || column.pk || fks?.has(column.name) || refs?.has(column.name))
      .map((column) => ({
        name: column.name,
        type: column.decl_type ?? "",
        pk: column.pk,
        fk: fks?.has(column.name) ?? false,
      }));
    const hidden = table.columns.length - rows.length;
    const [head] = textWidths([table.name], `600 12px ${mono}`);
    const names = textWidths(rows.map((row) => row.name), `12px ${mono}`);
    const types = textWidths(rows.map((row) => row.type), `11px ${mono}`);
    const [more] = textWidths([hidden > 0 ? t("컬럼 {count}개 더", { count: hidden }) : ""], `11px ${ui}`);
    // Header: padding, icon, gap, name. Row: padding, key mark, gaps, name,
    // type, link mark.
    let width = 20 + 12 + 6 + head;
    rows.forEach((_, index) => {
      width = Math.max(width, 16 + 12 + 12 + 6 + 6 + names[index] + types[index] + 12);
    });
    width = Math.max(width, 16 + 18 + more);
    return {
      name: table.name,
      rows,
      hidden,
      width: Math.round(Math.min(MAX_W, Math.max(MIN_W, width + BORDER * 2 + 2))),
      height: cardHeight(rows.length, hidden),
    };
  });
  const byName = new Map(cards.map((card) => [card.name, card]));
  const links: Link[] = [];
  valid.forEach((relation, index) => {
    const from = byName.get(relation.table)!;
    const to = byName.get(relation.ref_table)!;
    const targets = targetsOf(relation);
    relation.columns.forEach((column, position) => {
      const target = targets[position];
      links.push({
        key: `${index}:${position}`,
        from: relation.table,
        fromRow: from.rows.findIndex((row) => row.name === column),
        to: relation.ref_table,
        toRow: target === undefined ? -1 : to.rows.findIndex((row) => row.name === target),
      });
    });
  });
  return { cards, byName, links, relationCount: valid.length };
}

interface Box {
  x: number;
  y: number;
  width: number;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

// The line from the foreign-key row (crow's foot: many) to the referenced row
// (two bars: exactly one). Lines leave the facing sides of the two cards;
// cards in one column (or a table referring to itself) are joined on the
// right by a loop.
function linkGeometry(from: Box, fromY: number, to: Box, toY: number, self: boolean): { line: string; marks: string } {
  let ax: number;
  let ad: number;
  let bx: number;
  let bd: number;
  if (!self && from.x >= to.x + to.width + 24) {
    ax = from.x;
    ad = -1;
    bx = to.x + to.width;
    bd = 1;
  } else if (!self && to.x >= from.x + from.width + 24) {
    ax = from.x + from.width;
    ad = 1;
    bx = to.x;
    bd = -1;
  } else {
    ax = from.x + from.width;
    ad = 1;
    bx = to.x + to.width;
    bd = 1;
  }
  const stub = 14;
  let reachA: number;
  let reachB: number;
  if (ad === bd) {
    const outer = Math.max(ax, bx);
    const loop = 36 + Math.min(80, Math.abs(fromY - toY) * 0.12);
    reachA = outer - ax + loop;
    reachB = outer - bx + loop;
  } else {
    reachA = Math.max(30, Math.abs(bx - ax) / 2 - stub);
    reachB = reachA;
  }
  const a1 = ax + ad * stub;
  const b1 = bx + bd * stub;
  const line =
    `M${round(ax)} ${round(fromY)}H${round(a1)}` +
    `C${round(a1 + ad * reachA)} ${round(fromY)} ${round(b1 + bd * reachB)} ${round(toY)} ${round(b1)} ${round(toY)}` +
    `H${round(bx)}`;
  const foot = ax + ad * 11;
  const marks =
    `M${round(foot)} ${round(fromY)}L${round(ax)} ${round(fromY - 6)}` +
    `M${round(foot)} ${round(fromY)}L${round(ax)} ${round(fromY + 6)}` +
    `M${round(ax + ad * 13)} ${round(fromY - 5)}V${round(fromY + 5)}` +
    `M${round(bx + bd * 6)} ${round(toY - 5)}V${round(toY + 5)}` +
    `M${round(bx + bd * 10)} ${round(toY - 5)}V${round(toY + 5)}`;
  return { line, marks };
}

type CardState = "" | "focus" | "near" | "dim";

interface CardViewProps {
  card: Card;
  x: number;
  y: number;
  state: CardState;
  match: boolean;
  // Being dragged now, or the last card moved (kept above the others).
  lift: "" | "dragging" | "raised";
  // Rows the highlighted lines meet.
  hot: ReadonlySet<number> | undefined;
}

const CardView = memo(function CardView({ card, x, y, state, match, lift, hot }: CardViewProps) {
  return (
    <div
      className={`er-card${state === "" ? "" : ` ${state}`}${match ? " match" : ""}${lift === "" ? "" : ` ${lift}`}`}
      data-table={card.name}
      style={{ left: x, top: y, width: card.width, height: card.height }}
    >
      <div className="er-card-head" title={card.name}>
        <TableIcon size={8} className="er-card-icon" />
        <span className="er-card-name">{card.name}</span>
      </div>
      {card.rows.map((row, index) => (
        <div
          key={row.name}
          className={`er-row${hot?.has(index) ? " hot" : ""}`}
          title={row.type === "" ? row.name : `${row.name} ${row.type}`}
        >
          <span className="er-mark pk">{row.pk ? <KeyIcon size={7} /> : null}</span>
          <span className="er-row-name">{row.name}</span>
          <span className="er-row-type">{row.type}</span>
          <span className="er-mark fk">{row.fk ? <LinkIcon size={7} /> : null}</span>
        </div>
      ))}
      {card.hidden > 0 ? <div className="er-row more">{t("컬럼 {count}개 더", { count: card.hidden })}</div> : null}
    </div>
  );
});

const LinkView = memo(function LinkView({ line, marks, state }: { line: string; marks: string; state: string }) {
  return (
    <g className={`er-link${state === "" ? "" : ` ${state}`}`}>
      <path className="er-link-line" d={line} />
      <path className="er-link-marks" d={marks} />
    </g>
  );
});

type Gesture =
  | { kind: "pan"; pointer: number; startX: number; startY: number; viewX: number; viewY: number; moved: boolean }
  | { kind: "card"; pointer: number; startX: number; startY: number; name: string; origin: Point; moved: boolean };

export function ErDiagram({ conn, refreshKey, storageKey, tabId, focus, focusSeq, onOpenData }: ErDiagramProps) {
  const [tables, setTables] = useState<TableSchema[] | null>(() => peekSchema(conn, false));
  const [relations, setRelations] = useState<Relation[] | null>(() => peekRelations(conn, false));
  const [relationsFailed, setRelationsFailed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const forceRef = useRef(false);
  const [keysOnly, setKeysOnly] = useState(loadKeysOnly);
  const [saved, setSaved] = useState<SavedPositions>(() => loadPositions(storageKey));
  const [live, setLive] = useState<{ name: string; point: Point } | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [raised, setRaised] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [matchIndex, setMatchIndex] = useState(0);

  const viewportRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const zoomLabelRef = useRef<HTMLSpanElement>(null);
  const remembered = views.get(tabId);
  const view = useRef<View>(remembered !== undefined ? { x: remembered.x, y: remembered.y, k: remembered.k } : { x: 0, y: 0, k: 1 });
  const handledSeq = useRef(remembered?.seq ?? 0);
  const placedRef = useRef(remembered !== undefined);
  const idleTimer = useRef<number | undefined>(undefined);
  const gesture = useRef<Gesture | null>(null);
  const frame = useRef<number | null>(null);
  const livePoint = useRef<Point | null>(null);
  const pendingFit = useRef(false);

  useEffect(() => {
    setSaved(loadPositions(storageKey));
  }, [storageKey]);

  useEffect(() => {
    let alive = true;
    const force = forceRef.current;
    forceRef.current = false;
    setLoading(peekSchema(conn, false) === null || force);
    setError(null);
    void Promise.allSettled([
      loadSchema(conn, false, refreshKey, force),
      loadRelations(conn, false, refreshKey, force),
    ]).then(([schema, keys]) => {
      if (!alive) {
        return;
      }
      setLoading(false);
      if (schema.status === "fulfilled") {
        setTables(schema.value);
      } else {
        setError(errorOf(schema.reason, t("스키마를 불러오지 못했습니다")));
      }
      // Without relations (an older server, a driver that can't list them)
      // the tables are still drawn, with a note.
      if (keys.status === "fulfilled") {
        setRelations(keys.value);
        setRelationsFailed(false);
      } else {
        setRelations((prev) => prev ?? []);
        setRelationsFailed(true);
      }
    });
    return () => {
      alive = false;
    };
  }, [conn, refreshKey, nonce]);

  const model = useMemo(
    () => (tables === null ? null : buildModel(tables, relations ?? [], keysOnly)),
    [tables, relations, keysOnly],
  );
  const auto = useMemo(
    () =>
      model === null
        ? null
        : layoutDiagram(
            model.cards.map((card) => ({ id: card.name, width: card.width, height: card.height })),
            model.links.map((link) => ({ from: link.from, to: link.to })),
          ),
    [model],
  );

  const positionOf = useCallback(
    (name: string): Point => {
      if (live !== null && live.name === name) {
        return live.point;
      }
      return saved[name] ?? auto?.get(name) ?? { x: 0, y: 0 };
    },
    [live, saved, auto],
  );

  const bounds = useMemo(() => {
    if (model === null || model.cards.length === 0) {
      return null;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const card of model.cards) {
      const point = saved[card.name] ?? auto?.get(card.name) ?? { x: 0, y: 0 };
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x + card.width);
      maxY = Math.max(maxY, point.y + card.height);
    }
    return { minX, minY, maxX, maxY };
  }, [model, saved, auto]);

  // Pan and zoom write the transform straight to the DOM: no render per frame.
  const applyView = useCallback((animate = false) => {
    const world = worldRef.current;
    const viewport = viewportRef.current;
    if (world === null || viewport === null) {
      return;
    }
    const { x, y, k } = view.current;
    world.classList.add("moving");
    world.classList.toggle("animate", animate);
    world.classList.toggle("far", k < FAR_ZOOM);
    world.style.transform = `translate(${x}px, ${y}px) scale(${k})`;
    let grid = GRID * k;
    while (grid < 10) {
      grid *= 2;
    }
    viewport.style.backgroundSize = `${grid}px ${grid}px`;
    viewport.style.backgroundPosition = `${x}px ${y}px`;
    if (zoomLabelRef.current !== null) {
      zoomLabelRef.current.textContent = `${Math.round(k * 100)}%`;
    }
    // The layer is only promoted while it moves; afterwards it is painted
    // again at the new scale, so text stays sharp.
    window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => {
      world.classList.remove("moving", "animate");
    }, 280);
  }, []);

  const zoomAt = useCallback(
    (sx: number, sy: number, target: number, animate = false) => {
      const { x, y, k } = view.current;
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, target));
      view.current = { x: sx - ((sx - x) / k) * next, y: sy - ((sy - y) / k) * next, k: next };
      applyView(animate);
    },
    [applyView],
  );

  const zoomBy = (factor: number): void => {
    const viewport = viewportRef.current;
    if (viewport !== null) {
      zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, view.current.k * factor, true);
    }
  };

  const fit = useCallback(
    (animate: boolean) => {
      const viewport = viewportRef.current;
      if (viewport === null || bounds === null) {
        return;
      }
      const pad = 40;
      const width = Math.max(1, bounds.maxX - bounds.minX);
      const height = Math.max(1, bounds.maxY - bounds.minY);
      const k = Math.min(
        1,
        MAX_ZOOM,
        Math.max(MIN_ZOOM, Math.min((viewport.clientWidth - pad * 2) / width, (viewport.clientHeight - pad * 2) / height)),
      );
      view.current = {
        x: (viewport.clientWidth - width * k) / 2 - bounds.minX * k,
        y: Math.max(pad, (viewport.clientHeight - height * k) / 2) - bounds.minY * k,
        k,
      };
      applyView(animate);
    },
    [bounds, applyView],
  );

  const centreOn = useCallback(
    (name: string, animate: boolean) => {
      const viewport = viewportRef.current;
      const card = model?.byName.get(name);
      if (viewport === null || card === undefined) {
        return;
      }
      const point = positionOf(name);
      const k = view.current.k < 0.7 ? 1 : view.current.k;
      const vw = viewport.clientWidth;
      const vh = viewport.clientHeight;
      // A card taller than the view shows from its top.
      const top = card.height * k > vh - 80 ? 40 : (vh - card.height * k) / 2;
      view.current = { x: vw / 2 - (point.x + card.width / 2) * k, y: top - point.y * k, k };
      applyView(animate);
    },
    [model, positionOf, applyView],
  );

  // First paint: back where this tab was, else on the asked-for table, else
  // the whole diagram. A later focus request centres its table.
  useLayoutEffect(() => {
    if (auto === null || model === null) {
      return;
    }
    if (focus !== undefined && focusSeq !== undefined && focusSeq !== handledSeq.current && model.byName.has(focus)) {
      handledSeq.current = focusSeq;
      placedRef.current = true;
      setSelected(focus);
      centreOn(focus, false);
      return;
    }
    if (!placedRef.current) {
      placedRef.current = true;
      fit(false);
      return;
    }
    applyView();
  }, [auto, model, focus, focusSeq]);

  // After "reset layout", fit once the cards are back in their places.
  useLayoutEffect(() => {
    if (pendingFit.current) {
      pendingFit.current = false;
      fit(true);
    }
  }, [fit]);

  useEffect(
    () => () => {
      views.set(tabId, { ...view.current, seq: handledSeq.current });
      window.clearTimeout(idleTimer.current);
      if (frame.current !== null) {
        window.cancelAnimationFrame(frame.current);
      }
    },
    [tabId],
  );

  // Wheel pans; ⌘/Ctrl+wheel (and a trackpad pinch, which arrives as one)
  // zooms at the pointer. Safari reports pinches as gesture events.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) {
      return;
    }
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
      if (event.ctrlKey || event.metaKey) {
        const rect = viewport.getBoundingClientRect();
        const delta = Math.max(-25, Math.min(25, event.deltaY * unit));
        zoomAt(event.clientX - rect.left, event.clientY - rect.top, view.current.k * Math.exp(-delta * 0.01));
        return;
      }
      let dx = event.deltaX * unit;
      let dy = event.deltaY * unit;
      if (event.shiftKey && dx === 0) {
        dx = dy;
        dy = 0;
      }
      view.current = { ...view.current, x: view.current.x - dx, y: view.current.y - dy };
      applyView();
    };
    let gestureStart = 1;
    const onGestureStart = (event: Event): void => {
      event.preventDefault();
      gestureStart = view.current.k;
    };
    const onGestureChange = (event: Event): void => {
      event.preventDefault();
      const pinch = event as Event & { scale: number; clientX: number; clientY: number };
      const rect = viewport.getBoundingClientRect();
      zoomAt(pinch.clientX - rect.left, pinch.clientY - rect.top, gestureStart * pinch.scale);
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    viewport.addEventListener("gesturestart", onGestureStart);
    viewport.addEventListener("gesturechange", onGestureChange);
    return () => {
      viewport.removeEventListener("wheel", onWheel);
      viewport.removeEventListener("gesturestart", onGestureStart);
      viewport.removeEventListener("gesturechange", onGestureChange);
    };
  }, [zoomAt, applyView]);

  function cardAt(target: EventTarget | null): string | null {
    const element = target instanceof Element ? target.closest<HTMLElement>("[data-table]") : null;
    return element?.dataset.table ?? null;
  }

  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void {
    if ((event.button !== 0 && event.button !== 1) || gesture.current !== null) {
      return;
    }
    viewportRef.current?.focus({ preventScroll: true });
    const name = event.button === 0 ? cardAt(event.target) : null;
    if (name !== null) {
      gesture.current = {
        kind: "card",
        pointer: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        name,
        origin: positionOf(name),
        moved: false,
      };
    } else {
      event.preventDefault();
      gesture.current = {
        kind: "pan",
        pointer: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        viewX: view.current.x,
        viewY: view.current.y,
        moved: false,
      };
    }
  }

  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>): void {
    const current = gesture.current;
    if (current === null || current.pointer !== event.pointerId) {
      return;
    }
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (!current.moved) {
      if (Math.hypot(dx, dy) < 4) {
        return;
      }
      // Captured only once it is a drag, so a plain click or double-click
      // still lands on the card under it.
      current.moved = true;
      viewportRef.current?.setPointerCapture(event.pointerId);
      viewportRef.current?.classList.add(current.kind === "pan" ? "panning" : "dragging");
      if (current.kind === "card") {
        setRaised(current.name);
      }
    }
    if (current.kind === "pan") {
      view.current = { ...view.current, x: current.viewX + dx, y: current.viewY + dy };
      applyView();
      return;
    }
    const k = view.current.k;
    livePoint.current = { x: current.origin.x + dx / k, y: current.origin.y + dy / k };
    if (frame.current === null) {
      frame.current = window.requestAnimationFrame(() => {
        frame.current = null;
        if (livePoint.current !== null) {
          setLive({ name: current.name, point: livePoint.current });
        }
      });
    }
  }

  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>): void {
    const current = gesture.current;
    if (current === null || current.pointer !== event.pointerId) {
      return;
    }
    gesture.current = null;
    viewportRef.current?.classList.remove("panning", "dragging");
    if (viewportRef.current?.hasPointerCapture(event.pointerId)) {
      viewportRef.current.releasePointerCapture(event.pointerId);
    }
    if (current.kind === "pan") {
      if (!current.moved && event.type === "pointerup") {
        setSelected(null);
      }
      return;
    }
    if (!current.moved) {
      setSelected(current.name);
      return;
    }
    if (frame.current !== null) {
      window.cancelAnimationFrame(frame.current);
      frame.current = null;
    }
    const point = livePoint.current;
    livePoint.current = null;
    setLive(null);
    if (point !== null) {
      setSaved((prev) => {
        const next: SavedPositions = {};
        // Tables no longer in the schema drop out of what is kept.
        for (const [table, kept] of Object.entries(prev)) {
          if (model?.byName.has(table)) {
            next[table] = kept;
          }
        }
        next[current.name] = point;
        savePositions(storageKey, next);
        return next;
      });
    }
  }

  function onPointerOver(event: ReactPointerEvent<HTMLDivElement>): void {
    if (gesture.current === null) {
      setHovered(cardAt(event.target));
    }
  }

  function onDoubleClick(event: ReactMouseEvent<HTMLDivElement>): void {
    const name = cardAt(event.target);
    if (name !== null) {
      onOpenData(name);
    }
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.key === "Escape" && selected !== null) {
      event.preventDefault();
      event.stopPropagation();
      setSelected(null);
    }
  }

  function resetLayout(): void {
    savePositions(storageKey, {});
    setSaved({});
    pendingFit.current = true;
  }

  function toggleKeysOnly(next: boolean): void {
    setKeysOnly(next);
    try {
      window.localStorage.setItem(KEYS_ONLY_KEY, next ? "1" : "0");
    } catch {
      /* 저장 실패는 무시 */
    }
  }

  // Tables matching the search: exact name, then names starting with it,
  // then names containing it.
  const query = useDeferredValue(search.trim().toLowerCase());
  const matches = useMemo(() => {
    if (model === null || query === "") {
      return [];
    }
    const scored: [number, string][] = [];
    for (const card of model.cards) {
      const name = card.name.toLowerCase();
      const at = name.indexOf(query);
      if (at >= 0) {
        scored.push([name === query ? 0 : at === 0 ? 1 : 2, card.name]);
      }
    }
    scored.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]));
    return scored.map(([, name]) => name);
  }, [model, query]);
  const matchSet = useMemo(() => new Set(matches), [matches]);

  function goToMatch(index: number): void {
    if (matches.length === 0) {
      return;
    }
    const wrapped = ((index % matches.length) + matches.length) % matches.length;
    setMatchIndex(wrapped);
    setSelected(matches[wrapped]);
    centreOn(matches[wrapped], true);
  }

  // Typing jumps to the best match as it changes.
  useEffect(() => {
    setMatchIndex(0);
    if (matches.length > 0) {
      setSelected(matches[0]);
      centreOn(matches[0], true);
    }
    // Only a new match list moves the view, not a card moved meanwhile.
  }, [matches]);

  const active = hovered ?? selected;
  const highlight = useMemo(() => {
    if (model === null || active === null || !model.byName.has(active)) {
      return null;
    }
    const near = new Set<string>([active]);
    const on = new Set<string>();
    const hot = new Map<string, Set<number>>();
    const mark = (table: string, row: number): void => {
      if (row >= 0) {
        const rows = hot.get(table) ?? new Set<number>();
        rows.add(row);
        hot.set(table, rows);
      }
    };
    for (const link of model.links) {
      if (link.from === active || link.to === active) {
        on.add(link.key);
        near.add(link.from);
        near.add(link.to);
        mark(link.from, link.fromRow);
        mark(link.to, link.toRow);
      }
    }
    return { active, near, on, hot };
  }, [model, active]);

  const links = useMemo(() => {
    if (model === null) {
      return { under: [], over: [] };
    }
    const drawn = model.links.map((link) => {
      const from = model.byName.get(link.from)!;
      const to = model.byName.get(link.to)!;
      const a = positionOf(link.from);
      const b = positionOf(link.to);
      const geometry = linkGeometry(
        { x: a.x, y: a.y, width: from.width },
        rowY(a.y, link.fromRow),
        { x: b.x, y: b.y, width: to.width },
        rowY(b.y, link.toRow),
        link.from === link.to,
      );
      const state = highlight === null ? "" : highlight.on.has(link.key) ? "on" : "dim";
      return { key: link.key, state, ...geometry };
    });
    // Highlighted lines go in a layer over the cards, the rest under them.
    return {
      under: drawn.filter((link) => link.state !== "on"),
      over: drawn.filter((link) => link.state === "on"),
    };
  }, [model, positionOf, highlight]);

  const empty = model !== null && model.cards.length === 0;

  return (
    <div className="panel er-panel">
      <div className="panel-head er-head">
        <span className="panel-title">{t("ER 다이어그램")}</span>
        <span className="panel-stat">{t("테이블 {count}개", { count: model === null ? "…" : model.cards.length })}</span>
        <span className="panel-stat">{t("관계 {count}개", { count: model === null ? "…" : model.relationCount })}</span>
        <div className="er-search">
          <SearchIcon size={10} className="er-search-icon" />
          <input
            value={search}
            placeholder={t("테이블 찾기")}
            spellCheck={false}
            aria-label={t("테이블 찾기")}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                goToMatch(matchIndex + (event.shiftKey ? -1 : 1) * (matches[matchIndex] === selected ? 1 : 0));
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                if (search !== "") {
                  setSearch("");
                } else {
                  viewportRef.current?.focus({ preventScroll: true });
                }
              }
            }}
          />
          {query !== "" ? (
            <span className="er-search-count">
              {matches.length === 0 ? t("없음") : `${matchIndex + 1}/${matches.length}`}
            </span>
          ) : null}
        </div>
        <span className="spacer" />
        {loading && tables !== null ? (
          <span className="panel-dim delayed-in">
            <Spinner size={10} /> {t("불러오는 중…")}
          </span>
        ) : null}
        <div className="segmented er-columns-toggle" role="group" aria-label={t("표시할 컬럼")}>
          <button type="button" className={keysOnly ? "" : "active"} onClick={() => toggleKeysOnly(false)}>
            {t("모든 컬럼")}
          </button>
          <button type="button" className={keysOnly ? "active" : ""} onClick={() => toggleKeysOnly(true)}>
            {t("키만")}
          </button>
        </div>
        <div className="er-zoom">
          <button type="button" className="icon-button" title={t("축소")} onClick={() => zoomBy(1 / 1.25)}>
            <MinusIcon size={10} />
          </button>
          <span ref={zoomLabelRef} className="er-zoom-label">
            {Math.round(view.current.k * 100)}%
          </span>
          <button type="button" className="icon-button" title={t("확대")} onClick={() => zoomBy(1.25)}>
            <PlusIcon size={10} />
          </button>
          <button type="button" className="icon-button" title={t("화면에 맞추기")} onClick={() => fit(true)}>
            <FitIcon size={10} />
          </button>
        </div>
        <button
          type="button"
          className="icon-text-button"
          disabled={Object.keys(saved).length === 0}
          title={t("옮긴 카드를 자동 배치로 되돌립니다")}
          onClick={resetLayout}
        >
          {t("배치 초기화")}
        </button>
        <button
          type="button"
          className="icon-button"
          disabled={loading}
          title={t("다이어그램 새로고침")}
          onClick={() => {
            forceRef.current = true;
            setNonce((value) => value + 1);
          }}
        >
          <RefreshIcon size={11} />
        </button>
      </div>
      <div
        ref={viewportRef}
        className="er-viewport"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerOver={onPointerOver}
        onPointerLeave={() => {
          if (gesture.current === null) {
            setHovered(null);
          }
        }}
        onDoubleClick={onDoubleClick}
        onKeyDown={onKeyDown}
      >
        <div ref={worldRef} className="er-world">
          <svg className="er-links" aria-hidden="true">
            {links.under.map((link) => (
              <LinkView key={link.key} line={link.line} marks={link.marks} state={link.state} />
            ))}
          </svg>
          {model?.cards.map((card) => {
            const point = positionOf(card.name);
            const state: CardState =
              highlight === null ? "" : highlight.active === card.name ? "focus" : highlight.near.has(card.name) ? "near" : "dim";
            return (
              <CardView
                key={card.name}
                card={card}
                x={point.x}
                y={point.y}
                state={state}
                match={matchSet.has(card.name)}
                lift={live !== null && live.name === card.name ? "dragging" : raised === card.name ? "raised" : ""}
                hot={highlight?.hot.get(card.name)}
              />
            );
          })}
          <svg className="er-links" aria-hidden="true">
            {links.over.map((link) => (
              <LinkView key={link.key} line={link.line} marks={link.marks} state={link.state} />
            ))}
          </svg>
        </div>
        {tables === null && error === null ? <LoadingState variant="overlay" /> : null}
        {error !== null ? (
          <div className="er-overlay">
            <ErrorNotice message={error} />
          </div>
        ) : null}
        {empty ? <div className="panel-empty er-empty">{t("테이블이 없습니다")}</div> : null}
        {relationsFailed && !empty ? (
          <div className="er-note" role="status">
            {t("관계(외래 키)를 불러오지 못해 테이블만 표시합니다")}
          </div>
        ) : null}
      </div>
    </div>
  );
}
