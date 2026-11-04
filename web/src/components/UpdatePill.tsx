import { useEffect, useState, useSyncExternalStore, type CSSProperties } from "react";
import { t } from "../i18n";
import {
  configureUpdate,
  getRestart,
  getUpdate,
  loadUpdate,
  readyRelease,
  restartBusy,
  restartToUpdate,
  subscribeRestart,
  subscribeUpdate,
} from "../update";
import { ContextMenu } from "./ContextMenu";
import { notifyError } from "./ErrorNotice";
import { RefreshIcon } from "./icons";
import { Gauge } from "./Gauge";

// The desktop app's "Restart to update": shown once the app has downloaded a
// newer release on its own, arriving with a wash of color. A click installs
// it and the app restarts; a failure shows beside it and the pill tries
// again. Its menu (right click) has the release notes and skipping the
// release. Nothing shows in builds that don't update themselves.
export function UpdatePill({ className }: { className?: string }) {
  const update = useSyncExternalStore(subscribeUpdate, getUpdate);
  const restart = useSyncExternalStore(subscribeRestart, getRestart);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    loadUpdate().catch(() => {});
  }, []);

  const version = readyRelease(update);
  if (update === null || version === null) {
    return null;
  }
  const busy = restartBusy(restart) || update.install.state === "installing";
  let failure: string | null = null;
  if (!busy) {
    if (restart.phase === "error") {
      failure = restart.error instanceof Error ? restart.error.message : String(restart.error);
    } else if (update.install.state === "error") {
      failure = update.install.message;
    }
  }
  const label = busy
    ? restart.phase === "restarting"
      ? t("다시 시작하는 중…")
      : t("설치하는 중…")
    : failure !== null
      ? t("다시 시도")
      : t("다시 시작해서 업데이트");

  return (
    <span className={`update-pill-slot${className ? ` ${className}` : ""}`}>
      {failure !== null ? (
        <span className="update-pill-error" role="alert" title={failure}>
          {t("설치하지 못했습니다")}
        </span>
      ) : null}
      <button
        // A newer version arrives afresh.
        key={version}
        type="button"
        className={`update-pill gauge-host${failure !== null ? " failed" : ""}`}
        title={t("TablePeek {latest}으로 업데이트 (지금 {current})", { latest: version, current: update.current })}
        disabled={busy}
        aria-busy={busy}
        onClick={() => void restartToUpdate()}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        <Gauge busy={busy} outcome={failure !== null ? "error" : "ok"} />
        <RefreshIcon size={11} />
        {/* Keyed by its words, so each new label comes into focus word by word. */}
        <span key={label} className="update-pill-label">
          {label.split(/(\s+)/).map((word, index) =>
            index % 2 === 1 ? (
              word
            ) : (
              <span key={index} className="update-pill-word" style={{ "--word": index / 2 } as CSSProperties}>
                {word}
              </span>
            ),
          )}
        </span>
      </button>
      {menu !== null ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={[
            {
              label: t("변경 내역"),
              disabled: update.url === null,
              onSelect: () => window.open(update.url ?? undefined, "_blank", "noopener"),
            },
            {
              label: t("이 버전 건너뛰기"),
              disabled: busy,
              onSelect: () => {
                configureUpdate({ skipped: version }).catch((error: unknown) => notifyError(error));
              },
            },
          ]}
        />
      ) : null}
    </span>
  );
}
