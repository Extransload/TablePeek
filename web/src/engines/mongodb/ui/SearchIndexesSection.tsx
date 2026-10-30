// The 인덱스 sub-tab's 검색 인덱스 section (MONGODB.md §8.1): the
// collection's Atlas Search and Vector Search indexes with their status and
// whether queries can use them yet, a dialog that creates or changes one
// from its JSON definition (with templates), and delete with confirmation.
// A server without search (anything but Atlas or a server with mongot)
// gets a plain note instead of an error.

import { useEffect, useMemo, useState } from "react";
import { notifyError, ErrorNotice } from "../../../components/ErrorNotice";
import { PencilIcon, PlusIcon, RefreshIcon, TrashIcon } from "../../../components/icons";
import { Select } from "../../../components/Select";
import { Spinner } from "../../../components/Spinner";
import { SuggestInput } from "../../../components/SuggestInput";
import { phrase, say, t, type Phrase } from "../../../i18n";
import { MongoError, createSearchIndex, dropSearchIndex, isAbort, listSearchIndexes, updateSearchIndex, type Namespace, type SearchIndexInfo } from "../api";
import { Int32, bsonDoc, type BsonDocument } from "../bson";
import { shellCollection, toShell, toShellPretty } from "../format";
import { AdminModal, CommandPreview, Failure } from "./AdminModal";
import { parseDocText } from "./JsonView";
import { MongoEditor } from "./MongoEditor";
import type { DocHost } from "./types";
import "./streams.css";

// While an index builds, the list reads again this often.
const BUILDING_POLL_MS = 5000;

type SearchKind = "search" | "vectorSearch";

const SIMILARITIES = ["cosine", "euclidean", "dotProduct"];

// The status word's colour class.
function statusClass(status: string): string {
  switch (status.toUpperCase()) {
    case "READY":
      return "ready";
    case "FAILED":
      return "failed";
    case "DELETING":
    case "DOES_NOT_EXIST":
      return "dim";
    default:
      return "building";
  }
}

