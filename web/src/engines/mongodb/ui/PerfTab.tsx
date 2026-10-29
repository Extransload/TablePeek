// The connection's 성능 tab (MONGODB.md §6.2): every two seconds while it is
// shown, a `serverStatus` sample (charted as rates over the last five
// minutes), the running operations (`currentOp`, killable after a
// confirmation) and per-collection time (`top`). Below, the profiler of one
// database: its level, changed after a confirmation, and the latest 50
// `system.profile` entries. Pausing, switching tabs or hiding the window
// stops the polling; the charts keep their history per tab.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { ErrorNotice, notifyError } from "../../../components/ErrorNotice";
import { PlayIcon, RefreshIcon, StopIcon } from "../../../components/icons";
import { useThemeColors } from "../../../components/ResultChart";
import { ReviewModal } from "../../../components/ReviewModal";
import { Select } from "../../../components/Select";
import { Spinner } from "../../../components/Spinner";
import { formatBytes } from "../../../format";
import { t } from "../../../i18n";
import type { ReviewItem, SafeMode } from "../../../sqlTools";
import * as api from "../api";
import { BsonDate, Int32, isDocument, type BsonDocument } from "../bson";
import { toShell, toShellPretty } from "../format";
import { OP_KINDS, POLL_MS, POLL_TIMEOUT_MS, WINDOW_MS, appendPoint, axisSteps, perfPoint, runningOps, topRows, type PerfPoint, type RunningOp, type TopRow } from "../perf";
import { ShellText } from "./ShellText";
import "./panels.css";
import "./perf.css";

export interface PerfTabProps {
  conn: string;
  // Unique per tab: the charts' history survives switching away.
  tabKey: string;
  // The database the profiler section starts on.
  db: string;
  safeMode: SafeMode;
  notify(message: string): void;
}

interface Remembered {
  points: PerfPoint[];
  last: api.PerfSample | null;
  paused: boolean;
  profileDb: string;
}

const memory = new Map<string, Remembered>();

// Profiler entries are read again every this many polls while it is on.
const PROFILE_EVERY = 5;

interface ProfileStatus {
  level: number;
  slowms: number;
}

