export interface ConnMeta {
  group: string;
  color: string;
  tags: string[];
}

const STORAGE_KEY = "tablepeek.conn-meta";
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
    const raw = window.localStorage.getItem(STORAGE_KEY);
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
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(meta));
  } catch {}
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

export function subscribeConnMeta(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
