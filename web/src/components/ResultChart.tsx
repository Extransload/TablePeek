import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  AGGREGATES,
  CATEGORY_LIMITS,
  CHART_SORTS,
  CHART_TYPES,
  TIME_BUCKETS,
  buildChart,
  formatNumber,
  formatTick,
  formatTimeTick,
  compactAxis,
  niceTicks,
  timeTicks,
  type Aggregate,
  type ChartModel,
  type ChartSettings,
  type ChartSort,
  type ChartType,
  type ColumnInfo,
  type TimeBucket,
} from "../chartData";
import { getLanguage, t } from "../i18n";
import { ChevronDownIcon } from "./icons";
import { Select } from "./Select";
import { useMenuDismiss } from "./useMenuDismiss";

// Series colours, from the theme's own: the accent first, then the syntax
// colours, read again whenever the theme changes. Repeats (a theme whose
// keyword colour is its accent) are dropped; a few fixed hues fill in when the
// theme has too few.
const SERIES_VARIABLES = [
  "--accent",
  "--syntax-string",
  "--warn",
  "--syntax-keyword",
  "--syntax-function",
  "--ok",
  "--error",
  "--syntax-type",
  "--syntax-number",
  "--syntax-variable",
];
const FALLBACK_COLORS = ["#4e79a7", "#f28e2b", "#59a14f", "#e15759", "#76b7b2", "#edc948", "#b07aa1", "#ff9da7"];
const MIN_COLORS = 8;

// A colour too close to grey to tell from the "other" slice and the axes
// (a theme's comment or punctuation colour).
function greyish(color: string): boolean {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
  if (hex === undefined) {
    return false;
  }
  const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
  const channels = [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16));
  return Math.max(...channels) - Math.min(...channels) < 48;
}

export interface ThemeColors {
  series: string[];
  // The "other" slice and bar.
  other: string;
  panel: string;
}

function readThemeColors(): ThemeColors {
  const style = getComputedStyle(document.documentElement);
  const seen = new Set<string>();
  const series: string[] = [];
  const add = (color: string): void => {
    const key = color.toLowerCase();
    if (color !== "" && !seen.has(key) && !greyish(color)) {
      seen.add(key);
      series.push(color);
    }
  };
  for (const name of SERIES_VARIABLES) {
    add(style.getPropertyValue(name).trim());
  }
  for (const color of FALLBACK_COLORS) {
    if (series.length >= MIN_COLORS) {
      break;
    }
    add(color);
  }
  return {
    series,
    other: style.getPropertyValue("--faint").trim() || "#888888",
    panel: style.getPropertyValue("--bg").trim() || "#1e1e1e",
  };
}

export function useThemeColors(themeKey: string): ThemeColors {
  const [colors, setColors] = useState(readThemeColors);
  useEffect(() => {
    const update = (): void => setColors(readThemeColors());
    update();
    window.addEventListener("tablepeek:theme", update);
    return () => window.removeEventListener("tablepeek:theme", update);
  }, [themeKey]);
  return colors;
}

function useSize(ref: RefObject<HTMLDivElement | null>): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    const measure = (): void => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

function localeOf(): string {
  return getLanguage() === "en" ? "en-US" : "ko-KR";
}

// A slice's share of the pie, "<0.1%" for one too thin to round to anything.
function shareText(value: number, total: number, locale: string, digits: number): string {
  const percent = (value / (total || 1)) * 100;
  const least = 10 ** -digits;
  return percent > 0 && percent < least
    ? `<${least.toLocaleString(locale)}%`
    : `${percent.toLocaleString(locale, { maximumFractionDigits: digits })}%`;
}

// About how wide a label draws at the axis font: Hangul and CJK twice Latin.
function textWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += char.charCodeAt(0) > 0x2e80 ? 10.5 : 6.1;
  }
  return width;
}

function clip(text: string, max: number): string {
  if (textWidth(text) <= max) {
    return text;
  }
  let out = "";
  for (const char of text) {
    if (textWidth(`${out}${char}…`) > max) {
      break;
    }
    out += char;
  }
  return `${out}…`;
}

// A circle as path commands, so thousands of dots draw as one element.
function dot(x: number, y: number, r: number): string {
  return `M${x - r} ${y}a${r} ${r} 0 1 0 ${r * 2} 0a${r} ${r} 0 1 0 ${-r * 2} 0`;
}

interface Hover {
  index: number;
  // The series under the pointer (a scatter's dot), else null for all.
  series: number | null;
  x: number;
  y: number;
}

