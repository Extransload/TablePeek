// The picture Settings → Appearance → Background lays behind the app: a
// built-in photograph (BUILTIN_BACKGROUNDS), shipped with the page, or one
// of the pictures added from files. The server keeps those
// (/api/backgrounds), so every window, the browser's and the desktop app's
// alike, offers the same ones; settings hold the stamp of the one shown,
// "builtin:<id>" or "picture:<id>". Either is drawn under the page
// (styles.css, "Background picture"), the theme's own background under it
// where it doesn't reach, and the app's surfaces turn translucent over it at
// the page opacity (settings.ts).

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

// An added picture's stamp in the settings.
const PICTURE = "picture:";

export function pictureStamp(id: string): string {
  return PICTURE + id;
}

// The added picture a stamp names, by id. A stamp saved before 0.7.4, when
// there was one picture under a random stamp, names that one, which the
// server has kept under "legacy".
export function pictureId(stamp: string): string | null {
  if (stamp === "" || stamp.startsWith("builtin:")) {
    return null;
  }
  return stamp.startsWith(PICTURE) ? stamp.slice(PICTURE.length) : "legacy";
}

// The added pictures' object URLs, by id: an id's bytes never change, so
// each is fetched once, for the backdrop and its tile in Settings alike.
const pictureUrls = new Map<string, Promise<string | null>>();

export function pictureUrl(id: string): Promise<string | null> {
  let url = pictureUrls.get(id);
  if (url === undefined) {
    url = fetchPicture(id);
    pictureUrls.set(id, url);
  }
  return url;
}

async function fetchPicture(id: string): Promise<string | null> {
  try {
    const response = await fetch(`/api/backgrounds/${encodeURIComponent(id)}`, {
      headers: { "x-tablepeek-token": authToken },
    });
    if (response.ok) {
      return URL.createObjectURL(await response.blob());
    }
  } catch {
    // Asked again next time.
  }
  pictureUrls.delete(id);
  return null;
}

// A picture removed: its object URL goes too.
export function forgetPicture(id: string): void {
  const url = pictureUrls.get(id);
  pictureUrls.delete(id);
  void url?.then((value) => value !== null && URL.revokeObjectURL(value));
}

// The stamp shown or on its way.
let shownStamp = "";

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
  const id = pictureId(stamp);
  if (builtin !== null) {
    show(builtin.url);
  } else if (id !== null) {
    void pictureUrl(id).then((url) => {
      // Unless another picture (or none) was picked meanwhile.
      if (stamp === shownStamp) {
        show(url);
      }
    });
  } else {
    show(null);
  }
}

function show(url: string | null): void {
  document.documentElement.style.setProperty("--backdrop-image", url === null ? "none" : `url("${url}")`);
}
