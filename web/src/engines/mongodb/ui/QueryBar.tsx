// The collection tab's query bar (MONGODB.md §3.2): a one-line filter with
// completion, 옵션 for projection · sort · skip · limit, ⌘↩ 찾기, 초기화,
// recent runs and favourites per collection (kept in localStorage), the
// sampled field list, and 계획 for the explain tab.

import { useCallback, useId, useRef, useState } from "react";
import { FieldError, fieldErrorProps } from "../../../components/ErrorNotice";
import { ChevronDownIcon, ColumnsIcon, HistoryIcon, SearchIcon, StarIcon } from "../../../components/icons";
import { useMenuDismiss } from "../../../components/useMenuDismiss";
import { t } from "../../../i18n";
import { isDocument, type BsonDocument } from "../bson";
import type { CompletionContext, FieldStat } from "../complete";
import { shellKey, toShell } from "../format";
import { parseFilter, parseValue } from "../shell/parse";
import { PlanIcon } from "./icons";
import { MongoEditor } from "./MongoEditor";
import { ShellText } from "./ShellText";
import type { DocQuery } from "./types";

// The boxes as typed.
export interface QueryText {
  filter: string;
  projection: string;
  sort: string;
  skip: string;
  limit: string;
}

export type QueryKey = keyof QueryText;

export const EMPTY_QUERY: QueryText = { filter: "", projection: "", sort: "", skip: "", limit: "" };

export interface QueryError {
  key: QueryKey;
  message: string;
  // Position inside that box, for the underline.
  range: { from: number; to: number } | null;
}

const LABELS: Record<QueryKey, string> = { filter: "필터", projection: "프로젝션", sort: "정렬", skip: "건너뛰기", limit: "개수" };

// The boxes read as a query; `limit` 0 means none. Blank boxes are null.
export function parseQuery(q: QueryText): { ok: true; value: DocQuery } | { ok: false; error: QueryError } {
  const filter = parseFilter(q.filter);
  if (!filter.ok) {
    return { ok: false, error: { key: "filter", message: `${t(LABELS.filter)}: ${filter.error.message}`, range: { from: filter.error.from, to: filter.error.to } } };
  }
  const docs: Partial<Record<"projection" | "sort", BsonDocument | null>> = {};
  for (const key of ["projection", "sort"] as const) {
    const text = q[key];
    if (text.trim() === "") {
      docs[key] = null;
      continue;
    }
    const r = parseValue(text);
    if (!r.ok) {
      return { ok: false, error: { key, message: `${t(LABELS[key])}: ${r.error.message}`, range: { from: r.error.from, to: r.error.to } } };
    }
    if (!isDocument(r.value)) {
      return { ok: false, error: { key, message: t("{label}은(는) { … } 문서여야 합니다", { label: t(LABELS[key]) }), range: null } };
    }
    docs[key] = Object.keys(r.value).length === 0 ? null : r.value;
  }
  const numbers: Record<"skip" | "limit", number> = { skip: 0, limit: 0 };
  for (const key of ["skip", "limit"] as const) {
    const text = q[key].trim();
    if (text === "") {
      continue;
    }
    const n = Number(text);
    if (!Number.isInteger(n) || n < 0) {
      return { ok: false, error: { key, message: t("{label}: 0 이상의 정수를 쓰세요", { label: t(LABELS[key]) }), range: null } };
    }
    numbers[key] = n;
  }
  return { ok: true, value: { filter: filter.value, projection: docs.projection ?? null, sort: docs.sort ?? null, skip: numbers.skip, limit: numbers.limit } };
}

// One line of mongosh for a query (history, tooltips).
export function queryText(q: QueryText): string {
  let out = q.filter.trim() || "{}";
  if (q.projection.trim()) out += `, ${q.projection.trim()}`;
  if (q.sort.trim()) out += ` · sort ${q.sort.trim()}`;
  if (q.skip.trim()) out += ` · skip ${q.skip.trim()}`;
  if (q.limit.trim()) out += ` · limit ${q.limit.trim()}`;
  return out;
}

// ---- Recent runs and favourites ----

