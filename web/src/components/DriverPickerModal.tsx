import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { engines } from "../engines";
import { t } from "../i18n";
import { DriverIcon } from "./DriverIcon";

// Arrow keys walk the tiles in reading order.
const STEPS: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

interface DriverPickerModalProps {
  // The picked engine's id.
  onPick(kind: string): void;
  onClose(): void;
}

// A new connection starts, as in TablePlus, by picking the kind of database:
// nothing is picked until the user picks it. Double-click or Enter creates.
export function DriverPickerModal({ onPick, onClose }: DriverPickerModalProps) {
  const choices = engines();
  const [picked, setPicked] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const tileId = useId();

  useEffect(() => {
    gridRef.current?.focus();
  }, []);

  useEffect(() => {
    function onEscape(event: globalThis.KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [onClose]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const at = picked === null ? -1 : choices.findIndex((choice) => choice.id === picked);
    const step = STEPS[event.key];
    if (step !== undefined) {
      event.preventDefault();
      const next = at < 0 ? 0 : Math.min(choices.length - 1, Math.max(0, at + step));
      setPicked(choices[next].id);
    } else if (event.key === "Enter" && picked !== null) {
      event.preventDefault();
      // A held Enter mustn't run on into the form that opens next.
      if (!event.repeat) {
        onPick(picked);
      }
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal driver-picker"
        role="dialog"
        aria-label={t("새 연결")}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-title">{t("새 연결")}</span>
        </div>
        <div className="modal-body">
          <p className="driver-picker-hint">{t("연결할 데이터베이스 종류를 고르세요")}</p>
          <div
            ref={gridRef}
            className="driver-grid"
            role="listbox"
            aria-label={t("데이터베이스 종류")}
            aria-activedescendant={picked !== null ? `${tileId}-${picked}` : undefined}
            tabIndex={0}
            onKeyDown={onKeyDown}
          >
            {choices.map((choice) => (
              <button
                type="button"
                key={choice.id}
                id={`${tileId}-${choice.id}`}
                role="option"
                aria-selected={picked === choice.id}
                tabIndex={-1}
                className={`driver-tile${picked === choice.id ? " selected" : ""}`}
                onClick={() => {
                  setPicked(choice.id);
                  // The list keeps the focus, and with it the keys and the ring.
                  gridRef.current?.focus();
                }}
                onDoubleClick={() => onPick(choice.id)}
              >
                <DriverIcon kind={choice.id} size={40} />
                <span className="driver-tile-name">{choice.label}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            {t("취소")}
          </button>
          <button
            type="button"
            className="primary"
            disabled={picked === null}
            onClick={() => {
              if (picked !== null) {
                onPick(picked);
              }
            }}
          >
            {t("만들기")}
          </button>
        </div>
      </div>
    </div>
  );
}
