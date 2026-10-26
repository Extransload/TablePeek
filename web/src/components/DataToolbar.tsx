import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useMenuDismiss } from "./useMenuDismiss";
import type { DataTab } from "../tabs";
import { t } from "../i18n";
import { withHint } from "../shortcuts";
import { ColumnsIcon, FilterIcon, ListIcon, PlusIcon, RefreshIcon } from "./icons";
import { Spinner } from "./Spinner";

interface NumBoxProps {
  value: number;
  min: number;
  max?: number;
  disabled: boolean;
  title: string;
  onCommit(value: number): void;
}

function NumBox({ value, min, max, disabled, title, onCommit }: NumBoxProps) {
  const [text, setText] = useState(String(value));
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) {
      setText(String(value));
    }
  }, [value]);

  function commit(): void {
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) {
      setText(String(value));
      return;
    }
    let next = Math.trunc(parsed);
    next = Math.max(min, next);
    if (max !== undefined) {
      next = Math.min(max, next);
    }
    setText(String(next));
    if (next !== value) {
      onCommit(next);
    }
  }

  return (
    <input
      type="number"
      className="num-box"
      value={text}
      min={min}
      max={max}
      disabled={disabled}
      title={title}
      spellCheck={false}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onBlur={() => {
        focusedRef.current = false;
        commit();
      }}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
          (event.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

interface PageSizeMenuProps {
  tab: DataTab;
  running: boolean;
  counting: boolean;
  hasMeta: boolean;
  onLimit(limit: number): void;
  onOffset(offset: number): void;
  onCount(): void;
}

// LIMIT, OFFSET and an exact COUNT, kept behind the page size so the footer
// stays one quiet line.
function PageSizeMenu({ tab, running, counting, hasMeta, onLimit, onOffset, onCount }: PageSizeMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dismiss = useCallback(() => setOpen(false), []);
  useMenuDismiss(open, rootRef, dismiss);
  return (
    <div className="page-size-menu" ref={rootRef}>
      <button
        type="button"
        className={open ? "icon-button page-size-button active" : "icon-button page-size-button"}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t("가져올 행 수 (LIMIT)")}
        onClick={() => setOpen((value) => !value)}
        title={`${t("가져올 행 수 (LIMIT)")} · ${t("{count}행씩", { count: tab.pageSize.toLocaleString() })}`}
      >
        <ListIcon size={13} />
      </button>
      {open ? (
        <div className="page-size-panel" role="dialog" aria-label={t("페이지 설정")}>
          <label className="page-size" title={t("가져올 행 수 (LIMIT)")}>
            LIMIT
            <NumBox
              value={tab.pageSize}
              min={1}
              max={MAX_LIMIT}
              disabled={running}
              title="LIMIT"
              onCommit={onLimit}
            />
          </label>
          <label className="page-size" title={t("시작 행 (OFFSET)")}>
            OFFSET
            <NumBox value={tab.offset} min={0} disabled={running} title="OFFSET" onCommit={onOffset} />
          </label>
          <button
            type="button"
            disabled={running || counting || !hasMeta}
            onClick={onCount}
            title={t("정확한 총 행 수 (COUNT) 새로고침")}
          >
            {counting ? t("계산 중…") : "COUNT"}
          </button>
        </div>
      ) : null}
    </div>
  );
}

// The rows a table view holds in all, when known: counted (exact) or the
// driver's estimate.
export interface DataTotal {
  rows: number;
  exact: boolean;
}

interface DataTabToolbarProps {
  tab: DataTab;
  // The Data | Structure | Index switch, which leads the footer.
  viewTabs: ReactNode;
  // The refresh and filter shortcuts as the keymap has them, for the tooltips.
  refreshHint?: string;
  filterHint?: string;
  total: DataTotal | null;
  running: boolean;
  // The rows are on their way (a run, or an open about to start one).
  loading: boolean;
  counting: boolean;
  filterOpen: boolean;
  columnsOpen: boolean;
  // The column list, opened over its button.
  columnsPicker?: ReactNode;
  onRefresh(): void;
  onToggleFilter(): void;
  onToggleColumns(): void;
  onInsertRow(): void;
  onLimit(limit: number): void;
  onOffset(offset: number): void;
  onCount(): void;
  onPrev(): void;
  onNext(): void;
}

const MAX_LIMIT = 500000;

// "1–300 / 1,126 rows": the rows on this page and how many there are.
function rangeText(offset: number, shown: number, total: DataTotal | null): string {
  if (shown === 0 && offset === 0) {
    return t("행 없음");
  }
  const range = `${(offset + 1).toLocaleString()}–${(offset + shown).toLocaleString()}`;
  if (total === null) {
    return t("{range} / ?행", { range });
  }
  // `count` gives English its singular: "1–1 of 1 row".
  const values = { range, total: total.rows.toLocaleString(), count: total.rows };
  return total.exact ? t("{range} / {total}행", values) : t("{range} / ≈ {total}행", values);
}

// The Data view's footer, laid out as TablePlus's: the views and + Row on the
// left, where the page sits among all the rows in the middle, and filters,
// columns and paging on the right.
export function DataTabToolbar({
  tab,
  viewTabs,
  refreshHint,
  filterHint,
  total,
  running,
  loading,
  counting,
  filterOpen,
  columnsOpen,
  columnsPicker,
  onRefresh,
  onToggleFilter,
  onToggleColumns,
  onInsertRow,
  onLimit,
  onOffset,
  onCount,
  onPrev,
  onNext,
}: DataTabToolbarProps) {
  const meta = tab.meta;
  const hasMeta = meta !== undefined;
  const canInsert = hasMeta && meta.sourceTable !== null;
  const size = Math.max(1, tab.pageSize);
  const page = Math.floor(Math.max(0, tab.offset) / size) + 1;
  const pages = total !== null ? Math.max(1, Math.ceil(total.rows / size)) : null;
  const fullPage = hasMeta && (meta.rowCount >= size || meta.truncated);
  const nextEnabled =
    hasMeta && !running && (total !== null && total.exact && pages !== null ? page < pages : fullPage);
  return (
    <>
      <div className="footer-start">
        {viewTabs}
        <button
          type="button"
          className="footer-button"
          disabled={running || !canInsert}
          onClick={onInsertRow}
          title={t("새 행 추가 (변경사항 적용 시 저장)")}
        >
          <PlusIcon size={11} />
          <span className="footer-label">{t("새 행")}</span>
        </button>
      </div>
      <div className="footer-middle">
        {hasMeta ? (
          <button
            type="button"
            className="row-range"
            disabled={running || counting}
            onClick={onCount}
            title={t("정확한 행 수 세기")}
          >
            {rangeText(Math.max(0, tab.offset), meta.rowCount, total)}
            {counting ? <Spinner size={10} className="delayed-in" /> : null}
          </button>
        ) : running || loading ? (
          <span className="row-range delayed-in">{t("불러오는 중…")}</span>
        ) : null}
      </div>
      <div className="footer-end">
        <button
          type="button"
          className={filterOpen ? "footer-button active" : "footer-button"}
          onClick={onToggleFilter}
          title={withHint(t("필터 표시/숨김"), filterHint)}
        >
          <FilterIcon size={11} />
          <span className="footer-label">{t("필터")}</span>
        </button>
        <span className="footer-anchor">
          <button
            type="button"
            className={columnsOpen ? "footer-button active" : "footer-button"}
            onClick={onToggleColumns}
            title={t("컬럼 표시/숨김·순서")}
          >
            <ColumnsIcon size={11} />
            <span className="footer-label">{t("컬럼")}</span>
          </button>
          {columnsPicker}
        </span>
        <button
          type="button"
          className="icon-button"
          disabled={running}
          onClick={onRefresh}
          title={withHint(t("데이터 새로고침"), refreshHint)}
        >
          <RefreshIcon size={12} />
        </button>
        <PageSizeMenu
          tab={tab}
          running={running}
          counting={counting}
          hasMeta={hasMeta}
          onLimit={onLimit}
          onOffset={onOffset}
          onCount={onCount}
        />
        <span className="page-nav">
          <button
            type="button"
            disabled={running || !hasMeta || tab.offset === 0}
            onClick={onPrev}
            title={t("이전 페이지")}
            aria-label={t("이전 페이지")}
          >
            ‹
          </button>
          <span className="page-label" title={t("페이지")}>
            {pages === null ? page : total?.exact ? `${page} / ${pages}` : `${page} / ≈${pages}`}
          </span>
          <button
            type="button"
            disabled={!nextEnabled}
            onClick={onNext}
            title={t("다음 페이지")}
            aria-label={t("다음 페이지")}
          >
            ›
          </button>
        </span>
      </div>
    </>
  );
}