interface Plot {
  layer: ReactNode;
  hit(px: number, py: number): Hover | null;
  overlay(hover: Hover): ReactNode;
}

const TOP = 14;
const RIGHT = 18;
const LABEL_MAX = 130;

// Bars, lines, areas and scatters: a value axis up the left, X along the
// bottom (categories in a row, or times and numbers to scale).
function cartesianPlot(
  model: ChartModel,
  settings: ChartSettings,
  width: number,
  height: number,
  colors: ThemeColors,
  locale: string,
): Plot {
  const points = model.points;
  const count = points.length;
  const seriesCount = model.series.length;
  const kind = settings.type;
  const stacked = settings.stacked && seriesCount > 1 && (kind === "bar" || kind === "area");
  const categorical = kind === "bar" || model.xType === "text";

  // Each value's span: from zero, or from the stack beneath it.
  const lows: number[][] = [];
  const highs: number[][] = [];
  let min = Infinity;
  let max = -Infinity;
  for (const point of points) {
    let up = 0;
    let down = 0;
    const lo: number[] = [];
    const hi: number[] = [];
    point.values.forEach((value, s) => {
      if (value === null) {
        lo[s] = Number.NaN;
        hi[s] = Number.NaN;
        return;
      }
      if (stacked) {
        lo[s] = value >= 0 ? up : down;
        if (value >= 0) {
          up += value;
        } else {
          down += value;
        }
        hi[s] = value >= 0 ? up : down;
        min = Math.min(min, lo[s]);
        max = Math.max(max, lo[s]);
      } else {
        lo[s] = 0;
        hi[s] = value;
      }
      min = Math.min(min, hi[s]);
      max = Math.max(max, hi[s]);
    });
    lows.push(lo);
    highs.push(hi);
  }
  if (!Number.isFinite(min)) {
    min = 0;
    max = 1;
  }
  if (kind === "bar" || kind === "area") {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }

  const yTicks = niceTicks(min, max, Math.max(2, Math.floor((height - 60) / 44)));
  const yCompact = compactAxis(yTicks.domain);
  const yLabels = yTicks.ticks.map((value) => formatTick(value, yTicks.step, locale, yCompact));
  let left = 0;
  for (const label of yLabels) {
    left = Math.max(left, textWidth(label));
  }
  left = Math.ceil(left) + 16;
  const plotW = Math.max(10, width - left - RIGHT);
  const band = plotW / Math.max(1, count);

  // X labels: categories turn aslant when they don't fit their band, and
  // only every few show when the bands are thinner than a line of text.
  let widest = 0;
  if (categorical) {
    for (const point of points) {
      widest = Math.max(widest, Math.min(LABEL_MAX, textWidth(point.label)));
    }
  }
  const slanted = categorical && widest + 8 > band;
  const bottom = slanted ? Math.min(LABEL_MAX, Math.ceil(widest * 0.66 + 20)) : 26;
  const plotH = Math.max(10, height - TOP - bottom);
  const [y0, y1] = yTicks.domain;
  const yAt = (value: number): number => TOP + plotH - ((value - y0) / (y1 - y0 || 1)) * plotH;

  let x0 = 0;
  let x1 = 1;
  let xTickMarks: { at: number; label: string }[] = [];
  if (!categorical) {
    x0 = Infinity;
    x1 = -Infinity;
    for (const point of points) {
      x0 = Math.min(x0, point.x ?? Infinity);
      x1 = Math.max(x1, point.x ?? -Infinity);
    }
    if (model.xType === "time") {
      if (x0 === x1) {
        x0 -= 12 * 3_600_000;
        x1 += 12 * 3_600_000;
      }
      const ticks = timeTicks(x0, x1, Math.max(2, Math.floor(plotW / 100)));
      xTickMarks = ticks.ticks.map((at) => ({
        at,
        label: formatTimeTick(at, ticks.unit, x1 - x0, model.timeKind),
      }));
    } else {
      const ticks = niceTicks(x0, x1, Math.max(2, Math.floor(plotW / 80)));
      [x0, x1] = ticks.domain;
      const xCompact = compactAxis(ticks.domain);
      xTickMarks = ticks.ticks.map((at) => ({ at, label: formatTick(at, ticks.step, locale, xCompact) }));
    }
  }
  const xAt = (index: number): number =>
    categorical
      ? left + band * (index + 0.5)
      : left + (((points[index].x ?? x0) - x0) / (x1 - x0 || 1)) * plotW;
  const xs = points.map((_, index) => xAt(index));

  const grid: ReactNode[] = yTicks.ticks.map((value, index) => (
    <g key={`y${index}`}>
      <line className={value === 0 ? "chart-zero" : "chart-grid"} x1={left} x2={left + plotW} y1={yAt(value)} y2={yAt(value)} />
      <text className="chart-tick" x={left - 8} y={yAt(value)} dy="0.32em" textAnchor="end">
        {yLabels[index]}
      </text>
    </g>
  ));
  const xLabels: ReactNode[] = [];
  if (categorical) {
    const every = slanted ? Math.max(1, Math.ceil(13 / band)) : 1;
    for (let index = 0; index < count; index += every) {
      const x = xs[index];
      const text = clip(points[index].label, LABEL_MAX);
      xLabels.push(
        slanted ? (
          <text key={index} className="chart-tick" textAnchor="end" transform={`translate(${x + 3} ${TOP + plotH + 10}) rotate(-40)`}>
            {text}
          </text>
        ) : (
          <text key={index} className="chart-tick" x={x} y={TOP + plotH + 16} textAnchor="middle">
            {text}
          </text>
        ),
      );
    }
  } else {
    xTickMarks.forEach((mark, index) => {
      const x = left + ((mark.at - x0) / (x1 - x0 || 1)) * plotW;
      xLabels.push(
        <g key={index}>
          <line className="chart-grid faint" x1={x} x2={x} y1={TOP} y2={TOP + plotH} />
          <text className="chart-tick" x={x} y={TOP + plotH + 16} textAnchor="middle">
            {mark.label}
          </text>
        </g>,
      );
    });
  }

  const series: ReactNode[] = [];
  const colorOf = (s: number): string => colors.series[s % colors.series.length];
  if (kind === "bar") {
    const inner = band * (count > 1 ? 0.8 : 0.5);
    const each = stacked ? Math.min(inner, 64) : Math.min(inner / seriesCount, 48);
    const gap = each > 5 ? 1 : 0;
    for (let s = 0; s < seriesCount; s += 1) {
      let path = "";
      let otherPath = "";
      for (let index = 0; index < count; index += 1) {
        const lo = lows[index][s];
        const hi = highs[index][s];
        if (Number.isNaN(hi)) {
          continue;
        }
        const start = left + band * index + (band - (stacked ? each : each * seriesCount)) / 2;
        const x = stacked ? start : start + each * s;
        const top = Math.min(yAt(lo), yAt(hi));
        const h = Math.max(hi === lo ? 0 : 0.75, Math.abs(yAt(lo) - yAt(hi)));
        const rect = `M${x + gap / 2} ${top}h${Math.max(0.75, each - gap)}v${h}h${-Math.max(0.75, each - gap)}Z`;
        if (points[index].other) {
          otherPath += rect;
        } else {
          path += rect;
        }
      }
      series.push(<path key={`b${s}`} d={path} fill={colorOf(s)} />);
      if (otherPath !== "") {
        series.push(<path key={`o${s}`} d={otherPath} fill={colorOf(s)} fillOpacity={0.45} />);
      }
    }
  } else if (kind === "line" || kind === "area") {
    const dots = count <= 80;
    for (let s = 0; s < seriesCount; s += 1) {
      let line = "";
      let area = "";
      let run: number[] = [];
      const close = (): void => {
        if (run.length === 0) {
          return;
        }
        if (kind === "area") {
          let top = "";
          let base = "";
          run.forEach((index, at) => {
            top += `${at === 0 ? "M" : "L"}${xs[index]} ${yAt(highs[index][s])}`;
          });
          for (let at = run.length - 1; at >= 0; at -= 1) {
            const index = run[at];
            base += `L${xs[index]} ${yAt(stacked ? lows[index][s] : 0)}`;
          }
          area += `${top}${base}Z`;
        }
        run = [];
      };
      let dotPath = "";
      for (let index = 0; index < count; index += 1) {
        const hi = highs[index][s];
        if (Number.isNaN(hi)) {
          close();
          continue;
        }
        line += `${run.length === 0 ? "M" : "L"}${xs[index]} ${yAt(hi)}`;
        run.push(index);
        if (dots) {
          dotPath += dot(xs[index], yAt(hi), 2.4);
        }
      }
      close();
      if (area !== "") {
        series.push(<path key={`a${s}`} d={area} fill={colorOf(s)} fillOpacity={stacked ? 0.42 : 0.16} />);
      }
      series.push(
        <path key={`l${s}`} d={line} fill="none" stroke={colorOf(s)} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />,
      );
      if (dotPath !== "") {
        series.push(<path key={`d${s}`} d={dotPath} fill={colorOf(s)} />);
      }
    }
  } else {
    for (let s = 0; s < seriesCount; s += 1) {
      let path = "";
      for (let index = 0; index < count; index += 1) {
        const hi = highs[index][s];
        if (!Number.isNaN(hi)) {
          path += dot(xs[index], yAt(hi), 3);
        }
      }
      series.push(<path key={`s${s}`} d={path} fill={colorOf(s)} fillOpacity={0.7} />);
    }
  }

  const inPlot = (px: number, py: number): boolean =>
    px >= left && px <= left + plotW && py >= TOP - 4 && py <= TOP + plotH + 4;
  const hit = (px: number, py: number): Hover | null => {
    if (count === 0 || !inPlot(px, py)) {
      return null;
    }
    if (kind === "scatter") {
      let best = -1;
      let bestSeries = 0;
      let bestDistance = 18 * 18;
      for (let s = 0; s < seriesCount; s += 1) {
        for (let index = 0; index < count; index += 1) {
          const hi = highs[index][s];
          if (Number.isNaN(hi)) {
            continue;
          }
          const dx = xs[index] - px;
          const dy = yAt(hi) - py;
          const distance = dx * dx + dy * dy;
          if (distance < bestDistance) {
            best = index;
            bestSeries = s;
            bestDistance = distance;
          }
        }
      }
      return best < 0 ? null : { index: best, series: bestSeries, x: xs[best], y: yAt(highs[best][bestSeries]) };
    }
    let index: number;
    if (categorical) {
      index = Math.min(count - 1, Math.max(0, Math.floor((px - left) / band)));
    } else {
      // The nearest point along X; points run in X order.
      let lo = 0;
      let hi = count - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (xs[mid] < px) {
          lo = mid + 1;
        } else {
          hi = mid;
        }
      }
      index = lo > 0 && px - xs[lo - 1] < xs[lo] - px ? lo - 1 : lo;
    }
    return { index, series: null, x: xs[index], y: py };
  };
  const overlay = (hover: Hover): ReactNode => {
    const index = hover.index;
    if (kind === "bar") {
      return <rect className="chart-hover-band" x={left + band * index} y={TOP} width={band} height={plotH} />;
    }
    if (kind === "scatter") {
      const s = hover.series ?? 0;
      return (
        <circle
          className="chart-hover-dot"
          cx={xs[index]}
          cy={yAt(highs[index][s])}
          r={5.5}
          fill={colorOf(s)}
          stroke={colors.panel}
        />
      );
    }
    return (
      <g>
        <line className="chart-guide" x1={xs[index]} x2={xs[index]} y1={TOP} y2={TOP + plotH} />
        {highs[index].map((hi, s) =>
          Number.isNaN(hi) ? null : (
            <circle key={s} cx={xs[index]} cy={yAt(hi)} r={4} fill={colorOf(s)} stroke={colors.panel} strokeWidth={1.5} />
          ),
        )}
      </g>
    );
  };

  return {
    layer: (
      <>
        <g>{grid}</g>
        <g>{xLabels}</g>
        <line className="chart-axis-line" x1={left} x2={left + plotW} y1={TOP + plotH} y2={TOP + plotH} />
        <g>{series}</g>
      </>
    ),
    hit,
    overlay,
  };
}

