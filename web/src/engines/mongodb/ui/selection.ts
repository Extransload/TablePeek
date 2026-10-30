// Moving the selection of a list (cards, JSON blocks, schema fields, index,
// file and event rows) with the arrow keys, for the app's detail panel.

// The index to select after an arrow key, or null when the key is not for
// the list: not a plain up or down, or typed into a field or editor inside
// it. With nothing selected (`current` < 0) down picks the first item and
// up the last.
export function arrowStep(event: { key: string; target: EventTarget | null; altKey: boolean; metaKey: boolean; ctrlKey: boolean }, count: number, current: number): number | null {
  if ((event.key !== "ArrowDown" && event.key !== "ArrowUp") || count === 0 || event.altKey || event.metaKey || event.ctrlKey) {
    return null;
  }
  if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable='true'], .cm-editor") !== null) {
    return null;
  }
  if (current < 0) {
    return event.key === "ArrowDown" ? 0 : count - 1;
  }
  return Math.min(count - 1, Math.max(0, current + (event.key === "ArrowDown" ? 1 : -1)));
}

// A click that means "select this item": not on a control inside it.
export function selectsItem(target: EventTarget | null): boolean {
  return !(target instanceof Element && target.closest("button, a, input, textarea, select, [contenteditable='true'], .cm-editor, .mg-jl-fold") !== null);
}
