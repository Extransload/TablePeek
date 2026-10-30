// 일괄 수정 · 일괄 삭제 (MONGODB.md §8.1): the query bar's filter (editable
// here), for 수정 an update as operators (a `$set` template) or as a
// pipeline, the number of documents it reaches (counted as you type), and
// a look at the first few: for 수정 each one before and after with the
// changed fields marked (`POST /api/doc/update/preview`, which changes them
// inside a transaction the server aborts), for 삭제 the documents that
// would go. 실행 sends updateMany / deleteMany behind safe mode with
// `confirmed: true`, shows what changed and has the workbench reload.

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { ReviewModal } from "../../../components/ReviewModal";
import { Select } from "../../../components/Select";
import { Spinner } from "../../../components/Spinner";
import { phrase, say, t, type Phrase } from "../../../i18n";
import type { ReviewItem, SafeMode } from "../../../sqlTools";
import { count, find, isAbort, remove, update, updatePreview, type CountResult, type Namespace, type QueryOptions, type UpdatePreview } from "../api";
import { bsonDoc, deepEqual, isDocument, type BsonDocument, type BsonValue } from "../bson";
import type { CompletionContext } from "../complete";
import { toShell } from "../format";
import { parseFilter, parseValue } from "../shell/parse";
import { AdminModal, CommandPreview, shellNamespace } from "./AdminModal";
import { JsonView, SyntaxErrorNotice } from "./JsonView";
import { MongoEditor } from "./MongoEditor";
import { ShellText } from "./ShellText";
import { asError, WriteErrorNotice } from "./writeErrors";
import "./bulk.css";

export type BulkMode = "update" | "delete";

type UpdateKind = "operators" | "pipeline";

interface BulkModalProps {
  ns: Namespace;
  mode: BulkMode;
  // The query bar's filter text, the starting point.
  filterText: string;
  // The query bar's 옵션: its collation and hint go with the count, the
  // preview and the write (the time limit does not).
  options?: QueryOptions;
  safeMode: SafeMode;
  completion: () => CompletionContext;
  notify(message: string): void;
  // After a run that wrote: the workbench reloads the page and its stats.
  onDone(): void;
  onClose(): void;
}

const OPERATORS_TEMPLATE = "{\n  $set: {\n    \n  }\n}";
const PIPELINE_TEMPLATE = "[\n  { $set: {  } }\n]";

const SAMPLE_SIZES = [5, 10, 20];

// How long typing pauses before the count and the preview run again.
const DEBOUNCE_MS = 500;

type Checked<T> = { ok: true; value: T } | { ok: false; message: Phrase; range: { from: number; to: number } | null };

// The update editor's text as what `update` sends, or why it cannot go.
function checkUpdate(kind: UpdateKind, text: string): Checked<BsonDocument | BsonDocument[]> {
  const r = parseValue(text);
  if (!r.ok) {
    return { ok: false, message: r.error.message, range: { from: r.error.from, to: r.error.to } };
  }
  const v = r.value;
  if (kind === "pipeline") {
    if (!Array.isArray(v) || v.length === 0 || !v.every(isDocument)) {
      return { ok: false, message: phrase("[ { $set: { … } } ]처럼 단계의 배열을 쓰세요"), range: null };
    }
    for (const stage of v) {
      const [name, body] = [...stage][0] ?? [];
      if (stage.size !== 1 || name === undefined || !name.startsWith("$")) {
        return { ok: false, message: phrase("단계마다 { $set: { … } }처럼 연산자 하나를 쓰세요"), range: null };
      }
      if (isDocument(body) && body.size === 0) {
        return { ok: false, message: phrase("{op}에 필드를 하나 이상 쓰세요", { op: name }), range: null };
      }
    }
    return { ok: true, value: v };
  }
  if (!isDocument(v) || v.size === 0) {
    return { ok: false, message: phrase("{ $set: { … } }처럼 연산자 문서를 쓰세요"), range: null };
  }
  for (const [op, body] of v) {
    if (!op.startsWith("$")) {
      return { ok: false, message: phrase("{key}: 수정은 $set·$inc 같은 연산자로 씁니다 (문서를 통째로 바꾸지 않습니다)", { key: op }), range: null };
    }
    if (isDocument(body) && body.size === 0) {
      return { ok: false, message: phrase("{op}에 필드를 하나 이상 쓰세요", { op }), range: null };
    }
  }
  return { ok: true, value: v };
}

