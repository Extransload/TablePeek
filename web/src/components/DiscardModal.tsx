import { useEffect, useRef } from "react";
import { t } from "../i18n";

interface DiscardModalProps {
  // The apply shortcut as the keymap spells it, e.g. "⌘S".
  applyHint: string;
  onDiscard(): void;
  onCancel(): void;
}

// TablePlus's warning before staged changes are thrown away (a refresh, a
// closed tab, another page). Cancel has the focus, so Return keeps the changes.
export function DiscardModal({ applyHint, onDiscard, onCancel }: DiscardModalProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const discardRef = useRef<HTMLButtonElement | null>(null);

  // Focus goes back where it was (the grid, say) once the answer is in.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancelRef.current?.focus();
    return () => before?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      } else if (event.key === "Tab") {
        // Tab moves between the two answers only.
        event.preventDefault();
        (document.activeElement === cancelRef.current ? discardRef : cancelRef).current?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal alert-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="discard-title"
        aria-describedby="discard-message"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="alert-title" id="discard-title">
          {t("경고")}
        </h2>
        <p className="alert-message" id="discard-message">
          {t("변경 사항을 모두 버릴까요?\n팁: 변경 사항은 이렇게 반영할 수 있습니다.\n1. {shortcut}\n2. 변경 표시줄의 '변경사항 적용' 버튼", {
            shortcut: applyHint,
          })}
        </p>
        <div className="alert-actions">
          <button type="button" ref={cancelRef} onClick={onCancel}>
            {t("취소")}
          </button>
          <button type="button" ref={discardRef} onClick={onDiscard}>
            {t("버리기")}
          </button>
        </div>
      </div>
    </div>
  );
}
