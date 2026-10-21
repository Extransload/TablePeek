import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { Spinner } from "./Spinner";

interface PromptModalProps {
  title: string;
  label: string;
  initial?: string;
  placeholder?: string;
  confirmLabel: string;
  // A password field: the value is passed as typed, never trimmed.
  secret?: boolean;
  // A message when the (trimmed) value can't be used; the dialog stays open.
  validate?(value: string): string | null;
  // A returned message (or one resolved later) keeps the dialog open and shows it.
  onSubmit(value: string): void | string | null | Promise<void | string | null>;
  onClose(): void;
}

// One line of input with confirm and cancel: a group name, a connection URL,
// a file password.
export function PromptModal({
  title,
  label,
  initial = "",
  placeholder,
  confirmLabel,
  secret = false,
  validate,
  onSubmit,
  onClose,
}: PromptModalProps) {
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const problem = value.trim() === "" ? null : (validate?.(value.trim()) ?? null);
  const shown = problem ?? failure;
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // After a failed submit the field is enabled again: select it for a retry.
  useEffect(() => {
    if (failure !== null) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [failure]);

  // Closing waits for a submit in flight.
  function close(): void {
    if (!busy) {
      onClose();
    }
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        close();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  async function submit(): Promise<void> {
    if (value.trim() === "" || problem !== null || busy) {
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const result = await onSubmit(secret ? value : value.trim());
      if (typeof result === "string") {
        setFailure(result);
        return;
      }
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <form
        className="modal prompt-modal"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="modal-head">
          <span className="modal-title">{title}</span>
        </div>
        <label className="modal-body prompt-body">
          <span className="prompt-label">{label}</span>
          <input
            ref={inputRef}
            type={secret ? "password" : "text"}
            autoComplete={secret ? "off" : undefined}
            value={value}
            placeholder={placeholder}
            spellCheck={false}
            disabled={busy}
            aria-invalid={shown !== null}
            onChange={(event) => {
              setValue(event.target.value);
              setFailure(null);
            }}
          />
          {shown !== null ? (
            <span className="prompt-problem" role="alert">
              {shown}
            </span>
          ) : null}
        </label>
        <div className="modal-foot">
          <span className="spacer" />
          <button type="button" onClick={close} disabled={busy}>
            {t("취소")}
          </button>
          <button type="submit" className="primary" disabled={value.trim() === "" || problem !== null || busy}>
            {busy ? <Spinner size={10} /> : null}
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
