// The mongosh tab (MONGODB.md §3.8): an editor whose statements are parsed
// in the page (nothing is evaluated as JavaScript) and sent as structured
// requests. ⌘↩ runs the selection or the statement under the cursor, ⇧⌘↩
// every statement. Results show in the same ☰ / {} / ⊞ views as a
// collection tab, read-only, beside a message list. Safe mode asks before
// an empty-filter updateMany / deleteMany, drop and dropIndex (mode 2:
// before every write). The server logs each request to the console.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { PlayIcon } from "../../../components/icons";
import { ReviewModal } from "../../../components/ReviewModal";
import { Spinner } from "../../../components/Spinner";
import { t } from "../../../i18n";
import type { ReviewItem, SafeMode } from "../../../sqlTools";
import * as api from "../api";
import { Double, Int32, Int64, compareForSort, isDocument, type BsonDocument, type BsonValue } from "../bson";
import { sampleFields, shellTarget, type CompletionContext, type FieldStat } from "../complete";
import { toShell, toShellPretty } from "../format";
import { parseScript, statementAt, tokenize, type ParseResult, type ShellRequest } from "../shell/parse";
import { CardView } from "./CardView";
import { DocTableView } from "./DocTableView";
import { JsonView, SyntaxErrorNotice } from "./JsonView";
import { MongoEditor, type MongoEditorHandle } from "./MongoEditor";
import { ShellText } from "./ShellText";
import { ViewSwitch, viewForKey, type DocView } from "./ViewSwitch";
import "../mongodb.css";

// Documents a bare find() brings back.
const SHELL_LIMIT = 1000;

interface ShellMessage {
  // The statement as written.
  source: string;
  ok: boolean;
  // The status, or why it did not run (cancelled).
  text: string;
  // A statement that did not parse: the message and where, in `src`.
  parse: { src: string; at: number; message: string } | null;
  // The server's refusal (for the explained notice).
  error: unknown;
  ms: number;
}

