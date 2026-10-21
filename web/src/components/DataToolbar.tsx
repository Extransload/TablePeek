import { useCallback, useEffect, useRef, useState } from "react";
import { useMenuDismiss } from "./Dropdowns";
import { dataPageInfo, type DataTab } from "../tabs";
import { t } from "../i18n";
import { ColumnsIcon, FilterIcon, PlusIcon, RefreshIcon } from "./icons";

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
        className={open ? "page-size-button active" : "page-size-button"}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={t("가져올 행 수 (LIMIT)")}
      >
        {t("{count}행씩", { count: tab.pageSize.toLocaleString() })}
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

interface DataTabToolbarProps {
  tab: DataTab;
  running: boolean;
  counting: boolean;
  filterOpen: boolean;
  columnsOpen: boolean;
  onRefresh(): void;
  onToggleFilter(): void;
  onToggleColumns(): void;
  onInsertRow(): void;
  onLimit(limit: number): void;
  onOffset(offset: number): void;
  onCount(): void;
  onFirst(): void;
  onPrev(): void;
  onNext(): void;
}

const MAX_LIMIT = 500000;

export function DataTabToolbar({
  tab,
  running,
  counting,
  filterOpen,
  columnsOpen,
  onRefresh,
  onToggleFilter,
  onToggleColumns,
  onInsertRow,
  onLimit,
  onOffset,
  onCount,
  onFirst,
  onPrev,
  onNext,
}: DataTabToolbarProps) {
  const info = dataPageInfo(tab, tab.count ?? null);
  const hasMeta = tab.meta !== undefined;
  const canInsert = hasMeta && tab.meta !== undefined && tab.meta.sourceTable !== null;
  const nextEnabled =
    hasMeta &&
    !running &&
    (info.truncated ||
      (info.exact && info.pages !== null && info.page < info.pages));
  return (
    <>
      <button
        type="button"
        className="icon-button"
        disabled={running}
        onClick={onRefresh}
        title={t("데이터 새로고침")}
      >
        <RefreshIcon size={12} />
      </button>
      <button
        type="button"
        className="icon-button"
        disabled={running || !canInsert}
        onClick={onInsertRow}
        title={t("새 행 추가 (변경사항 적용 시 저장)")}
      >
        <PlusIcon size={12} />
      </button>
      <button
        type="button"
        className={filterOpen ? "icon-button active" : "icon-button"}
        onClick={onToggleFilter}
        title={t("필터 표시/숨김")}
      >
        <FilterIcon size={12} />
      </button>
      <button
        type="button"
        className={columnsOpen ? "icon-button active" : "icon-button"}
        onClick={onToggleColumns}
        title={t("컬럼 표시/숨김·순서")}
      >
        <ColumnsIcon size={12} />
      </button>
      <span className="spacer" />
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
          onClick={onFirst}
          title={t("첫 페이지")}
          aria-label={t("첫 페이지")}
        >
          «
        </button>
        <button
          type="button"
          disabled={running || !hasMeta || tab.offset === 0}
          onClick={onPrev}
          title={t("이전 페이지")}
          aria-label={t("이전 페이지")}
        >
          ‹
        </button>
        <span className="page-label">
          {info.pages === null ? `${info.page}+` : `${info.page} / ${info.pages}`}
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
      <span className="row-count">
        {info.rows === null
          ? running
            ? t("불러오는 중…")
            : ""
          : info.exact
            ? t("{count}행", { count: info.rows.toLocaleString() })
            : t("{count}+행", { count: info.rows.toLocaleString() })}
      </span>
    </>
  );
}
