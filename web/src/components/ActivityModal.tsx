import { useEffect, useState } from "react";
import { clearActivity, subscribeActivity, type ActivityEntry } from "../activity";

interface ActivityModalProps {
  onClose(): void;
}

const KIND_LABELS: Record<string, string> = {
  job: "작업",
  ddl: "구조 변경",
  conn: "연결",
  etc: "기타",
};

export function ActivityModal({ onClose }: ActivityModalProps) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);

  useEffect(() => subscribeActivity(setEntries), []);
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
      <div className="modal activity-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">Activity</span>
          <span className="modal-path">{`${entries.length}개`}</span>
        </div>
        <div className="modal-body activity-body">
          <div className="log-tools">
            <span className="helper">설정의 보관 기간이 지난 기록은 자동 정리됩니다.</span>
            <span className="spacer" />
            <button type="button" onClick={() => clearActivity()}>
              비우기
            </button>
          </div>
          <div className="log-list">
            {entries.length === 0 ? (
              <div className="log-empty">기록된 활동이 없습니다</div>
            ) : (
              entries
                .slice()
                .reverse()
                .map((entry) => (
                  <div className="activity-row" key={entry.id}>
                    <span className="log-time mono">
                      {new Date(entry.at).toLocaleString("ko-KR", { hour12: false })}
                    </span>
                    <span className="activity-kind">{KIND_LABELS[entry.kind] ?? entry.kind}</span>
                    <span className="activity-message">{entry.message}</span>
                    {entry.detail !== undefined ? (
                      <span className="activity-detail dim">{entry.detail}</span>
                    ) : null}
                  </div>
                ))
            )}
          </div>
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}