interface ShellResult {
  // Documents to show; plain values are wrapped as { value }.
  docs: BsonDocument[];
  // The collection they came from, when there is one.
  coll: string | null;
  status: string;
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

const memory = new Map<string, { view: DocView | "messages"; result: ShellResult | null; messages: ShellMessage[] }>();

// The documents a value reads as in the result views.
function asDocs(v: BsonValue): BsonDocument[] {
  if (Array.isArray(v)) {
    return v.map((x) => (isDocument(x) ? x : { value: x }));
  }
  return [isDocument(v) ? v : { value: v }];
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

// What the safe-mode dialog says about a request, or null when it runs
// without asking.
function review(req: ShellRequest, source: string, mode: SafeMode): ReviewItem | null {
  if (mode === 0) {
    return null;
  }
  const empty = (filter: BsonDocument) => Object.keys(filter).length === 0;
  switch (req.kind) {
    case "updateMany":
      if (empty(req.filter)) {
        return { sql: source, keyword: "updateMany", severity: "danger", reason: "조건 없이 모든 문서를 바꿉니다" };
      }
      break;
    case "deleteMany":
      if (empty(req.filter)) {
        return { sql: source, keyword: "deleteMany", severity: "danger", reason: "조건 없이 모든 문서를 지웁니다" };
      }
      break;
    case "updateOne":
      if (empty(req.filter)) {
        return { sql: source, keyword: "updateOne", severity: "danger", reason: "조건 없이 처음 찾은 문서를 바꿉니다" };
      }
      break;
    case "replaceOne":
      if (empty(req.filter)) {
        return { sql: source, keyword: "replaceOne", severity: "danger", reason: "조건 없이 처음 찾은 문서를 통째로 바꿉니다" };
      }
      break;
    case "deleteOne":
      if (empty(req.filter)) {
        return { sql: source, keyword: "deleteOne", severity: "danger", reason: "조건 없이 처음 찾은 문서를 지웁니다" };
      }
      break;
    case "drop":
      return { sql: source, keyword: "drop", severity: "danger", reason: "컬렉션과 그 인덱스를 모두 지웁니다" };
    case "dropIndex":
      return { sql: source, keyword: "dropIndex", severity: "danger", reason: "인덱스를 지웁니다" };
  }
  if (mode === 2 && ["insertOne", "insertMany", "updateOne", "updateMany", "replaceOne", "deleteOne", "deleteMany", "createIndex"].includes(req.kind)) {
    return { sql: source, keyword: req.kind, severity: "write", reason: "데이터를 바꿉니다" };
  }
  return null;
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
  const [panelOpen, setPanelOpen] = useState(false);
  const [allOpen, setAllOpen] = useState(false);
  const [editorBasis, setEditorBasis] = useState<number | null>(null);
  const [pendingReview, setPendingReview] = useState<{ item: ReviewItem; resolve(ok: boolean): void } | null>(null);
  const editorRef = useRef<MongoEditorHandle | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const dbRef = useRef(db);
  dbRef.current = db;

  useEffect(() => {
    memory.set(tabKey, { view, result, messages });
  }, [tabKey, view, result, messages]);

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
        api.find({ conn, db: dbName, coll }, { filter: {}, limit: 50 }).then(
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
    const value = (v: BsonValue, status: string, coll: string | null = null): ShellResult => ({ docs: asDocs(v), coll, status, reply: v });
    switch (req.kind) {
      case "use":
        dbRef.current = req.db;
        onDbChange(req.db);
        return { docs: [], coll: null, status: t("{db} 데이터베이스로 바꿨습니다", { db: req.db }), reply: null };
      case "show":
        if (req.what === "dbs") {
          const list = await api.listDatabases(conn, signal);
          return value(list.map((d) => ({ name: d.name, sizeOnDisk: num(d.sizeOnDisk), empty: d.empty })), t("데이터베이스 {count}개", { count: list.length }));
        } else {
          const list = await api.listCollections(conn, dbName, signal);
          return value(list.map((c) => ({ name: c.name, type: c.type, count: num(c.count) })), t("컬렉션 {count}개", { count: list.length }));
        }
      case "find": {
        const batch = await api.find(ns(req.coll), { filter: req.filter, projection: req.projection, sort: req.sort, skip: req.skip ?? undefined, limit: req.limit ?? SHELL_LIMIT, maxTimeMS }, signal);
        return { docs: batch.docs, coll: req.coll, status: t("문서 {count}개", { count: batch.docs.length.toLocaleString() }), reply: null };
      }
      case "findOne": {
        const batch = await api.find(ns(req.coll), { filter: req.filter, projection: req.projection, limit: 1, maxTimeMS }, signal);
        return { docs: batch.docs, coll: req.coll, status: batch.docs.length === 0 ? "null" : t("문서 1개"), reply: batch.docs[0] ?? null };
      }
      case "countDocuments": {
        // An empty filter would be estimated; this one counts.
        const filter = Object.keys(req.filter).length === 0 ? { _id: { $exists: true } } : req.filter;
        const r = await api.count(ns(req.coll), filter, signal);
        return value(num(r.count), r.count === null ? t("많음 (세는 데 시간이 너무 걸립니다)") : String(r.count), req.coll);
      }
      case "estimatedDocumentCount": {
        const r = await api.count(ns(req.coll), {}, signal);
        return value(num(r.count), String(r.count ?? t("많음")), req.coll);
      }
      case "distinct": {
        const values = await api.distinct(ns(req.coll), req.key, req.filter, signal);
        return value(values, t("값 {count}개", { count: values.length }), req.coll);
      }
      case "aggregate": {
        const batch = await api.aggregate(ns(req.coll), req.pipeline, maxTimeMS, signal);
        return { docs: batch.docs, coll: req.coll, status: t("문서 {count}개", { count: batch.docs.length.toLocaleString() }), reply: null };
      }
      case "insertOne":
      case "insertMany": {
        const ids = await api.insert(ns(req.coll), req.kind === "insertOne" ? [req.doc] : req.docs, signal);
        return value({ acknowledged: true, insertedIds: ids }, t("문서 {count}개를 넣었습니다", { count: ids.length }), req.coll);
      }
      case "updateOne":
      case "updateMany": {
        const many = req.kind === "updateMany";
        const r = await api.update(ns(req.coll), { filter: req.filter, update: req.update, many, upsert: req.upsert, confirmed: Object.keys(req.filter).length === 0 }, signal);
        return value({ acknowledged: true, matchedCount: num(r.matched), modifiedCount: num(r.modified) }, t("{matched}개 일치 · {modified}개 바꿈", { matched: r.matched, modified: r.modified }), req.coll);
      }
      case "replaceOne": {
        const r = await api.replace(ns(req.coll), req.filter, req.replacement, Object.keys(req.filter).length === 0, signal);
        return value({ acknowledged: true, matchedCount: num(r.matched), modifiedCount: num(r.modified) }, t("{matched}개 일치 · {modified}개 바꿈", { matched: r.matched, modified: r.modified }), req.coll);
      }
      case "deleteOne":
      case "deleteMany": {
        const many = req.kind === "deleteMany";
        const deleted = await api.remove(ns(req.coll), req.filter, many, Object.keys(req.filter).length === 0, signal);
        return value({ acknowledged: true, deletedCount: num(deleted) }, t("문서 {count}개를 지웠습니다", { count: deleted }), req.coll);
      }
      case "createIndex": {
        const name = await api.createIndex(ns(req.coll), req.keys, req.options, signal);
        return value(name, t("인덱스 {name}을(를) 만들었습니다", { name }), req.coll);
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
        return value({ ok: num(1) }, t("인덱스 {name}을(를) 지웠습니다", { name }), req.coll);
      }
      case "getIndexes": {
        const list = await api.listIndexes(ns(req.coll), signal);
        return {
          docs: list.map((ix) => {
            const doc: BsonDocument = { name: ix.name, key: ix.key };
            if (ix.unique) doc.unique = true;
            if (ix.sparse) doc.sparse = true;
            if (ix.expireAfterSeconds !== undefined) doc.expireAfterSeconds = num(ix.expireAfterSeconds);
            if (ix.partialFilterExpression) doc.partialFilterExpression = ix.partialFilterExpression;
            if (ix.size !== undefined) doc.size = num(ix.size);
            if (ix.ops !== undefined) doc.ops = num(ix.ops);
            return doc;
          }),
          coll: req.coll,
          status: t("인덱스 {count}개", { count: list.length }),
          reply: null,
        };
      }
      case "drop": {
        const r = await api.command(conn, dbName, { drop: req.coll }, true, signal);
        return value(r, t("{coll} 컬렉션을 지웠습니다", { coll: req.coll }), req.coll);
      }
      case "stats": {
        const r = await api.command(conn, dbName, req.coll === null ? { dbStats: num(1) } : { collStats: req.coll }, false, signal);
        return value(r, t("완료"), req.coll);
      }
      case "explain": {
        const target = req.target;
        const r =
          target.kind === "find"
            ? await api.explain(ns(target.coll), { find: { filter: target.filter, projection: target.projection, sort: target.sort, skip: target.skip, limit: target.limit } }, req.verbosity, signal)
            : await api.explain(ns(target.coll), { aggregate: { pipeline: target.pipeline } }, req.verbosity, signal);
        return value(r, t("실행 계획"), target.coll);
      }
    }
  };

  // Runs statements in order, stopping at the first failure. Each gets a
  // message; the last one's documents show in the views.
  const runStatements = async (statements: { from: number; to: number; source: string; req: ParseResult<ShellRequest> }[], all: string) => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setErrorRange(null);
    setRunning(true);
    const out: ShellMessage[] = [];
    let last: ShellResult | null = null;
    let lastDb = dbRef.current;
    for (const st of statements) {
      if (!st.req.ok) {
        out.push({ source: st.source, ok: false, text: t("구문 오류"), parse: { src: all, at: st.req.error.from, message: st.req.error.message }, error: null, ms: 0 });
        setErrorRange({ from: st.req.error.from, to: st.req.error.to });
        break;
      }
      const req = st.req.value;
      const item = review(req, st.source, safeMode);
      if (item !== null && !(await ask(item))) {
        out.push({ source: st.source, ok: false, text: t("실행을 취소했습니다"), parse: null, error: null, ms: 0 });
        break;
      }
      const started = performance.now();
      try {
        last = await execute(req, controller.signal);
        lastDb = req.kind === "use" ? dbRef.current : (req.db ?? dbRef.current);
        out.push({ source: st.source, ok: true, text: last.status, parse: null, error: null, ms: performance.now() - started });
      } catch (error) {
        if (api.isAbort(error)) {
          out.push({ source: st.source, ok: false, text: t("취소했습니다"), parse: null, error: null, ms: performance.now() - started });
          break;
        }
        out.push({ source: st.source, ok: false, text: t("오류"), parse: null, error, ms: performance.now() - started });
        break;
      }
    }
    if (controllerRef.current === controller) {
      controllerRef.current = null;
    }
    setRunning(false);
    setMessages(out);
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
      void runStatements(list, all);
      return;
    }
    const range = statementAt(all, sel.from);
    const st = range === null ? null : parseScript(all).find((s) => s.from >= range.from && s.from <= range.to) ?? null;
    if (st === null) {
      notify(t("실행할 쿼리가 없습니다"));
      return;
    }
    editorRef.current?.flash(st.from, st.to);
    void runStatements([{ from: st.from, to: st.to, source: all.slice(st.from, st.to).trim(), req: st.result }], all);
  };

