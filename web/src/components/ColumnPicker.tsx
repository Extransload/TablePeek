import { useEffect, useRef } from "react";
import { t } from "../i18n";
import { UpIcon } from "./icons";

export interface ColumnEntry {
  name: string;
  visible: boolean;
  pk: boolean;
}

interface ColumnPickerProps {
  columns: ColumnEntry[];
  onToggle(name: string): void;
  onMove(name: string, delta: -1 | 1): void;
  onAll(): void;
  onReset(): void;
  onClose(): void;
}

export function ColumnPicker({
  columns,
  onToggle,
  onMove,
  onAll,
  onReset,
  onClose,
}: ColumnPickerProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onPointerDown(event: PointerEvent): void {
      const root = rootRef.current;
      if (root && !root.contains(event.target as Node)) {
        onClose();
      }
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
      }
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div className="column-picker" ref={rootRef}>
      <div className="column-picker-head">
        <span>{t("컬럼 표시·순서")}</span>
        <span className="spacer" />
        <button type="button" className="link-button" onClick={onAll}>
          {t("모두 표시")}
        </button>
        <button type="button" className="link-button" onClick={onReset}>
          {t("초기화")}
        </button>
      </div>
      <div className="column-picker-list">
        {columns.length === 0 ? (
          <div className="column-picker-empty">{t("컬럼 정보가 없습니다")}</div>
        ) : (
          columns.map((column, index) => (
            <div className={column.visible ? "column-picker-row" : "column-picker-row off"} key={column.name}>
              <button
                type="button"
                className="column-picker-move"
                title={t("위로")}
                disabled={index === 0}
                onClick={() => onMove(column.name, -1)}
              >
                <UpIcon size={10} />
              </button>
              <button
                type="button"
                className="column-picker-move down"
                title={t("아래로")}
                disabled={index === columns.length - 1}
                onClick={() => onMove(column.name, 1)}
              >
                <UpIcon size={10} />
              </button>
              <label className="column-picker-label">
                <input
                  type="checkbox"
                  checked={column.visible}
                  onChange={() => onToggle(column.name)}
                />
                <span className="column-picker-name" title={column.name}>
                  {column.name}
                </span>
                {column.pk ? <span className="column-picker-pk">PK</span> : null}
              </label>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
