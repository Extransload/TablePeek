import { listConnMeta, setConnMeta } from "./connMeta";
import { t } from "./i18n";

// Connection groups for the home list. A connection's meta names its group by
// id; the groups themselves (name, color, folded or not) live here, so a group
// can exist before anything is in it.

export interface ConnGroup {
  id: string;
  name: string;
  color: string;
  collapsed: boolean;
}

// The connection dialog's swatches, plus two more so neighbours differ.
export const GROUP_COLORS = [
  "#f59e0b",
  "#3b82f6",
  "#22c55e",
  "#a855f7",
  "#ef4444",
  "#14b8a6",
  "#ec4899",
  "#64748b",
];

const STORAGE_KEY = "tablepeek.conn-groups";
const listeners = new Set<() => void>();

function normalizeGroup(value: unknown): ConnGroup | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const group = value as Partial<ConnGroup>;
  if (typeof group.id !== "string" || group.id === "" || typeof group.name !== "string") {
    return null;
  }
  return {
    id: group.id,
    name: group.name,
    color: typeof group.color === "string" ? group.color : GROUP_COLORS[0],
    collapsed: group.collapsed === true,
  };
}

function readAll(): ConnGroup[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map(normalizeGroup).filter((group): group is ConnGroup => group !== null)
      : [];
  } catch {
    return [];
  }
}

function writeAll(groups: ConnGroup[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(groups));
  } catch {}
  for (const listener of listeners) {
    listener();
  }
}

export function listGroups(): ConnGroup[] {
  return readAll();
}

export function createGroup(name: string, color?: string): ConnGroup {
  const groups = readAll();
  const group: ConnGroup = {
    id: crypto.randomUUID(),
    name: name.trim() || t("새 그룹"),
    color: color ?? GROUP_COLORS[groups.length % GROUP_COLORS.length],
    collapsed: false,
  };
  writeAll([...groups, group]);
  return group;
}

export function updateGroup(
  id: string,
  patch: Partial<Pick<ConnGroup, "name" | "color" | "collapsed">>,
): void {
  writeAll(
    readAll().map((group) =>
      group.id === id
        ? {
            ...group,
            ...patch,
            name: patch.name === undefined ? group.name : patch.name.trim() || group.name,
          }
        : group,
    ),
  );
}

// The group goes; its connections stay, outside any group.
export function deleteGroup(id: string): void {
  for (const [connId, meta] of Object.entries(listConnMeta())) {
    if (meta.group === id) {
      setConnMeta(connId, { ...meta, group: "" });
    }
  }
  writeAll(readAll().filter((group) => group.id !== id));
}

export function findGroupByName(name: string): ConnGroup | undefined {
  const wanted = name.trim().toLowerCase();
  return readAll().find((group) => group.name.toLowerCase() === wanted);
}

export function subscribeGroups(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Earlier versions kept a group name on each connection; turn each name into
// a group and point the connection at its id. Safe to run on every start.
export function migrateGroupNames(): void {
  const known = new Set(readAll().map((group) => group.id));
  for (const [connId, meta] of Object.entries(listConnMeta())) {
    if (meta.group === "" || known.has(meta.group)) {
      continue;
    }
    const group = findGroupByName(meta.group) ?? createGroup(meta.group);
    known.add(group.id);
    setConnMeta(connId, { ...meta, group: group.id });
  }
}
