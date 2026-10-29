// A 변경 보기 session (MONGODB.md §8.1): one change stream on a collection
// or a whole database, its last events (at most `MAX_EVENTS`), and whether
// the user wants it running. Sessions live per tab for as long as the page
// does, so a tab shown again finds its events and settings.
//
// The stream is open only while its panel is on screen. Hiding the panel
// (another tab or sub-tab) closes it; showing it again reopens it after the
// last event received (`resumeAfter`), so the events from meanwhile still
// arrive. A dropped connection reopens the same way, with growing waits.

import { t } from "../../i18n";
import { MongoError, isAbort, watchChanges, type WatchRequest } from "./api";
import type { BsonDocument, BsonValue } from "./bson";

export const MAX_EVENTS = 1000;

// The kinds the filter names; everything else (drop, rename, dropDatabase,
// invalidate, create, createIndexes, …) counts as "other".
export const MAIN_OPS = ["insert", "update", "replace", "delete"] as const;
export type OpFilter = (typeof MAIN_OPS)[number] | "other";
export const OP_FILTERS: OpFilter[] = [...MAIN_OPS, "other"];

// Waits before reconnecting, by attempt; the last repeats.
const RETRY_MS = [1000, 2000, 5000, 10000, 30000];

// Failures reconnecting cannot fix: the stream needs the user.
const FATAL_CODES: Record<string, true> = {
  unsupported_capability: true,
  bad_request: true,
  invalid_token: true,
  not_found: true,
  // ChangeStreamHistoryLost, ChangeStreamFatalError, Unauthorized,
  // NoMatchingDocument (fullDocument: "required").
  mongo_286: true,
  mongo_280: true,
  mongo_13: true,
  mongo_47: true,
};

export interface ChangeEvent {
  // Arrival order within the session, for keys.
  seq: number;
  // When the page got it (ms since the epoch).
  received: number;
  doc: BsonDocument;
}

export type WatchStatus =
  // Not running (never started, or paused).
  | "stopped"
  | "connecting"
  | "live"
  // Waiting to reconnect after a failure.
  | "retrying"
  // The server closed the stream for good (an invalidate event).
  | "ended"
  // A failure reconnecting cannot fix.
  | "failed";

export interface WatchOptions {
  ops: OpFilter[];
  // fullDocument: "updateLookup" (the document after an update).
  fullDocument: boolean;
  // fullDocumentBeforeChange: "whenAvailable" (needs pre-images on the collection).
  before: boolean;
}

export interface WatchSnapshot {
  status: WatchStatus;
  // Newest last.
  events: ChangeEvent[];
  // Events let go because of the cap.
  dropped: number;
  error: unknown;
  // The reconnect attempt being waited for (1-based) while retrying.
  attempt: number;
  // The server clock of the last heartbeat or event (ms).
  lastSeen: number | null;
  options: WatchOptions;
  // Whether a resume token is held (the next start continues after it).
  resumable: boolean;
}

const DEFAULT_OPTIONS: WatchOptions = { ops: [...OP_FILTERS], fullDocument: true, before: true };

// Whether the chosen kinds keep an event. The kinds are applied here, not
// as a `$match` in the stream: a stream resumed with a filter fails when the
// event its token names is one the filter drops ("resume token was not
// found"), so the stream always carries every event and the token always
// names the last one received.
function keeps(ops: OpFilter[], operationType: string): boolean {
  return (MAIN_OPS as readonly string[]).includes(operationType) ? ops.includes(operationType as OpFilter) : ops.includes("other");
}

export class WatchSession {
  private snapshot: WatchSnapshot;
  private readonly listeners = new Set<() => void>();
  // What the user asked for: running (until paused) or not.
  private wanted = false;
  // Whether a panel shows this session; the stream is open only then.
  private shown = false;
  private token: BsonValue | undefined;
  private controller: AbortController | null = null;
  private retryTimer: number | undefined;
  private seq = 0;
  // Events come in bursts; listeners hear once per animation frame.
  private pending: ChangeEvent[] = [];
  private frame: number | undefined;

  constructor(
    readonly conn: string,
    readonly db: string,
    readonly coll: string | null,
  ) {
    this.snapshot = { status: "stopped", events: [], dropped: 0, error: null, attempt: 0, lastSeen: null, options: DEFAULT_OPTIONS, resumable: false };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): WatchSnapshot => this.snapshot;

  // A panel shows the session (true) or went away (false).
  setShown(shown: boolean): void {
    this.shown = shown;
    if (shown && this.wanted && (this.snapshot.status === "stopped" || this.snapshot.status === "retrying")) {
      this.open();
    } else if (!shown) {
      this.close();
      if (this.wanted && this.snapshot.status !== "ended" && this.snapshot.status !== "failed") {
        this.update({ status: "stopped", attempt: 0 });
      }
    }
  }

