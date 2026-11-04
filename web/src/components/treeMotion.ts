import { animate, DURATION, EASE, flip, ghost, measure, reducedMotion, type Rects } from "../motion";

// A sidebar tree node opening or closing: its rows unroll from under it (a
// clip on their container, so nothing is laid out per frame) while what
// follows slides down to make room, and roll back up into it as it closes.
// Only what's on screen moves; a node taller than the list just fades, so
// thousands of rows never animate.

// Up to this many rows arrive one after another; more come in together.
const STAGGER_ROWS = 20;
const STAGGER_STEP = 18;

export interface TreeMove {
  list: HTMLElement;
  // The node: its rows' container is inside it or right after it.
  anchor: HTMLElement;
  // Finds the rows' container, whenever it's there.
  find(): HTMLElement | null;
  // The container this toggle is closing, or null when it opens one.
  closing: HTMLElement | null;
  // The closing rows are taller than the list (only a fade is worth it).
  large: boolean;
  followers: HTMLElement[];
  before: Rects;
  leave: (() => void) | null;
}

// Followers are keyed by identity: React keeps the same element for the
// same node, so where it was and where it is pair up without names.
const ids = new WeakMap<HTMLElement, string>();
let nextId = 0;
function keyOf(element: HTMLElement): string {
  let id = ids.get(element);
  if (id === undefined) {
    nextId += 1;
    id = String(nextId);
    ids.set(element, id);
  }
  return id;
}

// What comes after the node in the list, outermost blocks as a whole, down
// to `limit` (a client y); the rows' own container is left out.
function followersOf(anchor: HTMLElement, list: HTMLElement, skip: Element | null, top: number, limit: number): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (let node: HTMLElement | null = anchor; node !== null && node !== list; node = node.parentElement) {
    for (let next = node.nextElementSibling; next !== null; next = next.nextElementSibling) {
      if (next === skip || !(next instanceof HTMLElement) || next.classList.contains("motion-ghost")) {
        continue;
      }
      const rect = next.getBoundingClientRect();
      if (rect.top > limit) {
        return found;
      }
      if (rect.bottom >= top) {
        found.push(next);
      }
    }
  }
  return found;
}

// Call just before the state change that opens or closes the node's rows.
export function prepareTreeMove(list: HTMLElement, anchor: HTMLElement, find: () => HTMLElement | null): TreeMove | null {
  if (reducedMotion()) {
    return null;
  }
  const view = list.getBoundingClientRect();
  const closing = find();
  const height = closing?.getBoundingClientRect().height ?? 0;
  const large = height > view.height;
  // Closing pulls up what's below the fold by the rows' height.
  const followers = large ? [] : followersOf(anchor, list, closing, view.top, view.bottom + height);
  const before = measure(followers, keyOf);
  const leave =
    closing !== null && !large
      ? ghost(
          closing,
          [
            { clipPath: "inset(0 0 0 0)", opacity: 1 },
            { clipPath: "inset(0 0 100% 0)", opacity: 0 },
          ],
          { duration: DURATION.spring, easing: EASE.spring },
        )
      : null;
  return { list, anchor, find, closing, large, followers, before, leave };
}

// Call after the change, before paint (a layout effect).
export function playTreeMove(move: TreeMove): void {
  const { list, anchor } = move;
  if (!anchor.isConnected) {
    return;
  }
  const opened = move.closing === null ? move.find() : null;
  // Nothing changed (a search keeps every match open, say).
  if (move.closing !== null ? move.closing.isConnected : opened === null) {
    return;
  }
  const view = list.getBoundingClientRect();
  if (move.large) {
    for (const element of followersOf(anchor, list, null, view.top, view.bottom)) {
      animate(element, [{ opacity: 0 }, { opacity: 1 }], { duration: DURATION.fast, easing: EASE.out });
    }
    return;
  }
  if (opened !== null && opened.getBoundingClientRect().height > view.height) {
    animate(opened, [{ opacity: 0 }, { opacity: 1 }], { duration: DURATION.fast, easing: EASE.out });
    return;
  }
  flip(
    move.followers.filter((element) => element.isConnected),
    keyOf,
    move.before,
    { duration: DURATION.spring, easing: EASE.spring },
  );
  move.leave?.();
  if (opened === null) {
    return;
  }
  animate(opened, [{ clipPath: "inset(0 0 100% 0)" }, { clipPath: "inset(0 0 0 0)" }], {
    duration: DURATION.spring,
    easing: EASE.spring,
  });
  const rows = opened.children;
  if (rows.length <= STAGGER_ROWS) {
    for (let index = 0; index < rows.length; index += 1) {
      animate(rows[index], [{ opacity: 0, transform: "translateY(-6px)" }, { opacity: 1, transform: "none" }], {
        duration: DURATION.slow,
        delay: index * STAGGER_STEP,
        easing: EASE.out,
        fill: "backwards",
      });
    }
  }
}
