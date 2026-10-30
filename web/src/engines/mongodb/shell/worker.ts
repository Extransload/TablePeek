// The Web Worker a mongosh script runs in (MONGODB.md §8.2, started by
// script.ts). The script is real JavaScript evaluated here, with the mongosh
// API as globals: `db` and its collections and cursors, `use`/`show`, the
// BSON constructors, `EJSON`, `print`/`printjson`/`console.log`. Each
// database call is a synchronous request to the document routes, so scripts
// read like mongosh without `await`.
//
// What the script can reach: a worker has no page to touch; the network and
// storage globals are taken away before it runs; the API token lives only
// in this module's closure and is handed to the browser's request functions
// captured before the script could replace them, so patching
// `XMLHttpRequest.prototype` or `Function.prototype.call` sees nothing.
// Writes safe mode would ask about are refused with a message saying how to
// run them, since a script cannot stop for a dialog.

import { phrase, phraseError, phraseOf, say, setLanguage, type Phrase } from "../../../i18n";
import {
  Binary,
  BsonDate,
  BsonRegex,
  BsonUndefined,
  Code,
  Decimal128,
  Double,
  Int32,
  Int64,
  MAX_KEY,
  MIN_KEY,
  MaxKey,
  MinKey,
  ObjectId,
  Timestamp,
  fromEJSON,
  isDocument,
  jsonKeys,
  jsonObject,
  parseJson,
  stringifyJson,
  toEJSON,
  type BsonDocument,
  type BsonValue,
} from "../bson";
import { ejsonText, toShell } from "../format";
import { commandNeedsConfirm, pipelineWrites, review } from "./safety";
import type { ScriptError, ScriptEvent, ScriptStart } from "./script";
import type { ShellRequest } from "./parse";

// ---- The browser functions this module needs, taken before any script ----

interface WorkerScope {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: MessageEvent<ScriptStart>) => void): void;
}

const scope = globalThis as unknown as WorkerScope;
const apply = Reflect.apply;
const XHR = XMLHttpRequest;
const xhrOpen = XHR.prototype.open;
const xhrSetHeader = XHR.prototype.setRequestHeader;
const xhrSend = XHR.prototype.send;
const xhrStatus = Object.getOwnPropertyDescriptor(XHR.prototype, "status")!.get!;
const xhrResponseText = Object.getOwnPropertyDescriptor(XHR.prototype, "responseText")!.get!;
const post = scope.postMessage.bind(scope);
const origin = globalThis.location.origin;
const indirectEval = globalThis.eval;
const randomUUID = crypto.randomUUID.bind(crypto);

// Globals a script may not use: the network, storage, other workers, and
// talking to the page behind this module's back.
const LOCKED = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "WebSocketStream",
  "WebTransport",
  "EventSource",
  "importScripts",
  "indexedDB",
  "caches",
  "cookieStore",
  "navigator",
  "BroadcastChannel",
  "Worker",
  "SharedWorker",
  "postMessage",
  "close",
  "onmessage",
  "onmessageerror",
  "addEventListener",
  "removeEventListener",
  "dispatchEvent",
];

// Deletes each name from the global object and its prototypes (where the
// browser defines most of them), then pins it as undefined.
function lockGlobals(): void {
  for (const name of LOCKED) {
    for (let at: object | null = globalThis; at !== null; at = Object.getPrototypeOf(at)) {
      try {
        delete (at as Record<string, unknown>)[name];
      } catch {}
    }
    try {
      Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false });
    } catch {}
  }
}

// ---- Run state ----

let conn = "";
let token = "";
let safeMode: ScriptStart["safeMode"] = 1;
let deadline = Infinity;
let docLimit = 1000;
let outputCap = 1000;
let outputs = 0;
let outputBytes = 0;
let capped = false;

// Text the run keeps across all outputs, so a loop printing large values
// cannot fill the page's memory.
const OUTPUT_BYTES = 16 * 1024 * 1024;
// Documents a cursor reads per request (the server's most).
const BATCH = 1000;
// The name stack traces give the script, for error positions.
const SCRIPT_URL = "mongosh-script";

function emit(event: ScriptEvent): void {
  // The final value always shows; the cap is for what the script prints.
  if (event.type === "print" || (event.type === "value" && event.from === "print")) {
    if (capped) {
      return;
    }
    const size = event.type === "print" ? event.text.length : event.ejson.length;
    if (outputs >= outputCap || outputBytes + size > OUTPUT_BYTES) {
      capped = true;
      post({ type: "capped" } satisfies ScriptEvent);
      return;
    }
    outputs += 1;
    outputBytes += size;
  }
  post(event);
}

// ---- Errors ----

// A refusal from the server, with its fields (ERRORS.md §2). `code` is
// MongoDB's number when there is one, as scripts compare it in mongosh
// (`e.code === 11000`); `appCode` is the app's (`mongo_11000`, `bad_request`).
class MongoServerError extends Error {
  readonly code: number | string;
  readonly appCode: string;
  readonly codeName?: string;
  readonly status: number;
  readonly fields: Record<string, unknown>;
  // The message as a phrase when the app wrote it (not the server).
  readonly phrase?: Phrase;
  constructor(status: number, appCode: string, message: string | Phrase, fields: Record<string, unknown>) {
    super(typeof message === "string" ? message : say(message));
    if (typeof message !== "string") {
      this.phrase = message;
    }
    this.name = "MongoServerError";
    this.status = status;
    this.appCode = appCode;
    const serverCode = typeof fields.server_code === "number" ? fields.server_code : Number(/^mongo_(\d+)$/.exec(appCode)?.[1] ?? NaN);
    this.code = Number.isNaN(serverCode) ? appCode : serverCode;
    this.fields = fields;
    if (typeof fields.code_name === "string") {
      this.codeName = fields.code_name;
    }
  }
}

// A write safe mode asks about: a script cannot ask, so it stops here.
class SafeModeError extends Error {
  readonly phrase: Phrase;
  constructor(what: string) {
    const p = phrase("안전 모드: 스크립트 안의 {what}은(는) 확인 없이 실행하지 않습니다. 이 문장만 따로 실행하면(⌘↩) 확인 창에서 실행할 수 있고, 안전 모드를 끄면 스크립트에서도 바로 실행됩니다.", { what });
    super(say(p));
    this.phrase = p;
    this.name = "SafeModeError";
  }
}

// The server's message for a write it refuses without `confirmed`.
const CONFIRM_REFUSAL = /\(confirmed: true\)/;

// ---- Requests ----

