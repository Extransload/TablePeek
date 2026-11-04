import { useLayoutEffect, type RefObject } from "react";

// Motion CSS can't express alone: things moving from where they were (FLIP),
// things leaving after React has dropped them (ghosts), springs played from
// script. The values mirror the tokens in styles.css (--motion-*, --ease-*);
// under reduced motion everything here jumps straight to its end.

export const DURATION = {
  instant: 80,
  fast: 120,
  base: 160,
  slow: 260,
  slower: 420,
  spring: 520,
} as const;

// A damped spring sampled for linear(): ~4% overshoot, and a livelier ~12%.
const SPRING =
  "linear(0, 0.059, 0.194, 0.359, 0.524, 0.672, 0.793, 0.886, 0.952, 0.996, 1.022, 1.035, 1.038, 1.036, 1.031, 1.025, 1.019, 1.013, 1.008, 1.005, 1.002, 1, 0.999, 1)";
const SPRING_BOUNCY =
  "linear(0, 0.071, 0.238, 0.445, 0.65, 0.827, 0.963, 1.055, 1.107, 1.126, 1.121, 1.103, 1.077, 1.051, 1.027, 1.009, 0.996, 0.988, 0.984, 0.984, 0.986, 0.989, 0.993, 0.996, 0.998, 1)";
const linearEasing = typeof CSS !== "undefined" && CSS.supports("transition-timing-function", "linear(0, 1)");

export const EASE = {
  out: "cubic-bezier(0.22, 1, 0.36, 1)",
  in: "cubic-bezier(0.55, 0, 1, 0.45)",
  inOut: "cubic-bezier(0.65, 0, 0.35, 1)",
  spring: linearEasing ? SPRING : "cubic-bezier(0.3, 1.25, 0.5, 1)",
  springBouncy: linearEasing ? SPRING_BOUNCY : "cubic-bezier(0.34, 1.56, 0.64, 1)",
} as const;

const reducedQuery = typeof window !== "undefined" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;

export function reducedMotion(): boolean {
  return reducedQuery?.matches ?? false;
}

// Element.animate, skipped under reduced motion (the element simply is where
// it ends up). Null when nothing plays.
export function animate(
  element: Element,
  keyframes: Keyframe[] | PropertyIndexedKeyframes,
  options: KeyframeAnimationOptions,
): Animation | null {
  if (reducedMotion() || typeof element.animate !== "function") {
    return null;
  }
  return element.animate(keyframes, options);
}

// FLIP moves are tracked per element, so a new one starts from wherever the
// last one had got to instead of jumping.
const flips = new WeakMap<Element, Animation>();

export type Rects = Map<string, DOMRect>;

// Where each keyed element is on screen now (mid-move ones where they appear).
export function measure(elements: Iterable<HTMLElement>, keyOf: (element: HTMLElement) => string | undefined): Rects {
  const rects: Rects = new Map();
  for (const element of elements) {
    const key = keyOf(element);
    if (key !== undefined) {
      rects.set(key, element.getBoundingClientRect());
    }
  }
  return rects;
}

export interface FlipOptions {
  duration?: number;
  easing?: string;
  // Elements that weren't there before: how they arrive (none by default),
  // or a callback that animates each itself (`index` counts the arrivals).
  enter?: Keyframe[];
  onEnter?: (element: HTMLElement, index: number) => void;
}

