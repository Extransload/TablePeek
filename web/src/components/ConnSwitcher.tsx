import { useEffect, useRef, useState, type CSSProperties } from "react";
import { getConnMeta, subscribeConnMeta } from "../connMeta";
import { t } from "../i18n";
import type { ConnSummary, Connection } from "../store";
import { DriverIcon, driverName } from "./DriverIcon";
import { CloseIcon } from "./icons";
import { Gauge, type GaugeOutcome } from "./Gauge";
import { useTabMotion } from "./tabMotion";

interface ConnSwitcherProps {
  conns: ConnSummary[];
  activeId: string | null;
  connection: Connection;
  activeDetail: string | null;
  // An open connection being entered, its outcome null while under way.
  entering: { id: string; outcome: GaugeOutcome | null } | null;
  onSwitch(id: string): void;
  onClose(id: string): void;
}

// The server names the demo in Korean; show it in the UI language.
function connLabel(conn: ConnSummary): string {
  return conn.demo ? t("데모 데이터베이스") : conn.label;
}

export function ConnSwitcher({
  conns,
  activeId,
  connection,
  activeDetail,
  entering,
  onSwitch,
  onClose,
}: ConnSwitcherProps) {
  const [, setMetaVersion] = useState(0);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const indicatorRef = useRef<HTMLSpanElement | null>(null);
  const activeConn = conns.find((conn) => conn.id === activeId);

  useEffect(() => subscribeConnMeta(() => setMetaVersion((value) => value + 1)), []);
  useTabMotion(trackRef, indicatorRef, conns.map((conn) => conn.id), activeConn?.id ?? null);

  return (
    <div className="conn-bar">
      <div ref={trackRef} className="conn-bar-track" role="tablist" aria-label={t("열린 연결")}>
        {conns.length === 0 ? (
          <span className="conn-bar-empty">{t("열린 연결이 없습니다")}</span>
        ) : (
          conns.map((conn) => {
            const meta = getConnMeta(conn.saved_id);
            const active = conn.id === activeId;
            const state = active ? connection : "idle";
            const enteringThis = entering !== null && entering.id === conn.id ? entering : null;
            const busy = state === "connecting" || (enteringThis !== null && enteringThis.outcome === null);
            const style = {
              "--conn-color": meta?.color || "var(--accent)",
              "--gauge-color": meta?.color || "var(--accent)",
            } as CSSProperties;
            return (
              <span className="conn-tab-wrap" role="presentation" key={conn.id} data-motion-key={conn.id} style={style}>
              <button
                type="button"
                role="tab"
                aria-selected={active}
                aria-busy={busy}
                className={`conn-tab gauge-host${active ? " active" : ""}${conn.is_default ? "" : " closable"}`}
                onClick={() => onSwitch(conn.id)}
                title={`${connLabel(conn)} · ${driverName(conn.kind)} — ${
                  state === "open"
                    ? t("연결됨")
                    : state === "connecting"
                      ? t("연결 중")
                      : state === "closed"
                        ? t("끊김")
                        : t("연결 열기")
                }${active && activeDetail ? `\n${activeDetail}` : ""}${conn.path ? `\n${conn.path}` : ""}`}
              >
                {/* Fills in the connection's colour while it connects; a drop
                    while reconnecting flashes and drains. */}
                <Gauge
                  busy={busy}
                  id={`conn:${conn.id}`}
                  outcome={enteringThis?.outcome ?? (state === "closed" ? "error" : "ok")}
                />
                <span className={`conn-state-dot conn-state-light ${state}`} aria-hidden="true" />
                <span className="conn-tab-icon">
                  <DriverIcon kind={conn.kind} />
                </span>
                <span className="conn-tab-label">{connLabel(conn)}</span>
              </button>
              {conn.is_default ? null : (
                <button
                  type="button"
                  className="conn-tab-close"
                  // No focus on press: focusing a half-hidden tab scrolls the bar,
                  // which moves the button out from under the pointer.
                  onMouseDown={(event) => event.preventDefault()}
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
        {/* The active tab's colour, which it pours from tab to tab. */}
        <span
          ref={indicatorRef}
          className="conn-tab-indicator"
          aria-hidden="true"
          style={{ "--conn-color": (activeConn && getConnMeta(activeConn.saved_id)?.color) || "var(--accent)" } as CSSProperties}
        />
      </div>
    </div>
  );
}
