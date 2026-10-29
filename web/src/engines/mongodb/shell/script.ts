// mongosh scripts as real JavaScript (MONGODB.md §8.2). The page starts a
// fresh Web Worker for each run (worker.ts) and hands it the script; the
// worker calls the document routes itself with synchronous requests and
// sends back what the script prints and its final value. Stopping, or the
// time limit running out, ends the worker wherever it is, even inside an
// endless loop.

import { getLanguage, type Language } from "../../../i18n";
import type { SafeMode } from "../../../sqlTools";
import { store } from "../../../store";
import type { MongoErrorFields } from "../api";

// What the page sends to start a run.
export interface ScriptStart {
  code: string;
  conn: string;
  // The database `db` starts on.
  db: string;
  // The API token; it stays inside the worker's own code, out of the
  // script's reach.
  token: string;
  safeMode: SafeMode;
  // Milliseconds the run may take, or null for no limit. The worker gives
  // each read what is left of it as maxTimeMS.
  timeLimitMs: number | null;
  language: Language;
  // Documents a cursor left as the script's final value shows.
  docLimit: number;
  // Printed lines and values the run keeps; later ones are dropped.
  outputCap: number;
}

// Why a script stopped with an error. `code` and `fields` are the server's
// for a refused request (shown as a MongoError); `line` and `column` point
// into the script text.
export interface ScriptError {
  name: string;
  message: string;
  code?: string;
  fields?: MongoErrorFields;
  // A write safe mode would have asked about.
  safeMode?: boolean;
  syntax?: boolean;
  status?: number;
  line?: number;
  column?: number;
}

export type ScriptEvent =
  | { type: "print"; text: string }
  // A value as canonical Extended JSON text: printjson's, a print of one
  // object, or the script's final value. `coll` names the collection
  // documents came from; `more` says a cursor had more than was shown.
  | { type: "value"; ejson: string; from: "print" | "result"; coll: string | null; more: boolean }
  | { type: "use"; db: string }
  | { type: "capped" }
  | { type: "done" }
  | { type: "error"; error: ScriptError };

export type ScriptEnd = "done" | "error" | "stopped" | "timeout";

export interface ScriptRun {
  stop(): void;
  finished: Promise<ScriptEnd>;
}

// Runs `code` in a new worker; events arrive through `onEvent` until the
// run finishes, is stopped, or passes `timeLimitMs`.
export function runScript(args: Omit<ScriptStart, "token" | "language">, onEvent: (event: ScriptEvent) => void): ScriptRun {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  let settle: (end: ScriptEnd) => void = () => undefined;
  const finished = new Promise<ScriptEnd>((resolve) => {
    settle = resolve;
  });
  let over = false;
  let timer: number | undefined;
  const finish = (end: ScriptEnd) => {
    if (over) {
      return;
    }
    over = true;
    window.clearTimeout(timer);
    worker.terminate();
    settle(end);
  };
  worker.onmessage = (message: MessageEvent<ScriptEvent>) => {
    if (over) {
      return;
    }
    const event = message.data;
    onEvent(event);
    if (event.type === "done") {
      finish("done");
    } else if (event.type === "error") {
      if (event.error.status === 401) {
        store.serverRestarted();
      }
      finish("error");
    }
  };
  // The worker's own code failed to load or threw outside the script.
  worker.onerror = (event) => {
    event.preventDefault();
    onEvent({ type: "error", error: { name: "Error", message: event.message || "worker error" } });
    finish("error");
  };
  if (args.timeLimitMs !== null) {
    timer = window.setTimeout(() => finish("timeout"), args.timeLimitMs);
  }
  const start: ScriptStart = { ...args, token: store.token(), language: getLanguage() };
  worker.postMessage(start);
  return { stop: () => finish("stopped"), finished };
}
