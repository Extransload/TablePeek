import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import * as uiState from "../persist";
import { store, type AiStatus } from "../store";
import { notifyError } from "./ErrorNotice";
import { ExternalIcon } from "./icons";

// "Sign in with ChatGPT" (AI provider "chatgpt"), shared by Settings › AI and
// the SQL editor's AI box: the branded button, the usage link, the poll while
// the browser login runs, and the one-time note after the first sign-in.

export const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";

// Set once the first sign-in's note has been shown, ever.
const WELCOME_SHOWN_KEY = "tablepeek.chatgpt-welcome-shown";

// Starts a browser login and opens its page (the desktop app hands it to
// the system browser); the screens watching the status follow it from there.
export async function continueWithChatGpt(newAccount = false): Promise<void> {
  try {
    const url = await store.startChatGptLogin(newAccount);
    window.open(url, "_blank", "noopener");
  } catch (error) {
    notifyError(error);
  }
}

// The pending login's page again, or a new login when this page didn't start it.
export function reopenChatGptLogin(): void {
  const url = store.getChatGptLoginUrl();
  if (url === null) {
    void continueWithChatGpt();
  } else {
    window.open(url, "_blank", "noopener");
  }
}

// Keeps the shared status current while a login is pending and this screen is open.
export function useChatGptLoginWatch(status: AiStatus | null): void {
  const pending = status?.provider === "chatgpt" && status.chatgpt?.login === "pending";
  useEffect(() => {
    if (!pending) {
      return;
    }
    const controller = new AbortController();
    store.watchChatGptLogin(controller.signal);
    return () => controller.abort();
  }, [pending]);
}

// OpenAI's sign-in button: its own wording in every language, black with white text.
export function ChatGptSignInButton({ disabled = false }: { disabled?: boolean }) {
  return (
    <button
      type="button"
      className="chatgpt-signin-button"
      data-oai-siwc-button=""
      disabled={disabled}
      onClick={() => void continueWithChatGpt()}
    >
      Continue with ChatGPT
    </button>
  );
}

export function ManageUsageLink() {
  return (
    <button type="button" className="link-button chatgpt-usage-link" onClick={() => window.open(CHATGPT_USAGE_URL, "_blank", "noopener")}>
      Manage usage
      <ExternalIcon size={10} />
    </button>
  );
}

// After the first sign-in started from TablePeek: the requests use the
// user's ChatGPT plan, whose usage is managed in ChatGPT. Shown once, ever.
export function ChatGptWelcomeHost() {
  const [open, setOpen] = useState(false);
  useEffect(
    () =>
      store.onChatGptSignIn(() => {
        if (uiState.getItem(WELCOME_SHOWN_KEY) === null) {
          uiState.setItem(WELCOME_SHOWN_KEY, "1");
          setOpen(true);
        }
      }),
    [],
  );
  return open ? <ChatGptWelcome onClose={() => setOpen(false)} /> : null;
}

function ChatGptWelcome({ onClose }: { onClose(): void }) {
  const okRef = useRef<HTMLButtonElement | null>(null);

  // Focus goes back where it was once it is closed.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    okRef.current?.focus();
    return () => before?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal confirm-dialog chatgpt-welcome"
        role="dialog"
        aria-modal="true"
        aria-labelledby="chatgpt-welcome-title"
        aria-describedby="chatgpt-welcome-message"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-title" id="chatgpt-welcome-title">
            {t("ChatGPT 요금제를 사용합니다")}
          </span>
        </div>
        <div className="modal-body review-body">
          <p className="review-lead confirm-dialog-message" id="chatgpt-welcome-message">
            {t("TablePeek의 AI 요청은 ChatGPT 요금제의 사용량으로 처리됩니다. 사용량과 한도는 ChatGPT 설정에서 관리합니다.")}
          </p>
          <div>
            <ManageUsageLink />
          </div>
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          <button type="button" ref={okRef} className="primary" onClick={onClose}>
            {t("확인 [안내]")}
          </button>
        </div>
      </div>
    </div>
  );
}
