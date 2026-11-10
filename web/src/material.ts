// The window material Settings → Appearance picks, as Tern has it:
//
// - solid: everything opaque;
// - glass: translucent, with the system's tint behind it;
// - clear: the desktop blurred without the system's tint.
//
// The floating surfaces (Quick Look, dialogs, the command palette, menus,
// pickers, the settings sheet) turn to tinted glass over the app in every
// window, at an opacity of their own (Settings → Appearance). Only the
// desktop app's windows can let the desktop itself show through: there the
// page paints its own background at the picked opacity, and the app puts the
// system's material (or a plain blur) behind the window, asked for through
// the server (PUT /api/window), since the page can't reach its window. A
// server whose pages live in browser tabs says its windows can't be
// see-through. The picked material alone decides: the system's "Reduce
// transparency" isn't followed.

import { authToken } from "./token";

export type Material = "solid" | "glass" | "clear";

export const MATERIALS: readonly Material[] = ["solid", "glass", "clear"];
// Points of blur behind a clear surface or window.
export const MATERIAL_BLUR_MAX = 64;
// Points of blur the glass material puts behind a floating surface.
const GLASS_BLUR = 24;
// The least fill a floating surface's text reads over: with at least
// READABLE_BLUR points of blur behind it, what is under it is a wash, so the
// picked opacity may go as low as MIN_BLURRED_FILL; with less, or none (a
// surface inside another glass one, whose backdrop-filter is its backdrop
// root), what is under it stays sharp: any see-through ghosts it behind the
// text, so the fill is opaque.
const READABLE_BLUR = 8;
const MIN_BLURRED_FILL = 0.6;
const MIN_UNBLURRED_FILL = 1;

export interface MaterialPicks {
  material: Material;
  // How opaque the background is over what shows through, 0–100.
  materialOpacity: number;
  materialBlur: number;
  // How opaque the floating surfaces are, 0–100: their own pick, apart
  // from the window's, so they stay readable over a see-through window.
  floatingOpacity: number;
}

// The colours a translucent surface is tinted with: the theme's own.
export interface MaterialColors {
  mode: "dark" | "light";
  bg: string;
  panel: string;
  head: string;
  rowAlt: string;
}

const ENDPOINT = "/api/window";
// Changes this close together (a slider dragged) reach the window as one.
const WINDOW_DELAY_MS = 60;

// Whether this page's window can be see-through: null until the server says.
let translucentWindow: boolean | null = null;
let asked = false;
const listeners = new Set<() => void>();
// The look last sent (or on its way), and the next one to send.
let sent = "";
let pending: string | null = null;
let timer: number | undefined;
// One request at a time, so the last look picked is the one that lands.
let sending = false;

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

// Called when the server answers whether the window can be see-through.
export function subscribeMaterial(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Whether this window can let the desktop show through (the desktop app):
// null until the server answers.
export function windowTranslucent(): boolean | null {
  return translucentWindow;
}

// Whether the page's own background is translucent: a see-through window.
export function seeThrough(picks: MaterialPicks): boolean {
  return translucentWindow === true && picks.material !== "solid";
}

function rgba(color: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(color.trim());
  if (match === null) {
    return color;
  }
  const value = Number.parseInt(match[1], 16);
  const a = Math.round(Math.min(1, Math.max(0, alpha)) * 1000) / 1000;
  return `rgba(${value >> 16}, ${(value >> 8) & 255}, ${value & 255}, ${a})`;
}

// The page's surfaces in a see-through window: the theme's colours at the
// picked opacity, for the CSS variables and the canvas grid alike.
export function seeThroughColors<C extends Omit<MaterialColors, "mode">>(colors: C, picks: MaterialPicks): C {
  const alpha = picks.materialOpacity / 100;
  return {
    ...colors,
    bg: rgba(colors.bg, alpha),
    panel: rgba(colors.panel, alpha),
    head: rgba(colors.head, alpha),
    rowAlt: rgba(colors.rowAlt, alpha),
  };
}

// Sets the floating surfaces' glass (see styles.css, "Window material") and
// gives the window its material where it can have one. Under System the
// window keeps the system's appearance, which the page follows.
export function applyMaterial(picks: MaterialPicks, colors: MaterialColors, followsSystem: boolean): void {
  const root = document.documentElement;
  const material = picks.material;
  root.dataset.material = material;
  root.classList.toggle("see-through", seeThrough(picks));
  if (material !== "solid") {
    // The floating surfaces take their own opacity, not the window's: over
    // a see-through window the page under them is as clear as the window,
    // so the window's opacity would leave their text over the desktop.
    const picked = picks.floatingOpacity / 100;
    const blur = material === "glass" ? GLASS_BLUR : picks.materialBlur;
    const fill = Math.max(picked, blur >= READABLE_BLUR ? MIN_BLURRED_FILL : MIN_UNBLURRED_FILL);
    root.style.setProperty("--glass-fill", rgba(colors.panel, fill));
    root.style.setProperty("--glass-well", rgba(colors.bg, fill * 0.55));
    root.style.setProperty("--glass-raise", rgba(colors.head, fill * 0.45));
    // For a floating surface inside a glass one: it can't blur what is under it.
    root.style.setProperty("--glass-solid", rgba(colors.panel, Math.max(picked, MIN_UNBLURRED_FILL)));
    root.style.setProperty(
      "--glass-filter",
      material === "glass" ? `blur(${GLASS_BLUR}px) saturate(170%)` : `blur(${blur}px)`,
    );
  }
  if (translucentWindow === null && !asked) {
    asked = true;
    void askWindow();
  }
  if (translucentWindow === true) {
    queueWindow(JSON.stringify({ material, blur: picks.materialBlur, dark: colors.mode === "dark", system: followsSystem }));
  }
}

async function askWindow(): Promise<void> {
  let translucent = false;
  try {
    const response = await fetch(ENDPOINT, { headers: { "x-tablepeek-token": authToken } });
    const body = response.ok ? ((await response.json()) as { translucent?: unknown }) : null;
    translucent = body?.translucent === true;
  } catch {}
  if (translucent === translucentWindow) {
    return;
  }
  translucentWindow = translucent;
  notify();
}

function queueWindow(look: string): void {
  pending = look === sent ? null : look;
  window.clearTimeout(timer);
  if (pending !== null) {
    timer = window.setTimeout(() => void sendWindow(), WINDOW_DELAY_MS);
  }
}

async function sendWindow(): Promise<void> {
  const look = pending;
  // A request still out sends what's pending when it's back.
  if (look === null || sending) {
    return;
  }
  pending = null;
  sent = look;
  sending = true;
  try {
    const response = await fetch(ENDPOINT, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-tablepeek-token": authToken },
      body: look,
    });
    if (!response.ok) {
      sent = "";
    }
  } catch {
    // The window keeps the look it had; the next change asks again.
    sent = "";
  } finally {
    sending = false;
  }
  void sendWindow();
}