// ---- Before and after ----

type DiffState = "same" | "changed" | "added" | "removed";

interface DiffRow {
  key: string;
  depth: number;
  state: DiffState;
  before?: BsonValue;
  after?: BsonValue;
  // Both sides are documents that differ: the fields follow, one deeper.
  group: boolean;
}

// Field rows of two documents in the after document's order, fields the
// update removed placed where they stood before. Nested documents that
// differ open into their fields; anything else is one row. Returns how many
// fields changed, were added or were removed.
function diffRows(before: BsonDocument, after: BsonDocument, depth: number, out: DiffRow[]): number {
  const order = [...after.keys()];
  let prev: string | null = null;
  for (const key of before.keys()) {
    if (!after.has(key)) {
      const at = prev === null ? 0 : order.indexOf(prev) + 1;
      order.splice(at, 0, key);
    }
    prev = key;
  }
  let changes = 0;
  for (const key of order) {
    const b = before.get(key);
    const a = after.get(key);
    if (b === undefined) {
      out.push({ key, depth, state: "added", after: a, group: false });
      changes += 1;
    } else if (a === undefined) {
      out.push({ key, depth, state: "removed", before: b, group: false });
      changes += 1;
    } else if (deepEqual(b, a)) {
      out.push({ key, depth, state: "same", before: b, after: a, group: false });
    } else if (isDocument(b) && isDocument(a)) {
      const row: DiffRow = { key, depth, state: "changed", group: true };
      out.push(row);
      changes += diffRows(b, a, depth + 1, out);
    } else {
      out.push({ key, depth, state: "changed", before: b, after: a, group: false });
      changes += 1;
    }
  }
  return changes;
}

function DiffValue({ value }: { value: BsonValue | undefined }) {
  if (value === undefined) {
    return <span className="mg-bulk-missing">—</span>;
  }
  const text = toShell(value);
  return (
    <span className="mg-bulk-text" title={text}>
      <ShellText text={text} />
    </span>
  );
}

