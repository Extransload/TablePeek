// What a Stop left on the server (docs/engines/elasticsearch.md §4.1): the
// tasks it cancelled, and the ones the server keeps running — a write, which
// a Stop never cancels by itself, or a task the server can't cancel — each
// with a button to cancel it or the related tasks of its tree that can be
// (through the tasks API, after a confirmation).

import { useState } from "react";
import { notifyError } from "../../../components/ErrorNotice";
import { Spinner } from "../../../components/Spinner";
import { t } from "../../../i18n";
import * as api from "../api";
import { requestText, type SearchHost } from "./common";

function TaskLine({ task }: { task: api.TaskRow }) {
  return (
    <span className="es-task-line">
      <span className="mono">{task.action}</span>
      <span className="panel-dim">{` · ${task.id} · ${task.running_time_ms === null ? "—" : task.running_time_ms < 1000 ? `${Math.round(task.running_time_ms)} ms` : `${(task.running_time_ms / 1000).toFixed(1)} s`}`}</span>
      {task.description ? <span className="es-task-desc mono" title={task.description}>{task.description}</span> : null}
    </span>
  );
}

// `report`: "loading" while the server is asked, null when it couldn't be.
export function ServerTasks({ host, report }: { host: SearchHost; report: api.StopReport | "loading" | null }) {
  const [asked, setAsked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);

  if (report === "loading") {
    return (
      <div className="es-tasks-left">
        <p className="panel-dim">
          <Spinner size={10} /> {t("서버에 남은 작업을 확인하는 중…")}
        </p>
      </div>
    );
  }
  if (report === null) {
    return null;
  }

  const cancel = async (task: api.TaskRow, related: boolean) => {
    const ok = await host.confirm({
      title: t("작업 취소"),
      message: related
        ? t("{action} 작업을 취소합니다. 같은 요청에서 나온 작업이라, 취소하면 계속 실행 중인 작업의 일부가 멈춥니다. 되돌릴 수 없습니다.", { action: task.action })
        : t("{action} 작업을 취소합니다. 이미 바뀐 문서는 그대로 남고, 취소는 되돌릴 수 없습니다.", { action: task.action }),
      command: requestText("POST", `/_tasks/${task.id}/_cancel`),
      okLabel: t("작업 취소"),
    });
    if (!ok) return;
    setBusy(task.id);
    try {
      await api.cancelTask(host.conn, task.id);
      setAsked((set) => new Set(set).add(task.id));
      host.notify(t("작업 취소를 요청했습니다: {id}", { id: task.id }));
    } catch (error) {
      notifyError(error, { context: "admin" });
    } finally {
      setBusy(null);
    }
  };

  const cancelButton = (task: api.TaskRow, related: boolean) =>
    asked.has(task.id) ? (
      <span className="es-cl-tag">{t("취소 요청함")}</span>
    ) : (
      <button type="button" className="footer-button" disabled={busy !== null || host.readOnly} onClick={() => void cancel(task, related)}>
        {busy === task.id ? <Spinner size={10} /> : null}
        {related ? t("관련 작업 취소") : t("작업 취소")}
      </button>
    );

  return (
    <div className="es-tasks-left" role="status" aria-live="polite">
      {report.cancelled.length > 0 ? (
        <section>
          <h4>{t("서버 작업 {count}개를 취소했습니다", { count: report.cancelled.length })}</h4>
          <ul>
            {report.cancelled.map((task) => (
              <li key={task.id}>
                <TaskLine task={task} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {report.running.map((task) => (
        <section key={task.id} className="es-tasks-running">
          <h4>{t("서버에서 계속 실행 중입니다")}</h4>
          <p className="panel-dim">
            {task.cancellable
              ? t("쓰기 요청은 정지해도 서버에서 멈추지 않습니다. 끝까지 두거나 작업을 취소하세요.")
              : t("서버가 취소할 수 없는 작업이라 끝날 때까지 실행됩니다.")}
          </p>
          <div className="es-tasks-row">
            <TaskLine task={task} />
            {task.cancellable ? cancelButton(task, false) : null}
          </div>
          {!task.cancellable && task.related.length === 0 ? <p className="panel-dim">{t("함께 취소할 수 있는 관련 작업도 없습니다.")}</p> : null}
          {task.related.length > 0 ? (
            <>
              <p className="panel-dim">{t("같은 요청에서 나온 작업 중 취소할 수 있는 것:")}</p>
              <ul>
                {task.related.map((related) => (
                  <li key={related.id} className="es-tasks-row">
                    <TaskLine task={related} />
                    {cancelButton(related, true)}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ))}
      {report.stopped && report.cancelled.length === 0 && report.running.length === 0 ? <p className="panel-dim">{t("서버에 남은 작업이 없습니다.")}</p> : null}
    </div>
  );
}
