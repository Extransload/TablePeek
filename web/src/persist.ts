// The page's saved state — settings, language, workspaces and their tabs,
// drafts, panel sizes, recent queries — as a synchronous key/value store, the
// way localStorage was. The server keeps it in ~/.tablepeek/ui-state.json:
// localStorage belongs to one origin, and the server takes a new port every
// run. main.tsx loads it before any other module runs, since several read
// theirs as they load (the settings apply themselves, the language is picked);
// changes go back to the server in short batches.
//
// Several pages can be open at once, and callers change whole maps (drafts,
// column widths) by reading, changing and writing them back, so each page's
// copy must stay current or it would write back what another page replaced.
// Pages of the same address tell each other each change as it is made; what
// another TablePeek (another port, the desktop app) saved is read again when
// the page comes back to the front.

import { authToken, TOKEN_KEY } from "./token";

const ENDPOINT = "/api/ui-state";
const KEY_PREFIX = "tablepeek.";
// Set in this origin's localStorage once what it kept there was brought in.
const IMPORTED_KEY = "tablepeek.ui-state-imported";
// Pages of this origin tell each other their changes here.
const CHANNEL_NAME = "tablepeek.ui-state";
// Changes made this close together go back as one request.
const BATCH_DELAY_MS = 300;
// A save the server couldn't take is tried again this much later, with
// whatever changed meanwhile.
const RETRY_DELAY_MS = 5_000;
// Focus and visibility arrive together when the page comes to the front: one
// read for both.
const REFRESH_DELAY_MS = 50;
// Browsers let requests outlive their page (keepalive) only within 64 KiB of
// bodies in total.
const KEEPALIVE_MAX_BYTES = 60 * 1024;

type Message =
  // Another page of this origin changed a key (null: removed); it saves it.
  | { type: "set"; key: string; value: string | null }
  // Another page of this origin saved these values.
  | { type: "saved"; entries: [string, string | null][] };

const values = new Map<string, string>();
// What the server holds for each key, as far as this page knows: read from
// it, or saved by a page of this origin. A value read again that still
// matches is nobody's change.
const base = new Map<string, string>();
// Every change, here or told by another page, takes the next number.
let changeNo = 0;
// The number of each key's latest change.
const changedAt = new Map<string, number>();
// Keys changed here and not saved yet, with their latest change's number.
// Each request carries all of them with their current values, so a newer
// request holds everything an older one still on its way does.
const unsaved = new Map<string, number>();
// Off while the saved state couldn't be read (the server down, or a stale
// token from a previous run): the defaults this page runs on must not
// overwrite it.
let saving = false;
let timer: number | undefined;
// This page's requests are numbered; the server skips one older than a
// request it already saved, and the page ignores its answer.
const writer = crypto.randomUUID();
let lastSeq = 0;
let savedSeq = 0;
let requestsOut = 0;
// The batch timer fired while a request was out: send when it's back.
let sendWhenBack = false;
// The latest request's last change, and the request's number while it is
// out and outlives the page.
let lastSentChange = 0;
let keepaliveOut = 0;
let channel: BroadcastChannel | null = null;
let refreshTimer: number | undefined;
let refreshing = false;
let refreshAgain = false;

// GET /api/ui-state.
interface SavedUiState {
  values: Record<string, string>;
}

export function getItem(key: string): string | null {
  return values.get(key) ?? null;
}

export function setItem(key: string, value: string): void {
  if (values.get(key) === value) {
    return;
  }
  values.set(key, value);
  change(key, value);
}

export function removeItem(key: string): void {
  if (!values.delete(key)) {
    return;
  }
  change(key, null);
}

// Reads the saved state; resolves either way. When it can't be read the page
// keeps its changes in memory only, and its first request to the server
// reports the reason the way every request does.
export async function loadUiState(): Promise<void> {
  const saved = await readSaved();
  if (saved === null) {
    return;
  }
  for (const [key, value] of saved) {
    values.set(key, value);
    base.set(key, value);
  }
  saving = true;
  if (typeof BroadcastChannel === "function") {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent<Message>) => receive(event.data);
  }
  importBrowserState();
  window.addEventListener("pagehide", flushNow);
  window.addEventListener("focus", scheduleRefresh);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushNow();
    } else {
      scheduleRefresh();
    }
  });
}

async function readSaved(): Promise<Map<string, string> | null> {
  try {
    const response = await fetch(ENDPOINT, { headers: { "x-tablepeek-token": authToken } });
    if (!response.ok) {
      return null;
    }
    const saved = (await response.json()) as SavedUiState;
    return new Map(Object.entries(saved.values));
  } catch {
    return null;
  }
}

// Each origin, the first time it shows a page, brings in what this browser
// kept in its localStorage, where earlier versions saved: the keys the server
// doesn't have yet. localStorage stays as it was. (index.html has already
// renamed the oldest versions' keys there.)
function importBrowserState(): void {
  try {
    const storage = window.localStorage;
    if (storage.getItem(IMPORTED_KEY) !== null) {
      return;
    }
    let found = false;
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key === null || !key.startsWith(KEY_PREFIX) || key === TOKEN_KEY || key === IMPORTED_KEY) {
        continue;
      }
      found = true;
      const value = storage.getItem(key);
      if (value !== null && !values.has(key)) {
        values.set(key, value);
        change(key, value);
      }
    }
    if (found) {
      storage.setItem(IMPORTED_KEY, "1");
    }
  } catch {}
}

