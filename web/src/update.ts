import { ApiRequestError, store, type UpdateStatus } from "./store";

// The update status the banner, the desktop app's restart pill and Settings
// share. The page asks for it once it opens; the server checks GitHub at most
// once a day (and never when the check is off), so asking is cheap. Settings'
// toggle, "check now" and "skip this version" replace it with the server's
// answer. In the desktop app the server downloads a newer release on its
// own, so the page keeps asking: every second while it downloads, every
// minute otherwise, and when the window comes back into view.

let status: UpdateStatus | null = null;
let loading: Promise<UpdateStatus> | null = null;
const listeners = new Set<() => void>();
let pollTimer: number | undefined;

const POLL_BUSY_MS = 1000;
const POLL_IDLE_MS = 60_000;

// The release whose banner was closed in this window: it shows again in the
// next one (sessionStorage lives as long as the browser tab).
const DISMISSED_KEY = "tablepeek.update-dismissed";

function publish(next: UpdateStatus): UpdateStatus {
  status = next;
  for (const listener of listeners) {
    listener();
  }
  schedulePoll();
  return next;
}

function schedulePoll(): void {
  window.clearTimeout(pollTimer);
  pollTimer = undefined;
  if (status === null || !status.installable) {
    return;
  }
  const busy = status.install.state === "checking" || status.install.state === "downloading";
  pollTimer = window.setTimeout(() => {
    refreshUpdate().catch(() => schedulePoll());
  }, busy ? POLL_BUSY_MS : POLL_IDLE_MS);
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && status?.installable) {
      refreshUpdate().catch(() => {});
    }
  });
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

// The version the desktop app has downloaded and can restart into (or is
// installing, or failed to install and can try again), unless checks are
// off or the user skipped it.
export function readyRelease(update: UpdateStatus | null): string | null {
  if (update === null || !update.installable || !update.enabled) {
    return null;
  }
  const install = update.install;
  let version: string | null = null;
  if (install.state === "ready" || install.state === "installing") {
    version = install.version;
  } else if (install.state === "error" && install.during === "apply") {
    version = install.version;
  }
  // "v0.2.0" and "0.2.0" name the same release.
  const bare = (tag: string) => tag.replace(/^v/i, "");
  return version !== null && update.skipped !== null && bare(version) === bare(update.skipped) ? null : version;
}

// The click on "Restart to update": installing, restarting once it is in
// (the page goes with the app), or the error it stopped with.
export type RestartState = { phase: "idle" } | { phase: "installing" } | { phase: "restarting" } | { phase: "error"; error: unknown };

let restart: RestartState = { phase: "idle" };
const restartListeners = new Set<() => void>();

function setRestart(next: RestartState): void {
  restart = next;
  for (const listener of restartListeners) {
    listener();
  }
}

export function subscribeRestart(listener: () => void): () => void {
  restartListeners.add(listener);
  return () => restartListeners.delete(listener);
}

export function getRestart(): RestartState {
  return restart;
}

export function restartBusy(state: RestartState): boolean {
  return state.phase === "installing" || state.phase === "restarting";
}

// Installs the downloaded release; the app restarts on its own once it is in.
export async function restartToUpdate(): Promise<void> {
  if (restartBusy(restart)) {
    return;
  }
  setRestart({ phase: "installing" });
  try {
    await store.installUpdate();
    setRestart({ phase: "restarting" });
  } catch (error) {
    // On Windows the app quits for its installer before it answers.
    if (error instanceof ApiRequestError && error.code === "network") {
      setRestart({ phase: "restarting" });
      return;
    }
    setRestart({ phase: "error", error });
    refreshUpdate().catch(() => {});
  }
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

// The release the banner offers (builds that don't update themselves): a
// newer stable one, neither skipped nor closed in this window.
export function offeredRelease(update: UpdateStatus | null): string | null {
  if (update === null || update.installable || !update.enabled || !update.newer || update.latest === null) {
    return null;
  }
  if (update.latest === update.skipped || update.latest === dismissedRelease()) {
    return null;
  }
  return update.latest;
}
