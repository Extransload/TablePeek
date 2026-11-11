// The settings sheet docked at the window's right edge (SettingsSheet), and
// the app area left of it. The app gives up the sheet's width (styles.css,
// html.settings-docked, --settings-dock); overlays the page places itself
// keep to the area they open in, so one opened over the app never covers the
// sheet, and follow as the sheet is resized.

import { useSyncExternalStore } from "react";
import { animate, DURATION, EASE } from "./motion";

let dock = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

// The sheet's width while it is docked, null once it closes. As it comes in
// or goes, the app gives up the room or takes it back on the sheet's own
// timing (styles.css, tablepeek-sheet-in; overlayMotion.ts, its exit), so
// the app moves with it; a resize just follows the edge.
export function setSettingsDock(width: number | null): void {
  const root = document.documentElement;
  const was = dock;
  root.classList.toggle("settings-docked", width !== null);
  if (width === null) {
    root.style.removeProperty("--settings-dock");
  } else {
    root.style.setProperty("--settings-dock", `${width}px`);
  }
  const app = document.querySelector(".app");
  if (app !== null && was === 0 && width !== null) {
    animate(app, [{ paddingRight: "0px" }, { paddingRight: `${width}px` }], {
      duration: DURATION.spring,
      easing: EASE.spring,
    });
  } else if (app !== null && was !== 0 && width === null) {
    animate(app, [{ paddingRight: `${was}px` }, { paddingRight: "0px" }], { duration: DURATION.slow, easing: EASE.in });
  }
  const next = width ?? 0;
  if (next !== dock) {
    dock = next;
    notify();
  }
}

// The width of the app area: the window's, less the docked sheet's.
export function appAreaWidth(): number {
  return Math.max(0, window.innerWidth - dock);
}

// The right edge an overlay opened at `x` stays left of: the app area's for
// one opened over the app, the window's for one opened on the sheet itself.
export function overlayRight(x: number): number {
  const app = appAreaWidth();
  return x < app ? app : window.innerWidth;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener("resize", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("resize", listener);
  };
}

// The app area's width, rendering again as the window or the sheet resizes.
export function useAppAreaWidth(): number {
  return useSyncExternalStore(subscribe, appAreaWidth);
}
