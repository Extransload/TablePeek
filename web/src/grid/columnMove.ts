// A column moved from `from` to `to` (its index after the move): what the
// grid, the row source and the result's meta each do to their own lists, so
// an index into one still means the same column in the others.

/** Moves `items[from]` to index `to`, in place. */
export function moveItem<T>(items: T[], from: number, to: number): void {
  if (from === to) {
    return;
  }
  const [item] = items.splice(from, 1);
  items.splice(to, 0, item);
}

/** Where the column at `index` is once column `from` has moved to `to`. */
export function movedIndex(index: number, from: number, to: number): number {
  if (index === from) {
    return to;
  }
  if (from < to && index > from && index <= to) {
    return index - 1;
  }
  if (from > to && index >= to && index < from) {
    return index + 1;
  }
  return index;
}
