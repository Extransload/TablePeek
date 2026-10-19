export type ConnectionEnvironment =
  | ""
  | "local"
  | "development"
  | "staging"
  | "production";

export interface ConnMeta {
  group: string;
  color: string;
  tags: string[];
  environment: ConnectionEnvironment;
}

export const ENVIRONMENT_LABELS: Record<Exclude<ConnectionEnvironment, "">, string> = {
  local: "LOCAL",
  development: "DEV",
  staging: "STAGE",
  production: "PROD",
};

export const ENVIRONMENT_OPTIONS: {
  value: ConnectionEnvironment;
  label: string;
}[] = [
  { value: "", label: "지정 안 함" },
  { value: "local", label: "로컬" },
  { value: "development", label: "개발" },
  { value: "staging", label: "스테이징" },
  { value: "production", label: "운영" },
];

const STORAGE_KEY = "wrendb.conn-meta";
const listeners = new Set<() => void>();

export function environmentLabel(environment: ConnectionEnvironment): string {
  return environment === "" ? "" : ENVIRONMENT_LABELS[environment];
}

function normalizeEnvironment(value: unknown): ConnectionEnvironment {
  return value === "local" ||
    value === "development" ||
    value === "staging" ||
    value === "production"
    ? value
    : "";
}

function inferEnvironment(group: string): ConnectionEnvironment {
  const text = group.toLowerCase();
  if (/(prod|production|운영|상용)/.test(text)) {
    return "production";
  }
  if (/(stage|staging|스테이징)/.test(text)) {
    return "staging";
  }
  if (/(dev|development|개발)/.test(text)) {
    return "development";
  }
  if (/(local|로컬)/.test(text)) {
    return "local";
  }
  return "";
}

function normalizeMeta(value: unknown): ConnMeta | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const meta = value as Partial<ConnMeta>;
  const group = typeof meta.group === "string" ? meta.group : "";
  return {
    group,
    color: typeof meta.color === "string" ? meta.color : "",
    tags: Array.isArray(meta.tags)
      ? meta.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
    environment:
      meta.environment === undefined
        ? inferEnvironment(group)
        : normalizeEnvironment(meta.environment),
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
    tags: meta.tags.map((tag) => tag.trim()).filter((tag) => tag !== ""),
    environment: normalizeEnvironment(meta.environment),
  };
  if (
    next.group === "" &&
    next.color === "" &&
    next.tags.length === 0 &&
    next.environment === ""
  ) {
    delete all[id];
  } else {
    all[id] = next;
  }
  writeAll(all);
}

export function listConnMeta(): Record<string, ConnMeta> {
  return readAll();
}

export function subscribeConnMeta(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
