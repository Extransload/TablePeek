import { getSettings } from "./settings";

export interface ActivityEntry {
  id: string;
  at: number;
  kind: string;
  message: string;
  detail?: string;
}

const STORAGE_KEY = "tablepeek.activity";
const CAP = 500;

type Listener = (entries: ActivityEntry[]) => void;
const listeners = new Set<Listener>();
let entries = load();
let seq = 0;

function prune(list: ActivityEntry[]): ActivityEntry[] {
  const days = Math.max(1, getSettings().activityDays);
  const cutoff = Date.now() - days * 86_400_000;
  return list.filter((entry) => entry.at >= cutoff).slice(-CAP);
}

function load(): ActivityEntry[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return [];
    }
    const parsed = JSON.parse(raw) as ActivityEntry[];
    return Array.isArray(parsed) ? prune(parsed) : [];
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

export function addActivity(kind: string, message: string, detail?: string): void {
  seq += 1;
  entries = prune([
    ...entries,
    {
      id: `${Date.now()}-${seq}`,
      at: Date.now(),
      kind,
      message,
      ...(detail !== undefined && detail !== "" ? { detail } : {}),
    },
  ]);
  persist();
}

export function listActivity(): ActivityEntry[] {
  return entries;
}

export function clearActivity(): void {
  entries = [];
  persist();
}

export function subscribeActivity(listener: Listener): () => void {
  listeners.add(listener);
  listener(listActivity());
  return () => listeners.delete(listener);
}
