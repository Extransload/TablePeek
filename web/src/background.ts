// The picture Settings → Appearance → Background lays behind the app. The
// server keeps a picked one (GET, PUT and DELETE /api/background), so every
// window, the browser's and the desktop app's alike, shows the same one;
// settings hold its stamp, new with each picture, so a window whose settings
// change loads the new one. The built-in one (BUILTIN_BACKGROUND) is drawn
// here instead, in the theme's own colours, and follows the theme. Either is
// drawn under the page (styles.css, "Background picture"), the theme's own
// background under it where it doesn't reach, and the app's surfaces turn
// translucent over it at the picked opacity (settings.ts).

import { luminance, mixHex } from "./color";
import type { Palette, ValueKind } from "./palette";
import { authToken } from "./token";

// How the picture fills the window: all of it, cropped (cover); all of the
// picture, letterboxed (contain); or repeated at its own size (tile).
export type BackgroundFit = "cover" | "contain" | "tile";
export const BACKGROUND_FITS: readonly BackgroundFit[] = ["cover", "contain", "tile"];
// Points of blur the picture may take.
export const BACKGROUND_BLUR_MAX = 64;
// The pictures the server takes.
export const BACKGROUND_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";
// The settings' stamp for the built-in picture.
export const BUILTIN_BACKGROUND = "builtin:floor";

export interface BackgroundPicks {
  backgroundImage: string;
  backgroundFit: BackgroundFit;
  backgroundBlur: number;
}

const ENDPOINT = "/api/background";

// What is shown (the stamp, with the theme's colours for the built-in
// picture) or on its way, and the object URL a picked picture is shown from.
let shownKey = "";
let objectUrl: string | null = null;

// `colors`: the theme's opaque colours, which the built-in picture is drawn in.
export function applyBackground(picks: BackgroundPicks, colors: Palette): void {
  const root = document.documentElement;
  const stamp = picks.backgroundImage;
  const builtin = stamp === BUILTIN_BACKGROUND;
  // The built-in picture covers the window, whatever the fit.
  const fit = builtin ? "cover" : picks.backgroundFit;
  root.classList.toggle("has-backdrop", stamp !== "");
  root.style.setProperty("--backdrop-size", fit === "tile" ? "auto" : fit);
  root.style.setProperty("--backdrop-repeat", fit === "tile" ? "repeat" : "no-repeat");
  root.style.setProperty("--backdrop-blur", `${picks.backgroundBlur}px`);
  // The built-in picture is drawn again for another theme.
  const key = builtin
    ? [stamp, colors.bg, colors.line, colors.ink, colors.accent, ...Object.values(colors.typeInks)].join(":")
    : stamp;
  if (key === shownKey) {
    return;
  }
  shownKey = key;
  if (stamp === "") {
    show(null);
  } else if (builtin) {
    show(`data:image/svg+xml,${encodeURIComponent(floorPicture(colors))}`);
  } else {
    void load(key);
  }
}

async function load(key: string): Promise<void> {
  let url: string | null = null;
  try {
    const response = await fetch(ENDPOINT, { headers: { "x-tablepeek-token": authToken }, cache: "no-store" });
    if (response.ok) {
      url = URL.createObjectURL(await response.blob());
    }
  } catch {
    // The theme's background stays; the next picture picked asks again.
  }
  // Another picture (or none) was picked meanwhile.
  if (key !== shownKey) {
    if (url !== null) {
      URL.revokeObjectURL(url);
    }
    return;
  }
  show(url);
}

// Shows `url` (an object URL of a picked picture, a data URL of the built-in
// one, or none), letting go of the picked picture shown before.
function show(url: string | null): void {
  if (objectUrl !== null) {
    URL.revokeObjectURL(objectUrl);
  }
  objectUrl = url !== null && url.startsWith("blob:") ? url : null;
  document.documentElement.style.setProperty("--backdrop-image", url === null ? "none" : `url("${url}")`);
}

// ── The built-in picture: the home screen's table floor (HomeBackdrop.tsx),
// held still, under a night sky. A table laid out as a floor running to a
// horizon below the middle, its grid fading into a haze in the distance; a
// few cells lit in the theme's value colours, one row in its accent, the
// accent's glow along the horizon and faint stars above, over the theme's
// background. Drawn as SVG, so it is sharp at any size and light. ──

const WIDTH = 1600;
const HEIGHT = 1000;
// The horizon's height, as a fraction of the picture's.
const HORIZON = 0.56;
// World units, as the home's floor has them: the camera stands 1 above the
// floor; a cell is CELL_W wide and CELL_D deep; rows run from Z_NEAR (the
// picture's bottom edge) to Z_FAR.
const CELL_W = 0.36;
const CELL_D = 0.16;
const Z_NEAR = 0.7;
const Z_FAR = 9;
// Columns either side of the middle: past the edges of the widest window.
const HALF = 14;
const LIT_KINDS: ValueKind[] = ["string", "integer", "date", "boolean", "float", "json", "uuid", "enum"];

