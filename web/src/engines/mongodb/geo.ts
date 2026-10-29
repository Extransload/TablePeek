// Location values in a schema sample, for the 스키마 tab's map (MONGODB.md
// §8.1): GeoJSON geometries (Point, MultiPoint, LineString,
// MultiLineString, Polygon, MultiPolygon) and legacy `[lng, lat]` pairs,
// found field by field as the schema analysis walks paths (documents inside
// arrays share their array's path). A region drawn on the map becomes a
// `$geoWithin` filter.

import { bsonDoc, isDocument, type BsonDocument, type BsonValue } from "./bson";
import { toShell } from "./format";
import { filterNumber, numeric } from "./schema";

export type GeoKind = "Point" | "Legacy" | "MultiPoint" | "LineString" | "MultiLineString" | "Polygon" | "MultiPolygon";

// [lng, lat] in degrees.
export type LngLat = [number, number];

export interface GeoItem {
  // Index of the sample document holding the value.
  doc: number;
  kind: GeoKind;
  // The document's `_id` and a name-like text field, for hovering.
  id: string;
  label: string | null;
  value: BsonValue;
  // Where to draw a dot: a Point or pair, each point of a MultiPoint.
  points: LngLat[];
  // Outlines to draw: line strings and polygon rings.
  lines: LngLat[][];
}

export interface GeoField {
  path: string;
  items: GeoItem[];
  kinds: Partial<Record<GeoKind, number>>;
  // Every value is a point (GeoJSON Point or a pair), so a drawn rectangle
  // can be `$box`; lines and polygons need a `$geometry` polygon.
  pointsOnly: boolean;
}

// Field names that suggest `[x, y]` arrays are coordinates even when every
// value is a whole number.
const GEO_NAME = /loc|geo|coord|gps|pos|point|lnglat|lonlat|latlng|cent(?:er|re)|place/i;

function lngLat(v: BsonValue): LngLat | null {
  if (!Array.isArray(v) || v.length < 2) {
    return null;
  }
  const lng = numeric(v[0]);
  const lat = numeric(v[1]);
  if (lng === null || lat === null || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
    return null;
  }
  return [lng, lat];
}

// A list of positions, or null when any is not one.
function lngLats(v: BsonValue): LngLat[] | null {
  if (!Array.isArray(v)) {
    return null;
  }
  const out: LngLat[] = [];
  for (const p of v) {
    const ll = lngLat(p);
    if (ll === null) {
      return null;
    }
    out.push(ll);
  }
  return out;
}

function listOf<T>(v: BsonValue, each: (x: BsonValue) => T | null): T[] | null {
  if (!Array.isArray(v)) {
    return null;
  }
  const out: T[] = [];
  for (const x of v) {
    const r = each(x);
    if (r === null) {
      return null;
    }
    out.push(r);
  }
  return out;
}

// The points and outlines of a GeoJSON geometry document, or null when the
// document is not one.
function geoJson(v: BsonDocument): { kind: GeoKind; points: LngLat[]; lines: LngLat[][] } | null {
  const type = v.get("type");
  const c = v.get("coordinates");
  if (typeof type !== "string" || c === undefined) {
    return null;
  }
  switch (type) {
    case "Point": {
      const p = lngLat(c);
      return p && { kind: "Point", points: [p], lines: [] };
    }
    case "MultiPoint": {
      const ps = lngLats(c);
      return ps && { kind: "MultiPoint", points: ps, lines: [] };
    }
    case "LineString": {
      const ps = lngLats(c);
      return ps && { kind: "LineString", points: [], lines: [ps] };
    }
    case "MultiLineString":
    case "Polygon": {
      const ls = listOf(c, lngLats);
      return ls && { kind: type, points: [], lines: ls };
    }
    case "MultiPolygon": {
      const polys = listOf(c, (p) => listOf(p, lngLats));
      return polys && { kind: "MultiPolygon", points: [], lines: polys.flat() };
    }
  }
  return null;
}

