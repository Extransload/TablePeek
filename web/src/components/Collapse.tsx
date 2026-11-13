import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
  type RefObject,
} from "react";
import { DURATION, EASE, ghost, reducedMotion, type PlayGhost } from "../motion";

// Everything that opens and closes in place moves the same way, through one
// of two pieces here:
//
// - `Collapse`, for content that is ordinary DOM (a sidebar node's rows, a
//   form section, a detail block): it grows from nothing to its height as it
//   fades in and shrinks back as it fades out, so what follows it moves with
//   it, and only then leaves the page. A toggle mid-way turns back from where
//   it is.
// - `useRowMotion`, for trees drawn as a flat run of rows worked out from
//   which nodes are open (virtualized or not): the rows a node opens drop in
//   one after another, the rows it closes fade out where they were (copies,
//   as React has dropped them), and the rows below glide to where they now are.
//
// Both touch only what's on screen, so a node with thousands of children
// opens as smoothly as one with three, and with Reduce motion on both jump
// straight to the end. Chevrons turn by CSS (styles.css, "Disclosure chevrons").

// Up to this many rows arrive one after another; the rest come with the last.
const STAGGER_ROWS = 20;
const STAGGER_STEP = 18;
// How far an arriving row drops from, and a leaving one rises to.
const DRIFT = 6;

// The properties `Collapse` animates; the shut end has them at zero.
const BOX = [
  "height",
  "paddingTop",
  "paddingBottom",
  "borderTopWidth",
  "borderBottomWidth",
  "marginTop",
  "marginBottom",
  "opacity",
] as const;
type Box = Record<(typeof BOX)[number], string>;

function boxOf(element: HTMLElement): Box {
  const style = getComputedStyle(element);
  return {
    height: `${element.getBoundingClientRect().height}px`,
    paddingTop: style.paddingTop,
    paddingBottom: style.paddingBottom,
    borderTopWidth: style.borderTopWidth,
    borderBottomWidth: style.borderBottomWidth,
    marginTop: style.marginTop,
    marginBottom: style.marginBottom,
    opacity: style.opacity,
  };
}

// The gap a flex or grid column puts beside the element: shut, it pulls that
// back too, so the space it held closes all the way.
function gapBeside(element: HTMLElement): number {
  const parent = element.parentElement;
  if (parent === null || (element.previousElementSibling === null && element.nextElementSibling === null)) {
    return 0;
  }
  const style = getComputedStyle(parent);
  const column = style.display.includes("grid") || (style.display.includes("flex") && style.flexDirection.startsWith("column"));
  return column ? parseFloat(style.rowGap) || 0 : 0;
}

// Rows arriving: the first few in sight drop in one after another.
function arrive(rows: Iterable<Element>): void {
  const bottom = window.innerHeight;
  let index = 0;
  for (const row of rows) {
    const rect = row.getBoundingClientRect();
    if (rect.top > bottom) {
      break;
    }
    if (rect.bottom < 0) {
      continue;
    }
    row.animate([{ opacity: 0, translate: `0 ${-DRIFT}px` }, { opacity: 1, translate: "0 0" }], {
      duration: DURATION.slow,
      delay: Math.min(index, STAGGER_ROWS) * STAGGER_STEP,
      easing: EASE.out,
      fill: "backwards",
    });
    index += 1;
  }
}

interface CollapseProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  open: boolean;
  // A function is called only while open, so closed content costs nothing.
  children?: ReactNode | (() => ReactNode);
  // The direct children are rows: they drop in one after another as it opens.
  stagger?: boolean;
}

// For this long after it opens, content that arrives late (rows read from
// the server, an editor that mounts a frame later) grows into place too.
const SETTLE = 1000;

