// The index management dialogs of the search workbench: 인덱스 만들기,
// 매핑 복제, 삭제 (an index, a data stream or an alias), 열기·닫기·새로 고침,
// 재색인, 별칭 추가 and 통계. Each shows the request it sends in Dev Tools
// notation; writes ask first as safe mode says (deletes always ask, with the
// name typed under safe mode). Also the parts the import and export dialogs
// share: the request preview, the read-only line, the target lists.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { writeClipboard } from "../../../clipboard";
import { ErrorNotice, FieldError, fieldErrorProps, notifyError } from "../../../components/ErrorNotice";
import { Spinner } from "../../../components/Spinner";
import { SuggestInput } from "../../../components/SuggestInput";
import { formatBytes } from "../../../format";
import { getLanguage, say, t } from "../../../i18n";
import { JsonSyntaxError, parseJson, stringifyJson } from "../../mongodb/bson";
import { AdminModal } from "../../mongodb/ui/AdminModal";
import {
  SearchError,
  aliases as listAliases,
  consoleRequest,
  count,
  createIndex,
  dataStreams as listDataStreams,
  definition,
  getMapping,
  getSettings,
  indexAction,
  indices as listIndices,
  isAbort,
  reindex,
  shards as listShards,
  updateAliases,
  type AliasRow,
  type DataStreamRow,
  type IndexRow,
  type RequestClass,
} from "../api";
import { completeDsl, mappingFields, type DslCompletion, type MappedField } from "../dsl";
import { list, num, rec, str, type Json } from "../json";
import { indexNameProblem } from "../transfer";
import { ConsoleText, needsConfirm, requestText, type ConfirmRequest, type SearchHost } from "./common";
import { SearchEditor } from "./SearchEditor";
import type { SearchAdminEffect } from "./types";
import "../../mongodb/mongodb.css";
import "./admin.css";

export interface DialogProps {
  host: SearchHost;
  onEffect(effect: SearchAdminEffect): void;
  onClose(): void;
}

// ---- Shared parts ----

// Asks first when safe mode stops before this class of request; true to go on.
export async function askFirst(host: SearchHost, cls: RequestClass, request: ConfirmRequest): Promise<boolean> {
  return !needsConfirm(cls, host.safeMode) || host.confirm(request);
}

// The request a dialog will send, or why it cannot yet.
export function RequestPreview({ text, problem }: { text: string | null; problem: string | null }) {
  return (
    <>
      <div className="mg-form-label">{t("보낼 요청")}</div>
      <pre className="panel-pre mg-export-code mg-ix-preview es-request-pre">{problem === null && text !== null ? <ConsoleText text={text} /> : <span className="mg-danger-text">{problem}</span>}</pre>
    </>
  );
}

export function ReadOnlyNote() {
  return <p className="es-admin-note">{t("읽기 전용 연결입니다 — 쓰기 요청은 보내지 않습니다")}</p>;
}

// A dialog's failed request, explained; nothing while `error` is null.
export function DialogFailure({ error, context = "structure", onRetry }: { error: unknown; context?: "structure" | "import" | "export"; onRetry?(): void }) {
  return error === null ? null : <ErrorNotice error={error} context={context} engine="elasticsearch" variant="compact" onRetry={onRetry} />;
}

// An editor's JSON text: its value, or why not and where (for the underline).
export function readJsonText(text: string, label: string): { value: Json } | { error: string; at: { from: number; to: number } | null } {
  try {
    return { value: parseJson(text) as Json };
  } catch (error) {
    if (error instanceof JsonSyntaxError) {
      return { error: `${label}: ${say(error.phrase)}`, at: { from: error.offset, to: error.offset + 1 } };
    }
    return { error: `${label}: ${error instanceof Error ? error.message : String(error)}`, at: null };
  }
}

function isObject(v: unknown): v is Record<string, Json> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// The indices (hidden ones too), aliases and data streams of the
// connection: name suggestions and what a name is.
export interface Targets {
  indices: IndexRow[];
  aliases: AliasRow[];
  streams: DataStreamRow[];
}

export function useTargets(conn: string): { data: Targets | null; error: unknown; reload(): void } {
  const [data, setData] = useState<Targets | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [seq, setSeq] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    Promise.all([listIndices(conn, true, controller.signal), listAliases(conn, controller.signal), listDataStreams(conn, controller.signal)]).then(
      ([indices, aliases, streams]) => setData({ indices, aliases, streams }),
      (err: unknown) => {
        if (!isAbort(err)) {
          setError(err);
        }
      },
    );
    return () => controller.abort();
  }, [conn, seq]);
  return { data, error, reload: () => setSeq((n) => n + 1) };
}

