// The window material Settings → Appearance picks, as Tern has it:
//
// - solid: everything opaque;
// - glass: translucent, with the system's tint behind it;
// - clear: the desktop blurred without the system's tint.
//
// Only the desktop app's windows can let the desktop itself show through:
// there the page paints its own background at the page opacity, and the app
// puts the system's material (or a plain blur) behind the window, asked for
// through the server (PUT /api/window), since the page can't reach its
// window. A server whose pages live in browser tabs says its windows can't be
// see-through. A background picture covers the window, so under one the
// window stays solid whatever the material. The picked material alone
// decides: the system's "Reduce transparency" isn't followed.
//
// The floating surfaces (Quick Look, dialogs, the command palette, menus,
// pickers, notices) turn to glass under glass or clear and over a background
// picture (background.ts), in every window: the same blur always (the
// window's own blur is the desktop's), at opacities of their own.

import { authToken } from "./token";

export type Material = "solid" | "glass" | "clear";

export const MATERIALS: readonly Material[] = ["solid", "glass", "clear"];
// Points of blur behind a clear window.
export const MATERIAL_BLUR_MAX = 64;
// The floating surfaces' blur of what is under them.
const GLASS_FILTER = "blur(24px) saturate(170%)";
// A floating surface blurs all the page draws, so its picked opacity holds
// as picked, down to none. What it can't blur is the desktop through a
// see-through window: when that is left sharp (clear, with less than
// READABLE_BLUR points), the page and the surface together cover at least
// READABLE_COVER of it, so the text over it reads.
const READABLE_BLUR = 8;
const READABLE_COVER = 0.6;

export interface MaterialPicks {
  material: Material;
  materialBlur: number;
  // How opaque the page's background is over what is behind it, 0–100.
  pageOpacity: number;
  // How opaque the floating surfaces are, 0–100: their own picks, apart
  // from the page's. The notices have theirs; the others share one.
  floatingOpacity: number;
  noticeOpacity: number;
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

// The page's surfaces over a background picture or in a see-through window:
// the theme's colours at the page opacity, for the CSS variables and the
// canvas grid alike.
export function seeThroughColors<C extends Omit<MaterialColors, "mode">>(colors: C, picks: MaterialPicks): C {
  const alpha = picks.pageOpacity / 100;
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
// window keeps the system's appearance, which the page follows. `pictured`:
// a background picture lies behind the app; it covers the window, which
// stays solid, and the floating surfaces turn to glass over it whatever the
// material.
export function applyMaterial(picks: MaterialPicks, colors: MaterialColors, followsSystem: boolean, pictured: boolean): void {
  const root = document.documentElement;
  const material = picks.material;
  root.dataset.material = material;
  const glass = material !== "solid" || pictured;
  root.classList.toggle("floating-glass", glass);
  if (glass) {
    // The least fill that keeps text readable over a desktop left sharp.
    const sharpDesktop = !pictured && seeThrough(picks) && material === "clear" && picks.materialBlur < READABLE_BLUR;
    const page = picks.pageOpacity / 100;
    const least = sharpDesktop && page < READABLE_COVER ? 1 - (1 - READABLE_COVER) / (1 - page) : 0;
    const fill = Math.max(picks.floatingOpacity / 100, least);
    root.style.setProperty("--glass-fill", rgba(colors.panel, fill));
    root.style.setProperty("--glass-fill-notice", rgba(colors.panel, Math.max(picks.noticeOpacity / 100, least)));
    root.style.setProperty("--glass-well", rgba(colors.bg, fill * 0.55));
    root.style.setProperty("--glass-raise", rgba(colors.head, fill * 0.45));
    // For a floating surface inside a glass one: it can't blur what is under
    // it (the outer one's backdrop-filter is its backdrop root), so it is opaque.
    root.style.setProperty("--glass-solid", colors.panel);
    root.style.setProperty("--glass-filter", GLASS_FILTER);
  }
  if (translucentWindow === null && !asked) {
    asked = true;
    void askWindow();
  }
  if (translucentWindow === true) {
    queueWindow(
      JSON.stringify({
        material: pictured ? "solid" : material,
        blur: picks.materialBlur,
        dark: colors.mode === "dark",
        system: followsSystem,
      }),
    );
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