interface Slice {
  index: number;
  start: number;
  end: number;
  color: string;
}

function arc(cx: number, cy: number, r: number, inner: number, start: number, end: number): string {
  if (end - start >= Math.PI * 2 - 1e-9) {
    // A whole ring: two halves, an arc can't start and end at one point.
    const outer = `M${cx + r} ${cy}A${r} ${r} 0 1 1 ${cx - r} ${cy}A${r} ${r} 0 1 1 ${cx + r} ${cy}Z`;
    return inner > 0
      ? `${outer}M${cx + inner} ${cy}A${inner} ${inner} 0 1 0 ${cx - inner} ${cy}A${inner} ${inner} 0 1 0 ${cx + inner} ${cy}Z`
      : outer;
  }
  const large = end - start > Math.PI ? 1 : 0;
  const p = (radius: number, angle: number): string => `${cx + radius * Math.cos(angle)} ${cy + radius * Math.sin(angle)}`;
  if (inner <= 0) {
    return `M${cx} ${cy}L${p(r, start)}A${r} ${r} 0 ${large} 1 ${p(r, end)}Z`;
  }
  return `M${p(r, start)}A${r} ${r} 0 ${large} 1 ${p(r, end)}L${p(inner, end)}A${inner} ${inner} 0 ${large} 0 ${p(inner, start)}Z`;
}

