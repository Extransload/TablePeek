import { useEffect } from "react";

interface ReviewModalProps {
  sql: string;
  unsafe: "UPDATE" | "DELETE";
  txActive: boolean;
  onRun(wrapTx: boolean): void;
  onClose(): void;
}

export function ReviewModal({ sql, unsafe, txActive, onRun, onClose }: ReviewModalProps) {
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
      <div className="modal review-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">SQL 검토 (주의 모드 2)</span>
          <span className="modal-path">Code Review</span>
        </div>
        <div className="modal-body review-body">
          <p className="helper">{`WHERE 절이 없는 ${unsafe} 문입니다. 실행 전에 확인하세요.`}</p>
          <pre className="review-pre mono">{sql}</pre>
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            취소
          </button>
          {txActive ? null : (
            <button type="button" onClick={() => onRun(true)} title="트랜잭션 시작 후 실행">
              트랜잭션으로 실행
            </button>
          )}
          <button type="button" className="primary" onClick={() => onRun(false)}>
            실행
          </button>
        </div>
      </div>
    </div>
  );
}
