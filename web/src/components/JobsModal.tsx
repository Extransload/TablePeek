import { useEffect, useState } from "react";
import { t } from "../i18n";
import { cancelJob, clearFinishedJobs, subscribeJobs, type Job } from "../jobs";
import { ErrorNotice } from "./ErrorNotice";
import { StopIcon } from "./icons";

interface JobsModalProps {
  onClose(): void;
}

const STATUS_LABEL: Record<Job["status"], string> = {
  running: "진행 중",
  done: "완료",
  error: "실패",
  cancelled: "중지됨",
};

function formatWhen(time: number): string {
  const date = new Date(time);
  const pad = (value: number): string => (value < 10 ? `0${value}` : String(value));
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function JobsModal({ onClose }: JobsModalProps) {
  const [jobs, setJobs] = useState<Job[]>([]);

  useEffect(() => {
    const unsubscribe = subscribeJobs(setJobs);
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      unsubscribe();
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal jobs-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">{t("작업 큐")}</span>
          <span className="spacer" />
          <button type="button" onClick={clearFinishedJobs}>
            {t("완료 항목 지우기")}
          </button>
        </div>
        <div className="modal-body jobs-body">
          {jobs.length === 0 ? (
            <div className="panel-empty-inline">{t("작업이 없습니다")}</div>
          ) : (
            jobs.map((job) => (
              <div className="job-row" key={job.id}>
                <div className="job-line">
                  <span className="job-label">{job.label}</span>
                  <span className="job-detail dim">{job.detail}</span>
                  <span className="spacer" />
                  <span
                    className={
                      job.status === "error"
                        ? "job-status err"
                        : job.status === "done"
                          ? "job-status ok"
                          : "job-status"
                    }
                  >
                    {t(STATUS_LABEL[job.status])}
                  </span>
                  <span className="job-time dim">{formatWhen(job.startedAt)}</span>
                  {job.status === "running" && job.cancellable ? (
                    <button
                      type="button"
                      className="icon-button job-stop"
                      title={t("중지")}
                      aria-label={t("중지")}
                      onClick={() => cancelJob(job.id)}
                    >
                      <StopIcon size={10} />
                    </button>
                  ) : null}
                </div>
                <div className="job-bar">
                  <div
                    className={`job-bar-fill${job.status === "error" ? " error" : job.status === "cancelled" ? " cancelled" : ""}`}
                    style={{
                      width: `${job.total > 0 ? Math.min(100, Math.round((job.done / job.total) * 100)) : job.status === "running" ? 5 : 100}%`,
                    }}
                  />
                </div>
                <div className="job-meta dim">
                  {job.total > 0
                    ? `${job.done.toLocaleString()} / ${job.total.toLocaleString()}`
                    : job.status === "running"
                      ? t("진행 중…")
                      : ""}
                </div>
                {job.error ? <ErrorNotice error={job.error} variant="compact" /> : null}
              </div>
            ))
          )}
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            {t("닫기")}
          </button>
        </div>
      </div>
    </div>
  );
}
