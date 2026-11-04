import { useLayoutEffect, useRef, type RefObject } from "react";
import { DURATION, EASE, animate, flip, ghost, measure, type Rects } from "../motion";

// Tab strips (query/table tabs, connection tabs) move like liquid: one
// highlight per strip pours from tab to tab, its leading edge racing ahead
// and the tail catching up; a new tab buds out of the tab beside it, a
// closed one melts into the neighbour taking its place, and the rest slide
// over. Each tab is a direct child of the strip marked data-motion-key; the
// highlight is an empty element in the strip, drawn under the active tab
// (which goes clear, so the highlight is its look).

// How long each edge of the highlight takes to reach the next tab.
const LEAD = 180;
const TAIL = 320;

type Side = "left" | "right";

const keyOf = (element: HTMLElement): string | undefined => element.dataset.motionKey;

function itemsOf(strip: HTMLElement): HTMLElement[] {
  return [...strip.querySelectorAll<HTMLElement>(":scope > [data-motion-key]")];
}

// A box in the strip's scrolled content: what the highlight's left/top mean,
// so it rides along with the strip's scroll for free.
interface Place {
  left: number;
  top: number;
  width: number;
  height: number;
}

function within(strip: HTMLElement, rect: Place): Place {
  const box = strip.getBoundingClientRect();
  return {
    left: rect.left - box.left - strip.clientLeft + strip.scrollLeft,
    top: rect.top - box.top - strip.clientTop + strip.scrollTop,
    width: rect.width,
    height: rect.height,
  };
}

// Where a tab will rest: its box with any slide or bud in flight taken back
// out, so the highlight heads for where the tab ends up, not a frame of it.
function restingPlace(item: HTMLElement, strip: HTMLElement): Place {
  const rect = item.getBoundingClientRect();
  const style = getComputedStyle(item);
  const [ox = 0, oy = 0] = style.transformOrigin.split(" ").map(parseFloat);
  const [tx = 0, ty = 0] = style.translate === "none" ? [] : style.translate.split(" ").map(parseFloat);
  const [sx = 1, sy = sx] = style.scale === "none" ? [] : style.scale.split(" ").map(parseFloat);
  const shown = new DOMMatrix()
    .translateSelf(ox + tx, oy + ty)
    .scaleSelf(sx, sy)
    .multiplySelf(style.transform === "none" ? new DOMMatrix() : new DOMMatrix(style.transform))
    .translateSelf(-ox, -oy);
  // Tabs only ever slide and stretch; a bud's first frame is too thin to
  // read its size from, so take it as laid out then.
  if (shown.a < 0.05 || shown.d < 0.05) {
    return within(strip, { left: rect.left, top: rect.top, width: item.offsetWidth, height: item.offsetHeight });
  }
  return within(strip, {
    left: rect.left - shown.e,
    top: rect.top - shown.f,
    width: rect.width / shown.a,
    height: rect.height / shown.d,
  });
}

