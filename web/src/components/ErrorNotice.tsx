import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { writeClipboard } from "../clipboard";
import {
  explainError,
  isAppServerDown,
  toAppError,
  type AppError,
  type ErrorAction,
  type ErrorContext,
} from "../errorHelp";
import { getLanguage, t, tServer } from "../i18n";
import { AlertIcon, CheckIcon, CloseIcon, CopyIcon } from "./icons";

// Every error the app shows goes through here (docs/ERRORS.md §3): a box
// (ErrorNotice), a line under a field (FieldError), or a toast (notifyError).

interface ErrorNoticeProps {
  // A message, a server error, or anything thrown.
  error: unknown;
  // Where it shows, so the explanation offers only fixes that fit there.
  context?: ErrorContext;
  // The engine, when the error may not name it (a connect attempt).
  engine?: string;
  // block: panels and dialogs; compact: narrow places; banner: a strip laid
  // over a grid or result, one line until "자세히" opens.
  variant?: "block" | "compact" | "banner";
  onRetry?(): void;
  // One-click fixes this screen can apply; the explanation's suggested one
  // gets a button when it is here.
  onFix?: Partial<Record<ErrorAction, () => void>>;
  // The caller's own buttons.
  actions?: ReactNode;
  onClose?(): void;
}

const ACTION_LABELS: Record<ErrorAction, string> = {
  "ssl-off": "SSL 끄고 다시 테스트",
  "ssl-on": "SSL ‘필수’로 바꾸고 다시 테스트",
  "direct-connection": "직접 연결 켜고 다시 테스트",
  "open-validation": "검증 탭 열기",
  "refresh-schema": "스키마 새로고침",
};

// A one-line title never runs on: the whole text is in "자세히".
const TITLE_LIMIT = 200;

function positionText(position: NonNullable<AppError["position"]>): string {
  if (position.line !== undefined) {
    return position.column !== undefined
      ? t("{line}번째 줄 {column}번째 칸", { line: position.line, column: position.column })
      : t("{line}번째 줄", { line: position.line });
  }
  return position.offset !== undefined ? t("{offset}번째 글자", { offset: position.offset }) : "";
}

// The error's codes as "label: value" rows: the server code, SQLSTATE, the
// engine's number and name, and where in the statement.
function codeRows(error: AppError): [string, string][] {
  const rows: [string, string][] = [];
  if (error.code !== "") {
    rows.push([t("코드"), error.code]);
  }
  if (error.sqlstate !== undefined) {
    rows.push(["SQLSTATE", error.sqlstate]);
  }
  if (error.server_code !== undefined || error.code_name !== undefined) {
    rows.push([
      t("서버 오류 번호"),
      [error.server_code, error.code_name].filter((part) => part !== undefined).join(" · "),
    ]);
  }
  const where = error.position !== undefined ? positionText(error.position) : "";
  if (where !== "") {
    rows.push([t("위치"), where]);
  }
  return rows;
}

function detailsText(details: unknown): string {
  if (details === undefined) {
    return "";
  }
  try {
    return JSON.stringify(details, null, 2);
  } catch {
    return String(details);
  }
}

