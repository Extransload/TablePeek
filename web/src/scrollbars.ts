// Scrollbars the app draws itself. Chrome on macOS no longer styles
// ::-webkit-scrollbar, which leaves its own bars: 16px classic ones, or
// overlay ones (scrollbar-width: thin) that widen under the pointer. Every
// element's own bars are hidden (styles.css), and a scroll area gets thin
// thumbs laid over its right and bottom edges instead, one size always:
// hovering only recolours them. They show while the pointer is over the
// area or it scrolls; the grid's and the editor's are pinned, kept in view
// when Settings asks (html.scrollbar-x-always / -y-always).

type Axis = "x" | "y";

// The track's breadth: the thumb's hit area, its visible pill thinner.
const TRACK = 10;
const MIN_THUMB = 24;
const HIDE_AFTER_MS = 900;

const bars = new WeakMap<HTMLElement, ScrollArea>();
const live = new Set<ScrollArea>();

export class ScrollArea {
  private readonly tracks: Record<Axis, HTMLDivElement>;
  private readonly thumbs: Record<Axis, HTMLDivElement>;
  private readonly resize: ResizeObserver;
  private frame = 0;
  private hideTimer = 0;
  private dragging = false;

  constructor(
    readonly scroller: HTMLElement,
    pinned: boolean,
  ) {
    const make = (axis: Axis): [HTMLDivElement, HTMLDivElement] => {
      const track = document.createElement("div");
      track.className = `app-scrollbar ${axis}${pinned ? " pinned" : ""}`;
      track.setAttribute("aria-hidden", "true");
      const thumb = document.createElement("div");
      thumb.className = "app-scrollbar-thumb";
      thumb.addEventListener("pointerdown", (event) => this.drag(axis, event));
      track.append(thumb);
      return [track, thumb];
    };
    const [yTrack, yThumb] = make("y");
    const [xTrack, xThumb] = make("x");
    this.tracks = { x: xTrack, y: yTrack };
    this.thumbs = { x: xThumb, y: yThumb };
    scroller.addEventListener("scroll", this.scrolled, { passive: true });
    scroller.addEventListener("pointerenter", this.onEnter);
    scroller.addEventListener("pointerleave", this.onLeave);
    for (const track of [xTrack, yTrack]) {
      track.addEventListener("pointerenter", this.onEnter);
      track.addEventListener("pointerleave", this.onLeave);
    }
    this.resize = new ResizeObserver(() => this.update());
    this.resize.observe(scroller);
    if (scroller.parentElement) {
      this.resize.observe(scroller.parentElement);
    }
    live.add(this);
    this.update();
  }

  // A content element whose size sets the scroll range (the grid's sizer,
  // the editor's content): watched so pinned bars follow it.
  watch(content: Element): void {
    this.resize.observe(content);
  }

  update(): void {
    if (this.frame === 0) {
      this.frame = requestAnimationFrame(() => {
        this.frame = 0;
        this.layout();
      });
    }
  }

  show(): void {
    window.clearTimeout(this.hideTimer);
    this.tracks.x.classList.add("shown");
    this.tracks.y.classList.add("shown");
  }

  private hideSoon(): void {
    window.clearTimeout(this.hideTimer);
    this.hideTimer = window.setTimeout(() => {
      if (this.dragging || this.hovered()) {
        return;
      }
      this.tracks.x.classList.remove("shown");
      this.tracks.y.classList.remove("shown");
    }, HIDE_AFTER_MS);
  }

  private hovered(): boolean {
    return (
      this.scroller.matches(":hover") || this.tracks.x.matches(":hover") || this.tracks.y.matches(":hover")
    );
  }

  // Scrolled: shown, then gone a moment after.
  readonly scrolled = (): void => {
    this.show();
    this.update();
    this.hideSoon();
  };

  private readonly onEnter = (): void => {
    this.show();
    this.update();
  };

  private readonly onLeave = (): void => {
    this.hideSoon();
  };

