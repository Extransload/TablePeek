// The connection's 클러스터 tab (docs/engines/elasticsearch.md §4.1): the
// cluster's name, version and health; every two seconds while it is shown
// a `_nodes/stats` sample charted as rates over the last five minutes and
// the running tasks (cancellable after a confirmation); every ten seconds
// the health and the nodes again, and the shards whenever the health's
// shard counts change. Hot threads load on demand. Pausing, switching tabs
// or hiding the window stops the polling; the charts keep their history per
// connection.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { writeClipboard } from "../../../clipboard";
import { ErrorNotice, notifyError } from "../../../components/ErrorNotice";
import { ChevronIcon, CopyIcon, PlayIcon, RefreshIcon, StopIcon } from "../../../components/icons";
import { useThemeColors } from "../../../components/ResultChart";
import { Select } from "../../../components/Select";
import { Spinner } from "../../../components/Spinner";
import { formatBytes } from "../../../format";
import { t } from "../../../i18n";
import { POLL_MS, POLL_TIMEOUT_MS, WINDOW_MS, axisSteps } from "../../mongodb/perf";
import * as api from "../api";
import { num, str } from "../json";
import { actionsPattern, appendPoint, clusterPoint, isAppTask, shardGroups, shardRow, taskRows, type ClusterPoint, type ShardGroup, type ShardRow } from "../perf";
import { requestText } from "./common";
import type { ClusterTabProps } from "./types";
import "../../mongodb/mongodb.css";
import "../../mongodb/ui/panels.css";
import "../../mongodb/ui/perf.css";
import "./cluster.css";

interface Remembered {
  points: ClusterPoint[];
  last: api.PerfSample | null;
  paused: boolean;
}

// Chart history per connection, kept while the tab is closed and opened
// again within the window.
const memory = new Map<string, Remembered>();

// The health and the nodes are read again every this many polls.
const OVERVIEW_EVERY = 5;
// Index groups drawn at most in the shards table; the filter narrows.
const MAX_GROUPS = 300;

// `_cat/nodes` role letters.
const ROLE_NAMES: Record<string, string> = {
  c: "data_cold",
  d: "data",
  f: "data_frozen",
  h: "data_hot",
  i: "ingest",
  l: "ml",
  m: "master",
  r: "remote_cluster_client",
  s: "data_content",
  t: "transform",
  v: "voting_only",
  w: "data_warm",
  I: "search",
  S: "search",
  "-": "coordinating_only",
};

function msText(ms: number): string {
  if (ms < 1) return ms === 0 ? "0 ms" : `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${Math.round(ms).toLocaleString()} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

// A task's running time: milliseconds and seconds as msText, then minutes
// and hours.
function durationText(ms: number): string {
  if (ms < 60_000) return msText(ms);
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? t("{h}시간 {m}분", { h, m }) : t("{m}분 {s}초", { m, s: s % 60 });
}

function rateText(v: number): string {
  return v >= 100 || Number.isInteger(v) ? Math.round(v).toLocaleString() : v.toFixed(1);
}

function countTick(v: number): string {
  return v >= 1_000_000_000 ? `${v / 1_000_000_000}G` : v >= 1_000_000 ? `${v / 1_000_000}M` : v >= 1000 ? `${v / 1000}k` : String(v);
}

function bytesText(v: number): string {
  return formatBytes(v) ?? "0 B";
}

function clockText(ms: number, seconds = false): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), hour12: false });
}

interface Series {
  label: string;
  color: string;
  values: (number | null)[];
}

interface ChartProps {
  title: string;
  points: ClusterPoint[];
  series: Series[];
  // Readout text for a value; `tick` for the axis when it differs.
  format(v: number): string;
  tick?(v: number): string;
  bytes?: boolean;
  note?: string;
}

const CHART_H = 150;
const PAD = { top: 10, right: 12, bottom: 22 };

// A line chart of the last five minutes in the 성능 tab's style (the result
// chart's grid, ticks and theme series colours). Lines break where samples
// are missing; hovering shows the values at the nearest sample.
function PerfChart({ title, points, series, format, tick = format, bytes = false, note }: ChartProps) {
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
  const tickLabels = ticks.map(tick);
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

// A percentage as a bar and its number; amber from 75 %, red from 90 %.
function PercentBar({ value }: { value: number | null }) {
  if (value === null) return <span className="panel-dim">—</span>;
  const level = value >= 90 ? " crit" : value >= 75 ? " warn" : "";
  return (
    <span className="es-cl-pct">
      <span className="es-cl-bar">
        <span className={`es-cl-bar-fill${level}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </span>
      <span className="mono">{`${Math.round(value)}%`}</span>
    </span>
  );
}