function request(method: "GET" | "POST" | "DELETE", route: string, query: Record<string, string>, body?: unknown): unknown {
  const params = new URLSearchParams({ conn, ...query });
  const xhr = new XHR();
  apply(xhrOpen, xhr, [method, `${origin}/api/doc/${route}?${params}`, false]);
  apply(xhrSetHeader, xhr, ["content-type", "application/json"]);
  apply(xhrSetHeader, xhr, ["x-tablepeek-token", token]);
  try {
    apply(xhrSend, xhr, [body === undefined ? null : stringifyJson(body)]);
  } catch {
    throw new MongoServerError(0, "network", phrase("서버에 연결할 수 없습니다"), {});
  }
  const status = apply(xhrStatus, xhr, []) as number;
  const text = apply(xhrResponseText, xhr, []) as string;
  let json: unknown = null;
  try {
    json = parseJson(text);
  } catch {
    json = null;
  }
  if (status === 0) {
    throw new MongoServerError(0, "network", phrase("서버에 연결할 수 없습니다"), {});
  }
  if (status < 200 || status >= 300) {
    const raw = json !== null && typeof json === "object" ? (json as Record<string, unknown>) : {};
    const inner = raw.error !== null && typeof raw.error === "object" ? (raw.error as Record<string, unknown>) : raw;
    const message = String(inner.message ?? `HTTP ${status}`);
    if (status === 400 && CONFIRM_REFUSAL.test(message)) {
      throw new SafeModeError(message.replace(CONFIRM_REFUSAL, "").trim());
    }
    throw new MongoServerError(status, String(inner.code ?? `http_${status}`), message, inner);
  }
  return json;
}

function postDoc(route: string, body: Record<string, unknown>): unknown {
  return request("POST", route, {}, body);
}

// maxTimeMS for a read: what is left of the run's time limit.
function remainingMs(): number | undefined {
  return deadline === Infinity ? undefined : Math.max(1, Math.floor(deadline - Date.now()));
}

// Under safe mode off every write goes confirmed; otherwise a write the
// mongosh tab would ask about is refused (the server would refuse most of
// them anyway).
function confirmWrite(req: ShellRequest, what: string): boolean {
  if (safeMode === 0) {
    return true;
  }
  if (review(req, what, safeMode) !== null) {
    throw new SafeModeError(what);
  }
  return false;
}

// ---- Values between JavaScript and BSON ----

const SHELL_KIND = Symbol("mongoshKind");

function isBsonScalar(v: object): boolean {
  return (
    v instanceof ObjectId ||
    v instanceof Int32 ||
    v instanceof Int64 ||
    v instanceof Double ||
    v instanceof Decimal128 ||
    v instanceof BsonDate ||
    v instanceof Binary ||
    v instanceof BsonRegex ||
    v instanceof Timestamp ||
    v instanceof Code ||
    v instanceof MinKey ||
    v instanceof MaxKey ||
    v instanceof BsonUndefined
  );
}

// A script value as BSON, the way the Node driver stores it: integral
// numbers that fit 32 bits as Int32, other numbers as Double, bigint as
// Int64, Date and RegExp as their BSON types; `undefined` and functions in
// an object are left out. Undefined at the top stays undefined.
function toBson(v: unknown, seen: Set<object> = new Set()): BsonValue | undefined {
  if (v === null || typeof v === "string" || typeof v === "boolean") {
    return v;
  }
  if (typeof v === "number") {
    return Number.isInteger(v) && !Object.is(v, -0) && v >= -2147483648 && v <= 2147483647 ? new Int32(v) : new Double(v);
  }
  if (typeof v === "bigint") {
    return new Int64(v);
  }
  if (v === undefined || typeof v === "function" || typeof v === "symbol") {
    return undefined;
  }
  const obj = v as object;
  if (isBsonScalar(obj)) {
    return obj as BsonValue;
  }
  if (obj instanceof Date) {
    if (Number.isNaN(obj.getTime())) {
      throw phraseError(phrase("잘못된 날짜(Invalid Date)는 저장할 수 없습니다"), TypeError);
    }
    return BsonDate.fromDate(obj);
  }
  if (obj instanceof RegExp) {
    return new BsonRegex(obj.source, obj.flags.replace(/[^imsu]/g, ""));
  }
  const kind = (obj as Record<symbol, unknown>)[SHELL_KIND];
  if (kind !== undefined) {
    throw phraseError(phrase("{kind}은(는) 값으로 쓸 수 없습니다", { kind: String(kind) }), TypeError);
  }
  if (seen.has(obj)) {
    throw phraseError(phrase("순환 참조가 있는 값은 BSON으로 바꿀 수 없습니다"), TypeError);
  }
  seen.add(obj);
  try {
    if (Array.isArray(obj)) {
      return obj.map((x) => toBson(x, seen) ?? null);
    }
    const doc: BsonDocument = new Map();
    if (obj instanceof Map) {
      for (const [key, value] of obj) {
        const b = toBson(value, seen);
        if (b !== undefined) {
          doc.set(String(key), b);
        }
      }
      return doc;
    }
    const record = obj as Record<string, unknown>;
    for (const key of jsonKeys(obj)) {
      const b = toBson(record[key], seen);
      if (b !== undefined) {
        doc.set(key, b);
      }
    }
    return doc;
  } finally {
    seen.delete(obj);
  }
}

// A document argument: an object (or nothing, for `fallback`).
function docArg(v: unknown, what: string, fallback?: BsonDocument): BsonDocument {
  if (v === undefined && fallback !== undefined) {
    return fallback;
  }
  const b = toBson(v);
  if (b === undefined || !isDocument(b)) {
    throw phraseError(phrase("{what}은(는) 문서({ … })여야 합니다", { what }), TypeError);
  }
  return b;
}

function optionalDoc(v: unknown, what: string): BsonDocument | null {
  return v === undefined || v === null ? null : docArg(v, what);
}

// BSON as the script sees it, as mongosh shows it: documents as plain
// objects (keeping field order, "2024" keys included, for writing back),
// Int32 and Double as numbers, dates as Date; Int64, Decimal128 and the
// rest as their BSON classes.
function toJs(v: BsonValue): unknown {
  if (isDocument(v)) {
    return jsonObject([...v].map(([key, value]): [string, unknown] => [key, toJs(value)]));
  }
  if (Array.isArray(v)) {
    return v.map(toJs);
  }
  if (v instanceof Int32 || v instanceof Double) {
    return v.value;
  }
  if (v instanceof BsonDate) {
    return v.iso() === null ? v : v.toDate();
  }
  if (v instanceof BsonRegex && /^[imsu]*$/.test(v.options)) {
    try {
      // A pattern JavaScript would write differently ("a/b" reads back as
      // "a\/b") stays a BSON regex so writing it back keeps it as stored.
      const re = new RegExp(v.pattern, v.options);
      return re.source === v.pattern ? re : v;
    } catch {
      return v;
    }
  }
  return v;
}