function slicesOf(model: ChartModel, colors: ThemeColors): { slices: Slice[]; total: number } {
  let total = 0;
  for (const point of model.points) {
    total += Math.max(0, point.values[0] ?? 0);
  }
  const slices: Slice[] = [];
  let angle = -Math.PI / 2;
  model.points.forEach((point, index) => {
    const value = point.values[0] ?? 0;
    if (value <= 0 || total <= 0) {
      return;
    }
    const start = angle;
    angle += (value / total) * Math.PI * 2;
    slices.push({
      index,
      start,
      end: angle,
      color: point.other ? colors.other : colors.series[slices.length % colors.series.length],
    });
  });
  return { slices, total };
}

// A pie (or donut) of the first series, slices clockwise from the top.
function piePlot(
  model: ChartModel,
  settings: ChartSettings,
  slices: Slice[],
  total: number,
  width: number,
  height: number,
  colors: ThemeColors,
  locale: string,
): Plot {
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.max(10, Math.min(width, height) / 2 - 14);
  const inner = settings.donut ? r * 0.58 : 0;
  const layer = (
    <>
      {slices.map((slice) => (
        <path key={slice.index} d={arc(cx, cy, r, inner, slice.start, slice.end)} fill={slice.color} stroke={colors.panel} strokeWidth={1} />
      ))}
      {slices.map((slice) => {
        const share = (slice.end - slice.start) / (Math.PI * 2);
        if (share < 0.045) {
          return null;
        }
        const mid = (slice.start + slice.end) / 2;
        const at = inner > 0 ? (r + inner) / 2 : r * 0.64;
        return (
          <text key={`p${slice.index}`} className="chart-slice-label" x={cx + at * Math.cos(mid)} y={cy + at * Math.sin(mid)} dy="0.32em" textAnchor="middle">
            {`${Math.round(share * 100)}%`}
          </text>
        );
      })}
      {inner > 0 ? (
        <>
          <text className="chart-donut-value" x={cx} y={cy} dy="0.1em" textAnchor="middle">
            {formatTick(total, 1, locale)}
          </text>
          <text className="chart-tick" x={cx} y={cy} dy="1.6em" textAnchor="middle">
            {clip(model.series[0] ?? "", inner * 1.6)}
          </text>
        </>
      ) : null}
    </>
  );
  const hit = (px: number, py: number): Hover | null => {
    const dx = px - cx;
    const dy = py - cy;
    const distance = Math.hypot(dx, dy);
    if (distance > r + 4 || distance < inner) {
      return null;
    }
    let angle = Math.atan2(dy, dx);
    if (angle < -Math.PI / 2) {
      angle += Math.PI * 2;
    }
    const slice = slices.find((entry) => angle >= entry.start && angle < entry.end);
    return slice === undefined ? null : { index: slice.index, series: 0, x: px, y: py };
  };
  const overlay = (hover: Hover): ReactNode => {
    const slice = slices.find((entry) => entry.index === hover.index);
    if (slice === undefined) {
      return null;
    }
    const mid = (slice.start + slice.end) / 2;
    const shift = slices.length > 1 ? 5 : 0;
    return (
      <path
        d={arc(cx + shift * Math.cos(mid), cy + shift * Math.sin(mid), r, inner, slice.start, slice.end)}
        fill={slice.color}
        stroke={colors.panel}
        strokeWidth={1.5}
      />
    );
  };
  return { layer, hit, overlay };
}

