import { useEffect, useState } from "react";
import { formatNumber } from "../chartData";
import { collectRows } from "../export";
import { t, uiLocale } from "../i18n";
import { PEEK_ROW_CAP, peekModel, type PeekFinding, type PeekModel } from "../peek";
import type { GridResult } from "../store";
import { TABLE_COLORS } from "../tableColors";

// The share bar's slices before the rest fold into "Other".
const SHARE_SLICES = 7;
// The line's drawing box.
const LINE_W = 340;
const LINE_H = 56;

// The Peek summary of a result, read again when its rows change (a column
// moved, an edit staged). Null while it loads, when it is off, and for a
// result whose shape has none.
export function usePeekModel(result: GridResult | null, enabled: boolean): PeekModel | null {
  const [read, setRead] = useState<{ result: GridResult; model: PeekModel | null } | null>(null);
  useEffect(() => {
    if (!enabled || result === null) {
      return;
    }
    const { meta, source } = result;
    // A cut-off result would be summed up wrong; a long one is a list.
    if (meta.truncated || meta.columns.length === 0 || meta.rowCount === 0 || meta.rowCount > PEEK_ROW_CAP) {
      setRead({ result, model: null });
      return;
    }
    let alive = true;
    const load = async (): Promise<void> => {
      const rows = await collectRows(source);
      if (!alive) {
        return;
      }
      // The driver's kinds follow the columns as the server sent them.
      const kinds = source.columns.map((name) => meta.columnKinds?.[meta.columns.indexOf(name)] ?? null);
      setRead({ result, model: peekModel(source.columns, rows, kinds) });
    };
    void load();
    const stop = source.onUpdate(() => void load());
    return () => {
      alive = false;
      stop();
    };
  }, [result, enabled]);
  return enabled && read !== null && read.result === result ? read.model : null;
}

interface Formats {
  number(value: number): string;
  percent(value: number): string;
  ratio(value: number): string;
}

function formatsFor(locale: string): Formats {
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const percent = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 });
  const ratio = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  return { number: (v) => number.format(v), percent: (v) => percent.format(v), ratio: (v) => ratio.format(v) };
}

function sentence(finding: PeekFinding, f: Formats): string {
  switch (finding.kind) {
    case "share":
      return t("{measure} 가장 큰 몫: {label} · {percent} ({value} / {total})", {
        measure: finding.measure,
        label: finding.label,
        percent: f.percent(finding.value / finding.total),
        value: f.number(finding.value),
        total: f.number(finding.total),
      });
    case "top":
      return finding.median > 0 && finding.value > finding.median
        ? t("{measure} 가장 높음: {label} · {value}, 가운데 값 {median}보다 {percent} 높음", {
            measure: finding.measure,
            label: finding.label,
            value: f.number(finding.value),
            median: f.number(finding.median),
            percent: f.percent(finding.value / finding.median - 1),
          })
        : t("{measure} 가장 높음: {label} · {value}", {
            measure: finding.measure,
            label: finding.label,
            value: f.number(finding.value),
          });
    case "spike":
      return t("{label} 튐: {measure} {value}, 가운데 값 {median}의 {ratio}배", {
        label: finding.label,
        measure: finding.measure,
        value: f.number(finding.value),
        median: f.number(finding.median),
        ratio: f.ratio(finding.value / finding.median),
      });
    case "even":
      return t("{measure}에 크게 튀는 값 없음 · {min} – {max}", {
        measure: finding.measure,
        min: f.number(finding.min),
        max: f.number(finding.max),
      });
  }
}

const SHAPE_LABEL: Record<PeekModel["shape"], string> = {
  single: "값 하나",
  category: "범주별",
  time: "시간순",
};

// The first measure's share by label: the largest slices, the rest as one.
function ShareBar({ model, f }: { model: PeekModel; f: Formats }) {
  const measure = model.measures[0];
  const labels = model.axis!.labels;
  const rows = model.order
    .filter((row) => (measure.values[row] ?? 0) > 0)
    .sort((a, b) => (measure.values[b] ?? 0) - (measure.values[a] ?? 0));
  const slices: { key: string; label: string; value: number; color: string }[] = rows.slice(0, SHARE_SLICES).map((row, index) => ({
    key: `${row}`,
    label: labels[row],
    value: measure.values[row] ?? 0,
    color: TABLE_COLORS[index % TABLE_COLORS.length].value,
  }));
  const rest = rows.slice(SHARE_SLICES).reduce((sum, row) => sum + (measure.values[row] ?? 0), 0);
  if (rest > 0) {
    slices.push({ key: "other", label: t("기타"), value: rest, color: "var(--faint)" });
  }
  return (
    <div className="peek-viz">
      <div className="peek-viz-title">{measure.name}</div>
      <div className="peek-share" role="img" aria-label={slices.map((s) => `${s.label} ${f.percent(s.value / measure.total)}`).join(", ")}>
        {slices.map((slice) => (
          <i key={slice.key} style={{ flexGrow: slice.value, background: slice.color }} title={`${slice.label} · ${f.number(slice.value)}`} />
        ))}
      </div>
      <div className="peek-legend">
        {slices.map((slice) => (
          <span key={slice.key}>
            <b style={{ background: slice.color }} />
            {slice.label} {f.percent(slice.value / measure.total)}
          </span>
        ))}
      </div>
    </div>
  );
}

