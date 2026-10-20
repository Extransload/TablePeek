import { useEffect, useRef } from "react";
import { t } from "../i18n";
import type { ReviewItem, SafeMode } from "../sqlTools";
import { ShieldIcon } from "./icons";
import { SAFE_MODE_LABELS } from "./SafeModeMenu";

interface ReviewModalProps {
  mode: SafeMode;
  items: ReviewItem[];
  txActive: boolean;
  onRun(wrapTx: boolean): void;
  onClose(): void;
}

export function ReviewModal({ mode, items, txActive, onRun, onClose }: ReviewModalProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const runRef = useRef<HTMLButtonElement | null>(null);
  const danger = items.some((item) => item.severity === "danger");

  useEffect(() => {
    // Destructive statements start on Cancel so Enter can't run them by accident.
    (danger ? cancelRef : runRef).current?.focus();
  }, [danger]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={`modal review-modal${danger ? " danger" : ""}`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head review-head">
          <span className="review-mark" aria-hidden="true">
            <ShieldIcon size={13} />
          </span>
          <div className="review-head-text">
            <span className="modal-title">{t("실행 전 확인")}</span>
            <span className="review-mode">{t(SAFE_MODE_LABELS[mode].title)}</span>
          </div>
        </div>
        <div className="modal-body review-body">
          <p className="review-lead">
            {danger
              ? t("되돌리기 어려운 문장이 있습니다. 내용을 확인하세요.")
              : t("다음 {count}개 문장이 데이터를 변경합니다.", { count: items.length })}
          </p>
          <ol className="review-list">
            {items.map((item, index) => (
              <li key={index} className={`review-item ${item.severity}`}>
                <div className="review-item-head">
                  <span className={`review-badge ${item.severity}`}>
                    {item.severity === "danger" ? t("위험") : t("변경")}
                  </span>
                  <span className="review-keyword">{item.keyword}</span>
                  <span className="review-reason">{t(item.reason)}</span>
                </div>
                <pre className="review-pre mono">{item.sql}</pre>
              </li>
            ))}
          </ol>
        </div>
        <div className="modal-foot">
          <span className="review-hint">{t("안전 모드는 툴바의 방패 버튼에서 바꿀 수 있습니다")}</span>
          <span className="spacer" />
          <button type="button" ref={cancelRef} onClick={onClose}>
            {t("취소")}
          </button>
          {txActive ? null : (
            <button
              type="button"
              onClick={() => onRun(true)}
              title={t("트랜잭션 안에서 실행합니다. 결과를 보고 커밋하거나 롤백할 수 있습니다.")}
            >
              {t("트랜잭션으로 실행")}
            </button>
          )}
          <button
            type="button"
            ref={runRef}
            className={danger ? "primary danger" : "primary"}
            onClick={() => onRun(false)}
          >
            {danger ? t("그래도 실행") : t("실행")}
          </button>
        </div>
      </div>
    </div>
  );
}