function ChartTooltip({
  hover,
  model,
  settings,
  colors,
  sliceColor,
  total,
  locale,
  width,
  height,
}: {
  hover: Hover;
  model: ChartModel;
  settings: ChartSettings;
  colors: ThemeColors;
  sliceColor: string | null;
  total: number;
  locale: string;
  width: number;
  height: number;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const element = ref.current;
    if (element !== null && (element.offsetWidth !== box.w || element.offsetHeight !== box.h)) {
      setBox({ w: element.offsetWidth, h: element.offsetHeight });
    }
  });
  const point = model.points[hover.index];
  if (point === undefined) {
    return null;
  }
  const left = hover.x + 14 + box.w > width ? Math.max(4, hover.x - 14 - box.w) : hover.x + 14;
  const top = Math.max(4, Math.min(height - box.h - 4, hover.y - box.h / 2));
  const value = (v: number | null): string => (v === null ? "NULL" : formatNumber(v, locale));
  const stackedTotal = settings.stacked && model.series.length > 1 && (settings.type === "bar" || settings.type === "area");
  const rows =
    settings.type === "pie"
      ? [0]
      : hover.series !== null
        ? [hover.series]
        : model.series.map((_, s) => s);
  return (
    <div className="chart-tip" ref={ref} style={{ left, top }}>
      <div className="chart-tip-title">{point.label}</div>
      {rows.map((s) => (
        <div className="chart-tip-row" key={s}>
          <span className="chart-swatch" style={{ background: sliceColor ?? colors.series[s % colors.series.length] }} />
          <span className="chart-tip-name">{model.series[s]}</span>
          <span className="chart-tip-value">{value(point.values[s])}</span>
        </div>
      ))}
      {settings.type === "pie" && total > 0 && (point.values[0] ?? 0) > 0 ? (
        <div className="chart-tip-row muted">
          <span className="chart-tip-name">{t("비율")}</span>
          <span className="chart-tip-value">
            {shareText(point.values[0] ?? 0, total, locale, 2)}
          </span>
        </div>
      ) : null}
      {stackedTotal && hover.series === null ? (
        <div className="chart-tip-row muted">
          <span className="chart-tip-name">{t("합계")}</span>
          <span className="chart-tip-value">
            {formatNumber(point.values.reduce<number>((sum, v) => sum + (v ?? 0), 0), locale)}
          </span>
        </div>
      ) : null}
      <div className="chart-tip-foot">
        {point.other ? t("{count}개 항목 · {rows}행", { count: model.merged.toLocaleString(), rows: point.rows.toLocaleString() }) : t("{count}행", { count: point.rows.toLocaleString() })}
      </div>
    </div>
  );
}

