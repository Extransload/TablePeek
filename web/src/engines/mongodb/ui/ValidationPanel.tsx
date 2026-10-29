// The 검증 sub-tab (MONGODB.md §6.2): the collection's validator
// (`$jsonSchema` or a query expression) in a code editor with its
// validationLevel and validationAction. Before anything is applied it shows,
// on a sample of the documents, how many pass and how many break the rule
// being edited, with examples and the reasons a `$jsonSchema` gives; 적용
// sends `collMod` (safe mode shows the command first). A draft comes from
// the 스키마 tab, or from a fresh sample with 현재 데이터로 초안 만들기.

import { useEffect, useMemo, useRef, useState } from "react";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { CheckIcon } from "../../../components/icons";
import { Select } from "../../../components/Select";
import { LoadingState, Spinner } from "../../../components/Spinner";
import { t } from "../../../i18n";
import { aggregate, command, isAbort, listCollections, toNumber, type Namespace } from "../api";
import { Int32, bsonDoc, isDocument, type BsonDocument } from "../bson";
import { sampleFields, type CompletionContext } from "../complete";
import { shellCollection, toShell, toShellPretty } from "../format";
import { analyzeSchema, draftJsonSchema, jsonSchemaReasons } from "../schema";
import { parseValue } from "../shell/parse";
import { CardView } from "./CardView";
import { BracesIcon } from "./icons";
import { SyntaxErrorNotice } from "./JsonView";
import { MongoEditor } from "./MongoEditor";
import { ShellText } from "./ShellText";
import type { DocHost } from "./types";
import "./panels.css";
import "./schema.css";

export interface ValidationPanelProps {
  ns: Namespace;
  // Views and read-only connections: the rule can be tried, not applied.
  readOnly: boolean;
  // False while another sub-tab is in front.
  active: boolean;
  host: DocHost;
  // A `$jsonSchema` from the 스키마 tab; `seq` changes for each request.
  draft: { seq: number; schema: BsonDocument } | null;
}

type Level = "off" | "moderate" | "strict";
type Action = "error" | "warn";

const LEVELS: { id: Level; label: string }[] = [
  { id: "off", label: "끔 (off)" },
  { id: "moderate", label: "보통 (moderate)" },
  { id: "strict", label: "엄격 (strict)" },
];

const ACTIONS: { id: Action; label: string }[] = [
  { id: "error", label: "거부 (error)" },
  { id: "warn", label: "경고만 (warn)" },
];

// Documents the preview checks, and how many examples it brings back.
const PREVIEW_SAMPLE = 1000;
const FAIL_EXAMPLES = 20;
const PASS_EXAMPLES = 5;

// The rule as the server has it.
interface Applied {
  validator: BsonDocument | null;
  level: Level;
  action: Action;
}

interface Preview {
  command: string;
  total: number;
  failed: number;
  failDocs: BsonDocument[];
  passDocs: BsonDocument[];
  validator: BsonDocument;
}

// The editor as left, per collection, so a trip to 문서 to try an insert
// comes back to the same text.
interface ValidationMemory {
  text: string;
  level: Level;
  action: Action;
  applied: Applied | null;
  tab: "fail" | "pass";
}

const memory = new Map<string, ValidationMemory>();

// Draft requests already put into the editor (the panel is mounted again
// each time its tab is shown while the workbench keeps the last request).
const handledDrafts = new WeakSet<object>();

function textOf(validator: BsonDocument | null): string {
  return validator === null ? "" : toShellPretty(validator);
}

// The editor text as a validator document; null for an empty editor.
function parseRule(text: string): { ok: true; value: BsonDocument | null } | { ok: false; message: string; from: number; to: number } {
  if (text.trim() === "") {
    return { ok: true, value: null };
  }
  const r = parseValue(text);
  if (!r.ok) {
    return { ok: false, message: r.error.message, from: r.error.from, to: r.error.to };
  }
  if (!isDocument(r.value)) {
    return { ok: false, message: t("검증 규칙은 { … } 문서여야 합니다"), from: 0, to: text.length };
  }
  return { ok: true, value: r.value };
}

