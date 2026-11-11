import { DURATION, EASE, reducedMotion, unhook } from "./motion";

// The floating surfaces (some forty dialogs, the command palette, menus,
// pickers, popovers, tooltips, the settings sheet) open and close wherever
// their owners render them. How they arrive is CSS (styles.css, the
// "입력 · 모션" block); the rest is done here, by one observer of the page
// rather than by each owner:
//
// - a popover arriving grows out of what opened it: once its owner has
//   placed it, its transform-origin is turned to the point of it nearest the
//   pointer, or the control that had the keys, and it's marked
//   data-arriving, which starts its entrance;
// - a surface leaving is copied back where it was, inert, for the length of
//   its exit, then goes.
//
// Owners close, hand focus back and unmount exactly as before: the copies
// are only paint, and under reduced motion nothing here happens.

// Grow out of what opened them.
const POPOVER_LIST = [
  ".context-menu",
  ".menu-panel",
  ".conn-menu",
  ".column-picker",
  ".cell-menu",
  ".cell-pop",
  ".page-size-panel",
  ".analysis-picker-panel",
  ".date-picker",
];
const POPOVERS = POPOVER_LIST.join(", ");

const timing = (duration: number, easing: string): KeyframeAnimationOptions => ({ duration, easing, fill: "forwards" });

// A surface shrinks a touch as it fades: its entrance played back, quicker.
function fadeDown(surface: Element): Animation {
  return surface.animate([{ opacity: 0, transform: "scale(0.98)" }], timing(DURATION.fast, EASE.out));
}

interface Exit {
  selector: string;
  // Plays the farewell on the copy (or its parts); the copy goes once all end.
  play(copy: HTMLElement): Animation[];
}

const EXITS: Exit[] = [
  {
    // The dim goes by its colour, as it came (see styles.css: fading the
    // backdrop's opacity would take the blur from a glass dialog in it).
    selector: ".modal-backdrop, .palette-backdrop, .cell-pop-backdrop",
    play: (copy) => [
      copy.animate([{ backgroundColor: "transparent" }], timing(DURATION.fast, EASE.out)),
      ...Array.from(copy.children, (surface) => fadeDown(surface)),
    ],
  },
  {
    selector: ".context-layer",
    play: (copy) => Array.from(copy.querySelectorAll(":scope > .context-menu"), (menu) => fadeDown(menu)),
  },
  {
    // Back off the edge it came in from; moved, never faded, so it is glass
    // to the end.
    selector: ".settings-sheet",
    play: (copy) => [copy.animate([{ transform: "translateX(100%)" }], timing(DURATION.slow, EASE.in))],
  },
  {
    // The quick view's switch to its large view swaps .cell-pop inside a
    // backdrop that stays, with motion of its own (CellInspector): a closed
    // inspector leaves as its backdrop, above.
    selector: [...POPOVER_LIST.filter((selector) => selector !== ".cell-pop"), ".cm-tooltip"].join(", "),
    play: (copy) => [fadeDown(copy)],
  },
  {
    selector: ".hover-tooltip",
    play: (copy) => [copy.animate([{ opacity: 0 }], timing(DURATION.instant, EASE.out))],
  },
];

// What opened a popover, as far as can be told: where the pointer last was,
// or the element a key was last pressed in.
let lastInput: "pointer" | "key" | null = null;
let pointerX = 0;
let pointerY = 0;
let keyTarget: EventTarget | null = null;

// Scroll offsets as they happen: an element already out of the page has
// none left to read, and its copy would show its list scrolled to the top.
const scrolled = new WeakMap<Element, [number, number]>();

function positioned(element: Element): boolean {
  const { position } = getComputedStyle(element);
  return position === "absolute" || position === "fixed";
}

// The point of `popover` nearest what opened it, as a transform-origin; null
// when there's nothing to go by.
function originToward(popover: HTMLElement): string | null {
  let x: number;
  let y: number;
  if (lastInput === "pointer") {
    x = pointerX;
    y = pointerY;
  } else if (lastInput === "key" && keyTarget instanceof Element && keyTarget.isConnected && !popover.contains(keyTarget)) {
    const from = keyTarget.getBoundingClientRect();
    x = from.left + from.width / 2;
    y = from.top + from.height / 2;
  } else {
    return null;
  }
  const box = popover.getBoundingClientRect();
  if (box.width === 0 || box.height === 0) {
    return null;
  }
  const originX = Math.min(Math.max(x - box.left, 0), box.width);
  const originY = Math.min(Math.max(y - box.top, 0), box.height);
  return `${Math.round(originX)}px ${Math.round(originY)}px`;
}

interface Leaving {
  copy: HTMLElement;
  // Puts the copy in the page, then (once laid out) back as it was.
  place(): void;
  settle(): void;
  play(copy: HTMLElement): Animation[];
}

function markCopy(copy: HTMLElement): void {
  unhook(copy);
  copy.classList.add("motion-ghost", "overlay-ghost");
  copy.style.pointerEvents = "none";
}

