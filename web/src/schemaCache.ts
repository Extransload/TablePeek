import { store, type ObjectList, type TableSchema } from "./store";

// Schema per connection, shared by the sidebar and SQL autocomplete. Switching
// back to a connection shows the cached copy at once; it is fetched again in
// the background once older than STALE_MS, or right away when `version`
// (the connection's meta key) changes. Concurrent callers share one request.
const STALE_MS = 30_000;

interface Slot<T> {
  version: string;
  value: T | null;
  fetchedAt: number;
  pending: Promise<T> | null;
}

const tablesCache = new Map<string, Slot<TableSchema[]>>();
const objectsCache = new Map<string, Slot<ObjectList>>();

function keyOf(conn: string, system: boolean): string {
  return `${conn}\u0000${system ? "1" : "0"}`;
}

function slotFor<T>(cache: Map<string, Slot<T>>, key: string, version: string): Slot<T> {
  const slot = cache.get(key);
  if (slot === undefined) {
    const created: Slot<T> = { version, value: null, fetchedAt: 0, pending: null };
    cache.set(key, created);
    return created;
  }
  if (slot.version !== version) {
    // Keep showing the old value, but it is stale and an older request can't satisfy it.
    slot.version = version;
    slot.fetchedAt = 0;
    slot.pending = null;
  }
  return slot;
}

function load<T>(
  cache: Map<string, Slot<T>>,
  key: string,
  version: string,
  fetcher: () => Promise<T>,
  force: boolean,
): Promise<T> {
  const slot = slotFor(cache, key, version);
  if (!force && slot.pending !== null) {
    return slot.pending;
  }
  if (!force && slot.value !== null && Date.now() - slot.fetchedAt < STALE_MS) {
    return Promise.resolve(slot.value);
  }
  const pending = fetcher()
    .then((value) => {
      if (slot.version === version) {
        slot.value = value;
        slot.fetchedAt = Date.now();
      }
      return value;
    })
    .finally(() => {
      if (slot.pending === pending) {
        slot.pending = null;
      }
    });
  slot.pending = pending;
  return pending;
}

export function peekSchema(conn: string, system: boolean): TableSchema[] | null {
  return tablesCache.get(keyOf(conn, system))?.value ?? null;
}

export function loadSchema(
  conn: string,
  system: boolean,
  version: string,
  force = false,
): Promise<TableSchema[]> {
  return load(tablesCache, keyOf(conn, system), version, () => store.fetchSchema(conn, system), force);
}

export function peekObjects(conn: string, system: boolean): ObjectList | null {
  return objectsCache.get(keyOf(conn, system))?.value ?? null;
}

export function loadObjects(
  conn: string,
  system: boolean,
  version: string,
  force = false,
): Promise<ObjectList> {
  return load(objectsCache, keyOf(conn, system), version, () => store.fetchObjects(conn, system), force);
}

export function forgetSchema(conn: string): void {
  const prefix = `${conn}\u0000`;
  for (const cache of [tablesCache, objectsCache] as Map<string, unknown>[]) {
    for (const key of [...cache.keys()]) {
      if (key.startsWith(prefix)) {
        cache.delete(key);
      }
    }
  }
}