// A text field that names the document (`name`, `title`, … or the first
// top-level string), for the hover card.
function labelOf(doc: BsonDocument): string | null {
  for (const key of ["name", "title", "label", "city", "place"]) {
    const v = doc.get(key);
    if (typeof v === "string" && v !== "") {
      return v;
    }
  }
  for (const [key, v] of doc) {
    if (key !== "_id" && typeof v === "string" && v !== "") {
      return v;
    }
  }
  return null;
}

interface PairAcc {
  arrays: number;
  pairs: { doc: number; value: BsonValue; at: LngLat }[];
  fractional: boolean;
}

// Fields of the sample holding locations. GeoJSON geometries count at any
// share; `[lng, lat]` pairs only when at least 90% of the arrays at the path
// are pairs in range and either a coordinate has a fraction or the field
// name suggests a location, so `[1, 2]`-like arrays do not turn into maps.
export function findGeoFields(docs: BsonDocument[]): Map<string, GeoField> {
  const geo = new Map<string, Omit<GeoItem, "id" | "label">[]>();
  const pairs = new Map<string, PairAcc>();
  const add = (path: string, item: Omit<GeoItem, "id" | "label">) => {
    let list = geo.get(path);
    if (list === undefined) {
      list = [];
      geo.set(path, list);
    }
    list.push(item);
  };
  // A document value: a geometry, or a document whose fields are walked.
  const visitDoc = (v: BsonDocument, path: string, docIndex: number) => {
    const g = geoJson(v);
    if (g !== null) {
      add(path, { doc: docIndex, value: v, ...g });
    } else {
      visit(v, path, docIndex);
    }
  };
  const visit = (obj: BsonDocument, prefix: string | null, docIndex: number) => {
    for (const [key, v] of obj) {
      const path = prefix === null ? key : `${prefix}.${key}`;
      if (isDocument(v)) {
        visitDoc(v, path, docIndex);
      } else if (Array.isArray(v)) {
        let acc = pairs.get(path);
        if (acc === undefined) {
          acc = { arrays: 0, pairs: [], fractional: false };
          pairs.set(path, acc);
        }
        acc.arrays++;
        const at = v.length === 2 ? lngLat(v) : null;
        if (at !== null) {
          acc.pairs.push({ doc: docIndex, value: v, at });
          acc.fractional ||= !Number.isInteger(at[0]) || !Number.isInteger(at[1]);
        }
        for (const el of v) {
          if (isDocument(el)) {
            visitDoc(el, path, docIndex);
          }
        }
      }
    }
  };
  docs.forEach((doc, i) => visit(doc, null, i));

  for (const [path, acc] of pairs) {
    const name = path.slice(path.lastIndexOf(".") + 1);
    if (acc.pairs.length > 0 && acc.pairs.length >= acc.arrays * 0.9 && (acc.fractional || GEO_NAME.test(name))) {
      for (const p of acc.pairs) {
        add(path, { doc: p.doc, kind: "Legacy", value: p.value, points: [p.at], lines: [] });
      }
    }
  }

  const out = new Map<string, GeoField>();
  for (const [path, list] of geo) {
    const kinds: Partial<Record<GeoKind, number>> = {};
    for (const item of list) {
      kinds[item.kind] = (kinds[item.kind] ?? 0) + 1;
    }
    const items = list.map((item) => {
      const doc = docs[item.doc];
      const id = doc.get("_id");
      return { ...item, id: id === undefined ? "" : toShell(id), label: labelOf(doc) };
    });
    out.set(path, { path, items, kinds, pointsOnly: list.every((x) => x.kind === "Point" || x.kind === "Legacy") });
  }
  return out;
}

// ---- Regions and $geoWithin ----

export type GeoRegion = { kind: "box"; west: number; south: number; east: number; north: number } | { kind: "circle"; center: LngLat; radius: number };

// Mean Earth radius in kilometres, as `$centerSphere` examples use.
export const EARTH_KM = 6378.1;

const RAD = Math.PI / 180;