function hash(a: number, b: number): number {
  let h = Math.imul(a, 374761393) + Math.imul(b, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function floorPicture(colors: Palette): string {
  const hy = HEIGHT * HORIZON;
  // Screen units per world unit at depth 1: the nearest row meets the bottom edge.
  const focal = (HEIGHT - hy) * Z_NEAR;
  const cx = WIDTH / 2;
  const at = (x: number, z: number): string => `${(cx + (focal * x) / z).toFixed(1)},${(hy + focal / z).toFixed(1)}`;
  const n = (value: number): string => value.toFixed(3);
  const rows = Math.ceil((Z_FAR - Z_NEAR) / CELL_D);
  // How near a depth is, 1 at the bottom edge to 0 at the far end.
  const nearness = (z: number): number => 1 - (z - Z_NEAR) / (Z_FAR - Z_NEAR);
  const sky = mixHex(colors.bg, colors.accent, 0.12);
  const ground = mixHex(colors.bg, colors.line, 0.3);
  const grid = mixHex(colors.line, colors.accent, 0.35);

  const stars: string[] = [];
  const cells: string[] = [];
  const lines: string[] = [];
  // Stars, brighter higher up, thinning out toward the glow; a light theme's
  // daytime sky has none.
  const starCount = luminance(colors.bg) < 0.2 ? 160 : 0;
  for (let star = 0; star < starCount; star += 1) {
    const x = hash(star, 11) * WIDTH;
    const y = hash(star, 23) ** 1.4 * hy * 0.92;
    const r = 0.6 + hash(star, 37) * 1.1;
    const alpha = (0.1 + 0.4 * hash(star, 41)) * (1 - y / hy);
    stars.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(2)}" fill-opacity="${n(alpha)}"/>`);
  }
  // The lit cells, nearer ones brighter; one row of the accent, as the
  // home's floor selects a row now and then.
  const selected = 6;
  for (let row = 0; row < rows; row += 1) {
    const z0 = Z_NEAR + row * CELL_D;
    const z1 = z0 + CELL_D;
    const near = nearness(z0);
    for (let col = -HALF; col < HALF; col += 1) {
      const x0 = col * CELL_W;
      const x1 = x0 + CELL_W;
      let fill: string | null = null;
      let alpha = 0;
      if (row === selected && Math.abs(col) < 7) {
        fill = colors.accent;
        alpha = 0.22 * near;
      } else if (hash(row, col + 101) < 0.1) {
        fill = colors.typeInks[LIT_KINDS[Math.floor(hash(col + 101, 7) * LIT_KINDS.length)]];
        alpha = (0.12 + 0.35 * hash(col, row)) * near ** 1.5;
      }
      if (fill !== null && alpha > 0.01) {
        cells.push(`<polygon points="${at(x0, z0)} ${at(x1, z0)} ${at(x1, z1)} ${at(x0, z1)}" fill="${fill}" fill-opacity="${n(alpha)}"/>`);
      }
    }
  }
  // The grid: lines across the rows, fading with depth, and lines along the
  // columns, running to the horizon.
  for (let row = 0; row <= rows; row += 1) {
    const z = Z_NEAR + row * CELL_D;
    lines.push(
      `<line x1="0" x2="${WIDTH}" y1="${(hy + focal / z).toFixed(1)}" y2="${(hy + focal / z).toFixed(1)}" stroke-opacity="${n(0.6 * nearness(z) ** 1.3)}"/>`,
    );
  }
  for (let col = -HALF; col <= HALF; col += 1) {
    const x = col * CELL_W;
    const xNear = (cx + (focal * x) / Z_NEAR).toFixed(1);
    const xFar = (cx + (focal * x) / Z_FAR).toFixed(1);
    lines.push(`<line x1="${xNear}" y1="${HEIGHT}" x2="${xFar}" y2="${(hy + focal / Z_FAR).toFixed(1)}"/>`);
  }

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" preserveAspectRatio="xMidYMid slice">`,
    "<defs>",
    `<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${colors.bg}"/><stop offset="${HORIZON}" stop-color="${sky}"/><stop offset="1" stop-color="${ground}"/></linearGradient>`,
    `<radialGradient id="glow" cx="0.5" cy="${HORIZON}" r="0.55" gradientTransform="translate(0.5 ${HORIZON}) scale(1 0.4) translate(-0.5 -${HORIZON})"><stop offset="0" stop-color="${colors.accent}" stop-opacity="0.4"/><stop offset="1" stop-color="${colors.accent}" stop-opacity="0"/></radialGradient>`,
    // The far rows sink into a haze of the sky's colour, over the floor's top.
    `<linearGradient id="haze" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky}" stop-opacity="1"/><stop offset="0.2" stop-color="${sky}" stop-opacity="0"/></linearGradient>`,
    "</defs>",
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#sky)"/>`,
    `<g fill="${colors.ink}">${stars.join("")}</g>`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="url(#glow)"/>`,
    `<g>${cells.join("")}</g>`,
    `<g stroke="${grid}" stroke-width="1.2" stroke-opacity="0.3">${lines.join("")}</g>`,
    `<rect y="${hy}" width="${WIDTH}" height="${HEIGHT - hy}" fill="url(#haze)"/>`,
    `<line x1="0" x2="${WIDTH}" y1="${hy}" y2="${hy}" stroke="${colors.accent}" stroke-opacity="0.45" stroke-width="1.5"/>`,
    "</svg>",
  ].join("");
}
