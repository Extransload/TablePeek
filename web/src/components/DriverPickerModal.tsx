import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { t } from "../i18n";
import type { Driver } from "../store";
import { DriverIcon } from "./DriverIcon";

export type DriverChoice = Driver | "sqlite";

// Arrow keys walk the tiles in reading order.
const STEPS: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

const CHOICES: { kind: DriverChoice; label: string }[] = [
  { kind: "postgres", label: "PostgreSQL" },
  { kind: "mysql", label: "MySQL" },
  { kind: "mssql", label: "SQL Server" },
  { kind: "cockroach", label: "CockroachDB" },
  { kind: "sqlite", label: "SQLite" },
];

interface DriverPickerModalProps {
  onPick(kind: DriverChoice): void;
  onClose(): void;
}

// A new connection starts, as in TablePlus, by picking the kind of database:
// nothing is picked until the user picks it. Double-click or Enter creates.
export function DriverPickerModal({ onPick, onClose }: DriverPickerModalProps) {
  const [picked, setPicked] = useState<DriverChoice | null>(null);
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
    const at = picked === null ? -1 : CHOICES.findIndex((choice) => choice.kind === picked);
    const step = STEPS[event.key];
    if (step !== undefined) {
      event.preventDefault();
      const next = at < 0 ? 0 : Math.min(CHOICES.length - 1, Math.max(0, at + step));
      setPicked(CHOICES[next].kind);
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
            {CHOICES.map((choice) => (
              <button
                type="button"
                key={choice.kind}
                id={`${tileId}-${choice.kind}`}
                role="option"
                aria-selected={picked === choice.kind}
                tabIndex={-1}
                className={`driver-tile${picked === choice.kind ? " selected" : ""}`}
                onClick={() => {
                  setPicked(choice.kind);
                  // The list keeps the focus, and with it the keys and the ring.
                  gridRef.current?.focus();
                }}
                onDoubleClick={() => onPick(choice.kind)}
              >
                <DriverIcon kind={choice.kind} size={40} />
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