  private layout(): void {
    const { scroller } = this;
    const parent = scroller.parentElement;
    if (!scroller.isConnected || parent === null) {
      this.destroy();
      return;
    }
    for (const track of [this.tracks.y, this.tracks.x]) {
      if (track.parentElement !== parent) {
        parent.append(track);
      }
    }
    const style = getComputedStyle(scroller);
    const box = scroller.getBoundingClientRect();
    const clipped = cutOff(parent, box);
    const canY = !clipped && /auto|scroll/.test(style.overflowY) && scroller.scrollHeight > scroller.clientHeight + 1;
    const canX = !clipped && /auto|scroll/.test(style.overflowX) && scroller.scrollWidth > scroller.clientWidth + 1;
    // Idle tracks stay laid out (hidden, not undisplayed), so their
    // offsetParent still names the box they are placed in.
    this.tracks.y.classList.toggle("idle", !canY);
    this.tracks.x.classList.toggle("idle", !canX);
    // Above the scroller, which may stack high itself (a menu, a toast).
    const z = Number.parseInt(style.zIndex, 10);
    for (const track of [this.tracks.x, this.tracks.y]) {
      track.style.zIndex = Number.isFinite(z) ? String(Math.max(20, z + 1)) : "";
    }
    // The tracks sit in the scroller's parent, over the scroller's edges:
    // placed from both boxes, as the parent may itself be scrolled.
    const origin = this.tracks.y.offsetParent ?? document.body;
    const outer = origin.getBoundingClientRect();
    const left = box.left - outer.left - origin.clientLeft + origin.scrollLeft + scroller.clientLeft;
    const top = box.top - outer.top - origin.clientTop + origin.scrollTop + scroller.clientTop;
    const width = scroller.clientWidth;
    const height = scroller.clientHeight;
    this.place("y", left + width - TRACK, top, TRACK, height - (canX ? TRACK : 0));
    this.place("x", left, top + height - TRACK, width - (canY ? TRACK : 0), TRACK);
  }

  private place(axis: Axis, left: number, top: number, width: number, height: number): void {
    const track = this.tracks[axis];
    track.style.transform = `translate(${left}px, ${top}px)`;
    track.style.width = `${Math.max(0, width)}px`;
    track.style.height = `${Math.max(0, height)}px`;
    const { scroller } = this;
    const length = axis === "y" ? height : width;
    const view = axis === "y" ? scroller.clientHeight : scroller.clientWidth;
    const range = axis === "y" ? scroller.scrollHeight : scroller.scrollWidth;
    const offset = axis === "y" ? scroller.scrollTop : Math.abs(scroller.scrollLeft);
    const size = Math.max(MIN_THUMB, Math.round((view / Math.max(range, 1)) * length));
    const room = Math.max(0, length - size);
    const at = range > view ? Math.round((offset / (range - view)) * room) : 0;
    const thumb = this.thumbs[axis];
    if (axis === "y") {
      thumb.style.height = `${size}px`;
      thumb.style.transform = `translateY(${at}px)`;
    } else {
      thumb.style.width = `${size}px`;
      thumb.style.transform = `translateX(${at}px)`;
    }
  }

  // Dragging a thumb scrolls by as much as the content runs past the view
  // for each pixel the thumb can travel.
  private drag(axis: Axis, event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const thumb = this.thumbs[axis];
    const { scroller } = this;
    const start = axis === "y" ? event.clientY : event.clientX;
    const from = axis === "y" ? scroller.scrollTop : scroller.scrollLeft;
    const track = this.tracks[axis];
    const length = axis === "y" ? track.clientHeight : track.clientWidth;
    const size = axis === "y" ? thumb.offsetHeight : thumb.offsetWidth;
    const range =
      axis === "y" ? scroller.scrollHeight - scroller.clientHeight : scroller.scrollWidth - scroller.clientWidth;
    const ratio = range / Math.max(1, length - size);
    this.dragging = true;
    thumb.classList.add("dragging");
    thumb.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent): void => {
      const moved = ((axis === "y" ? next.clientY : next.clientX) - start) * ratio;
      if (axis === "y") {
        scroller.scrollTop = from + moved;
      } else {
        scroller.scrollLeft = from + moved;
      }
    };
    const end = (): void => {
      this.dragging = false;
      thumb.classList.remove("dragging");
      thumb.removeEventListener("pointermove", move);
      thumb.removeEventListener("pointerup", end);
      thumb.removeEventListener("pointercancel", end);
      thumb.removeEventListener("lostpointercapture", end);
      this.hideSoon();
    };
    thumb.addEventListener("pointermove", move);
    thumb.addEventListener("pointerup", end);
    thumb.addEventListener("pointercancel", end);
    thumb.addEventListener("lostpointercapture", end);
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    window.clearTimeout(this.hideTimer);
    this.resize.disconnect();
    this.scroller.removeEventListener("scroll", this.scrolled);
    this.scroller.removeEventListener("pointerenter", this.onEnter);
    this.scroller.removeEventListener("pointerleave", this.onLeave);
    this.tracks.x.remove();
    this.tracks.y.remove();
    if (bars.get(this.scroller) === this) {
      bars.delete(this.scroller);
    }
    live.delete(this);
  }
}

