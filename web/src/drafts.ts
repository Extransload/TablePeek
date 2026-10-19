export interface QueryDraft {
  sql: string;
  title: string;
  at: number;
}

type DraftMap = Record<string, Record<string, QueryDraft>>;

const KEY = "wrendb.drafts";
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

export function saveDraft(conn: string, tabId: string, sql: string, title: string): void {
  const key = `${conn}:${tabId}`;
  const pending = timers.get(key);
  if (pending !== undefined) {
    window.clearTimeout(pending);
  }
  if (sql.trim() === "") {
    return;
  }
  const timer = window.setTimeout(() => {
    timers.delete(key);
    const map = read();
    map[conn] = { ...(map[conn] ?? {}), [tabId]: { sql, title, at: Date.now() } };
    write(map);
  }, 400);
  timers.set(key, timer);
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

export function listDrafts(conn: string): { tabId: string; draft: QueryDraft }[] {
  const map = read();
  const scoped = map[conn] ?? {};
  return Object.entries(scoped)
    .map(([tabId, draft]) => ({ tabId, draft }))
    .sort((a, b) => b.draft.at - a.draft.at);
}
