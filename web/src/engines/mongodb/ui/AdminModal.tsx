// Parts the management, import and export dialogs share: the modal frame,
// the command preview, the failure line, name rules and the mongosh
// spelling of a namespace.

import { useEffect, useRef, type ReactNode } from "react";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { ShieldIcon } from "../../../components/icons";
import { t } from "../../../i18n";
import { shellCollection } from "../format";
import { ShellText } from "./ShellText";
import "./panels.css";
import "./admin.css";

// `db.getSiblingDB("shop").orders` — the namespace as mongosh reaches it
// from any database.
export function shellNamespace(db: string, coll: string): string {
  return `db.getSiblingDB(${JSON.stringify(db)})${shellCollection(coll).slice(2)}`;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Why a database name cannot be used, or null.
export function databaseNameProblem(name: string): string | null {
  if (name === "") {
    return t("데이터베이스 이름을 쓰세요");
  }
  if (/[/\\. "$*<>:|?\0]/.test(name)) {
    return t("데이터베이스 이름에 쓸 수 없는 글자가 있습니다 (/ \\ . 공백 \" $ * < > : | ?)");
  }
  if (new TextEncoder().encode(name).length >= 64) {
    return t("데이터베이스 이름은 64바이트보다 짧아야 합니다");
  }
  return null;
}

// Why a collection name cannot be used, or null.
export function collectionNameProblem(name: string): string | null {
  if (name === "") {
    return t("컬렉션 이름을 쓰세요");
  }
  if (name.includes("$") || name.includes("\0")) {
    return t("컬렉션 이름에는 $를 쓸 수 없습니다");
  }
  if (name.startsWith("system.")) {
    return t("system.으로 시작하는 이름은 MongoDB가 씁니다");
  }
  return null;
}

// The frame every dialog here shares: head with the namespace, body, a
// foot with the buttons; Esc and a click outside close it unless busy.
export function AdminModal({ title, path, className, busy, danger = false, onClose, children, foot }: { title: string; path?: string; className?: string; busy: boolean; danger?: boolean; onClose(): void; children: ReactNode; foot: ReactNode }) {
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented && !busyRef.current) {
        event.preventDefault();
        closeRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="modal-backdrop" onClick={() => !busyRef.current && onClose()}>
      <div className={`modal mg-admin-modal${danger ? " review-modal danger" : ""}${className ? ` ${className}` : ""}`} role={danger ? "alertdialog" : "dialog"} aria-label={title} onClick={(event) => event.stopPropagation()}>
        <div className={`modal-head${danger ? " review-head" : ""}`}>
          {danger ? (
            <span className="review-mark" aria-hidden="true">
              <ShieldIcon size={13} />
            </span>
          ) : null}
          <span className="modal-title">{title}</span>
          {path !== undefined ? <span className="modal-path">{path}</span> : null}
        </div>
        <div className="modal-body mg-form">{children}</div>
        <div className="modal-foot">{foot}</div>
      </div>
    </div>
  );
}

// The command a dialog will send, or why it cannot yet.
export function CommandPreview({ command, problem }: { command: string | null; problem: string | null }) {
  return (
    <>
      <div className="mg-form-label">{t("보낼 명령")}</div>
      <pre className="panel-pre mg-export-code mg-ix-preview">{problem === null && command !== null ? <ShellText text={command} /> : <span className="mg-danger-text">{problem}</span>}</pre>
    </>
  );
}

// A dialog's failed command, explained; nothing while `error` is null.
export function Failure({ error }: { error: unknown }) {
  return error === null ? null : <ErrorNotice error={error} context="admin" engine="mongodb" variant="compact" />;
}