function SampleDiff({ before, after, changedOnly }: { before: BsonDocument; after: BsonDocument | null; changedOnly: boolean }) {
  const { rows, changes } = useMemo(() => {
    const out: DiffRow[] = [];
    const n = after === null ? 0 : diffRows(before, after, 0, out);
    return { rows: out, changes: n };
  }, [before, after]);
  const id = before.get("_id");
  const shown = changedOnly ? rows.filter((r) => r.state !== "same") : rows;
  return (
    <div className={`mg-bulk-sample${changes === 0 ? " unchanged" : ""}`}>
      <div className="mg-bulk-sample-head">
        <span className="mono">{id === undefined ? t("(_id 없음)") : <ShellText text={`_id: ${toShell(id)}`} />}</span>
        <span className="spacer" />
        <span className={changes === 0 ? "panel-dim" : "mg-bulk-changes"}>
          {after === null ? t("바뀐 뒤를 읽지 못했습니다") : changes === 0 ? t("바뀌지 않음") : t("필드 {count}개 바뀜", { count: changes })}
        </span>
      </div>
      {after === null || shown.length === 0 ? null : (
        <div className="mg-bulk-diff" role="table" aria-label={t("바뀌기 전과 뒤")}>
          <div className="mg-bulk-row head" role="row">
            <span role="columnheader">{t("필드")}</span>
            <span role="columnheader">{t("바뀌기 전")}</span>
            <span role="columnheader">{t("바뀐 뒤")}</span>
          </div>
          {shown.map((row, i) => (
            <div key={i} className={`mg-bulk-row ${row.state}`} role="row" title={row.state === "added" ? t("추가된 필드") : row.state === "removed" ? t("지워진 필드") : row.state === "changed" ? t("바뀐 필드") : undefined}>
              <span className="mg-bulk-key mono" role="cell" style={{ paddingLeft: `${row.depth * 1.5 + 0.5}ch` }}>
                {row.key}
              </span>
              <span className="mg-bulk-val mono" role="cell">
                {row.group ? <span className="mg-bulk-missing">{"{ … }"}</span> : <DiffValue value={row.before} />}
              </span>
              <span className="mg-bulk-val mono" role="cell">
                {row.group ? <span className="mg-bulk-missing">{"{ … }"}</span> : <DiffValue value={row.after} />}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- The dialog ----

type Look =
  | { state: "loading" }
  | { state: "error"; error: unknown }
  // 수정: the server's preview; when it could not preview (`previewed`
  // false) `docs` holds the first matching documents as they are.
  | { state: "preview"; preview: UpdatePreview; docs: BsonDocument[] }
  // 삭제: the first documents that would go.
  | { state: "docs"; docs: BsonDocument[] };

type Outcome = { mode: "update"; matched: number; modified: number } | { mode: "delete"; deleted: number };

function countText(c: CountResult | null): string {
  if (c === null) {
    return "…";
  }
  if (c.count === null) {
    return t("많음 (세는 데 오래 걸림)");
  }
  return `${c.exact ? "" : "≈ "}${c.count.toLocaleString()}`;
}

export function BulkModal({ ns, mode: initialMode, filterText: initialFilter, options, safeMode, completion, notify, onDone, onClose }: BulkModalProps) {
  const [mode, setMode] = useState<BulkMode>(initialMode);
  const [filterText, setFilterText] = useState(initialFilter);
  const [kind, setKind] = useState<UpdateKind>("operators");
  const [texts, setTexts] = useState<Record<UpdateKind, string>>({ operators: OPERATORS_TEMPLATE, pipeline: PIPELINE_TEMPLATE });
  const [size, setSize] = useState(5);
  const [changedOnly, setChangedOnly] = useState(false);
  const [matched, setMatched] = useState<CountResult | null>(null);
  const [countError, setCountError] = useState<unknown>(null);
  const [look, setLook] = useState<Look | null>(null);
  // Bumped after a run and by ⌘↩ in an editor: count and look again now.
  const [seq, setSeq] = useState(0);
  const [immediate, setImmediate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Error | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [review, setReview] = useState<{ item: ReviewItem; resolve(ok: boolean): void } | null>(null);
  // Fixed when the dialog opens, as the filter's starting text is.
  const [writeOptions] = useState<QueryOptions>(() => ({ collation: options?.collation ?? null, hint: options?.hint ?? null }));
  // The same as mongosh's options argument, `{ collation, hint }`, or null.
  const optionsDoc = useMemo(() => {
    const doc = bsonDoc();
    if (writeOptions.collation) {
      doc.set("collation", writeOptions.collation);
    }
    if (writeOptions.hint) {
      doc.set("hint", writeOptions.hint);
    }
    return doc.size > 0 ? doc : null;
  }, [writeOptions]);
  const optionsArg = optionsDoc === null ? "" : `, ${toShell(optionsDoc)}`;

  const filter = useMemo(() => parseFilter(filterText), [filterText]);
  const updateText = texts[kind];
  const updateDoc = useMemo(() => checkUpdate(kind, updateText), [kind, updateText]);
  const target = shellNamespace(ns.db, ns.coll);

  // The matching count, again after each pause in typing.
  useEffect(() => {
    if (!filter.ok) {
      return;
    }
    const value = filter.value;
    const controller = new AbortController();
    setMatched(null);
    setCountError(null);
    const timer = window.setTimeout(
      () => {
        count(ns, value, controller.signal, writeOptions).then(setMatched, (error: unknown) => {
          if (!isAbort(error)) {
            setCountError(error);
          }
        });
      },
      immediate ? 0 : DEBOUNCE_MS,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [ns, filter, writeOptions, seq, immediate]);

  // The first few documents: before and after for 수정, as they are for 삭제.
  useEffect(() => {
    if (!filter.ok || (mode === "update" && !updateDoc.ok)) {
      setLook(null);
      return;
    }
    const f = filter.value;
    const u = updateDoc.ok ? updateDoc.value : null;
    const controller = new AbortController();
    const signal = controller.signal;
    setLook({ state: "loading" });
    const timer = window.setTimeout(
      () => {
        const load = async (): Promise<Look> => {
          if (mode === "delete" || u === null) {
            return { state: "docs", docs: (await find(ns, { filter: f, limit: size, ...writeOptions }, signal)).docs };
          }
          const preview = await updatePreview(ns, f, u, size, signal, writeOptions);
          const docs = preview.previewed ? [] : (await find(ns, { filter: f, limit: size, ...writeOptions }, signal)).docs;
          return { state: "preview", preview, docs };
        };
        load().then(setLook, (error: unknown) => {
          if (!isAbort(error)) {
            setLook({ state: "error", error });
          }
        });
      },
      immediate ? 0 : DEBOUNCE_MS,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [ns, mode, filter, updateDoc, writeOptions, size, seq, immediate]);

  const refreshNow = () => {
    setImmediate(true);
    setSeq((n) => n + 1);
  };

  const editFilter = (text: string) => {
    setImmediate(false);
    setFilterText(text);
    setOutcome(null);
    setFailure(null);
  };

  const editUpdate = (text: string) => {
    setImmediate(false);
    setTexts((prev) => ({ ...prev, [kind]: text }));
    setOutcome(null);
    setFailure(null);
  };

  const command = !filter.ok
    ? null
    : mode === "delete"
      ? `${target}.deleteMany(${toShell(filter.value)}${optionsArg})`
      : updateDoc.ok
        ? `${target}.updateMany(${toShell(filter.value)}, ${toShell(updateDoc.value)}${optionsArg})`
        : null;
  const problem = !filter.ok ? t("필터: {message}", { message: say(filter.error.message) }) : mode === "update" && !updateDoc.ok ? t("수정 내용: {message}", { message: say(updateDoc.message) }) : null;

  // What safe mode asks about, as elsewhere for these commands: an empty
  // filter always (mode 1 and 2), any bulk write in mode 2.
  const reviewItem = (cmd: string, empty: boolean): ReviewItem | null => {
    if (safeMode === 0) {
      return null;
    }
    const keyword = mode === "delete" ? "deleteMany" : "updateMany";
    if (empty) {
      return { sql: cmd, keyword, severity: "danger", reason: mode === "delete" ? "조건 없이 모든 문서를 지웁니다" : "조건 없이 모든 문서를 바꿉니다" };
    }
    if (safeMode === 2) {
      return { sql: cmd, keyword, severity: "write", reason: "데이터를 바꿉니다" };
    }
    return null;
  };

  const ask = (item: ReviewItem) =>
    new Promise<boolean>((resolve) =>
      setReview({
        item,
        resolve: (ok) => {
          setReview(null);
          resolve(ok);
        },
      }),
    );

  const run = async () => {
    if (busy || command === null || !filter.ok || (mode === "update" && !updateDoc.ok)) {
      return;
    }
    const item = reviewItem(command, filter.value.size === 0);
    if (item !== null && !(await ask(item))) {
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      if (mode === "delete") {
        const deleted = await remove(ns, filter.value, true, true, undefined, writeOptions);
        setOutcome({ mode: "delete", deleted });
        notify(t("문서 {count}개를 삭제했습니다", { count: deleted.toLocaleString() }));
      } else if (updateDoc.ok) {
        const r = await update(ns, { filter: filter.value, update: updateDoc.value, many: true, confirmed: true, options: writeOptions });
        setOutcome({ mode: "update", ...r });
        notify(t("문서 {modified}개를 고쳤습니다 (일치 {matched}개)", { modified: r.modified.toLocaleString(), matched: r.matched.toLocaleString() }));
      }
      onDone();
      refreshNow();
    } catch (error) {
      setFailure(asError(error));
    } finally {
      setBusy(false);
    }
  };

  const count0 = matched?.count === 0;
  const canRun = command !== null && !busy && !count0;
  const title = mode === "delete" ? t("일괄 삭제") : t("일괄 수정");

  let lookBody = null;
  if (look === null) {
    lookBody = null;
  } else if (look.state === "loading") {
    lookBody = (
      <div className="panel-dim" role="status">
        <Spinner size={10} />
        {mode === "delete" ? t("지울 문서를 읽는 중…") : t("미리보기를 만드는 중…")}
      </div>
    );
  } else if (look.state === "error") {
    lookBody = <ErrorNotice error={look.error} context="document" engine="mongodb" variant="compact" onRetry={refreshNow} />;
  } else if (look.state === "docs") {
    lookBody =
      look.docs.length === 0 ? (
        <div className="panel-dim">{t("조건에 맞는 문서가 없습니다")}</div>
      ) : (
        <div className="mg-bulk-docs">
          <JsonView docs={look.docs} offset={0} canonical={false} allFolded={false} readOnly notify={notify} />
        </div>
      );
  } else if (!look.preview.previewed) {
    lookBody = (
      <>
        <div className="mg-bulk-note" role="note">
          {t("이 서버는 단일 서버라 트랜잭션이 없어 바뀐 뒤의 모습을 미리 볼 수 없습니다. 미리보기는 앞 몇 건을 트랜잭션 안에서 실제로 고쳐 읽은 뒤 되돌리는 방식이라 레플리카셋이나 샤드 클러스터에서만 됩니다. 아래는 바뀔 문서의 지금 모습입니다.")}
        </div>
        {look.docs.length === 0 ? (
          <div className="panel-dim">{t("조건에 맞는 문서가 없습니다")}</div>
        ) : (
          <div className="mg-bulk-docs">
            <JsonView docs={look.docs} offset={0} canonical={false} allFolded={false} readOnly notify={notify} />
          </div>
        )}
      </>
    );
  } else if (look.preview.samples.length === 0) {
    lookBody = <div className="panel-dim">{t("조건에 맞는 문서가 없습니다")}</div>;
  } else {
    lookBody = (
      <div className="mg-bulk-samples">
        {look.preview.samples.map((s, i) => (
          <SampleDiff key={i} before={s.before} after={s.after} changedOnly={changedOnly} />
        ))}
      </div>
    );
  }

  return (
    <AdminModal
      title={title}
      path={`${ns.db}.${ns.coll}`}
      className="mg-bulk-modal"
      busy={busy || review !== null}
      onClose={onClose}
      foot={
        <>
          {outcome !== null ? (
            <span className="mg-bulk-outcome" role="status">
              {outcome.mode === "delete"
                ? t("삭제 {count}개", { count: outcome.deleted.toLocaleString() })
                : t("일치 {matched}개 · 수정 {modified}개", { matched: outcome.matched.toLocaleString(), modified: outcome.modified.toLocaleString() })}
            </span>
          ) : (
            <span className="panel-dim">{t("⌘↩ 다시 세고 미리보기")}</span>
          )}
          <span className="spacer" />
          <button type="button" onClick={onClose} disabled={busy}>
            {outcome !== null ? t("닫기") : t("취소")}
          </button>
          <button type="button" className={mode === "delete" ? "primary danger" : "primary"} disabled={!canRun} onClick={() => void run()}>
            {busy ? <Spinner size={10} /> : null}
            {mode === "delete"
              ? matched?.count != null
                ? t("{count}개 삭제 (deleteMany)", { count: countText(matched) })
                : t("삭제 (deleteMany)")
              : matched?.count != null
                ? t("{count}개 수정 (updateMany)", { count: countText(matched) })
                : t("수정 (updateMany)")}
          </button>
        </>
      }
    >
      <div className="mg-subtabs mg-seg" role="radiogroup" aria-label={t("작업 [연산]")}>
        {(["update", "delete"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            className={mode === m ? "active" : undefined}
            disabled={busy}
            onClick={() => {
              setMode(m);
              setOutcome(null);
              setFailure(null);
            }}
          >
            {m === "update" ? t("일괄 수정") : t("일괄 삭제")}
          </button>
        ))}
      </div>
      <div className="mg-form-row">
        <span className="mg-form-label">{t("필터 (쿼리 막대에서 가져옴)")}</span>
        <MongoEditor
          value={filterText}
          onChange={editFilter}
          onRun={refreshNow}
          role="filter"
          completion={completion}
          className="mg-bulk-editor mg-bulk-filter"
          error={filter.ok ? null : filter.error}
          ariaLabel={t("필터")}
          placeholder={t("비워 두면 모든 문서")}
        />
        {!filter.ok ? <SyntaxErrorNotice src={filterText} message={say(filter.error.message)} at={filter.error.from} context="document" /> : null}
      </div>
      <div className="mg-bulk-count" role="status" aria-live="polite">
        <span className="mg-form-label">{mode === "delete" ? t("지울 문서") : t("영향받는 문서")}</span>
        {countError !== null ? (
          <ErrorNotice error={countError} context="document" engine="mongodb" variant="compact" onRetry={refreshNow} />
        ) : (
          <span className={`mg-bulk-count-v${mode === "delete" && matched?.count ? " danger" : ""}`}>
            {filter.ok ? (matched === null ? <Spinner size={10} /> : matched.count === null ? countText(matched) : t("문서 {count}개", { count: countText(matched) })) : "—"}
          </span>
        )}
        {filter.ok && filter.value.size === 0 ? <span className="mg-danger-text">{t("필터가 비어 있어 컬렉션의 모든 문서가 대상입니다")}</span> : null}
        {optionsDoc !== null ? <span className="panel-dim mono">{t("쿼리 막대 옵션을 함께 씁니다: {options}", { options: toShell(optionsDoc) })}</span> : null}
      </div>
      {mode === "update" ? (
        <div className="mg-form-row">
          <div className="mg-bulk-headrow">
            <span className="mg-form-label">{t("수정 내용")}</span>
            <span className="spacer" />
            <div className="mg-subtabs mg-seg" role="radiogroup" aria-label={t("수정 방식")}>
              {(["operators", "pipeline"] as const).map((k) => (
                <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? "active" : undefined} disabled={busy} onClick={() => setKind(k)}>
                  {k === "operators" ? t("연산자 ($set …)") : t("파이프라인 [ … ]")}
                </button>
              ))}
            </div>
          </div>
          <MongoEditor
            key={kind}
            value={updateText}
            onChange={editUpdate}
            onRun={refreshNow}
            role={kind === "operators" ? "update" : "pipeline"}
            completion={completion}
            className="mg-bulk-editor"
            autoFocus
            error={updateDoc.ok ? null : updateDoc.range}
            ariaLabel={t("수정 내용")}
          />
          {!updateDoc.ok && updateDoc.range !== null ? <SyntaxErrorNotice src={updateText} message={say(updateDoc.message)} at={updateDoc.range.from} context="document" /> : null}
        </div>
      ) : null}
      <CommandPreview command={command} problem={problem} />
      <div className="mg-bulk-headrow">
        <span className="mg-form-label">{mode === "delete" ? t("지워질 문서 (앞부분)") : t("바뀌기 전 · 뒤 (앞부분)")}</span>
        <span className="spacer" />
        {mode === "update" && look?.state === "preview" && look.preview.previewed ? (
          <label className="mg-bulk-check">
            <input type="checkbox" checked={changedOnly} onChange={(event) => setChangedOnly(event.target.checked)} />
            {t("바뀐 필드만")}
          </label>
        ) : null}
        <label className="mg-bulk-check">
          {t("앞")}
          <Select className="mg-input" value={String(size)} disabled={busy} onChange={(event) => setSize(Number(event.target.value))}>
            {SAMPLE_SIZES.map((n) => (
              <option key={n} value={n}>
                {t("{count}건", { count: n })}
              </option>
            ))}
          </Select>
        </label>
      </div>
      {lookBody}
      {failure !== null ? <WriteErrorNotice error={failure} variant="block" /> : null}
      {/* Over this dialog, not inside its scrolling body. */}
      {review !== null
        ? createPortal(<ReviewModal mode={safeMode === 0 ? 1 : safeMode} items={[review.item]} offerTx={false} onRun={() => review.resolve(true)} onClose={() => review.resolve(false)} />, document.body)
        : null}
    </AdminModal>
  );
}