function ChartPlot({ model, settings, colors }: { model: ChartModel; settings: ChartSettings; colors: ThemeColors }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const { width, height } = useSize(hostRef);
  const [hover, setHover] = useState<Hover | null>(null);
  const locale = localeOf();
  const pie = settings.type === "pie";
  const pieParts = useMemo(() => (pie ? slicesOf(model, colors) : { slices: [], total: 0 }), [pie, model, colors]);
  const plot = useMemo(() => {
    if (width < 40 || height < 40) {
      return null;
    }
    return pie
      ? piePlot(model, settings, pieParts.slices, pieParts.total, width, height, colors, locale)
      : cartesianPlot(model, settings, width, height, colors, locale);
  }, [model, settings, width, height, colors, locale, pie, pieParts]);
  useEffect(() => setHover(null), [plot]);

  const onMove = useCallback(
    (event: PointerEvent<SVGSVGElement>) => {
      if (plot === null) {
        return;
      }
      const rect = event.currentTarget.getBoundingClientRect();
      setHover(plot.hit(event.clientX - rect.left, event.clientY - rect.top));
    },
    [plot],
  );

  const legend = pie ? (
    <div className="chart-pie-legend">
      {pieParts.slices.map((slice) => {
        const point = model.points[slice.index];
        const value = point.values[0] ?? 0;
        return (
          <div
            key={slice.index}
            className={`chart-pie-entry${hover?.index === slice.index ? " active" : ""}`}
            title={point.label}
          >
            <span className="chart-swatch" style={{ background: slice.color }} />
            <span className="chart-pie-label">{point.label}</span>
            <span className="chart-pie-value">{formatNumber(value, locale)}</span>
            <span className="chart-pie-share">
              {shareText(value, pieParts.total, locale, 1)}
            </span>
          </div>
        );
      })}
    </div>
  ) : (
    <div className="chart-legend">
      {model.series.map((name, s) => (
        <span className="chart-legend-entry" key={name}>
          <span
            className={`chart-swatch${settings.type === "line" ? " line" : ""}`}
            style={{ background: colors.series[s % colors.series.length] }}
          />
          {name}
        </span>
      ))}
    </div>
  );

  return (
    <div className={`chart-body${pie ? " pie" : ""}`}>
      {pie ? null : legend}
      <div className="chart-host" ref={hostRef}>
        {plot !== null ? (
          <svg
            className="chart-svg"
            width={width}
            height={height}
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
            role="img"
            aria-label={model.series.join(", ")}
          >
            {plot.layer}
            {hover !== null ? plot.overlay(hover) : null}
          </svg>
        ) : null}
        {hover !== null && plot !== null ? (
          <ChartTooltip
            hover={hover}
            model={model}
            settings={settings}
            colors={colors}
            sliceColor={pie ? (pieParts.slices.find((slice) => slice.index === hover.index)?.color ?? null) : null}
            total={pieParts.total}
            locale={locale}
            width={width}
            height={height}
          />
        ) : null}
      </div>
      {pie ? legend : null}
    </div>
  );
}

