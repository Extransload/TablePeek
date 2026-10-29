import { useEffect, useId, useRef, useState } from "react";
import { t } from "../i18n";
import { FieldError, fieldErrorProps } from "./ErrorNotice";
import { EyeIcon, EyeOffIcon } from "./icons";
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
  const [reveal, setReveal] = useState(false);
  const fieldId = useId();
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

  // Esc closes this dialog only, not the one under it.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
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
        <div className="modal-body prompt-body">
          <label className="prompt-label" htmlFor={`${fieldId}-input`}>
            {label}
          </label>
          <span className="cm-input-wrap">
            <input
              id={`${fieldId}-input`}
              ref={inputRef}
              type={secret && !reveal ? "password" : "text"}
              autoComplete={secret ? "new-password" : undefined}
              value={value}
              placeholder={placeholder}
              spellCheck={false}
              disabled={busy}
              {...fieldErrorProps(fieldId, shown)}
              onChange={(event) => {
                setValue(event.target.value);
                setFailure(null);
              }}
            />
            {secret ? (
              <button
                type="button"
                className="cm-eye"
                onClick={() => setReveal((now) => !now)}
                title={reveal ? t("비밀번호 숨기기") : t("비밀번호 보기")}
                aria-label={reveal ? t("비밀번호 숨기기") : t("비밀번호 보기")}
              >
                {reveal ? <EyeOffIcon size={11} /> : <EyeIcon size={11} />}
              </button>
            ) : null}
          </span>
          <FieldError id={fieldId} error={shown} />
        </div>
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
