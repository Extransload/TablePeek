import { store, type UpdateStatus } from "./store";

// The update status the banner and Settings share. The page asks for it once
// it opens; the server checks GitHub at most once a day (and never when the
// check is off), so asking is cheap. Settings' toggle, "check now" and the
// banner's "skip this version" replace it with the server's answer.

let status: UpdateStatus | null = null;
let loading: Promise<UpdateStatus> | null = null;
const listeners = new Set<() => void>();

// The release whose banner was closed in this window: it shows again in the
// next one (sessionStorage lives as long as the browser tab).
const DISMISSED_KEY = "tablepeek.update-dismissed";

function publish(next: UpdateStatus): UpdateStatus {
  status = next;
  for (const listener of listeners) {
    listener();
  }
  return next;
}

export function subscribeUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getUpdate(): UpdateStatus | null {
  return status;
}

// The status, asked for once per page.
export function loadUpdate(): Promise<UpdateStatus> {
  loading ??= store.fetchUpdate().then(publish, (error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

// The status again, after checks were turned on (the server checks then if
// the last check is a day old).
export async function refreshUpdate(): Promise<UpdateStatus> {
  return publish(await store.fetchUpdate());
}

export async function checkUpdateNow(): Promise<UpdateStatus> {
  return publish(await store.checkUpdateNow());
}

export async function configureUpdate(patch: { enabled?: boolean; skipped?: string | null }): Promise<UpdateStatus> {
  return publish(await store.configureUpdate(patch));
}

export function dismissedRelease(): string | null {
  try {
    return window.sessionStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

export function dismissRelease(tag: string): void {
  try {
    window.sessionStorage.setItem(DISMISSED_KEY, tag);
  } catch {}
  if (status !== null) {
    publish({ ...status });
  }
}

// The release the banner offers: a newer stable one, neither skipped nor
// closed in this window.
export function offeredRelease(update: UpdateStatus | null): string | null {
  if (update === null || !update.enabled || !update.newer || update.latest === null) {
    return null;
  }
  if (update.latest === update.skipped || update.latest === dismissedRelease()) {
    return null;
  }
  return update.latest;
}