export function ClusterTab({ host, active, onOpenIndex }: ClusterTabProps) {
  const conn = host.conn;
  const remembered = memory.get(conn);
  const [points, setPoints] = useState<ClusterPoint[]>(remembered?.points ?? []);
  const [sample, setSample] = useState<api.PerfSample | null>(remembered?.last ?? null);
  const [paused, setPaused] = useState(remembered?.paused ?? false);
  const [visible, setVisible] = useState(document.visibilityState === "visible");
  const [perfError, setPerfError] = useState<unknown>(null);
  // The last poll ran out of time on at least one request.
  const [slow, setSlow] = useState(false);
  const [info, setInfo] = useState<api.ClusterInfo | null>(null);
  const [infoError, setInfoError] = useState<unknown>(null);
  const [nodeRows, setNodeRows] = useState<api.NodeRow[] | null>(null);
  const [nodesError, setNodesError] = useState<unknown>(null);
  const [shardList, setShardList] = useState<ShardRow[] | null>(null);
  const [shardsError, setShardsError] = useState<unknown>(null);
  const [shardsLoading, setShardsLoading] = useState(false);
  const [shardFilter, setShardFilter] = useState("");
  const [problemsOnly, setProblemsOnly] = useState(false);
  // Index groups opened or closed against their default (a group with a
  // problem starts open).
  const [toggled, setToggled] = useState<Set<string>>(() => new Set());
  const [taskList, setTaskList] = useState<api.TaskRow[] | null>(null);
  const [tasksError, setTasksError] = useState<unknown>(null);
  const [actionsText, setActionsText] = useState("");
  const [childTasks, setChildTasks] = useState(false);
  const [cancelling, setCancelling] = useState<Set<string>>(() => new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [hot, setHot] = useState<string | null>(null);
  const [hotError, setHotError] = useState<unknown>(null);
  const [hotLoading, setHotLoading] = useState(false);
  const [hotThreads, setHotThreads] = useState("3");
  const [hotInterval, setHotInterval] = useState("500ms");
  const colors = useThemeColors("perf");

  const lastRef = useRef<api.PerfSample | null>(remembered?.last ?? null);
  // The actions pattern the task reads send, and a number bumped when it
  // changes so a reply for the old pattern is dropped.
  const actionsRef = useRef("");
  const tasksSeqRef = useRef(0);
  const shardSigRef = useRef("");
  const shardsSeqRef = useRef(0);
  const refreshCtrlRef = useRef<AbortController | null>(null);
  const hotCtrlRef = useRef<AbortController | null>(null);
  const loadedRef = useRef(false);

  useEffect(() => {
    memory.set(conn, { points, last: lastRef.current, paused });
  }, [conn, points, paused]);

  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  useEffect(
    () => () => {
      refreshCtrlRef.current?.abort();
      hotCtrlRef.current?.abort();
    },
    [],
  );

  const loadShards = async (signal?: AbortSignal) => {
    const seq = ++shardsSeqRef.current;
    setShardsLoading(true);
    try {
      const rows = await api.shards(conn, undefined, signal);
      if (seq !== shardsSeqRef.current) return;
      setShardList(rows.map(shardRow));
      setShardsError(null);
    } catch (error) {
      if (!api.isAbort(error) && seq === shardsSeqRef.current) setShardsError(error);
    } finally {
      if (seq === shardsSeqRef.current) setShardsLoading(false);
    }
  };

  // New health: shown, and the shards read again when their counts moved
  // since the last reading.
  const applyInfo = (next: api.ClusterInfo, signal?: AbortSignal) => {
    setInfo(next);
    setInfoError(null);
    const sig = ["status", "number_of_nodes", "active_primary_shards", "active_shards", "relocating_shards", "initializing_shards", "unassigned_shards"]
      .map((key) => String(next.health[key] ?? ""))
      .join("|");
    const changed = shardSigRef.current !== "" && sig !== shardSigRef.current;
    shardSigRef.current = sig;
    if (changed) void loadShards(signal);
  };

  const loadTasks = async (signal?: AbortSignal) => {
    const seq = tasksSeqRef.current;
    try {
      const rows = await api.tasks(conn, actionsRef.current || undefined, signal);
      if (seq !== tasksSeqRef.current) return;
      setTaskList(rows);
      setTasksError(null);
    } catch (error) {
      if (!api.isAbort(error) && seq === tasksSeqRef.current) setTasksError(error);
    }
  };

  // Everything but the charts, read again (the refresh button, and the
  // first time the tab is shown).
  const refresh = async () => {
    refreshCtrlRef.current?.abort();
    const ctrl = new AbortController();
    refreshCtrlRef.current = ctrl;
    setRefreshing(true);
    const loadInfo = async () => {
      try {
        applyInfo(await api.clusterInfo(conn, ctrl.signal));
      } catch (error) {
        if (!api.isAbort(error)) setInfoError(error);
      }
    };
    const loadNodes = async () => {
      try {
        setNodeRows(await api.nodes(conn, ctrl.signal));
        setNodesError(null);
      } catch (error) {
        if (!api.isAbort(error)) setNodesError(error);
      }
    };
    await Promise.all([loadInfo(), loadNodes(), loadShards(ctrl.signal), loadTasks(ctrl.signal)]);
    if (refreshCtrlRef.current === ctrl) {
      refreshCtrlRef.current = null;
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (!active || loadedRef.current) return;
    loadedRef.current = true;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // The task filter applies a moment after typing stops.
  useEffect(() => {
    const pattern = actionsPattern(actionsText);
    if (pattern === actionsRef.current) return;
    const timer = window.setTimeout(() => {
      actionsRef.current = pattern;
      tasksSeqRef.current += 1;
      setTaskList(null);
      void loadTasks();
    }, 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionsText]);

  // One poll: the stats sample and the tasks, and every OVERVIEW_EVERY polls
  // the health and the nodes, each failing on its own. Requests still out
  // after POLL_TIMEOUT_MS are aborted: what they would have shown keeps its
  // last value, and a missed sample breaks the chart lines.
  const poll = async (signal: AbortSignal, round: number) => {
    const own = new AbortController();
    const stop = () => own.abort();
    signal.addEventListener("abort", stop);
    let timedOut = false;
    const timer = window.setTimeout(() => {
      timedOut = true;
      own.abort();
    }, POLL_TIMEOUT_MS);
    const overview = round > 0 && round % OVERVIEW_EVERY === 0;
    const seq = tasksSeqRef.current;
    const [perf, taskReply, infoReply, nodesReply] = await Promise.allSettled([
      api.perf(conn, own.signal),
      api.tasks(conn, actionsRef.current || undefined, own.signal),
      overview ? api.clusterInfo(conn, own.signal) : Promise.resolve(null),
      overview ? api.nodes(conn, own.signal) : Promise.resolve(null),
    ]);
    window.clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    if (signal.aborted) return;
    const late = (result: PromiseSettledResult<unknown>) => timedOut && result.status === "rejected" && api.isAbort(result.reason);
    setSlow(late(perf) || late(taskReply) || late(infoReply) || late(nodesReply));
    if (perf.status === "fulfilled") {
      const point = clusterPoint(lastRef.current, perf.value);
      lastRef.current = perf.value;
      setSample(perf.value);
      setPoints((list) => appendPoint(list, point));
      setPerfError(null);
    } else if (late(perf)) {
      lastRef.current = null;
    } else {
      setPerfError(perf.reason);
    }
    if (seq === tasksSeqRef.current) {
      if (taskReply.status === "fulfilled") {
        setTaskList(taskReply.value);
        setTasksError(null);
      } else if (!late(taskReply)) {
        setTasksError(taskReply.reason);
      }
    }
    if (infoReply.status === "fulfilled" && infoReply.value !== null) {
      applyInfo(infoReply.value, signal);
    } else if (infoReply.status === "rejected" && !late(infoReply)) {
      setInfoError(infoReply.reason);
    }
    if (nodesReply.status === "fulfilled" && nodesReply.value !== null) {
      setNodeRows(nodesReply.value);
      setNodesError(null);
    } else if (nodesReply.status === "rejected" && !late(nodesReply)) {
      setNodesError(nodesReply.reason);
    }
  };
  const pollRef = useRef(poll);
  pollRef.current = poll;

  const running = active && !paused && visible;

  useEffect(() => {
    if (!running) return;
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
  }, [conn, running]);

  const cancel = async (task: api.TaskRow) => {
    const ok = await host.confirm({
      title: t("작업 취소"),
      message: t("{action} 작업을 취소합니다 ({time} 실행 중). 이 작업을 기다리던 요청은 실패하고, 취소는 되돌릴 수 없습니다.", {
        action: task.action,
        time: task.running_time_ms === null ? "—" : durationText(task.running_time_ms),
      }),
      command: requestText("POST", `/_tasks/${task.id}/_cancel`),
      okLabel: t("작업 취소"),
    });
    if (!ok) return;
    setCancelling((set) => new Set(set).add(task.id));
    try {
      await api.cancelTask(conn, task.id);
      host.notify(t("작업 취소를 요청했습니다: {id}", { id: task.id }));
      await loadTasks();
    } catch (error) {
      notifyError(error, { context: "admin" });
    } finally {
      setCancelling((set) => {
        const next = new Set(set);
        next.delete(task.id);
        return next;
      });
    }
  };

  const loadHot = async () => {
    hotCtrlRef.current?.abort();
    const ctrl = new AbortController();
    hotCtrlRef.current = ctrl;
    setHotLoading(true);
    setHotError(null);
    try {
      setHot(await api.hotThreads(conn, Number(hotThreads), hotInterval, ctrl.signal));
    } catch (error) {
      if (!api.isAbort(error)) setHotError(error);
    } finally {
      if (hotCtrlRef.current === ctrl) {
        hotCtrlRef.current = null;
        setHotLoading(false);
      }
    }
  };

  const copyHot = async () => {
    if (hot === null) return;
    let failed = false;
    await writeClipboard(hot, (message) => {
      failed = true;
      notifyError(message);
    });
    if (!failed) host.notify(t("복사했습니다"));
  };

  const charts = useMemo(() => {
    const line = (label: string, color: number, value: (p: ClusterPoint) => number | null): Series => ({
      label,
      color: colors.series[color % colors.series.length],
      values: points.map(value),
    });
    const pool = (name: "search" | "write") => [
      line(t("활성"), 0, (p) => p[name].active),
      line(t("대기"), 2, (p) => p[name].queue),
      line(t("거부 (초당)"), 3, (p) => p[name].rejected),
    ];
    return {
      search: [line(t("쿼리"), 0, (p) => p.query), line(t("페치"), 1, (p) => p.fetch)],
      searchMs: [line(t("쿼리"), 0, (p) => p.queryMs)],
      index: [line(t("색인"), 2, (p) => p.index), line(t("삭제"), 3, (p) => p.delete)],
      indexMs: [line(t("색인"), 2, (p) => p.indexMs)],
      get: [line("get", 4, (p) => p.get), line("refresh", 5, (p) => p.refresh)],
      heap: [line(t("사용 중"), 0, (p) => p.heapUsed), line(t("최대"), 3, (p) => p.heapMax)],
      cpu: [line(t("평균"), 1, (p) => p.cpu)],
      searchPool: pool("search"),
      writePool: pool("write"),
      http: [line(t("열림"), 0, (p) => p.http)],
      docs: [line(t("문서"), 4, (p) => p.docs)],
      store: [line(t("크기"), 5, (p) => p.store)],
    };
  }, [points, colors]);

  const groups = useMemo(() => (shardList === null ? null : shardGroups(shardList)), [shardList]);
  // Groups whose index name matches show every shard; otherwise the shards
  // whose node, state or unassigned reason matches. "Problems only" keeps
  // the shards that are not started.
  const shownGroups = useMemo(() => {
    if (groups === null) return null;
    const needle = shardFilter.trim().toLowerCase();
    const out: { group: ShardGroup; shards: ShardRow[] }[] = [];
    for (const group of groups) {
      const byName = needle === "" || group.index.toLowerCase().includes(needle);
      const shards = group.shards.filter(
        (s) =>
          (!problemsOnly || s.state !== "STARTED") &&
          (byName || s.node.toLowerCase().includes(needle) || s.state.toLowerCase().includes(needle) || s.reason.toLowerCase().includes(needle)),
      );
      if (shards.length > 0) out.push({ group, shards });
    }
    return out;
  }, [groups, shardFilter, problemsOnly]);

  const tasksShown = useMemo(() => (taskList === null ? null : taskRows(taskList, childTasks)), [taskList, childTasks]);

  const health: Record<string, unknown> = info?.health ?? {};
  const status = str(health.status);
  const stat = (key: string): string => {
    const v = num(health[key]);
    return v === null ? "—" : v.toLocaleString();
  };
  const percent = num(health.active_shards_percent_as_number);
  const heapNote = sample !== null && sample.heap_max_bytes > 0 ? t("최대 {size} · {percent}% 사용", { size: bytesText(sample.heap_max_bytes), percent: Math.round((sample.heap_used_bytes / sample.heap_max_bytes) * 100) }) : undefined;

  return (
    <div className="mg-root mg-perf es-cl">
      <div className="mg-agg-bar">
        <span className="mg-agg-count">{t("클러스터")}</span>
        {info !== null ? <span className="es-cl-name mono">{info.cluster_name}</span> : null}
        {status !== "" ? <span className={`es-cl-health ${status}`}>{status}</span> : null}
        <span className="spacer" />
        {running && slow ? (
          <span className="mg-perf-slow" role="status" title={t("요청이 {seconds}초 안에 끝나지 않아 이번 값은 비워 둡니다", { seconds: POLL_TIMEOUT_MS / 1000 })}>
            {t("서버 응답이 늦습니다")}
          </span>
        ) : null}
        <span className="panel-dim">{running ? t("2초마다 갱신") : paused ? t("일시 정지됨") : t("창이 가려져 멈춤")}</span>
        {running || refreshing ? <Spinner size={11} /> : null}
        <button type="button" className="icon-button" title={t("새로고침")} aria-label={t("새로고침")} disabled={refreshing} onClick={() => void refresh()}>
          <RefreshIcon size={11} />
        </button>
        <button type="button" className="icon-text-button" onClick={() => setPaused((p) => !p)} aria-pressed={paused}>
          {paused ? <PlayIcon size={10} /> : <StopIcon size={10} />}
          {paused ? t("다시 시작") : t("일시 정지")}
        </button>
      </div>
      <div className="mg-ix-body mg-perf-body">
        {infoError !== null ? (
          info === null ? (
            <ErrorNotice error={infoError} context="admin" engine="elasticsearch" onRetry={() => void refresh()} />
          ) : (
            <ErrorNotice error={infoError} context="admin" engine="elasticsearch" variant="compact" />
          )
        ) : null}
        {info !== null ? (
          <section className="structure-section es-cl-overview">
            <div className="es-cl-overview-head">
              <span className={`es-cl-dot ${status}`} aria-hidden />
              <span className="es-cl-overview-name">{info.cluster_name}</span>
              <span className="es-cl-tag">{`${info.flavor === "opensearch" ? "OpenSearch" : "Elasticsearch"} ${info.version}`}</span>
              {info.lucene_version ? <span className="es-cl-tag">{`Lucene ${info.lucene_version}`}</span> : null}
              {info.build_flavor && info.build_flavor !== "default" ? <span className="es-cl-tag">{info.build_flavor}</span> : null}
              <span className="spacer" />
              <span className="panel-dim mono" title="cluster_uuid">
                {info.cluster_uuid}
              </span>
            </div>
            <div className="es-cl-stats">
              <div className="es-cl-stat">
                <span>{t("상태")}</span>
                <b className={`es-cl-health-text ${status}`}>{status || "—"}</b>
              </div>
              <div className="es-cl-stat">
                <span>{t("노드")}</span>
                <b className="mono">{stat("number_of_nodes")}</b>
              </div>
              <div className="es-cl-stat">
                <span>{t("데이터 노드")}</span>
                <b className="mono">{stat("number_of_data_nodes")}</b>
              </div>
              <div className="es-cl-stat">
                <span>{t("활성 샤드")}</span>
                <b className="mono">{stat("active_shards")}</b>
              </div>
              <div className="es-cl-stat">
                <span>{t("프라이머리 샤드")}</span>
                <b className="mono">{stat("active_primary_shards")}</b>
              </div>
              <div className="es-cl-stat">
                <span>{t("이동 중")}</span>
                <b className={`mono${num(health.relocating_shards) ? " es-cl-warn" : ""}`}>{stat("relocating_shards")}</b>
              </div>
              <div className="es-cl-stat">
                <span>{t("초기화 중")}</span>
                <b className={`mono${num(health.initializing_shards) ? " es-cl-warn" : ""}`}>{stat("initializing_shards")}</b>
              </div>
              <div className="es-cl-stat">
                <span>{t("할당 안 됨")}</span>
                <b className={`mono${num(health.unassigned_shards) ? " es-cl-bad" : ""}`}>{stat("unassigned_shards")}</b>
              </div>
              <div className="es-cl-stat">
                <span>{t("대기 중인 클러스터 작업")}</span>
                <b className="mono">{stat("number_of_pending_tasks")}</b>
              </div>
              <div className="es-cl-stat">
                <span>{t("활성 샤드 비율")}</span>
                <b className="mono">{percent === null ? "—" : `${percent.toFixed(percent % 1 === 0 ? 0 : 1)}%`}</b>
              </div>
            </div>
            <div className="es-cl-conn" aria-label={t("연결된 노드")}>
              <span className="panel-dim">{t("요청을 받는 노드")}</span>
              {info.connection.nodes.map((node) => (
                <span
                  key={node.address}
                  className={`es-cl-tag${node.current ? " current" : ""}${node.down ? " warn" : ""}`}
                  title={[node.name, node.seed ? t("연결 설정의 주소") : t("클러스터가 알려 준 노드"), node.down ? t("최근 연결할 수 없었음") : null].filter(Boolean).join(" · ")}
                >
                  {node.current ? "● " : ""}
                  <span className="mono">{node.address}</span>
                  {node.name ? ` ${node.name}` : ""}
                </span>
              ))}
              {info.connection.failovers > 0 ? <span className="es-cl-tag warn">{t("다른 노드로 넘어감 {count}번", { count: info.connection.failovers })}</span> : null}
              {!info.connection.sniff ? <span className="panel-dim">{t("다른 노드로 넘어가기 꺼짐")}</span> : null}
              {info.connection.sniff_error ? (
                <span className="panel-dim" title={info.connection.sniff_error}>
                  {t("노드 목록을 읽지 못해 이 주소만 씁니다")}
                </span>
              ) : null}
            </div>
          </section>
        ) : infoError === null ? (
          <div className="mg-perf-empty panel-dim">{t("불러오는 중…")}</div>
        ) : null}

        {perfError !== null ? <ErrorNotice error={perfError} context="admin" engine="elasticsearch" variant="compact" /> : null}
        <div className="mg-perf-grid">
          <PerfChart title={t("검색 (초당)")} points={points} series={charts.search} format={rateText} />
          <PerfChart title={t("검색 지연 (쿼리당 평균)")} points={points} series={charts.searchMs} format={msText} />
          <PerfChart title={t("색인 (초당)")} points={points} series={charts.index} format={rateText} />
          <PerfChart title={t("색인 지연 (문서당 평균)")} points={points} series={charts.indexMs} format={msText} />
          <PerfChart title={t("get · refresh (초당)")} points={points} series={charts.get} format={rateText} />
          <PerfChart title={t("JVM 힙")} points={points} series={charts.heap} format={bytesText} bytes note={heapNote} />
          <PerfChart title={t("CPU (노드 평균)")} points={points} series={charts.cpu} format={(v) => `${Math.round(v)}%`} />
          <PerfChart title={t("스레드 풀 · search")} points={points} series={charts.searchPool} format={rateText} />
          <PerfChart title={t("스레드 풀 · write")} points={points} series={charts.writePool} format={rateText} />
          <PerfChart title={t("HTTP 연결")} points={points} series={charts.http} format={rateText} />
          <PerfChart title={t("문서 수")} points={points} series={charts.docs} format={(v) => v.toLocaleString()} tick={countTick} />
          <PerfChart title={t("저장 크기")} points={points} series={charts.store} format={bytesText} bytes />
        </div>

        <Section title={t("노드")} hint={nodeRows !== null ? t("{count}개 · ★ 선출된 마스터", { count: nodeRows.length }) : undefined}>
          {nodesError !== null ? (
            <div className="mg-perf-empty">
              <ErrorNotice error={nodesError} context="admin" engine="elasticsearch" variant="compact" />
            </div>
          ) : null}
          {nodeRows === null ? (
            nodesError === null ? <div className="mg-perf-empty panel-dim">{t("불러오는 중…")}</div> : null
          ) : (
            <div className="mg-perf-scroll">
              <table className="panel-table mg-struct-table mg-perf-table es-cl-table">
                <thead>
                  <tr>
                    <th>{t("이름")}</th>
                    <th>IP</th>
                    <th>{t("역할")}</th>
                    <th>{t("버전")}</th>
                    <th>{t("힙")}</th>
                    <th>RAM</th>
                    <th>CPU</th>
                    <th className="num">{t("부하 (1분)")}</th>
                    <th>{t("디스크")}</th>
                    <th className="num">{t("가동 시간")}</th>
                  </tr>
                </thead>
                <tbody>
                  {nodeRows.map((node) => (
                    <tr key={node.id || node.name}>
                      <td className="mono" title={node.id}>
                        {node.master ? (
                          <span className="es-cl-master" title={t("선출된 마스터")}>
                            ★
                          </span>
                        ) : null}
                        {node.name}
                      </td>
                      <td className="mono">{node.ip}</td>
                      <td
                        className="mono"
                        title={[...node.roles]
                          .map((letter) => ROLE_NAMES[letter] ?? letter)
                          .join(", ")}
                      >
                        {node.roles || "—"}
                      </td>
                      <td className="mono">{node.version}</td>
                      <td>
                        <PercentBar value={node.heap_percent} />
                      </td>
                      <td>
                        <PercentBar value={node.ram_percent} />
                      </td>
                      <td>
                        <PercentBar value={node.cpu} />
                      </td>
                      <td className="num mono">{node.load_1m === null ? "—" : node.load_1m.toFixed(2)}</td>
                      <td>
                        <PercentBar value={node.disk_used_percent} />
                      </td>
                      <td className="num mono">{node.uptime || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <Section
          title={t("샤드")}
          hint={
            shardList !== null
              ? t("인덱스 {indexes}개 · 샤드 {shards}개", { indexes: groups?.length ?? 0, shards: shardList.length })
              : undefined
          }
          actions={
            <>
              <input
                className="mg-input es-cl-filter"
                type="search"
                value={shardFilter}
                placeholder={t("인덱스·노드·상태로 거르기")}
                aria-label={t("샤드 거르기")}
                onChange={(event) => setShardFilter(event.target.value)}
              />
              <label className="es-cl-check">
                <input type="checkbox" checked={problemsOnly} onChange={(event) => setProblemsOnly(event.target.checked)} />
                {t("시작되지 않은 샤드만")}
              </label>
              <button type="button" className="icon-button" title={t("샤드 새로고침")} aria-label={t("샤드 새로고침")} disabled={shardsLoading} onClick={() => void loadShards()}>
                {shardsLoading ? <Spinner size={11} /> : <RefreshIcon size={11} />}
              </button>
            </>
          }
        >
          {shardsError !== null ? (
            <div className="mg-perf-empty">
              <ErrorNotice error={shardsError} context="admin" engine="elasticsearch" variant="compact" onRetry={() => void loadShards()} />
            </div>
          ) : null}
          {shownGroups === null ? (
            shardsError === null ? <div className="mg-perf-empty panel-dim">{t("불러오는 중…")}</div> : null
          ) : shownGroups.length === 0 ? (
            <div className="mg-perf-empty panel-dim">{shardList !== null && shardList.length > 0 ? t("조건에 맞는 샤드가 없습니다") : t("샤드가 없습니다")}</div>
          ) : (
            <div className="mg-perf-scroll es-cl-shards">
              <table className="panel-table mg-struct-table mg-perf-table es-cl-table">
                <thead>
                  <tr>
                    <th>{t("인덱스 [하나]")}</th>
                    <th>{t("프라이머리·레플리카")}</th>
                    <th>{t("상태")}</th>
                    <th>{t("노드")}</th>
                    <th className="num">{t("문서")}</th>
                    <th className="num">{t("크기")}</th>
                  </tr>
                </thead>
                <tbody>
                  {shownGroups.slice(0, MAX_GROUPS).map(({ group, shards }) => {
                    const open = toggled.has(group.index) !== (group.health === "red" || group.health === "yellow");
                    const flip = () =>
                      setToggled((set) => {
                        const next = new Set(set);
                        if (!next.delete(group.index)) next.add(group.index);
                        return next;
                      });
                    return [
                      <tr key={group.index} className={`es-cl-group ${group.health}`}>
                        <td className="es-cl-group-cell">
                          <span className="es-cl-group-name">
                            <button type="button" className={`es-cl-toggle${open ? " open" : ""}`} aria-expanded={open} aria-label={open ? t("접기") : t("펼치기")} onClick={flip}>
                              <ChevronIcon size={10} />
                            </button>
                            <span className={`es-cl-dot ${group.health === "ok" || group.health === "moving" ? "green" : group.health}`} aria-hidden />
                            <button type="button" className="es-cl-link mono" title={t("{name} 열기", { name: group.index })} onClick={() => onOpenIndex(group.index)}>
                              {group.index}
                            </button>
                          </span>
                        </td>
                        <td className="mono panel-dim">{`${group.primaries}p · ${group.replicas}r`}</td>
                        <td>
                          {Object.entries(group.states).map(([state, n]) => (
                            <span key={state} className={`es-cl-state ${state.toLowerCase()}`}>
                              {`${state} ${n}`}
                            </span>
                          ))}
                        </td>
                        <td />
                        <td className="num mono">{group.docs.toLocaleString()}</td>
                        <td className="num mono">{bytesText(group.store)}</td>
                      </tr>,
                      ...(open
                        ? shards.map((s, i) => (
                            <tr key={`${group.index}:${s.shard}:${s.primary ? "p" : "r"}:${i}`} className={`es-cl-shard${s.state === "UNASSIGNED" ? " unassigned" : ""}`}>
                              <td className="mono es-cl-shard-num">{`#${s.shard}`}</td>
                              <td>
                                <span className={`es-cl-prirep${s.primary ? " primary" : ""}`}>{s.primary ? t("프라이머리") : t("레플리카")}</span>
                              </td>
                              <td>
                                <span className={`es-cl-state ${s.state.toLowerCase()}`}>{s.state}</span>
                                {s.reason ? <span className="panel-dim es-cl-reason">{s.reason}</span> : null}
                              </td>
                              <td className="mono" title={s.ip}>
                                {s.node || <span className="panel-dim">—</span>}
                              </td>
                              <td className="num mono">{s.docs === null ? "—" : s.docs.toLocaleString()}</td>
                              <td className="num mono">{s.store === null ? "—" : bytesText(s.store)}</td>
                            </tr>
                          ))
                        : []),
                    ];
                  })}
                </tbody>
              </table>
              {shownGroups.length > MAX_GROUPS ? (
                <div className="mg-perf-empty panel-dim">{t("인덱스 {count}개 중 {shown}개만 보입니다. 거르기로 좁혀 보세요", { count: shownGroups.length, shown: MAX_GROUPS })}</div>
              ) : null}
            </div>
          )}
        </Section>

        <Section
          title={t("실행 중인 작업")}
          hint={tasksShown !== null ? t("{count}개 · 오래 걸린 순", { count: tasksShown.length }) : undefined}
          actions={
            <>
              <input
                className="mg-input es-cl-filter mono"
                type="search"
                value={actionsText}
                placeholder="*search*"
                aria-label={t("동작으로 거르기")}
                title={t("동작 이름 패턴 (쉼표로 여러 개, * 와일드카드). 별표가 없으면 그 글자가 들어간 동작")}
                onChange={(event) => setActionsText(event.target.value)}
              />
              <label className="es-cl-check">
                <input type="checkbox" checked={childTasks} onChange={(event) => setChildTasks(event.target.checked)} />
                {t("하위 작업 포함")}
              </label>
            </>
          }
        >
          {tasksError !== null ? (
            <div className="mg-perf-empty">
              <ErrorNotice error={tasksError} context="admin" engine="elasticsearch" variant="compact" onRetry={() => void loadTasks()} />
            </div>
          ) : null}
          {tasksShown === null ? (
            tasksError === null ? <div className="mg-perf-empty panel-dim">{t("불러오는 중…")}</div> : null
          ) : tasksShown.length === 0 ? (
            <div className="mg-perf-empty panel-dim">{t("실행 중인 작업이 없습니다")}</div>
          ) : (
            <div className="mg-perf-scroll">
              <table className="panel-table mg-struct-table mg-perf-table es-cl-table">
                <thead>
                  <tr>
                    <th className="num">{t("실행 시간")}</th>
                    <th>{t("동작")}</th>
                    <th>{t("설명")}</th>
                    <th>{t("노드")}</th>
                    <th />
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {tasksShown.map((task) => (
                    <tr key={task.id}>
                      <td className="num mono">{task.running_time_ms === null ? "—" : durationText(task.running_time_ms)}</td>
                      <td className="mono" title={task.parent_task_id ? t("상위 작업 {id}", { id: task.parent_task_id }) : task.id}>
                        {task.parent_task_id ? <span className="panel-dim">↳ </span> : null}
                        {task.action}
                      </td>
                      <td className="mg-perf-cmd" title={task.description}>
                        {task.description || <span className="panel-dim">—</span>}
                      </td>
                      <td className="mono" title={task.node}>
                        {nodeRows?.find((n) => n.id !== "" && task.node.startsWith(n.id))?.name ?? task.node}
                      </td>
                      <td>
                        {isAppTask(task) ? (
                          <span className="es-cl-tag" title={`X-Opaque-Id: ${task.opaque_id}`}>
                            TablePeek
                          </span>
                        ) : null}
                        {task.cancelled ? <span className="es-cl-tag warn">{t("취소 중")}</span> : null}
                        {!task.cancellable ? <span className="panel-dim">{t("취소 불가")}</span> : null}
                      </td>
                      <td className="num">
                        {task.cancellable && !task.cancelled && !host.readOnly ? (
                          <button type="button" className="icon-text-button mg-danger-text" disabled={cancelling.has(task.id)} onClick={() => void cancel(task)}>
                            {cancelling.has(task.id) ? <Spinner size={10} /> : null}
                            {t("취소")}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <Section
          title={t("핫 스레드")}
          hint={t("노드마다 CPU를 가장 많이 쓰는 스레드 (_nodes/hot_threads)")}
          actions={
            <>
              <Select className="mg-input" aria-label={t("스레드 수")} value={hotThreads} onChange={(event) => setHotThreads(event.target.value)}>
                {["3", "5", "10"].map((n) => (
                  <option key={n} value={n}>
                    {t("스레드 {count}개", { count: n })}
                  </option>
                ))}
              </Select>
              <Select className="mg-input" aria-label={t("측정 간격")} value={hotInterval} onChange={(event) => setHotInterval(event.target.value)}>
                <option value="500ms">500ms</option>
                <option value="1s">1s</option>
              </Select>
              <button type="button" className="mg-qbtn" disabled={hotLoading} onClick={() => void loadHot()}>
                {hotLoading ? <Spinner size={10} /> : null}
                {hot === null ? t("불러오기") : t("다시 불러오기")}
              </button>
              {hot !== null ? (
                <button type="button" className="icon-button" title={t("복사")} aria-label={t("복사")} onClick={() => void copyHot()}>
                  <CopyIcon size={11} />
                </button>
              ) : null}
            </>
          }
        >
          {hotError !== null ? (
            <div className="mg-perf-empty">
              <ErrorNotice error={hotError} context="admin" engine="elasticsearch" variant="compact" onRetry={() => void loadHot()} />
            </div>
          ) : null}
          {hot !== null ? (
            <pre className="es-cl-hot mono">{hot.trim() === "" ? t("보고된 스레드가 없습니다") : hot}</pre>
          ) : hotError === null ? (
            <div className="mg-perf-empty panel-dim">{hotLoading ? t("측정하는 중…") : t("불러오기를 누르면 지금 바쁜 스레드를 잽니다")}</div>
          ) : null}
        </Section>
      </div>
    </div>
  );
}
