// The 인덱스 sub-tab (MONGODB.md §3.6): the collection's indexes with their
// keys (↑ ascending, ↓ descending), options, size and use count, a create
// dialog that shows the command it will send, and drop with confirmation.
// Below them, the Atlas Search indexes (SearchIndexesSection). An index
// picked in the list shows in the app's detail panel.

import { useEffect, useMemo, useRef, useState } from "react";
import { ErrorNotice, notifyError } from "../../../components/ErrorNotice";
import { PlusIcon, RefreshIcon, TrashIcon, CloseIcon } from "../../../components/icons";
import { Select } from "../../../components/Select";
import { LoadingState, Spinner } from "../../../components/Spinner";
import { SuggestInput } from "../../../components/SuggestInput";
import { formatBytes } from "../../../format";
import { phrase, say, t, type Phrase } from "../../../i18n";
import { createIndex, dropIndex, isAbort, listIndexes, type IndexInfo, type Namespace } from "../api";
import { Int32, isNumber, type BsonDocument } from "../bson";
import { shellCollection, toShell } from "../format";
import { parseFilter } from "../shell/parse";
import { DocDetailPanel, FactsList, NothingSelected, type Fact } from "./DocDetailPanel";
import { arrowStep, selectsItem } from "./selection";
import { ShellText } from "./ShellText";
import { SearchIndexesSection } from "./SearchIndexesSection";
import type { IndexCreateRequest, IndexesPanelProps } from "./types";
import "./panels.css";

// Create requests already opened. The panel is mounted again each time its
// tab is shown while the workbench keeps the last request, so a request is
// known by identity rather than by the panel's own state.
const handledRequests = new WeakSet<IndexCreateRequest>();

// Index key kinds the dialog offers besides the two directions.
const SPECIAL_KINDS = ["text", "hashed", "2dsphere"];

function KeyChips({ keys }: { keys: BsonDocument }) {
  return (
    <span className="mg-keychips">
      {[...keys].map(([field, v]) => {
        const dir = isNumber(v) ? (Number(v.value) < 0 ? "↓" : "↑") : typeof v === "string" ? v : toShell(v);
        return (
          <span key={field} className="mg-keychip" title={`${field}: ${toShell(v)}`}>
            <span className="mono">{field}</span>
            <span className="mg-keydir">{dir}</span>
          </span>
        );
      })}
    </span>
  );
}

function IndexFlags({ index }: { index: IndexInfo }) {
  const flags = [
    index.unique ? (
      <span key="unique" className="mg-flag unique">
        UNIQUE
      </span>
    ) : null,
    index.sparse ? (
      <span key="sparse" className="mg-flag">
        SPARSE
      </span>
    ) : null,
    index.expireAfterSeconds !== undefined ? (
      <span key="ttl" className="mg-flag ttl" title={t("{seconds}초 뒤 만료", { seconds: index.expireAfterSeconds.toLocaleString() })}>
        TTL {t("{seconds}초", { seconds: index.expireAfterSeconds.toLocaleString() })}
      </span>
    ) : null,
    index.partialFilterExpression !== undefined ? (
      <span key="partial" className="mg-flag" title={toShell(index.partialFilterExpression)}>
        PARTIAL
      </span>
    ) : null,
    index.key.size > 1 ? (
      <span key="compound" className="mg-flag dim">
        {t("복합")}
      </span>
    ) : null,
  ].filter((flag) => flag !== null);
  return flags.length > 0 ? <>{flags}</> : <span className="panel-dim">—</span>;
}

// An index as the detail panel lists it, by the server's option names.
function indexFacts(ix: IndexInfo): Fact[] {
  const facts: Fact[] = [{ name: "key", value: toShell(ix.key) }];
  if (ix.unique) {
    facts.push({ name: "unique", value: "true" });
  }
  if (ix.sparse) {
    facts.push({ name: "sparse", value: "true" });
  }
  if (ix.expireAfterSeconds !== undefined) {
    facts.push({ name: "expireAfterSeconds", value: String(ix.expireAfterSeconds) });
  }
  if (ix.partialFilterExpression !== undefined) {
    facts.push({ name: "partialFilterExpression", value: toShell(ix.partialFilterExpression) });
  }
  if (ix.size !== undefined) {
    facts.push({ name: "size", value: formatBytes(ix.size) });
  }
  if (ix.ops !== undefined) {
    facts.push({ name: "$indexStats.accesses.ops", value: ix.ops.toLocaleString() });
  }
  return facts;
}

