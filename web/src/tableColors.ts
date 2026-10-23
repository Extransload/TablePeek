// Font colours a table can be marked with, so it stands out in a long list:
// its name in the sidebar and its tabs take the colour. Mid-tone hues that
// read on light and dark themes alike.
export const TABLE_COLORS = [
  { id: "red", label: "빨강", value: "#e5484d" },
  { id: "orange", label: "주황", value: "#ec7a20" },
  { id: "yellow", label: "노랑", value: "#c79a00" },
  { id: "green", label: "초록", value: "#2f9e5f" },
  { id: "teal", label: "청록", value: "#12a594" },
  { id: "blue", label: "파랑", value: "#3d8bfd" },
  { id: "purple", label: "보라", value: "#8e5bd8" },
  { id: "pink", label: "분홍", value: "#d6409f" },
] as const;

// Connection → table → colour id.
export type TableColorMap = Record<string, Record<string, string>>;

const STORAGE_KEY = "tablepeek.table-colors";

export function tableColorValue(id: string | undefined): string | undefined {
  return TABLE_COLORS.find((color) => color.id === id)?.value;
}

export function loadTableColors(): TableColorMap {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (parsed === null || typeof parsed !== "object") {
      return {};
    }
    const out: TableColorMap = {};
    for (const [conn, tables] of Object.entries(parsed)) {
      if (tables === null || typeof tables !== "object") {
        continue;
      }
      const kept: Record<string, string> = {};
      for (const [table, id] of Object.entries(tables)) {
        if (typeof id === "string" && tableColorValue(id) !== undefined) {
          kept[table] = id;
        }
      }
      out[conn] = kept;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveTableColors(map: TableColorMap): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {}
}

// The tables given the colour, or cleared of it (null).
export function withTableColor(
  map: TableColorMap,
  conn: string,
  tables: string[],
  id: string | null,
): TableColorMap {
  const next = { ...(map[conn] ?? {}) };
  for (const table of tables) {
    if (id === null) {
      delete next[table];
    } else {
      next[table] = id;
    }
  }
  return { ...map, [conn]: next };
}

// A renamed table keeps its colour.
export function moveTableColor(map: TableColorMap, conn: string, from: string, to: string): TableColorMap {
  const id = map[conn]?.[from];
  if (id === undefined) {
    return map;
  }
  const next = { ...map[conn] };
  delete next[from];
  next[to] = id;
  return { ...map, [conn]: next };
}