function bsonOf(json: unknown): BsonValue {
  return fromEJSON(json);
}

function docsOf(json: unknown): BsonDocument[] {
  return Array.isArray(json) ? json.map(bsonOf).filter(isDocument) : [];
}

function numberOf(v: unknown): number {
  const b = typeof v === "object" && v !== null ? bsonOf(v) : v;
  if (b instanceof Int32 || b instanceof Double) {
    return b.value;
  }
  if (b instanceof Int64) {
    return Number(b.value);
  }
  return typeof b === "number" ? b : Number(b) || 0;
}

// ---- Output ----

// Text for one print argument: strings as they are, values in mongosh
// notation.
function printText(v: unknown): string {
  if (typeof v === "string") {
    return v;
  }
  if (v === undefined || typeof v === "number" || typeof v === "bigint" || typeof v === "boolean") {
    return String(v);
  }
  if (typeof v === "function") {
    return `[Function: ${v.name || "anonymous"}]`;
  }
  if (typeof v === "symbol") {
    return v.toString();
  }
  const kind = typeof v === "object" && v !== null ? (v as Record<symbol, unknown>)[SHELL_KIND] : undefined;
  if (kind !== undefined) {
    return String(v);
  }
  try {
    return toShell(toBson(v) ?? null);
  } catch {
    return String(v);
  }
}

// A value shown in the page: documents (and cursors, read up to the limit)
// in the result views, anything else as text.
function showValue(v: unknown, from: "print" | "result"): void {
  if (v instanceof Cursor) {
    const docs: BsonDocument[] = [];
    while (docs.length < docLimit && v.hasNext()) {
      const next = toBson(v.next());
      docs.push(next !== undefined && isDocument(next) ? next : new Map([["value", next ?? null]]));
    }
    emit({ type: "value", ejson: stringifyJson(docs.map(toEJSON)), from, coll: v.collName(), more: v.hasNext() });
    return;
  }
  const kind = typeof v === "object" && v !== null ? (v as Record<symbol, unknown>)[SHELL_KIND] : undefined;
  if (typeof v === "string" || typeof v === "function" || typeof v === "symbol" || kind !== undefined) {
    emit({ type: "print", text: printText(v) });
    return;
  }
  const b = toBson(v);
  emit({ type: "value", ejson: stringifyJson(toEJSON(b ?? null)), from, coll: null, more: false });
}

function print(...args: unknown[]): void {
  if (args.length === 1 && typeof args[0] === "object" && args[0] !== null && !(args[0] as Record<symbol, unknown>)[SHELL_KIND]) {
    showValue(args[0], "print");
    return;
  }
  emit({ type: "print", text: args.map(printText).join(" ") });
}

function printjson(v: unknown): void {
  if (typeof v === "string") {
    emit({ type: "print", text: JSON.stringify(v) });
    return;
  }
  showValue(v, "print");
}

// ---- Cursors ----

interface FindSpec {
  db: string;
  coll: string;
  filter: BsonDocument;
  projection: BsonDocument | null;
  sort: BsonDocument | null;
  skip: number;
  limit: number;
  batch: number;
  hint: BsonValue | null;
  collation: BsonDocument | null;
  maxTimeMS: number | null;
}

// Options shared by the reads (MONGODB.md §8.3).
function readOptions(o: { hint: BsonValue | null; collation: BsonDocument | null; maxTimeMS: number | null }): Record<string, unknown> {
  const left = remainingMs();
  const max = o.maxTimeMS !== null && left !== undefined ? Math.min(o.maxTimeMS, left) : (o.maxTimeMS ?? left);
  return {
    hint: o.hint === null ? undefined : toEJSON(o.hint),
    collation: o.collation === null ? undefined : toEJSON(o.collation),
    maxTimeMS: max,
  };
}

function hintArg(v: unknown): BsonValue {
  return typeof v === "string" ? v : docArg(v, "hint");
}

function countArg(v: unknown, what: string): number {
  const n = typeof v === "number" ? v : v instanceof Int32 || v instanceof Double ? v.value : v instanceof Int64 ? Number(v.value) : NaN;
  if (!Number.isInteger(n) || n < 0) {
    throw phraseError(phrase("{what}에는 0 이상의 정수를 주세요", { what }), TypeError);
  }
  return n;
}

// Server cursors (`/api/doc/cursor/*`) the script has open, closed when it
// ends; a stopped worker leaves them to the server's idle timeout.
const openCursors = new Set<string>();

function closeOpenCursors(): void {
  for (const id of openCursors) {
    try {
      postDoc("cursor/close", { id });
    } catch {}
  }
  openCursors.clear();
}

// A cursor over a server cursor, read a batch at a time as the script asks
// for documents; `map` callbacks apply as they are read.
abstract class Cursor {
  [SHELL_KIND] = "Cursor";
  protected buffer: BsonDocument[] = [];
  protected done = false;
  protected started = false;
  private id: string | null = null;
  private opened = false;
  private maps: ((doc: unknown) => unknown)[] = [];

  // The body of `cursor/open`: the find or aggregate and the batch size.
  protected abstract openBody(): Record<string, unknown>;
  abstract collName(): string;
  abstract explain(verbosity?: string): unknown;

  private fetch(): void {
    let r: { id?: string | null; batch: unknown[]; done: boolean };
    if (!this.opened) {
      this.opened = true;
      r = postDoc("cursor/open", this.openBody()) as typeof r;
      this.id = r.id ?? null;
      if (this.id !== null) {
        openCursors.add(this.id);
      }
    } else if (this.id !== null) {
      r = postDoc("cursor/next", { id: this.id }) as typeof r;
    } else {
      this.done = true;
      return;
    }
    this.buffer.push(...docsOf(r.batch));
    if (r.done || this.id === null) {
      this.forget();
    }
  }

  // The server closed the cursor (or never kept one).
  private forget(): void {
    if (this.id !== null) {
      openCursors.delete(this.id);
      this.id = null;
    }
    this.done = true;
  }

  protected change(): this {
    if (this.started) {
      throw phraseError(phrase("읽기 시작한 커서는 바꿀 수 없습니다"));
    }
    return this;
  }

  hasNext(): boolean {
    this.started = true;
    while (this.buffer.length === 0 && !this.done) {
      this.fetch();
    }
    return this.buffer.length > 0;
  }

