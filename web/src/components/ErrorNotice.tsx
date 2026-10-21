import { useEffect, useMemo, useState, type ReactNode } from "react";
import { writeClipboard } from "../clipboard";
import { explainError, type ErrorHelp } from "../errorHelp";
import { t } from "../i18n";
import { AlertIcon, CheckIcon, CloseIcon, CopyIcon } from "./icons";

interface ErrorNoticeProps {
  message: string;
  // API error code, when the error came from the TablePeek server.
  code?: string;
  variant?: "block" | "compact" | "toast";
  // Buttons that apply the explanation's suggested fix, if the caller can.
  renderActions?(help: ErrorHelp): ReactNode;
  onClose?(): void;
}

// An error explained: what happened, why, and what to try, with the original
// message one click away. Unrecognized errors show the message as is.
export function ErrorNotice({
  message,
  code,
  variant = "block",
  renderActions,
  onClose,
}: ErrorNoticeProps) {
  const help = useMemo(() => explainError(message, code), [message, code]);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const close =
    onClose !== undefined ? (
      <button type="button" className="icon-button error-notice-close" onClick={onClose} title={t("닫기")}>
        <CloseIcon size={10} />
      </button>
    ) : null;

  if (help === null) {
    return (
      <div className={`error-notice ${variant} plain`} role="alert">
        <div className="error-notice-head">
          <AlertIcon size={11} className="error-notice-icon" />
          <span className="error-notice-message">{message}</span>
          {close}
        </div>
      </div>
    );
  }

  const actions = renderActions?.(help) ?? null;
  return (
    <div className={`error-notice ${variant}`} role="alert">
      <div className="error-notice-head">
        <AlertIcon size={11} className="error-notice-icon" />
        <strong className="error-notice-title">{help.title}</strong>
        {close}
      </div>
      {help.cause !== undefined ? <p className="error-notice-cause">{help.cause}</p> : null}
      {help.fixes.length > 0 ? (
        <div className="error-notice-fixes">
          <span className="error-notice-label">{t("이렇게 해 보세요")}</span>
          <ul>
            {help.fixes.map((fix) => (
              <li key={fix}>{fix}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {actions !== null ? <div className="error-notice-actions">{actions}</div> : null}
      <details className="error-notice-raw">
        <summary>{t("원래 오류 메시지")}</summary>
        <div className="error-notice-raw-body">
          <pre className="mono">{message}</pre>
          <button
            type="button"
            className="icon-button"
            title={t("오류 메시지 복사")}
            onClick={() => {
              let failed = false;
              void writeClipboard(message, () => {
                failed = true;
              }).then(() => setCopied(!failed));
            }}
          >
            {copied ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
          </button>
        </div>
      </details>
    </div>
  );
}
