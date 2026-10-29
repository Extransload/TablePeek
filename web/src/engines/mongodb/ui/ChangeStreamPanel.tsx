// 변경 보기 (MONGODB.md §8.1): a change stream on a collection (the
// collection tab's sub-tab) or a whole database (its own tab). Start and
// pause, which kinds of change to receive, whether to ask for the document
// after an update and before a change, and the newest events first: time,
// kind, collection, _id and what changed. A row opens to the fields an
// update set or removed beside their earlier values, the document before and
// after, and the raw event. The session (changeStream.ts) keeps the events
// and reconnects after the last one received.

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { writeClipboard } from "../../../clipboard";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { ChevronIcon, CopyIcon, TrashIcon } from "../../../components/icons";
import { Spinner } from "../../../components/Spinner";
import { t } from "../../../i18n";
import { BsonDate, Timestamp, isDocument, type BsonDocument, type BsonValue } from "../bson";
import { MAX_EVENTS, OP_FILTERS, watchSession, type ChangeEvent, type OpFilter, type WatchSnapshot } from "../changeStream";
import { toShell, toShellPretty } from "../format";
import { DocFields } from "./CardView";
import { ShellText } from "./ShellText";
import "./streams.css";

export interface ChangeStreamPanelProps {
  conn: string;
  db: string;
  // Null: every collection of `db`.
  coll: string | null;
  // The tab the session belongs to.
  sessionKey: string;
  notify(message: string): void;
}

const OP_LABELS: Record<OpFilter, string> = {
  insert: "insert",
  update: "update",
  replace: "replace",
  delete: "delete",
  other: "기타",
};

function opClass(op: string): string {
  return op === "insert" || op === "update" || op === "replace" || op === "delete" ? op : "other";
}

// When the change happened: `wallTime` (6.0+), else the cluster time's
// second, else when it arrived.
function eventTime(event: ChangeEvent): Date {
  const wall = event.doc.get("wallTime");
  if (wall instanceof BsonDate) {
    return wall.toDate();
  }
  const cluster = event.doc.get("clusterTime");
  if (cluster instanceof Timestamp) {
    return new Date(cluster.t * 1000);
  }
  return new Date(event.received);
}

