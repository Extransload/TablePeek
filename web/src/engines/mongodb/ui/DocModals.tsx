// The workbench's two dialogs: confirming a destructive command (safe mode,
// document delete) and choosing after a conflicting save (MONGODB.md §4).

import { useContext, useEffect, useMemo, useRef } from "react";
import { ShieldIcon } from "../../../components/icons";
import { Spinner } from "../../../components/Spinner";
import { t } from "../../../i18n";
import { toShellPretty } from "../format";
import { ShellText } from "./ShellText";
import type { DocConflict } from "./useDocEdits";
import { OpenValidationContext, WriteErrorNotice } from "./writeErrors";

export interface ConfirmRequest {
  title: string;
  message: string;
  // The mongosh text of what will be sent.
  command: string;
  okLabel: string;
}

// Esc anywhere runs `onEscape` (the workbench's and the 집계 tab's dialogs).
export function useEscape(onEscape: () => void) {
  const ref = useRef(onEscape);
  ref.current = onEscape;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        ref.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function ConfirmModal({ request, onResult }: { request: ConfirmRequest; onResult(ok: boolean): void }) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEscape(() => onResult(false));
  // Starts on Cancel so Return cannot run it by accident.
  useEffect(() => cancelRef.current?.focus(), []);
  return (
    <div className="modal-backdrop" onClick={() => onResult(false)}>
      <div className="modal review-modal danger" role="alertdialog" aria-label={request.title} onClick={(event) => event.stopPropagation()}>
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
          <pre className="review-pre mono">
            <ShellText text={request.command} />
          </pre>
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          <button type="button" ref={cancelRef} onClick={() => onResult(false)}>
            {t("취소")}
          </button>
          <button type="button" className="primary danger" onClick={() => onResult(true)}>
            {request.okLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// Lines of `text` not in `other`, to mark what differs.
function changedLines(text: string, other: string): Set<number> {
  const theirs = new Set(other.split("\n").map((line) => line.trim().replace(/,$/, "")));
  const out = new Set<number>();
  text.split("\n").forEach((line, i) => {
    if (!theirs.has(line.trim().replace(/,$/, ""))) {
      out.add(i);
    }
  });
  return out;
}

function Side({ title, text, marks }: { title: string; text: string; marks: Set<number> }) {
  return (
    <div className="mg-conflict-side">
      <div className="mg-conflict-title">{title}</div>
      <pre className="mg-conflict-code mono">
        {text.split("\n").map((line, i) => (
          <div key={i} className={marks.has(i) ? "mg-conflict-diff" : undefined}>
            <ShellText text={line === "" ? " " : line} />
          </div>
        ))}
      </pre>
    </div>
  );
}

export function ConflictModal({ conflict }: { conflict: DocConflict }) {
  useEscape(() => {
    if (!conflict.busy) {
      conflict.dismiss();
    }
  });
  const now = useMemo(() => (conflict.current === null ? "" : toShellPretty(conflict.current)), [conflict.current]);
  const mine = useMemo(() => toShellPretty(conflict.mine), [conflict.mine]);
  const deleted = conflict.current === null;
  // "검증 탭 열기" closes the dialog first (the edit stays in its view).
  const openValidation = useContext(OpenValidationContext);
  const leaveForValidation =
    openValidation === null
      ? null
      : () => {
          conflict.dismiss();
          openValidation();
        };
  return (
    <div className="modal-backdrop">
      <div className="modal mg-conflict-modal" role="alertdialog" aria-label={t("저장하지 못했습니다")}>
        <div className="modal-head">
          <span className="modal-title">{deleted ? t("다른 곳에서 삭제되었습니다") : t("다른 곳에서 바뀌었습니다")}</span>
        </div>
        <div className="modal-body mg-conflict-body">
          <p className="review-lead">
            {deleted
              ? t("이 문서를 연 뒤 다른 곳에서 삭제해 변경을 저장하지 않았습니다.")
              : t("이 문서를 연 뒤 다른 곳에서 바꿔 덮어쓰지 않았습니다. 어느 쪽을 남길지 고르세요.")}
          </p>
          <div className="mg-conflict-sides">
            {deleted ? null : <Side title={t("지금 값")} text={now} marks={changedLines(now, mine)} />}
            <Side title={t("내 변경")} text={mine} marks={deleted ? new Set() : changedLines(mine, now)} />
          </div>
          {conflict.error !== null ? (
            <OpenValidationContext.Provider value={leaveForValidation}>
              <WriteErrorNotice error={conflict.error} variant="block" />
            </OpenValidationContext.Provider>
          ) : null}
        </div>
        <div className="modal-foot">
          <button type="button" onClick={conflict.dismiss} disabled={conflict.busy}>
            {t("닫기")}
          </button>
          <span className="spacer" />
          <button type="button" className={deleted ? "primary" : undefined} onClick={conflict.reload} disabled={conflict.busy}>
            {t("지금 값으로 다시 불러오기")}
          </button>
          {deleted ? null : (
            <button type="button" className="primary danger" onClick={conflict.overwrite} disabled={conflict.busy}>
              {conflict.busy ? <Spinner size={10} /> : null}
              {t("내 변경으로 덮어쓰기")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
