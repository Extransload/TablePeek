export interface QueryDraft {
  sql: string;
  title: string;
  at: number;
  // A saved query's tab: its SQL lives in Queries, so a new tab doesn't bring
  // it back, whatever its name.
  favorite?: boolean;
}

type DraftMap = Record<string, Record<string, QueryDraft>>;

const KEY = "tablepeek.drafts";
const timers = new Map<string, number>();

function read(): DraftMap {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === null) {
      return {};
    }
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as DraftMap) : {};
  } catch {
    return {};
  }
}

function write(map: DraftMap): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(map));
  } catch {}
}

// `conn` is the connection's stable key, so a closed tab's SQL outlives the
// session it was written in. Typing saves after a pause; a closing tab saves
// at once (delay 0), so a new tab opened right after finds it.
export function saveDraft(
  conn: string,
  tabId: string,
  sql: string,
  title: string,
  delay = 400,
  favorite = false,
): void {
  const key = `${conn}:${tabId}`;
  const pending = timers.get(key);
  if (pending !== undefined) {
    window.clearTimeout(pending);
    timers.delete(key);
  }
  if (sql.trim() === "") {
    return;
  }
  const store = (): void => {
    timers.delete(key);
    const map = read();
    map[conn] = { ...(map[conn] ?? {}), [tabId]: { sql, title, at: Date.now(), ...(favorite ? { favorite } : {}) } };
    write(map);
  };
  if (delay <= 0) {
    store();
    return;
  }
  timers.set(key, window.setTimeout(store, delay));
}

export function removeDraft(conn: string, tabId: string): void {
  const key = `${conn}:${tabId}`;
  const pending = timers.get(key);
  if (pending !== undefined) {
    window.clearTimeout(pending);
    timers.delete(key);
  }
  const map = read();
  const scoped = map[conn];
  if (scoped === undefined || !(tabId in scoped)) {
    return;
  }
  delete scoped[tabId];
  if (Object.keys(scoped).length === 0) {
    delete map[conn];
  }
  write(map);
}

// Drafts kept under `from` (a session's id, as earlier versions keyed them)
// move to `to`, the connection's stable key.
export function adoptDrafts(from: string, to: string): void {
  if (from === to) {
    return;
  }
  const map = read();
  const old = map[from];
  if (old === undefined) {
    return;
  }
  map[to] = { ...old, ...(map[to] ?? {}) };
  delete map[from];
  write(map);
}

export function listDrafts(conn: string): { tabId: string; draft: QueryDraft }[] {
  const map = read();
  const scoped = map[conn] ?? {};
  return Object.entries(scoped)
    .map(([tabId, draft]) => ({ tabId, draft }))
    .sort((a, b) => b.draft.at - a.draft.at);
}