const TYPE_LABELS: Record<ChartType, string> = {
  bar: "막대",
  line: "선",
  area: "영역",
  pie: "원형",
  scatter: "산점도",
};

export const AGGREGATE_LABELS: Record<Aggregate, string> = {
  none: "없음 (행마다)",
  count: "개수",
  sum: "합계",
  avg: "평균",
  min: "최소",
  max: "최대",
};

export const BUCKET_LABELS: Record<TimeBucket, string> = {
  auto: "자동",
  none: "그대로",
  minute: "분",
  hour: "시간",
  day: "일",
  week: "주",
  month: "월",
  year: "년",
};

const SORT_LABELS: Record<ChartSort, string> = {
  x: "X 순",
  "value-desc": "값 큰 순",
  "value-asc": "값 작은 순",
};

const TYPE_GROUPS: [ColumnInfo["type"], string][] = [
  ["time", "날짜·시간"],
  ["text", "텍스트"],
  ["number", "숫자"],
];

// The result's columns as <option>s, grouped by what they hold.
export function columnOptions(columns: ColumnInfo[], keep: (column: ColumnInfo) => boolean = () => true): ReactNode {
  return TYPE_GROUPS.map(([type, label]) => {
    const matching = columns.filter((column) => column.type === type && keep(column));
    return matching.length === 0 ? null : (
      <optgroup key={type} label={t(label)}>
        {matching.map((column) => (
          <option key={column.name} value={column.name}>
            {column.name}
          </option>
        ))}
      </optgroup>
    );
  });
}

