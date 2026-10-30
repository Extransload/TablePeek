// The 분석 sub-tab of an index tab: the analyze API as a tester. A text runs
// through an analyzer (built-in, a language or plugin one, or one this
// index defines), through a field's analyzer, or through a tokenizer and
// filters put together here; the tokens show as chips (hovering one marks
// its offsets in the text) and as a table, and with 단계별 the token stream
// after each character filter, the tokenizer and each token filter.

import { useEffect, useMemo, useRef, useState } from "react";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { CloseIcon, PlayIcon } from "../../../components/icons";
import { Spinner } from "../../../components/Spinner";
import { SuggestInput } from "../../../components/SuggestInput";
import { t } from "../../../i18n";
import { jsonKeys } from "../../mongodb/bson";
import { analyze, getMapping, getSettings, isAbort } from "../api";
import { mappingFields } from "../dsl";
import { list, num, rec, str, type Json } from "../json";
import { requestText } from "./common";
import { BUILTIN_ANALYZERS, IndexPicker, LANGUAGE_ANALYZERS, backingIndex, customAnalysis, type CustomAnalysis } from "./MappingPanel";
import type { IndexPanelProps } from "./types";
import "../../mongodb/mongodb.css";
import "../../mongodb/ui/panels.css";
import "./panels.css";

// Analyzers of the common plugins (analysis-nori, -kuromoji, -smartcn, -icu).
const PLUGIN_ANALYZERS = ["nori", "kuromoji", "smartcn", "icu_analyzer"];
const TOKENIZERS = [
  "standard",
  "letter",
  "lowercase",
  "whitespace",
  "uax_url_email",
  "classic",
  "thai",
  "ngram",
  "edge_ngram",
  "keyword",
  "pattern",
  "simple_pattern",
  "simple_pattern_split",
  "char_group",
  "path_hierarchy",
  "nori_tokenizer",
  "kuromoji_tokenizer",
  "icu_tokenizer",
];
const TOKEN_FILTERS = [
  "lowercase",
  "uppercase",
  "asciifolding",
  "stop",
  "stemmer",
  "porter_stem",
  "kstem",
  "snowball",
  "trim",
  "unique",
  "length",
  "truncate",
  "word_delimiter_graph",
  "shingle",
  "ngram",
  "edge_ngram",
  "reverse",
  "elision",
  "apostrophe",
  "classic",
  "cjk_bigram",
  "cjk_width",
  "decimal_digit",
  "keyword_repeat",
  "remove_duplicates",
  "fingerprint",
  "flatten_graph",
  "nori_part_of_speech",
  "nori_readingform",
  "icu_folding",
  "icu_normalizer",
];
const CHAR_FILTERS = ["html_strip", "icu_normalizer"];
const TEXTUAL: Record<string, true> = { text: true, match_only_text: true, search_as_you_type: true, keyword: true, wildcard: true, completion: true, semantic_text: true };

type Mode = "analyzer" | "field" | "custom";

// What the tester was set to, kept per index tab while the app is open.
interface Draft {
  mode: Mode;
  text: string;
  analyzer: string;
  field: string;
  tokenizer: string;
  filters: string[];
  charFilters: string[];
  explain: boolean;
}
const drafts = new Map<string, Draft>();

interface Token {
  token: string;
  start: number | null;
  end: number | null;
  type: string;
  position: number | null;
  // What `explain` adds (bytes, positionLength, keyword, …).
  extra: [string, unknown][];
}

interface Stage {
  // 문자 필터, 토크나이저, 토큰 필터 or 분석기.
  kind: string;
  name: string;
  tokens: Token[] | null;
  // A character filter's output.
  text: string | null;
}

function tokenOf(raw: unknown): Token {
  const r = rec(raw);
  return {
    token: str(r.token),
    start: num(r.start_offset),
    end: num(r.end_offset),
    type: str(r.type),
    position: num(r.position),
    extra: Object.entries(r).filter(([key]) => !["token", "start_offset", "end_offset", "type", "position"].includes(key)),
  };
}

// The `detail` of an explained run as stages in the order they ran.
function stagesOf(raw: Record<string, unknown>): Stage[] {
  const detail = rec(raw.detail);
  const stages: Stage[] = [];
  for (const cf of list(detail.charfilters)) {
    const c = rec(cf);
    stages.push({ kind: "문자 필터", name: str(c.name), tokens: null, text: list(c.filtered_text).map(str).join("\n") });
  }
  if (detail.tokenizer !== undefined) {
    const tk = rec(detail.tokenizer);
    stages.push({ kind: "토크나이저", name: str(tk.name), tokens: list(tk.tokens).map(tokenOf), text: null });
  }
  for (const tf of list(detail.tokenfilters)) {
    const f = rec(tf);
    stages.push({ kind: "토큰 필터", name: str(f.name), tokens: list(f.tokens).map(tokenOf), text: null });
  }
  if (detail.analyzer !== undefined) {
    const a = rec(detail.analyzer);
    stages.push({ kind: "분석기", name: str(a.name), tokens: list(a.tokens).map(tokenOf), text: null });
  }
  return stages;
}