  next(): unknown {
    if (!this.hasNext()) {
      throw phraseError(phrase("커서에 더 읽을 문서가 없습니다"));
    }
    let doc = toJs(this.buffer.shift()!);
    for (const fn of this.maps) {
      doc = fn(doc);
    }
    return doc;
  }

  tryNext(): unknown {
    return this.hasNext() ? this.next() : null;
  }

  toArray(): unknown[] {
    const out: unknown[] = [];
    while (this.hasNext()) {
      out.push(this.next());
    }
    return out;
  }

  // Stops early when the callback returns false, as the Node driver does.
  forEach(fn: (doc: unknown) => unknown): void {
    while (this.hasNext()) {
      if (fn(this.next()) === false) {
        break;
      }
    }
  }

  map(fn: (doc: unknown) => unknown): this {
    if (typeof fn !== "function") {
      throw phraseError(phrase("map에는 함수를 주세요"), TypeError);
    }
    this.maps.push(fn);
    return this;
  }

  itcount(): number {
    let n = 0;
    while (this.hasNext()) {
      this.buffer.shift();
      n += 1;
    }
    return n;
  }

  isExhausted(): boolean {
    return this.done && this.buffer.length === 0;
  }

  close(): void {
    const id = this.id;
    this.forget();
    this.buffer = [];
    if (id !== null) {
      postDoc("cursor/close", { id });
    }
  }

  pretty(): this {
    return this;
  }

  [Symbol.iterator](): Iterator<unknown> {
    return { next: () => (this.hasNext() ? { value: this.next(), done: false } : { value: undefined, done: true }) };
  }

  toString(): string {
    return `Cursor(${this.collName()})`;
  }
}

class FindCursor extends Cursor {
  constructor(private spec: FindSpec) {
    super();
  }

  collName(): string {
    return this.spec.coll;
  }

  protected openBody(): Record<string, unknown> {
    const s = this.spec;
    return {
      db: s.db,
      coll: s.coll,
      find: {
        filter: toEJSON(s.filter),
        projection: s.projection === null ? undefined : toEJSON(s.projection),
        sort: s.sort === null ? undefined : toEJSON(s.sort),
        skip: s.skip || undefined,
        limit: s.limit || undefined,
        ...readOptions(s),
      },
      batchSize: s.batch,
    };
  }

  sort(v: unknown): this {
    this.change().spec.sort = docArg(v, "sort");
    return this;
  }
  skip(n: unknown): this {
    this.change().spec.skip = countArg(n, "skip");
    return this;
  }
  limit(n: unknown): this {
    // A negative limit means "one batch" in mongosh; here the same count.
    const v = typeof n === "number" ? Math.abs(n) : n;
    this.change().spec.limit = countArg(v, "limit");
    return this;
  }
  // The server takes 1–1000.
  batchSize(n: unknown): this {
    this.change().spec.batch = Math.min(BATCH, Math.max(1, countArg(n, "batchSize")));
    return this;
  }
  project(v: unknown): this {
    this.change().spec.projection = docArg(v, "projection");
    return this;
  }
  projection(v: unknown): this {
    return this.project(v);
  }
  hint(v: unknown): this {
    this.change().spec.hint = hintArg(v);
    return this;
  }
  collation(v: unknown): this {
    this.change().spec.collation = docArg(v, "collation");
    return this;
  }
  maxTimeMS(n: unknown): this {
    this.change().spec.maxTimeMS = countArg(n, "maxTimeMS");
    return this;
  }

  // countDocuments of the filter; with `applySkipLimit` the cursor's skip
  // and limit cut it the way the cursor would.
  count(applySkipLimit = false): number {
    const s = this.spec;
    let n = countDocuments(s.db, s.coll, s.filter, s);
    if (applySkipLimit) {
      n = Math.max(0, n - s.skip);
      if (s.limit > 0) {
        n = Math.min(n, s.limit);
      }
    }
    return n;
  }
  size(): number {
    return this.count(true);
  }

  explain(verbosity: unknown = "queryPlanner"): unknown {
    const s = this.spec;
    return toJs(
      bsonOf(
        postDoc("explain", {
          db: s.db,
          coll: s.coll,
          verbosity: explainVerbosity(verbosity),
          find: {
            filter: toEJSON(s.filter),
            projection: s.projection === null ? undefined : toEJSON(s.projection),
            sort: s.sort === null ? undefined : toEJSON(s.sort),
            skip: s.skip || undefined,
            limit: s.limit || undefined,
          },
          ...readOptions(s),
        }),
      ),
    );
  }
}

class AggregateCursor extends Cursor {
  constructor(
    private db: string,
    private coll: string,
    private pipeline: BsonDocument[],
    private options: { hint: BsonValue | null; collation: BsonDocument | null; maxTimeMS: number | null },
  ) {
    super();
  }

  collName(): string {
    return this.coll;
  }

  protected openBody(): Record<string, unknown> {
    let confirmed = false;
    if (pipelineWrites(this.pipeline)) {
      if (safeMode !== 0) {
        throw new SafeModeError("$out·$merge aggregate");
      }
      confirmed = true;
    }
    return {
      db: this.db,
      coll: this.coll,
      aggregate: { pipeline: this.pipeline.map(toEJSON), ...readOptions(this.options) },
      batchSize: BATCH,
      confirmed: confirmed || undefined,
    };
  }

  explain(verbosity: unknown = "queryPlanner"): unknown {
    return toJs(
      bsonOf(
        postDoc("explain", {
          db: this.db,
          coll: this.coll,
          verbosity: explainVerbosity(verbosity),
          aggregate: { pipeline: this.pipeline.map(toEJSON) },
          ...readOptions(this.options),
        }),
      ),
    );
  }
}

const VERBOSITIES = ["queryPlanner", "executionStats", "allPlansExecution"];

function explainVerbosity(v: unknown): string {
  if (v === true) {
    return "allPlansExecution";
  }
  if (v === false || v === undefined) {
    return "queryPlanner";
  }
  if (typeof v === "string" && VERBOSITIES.includes(v)) {
    return v;
  }
  throw phraseError(phrase("explain의 상세도는 {list} 중 하나입니다", { list: VERBOSITIES.join(", ") }), TypeError);
}

// An exact count; an empty filter would be estimated, so it becomes one
// that matches every document.
function countDocuments(db: string, coll: string, filter: BsonDocument, o: { hint: BsonValue | null; collation: BsonDocument | null; maxTimeMS: number | null }): number {
  const exact = filter.size === 0 ? new Map([["_id", new Map([["$exists", true]])]]) : filter;
  const r = postDoc("count", { db, coll, filter: toEJSON(exact as BsonDocument), ...readOptions(o) }) as { count: unknown };
  if (r.count === null || r.count === undefined) {
    throw new MongoServerError(200, "mongo_50", phrase("세는 데 시간이 너무 걸려 멈췄습니다"), {});
  }
  return numberOf(r.count);
}

