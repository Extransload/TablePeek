import * as uiState from "./persist";
import type { SavedConnection } from "./store";

export interface ConnMeta {
  group: string;
  color: string;
  tags: string[];
}

const STORAGE_KEY = "tablepeek.conn-meta";
// Saved connections' places on the home list, by id, as dragging left them.
const ORDER_KEY = "tablepeek.conn-order";
const listeners = new Set<() => void>();

// Older versions stored an environment beside the tags; it lives on as a tag.
const LEGACY_ENVIRONMENTS = new Set(["local", "development", "staging", "production"]);

function uniqueTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag !== ""))];
}

export function normalizeMeta(value: unknown): ConnMeta | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const meta = value as Partial<ConnMeta> & { environment?: unknown };
  const tags = Array.isArray(meta.tags)
    ? meta.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  if (typeof meta.environment === "string" && LEGACY_ENVIRONMENTS.has(meta.environment)) {
    tags.push(meta.environment);
  }
  return {
    group: typeof meta.group === "string" ? meta.group : "",
    color: typeof meta.color === "string" ? meta.color : "",
    tags: uniqueTags(tags),
  };
}

function readAll(): Record<string, ConnMeta> {
  try {
    const raw = uiState.getItem(STORAGE_KEY);
    if (raw === null) {
      return {};
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed === null || typeof parsed !== "object") {
      return {};
    }
    const normalized: Record<string, ConnMeta> = {};
    for (const [id, value] of Object.entries(parsed)) {
      const meta = normalizeMeta(value);
      if (meta !== null) {
        normalized[id] = meta;
      }
    }
    return normalized;
  } catch {
    return {};
  }
}

function writeAll(meta: Record<string, ConnMeta>): void {
  uiState.setItem(STORAGE_KEY, JSON.stringify(meta));
  for (const listener of listeners) {
    listener();
  }
}

export function getConnMeta(id: string | undefined): ConnMeta | null {
  if (id === undefined) {
    return null;
  }
  return readAll()[id] ?? null;
}

export function setConnMeta(id: string, meta: ConnMeta): void {
  const all = readAll();
  const next: ConnMeta = {
    group: meta.group.trim(),
    color: meta.color.trim(),
    tags: uniqueTags(meta.tags),
  };
  if (next.group === "" && next.color === "" && next.tags.length === 0) {
    delete all[id];
  } else {
    all[id] = next;
  }
  writeAll(all);
}

// Moves a connection into a group ("" for none), keeping its color and tags.
export function setConnGroup(connId: string, groupId: string): void {
  const meta = readAll()[connId] ?? { group: "", color: "", tags: [] };
  setConnMeta(connId, { ...meta, group: groupId });
}

export function listConnMeta(): Record<string, ConnMeta> {
  return readAll();
}

function readOrder(): string[] {
  try {
    const parsed: unknown = JSON.parse(uiState.getItem(ORDER_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

// Saved connections in their places on the home list. One without a place
// (saved since, or nothing was ever moved) comes ahead of the placed ones,
// the most recently used first.
export function orderConnections(saved: SavedConnection[]): SavedConnection[] {
  const place = new Map(readOrder().map((id, index) => [id, index]));
  return [...saved].sort((a, b) => {
    const atA = place.get(a.id);
    const atB = place.get(b.id);
    if (atA === undefined || atB === undefined) {
      return atA !== undefined ? 1 : atB !== undefined ? -1 : (b.last_used ?? 0) - (a.last_used ?? 0);
    }
    return atA - atB;
  });
}

// Moves a connection into a group ("" for none), just before or after
// another connection there (null: there's none yet). Every saved connection
// gets its place as it stands now, so the rest stay where they are.
export function moveConnection(
  saved: SavedConnection[],
  connId: string,
  groupId: string,
  targetId: string | null,
  after: boolean,
): void {
  const rest = orderConnections(saved)
    .map((connection) => connection.id)
    .filter((id) => id !== connId);
  const at = targetId === null ? -1 : rest.indexOf(targetId);
  rest.splice(at < 0 ? rest.length : after ? at + 1 : at, 0, connId);
  uiState.setItem(ORDER_KEY, JSON.stringify(rest));
  if ((readAll()[connId]?.group ?? "") !== groupId) {
    // Tells the listeners of both changes.
    setConnGroup(connId, groupId);
    return;
  }
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeConnMeta(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// A connection's group, colour, tags or place changed in another window
// (a browser tab, the desktop app): the home list here follows.
uiState.subscribeChangesElsewhere((key) => {
  if (key === STORAGE_KEY || key === ORDER_KEY) {
    for (const listener of listeners) {
      listener();
    }
  }
});