export function ValidationPanel({ ns, readOnly, active, host, draft }: ValidationPanelProps) {
  const key = `${ns.conn}\u0000${ns.db}\u0000${ns.coll}`;
  const remembered = memory.get(key);
  const [text, setText] = useState(remembered?.text ?? "");
  const [level, setLevel] = useState<Level>(remembered?.level ?? "strict");
  const [action, setAction] = useState<Action>(remembered?.action ?? "error");
  const [applied, setApplied] = useState<Applied | null>(remembered?.applied ?? null);
  const [tab, setTab] = useState<"fail" | "pass">(remembered?.tab ?? "fail");
  const [loadError, setLoadError] = useState<unknown>(null);
  // A failed 초안 만들기 or 적용, until the next try.
  const [actionError, setActionError] = useState<unknown>(null);
  const [preview, setPreview] = useState<Preview | { error: unknown } | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<"apply" | "draft" | null>(null);
  const [reloadSeq, setReloadSeq] = useState(0);

  useEffect(() => {
    memory.set(key, { text, level, action, applied, tab });
  }, [key, text, level, action, applied, tab]);

  // Whether the next load fills the editor: the first one, and the one after
  // 적용. Typing or a draft keeps the text from being replaced.
  const takeServer = useRef(remembered?.applied == null);
  const latest = useRef({ text, level, action, applied });
  latest.current = { text, level, action, applied };

  // The rule as the server has it: on opening, and again after 적용. The
  // editor takes it unless it holds changes of its own.
  useEffect(() => {
    const ctl = new AbortController();
    listCollections(ns.conn, ns.db, ctl.signal).then(
      (list) => {
        const options: BsonDocument = list.find((c) => c.name === ns.coll)?.options ?? new Map();
        const stored = options.get("validator");
        const validator = isDocument(stored) && stored.size > 0 ? stored : null;
        const validationLevel = options.get("validationLevel");
        const next: Applied = {
          validator,
          level: validationLevel === "off" || validationLevel === "moderate" ? validationLevel : "strict",
          action: options.get("validationAction") === "warn" ? "warn" : "error",
        };
        const cur = latest.current;
        const untouched = takeServer.current || (cur.applied !== null && cur.text === textOf(cur.applied.validator) && cur.level === cur.applied.level && cur.action === cur.applied.action);
        takeServer.current = false;
        setLoadError(null);
        setApplied(next);
        if (untouched) {
          setText(textOf(next.validator));
          setLevel(next.level);
          setAction(next.action);
        }
      },
      (e: unknown) => {
        if (!isAbort(e)) {
          setLoadError(e);
        }
      },
    );
    return () => ctl.abort();
  }, [ns.conn, ns.db, ns.coll, reloadSeq]);

  useEffect(() => {
    if (draft !== null && !handledDrafts.has(draft)) {
      handledDrafts.add(draft);
      takeServer.current = false;
      setText(toShellPretty(bsonDoc({ $jsonSchema: draft.schema })));
      setLevel((l) => (l === "off" ? "strict" : l));
    }
  }, [draft]);

  const rule = useMemo(() => parseRule(text), [text]);

  // The preview: 0.6 s after the text settles, on one sample. `$facet` keeps
  // the counts and examples from the same documents.
  useEffect(() => {
    if (!active || !rule.ok || rule.value === null) {
      setPreview(null);
      setChecking(false);
      return;
    }
    const validator = rule.value;
    const ctl = new AbortController();
    const timer = window.setTimeout(() => {
      setChecking(true);
      const failing = bsonDoc({ $match: bsonDoc({ $nor: [validator] }) });
      const pipeline: BsonDocument[] = [
        bsonDoc({ $sample: bsonDoc({ size: new Int32(PREVIEW_SAMPLE) }) }),
        bsonDoc({
          $facet: bsonDoc({
            total: [bsonDoc({ $count: "n" })],
            failed: [failing, bsonDoc({ $count: "n" })],
            failDocs: [failing, bsonDoc({ $limit: new Int32(FAIL_EXAMPLES) })],
            passDocs: [bsonDoc({ $match: bsonDoc({ $and: [validator] }) }), bsonDoc({ $limit: new Int32(PASS_EXAMPLES) })],
          }),
        }),
      ];
      const commandText = `${shellCollection(ns.coll)}.aggregate([{ $sample: { size: ${PREVIEW_SAMPLE} } }, { $match: { $nor: [${toShell(validator)}] } }])`;
      aggregate(ns, pipeline, undefined, ctl.signal).then(
        (batch) => {
          const facet: BsonDocument = batch.docs[0] ?? new Map();
          const n = (list: unknown) => (Array.isArray(list) && isDocument(list[0]) ? toNumber(list[0].get("n")) : 0);
          const docsOf = (list: unknown) => (Array.isArray(list) ? list.filter(isDocument) : []);
          setPreview({ command: commandText, total: n(facet.get("total")), failed: n(facet.get("failed")), failDocs: docsOf(facet.get("failDocs")), passDocs: docsOf(facet.get("passDocs")), validator });
          setChecking(false);
        },
        (e: unknown) => {
          if (!isAbort(e)) {
            setPreview({ error: e });
            setChecking(false);
          }
        },
      );
    }, 600);
    return () => {
      window.clearTimeout(timer);
      ctl.abort();
    };
  }, [active, rule, ns]);

  const fields = useMemo(() => sampleFields(preview !== null && "total" in preview ? preview.failDocs.concat(preview.passDocs) : []), [preview]);
  const completionRef = useRef<CompletionContext>({ fields });
  completionRef.current = { fields };

  async function makeDraft(): Promise<void> {
    setBusy("draft");
    setActionError(null);
    try {
      const batch = await aggregate(ns, [bsonDoc({ $sample: bsonDoc({ size: new Int32(PREVIEW_SAMPLE) }) })]);
      if (batch.docs.length === 0) {
        host.notify(t("문서가 없어 초안을 만들 수 없습니다"));
        return;
      }
      setText(toShellPretty(bsonDoc({ $jsonSchema: draftJsonSchema(analyzeSchema(batch.docs)) })));
      setLevel((l) => (l === "off" ? "strict" : l));
      host.notify(t("문서 {count}개로 초안을 만들었습니다", { count: batch.docs.length.toLocaleString() }));
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(null);
    }
  }

  async function apply(): Promise<void> {
    if (!rule.ok || readOnly) {
      return;
    }
    // An empty editor removes the rule (collMod with an empty validator).
    const cmd = bsonDoc({ collMod: ns.coll, validator: rule.value ?? new Map(), validationLevel: level, validationAction: action });
    if (host.safeMode !== 0) {
      const ok = await host.confirm({
        title: t("검증 규칙 적용"),
        message:
          rule.value === null
            ? t("{ns}의 검증 규칙을 지울까요?", { ns: `${ns.db}.${ns.coll}` })
            : t("{ns}에 이 검증 규칙을 적용할까요?\n이후의 쓰기부터 검사합니다. 이미 있는 문서는 바뀌지 않습니다.", { ns: `${ns.db}.${ns.coll}` }),
        command: `db.getSiblingDB(${JSON.stringify(ns.db)}).runCommand(${toShellPretty(cmd)})`,
        okLabel: t("적용"),
      });
      if (!ok) {
        return;
      }
    }
    setBusy("apply");
    setActionError(null);
    try {
      await command(ns.conn, ns.db, cmd, true);
      host.notify(rule.value === null ? t("검증 규칙을 지웠습니다") : t("검증 규칙을 적용했습니다"));
      // The editor shows what the server now has.
      takeServer.current = true;
      setReloadSeq((n) => n + 1);
    } catch (e) {
      setActionError(e);
    } finally {
      setBusy(null);
    }
  }

  const dirty = applied !== null && (text !== textOf(applied.validator) || level !== applied.level || action !== applied.action);
  let state: { text: string; cls: string };
  if (applied === null) {
    state = { text: t("불러오는 중…"), cls: "dim" };
  } else if (applied.validator === null) {
    state = { text: t("규칙 없음"), cls: "dim" };
  } else {
    state = { text: t("적용 중 · {level} · {action}", { level: applied.level, action: applied.action }), cls: "ok" };
  }

  let result;
  if (!rule.ok) {
    result = <SyntaxErrorNotice src={text} message={rule.message} at={rule.from} context="structure" />;
  } else if (rule.value === null) {
    result = <div className="panel-empty">{t("규칙을 쓰면 표본 문서가 통과하는지 바로 보여 줍니다")}</div>;
  } else if (preview === null) {
    result = <LoadingState />;
  } else if ("error" in preview) {
    result = <ErrorNotice error={preview.error} context="structure" engine="mongodb" />;
  } else {
    const pass = preview.total - preview.failed;
    const pct = preview.total > 0 ? (pass / preview.total) * 100 : 100;
    const validator = preview.validator;
    result = (
      <>
        <div className="mg-valid-sum" title={preview.command}>
          <div className="mg-valid-bar">
            <span className="pass" style={{ width: `${pct}%` }} />
            <span className="fail" style={{ width: `${100 - pct}%` }} />
          </div>
          <div className="mg-valid-counts">
            <span className="ok">{t("통과 {count}개", { count: pass.toLocaleString() })}</span>
            <span className="bad">{t("위반 {count}개", { count: preview.failed.toLocaleString() })}</span>
            <span className="panel-dim">{t("표본 {count}개 · 적용하기 전에 미리 셉니다", { count: preview.total.toLocaleString() })}</span>
            {checking ? <Spinner size={10} /> : null}
          </div>
        </div>
        <div className="view-tabs mg-valid-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === "fail"} className={tab === "fail" ? "active" : undefined} onClick={() => setTab("fail")}>
            {t("위반한 문서 {count}", { count: preview.failed.toLocaleString() })}
          </button>
          <button type="button" role="tab" aria-selected={tab === "pass"} className={tab === "pass" ? "active" : undefined} onClick={() => setTab("pass")}>
            {t("통과한 문서 {count}", { count: pass.toLocaleString() })}
          </button>
        </div>
        <div className="mg-valid-list">
          {tab === "fail" ? (
            preview.failDocs.length === 0 ? (
              <div className="panel-empty">{t("표본의 모든 문서가 통과합니다")}</div>
            ) : (
              <>
                {preview.failDocs.map((doc, i) => {
                  const reasons = jsonSchemaReasons(validator, doc);
                  const id = doc.get("_id");
                  return (
                    <div key={i} className="mg-valid-doc">
                      {id !== undefined ? <ShellText className="mg-doc-id" text={toShell(id)} /> : null}
                      <ul className="mg-valid-reasons">
                        {(reasons.length > 0 ? reasons.slice(0, 6) : [t("이 규칙에 맞지 않습니다 (서버 판정)")]).map((reason, j) => (
                          <li key={j}>{reason}</li>
                        ))}
                        {reasons.length > 6 ? <li className="panel-dim">{t("… {count}개 더", { count: reasons.length - 6 })}</li> : null}
                      </ul>
                    </div>
                  );
                })}
                {preview.failed > preview.failDocs.length ? <div className="panel-dim">{t("앞의 {count}개만 보여 줍니다", { count: preview.failDocs.length })}</div> : null}
              </>
            )
          ) : (
            <CardView docs={preview.passDocs} offset={0} readOnly allOpen={false} notify={host.notify} emptyText={t("표본에 통과하는 문서가 없습니다")} />
          )}
        </div>
      </>
    );
  }

  return (
    <div className="mg-pane mg-validation">
      <div className="mg-agg-bar">
        <span className={`mg-flag ${state.cls}`}>{state.text}</span>
        <label className="mg-inline">
          {t("검증 수준")}
          <Select className="mg-input" value={level} disabled={readOnly} onChange={(event) => setLevel(event.target.value as Level)}>
            {LEVELS.map((x) => (
              <option key={x.id} value={x.id}>
                {t(x.label)}
              </option>
            ))}
          </Select>
        </label>
        <label className="mg-inline">
          {t("어기면")}
          <Select className="mg-input" value={action} disabled={readOnly} onChange={(event) => setAction(event.target.value as Action)}>
            {ACTIONS.map((x) => (
              <option key={x.id} value={x.id}>
                {t(x.label)}
              </option>
            ))}
          </Select>
        </label>
        <span className="spacer" />
        <button type="button" className="mg-qbtn" disabled={busy !== null} title={t("문서 {count}개를 표본으로 $jsonSchema 초안을 만듭니다", { count: PREVIEW_SAMPLE.toLocaleString() })} onClick={() => void makeDraft()}>
          {busy === "draft" ? <Spinner size={10} /> : <BracesIcon size={10} />}
          {t("현재 데이터로 초안 만들기")}
        </button>
        <button
          type="button"
          className="mg-qbtn"
          disabled={!dirty}
          title={t("서버에 적용된 규칙으로 되돌리기")}
          onClick={() => {
            if (applied !== null) {
              setText(textOf(applied.validator));
              setLevel(applied.level);
              setAction(applied.action);
            }
          }}
        >
          {t("되돌리기")}
        </button>
        {readOnly ? null : (
          <button type="button" className="primary mg-find" disabled={!rule.ok || !dirty || busy !== null} title={t("collMod로 적용 (⌘↩)")} onClick={() => void apply()}>
            {busy === "apply" ? <Spinner size={9} /> : <CheckIcon size={9} />}
            {t("적용")}
          </button>
        )}
      </div>
      {loadError !== null || actionError !== null ? (
        <div className="mg-valid-load">
          {loadError !== null ? <ErrorNotice error={loadError} context="structure" engine="mongodb" /> : null}
          {actionError !== null ? <ErrorNotice error={actionError} context="structure" engine="mongodb" variant="compact" onClose={() => setActionError(null)} /> : null}
        </div>
      ) : null}
      <div className="mg-valid-grid">
        <div className="mg-valid-editor">
          <MongoEditor
            value={text}
            onChange={setText}
            onRun={() => void apply()}
            role="filter"
            completion={() => completionRef.current}
            placeholder={t("{ $jsonSchema: { bsonType: \"object\", required: [ … ], properties: { … } } }\n\n위의 「현재 데이터로 초안 만들기」로 시작해 보세요")}
            error={rule.ok ? null : { from: rule.from, to: rule.to }}
            ariaLabel={t("검증 규칙")}
          />
        </div>
        <div className="mg-valid-result">{result}</div>
      </div>
    </div>
  );
}
