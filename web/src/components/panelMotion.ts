import { useCallback } from "react";
import { animate, DURATION, EASE, ghost } from "../motion";

// Docked panels (the sidebar, the row detail column, the console) slide in
// from the edge they're docked to and back out to it. Their width or height
// snaps as they come and go, so the grid beside them lays out once; only the
// panel itself, or its ghost, moves.

export type PanelEdge = "left" | "right" | "bottom";

const OFFSET: Record<PanelEdge, string> = {
  left: "translateX(-28px)",
  right: "translateX(28px)",
  bottom: "translateY(24px)",
};

// The parent each kind of panel (its first class) is leaving in the commit
// under way: one of the same kind mounting there is the same panel for another
// connection or tab, a swap rather than an opening.
const leaving = new Map<string, Element>();

// A callback ref for a docked panel's root. It plays the way in when the
// panel opens and a ghost of it going out when it closes on its own; a swap
// in place, or the panel going with its surroundings (the workbench closing),
// plays nothing.
export function usePanelMotion(edge: PanelEdge): (element: HTMLElement | null) => (() => void) | undefined {
  return useCallback(
    (element: HTMLElement | null) => {
      if (element === null) {
        return undefined;
      }
      const kind = element.classList[0] ?? "";
      const parent = element.parentElement;
      if (parent === null || leaving.get(kind) !== parent) {
        animate(element, [{ opacity: 0, transform: OFFSET[edge] }, { opacity: 1, transform: "none" }], {
          duration: DURATION.spring,
          easing: EASE.spring,
        });
      }
      return () => {
        const from = element.parentElement;
        if (!element.isConnected || from === null) {
          return;
        }
        leaving.set(kind, from);
        const play = ghost(element, [{ opacity: 1, transform: "none" }, { opacity: 0, transform: OFFSET[edge] }], {
          duration: DURATION.slow,
          easing: EASE.in,
        });
        // React detaches refs before it removes nodes; by the microtask the
        // commit is done and what took the panel's place is there to see.
        queueMicrotask(() => {
          if (leaving.get(kind) === from) {
            leaving.delete(kind);
          }
          if (element.isConnected || !from.isConnected) {
            return;
          }
          for (const sibling of from.children) {
            if (sibling.classList.contains(kind) && !sibling.classList.contains("motion-ghost")) {
              return;
            }
          }
          play();
        });
      };
    },
    [edge],
  );
}
