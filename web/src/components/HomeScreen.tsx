import { useCallback, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  listConnMeta,
  setConnMeta,
  subscribeConnMeta,
  type ConnMeta,
} from "../connMeta";
import { t, tTableCount } from "../i18n";
import { store, type ConnSummary, type Driver, type SavedConnection } from "../store";
import { BrandMark } from "./BrandLogo";
import { DriverIcon, driverName } from "./DriverIcon";
import { ErrorNotice } from "./ErrorNotice";
import { CloseIcon, ExternalIcon, FileIcon, PencilIcon, PlusIcon, TrashIcon } from "./icons";
import { Spinner } from "./Spinner";

interface HomeScreenProps {
  conns: ConnSummary[];
  busySaved: string | null;
  onOpenConn(id: string): void;
  onOpenNewWindow(id: string): void;
  onCloseConn(id: string): void;
  onOpenFile(): void;
  // Opens the connection dialog, preset to `driver` when one was picked.
  onNewConnection(driver?: Driver): void;
  onConnectSaved(id: string): void;
  onEditConnection(connection: SavedConnection): void;
  // Bumped when the connection dialog saved a profile, so the list reloads.
  savedVersion: number;
  // The app's latest error, shown here instead of in a corner toast.
  appError: string | null;
  onDismissAppError(): void;
}

// What the "new connection" card offers; SQLite opens a file instead.
const ADD_CHOICES: (Driver | "sqlite")[] = ["postgres", "mysql", "mssql", "cockroach", "sqlite"];

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

function savedTarget(connection: SavedConnection) {
  return connection.postgres ?? connection.cockroach ?? connection.mysql ?? connection.mssql ?? null;
}

// "host : database", as TablePlus lists connections.
function savedAddress(connection: SavedConnection): string {
  const db = savedTarget(connection);
  if (db === null) {
    return t("설정 없음");
  }
  return db.database ? `${db.host} : ${db.database}` : db.host;
}

