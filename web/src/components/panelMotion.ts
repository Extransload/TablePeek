import { useCallback } from "react";
import { animate, DURATION, EASE, ghost } from "../motion";

// Docked panels (the sidebar, the row detail column, the console) slide in
// from the edge they're docked to and back out to it, and what is beside them
// gives way or takes the room back as they move, together: the panel comes
// in from a margin that hides it past its edge, so the layout follows it
// frame by frame. Going out, a copy of it holds its place in the layout and
// slides back past the edge the same way.

export type PanelEdge = "left" | "right" | "bottom";

const MARGIN: Record<PanelEdge, "marginLeft" | "marginRight" | "marginBottom"> = {
  left: "marginLeft",
  right: "marginRight",
  bottom: "marginBottom",
};

// The margin that puts the whole panel past its edge.
function hidden(element: HTMLElement, edge: PanelEdge): string {
  const rect = element.getBoundingClientRect();
  return `${-(edge === "bottom" ? rect.height : rect.width)}px`;
}

// The parent each kind of panel (its first class) is leaving in the commit
// under way: one of the same kind mounting there is the same panel for another
// connection or tab, a swap rather than an opening.
const leaving = new Map<string, Element>();

// A callback ref for a docked panel's root. It plays the way in when the
// panel opens and a copy of it going out when it closes on its own; a swap
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
      const margin = MARGIN[edge];
      if (parent === null || leaving.get(kind) !== parent) {
        // Eased without overshoot: past its rest the panel would leave a gap
        // at the window's edge.
        animate(element, [{ [margin]: hidden(element, edge) }, { [margin]: "0px" }], {
          duration: DURATION.slow,
          easing: EASE.out,
        });
      }
      return () => {
        const from = element.parentElement;
        if (!element.isConnected || from === null) {
          return;
        }
        leaving.set(kind, from);
        const play = ghost(
          element,
          [{ [margin]: "0px" }, { [margin]: hidden(element, edge) }],
          { duration: DURATION.slow, easing: EASE.inOut },
          { inFlow: true },
        );
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