// Plays each keyed element from where `before` saw it to where layout has
// put it now. Call after the DOM has changed, before paint (a layout effect).
export function flip(
  elements: Iterable<HTMLElement>,
  keyOf: (element: HTMLElement) => string | undefined,
  before: Rects,
  { duration = DURATION.spring, easing = EASE.spring, enter, onEnter }: FlipOptions = {},
): void {
  if (reducedMotion()) {
    return;
  }
  const moves: [HTMLElement, number, number][] = [];
  const entering: HTMLElement[] = [];
  // Read everything first, then write, so layout is worked out once.
  const list = [...elements];
  for (const element of list) {
    flips.get(element)?.cancel();
  }
  for (const element of list) {
    const key = keyOf(element);
    const was = key === undefined ? undefined : before.get(key);
    if (was === undefined) {
      entering.push(element);
      continue;
    }
    const now = element.getBoundingClientRect();
    const dx = was.left - now.left;
    const dy = was.top - now.top;
    if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5) {
      moves.push([element, dx, dy]);
    }
  }
  for (const [element, dx, dy] of moves) {
    const animation = element.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
      duration,
      easing,
    });
    flips.set(element, animation);
    animation.onfinish = () => flips.delete(element);
  }
  for (const [index, element] of entering.entries()) {
    if (enter !== undefined) {
      flips.set(element, element.animate(enter, { duration, easing }));
    }
    onEnter?.(element, index);
  }
}

// A copy is for show: nothing that finds elements by id, tab stop or data
// attribute (keyboard walks, drop zones) may mistake it for the real thing,
// and assistive tech skips it (its aria stays, for the styles keyed on it).
export function unhook(copy: HTMLElement): void {
  for (const node of [copy, ...copy.querySelectorAll<HTMLElement>("*")]) {
    node.removeAttribute("id");
    node.removeAttribute("tabindex");
    for (const name of node.getAttributeNames()) {
      if (name.startsWith("data-")) {
        node.removeAttribute(name);
      }
    }
  }
  copy.setAttribute("aria-hidden", "true");
  copy.inert = true;
}

// A stand-in for an element about to leave the page: a copy laid exactly over
// it, beside it in the same parent (so its styles still apply), that plays
// `keyframes` and goes. Measure now, while the element is still there; call
// the result once it's gone.
export function ghost(
  element: HTMLElement,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions,
): () => void {
  if (reducedMotion()) {
    return () => {};
  }
  const rect = element.getBoundingClientRect();
  const parent = element.parentElement;
  const next = element.nextSibling;
  const copy = element.cloneNode(true) as HTMLElement;
  // A copy starts scrolled to the top; it should show what was on screen.
  const originals = [element, ...element.querySelectorAll<HTMLElement>("*")];
  const copies = [copy, ...copy.querySelectorAll<HTMLElement>("*")];
  const scrolled = originals.flatMap((node, index) =>
    node.scrollTop !== 0 || node.scrollLeft !== 0 ? [[copies[index], node.scrollTop, node.scrollLeft] as const] : [],
  );
  unhook(copy);
  copy.classList.add("motion-ghost");
  return () => {
    const host = parent?.isConnected ? parent : document.body;
    Object.assign(copy.style, {
      position: "absolute",
      left: "0px",
      top: "0px",
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      margin: "0",
      boxSizing: "border-box",
      pointerEvents: "none",
    });
    host.insertBefore(copy, next !== null && next.parentNode === host ? next : null);
    // Wherever the containing block is, correct by what it put the copy at.
    const placed = copy.getBoundingClientRect();
    copy.style.left = `${rect.left - placed.left}px`;
    copy.style.top = `${rect.top - placed.top}px`;
    for (const [node, top, left] of scrolled) {
      node.scrollTop = top;
      node.scrollLeft = left;
    }
    const animation = copy.animate(keyframes, { fill: "forwards", ...options });
    const remove = () => copy.remove();
    animation.onfinish = remove;
    animation.oncancel = remove;
  };
}

// Plays `keyframes` on a copy of the element `ref` points at as it unmounts.
// (Under StrictMode's trial unmount the element stays, and nothing plays;
// one leaving along with its surroundings, a whole screen, needs no farewell.)
export function useExitGhost(
  ref: RefObject<HTMLElement | null>,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions,
): void {
  useLayoutEffect(() => {
    const element = ref.current;
    return () => {
      if (element === null || !element.isConnected) {
        return;
      }
      const parent = element.parentElement;
      const play = ghost(element, keyframes, options);
      queueMicrotask(() => {
        if (!element.isConnected && parent?.isConnected) {
          play();
        }
      });
    };
    // The element and its farewell are fixed at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
