import { useCallback, useEffect, useState } from "react";
import {
  environmentLabel,
  getConnMeta,
  listConnMeta,
  setConnMeta,
  subscribeConnMeta,
} from "../connMeta";
import { t, tTableCount } from "../i18n";
import { store, type ConnSummary, type SavedConnection } from "../store";
import {
  CloseIcon,
  DatabaseIcon,
  FileIcon,
  PencilIcon,
  PlusIcon,
  RefreshIcon,
  TrashIcon,
} from "./icons";
import { ConnectionMetaModal } from "./ConnectionMetaModal";
import { Spinner } from "./Spinner";

interface HomeScreenProps {
  conns: ConnSummary[];
  busySaved: string | null;
  onOpenConn(id: string): void;
  onOpenNewWindow(id: string): void;
  onCloseConn(id: string): void;
  onOpenDemo(): void;
  onOpenFile(): void;
  onNewConnection(): void;
  onConnectSaved(id: string): void;
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

function relativeTime(at: number | undefined): string | null {
  if (at === undefined || at <= 0) {
    return null;
  }
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - at);
  if (seconds < 60) {
    return t("방금 전");
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return t("{count}분 전", { count: minutes });
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return t("{count}시간 전", { count: hours });
  }
  const days = Math.floor(hours / 24);
  return t("{count}일 전", { count: days });
}

function savedDetail(connection: SavedConnection): string {
  const db =
    connection.postgres ?? connection.cockroach ?? connection.mysql ?? connection.mssql;
  if (!db) {
    return t("설정 없음");
  }
  return `${db.user}@${db.host}:${db.port}/${db.database}${connection.ssh ? " · SSH" : ""}`;
}