  start(): void {
    this.wanted = true;
    if (this.snapshot.status === "ended" || this.snapshot.status === "failed") {
      // A stream the server ended (or that failed for good) starts anew:
      // its token would only end or fail it again.
      this.token = undefined;
    }
    if (this.shown) {
      this.open();
    }
  }

  pause(): void {
    this.wanted = false;
    this.close();
    this.update({ status: "stopped", attempt: 0 });
  }

  clear(): void {
    this.flush();
    this.update({ events: [], dropped: 0 });
  }

  // New options apply at once. The kinds only change what is kept from now
  // on; the document options reopen a running stream after its last event.
  setOptions(options: WatchOptions): void {
    const reopen = options.fullDocument !== this.snapshot.options.fullDocument || options.before !== this.snapshot.options.before;
    this.update({ options });
    if (reopen && this.wanted && this.shown && this.snapshot.status !== "ended" && this.snapshot.status !== "failed") {
      this.open();
    }
  }

  private request(): WatchRequest {
    const { options } = this.snapshot;
    return {
      db: this.db,
      coll: this.coll ?? undefined,
      fullDocument: options.fullDocument ? "updateLookup" : undefined,
      fullDocumentBeforeChange: options.before ? "whenAvailable" : undefined,
      resumeAfter: this.token,
    };
  }

  private open(): void {
    this.close();
    const controller = new AbortController();
    this.controller = controller;
    this.update({ status: "connecting", error: this.snapshot.status === "retrying" ? this.snapshot.error : null });
    let ended = false;
    watchChanges(
      this.conn,
      this.request(),
      (doc) => {
        const id = doc.get("_id");
        if (id !== undefined) {
          this.token = id;
        }
        const op = String(doc.get("operationType") ?? "");
        if (op === "invalidate") {
          ended = true;
        }
        if (keeps(this.snapshot.options.ops, op)) {
          this.pending.push({ seq: ++this.seq, received: Date.now(), doc });
          this.schedule();
        }
      },
      (ms) => {
        if (this.controller === controller) {
          this.update({ status: "live", attempt: 0, error: null, lastSeen: ms });
        }
      },
      controller.signal,
    ).then(
      () => {
        if (this.controller !== controller) {
          return;
        }
        this.controller = null;
        this.flush();
        if (ended) {
          this.token = undefined;
          this.update({ status: "ended" });
        } else {
          // Closed without an invalidate: the connection went, not the stream.
          this.retry(new MongoError("network", t("변경 스트림 연결이 끊겼습니다")));
        }
      },
      (error: unknown) => {
        if (this.controller !== controller || isAbort(error)) {
          return;
        }
        this.controller = null;
        this.flush();
        if (error instanceof MongoError && FATAL_CODES[error.code] === true) {
          this.wanted = false;
          this.update({ status: "failed", error, attempt: 0 });
        } else {
          this.retry(error);
        }
      },
    );
  }

  private retry(error: unknown): void {
    const attempt = this.snapshot.attempt + 1;
    this.update({ status: "retrying", error, attempt });
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = undefined;
      if (this.wanted && this.shown) {
        this.open();
      }
    }, RETRY_MS[Math.min(attempt, RETRY_MS.length) - 1]);
  }

  private close(): void {
    window.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.controller?.abort();
    this.controller = null;
    this.flush();
  }

  private schedule(): void {
    if (this.frame === undefined) {
      this.frame = window.requestAnimationFrame(() => {
        this.frame = undefined;
        this.flush();
      });
    }
  }

  private flush(): void {
    if (this.frame !== undefined) {
      window.cancelAnimationFrame(this.frame);
      this.frame = undefined;
    }
    if (this.pending.length === 0) {
      return;
    }
    const all = [...this.snapshot.events, ...this.pending];
    this.pending = [];
    const over = Math.max(0, all.length - MAX_EVENTS);
    this.update({
      events: over > 0 ? all.slice(over) : all,
      dropped: this.snapshot.dropped + over,
      status: this.snapshot.status === "connecting" ? "live" : this.snapshot.status,
    });
  }

  private update(patch: Partial<WatchSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch, resumable: this.token !== undefined };
    for (const listener of this.listeners) {
      listener();
    }
  }
}

const sessions = new Map<string, WatchSession>();

// The session of a tab (`key`), made on first use.
export function watchSession(key: string, conn: string, db: string, coll: string | null): WatchSession {
  let session = sessions.get(key);
  if (session === undefined || session.conn !== conn || session.db !== db || session.coll !== coll) {
    session?.pause();
    session = new WatchSession(conn, db, coll);
    sessions.set(key, session);
  }
  return session;
}
