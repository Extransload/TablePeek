import { PAGE_SIZE_OPTIONS, dataPageInfo, type DataTab } from "../tabs";
import { FilterIcon, RefreshIcon } from "./icons";

interface DataTabToolbarProps {
  tab: DataTab;
  running: boolean;
  filterOpen: boolean;
  onRefresh(): void;
  onToggleFilter(): void;
  onPageSize(size: number): void;
  onFirst(): void;
  onPrev(): void;
  onNext(): void;
}

export function DataTabToolbar({
  tab,
  running,
  filterOpen,
  onRefresh,
  onToggleFilter,
  onPageSize,
  onFirst,
  onPrev,
  onNext,
}: DataTabToolbarProps) {
  const info = dataPageInfo(tab);
  const hasMeta = tab.meta !== undefined;
  const nextEnabled = hasMeta && info.truncated && !running;
  return (
    <>
      <button
        type="button"
        className="icon-text-button"
        disabled={running}
        onClick={onRefresh}
        title="데이터 새로고침"
      >
        <RefreshIcon size={11} />
        새로고침
      </button>
      <button
        type="button"
        className={filterOpen ? "icon-text-button active" : "icon-text-button"}
        onClick={onToggleFilter}
        title="필터 표시/숨김"
      >
        <FilterIcon size={11} />
        필터
      </button>
      <label className="page-size" title="페이지 크기">
        페이지
        <select
          value={tab.pageSize}
          disabled={running}
          onChange={(event) => onPageSize(Number(event.target.value))}
        >
          {PAGE_SIZE_OPTIONS.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </label>
      <span className="toolbar-sep" />
      <button
        type="button"
        disabled={running || !hasMeta || tab.page === 0}
        onClick={onFirst}
        title="첫 페이지"
      >
        처음
      </button>
      <button
        type="button"
        disabled={running || !hasMeta || tab.page === 0}
        onClick={onPrev}
        title="이전 페이지"
      >
        이전
      </button>
      {info.pages === null ? (
        <span className="page-label dim">{`${info.page + 1} 페이지+`}</span>
      ) : (
        <span className="page-label">{`${info.page + 1} / ${info.pages} 페이지`}</span>
      )}
      <button
        type="button"
        disabled={!nextEnabled}
        onClick={onNext}
        title="다음 페이지"
      >
        다음
      </button>
      <span className="toolbar-sep" />
      <span className="row-count">
        {info.rows === null
          ? running
            ? "불러오는 중…"
            : ""
          : info.truncated
            ? `${info.rows.toLocaleString()}+행`
            : `총 ${info.rows.toLocaleString()}행`}
      </span>
    </>
  );
}
