// The location map of a 스키마 field (MONGODB.md §8.1): the sampled GeoJSON
// geometries and `[lng, lat]` pairs drawn on an offline world map
// (equirectangular, Natural Earth land outlines built in). Wheel or the
// buttons zoom, dragging pans, nearby dots merge into numbered clusters, and
// hovering shows the value. Dragging a rectangle or a circle (or Shift-drag)
// picks a region, which applies as a `$geoWithin` filter.

import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { FilterIcon, FitIcon, MinusIcon, PlusIcon } from "../../../components/icons";
import { t } from "../../../i18n";
import type { BsonValue } from "../bson";
import { toShell } from "../format";
import { EARTH_KM, angularDistance, circleOutline, geoWithin, itemInRegion, type GeoField, type GeoKind, type GeoRegion, type LngLat } from "../geo";
import { LAND_PATH } from "../worldLand";
import "./geomap.css";

interface View {
  // Map centre in degrees and zoom (1 = the whole world fits).
  lng: number;
  lat: number;
  zoom: number;
}

type Tool = "pan" | "box" | "circle";

interface Drag {
  pointer: number;
  tool: Tool;
  x: number;
  y: number;
  start: View;
  moved: boolean;
  // A cluster pressed without moving zooms in to it.
  cluster: number | null;
}

interface Dot {
  x: number;
  y: number;
  lng: number;
  lat: number;
  // Positions merged in, and the values (item indices) they belong to.
  n: number;
  items: number[];
}

// On-screen radius of a dot standing for `count` values.
function dotRadius(count: number): number {
  return count > 1 ? Math.min(24, 7 + 2.4 * Math.log2(count)) : 4.5;
}

const MAX_ZOOM = 256;
const CLUSTER_PX = 26;
const GRATICULE_STEPS = [1, 2, 5, 10, 15, 30];