function samePlace(a: Place, b: Place): boolean {
  return (
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

const px = (value: number): string => `${value}px`;

interface Highlight {
  // Where it rests (null while there's no active tab to sit under).
  placed: Place | null;
  // The strip width its `right` was worked out against.
  span: number;
  pours: Animation[];
}

// "pour": to a newly active tab, edges apart. "glide": with the same tab as
// it slides, in step with its move. "jump": straight there (first showing,
// resizes), and only if it's actually somewhere else.
type How = "pour" | "glide" | "jump";

function moveHighlight(
  strip: HTMLElement,
  indicator: HTMLElement,
  item: HTMLElement | undefined,
  state: Highlight,
  how: How,
): void {
  if (item === undefined) {
    for (const pour of state.pours) {
      pour.cancel();
    }
    state.pours = [];
    state.placed = null;
    indicator.hidden = true;
    return;
  }
  const to = restingPlace(item, strip);
  const span = strip.clientWidth;
  const was = state.placed;
  if (how === "jump" && was !== null && span === state.span && samePlace(was, to)) {
    return;
  }
  // Where it shows right now (mid-pour or not), read before stopping that.
  const from = was === null || how === "jump" ? null : within(strip, indicator.getBoundingClientRect());
  for (const pour of state.pours) {
    pour.cancel();
  }
  state.pours = [];
  state.placed = to;
  state.span = span;
  indicator.hidden = false;
  // Left and right rather than a width, so each edge can keep its own time.
  const right = (place: Place): string => px(span - place.left - place.width);
  Object.assign(indicator.style, { left: px(to.left), right: right(to), top: px(to.top), height: px(to.height) });
  if (from === null || samePlace(from, to)) {
    return;
  }
  const lead = { duration: LEAD, easing: EASE.out };
  const tail = { duration: TAIL, easing: EASE.spring };
  const together = { duration: DURATION.spring, easing: EASE.spring };
  const rightward = to.left + to.width / 2 >= from.left + from.width / 2;
  const [leftTiming, rightTiming] = how === "glide" ? [together, together] : rightward ? [tail, lead] : [lead, tail];
  for (const pour of [
    animate(
      indicator,
      { left: [px(from.left), px(to.left)], top: [px(from.top), px(to.top)], height: [px(from.height), px(to.height)] },
      leftTiming,
    ),
    animate(indicator, { right: [right(from), right(to)] }, rightTiming),
  ]) {
    if (pour !== null) {
      state.pours.push(pour);
    }
  }
}

// A new tab grows out of the edge it shares with the neighbour on `side`.
function bud(item: HTMLElement, side: Side): void {
  item.style.transformOrigin = `${side} center`;
  const grow = animate(item, [{ scale: "0.2 1" }, { scale: "1 1" }], { duration: DURATION.spring, easing: EASE.spring });
  animate(item, [{ opacity: 0 }, { opacity: 1 }], { duration: DURATION.base, easing: EASE.out });
  const done = (): void => {
    item.style.transformOrigin = "";
  };
  if (grow === null) {
    done();
  } else {
    grow.onfinish = done;
    grow.oncancel = done;
  }
}

// A closed tab shrinks into the edge the neighbour taking its place comes
// from, smudging as it goes.
function melt(side: Side): Keyframe[] {
  const transformOrigin = `${side} center`;
  return [
    { transformOrigin, scale: "1 1", opacity: 1, filter: "blur(0px)" },
    { transformOrigin, scale: "0 1", opacity: 0, filter: "blur(3px)" },
  ];
}

interface Change {
  order: string;
  // False when no tab survived (another connection's tabs): nothing to bud
  // from, melt into or slide, so the strip just shows the new set.
  continued: boolean;
  before: Rects;
  buds: Map<string, Side>;
  ghosts: (() => void)[];
}

export function useTabMotion(
  stripRef: RefObject<HTMLElement | null>,
  indicatorRef: RefObject<HTMLElement | null>,
  keys: readonly string[],
  activeKey: string | null,
): void {
  const order = keys.join("\n");
  const committed = useRef<{ order: string; keys: readonly string[]; active: string | null } | null>(null);
  const change = useRef<Change | null>(null);
  const highlight = useRef<Highlight>({ placed: null, span: 0, pours: [] });
  const activeRef = useRef(activeKey);
  const observer = useRef<ResizeObserver | null>(null);

  // Render is the last moment the old tabs are on the page: note where each
  // is and copy the ones about to go, for the layout effect to play from.
  const last = committed.current;
  const strip = stripRef.current;
  if (strip !== null && last !== null && last.order !== order) {
    const items = itemsOf(strip);
    const was = new Set(last.keys);
    const now = new Set(keys);
    const continued = keys.some((key) => was.has(key));
    const buds = new Map<string, Side>();
    const ghosts: (() => void)[] = [];
    if (continued) {
      for (const [index, key] of last.keys.entries()) {
        const element = items.find((item) => keyOf(item) === key);
        if (now.has(key) || element === undefined) {
          continue;
        }
        // The next surviving tab slides over into its space; past the last
        // one, the one before stretches into it.
        const side = last.keys.slice(index + 1).some((other) => now.has(other)) ? "right" : "left";
        ghosts.push(ghost(element, melt(side), { duration: DURATION.slow, easing: EASE.out }));
      }
      for (const [index, key] of keys.entries()) {
        if (was.has(key)) {
          continue;
        }
        const prev: string | undefined = keys[index - 1];
        const next: string | undefined = keys[index + 1];
        const old = (other: string | undefined): boolean => other !== undefined && was.has(other);
        // Out of the tab it was opened from, else whichever neighbour was there.
        const side =
          old(prev) && prev === last.active
            ? "left"
            : old(next) && next === last.active
              ? "right"
              : old(prev)
                ? "left"
                : old(next)
                  ? "right"
                  : null;
        if (side !== null) {
          buds.set(key, side);
        }
      }
    }
    change.current = { order, continued, before: continued ? measure(items, keyOf) : new Map(), buds, ghosts };
  }

  useLayoutEffect(() => {
    const strip = stripRef.current;
    const indicator = indicatorRef.current;
    const last = committed.current;
    const moved = change.current?.order === order ? change.current : null;
    change.current = null;
    committed.current = { order, keys, active: activeKey };
    activeRef.current = activeKey;
    if (strip === null || indicator === null) {
      return;
    }
    const items = itemsOf(strip);
    if (moved !== null && moved.continued) {
      flip(items, keyOf, moved.before, {
        onEnter: (element) => {
          const side = moved.buds.get(keyOf(element) ?? "");
          if (side !== undefined) {
            bud(element, side);
          }
        },
      });
    }
    const continued = moved === null || moved.continued;
    const how: How =
      last === null || !continued ? "jump" : last.active !== activeKey ? "pour" : moved !== null ? "glide" : "jump";
    const active = items.find((item) => keyOf(item) === activeKey);
    moveHighlight(strip, indicator, active, highlight.current, how);
    for (const play of moved?.ghosts ?? []) {
      play();
    }
    // Any tab or the strip resizing (window, theme, a renamed tab) moves the
    // active tab without a render here: follow it there directly.
    const watch = observer.current;
    if (watch !== null) {
      watch.disconnect();
      watch.observe(strip);
      for (const item of items) {
        watch.observe(item);
      }
    }
    // Keys and the active key are all that move tabs; `order` stands for keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order, activeKey]);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    const indicator = indicatorRef.current;
    if (strip === null || indicator === null) {
      return;
    }
    const watch = new ResizeObserver(() => {
      const active = itemsOf(strip).find((item) => keyOf(item) === activeRef.current);
      moveHighlight(strip, indicator, active, highlight.current, "jump");
    });
    watch.observe(strip);
    for (const item of itemsOf(strip)) {
      watch.observe(item);
    }
    observer.current = watch;
    return () => {
      watch.disconnect();
      observer.current = null;
    };
  }, [stripRef, indicatorRef]);
}
