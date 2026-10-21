import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";

interface PromptModalProps {
  title: string;
  label: string;
  initial?: string;
  placeholder?: string;
  confirmLabel: string;
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
  onSubmit,
  onClose,
}: PromptModalProps) {
  const [value, setValue] = useState(initial);
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
    if (value.trim() === "") {
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
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        <div className="modal-foot">
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            {t("취소")}
          </button>
          <button type="submit" className="primary" disabled={value.trim() === ""}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