// A copy of a surface React (or CodeMirror, or the grid) has just taken out
// of `record.target`, with what cloning leaves behind put back: typed
// values, drawn canvases, scroll offsets.
function leavingCopy(original: HTMLElement, record: MutationRecord, exit: Exit): Leaving {
  const parent = record.target;
  const next = record.nextSibling;
  const copy = original.cloneNode(true) as HTMLElement;
  const from = [original, ...original.querySelectorAll("*")];
  const to = [copy, ...copy.querySelectorAll("*")];
  const offsets: [Element, number, number][] = [];
  from.forEach((element, index) => {
    const twin = to[index];
    if (twin === undefined) {
      return;
    }
    if (element instanceof HTMLInputElement && element.type !== "file") {
      (twin as HTMLInputElement).value = element.value;
      (twin as HTMLInputElement).checked = element.checked;
    } else if (element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
      (twin as HTMLTextAreaElement | HTMLSelectElement).value = element.value;
    } else if (element instanceof HTMLCanvasElement && element.width > 0 && element.height > 0) {
      (twin as HTMLCanvasElement).getContext("2d")?.drawImage(element, 0, 0);
    }
    const offset = scrolled.get(element);
    if (offset !== undefined) {
      offsets.push([twin, ...offset]);
    }
  });
  markCopy(copy);
  return {
    copy,
    place: () => parent.insertBefore(copy, next !== null && next.parentNode === parent ? next : null),
    settle: () => {
      for (const [twin, left, top] of offsets) {
        twin.scrollLeft = left;
        twin.scrollTop = top;
      }
    },
    play: exit.play,
  };
}

// The success flash stays in the page and only loses its words: what leaves
// is a copy of it holding them.
function flashCopy(record: MutationRecord): Leaving | null {
  const flash = record.target;
  if (!(flash instanceof HTMLElement) || !flash.matches(".flash-toast") || flash.hasChildNodes() || record.removedNodes.length === 0) {
    return null;
  }
  const copy = flash.cloneNode(false) as HTMLElement;
  for (const node of record.removedNodes) {
    copy.append(node.cloneNode(true));
  }
  markCopy(copy);
  return {
    copy,
    place: () => flash.after(copy),
    settle: () => {},
    play: (element) => [
      element.animate([{ opacity: 0, transform: "translate(-50%, 6px) scale(0.98)" }], timing(DURATION.fast, EASE.out)),
    ],
  };
}

function removeWhenDone(copy: HTMLElement, animations: Animation[]): void {
  let remaining = animations.length;
  if (remaining === 0) {
    copy.remove();
    return;
  }
  const done = () => {
    remaining -= 1;
    if (remaining === 0) {
      copy.remove();
    }
  };
  for (const animation of animations) {
    animation.onfinish = done;
    animation.oncancel = done;
  }
}

function onMutations(records: MutationRecord[]): void {
  if (reducedMotion()) {
    return;
  }
  const arriving: HTMLElement[] = [];
  const leaving: Leaving[] = [];
  for (const record of records) {
    for (const node of record.addedNodes) {
      if (!(node instanceof HTMLElement) || !node.isConnected || node.classList.contains("motion-ghost")) {
        continue;
      }
      if (node.matches(POPOVERS)) {
        arriving.push(node);
      }
      // Popovers that arrive inside something else (a menu's layer, a dialog).
      if (node.firstElementChild !== null) {
        arriving.push(...node.querySelectorAll<HTMLElement>(POPOVERS));
      }
    }
    const flash = flashCopy(record);
    if (flash !== null) {
      leaving.push(flash);
      continue;
    }
    if (!record.target.isConnected) {
      continue;
    }
    for (const node of record.removedNodes) {
      // Moved rather than removed, or a copy going.
      if (!(node instanceof HTMLElement) || node.isConnected || node.classList.contains("motion-ghost")) {
        continue;
      }
      const exit = EXITS.find((candidate) => node.matches(candidate.selector));
      if (exit !== undefined) {
        leaving.push(leavingCopy(node, record, exit));
      }
    }
  }
  // Reads first, then writes, so layout is worked out once.
  const origins = arriving.map(originToward);
  arriving.forEach((popover, index) => {
    const origin = origins[index];
    if (origin !== null && origin !== undefined) {
      popover.style.transformOrigin = origin;
    }
    popover.setAttribute("data-arriving", "");
  });
  for (const { place } of leaving) {
    place();
  }
  for (const { copy, settle, play } of leaving) {
    // A surface in the flow (none should be) would push the page about.
    if (!positioned(copy) && !Array.from(copy.children).some(positioned)) {
      copy.remove();
      continue;
    }
    settle();
    removeWhenDone(copy, play(copy));
  }
}

function notePointer(event: PointerEvent): void {
  lastInput = "pointer";
  pointerX = event.clientX;
  pointerY = event.clientY;
}

// Called once, before the first render.
export function installOverlayMotion(): void {
  const passive = { capture: true, passive: true };
  document.addEventListener("pointerdown", notePointer, passive);
  // A submenu opens under the pointer without a press.
  document.addEventListener("pointermove", notePointer, passive);
  document.addEventListener(
    "keydown",
    (event) => {
      lastInput = "key";
      keyTarget = event.target;
    },
    passive,
  );
  document.addEventListener(
    "scroll",
    (event) => {
      const target = event.target;
      if (target instanceof Element) {
        scrolled.set(target, [target.scrollLeft, target.scrollTop]);
      }
    },
    passive,
  );
  new MutationObserver(onMutations).observe(document.body, { childList: true, subtree: true });
}
