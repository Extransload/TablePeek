import { useEffect, useRef, useState } from "react";
import { dataPageInfo, type DataTab } from "../tabs";
import { t } from "../i18n";
import { ColumnsIcon, DownloadIcon, FilterIcon, PanelIcon, PlusIcon, RefreshIcon } from "./icons";

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
  detailOpen: boolean;
  canDetail: boolean;
  onDetail(): void;
  onExport(): void;
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
  detailOpen,
  canDetail,
  onDetail,
  onExport,
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
        className="icon-text-button"
        disabled={running}
        onClick={onRefresh}
        title={t("데이터 새로고침")}
      >
        <RefreshIcon size={11} />
        {t("새로고침")}
      </button>
      <button
        type="button"
        className="icon-text-button"
        disabled={running || !canInsert}
        onClick={onInsertRow}
        title={t("행 추가 (기본값)")}
      >
        <PlusIcon size={11} />
        {t("행 추가")}
      </button>
      <button
        type="button"
        className={filterOpen ? "icon-text-button active" : "icon-text-button"}
        onClick={onToggleFilter}
        title={t("필터 표시/숨김")}
      >
        <FilterIcon size={11} />
        {t("필터")}
      </button>
      <button
        type="button"
        className={columnsOpen ? "icon-text-button active" : "icon-text-button"}
        onClick={onToggleColumns}
        title={t("컬럼 표시/숨김·순서")}
      >
        <ColumnsIcon size={11} />
        {t("컬럼")}
      </button>
      <span className="toolbar-sep" />
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
        <NumBox
          value={tab.offset}
          min={0}
          disabled={running}
          title="OFFSET"
          onCommit={onOffset}
        />
      </label>
      <button
        type="button"
        className="icon-text-button"
        disabled={running || counting || !hasMeta}
        onClick={onCount}
        title={t("정확한 총 행 수 (COUNT) 새로고침")}
      >
        {counting ? t("계산 중…") : "COUNT"}
      </button>
      <span className="toolbar-sep" />
      <button
        type="button"
        disabled={running || !hasMeta || tab.offset === 0}
        onClick={onFirst}
        title={t("첫 페이지")}
      >
        {t("처음")}
      </button>
      <button
        type="button"
        disabled={running || !hasMeta || tab.offset === 0}
        onClick={onPrev}
        title={t("이전 페이지")}
      >
        {t("이전")}
      </button>
      {info.pages === null ? (
        <span className="page-label dim">{t("{page} 페이지+", { page: info.page })}</span>
      ) : (
        <span className="page-label">{t("{page} / {pages} 페이지", { page: info.page, pages: info.pages })}</span>
      )}
      <button type="button" disabled={!nextEnabled} onClick={onNext} title={t("다음 페이지")}>
        {t("다음")}
      </button>
      <span className="spacer" />
      <span className="row-count">
        {info.rows === null
          ? running
            ? t("불러오는 중…")
            : ""
          : info.exact
            ? t("총 {count}행", { count: info.rows.toLocaleString() })
            : t("{count}+행", { count: info.rows.toLocaleString() })}
      </span>
      <span className="toolbar-sep" />
      <button
        type="button"
        className={`icon-button${detailOpen ? " active" : ""}`}
        disabled={!canDetail}
        onClick={onDetail}
        title={t("행 상세 패널")}
      >
        <PanelIcon size={11} />
      </button>
      <button
        type="button"
        className="icon-button"
        disabled={!canDetail}
        onClick={onExport}
        title={t("결과 내보내기")}
      >
        <DownloadIcon size={11} />
      </button>
    </>
  );
}
