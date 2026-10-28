// Widths a table's columns were given by hand, as TablePlus keeps them: the
// table opens with them again after it is closed, switched away from, or the
// app restarts. Keyed by the connection's stable key and the table, then the
// column name; widths are at a font scale of 1, so they follow a font change.
export type ColumnWidthMap = Record<string, Record<string, number>>;

const STORAGE_KEY = "tablepeek.column-widths";

export function columnWidthsKey(conn: string, table: string): string {
  return `${conn}\u0000${table}`;
}

function loadAll(): ColumnWidthMap {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (parsed === null || typeof parsed !== "object") {
      return {};
    }
    const out: ColumnWidthMap = {};
    for (const [key, columns] of Object.entries(parsed)) {
      if (columns === null || typeof columns !== "object") {
        continue;
      }
      const kept: Record<string, number> = {};
      for (const [column, width] of Object.entries(columns)) {
        if (typeof width === "number" && Number.isFinite(width) && width > 0) {
          kept[column] = width;
        }
      }
      out[key] = kept;
    }
    return out;
  } catch {
    return {};
  }
}

function saveAll(map: ColumnWidthMap): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {}
}

export function loadColumnWidths(key: string): Record<string, number> {
  return loadAll()[key] ?? {};
}

export function saveColumnWidth(key: string, column: string, width: number): void {
  const map = loadAll();
  map[key] = { ...(map[key] ?? {}), [column]: width };
  saveAll(map);
}

// The table's columns go back to fitting what they hold.
export function forgetColumnWidths(key: string): void {
  const map = loadAll();
  if (map[key] === undefined) {
    return;
  }
  delete map[key];
  saveAll(map);
}
