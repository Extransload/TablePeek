import { useEffect, type RefObject } from "react";

// Closes a dropdown on a click outside it or on Escape.
export function useMenuDismiss(
  open: boolean,
  rootRef: RefObject<HTMLDivElement | null>,
  onDismiss: () => void,
): void {
  useEffect(() => {
    if (!open) {
      return;
    }
    function onDocumentClick(event: MouseEvent): void {
      const root = rootRef.current;
      if (root && !root.contains(event.target as Node)) {
        onDismiss();
      }
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onDismiss();
      }
    }
    document.addEventListener("click", onDocumentClick);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("click", onDocumentClick);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, rootRef, onDismiss]);
}
