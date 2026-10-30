// The mongosh tab (MONGODB.md §3.8, §8.2): an editor whose statements are
// parsed in the page and sent as structured requests when every one is
// mongosh's plain form; text with JavaScript of its own (variables, loops,
// functions) runs as a script in a Web Worker (shell/script.ts) instead.
// ⌘↩ runs the selection or the statement under the cursor, ⇧⌘↩ every
// statement. Results show in the same ☰ / {} / ⊞ views as a collection tab,
// read-only, beside a message list that also holds a script's printed
// output. Safe mode asks before an empty-filter updateMany / deleteMany,
// drop and dropIndex (mode 2: before every write); a script refuses those
// writes instead. The server logs each request to the console.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { PlayIcon } from "../../../components/icons";
import { ReviewModal } from "../../../components/ReviewModal";
import { Select } from "../../../components/Select";
import { Spinner } from "../../../components/Spinner";
import { literal, phrase, say, t, type Phrase } from "../../../i18n";
import type { ReviewItem, SafeMode } from "../../../sqlTools";
import * as api from "../api";
import { Double, Int32, Int64, bsonDoc, compareForSort, fromEJSON, isDocument, parseJson, type BsonDocument, type BsonValue } from "../bson";
import { sampleFields, shellTarget, type CompletionContext, type FieldStat } from "../complete";
import { toShell, toShellPretty } from "../format";
import { parseScript, statementAt, tokenize, type ParseResult, type ShellRequest } from "../shell/parse";
import { review } from "../shell/safety";
import { runScript, type ScriptError } from "../shell/script";
import { CardView, docKey } from "./CardView";
import { DocDetail, DocDetailPanel, NothingSelected, useCollectionFacts } from "./DocDetailPanel";
import { DocTableView } from "./DocTableView";
import { JsonView, SyntaxErrorNotice } from "./JsonView";
import { MongoEditor, type MongoEditorHandle } from "./MongoEditor";
import { ShellText } from "./ShellText";
import { ViewSwitch, viewForKey, type DocView } from "./ViewSwitch";
import "../mongodb.css";
import "./shell.css";

// Documents a bare find() brings back (and a cursor a script ends on).
const SHELL_LIMIT = 1000;
// Printed lines and values one script run keeps.
const OUTPUT_CAP = 1000;
// A script's output while it runs reaches the page this often (ms).
const LIVE_OUTPUT_MS = 200;

// What a script printed: text, or a value (printjson, a print of one
// object, the final value).
type ScriptOutput =
  | { kind: "text"; text: string; phrase?: Phrase }
  | { kind: "value"; value: BsonValue; from: "print" | "result"; coll: string | null; more: boolean }
  | { kind: "note"; text: Phrase };

interface ShellMessage {
  // The statement as written.
  source: string;
  ok: boolean;
  // The status, or why it did not run (cancelled).
  text: Phrase;
  // A statement that did not parse: the message and where, in `src`.
  parse: { src: string; at: number; message: Phrase } | null;
  // The server's refusal (for the explained notice).
  error: unknown;
  // Why a script stopped, turned into the notice's error where it shows.
  script?: ScriptError;
  ms: number;
  // A script's output, in order (statements run one by one have none).
  outputs?: ScriptOutput[];
}

interface ShellResult {
  // Documents to show; plain values are wrapped as { value }.
  docs: BsonDocument[];
  // The collection they came from, when there is one.
  coll: string | null;
  status: Phrase;
  reply: BsonValue | null;
}

export interface ShellTabProps {
  conn: string;
  // The connection's stable key (as App keys column widths by).
  connKey: string;
  // The database `db` refers to; `use` changes it through onDbChange.
  db: string;
  tabKey: string;
  text: string;
  onTextChange(text: string): void;
  onDbChange(db: string): void;
  safeMode: SafeMode;
  notify(message: string): void;
  maxTimeMS?: number;
}

const memory = new Map<string, { view: DocView | "messages"; result: ShellResult | null; messages: ShellMessage[]; choices: ShellResult[] }>();

// The documents a value reads as in the result views.
function asDocs(v: BsonValue): BsonDocument[] {
  if (Array.isArray(v)) {
    return v.map((x) => (isDocument(x) ? x : bsonDoc({ value: x })));
  }
  return [isDocument(v) ? v : bsonDoc({ value: v })];
}

// Whether a script's value is documents the result views can show: one
// document, or an array of them.
function readsAsDocs(v: BsonValue): boolean {
  return isDocument(v) || (Array.isArray(v) && v.length > 0 && v.every(isDocument));
}