// An error explained: what happened, why, and what to try, with the codes
// and the original text one click away. An error no rule explains shows its
// first line as the title and folds the rest.
export function ErrorNotice({
  error,
  context = "general",
  engine,
  variant = "block",
  onRetry,
  onFix,
  actions,
  onClose,
}: ErrorNoticeProps) {
  // Written again after a language switch (a phrased error, the explanation).
  const language = getLanguage();
  const appError = useMemo(() => toAppError(error), [error, language]);
  const help = useMemo(() => explainError(appError, context, engine), [appError, context, engine]);
  // The copy button's last outcome, shown for a moment.
  const [copy, setCopy] = useState<"done" | "failed" | null>(null);

  useEffect(() => {
    if (copy === null) {
      return;
    }
    const timer = window.setTimeout(() => setCopy(null), 1500);
    return () => window.clearTimeout(timer);
  }, [copy]);

  // The app's connection banner says this once for the whole window.
  if (isAppServerDown(appError)) {
    return null;
  }

  const message = tServer(appError.message);
  const original = appError.raw ?? message;
  const firstLine = message.trim().split("\n")[0] ?? "";
  const title =
    help?.title ?? (firstLine.length > TITLE_LIMIT ? `${firstLine.slice(0, TITLE_LIMIT - 1)}…` : firstLine);
  const rows = codeRows(appError);
  const extra = detailsText(appError.details);
  const hasDetails = help !== null || rows.length > 0 || extra !== "" || original.trim() !== title;
  const fix = help?.action !== undefined ? onFix?.[help.action] : undefined;
  const undo = appError.undo;
  const undoLines =
    undo === undefined
      ? []
      : [
          ...undo.undone.map((change) => `${t("되돌림")}: ${change}`),
          ...undo.left.map((entry) => `${t("남음")}: ${entry.change} — ${tServer(entry.reason)}`),
        ];
  const copyText = [title, help?.cause, ...undoLines, ...rows.map(([label, value]) => `${label}: ${value}`), original, extra]
    .filter((part) => part !== undefined && part !== "")
    .join("\n");

  // What a transaction-less apply took back after the failure, and what is
  // left as it was written: always in view, every variant.
  const undoReport =
    undo !== undefined ? (
      <div className={undo.left.length === 0 ? "error-notice-undo" : "error-notice-undo partial"}>
        <span className="error-notice-label">
          {undo.left.length === 0
            ? t("트랜잭션이 없어 앞서 적용한 변경 {count}개를 되돌렸습니다", { count: undo.undone.length })
            : t("트랜잭션이 없어 앞서 적용한 변경을 되돌렸지만 {count}개는 남았습니다. 새로고침해 확인하세요", {
                count: undo.left.length,
              })}
        </span>
        <ul>
          {undo.left.map((entry) => (
            <li key={`left:${entry.change}`} className="error-notice-undo-left">
              {t("남음")}: {entry.change} — {tServer(entry.reason)}
            </li>
          ))}
          {undo.undone.map((change) => (
            <li key={`undone:${change}`}>
              {t("되돌림")}: {change}
            </li>
          ))}
        </ul>
      </div>
    ) : null;

  const fixes =
    help !== null && help.fixes.length > 0 ? (
      <div className="error-notice-fixes">
        <span className="error-notice-label">{t("이렇게 해 보세요")}</span>
        <ul>
          {help.fixes.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
    ) : null;
  const buttons =
    onRetry !== undefined || fix !== undefined || actions !== undefined ? (
      <div className="error-notice-actions">
        {fix !== undefined && help?.action !== undefined ? (
          <button type="button" className="primary" onClick={fix}>
            {t(ACTION_LABELS[help.action])}
          </button>
        ) : null}
        {onRetry !== undefined ? (
          <button type="button" onClick={onRetry}>
            {t("다시 시도")}
          </button>
        ) : null}
        {actions}
      </div>
    ) : null;
  const banner = variant === "banner";

  return (
    <div className={`error-notice ${variant}`} role="alert">
      <div className="error-notice-head">
        <AlertIcon size={11} className="error-notice-icon" />
        <strong className="error-notice-title" title={banner ? title : undefined}>
          {title}
        </strong>
        {banner && help?.cause !== undefined ? <span className="error-notice-cause">{help.cause}</span> : null}
        {banner ? buttons : null}
        <button
          type="button"
          className="icon-button error-notice-icon-button"
          title={
            copy === "done" ? t("복사했습니다") : copy === "failed" ? t("클립보드에 복사하지 못했습니다") : t("오류 내용 복사")
          }
          aria-label={t("오류 내용 복사")}
          onClick={() => {
            let failed = false;
            void writeClipboard(copyText, () => {
              failed = true;
            }).then(() => setCopy(failed ? "failed" : "done"));
          }}
        >
          {copy === "done" ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
        </button>
        {onClose !== undefined ? (
          <button
            type="button"
            className="icon-button error-notice-icon-button"
            onClick={onClose}
            title={t("닫기")}
            aria-label={t("닫기")}
          >
            <CloseIcon size={10} />
          </button>
        ) : null}
      </div>
      {undoReport}
      {!banner && help?.cause !== undefined ? <p className="error-notice-cause">{help.cause}</p> : null}
      {!banner ? fixes : null}
      {!banner ? buttons : null}
      {hasDetails ? (
        <details className="error-notice-raw">
          <summary>{t("자세히")}</summary>
          {banner ? fixes : null}
          {rows.length > 0 ? (
            <dl className="error-notice-codes">
              {rows.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd className="mono">{value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <pre className="mono">{original}</pre>
          {extra !== "" ? <pre className="mono">{extra}</pre> : null}
        </details>
      ) : null}
    </div>
  );
}

// A problem with one field's value, on the line under it. Rendered while
// empty too, so a screen reader announces the message when it appears; give
// the input fieldErrorProps(id, error) to point at it.
export function FieldError({ id, error }: { id: string; error: string | null | undefined }) {
  return (
    <p id={id} className="field-error" aria-live="polite">
      {error ?? ""}
    </p>
  );
}

// aria-invalid and aria-describedby for an input whose FieldError is `id`.
export function fieldErrorProps(
  id: string,
  error: string | null | undefined,
): { "aria-invalid"?: true; "aria-describedby"?: string } {
  return error ? { "aria-invalid": true, "aria-describedby": id } : {};
}

// ── Error toasts ─────────────────────────────────────────────────────
// Failures that have no place of their own on screen. Red, they stay until
// closed (unlike the success flash), and the newest three are kept.

interface ErrorToast {
  id: number;
  error: AppError;
  context?: ErrorContext;
  retry?(): void;
}

const TOAST_LIMIT = 3;
let toasts: ErrorToast[] = [];
let toastSeq = 0;
const toastListeners = new Set<() => void>();

function setToasts(next: ErrorToast[]): void {
  toasts = next;
  for (const listener of toastListeners) {
    listener();
  }
}

function subscribeToasts(listener: () => void): () => void {
  toastListeners.add(listener);
  return () => toastListeners.delete(listener);
}

// Reports a failure in a toast that stays until closed. A failure of the
// TablePeek server itself is left to the app's connection banner.
export function notifyError(error: unknown, options: { retry?(): void; context?: ErrorContext } = {}): void {
  if (isAppServerDown(error)) {
    return;
  }
  const appError = toAppError(error);
  // The same failure again moves to the front instead of stacking up.
  const others = toasts.filter((toast) => toast.error.code !== appError.code || toast.error.message !== appError.message);
  toastSeq += 1;
  setToasts([...others, { id: toastSeq, error: appError, ...options }].slice(-TOAST_LIMIT));
}

// `onFix`: the one-click fixes the app can apply wherever a toast came from
// (refresh the schema, say); using one closes the toast.
export function ErrorToasts({ onFix }: { onFix?: Partial<Record<ErrorAction, () => void>> }) {
  const list = useSyncExternalStore(subscribeToasts, () => toasts);
  if (list.length === 0) {
    return null;
  }
  const dismiss = (id: number) => setToasts(toasts.filter((toast) => toast.id !== id));
  return (
    <div className="error-toasts">
      {list.map((toast) => (
        <ErrorNotice
          key={toast.id}
          error={toast.error}
          context={toast.context}
          variant="compact"
          onRetry={
            toast.retry !== undefined
              ? () => {
                  dismiss(toast.id);
                  toast.retry?.();
                }
              : undefined
          }
          onFix={
            onFix === undefined
              ? undefined
              : Object.fromEntries(
                  Object.entries(onFix).map(([action, fix]) => [
                    action,
                    () => {
                      dismiss(toast.id);
                      fix();
                    },
                  ]),
                )
          }
          onClose={() => dismiss(toast.id)}
        />
      ))}
    </div>
  );
}
