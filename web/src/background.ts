// The picture Settings → Appearance → Background lays behind the app. The
// server keeps it (GET, PUT and DELETE /api/background), so every window,
// the browser's and the desktop app's alike, shows the same one; settings
// hold its stamp, new with each picture, so a window whose settings change
// loads the new one. It is drawn under the page (styles.css, "Background
// picture"), the theme's own background under it where it doesn't reach, and
// the app's surfaces turn translucent over it at the picked opacity
// (settings.ts).

import { authToken } from "./token";

// How the picture fills the window: all of it, cropped (cover); all of the
// picture, letterboxed (contain); or repeated at its own size (tile).
export type BackgroundFit = "cover" | "contain" | "tile";
export const BACKGROUND_FITS: readonly BackgroundFit[] = ["cover", "contain", "tile"];
// Points of blur the picture may take.
export const BACKGROUND_BLUR_MAX = 64;
// The pictures the server takes.
export const BACKGROUND_ACCEPT = "image/png,image/jpeg,image/gif,image/webp";

export interface BackgroundPicks {
  backgroundImage: string;
  backgroundFit: BackgroundFit;
  backgroundBlur: number;
}

const ENDPOINT = "/api/background";

// The stamp whose picture is shown (or on its way), and the object URL it
// is shown from.
let shownStamp = "";
let objectUrl: string | null = null;

export function applyBackground(picks: BackgroundPicks): void {
  const root = document.documentElement;
  const stamp = picks.backgroundImage;
  const tile = picks.backgroundFit === "tile";
  root.classList.toggle("has-backdrop", stamp !== "");
  root.style.setProperty("--backdrop-size", tile ? "auto" : picks.backgroundFit);
  root.style.setProperty("--backdrop-repeat", tile ? "repeat" : "no-repeat");
  root.style.setProperty("--backdrop-blur", `${picks.backgroundBlur}px`);
  if (stamp === shownStamp) {
    return;
  }
  shownStamp = stamp;
  if (stamp === "") {
    show(null);
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
  // A newer picture (or none) was picked meanwhile.
  if (stamp !== shownStamp) {
    if (url !== null) {
      URL.revokeObjectURL(url);
    }
    return;
  }
  show(url);
}

function show(url: string | null): void {
  if (objectUrl !== null) {
    URL.revokeObjectURL(objectUrl);
  }
  objectUrl = url;
  document.documentElement.style.setProperty("--backdrop-image", url === null ? "none" : `url("${url}")`);
}