type Outcome = { tokens: Token[]; stages: Stage[]; text: string; request: string } | { error: unknown };

function TokenChips({ tokens, hovered, onHover }: { tokens: Token[]; hovered: Token | null; onHover(token: Token | null): void }) {
  return (
    <div className="es-tokens">
      {tokens.map((tok, i) => (
        <span
          key={i}
          className={`es-token${hovered === tok ? " hot" : ""}`}
          title={[`${t("위치")} ${tok.position ?? "—"}`, `${t("오프셋")} ${tok.start ?? "—"}–${tok.end ?? "—"}`, tok.type, ...tok.extra.map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)].join("\n")}
          onMouseEnter={() => onHover(tok)}
          onMouseLeave={() => onHover(null)}
        >
          <span className="es-token-text mono">{tok.token}</span>
          <span className="es-token-pos">{tok.position ?? ""}</span>
        </span>
      ))}
      {tokens.length === 0 ? <span className="panel-dim">{t("토큰이 없습니다")}</span> : null}
    </div>
  );
}

export function AnalyzePanel({ host, index, kind, refreshSeq }: IndexPanelProps) {
  const key = `${host.conn}\u0000${index}`;
  const [draft, setDraft] = useState<Draft>(() => drafts.get(key) ?? { mode: "analyzer", text: "", analyzer: "standard", field: "", tokenizer: "standard", filters: ["lowercase"], charFilters: [], explain: false });
  const [mapping, setMapping] = useState<Record<string, unknown> | null>(null);
  const [custom, setCustom] = useState<CustomAnalysis | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"chips" | "table">("chips");
  const [hovered, setHovered] = useState<Token | null>(null);
  const [filterInput, setFilterInput] = useState("");
  const [charInput, setCharInput] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);

  function update(patch: Partial<Draft>): void {
    setDraft((d) => {
      const next = { ...d, ...patch };
      drafts.set(key, next);
      return next;
    });
  }

  // The mapping names the concrete indices (analyze takes one) and the fields.
  useEffect(() => {
    const ctl = new AbortController();
    getMapping(host.conn, index, ctl.signal).then(
      (reply) => setMapping(reply),
      (e: unknown) => {
        if (!isAbort(e)) {
          setMapping({});
        }
      },
    );
    return () => ctl.abort();
  }, [host.conn, index, refreshSeq]);

  const names = useMemo(() => (mapping === null ? [] : jsonKeys(mapping).sort()), [mapping]);
  const current = backingIndex(names, picked, kind);

  useEffect(() => {
    if (current === null) {
      setCustom(null);
      return;
    }
    const ctl = new AbortController();
    getSettings(host.conn, current, false, ctl.signal).then(
      (reply) => setCustom(customAnalysis(reply, current)),
      () => setCustom(null),
    );
    return () => ctl.abort();
  }, [host.conn, current, refreshSeq]);

  const fields = useMemo(() => (mapping === null || current === null ? [] : mappingFields({ [current]: mapping[current] }).filter((f) => Object.hasOwn(TEXTUAL, f.type))), [mapping, current]);
  // The index's own analysis components (its settings) first, then the built-in ones.
  const analyzerSuggestions = useMemo(() => [...new Set([...(custom?.analyzers ?? []), ...BUILTIN_ANALYZERS, ...LANGUAGE_ANALYZERS, ...PLUGIN_ANALYZERS])], [custom]);
  const tokenizerSuggestions = useMemo(() => [...new Set([...(custom?.tokenizers ?? []), ...TOKENIZERS])], [custom]);
  const filterSuggestions = useMemo(() => [...new Set([...(custom?.filters ?? []), ...TOKEN_FILTERS])], [custom]);
  const charSuggestions = useMemo(() => [...new Set([...(custom?.charFilters ?? []), ...CHAR_FILTERS])], [custom]);

  const body = useMemo((): { [key: string]: Json } => {
    const b: { [key: string]: Json } = {};
    if (draft.mode === "analyzer") {
      b.analyzer = draft.analyzer.trim() || "standard";
    } else if (draft.mode === "field") {
      b.field = draft.field.trim();
    } else {
      b.tokenizer = draft.tokenizer.trim() || "standard";
      if (draft.charFilters.length > 0) {
        b.char_filter = draft.charFilters;
      }
      if (draft.filters.length > 0) {
        b.filter = draft.filters;
      }
    }
    b.text = draft.text;
    if (draft.explain) {
      b.explain = true;
    }
    return b;
  }, [draft]);

  const problem = draft.text === "" ? t("분석할 글을 쓰세요") : draft.mode === "field" && draft.field.trim() === "" ? t("필드를 고르세요") : null;

  function run(): void {
    if (problem !== null || busy) {
      return;
    }
    controller.current?.abort();
    const ctl = new AbortController();
    controller.current = ctl;
    setBusy(true);
    const text = draft.text;
    const request = requestText("POST", `/${current ?? index}/_analyze`, body);
    analyze(host.conn, current ?? index, body, ctl.signal).then(
      ({ tokens, raw }) => {
        const stages = stagesOf(raw);
        const last = [...stages].reverse().find((s) => s.tokens !== null);
        setOutcome({ tokens: tokens.length > 0 || last === undefined ? list(raw.tokens).map(tokenOf) : (last.tokens ?? []), stages, text, request });
        setHovered(null);
        setBusy(false);
      },
      (e: unknown) => {
        if (!isAbort(e)) {
          setOutcome({ error: e });
          setBusy(false);
        }
      },
    );
  }

  function setChain(which: "filters" | "charFilters", next: string[]): void {
    update(which === "filters" ? { filters: next } : { charFilters: next });
  }

  // A filter chain: the names in order, each removable, and a field that adds
  // one on Enter (a highlighted suggestion is picked first).
  const chainEditor = (which: "filters" | "charFilters", label: string, input: string, setInput: (v: string) => void, suggestions: string[]) => (
    <form
      className="es-chain"
      onSubmit={(event) => {
        event.preventDefault();
        if (input.trim() !== "") {
          setChain(which, [...draft[which], input.trim()]);
          setInput("");
        }
      }}
    >
      <span className="mg-form-label">{label}</span>
      {draft[which].map((name, i) => (
        <span key={`${name}-${i}`} className="es-chip mono">
          {name}
          <button type="button" className="es-chip-x" aria-label={t("빼기")} title={t("빼기")} onClick={() => setChain(which, draft[which].filter((_, j) => j !== i))}>
            <CloseIcon size={7} />
          </button>
        </span>
      ))}
      <SuggestInput
        type="text"
        className="mg-input mono es-chain-input"
        spellCheck={false}
        suggestions={suggestions}
        placeholder={t("추가… (Enter)")}
        aria-label={label}
        value={input}
        onChange={(event) => setInput(event.target.value)}
      />
    </form>
  );

  let result;
  if (outcome === null) {
    result = <div className="panel-empty">{t("글을 쓰고 분석을 누르면 (⌘↩) 토큰을 봅니다")}</div>;
  } else if ("error" in outcome) {
    result = <ErrorNotice error={outcome.error} context="general" engine="elasticsearch" onRetry={run} />;
  } else {
    const hot = hovered !== null && hovered.start !== null && hovered.end !== null ? { from: hovered.start, to: hovered.end } : null;
    result = (
      <>
        <div className="es-analyze-head">
          <span className="mg-agg-count">{t("토큰 {count}개", { count: outcome.tokens.length })}</span>
          <span className="panel-dim mono es-request" title={outcome.request}>
            {outcome.request.split("\n")[0]}
          </span>
          <span className="spacer" />
          <div className="segmented" role="group" aria-label={t("보기")}>
            <button type="button" className={view === "chips" ? "active" : ""} aria-pressed={view === "chips"} onClick={() => setView("chips")}>
              {t("토큰")}
            </button>
            <button type="button" className={view === "table" ? "active" : ""} aria-pressed={view === "table"} onClick={() => setView("table")}>
              {t("표")}
            </button>
          </div>
        </div>
        <pre className="panel-pre es-analyze-source" aria-label={t("분석한 글")}>
          {hot === null ? (
            outcome.text
          ) : (
            <>
              {outcome.text.slice(0, hot.from)}
              <mark>{outcome.text.slice(hot.from, hot.to)}</mark>
              {outcome.text.slice(hot.to)}
            </>
          )}
        </pre>
        {view === "chips" ? (
          <TokenChips tokens={outcome.tokens} hovered={hovered} onHover={setHovered} />
        ) : (
          <table className="panel-table es-token-table">
            <thead>
              <tr>
                <th className="num">#</th>
                <th>{t("토큰")}</th>
                <th className="num">{t("위치")}</th>
                <th className="num">{t("시작")}</th>
                <th className="num">{t("끝")}</th>
                <th>{t("형식")}</th>
              </tr>
            </thead>
            <tbody>
              {outcome.tokens.map((tok, i) => (
                <tr key={i} className={hovered === tok ? "hot" : undefined} onMouseEnter={() => setHovered(tok)} onMouseLeave={() => setHovered(null)}>
                  <td className="num panel-dim">{i + 1}</td>
                  <td className="mono">{tok.token}</td>
                  <td className="num mono">{tok.position ?? "—"}</td>
                  <td className="num mono">{tok.start ?? "—"}</td>
                  <td className="num mono">{tok.end ?? "—"}</td>
                  <td className="mono">{tok.type}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {outcome.stages.length > 0 ? (
          <section className="structure-section es-stages">
            <div className="structure-section-head">
              <span className="structure-section-title">{t("단계별 토큰")}</span>
            </div>
            {outcome.stages.map((stage, i) => (
              <div key={i} className="es-stage">
                <div className="es-stage-head">
                  <span className="es-chip dim">{t(stage.kind)}</span>
                  <span className="mono">{stage.name}</span>
                </div>
                {stage.tokens !== null ? <TokenChips tokens={stage.tokens} hovered={hovered} onHover={setHovered} /> : <pre className="panel-pre es-analyze-source">{stage.text}</pre>}
              </div>
            ))}
          </section>
        ) : null}
      </>
    );
  }

  return (
    <div className="mg-pane es-pane">
      <div className="mg-agg-bar">
        <IndexPicker names={names} value={current} onChange={setPicked} />
        <div className="segmented" role="group" aria-label={t("분석 방법")}>
          {(
            [
              ["analyzer", "분석기"],
              ["field", "필드"],
              ["custom", "직접 구성"],
            ] as const
          ).map(([mode, label]) => (
            <button key={mode} type="button" className={draft.mode === mode ? "active" : ""} aria-pressed={draft.mode === mode} onClick={() => update({ mode })}>
              {t(label)}
            </button>
          ))}
        </div>
        {draft.mode === "analyzer" ? (
          <SuggestInput type="text" className="mg-input mono es-analyzer-input" spellCheck={false} aria-label={t("분석기")} suggestions={analyzerSuggestions} placeholder="standard" value={draft.analyzer} onChange={(event) => update({ analyzer: event.target.value })} />
        ) : draft.mode === "field" ? (
          <SuggestInput type="text" className="mg-input mono es-analyzer-input" spellCheck={false} aria-label={t("필드")} suggestions={fields.map((f) => f.path)} placeholder={t("필드 경로")} value={draft.field} onChange={(event) => update({ field: event.target.value })} />
        ) : (
          <SuggestInput type="text" className="mg-input mono es-analyzer-input" spellCheck={false} aria-label={t("토크나이저")} suggestions={tokenizerSuggestions} placeholder="standard" value={draft.tokenizer} onChange={(event) => update({ tokenizer: event.target.value })} />
        )}
        <label className="es-check" title={t("문자 필터, 토크나이저, 토큰 필터를 거칠 때마다의 토큰")}>
          <input type="checkbox" checked={draft.explain} onChange={(event) => update({ explain: event.target.checked })} />
          {t("단계별 (explain)")}
        </label>
        <span className="spacer" />
        <button type="button" className="primary mg-find" disabled={problem !== null || busy} title={problem ?? "⌘↩"} onClick={run}>
          {busy ? <Spinner size={10} /> : <PlayIcon size={9} />}
          {t("분석")}
        </button>
      </div>
      <div className="es-body es-analyze">
        {draft.mode === "custom" ? (
          <div className="es-chains">
            {chainEditor("charFilters", t("문자 필터"), charInput, setCharInput, charSuggestions)}
            {chainEditor("filters", t("토큰 필터 (순서대로)"), filterInput, setFilterInput, filterSuggestions)}
          </div>
        ) : null}
        {draft.mode === "analyzer" && custom !== null && custom.analyzers.length > 0 ? (
          <div className="es-hint panel-dim">{t("이 인덱스의 분석기: {names}", { names: custom.analyzers.join(", ") })}</div>
        ) : null}
        <textarea
          className="mg-input es-analyze-text"
          spellCheck={false}
          placeholder={t("분석할 글")}
          aria-label={t("분석할 글")}
          value={draft.text}
          onChange={(event) => update({ text: event.target.value })}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              run();
            }
          }}
        />
        <div className="es-analyze-result">{result}</div>
      </div>
    </div>
  );
}
