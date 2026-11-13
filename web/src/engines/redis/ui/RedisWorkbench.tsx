// The key-value workbench (Redis, Valkey), modelled on RedisInsight's
// Browser: it owns the whole area under the connection bar. On top, the
// database overview (database picker with key counts, keys, memory, ops/s,
// clients, version; read again every 5 seconds while the page shows) and
// the sections: Browser (key list | key details), CLI, Slow log, Server.

import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Gauge } from "../../../components/Gauge";
import { SafeModeMenu } from "../../../components/SafeModeMenu";
import { Select } from "../../../components/Select";
import { formatBytes } from "../../../format";
import { t } from "../../../i18n";
import type { SafeMode } from "../../../sqlTools";
import { isAbort, overview as readOverview, type Overview } from "../api";
import { binId, type Bin } from "../bin";
import { CliView } from "./CliView";
import type { KeyChange, RedisHost } from "./common";
import { CreateKeyModal } from "./Dialogs";
import { KeyDetails } from "./KeyDetails";
import { KeyList, type KeyListPrefs } from "./KeyList";
import { ServerView, SlowlogView } from "./ServerView";
import "../redis.css";

export type RedisSection = "browser" | "cli" | "slowlog" | "server";

// What the workbench keeps between visits (saved with the connection's tabs).
export interface RedisState {
  section: RedisSection;
  key: { db: number; key: Bin; type: string } | null;
  list: KeyListPrefs;
  cliText: string;
  // The CLI's database; SELECT moves it. Null: the connection's.
  cliDb: number | null;
}

export const DEFAULT_REDIS_STATE: RedisState = {
  section: "browser",
  key: null,
  list: { view: "tree", delimiter: ":", pattern: "", types: [] },
  cliText: "",
  cliDb: null,
};

// Something the app asks for (command palette, ⌘T).
export interface RedisRequest {
  seq: number;
  kind: "cli" | "server" | "create";
}

const WIDTH_KEY = "tablepeek.redis-keys-width";
const POLL_MS = 5000;

function savedWidth(): number {
  const value = Number(localStorage.getItem(WIDTH_KEY));
  return Number.isFinite(value) && value >= 240 ? value : 440;
}

interface RedisWorkbenchProps {
  conn: string;
  // Where the CLI history is kept (the saved connection).
  connKey: string;
  // The connection's database and "host:port".
  db: number;
  address: string;
  readOnly: boolean;
  safeMode: SafeMode;
  onSafeMode(mode: SafeMode): void;
  notify(message: string): void;
  // F5 and the like.
  refreshSeq: number;
  state: RedisState;
  onState(next: RedisState): void;
  onSwitchDb(db: number): void;
  request: RedisRequest | null;
}

