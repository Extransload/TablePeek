//! On macOS the page's top bar is the window's title bar: the window keeps
//! its traffic lights but no title or title bar row of its own, and the page
//! (whose bar holds the logo, the connection tabs and the bar's buttons) is
//! drawn up to the window's top edge, the traffic lights over its left end.
//!
//! The page lays its bar out for this when the root element says so: its
//! `data-titlebar` is `overlay` while the traffic lights show, `fullscreen`
//! when they don't (a full-screen window has no traffic lights in its bar),
//! and absent in browser tabs and on Windows, where the title bar stays.
//!
//! Since the page now covers the title bar, the window is moved by the
//! page's bar instead: the areas of it marked `data-tauri-drag-region` start
//! a window drag on press and zoom the window on double click, through
//! Tauri's own drag script. That script calls two of Tauri's window commands
//! over IPC, so this window's pages, which otherwise get no IPC at all, are
//! allowed exactly those two (see [`allow_dragging`]).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tauri::ipc::CapabilityBuilder;
use tauri::webview::PageLoadEvent;
use tauri::{
    AppHandle, LogicalPosition, Manager, Runtime, TitleBarStyle, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

/// Where the traffic lights sit, in points from the window's top left:
/// vertically centred in the page's 46-point bar (see `html[data-titlebar]`
/// in web/src/styles.css). AppKit takes `y` as the height the buttons'
/// title bar view grows by, which puts their centre 2¼ points above it.
const TRAFFIC_LIGHTS: LogicalPosition<f64> = LogicalPosition { x: 16.0, y: 25.0 };

/// Marks the page before its own scripts run, so its first frame already
/// has the bar laid out around the traffic lights.
const MARK_OVERLAY: &str = "document.documentElement.dataset.titlebar = 'overlay';";
const MARK_FULLSCREEN: &str = "document.documentElement.dataset.titlebar = 'fullscreen';";

/// Lets the pages of this run's server (on `port`) move and zoom their
/// window from their bar, and nothing else.
///
/// The page is a remote origin to Tauri (`http://127.0.0.1:<port>`), and
/// a remote origin gets no command unless a capability names it. This one
/// names only this run's server origin (the exact port, not any local
/// server) and grants only `start_dragging` and `internal_toggle_maximize`,
/// the two commands the drag script calls. Neither reads anything, takes
/// arguments that matter, or reaches past the calling window, so the most
/// a page could do with them is move or zoom its own window. Every other
/// command (the opener and updater plugins', the rest of the window and
/// webview commands) stays refused, as does any page of another origin: the
/// windows only ever load this server's pages anyway (see window.rs).
pub fn allow_dragging(app: &AppHandle, port: u16) -> tauri::Result<()> {
    app.add_capability(
        CapabilityBuilder::new("title-bar-drag")
            // The server sends `localhost` pages on to `127.0.0.1`; one
            // may show for a moment before it does.
            .remote(format!("http://127.0.0.1:{port}"))
            .remote(format!("http://localhost:{port}"))
            .local(false)
            .window("*")
            .permission("core:window:allow-start-dragging")
            .permission("core:window:allow-internal-toggle-maximize"),
    )
}

/// A window with the page drawn under its traffic lights.
pub fn overlay<'a, R: Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    builder
        .title_bar_style(TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(TRAFFIC_LIGHTS)
        .initialization_script(MARK_OVERLAY)
        // A page loaded in a full-screen window (a reload, say) is told so.
        .on_page_load(|window, payload| {
            if payload.event() == PageLoadEvent::Finished {
                mark(&window, window.is_fullscreen().unwrap_or(false));
            }
        })
}

/// Tells the window's page when it enters or leaves full screen, which
/// resizes it.
pub fn follow_fullscreen<R: Runtime>(window: &WebviewWindow<R>) {
    let watched = window.clone();
    let fullscreen = Arc::new(AtomicBool::new(false));
    window.on_window_event(move |event| {
        if let WindowEvent::Resized(_) = event {
            let now = watched.is_fullscreen().unwrap_or(false);
            if fullscreen.swap(now, Ordering::Relaxed) != now {
                mark(&watched, now);
            }
        }
    });
}

fn mark<R: Runtime>(window: &WebviewWindow<R>, fullscreen: bool) {
    let script = if fullscreen {
        MARK_FULLSCREEN
    } else {
        MARK_OVERLAY
    };
    if let Err(err) = window.eval(script) {
        eprintln!("창 {} 제목 막대를 바꿀 수 없습니다: {err}", window.label());
    }
}