export function HomeScreen({
  conns,
  busySaved,
  onOpenConn,
  onOpenNewWindow,
  onCloseConn,
  onOpenDemo,
  onOpenFile,
  onNewConnection,
  onConnectSaved,
}: HomeScreenProps) {
  const [saved, setSaved] = useState<SavedConnection[] | null>(null);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [metaVersion, setMetaVersion] = useState(0);
  const [editing, setEditing] = useState<SavedConnection | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const loadSaved = useCallback(async (): Promise<void> => {
    try {
      const connections = await store.listConnections();
      setSaved(connections);
      setSavedError(null);
    } catch (err) {
      setSavedError(err instanceof Error && err.message ? err.message : t("저장된 연결을 불러오지 못했습니다"));
    }
  }, []);

  useEffect(() => {
    void loadSaved();
  }, [loadSaved, nonce]);
  async function deleteSaved(connection: SavedConnection): Promise<void> {
    if (
      !window.confirm(
        t("{name} 연결을 삭제할까요? 열려 있는 세션은 유지됩니다.", {
          name: connection.name,
        }),
      )
    ) {
      return;
    }
    setDeleting(connection.id);
    setSavedError(null);
    try {
      await store.deleteConnection(connection.id);
      setConnMeta(connection.id, {
        group: "",
        color: "",
        tags: [],
        environment: "",
      });
      setSaved((current) =>
        current === null
          ? current
          : current.filter((item) => item.id !== connection.id),
      );
    } catch (err) {
      setSavedError(
        err instanceof Error && err.message
          ? err.message
          : t("저장된 연결을 삭제하지 못했습니다"),
      );
    } finally {
      setDeleting(null);
    }
  }

  useEffect(() => subscribeConnMeta(() => setMetaVersion((value) => value + 1)), []);

  const openBySaved = new Map<string, ConnSummary>();
  for (const conn of conns) {
    if (conn.saved_id !== undefined) {
      openBySaved.set(conn.saved_id, conn);
    }
  }
  const sortedSaved = (saved ?? [])
    .slice()
    .sort((a, b) => (b.last_used ?? 0) - (a.last_used ?? 0));
  const metaById = listConnMeta();
  void metaVersion;
  const groupedSaved = new Map<string, SavedConnection[]>();
  for (const connection of sortedSaved) {
    const group = metaById[connection.id]?.group ?? "";
    const list = groupedSaved.get(group) ?? [];
    list.push(connection);
    groupedSaved.set(group, list);
  }

  return (
    <div className="home">
      <div className="home-inner">
        <section className="home-hero">
          <div className="home-hero-copy">
            <div className="home-heading">
              <span className="home-mark" aria-hidden="true">
                <DatabaseIcon size={24} />
              </span>
              <div className="home-heading-text">
                <div className="home-title">{t("연결 홈")}</div>
                <div className="home-sub">{t("열린 연결을 선택하거나 새 연결을 시작하세요")}</div>
              </div>
            </div>
            <div className="home-actions">
              <button type="button" className="primary" onClick={onNewConnection}>
                <PlusIcon size={12} />
                {t("새 연결")}
              </button>
              <button type="button" onClick={onOpenFile}>
                <FileIcon size={11} />
                {t("파일 열기")}
              </button>
              <button type="button" onClick={onOpenDemo}>
                <DatabaseIcon size={11} />
                {t("데모 열기")}
              </button>
              <button type="button" onClick={() => setNonce((value) => value + 1)}>
                <RefreshIcon size={11} />
                {t("새로고침")}
              </button>
            </div>
          </div>
          <div className="home-hero-stats">
            <div className="home-stat">
              <span className="home-stat-value">{conns.length}</span>
              <span className="home-stat-label">{t("열린 연결")}</span>
            </div>
            <div className="home-stat">
              <span className="home-stat-value">
                {saved === null ? "—" : sortedSaved.length}
              </span>
              <span className="home-stat-label">{t("저장된 연결")}</span>
            </div>
          </div>
        </section>

        <section className="home-section">
          <div className="home-section-head">
            <span className="home-section-title">{t("열린 연결")}</span>
            <span className="home-section-count">{conns.length}</span>
          </div>
          {conns.length === 0 ? (
            <div className="home-empty">
              <DatabaseIcon size={18} />
              <span>{t("열린 연결이 없습니다")}</span>
            </div>
          ) : (
            <div className="home-cards">
              {conns.map((conn) => {
                const meta = getConnMeta(conn.saved_id);
                return (
                <div
                  className="home-card"
                  key={conn.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenConn(conn.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      onOpenConn(conn.id);
                    }
                  }}
                >
                  <div className="home-card-head">
                    <span className="home-card-mark" aria-hidden="true">
                      <DatabaseIcon size={18} />
                    </span>
                    <div className="home-card-identity">
                      <div className="home-card-title-row">
                        <span
                          className="home-dot"
                          aria-hidden="true"
                          style={meta?.color ? { background: meta.color } : undefined}
                        />
                        <span className="home-card-name">{conn.label}</span>
                        {meta?.environment ? (
                          <span className={`env-badge env-${meta.environment}`}>
                            {environmentLabel(meta.environment)}
                          </span>
                        ) : null}
                      </div>
                      <div className="home-card-sub">
                        <span className="home-card-path">
                          {conn.path ?? (conn.demo ? t("인메모리 데모") : "—")}
                        </span>
                        <span className="home-card-sep">·</span>
                        <span className="home-card-tables">
                          {tTableCount(conn.table_count)}
                        </span>
                      </div>
                    </div>
                    <span className="home-card-state">
                      <span className="home-card-state-dot" aria-hidden="true" />
                      {t("연결됨")}
                    </span>
                  </div>
                  <div className="home-card-badges">
                    <span className={`driver-badge ${conn.kind}`}>{badgeOf(conn.kind)}</span>
                    {meta?.group ? <span className="home-chip">{meta.group}</span> : null}
                    {conn.is_default ? <span className="home-chip">{t("기본")}</span> : null}
                  </div>
                  <div className="home-card-actions">
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        onOpenNewWindow(conn.id);
                      }}
                      title={t("새 창에서 열기")}
                    >
                      {t("새 창")}
                    </button>
                    {conn.is_default ? null : (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          onCloseConn(conn.id);
                        }}
                        title={t("닫기")}
                      >
                        <CloseIcon size={10} />
                        {t("닫기")}
                      </button>
                    )}
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </section>

        <section className="home-section">
          <div className="home-section-head">
            <span className="home-section-title">{t("저장된 연결")}</span>
            <span className="home-section-count">
              {saved === null ? "—" : sortedSaved.length}
            </span>
          </div>
          {savedError !== null ? (
            <div className="home-empty err">{savedError}</div>
          ) : saved === null ? (
            <div className="home-empty">
              <Spinner size={12} />
              <span>{t("불러오는 중…")}</span>
            </div>
          ) : sortedSaved.length === 0 ? (
            <div className="home-empty">
              <DatabaseIcon size={18} />
              <span>{t("저장된 연결이 없습니다")}</span>
            </div>
          ) : (
            <div className="home-saved-list">
              {[...groupedSaved.entries()].map(([group, groupConns]) => (
                <div className="home-saved-group" key={group === "" ? "__none" : group}>
                  {group !== "" ? <div className="home-group-title">{group}</div> : null}
                  {groupConns.map((connection) => {
                    const open = openBySaved.get(connection.id);
                    const recent = relativeTime(connection.last_used);
                    const busy = busySaved === connection.id;
                    const meta = metaById[connection.id];
                    return (
                      <div
                        className={`home-saved-row${open !== undefined ? " is-open" : ""}`}
                        key={connection.id}
                      >
                        <span
                          className="home-saved-dot"
                          aria-hidden="true"
                          style={meta?.color ? { background: meta.color } : undefined}
                        />
                        <div className="home-saved-main">
                          <div className="home-saved-title">
                            <span className={`driver-badge ${connection.driver}`}>
                              {badgeOf(connection.driver)}
                            </span>
                            <span className="home-saved-name">{connection.name}</span>
                            {meta?.environment ? (
                              <span className={`env-badge env-${meta.environment}`}>
                                {environmentLabel(meta.environment)}
                              </span>
                            ) : null}
                            {meta?.tags !== undefined && meta.tags.length > 0 ? (
                              <span className="home-saved-tags">
                                {meta.tags.map((tag) => (
                                  <span className="home-chip" key={tag}>
                                    {tag}
                                  </span>
                                ))}
                              </span>
                            ) : null}
                          </div>
                          <div className="home-saved-subline">
                            <span className="home-saved-detail">{savedDetail(connection)}</span>
                            <span className="home-saved-recent">{recent ?? ""}</span>
                          </div>
                        </div>
                        <div className="home-saved-actions">
                          <button
                            type="button"
                            className="home-saved-info"
                            onClick={() => setEditing(connection)}
                            title={t("그룹·환경·태그·색상 편집")}
                          >
                            <PencilIcon size={11} />
                            {t("정보")}
                          </button>
                          <button
                            type="button"
                            className="home-saved-delete"
                            disabled={deleting !== null}
                            onClick={() => void deleteSaved(connection)}
                            title={t("저장된 연결 삭제")}
                            aria-label={t("저장된 연결 삭제")}
                          >
                            {deleting === connection.id ? (
                              <Spinner size={10} />
                            ) : (
                              <TrashIcon size={11} />
                            )}
                          </button>
                          {open !== undefined ? (
                            <button
                              type="button"
                              className="home-saved-open"
                              onClick={() => onOpenConn(open.id)}
                              title={t("열린 연결로 전환")}
                            >
                              {t("열림")}
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="home-saved-connect"
                              disabled={busySaved !== null}
                              onClick={() => onConnectSaved(connection.id)}
                            >
                              {busy ? t("연결 중…") : t("연결")}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
      {editing !== null ? (
        <ConnectionMetaModal
          id={editing.id}
          name={editing.name}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}