function timeText(date: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

// The value at a dotted path (array elements by index), or undefined.
function valueAt(doc: BsonDocument, path: string): BsonValue | undefined {
  let cur: BsonValue | undefined = doc;
  for (const part of path.split(".")) {
    if (isDocument(cur)) {
      cur = cur.get(part);
    } else if (Array.isArray(cur) && /^\d+$/.test(part)) {
      cur = cur[Number(part)];
    } else {
      return undefined;
    }
  }
  return cur;
}

function docOf(event: BsonDocument, key: string): BsonDocument | null {
  const v = event.get(key);
  return isDocument(v) ? v : null;
}

// A one-line account of the event for its row.
function summary(doc: BsonDocument): string {
  const op = String(doc.get("operationType") ?? "");
  const update = docOf(doc, "updateDescription");
  if (update !== null) {
    const set = docOf(update, "updatedFields");
    const removed = update.get("removedFields");
    const parts: string[] = [];
    if (set !== null && set.size > 0) {
      parts.push(t("설정 {fields}", { fields: [...set.keys()].join(", ") }));
    }
    if (Array.isArray(removed) && removed.length > 0) {
      parts.push(t("제거 {fields}", { fields: removed.map(String).join(", ") }));
    }
    return parts.join(" · ");
  }
  if (op === "rename") {
    const to = docOf(doc, "to");
    return to !== null ? `→ ${String(to.get("db") ?? "")}.${String(to.get("coll") ?? "")}` : "";
  }
  const full = docOf(doc, "fullDocument");
  if (full !== null) {
    return t("필드 {count}개", { count: full.size });
  }
  return "";
}

function statusText(s: WatchSnapshot): string {
  switch (s.status) {
    case "stopped":
      return s.resumable ? t("멈춤 · 시작하면 마지막 이벤트 뒤부터 이어서 받습니다") : t("멈춤");
    case "connecting":
      return t("여는 중…");
    case "live":
      return t("실시간");
    case "retrying":
      return t("연결이 끊겨 다시 연결하는 중… ({attempt}번째)", { attempt: s.attempt });
    case "ended":
      return t("서버가 스트림을 닫았습니다 (컬렉션·데이터베이스가 지워졌거나 이름이 바뀌었습니다)");
    case "failed":
      return t("열 수 없습니다");
  }
}

export function ChangeStreamPanel({ conn, db, coll, sessionKey, notify }: ChangeStreamPanelProps) {
  const session = useMemo(() => watchSession(sessionKey, conn, db, coll), [sessionKey, conn, db, coll]);
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [openSeq, setOpenSeq] = useState<Set<number>>(() => new Set());

  useEffect(() => {
    session.setShown(true);
    return () => session.setShown(false);
  }, [session]);

  const running = snap.status === "connecting" || snap.status === "live" || snap.status === "retrying";
  const newestFirst = useMemo(() => [...snap.events].reverse(), [snap.events]);
  const target = coll === null ? t("데이터베이스 {db}", { db }) : `${db}.${coll}`;

  const toggleOp = (op: OpFilter) => {
    const ops = snap.options.ops.includes(op) ? snap.options.ops.filter((o) => o !== op) : [...snap.options.ops, op];
    if (ops.length > 0) {
      session.setOptions({ ...snap.options, ops });
    }
  };

  const toggleRow = (seq: number) =>
    setOpenSeq((prev) => {
      const next = new Set(prev);
      if (!next.delete(seq)) {
        next.add(seq);
      }
      return next;
    });

  return (
    <div className="mg-pane mg-watch">
      <div className="mg-agg-bar mg-watch-bar">
        {running ? (
          <button type="button" className="mg-qbtn" onClick={() => session.pause()}>
            {t("멈춤")}
          </button>
        ) : (
          <button type="button" className="primary mg-find" onClick={() => session.start()}>
            {t("시작")}
          </button>
        )}
        <span className={`mg-watch-status ${snap.status}`} role="status" aria-live="polite">
          {snap.status === "connecting" ? <Spinner size={10} /> : <span className="mg-watch-dot" aria-hidden="true" />}
          {statusText(snap)}
        </span>
        <span className="spacer" />
        <span className="mg-watch-ops" role="group" aria-label={t("작업 종류")}>
          {OP_FILTERS.map((op) => (
            <button
              key={op}
              type="button"
              className={`mg-watch-chip ${opClass(op)}${snap.options.ops.includes(op) ? " on" : ""}`}
              aria-pressed={snap.options.ops.includes(op)}
              title={op === "other" ? t("drop·rename·dropDatabase·invalidate 등") : undefined}
              onClick={() => toggleOp(op)}
            >
              {t(OP_LABELS[op])}
            </button>
          ))}
        </span>
        <label className="mg-watch-check" title={t("업데이트 뒤의 문서 전체를 함께 받습니다 (fullDocument: updateLookup)")}>
          <input type="checkbox" checked={snap.options.fullDocument} onChange={(event) => session.setOptions({ ...snap.options, fullDocument: event.target.checked })} />
          {t("바뀐 뒤 문서")}
        </label>
        <label className="mg-watch-check" title={t("컬렉션에 changeStreamPreAndPostImages가 켜져 있으면 바뀌기 전 문서를 함께 받습니다 (fullDocumentBeforeChange: whenAvailable)")}>
          <input type="checkbox" checked={snap.options.before} onChange={(event) => session.setOptions({ ...snap.options, before: event.target.checked })} />
          {t("바뀌기 전 문서")}
        </label>
        <button type="button" className="icon-text-button" disabled={snap.events.length === 0} onClick={() => { session.clear(); setOpenSeq(new Set()); }}>
          <TrashIcon size={10} />
          {t("비우기")}
        </button>
      </div>
      <div className="mg-watch-body">
        {snap.status === "failed" ? (
          <ErrorNotice error={snap.error} context="document" engine="mongodb" onRetry={() => session.start()} />
        ) : null}
        {newestFirst.length === 0 ? (
          <div className="panel-empty mg-watch-empty">
            {running ? t("{target}의 변경을 기다리는 중…", { target }) : t("시작을 누르면 {target}에서 일어나는 변경을 실시간으로 보여줍니다", { target })}
          </div>
        ) : (
          <>
            <div className="mg-watch-count panel-dim">
              {t("이벤트 {count}개 (최근 {max}개까지 보관)", { count: snap.events.length.toLocaleString(), max: MAX_EVENTS.toLocaleString() })}
              {snap.dropped > 0 ? ` · ${t("오래된 {count}개는 버렸습니다", { count: snap.dropped.toLocaleString() })}` : ""}
            </div>
            <div className="mg-watch-list" role="list">
              {newestFirst.map((event) => (
                <EventRow key={event.seq} event={event} showNs={coll === null} open={openSeq.has(event.seq)} wantBefore={snap.options.before} onToggle={() => toggleRow(event.seq)} notify={notify} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function EventRow({ event, showNs, open, wantBefore, onToggle, notify }: { event: ChangeEvent; showNs: boolean; open: boolean; wantBefore: boolean; onToggle(): void; notify(message: string): void }) {
  const doc = event.doc;
  const op = String(doc.get("operationType") ?? "?");
  const ns = docOf(doc, "ns");
  const key = docOf(doc, "documentKey");
  const id = key?.get("_id");
  return (
    <div className={`mg-watch-event${open ? " open" : ""}`} role="listitem">
      <div
        className="mg-watch-row"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <span className={`schema-toggle${open ? " open" : ""}`}>
          <ChevronIcon size={9} />
        </span>
        <span className="mg-watch-time mono">{timeText(eventTime(event))}</span>
        <span className={`mg-watch-op ${opClass(op)}`}>{op}</span>
        {showNs ? <span className="mg-watch-ns mono">{ns !== null ? String(ns.get("coll") ?? "") : ""}</span> : null}
        <span className="mg-watch-id mono">{id !== undefined ? <ShellText text={toShell(id)} /> : null}</span>
        <span className="mg-watch-sum">{summary(doc)}</span>
      </div>
      {open ? <EventDetail doc={doc} wantBefore={wantBefore} notify={notify} /> : null}
    </div>
  );
}

function EventDetail({ doc, wantBefore, notify }: { doc: BsonDocument; wantBefore: boolean; notify(message: string): void }) {
  const [raw, setRaw] = useState(false);
  const op = String(doc.get("operationType") ?? "");
  const after = docOf(doc, "fullDocument");
  const before = docOf(doc, "fullDocumentBeforeChange");
  const update = docOf(doc, "updateDescription");
  const set = update !== null ? docOf(update, "updatedFields") : null;
  const removedRaw = update?.get("removedFields");
  const removed = Array.isArray(removedRaw) ? removedRaw.map(String) : [];
  const truncatedRaw = update?.get("truncatedArrays");
  const truncated = Array.isArray(truncatedRaw) ? truncatedRaw.filter(isDocument) : [];
  const touchesDoc = op === "update" || op === "replace" || op === "delete";

  return (
    <div className="mg-watch-detail">
      {update !== null ? (
        <table className="panel-table mg-struct-table mg-watch-diff">
          <thead>
            <tr>
              <th>{t("필드")}</th>
              <th>{t("바뀌기 전")}</th>
              <th>{t("바뀐 뒤")}</th>
            </tr>
          </thead>
          <tbody>
            {[...(set ?? new Map<string, BsonValue>())].map(([path, value]) => {
              const old = before !== null ? valueAt(before, path) : undefined;
              return (
                <tr key={`set:${path}`}>
                  <td className="mono">{path}</td>
                  <td className="mono mg-watch-old">{old !== undefined ? <ShellText text={toShell(old)} /> : <span className="panel-dim">{before !== null ? t("(없음)") : "—"}</span>}</td>
                  <td className="mono mg-watch-new">
                    <ShellText text={toShell(value)} />
                  </td>
                </tr>
              );
            })}
            {removed.map((path) => {
              const old = before !== null ? valueAt(before, path) : undefined;
              return (
                <tr key={`rm:${path}`}>
                  <td className="mono">{path}</td>
                  <td className="mono mg-watch-old">{old !== undefined ? <ShellText text={toShell(old)} /> : "—"}</td>
                  <td className="panel-dim">{t("(제거됨)")}</td>
                </tr>
              );
            })}
            {truncated.map((tr) => (
              <tr key={`tr:${String(tr.get("field"))}`}>
                <td className="mono">{String(tr.get("field") ?? "")}</td>
                <td className="panel-dim">—</td>
                <td className="panel-dim">{t("배열을 {size}개로 줄임", { size: toShell(tr.get("newSize") ?? null) })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {touchesDoc && wantBefore && before === null ? (
        <div className="panel-dim mg-watch-hint">{t("바뀌기 전 문서가 없습니다. 컬렉션에 changeStreamPreAndPostImages가 켜져 있어야 서버가 보내 줍니다.")}</div>
      ) : null}
      {before !== null || after !== null ? (
        <div className="mg-watch-docs">
          {before !== null ? (
            <div className="mg-watch-doc">
              <div className="mg-form-label">{t("바뀌기 전 문서")}</div>
              <DocFields doc={before} readOnly />
            </div>
          ) : null}
          {after !== null ? (
            <div className="mg-watch-doc">
              <div className="mg-form-label">{op === "insert" ? t("넣은 문서") : t("바뀐 뒤 문서")}</div>
              <DocFields doc={after} readOnly />
            </div>
          ) : null}
        </div>
      ) : op === "update" ? (
        <div className="panel-dim mg-watch-hint">{t("바뀐 뒤 문서는 '바뀐 뒤 문서'를 켜면 받습니다 (그 사이 지워진 문서는 없음).")}</div>
      ) : null}
      <div className="mg-watch-raw-bar">
        <button type="button" className="icon-text-button" aria-expanded={raw} onClick={() => setRaw((v) => !v)}>
          <ChevronIcon size={9} className={raw ? "mg-watch-open" : undefined} />
          {t("원본 이벤트")}
        </button>
        <button
          type="button"
          className="icon-text-button"
          onClick={() => {
            void writeClipboard(toShellPretty(doc), notify);
            notify(t("복사했습니다"));
          }}
        >
          <CopyIcon size={10} />
          {t("복사")}
        </button>
      </div>
      {raw ? (
        <pre className="panel-pre mg-watch-rawtext">
          <ShellText text={toShellPretty(doc)} />
        </pre>
      ) : null}
    </div>
  );
}

// The database-level 변경 보기 tab (from the sidebar's database menu).
export function ChangeStreamTab({ conn, db, tabKey, notify }: { conn: string; db: string; tabKey: string; notify(message: string): void }) {
  return (
    <div className="mg-root">
      <div className="mg-panes">
        <ChangeStreamPanel conn={conn} db={db} coll={null} sessionKey={tabKey} notify={notify} />
      </div>
    </div>
  );
}
