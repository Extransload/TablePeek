// The 문서 tab's dialogs: a document as JSON (add, clone, edit) and the
// by-query writes (일괄 수정 / 일괄 삭제) with how many documents they reach.

import { useEffect, useMemo, useRef, useState } from "react";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { CheckIcon } from "../../../components/icons";
import { Spinner } from "../../../components/Spinner";
import { t } from "../../../i18n";
import { JsonSyntaxError, isDocument, jsonKeys, jsonObject, parseJson } from "../../mongodb/bson";
import { useEscape } from "../../mongodb/ui/DocModals";
import { count, deleteByQuery, isAbort, search, updateByQuery, type Hit } from "../api";
import { ELEMENT, jsonCaret, type DslCompletion, type MappedField } from "../dsl";
import { fromJson, jsonText, num, rec, str, type Json } from "../json";
import { needsConfirm, requestText, type SearchHost } from "./common";
import { SearchEditor } from "./SearchEditor";

// Keys of a document being typed: the mapping's fields under the object the
// caret is in.
export function completeDocKeys(fields: MappedField[]) {
  return (text: string, pos: number): DslCompletion | null => {
    const at = jsonCaret(text, pos);
    if (at === null || at.at !== "key" || at.path.includes(ELEMENT)) {
      return null;
    }
    const parent = at.path.join(".");
    const items = fields
      .filter((f) => !f.multi && (parent === "" ? !f.path.includes(".") : f.path.startsWith(`${parent}.`) && !f.path.slice(parent.length + 1).includes(".")))
      .filter((f) => !at.siblings.includes(f.path.slice(parent === "" ? 0 : parent.length + 1)))
      .map((f) => {
        const name = parent === "" ? f.path : f.path.slice(parent.length + 1);
        const template = f.type === "object" || f.type === "nested" ? "{ }" : ["text", "keyword", "date", "ip", "match_only_text", "wildcard", "constant_keyword"].includes(f.type) ? '""' : "";
        const head = at.quoted ? `${name}": ` : `"${name}": `;
        return { label: name, kind: "field" as const, detail: f.type, insert: head + template, caretBack: template === "" ? 0 : 1 };
      })
      .filter((item) => item.label.toLowerCase().startsWith(at.prefix.toLowerCase()));
    return items.length === 0 ? null : { from: at.from, to: pos, quoted: at.quoted, items };
  };
}

export interface DocEditorRequest {
  mode: "insert" | "clone" | "replace";
  index: string;
  // Replace: the hit being edited.
  hit?: Hit;
  initial: string;
}