// Whether an outer scroll area shows only part of `box` (a scroller inside
// it, scrolled partly out of view): its bars would then lie over whatever
// is next to it, so they stay hidden.
function cutOff(from: HTMLElement, box: DOMRect): boolean {
  for (let element: HTMLElement | null = from; element !== null && element !== document.body; element = element.parentElement) {
    if (scrollsByStyle(element)) {
      const outer = element.getBoundingClientRect();
      return box.top < outer.top - 1 || box.bottom > outer.bottom + 1 || box.left < outer.left - 1 || box.right > outer.right + 1;
    }
  }
  return false;
}

// The app's bars on `scroller`, made once. Pinned bars (the grid's, the
// editor's) stay in view when Settings keeps them so.
export function scrollbarsFor(scroller: HTMLElement, pinned = false): ScrollArea {
  let area = bars.get(scroller);
  if (area === undefined) {
    area = new ScrollArea(scroller, pinned);
    bars.set(scroller, area);
  }
  return area;
}

let scrollStyle = new WeakMap<Element, boolean>();
let styleReadAt = 0;

// Whether an element scrolls by its style (overflow auto or scroll) and
// wants bars (a strip that scrolls sideways unmarked sets --app-scrollbar:
// none), cached: it is asked on every pointer move.
function scrollsByStyle(element: Element): boolean {
  // Read again after a second: a class may turn an area's scrolling on.
  const now = performance.now();
  if (now - styleReadAt > 1000) {
    scrollStyle = new WeakMap();
    styleReadAt = now;
  }
  let known = scrollStyle.get(element);
  if (known === undefined) {
    const style = getComputedStyle(element);
    known =
      (/auto|scroll/.test(style.overflowY) || /auto|scroll/.test(style.overflowX)) &&
      style.getPropertyValue("--app-scrollbar").trim() !== "none";
    scrollStyle.set(element, known);
  }
  return known;
}

// Every scroll area gets its bars the first time the pointer comes over it
// or it scrolls; areas gone from the page drop theirs.
export function installScrollbars(): void {
  const reach = (target: EventTarget | null): void => {
    for (let element = target instanceof Element ? target : null; element !== null; element = element.parentElement) {
      if (element instanceof HTMLElement && element !== document.body && scrollsByStyle(element)) {
        const area = scrollbarsFor(element);
        if (element.matches(":hover")) {
          area.show();
        }
        area.update();
      }
    }
  };
  document.addEventListener("pointerover", (event) => reach(event.target), { capture: true, passive: true });
  document.addEventListener(
    "scroll",
    (event) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (target instanceof HTMLElement && target !== document.body && !bars.has(target) && scrollsByStyle(target)) {
        scrollbarsFor(target).scrolled();
      }
      // Areas inside the one that scrolled moved with it.
      for (const area of live) {
        if (area.scroller !== target && target.contains(area.scroller)) {
          area.update();
        }
      }
    },
    { capture: true, passive: true },
  );
  // Bars of areas no longer on the page go with them.
  window.setInterval(() => {
    for (const area of live) {
      if (!area.scroller.isConnected) {
        area.destroy();
      }
    }
  }, 5000);
}