// ---- Collections and databases ----

function readOpts(options: unknown): { hint: BsonValue | null; collation: BsonDocument | null; maxTimeMS: number | null } {
  const o = options !== null && typeof options === "object" ? (options as Record<string, unknown>) : {};
  return {
    hint: o.hint === undefined ? null : hintArg(o.hint),
    collation: o.collation === undefined ? null : docArg(o.collation, "collation"),
    maxTimeMS: o.maxTimeMS === undefined ? null : countArg(o.maxTimeMS, "maxTimeMS"),
  };
}

function upsertOf(options: unknown): boolean {
  return options !== null && typeof options === "object" && (options as Record<string, unknown>).upsert === true;
}

function insertedFailure(r: { errors?: Record<string, unknown>[] }): void {
  const failed = r.errors?.[0];
  if (failed !== undefined) {
    const code = String(failed.code ?? "mongodb_error");
    throw new MongoServerError(200, /^\d+$/.test(code) ? `mongo_${code}` : code, String(failed.message ?? ""), failed);
  }
}

class Collection {
  [SHELL_KIND] = "Collection";
  constructor(
    private readonly _db: string,
    private readonly _name: string,
  ) {}

  getName(): string {
    return this._name;
  }
  getFullName(): string {
    return `${this._db}.${this._name}`;
  }
  getDB(): unknown {
    return dbProxy(this._db);
  }
  toString(): string {
    return this.getFullName();
  }

  find(filter?: unknown, projection?: unknown, options?: unknown): FindCursor {
    const o = readOpts(options);
    return new FindCursor({
      db: this._db,
      coll: this._name,
      filter: docArg(filter, "filter", new Map()),
      projection: optionalDoc(projection, "projection"),
      sort: null,
      skip: 0,
      limit: 0,
      batch: BATCH,
      ...o,
    });
  }

  findOne(filter?: unknown, projection?: unknown, options?: unknown): unknown {
    const docs = this.find(filter, projection, options).limit(1).toArray();
    return docs[0] ?? null;
  }

  countDocuments(filter?: unknown, options?: unknown): number {
    return countDocuments(this._db, this._name, docArg(filter, "filter", new Map()), readOpts(options));
  }

  count(filter?: unknown, options?: unknown): number {
    return this.countDocuments(filter, options);
  }

  estimatedDocumentCount(options?: unknown): number {
    const r = postDoc("count", { db: this._db, coll: this._name, filter: {}, ...readOptions(readOpts(options)) }) as { count: unknown };
    return numberOf(r.count);
  }

  distinct(key: unknown, filter?: unknown): unknown[] {
    if (typeof key !== "string") {
      throw phraseError(phrase("distinct에는 필드 이름을 주세요"), TypeError);
    }
    const r = postDoc("distinct", { db: this._db, coll: this._name, key, filter: toEJSON(docArg(filter, "filter", new Map())) }) as { values?: unknown[] };
    return (r.values ?? []).map((x) => toJs(bsonOf(x)));
  }

  // aggregate([stages], options) or aggregate(stage, stage, …).
  aggregate(...args: unknown[]): AggregateCursor {
    const list = Array.isArray(args[0]) ? args[0] : args;
    const options = Array.isArray(args[0]) ? args[1] : undefined;
    const pipeline = list.map((stage) => docArg(stage, "pipeline stage"));
    return new AggregateCursor(this._db, this._name, pipeline, readOpts(options));
  }

  insertOne(doc: unknown): unknown {
    const d = docArg(doc, "document");
    if (safeMode !== 0) {
      confirmWrite({ kind: "insertOne", coll: this._name, doc: d, db: null }, "insertOne");
    }
    const r = postDoc("insert", { db: this._db, coll: this._name, docs: [toEJSON(d)] }) as { insertedIds?: unknown[]; errors?: Record<string, unknown>[] };
    insertedFailure(r);
    return { acknowledged: true, insertedId: toJs(bsonOf(r.insertedIds?.[0] ?? null)) };
  }

  insertMany(docs: unknown, options?: unknown): unknown {
    if (!Array.isArray(docs)) {
      throw phraseError(phrase("insertMany에는 문서 배열을 주세요"), TypeError);
    }
    const list = docs.map((d) => docArg(d, "document"));
    if (safeMode !== 0) {
      confirmWrite({ kind: "insertMany", coll: this._name, docs: list, db: null }, "insertMany");
    }
    const ordered = options !== null && typeof options === "object" && (options as Record<string, unknown>).ordered === false ? false : undefined;
    const r = postDoc("insert", { db: this._db, coll: this._name, docs: list.map(toEJSON), ordered }) as { insertedIds?: unknown[]; errors?: Record<string, unknown>[] };
    insertedFailure(r);
    const ids = (r.insertedIds ?? []).map((x, i): [string, unknown] => [String(i), toJs(bsonOf(x))]);
    return { acknowledged: true, insertedIds: jsonObject(ids) };
  }

  private updateWith(many: boolean, filter: unknown, update: unknown, options: unknown): unknown {
    const f = docArg(filter, "filter");
    const u = Array.isArray(update) ? update.map((stage) => docArg(stage, "update")) : docArg(update, "update");
    const upsert = upsertOf(options);
    const kind = many ? "updateMany" : "updateOne";
    const confirmed = confirmWrite({ kind, coll: this._name, filter: f, update: u, upsert, db: null }, kind);
    const r = postDoc("update", {
      db: this._db,
      coll: this._name,
      filter: toEJSON(f),
      update: Array.isArray(u) ? u.map(toEJSON) : toEJSON(u),
      many,
      upsert,
      confirmed: confirmed || undefined,
    }) as { matched?: number; modified?: number };
    return { acknowledged: true, matchedCount: Number(r.matched) || 0, modifiedCount: Number(r.modified) || 0 };
  }

  updateOne(filter: unknown, update: unknown, options?: unknown): unknown {
    return this.updateWith(false, filter, update, options);
  }

  updateMany(filter: unknown, update: unknown, options?: unknown): unknown {
    return this.updateWith(true, filter, update, options);
  }

