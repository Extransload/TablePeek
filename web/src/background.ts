// The picture Settings → Appearance → Background lays behind the app: a
// built-in photograph (BUILTIN_BACKGROUNDS), shipped with the page,
// or one picked from a file. The server keeps a picked one (GET, PUT and
// DELETE /api/background), so every window, the browser's and the desktop
// app's alike, shows the same one; settings hold its stamp, new with each
// picture, so a window whose settings change loads the new one, or a
// built-in one's "builtin:<id>". Either is drawn under the page (styles.css,
// "Background picture"), the theme's own background under it where it
// doesn't reach, and the app's surfaces turn translucent over it at the
// picked opacity (settings.ts).

import dawn from "./assets/backgrounds/dawn.webp";
import dawnThumb from "./assets/backgrounds/dawn-thumb.webp";
import { authToken } from "./token";

// How the picture fills the window: all of it, cropped (cover); all of the
// picture, letterboxed (contain); or repeated at its own size (tile).
export type BackgroundFit = "cover" | "contain" | "tile";
export const BACKGROUND_FITS: readonly BackgroundFit[] = ["cover", "contain", "tile"];
// Points of blur the picture may take.
export const BACKGROUND_BLUR_MAX = 64;
// The pictures the server takes.
export const BACKGROUND_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";

// The built-in photographs, from Unsplash (assets/backgrounds/CREDITS.md).
// `stamp` is what settings hold for one; `label` names it (Korean,
// translated by i18n.ts).
export interface BuiltinBackground {
  stamp: string;
  label: string;
  url: string;
  thumb: string;
}

export const BUILTIN_BACKGROUNDS: readonly BuiltinBackground[] = [
  { stamp: "builtin:dawn", label: "분홍 하늘 설산", url: dawn, thumb: dawnThumb },
];

// The built-in picture a stamp names. One saved by an earlier version that
// no longer ships (0.7.0's drawn "builtin:floor") becomes the first.
export function builtinBackground(stamp: string): BuiltinBackground | null {
  if (!stamp.startsWith("builtin:")) {
    return null;
  }
  return BUILTIN_BACKGROUNDS.find((picture) => picture.stamp === stamp) ?? BUILTIN_BACKGROUNDS[0];
}

export interface BackgroundPicks {
  backgroundImage: string;
  backgroundFit: BackgroundFit;
  backgroundBlur: number;
}

const ENDPOINT = "/api/background";

// The stamp shown or on its way, and the object URL a picked picture is
// shown from.
let shownStamp = "";
let objectUrl: string | null = null;

export function applyBackground(picks: BackgroundPicks): void {
  const root = document.documentElement;
  const stamp = picks.backgroundImage;
  const builtin = builtinBackground(stamp);
  // A built-in picture covers the window, whatever the fit.
  const fit = builtin !== null ? "cover" : picks.backgroundFit;
  root.classList.toggle("has-backdrop", stamp !== "");
  root.style.setProperty("--backdrop-size", fit === "tile" ? "auto" : fit);
  root.style.setProperty("--backdrop-repeat", fit === "tile" ? "repeat" : "no-repeat");
  root.style.setProperty("--backdrop-blur", `${picks.backgroundBlur}px`);
  if (stamp === shownStamp) {
    return;
  }
  shownStamp = stamp;
  if (stamp === "") {
    show(null);
  } else if (builtin !== null) {
    show(builtin.url);
  } else {
    void load(stamp);
  }
}

async function load(stamp: string): Promise<void> {
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
  if (stamp !== shownStamp) {
    if (url !== null) {
      URL.revokeObjectURL(url);
    }
    return;
  }
  show(url);
}

// Shows `url` (an object URL of a picked picture, a built-in one's, or
// none), letting go of the picked picture shown before.
function show(url: string | null): void {
  if (objectUrl !== null) {
    URL.revokeObjectURL(objectUrl);
  }
  objectUrl = url !== null && url.startsWith("blob:") ? url : null;
  document.documentElement.style.setProperty("--backdrop-image", url === null ? "none" : `url("${url}")`);
}