function change(key: string, value: string | null): void {
  if (!saving) {
    return;
  }
  changeNo += 1;
  changedAt.set(key, changeNo);
  unsaved.set(key, changeNo);
  post({ type: "set", key, value });
  if (timer === undefined) {
    timer = window.setTimeout(flush, BATCH_DELAY_MS);
  }
}

function post(message: Message): void {
  try {
    channel?.postMessage(message);
  } catch {}
}

function receive(message: Message): void {
  if (message.type === "set") {
    if (message.value === null) {
      values.delete(message.key);
    } else {
      values.set(message.key, message.value);
    }
    // The other page's value is the newer one, and it saves it.
    unsaved.delete(message.key);
    changeNo += 1;
    changedAt.set(message.key, changeNo);
    return;
  }
  for (const [key, value] of message.entries) {
    if (value === null) {
      base.delete(key);
    } else {
      base.set(key, value);
    }
    changeNo += 1;
    changedAt.set(key, changeNo);
  }
}

function scheduleRefresh(): void {
  if (!saving || refreshTimer !== undefined) {
    return;
  }
  refreshTimer = window.setTimeout(() => {
    refreshTimer = undefined;
    void refresh();
  }, REFRESH_DELAY_MS);
}

// Reads the saved state again and takes what others changed meanwhile. A key
// changed here or by another page of this origin since the read started, or
// not saved yet when it started, keeps this page's value: the read may
// predate that save.
async function refresh(): Promise<void> {
  if (refreshing) {
    refreshAgain = true;
    return;
  }
  refreshing = true;
  const startedAt = changeNo;
  const unsettled = new Set(unsaved.keys());
  const saved = await readSaved();
  refreshing = false;
  if (saved !== null && saving) {
    for (const key of new Set([...saved.keys(), ...base.keys()])) {
      if (unsettled.has(key) || (changedAt.get(key) ?? 0) > startedAt) {
        continue;
      }
      const value = saved.get(key) ?? null;
      if (value === (base.get(key) ?? null)) {
        continue;
      }
      if (value === null) {
        base.delete(key);
        values.delete(key);
      } else {
        base.set(key, value);
        values.set(key, value);
      }
    }
  }
  if (refreshAgain) {
    refreshAgain = false;
    void refresh();
  }
}

function clearTimer(): void {
  if (timer !== undefined) {
    window.clearTimeout(timer);
    timer = undefined;
  }
}

function flush(): void {
  clearTimer();
  if (unsaved.size === 0) {
    return;
  }
  if (requestsOut > 0) {
    sendWhenBack = true;
    return;
  }
  send(false);
}

// The page is being hidden or closed: what's unsaved goes now, without
// waiting for a request still on its way (a closing page won't see it end);
// the server skips that one should it arrive later.
function flushNow(): void {
  clearTimer();
  if (unsaved.size === 0) {
    return;
  }
  // Already on its way in a request that outlives the page.
  if (keepaliveOut !== 0 && keepaliveOut === lastSeq && Math.max(...unsaved.values()) <= lastSentChange) {
    return;
  }
  send(true);
}

function send(closing: boolean): void {
  const upTo = changeNo;
  const seq = ++lastSeq;
  const entries: [string, string | null][] = [];
  const set: Record<string, string> = {};
  const remove: string[] = [];
  for (const key of unsaved.keys()) {
    const value = values.get(key) ?? null;
    entries.push([key, value]);
    if (value === null) {
      remove.push(key);
    } else {
      set[key] = value;
    }
  }
  const body = JSON.stringify({ writer, seq, set, remove });
  // A larger body goes as a plain request: a hidden page still completes it,
  // and only a closing one may cut it off.
  const keepalive = closing && new TextEncoder().encode(body).length <= KEEPALIVE_MAX_BYTES;
  lastSentChange = upTo;
  keepaliveOut = keepalive ? seq : 0;
  requestsOut += 1;
  void request(body, keepalive).then((status) => {
    requestsOut -= 1;
    if (keepaliveOut === seq) {
      keepaliveOut = 0;
    }
    settle(status, seq, upTo, entries);
    if (sendWhenBack && requestsOut === 0) {
      sendWhenBack = false;
      flush();
    }
  });
}

// The response's status, or 0 when the server wasn't reached.
async function request(body: string, keepalive: boolean): Promise<number> {
  try {
    const response = await fetch(ENDPOINT, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-tablepeek-token": authToken },
      body,
      keepalive,
    });
    return response.status;
  } catch {
    return 0;
  }
}

function settle(status: number, seq: number, upTo: number, entries: [string, string | null][]): void {
  if (!saving) {
    return;
  }
  if (status === 401) {
    // The server restarted with a new token: the page opened from its new
    // address saves from now on.
    saving = false;
    unsaved.clear();
    clearTimer();
    return;
  }
  if (status === 0 || status >= 500) {
    // Unsaved keys stay so, and the retry sends their values as they are then.
    if (timer === undefined) {
      timer = window.setTimeout(flush, RETRY_DELAY_MS);
    }
    return;
  }
  // A newer request already came back saved: it carried these keys too.
  if (seq < savedSeq) {
    return;
  }
  // Keys changed again since are still to save. Anything but a success (a
  // batch too large to keep) can't succeed by trying again.
  const done = entries.filter(([key]) => (unsaved.get(key) ?? Infinity) <= upTo);
  for (const [key] of done) {
    unsaved.delete(key);
  }
  if (status < 200 || status >= 300) {
    return;
  }
  savedSeq = seq;
  for (const [key, value] of entries) {
    if (value === null) {
      base.delete(key);
    } else {
      base.set(key, value);
    }
  }
  post({ type: "saved", entries });
}