// A document typed as JSON. `_id` in the text (insert and clone) names the
// new document; without it the server makes one. Resolves the failure to
// show, or null once saved.
export function DocEditorModal({ request, fields, onSubmit, onClose }: { request: DocEditorRequest; fields: MappedField[]; onSubmit(id: string | null, source: Json): Promise<Error | null>; onClose(): void }) {
  const [text, setText] = useState(request.initial);
  const [parseError, setParseError] = useState<{ message: string; from: number; to: number } | null>(null);
  const [failure, setFailure] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  useEscape(() => {
    if (!busy) {
      onClose();
    }
  });
  const complete = useMemo(() => completeDocKeys(fields), [fields]);

  const submit = async () => {
    let value: unknown;
    try {
      value = parseJson(text, { bigints: true });
    } catch (error) {
      const at = error instanceof JsonSyntaxError ? error.offset : 0;
      setParseError({ message: error instanceof Error ? error.message : String(error), from: at, to: at + 1 });
      return;
    }
    const doc = fromJson(value);
    if (!isDocument(doc)) {
      setParseError({ message: t("문서 { … }를 써야 합니다"), from: 0, to: text.length });
      return;
    }
    setParseError(null);
    const rawId = doc.get("_id");
    if (rawId !== undefined && typeof rawId !== "string" && request.mode !== "replace") {
      setParseError({ message: t("_id는 문자열이어야 합니다"), from: 0, to: text.length });
      return;
    }
    const source = rec(value);
    const body = jsonObject(jsonKeys(source).filter((key) => key !== "_id").map((key): [string, Json] => [key, source[key] as Json]));
    setBusy(true);
    const result = await onSubmit(typeof rawId === "string" && rawId !== "" ? rawId : null, body);
    setBusy(false);
    setFailure(result);
  };

  const title = request.mode === "insert" ? t("문서 추가") : request.mode === "clone" ? t("문서 복제") : t("문서 편집");
  const where = request.mode === "replace" && request.hit ? `${request.hit.index} · _id ${request.hit.id}` : request.index;
  return (
    <div className="modal-backdrop">
      <div className="modal es-doc-modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <span className="modal-title">{title}</span>
          <span className="panel-dim mono es-doc-where">{where}</span>
        </div>
        <div className="modal-body es-doc-body">
          <div className="es-doc-editor">
            <SearchEditor value={text} onChange={setText} onRun={() => void submit()} onEscape={onClose} complete={complete} error={parseError} autoFocus ariaLabel={title} />
          </div>
          {parseError !== null ? <ErrorNotice error={new Error(parseError.message)} context="editor" variant="compact" onClose={() => setParseError(null)} /> : null}
          {failure !== null ? <ErrorNotice error={failure} context="document" engine="elasticsearch" variant="compact" onClose={() => setFailure(null)} /> : null}
        </div>
        <div className="modal-foot">
          <span className="panel-dim">{request.mode === "replace" ? t("_id는 바꿀 수 없습니다 · ⌘↩ 저장") : t("_id를 쓰면 그 id로, 비워 두면 서버가 만듭니다 · ⌘↩ 추가")}</span>
          <span className="spacer" />
          <button type="button" onClick={onClose} disabled={busy}>
            {t("취소")}
          </button>
          <button type="button" className="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? <Spinner size={10} /> : <CheckIcon size={10} />}
            {request.mode === "replace" ? t("저장") : t("추가")}
          </button>
        </div>
      </div>
    </div>
  );
}

export type ByQueryMode = "update" | "delete";

const SCRIPT_TEMPLATE = "ctx._source.status = params.status";
const PARAMS_TEMPLATE = '{ "status": "paid" }';

