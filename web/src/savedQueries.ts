import type { Favorite } from "./store";

// The Queries tab's own settings, as TablePlus keeps them under its "+" menu.
export type QuerySort = "name" | "created" | "modified";

const SORT_KEY = "tablepeek.queries-sort";
const AUTOSAVE_KEY = "tablepeek.queries-autosave";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered, still applied.
  }
}

export function loadQuerySort(): QuerySort {
  const value = read(SORT_KEY);
  return value === "created" || value === "modified" ? value : "name";
}

export function saveQuerySort(sort: QuerySort): void {
  write(SORT_KEY, sort);
}

// Edits made in a saved query's own tab are written back to it.
export function loadAutoSave(): boolean {
  return read(AUTOSAVE_KEY) !== "0";
}

export function saveAutoSave(on: boolean): void {
  write(AUTOSAVE_KEY, on ? "1" : "0");
}

export function sortQueries(queries: Favorite[], sort: QuerySort): Favorite[] {
  const byName = (a: Favorite, b: Favorite): number =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  return queries.slice().sort((a, b) => {
    if (sort === "created" && a.created_at !== b.created_at) {
      return b.created_at - a.created_at;
    }
    if (sort === "modified" && a.updated_at !== b.updated_at) {
      return b.updated_at - a.updated_at;
    }
    return byName(a, b);
  });
}

// Saves `sql` as a .sql file through the browser's download.
export function downloadSql(name: string, sql: string): void {
  const safe = name.replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "") || "query";
  const url = URL.createObjectURL(new Blob([sql.endsWith("\n") ? sql : `${sql}\n`], { type: "application/sql" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = safe.toLowerCase().endsWith(".sql") ? safe : `${safe}.sql`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