const STORE_KEY = "tablepeek.mongo.queries";
const RECENT_CAP = 30;

interface SavedQuery {
  q: QueryText;
  at: number;
}

interface QueryShelf {
  recent: SavedQuery[];
  fav: SavedQuery[];
}

function readShelves(): Record<string, QueryShelf> {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(STORE_KEY) ?? "{}");
    return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, QueryShelf>) : {};
  } catch {
    return {};
  }
}

function shelfOf(ns: string): QueryShelf {
  const shelf = readShelves()[ns];
  return { recent: Array.isArray(shelf?.recent) ? shelf.recent : [], fav: Array.isArray(shelf?.fav) ? shelf.fav : [] };
}

function writeShelf(ns: string, shelf: QueryShelf): void {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify({ ...readShelves(), [ns]: shelf }));
  } catch {
    // Not remembered; the query still ran.
  }
}

const sameQuery = (a: QueryText, b: QueryText) => (Object.keys(EMPTY_QUERY) as QueryKey[]).every((k) => a[k].trim() === b[k].trim());

// Puts a run query first in the collection's recent list.
export function recordQuery(ns: string, q: QueryText): void {
  const shelf = shelfOf(ns);
  writeShelf(ns, { ...shelf, recent: [{ q, at: Date.now() }, ...shelf.recent.filter((x) => !sameQuery(x.q, q))].slice(0, RECENT_CAP) });
}

