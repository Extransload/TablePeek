import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";

interface PromptModalProps {
  title: string;
  label: string;
  initial?: string;
  placeholder?: string;
  confirmLabel: string;
  // A message when the (trimmed) value can't be used; the dialog stays open.
  validate?(value: string): string | null;
  onSubmit(value: string): void;
  onClose(): void;
}

// One line of input with confirm and cancel: a group name, a connection URL.
export function PromptModal({
  title,
  label,
  initial = "",
  placeholder,
  confirmLabel,
  validate,
  onSubmit,
  onClose,
}: PromptModalProps) {
  const [value, setValue] = useState(initial);
  const problem = value.trim() === "" ? null : (validate?.(value.trim()) ?? null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function submit(): void {
    if (value.trim() === "" || problem !== null) {
      return;
    }
    onSubmit(value.trim());
    onClose();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal prompt-modal"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="modal-head">
          <span className="modal-title">{title}</span>
        </div>
        <label className="modal-body prompt-body">
          <span className="prompt-label">{label}</span>
          <input
            ref={inputRef}
            value={value}
            placeholder={placeholder}
            spellCheck={false}
            aria-invalid={problem !== null}
            onChange={(event) => setValue(event.target.value)}
          />
          {problem !== null ? (
            <span className="prompt-problem" role="alert">
              {problem}
            </span>
          ) : null}
        </label>
        <div className="modal-foot">
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            {t("취소")}
          </button>
          <button type="submit" className="primary" disabled={value.trim() === "" || problem !== null}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
