import { useEffect, useLayoutEffect, useRef, useState } from "react";

const SHOW_DELAY_MS = 350;

// "New tab (⌘T)" → the label, and the shortcut shown as keys. Titles write a
// shortcut last, in parentheses, the way shortcutHint() spells it.
const SHORTCUT_TAIL = /^([\s\S]*?)\s*\(((?:[⌘⌥⇧⌃]|Ctrl\+|Alt\+|Shift\+|Win\+|F\d{1,2}\b)[^()]*)\)\s*$/;

function splitShortcut(text: string): { label: string; keys: string | null } {
  const match = SHORTCUT_TAIL.exec(text);
  return match === null ? { label: text, keys: null } : { label: match[1], keys: match[2] };
}
const EDGE = 8;
const GAP = 6;

interface TipState {
  text: string;
  x: number;
  top: number;
  bottom: number;
}

// Replaces the slow native `title` tooltip app-wide: while an element with a
// title is hovered, its title moves to data-tip-title (restored on leave) and a
// styled tooltip is shown instead.
export function HoverTooltip() {
  const [tip, setTip] = useState<TipState | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let target: HTMLElement | null = null;
    let observer: MutationObserver | null = null;
    let timer = 0;
    let visible = false;

    function takeTitle(el: HTMLElement): void {
      const title = el.getAttribute("title");
      if (title !== null) {
        el.dataset.tipTitle = title;
        el.removeAttribute("title");
      }
    }

    function release(): void {
      window.clearTimeout(timer);
      observer?.disconnect();
      observer = null;
      if (target !== null) {
        const title = target.dataset.tipTitle;
        delete target.dataset.tipTitle;
        if (title !== undefined && !target.hasAttribute("title")) {
          target.setAttribute("title", title);
        }
      }
      target = null;
    }

    function hide(): void {
      release();
      visible = false;
      setTip(null);
    }

    // Clicks, keys and scrolling only close the bubble; the title stays stashed until
    // the pointer leaves, so the native tooltip cannot pop up under the cursor.
    function dismiss(): void {
      window.clearTimeout(timer);
      visible = false;
      setTip(null);
    }

    function show(): void {
      const el = target;
      const text = el?.dataset.tipTitle?.trim() ?? "";
      if (el === null || !el.isConnected || text === "") {
        hide();
        return;
      }
      const rect = el.getBoundingClientRect();
      visible = true;
      setTip({ text, x: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom });
    }

    function onPointerOver(event: PointerEvent): void {
      if (event.pointerType === "touch") {
        return;
      }
      const origin = event.target instanceof Element ? event.target : null;
      const el = origin?.closest<HTMLElement>("[title], [data-tip-title]") ?? null;
      if (el === target) {
        return;
      }
      const wasVisible = visible;
      release();
      if (el === null || (el.getAttribute("title") ?? "").trim() === "") {
        visible = false;
        setTip(null);
        return;
      }
      target = el;
      takeTitle(el);
      observer = new MutationObserver(() => {
        if (target !== null && target.hasAttribute("title")) {
          takeTitle(target);
          if (visible) {
            show();
          }
        }
      });
      observer.observe(el, { attributes: true, attributeFilter: ["title"] });
      if (wasVisible) {
        show();
      } else {
        visible = false;
        setTip(null);
        timer = window.setTimeout(show, SHOW_DELAY_MS);
      }
    }

    function onPointerOut(event: PointerEvent): void {
      if (target === null) {
        return;
      }
      const next = event.relatedTarget;
      if (next instanceof Node && target.contains(next)) {
        return;
      }
      hide();
    }

    document.addEventListener("pointerover", onPointerOver, true);
    document.addEventListener("pointerout", onPointerOut, true);
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", dismiss, true);
    document.addEventListener("scroll", dismiss, true);
    window.addEventListener("blur", hide);
    return () => {
      document.removeEventListener("pointerover", onPointerOver, true);
      document.removeEventListener("pointerout", onPointerOut, true);
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", dismiss, true);
      document.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("blur", hide);
      release();
    };
  }, []);

  useLayoutEffect(() => {
    const node = tipRef.current;
    if (node === null || tip === null) {
      return;
    }
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    const left = Math.min(Math.max(tip.x - width / 2, EDGE), window.innerWidth - width - EDGE);
    const below = tip.bottom + GAP + height + EDGE <= window.innerHeight;
    node.style.left = `${Math.max(EDGE, left)}px`;
    node.style.top = `${below ? tip.bottom + GAP : Math.max(EDGE, tip.top - GAP - height)}px`;
    node.dataset.place = below ? "below" : "above";
  }, [tip]);

  if (tip === null) {
    return null;
  }
  const { label, keys } = splitShortcut(tip.text);
  return (
    <div className="hover-tooltip" role="tooltip" ref={tipRef}>
      {label}
      {keys !== null ? <kbd className="hover-tooltip-keys">{keys}</kbd> : null}
    </div>
  );
}