  replaceOne(filter: unknown, replacement: unknown, options?: unknown): unknown {
    const f = docArg(filter, "filter");
    const doc = docArg(replacement, "replacement");
    if (upsertOf(options)) {
      throw phraseError(phrase("replaceOne의 upsert는 지원하지 않습니다 — updateOne(…, { upsert: true })를 쓰세요"), TypeError);
    }
    const confirmed = confirmWrite({ kind: "replaceOne", coll: this._name, filter: f, replacement: doc, upsert: false, db: null }, "replaceOne");
    const r = postDoc("replace", { db: this._db, coll: this._name, filter: toEJSON(f), replacement: toEJSON(doc), confirmed: confirmed || undefined }) as { matched?: number; modified?: number };
    return { acknowledged: true, matchedCount: Number(r.matched) || 0, modifiedCount: Number(r.modified) || 0 };
  }

  private deleteWith(many: boolean, filter: unknown): unknown {
    const f = docArg(filter, "filter");
    const kind = many ? "deleteMany" : "deleteOne";
    const confirmed = confirmWrite({ kind, coll: this._name, filter: f, db: null }, kind);
    const r = postDoc("delete", { db: this._db, coll: this._name, filter: toEJSON(f), many, confirmed: confirmed || undefined }) as { deleted?: number };
    return { acknowledged: true, deletedCount: Number(r.deleted) || 0 };
  }

  deleteOne(filter: unknown): unknown {
    return this.deleteWith(false, filter);
  }

  deleteMany(filter: unknown): unknown {
    return this.deleteWith(true, filter);
  }

  createIndex(keys: unknown, options?: unknown): string {
    const k = docArg(keys, "keys");
    const o = docArg(options, "options", new Map());
    if (safeMode !== 0) {
      confirmWrite({ kind: "createIndex", coll: this._name, keys: k, options: o, db: null }, "createIndex");
    }
    const r = postDoc("indexes", { db: this._db, coll: this._name, keys: toEJSON(k), options: toEJSON(o) }) as { name?: string };
    return String(r.name);
  }

  getIndexes(): unknown[] {
    const list = request("GET", "indexes", { db: this._db, coll: this._name }) as unknown[];
    return list.map((x) => toJs(bsonOf(x)));
  }

  dropIndex(index: unknown): unknown {
    let name: string;
    if (typeof index === "string") {
      name = index;
    } else {
      const spec = toShell(docArg(index, "index"));
      const list = request("GET", "indexes", { db: this._db, coll: this._name }) as unknown[];
      const found = list.map(bsonOf).find((ix) => isDocument(ix) && toShell(ix.get("key") ?? null) === spec);
      if (found === undefined || !isDocument(found)) {
        throw new MongoServerError(400, "index_not_found", phrase("이 키의 인덱스가 없습니다: {key}", { key: spec }), {});
      }
      name = String(found.get("name"));
    }
    confirmWrite({ kind: "dropIndex", coll: this._name, index: name, db: null }, "dropIndex");
    request("DELETE", "indexes", {}, { db: this._db, coll: this._name, name });
    return { ok: 1 };
  }

  drop(): boolean {
    const confirmed = confirmWrite({ kind: "drop", coll: this._name, db: null }, "drop");
    postDoc("command", { db: this._db, command: toEJSON(new Map([["drop", this._name]])), confirmed: confirmed || undefined });
    return true;
  }

  stats(): unknown {
    return toJs(bsonOf(postDoc("command", { db: this._db, command: toEJSON(new Map([["collStats", this._name]])) })));
  }

  // explain(verbosity).find(…) / .aggregate(…).
  explain(verbosity?: unknown): unknown {
    const v = explainVerbosity(verbosity);
    return {
      [SHELL_KIND]: "Explainable",
      find: (filter?: unknown, projection?: unknown) => this.find(filter, projection).explain(v),
      aggregate: (...args: unknown[]) => this.aggregate(...args).explain(v),
      toString: () => `Explainable(${this.getFullName()})`,
    };
  }
}

// Names a proxy never turns into a collection: what JavaScript itself asks
// an object for (awaiting, printing, converting).
const NOT_COLLECTIONS: Record<string, boolean> = { then: true, toJSON: true, inspect: true, constructor: true, valueOf: true, toString: true, asymmetricMatch: true, nodeType: true };

// `db.orders.archive` is the collection "orders.archive", as in mongosh.
function collectionProxy(db: string, name: string): Collection {
  return new Proxy(new Collection(db, name), {
    get(target, prop, receiver) {
      if (typeof prop === "symbol" || prop in target || Object.hasOwn(NOT_COLLECTIONS, prop)) {
        return Reflect.get(target, prop, receiver);
      }
      return collectionProxy(db, `${name}.${prop}`);
    },
  });
}

