// How far a drag near an edge of the visible cells should scroll per frame.
// A thin zone inside the edge lets a grid flush with the window edge still
// scroll, while most of the first and last visible rows stay selectable; the
// further the pointer goes, the faster it moves.
const EDGE_ZONE = 10;
const MIN_STEP = 2;
const MAX_STEP = 48;

/** Pixels to scroll this frame along one axis: negative toward `start`. */
export function edgeScrollStep(pointer: number, start: number, end: number): number {
  if (end - start < EDGE_ZONE * 2) {
    return 0;
  }
  const into =
    pointer < start + EDGE_ZONE
      ? -(start + EDGE_ZONE - pointer)
      : pointer > end - EDGE_ZONE
        ? pointer - (end - EDGE_ZONE)
        : 0;
  if (into === 0) {
    return 0;
  }
  const speed = Math.min(MAX_STEP, Math.max(MIN_STEP, Math.round(Math.abs(into) / 3)));
  return Math.sign(into) * speed;
}