export function IndexesPanel({ ns, readOnly, fields, createRequest, host, facts, onChanged }: IndexesPanelProps) {
  const [indexes, setIndexes] = useState<IndexInfo[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reloadSeq, setReloadSeq] = useState(0);
  // The create dialog, with its starting keys.
  const [creating, setCreating] = useState<{ keys: BsonDocument | null } | null>(null);
  const [dropping, setDropping] = useState<string | null>(null);
  // The index in the detail panel, by name.
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    const ctl = new AbortController();
    setError(null);
    listIndexes(ns, ctl.signal).then(
      (list) => setIndexes(list),
      (e: unknown) => {
        if (!isAbort(e)) {
          setError(e);
        }
      },
    );
    return () => ctl.abort();
  }, [ns.conn, ns.db, ns.coll, reloadSeq]);

  useEffect(() => {
    if (createRequest !== null && !handledRequests.has(createRequest) && !readOnly) {
      handledRequests.add(createRequest);
      setCreating({ keys: createRequest.keys });
    }
  }, [createRequest, readOnly]);

  async function drop(name: string): Promise<void> {
    const ok = await host.confirm({
      title: t("인덱스 삭제"),
      message: t("인덱스 {name}을 지울까요?\n이 인덱스를 쓰던 쿼리는 느려질 수 있습니다.", { name }),
      command: `${shellCollection(ns.coll)}.dropIndex(${JSON.stringify(name)})`,
      okLabel: t("삭제"),
    });
    if (!ok) {
      return;
    }
    setDropping(name);
    try {
      await dropIndex(ns, name);
      host.notify(t("인덱스 {name}을 지웠습니다", { name }));
      setReloadSeq((n) => n + 1);
      onChanged();
    } catch (e) {
      notifyError(e, { context: "structure" });
    } finally {
      setDropping(null);
    }
  }

  const total = indexes?.reduce((sum, ix) => sum + (ix.size ?? 0), 0) ?? 0;
  const sized = indexes?.some((ix) => ix.size !== undefined) ?? false;
  const pickedIndex = picked === null ? undefined : indexes?.find((ix) => ix.name === picked);
  const pickAt = (table: HTMLTableElement | null, at: number) => {
    const ix = indexes?.[at];
    if (ix !== undefined) {
      setPicked(ix.name);
      table?.tBodies[0]?.rows[at]?.scrollIntoView({ block: "nearest" });
    }
  };

  return (
    <div className="mg-pane mg-indexes">
      <div className="mg-agg-bar">
        <span className="mg-agg-count">
          {indexes === null
            ? t("인덱스")
            : sized
              ? t("인덱스 {count}개 · 전체 {size}", { count: indexes.length, size: formatBytes(total) ?? "" })
              : t("인덱스 {count}개", { count: indexes.length })}
        </span>
        <span className="spacer" />
        <button type="button" className="icon-button" title={t("새로고침")} aria-label={t("새로고침")} onClick={() => setReloadSeq((n) => n + 1)}>
          <RefreshIcon size={12} />
        </button>
        {readOnly ? null : (
          <button type="button" className="primary mg-find" onClick={() => setCreating({ keys: null })}>
            <PlusIcon size={9} />
            {t("인덱스 만들기")}
          </button>
        )}
      </div>
      <div className="mg-ix-body">
        {error !== null ? (
          <ErrorNotice error={error} context="structure" engine="mongodb" />
        ) : indexes === null ? (
          <LoadingState />
        ) : (
          <section className="structure-section">
            <table
              className="panel-table mg-struct-table mg-ix-table mg-pick-table"
              tabIndex={-1}
              onKeyDown={(event) => {
                const next = arrowStep(event, indexes.length, indexes.findIndex((ix) => ix.name === picked));
                if (next !== null) {
                  event.preventDefault();
                  pickAt(event.currentTarget, next);
                }
              }}
            >
              <thead>
                <tr>
                  <th>{t("이름")}</th>
                  <th>{t("키")}</th>
                  <th>{t("속성")}</th>
                  <th className="num">{t("크기")}</th>
                  <th className="num">{t("사용")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {indexes.map((ix, at) => (
                  <tr
                    key={ix.name}
                    className={ix.name === picked ? "selected" : undefined}
                    onClick={(event) => {
                      if (selectsItem(event.target)) {
                        pickAt(null, at);
                        event.currentTarget.closest("table")?.focus({ preventScroll: true });
                      }
                    }}
                  >
                    <td className="mono">{ix.name}</td>
                    <td>
                      <KeyChips keys={ix.key} />
                    </td>
                    <td>
                      <IndexFlags index={ix} />
                    </td>
                    <td className="num mono">{ix.size !== undefined ? formatBytes(ix.size) : ""}</td>
                    <td className="num mono">{ix.ops !== undefined ? t("{count}회", { count: ix.ops.toLocaleString() }) : ""}</td>
                    <td className="num">
                      {ix.name === "_id_" ? (
                        <span className="panel-dim">{t("기본")}</span>
                      ) : readOnly ? null : (
                        <button type="button" className="icon-text-button mg-danger-text" disabled={dropping !== null} onClick={() => void drop(ix.name)}>
                          {dropping === ix.name ? <Spinner size={10} /> : <TrashIcon size={10} />}
                          {t("삭제")}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
        <div className="mg-ix-hint panel-dim">{t("사용 횟수는 서버가 켜진 뒤 $indexStats가 센 값입니다. 권한이 없으면 크기·사용 칸은 비어 있습니다.")}</div>
        <SearchIndexesSection ns={ns} readOnly={readOnly} fields={fields} host={host} />
      </div>
      {creating !== null ? (
        <CreateIndexDialog
          ns={ns}
          fields={fields}
          initial={creating.keys}
          onClose={() => setCreating(null)}
          onCreated={(name) => {
            setCreating(null);
            host.notify(t("인덱스 {name}을 만들었습니다", { name }));
            setReloadSeq((n) => n + 1);
            onChanged();
          }}
        />
      ) : null}
      <DocDetailPanel>
        {(query) =>
          pickedIndex !== undefined ? (
            <FactsList key={pickedIndex.name} title={<span className="mg-detail-path mono">{pickedIndex.name}</span>} facts={indexFacts(pickedIndex)} query={query} />
          ) : (
            <NothingSelected facts={facts} query={query} empty={t("선택된 인덱스가 없습니다")} />
          )
        }
      </DocDetailPanel>
    </div>
  );
}

interface KeyRow {
  id: number;
  field: string;
  // "1", "-1" or a special kind.
  kind: string;
}

function keyRowsOf(keys: BsonDocument | null): KeyRow[] {
  const entries = [...(keys ?? [])];
  if (entries.length === 0) {
    return [{ id: 0, field: "", kind: "1" }];
  }
  return entries.map(([field, v], id) => ({
    id,
    field,
    kind: isNumber(v) ? (Number(v.value) < 0 ? "-1" : "1") : typeof v === "string" ? v : "1",
  }));
}

function CreateIndexDialog({
  ns,
  fields,
  initial,
  onClose,
  onCreated,
}: {
  ns: Namespace;
  fields: string[];
  initial: BsonDocument | null;
  onClose(): void;
  onCreated(name: string): void;
}) {
  const [rows, setRows] = useState<KeyRow[]>(() => keyRowsOf(initial));
  const [name, setName] = useState("");
  const [unique, setUnique] = useState(false);
  const [sparse, setSparse] = useState(false);
  const [ttlOn, setTtlOn] = useState(false);
  const [ttl, setTtl] = useState("3600");
  const [partial, setPartial] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const nextId = useRef(rows.length);

  // The command as it will be sent, or why it cannot be.
  const spec = useMemo((): { keys: BsonDocument; options: BsonDocument } | { error: Phrase } => {
    const keys: BsonDocument = new Map();
    for (const row of rows) {
      const field = row.field.trim();
      if (field !== "") {
        keys.set(field, row.kind === "1" || row.kind === "-1" ? new Int32(Number(row.kind)) : row.kind);
      }
    }
    const options: BsonDocument = new Map();
    if (name.trim() !== "") {
      options.set("name", name.trim());
    }
    if (unique) {
      options.set("unique", true);
    }
    if (sparse) {
      options.set("sparse", true);
    }
    if (ttlOn) {
      const seconds = Number(ttl);
      if (!Number.isInteger(seconds) || seconds < 0) {
        return { error: phrase("TTL은 0 이상의 정수(초)여야 합니다") };
      }
      options.set("expireAfterSeconds", new Int32(seconds));
    }
    if (partial.trim() !== "") {
      const parsed = parseFilter(partial);
      if (!parsed.ok) {
        return { error: phrase("부분 인덱스 조건: {message}", { message: parsed.error.message }) };
      }
      options.set("partialFilterExpression", parsed.value);
    }
    return { keys, options };
  }, [rows, name, unique, sparse, ttlOn, ttl, partial]);

  const command =
    "error" in spec
      ? null
      : `${shellCollection(ns.coll)}.createIndex(${toShell(spec.keys)}${spec.options.size > 0 ? `, ${toShell(spec.options)}` : ""})`;
  const problem = "error" in spec ? say(spec.error) : spec.keys.size === 0 ? t("필드를 하나 이상 고르세요") : null;

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  function setRow(id: number, patch: Partial<KeyRow>): void {
    setRows((list) => list.map((row) => (row.id === id ? { ...row, ...patch } : row)));
    setFailure(null);
  }

  async function submit(): Promise<void> {
    if (busy || problem !== null || "error" in spec) {
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      onCreated(await createIndex(ns, spec.keys, spec.options));
    } catch (e) {
      setFailure(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <form
        className="modal mg-ix-modal"
        role="dialog"
        aria-label={t("인덱스 만들기")}
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="modal-head">
          <span className="modal-title">{t("인덱스 만들기")}</span>
          <span className="modal-path">{`${ns.db}.${ns.coll}`}</span>
        </div>
        <div className="modal-body mg-form">
          <div className="mg-form-label">{t("키 (순서가 중요합니다: 같음 → 정렬 → 범위)")}</div>
          <div className="mg-ix-rows">
            {rows.map((row, i) => (
              <div key={row.id} className="mg-ix-row">
                <SuggestInput
                  type="text"
                  className="mg-input mono"
                  suggestions={fields}
                  placeholder={t("필드 경로")}
                  aria-label={t("필드 경로")}
                  spellCheck={false}
                  autoFocus={i === 0 && initial === null}
                  value={row.field}
                  onChange={(event) => setRow(row.id, { field: event.target.value })}
                />
                <Select className="mg-input" aria-label={t("방향")} value={row.kind} onChange={(event) => setRow(row.id, { kind: event.target.value })}>
                  <option value="1">{t("1 (오름차순)")}</option>
                  <option value="-1">{t("-1 (내림차순)")}</option>
                  {SPECIAL_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {kind}
                    </option>
                  ))}
                </Select>
                <button
                  type="button"
                  className="icon-button"
                  title={t("빼기")}
                  aria-label={t("빼기")}
                  disabled={rows.length === 1}
                  onClick={() => setRows((list) => list.filter((r) => r.id !== row.id))}
                >
                  <CloseIcon size={9} />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="mg-qbtn"
            onClick={() => {
              setRows((list) => [...list, { id: nextId.current++, field: "", kind: "1" }]);
            }}
          >
            <PlusIcon size={9} />
            {t("필드 추가")}
          </button>
          <div className="mg-form-grid">
            <label className="mg-form-row">
              <span className="mg-form-label">{t("이름")}</span>
              <input
                type="text"
                className="mg-input"
                placeholder={t("비우면 자동 (예: status_1_orderedAt_-1)")}
                spellCheck={false}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label className="mg-form-row">
              <span className="mg-form-label">{t("부분 인덱스 조건")}</span>
              <input
                type="text"
                className="mg-input mono"
                placeholder={t('예: { status: "paid" }')}
                spellCheck={false}
                value={partial}
                onChange={(event) => setPartial(event.target.value)}
              />
            </label>
          </div>
          <div className="mg-checks">
            <label>
              <input type="checkbox" checked={unique} onChange={(event) => setUnique(event.target.checked)} />
              {t("고유 (unique)")}
            </label>
            <label>
              <input type="checkbox" checked={sparse} onChange={(event) => setSparse(event.target.checked)} />
              {t("희소 (sparse)")}
            </label>
            <label>
              <input type="checkbox" checked={ttlOn} onChange={(event) => setTtlOn(event.target.checked)} />
              TTL
            </label>
            <input
              type="number"
              className="mg-input mg-num"
              aria-label={t("TTL 초")}
              min={0}
              disabled={!ttlOn}
              value={ttl}
              onChange={(event) => setTtl(event.target.value)}
            />
            <span className="panel-dim">{t("초 뒤 만료 (Date 필드)")}</span>
          </div>
          <div className="mg-form-label">{t("보낼 명령")}</div>
          <pre className="panel-pre mg-export-code mg-ix-preview">{command !== null ? <ShellText text={command} /> : <span className="mg-danger-text">{problem}</span>}</pre>
          {failure !== null ? <ErrorNotice error={failure} context="structure" engine="mongodb" variant="compact" /> : null}
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          <button type="button" onClick={onClose} disabled={busy}>
            {t("취소")}
          </button>
          <button type="submit" className="primary" disabled={busy || problem !== null}>
            {busy ? <Spinner size={10} /> : null}
            {t("만들기")}
          </button>
        </div>
      </form>
    </div>
  );
}
