// What the search workbench's panels, tabs and dialogs share: the host they
// ask for confirmation and post notices through, the safe-mode rule, the
// request text in Dev Tools notation, and the confirmation dialog that
// shows that request.

import { useEffect, useMemo, useRef, useState } from "react";
import { ShieldIcon } from "../../../components/icons";
import { t } from "../../../i18n";
import type { SafeMode } from "../../../sqlTools";
import { stringifyJson } from "../../mongodb/bson";
import type { RequestClass } from "../api";
import type { Json } from "../json";
import { jsonSpans, type Span } from "./SearchEditor";

export interface ConfirmRequest {
  title: string;
  message: string;
  // The request in Dev Tools notation (`DELETE /shop-orders`).
  command: string;
  okLabel: string;
  // The name to type before the button turns on (deleting an index with
  // safe mode on).
  typeToConfirm?: string;
}

// What the panels need from the app around them.
export interface SearchHost {
  conn: string;
  // A short success message (toast).
  notify(message: string): void;
  // Asks before a write; resolves true to go on.
  confirm(request: ConfirmRequest): Promise<boolean>;
  // The connection's safe mode.
  safeMode: SafeMode;
  // A read-only connection: no writes at all.
  readOnly: boolean;
}

// Whether safe mode stops before a request of this class: level 1 before
// destructive ones, level 2 before every write.
export function needsConfirm(cls: RequestClass, mode: SafeMode): boolean {
  return cls === "danger" ? mode >= 1 : cls === "write" ? mode >= 2 : false;
}

// A request as the console and history show it: the method line, then the
// body as pretty JSON (or NDJSON text as is).
export function requestText(method: string, path: string, body?: Json | string | null): string {
  const head = `${method} ${path.startsWith("/") ? path : `/${path}`}`;
  if (body === undefined || body === null) {
    return head;
  }
  return `${head}\n${typeof body === "string" ? body.replace(/\n$/, "") : stringifyJson(body, 2)}`;
}

const METHOD_LINE = /^(GET|HEAD|POST|PUT|DELETE|PATCH)(\s+)(\S*)/i;

// Console text coloured: method lines (method, path, query) and JSON bodies.
export function consoleSpans(src: string): Span[] {
  const out: Span[] = [];
  let at = 0;
  let bodyFrom = -1;
  const flushBody = (to: number) => {
    if (bodyFrom >= 0 && to > bodyFrom) {
      out.push(...jsonSpans(src, bodyFrom, to));
    }
    bodyFrom = -1;
  };
  while (at <= src.length) {
    const end = src.indexOf("\n", at);
    const lineEnd = end < 0 ? src.length : end;
    const line = src.slice(at, lineEnd);
    const m = METHOD_LINE.exec(line);
    if (m !== null) {
      flushBody(at);
      out.push({ from: at, to: at + m[1].length, cls: "sx-keyword" });
      const pathFrom = at + m[1].length + m[2].length;
      const q = m[3].indexOf("?");
      if (q < 0) {
        out.push({ from: pathFrom, to: pathFrom + m[3].length, cls: "sx-function" });
      } else {
        out.push({ from: pathFrom, to: pathFrom + q, cls: "sx-function" });
        out.push({ from: pathFrom + q, to: pathFrom + m[3].length, cls: "sx-string" });
      }
    } else if (/^\s*(#|\/\/)/.test(line) && bodyFrom < 0) {
      out.push({ from: at, to: lineEnd, cls: "sx-comment" });
    } else if (bodyFrom < 0 && line.trim() !== "") {
      bodyFrom = at;
    }
    if (end < 0) {
      break;
    }
    at = end + 1;
  }
  flushBody(src.length);
  return out;
}

// Request text coloured for read-only places (dialogs, the response head).
export function ConsoleText({ text, className }: { text: string; className?: string }) {
  const parts = useMemo(() => {
    const list: { text: string; cls: string | null }[] = [];
    let at = 0;
    for (const span of consoleSpans(text)) {
      if (span.from > at) {
        list.push({ text: text.slice(at, span.from), cls: null });
      }
      list.push({ text: text.slice(span.from, span.to), cls: span.cls });
      at = span.to;
    }
    if (at < text.length) {
      list.push({ text: text.slice(at), cls: null });
    }
    return list;
  }, [text]);
  return (
    <span className={className}>
      {parts.map((part, i) => (part.cls === null ? part.text : <span key={i} className={part.cls}>{part.text}</span>))}
    </span>
  );
}

// The confirmation before a write: what it does, the request it sends, and
// with `typeToConfirm` a name to type first. Starts on Cancel.
export function SearchConfirmModal({ request, onResult }: { request: ConfirmRequest; onResult(ok: boolean): void }) {
  const [typed, setTyped] = useState("");
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const ready = request.typeToConfirm === undefined || typed === request.typeToConfirm;
  useEffect(() => {
    (request.typeToConfirm !== undefined ? inputRef : cancelRef).current?.focus();
  }, [request.typeToConfirm]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onResult(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onResult]);
  return (
    <div className="modal-backdrop" onClick={() => onResult(false)}>
      <div className="modal review-modal danger" role="alertdialog" aria-modal="true" aria-label={request.title} onClick={(event) => event.stopPropagation()}>
        <div className="modal-head review-head">
          <span className="review-mark" aria-hidden="true">
            <ShieldIcon size={13} />
          </span>
          <div className="review-head-text">
            <span className="modal-title">{request.title}</span>
          </div>
        </div>
        <div className="modal-body review-body">
          <p className="review-lead mg-pre-line">{request.message}</p>
          <pre className="review-pre mono es-confirm-pre">
            <ConsoleText text={request.command} />
          </pre>
          {request.typeToConfirm !== undefined ? (
            <label className="confirm-dialog-field">
              <span>{t("확인하려면 이름을 그대로 입력하세요: {name}", { name: request.typeToConfirm })}</span>
              <input
                ref={inputRef}
                type="text"
                className="mono"
                spellCheck={false}
                autoComplete="off"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && ready) {
                    event.preventDefault();
                    onResult(true);
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
          <button type="button" className="primary danger" disabled={!ready} onClick={() => onResult(true)}>
            {request.okLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// A host's `confirm` backed by the modal: the state to render and the
// function to hand out.
export function useConfirm(): { pending: { request: ConfirmRequest; resolve(ok: boolean): void } | null; confirm(request: ConfirmRequest): Promise<boolean> } {
  const [pending, setPending] = useState<{ request: ConfirmRequest; resolve(ok: boolean): void } | null>(null);
  const confirm = useMemo(
    () => (request: ConfirmRequest) =>
      new Promise<boolean>((resolve) =>
        setPending({
          request,
          resolve: (ok) => {
            setPending(null);
            resolve(ok);
          },
        }),
      ),
    [],
  );
  return { pending, confirm };
}