function msText(ms: number): string {
  if (ms < 1) return ms === 0 ? "0 ms" : `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${Math.round(ms).toLocaleString()} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

function rateText(v: number): string {
  return v >= 100 || Number.isInteger(v) ? Math.round(v).toLocaleString() : v.toFixed(1);
}

function countTick(v: number): string {
  return v >= 1_000_000 ? `${v / 1_000_000}M` : v >= 1000 ? `${v / 1000}k` : String(v);
}

function uptimeText(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d > 0 ? t("{d}일 {h}시간", { d, h }) : h > 0 ? t("{h}시간 {m}분", { h, m }) : t("{m}분", { m });
}

function clockText(ms: number, seconds = false): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hour12: false });
}

// One line of a command for a table cell; the full text is its tooltip.
function preview(doc: BsonDocument | null): string {
  if (doc === null) return "";
  const line = toShell(doc);
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

interface Series {
  label: string;
  color: string;
  values: (number | null)[];
}

interface ChartProps {
  title: string;
  points: PerfPoint[];
  series: Series[];
  // Axis and readout text for a value.
  format(v: number): string;
  bytes?: boolean;
  // Extra text in the head (a cache's maximum).
  note?: string;
}

const CHART_H = 150;
const PAD = { top: 10, right: 12, bottom: 22 };

// A line chart of the last five minutes in the app's chart style (the
// result chart's grid, ticks and theme series colours). Lines break where
// samples are missing; hovering shows the values at the nearest sample.
function PerfChart({ title, points, series, format, bytes = false, note }: ChartProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (el === null) return;
    const measure = () => setWidth(el.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const end = points.length > 0 ? points[points.length - 1].time : Date.now();
  const start = end - WINDOW_MS;
  const max = Math.max(0, ...series.flatMap((s) => s.values.filter((v): v is number => v !== null)));
  const ticks = axisSteps(max, 3, bytes);
  const top = ticks[ticks.length - 1];
  const tickLabels = ticks.map(format);
  const left = Math.max(...tickLabels.map((label) => label.length)) * 6.2 + 14;
  const plotW = Math.max(10, width - left - PAD.right);
  const plotH = CHART_H - PAD.top - PAD.bottom;
  const xAt = (time: number) => left + ((time - start) / WINDOW_MS) * plotW;
  const yAt = (v: number) => PAD.top + plotH - (v / (top || 1)) * plotH;

  const minutes: number[] = [];
  for (let m = Math.ceil(start / 60_000) * 60_000; m <= end; m += 60_000) minutes.push(m);

  const paths = series.map((s) => {
    let d = "";
    let open = false;
    s.values.forEach((v, i) => {
      if (v === null || points[i].gap) open = false;
      if (v === null) return;
      d += `${open ? "L" : "M"}${xAt(points[i].time).toFixed(1)} ${yAt(v).toFixed(1)}`;
      open = true;
    });
    return d;
  });

  const onMove = (event: MouseEvent<SVGSVGElement>) => {
    if (points.length === 0) return;
    const x = event.clientX - event.currentTarget.getBoundingClientRect().left;
    const time = start + ((x - left) / plotW) * WINDOW_MS;
    let best = 0;
    points.forEach((p, i) => {
      if (Math.abs(p.time - time) < Math.abs(points[best].time - time)) best = i;
    });
    setHover(best);
  };

  const at = hover !== null && hover < points.length ? hover : null;
  const latest = (s: Series): string => {
    for (let i = s.values.length - 1; i >= 0; i--) {
      const v = s.values[i];
      if (v !== null) return format(v);
    }
    return "—";
  };

  return (
    <section className="structure-section mg-perf-card">
      <div className="structure-section-head">
        <span className="structure-section-title">{title}</span>
        {note ? <span className="panel-dim">{note}</span> : null}
        <span className="spacer" />
        <span className="mg-perf-legend">
          {series.map((s) => (
            <span key={s.label} className="mg-perf-legend-item">
              <span className="chart-swatch line" style={{ background: s.color }} />
              {s.label}
              <span className="mono">{latest(s)}</span>
            </span>
          ))}
        </span>
      </div>
      <div ref={hostRef} className="mg-perf-plot">
        {width > 0 ? (
          <svg className="chart-svg" width={width} height={CHART_H} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
            {ticks.map((v, i) => (
              <g key={`y${i}`}>
                <line className={v === 0 ? "chart-zero" : "chart-grid"} x1={left} x2={left + plotW} y1={yAt(v)} y2={yAt(v)} />
                <text className="chart-tick" x={left - 8} y={yAt(v)} dy="0.32em" textAnchor="end">
                  {tickLabels[i]}
                </text>
              </g>
            ))}
            {minutes.map((m) => (
              <g key={m}>
                <line className="chart-grid faint" x1={xAt(m)} x2={xAt(m)} y1={PAD.top} y2={PAD.top + plotH} />
                <text className="chart-tick" x={xAt(m)} y={PAD.top + plotH + 15} textAnchor="middle">
                  {clockText(m)}
                </text>
              </g>
            ))}
            {paths.map((d, i) => (d ? <path key={series[i].label} d={d} fill="none" stroke={series[i].color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" /> : null))}
            {at !== null ? (
              <g>
                <line className="chart-axis-line" x1={xAt(points[at].time)} x2={xAt(points[at].time)} y1={PAD.top} y2={PAD.top + plotH} />
                {series.map((s) => {
                  const v = s.values[at];
                  return v === null ? null : <circle key={s.label} cx={xAt(points[at].time)} cy={yAt(v)} r={3.5} fill={s.color} />;
                })}
              </g>
            ) : null}
          </svg>
        ) : null}
        {at !== null ? (
          <div className="mg-perf-tip" style={xAt(points[at].time) > width / 2 ? { right: width - xAt(points[at].time) + 10 } : { left: xAt(points[at].time) + 10 }}>
            <div className="mg-perf-tip-time mono">{clockText(points[at].time, true)}</div>
            {series.map((s) => (
              <div key={s.label} className="mg-perf-tip-row">
                <span className="chart-swatch" style={{ background: s.color }} />
                <span>{s.label}</span>
                <span className="mono">{s.values[at] === null ? "—" : format(s.values[at] as number)}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function Section({ title, hint, actions, children }: { title: string; hint?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="structure-section mg-perf-section">
      <div className="structure-section-head">
        <span className="structure-section-title">{title}</span>
        {hint !== undefined ? <span className="panel-dim mg-perf-hint">{hint}</span> : null}
        <span className="spacer" />
        {actions}
      </div>
      {children}
    </section>
  );
}

export function PerfTab({ conn, tabKey, db, safeMode, notify }: PerfTabProps) {
  const remembered = memory.get(tabKey);
  const [points, setPoints] = useState<PerfPoint[]>(remembered?.points ?? []);
  const [sample, setSample] = useState<api.PerfSample | null>(remembered?.last ?? null);
  const [paused, setPaused] = useState(remembered?.paused ?? false);
  const [visible, setVisible] = useState(document.visibilityState === "visible");
  const [perfError, setPerfError] = useState<unknown>(null);
  // The last poll ran out of time on at least one request.
  const [slow, setSlow] = useState(false);
  const [ops, setOps] = useState<RunningOp[] | null>(null);
  const [opsError, setOpsError] = useState<unknown>(null);
  const [top, setTop] = useState<TopRow[] | null>(null);
  const [topError, setTopError] = useState<unknown>(null);
  const [profileDb, setProfileDb] = useState(remembered?.profileDb ?? db);
  const [dbs, setDbs] = useState<string[]>([]);
  const [profile, setProfile] = useState<ProfileStatus | null>(null);
  const [profileError, setProfileError] = useState<unknown>(null);
  const [entries, setEntries] = useState<BsonDocument[] | null>(null);
  const [entriesError, setEntriesError] = useState<unknown>(null);
  const [level, setLevel] = useState("1");
  const [slowms, setSlowms] = useState("100");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingReview, setPendingReview] = useState<{ item: ReviewItem; resolve(ok: boolean): void } | null>(null);
  const colors = useThemeColors("perf");

  const lastRef = useRef<api.PerfSample | null>(remembered?.last ?? null);
  const topRef = useRef<TopRow[] | null>(null);
  const profileRef = useRef({ db: profileDb, level: 0 });
  profileRef.current.db = profileDb;
  profileRef.current.level = profile?.level ?? 0;

  useEffect(() => {
    memory.set(tabKey, { points, last: lastRef.current, paused, profileDb });
  }, [tabKey, points, paused, profileDb]);

  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    api.listDatabases(conn, ctrl.signal).then(
      (list) => setDbs(list.map((d) => d.name)),
      () => undefined,
    );
    return () => ctrl.abort();
  }, [conn]);

  // The newest profiler entries, without the reads of system.profile itself.
  const loadEntries = async (target: string, signal?: AbortSignal) => {
    try {
      const batch = await api.find(
        { conn, db: target, coll: "system.profile" },
        { filter: { ns: { $ne: `${target}.system.profile` } }, sort: { ts: new Int32(-1) }, limit: 50, poll: true },
        signal,
      );
      if (profileRef.current.db === target) {
        setEntries(batch.docs);
        setEntriesError(null);
      }
    } catch (error) {
      if (!api.isAbort(error) && profileRef.current.db === target) setEntriesError(error);
    }
  };

  const loadProfile = async (target: string, signal?: AbortSignal) => {
    try {
      const reply = await api.command(conn, target, { profile: new Int32(-1) }, false, signal, true);
      if (profileRef.current.db !== target) return;
      const status = { level: api.toNumber(reply.was), slowms: api.toNumber(reply.slowms) };
      setProfile(status);
      setProfileError(null);
      setLevel(String(status.level === 0 ? 1 : status.level));
      setSlowms(String(status.slowms));
    } catch (error) {
      if (!api.isAbort(error) && profileRef.current.db === target) {
        setProfile(null);
        setProfileError(error);
      }
    }
  };

  useEffect(() => {
    const ctrl = new AbortController();
    setEntries(null);
    setExpanded(null);
    void loadProfile(profileDb, ctrl.signal);
    void loadEntries(profileDb, ctrl.signal);
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conn, profileDb]);

  // One poll: the sample, the running operations and `top`, each failing on
  // its own (currentOp and top need privileges a user may lack). Requests
  // still out after POLL_TIMEOUT_MS are aborted: what they would have shown
  // keeps its last value, and a missed sample breaks the chart lines.
  const poll = async (signal: AbortSignal, round: number) => {
    const own = new AbortController();
    const stop = () => own.abort();
    signal.addEventListener("abort", stop);
    let timedOut = false;
    const timer = window.setTimeout(() => {
      timedOut = true;
      own.abort();
    }, POLL_TIMEOUT_MS);
    const [perf, current, topReply] = await Promise.allSettled([
      api.perf(conn, own.signal),
      api.command(conn, "admin", { currentOp: new Int32(1), active: true }, false, own.signal, true),
      api.command(conn, "admin", { top: new Int32(1) }, false, own.signal, true),
    ]);
    window.clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    if (signal.aborted) return;
    const late = (result: PromiseSettledResult<unknown>) => timedOut && result.status === "rejected" && api.isAbort(result.reason);
    setSlow(late(perf) || late(current) || late(topReply));
    if (perf.status === "fulfilled") {
      const point = perfPoint(lastRef.current, perf.value);
      lastRef.current = perf.value;
      setSample(perf.value);
      setPoints((list) => appendPoint(list, point));
      setPerfError(null);
    } else if (late(perf)) {
      lastRef.current = null;
    } else {
      setPerfError(perf.reason);
    }
    if (current.status === "fulfilled") {
      setOps(runningOps(current.value));
      setOpsError(null);
    } else if (!late(current)) {
      setOpsError(current.reason);
    }
    if (topReply.status === "fulfilled") {
      const rows = topRows(topReply.value, topRef.current);
      topRef.current = rows;
      setTop(rows);
      setTopError(null);
    } else if (!late(topReply)) {
      setTopError(topReply.reason);
    }
    if (round > 0 && round % PROFILE_EVERY === 0 && profileRef.current.level > 0) {
      void loadEntries(profileRef.current.db, signal);
    }
  };
  const pollRef = useRef(poll);
  pollRef.current = poll;

  useEffect(() => {
    if (paused || !visible) return;
    const ctrl = new AbortController();
    let timer = 0;
    let round = 0;
    // Polls start every POLL_MS, or right after one that took longer.
    const tick = async () => {
      const started = Date.now();
      await pollRef.current(ctrl.signal, round++);
      if (!ctrl.signal.aborted) timer = window.setTimeout(() => void tick(), Math.max(0, started + POLL_MS - Date.now()));
    };
    void tick();
    return () => {
      ctrl.abort();
      window.clearTimeout(timer);
    };
  }, [conn, paused, visible]);

  const ask = (item: ReviewItem) =>
    new Promise<boolean>((resolve) => {
      setPendingReview({
        item,
        resolve: (ok) => {
          setPendingReview(null);
          resolve(ok);
        },
      });
    });

  const kill = async (op: RunningOp) => {
    const command = `db.killOp(${toShell(op.opid)})`;
    const ok = await ask({ sql: command, keyword: t("작업 종료"), severity: "danger", reason: t("{op} · {ns} 작업을 끝냅니다 ({time} 실행 중)", { op: op.op || "—", ns: op.ns || "—", time: msText(op.micros / 1000) }) });
    if (!ok) return;
    try {
      await api.command(conn, "admin", { killOp: new Int32(1), op: op.opid }, true);
      notify(t("작업을 끝냈습니다: {command}", { command }));
      setOps((list) => list?.filter((o) => o !== op) ?? null);
    } catch (error) {
      notifyError(error, { context: "admin" });
    }
  };

  // slowms is one setting for the whole server (it also decides what goes to
  // the server log), so it is sent only with level 1, where it matters.
  const applyLevel = async (next: number) => {
    const ms = Math.max(0, Math.round(Number(slowms) || 0));
    const target = profileDb;
    const command = `db.getSiblingDB(${JSON.stringify(target)}).setProfilingLevel(${next}${next === 1 ? `, { slowms: ${ms} }` : ""})`;
    const reason =
      next === 0
        ? t("{db}의 프로파일링을 끕니다", { db: target })
        : next === 1
          ? t("{db}에서 {ms}ms 넘게 걸린 작업을 system.profile에 남깁니다. slowms는 서버 전체 설정입니다", { db: target, ms })
          : t("{db}의 모든 작업을 system.profile에 남깁니다. 서버가 느려질 수 있습니다", { db: target });
    if (!(await ask({ sql: command, keyword: t("프로파일링 수준"), severity: "write", reason }))) return;
    setBusy(true);
    try {
      await api.command(conn, target, next === 1 ? { profile: new Int32(1), slowms: new Int32(ms) } : { profile: new Int32(next) }, true);
      notify(t("프로파일링 수준을 바꿨습니다: {command}", { command }));
      await loadProfile(target);
      await loadEntries(target);
    } catch (error) {
      notifyError(error, { context: "admin" });
    } finally {
      setBusy(false);
    }
  };

  const opSeries = useMemo<Series[]>(
    () => OP_KINDS.map((kind, i) => ({ label: kind, color: colors.series[i % colors.series.length], values: points.map((p) => p.ops?.[kind] ?? null) })),
    [points, colors],
  );
  const connSeries = useMemo<Series[]>(() => [{ label: t("현재"), color: colors.series[0], values: points.map((p) => p.connections) }], [points, colors]);
  const netSeries = useMemo<Series[]>(
    () => [
      { label: t("들어옴"), color: colors.series[1 % colors.series.length], values: points.map((p) => p.netIn) },
      { label: t("나감"), color: colors.series[2 % colors.series.length], values: points.map((p) => p.netOut) },
    ],
    [points, colors],
  );
  const memSeries = useMemo<Series[]>(
    () => [
      { label: t("상주 메모리"), color: colors.series[0], values: points.map((p) => p.resident) },
      ...(sample?.wiredTiger
        ? [
            { label: t("캐시"), color: colors.series[3 % colors.series.length], values: points.map((p) => p.cache) },
            { label: t("변경된 캐시"), color: colors.series[2 % colors.series.length], values: points.map((p) => p.dirty) },
          ]
        : []),
    ],
    [points, colors, sample?.wiredTiger],
  );
  const bytesText = (v: number) => formatBytes(v) ?? "0 B";
  const lock = sample?.globalLock ?? null;
  const running = !paused && visible;
  const profileLabels = [t("끔"), t("느린 작업만"), t("모든 작업")];

  return (
    <div className="mg-root mg-perf">
      <div className="mg-agg-bar">
        <span className="mg-agg-count">{t("서버 성능")}</span>
        {sample !== null ? (
          <span className="mg-perf-stats">
            <span>
              {t("가동")} <b className="mono">{uptimeText(sample.uptime)}</b>
            </span>
            <span>
              {t("연결")} <b className="mono">{sample.connections.current.toLocaleString()}</b>
              <span className="panel-dim"> / {(sample.connections.current + sample.connections.available).toLocaleString()}</span>
            </span>
            {lock !== null ? (
              <span title={t("전역 잠금: 실행 중인 읽기·쓰기 / 기다리는 읽기·쓰기")}>
                {t("활성")} <b className="mono">{`${lock.activeReaders}·${lock.activeWriters}`}</b> {t("대기")} <b className="mono">{`${lock.queueReaders}·${lock.queueWriters}`}</b>
              </span>
            ) : null}
          </span>
        ) : null}
        <span className="spacer" />
        {running && slow ? (
          <span className="mg-perf-slow" role="status" title={t("요청이 {seconds}초 안에 끝나지 않아 이번 값은 비워 둡니다", { seconds: POLL_TIMEOUT_MS / 1000 })}>
            {t("서버 응답이 늦습니다")}
          </span>
        ) : null}
        <span className="panel-dim">{running ? t("2초마다 갱신") : paused ? t("일시 정지됨") : t("창이 가려져 멈춤")}</span>
        {running ? <Spinner size={11} /> : null}
        <button type="button" className="icon-text-button" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
          {paused ? <PlayIcon size={10} /> : <StopIcon size={10} />}
          {paused ? t("다시 시작") : t("일시 정지")}
        </button>
      </div>
      <div className="mg-ix-body mg-perf-body">
        {perfError !== null ? <ErrorNotice error={perfError} context="admin" engine="mongodb" variant="compact" /> : null}
        <div className="mg-perf-grid">
          <PerfChart title={t("초당 작업 수")} points={points} series={opSeries} format={rateText} />
          <PerfChart title={t("연결 수")} points={points} series={connSeries} format={countTick} />
          <PerfChart title={t("네트워크 (초당)")} points={points} series={netSeries} format={bytesText} bytes />
          <PerfChart
            title={t("메모리·캐시")}
            points={points}
            series={memSeries}
            format={bytesText}
            bytes
            note={sample?.wiredTiger ? t("캐시 최대 {size}", { size: bytesText(sample.wiredTiger.cacheMax) }) : undefined}
          />
        </div>

        <Section title={t("현재 작업")} hint={ops !== null ? t("{count}개 · 오래 걸린 순", { count: ops.length }) : undefined}>
          {opsError !== null ? (
            <div className="mg-perf-empty">
              <ErrorNotice error={opsError} context="admin" engine="mongodb" variant="compact" />
            </div>
          ) : ops === null ? (
            <div className="mg-perf-empty panel-dim">{t("불러오는 중…")}</div>
          ) : ops.length === 0 ? (
            <div className="mg-perf-empty panel-dim">{t("실행 중인 작업이 없습니다")}</div>
          ) : (
            <table className="panel-table mg-struct-table mg-perf-table">
              <thead>
                <tr>
                  <th className="num">{t("실행 시간")}</th>
                  <th>{t("작업")}</th>
                  <th>{t("네임스페이스")}</th>
                  <th>{t("클라이언트")}</th>
                  <th>{t("계획")}</th>
                  <th>{t("명령")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {ops.map((op, i) => (
                  <tr key={`${toShell(op.opid)}:${i}`}>
                    <td className="num mono">{msText(op.micros / 1000)}</td>
                    <td className="mono">{op.op || op.desc}</td>
                    <td className="mono">{op.ns}</td>
                    <td className="mono" title={op.appName}>
                      {op.client || <span className="panel-dim">{op.desc || "—"}</span>}
                    </td>
                    <td className="mono">{op.plan || <span className="panel-dim">—</span>}</td>
                    <td className="mg-perf-cmd" title={op.command ? toShellPretty(op.command) : undefined}>
                      <ShellText text={preview(op.command)} />
                    </td>
                    <td className="num">
                      <button type="button" className="icon-text-button mg-danger-text" onClick={() => void kill(op)}>
                        {t("종료")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section title={t("컬렉션별 시간")} hint={t("top: 서버가 켜진 뒤 누적, '최근'은 직전 갱신 이후")}>
          {topError !== null ? (
            <div className="mg-perf-empty">
              <ErrorNotice error={topError} context="admin" engine="mongodb" variant="compact" />
            </div>
          ) : top === null ? (
            <div className="mg-perf-empty panel-dim">{t("불러오는 중…")}</div>
          ) : top.length === 0 ? (
            <div className="mg-perf-empty panel-dim">{t("기록된 작업이 없습니다")}</div>
          ) : (
            <div className="mg-perf-scroll">
              <table className="panel-table mg-struct-table mg-perf-table">
                <thead>
                  <tr>
                    <th>{t("네임스페이스")}</th>
                    <th className="num">{t("최근")}</th>
                    <th className="num">{t("전체")}</th>
                    <th className="num">{t("읽기")}</th>
                    <th className="num">{t("읽기 횟수")}</th>
                    <th className="num">{t("쓰기")}</th>
                    <th className="num">{t("쓰기 횟수")}</th>
                  </tr>
                </thead>
                <tbody>
                  {top.slice(0, 50).map((row) => (
                    <tr key={row.ns}>
                      <td className="mono">{row.ns}</td>
                      <td className={`num mono${row.recentMs ? "" : " panel-dim"}`}>{row.recentMs === null ? "—" : msText(row.recentMs)}</td>
                      <td className="num mono">{msText(row.totalMs)}</td>
                      <td className="num mono">{msText(row.readMs)}</td>
                      <td className="num mono">{row.readCount.toLocaleString()}</td>
                      <td className="num mono">{msText(row.writeMs)}</td>
                      <td className="num mono">{row.writeCount.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <Section
          title={t("느린 작업")}
          hint={profile !== null ? (profile.level === 0 ? t("프로파일링 꺼짐") : profile.level === 1 ? t("{ms}ms 넘는 작업 기록 중", { ms: profile.slowms }) : t("모든 작업 기록 중")) : undefined}
          actions={
            <>
              <Select className="mg-input" aria-label={t("데이터베이스")} value={profileDb} onChange={(event) => setProfileDb(event.target.value)}>
                {(dbs.includes(profileDb) ? dbs : [profileDb, ...dbs]).map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
              <Select className="mg-input" aria-label={t("프로파일링 수준")} value={level} onChange={(event) => setLevel(event.target.value)}>
                {profileLabels.map((label, i) => (
                  <option key={i} value={String(i)}>
                    {`${i} · ${label}`}
                  </option>
                ))}
              </Select>
              {level === "1" ? (
                <label className="mg-perf-slowms">
                  slowms
                  <input className="mg-input mg-num mono" type="number" min={0} value={slowms} onChange={(event) => setSlowms(event.target.value)} />
                </label>
              ) : null}
              <button type="button" className="mg-qbtn" disabled={busy || profile === null} onClick={() => void applyLevel(Number(level))}>
                {busy ? <Spinner size={10} /> : null}
                {t("수준 바꾸기")}
              </button>
              {profile !== null && profile.level > 0 ? (
                <button type="button" className="mg-qbtn" disabled={busy} onClick={() => void applyLevel(0)}>
                  {t("끄기")}
                </button>
              ) : null}
              <button type="button" className="icon-button" title={t("새로고침")} aria-label={t("새로고침")} onClick={() => void loadEntries(profileDb)}>
                <RefreshIcon size={11} />
              </button>
            </>
          }
        >
          {profileError !== null ? (
            <div className="mg-perf-empty">
              <ErrorNotice error={profileError} context="admin" engine="mongodb" variant="compact" />
            </div>
          ) : null}
          {entriesError !== null ? (
            <div className="mg-perf-empty">
              <ErrorNotice error={entriesError} context="admin" engine="mongodb" variant="compact" />
            </div>
          ) : entries === null ? (
            <div className="mg-perf-empty panel-dim">{t("불러오는 중…")}</div>
          ) : entries.length === 0 ? (
            <div className="mg-perf-empty panel-dim">{t("system.profile에 기록이 없습니다. 프로파일링을 켜면 여기에 쌓입니다")}</div>
          ) : (
            <div className="mg-perf-scroll">
              <table className="panel-table mg-struct-table mg-perf-table">
                <thead>
                  <tr>
                    <th>{t("시각")}</th>
                    <th>{t("작업")}</th>
                    <th>{t("네임스페이스")}</th>
                    <th className="num">{t("시간")}</th>
                    <th>{t("계획")}</th>
                    <th className="num">{t("검사 / 반환")}</th>
                    <th>{t("명령")}</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry, i) => {
                    const command = isDocument(entry.command) ? entry.command : null;
                    const examined = entry.docsExamined !== undefined ? api.toNumber(entry.docsExamined).toLocaleString() : "—";
                    const returned = entry.nreturned !== undefined ? api.toNumber(entry.nreturned).toLocaleString() : "—";
                    return [
                      <tr key={i} className={`mg-perf-row${expanded === i ? " open" : ""}`} onClick={() => setExpanded(expanded === i ? null : i)}>
                        <td className="mono">{entry.ts instanceof BsonDate ? clockText(Number(entry.ts.ms), true) : ""}</td>
                        <td className="mono">{typeof entry.op === "string" ? entry.op : ""}</td>
                        <td className="mono">{typeof entry.ns === "string" ? entry.ns : ""}</td>
                        <td className="num mono">{msText(api.toNumber(entry.millis))}</td>
                        <td className="mono">{typeof entry.planSummary === "string" ? entry.planSummary : <span className="panel-dim">—</span>}</td>
                        <td className="num mono">{`${examined} / ${returned}`}</td>
                        <td className="mg-perf-cmd">
                          <ShellText text={preview(command)} />
                        </td>
                      </tr>,
                      expanded === i ? (
                        <tr key={`${i}:doc`} className="mg-perf-detail">
                          <td colSpan={7}>
                            <pre className="mono">
                              <ShellText text={toShellPretty(entry)} />
                            </pre>
                          </td>
                        </tr>
                      ) : null,
                    ];
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>
      {pendingReview !== null ? <ReviewModal mode={safeMode === 0 ? 1 : safeMode} items={[pendingReview.item]} txActive onRun={() => pendingReview.resolve(true)} onClose={() => pendingReview.resolve(false)} /> : null}
    </div>
  );
}