// A script's error as the error notice reads it: the server's refusal as a
// MongoError (with its explanation), anything else as its message; both
// with the script line it came from.
function scriptErrorValue(e: ScriptError): unknown {
  const position = e.line === undefined ? undefined : { line: e.line, column: e.column };
  const message = e.phrase !== undefined ? say(e.phrase) : e.message;
  if (e.code !== undefined) {
    return new api.MongoError(e.code, message, { ...e.fields, position });
  }
  return { code: "", message: e.safeMode ? message : `${e.name}: ${message}`, position };
}

// A count or size from the API as the BSON number mongosh would print.
function num(n: number | null): BsonValue {
  if (n === null) {
    return null;
  }
  if (Number.isInteger(n)) {
    return Math.abs(n) <= 2147483647 ? new Int32(n) : new Int64(n);
  }
  return new Double(n);
}

export function ShellTab({ conn, connKey, db, tabKey, text, onTextChange, onDbChange, safeMode, notify, maxTimeMS }: ShellTabProps) {
  const remembered = memory.get(tabKey);
  const [view, setView] = useState<DocView | "messages">(remembered?.view ?? "cards");
  const [result, setResult] = useState<ShellResult | null>(remembered?.result ?? null);
  const [messages, setMessages] = useState<ShellMessage[]>(remembered?.messages ?? []);
  const [running, setRunning] = useState(false);
  const [errorRange, setErrorRange] = useState<{ from: number; to: number } | null>(null);
  const [collections, setCollections] = useState<string[]>([]);
  const [tablePath, setTablePath] = useState<string[]>([]);
  const [tableSort, setTableSort] = useState<BsonDocument | null>(null);
  // The card or JSON block in the app's detail panel, with the result it belongs to.
  const [picked, setPicked] = useState<{ of: ShellResult; key: string } | null>(null);
  const [allOpen, setAllOpen] = useState(false);
  const [editorBasis, setEditorBasis] = useState<number | null>(null);
  const [pendingReview, setPendingReview] = useState<{ item: ReviewItem; resolve(ok: boolean): void } | null>(null);
  const editorRef = useRef<MongoEditorHandle | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  // The script running now; stopping it ends its worker.
  const scriptRef = useRef<{ stop(): void } | null>(null);
  // A script's values that read as documents, any of which the views show.
  const [choices, setChoices] = useState<ShellResult[]>(remembered?.choices ?? []);
  const dbRef = useRef(db);
  dbRef.current = db;

  useEffect(() => {
    memory.set(tabKey, { view, result, messages, choices });
  }, [tabKey, view, result, messages, choices]);

  // A script still running when the tab goes away stops with it.
  useEffect(() => () => scriptRef.current?.stop(), []);

  useEffect(() => {
    const controller = new AbortController();
    api.listCollections(conn, db, controller.signal).then(
      (list) => setCollections(list.map((c) => c.name)),
      () => setCollections([]),
    );
    return () => controller.abort();
  }, [conn, db]);

  // Fields per collection for completion: from results, else a small
  // sample fetched the first time a collection is completed.
  const fieldCache = useRef(new Map<string, FieldStat[] | "loading">());
  const completion = useCallback((): CompletionContext => {
    const fieldsOf = (coll: string, db: string | null): FieldStat[] | null => {
      const dbName = db ?? dbRef.current;
      const key = `${dbName}.${coll}`;
      const hit = fieldCache.current.get(key);
      // Collection names are listed only for the current database.
      if (hit === undefined && (db !== null || collections.includes(coll))) {
        fieldCache.current.set(key, "loading");
        api.find({ conn, db: dbName, coll }, { filter: new Map(), limit: 50 }).then(
          (batch) => fieldCache.current.set(key, sampleFields(batch.docs)),
          () => fieldCache.current.delete(key),
        );
      }
      return hit === undefined || hit === "loading" ? null : hit;
    };
    const text = editorRef.current?.text() ?? "";
    const caret = editorRef.current?.selection().to ?? 0;
    const range = statementAt(text, caret);
    const target = range === null ? null : shellTarget(tokenize(text.slice(range.from, range.to), true).filter((tok) => tok.type !== "comment"));
    return { fields: target?.coll ? (fieldsOf(target.coll, target.db) ?? []) : [], collections, fieldsOf };
  }, [conn, collections]);

  const ask = (item: ReviewItem) =>
    new Promise<boolean>((resolve) => {
      setPendingReview({
        item,
        resolve: (ok) => {
          setPendingReview(null);
          resolve(ok);
        },
      });
    });

  // One request against the server; the documents or value it gives back.
  const execute = async (req: ShellRequest, signal: AbortSignal): Promise<ShellResult> => {
    const dbName = req.kind === "use" ? dbRef.current : (req.db ?? dbRef.current);
    const ns = (coll: string): api.Namespace => ({ conn, db: dbName, coll });
    const value = (v: BsonValue, status: Phrase, coll: string | null = null): ShellResult => ({ docs: asDocs(v), coll, status, reply: v });
    switch (req.kind) {
      case "use":
        dbRef.current = req.db;
        onDbChange(req.db);
        return { docs: [], coll: null, status: phrase("{db} 데이터베이스로 바꿨습니다", { db: req.db }), reply: null };
      case "show":
        if (req.what === "dbs") {
          const list = await api.listDatabases(conn, signal);
          return value(list.map((d) => bsonDoc({ name: d.name, sizeOnDisk: num(d.sizeOnDisk), empty: d.empty })), phrase("데이터베이스 {count}개", { count: list.length }));
        } else {
          const list = await api.listCollections(conn, dbName, signal);
          return value(list.map((c) => bsonDoc({ name: c.name, type: c.type, count: num(c.count) })), phrase("컬렉션 {count}개", { count: list.length }));
        }
      case "find": {
        const batch = await api.find(ns(req.coll), { filter: req.filter, projection: req.projection, sort: req.sort, skip: req.skip ?? undefined, limit: req.limit ?? SHELL_LIMIT, maxTimeMS }, signal);
        return { docs: batch.docs, coll: req.coll, status: phrase("문서 {count}개", { count: batch.docs.length.toLocaleString() }), reply: null };
      }
      case "findOne": {
        const batch = await api.find(ns(req.coll), { filter: req.filter, projection: req.projection, limit: 1, maxTimeMS }, signal);
        return { docs: batch.docs, coll: req.coll, status: batch.docs.length === 0 ? literal("null") : phrase("문서 1개"), reply: batch.docs[0] ?? null };
      }
      case "countDocuments": {
        // An empty filter would be estimated; this one counts.
        const filter = req.filter.size === 0 ? bsonDoc({ _id: bsonDoc({ $exists: true }) }) : req.filter;
        const r = await api.count(ns(req.coll), filter, signal);
        return value(num(r.count), r.count === null ? phrase("많음 (세는 데 시간이 너무 걸립니다)") : literal(String(r.count)), req.coll);
      }
      case "estimatedDocumentCount": {
        const r = await api.count(ns(req.coll), new Map(), signal);
        return value(num(r.count), r.count === null ? phrase("많음") : literal(String(r.count)), req.coll);
      }
      case "distinct": {
        const values = await api.distinct(ns(req.coll), req.key, req.filter, signal);
        return value(values, phrase("값 {count}개", { count: values.length }), req.coll);
      }
      case "aggregate": {
        const batch = await api.aggregate(ns(req.coll), req.pipeline, maxTimeMS, signal);
        return { docs: batch.docs, coll: req.coll, status: phrase("문서 {count}개", { count: batch.docs.length.toLocaleString() }), reply: null };
      }
      case "insertOne":
      case "insertMany": {
        const ids = await api.insert(ns(req.coll), req.kind === "insertOne" ? [req.doc] : req.docs, signal);
        return value(bsonDoc({ acknowledged: true, insertedIds: ids }), phrase("문서 {count}개를 넣었습니다", { count: ids.length }), req.coll);
      }
      case "updateOne":
      case "updateMany": {
        const many = req.kind === "updateMany";
        const r = await api.update(ns(req.coll), { filter: req.filter, update: req.update, many, upsert: req.upsert, confirmed: req.filter.size === 0 }, signal);
        return value(bsonDoc({ acknowledged: true, matchedCount: num(r.matched), modifiedCount: num(r.modified) }), phrase("{matched}개 일치 · {modified}개 바꿈", { matched: r.matched, modified: r.modified }), req.coll);
      }
      case "replaceOne": {
        const r = await api.replace(ns(req.coll), req.filter, req.replacement, req.filter.size === 0, signal);
        return value(bsonDoc({ acknowledged: true, matchedCount: num(r.matched), modifiedCount: num(r.modified) }), phrase("{matched}개 일치 · {modified}개 바꿈", { matched: r.matched, modified: r.modified }), req.coll);
      }
      case "deleteOne":
      case "deleteMany": {
        const many = req.kind === "deleteMany";
        const deleted = await api.remove(ns(req.coll), req.filter, many, req.filter.size === 0, signal);
        return value(bsonDoc({ acknowledged: true, deletedCount: num(deleted) }), phrase("문서 {count}개를 지웠습니다", { count: deleted }), req.coll);
      }
      case "createIndex": {
        const name = await api.createIndex(ns(req.coll), req.keys, req.options, signal);
        return value(name, phrase("인덱스 {name}을(를) 만들었습니다", { name }), req.coll);
      }
      case "dropIndex": {
        let name: string;
        if (typeof req.index === "string") {
          name = req.index;
        } else {
          const spec = toShell(req.index);
          const found = (await api.listIndexes(ns(req.coll), signal)).find((ix) => toShell(ix.key) === spec);
          if (found === undefined) {
            throw new api.MongoError("index_not_found", t("이 키의 인덱스가 없습니다: {key}", { key: spec }));
          }
          name = found.name;
        }
        await api.dropIndex(ns(req.coll), name, signal);
        return value(bsonDoc({ ok: num(1) }), phrase("인덱스 {name}을(를) 지웠습니다", { name }), req.coll);
      }
      case "getIndexes": {
        const list = await api.listIndexes(ns(req.coll), signal);
        return {
          docs: list.map((ix) => {
            const doc = bsonDoc({ name: ix.name, key: ix.key });
            if (ix.unique) doc.set("unique", true);
            if (ix.sparse) doc.set("sparse", true);
            if (ix.expireAfterSeconds !== undefined) doc.set("expireAfterSeconds", num(ix.expireAfterSeconds));
            if (ix.partialFilterExpression) doc.set("partialFilterExpression", ix.partialFilterExpression);
            if (ix.size !== undefined) doc.set("size", num(ix.size));
            if (ix.ops !== undefined) doc.set("ops", num(ix.ops));
            return doc;
          }),
          coll: req.coll,
          status: phrase("인덱스 {count}개", { count: list.length }),
          reply: null,
        };
      }
      case "drop": {
        const r = await api.command(conn, dbName, bsonDoc({ drop: req.coll }), true, signal);
        return value(r, phrase("{coll} 컬렉션을 지웠습니다", { coll: req.coll }), req.coll);
      }
      case "stats": {
        const r = await api.command(conn, dbName, req.coll === null ? bsonDoc({ dbStats: num(1) }) : bsonDoc({ collStats: req.coll }), false, signal);
        return value(r, phrase("완료"), req.coll);
      }
      case "explain": {
        const target = req.target;
        const r =
          target.kind === "find"
            ? await api.explain(ns(target.coll), { find: { filter: target.filter, projection: target.projection, sort: target.sort, skip: target.skip, limit: target.limit } }, req.verbosity, signal)
            : await api.explain(ns(target.coll), { aggregate: { pipeline: target.pipeline } }, req.verbosity, signal);
        return value(r, phrase("실행 계획"), target.coll);
      }
    }
  };

  // Runs statements in order, stopping at the first failure. Each gets a
  // message; the last one's documents show in the views.
  const runStatements = async (statements: { from: number; to: number; source: string; req: ParseResult<ShellRequest> }[], all: string) => {
    controllerRef.current?.abort();
    const script = scriptRef.current;
    scriptRef.current = null;
    script?.stop();
    const controller = new AbortController();
    controllerRef.current = controller;
    setErrorRange(null);
    setRunning(true);
    const out: ShellMessage[] = [];
    let last: ShellResult | null = null;
    let lastDb = dbRef.current;
    for (const st of statements) {
      if (!st.req.ok) {
        out.push({ source: st.source, ok: false, text: phrase("구문 오류"), parse: { src: all, at: st.req.error.from, message: st.req.error.message }, error: null, ms: 0 });
        setErrorRange({ from: st.req.error.from, to: st.req.error.to });
        break;
      }
      const req = st.req.value;
      const item = review(req, st.source, safeMode);
      if (item !== null && !(await ask(item))) {
        out.push({ source: st.source, ok: false, text: phrase("실행을 취소했습니다"), parse: null, error: null, ms: 0 });
        break;
      }
      const started = performance.now();
      try {
        last = await execute(req, controller.signal);
        lastDb = req.kind === "use" ? dbRef.current : (req.db ?? dbRef.current);
        out.push({ source: st.source, ok: true, text: last.status, parse: null, error: null, ms: performance.now() - started });
      } catch (error) {
        if (api.isAbort(error)) {
          out.push({ source: st.source, ok: false, text: phrase("취소했습니다"), parse: null, error: null, ms: performance.now() - started });
          break;
        }
        out.push({ source: st.source, ok: false, text: phrase("오류"), parse: null, error, ms: performance.now() - started });
        break;
      }
    }
    if (controllerRef.current === controller) {
      controllerRef.current = null;
    }
    setRunning(false);
    setMessages(out);
    setChoices([]);
    if (last !== null) {
      setResult(last);
      setTablePath([]);
      setTableSort(null);
      const failed = out.some((m) => !m.ok);
      if (failed || last.docs.length === 0) {
        setView("messages");
      } else if (view === "messages") {
        setView("cards");
      }
      if (last.coll !== null && last.docs.length > 0) {
        fieldCache.current.set(`${lastDb}.${last.coll}`, sampleFields(last.docs));
      }
    } else {
      setView("messages");
    }
  };

  // Runs `code` (at `base` in the editor text) as JavaScript in a worker.
  // Its output streams into one message; the views show the documents of
  // its last value that has some (the final value comes last).
  const runScriptText = async (code: string, base: number) => {
    controllerRef.current?.abort();
    const previous = scriptRef.current;
    scriptRef.current = null;
    previous?.stop();
    setErrorRange(null);
    setRunning(true);
    setView("messages");
    setChoices([]);
    const outputs: ScriptOutput[] = [];
    let failure: ScriptError | null = null;
    let changed = false;
    const started = performance.now();
    const message = (status: Phrase, ok: boolean, script?: ScriptError): ShellMessage => ({ source: code.trim(), ok, text: status, parse: null, error: null, script, ms: performance.now() - started, outputs: [...outputs] });
    const run = runScript({ code, conn, db: dbRef.current, safeMode, timeLimitMs: maxTimeMS ?? null, docLimit: SHELL_LIMIT, outputCap: OUTPUT_CAP }, (event) => {
      changed = true;
      switch (event.type) {
        case "print":
          outputs.push({ kind: "text", text: event.text, phrase: event.phrase });
          break;
        case "value":
          outputs.push({ kind: "value", value: fromEJSON(parseJson(event.ejson)), from: event.from, coll: event.coll, more: event.more });
          break;
        case "use":
          dbRef.current = event.db;
          onDbChange(event.db);
          break;
        case "capped":
          outputs.push({ kind: "note", text: phrase("출력이 {count}개를 넘어 이후 출력은 버렸습니다", { count: OUTPUT_CAP }) });
          break;
        case "error":
          failure = event.error;
          break;
      }
    });
    scriptRef.current = run;
    setMessages([message(phrase("실행 중…"), true)]);
    const live = window.setInterval(() => {
      if (changed && scriptRef.current === run) {
        changed = false;
        setMessages([message(phrase("실행 중…"), true)]);
      }
    }, LIVE_OUTPUT_MS);
    const end = await run.finished;
    window.clearInterval(live);
    // Replaced by a newer run: that one owns the screen now.
    if (scriptRef.current !== run) {
      return;
    }
    scriptRef.current = null;
    const error = failure as ScriptError | null;
    let done: ShellMessage;
    if (end === "done") {
      done = message(phrase("스크립트를 실행했습니다"), true);
    } else if (end === "stopped") {
      done = message(phrase("멈췄습니다"), false);
    } else if (end === "timeout") {
      done = message(phrase("실행 시간 제한({seconds}초)을 넘어 멈췄습니다", { seconds: Math.round((maxTimeMS ?? 0) / 1000) }), false);
    } else {
      done = message(phrase("오류"), false, error ?? undefined);
      if (error?.line !== undefined) {
        const lines = code.split("\n");
        const at = error.line - 1;
        if (at < lines.length) {
          const start = base + lines.slice(0, at).reduce((n, line) => n + line.length + 1, 0);
          const column = Math.min(lines[at].length, Math.max(0, (error.column ?? 1) - 1));
          setErrorRange({ from: start + column, to: start + lines[at].length });
        }
      }
    }
    const next: ShellResult[] = [];
    for (const o of outputs) {
      if (o.kind === "value" && readsAsDocs(o.value)) {
        const docs = asDocs(o.value);
        next.push({ docs, coll: o.coll, status: phrase("문서 {count}개", { count: `${docs.length.toLocaleString()}${o.more ? "+" : ""}` }), reply: null });
      }
    }
    setRunning(false);
    setMessages([done]);
    setChoices(next);
    const shown = next.at(-1) ?? null;
    setResult(shown);
    setTablePath([]);
    setTableSort(null);
    const final = outputs.at(-1);
    if (end === "done" && shown !== null && final?.kind === "value" && final.from === "result") {
      setView("cards");
    }
    if (shown !== null && shown.coll !== null) {
      fieldCache.current.set(`${dbRef.current}.${shown.coll}`, sampleFields(shown.docs));
    }
  };

  const stop = () => {
    controllerRef.current?.abort();
    scriptRef.current?.stop();
  };

  // Statements that all parse run one by one (safe mode can ask about each);
  // anything with JavaScript of its own runs whole as a script.
  const runCurrent = () => {
    const all = editorRef.current?.text() ?? text;
    const sel = editorRef.current?.selection() ?? { from: 0, to: 0 };
    if (sel.from !== sel.to) {
      const part = all.slice(sel.from, sel.to);
      const list = parseScript(part).map((st) => ({ from: st.from + sel.from, to: st.to + sel.from, source: part.slice(st.from, st.to).trim(), req: shiftError(st.result, sel.from) }));
      if (list.length === 0) {
        notify(t("실행할 쿼리가 없습니다"));
        return;
      }
      editorRef.current?.flash(sel.from, sel.to);
      if (list.every((st) => st.req.ok)) {
        void runStatements(list, all);
      } else {
        void runScriptText(part, sel.from);
      }
      return;
    }
    const range = statementAt(all, sel.from);
    const st = range === null ? null : parseScript(all).find((s) => s.from >= range.from && s.from <= range.to) ?? null;
    if (st === null) {
      notify(t("실행할 쿼리가 없습니다"));
      return;
    }
    editorRef.current?.flash(st.from, st.to);
    if (st.result.ok) {
      void runStatements([{ from: st.from, to: st.to, source: all.slice(st.from, st.to).trim(), req: st.result }], all);
    } else {
      void runScriptText(all.slice(st.from, st.to), st.from);
    }
  };

  const runAll = () => {
    const all = editorRef.current?.text() ?? text;
    const list = parseScript(all).map((st) => ({ from: st.from, to: st.to, source: all.slice(st.from, st.to).trim(), req: st.result }));
    if (list.length === 0) {
      notify(t("실행할 쿼리가 없습니다"));
      return;
    }
    editorRef.current?.flash(0, all.length);
    if (list.every((st) => st.req.ok)) {
      void runStatements(list, all);
    } else {
      void runScriptText(all, 0);
    }
  };

  // ⇧⌘↩ runs everything; ⌃1–3 switch the result view.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      const next = viewForKey(event);
      if (next !== null) {
        event.preventDefault();
        setView(next);
      } else if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        runAll();
      }
    };
    root.addEventListener("keydown", onKey, true);
    return () => root.removeEventListener("keydown", onKey, true);
  });

  const docs = useMemo(() => {
    const list = result?.docs ?? [];
    if (tableSort === null) {
      return list;
    }
    const key = tableSort.keys().next().value ?? "";
    const dir = toShell(tableSort.get(key) ?? null) === "-1" ? -1 : 1;
    return [...list].sort((a, b) => compareForSort(a.get(key), b.get(key)) * dir);
  }, [result, tableSort]);

  const readOnlyNs: api.Namespace = { conn, db, coll: result?.coll ?? "" };
  // What the detail panel lists with nothing picked: the collection the result came from.
  const facts = useCollectionFacts(readOnlyNs.coll !== "" ? readOnlyNs : null);
  const pickedKey = picked !== null && picked.of === result ? picked.key : null;
  const pickedAt = pickedKey === null ? -1 : docs.findIndex((doc, i) => docKey(doc, i) === pickedKey);
  const pick = (key: string) => {
    if (result !== null) {
      setPicked({ of: result, key });
    }
  };

  const showChoice = (index: number) => {
    setResult(choices[index]);
    setTablePath([]);
    setTableSort(null);
  };

  // A script's output lines. Values that are documents carry a button to
  // open them in the views; a list of several shows only its size here.
  const scriptOutputs = (outputs: ScriptOutput[]) => {
    let docsSeen = 0;
    return outputs.map((o, i) => {
      if (o.kind !== "value") {
        return (
          <li key={i} className={o.kind === "note" ? "mg-script-note" : "mg-script-print"}>
            {o.kind === "note" ? say(o.text) : o.phrase !== undefined ? say(o.phrase) : o.text}
          </li>
        );
      }
      const index = readsAsDocs(o.value) ? docsSeen++ : -1;
      const open =
        index >= 0 && choices[index] !== undefined ? (
          <button
            type="button"
            className="footer-button mg-script-open"
            onClick={() => {
              showChoice(index);
              setView("cards");
            }}
          >
            {t("결과 보기")}
          </button>
        ) : null;
      if (Array.isArray(o.value) && index >= 0 && o.value.length > 1) {
        return (
          <li key={i} className="mg-script-docs">
            {t("문서 {count}개", { count: `${o.value.length.toLocaleString()}${o.more ? "+" : ""}` })}
            {open}
          </li>
        );
      }
      return (
        <li key={i} className="mg-script-value">
          <pre className="mg-reply">
            <ShellText text={toShellPretty(o.value)} />
          </pre>
          {open}
        </li>
      );
    });
  };

  let body;
  if (result === null && messages.length === 0) {
    body = <div className="panel-empty mg-run-hint">{t("쿼리를 실행하세요 (⌘↩)")}</div>;
  } else if (view === "messages" || result === null) {
    body = (
      <div className="message-pane mg-shell-messages">
        <ol className="result-messages">
          {messages.map((m, i) => (
            <li key={i} className={`result-message${m.ok ? "" : " failed"}`}>
              <div className="result-message-line">
                <span className="result-message-label">{t("결과 {n}:", { n: i + 1 })}</span>
                {m.ok ? <span>{say(m.text)}</span> : <span className="result-message-error">{say(m.text)}</span>}
                <span className="result-message-time">· {m.ms < 1000 ? `${Math.round(m.ms)} ms` : `${(m.ms / 1000).toFixed(2)} s`}</span>
              </div>
              <div className="mg-shell-source mono">
                <ShellText text={m.source} />
              </div>
              {m.outputs !== undefined && m.outputs.length > 0 ? <ol className="mg-script-output">{scriptOutputs(m.outputs)}</ol> : null}
              {m.parse !== null ? <SyntaxErrorNotice src={m.parse.src} message={say(m.parse.message)} at={m.parse.at} context="shell" variant="block" /> : null}
              {m.script !== undefined ? <ErrorNotice error={scriptErrorValue(m.script)} context="shell" engine="mongodb" /> : m.error !== null ? <ErrorNotice error={m.error} context="shell" engine="mongodb" /> : null}
            </li>
          ))}
        </ol>
        {result?.reply != null ? (
          <pre className="message-info mg-reply">
            <ShellText text={toShellPretty(result.reply)} />
          </pre>
        ) : null}
      </div>
    );
  } else if (view === "cards") {
    body = <CardView docs={docs} offset={0} readOnly allOpen={allOpen} notify={notify} emptyText={t("결과 문서가 없습니다")} selected={pickedKey} onSelect={pick} />;
  } else if (view === "json") {
    body = <JsonView docs={docs} offset={0} canonical={false} allFolded={!allOpen} readOnly notify={notify} emptyText={t("결과 문서가 없습니다")} selected={pickedKey} onSelect={pick} />;
  } else {
    body = (
      <DocTableView
        ns={readOnlyNs}
        connKey={connKey}
        docs={docs}
        readOnly
        sort={tableSort}
        onSort={setTableSort}
        save={async () => new Error(t("쿼리 결과는 읽기 전용입니다 — 컬렉션 탭에서 편집하세요"))}
        facts={facts}
        path={tablePath}
        onPathChange={setTablePath}
      />
    );
  }

  const lastOk = messages.length > 0 && messages.every((m) => m.ok);
  const choice = result === null ? -1 : choices.indexOf(result);

  return (
    <div className="mg-root mg-shell" ref={rootRef}>
      <div className="editor-pane mg-shell-editor" style={editorBasis === null ? undefined : { flexBasis: editorBasis }}>
        <div className="mg-shell-code">
          <MongoEditor ref={editorRef} value={text} onChange={onTextChange} onRun={runCurrent} role="shell" completion={completion} error={errorRange} placeholder="db.collection.find({ … })" ariaLabel={t("mongosh 편집기")} />
        </div>
        <div className="editor-bar">
          <span className="mg-shell-db mono" title={t("db가 가리키는 데이터베이스 (use로 바꿉니다)")}>
            db: {db}
          </span>
          <span className="spacer" />
          <div className="editor-actions">
            {running ? (
              <button type="button" onClick={stop}>
                {t("정지")}
              </button>
            ) : null}
            <button type="button" title={t("모든 문장 실행 (⇧⌘↩)")} onClick={runAll} disabled={running}>
              {t("모두 실행")} <span className="split-hint">⇧⌘↩</span>
            </button>
            <button type="button" className="primary" title={t("현재 문장 실행 (⌘↩)")} onClick={runCurrent} disabled={running}>
              <PlayIcon size={10} />
              {t("현재 쿼리 실행")} <span className="split-hint">⌘↩</span>
            </button>
          </div>
        </div>
      </div>
      <div
        className="h-splitter"
        role="separator"
        aria-orientation="horizontal"
        onPointerDown={(event) => {
          event.preventDefault();
          const pane = event.currentTarget.previousElementSibling as HTMLElement | null;
          const total = rootRef.current?.getBoundingClientRect().height ?? 600;
          const startHeight = pane?.getBoundingClientRect().height ?? 200;
          const startY = event.clientY;
          const target = event.currentTarget;
          target.setPointerCapture(event.pointerId);
          const move = (e: PointerEvent) => setEditorBasis(Math.max(90, Math.min(total - 120, startHeight + e.clientY - startY)));
          const up = () => {
            target.removeEventListener("pointermove", move);
            target.removeEventListener("pointerup", up);
          };
          target.addEventListener("pointermove", move);
          target.addEventListener("pointerup", up);
        }}
      />
      <div className="result-pane mg-shell-results">
        <div className="data-toolbar mg-docbar">
          <div className="footer-start">
            <button type="button" className={`footer-button${view === "messages" ? " active" : ""}`} aria-pressed={view === "messages"} onClick={() => setView("messages")}>
              {t("메시지")}
            </button>
            {view === "cards" || view === "json" ? (
              <button type="button" className="footer-button" onClick={() => setAllOpen(!allOpen)}>
                {allOpen ? t("모두 접기") : t("모두 펼치기")}
              </button>
            ) : null}
          </div>
          <div className="footer-middle">
            {choices.length > 1 && choice >= 0 ? (
              <Select className="mg-script-choice" value={choice} aria-label={t("보여 줄 출력")} onChange={(event) => showChoice(Number(event.target.value))}>
                {choices.map((c, i) => (
                  <option key={i} value={i}>
                    {t("출력 {n}", { n: i + 1 })} · {say(c.status)}
                  </option>
                ))}
              </Select>
            ) : null}
            {messages.length > 0 ? (
              <span className={`row-range result-bar-status${lastOk ? "" : " failed"}`}>{lastOk ? (result === null ? "" : say(result.status)) : say(messages.find((m) => !m.ok)?.text ?? phrase("오류"))}</span>
            ) : null}
          </div>
          <div className="footer-end">
            <ViewSwitch view={view === "messages" ? "cards" : view} onChange={setView} />
          </div>
        </div>
        <div className="result-body mg-result-body">
          <div className="mg-docbody">{body}</div>
          {running ? (
            <div className="result-loading" role="status">
              <Spinner size={12} />
              {t("실행 중…")}
            </div>
          ) : null}
        </div>
      </div>
      {pendingReview !== null ? <ReviewModal mode={safeMode === 0 ? 1 : safeMode} items={[pendingReview.item]} offerTx={false} onRun={() => pendingReview.resolve(true)} onClose={() => pendingReview.resolve(false)} /> : null}
      {result !== null && view === "table" ? null : (
        <DocDetailPanel>
          {(query) =>
            result !== null && (view === "cards" || view === "json") && pickedAt >= 0 ? (
              <DocDetail ns={readOnlyNs.coll !== "" ? readOnlyNs : { ...readOnlyNs, coll: t("결과") }} doc={docs[pickedAt]} position={pickedAt} query={query} />
            ) : (
              <NothingSelected facts={facts} query={query} />
            )
          }
        </DocDetailPanel>
      )}
    </div>
  );
}

// A parse result from a selection, its error positions moved to the
// whole text.
function shiftError(r: ParseResult<ShellRequest>, by: number): ParseResult<ShellRequest> {
  return r.ok ? r : { ok: false, error: { ...r.error, from: r.error.from + by, to: r.error.to + by } };
}
