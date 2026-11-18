import { useEffect, useRef, useState, type CSSProperties } from "react";
import { getConnMeta, subscribeConnMeta } from "../connMeta";
import { t } from "../i18n";
import type { ConnSummary, Connection } from "../store";
import type { LinkState } from "../net/socket";
import { DriverIcon, driverName } from "./DriverIcon";
import { CloseIcon } from "./icons";
import { Gauge, type GaugeOutcome } from "./Gauge";
import { useTabMotion } from "./tabMotion";

// What the server last said about a connection: being checked (`busy`), found
// gone (`lost`, kept until it answers again), and how the last check ended
// for the gauge (`ended`).
export interface LinkMark {
  busy: boolean;
  lost: boolean;
  ended: GaugeOutcome;
}

// The mark after `state`; null once the connection answers (nothing to show).
export function nextLinkMark(prev: LinkMark | undefined, state: LinkState): LinkMark | null {
  const lost = prev?.lost ?? false;
  switch (state) {
    // A check of a connection already known gone is a reconnect: it stays red.
    case "checking":
      return { busy: !lost, lost, ended: "ok" };
    // Gone: the gauge races to full and the tab turns red at once, while
    // connecting again goes on; it stays red if that fails.
    case "reconnecting":
    case "failed":
    case "lost":
      return { busy: false, lost: true, ended: "ok" };
    // Stopped mid-check: the gauge drains; a known loss stays shown.
    case "stopped":
      return { busy: false, lost, ended: lost ? "ok" : "cancel" };
    case "open":
      return null;
  }
}

interface ConnSwitcherProps {
  conns: ConnSummary[];
  activeId: string | null;
  connection: Connection;
  activeDetail: string | null;
  // An open connection being entered, its outcome null while under way.
  entering: { id: string; outcome: GaugeOutcome | null } | null;
  // What the server last said about each connection (checking it, or found
  // it gone).
  links: Record<string, LinkMark>;
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
  links,
  onSwitch,
  onClose,
}: ConnSwitcherProps) {
  const [, setMetaVersion] = useState(0);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const indicatorRef = useRef<HTMLSpanElement | null>(null);
  const activeConn = conns.find((conn) => conn.id === activeId);

  useEffect(() => subscribeConnMeta(() => setMetaVersion((value) => value + 1)), []);
  useTabMotion(trackRef, indicatorRef, conns.map((conn) => conn.id), activeConn?.id ?? null);

  const activeBusy =
    activeConn !== undefined &&
    (connection === "connecting" ||
      links[activeConn.id]?.busy === true ||
      (entering !== null && entering.id === activeConn.id && entering.outcome === null));

  return (
    <div className="conn-bar">
      {/* While the active connection connects, the highlight under it empties
          and its tab's gauge fills back up in the highlight's own colour. */}
      <div
        ref={trackRef}
        className={`conn-bar-track${activeBusy ? " active-busy" : ""}`}
        role="tablist"
        aria-label={t("열린 연결")}
      >
        {conns.length === 0 ? (
          <span className="conn-bar-empty">{t("열린 연결이 없습니다")}</span>
        ) : (
          conns.map((conn) => {
            const meta = getConnMeta(conn.saved_id);
            const active = conn.id === activeId;
            const state = active ? connection : "idle";
            const enteringThis = entering !== null && entering.id === conn.id ? entering : null;
            const link = links[conn.id];
            const lost = link?.lost === true;
            const busy =
              state === "connecting" ||
              link?.busy === true ||
              (enteringThis !== null && enteringThis.outcome === null);
            const style = { "--conn-color": meta?.color || "var(--accent)" } as CSSProperties;
            return (
              <span className="conn-tab-wrap" role="presentation" key={conn.id} data-motion-key={conn.id} style={style}>
              <button
                type="button"
                role="tab"
                aria-selected={active}
                aria-busy={busy}
                className={`conn-tab gauge-host${active ? " active" : ""}${lost ? " lost" : ""}${conn.is_default ? "" : " closable"}`}
                onClick={() => onSwitch(conn.id)}
                title={`${connLabel(conn)} · ${driverName(conn.kind)} — ${
                  lost
                    ? t("연결 끊김")
                    : link?.busy === true
                      ? t("연결 확인 중")
                    : state === "open"
                      ? t("연결됨")
                      : state === "connecting"
                        ? t("연결 중")
                        : state === "closed"
                          ? t("끊김")
                          : t("연결 열기")
                }${active && activeDetail ? `\n${activeDetail}` : ""}${conn.path ? `\n${conn.path}` : ""}`}
              >
                {/* Fills in the connection's colour while it connects, or while
                    the server checks it after a pause. Found gone, the fill
                    races to full and the tab turns red until the connection
                    answers again. */}
                <Gauge
                  busy={busy}
                  id={`conn:${conn.id}`}
                  outcome={enteringThis?.outcome ?? (state === "closed" ? "error" : (link?.ended ?? "ok"))}
                />
                <span className="conn-tab-lost" aria-hidden="true" />
                <span className={`conn-state-dot conn-state-light ${lost ? "closed" : state}`} aria-hidden="true" />
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