// A block that opens and closes. Closed, its content isn't on the page; while
// it closes, what it showed last stays, inert, until the motion ends.
export function Collapse({ open, children, stagger = false, ...rest }: CollapseProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [present, setPresent] = useState(open);
  if (open && !present) {
    setPresent(true);
  }
  const kept = useRef<ReactNode>(null);
  if (open) {
    kept.current = typeof children === "function" ? children() : children;
  }
  // Whether it was open as of the last commit (null before the first).
  const was = useRef<boolean | null>(null);
  const playing = useRef<Animation | null>(null);
  // Its height at rest, and until when a change to it is played.
  const resting = useRef<number | null>(null);
  const settle = useRef(0);

  // Plays `frames` clipped (`clip`, unlike `hidden`, lets margins through as
  // they are at rest), heights measured border to border; `done` runs at the
  // end (given what puts the styles back), else it simply rests again.
  const play = (
    element: HTMLElement,
    frames: Keyframe[],
    options: KeyframeAnimationOptions,
    done?: (restore: () => void) => void,
  ) => {
    const saved = { overflow: element.style.overflow, boxSizing: element.style.boxSizing };
    element.style.overflow = "clip";
    element.style.boxSizing = "border-box";
    const animation = element.animate(frames, options);
    playing.current = animation;
    const restore = () => {
      element.style.overflow = saved.overflow;
      element.style.boxSizing = saved.boxSizing;
    };
    animation.oncancel = restore;
    animation.onfinish = () => {
      if (done !== undefined) {
        done(restore);
        return;
      }
      restore();
      playing.current = null;
      resting.current = element.getBoundingClientRect().height;
    };
  };

  // From one height to another, what's past the bottom of the window aside.
  const grow = (element: HTMLElement, from: number, to: number) => {
    const room = Math.max(0, window.innerHeight - element.getBoundingClientRect().top) + 24;
    if (Math.abs(Math.min(from, room) - Math.min(to, room)) < 1) {
      resting.current = to;
      return;
    }
    play(element, [{ height: `${Math.min(from, room)}px` }, { height: `${Math.min(to, room)}px` }], {
      duration: DURATION.slow,
      easing: EASE.out,
    });
  };

  useLayoutEffect(() => {
    const before = was.current;
    was.current = open;
    const element = ref.current;
    if (before === null || before === open || element === null) {
      return;
    }
    element.inert = !open;
    const running = playing.current;
    // Turned back mid-way: from wherever it has got to.
    const from = running !== null ? boxOf(element) : null;
    running?.cancel();
    playing.current = null;
    if (reducedMotion()) {
      if (!open) {
        setPresent(false);
      }
      return;
    }
    const full = boxOf(element);
    full.opacity = "1";
    const shut: Box = {
      height: "0px",
      paddingTop: "0px",
      paddingBottom: "0px",
      borderTopWidth: "0px",
      borderBottomWidth: "0px",
      marginTop: `${-gapBeside(element)}px`,
      marginBottom: "0px",
      opacity: "0",
    };
    // Past the bottom of the window nothing is seen: the motion covers what's
    // in sight, and the rest is laid out once, at the end, out of sight.
    const top = element.getBoundingClientRect().top;
    const room = Math.max(0, window.innerHeight - top) + 24;
    if (parseFloat(full.height) > room) {
      full.height = `${room}px`;
    }
    if (from !== null && parseFloat(from.height) > room) {
      from.height = `${room}px`;
    }
    const start = from ?? (open ? shut : full);
    const end = open ? full : shut;
    if (open) {
      settle.current = performance.now() + DURATION.slow + SETTLE;
      play(element, [start, end], { duration: DURATION.slow, easing: EASE.out }, (restore) => {
        restore();
        playing.current = null;
        // What came in while it opened grows on from where it got to.
        grow(element, parseFloat(end.height), element.getBoundingClientRect().height);
      });
    } else {
      // Held shut by the fill until it leaves the page.
      play(element, [start, end], { duration: DURATION.slow, easing: EASE.inOut, fill: "forwards" }, () =>
        setPresent(false),
      );
    }
    if (open && stagger && from === null) {
      arrive(element.children);
    }
    // Only opening or closing moves it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Open and at rest, a change in its height soon after it opened plays.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!present || element === null) {
      playing.current = null;
      resting.current = null;
      return;
    }
    const observer = new ResizeObserver(() => {
      if (playing.current !== null) {
        return;
      }
      const height = element.getBoundingClientRect().height;
      const last = resting.current;
      if (last !== null && Math.abs(height - last) >= 1 && performance.now() < settle.current && !reducedMotion()) {
        grow(element, last, height);
      } else {
        resting.current = height;
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
    // The element is there for as long as it's present.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [present]);

  return present ? (
    <div ref={ref} {...rest}>
      {kept.current}
    </div>
  ) : null;
}

// Rows of a flat tree are found by this attribute, their identity across a
// change (a node's path, say). Copies drop it, so they're never mistaken for
// the real thing. A row's depth (`aria-level`, or ROW_DEPTH where that role
// has none) tells a node's children from the rows after it when they fill
// the whole view, so the motion can't tell one from the other by position.
export const ROW_KEY = "data-row-key";
export const ROW_DEPTH = "data-row-depth";

interface RowShot {
  // Rows in sight, top to bottom, where each was and how deep it sat.
  keys: string[];
  rects: Map<string, DOMRect>;
  depths: Map<string, number>;
  // A copy of each, played if its row goes.
  leave: Map<string, PlayGhost>;
  at: number;
}

// NaN where the row doesn't say.
function depthOf(row: Element): number {
  return Number(row.getAttribute("aria-level") ?? row.getAttribute(ROW_DEPTH) ?? Number.NaN);
}

const moving = new WeakMap<Element, Animation>();

// The keyed rows in sight in `list` (its scrollport), top to bottom. Rows run
// down in document order, so the first in sight is found by halving.
function rowsInSight(list: HTMLElement): HTMLElement[] {
  const rows = list.querySelectorAll<HTMLElement>(`[${ROW_KEY}]`);
  const view = list.getBoundingClientRect();
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (rows[middle].getBoundingClientRect().bottom < view.top) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const found: HTMLElement[] = [];
  for (let index = low; index < rows.length; index += 1) {
    if (rows[index].getBoundingClientRect().top > view.bottom) {
      break;
    }
    found.push(rows[index]);
  }
  return found;
}

function snapshot(list: HTMLElement): RowShot {
  const keys: string[] = [];
  const rects = new Map<string, DOMRect>();
  const depths = new Map<string, number>();
  const leave = new Map<string, PlayGhost>();
  for (const row of rowsInSight(list)) {
    const key = row.getAttribute(ROW_KEY) ?? "";
    keys.push(key);
    rects.set(key, row.getBoundingClientRect());
    depths.set(key, depthOf(row));
    leave.set(key, ghost(row, [], {}));
  }
  return { keys, rects, depths, leave, at: performance.now() };
}

function glide(row: HTMLElement, dy: number): void {
  moving.set(
    row,
    row.animate([{ translate: `0 ${dy}px` }, { translate: "0 0" }], { duration: DURATION.spring, easing: EASE.spring }),
  );
}

function play(list: HTMLElement, shot: RowShot): void {
  const now = rowsInSight(list);
  // Whatever was moving starts over from where it appears to be.
  for (const row of now) {
    moving.get(row)?.cancel();
  }
  const found = new Map<string, HTMLElement>();
  for (const key of shot.keys) {
    const row = list.querySelector<HTMLElement>(`[${ROW_KEY}="${CSS.escape(key)}"]`);
    if (row !== null) {
      moving.get(row)?.cancel();
      found.set(key, row);
    }
  }
  // Each staying row's offset back to where it was.
  const offsets = new Map<string, number>();
  for (const [key, row] of found) {
    const was = shot.rects.get(key);
    if (was !== undefined) {
      offsets.set(key, was.top - row.getBoundingClientRect().top);
    }
  }
  // Whether a row (a depth) sits under the staying row `parent` as its child
  // (never where depths aren't known).
  const under = (depth: number, parent: string | null): boolean => {
    const top = parent === null ? Number.NaN : (shot.depths.get(parent) ?? Number.NaN);
    return depth > top;
  };
  // The rows gone that were children of the staying row right above them (a
  // run of deeper rows), and their height under each such row.
  const children = new Set<string>();
  const closed = new Map<string, number>();
  let owner: string | null = null;
  for (const key of shot.keys) {
    if (found.has(key)) {
      owner = key;
    } else if (owner !== null && under(shot.depths.get(key) ?? Number.NaN, owner)) {
      children.add(key);
      closed.set(owner, (closed.get(owner) ?? 0) + (shot.rects.get(key)?.height ?? 0));
    } else {
      owner = null;
    }
  }
  // Rows new to the screen: below a row that moved they came along with it;
  // under one that closed children they rose from past the fold in their
  // place; otherwise a node opened them.
  const arriving: HTMLElement[] = [];
  // The height of the rows opened right under each staying row.
  const opened = new Map<string, number>();
  let previous: string | null = null;
  for (const row of now) {
    const key = row.getAttribute(ROW_KEY) ?? "";
    if (offsets.has(key)) {
      previous = key;
      continue;
    }
    const along = previous === null ? 0 : (offsets.get(previous) ?? 0);
    if (Math.abs(along) >= 0.5) {
      glide(row, along);
      continue;
    }
    const rose = previous === null ? 0 : (closed.get(previous) ?? 0);
    if (rose > 0 && !under(depthOf(row), previous)) {
      glide(row, rose);
      continue;
    }
    arriving.push(row);
    if (previous !== null) {
      opened.set(previous, (opened.get(previous) ?? 0) + row.getBoundingClientRect().height);
    }
  }
  for (const [key, row] of found) {
    const dy = offsets.get(key) ?? 0;
    if (Math.abs(dy) >= 0.5) {
      glide(row, dy);
    }
  }
  // Rows gone: pushed past the fold by rows opened above them, they slide
  // down with the rest; closed away, they fade where they were.
  const leaving: [PlayGhost, number][] = [];
  let push = 0;
  for (const key of shot.keys) {
    if (found.has(key)) {
      const offset = offsets.get(key) ?? 0;
      push = Math.abs(offset) >= 0.5 ? -offset : (opened.get(key) ?? 0);
      continue;
    }
    const leave = shot.leave.get(key);
    if (leave !== undefined) {
      leaving.push([leave, children.has(key) ? 0 : push]);
    }
  }
  // All in, then all placed: the list is laid out once for them.
  for (const [leave] of leaving) {
    leave.insert();
  }
  for (const [leave, by] of leaving) {
    if (by > 0) {
      leave.start([{ translate: "0 0" }, { translate: `0 ${by}px` }], { duration: DURATION.spring, easing: EASE.spring });
    } else {
      leave.start([{ opacity: 1, translate: "0 0" }, { opacity: 0, translate: `0 ${-DRIFT}px` }], {
        duration: DURATION.base,
        easing: EASE.out,
      });
    }
  }
  arriving.forEach((row, index) => {
    moving.set(
      row,
      row.animate([{ opacity: 0, translate: `0 ${-DRIFT}px` }, { opacity: 1, translate: "0 0" }], {
        duration: DURATION.slow,
        delay: Math.min(index, STAGGER_ROWS) * STAGGER_STEP,
        easing: EASE.out,
        fill: "backwards",
      }),
    );
  });
}

// For a flat tree in `list` (the element that scrolls it), whose rows carry
// ROW_KEY. Call the result just before a change that opens or closes nodes;
// the render it causes plays the motion.
export function useRowMotion(list: RefObject<HTMLElement | null>): () => void {
  const pending = useRef<RowShot | null>(null);
  useLayoutEffect(() => {
    const shot = pending.current;
    const element = list.current;
    pending.current = null;
    // A note nothing re-rendered for straight away is stale.
    if (shot !== null && element !== null && performance.now() - shot.at < 150) {
      play(element, shot);
    }
  });
  return useCallback(() => {
    const element = list.current;
    if (element !== null && !reducedMotion()) {
      pending.current = snapshot(element);
    }
  }, [list]);
}