// Great-circle distance in radians.
export function angularDistance(a: LngLat, b: LngLat): number {
  const dLat = (b[1] - a[1]) * RAD;
  const dLng = (b[0] - a[0]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// The point `distance` radians from `from` along `bearing` (radians from
// north), longitude unwrapped near `from`'s.
function destination(from: LngLat, distance: number, bearing: number): LngLat {
  const lat1 = from[1] * RAD;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(distance) + Math.cos(lat1) * Math.sin(distance) * Math.cos(bearing));
  const dLng = Math.atan2(Math.sin(bearing) * Math.sin(distance) * Math.cos(lat1), Math.cos(distance) - Math.sin(lat1) * Math.sin(lat2));
  return [from[0] + dLng / RAD, lat2 / RAD];
}

// The outline of a spherical circle on the flat map: longitudes run on
// continuously past ±180, and a circle around a pole closes through it.
export function circleOutline(center: LngLat, radius: number, steps = 96): LngLat[] {
  const ring: LngLat[] = [];
  for (let i = 0; i <= steps; i++) {
    const p = destination(center, radius, (i / steps) * 2 * Math.PI);
    const prev = ring[ring.length - 1];
    if (prev !== undefined) {
      while (p[0] - prev[0] > 180) {
        p[0] -= 360;
      }
      while (p[0] - prev[0] < -180) {
        p[0] += 360;
      }
    }
    ring.push(p);
  }
  const span = ring[ring.length - 1][0] - ring[0][0];
  if (Math.abs(span) > 180) {
    const pole = center[1] >= 0 ? 90 : -90;
    ring.push([ring[ring.length - 1][0], pole], [ring[0][0], pole]);
  }
  return ring;
}

function inRegion(r: GeoRegion, p: LngLat): boolean {
  if (r.kind === "box") {
    return p[0] >= r.west && p[0] <= r.east && p[1] >= r.south && p[1] <= r.north;
  }
  return angularDistance(r.center, p) <= r.radius;
}

// Whether a value lies wholly in the region (what the server will match,
// give or take a polygon's curved edges).
export function itemInRegion(item: GeoItem, r: GeoRegion): boolean {
  return item.points.every((p) => inRegion(r, p)) && item.lines.every((l) => l.every((p) => inRegion(r, p)));
}

// A position with coordinates to four decimals (about 10 m), as filter
// numbers.
function position(p: LngLat): BsonValue {
  return p.map((n) => filterNumber(Math.round(n * 1e4) / 1e4));
}

// Longest edge of a rectangle drawn as a GeoJSON polygon: its edges are
// great-circle arcs, so the east-west sides get a vertex this often to stay
// close to the parallels drawn on the map.
const EDGE_STEP = 5;

// The `$geoWithin` value for a region. A rectangle is `$box` when every value
// is a point (exactly the rectangle drawn: `$box` is flat); otherwise a
// counter-clockwise GeoJSON polygon, with MongoDB's strict-winding CRS when
// it covers more than about a hemisphere. A circle is `$centerSphere`
// (radius in radians), which matches points, lines and polygons alike.
export function geoWithin(r: GeoRegion, pointsOnly: boolean): BsonDocument {
  if (r.kind === "circle") {
    return bsonDoc({ $geoWithin: bsonDoc({ $centerSphere: [position(r.center), filterNumber(Number(r.radius.toPrecision(6)))] }) });
  }
  if (pointsOnly) {
    return bsonDoc({ $geoWithin: bsonDoc({ $box: [position([r.west, r.south]), position([r.east, r.north])] }) });
  }
  const k = Math.max(1, Math.ceil((r.east - r.west) / EDGE_STEP));
  const ring: BsonValue[] = [];
  for (let i = 0; i <= k; i++) {
    ring.push(position([r.west + ((r.east - r.west) * i) / k, r.south]));
  }
  for (let i = 0; i <= k; i++) {
    ring.push(position([r.east - ((r.east - r.west) * i) / k, r.north]));
  }
  ring.push(ring[0]);
  const geometry = bsonDoc({ type: "Polygon", coordinates: [ring] });
  const share = ((r.east - r.west) / 360) * ((Math.sin(r.north * RAD) - Math.sin(r.south * RAD)) / 2);
  if (share > 0.45) {
    geometry.set("crs", bsonDoc({ type: "name", properties: bsonDoc({ name: "urn:x-mongodb:crs:strictwinding:EPSG:4326" }) }));
  }
  return bsonDoc({ $geoWithin: bsonDoc({ $geometry: geometry }) });
}