// Database names `use` and `getSiblingDB` accept (as parse.ts).
const DB_NAME = /^[^\s/\\."$*<>:|?;]+$/;

class Database {
  [SHELL_KIND] = "Database";
  constructor(private readonly _name: string) {}

  getName(): string {
    return this._name;
  }
  toString(): string {
    return this._name;
  }

  getSiblingDB(name: unknown): unknown {
    if (typeof name !== "string" || !DB_NAME.test(name)) {
      throw phraseError(phrase("데이터베이스 이름이 올바르지 않습니다: {name}", { name: String(name) }), TypeError);
    }
    return dbProxy(name);
  }

  getCollection(name: unknown): Collection {
    if (typeof name !== "string" || name === "") {
      throw phraseError(phrase("컬렉션 이름을 문자열로 주세요"), TypeError);
    }
    return collectionProxy(this._name, name);
  }

  getCollectionInfos(): unknown[] {
    const list = request("GET", "collections", { db: this._name }) as unknown[];
    return list.map((x) => toJs(bsonOf(x)));
  }

  getCollectionNames(): string[] {
    return (request("GET", "collections", { db: this._name }) as { name: string }[]).map((c) => String(c.name));
  }

  // One of the commands the server allows (driver.rs SHELL_COMMANDS).
  runCommand(command: unknown): unknown {
    const cmd = typeof command === "string" ? new Map<string, BsonValue>([[command, new Int32(1)]]) : docArg(command, "command");
    let confirmed = false;
    if (commandNeedsConfirm(cmd)) {
      if (safeMode !== 0) {
        throw new SafeModeError(String(cmd.keys().next().value));
      }
      confirmed = true;
    }
    return toJs(bsonOf(postDoc("command", { db: this._name, command: toEJSON(cmd), confirmed: confirmed || undefined })));
  }

  adminCommand(command: unknown): unknown {
    return new Database("admin").runCommand(command);
  }

  stats(): unknown {
    return this.runCommand({ dbStats: 1 });
  }

  createCollection(name: unknown, options?: unknown): unknown {
    if (typeof name !== "string" || name === "") {
      throw phraseError(phrase("컬렉션 이름을 문자열로 주세요"), TypeError);
    }
    return this.runCommand(new Map<string, BsonValue>([["create", name], ...docArg(options, "options", new Map())]));
  }

  dropDatabase(): unknown {
    return this.runCommand({ dropDatabase: 1 });
  }
}

function dbProxy(name: string): Database {
  return new Proxy(new Database(name), {
    get(target, prop, receiver) {
      if (typeof prop === "symbol" || prop in target || Object.hasOwn(NOT_COLLECTIONS, prop)) {
        return Reflect.get(target, prop, receiver);
      }
      return collectionProxy(name, prop);
    },
  });
}

// ---- use and show ----

// Both print what they did, as mongosh does, wherever they stand.
function use(name: unknown): void {
  if (typeof name !== "string" || !DB_NAME.test(name)) {
    throw phraseError(phrase("데이터베이스 이름이 올바르지 않습니다: {name}", { name: String(name) }), TypeError);
  }
  (globalThis as Record<string, unknown>).db = dbProxy(name);
  emit({ type: "use", db: name });
  const switched = phrase("{db} 데이터베이스로 바꿨습니다", { db: name });
  emit({ type: "print", text: say(switched), phrase: switched });
}

function showWhat(what: unknown): void {
  const current = (globalThis as Record<string, unknown>).db;
  const dbName = current instanceof Database ? current.getName() : "test";
  let list: unknown[];
  switch (what) {
    case "dbs":
    case "databases":
      list = (request("GET", "databases", {}) as unknown[]).map((x) => toJs(bsonOf(x)));
      break;
    case "collections":
    case "tables":
      list = (request("GET", "collections", { db: dbName }) as unknown[]).map((x) => {
        const d = bsonOf(x);
        return isDocument(d) ? toJs(new Map([["name", d.get("name") ?? null], ["type", d.get("type") ?? null], ["count", d.get("count") ?? null]])) : null;
      });
      break;
    default:
      throw phraseError(phrase("show {what}은(는) 지원하지 않습니다 — show dbs, show collections를 쓰세요", { what: String(what) }), TypeError);
  }
  showValue(list, "print");
}

// `use x` and `show y` lines become calls; everything else is JavaScript.
// Lines keep their place so error positions still match the editor.
function preparse(code: string): string {
  return code.replace(/^([ \t]*)(use|show)[ \t]+([^\s;'"`()]+)[ \t]*;?[ \t]*(\/\/[^\n]*)?$/gm, (_all, lead: string, cmd: string, arg: string) =>
    cmd === "use" ? `${lead}use(${JSON.stringify(arg)});` : `${lead}__show(${JSON.stringify(arg)});`,
  );
}

// ---- BSON helpers ----

// A constructor callable with or without `new` whose results are the
// app's BSON classes (so `instanceof` works on both).
function helper<T>(make: (...args: never[]) => T, proto: object | null): (...args: never[]) => T {
  const fn = function (this: unknown, ...args: never[]) {
    return make(...args);
  };
  if (proto !== null) {
    fn.prototype = proto;
  }
  return fn;
}

function numberText(v: unknown, what: string): string {
  if (typeof v === "string") {
    return v;
  }
  if (typeof v === "number" || typeof v === "bigint") {
    return String(v);
  }
  if (v instanceof Int32 || v instanceof Double || v instanceof Int64 || v instanceof Decimal128) {
    return String(v.value);
  }
  throw phraseError(phrase("{what}에는 숫자나 숫자 문자열을 주세요", { what }), TypeError);
}

function isoDate(text?: unknown): Date {
  if (text === undefined) {
    return new Date();
  }
  if (typeof text === "number" || text instanceof Date) {
    return new Date(text);
  }
  const s = String(text);
  // A date-time without a zone is UTC, as in mongosh.
  const zoned = /[zZ]$|[+-]\d{2}:?\d{2}$/.test(s) || !/T|\d{2}:\d{2}/.test(s) ? s : `${s}Z`;
  const date = new Date(zoned);
  if (Number.isNaN(date.getTime())) {
    throw phraseError(phrase("ISODate로 읽을 수 없는 날짜입니다: {text}", { text: s }), TypeError);
  }
  return date;
}

function decimal(v?: unknown): Decimal128 {
  return new Decimal128(v === undefined ? "0" : numberText(v, "NumberDecimal"));
}

function long(v?: unknown): Int64 {
  if (typeof v === "number" && !Number.isInteger(v)) {
    return new Int64(Math.trunc(v));
  }
  return new Int64(v === undefined ? 0 : numberText(v, "NumberLong"));
}

function int(v?: unknown): Int32 {
  const n = v === undefined ? 0 : Number(numberText(v, "NumberInt"));
  return new Int32(Math.trunc(n) | 0);
}

function double(v?: unknown): Double {
  return new Double(v === undefined ? 0 : Number(numberText(v, "Double")));
}

function uuid(text?: unknown): Binary {
  return Binary.fromUuid(text === undefined ? randomUUID() : String(text));
}

function timestamp(a?: unknown, b?: unknown): Timestamp {
  if (a !== null && typeof a === "object" && !(a instanceof Int64)) {
    const o = a as Record<string, unknown>;
    return new Timestamp(Number(o.t ?? 0), Number(o.i ?? 0));
  }
  if (a instanceof Int64) {
    return new Timestamp(Number(a.value >> 32n), Number(a.value & 0xffffffffn));
  }
  return new Timestamp(Number(a ?? 0), Number(b ?? 0));
}

function binData(subType: unknown, base64: unknown): Binary {
  return new Binary(String(base64), Number(subType));
}

// `Binary(base64, subType)` and `Binary.createFromBase64(…)` and friends,
// as the app's own mongosh text and its code export write binary values.
const createFromBase64 = (base64: unknown, subType: unknown = 0) => new Binary(String(base64), Number(subType));
const binaryHelper = Object.assign(helper(createFromBase64, Binary.prototype), {
  createFromBase64,
  createFromHexString: (hex: unknown, subType: unknown = 0) => Binary.fromHex(String(hex), Number(subType)),
});

function code(text: unknown, scope?: unknown): Code {
  return new Code(String(text), scope === undefined || scope === null ? null : docArg(scope, "scope"));
}

// A BSON regex kept as written: its pattern need not be a JavaScript one.
function bsonRegExp(pattern: unknown, options: unknown = ""): BsonRegex {
  return new BsonRegex(String(pattern), String(options));
}

function objectId(hex?: unknown): ObjectId {
  return hex === undefined ? ObjectId.generate() : new ObjectId(String(hex));
}

// mongosh's EJSON: relaxed by default, as the bson library's.
const EJSON = {
  stringify(value: unknown, replacer?: unknown, indent?: unknown, options?: unknown): string {
    // stringify(value, options) as well as stringify(value, replacer, indent, options).
    const opts = (replacer !== null && typeof replacer === "object" && !Array.isArray(replacer) ? replacer : options) as { relaxed?: boolean } | undefined;
    const width = typeof indent === "number" ? indent : typeof indent === "string" ? indent.length : 0;
    return ejsonText(toBson(value) ?? null, { relaxed: opts?.relaxed ?? true, indent: width });
  },
  parse(text: unknown): unknown {
    return toJs(fromEJSON(parseJson(String(text))));
  },
  serialize(value: unknown): unknown {
    return parseJson(stringifyJson(toEJSON(toBson(value) ?? null)));
  },
  deserialize(json: unknown): unknown {
    return toJs(fromEJSON(json));
  },
};

// Methods mongosh users call on BSON values, on the app's classes inside
// this worker only.
function extendBsonClasses(): void {
  const define = (proto: object, methods: Record<string, (this: never, ...args: never[]) => unknown>) => {
    for (const [name, fn] of Object.entries(methods)) {
      Object.defineProperty(proto, name, { value: fn, writable: true, configurable: true });
    }
  };
  define(ObjectId.prototype, {
    toString(this: ObjectId) {
      return this.hex;
    },
    toHexString(this: ObjectId) {
      return this.hex;
    },
    toJSON(this: ObjectId) {
      return this.hex;
    },
    getTimestamp(this: ObjectId) {
      return this.timestamp();
    },
    equals(this: ObjectId, other: unknown) {
      return other instanceof ObjectId ? other.hex === this.hex : typeof other === "string" && other.toLowerCase() === this.hex;
    },
  });
  define(Int64.prototype, {
    valueOf(this: Int64) {
      return Number(this.value);
    },
    toNumber(this: Int64) {
      return Number(this.value);
    },
    toString(this: Int64) {
      return this.value.toString();
    },
    toJSON(this: Int64) {
      return Number(this.value);
    },
  });
  for (const proto of [Int32.prototype, Double.prototype]) {
    define(proto, {
      valueOf(this: Int32 | Double) {
        return this.value;
      },
      toString(this: Int32 | Double) {
        return String(this.value);
      },
      toJSON(this: Int32 | Double) {
        return this.value;
      },
    });
  }
  define(Decimal128.prototype, {
    toString(this: Decimal128) {
      return this.value;
    },
    toJSON(this: Decimal128) {
      return { $numberDecimal: this.value };
    },
  });
  define(Binary.prototype, {
    toString(this: Binary) {
      return this.uuid() ?? this.base64;
    },
  });
}

function installGlobals(dbName: string): void {
  const g = globalThis as Record<string, unknown>;
  const consoleOut = { log: print, info: print, warn: print, error: print, debug: print };
  Object.assign(g, {
    db: dbProxy(dbName),
    use,
    __show: showWhat,
    print,
    printjson,
    console: consoleOut,
    EJSON,
    ObjectId: helper(objectId, ObjectId.prototype),
    ISODate: helper(isoDate, Date.prototype),
    NumberDecimal: helper(decimal, Decimal128.prototype),
    Decimal128: helper(decimal, Decimal128.prototype),
    NumberLong: helper(long, Int64.prototype),
    Long: helper(long, Int64.prototype),
    NumberInt: helper(int, Int32.prototype),
    Int32: helper(int, Int32.prototype),
    Double: helper(double, Double.prototype),
    UUID: helper(uuid, Binary.prototype),
    BinData: helper(binData, Binary.prototype),
    Timestamp: helper(timestamp, Timestamp.prototype),
    MinKey: helper(() => MIN_KEY, MinKey.prototype),
    MaxKey: helper(() => MAX_KEY, MaxKey.prototype),
    Binary: binaryHelper,
    Code: helper(code, Code.prototype),
    BSONRegExp: helper(bsonRegExp, BsonRegex.prototype),
    sleep: (ms: unknown) => {
      // A busy wait: a script has no event loop to come back to.
      const until = Date.now() + Number(ms);
      while (Date.now() < until) {
        // waiting
      }
    },
  });
}

// ---- Running ----

// The script's line and column from an error's stack, if it points there.
function scriptPosition(error: unknown): { line?: number; column?: number } {
  const stack = error instanceof Error ? String(error.stack ?? "") : "";
  const m = new RegExp(`${SCRIPT_URL}:(\\d+):(\\d+)`).exec(stack);
  return m ? { line: Number(m[1]), column: Number(m[2]) } : {};
}

function describe(error: unknown): ScriptError {
  if (error instanceof MongoServerError) {
    return { name: error.name, message: error.message, phrase: error.phrase, code: error.appCode, fields: error.fields, status: error.status, ...scriptPosition(error) };
  }
  if (error instanceof SafeModeError) {
    return { name: error.name, message: error.message, phrase: error.phrase, safeMode: true, ...scriptPosition(error) };
  }
  if (error instanceof SyntaxError) {
    return { name: error.name, message: error.message, phrase: phraseOf(error) ?? undefined, syntax: !scriptPosition(error).line };
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message, phrase: phraseOf(error) ?? undefined, ...scriptPosition(error) };
  }
  const p = phrase("스크립트가 오류 아닌 값을 던졌습니다: {value}", { value: printText(error) });
  return { name: "Error", message: say(p), phrase: p };
}

function run(start: ScriptStart): void {
  setLanguage(start.language);
  conn = start.conn;
  token = start.token;
  safeMode = start.safeMode;
  deadline = start.timeLimitMs === null ? Infinity : Date.now() + start.timeLimitMs;
  docLimit = start.docLimit;
  outputCap = start.outputCap;
  extendBsonClasses();
  installGlobals(start.db);
  lockGlobals();
  let event: ScriptEvent;
  try {
    const result: unknown = indirectEval(`${preparse(start.code)}\n//# sourceURL=${SCRIPT_URL}`);
    if (result !== undefined) {
      showValue(result, "result");
    }
    event = { type: "done" };
  } catch (error) {
    event = { type: "error", error: describe(error) };
  }
  // Before saying so: the page ends this worker as soon as it hears.
  closeOpenCursors();
  post(event);
}

let begun = false;
scope.addEventListener("message", (event) => {
  // One script per worker: the page starts a new one for each run.
  if (begun) {
    return;
  }
  begun = true;
  run(event.data);
});