function stamp(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---- The bar ----

interface QueryBarProps {
  // `db.coll`, the key recent runs and favourites are kept under.
  ns: string;
  query: QueryText;
  onChange(query: QueryText): void;
  optsOpen: boolean;
  onOptsOpenChange(open: boolean): void;
  error: QueryError | null;
  completion(): CompletionContext;
  fields: FieldStat[];
  onRun(): void;
  // Runs `query` right away (reset, history pick, a field added).
  onApply(query: QueryText): void;
  onExplain(): void;
}

export function QueryBar({ ns, query, onChange, optsOpen, onOptsOpenChange, error, completion, fields, onRun, onApply, onExplain }: QueryBarProps) {
  const [popover, setPopover] = useState<"history" | "fields" | null>(null);
  const [shelf, setShelf] = useState<QueryShelf>(() => shelfOf(ns));
  const [fieldSearch, setFieldSearch] = useState("");
  const popRef = useRef<HTMLDivElement | null>(null);
  const closePopover = useCallback(() => setPopover(null), []);
  useMenuDismiss(popover !== null, popRef, closePopover);

  const queryRef = useRef(query);
  queryRef.current = query;
  const set = (key: QueryKey, value: string) => onChange({ ...queryRef.current, [key]: value });
  const optCount = (["projection", "sort", "skip", "limit"] as const).filter((k) => query[k].trim() !== "").length;
  const invalid = (key: QueryKey) => (error?.key === key ? " invalid" : "");
  const errorId = useId();

  const isFav = (q: QueryText) => shelf.fav.some((f) => sameQuery(f.q, q));
  const toggleFav = (q: QueryText) => {
    const next = isFav(q) ? { ...shelf, fav: shelf.fav.filter((f) => !sameQuery(f.q, q)) } : { ...shelf, fav: [{ q, at: Date.now() }, ...shelf.fav] };
    writeShelf(ns, next);
    setShelf(next);
  };

  // `path: ` at the end of the filter, braces added when it is empty.
  const insertField = (path: string) => {
    const k = shellKey(path);
    const v = query.filter.trim();
    const filter = v === "" || v === "{}" ? `{ ${k}:  }` : `${v.slice(0, v.lastIndexOf("}")).replace(/\s*$/, "")}${/\{\s*$/.test(v.slice(0, v.lastIndexOf("}"))) ? " " : ", "}${k}:  }`;
    onChange({ ...query, filter });
    setPopover(null);
  };

  const historyItem = (item: SavedQuery, i: number) => (
    <div
      key={i}
      className="mg-hist-item"
      role="button"
      tabIndex={0}
      onClick={() => {
        setPopover(null);
        onApply(item.q);
      }}
    >
      <div className="mg-hist-text mono">
        <ShellText text={queryText(item.q)} />
      </div>
      <div className="mg-hist-meta">{stamp(item.at)}</div>
      <button
        type="button"
        className={`mg-star${isFav(item.q) ? " on" : ""}`}
        title={isFav(item.q) ? t("즐겨찾기에서 빼기") : t("즐겨찾기")}
        onClick={(event) => {
          event.stopPropagation();
          toggleFav(item.q);
        }}
      >
        <StarIcon size={10} />
      </button>
    </div>
  );

  const shownFields = fields.filter((f) => fieldSearch.trim() === "" || f.path.toLowerCase().includes(fieldSearch.trim().toLowerCase()));

  return (
    <div className="filter-bar mg-qbar">
      <div className="filter-rows">
        <div className="filter-row">
          <div className="mg-pop-anchor" ref={popover !== null ? popRef : undefined}>
            <button
              type="button"
              className={`icon-button mg-qicon${popover === "history" ? " active" : ""}`}
              title={t("쿼리 기록·즐겨찾기")}
              aria-label={t("쿼리 기록·즐겨찾기")}
              onClick={(event) => {
                event.stopPropagation();
                setShelf(shelfOf(ns));
                setPopover(popover === "history" ? null : "history");
              }}
            >
              <HistoryIcon size={11} />
            </button>
            {popover === "history" ? (
              <div className="menu-panel mg-popover mg-hist-pop" onClick={(event) => event.stopPropagation()}>
                <div className="mg-hist-head">
                  <span>{t("즐겨찾기")}</span>
                  <span className="spacer" />
                  <button type="button" className="mg-hist-save" onClick={() => !isFav(query) && toggleFav(query)}>
                    <StarIcon size={10} />
                    {t("지금 쿼리 즐겨찾기")}
                  </button>
                </div>
                {shelf.fav.length === 0 ? <div className="mg-hist-empty">{t("아직 없습니다")}</div> : shelf.fav.map(historyItem)}
                <div className="mg-hist-head">
                  <span>{t("최근 실행")}</span>
                  <span className="spacer" />
                  <span className="panel-dim">{t("{count}개", { count: shelf.recent.length })}</span>
                </div>
                {shelf.recent.length === 0 ? <div className="mg-hist-empty">{t("찾기(⌘↩)를 누르면 여기에 쌓입니다")}</div> : shelf.recent.map(historyItem)}
              </div>
            ) : null}
            {popover === "fields" ? (
              <div className="menu-panel mg-popover mg-fieldpop-wrap" onClick={(event) => event.stopPropagation()}>
                <div className="mg-hist-head">
                  <span>{t("필드 {count}개", { count: fields.length })}</span>
                  <span className="spacer" />
                  <span className="panel-dim">{t("이 페이지 문서에서")}</span>
                </div>
                <input className="mg-pop-search" placeholder={t("필드 검색…")} spellCheck={false} autoFocus value={fieldSearch} onChange={(event) => setFieldSearch(event.target.value)} />
                <div className="mg-fieldpop-list">
                  {shownFields.map((f) => (
                    <div key={f.path} className="mg-fieldpop-row" role="button" tabIndex={0} style={{ paddingLeft: 8 + f.depth * 12 }} title={t("{path} — 필터에 넣기", { path: f.path })} onClick={() => insertField(f.path)}>
                      <span className="mg-fieldpop-name mono">{f.path}</span>
                      <span className="mg-field-types">
                        {f.types.slice(0, 2).map((x) => (
                          <span key={x.type} className={`mg-type t-${x.type}`}>
                            {x.type}
                          </span>
                        ))}
                      </span>
                      <span className="mg-presence">
                        <span className="mg-bar">
                          <span style={{ width: `${Math.max(2, f.presence * 100)}%` }} />
                        </span>
                        <span className="mg-pct">{Math.round(f.presence * 100)}%</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
          <label className="mg-qlabel">{t("필터")}</label>
          <MongoEditor
            className={`mg-q${invalid("filter")}`}
            singleLine
            value={query.filter}
            onChange={(text) => set("filter", text)}
            onRun={onRun}
            role="filter"
            completion={completion}
            placeholder={t("{ 필드: 값 }   ⌘↩ 찾기 · Ctrl+Space 자동 완성")}
            error={error?.key === "filter" ? error.range : null}
            ariaLabel={t("필터")}
          />
          <button
            type="button"
            className={`mg-qbtn${popover === "fields" ? " active" : ""}`}
            title={t("필드 목록 — 누르면 필터에 넣습니다")}
            onClick={(event) => {
              event.stopPropagation();
              setFieldSearch("");
              setPopover(popover === "fields" ? null : "fields");
            }}
          >
            <ColumnsIcon size={10} />
            {t("필드")}
          </button>
          <button type="button" className={`mg-qbtn${optsOpen ? " active" : ""}`} title={t("프로젝션·정렬·건너뛰기·개수")} onClick={() => onOptsOpenChange(!optsOpen)} aria-expanded={optsOpen}>
            {t("옵션")}
            {optCount > 0 ? <span className="mg-opt-badge">{optCount}</span> : null}
            <span className="mg-chev">
              <ChevronDownIcon size={8} />
            </span>
          </button>
          <button type="button" className="mg-qbtn" title={t("쿼리 초기화")} onClick={() => onApply(EMPTY_QUERY)}>
            {t("초기화")}
          </button>
          <button type="button" className="mg-qbtn" title={t("이 쿼리의 실행 계획")} onClick={onExplain}>
            <PlanIcon size={10} />
            {t("계획")}
          </button>
          <button type="button" className="primary mg-find" title={t("찾기 (⌘↩)")} onClick={onRun}>
            <SearchIcon size={9} />
            {t("찾기")}
            <span className="split-hint">⌘↩</span>
          </button>
        </div>
        {optsOpen ? (
          <div className="filter-row mg-opts">
            <label className="mg-qlabel">{t("프로젝션")}</label>
            <MongoEditor className={`mg-q${invalid("projection")}`} singleLine value={query.projection} onChange={(text) => set("projection", text)} onRun={onRun} role="projection" completion={completion} placeholder="{ 필드: 1 }" error={error?.key === "projection" ? error.range : null} ariaLabel={t("프로젝션")} />
            <label className="mg-qlabel">{t("정렬")}</label>
            <MongoEditor className={`mg-q${invalid("sort")}`} singleLine value={query.sort} onChange={(text) => set("sort", text)} onRun={onRun} role="sort" completion={completion} placeholder="{ 필드: -1 }" error={error?.key === "sort" ? error.range : null} ariaLabel={t("정렬")} />
            <label className="mg-qlabel">{t("건너뛰기")}</label>
            <input
              className={`filter-value mg-q-num${invalid("skip")}`}
              {...fieldErrorProps(errorId, error?.key === "skip" ? error.message : null)}
              value={query.skip}
              placeholder="0"
              inputMode="numeric"
              spellCheck={false}
              aria-label={t("건너뛰기")}
              onChange={(event) => set("skip", event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && onRun()}
            />
            <label className="mg-qlabel">{t("개수")}</label>
            <input
              className={`filter-value mg-q-num${invalid("limit")}`}
              {...fieldErrorProps(errorId, error?.key === "limit" ? error.message : null)}
              value={query.limit}
              placeholder={t("없음")}
              inputMode="numeric"
              spellCheck={false}
              aria-label={t("개수")}
              onChange={(event) => set("limit", event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && onRun()}
            />
          </div>
        ) : null}
      </div>
      {/* Over what is below the bar, so the cards do not move. */}
      <div className={`mg-qerror${error !== null ? " on" : ""}`}>
        <FieldError id={errorId} error={error?.message ?? null} />
      </div>
    </div>
  );
}

// A filter that adds `path: value` (replacing the same path), for "이 값으로
// 필터" style actions.
export function withFilterValue(filterText: string, path: string, value: BsonDocument[string]): string {
  const r = parseFilter(filterText);
  const filter: BsonDocument = r.ok ? { ...r.value } : {};
  filter[path] = value;
  return toShell(filter);
}
