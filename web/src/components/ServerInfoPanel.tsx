import { useCallback, useEffect, useState } from "react";
import { formatBytes, humanizeElapsed } from "../format";
import { store, type ServerInfo, type ServerSession } from "../store";
import { RefreshIcon } from "./icons";
import { Spinner } from "./Spinner";

function errorOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function valueText(value: string | null): string {
  return value === null || value === "" ? "—" : value;
}

interface InfoCard {
  name: string;
  value: string;
  clamp?: boolean;
}

function compatibilityOf(info: ServerInfo): string | null {
  const version = (info.version ?? "").toLowerCase();
  if (info.driver === "mysql" && version.includes("mariadb")) {
    return "MariaDB (MySQL 호환)";
  }
  if (info.driver === "mysql" && version.includes("percona")) {
    return "Percona Server (MySQL 호환)";
  }
  if (info.driver === "postgres" && version.includes("yugabyte")) {
    return "YugabyteDB (PostgreSQL 호환)";
  }
  if (info.driver === "postgres" && version.includes("redshift")) {
    return "Amazon Redshift (PostgreSQL 호환)";
  }
  if (info.driver === "cockroach") {
    return "CockroachDB (PostgreSQL 호환)";
  }
  return null;
}

function cardsOf(info: ServerInfo): InfoCard[] {
  const size = formatBytes(info.size_bytes);
  const compatibility = compatibilityOf(info);
  return [
    { name: "드라이버", value: valueText(info.driver) },
    ...(compatibility === null
      ? []
      : [{ name: "호환 모드", value: compatibility }]),
    { name: "버전", value: valueText(info.version), clamp: true },
    { name: "데이터베이스", value: valueText(info.database) },
    { name: "인코딩", value: valueText(info.encoding) },
    { name: "업타임", value: valueText(info.uptime) },
    { name: "크기", value: size ?? "—" },
  ];
}

export function ServerInfoPanel({ conn }: { conn: string }) {
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [killing, setKilling] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const next = await store.fetchServer(conn);
      setInfo(next);
    } catch (err) {
      setError(errorOf(err, "서버 정보를 불러오지 못했습니다"));
    } finally {
      setLoading(false);
    }
  }, [conn]);

  useEffect(() => {
    void load();
  }, [load, nonce]);

  async function kill(session: ServerSession): Promise<void> {
    if (!window.confirm("이 세션을 종료할까요?")) {
      return;
    }
    setKilling(session.id);
    setError(null);
    try {
      await store.killSession(conn, session.id);
      await load();
    } catch (err) {
      setError(errorOf(err, "세션을 종료하지 못했습니다"));
    } finally {
      setKilling(null);
    }
  }

  const cards = info ? cardsOf(info) : [];
  const sessions = info ? info.sessions : null;

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">서버 정보</span>
        {info ? <span className="panel-stat">{info.driver}</span> : null}
        <span className="spacer" />
        {loading ? (
              <span className="panel-dim">
                <Spinner size={10} /> 불러오는 중…
              </span>
            ) : null}
        <button
          type="button"
          className="icon-text-button"
          disabled={loading}
          onClick={() => setNonce((value) => value + 1)}
          title="서버 정보 새로고침"
        >
          <RefreshIcon size={11} />
          새로고침
        </button>
      </div>
      <div className="panel-body">
        {error ? <div className="panel-error">{error}</div> : null}
        {info === null ? (
          error ? null : (
            <div className="panel-empty">불러오는 중…</div>
          )
        ) : (
          <>
            <div className="info-cards">
              {cards.map((card) => (
                <div className="info-card" key={card.name}>
                  <div className="info-card-name">{card.name}</div>
                  <div
                    className={`info-card-value${card.clamp ? " clamp3" : ""}`}
                    title={card.value}
                  >
                    {card.value}
                  </div>
                </div>
              ))}
            </div>
            <div className="panel-section">
              <div className="panel-section-title">
                세션
                {sessions !== null ? (
                  <span className="panel-count">{sessions.length}</span>
                ) : null}
                <span className="spacer" />
                {info.can_kill ? (
                  <span className="panel-dim">종료 가능</span>
                ) : null}
              </div>
              {sessions === null ? (
                <div className="panel-empty-inline">
                  이 엔진은 세션 목록을 지원하지 않습니다
                </div>
              ) : sessions.length === 0 ? (
                <div className="panel-empty-inline">세션이 없습니다</div>
              ) : (
                <table className="panel-table sessions-table">
                  <thead>
                    <tr>
                      <th>ID</th>
                      <th>사용자</th>
                      <th>DB</th>
                      <th>상태</th>
                      <th>경과</th>
                      <th>쿼리</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((session) => {
                      const elapsed = humanizeElapsed(session.elapsed_ms);
                      return (
                        <tr
                          key={session.id}
                          className={
                            session.is_current ? "session-current" : ""
                          }
                        >
                          <td className="mono">{session.id}</td>
                          <td className="dim">{valueText(session.user)}</td>
                          <td className="dim">{valueText(session.database)}</td>
                          <td>
                            {session.state ? (
                              <span className="badge-state">
                                {session.state}
                              </span>
                            ) : (
                              <span className="dim">—</span>
                            )}
                          </td>
                          <td className="mono dim">{elapsed ?? "—"}</td>
                          <td>
                            <span
                              className="session-query"
                              title={session.query ?? ""}
                            >
                              {session.query ?? ""}
                            </span>
                          </td>
                          <td className="session-action">
                            {session.is_current ? (
                              <span className="dim">현재 세션</span>
                            ) : info.can_kill ? (
                              <button
                                type="button"
                                disabled={killing !== null}
                                onClick={() => void kill(session)}
                                title="세션 종료"
                              >
                                {killing === session.id ? "종료 중…" : "종료"}
                              </button>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
