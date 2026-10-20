import { useEffect, useState, type CSSProperties } from "react";
import { environmentLabel, getConnMeta, subscribeConnMeta } from "../connMeta";
import { t } from "../i18n";
import type { ConnSummary, Connection } from "../store";
import { DriverIcon, driverName } from "./DriverIcon";
import { CloseIcon, PlusIcon } from "./icons";

interface ConnSwitcherProps {
  conns: ConnSummary[];
  activeId: string | null;
  connection: Connection;
  activeDetail: string | null;
  onSwitch(id: string): void;
  onNewConnection(): void;
  onClose(id: string): void;
}

export function ConnSwitcher({
  conns,
  activeId,
  connection,
  activeDetail,
  onSwitch,
  onNewConnection,
  onClose,
}: ConnSwitcherProps) {
  const [, setMetaVersion] = useState(0);

  useEffect(() => subscribeConnMeta(() => setMetaVersion((value) => value + 1)), []);

  return (
    <div className="conn-bar">
      <div className="conn-bar-track" role="tablist" aria-label={t("열린 연결")}>
        {conns.length === 0 ? (
          <span className="conn-bar-empty">{t("열린 연결이 없습니다")}</span>
        ) : (
          conns.map((conn) => {
            const meta = getConnMeta(conn.saved_id);
            const active = conn.id === activeId;
            const state = active ? connection : "idle";
            const style = {
              "--conn-color": meta?.color || "var(--accent)",
            } as CSSProperties;
            return (
              <span className="conn-tab-wrap" role="presentation" key={conn.id} style={style}>
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className={`conn-tab${active ? " active" : ""}${conn.is_default ? "" : " closable"}`}
                onClick={() => onSwitch(conn.id)}
                title={`${conn.label} · ${driverName(conn.kind)} — ${
                  state === "open"
                    ? t("연결됨")
                    : state === "connecting"
                      ? t("연결 중")
                      : state === "closed"
                        ? t("끊김")
                        : t("연결 열기")
                }${active && activeDetail ? `\n${activeDetail}` : ""}${conn.path ? `\n${conn.path}` : ""}`}
              >
                <span className={`conn-state-dot conn-state-light ${state}`} aria-hidden="true" />
                <span className="conn-tab-icon">
                  <DriverIcon kind={conn.kind} />
                </span>
                <span className="conn-tab-label">{conn.label}</span>
                {meta?.environment ? (
                  <span className={`env-badge env-${meta.environment}`}>
                    {environmentLabel(meta.environment)}
                  </span>
                ) : null}
              </button>
              {conn.is_default ? null : (
                <button
                  type="button"
                  className="conn-tab-close"
                  onClick={() => onClose(conn.id)}
                  title={t("연결 끊기")}
                  aria-label={t("연결 끊기")}
                >
                  <CloseIcon size={9} />
                </button>
              )}
              </span>
            );
          })
        )}
      </div>
      <button
        type="button"
        className="conn-bar-add"
        onClick={onNewConnection}
        title={t("새 연결")}
      >
        <PlusIcon size={12} />
      </button>
    </div>
  );
}
