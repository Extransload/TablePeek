// The Server section: INFO by section with a filter across every name and
// value, and the clients (CLIENT LIST) with CLIENT KILL. The Slow log
// section: SLOWLOG with its reset.

import { useEffect, useMemo, useState } from "react";
import { confirmDialog } from "../../../components/ConfirmDialog";
import { ErrorNotice, notifyError } from "../../../components/ErrorNotice";
import { Gauge } from "../../../components/Gauge";
import { RefreshIcon, SearchIcon, TrashIcon } from "../../../components/icons";
import { humanizeElapsed } from "../../../format";
import { t } from "../../../i18n";
import { store, type ServerSession } from "../../../store";
import { info as readInfo, isAbort, slowlog as readSlowlog, slowlogReset, type InfoSection, type SlowEntry } from "../api";
import { binText, consoleArg } from "../bin";
import type { RedisHost } from "./common";

function Filter({ value, onChange, placeholder }: { value: string; onChange(text: string): void; placeholder: string }) {
  return (
    <label className="kv-search kv-search-small">
      <SearchIcon size={11} />
      <input value={value} spellCheck={false} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

export function ServerView({ host, refreshSeq, onBusy }: { host: RedisHost; refreshSeq: number; onBusy(busy: boolean): void }) {
  const [part, setPart] = useState<"info" | "clients">("info");
  const [sections, setSections] = useState<InfoSection[] | null>(null);
  const [clients, setClients] = useState<{ list: ServerSession[]; canKill: boolean } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [nonce, setNonce] = useState(0);
  useEffect(() => onBusy(loading), [loading, onBusy]);

  useEffect(() => {
    let live = true;
    const ctl = new AbortController();
    setLoading(true);
    const work =
      part === "info"
        ? readInfo(host.conn, undefined, ctl.signal).then((list) => live && setSections(list))
        : store.fetchServer(host.conn).then((server) => live && setClients({ list: server.sessions ?? [], canKill: server.can_kill }));
    work.then(
      () => {
        if (live) {
          setError(null);
          setLoading(false);
        }
      },
      (reason: unknown) => {
        if (live && !isAbort(reason)) {
          setError(reason);
          setLoading(false);
        }
      },
    );
    return () => {
      live = false;
      ctl.abort();
    };
  }, [host.conn, part, nonce, refreshSeq]);

  const needle = filter.trim().toLowerCase();
  const shown = useMemo(
    () =>
      (sections ?? [])
        .map((section) => ({ ...section, entries: needle === "" || section.name.toLowerCase().includes(needle) ? section.entries : section.entries.filter(([name, value]) => name.toLowerCase().includes(needle) || value.toLowerCase().includes(needle)) }))
        .filter((section) => section.entries.length > 0),
    [sections, needle],
  );
  const shownClients = (clients?.list ?? []).filter((c) => needle === "" || [c.id, c.user, c.database, c.state, c.query].some((v) => (v ?? "").toLowerCase().includes(needle)));

  const kill = async (session: ServerSession) => {
    const ok = await confirmDialog({ title: t("클라이언트 연결 끊기"), message: t("클라이언트 {id}의 연결을 끊습니다.", { id: session.id }) + `\n\nCLIENT KILL ID ${session.id}`, confirmLabel: t("연결 끊기"), danger: true });
    if (!ok) {
      return;
    }
    try {
      await store.killSession(host.conn, session.id);
      host.notify(t("연결을 끊었습니다"));
      setNonce((n) => n + 1);
    } catch (reason) {
      notifyError(reason, { context: "admin" });
    }
  };

  return (
    <div className="kv-page">
      <div className="kv-page-bar surface-bars">
        <div className="kv-seg" role="tablist">
          <button type="button" role="tab" aria-selected={part === "info"} className={part === "info" ? "active" : undefined} onClick={() => setPart("info")}>
            INFO
          </button>
          <button type="button" role="tab" aria-selected={part === "clients"} className={part === "clients" ? "active" : undefined} onClick={() => setPart("clients")}>
            {t("클라이언트")}
            {clients !== null ? <span className="kv-tool-count">{clients.list.length}</span> : null}
          </button>
        </div>
        <span className="spacer" />
        <Filter value={filter} onChange={setFilter} placeholder={t("이름·값 찾기")} />
        <button type="button" className="kv-icon gauge-host" title={t("새로고침 (F5)")} aria-label={t("새로고침")} onClick={() => setNonce((n) => n + 1)}>
          <Gauge busy={loading} outcome={error !== null ? "error" : "ok"} />
          <RefreshIcon size={12} />
        </button>
      </div>
      <div className="kv-page-body surface-main">
        {error !== null ? <ErrorNotice error={error} context="admin" engine="redis" onRetry={() => setNonce((n) => n + 1)} /> : null}
        {part === "info" ? (
          sections === null ? null : shown.length === 0 ? (
            <div className="kv-empty panel-dim">{t("검색 결과가 없습니다")}</div>
          ) : (
            <div className="kv-info-cols">
              {shown.map((section) => (
                <section className="kv-info-section" key={section.name}>
                  <h3 className="kv-section-title">{section.name}</h3>
                  <table className="kv-grid kv-info-table">
                    <tbody>
                      {section.entries.map(([name, value]) => (
                        <tr key={name}>
                          <td className="mono kv-info-name">{name}</td>
                          <td className="mono kv-info-value" title={value}>
                            {value}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ))}
            </div>
          )
        ) : clients === null ? null : shownClients.length === 0 ? (
          <div className="kv-empty panel-dim">{t("검색 결과가 없습니다")}</div>
        ) : (
          <table className="kv-grid">
            <thead>
              <tr>
                <th>ID</th>
                <th>{t("사용자")}</th>
                <th>DB</th>
                <th>{t("주소 · 이름 · 플래그")}</th>
                <th>{t("마지막 명령")}</th>
                <th className="num">{t("유휴")}</th>
                <th className="kv-grid-actions" />
              </tr>
            </thead>
            <tbody>
              {shownClients.map((session) => (
                <tr key={session.id} className={session.is_current ? "selected" : undefined}>
                  <td className="mono">{session.id}</td>
                  <td className="mono">{session.user ?? "—"}</td>
                  <td className="mono">{session.database ?? "—"}</td>
                  <td className="mono">{session.state ?? ""}</td>
                  <td className="mono">{session.query ?? ""}</td>
                  <td className="num mono">{humanizeElapsed(session.elapsed_ms) ?? "—"}</td>
                  <td className="kv-grid-actions">
                    {session.is_current ? (
                      <span className="panel-dim">{t("이 연결")}</span>
                    ) : clients.canKill ? (
                      <button type="button" className="kv-btn small danger" onClick={() => void kill(session)}>
                        {t("연결 끊기")}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export function SlowlogView({ host, refreshSeq, onBusy }: { host: RedisHost; refreshSeq: number; onBusy(busy: boolean): void }) {
  const [slow, setSlow] = useState<SlowEntry[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [nonce, setNonce] = useState(0);
  useEffect(() => onBusy(loading), [loading, onBusy]);

  useEffect(() => {
    const ctl = new AbortController();
    setLoading(true);
    readSlowlog(host.conn, 128, ctl.signal).then(
      (list) => {
        setSlow(list);
        setError(null);
        setLoading(false);
      },
      (reason: unknown) => {
        if (!isAbort(reason)) {
          setError(reason);
          setLoading(false);
        }
      },
    );
    return () => ctl.abort();
  }, [host.conn, nonce, refreshSeq]);

  const reset = async () => {
    const ok = await confirmDialog({ title: t("SLOWLOG 비우기"), message: t("느린 명령 기록을 모두 지웁니다.") + "\n\nSLOWLOG RESET", confirmLabel: t("비우기"), danger: true });
    if (!ok) {
      return;
    }
    try {
      await slowlogReset(host.conn);
      host.notify(t("SLOWLOG를 비웠습니다"));
      setNonce((n) => n + 1);
    } catch (reason) {
      notifyError(reason, { context: "admin" });
    }
  };

  const needle = filter.trim().toLowerCase();
  const shown = (slow ?? []).filter((entry) => needle === "" || entry.args.some((arg) => binText(arg).toLowerCase().includes(needle)) || (entry.client ?? "").includes(needle) || (entry.client_name ?? "").toLowerCase().includes(needle));

  return (
    <div className="kv-page">
      <div className="kv-page-bar surface-bars">
        <span className="kv-bar-note">{t("slowlog-log-slower-than보다 오래 걸린 명령 (최근 128개)")}</span>
        <span className="spacer" />
        <Filter value={filter} onChange={setFilter} placeholder={t("명령 찾기")} />
        <button type="button" className="kv-btn" disabled={slow === null || slow.length === 0} onClick={() => void reset()}>
          <TrashIcon size={10} />
          {t("SLOWLOG 비우기")}
        </button>
        <button type="button" className="kv-icon gauge-host" title={t("새로고침 (F5)")} aria-label={t("새로고침")} onClick={() => setNonce((n) => n + 1)}>
          <Gauge busy={loading} outcome={error !== null ? "error" : "ok"} />
          <RefreshIcon size={12} />
        </button>
      </div>
      <div className="kv-page-body surface-main">
        {error !== null ? <ErrorNotice error={error} context="admin" engine="redis" onRetry={() => setNonce((n) => n + 1)} /> : null}
        {slow === null ? null : shown.length === 0 ? (
          <div className="kv-empty panel-dim">{slow.length === 0 ? t("느린 명령이 없습니다") : t("검색 결과가 없습니다")}</div>
        ) : (
          <table className="kv-grid">
            <thead>
              <tr>
                <th className="num">ID</th>
                <th>{t("시각")}</th>
                <th className="num">{t("걸린 시간")}</th>
                <th>{t("명령")}</th>
                <th>{t("클라이언트")}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((entry) => (
                <tr key={entry.id}>
                  <td className="num mono">{entry.id}</td>
                  <td className="mono">{new Date(entry.at * 1000).toLocaleString()}</td>
                  <td className="num mono">{entry.duration_us >= 1000 ? `${(entry.duration_us / 1000).toFixed(1)} ms` : `${entry.duration_us} µs`}</td>
                  <td className="mono kv-slow-cmd" title={entry.args.map(consoleArg).join(" ")}>
                    {entry.args.map(consoleArg).join(" ")}
                  </td>
                  <td className="mono">{[entry.client, entry.client_name].filter((part) => part !== null && part !== "").join(" · ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
