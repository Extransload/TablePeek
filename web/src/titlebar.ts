// In the macOS desktop app the page's top bar is the window's title bar: the
// app draws the page under its traffic lights and marks the root element
// (`data-titlebar`, see crates/tablepeek-desktop/src/titlebar.rs) before any
// of the page's scripts run. The bar then makes room for the traffic lights
// (styles.css, "Title bar") and moves the window: its empty areas are Tauri
// drag regions, which start a window drag on press and zoom on double click.
// Its buttons and tabs still click; Tauri's drag script skips them. Browser
// tabs and Windows keep a title bar of their own and get none of this.

// Spread on a bar: the whole of it drags, less what clicks.
export const DRAG_REGION: { "data-tauri-drag-region"?: "deep" } =
  document.documentElement.dataset.titlebar !== undefined ? { "data-tauri-drag-region": "deep" } : {};