export function SearchIndexesSection({ ns, readOnly, fields, host }: { ns: Namespace; readOnly: boolean; fields: string[]; host: DocHost }) {
  const [indexes, setIndexes] = useState<SearchIndexInfo[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reloadSeq, setReloadSeq] = useState(0);
  const [editing, setEditing] = useState<{ index: SearchIndexInfo | null } | null>(null);
  const [dropping, setDropping] = useState<string | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    setError(null);
    listSearchIndexes(ns, ctl.signal).then(setIndexes, (e: unknown) => {
      if (!isAbort(e)) {
        setIndexes(null);
        setError(e);
      }
    });
    return () => ctl.abort();
  }, [ns.conn, ns.db, ns.coll, reloadSeq]);

  // Read again while something is still being built or removed.
  const settling = indexes?.some((ix) => statusClass(ix.status) === "building" || ix.status.toUpperCase() === "DELETING") ?? false;
  useEffect(() => {
    if (!settling) {
      return;
    }
    const timer = window.setTimeout(() => setReloadSeq((n) => n + 1), BUILDING_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [settling, indexes]);

  const unsupported = error instanceof MongoError && error.code === "unsupported_capability";

  async function drop(name: string): Promise<void> {
    const ok = await host.confirm({
      title: t("검색 인덱스 삭제"),
      message: t("검색 인덱스 {name}을 지울까요?\n이 인덱스를 쓰는 $search·$vectorSearch 쿼리는 실패합니다.", { name }),
      command: `${shellCollection(ns.coll)}.dropSearchIndex(${JSON.stringify(name)})`,
      okLabel: t("삭제"),
    });
    if (!ok) {
      return;
    }
    setDropping(name);
    try {
      await dropSearchIndex(ns, name);
      host.notify(t("검색 인덱스 {name}을 지웠습니다", { name }));
      setReloadSeq((n) => n + 1);
    } catch (e) {
      notifyError(e, { context: "structure" });
    } finally {
      setDropping(null);
    }
  }

  return (
    <section className="structure-section mg-search-section">
      <div className="mg-search-head">
        <span className="mg-agg-count">{indexes === null ? t("검색 인덱스") : t("검색 인덱스 {count}개", { count: indexes.length })}</span>
        <span className="panel-dim">Atlas Search · Vector Search</span>
        <span className="spacer" />
        <button type="button" className="icon-button" title={t("새로고침")} aria-label={t("검색 인덱스 새로고침")} onClick={() => setReloadSeq((n) => n + 1)}>
          <RefreshIcon size={12} />
        </button>
        {readOnly || unsupported ? null : (
          <button type="button" className="mg-qbtn" onClick={() => setEditing({ index: null })}>
            <PlusIcon size={9} />
            {t("검색 인덱스 만들기")}
          </button>
        )}
      </div>
      {unsupported ? (
        <div className="mg-search-unsupported" role="note">
          <div>{t("이 서버에서는 검색 인덱스를 쓸 수 없습니다.")}</div>
          <div className="panel-dim">{t("Atlas 클러스터나 검색 프로세스(mongot)가 함께 도는 서버(예: Atlas 로컬 배포)에서 만들고 볼 수 있습니다.")}</div>
        </div>
      ) : error !== null ? (
        <ErrorNotice error={error} context="structure" engine="mongodb" variant="compact" onRetry={() => setReloadSeq((n) => n + 1)} />
      ) : indexes === null ? (
        <div className="mg-search-loading">
          <Spinner size={11} />
        </div>
      ) : indexes.length === 0 ? (
        <div className="panel-dim mg-search-empty">{t("검색 인덱스가 없습니다")}</div>
      ) : (
        <table className="panel-table mg-struct-table mg-ix-table">
          <thead>
            <tr>
              <th>{t("이름")}</th>
              <th>{t("종류")}</th>
              <th>{t("상태")}</th>
              <th>{t("조회 가능")}</th>
              <th>{t("정의")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {indexes.map((ix) => (
              <tr key={ix.name}>
                <td className="mono">{ix.name}</td>
                <td>
                  <span className="mg-flag dim">{ix.type}</span>
                </td>
                <td>
                  <span className={`mg-search-status ${statusClass(ix.status)}`}>{ix.status || "—"}</span>
                </td>
                <td>{ix.queryable ? <span className="mg-search-yes">{t("예")}</span> : <span className="panel-dim">{t("아니요")}</span>}</td>
                <td className="mono mg-search-def" title={ix.definition !== null ? toShellPretty(ix.definition) : undefined}>
                  {ix.definition !== null ? toShell(ix.definition) : ""}
                </td>
                <td className="num mg-search-acts">
                  {readOnly ? null : (
                    <>
                      <button type="button" className="icon-text-button" disabled={dropping !== null} onClick={() => setEditing({ index: ix })}>
                        <PencilIcon size={10} />
                        {t("고치기")}
                      </button>
                      <button type="button" className="icon-text-button mg-danger-text" disabled={dropping !== null} onClick={() => void drop(ix.name)}>
                        {dropping === ix.name ? <Spinner size={10} /> : <TrashIcon size={10} />}
                        {t("삭제")}
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing !== null ? (
        <SearchIndexDialog
          ns={ns}
          fields={fields}
          index={editing.index}
          onClose={() => setEditing(null)}
          onDone={(name, created) => {
            setEditing(null);
            host.notify(created ? t("검색 인덱스 {name}을 만들었습니다. 다 만들어지면 상태가 READY로 바뀝니다", { name }) : t("검색 인덱스 {name}을 고쳤습니다. 다시 만들어지는 동안 이전 정의로 조회합니다", { name }));
            setReloadSeq((n) => n + 1);
          }}
        />
      ) : null}
    </section>
  );
}

function dynamicTemplate(): BsonDocument {
  return bsonDoc({ mappings: bsonDoc({ dynamic: true }) });
}

function fieldsTemplate(field: string): BsonDocument {
  return bsonDoc({
    mappings: bsonDoc({
      dynamic: false,
      fields: new Map([[field, bsonDoc({ type: "string", analyzer: "lucene.standard" })]]),
    }),
  });
}

function vectorTemplate(path: string, dims: number, similarity: string): BsonDocument {
  return bsonDoc({
    fields: [bsonDoc({ type: "vector", path, numDimensions: new Int32(dims), similarity })],
  });
}

function SearchIndexDialog({
  ns,
  fields,
  index,
  onClose,
  onDone,
}: {
  ns: Namespace;
  fields: string[];
  // The index being changed; null to make a new one.
  index: SearchIndexInfo | null;
  onClose(): void;
  onDone(name: string, created: boolean): void;
}) {
  const creating = index === null;
  const [name, setName] = useState(index?.name ?? "default");
  const [kind, setKind] = useState<SearchKind>(index?.type === "vectorSearch" ? "vectorSearch" : "search");
  const [text, setText] = useState(() => toShellPretty(index?.definition ?? dynamicTemplate()));
  const [vectorPath, setVectorPath] = useState(() => fields.find((f) => /embed|vector/i.test(f)) ?? "embedding");
  const [dims, setDims] = useState("1536");
  const [similarity, setSimilarity] = useState("cosine");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);

  const parsed = useMemo(() => parseDocText(text, false), [text]);

  const plan = useMemo((): { command: string; definition: BsonDocument } | { error: Phrase } => {
    if (creating && name.trim() === "") {
      return { error: phrase("이름을 쓰세요") };
    }
    if (!parsed.ok) {
      return { error: phrase("정의: {message}", { message: parsed.message }) };
    }
    const coll = shellCollection(ns.coll);
    if (creating) {
      const spec = bsonDoc({ name: name.trim(), type: kind, definition: parsed.value });
      return { command: `${coll}.createSearchIndex(${toShellPretty(spec)})`, definition: parsed.value };
    }
    return { command: `${coll}.updateSearchIndex(${JSON.stringify(name)}, ${toShellPretty(parsed.value)})`, definition: parsed.value };
  }, [creating, name, kind, parsed, ns.coll]);

  const dimsNumber = Number(dims);
  const dimsOk = Number.isInteger(dimsNumber) && dimsNumber >= 1 && dimsNumber <= 8192;

  function applyTemplate(next: BsonDocument, nextKind: SearchKind): void {
    setText(toShellPretty(next));
    if (creating) {
      setKind(nextKind);
    }
    setFailure(null);
  }

  async function submit(): Promise<void> {
    if (busy || "error" in plan) {
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      if (creating) {
        onDone(await createSearchIndex(ns, name.trim(), kind, plan.definition), true);
      } else {
        await updateSearchIndex(ns, name, plan.definition);
        onDone(name, false);
      }
    } catch (e) {
      setFailure(e);
    } finally {
      setBusy(false);
    }
  }

  const title = creating ? t("검색 인덱스 만들기") : t("검색 인덱스 고치기");
  return (
    <AdminModal
      title={title}
      path={`${ns.db}.${ns.coll}`}
      className="mg-search-modal"
      busy={busy}
      onClose={onClose}
      foot={
        <>
          <span className="spacer" />
          <button type="button" onClick={onClose} disabled={busy}>
            {t("취소")}
          </button>
          <button type="button" className="primary" disabled={busy || "error" in plan} onClick={() => void submit()}>
            {busy ? <Spinner size={10} /> : null}
            {creating ? t("만들기") : t("저장")}
          </button>
        </>
      }
    >
      <div className="mg-form-grid">
        <label className="mg-form-row">
          <span className="mg-form-label">{t("이름")}</span>
          <input type="text" className="mg-input mono" spellCheck={false} value={name} disabled={!creating} autoFocus={creating} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="mg-form-row">
          <span className="mg-form-label">{t("종류")}</span>
          <Select className="mg-input" value={kind} disabled={!creating} onChange={(event) => setKind(event.target.value as SearchKind)}>
            <option value="search">{t("search (전문 검색)")}</option>
            <option value="vectorSearch">{t("vectorSearch (벡터 검색)")}</option>
          </Select>
        </label>
      </div>
      <div className="mg-form-label">{t("틀")}</div>
      <div className="mg-checks mg-search-templates">
        <button type="button" className="mg-qbtn" onClick={() => applyTemplate(dynamicTemplate(), "search")}>
          {t("동적 매핑")}
        </button>
        <button type="button" className="mg-qbtn" onClick={() => applyTemplate(fieldsTemplate(fields.find((f) => f !== "_id" && !f.includes(".")) ?? "title"), "search")}>
          {t("필드 매핑")}
        </button>
        <span className="mg-search-vector">
          <button type="button" className="mg-qbtn" disabled={!dimsOk || vectorPath.trim() === ""} onClick={() => applyTemplate(vectorTemplate(vectorPath.trim(), dimsNumber, similarity), "vectorSearch")}>
            {t("벡터 검색")}
          </button>
          <SuggestInput
            type="text"
            className="mg-input mono"
            suggestions={fields}
            aria-label={t("벡터 필드 경로 (path)")}
            title={t("벡터 필드 경로 (path)")}
            placeholder="path"
            spellCheck={false}
            value={vectorPath}
            onChange={(event) => setVectorPath(event.target.value)}
          />
          <input
            type="number"
            className="mg-input mg-num"
            aria-label={t("차원 수 (numDimensions)")}
            title={t("차원 수 (numDimensions)")}
            aria-invalid={!dimsOk}
            min={1}
            max={8192}
            value={dims}
            onChange={(event) => setDims(event.target.value)}
          />
          <Select className="mg-input" aria-label={t("유사도 (similarity)")} value={similarity} onChange={(event) => setSimilarity(event.target.value)}>
            {SIMILARITIES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </span>
      </div>
      <div className="mg-form-label">{t("정의 (mongosh 표기 또는 JSON)")}</div>
      <MongoEditor value={text} onChange={(value) => { setText(value); setFailure(null); }} role="doc" className="mg-admin-editor mg-search-editor" error={parsed.ok ? null : { from: parsed.from, to: parsed.to }} onRun={() => void submit()} ariaLabel={t("검색 인덱스 정의")} />
      {creating ? null : <div className="panel-dim">{t("고치면 새 정의로 다시 만드는 동안에도 이전 정의로 조회할 수 있습니다.")}</div>}
      <CommandPreview command={"error" in plan ? null : plan.command} problem={"error" in plan ? say(plan.error) : null} />
      <Failure error={failure} />
    </AdminModal>
  );
}
