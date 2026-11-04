import { useEffect, useRef } from "react";

// A menu that shows what its highlighted option would do before it is
// picked (Settings' themes, fonts and sizes): `onPreview` gets the option
// highlighted (by the pointer or ↑↓) once it has stayed a moment, so
// running down a long list draws only where it stops, and null as soon as
// nothing is (the menu closed or gone without a pick), to put the saved
// look back. Picking stays the menu's own onChange.

const PREVIEW_DELAY_MS = 80;

export function useMenuPreview(onPreview: ((value: string | null) => void) | undefined, highlighted: string | null): void {
  const latest = useRef(onPreview);
  latest.current = onPreview;
  // Whether a preview is showing, so a menu never previewed undoes nothing.
  const showing = useRef(false);

  useEffect(() => {
    if (latest.current === undefined) {
      return;
    }
    if (highlighted === null) {
      if (showing.current) {
        showing.current = false;
        latest.current(null);
      }
      return;
    }
    const timer = window.setTimeout(() => {
      showing.current = true;
      latest.current?.(highlighted);
    }, PREVIEW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [highlighted]);

  useEffect(
    () => () => {
      if (showing.current) {
        showing.current = false;
        latest.current?.(null);
      }
    },
    [],
  );
}