export function RedisWorkbench({ conn, connKey, db, address, readOnly, safeMode, onSafeMode, notify, refreshSeq, state, onState, onSwitchDb, request }: RedisWorkbenchProps) {
  const [overview, setOverview] = useState<Overview | null>(null);
  // Why the last overview read failed; null while it reads fine.
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [overviewSeq, setOverviewSeq] = useState(0);
  const [change, setChange] = useState<{ seq: number; change: KeyChange } | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [width, setWidth] = useState(savedWidth);
  const [busy, setBusy] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;
  const patch = useCallback((next: Partial<RedisState>) => onState({ ...stateRef.current, ...next }), [onState]);

  // A change on this page: the list follows, the details follow the key.
  const onKeyChange = useCallback(
    (c: KeyChange) => {
      setChange((prev) => ({ seq: (prev?.seq ?? 0) + 1, change: c }));
      setOverviewSeq((n) => n + 1);
      const current = stateRef.current.key;
      if (current === null || current.db !== c.db || binId(current.key) !== binId(c.key)) {
        return;
      }
      if (c.kind === "deleted") {
        patch({ key: null });
      } else if (c.kind === "renamed") {
        patch({ key: { ...current, key: c.to } });
      }
    },
    [patch],
  );
  const host: RedisHost = { conn, notify, safeMode, readOnly, onKeyChange };

  // The overview, every few seconds while the page is in sight.
  useEffect(() => {
    let ctl: AbortController | null = null;
    const read = () => {
      if (document.visibilityState !== "visible") {
        return;
      }
      ctl?.abort();
      ctl = new AbortController();
      readOverview(conn, ctl.signal).then(
        (next) => {
          setOverview(next);
          setOverviewError(null);
        },
        (reason: unknown) => {
          if (!isAbort(reason)) {
            setOverview(null);
            setOverviewError(reason instanceof Error ? reason.message : String(reason));
          }
        },
      );
    };
    read();
    const timer = window.setInterval(read, POLL_MS);
    document.addEventListener("visibilitychange", read);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", read);
      ctl?.abort();
    };
  }, [conn, db, refreshSeq, overviewSeq]);

  useEffect(() => {
    if (request === null) {
      return;
    }
    if (request.kind === "create") {
      patch({ section: "browser" });
      setCreating("");
    } else {
      patch({ section: request.kind });
    }
    // Only a new request counts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.seq]);

  const openCli = useCallback((text: string) => patch({ section: "cli", cliText: text }), [patch]);
  const onBusy = useCallback((value: boolean) => setBusy(value), []);

  const dragSplit = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startW = width;
    const box = event.currentTarget.parentElement;
    const max = Math.max(280, (box?.clientWidth ?? 1200) - 320);
    let last = startW;
    const move = (e: PointerEvent) => {
      last = Math.max(240, Math.min(max, startW + e.clientX - startX));
      setWidth(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      localStorage.setItem(WIDTH_KEY, String(Math.round(last)));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Without the overview the counts are unknown: the picker lists the
  // database in use alone, without claiming it is empty.
  const dbs = overview?.databases ?? [{ index: db, keys: -1, expires: 0 }];
  const dbSize = overview?.databases.find((entry) => entry.index === db)?.keys ?? null;
  const selected = state.key !== null && state.key.db === db ? state.key : null;
  const sections: { id: RedisSection; label: string }[] = [
    { id: "browser", label: t("브라우저") },
    { id: "cli", label: "CLI" },
    { id: "slowlog", label: t("느린 로그") },
    { id: "server", label: t("서버") },
  ];

  return (
    <div className="kv-wb">
      <div className="kv-top surface-top">
        <Select className="kv-db" aria-label={t("데이터베이스")} value={String(db)} onChange={(event) => onSwitchDb(Number(event.target.value))}>
          {dbs.map((entry) => (
            <option key={entry.index} value={entry.index}>
              {entry.keys > 0
                ? t("db{index} · 키 {count}개", { index: entry.index, count: entry.keys.toLocaleString() })
                : entry.keys === 0
                  ? t("db{index} · 비어 있음", { index: entry.index })
                  : `db${entry.index}`}
            </option>
          ))}
        </Select>
        <div className="kv-stats" aria-live="off" title={overviewError ?? undefined}>
          {overviewError !== null ? <span className="kv-stat-error">{t("서버 개요를 읽지 못했습니다")}</span> : null}
          <span className="kv-stat" title={t("모든 데이터베이스의 키")}>
            <span className="kv-stat-k">{t("키")}</span>
            <span className="kv-stat-v">{overview !== null ? overview.keys_total.toLocaleString() : "—"}</span>
          </span>
          <span className="kv-stat" title="used_memory">
            <span className="kv-stat-k">{t("메모리")}</span>
            <span className="kv-stat-v">{overview !== null ? (formatBytes(overview.used_memory) ?? "—") : "—"}</span>
          </span>
          <span className="kv-stat" title="instantaneous_ops_per_sec">
            <span className="kv-stat-k">ops/s</span>
            <span className="kv-stat-v">{overview !== null ? overview.ops_per_sec.toLocaleString() : "—"}</span>
          </span>
          <span className="kv-stat" title="connected_clients">
            <span className="kv-stat-k">{t("연결된 클라이언트")}</span>
            <span className="kv-stat-v">{overview !== null ? overview.connected_clients.toLocaleString() : "—"}</span>
          </span>
          <span className="kv-stat kv-stat-version">
            <span className="kv-stat-k">{overview?.flavor === "valkey" ? "Valkey" : "Redis"}</span>
            <span className="kv-stat-v">{overview?.version ?? "—"}</span>
          </span>
        </div>
        <span className="spacer" />
        <div className="kv-sections" role="tablist" aria-label={t("화면")}>
          {sections.map((section) => (
            <button key={section.id} type="button" role="tab" aria-selected={state.section === section.id} className={state.section === section.id ? "active" : undefined} onClick={() => patch({ section: section.id })}>
              {section.label}
            </button>
          ))}
        </div>
        <span className="kv-top-gauge gauge-host" aria-hidden="true">
          <Gauge busy={busy} />
        </span>
        <SafeModeMenu mode={safeMode} onChange={onSafeMode} compact />
      </div>
      <div className="kv-main">
        {state.section === "browser" ? (
          <div className="kv-browser" style={{ "--kv-keys-w": `${width}px` } as CSSProperties}>
            <div className="kv-keys-pane surface-left">
              <KeyList
                host={host}
                db={db}
                total={dbSize}
                refreshSeq={refreshSeq}
                change={change}
                selected={selected?.key ?? null}
                onSelect={(entry) => patch({ key: entry === null ? null : { db, key: entry.key, type: entry.type } })}
                onCreate={(prefix) => setCreating(prefix)}
                onOpenCli={openCli}
                prefs={state.list}
                onPrefs={(list) => patch({ list })}
              />
            </div>
            <div
              className="kv-split"
              role="separator"
              aria-orientation="vertical"
              aria-label={t("목록 너비")}
              tabIndex={0}
              onPointerDown={dragSplit}
              onDoubleClick={() => {
                setWidth(440);
                localStorage.removeItem(WIDTH_KEY);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
                  event.preventDefault();
                  const next = Math.max(240, width + (event.key === "ArrowLeft" ? -24 : 24));
                  setWidth(next);
                  localStorage.setItem(WIDTH_KEY, String(next));
                }
              }}
            />
            <div className="kv-details-pane surface-main">
              {selected !== null ? (
                <KeyDetails key={`${selected.db}:${binId(selected.key)}`} host={host} db={db} keyName={selected.key} refreshSeq={refreshSeq} onBusy={onBusy} onOpenCli={openCli} />
              ) : (
                <div className="kv-empty-state">
                  <div className="kv-empty-title">{t("키를 고르세요")}</div>
                  <p className="panel-dim">{t("왼쪽 목록에서 키를 고르면 값이 여기에 나옵니다.")}</p>
                  {!readOnly ? (
                    <button type="button" className="kv-btn" onClick={() => setCreating("")}>
                      {t("키 만들기…")}
                    </button>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        ) : state.section === "cli" ? (
          <CliView
            host={host}
            connKey={connKey}
            address={address}
            db={state.cliDb ?? db}
            onDbChange={(cliDb) => patch({ cliDb })}
            text={state.cliText}
            onTextChange={(cliText) => patch({ cliText })}
            onBusy={onBusy}
          />
        ) : state.section === "slowlog" ? (
          <SlowlogView host={host} refreshSeq={refreshSeq} onBusy={onBusy} />
        ) : (
          <ServerView host={host} refreshSeq={refreshSeq} onBusy={onBusy} />
        )}
      </div>
      {creating !== null ? (
        <CreateKeyModal
          host={host}
          db={db}
          prefix={creating}
          onCreated={(key, type) => patch({ section: "browser", key: { db, key, type } })}
          onClose={() => setCreating(null)}
        />
      ) : null}
    </div>
  );
}