// The Y picker: the number columns, any of them on.
function SeriesPicker({
  columns,
  x,
  picked,
  onChange,
}: {
  columns: ColumnInfo[];
  x: string | null;
  picked: string[];
  onChange(next: string[]): void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  useMenuDismiss(open, rootRef, close);
  const numbers = columns.filter((column) => column.type === "number" && column.name !== x);
  const label = picked.length === 0 ? t("없음") : picked.join(", ");
  return (
    <div className="analysis-picker" ref={rootRef}>
      <button
        type="button"
        className={`analysis-picker-button${open ? " active" : ""}`}
        onClick={() => setOpen((value) => !value)}
        disabled={numbers.length === 0}
        title={numbers.length === 0 ? t("숫자 컬럼이 없습니다") : label}
        aria-expanded={open}
      >
        <span className="analysis-picker-text">{label}</span>
        <ChevronDownIcon size={10} />
      </button>
      {open ? (
        <div className="analysis-picker-panel" role="dialog" aria-label={t("Y 값")}>
          {numbers.map((column) => (
            <label key={column.name} className="analysis-picker-row">
              <input
                type="checkbox"
                checked={picked.includes(column.name)}
                onChange={(event) =>
                  onChange(
                    numbers
                      .map((entry) => entry.name)
                      .filter((name) => (name === column.name ? event.target.checked : picked.includes(name))),
                  )
                }
              />
              <span>{column.name}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface ResultChartProps {
  columns: ColumnInfo[];
  rows: unknown[][];
  settings: ChartSettings;
  // How many rows, of what (the result, the whole table).
  scope: string;
  warn: string | null;
  themeKey: string;
  onChange(next: ChartSettings): void;
}

// The Chart view: its settings along the top, then the chart with its legend
// and a tooltip of the exact values under the pointer.
export function ResultChart({ columns, rows, settings, scope, warn, themeKey, onChange }: ResultChartProps) {
  const colors = useThemeColors(themeKey);
  const model = useMemo(
    () => buildChart(rows, columns, settings, { other: t("기타"), nul: "NULL" }),
    [rows, columns, settings],
  );
  const set = (patch: Partial<ChartSettings>): void => onChange({ ...settings, ...patch });
  const x = columns.find((column) => column.name === settings.x) ?? null;
  const hasNumbers = columns.some((column) => column.type === "number" && column.name !== settings.x);
  const categories = x !== null && (x.type === "text" || settings.type === "pie");
  const ordered = settings.type === "bar" || settings.type === "pie" || x?.type === "text";
  const stackable = (settings.type === "bar" || settings.type === "area") && model.series.length > 1;

  const notes: string[] = [scope];
  if (x?.type === "time" && settings.bucket === "auto") {
    notes.push(t("단위: {bucket}", { bucket: t(BUCKET_LABELS[model.bucket]) }));
  }
  if (model.skipped > 0) {
    notes.push(t("X가 비어 있는 {count}행 제외", { count: model.skipped.toLocaleString() }));
  }
  if (model.merged > 0) {
    notes.push(t("{count}개 항목을 기타로 묶음", { count: model.merged.toLocaleString() }));
  }

  let empty: ReactNode = null;
  if (rows.length === 0) {
    empty = t("결과에 행이 없습니다");
  } else if (x === null) {
    empty = t("X 컬럼을 고르세요");
  } else if (model.noSeries) {
    empty = (
      <>
        <span>
          {hasNumbers
            ? t("Y 값으로 쓸 숫자 컬럼을 고르세요.")
            : t("이 결과에는 숫자 컬럼이 없습니다. 집계를 '개수'로 바꾸면 X마다 행 수를 셉니다.")}
        </span>
        <button type="button" onClick={() => set({ agg: "count", y: [] })}>
          {t("행 수 세기")}
        </button>
      </>
    );
  } else if (model.points.length === 0) {
    empty = t("그릴 값이 없습니다: X 값이 모두 비어 있습니다");
  } else if (settings.type === "pie" && !model.points.some((point) => (point.values[0] ?? 0) > 0)) {
    empty = t("원형 차트는 0보다 큰 값만 그립니다");
  }

  return (
    <div className="analysis-view">
      <div className="analysis-controls">
        <div className="view-tabs analysis-types" role="group" aria-label={t("차트 종류")}>
          {CHART_TYPES.map((type) => (
            <button
              type="button"
              key={type}
              className={settings.type === type ? "active" : ""}
              aria-pressed={settings.type === type}
              onClick={() => set({ type })}
            >
              {t(TYPE_LABELS[type])}
            </button>
          ))}
        </div>
        <label className="analysis-field">
          <span>X</span>
          <Select value={settings.x ?? ""} onChange={(event) => set({ x: event.target.value })}>
            {columnOptions(columns)}
          </Select>
        </label>
        <label className="analysis-field">
          <span>Y</span>
          <SeriesPicker columns={columns} x={settings.x} picked={settings.y} onChange={(y) => set({ y })} />
        </label>
        <label className="analysis-field">
          <span>{t("집계")}</span>
          <Select value={settings.agg} onChange={(event) => set({ agg: event.target.value as Aggregate })}>
            {AGGREGATES.map((agg) => (
              <option key={agg} value={agg}>
                {t(AGGREGATE_LABELS[agg])}
              </option>
            ))}
          </Select>
        </label>
        {x?.type === "time" ? (
          <label className="analysis-field">
            <span>{t("단위")}</span>
            <Select value={settings.bucket} onChange={(event) => set({ bucket: event.target.value as TimeBucket })}>
              {TIME_BUCKETS.map((bucket) => (
                <option key={bucket} value={bucket}>
                  {t(BUCKET_LABELS[bucket])}
                </option>
              ))}
            </Select>
          </label>
        ) : null}
        {ordered ? (
          <label className="analysis-field">
            <span>{t("정렬")}</span>
            <Select value={settings.sort} onChange={(event) => set({ sort: event.target.value as ChartSort })}>
              {CHART_SORTS.map((sort) => (
                <option key={sort} value={sort}>
                  {t(SORT_LABELS[sort])}
                </option>
              ))}
            </Select>
          </label>
        ) : null}
        {categories ? (
          <label className="analysis-field">
            <span>{t("항목")}</span>
            <Select value={String(settings.limit)} onChange={(event) => set({ limit: Number(event.target.value) })}>
              {CATEGORY_LIMITS.map((limit) => (
                <option key={limit} value={limit}>
                  {limit === 0 ? t("전체") : t("상위 {count}", { count: limit })}
                </option>
              ))}
            </Select>
          </label>
        ) : null}
        {stackable ? (
          <label className="analysis-check">
            <input type="checkbox" checked={settings.stacked} onChange={(event) => set({ stacked: event.target.checked })} />
            {t("쌓기")}
          </label>
        ) : null}
        {settings.type === "pie" ? (
          <label className="analysis-check">
            <input type="checkbox" checked={settings.donut} onChange={(event) => set({ donut: event.target.checked })} />
            {t("도넛")}
          </label>
        ) : null}
        <span className="analysis-meta" title={[...notes, warn ?? ""].filter(Boolean).join("\n")}>
          {warn !== null ? <span className="warn">{warn}</span> : null}
          <span>{notes.join(" · ")}</span>
        </span>
      </div>
      {empty !== null ? <div className="analysis-empty">{empty}</div> : <ChartPlot model={model} settings={settings} colors={colors} />}
    </div>
  );
}
