// A side panel's edge: dragged or moved with the arrow keys to resize the
// panel (the schema sidebar, the row detail panel, the settings sheet), its
// width kept across reloads.

import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from "react";
import * as uiState from "./persist";

export function storedWidth(key: string, clamp: (width: number) => number): number | null {
  const saved = Number(uiState.getItem(key));
  return Number.isFinite(saved) && saved > 0 ? clamp(saved) : null;
}

export function storeWidth(key: string, width: number | null): void {
  if (width === null) {
    uiState.removeItem(key);
  } else {
    uiState.setItem(key, String(width));
  }
}

// Drags a side panel's edge. `grow` is 1 when moving right widens the panel
// (left sidebar) and -1 when moving left does (right panel). With `onClose`,
// dragging it past half its narrowest width closes it at once and ends the
// drag, keeping the width it had for when it opens again.
export function dragPanelEdge(
  event: ReactPointerEvent<HTMLDivElement>,
  panel: Element | null,
  grow: 1 | -1,
  clamp: (width: number) => number,
  onMove: (width: number) => void,
  onDone: (width: number) => void,
  onClose?: () => void,
): void {
  if (event.button !== 0) {
    return;
  }
  event.preventDefault();
  const handle = event.currentTarget;
  const startX = event.clientX;
  const startWidth = panel instanceof HTMLElement ? panel.getBoundingClientRect().width : 0;
  const closeBelow = clamp(0) / 2;
  let width = startWidth;
  handle.classList.add("dragging");
  document.body.classList.add("col-resizing");
  const end = (): void => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    handle.classList.remove("dragging");
    document.body.classList.remove("col-resizing");
  };
  const move = (next: PointerEvent): void => {
    const raw = startWidth + grow * (next.clientX - startX);
    if (onClose !== undefined && raw < closeBelow) {
      end();
      onMove(startWidth);
      onClose();
      return;
    }
    width = clamp(raw);
    onMove(width);
  };
  const up = (): void => {
    end();
    onDone(width);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// Arrow keys resize a focused panel edge (Shift for bigger steps); Home or
// Enter returns it to its default width.
export function keyPanelEdge(
  event: ReactKeyboardEvent<HTMLDivElement>,
  panel: Element | null,
  grow: 1 | -1,
  clamp: (width: number) => number,
  save: (width: number | null) => void,
): void {
  const current = panel instanceof HTMLElement ? panel.getBoundingClientRect().width : 0;
  const step = event.shiftKey ? 64 : 16;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    save(clamp(current + grow * (event.key === "ArrowLeft" ? -step : step)));
  } else if (event.key === "Home" || event.key === "Enter") {
    event.preventDefault();
    save(null);
  }
}
