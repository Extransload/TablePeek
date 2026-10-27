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

// The ids createGroup hands out, so an id left behind is never read as a name.
const GROUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function paletteColor(index: number): string {
  return GROUP_COLORS[index % GROUP_COLORS.length];
}

function normalizeGroup(value: unknown, index: number): ConnGroup | null {
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
    color: isHexColor(group.color) ? group.color : paletteColor(index),
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
    color: isHexColor(color) ? color : paletteColor(groups.length),
    collapsed: false,
  };
  writeAll([...groups, group]);
  return group;
}

export function updateGroup(
  id: string,
  patch: Partial<Pick<ConnGroup, "name" | "color" | "collapsed">>,
): void {
  if (patch.color !== undefined && !isHexColor(patch.color)) {
    const { color: _ignored, ...rest } = patch;
    patch = rest;
  }
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

// A group dragged to just before or after another; the list's order is the
// groups' order on the home screen.
export function moveGroup(id: string, targetId: string, after: boolean): void {
  const groups = readAll();
  const moving = groups.find((group) => group.id === id);
  if (moving === undefined || id === targetId) {
    return;
  }
  const rest = groups.filter((group) => group.id !== id);
  const at = rest.findIndex((group) => group.id === targetId);
  if (at < 0) {
    return;
  }
  rest.splice(after ? at + 1 : at, 0, moving);
  writeAll(rest);
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

export function isGroupNameTaken(name: string, exceptId?: string): boolean {
  const found = findGroupByName(name);
  return found !== undefined && found.id !== exceptId;
}

export function subscribeGroups(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Earlier versions kept a group name on each connection; turn each name into
// a group and point the connection at its id; an id whose group is gone is
// cleared. Safe to run on every start.
export function migrateGroupNames(): void {
  const known = new Set(readAll().map((group) => group.id));
  for (const [connId, meta] of Object.entries(listConnMeta())) {
    if (meta.group === "" || known.has(meta.group)) {
      continue;
    }
    if (GROUP_ID.test(meta.group)) {
      setConnMeta(connId, { ...meta, group: "" });
      continue;
    }
    const group = findGroupByName(meta.group) ?? createGroup(meta.group);
    known.add(group.id);
    setConnMeta(connId, { ...meta, group: group.id });
  }
}