function savedDetail(connection: SavedConnection): string {
  const db = savedTarget(connection);
  if (db === null) {
    return connection.name;
  }
  const ssh = connection.ssh ? ` · SSH ${connection.ssh.user}@${connection.ssh.host}` : "";
  return `${db.user}@${db.host}:${db.port}/${db.database}${ssh}`;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

// Environment and tags as pills; the connection's color goes into them.
function tagPills(meta: ConnMeta | undefined): ReactNode {
  if (meta === undefined) {
    return null;
  }
  const pills: { text: string; environment: string }[] = [];
  if (meta.environment !== "") {
    pills.push({ text: meta.environment, environment: meta.environment });
  }
  for (const tag of meta.tags) {
    pills.push({ text: tag, environment: "" });
  }
  if (pills.length === 0) {
    return meta.color ? (
      <span className="home-color-dot" style={{ background: meta.color }} aria-hidden="true" />
    ) : null;
  }
  const style = meta.color ? ({ "--tag-color": meta.color } as CSSProperties) : undefined;
  return pills.map((pill) => (
    <span
      key={`${pill.environment}:${pill.text}`}
      className={`home-tag${pill.environment ? ` env-${pill.environment}` : ""}${meta.color || pill.environment ? " colored" : ""}`}
      style={style}
    >
      {pill.text}
    </span>
  ));
}

export function HomeScreen({
  conns,
  busySaved,
  onOpenConn,
  onOpenNewWindow,
  onCloseConn,
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
  }, [loadSaved, savedVersion]);

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
  // Files and the demo are open without a saved profile; they list first.
  const unsaved = conns.filter((conn) => conn.saved_id === undefined);
  const sortedSaved = (saved ?? [])
    .slice()
    .sort((a, b) => (b.last_used ?? 0) - (a.last_used ?? 0));
  const metaById = listConnMeta();
  void metaVersion;
  const groups = new Map<string, SavedConnection[]>([["", []]]);
  for (const connection of sortedSaved) {
    const group = metaById[connection.id]?.group ?? "";
    const list = groups.get(group) ?? [];
    list.push(connection);
    groups.set(group, list);
  }

  function cardShell(
    key: string,
    open: boolean,
    activate: () => void,
    title: string,
    content: ReactNode,
  ): ReactNode {
    return (
      <div
        key={key}
        className={`home-card${open ? " is-open" : ""}`}
        role="button"
        tabIndex={0}
        title={title}
        onClick={activate}
        onKeyDown={(event) => {
          // Keys on an inner button belong to that button, not the card.
          if ((event.key === "Enter" || event.key === " ") && event.target === event.currentTarget) {
            event.preventDefault();
            activate();
          }
        }}
      >
        {content}
      </div>
    );
  }

  function openActions(open: ConnSummary): ReactNode {
    return (
      <>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpenNewWindow(open.id);
          }}
          title={t("새 창에서 열기")}
          aria-label={t("새 창에서 열기")}
        >
          <ExternalIcon size={11} />
        </button>
        {open.is_default ? null : (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onCloseConn(open.id);
            }}
            title={t("연결 끊기")}
            aria-label={t("연결 끊기")}
          >
            <CloseIcon size={10} />
          </button>
        )}
      </>
    );
  }

  function connectedState(open: ConnSummary): ReactNode {
    return (
      <span className="home-card-state">
        <span className="home-card-state-dot" aria-hidden="true" />
        {tTableCount(open.table_count)}
      </span>
    );
  }

  function renderSaved(connection: SavedConnection): ReactNode {
    const open = openBySaved.get(connection.id);
    const busy = busySaved === connection.id;
    const recent = relativeTime(connection.last_used);
    const activate = (): void => {
      if (open !== undefined) {
        onOpenConn(open.id);
      } else if (busySaved === null) {
        onConnectSaved(connection.id);
      }
    };
    return cardShell(
      connection.id,
      open !== undefined,
      activate,
      `${connection.name} — ${savedDetail(connection)}`,
      <>
        <DriverIcon kind={connection.driver} size={34} className="home-card-logo" />
        <div className="home-card-body">
          <div className="home-card-title">
            <span className="home-card-name">{connection.name}</span>
            {tagPills(metaById[connection.id])}
          </div>
          <div className="home-card-sub">
            <span className="home-card-address">{savedAddress(connection)}</span>
            {connection.ssh ? <span className="home-card-ssh">SSH</span> : null}
          </div>
        </div>
        <div className="home-card-side">
          <div className="home-card-actions">
            {open !== undefined ? openActions(open) : null}
            <button
              type="button"
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
              className="danger"
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
          {busy ? (
            <span className="home-card-state idle">
              <Spinner size={10} />
              {t("연결 중…")}
            </span>
          ) : open !== undefined ? (
            connectedState(open)
          ) : recent !== null ? (
            <span className="home-card-state idle">{recent}</span>
          ) : null}
        </div>
      </>,
    );
  }

  function renderUnsaved(conn: ConnSummary): ReactNode {
    const name = conn.demo ? t("데모 데이터베이스") : conn.path ? basename(conn.path) : conn.label;
    const address = conn.demo ? t("인메모리 데모") : (conn.path ?? conn.label);
    return cardShell(
      conn.id,
      true,
      () => onOpenConn(conn.id),
      `${name} — ${address}`,
      <>
        <DriverIcon kind={conn.kind} size={34} className="home-card-logo" />
        <div className="home-card-body">
          <div className="home-card-title">
            <span className="home-card-name">{name}</span>
          </div>
          <div className="home-card-sub">
            <span className="home-card-address">{address}</span>
          </div>
        </div>
        <div className="home-card-side">
          <div className="home-card-actions">{openActions(conn)}</div>
          {connectedState(conn)}
        </div>
      </>,
    );
  }

  const addCard = (
    <div className="home-add" key="__add">
      <button type="button" className="home-add-main" onClick={() => onNewConnection()}>
        <span className="home-add-plus" aria-hidden="true">
          <PlusIcon size={13} />
        </span>
        <span className="home-add-text">
          <span className="home-add-title">{t("새 연결")}</span>
          <span className="home-add-sub">{t("추가할 데이터베이스를 고르세요")}</span>
        </span>
      </button>
      <div className="home-add-drivers">
        {ADD_CHOICES.map((choice) => {
          const label =
            choice === "sqlite"
              ? t("SQLite 파일 열기")
              : t("{driver} 연결 추가", { driver: driverName(choice) });
          return (
            <button
              type="button"
              key={choice}
              onClick={() => (choice === "sqlite" ? onOpenFile() : onNewConnection(choice))}
              title={label}
              aria-label={label}
            >
              <DriverIcon kind={choice} size={24} />
            </button>
          );
        })}
      </div>
    </div>
  );

  const failed = savedError !== null;
  const empty = saved !== null && sortedSaved.length === 0 && unsaved.length === 0;
  const sections = [...groups.entries()].filter(
    ([group, list]) => list.length > 0 || (group === "" && unsaved.length > 0),
  );
  // Even with nothing to list (say, the saved list failed to load), the add
  // card stays reachable.
  if (sections.length === 0) {
    sections.push(["", []]);
  }

  let body: ReactNode;
  if (saved === null && !failed) {
    body = (
      <div className="home-loading">
        <Spinner size={12} />
        <span>{t("불러오는 중…")}</span>
      </div>
    );
  } else if (empty && !failed) {
    body = <HomeWelcome onNewConnection={onNewConnection} onOpenFile={onOpenFile} />;
  } else {
    body = (
      <>
        {failed ? (
          <div className="home-load-error">
            <ErrorNotice message={savedError} />
            <button type="button" onClick={() => void loadSaved()}>
              {t("다시 시도")}
            </button>
          </div>
        ) : null}
        {sections.map(([group, list], index) => (
          <section className="home-group" key={group === "" ? "__none" : group}>
            {group !== "" ? <h2 className="home-group-title">{group}</h2> : null}
            <div className="home-grid">
              {group === "" ? unsaved.map(renderUnsaved) : null}
              {list.map(renderSaved)}
              {index === sections.length - 1 ? addCard : null}
            </div>
          </section>
        ))}
      </>
    );
  }

  return (
    <div className="home">
      <div className="home-inner">
        {appError !== null && appError !== savedError ? (
          <ErrorNotice message={appError} onClose={onDismissAppError} />
        ) : null}
        {body}
      </div>
    </div>
  );
}