const KIND_LABEL: Record<GeoKind, string> = {
  Point: "GeoJSON Point",
  Legacy: "[lng, lat]",
  MultiPoint: "GeoJSON MultiPoint",
  LineString: "GeoJSON LineString",
  MultiLineString: "GeoJSON MultiLineString",
  Polygon: "GeoJSON Polygon",
  MultiPolygon: "GeoJSON MultiPolygon",
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function degrees(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function GeoMap({ field, onFilter }: { field: GeoField; onFilter(value: BsonValue): void }) {
  const clipId = `geo-clip-${useId().replace(/[^A-Za-z0-9_-]/g, "")}`;
  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(0);
  const height = clamp(Math.round(width * 0.5), 220, 360);
  const [view, setView] = useState<View | null>(null);
  const [tool, setTool] = useState<Tool>("pan");
  const [region, setRegion] = useState<GeoRegion | null>(null);
  const [draft, setDraft] = useState<GeoRegion | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number; items: number[] } | null>(null);
  const drag = useRef<Drag | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (el === null) {
      return;
    }
    const ro = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Pixels per degree at zoom 1, when the whole world just fits.
  const base = width > 0 ? Math.min(width / 360, height / 180) : 1;

  // Keep the world covering the view where it is larger than the view.
  const settle = (v: View): View => {
    const zoom = clamp(v.zoom, 1, MAX_ZOOM);
    const s = base * zoom;
    const halfW = width / (2 * s);
    const halfH = height / (2 * s);
    return {
      zoom,
      lng: halfW >= 180 ? 0 : clamp(v.lng, -180 + halfW, 180 - halfW),
      lat: halfH >= 90 ? 0 : clamp(v.lat, -90 + halfH, 90 - halfH),
    };
  };

  // The view that frames every value of the sample.
  const fitView = (): View => {
    let west = Infinity;
    let east = -Infinity;
    let south = Infinity;
    let north = -Infinity;
    for (const item of field.items) {
      for (const [lng, lat] of [...item.points, ...item.lines.flat()]) {
        west = Math.min(west, lng);
        east = Math.max(east, lng);
        south = Math.min(south, lat);
        north = Math.max(north, lat);
      }
    }
    if (west > east) {
      return settle({ lng: 0, lat: 0, zoom: 1 });
    }
    const spanX = Math.max(east - west, 2);
    const spanY = Math.max(north - south, 1);
    const zoom = Math.min(width / (spanX * base * 1.25), height / (spanY * base * 1.25), 32);
    return settle({ lng: (west + east) / 2, lat: (south + north) / 2, zoom });
  };

  useEffect(() => {
    if (width > 0) {
      setView((v) => (v === null ? fitView() : settle(v)));
    }
  }, [width]);

  const v = view ?? { lng: 0, lat: 0, zoom: 1 };
  const s = base * v.zoom;
  const px = (lng: number) => width / 2 + (lng - v.lng) * s;
  const py = (lat: number) => height / 2 - (lat - v.lat) * s;
  const geoAt = (x: number, y: number): LngLat => [v.lng + (x - width / 2) / s, v.lat - (y - height / 2) / s];

  // Wheel zoom keeps the point under the pointer still; React's wheel
  // listener is passive, so this one is attached by hand.
  const zoomAt = useRef<(x: number, y: number, factor: number) => void>(() => {});
  zoomAt.current = (x, y, factor) => {
    const [lng, lat] = geoAt(x, y);
    const zoom = clamp(v.zoom * factor, 1, MAX_ZOOM);
    const ns = base * zoom;
    setView(settle({ zoom, lng: lng - (x - width / 2) / ns, lat: lat + (y - height / 2) / ns }));
  };
  useEffect(() => {
    const svg = svgRef.current;
    if (svg === null) {
      return;
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      zoomAt.current(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.002)));
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [width > 0]);

  const inside = useMemo(() => {
    const r = draft ?? region;
    return r === null ? null : new Set(field.items.flatMap((item, i) => (itemInRegion(item, r) ? [i] : [])));
  }, [field, draft, region]);

  // Dots on screen: positions are binned by grid cell, then cells whose
  // circles would overlap merge (largest first) into one numbered cluster.
  const dots = useMemo(() => {
    const cells = new Map<string, Dot>();
    field.items.forEach((item, i) => {
      for (const [lng, lat] of item.points) {
        const x = px(lng);
        const y = py(lat);
        if (x < -CLUSTER_PX || y < -CLUSTER_PX || x > width + CLUSTER_PX || y > height + CLUSTER_PX) {
          continue;
        }
        const key = `${Math.floor(x / CLUSTER_PX)},${Math.floor(y / CLUSTER_PX)}`;
        const cell = cells.get(key);
        if (cell === undefined) {
          cells.set(key, { x, y, lng, lat, n: 1, items: [i] });
        } else {
          cell.n++;
          cell.x += (x - cell.x) / cell.n;
          cell.y += (y - cell.y) / cell.n;
          cell.lng += (lng - cell.lng) / cell.n;
          cell.lat += (lat - cell.lat) / cell.n;
          if (cell.items[cell.items.length - 1] !== i) {
            cell.items.push(i);
          }
        }
      }
    });
    const merged: Dot[] = [];
    for (const c of [...cells.values()].sort((a, b) => b.items.length - a.items.length)) {
      const into = merged.find((m) => Math.hypot(m.x - c.x, m.y - c.y) < dotRadius(m.items.length) + dotRadius(c.items.length));
      if (into === undefined) {
        merged.push(c);
        continue;
      }
      const n = into.n + c.n;
      into.x = (into.x * into.n + c.x * c.n) / n;
      into.y = (into.y * into.n + c.y * c.n) / n;
      into.lng = (into.lng * into.n + c.lng * c.n) / n;
      into.lat = (into.lat * into.n + c.lat * c.n) / n;
      into.n = n;
      into.items = [...new Set([...into.items, ...c.items])];
    }
    return merged;
  }, [field, v.lng, v.lat, v.zoom, width, height]);

  const graticule = useMemo(() => {
    const step = GRATICULE_STEPS.find((d) => d * s >= 70) ?? 30;
    const lines: string[] = [];
    const [west, north] = geoAt(0, 0);
    const [east, south] = geoAt(width, height);
    for (let lng = Math.ceil(Math.max(-180, west) / step) * step; lng <= Math.min(180, east); lng += step) {
      lines.push(`M${px(lng)} ${py(Math.min(90, north))}V${py(Math.max(-90, south))}`);
    }
    for (let lat = Math.ceil(Math.max(-90, south) / step) * step; lat <= Math.min(90, north); lat += step) {
      lines.push(`M${px(Math.max(-180, west))} ${py(lat)}H${px(Math.min(180, east))}`);
    }
    return lines.join("");
  }, [v.lng, v.lat, v.zoom, width, height]);

  const local = (e: ReactPointerEvent): [number, number] => {
    const r = svgRef.current!.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  };

  const regionBetween = (mode: Tool, a: LngLat, b: LngLat): GeoRegion => {
    if (mode === "circle") {
      return { kind: "circle", center: [clamp(a[0], -180, 180), clamp(a[1], -90, 90)], radius: Math.min(Math.PI, angularDistance(a, b)) };
    }
    const lngs = [clamp(a[0], -180, 180), clamp(b[0], -180, 180)].sort((p, q) => p - q);
    const lats = [clamp(a[1], -90, 90), clamp(b[1], -90, 90)].sort((p, q) => p - q);
    return { kind: "box", west: lngs[0], east: lngs[1], south: lats[0], north: lats[1] };
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || view === null) {
      return;
    }
    const [x, y] = local(e);
    const hit = (e.target as Element).closest("[data-cluster]");
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { pointer: e.pointerId, tool: e.shiftKey ? "box" : tool, x, y, start: view, moved: false, cluster: hit === null ? null : Number(hit.getAttribute("data-cluster")) };
    setHover(null);
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (d === null || d.pointer !== e.pointerId) {
      return;
    }
    const [x, y] = local(e);
    if (!d.moved && Math.hypot(x - d.x, y - d.y) < 4) {
      return;
    }
    d.moved = true;
    if (d.tool === "pan") {
      const ds = base * d.start.zoom;
      setView(settle({ ...d.start, lng: d.start.lng - (x - d.x) / ds, lat: d.start.lat + (y - d.y) / ds }));
    } else {
      setDraft(regionBetween(d.tool, geoAt(d.x, d.y), geoAt(x, y)));
    }
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    if (d === null || d.pointer !== e.pointerId) {
      return;
    }
    drag.current = null;
    if (!d.moved) {
      const dot = d.cluster === null ? undefined : dots[d.cluster];
      if (dot !== undefined && dot.items.length > 1) {
        setView(settle({ lng: dot.lng, lat: dot.lat, zoom: v.zoom * 4 }));
      }
      return;
    }
    if (d.tool !== "pan") {
      const [x, y] = local(e);
      const r = regionBetween(d.tool, geoAt(d.x, d.y), geoAt(x, y));
      const empty = r.kind === "box" ? r.east - r.west <= 0 || r.north - r.south <= 0 : r.radius <= 0;
      setRegion(empty ? region : r);
      setDraft(null);
    }
  };

  const shown = draft ?? region;
  let shape = null;
  if (shown !== null && view !== null) {
    if (shown.kind === "box") {
      shape = <rect className="mg-geo-region" x={px(shown.west)} y={py(shown.north)} width={(shown.east - shown.west) * s} height={(shown.north - shown.south) * s} />;
    } else {
      const ring = circleOutline(shown.center, shown.radius);
      shape = (
        <>
          <path className="mg-geo-region" d={`M${ring.map(([lng, lat]) => `${px(lng)} ${py(lat)}`).join("L")}Z`} />
          <circle className="mg-geo-center" cx={px(shown.center[0])} cy={py(shown.center[1])} r={2.5} />
        </>
      );
    }
  }

  const kinds = (Object.entries(field.kinds) as [GeoKind, number][])
    .sort((a, b) => b[1] - a[1])
    .map(([kind, n]) => `${kind === "Legacy" ? t("[경도, 위도]") : KIND_LABEL[kind]} ${n.toLocaleString()}`)
    .join(" · ");

  const filter = region === null ? null : geoWithin(region, field.pointsOnly);
  const docsInside = region === null || inside === null ? 0 : new Set([...inside].map((i) => field.items[i].doc)).size;
  const sampleDocs = new Set(field.items.map((item) => item.doc)).size;

  let regionText = "";
  if (region?.kind === "box") {
    regionText = t("경도 {west} ~ {east} · 위도 {south} ~ {north}", { west: degrees(region.west), east: degrees(region.east), south: degrees(region.south), north: degrees(region.north) });
  } else if (region?.kind === "circle") {
    regionText = t("중심 {lng}, {lat} · 반경 {km} km", {
      lng: degrees(region.center[0]),
      lat: degrees(region.center[1]),
      km: (region.radius * EARTH_KM).toLocaleString(undefined, { maximumFractionDigits: region.radius * EARTH_KM < 10 ? 2 : 0 }),
    });
  }

  const tip = hover === null ? null : hover.items.slice(0, 4).map((i) => field.items[i]);

  return (
    <div className="mg-viz mg-geo">
      <div className="mg-geo-head">
        <span className="mg-viz-note">
          {t("위치 {count}개", { count: field.items.length.toLocaleString() })}
          <span className="panel-dim"> · {kinds}</span>
        </span>
        <span className="spacer" />
        <div className="view-tabs mg-geo-tools" role="group" aria-label={t("지도 도구")}>
          {(
            [
              ["pan", t("이동"), t("끌어서 지도를 옮깁니다 (Shift+끌기는 사각형)")],
              ["box", t("사각형"), t("끌어서 사각형 영역을 고릅니다 ($box 또는 $geometry)")],
              ["circle", t("원"), t("중심에서 끌어서 원 영역을 고릅니다 ($centerSphere)")],
            ] as [Tool, string, string][]
          ).map(([id, label, title]) => (
            <button key={id} type="button" className={tool === id ? "active" : undefined} aria-pressed={tool === id} title={title} onClick={() => setTool(id)}>
              {label}
            </button>
          ))}
        </div>
        <button type="button" className="mg-qbtn" title={t("확대")} aria-label={t("확대")} onClick={() => zoomAt.current(width / 2, height / 2, 2)}>
          <PlusIcon size={10} />
        </button>
        <button type="button" className="mg-qbtn" title={t("축소")} aria-label={t("축소")} onClick={() => zoomAt.current(width / 2, height / 2, 0.5)}>
          <MinusIcon size={10} />
        </button>
        <button type="button" className="mg-qbtn" title={t("모든 위치가 보이게 맞추기")} aria-label={t("모든 위치가 보이게 맞추기")} onClick={() => setView(fitView())}>
          <FitIcon size={10} />
        </button>
      </div>
      <div ref={boxRef} className={`mg-geo-map tool-${tool}`} style={{ height }}>
        {width > 0 ? (
          <svg
            ref={svgRef}
            width={width}
            height={height}
            role="img"
            aria-label={t("{path} 위치 지도", { path: field.path })}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => {
              drag.current = null;
              setDraft(null);
            }}
            onPointerLeave={() => setHover(null)}
            onDoubleClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              zoomAt.current(e.clientX - r.left, e.clientY - r.top, e.shiftKey ? 0.5 : 2);
            }}
          >
            <defs>
              <clipPath id={clipId}>
                <rect x={0} y={0} width={3600} height={1800} />
              </clipPath>
            </defs>
            <rect className="mg-geo-sea" x={px(-180)} y={py(90)} width={360 * s} height={180 * s} />
            <path className="mg-geo-grid" d={graticule} />
            <g transform={`matrix(${s / 10} 0 0 ${s / 10} ${width / 2 - (180 + v.lng) * s} ${height / 2 - (90 - v.lat) * s})`}>
              <path className="mg-geo-land" d={LAND_PATH} clipPath={`url(#${clipId})`} vectorEffect="non-scaling-stroke" />
            </g>
            {field.items.map((item, i) =>
              item.lines.length === 0 ? null : (
                <path
                  key={i}
                  className={`mg-geo-line${item.kind === "Polygon" || item.kind === "MultiPolygon" ? " area" : ""}${inside !== null && !inside.has(i) ? " out" : ""}`}
                  d={item.lines.map((l) => `M${l.map(([lng, lat]) => `${px(lng)} ${py(lat)}`).join("L")}${item.kind === "Polygon" || item.kind === "MultiPolygon" ? "Z" : ""}`).join("")}
                  onPointerEnter={(e) => {
                    if (drag.current === null) {
                      const [x, y] = local(e);
                      setHover({ x, y, items: [i] });
                    }
                  }}
                  onPointerLeave={() => setHover(null)}
                />
              ),
            )}
            {dots.map((dot, n) => {
              const count = dot.items.length;
              const out = inside !== null && dot.items.every((i) => !inside.has(i));
              const enter = () => {
                if (drag.current === null) {
                  setHover({ x: dot.x, y: dot.y, items: dot.items });
                }
              };
              return count > 1 ? (
                <g key={n} className={`mg-geo-cluster${out ? " out" : ""}`} data-cluster={n} onPointerEnter={enter} onPointerLeave={() => setHover(null)}>
                  <circle cx={dot.x} cy={dot.y} r={dotRadius(count)} />
                  <text x={dot.x} y={dot.y} dy="0.35em">
                    {count > 999 ? `${Math.round(count / 100) / 10}k` : count}
                  </text>
                </g>
              ) : (
                <circle
                  key={n}
                  className={`mg-geo-dot${field.items[dot.items[0]].kind === "Legacy" ? " legacy" : ""}${out ? " out" : ""}`}
                  cx={dot.x}
                  cy={dot.y}
                  r={dotRadius(1)}
                  data-cluster={n}
                  onPointerEnter={enter}
                  onPointerLeave={() => setHover(null)}
                />
              );
            })}
            {shape}
          </svg>
        ) : null}
        {hover !== null && tip !== null ? (
          <div className={`mg-geo-tip${hover.x > width - 260 ? " left" : ""}`} style={{ left: hover.x, top: hover.y }}>
            {tip.map((item, k) => (
              <div key={k} className="mg-geo-tip-item">
                <div>
                  {item.label !== null ? <b>{shorten(item.label, 40)}</b> : null}
                  <span className="panel-dim mono"> {shorten(item.id, 40)}</span>
                </div>
                <div className="mono">{shorten(toShell(item.value), 90)}</div>
              </div>
            ))}
            {hover.items.length > 1 ? (
              <div className="panel-dim">
                {hover.items.length > tip.length ? t("외 {count}개 · ", { count: (hover.items.length - tip.length).toLocaleString() }) : ""}
                {t("눌러서 확대")}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="mg-geo-foot">
        {region === null || filter === null ? (
          <span className="panel-dim">{t("사각형이나 원으로 끌어 영역을 고르면 그 안의 문서로 거릅니다 · 휠·두 번 눌러 확대 · Shift+끌기는 사각형")}</span>
        ) : (
          <>
            <span className="mg-geo-sum">
              {t("표본 문서 {count}개 중 {inside}개가 영역 안", { count: sampleDocs.toLocaleString(), inside: docsInside.toLocaleString() })}
              <span className="panel-dim"> · {regionText}</span>
            </span>
            <code className="mg-geo-filter mono" title={toShell(filter)}>
              {toShell(filter)}
            </code>
            <span className="spacer" />
            <button type="button" className="mg-qbtn" onClick={() => setRegion(null)}>
              {t("영역 지우기")}
            </button>
            <button type="button" className="primary mg-find" onClick={() => onFilter(filter)}>
              <FilterIcon size={10} />
              {t("이 영역으로 거르기")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
