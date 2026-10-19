import { useEffect, useState, type CSSProperties } from "react";
import { environmentLabel, getConnMeta, subscribeConnMeta } from "../connMeta";
import { t } from "../i18n";
import type { ConnSummary, Connection } from "../store";
import { DatabaseIcon, HomeIcon, PlusIcon } from "./icons";

interface ConnSwitcherProps {
  conns: ConnSummary[];
  activeId: string | null;
  connection: Connection;
  onSwitch(id: string): void;
  onHome(): void;
  onNewConnection(): void;
}

const DRIVER_BADGE: Record<string, string> = {
  postgres: "PG",
  cockroach: "CRDB",
  mysql: "MySQL",
  mssql: "MSSQL",
  sqlite: "SQLite",
};

function badgeOf(kind: string): string {
  return DRIVER_BADGE[kind] ?? kind.toUpperCase();
}

export function ConnSwitcher({
  conns,
  activeId,
  connection,
  onSwitch,
  onHome,
  onNewConnection,
}: ConnSwitcherProps) {
  const [, setMetaVersion] = useState(0);

  useEffect(() => subscribeConnMeta(() => setMetaVersion((value) => value + 1)), []);

  return (
    <div className="conn-bar">
      <button
        type="button"
        className="app-home-button"
        onClick={onHome}
        title={t("연결 홈")}
      >
        <HomeIcon size={13} />
      </button>
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
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className={`conn-tab${active ? " active" : ""}`}
                key={conn.id}
                style={style}
                onClick={() => onSwitch(conn.id)}
                title={`${conn.label} — ${
                  state === "open"
                    ? t("연결됨")
                    : state === "connecting"
                      ? t("연결 중")
                      : state === "closed"
                        ? t("끊김")
                        : t("연결 열기")
                }`}
              >
                <span className="conn-tab-icon">
                  <DatabaseIcon size={12} />
                  <span className={`conn-state-dot ${state}`} aria-hidden="true" />
                </span>
                <span className="conn-tab-label">{conn.label}</span>
                {meta?.environment ? (
                  <span className={`env-badge env-${meta.environment}`}>
                    {environmentLabel(meta.environment)}
                  </span>
                ) : null}
                <span className={`driver-badge ${conn.kind}`}>{badgeOf(conn.kind)}</span>
              </button>
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
