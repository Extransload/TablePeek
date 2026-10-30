// The 문서 tab's query bar: a Lucene query string box, a Query DSL editor
// (opened with DSL, completion from the mapping), the sort and `_source`
// boxes, ⌘↩ to search, recent queries, and 계획 to profile the query.

import { useMemo, useRef, useState } from "react";
import { ContextMenu } from "../../../components/ContextMenu";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { ChevronDownIcon, HistoryIcon, SearchIcon } from "../../../components/icons";
import { PlanIcon } from "../../mongodb/ui/icons";
import { t } from "../../../i18n";
import { completeDsl, type DslCompletion, type MappedField } from "../dsl";
import { recentQueries, type QueryError, type QueryText } from "../query";
import { SearchEditor } from "./SearchEditor";

// The DSL box holds the `query` object; completion reads it as the value of
// a search body's `query`.
const DSL_LEAD = '{"query":';

interface QueryBarProps {
  index: string;
  query: QueryText;
  onChange(query: QueryText): void;
  dslOpen: boolean;
  onDslOpenChange(open: boolean): void;
  error: QueryError | null;
  fields: MappedField[];
  onRun(): void;
  // Runs a picked recent query.
  onApply(query: QueryText): void;
  onReset(): void;
  onProfile(): void;
}

// Field names (and `_score`) for the sort box, and `:asc`/`:desc` after a name.
function completeList(text: string, pos: number, fields: MappedField[], withOrder: boolean): DslCompletion | null {
  const start = Math.max(text.lastIndexOf(",", pos - 1) + 1, 0);
  const part = text.slice(start, pos);
  const lead = part.length - part.trimStart().length;
  const word = part.trimStart();
  const colon = word.indexOf(":");
  if (withOrder && colon >= 0) {
    return { from: start + lead + colon + 1, to: pos, quoted: false, items: ["asc", "desc"].filter((o) => o.startsWith(word.slice(colon + 1).toLowerCase())).map((o) => ({ label: o, kind: "value" })) };
  }
  const needle = word.replace(/^-/, "").toLowerCase();
  const names = fields.filter((f) => f.type !== "object" && (!withOrder || !["text", "match_only_text", "nested"].includes(f.type)));
  const items = [...(withOrder ? [{ label: "_score", kind: "field" as const, detail: t("점수") }] : []), ...names.map((f) => ({ label: f.path, kind: "field" as const, detail: f.type }))]
    .filter((item) => needle === "" || item.label.toLowerCase().includes(needle))
    .sort((a, b) => Number(!a.label.toLowerCase().startsWith(needle)) - Number(!b.label.toLowerCase().startsWith(needle)));
  return items.length === 0 ? null : { from: start + lead + (word.startsWith("-") ? 1 : 0), to: pos, quoted: false, items };
}

