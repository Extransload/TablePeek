// Closes this window of the desktop app: the app refuses the page's way to
// this address and closes the window instead, quitting with the last one
// (crates/tablepeek-desktop/src/window.rs). Only for the desktop app; a
// browser tab would just load the address.
export function closeAppWindow(): void {
  window.location.assign("/close-window");
}
