export interface QueryLogEntry {
  id: string;
  at: number;
  conn: string;
  sql: string;
  ms: number;
  ok: boolean;
  rows: number;
  error?: string;
}

const STORAGE_KEY = "tablepeek.query-log";
const CAP = 300;

type Listener = (entries: QueryLogEntry[]) => void;
const listeners = new Set<Listener>();
let entries = load();
let seq = 0;

function load(): QueryLogEntry[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return [];
    }
    const parsed = JSON.parse(raw) as QueryLogEntry[];
    return Array.isArray(parsed) ? parsed.slice(-CAP) : [];
  } catch {
    return [];
  }
}

function persist(): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {}
  for (const listener of listeners) {
    listener(entries);
  }
}

export function addQueryLog(
  conn: string,
  sql: string,
  ms: number,
  result: { ok: boolean; rows: number; error?: string },
): void {
  seq += 1;
  entries = [
    ...entries,
    {
      id: `${Date.now()}-${seq}`,
      at: Date.now(),
      conn,
      sql: sql.length > 2000 ? `${sql.slice(0, 2000)}…` : sql,
      ms: Math.max(0, Math.round(ms)),
      ok: result.ok,
      rows: result.rows,
      ...(result.error !== undefined ? { error: result.error } : {}),
    },
  ].slice(-CAP);
  persist();
}

export function listQueryLog(): QueryLogEntry[] {
  return entries;
}

export function clearQueryLog(): void {
  entries = [];
  persist();
}

export function subscribeQueryLog(listener: Listener): () => void {
  listeners.add(listener);
  listener(listQueryLog());
  return () => listeners.delete(listener);
}