// One measure over time, the middle value dashed, the value that stands out
// marked; buttons pick the measure when there are several.
function TimeLine({ model, f }: { model: PeekModel; f: Formats }) {
  const [picked, setPicked] = useState(0);
  const measure = model.measures[Math.min(picked, model.measures.length - 1)];
  const labels = model.axis!.labels;
  const points = model.order
    .map((row) => ({ row, value: measure.values[row] }))
    .filter((point): point is { row: number; value: number } => point.value !== null);
  const lo = Math.min(0, measure.min);
  const hi = measure.max === lo ? lo + 1 : measure.max;
  const x = (i: number): number => (points.length === 1 ? LINE_W / 2 : 4 + (i * (LINE_W - 8)) / (points.length - 1));
  const y = (v: number): number => LINE_H - 4 - ((v - lo) / (hi - lo)) * (LINE_H - 10);
  return (
    <div className="peek-viz">
      {model.measures.length > 1 ? (
        <div className="peek-series" role="group" aria-label={t("그릴 열")}>
          {model.measures.map((m, index) => (
            <button
              type="button"
              key={m.index}
              aria-pressed={m === measure}
              className={m === measure ? "active" : ""}
              onClick={() => setPicked(index)}
            >
              {m.name}
            </button>
          ))}
        </div>
      ) : (
        <div className="peek-viz-title">{measure.name}</div>
      )}
      <svg className="peek-line" width={LINE_W} height={LINE_H + 14} viewBox={`0 0 ${LINE_W} ${LINE_H + 14}`} role="img" aria-label={measure.name}>
        <line className="peek-line-median" x1={0} x2={LINE_W} y1={y(measure.median)} y2={y(measure.median)} />
        <polyline className="peek-line-path" points={points.map((p, i) => `${x(i)},${y(p.value)}`).join(" ")} />
        {points.map((p, i) => (
          <circle key={p.row} className={p.row === measure.spike ? "spike" : ""} cx={x(i)} cy={y(p.value)} r={p.row === measure.spike ? 4 : 2}>
            <title>{`${labels[p.row]} · ${f.number(p.value)}`}</title>
          </circle>
        ))}
        <text className="peek-line-label" x={2} y={LINE_H + 12}>
          {labels[points[0]?.row ?? 0]}
        </text>
        <text className="peek-line-label" x={LINE_W - 2} y={LINE_H + 12} textAnchor="end">
          {labels[points[points.length - 1]?.row ?? 0]}
        </text>
      </svg>
    </div>
  );
}

// Above the grid of a query result: what the rows say in a line or two and a
// small picture of them, or a one-row result's numbers written large.
export function PeekStrip({ model }: { model: PeekModel }) {
  const locale = uiLocale();
  const f = formatsFor(locale);
  const [first, ...rest] = model.findings;
  return (
    <section className="peek-strip surface-bars" aria-label={t("Peek 요약")}>
      <div className="peek-text">
        <div className="peek-label">
          <span className="brand-word-peek">Peek</span>
          <span className="peek-shape">{t(SHAPE_LABEL[model.shape])}</span>
          <span>{t("{count}행 · 규칙으로 계산", { count: model.rowCount.toLocaleString(locale) })}</span>
        </div>
        {model.shape === "single" ? (
          <div className="peek-cards">
            {model.cards.map((card) => (
              <div className="peek-card" key={card.name}>
                <small>{card.name}</small>
                <strong>{formatNumber(card.value, locale)}</strong>
              </div>
            ))}
          </div>
        ) : (
          <>
            {first !== undefined ? <div className="peek-headline">{sentence(first, f)}</div> : null}
            {rest.length > 0 ? <div className="peek-sub">{rest.map((finding) => sentence(finding, f)).join(" · ")}</div> : null}
          </>
        )}
      </div>
      {model.shape === "category" && model.measures[0].additive && model.measures[0].total > 0 ? (
        <ShareBar model={model} f={f} />
      ) : model.shape === "time" ? (
        <TimeLine model={model} f={f} />
      ) : null}
    </section>
  );
}