interface HomeWelcomeProps {
  onNewConnection(driver?: Driver): void;
  onOpenFile(): void;
}

// First run: nothing saved and nothing open yet.
function HomeWelcome({ onNewConnection, onOpenFile }: HomeWelcomeProps) {
  return (
    <div className="home-welcome">
      <div className="home-welcome-brand" aria-hidden="true">
        <BrandMark size={60} />
        <span className="home-welcome-word">
          Table<span className="brand-word-peek">Peek</span>
        </span>
      </div>
      <h1 className="home-welcome-title">{t("첫 데이터베이스를 연결해 보세요")}</h1>
      <p className="home-welcome-lead">
        {t("테이블을 둘러보고, 쿼리를 실행하고, 데이터를 바로 고칠 수 있습니다.")}
      </p>
      <div className="home-welcome-drivers">
        {ADD_CHOICES.map((choice) => (
          <button
            type="button"
            key={choice}
            onClick={() => (choice === "sqlite" ? onOpenFile() : onNewConnection(choice))}
          >
            <DriverIcon kind={choice} size={20} />
            <span>{driverName(choice)}</span>
          </button>
        ))}
      </div>
      <div className="home-welcome-info">
        <div className="home-welcome-label">{t("연결할 때 필요한 정보")}</div>
        <ul>
          <li>{t("호스트와 포트 (예: 127.0.0.1 : 5432)")}</li>
          <li>{t("사용자 이름과 비밀번호")}</li>
          <li>{t("데이터베이스 이름")}</li>
          <li>{t("필요하면 SSH 터널이나 SSL 인증서")}</li>
        </ul>
        <p>{t("postgres://… 같은 연결 URL을 호스트 칸에 붙여 넣으면 나머지가 자동으로 채워집니다.")}</p>
      </div>
      <div className="home-welcome-actions">
        <button type="button" className="primary" onClick={() => onNewConnection()}>
          <PlusIcon size={12} />
          {t("시작하기")}
        </button>
        <button type="button" onClick={onOpenFile}>
          <FileIcon size={11} />
          {t("SQLite 파일 열기")}
        </button>
      </div>
      <p className="home-welcome-note">
        {t("연결 정보는 이 컴퓨터(~/.tablepeek)에만 저장됩니다. 비밀번호는 저장을 고른 경우에만 OS 키체인에 보관됩니다.")}
      </p>
      <p className="home-welcome-note">
        {t("데모 데이터로 먼저 둘러보려면 make run DEMO=1 로 실행하세요.")}
      </p>
    </div>
  );
}