export function QueryBar({ index, query, onChange, dslOpen, onDslOpenChange, error, fields, onRun, onApply, onReset, onProfile }: QueryBarProps) {
  const [recentMenu, setRecentMenu] = useState<{ x: number; y: number } | null>(null);
  const fieldsRef = useRef(fields);
  fieldsRef.current = fields;
  const recent = useMemo(() => (recentMenu === null ? [] : recentQueries(index)), [recentMenu, index]);

  const completeQuery = (text: string, pos: number): DslCompletion | null => {
    const result = completeDsl(DSL_LEAD + text, DSL_LEAD.length + pos, { fields: fieldsRef.current, root: "search" });
    return result === null ? null : { ...result, from: result.from - DSL_LEAD.length, to: result.to - DSL_LEAD.length };
  };
  // Lucene field names: `field:` after a space or at the start.
  const completeLucene = (text: string, pos: number): DslCompletion | null => {
    const m = /[\w.@-]*$/.exec(text.slice(0, pos));
    const word = m?.[0] ?? "";
    if (word === "" || /[:"]/.test(text.slice(Math.max(0, pos - word.length - 1), pos - word.length))) {
      return null;
    }
    const items = fieldsRef.current
      .filter((f) => f.type !== "object" && f.path.toLowerCase().startsWith(word.toLowerCase()))
      .map((f) => ({ label: f.path, kind: "field" as const, detail: f.type, insert: `${f.path}:` }));
    return items.length === 0 ? null : { from: pos - word.length, to: pos, quoted: false, items };
  };

  const errorAt = (key: keyof QueryText) => (error !== null && error.key === key ? { from: error.from, to: error.to } : null);
  const invalid = (key: keyof QueryText) => (error !== null && error.key === key ? " invalid" : "");

  return (
    <div className="filter-bar mg-qbar es-qbar">
      <div className="filter-rows">
        <div className="filter-row">
          <label className="mg-qlabel">{t("검색어")}</label>
          <SearchEditor
            className={`mg-q${invalid("q")}`}
            value={query.q}
            onChange={(q) => onChange({ ...query, q })}
            onRun={onRun}
            complete={completeLucene}
            spans={() => []}
            singleLine
            placeholder={t("Lucene 검색어 (예: status:paid AND total:>100), 비우면 모든 문서")}
            error={errorAt("q")}
            ariaLabel={t("검색어")}
          />
          <button type="button" className={`mg-qbtn${dslOpen ? " active" : ""}`} aria-expanded={dslOpen} title={t("Query DSL 편집기 열기·닫기")} onClick={() => onDslOpenChange(!dslOpen)}>
            Query DSL
            {query.dsl.trim() !== "" && !dslOpen ? <span className="mg-opt-badge">1</span> : null}
            <span className="mg-chev">
              <ChevronDownIcon size={8} />
            </span>
          </button>
          <button
            type="button"
            className="mg-qbtn"
            title={t("최근 쿼리")}
            onClick={(event) => {
              const r = event.currentTarget.getBoundingClientRect();
              setRecentMenu({ x: r.left, y: r.bottom + 4 });
            }}
          >
            <HistoryIcon size={10} />
            {t("최근")}
          </button>
          <button type="button" className="mg-qbtn" title={t("쿼리 초기화")} onClick={onReset}>
            {t("초기화")}
          </button>
          <button type="button" className="mg-qbtn" title={t("이 쿼리의 실행 계획 (Profile API)")} onClick={onProfile}>
            <PlanIcon size={10} />
            {t("계획")}
          </button>
          <button type="button" className="primary mg-find" title={t("찾기 (⌘↩)")} onClick={onRun}>
            <SearchIcon size={9} />
            {t("찾기")}
            <span className="split-hint">⌘↩</span>
          </button>
        </div>
        {dslOpen ? (
          <div className="filter-row es-qdsl-row">
            <label className="mg-qlabel">DSL</label>
            <div className={`es-qdsl${invalid("dsl")}`}>
              <SearchEditor
                value={query.dsl}
                onChange={(dsl) => onChange({ ...query, dsl })}
                onRun={onRun}
                complete={completeQuery}
                placeholder={'{ "bool": { "filter": [ { "term": { "status": "paid" } } ] } }'}
                error={errorAt("dsl")}
                ariaLabel={t("Query DSL")}
              />
            </div>
          </div>
        ) : null}
        <div className="filter-row">
          <label className="mg-qlabel">{t("정렬")}</label>
          <SearchEditor
            className={`mg-q${invalid("sort")}`}
            value={query.sort}
            onChange={(sort) => onChange({ ...query, sort })}
            onRun={onRun}
            complete={(text, pos) => completeList(text, pos, fieldsRef.current, true)}
            spans={() => []}
            singleLine
            placeholder={t("필드:desc, 필드2 (비우면 점수 순)")}
            error={errorAt("sort")}
            ariaLabel={t("정렬")}
          />
          <label className="mg-qlabel">{t("필드")}</label>
          <SearchEditor
            className="mg-q"
            value={query.source}
            onChange={(source) => onChange({ ...query, source })}
            onRun={onRun}
            complete={(text, pos) => completeList(text, pos, fieldsRef.current, false)}
            spans={() => []}
            singleLine
            placeholder={t("돌려줄 필드 (예: name, price, -internal.*), 비우면 모두")}
            ariaLabel={t("돌려줄 필드 (_source)")}
          />
        </div>
      </div>
      {error !== null ? (
        <div className="mg-qerror">
          <ErrorNotice error={new Error(error.message)} context="editor" engine="elasticsearch" variant="compact" />
        </div>
      ) : null}
      {recentMenu !== null ? (
        <ContextMenu
          x={recentMenu.x}
          y={recentMenu.y}
          items={
            recent.length === 0
              ? [{ label: t("최근 쿼리가 없습니다"), disabled: true, onSelect: () => undefined }]
              : recent.map((r) => ({
                  label: [r.q, r.dsl.replace(/\s+/g, " "), r.sort && `sort ${r.sort}`, r.source && `_source ${r.source}`].filter((x) => x !== "").join(" · ").slice(0, 90) || t("모든 문서"),
                  onSelect: () => onApply(r),
                }))
          }
          onClose={() => setRecentMenu(null)}
        />
      ) : null}
    </div>
  );
}
