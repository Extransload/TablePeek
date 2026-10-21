import { useCallback, useEffect, useState, type CSSProperties } from "react";
import {
  environmentLabel,
  listConnMeta,
  setConnMeta,
  subscribeConnMeta,
} from "../connMeta";
import { t, tTableCount } from "../i18n";
import { store, type ConnSummary, type SavedConnection } from "../store";
import { ErrorNotice } from "./ErrorNotice";
import {
  CloseIcon,
  DatabaseIcon,
  FileIcon,
  PencilIcon,
  PlusIcon,
  RefreshIcon,
  TrashIcon,
} from "./icons";
import { DriverIcon, driverName } from "./DriverIcon";
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
  onEditConnection(connection: SavedConnection): void;
  // Bumped when the connection dialog saved a profile, so the list reloads.
  savedVersion: number;
  // The app's latest error, shown here instead of in a corner toast.
  appError: string | null;
  onDismissAppError(): void;
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
  onEditConnection,
  savedVersion,
  appError,
  onDismissAppError,
}: HomeScreenProps) {
  const [saved, setSaved] = useState<SavedConnection[] | null>(null);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [metaVersion, setMetaVersion] = useState(0);
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
  }, [loadSaved, nonce, savedVersion]);
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

  function renderCard(connection: SavedConnection) {
    const open = openBySaved.get(connection.id);
    const recent = relativeTime(connection.last_used);
    const busy = busySaved === connection.id;
    const meta = metaById[connection.id];
    const activate = (): void => {
      if (open !== undefined) {
        onOpenConn(open.id);
      } else if (busySaved === null) {
        onConnectSaved(connection.id);
      }
    };
    const style = meta?.color ? ({ "--card-color": meta.color } as CSSProperties) : undefined;
    return (
      <div
        className={`home-card${open !== undefined ? " is-open" : ""}${meta?.color ? " has-color" : ""}`}
        key={connection.id}
        style={style}
        role="button"
        tabIndex={0}
        onClick={activate}
        onKeyDown={(event) => {
          // Enter on an inner button belongs to that button, not the card.
          if (event.key === "Enter" && event.target === event.currentTarget) {
            activate();
          }
        }}
      >
        <div className="home-card-head">
          <DriverIcon kind={connection.driver} size={38} className="home-card-logo" />
          <div className="home-card-identity">
            <div className="home-card-title-row">
              <span className="home-card-name">{connection.name}</span>
              {meta?.environment ? (
                <span className={`env-badge env-${meta.environment}`}>
                  {environmentLabel(meta.environment)}
                </span>
              ) : null}
            </div>
            <div className="home-card-sub">
              <span className="home-card-path">{savedDetail(connection)}</span>
              {open !== undefined ? (
                <>
                  <span className="home-card-sep">·</span>
                  <span className="home-card-tables">{tTableCount(open.table_count)}</span>
                </>
              ) : null}
            </div>
          </div>
          {busy ? (
            <span className="home-card-state idle">
              <Spinner size={10} />
              {t("연결 중…")}
            </span>
          ) : open !== undefined ? (
            <span className="home-card-state">
              <span className="home-card-state-dot" aria-hidden="true" />
              {t("연결됨")}
            </span>
          ) : recent !== null ? (
            <span className="home-card-state idle">{recent}</span>
          ) : null}
        </div>
        <div className="home-card-badges">
          <span className="home-driver">{driverName(connection.driver)}</span>
          {connection.ssh ? <span className="home-chip">SSH</span> : null}
          {(meta?.tags ?? []).map((tag) => (
            <span className="home-chip" key={tag}>
              {tag}
            </span>
          ))}
        </div>
        <div className="home-card-actions">
          {open !== undefined ? (
            <>
              <button
                type="button"
                className="home-card-primary"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenConn(open.id);
                }}
                title={t("열린 연결로 전환")}
              >
                {t("열기")}
              </button>
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  onOpenNewWindow(open.id);
                }}
                title={t("새 창에서 열기")}
              >
                {t("새 창")}
              </button>
              {open.is_default ? null : (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseConn(open.id);
                  }}
                  title={t("연결 끊기")}
                >
                  <CloseIcon size={10} />
                  {t("연결 끊기")}
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              className="home-card-primary"
              disabled={busySaved !== null}
              onClick={(event) => {
                event.stopPropagation();
                onConnectSaved(connection.id);
              }}
              title={t("연결")}
            >
              {busy ? t("연결 중…") : t("연결")}
            </button>
          )}
          <span className="spacer" />
          <button
            type="button"
            className="home-card-icon"
            onClick={(event) => {
              event.stopPropagation();
              onEditConnection(connection);
            }}
            title={t("연결 편집")}
            aria-label={t("연결 편집")}
          >
            <PencilIcon size={11} />
          </button>
          <button
            type="button"
            className="home-card-icon danger"
            disabled={deleting !== null}
            onClick={(event) => {
              event.stopPropagation();
              void deleteSaved(connection);
            }}
            title={t("저장된 연결 삭제")}
            aria-label={t("저장된 연결 삭제")}
          >
            {deleting === connection.id ? <Spinner size={10} /> : <TrashIcon size={11} />}
          </button>
        </div>
      </div>
    );
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
                <div className="home-sub">{t("저장된 연결을 선택하거나 새 연결을 만드세요")}</div>
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
        </section>

        {appError !== null && appError !== savedError ? (
          <ErrorNotice message={appError} onClose={onDismissAppError} />
        ) : null}

        <section className="home-section">
          <div className="home-section-head">
            <span className="home-section-title">{t("저장된 연결")}</span>
            <span className="home-section-count">
              {saved === null ? "—" : sortedSaved.length}
            </span>
          </div>
          {savedError !== null ? (
            <ErrorNotice message={savedError} />
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
                  <div className="home-cards">{groupConns.map(renderCard)}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