// Names to suggest: visible indices, aliases and data streams, once each.
export function targetNames(targets: Targets | null): string[] {
  if (targets === null) {
    return [];
  }
  const names = new Set<string>();
  for (const row of targets.indices) {
    if (!row.hidden) {
      names.add(row.name);
    }
  }
  for (const row of targets.aliases) {
    if (!row.is_hidden) {
      names.add(row.alias);
    }
  }
  for (const row of targets.streams) {
    if (!row.hidden) {
      names.add(row.name);
    }
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

// Whether the name is taken by an index, an alias or a data stream.
export function nameTaken(targets: Targets | null, name: string): boolean {
  return targets !== null && (targets.indices.some((r) => r.name === name) || targets.aliases.some((r) => r.alias === name) || targets.streams.some((r) => r.name === name));
}

// The mapped fields of an index (or of every index behind an alias or data
// stream, first one winning), for completion and the CSV field list. Null
// while loading.
export function useIndexFields(conn: string, index: string): { fields: MappedField[] | null; error: unknown } {
  const [fields, setFields] = useState<MappedField[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    setFields(null);
    setError(null);
    if (index === "") {
      setFields([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      getMapping(conn, index, controller.signal).then(
        (reply) => {
          const seen = new Map<string, MappedField>();
          for (const value of Object.values(reply)) {
            for (const field of mappingFields(rec(value).mappings)) {
              if (!seen.has(field.path)) {
                seen.set(field.path, field);
              }
            }
          }
          setFields([...seen.values()]);
        },
        (err: unknown) => {
          if (!isAbort(err)) {
            setFields([]);
            setError(err);
          }
        },
      );
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [conn, index]);
  return { fields, error };
}

const QUERY_WRAP = '{"query":';

// Completion for an editor holding one query (a filter, a reindex query):
// read as the `query` of a search body.
export function completeQuery(text: string, pos: number, fields: MappedField[]): DslCompletion | null {
  const result = completeDsl(QUERY_WRAP + text, QUERY_WRAP.length + pos, { fields, root: "count" });
  if (result === null || result.from < QUERY_WRAP.length) {
    return null;
  }
  return { ...result, from: result.from - QUERY_WRAP.length, to: result.to - QUERY_WRAP.length };
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="mg-stats-cell">
      <div className="mg-form-label">{label}</div>
      <div className="mono es-stats-value">{value}</div>
    </div>
  );
}

function countText(n: number | null): string {
  return n === null ? "—" : n.toLocaleString();
}

// ---- 인덱스 만들기 ----

const DEFAULT_MAPPINGS = '{\n  "properties": {\n  }\n}';
const REFRESH_TEXT = /^(?:-1|\d+(?:nanos|micros|ms|s|m|h|d)?)$/;

type BodyPlan = { index: string; body: Record<string, Json>; command: string } | { error: string; at?: { from: number; to: number } | null; editor?: "mappings" | "settings" | "body" | "query" | "filter" };

function CreateIndexDialog({ host, onEffect, onClose }: DialogProps) {
  const [name, setName] = useState("");
  const [shards, setShards] = useState("1");
  const [replicas, setReplicas] = useState("1");
  const [refresh, setRefresh] = useState("");
  const [mappingsText, setMappingsText] = useState(DEFAULT_MAPPINGS);
  const [advanced, setAdvanced] = useState(false);
  const [settingsText, setSettingsText] = useState("{\n}");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const targets = useTargets(host.conn);
  const language = getLanguage();
  const index = name.trim();
  const nameProblem = index === "" ? null : (indexNameProblem(index) ?? (nameTaken(targets.data, index) ? t("같은 이름의 인덱스·별칭·데이터 스트림이 있습니다") : null));

  // The simple fields as settings, or why they do not read.
  const simple = useMemo((): { settings: Record<string, Json> } | { error: string } => {
    if (!/^\d+$/.test(shards.trim()) || Number(shards) < 1 || Number(shards) > 1024) {
      return { error: t("샤드 수: 1에서 1024 사이의 정수를 쓰세요") };
    }
    if (!/^\d+$/.test(replicas.trim())) {
      return { error: t("복제본 수: 0 이상의 정수를 쓰세요") };
    }
    const settings: Record<string, Json> = { number_of_shards: Number(shards), number_of_replicas: Number(replicas) };
    if (refresh.trim() !== "") {
      if (!REFRESH_TEXT.test(refresh.trim())) {
        return { error: t("새로 고침 간격: 1s, 30s, 1m 또는 -1(끔)처럼 쓰세요") };
      }
      settings.refresh_interval = refresh.trim();
    }
    return { settings };
  }, [shards, replicas, refresh, language]);

  const plan = useMemo((): BodyPlan => {
    const problem = indexNameProblem(index) ?? nameProblem;
    if (problem !== null) {
      return { error: problem };
    }
    let settings: Record<string, Json>;
    if (advanced) {
      const parsed = settingsText.trim() === "" ? { value: {} } : readJsonText(settingsText, t("설정"));
      if ("error" in parsed) {
        return { error: parsed.error, at: parsed.at, editor: "settings" };
      }
      if (!isObject(parsed.value)) {
        return { error: t("설정은 객체({ … })여야 합니다"), editor: "settings" };
      }
      settings = parsed.value;
    } else {
      if ("error" in simple) {
        return simple;
      }
      settings = simple.settings;
    }
    const body: Record<string, Json> = { settings };
    if (mappingsText.trim() !== "") {
      const parsed = readJsonText(mappingsText, t("매핑"));
      if ("error" in parsed) {
        return { error: parsed.error, at: parsed.at, editor: "mappings" };
      }
      if (!isObject(parsed.value)) {
        return { error: t("매핑은 객체({ … })여야 합니다"), editor: "mappings" };
      }
      const keys = Object.keys(parsed.value);
      // `{}` and an empty `properties` leave the mapping to dynamic mapping.
      const empty = keys.length === 0 || (keys.length === 1 && isObject(parsed.value.properties) && Object.keys(parsed.value.properties).length === 0);
      if (!empty) {
        body.mappings = parsed.value;
      }
    }
    return { index, body, command: requestText("PUT", `/${index}`, body) };
  }, [index, nameProblem, advanced, settingsText, simple, mappingsText, language]);

  const toggleAdvanced = (on: boolean) => {
    if (on && "settings" in simple) {
      setSettingsText(stringifyJson({ index: simple.settings }, 2));
    }
    setAdvanced(on);
  };

  const submit = async () => {
    if (busy || "error" in plan || host.readOnly) {
      return;
    }
    if (!(await askFirst(host, "write", { title: t("인덱스 만들기"), message: t("{index} 인덱스를 만듭니다.", { index: plan.index }), command: plan.command, okLabel: t("만들기") }))) {
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await createIndex(host.conn, plan.index, plan.body);
      host.notify(t("{index} 인덱스를 만들었습니다", { index: plan.index }));
      onEffect({ kind: "created", index: plan.index });
      onClose();
    } catch (error) {
      setFailure(error);
      setBusy(false);
    }
  };

  return (
    <AdminModal
      title={t("인덱스 만들기")}
      className="mg-create-modal"
      busy={busy}
      onClose={onClose}
      foot={
        <>
          <span className="spacer" />
          <button type="button" onClick={onClose} disabled={busy}>
            {t("취소")}
          </button>
          <button type="button" className="primary" disabled={busy || "error" in plan || host.readOnly} onClick={() => void submit()}>
            {busy ? <Spinner size={10} /> : null}
            {t("만들기")}
          </button>
        </>
      }
    >
      {host.readOnly ? <ReadOnlyNote /> : null}
      <label className="mg-form-row">
        <span className="mg-form-label">{t("인덱스 이름")}</span>
        <input type="text" className="mg-input mono" placeholder={t("예: shop-orders")} spellCheck={false} autoFocus value={name} onChange={(event) => setName(event.target.value)} {...fieldErrorProps("es-create-name", nameProblem)} />
        <FieldError id="es-create-name" error={nameProblem} />
      </label>
      <div className="mg-checks">
        <label>
          <input type="checkbox" checked={advanced} disabled={busy} onChange={(event) => toggleAdvanced(event.target.checked)} />
          {t("설정을 JSON으로 직접 쓰기")}
        </label>
      </div>
      {advanced ? (
        <>
          <div className="mg-form-label">{t("설정 (settings)")}</div>
          <SearchEditor value={settingsText} onChange={setSettingsText} className="mg-admin-editor" error={"error" in plan && plan.editor === "settings" ? (plan.at ?? null) : null} ariaLabel={t("설정")} />
        </>
      ) : (
        <div className="mg-form-grid es-form-3">
          <label className="mg-form-row">
            <span className="mg-form-label">{t("주 샤드 수")}</span>
            <input type="number" min={1} max={1024} className="mg-input mono" disabled={busy} value={shards} onChange={(event) => setShards(event.target.value)} />
          </label>
          <label className="mg-form-row">
            <span className="mg-form-label">{t("복제본 수")}</span>
            <input type="number" min={0} className="mg-input mono" disabled={busy} value={replicas} onChange={(event) => setReplicas(event.target.value)} />
          </label>
          <label className="mg-form-row">
            <span className="mg-form-label">{t("새로 고침 간격")}</span>
            <input type="text" className="mg-input mono" placeholder="1s" spellCheck={false} disabled={busy} value={refresh} onChange={(event) => setRefresh(event.target.value)} />
          </label>
        </div>
      )}
      <div className="mg-form-label">{t("매핑 (mappings, 비우면 동적 매핑)")}</div>
      <SearchEditor value={mappingsText} onChange={setMappingsText} className="mg-admin-editor" error={"error" in plan && plan.editor === "mappings" ? (plan.at ?? null) : null} ariaLabel={t("매핑")} />
      <RequestPreview text={"error" in plan ? null : plan.command} problem={"error" in plan ? plan.error : null} />
      <DialogFailure error={failure} />
    </AdminModal>
  );
}

// ---- 매핑 복제 ----

// A new index made with another's settings and mappings (and optionally its
// aliases), editable first: the usual step before a reindex.
function CloneMappingDialog({ host, index, onEffect, onClose }: DialogProps & { index: string }) {
  const [name, setName] = useState(`${index}-v2`);
  const [withAliases, setWithAliases] = useState(false);
  const [source, setSource] = useState<{ settings: unknown; mappings: unknown; aliases: unknown } | null>(null);
  const [text, setText] = useState("");
  const [loadError, setLoadError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [seq, setSeq] = useState(0);
  const targets = useTargets(host.conn);
  const language = getLanguage();

  useEffect(() => {
    const controller = new AbortController();
    setLoadError(null);
    definition(host.conn, index, controller.signal).then(
      (def) => setSource(def),
      (error: unknown) => {
        if (!isAbort(error)) {
          setLoadError(error);
        }
      },
    );
    return () => controller.abort();
  }, [host.conn, index, seq]);

  // The body text follows the alias choice until it is edited.
  const edited = useRef(false);
  useEffect(() => {
    if (source !== null && !edited.current) {
      const body: Record<string, unknown> = { settings: source.settings, mappings: source.mappings };
      if (withAliases && isObject(source.aliases) && Object.keys(source.aliases).length > 0) {
        body.aliases = source.aliases;
      }
      setText(stringifyJson(body, 2));
    }
  }, [source, withAliases]);

  const target = name.trim();
  const nameProblem = target === "" ? null : (indexNameProblem(target) ?? (nameTaken(targets.data, target) ? t("같은 이름의 인덱스·별칭·데이터 스트림이 있습니다") : null));
  const plan = useMemo((): BodyPlan => {
    const problem = indexNameProblem(target) ?? nameProblem;
    if (problem !== null) {
      return { error: problem };
    }
    if (source === null) {
      return { error: t("원본 정의를 읽는 중…") };
    }
    const parsed = readJsonText(text, t("본문"));
    if ("error" in parsed) {
      return { error: parsed.error, at: parsed.at, editor: "body" };
    }
    if (!isObject(parsed.value)) {
      return { error: t("본문은 객체({ … })여야 합니다"), editor: "body" };
    }
    return { index: target, body: parsed.value, command: requestText("PUT", `/${target}`, parsed.value) };
  }, [target, nameProblem, source, text, language]);

  const submit = async () => {
    if (busy || "error" in plan || host.readOnly) {
      return;
    }
    if (!(await askFirst(host, "write", { title: t("매핑 복제"), message: t("{source}의 설정과 매핑으로 {index} 인덱스를 만듭니다.", { source: index, index: plan.index }), command: plan.command, okLabel: t("만들기") }))) {
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await createIndex(host.conn, plan.index, plan.body);
      host.notify(t("{index} 인덱스를 만들었습니다", { index: plan.index }));
      onEffect({ kind: "created", index: plan.index });
      onClose();
    } catch (error) {
      setFailure(error);
      setBusy(false);
    }
  };

  return (
    <AdminModal
      title={t("매핑 복제")}
      path={index}
      className="mg-create-modal"
      busy={busy}
      onClose={onClose}
      foot={
        <>
          <span className="spacer" />
          <button type="button" onClick={onClose} disabled={busy}>
            {t("취소")}
          </button>
          <button type="button" className="primary" disabled={busy || "error" in plan || host.readOnly} onClick={() => void submit()}>
            {busy ? <Spinner size={10} /> : null}
            {t("만들기")}
          </button>
        </>
      }
    >
      {host.readOnly ? <ReadOnlyNote /> : null}
      <p className="panel-dim">{t("같은 설정과 매핑으로 빈 인덱스를 만듭니다 — 매핑을 바꿔 다시 색인할 때 먼저 씁니다. 문서는 복사하지 않습니다.")}</p>
      <label className="mg-form-row">
        <span className="mg-form-label">{t("새 인덱스 이름")}</span>
        <input type="text" className="mg-input mono" spellCheck={false} autoFocus value={name} disabled={busy} onChange={(event) => setName(event.target.value)} {...fieldErrorProps("es-clone-name", nameProblem)} />
        <FieldError id="es-clone-name" error={nameProblem} />
      </label>
      <div className="mg-checks">
        <label>
          <input
            type="checkbox"
            checked={withAliases}
            disabled={busy}
            onChange={(event) => {
              edited.current = false;
              setWithAliases(event.target.checked);
            }}
          />
          {t("별칭도 복사 (같은 별칭이 두 인덱스를 가리키게 됩니다)")}
        </label>
      </div>
      {loadError !== null ? (
        <DialogFailure error={loadError} onRetry={() => setSeq((n) => n + 1)} />
      ) : source === null ? (
        <span className="panel-dim">
          <Spinner size={10} /> {t("원본 정의를 읽는 중…")}
        </span>
      ) : (
        <>
          <div className="mg-form-label">{t("본문 (settings · mappings · aliases)")}</div>
          <SearchEditor
            value={text}
            onChange={(next) => {
              edited.current = true;
              setText(next);
            }}
            className="mg-admin-editor es-tall-editor"
            error={"error" in plan && plan.editor === "body" ? (plan.at ?? null) : null}
            ariaLabel={t("본문")}
          />
        </>
      )}
      <RequestPreview text={"error" in plan ? null : plan.command} problem={"error" in plan ? plan.error : null} />
      <DialogFailure error={failure} />
    </AdminModal>
  );
}

// ---- 삭제 ----

type DeleteTarget = { kind: "index"; row: IndexRow; stream: DataStreamRow | null } | { kind: "data_stream"; stream: DataStreamRow } | { kind: "alias"; rows: AliasRow[] } | { kind: "missing" };

function deleteTarget(targets: Targets, name: string): DeleteTarget {
  const row = targets.indices.find((r) => r.name === name);
  if (row !== undefined) {
    return { kind: "index", row, stream: targets.streams.find((s) => s.name === row.data_stream || s.indices.includes(name)) ?? null };
  }
  const stream = targets.streams.find((s) => s.name === name);
  if (stream !== undefined) {
    return { kind: "data_stream", stream };
  }
  const rows = targets.aliases.filter((r) => r.alias === name);
  return rows.length > 0 ? { kind: "alias", rows } : { kind: "missing" };
}

function DeleteDialog({ host, index, onEffect, onClose }: DialogProps & { index: string }) {
  const targets = useTargets(host.conn);
  const [wholeStream, setWholeStream] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const target = targets.data === null ? null : deleteTarget(targets.data, index);
  // A data stream's write index (its newest) goes only with the stream.
  const isWriteIndex = target?.kind === "index" && target.stream !== null && target.stream.indices.at(-1) === index;
  const stream = target?.kind === "data_stream" ? target.stream : target?.kind === "index" && target.stream !== null && (wholeStream || isWriteIndex) ? target.stream : null;
  const victim = stream !== null ? stream.name : index;
  const actions: Json[] = target?.kind === "alias" ? target.rows.map((r) => ({ remove: { index: r.index, alias: index } })) : [];
  const command = target === null || target.kind === "missing" ? null : stream !== null ? requestText("DELETE", `/_data_stream/${stream.name}`) : target.kind === "alias" ? requestText("POST", "/_aliases", { actions }) : requestText("DELETE", `/${index}`);
  const typeToConfirm = host.safeMode >= 1;
  const ready = command !== null && !host.readOnly && (!typeToConfirm || typed === victim);

  const submit = async () => {
    if (busy || !ready || target === null) {
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      if (stream !== null) {
        const reply = await consoleRequest(host.conn, { method: "DELETE", path: `/_data_stream/${encodeURIComponent(stream.name)}`, confirmed: true });
        if (reply.status >= 400) {
          const err = rec(rec(reply.body).error);
          const type = str(err.type);
          throw new SearchError(type !== "" ? `es_${type}` : `es_http_${reply.status}`, str(err.reason) || (typeof reply.body === "string" ? reply.body : `HTTP ${reply.status}`), { server_code: reply.status, code_name: type || undefined, raw: stringifyJson(reply.body) });
        }
      } else if (target.kind === "alias") {
        await updateAliases(host.conn, actions);
      } else {
        await indexAction(host.conn, "delete", index);
      }
      host.notify(stream !== null ? t("데이터 스트림 {name}을 지웠습니다", { name: stream.name }) : target.kind === "alias" ? t("별칭 {name}을 지웠습니다", { name: index }) : t("{index} 인덱스를 지웠습니다", { index }));
      onEffect({ kind: "deleted", index: victim });
      if (victim !== index) {
        onEffect({ kind: "deleted", index });
      }
      onClose();
    } catch (error) {
      setFailure(error);
      setBusy(false);
    }
  };

  let body: ReactNode = null;
  if (target === null) {
    body = targets.error !== null ? <DialogFailure error={targets.error} onRetry={targets.reload} /> : <Spinner size={12} />;
  } else if (target.kind === "missing") {
    body = <p className="es-admin-note">{t("{name}이라는 인덱스·데이터 스트림·별칭이 없습니다 — 이미 지워졌을 수 있습니다.", { name: index })}</p>;
  } else if (target.kind === "alias") {
    body = (
      <>
        <p className="review-lead">{t("{name}은 별칭입니다. 별칭만 지우고 인덱스와 문서는 그대로 둡니다.", { name: index })}</p>
        <p className="panel-dim mono">{target.rows.map((r) => r.index).join(", ")}</p>
      </>
    );
  } else if (target.kind === "data_stream") {
    body = <p className="review-lead">{t("데이터 스트림 {name}과 백킹 인덱스 {count}개를 모두 지웁니다. 되돌릴 수 없습니다.", { name: target.stream.name, count: target.stream.indices.length })}</p>;
  } else {
    const row = target.row;
    body = (
      <>
        <p className="review-lead">{t("{index} 인덱스와 문서 {docs}개({size})를 지웁니다. 되돌릴 수 없습니다.", { index, docs: countText(row.docs), size: formatBytes(row.size) ?? "—" })}</p>
        {row.aliases.length > 0 ? <p className="es-admin-note">{t("이 인덱스를 가리키는 별칭도 사라집니다: {aliases}", { aliases: row.aliases.join(", ") })}</p> : null}
        {target.stream !== null ? (
          <>
            <p className="es-admin-note">
              {isWriteIndex
                ? t("데이터 스트림 {stream}의 쓰기 인덱스입니다. 쓰기 인덱스는 따로 지울 수 없어 스트림을 통째로 지웁니다 (백킹 인덱스 {count}개).", { stream: target.stream.name, count: target.stream.indices.length })
                : t("데이터 스트림 {stream}의 백킹 인덱스입니다. 이 인덱스만 지우면 그 기간의 문서가 스트림에서 빠집니다.", { stream: target.stream.name })}
            </p>
            {isWriteIndex ? null : (
              <div className="mg-checks mg-col" role="radiogroup" aria-label={t("지울 대상")}>
                <label>
                  <input type="radio" name="es-delete-scope" checked={!wholeStream} disabled={busy} onChange={() => setWholeStream(false)} />
                  {t("이 백킹 인덱스만")}
                </label>
                <label>
                  <input type="radio" name="es-delete-scope" checked={wholeStream} disabled={busy} onChange={() => setWholeStream(true)} />
                  {t("데이터 스트림 {stream} 전체 (백킹 인덱스 {count}개)", { stream: target.stream.name, count: target.stream.indices.length })}
                </label>
              </div>
            )}
          </>
        ) : null}
      </>
    );
  }

  const title = stream !== null ? t("데이터 스트림 삭제") : target?.kind === "alias" ? t("별칭 삭제") : t("인덱스 삭제");
  return (
    <AdminModal
      title={title}
      path={index}
      busy={busy}
      danger
      onClose={onClose}
      foot={
        <>
          <span className="spacer" />
          <button type="button" onClick={onClose} disabled={busy}>
            {t("취소")}
          </button>
          <button type="button" className="primary danger" disabled={busy || !ready} onClick={() => void submit()}>
            {busy ? <Spinner size={10} /> : null}
            {t("삭제")}
          </button>
        </>
      }
    >
      {host.readOnly ? <ReadOnlyNote /> : null}
      {body}
      {command !== null ? (
        <pre className="review-pre mono es-confirm-pre">
          <ConsoleText text={command} />
        </pre>
      ) : null}
      {command !== null && typeToConfirm ? (
        <label className="confirm-dialog-field">
          <span>{t("확인하려면 이름을 그대로 입력하세요: {name}", { name: victim })}</span>
          <input
            type="text"
            className="mono"
            spellCheck={false}
            autoComplete="off"
            autoFocus
            disabled={busy}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && ready) {
                event.preventDefault();
                void submit();
              }
            }}
          />
        </label>
      ) : null}
      <DialogFailure error={failure} />
    </AdminModal>
  );
}

// ---- 열기 · 닫기 · 새로 고침 ----

// Closing stops searches and writes on the index: always asked, in a danger
// dialog.
function CloseIndexDialog({ host, index, onEffect, onClose }: DialogProps & { index: string }) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const command = requestText("POST", `/${index}/_close`);
  const submit = async () => {
    if (busy || host.readOnly) {
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await indexAction(host.conn, "close", index);
      host.notify(t("{index} 인덱스를 닫았습니다", { index }));
      onEffect({ kind: "changed" });
      onClose();
    } catch (error) {
      setFailure(error);
      setBusy(false);
    }
  };
  return (
    <AdminModal
      title={t("인덱스 닫기")}
      path={index}
      busy={busy}
      danger
      onClose={onClose}
      foot={
        <>
          <span className="spacer" />
          <button type="button" onClick={onClose} disabled={busy} autoFocus>
            {t("취소")}
          </button>
          <button type="button" className="primary danger" disabled={busy || host.readOnly} onClick={() => void submit()}>
            {busy ? <Spinner size={10} /> : null}
            {t("닫기 [인덱스]")}
          </button>
        </>
      }
    >
      {host.readOnly ? <ReadOnlyNote /> : null}
      <p className="review-lead">{t("닫힌 인덱스는 검색도 색인도 되지 않고 문서 수와 크기도 보이지 않습니다. 다시 열 때까지 이 인덱스를 쓰는 요청은 실패합니다.")}</p>
      <pre className="review-pre mono es-confirm-pre">
        <ConsoleText text={command} />
      </pre>
      <DialogFailure error={failure} />
    </AdminModal>
  );
}

// 열기 and 새로 고침 run at once (asked first only at safe mode 2); a
// failure goes to an error toast with 다시 시도.
function DirectActionDialog({ host, index, action, onEffect, onClose }: DialogProps & { index: string; action: "open" | "refresh" }) {
  const started = useRef(false);
  const latest = useRef({ host, onEffect, onClose });
  latest.current = { host, onEffect, onClose };
  useEffect(() => {
    // Once per dialog, also under StrictMode's second mount.
    if (started.current) {
      return;
    }
    started.current = true;
    const { host: h } = latest.current;
    // Sends the request; a failure's toast offers to send it again.
    const attempt = async () => {
      try {
        await indexAction(h.conn, action, index);
        h.notify(action === "open" ? t("{index} 인덱스를 열었습니다", { index }) : t("{index} 인덱스를 새로 고쳤습니다", { index }));
        latest.current.onEffect({ kind: "changed" });
      } catch (error) {
        notifyError(error, { context: "structure", retry: () => void attempt() });
      }
    };
    const run = async () => {
      if (h.readOnly) {
        notifyError(new SearchError("read_only", t("읽기 전용 연결입니다 — 쓰기 요청은 보내지 않습니다")), { context: "structure" });
      } else if (
        await askFirst(h, "write", {
          title: action === "open" ? t("인덱스 열기") : t("인덱스 새로 고침"),
          message: action === "open" ? t("{index} 인덱스를 엽니다.", { index }) : t("{index} 인덱스를 새로 고쳐 최근 쓰기가 검색에 보이게 합니다.", { index }),
          command: requestText("POST", `/${index}/${action === "open" ? "_open" : "_refresh"}`),
          okLabel: action === "open" ? t("열기") : t("새로 고침"),
        })
      ) {
        await attempt();
      }
      latest.current.onClose();
    };
    void run();
  }, [index, action]);
  return null;
}

// ---- 재색인 ----

// A reindex this many documents or more is better run as a task.
const LARGE_REINDEX = 1_000_000;

function ReindexDialog({ host, index, onEffect, onClose }: DialogProps & { index: string }) {
  const [source, setSource] = useState(index);
  const [dest, setDest] = useState("");
  const [queryText, setQueryText] = useState("");
  const [opCreate, setOpCreate] = useState(false);
  const [proceed, setProceed] = useState(false);
  const [maxDocs, setMaxDocs] = useState("");
  const [wait, setWait] = useState(true);
  const [docs, setDocs] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const targets = useTargets(host.conn);
  const names = useMemo(() => targetNames(targets.data), [targets.data]);
  const src = source.trim();
  const dst = dest.trim();
  const { fields } = useIndexFields(host.conn, src);
  const fieldsRef = useRef<MappedField[]>([]);
  fieldsRef.current = fields ?? [];
  const language = getLanguage();
  const destStream = targets.data?.streams.some((s) => s.name === dst) ?? false;
  const destExists = nameTaken(targets.data, dst);

  // How many documents the source holds (whole, not the query's share).
  useEffect(() => {
    setDocs(null);
    if (src === "") {
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      count(host.conn, src, undefined, controller.signal).then(setDocs, () => setDocs(null));
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [host.conn, src]);

  const plan = useMemo((): { body: Record<string, Json>; command: string } | { error: string; at?: { from: number; to: number } | null; editor?: "query" } => {
    if (src === "") {
      return { error: t("원본 인덱스를 쓰세요") };
    }
    if (dst === "") {
      return { error: t("대상 인덱스를 쓰세요") };
    }
    if (dst === src) {
      return { error: t("원본과 대상이 같습니다") };
    }
    if (!destExists) {
      const problem = indexNameProblem(dst);
      if (problem !== null) {
        return { error: problem };
      }
    }
    const sourcePart: Record<string, Json> = { index: src };
    if (queryText.trim() !== "") {
      const parsed = readJsonText(queryText, t("쿼리"));
      if ("error" in parsed) {
        return { error: parsed.error, at: parsed.at, editor: "query" };
      }
      if (!isObject(parsed.value)) {
        return { error: t("쿼리는 객체({ … })여야 합니다"), editor: "query" };
      }
      sourcePart.query = parsed.value;
    }
    const destPart: Record<string, Json> = { index: dst };
    if (opCreate || destStream) {
      destPart.op_type = "create";
    }
    const body: Record<string, Json> = {};
    if (proceed) {
      body.conflicts = "proceed";
    }
    if (maxDocs.trim() !== "") {
      if (!/^\d+$/.test(maxDocs.trim()) || Number(maxDocs) < 1) {
        return { error: t("최대 문서 수: 1 이상의 정수를 쓰세요") };
      }
      body.max_docs = Number(maxDocs);
    }
    body.source = sourcePart;
    body.dest = destPart;
    return { body, command: requestText("POST", wait ? "/_reindex" : "/_reindex?wait_for_completion=false", body) };
  }, [src, dst, destExists, destStream, queryText, opCreate, proceed, maxDocs, wait, language]);

  const submit = async () => {
    if (busy || "error" in plan || host.readOnly) {
      return;
    }
    if (!(await askFirst(host, "danger", { title: t("재색인"), message: t("{source}의 문서를 {dest}에 씁니다. 대상에 같은 _id가 있으면 덮어씁니다.", { source: src, dest: dst }), command: plan.command, okLabel: t("재색인") }))) {
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const reply = await reindex(host.conn, plan.body, wait);
      setResult(reply);
      host.notify(wait ? t("재색인을 마쳤습니다 — {dest}", { dest: dst }) : t("재색인 작업을 시작했습니다"));
      onEffect({ kind: "changed" });
    } catch (error) {
      setFailure(error);
    }
    setBusy(false);
  };

  const finished = result !== null;
  const failures = list(result?.failures);
  const task = result !== null && result.task !== undefined ? str(result.task) : null;
  return (
    <AdminModal
      title={t("재색인")}
      path={index}
      className="mg-create-modal"
      busy={busy}
      onClose={onClose}
      foot={
        <>
          {busy && wait ? <span className="panel-dim">{t("끝날 때까지 기다립니다…")}</span> : null}
          <span className="spacer" />
          <button type="button" onClick={onClose} disabled={busy}>
            {finished ? t("닫기") : t("취소")}
          </button>
          {finished ? null : (
            <button type="button" className="primary" disabled={busy || "error" in plan || host.readOnly} onClick={() => void submit()}>
              {busy ? <Spinner size={10} /> : null}
              {t("재색인")}
            </button>
          )}
        </>
      }
    >
      {host.readOnly ? <ReadOnlyNote /> : null}
      <div className="mg-form-grid">
        <label className="mg-form-row">
          <span className="mg-form-label">{t("원본")}</span>
          <SuggestInput type="text" className="mg-input mono" suggestions={names} spellCheck={false} disabled={busy || finished} value={source} onChange={(event) => setSource(event.target.value)} />
        </label>
        <label className="mg-form-row">
          <span className="mg-form-label">{dst === "" ? t("대상") : destExists ? t("대상 (있는 인덱스에 씁니다)") : t("대상 (없으면 동적 매핑으로 만들어집니다)")}</span>
          <SuggestInput type="text" className="mg-input mono" suggestions={names.filter((n) => n !== src)} spellCheck={false} autoFocus disabled={busy || finished} value={dest} onChange={(event) => setDest(event.target.value)} />
        </label>
      </div>
      {dst !== "" && !destExists ? <p className="es-admin-note">{t("대상 인덱스가 없어 첫 문서가 들어갈 때 동적 매핑으로 만들어집니다. 매핑을 정하려면 먼저 ‘매핑 복제’로 만드세요.")}</p> : null}
      <div className="mg-form-label">{t("쿼리 (비우면 전체)")}</div>
      <SearchEditor
        value={queryText}
        onChange={setQueryText}
        complete={(text, pos) => completeQuery(text, pos, fieldsRef.current)}
        placeholder='{ "range": { "@timestamp": { "gte": "now-7d" } } }'
        readOnly={busy || finished}
        className="mg-admin-editor es-short-editor"
        error={"error" in plan && plan.editor === "query" ? (plan.at ?? null) : null}
        ariaLabel={t("쿼리")}
      />
      <div className="mg-checks">
        <label title={t("대상에 같은 _id가 있으면 덮어쓰지 않고 충돌로 셉니다")}>
          <input type="checkbox" checked={opCreate || destStream} disabled={busy || finished || destStream} onChange={(event) => setOpCreate(event.target.checked)} />
          {t("없는 문서만 (op_type: create)")}
        </label>
        <label title={t("버전 충돌이 나도 멈추지 않고 셉니다")}>
          <input type="checkbox" checked={proceed} disabled={busy || finished} onChange={(event) => setProceed(event.target.checked)} />
          {t("충돌은 건너뛰기 (conflicts: proceed)")}
        </label>
        <label>
          {t("최대 문서 수")}
          <input type="number" min={1} className="mg-input mono es-narrow" placeholder={t("전체")} disabled={busy || finished} value={maxDocs} onChange={(event) => setMaxDocs(event.target.value)} />
        </label>
      </div>
      <div className="mg-checks mg-col" role="radiogroup" aria-label={t("실행 방식")}>
        <label>
          <input type="radio" name="es-reindex-wait" checked={wait} disabled={busy || finished} onChange={() => setWait(true)} />
          {t("끝날 때까지 기다리고 결과 보기")}
        </label>
        <label>
          <input type="radio" name="es-reindex-wait" checked={!wait} disabled={busy || finished} onChange={() => setWait(false)} />
          {t("백그라운드 작업으로 (작업 ID를 받고 클러스터 탭의 작업 목록에서 지켜봅니다)")}
        </label>
      </div>
      {docs !== null ? (
        <span className={docs >= LARGE_REINDEX && wait ? "es-admin-note" : "panel-dim"}>
          {docs >= LARGE_REINDEX && wait ? t("원본에 문서가 {count}개 있습니다 — 오래 걸리니 백그라운드 작업을 권합니다.", { count: docs.toLocaleString() }) : t("원본 문서 {count}개", { count: docs.toLocaleString() })}
        </span>
      ) : null}
      {finished ? null : <RequestPreview text={"error" in plan ? null : plan.command} problem={"error" in plan ? plan.error : null} />}
      <DialogFailure error={failure} />
      {task !== null ? (
        <div className="es-task">
          <span className="mg-form-label">{t("작업 ID")}</span>
          <code className="mono">{task}</code>
          <button type="button" className="mg-qbtn" onClick={() => void writeClipboard(task, host.notify).then(() => host.notify(t("작업 ID를 복사했습니다")))}>
            {t("복사")}
          </button>
        </div>
      ) : null}
      {result !== null && task === null ? (
        <>
          <div className="mg-stats-grid">
            <Cell label={t("전체")} value={countText(num(result.total))} />
            <Cell label={t("만듦")} value={countText(num(result.created))} />
            <Cell label={t("바꿈")} value={countText(num(result.updated))} />
            <Cell label={t("버전 충돌")} value={countText(num(result.version_conflicts))} />
            <Cell label={t("변경 없음")} value={countText(num(result.noops))} />
            <Cell label={t("실패")} value={failures.length.toLocaleString()} />
            <Cell label={t("걸린 시간")} value={num(result.took) !== null ? `${(num(result.took) ?? 0).toLocaleString()} ms` : "—"} />
          </div>
          {failures.length > 0 ? (
            <div className="mg-import-preview mono mg-import-failures">
              {failures.slice(0, 100).map((raw, i) => {
                const f = rec(raw);
                const cause = rec(f.cause);
                return (
                  <div key={i} className="mg-import-line bad">
                    <span className="mg-import-ln">{str(f.id) || "—"}</span>
                    <span className="mg-import-text">
                      {str(cause.type)}: {str(cause.reason) || stringifyJson(raw)}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : null}
        </>
      ) : null}
    </AdminModal>
  );
}

// ---- 별칭 ----

function AliasDialog({ host, index, onEffect, onClose }: DialogProps & { index: string }) {
  const [name, setName] = useState("");
  const [filterText, setFilterText] = useState("");
  const [routing, setRouting] = useState("");
  const [writeIndex, setWriteIndex] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const targets = useTargets(host.conn);
  const { fields } = useIndexFields(host.conn, index);
  const fieldsRef = useRef<MappedField[]>([]);
  fieldsRef.current = fields ?? [];
  const language = getLanguage();
  const alias = name.trim();
  const current = targets.data?.aliases.filter((r) => r.index === index) ?? [];
  const aliasNames = useMemo(() => [...new Set((targets.data?.aliases ?? []).map((r) => r.alias))].sort(), [targets.data]);

  const plan = useMemo((): { actions: Json[]; command: string } | { error: string; at?: { from: number; to: number } | null; editor?: "filter" } => {
    if (alias === "") {
      return { error: t("별칭 이름을 쓰세요") };
    }
    const problem = indexNameProblem(alias);
    if (problem !== null) {
      return { error: problem };
    }
    if (targets.data?.indices.some((r) => r.name === alias)) {
      return { error: t("같은 이름의 인덱스가 있어 별칭으로 쓸 수 없습니다") };
    }
    const add: Record<string, Json> = { index, alias };
    if (filterText.trim() !== "") {
      const parsed = readJsonText(filterText, t("필터"));
      if ("error" in parsed) {
        return { error: parsed.error, at: parsed.at, editor: "filter" };
      }
      if (!isObject(parsed.value)) {
        return { error: t("필터는 쿼리 객체({ … })여야 합니다"), editor: "filter" };
      }
      add.filter = parsed.value;
    }
    if (routing.trim() !== "") {
      add.routing = routing.trim();
    }
    if (writeIndex) {
      add.is_write_index = true;
    }
    const actions: Json[] = [{ add }];
    return { actions, command: requestText("POST", "/_aliases", { actions }) };
  }, [alias, index, filterText, routing, writeIndex, targets.data, language]);

  const submit = async () => {
    if (busy || "error" in plan || host.readOnly) {
      return;
    }
    if (!(await askFirst(host, "write", { title: t("별칭 추가"), message: t("{index}에 별칭 {alias}를 붙입니다.", { index, alias }), command: plan.command, okLabel: t("추가") }))) {
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await updateAliases(host.conn, plan.actions);
      host.notify(t("별칭 {alias}를 붙였습니다", { alias }));
      onEffect({ kind: "changed" });
      onClose();
    } catch (error) {
      setFailure(error);
      setBusy(false);
    }
  };

  const remove = async (row: AliasRow) => {
    if (busy || host.readOnly) {
      return;
    }
    const actions: Json[] = [{ remove: { index: row.index, alias: row.alias } }];
    const command = requestText("POST", "/_aliases", { actions });
    if (!(await askFirst(host, "write", { title: t("별칭 떼기"), message: t("{index}에서 별칭 {alias}를 뗍니다. 인덱스와 문서는 그대로입니다.", { index: row.index, alias: row.alias }), command, okLabel: t("떼기") }))) {
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await updateAliases(host.conn, actions);
      host.notify(t("별칭 {alias}를 뗐습니다", { alias: row.alias }));
      onEffect({ kind: "changed" });
      targets.reload();
    } catch (error) {
      setFailure(error);
    }
    setBusy(false);
  };

  return (
    <AdminModal
      title={t("별칭")}
      path={index}
      className="mg-create-modal"
      busy={busy}
      onClose={onClose}
      foot={
        <>
          <span className="spacer" />
          <button type="button" onClick={onClose} disabled={busy}>
            {t("닫기")}
          </button>
          <button type="button" className="primary" disabled={busy || "error" in plan || host.readOnly} onClick={() => void submit()}>
            {busy ? <Spinner size={10} /> : null}
            {t("별칭 추가")}
          </button>
        </>
      }
    >
      {host.readOnly ? <ReadOnlyNote /> : null}
      {current.length > 0 ? (
        <>
          <div className="mg-form-label">{t("붙어 있는 별칭")}</div>
          <table className="panel-table mg-stats-table">
            <thead>
              <tr>
                <th>{t("별칭")}</th>
                <th>{t("필터")}</th>
                <th>{t("라우팅")}</th>
                <th>{t("쓰기 인덱스")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {current.map((row) => (
                <tr key={row.alias}>
                  <td className="mono">{row.alias}</td>
                  <td className="mono es-cell-clip" title={row.filter !== null ? stringifyJson(row.filter) : undefined}>
                    {row.filter !== null ? stringifyJson(row.filter) : "—"}
                  </td>
                  <td className="mono">{row.index_routing ?? row.search_routing ?? "—"}</td>
                  <td>{row.is_write_index === true ? t("예") : "—"}</td>
                  <td>
                    {host.readOnly ? null : (
                      <button type="button" className="mg-qbtn" disabled={busy} onClick={() => void remove(row)}>
                        {t("떼기")}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
      <div className="mg-form-grid">
        <label className="mg-form-row">
          <span className="mg-form-label">{t("별칭 이름")}</span>
          <SuggestInput type="text" className="mg-input mono" suggestions={aliasNames} spellCheck={false} autoFocus disabled={busy} value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="mg-form-row">
          <span className="mg-form-label">{t("라우팅 (선택)")}</span>
          <input type="text" className="mg-input mono" spellCheck={false} disabled={busy} value={routing} onChange={(event) => setRouting(event.target.value)} />
        </label>
      </div>
      <div className="mg-form-label">{t("필터 (선택, 이 별칭으로 검색하면 늘 붙는 쿼리)")}</div>
      <SearchEditor
        value={filterText}
        onChange={setFilterText}
        complete={(text, pos) => completeQuery(text, pos, fieldsRef.current)}
        placeholder='{ "term": { "status": "active" } }'
        readOnly={busy}
        className="mg-admin-editor es-short-editor"
        error={"error" in plan && plan.editor === "filter" ? (plan.at ?? null) : null}
        ariaLabel={t("필터")}
      />
      <div className="mg-checks">
        <label title={t("별칭으로 쓰는 문서가 이 인덱스로 갑니다 (별칭이 여러 인덱스를 가리킬 때)")}>
          <input type="checkbox" checked={writeIndex} disabled={busy} onChange={(event) => setWriteIndex(event.target.checked)} />
          {t("쓰기 인덱스로 (is_write_index)")}
        </label>
      </div>
      <RequestPreview text={"error" in plan ? null : plan.command} problem={"error" in plan ? plan.error : null} />
      <DialogFailure error={failure} />
    </AdminModal>
  );
}

// ---- 통계 ----

interface StatsData {
  rows: IndexRow[];
  shards: Record<string, unknown>[];
  // `index` settings of each index, by name.
  settings: Record<string, Record<string, unknown>>;
  fieldCount: number | null;
}

function StatsDialog({ host, index, onClose }: { host: SearchHost; index: string; onClose(): void }) {
  const [data, setData] = useState<StatsData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [seq, setSeq] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const signal = controller.signal;
    setError(null);
    (async () => {
      const [all, shardRows, settingsReply, def] = await Promise.all([
        listIndices(host.conn, true, signal),
        listShards(host.conn, index, signal),
        getSettings(host.conn, index, false, signal).catch((err: unknown) => {
          if (isAbort(err)) {
            throw err;
          }
          return {};
        }),
        definition(host.conn, index, signal).catch((err: unknown) => {
          if (isAbort(err)) {
            throw err;
          }
          return null;
        }),
      ]);
      const exact = all.filter((r) => r.name === index);
      const rows = exact.length > 0 ? exact : all.filter((r) => r.aliases.includes(index) || r.data_stream === index);
      const settings: Record<string, Record<string, unknown>> = {};
      for (const [name, value] of Object.entries(settingsReply)) {
        settings[name] = rec(rec(rec(value).settings).index);
      }
      const fieldCount = def === null ? null : mappingFields(def.mappings).filter((f) => !f.multi).length;
      return { rows, shards: shardRows, settings, fieldCount };
    })().then(setData, (err: unknown) => {
      if (!isAbort(err)) {
        setError(err);
      }
    });
    return () => controller.abort();
  }, [host.conn, index, seq]);

  const sum = (pick: (r: IndexRow) => number | null): number | null => (data === null || data.rows.some((r) => pick(r) === null) ? null : data.rows.reduce((total, r) => total + (pick(r) ?? 0), 0));
  const single = data !== null && data.rows.length === 1 ? data.rows[0] : null;
  const settings = single !== null ? (data?.settings[single.name] ?? {}) : {};
  const created = num(settings.creation_date);
  const version = str(rec(settings.version).created);

  const copy = () => {
    if (data === null) {
      return;
    }
    const json = { index, indices: data.rows, settings: data.settings, fields: data.fieldCount, shards: data.shards };
    void writeClipboard(stringifyJson(json, 2), host.notify).then(() => host.notify(t("통계를 JSON으로 복사했습니다")));
  };

  return (
    <AdminModal
      title={t("인덱스 통계")}
      path={index}
      className="mg-create-modal es-stats-modal"
      busy={false}
      onClose={onClose}
      foot={
        <>
          <button type="button" className="mg-qbtn" disabled={data === null} onClick={() => setSeq((n) => n + 1)}>
            {t("새로 고침")}
          </button>
          <span className="spacer" />
          <button type="button" disabled={data === null} onClick={copy}>
            {t("JSON으로 복사")}
          </button>
          <button type="button" className="primary" onClick={onClose}>
            {t("닫기")}
          </button>
        </>
      }
    >
      {error !== null ? <DialogFailure error={error} onRetry={() => setSeq((n) => n + 1)} /> : null}
      {data === null && error === null ? <Spinner size={12} /> : null}
      {data !== null && data.rows.length === 0 ? <p className="es-admin-note">{t("{name}에 해당하는 인덱스가 없습니다.", { name: index })}</p> : null}
      {data !== null && data.rows.length > 0 ? (
        <div className="mg-stats-grid">
          {single !== null ? (
            <>
              <Cell label={t("상태")} value={single.status || "—"} />
              <Cell label={t("건강")} value={single.health || "—"} />
            </>
          ) : (
            <Cell label={t("인덱스")} value={data.rows.length.toLocaleString()} />
          )}
          <Cell label={t("문서")} value={countText(sum((r) => r.docs))} />
          <Cell label={t("삭제된 문서")} value={countText(sum((r) => r.deleted))} />
          <Cell label={t("크기")} value={formatBytes(sum((r) => r.size)) ?? "—"} />
          <Cell label={t("주 샤드 크기")} value={formatBytes(sum((r) => r.pri_size)) ?? "—"} />
          <Cell label={t("주 샤드")} value={countText(sum((r) => r.primaries))} />
          {single !== null ? <Cell label={t("복제본")} value={countText(single.replicas)} /> : null}
          <Cell label={t("샤드 (전체)")} value={data.shards.length.toLocaleString()} />
          {data.fieldCount !== null ? <Cell label={t("매핑 필드")} value={data.fieldCount.toLocaleString()} /> : null}
          {single !== null ? (
            <>
              <Cell label={t("별칭")} value={single.aliases.length > 0 ? single.aliases.join(", ") : "—"} />
              <Cell label={t("데이터 스트림")} value={single.data_stream ?? "—"} />
              <Cell label={t("새로 고침 간격")} value={str(settings.refresh_interval) || t("기본 (1s)")} />
              <Cell label={t("만든 때")} value={created !== null ? new Date(created).toLocaleString() : "—"} />
              <Cell label={t("만든 버전")} value={version || "—"} />
              <Cell label="UUID" value={single.uuid || "—"} />
            </>
          ) : null}
        </div>
      ) : null}
      {data !== null && data.rows.length > 1 ? (
        <table className="panel-table mg-stats-table">
          <thead>
            <tr>
              <th>{t("인덱스")}</th>
              <th>{t("건강")}</th>
              <th>{t("상태")}</th>
              <th className="num">{t("문서")}</th>
              <th className="num">{t("크기")}</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.name}>
                <td className="mono">{r.name}</td>
                <td>{r.health}</td>
                <td>{r.status}</td>
                <td className="num mono">{countText(r.docs)}</td>
                <td className="num mono">{formatBytes(r.size) ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {data !== null && data.shards.length > 0 ? (
        <>
          <div className="mg-form-label">{t("샤드")}</div>
          <div className="es-stats-shards">
            <table className="panel-table mg-stats-table">
              <thead>
                <tr>
                  {data.rows.length > 1 ? <th>{t("인덱스")}</th> : null}
                  <th className="num">{t("샤드")}</th>
                  <th>{t("종류")}</th>
                  <th>{t("상태")}</th>
                  <th className="num">{t("문서")}</th>
                  <th className="num">{t("크기")}</th>
                  <th>{t("노드")}</th>
                </tr>
              </thead>
              <tbody>
                {data.shards.map((s, i) => (
                  <tr key={i}>
                    {data.rows.length > 1 ? <td className="mono">{str(s.index)}</td> : null}
                    <td className="num mono">{str(s.shard)}</td>
                    <td>{str(s.prirep) === "p" ? t("주") : t("복제")}</td>
                    <td className={str(s.state) === "UNASSIGNED" ? "mg-danger-text" : undefined} title={str(s["unassigned.reason"]) || undefined}>
                      {str(s.state)}
                    </td>
                    <td className="num mono">{countText(num(s.docs))}</td>
                    <td className="num mono">{formatBytes(num(s.store)) ?? "—"}</td>
                    <td className="mono">{str(s.node) || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </AdminModal>
  );
}

export { AliasDialog, CloneMappingDialog, CloseIndexDialog, CreateIndexDialog, DeleteDialog, DirectActionDialog, ReindexDialog, StatsDialog };

