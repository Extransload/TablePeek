// The app's yes/no question and one-line question, in place of the browser's
// confirm() and prompt(). Callers `await confirmDialog({...})` or
// `await promptDialog({...})`; the one <ConfirmDialogHost /> in App draws them.
// A danger question starts on Cancel so Return cannot run it by accident;
// `typeToConfirm` keeps the button off until that name is typed (DROP
// DATABASE with safe mode on, as the MongoDB drop dialog does).

import { useEffect, useRef, useState, type ComponentProps } from "react";
import { t } from "../i18n";
import { ShieldIcon } from "./icons";
import { PromptModal } from "./PromptModal";

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  typeToConfirm?: string;
}

export type PromptOptions = Omit<ComponentProps<typeof PromptModal>, "onSubmit" | "onClose">;

type Pending =
  | { id: number; kind: "confirm"; options: ConfirmOptions; resolve(ok: boolean): void }
  | { id: number; kind: "prompt"; options: PromptOptions; resolve(value: string | null): void };

let nextId = 0;
let queue: Pending[] = [];
let listener: ((pending: Pending | null) => void) | null = null;

function enqueue(pending: Pending): void {
  queue = [...queue, pending];
  if (queue.length === 1) {
    listener?.(queue[0]);
  }
}

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => enqueue({ id: ++nextId, kind: "confirm", options, resolve }));
}

// Resolves to the value (trimmed unless `secret`), or null when cancelled.
export function promptDialog(options: PromptOptions): Promise<string | null> {
  return new Promise<string | null>((resolve) => enqueue({ id: ++nextId, kind: "prompt", options, resolve }));
}

function settle(answer: boolean | string | null): void {
  const [head, ...rest] = queue;
  queue = rest;
  if (head?.kind === "confirm") {
    head.resolve(answer === true);
  } else if (head?.kind === "prompt") {
    head.resolve(typeof answer === "string" ? answer : null);
  }
  listener?.(queue[0] ?? null);
}

export function ConfirmDialogHost() {
  const [pending, setPending] = useState<Pending | null>(queue[0] ?? null);
  useEffect(() => {
    listener = setPending;
    setPending(queue[0] ?? null);
    return () => {
      listener = null;
    };
  }, []);
  // A new key per question resets the typed text and the focus.
  if (pending === null) {
    return null;
  }
  return pending.kind === "confirm" ? (
    <ConfirmDialog key={pending.id} options={pending.options} onResult={settle} />
  ) : (
    // PromptModal closes itself after a submit too; only a cancel settles then.
    <PromptModal
      key={pending.id}
      {...pending.options}
      onSubmit={(value) => settle(value)}
      onClose={() => {
        if (queue[0]?.id === pending.id) {
          settle(null);
        }
      }}
    />
  );
}

function ConfirmDialog({ options, onResult }: { options: ConfirmOptions; onResult(ok: boolean): void }) {
  const { title, message, confirmLabel, danger = false, typeToConfirm } = options;
  const [typed, setTyped] = useState("");
  const boxRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const okRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const ready = typeToConfirm === undefined || typed === typeToConfirm;

  // Focus goes back where it was once the answer is in.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    (typeToConfirm !== undefined ? inputRef : danger ? cancelRef : okRef).current?.focus();
    return () => before?.focus({ preventScroll: true });
  }, [danger, typeToConfirm]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onResult(false);
      } else if (event.key === "Tab") {
        // Tab stays inside the dialog.
        const items = Array.from(boxRef.current?.querySelectorAll<HTMLElement>("input, button:not(:disabled)") ?? []);
        if (items.length === 0) {
          return;
        }
        event.preventDefault();
        const at = items.indexOf(document.activeElement as HTMLElement);
        const next = event.shiftKey ? (at <= 0 ? items.length - 1 : at - 1) : (at + 1) % items.length;
        items[next].focus();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onResult]);

  return (
    <div className="modal-backdrop" onClick={() => onResult(false)}>
      <div
        ref={boxRef}
        className={`modal confirm-dialog${danger ? " review-modal danger" : ""}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby="confirm-dialog-message"
        onClick={(event) => event.stopPropagation()}
      >
        <div className={`modal-head${danger ? " review-head" : ""}`}>
          {danger ? (
            <span className="review-mark" aria-hidden="true">
              <ShieldIcon size={13} />
            </span>
          ) : null}
          <span className="modal-title" id="confirm-dialog-title">
            {title}
          </span>
        </div>
        <div className="modal-body review-body">
          <p className="review-lead confirm-dialog-message" id="confirm-dialog-message">
            {message}
          </p>
          {typeToConfirm !== undefined ? (
            <label className="confirm-dialog-field">
              <span>{t("확인하려면 이름을 그대로 입력하세요: {name}", { name: typeToConfirm })}</span>
              <input
                ref={inputRef}
                type="text"
                className="mono"
                spellCheck={false}
                autoComplete="off"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    if (ready) {
                      onResult(true);
                    }
                  }
                }}
              />
            </label>
          ) : null}
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          <button type="button" ref={cancelRef} onClick={() => onResult(false)}>
            {t("취소")}
          </button>
          <button type="button" ref={okRef} className={danger ? "primary danger" : "primary"} disabled={!ready} onClick={() => onResult(true)}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