// 일괄 수정 (`_update_by_query` with a painless script) and 일괄 삭제
// (`_delete_by_query`) on the documents the query matches: the count and
// the first few documents first, then the write after confirmation.
export function ByQueryModal({ host, index, mode: initialMode, query, onDone, onClose }: { host: SearchHost; index: string; mode: ByQueryMode; query: Json | null; onDone(): void; onClose(): void }) {
  const [mode, setMode] = useState<ByQueryMode>(initialMode);
  const [script, setScript] = useState(SCRIPT_TEMPLATE);
  const [params, setParams] = useState(PARAMS_TEMPLATE);
  const [proceed, setProceed] = useState(true);
  const [maxDocs, setMaxDocs] = useState("");
  const [matched, setMatched] = useState<number | null>(null);
  const [sample, setSample] = useState<Hit[]>([]);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [runError, setRunError] = useState<unknown>(null);
  const [paramsError, setParamsError] = useState<{ message: string; from: number; to: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const queryRef = useRef(query);
  useEscape(() => {
    if (!busy) {
      onClose();
    }
  });

  useEffect(() => {
    const controller = new AbortController();
    setMatched(null);
    setLoadError(null);
    Promise.all([count(host.conn, index, queryRef.current ?? undefined, controller.signal), search(host.conn, { index, body: queryRef.current === null ? undefined : jsonObject([["query", queryRef.current]]), size: 5 }, controller.signal)]).then(
      ([n, page]) => {
        setMatched(n);
        setSample(page.hits);
      },
      (error: unknown) => {
        if (!isAbort(error)) {
          setLoadError(error);
        }
      },
    );
    return () => controller.abort();
  }, [host.conn, index]);

  const limit = maxDocs.trim() === "" ? undefined : Number(maxDocs);
  const limitBad = limit !== undefined && (!Number.isInteger(limit) || limit < 1);
  let paramsJson: Json | null = null;
  if (mode === "update" && params.trim() !== "") {
    try {
      paramsJson = parseJson(params) as Json;
    } catch {
      paramsJson = null;
    }
  }
  const scriptBody: Json = jsonObject<Json>([["source", script], ["lang", "painless"], ...(paramsJson !== null ? ([["params", paramsJson]] as [string, Json][]) : [])]);
  const body = jsonObject<Json>([
    // No condition is sent as `match_all`, so the request shown is the one sent.
    ["query", query ?? jsonObject<Json>([["match_all", jsonObject<Json>([])]])],
    ...(mode === "update" ? ([["script", scriptBody]] as [string, Json][]) : []),
    ...(limit !== undefined && !limitBad ? ([["max_docs", limit]] as [string, Json][]) : []),
  ]);
  const path = `/${index}/${mode === "update" ? "_update_by_query" : "_delete_by_query"}${proceed ? "?conflicts=proceed" : ""}`;
  const command = requestText("POST", path, body);

  const run = async () => {
    if (mode === "update" && params.trim() !== "") {
      try {
        parseJson(params);
      } catch (error) {
        const at = error instanceof JsonSyntaxError ? error.offset : 0;
        setParamsError({ message: error instanceof Error ? error.message : String(error), from: at, to: at + 1 });
        return;
      }
    }
    setParamsError(null);
    // By-query writes always reach many documents: the server needs
    // `confirmed`, and safe mode asks first.
    if (needsConfirm("danger", host.safeMode)) {
      const ok = await host.confirm({
        title: mode === "update" ? t("일괄 수정") : t("일괄 삭제"),
        message:
          query === null
            ? t("조건 없이 인덱스의 모든 문서({count}개)에 적용합니다. 되돌릴 수 없습니다.", { count: matched?.toLocaleString() ?? "?" })
            : t("조건에 맞는 문서 {count}개에 적용합니다. 되돌릴 수 없습니다.", { count: matched?.toLocaleString() ?? "?" }),
        command,
        okLabel: mode === "update" ? t("수정") : t("삭제"),
      });
      if (!ok) {
        return;
      }
    }
    setBusy(true);
    setRunError(null);
    try {
      const args = { index, query: query ?? jsonObject<Json>([["match_all", jsonObject<Json>([])]]), conflicts: proceed ? ("proceed" as const) : ("abort" as const), max_docs: limitBad ? undefined : limit };
      const r = mode === "update" ? await updateByQuery(host.conn, { ...args, script: scriptBody }) : await deleteByQuery(host.conn, args);
      setResult(r);
      onDone();
    } catch (error) {
      setRunError(error);
    } finally {
      setBusy(false);
    }
  };

  const failures = Array.isArray(result?.failures) ? result.failures : [];
  return (
    <div className="modal-backdrop">
      <div className="modal es-byquery-modal" role="dialog" aria-modal="true" aria-label={mode === "update" ? t("일괄 수정") : t("일괄 삭제")}>
        <div className="modal-head">
          <div className="segmented" role="group">
            <button type="button" className={mode === "update" ? "active" : undefined} aria-pressed={mode === "update"} onClick={() => setMode("update")} disabled={busy}>
              {t("일괄 수정")}
            </button>
            <button type="button" className={mode === "delete" ? "active" : undefined} aria-pressed={mode === "delete"} onClick={() => setMode("delete")} disabled={busy}>
              {t("일괄 삭제")}
            </button>
          </div>
          <span className="spacer" />
          <span className="panel-dim mono">{index}</span>
        </div>
        <div className="modal-body es-byquery-body">
          <div className="es-byquery-count" role="status">
            {loadError !== null ? (
              <ErrorNotice error={loadError} context="document" engine="elasticsearch" variant="compact" />
            ) : matched === null ? (
              <>
                <Spinner size={10} /> {t("영향받는 문서를 세는 중…")}
              </>
            ) : (
              <strong>{t("영향받는 문서 {count}개", { count: matched.toLocaleString() })}</strong>
            )}
            {query === null ? <span className="es-warn">{t("조건이 없어 모든 문서가 대상입니다")}</span> : null}
          </div>
          {mode === "update" ? (
            <>
              <label className="es-field-label">{t("스크립트 (painless)")}</label>
              <div className="es-byquery-editor">
                <SearchEditor value={script} onChange={setScript} spans={() => []} ariaLabel={t("스크립트 (painless)")} />
              </div>
              <label className="es-field-label">{t("params (JSON, 선택)")}</label>
              <div className="es-byquery-editor small">
                <SearchEditor value={params} onChange={setParams} error={paramsError} ariaLabel="params" />
              </div>
              {paramsError !== null ? <ErrorNotice error={new Error(paramsError.message)} context="editor" variant="compact" /> : null}
            </>
          ) : null}
          <div className="es-byquery-opts">
            <label className="check-row">
              <input type="checkbox" checked={proceed} onChange={(event) => setProceed(event.target.checked)} />
              {t("버전 충돌은 건너뛰기 (conflicts=proceed)")}
            </label>
            <label className="es-inline-field">
              {t("최대 문서 수")}
              <input type="text" inputMode="numeric" className="mono" value={maxDocs} placeholder={t("모두")} aria-invalid={limitBad || undefined} onChange={(event) => setMaxDocs(event.target.value)} />
            </label>
          </div>
          <div className="es-field-label">{t("보낼 요청")}</div>
          <pre className="review-pre mono es-byquery-command">{command}</pre>
          {sample.length > 0 && result === null ? (
            <>
              <div className="es-field-label">{t("대상 문서 (앞 {count}개)", { count: sample.length })}</div>
              <div className="es-byquery-sample">
                {sample.map((hit) => (
                  <pre key={`${hit.index}/${hit.id}`} className="mono">
                    <span className="panel-dim">{hit.id} · </span>
                    {jsonText(hit.source, 0).slice(0, 240)}
                  </pre>
                ))}
              </div>
            </>
          ) : null}
          {result !== null ? (
            <div className="es-byquery-result" role="status">
              <strong>
                {mode === "update"
                  ? t("수정 {updated}개 · 충돌 {conflicts}개 · {ms}ms", { updated: num(result.updated) ?? 0, conflicts: num(result.version_conflicts) ?? 0, ms: num(result.took) ?? 0 })
                  : t("삭제 {deleted}개 · 충돌 {conflicts}개 · {ms}ms", { deleted: num(result.deleted) ?? 0, conflicts: num(result.version_conflicts) ?? 0, ms: num(result.took) ?? 0 })}
              </strong>
              {failures.slice(0, 20).map((f, i) => (
                <div key={i} className="es-failure mono">
                  {str(rec(f).id)} · {str(rec(rec(f).cause).type)}: {str(rec(rec(f).cause).reason)}
                </div>
              ))}
            </div>
          ) : null}
          {runError !== null ? <ErrorNotice error={runError} context="document" engine="elasticsearch" variant="block" /> : null}
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          <button type="button" onClick={onClose} disabled={busy}>
            {result !== null ? t("닫기") : t("취소")}
          </button>
          {result === null ? (
            <button type="button" className="primary danger" onClick={() => void run()} disabled={busy || host.readOnly || limitBad || (mode === "update" && script.trim() === "")}>
              {busy ? <Spinner size={10} /> : null}
              {mode === "update" ? t("수정 실행") : t("삭제 실행")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