  const runAll = () => {
    const all = editorRef.current?.text() ?? text;
    const list = parseScript(all).map((st) => ({ from: st.from, to: st.to, source: all.slice(st.from, st.to).trim(), req: st.result }));
    if (list.length === 0) {
      notify(t("실행할 쿼리가 없습니다"));
      return;
    }
    editorRef.current?.flash(0, all.length);
    void runStatements(list, all);
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
    const [key] = Object.keys(tableSort);
    const dir = toShell(tableSort[key]) === "-1" ? -1 : 1;
    return [...list].sort((a, b) => compareForSort(a[key], b[key]) * dir);
  }, [result, tableSort]);

  const readOnlyNs: api.Namespace = { conn, db, coll: result?.coll ?? "" };

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
                {m.ok ? <span>{m.text}</span> : <span className="result-message-error">{m.text}</span>}
                <span className="result-message-time">· {m.ms < 1000 ? `${Math.round(m.ms)} ms` : `${(m.ms / 1000).toFixed(2)} s`}</span>
              </div>
              <div className="mg-shell-source mono">
                <ShellText text={m.source} />
              </div>
              {m.parse !== null ? <SyntaxErrorNotice src={m.parse.src} message={m.parse.message} at={m.parse.at} context="shell" variant="block" /> : null}
              {m.error !== null ? <ErrorNotice error={m.error} context="shell" engine="mongodb" /> : null}
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
    body = <CardView docs={docs} offset={0} readOnly allOpen={allOpen} notify={notify} emptyText={t("결과 문서가 없습니다")} />;
  } else if (view === "json") {
    body = <JsonView docs={docs} offset={0} canonical={false} allFolded={!allOpen} readOnly notify={notify} emptyText={t("결과 문서가 없습니다")} />;
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
        panelOpen={panelOpen}
        onPanelOpenChange={setPanelOpen}
        path={tablePath}
        onPathChange={setTablePath}
      />
    );
  }

  const lastOk = messages.length > 0 && messages.every((m) => m.ok);

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
              <button type="button" onClick={() => controllerRef.current?.abort()}>
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
            {messages.length > 0 ? (
              <span className={`row-range result-bar-status${lastOk ? "" : " failed"}`}>{lastOk ? (result?.status ?? "") : t("오류")}</span>
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
      {pendingReview !== null ? <ReviewModal mode={safeMode === 0 ? 1 : safeMode} items={[pendingReview.item]} txActive onRun={() => pendingReview.resolve(true)} onClose={() => pendingReview.resolve(false)} /> : null}
    </div>
  );
}

// A parse result from a selection, its error positions moved to the
// whole text.
function shiftError(r: ParseResult<ShellRequest>, by: number): ParseResult<ShellRequest> {
  return r.ok ? r : { ok: false, error: { ...r.error, from: r.error.from + by, to: r.error.to + by } };
}
