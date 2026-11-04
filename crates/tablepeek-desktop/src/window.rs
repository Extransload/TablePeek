//! The app's windows: each shows a page of the embedded server and keeps the
//! page inside the app the way a browser tab would keep it on its site.
//!
//! - Navigating away from the server (a link without a target) opens the
//!   address in the system browser instead and leaves the page as it is.
//! - `window.open` of a server page (a connection in a new window) opens
//!   another app window; anything else (an OIDC login, release notes) goes
//!   to the system browser.
//! - Downloads (exports, GridFS files) are saved to the Downloads folder
//!   under the name the page gave, numbered when that name is taken.
//! - Files dropped on a window reach the page, which takes them as a browser
//!   would (imports, cell values, uploads).
//! - Windows are transparent, so the page decides how much of the desktop
//!   shows through (see material.rs); a new one takes the others' material.
//! - On macOS the page's bar is the title bar (see titlebar.rs).
//! - The page is told it runs in the app (`data-app="desktop"` on its root,
//!   set before its scripts run), so its keys can differ from a browser
//!   tab's: ⌘R refreshes the view, as in TablePlus, where a browser reloads.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_opener::OpenerExt;

use crate::material::WindowEffects;

/// Marks the page as the app's before any of its scripts run.
const MARK_APP: &str = "document.documentElement.dataset.app = 'desktop';";

/// Numbers the windows after the first ("main"); labels must be unique.
static WINDOWS: AtomicUsize = AtomicUsize::new(0);

/// Opens a window on `url`, a page of the server listening on `port`.
pub fn open(app: &AppHandle, port: u16, url: Url) -> tauri::Result<()> {
    let label = match WINDOWS.fetch_add(1, Ordering::Relaxed) {
        0 => "main".to_string(),
        n => format!("window-{n}"),
    };
    let opener = app.clone();
    let spawner = app.clone();
    let saver = app.clone();
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url))
        .title("TablePeek")
        .inner_size(1440.0, 900.0)
        .min_inner_size(960.0, 600.0)
        .center()
        .transparent(true)
        .disable_drag_drop_handler()
        .initialization_script(MARK_APP)
        .on_navigation(move |url| {
            if is_app_page(url, port) || is_inline(url) {
                return true;
            }
            open_outside(&opener, url);
            false
        })
        .on_new_window(move |url, _features| {
            if is_app_page(&url, port) {
                // Built off this callback: it runs inside the webview's own
                // window request.
                let app = spawner.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(err) = open(&app, port, url) {
                        eprintln!("새 창을 열 수 없습니다: {err}");
                    }
                });
            } else {
                open_outside(&spawner, &url);
            }
            NewWindowResponse::Deny
        })
        .on_download(move |_webview, event| {
            match event {
                DownloadEvent::Requested { destination, .. } => {
                    let Some(name) = destination.file_name().map(PathBuf::from) else {
                        return false;
                    };
                    let Ok(dir) = saver.path().download_dir() else {
                        return false;
                    };
                    *destination = unique_path(&dir, &name);
                }
                DownloadEvent::Finished { url, success, .. } if !success => {
                    eprintln!("내려받기에 실패했습니다: {url}");
                }
                _ => {}
            }
            true
        });
    #[cfg(target_os = "macos")]
    let builder = crate::titlebar::overlay(builder);
    let window = builder.build()?;
    #[cfg(target_os = "macos")]
    crate::titlebar::follow_fullscreen(&window);
    if let Some(material) = app.try_state::<Arc<WindowEffects>>() {
        material.apply_current(&window);
    }
    Ok(())
}

/// A page of this run's server. The server sends `localhost` pages on to
/// `127.0.0.1` itself.
fn is_app_page(url: &Url, port: u16) -> bool {
    url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
        && url.port() == Some(port)
}

/// Navigations that stay in the page: an empty document, or data the page
/// made itself.
fn is_inline(url: &Url) -> bool {
    matches!(url.scheme(), "about" | "blob" | "data")
}

/// Web and mail addresses go to the system's handler; other schemes (a
/// `file:` link, say) are only refused.
fn open_outside(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto") {
        if let Err(err) = app.opener().open_url(url.as_str(), None::<&str>) {
            eprintln!("브라우저에서 열 수 없습니다: {url}: {err}");
        }
    }
}

/// `name` in `dir`, or `name (1)`, `name (2)`, … before the extension when
/// it is taken, as browsers save downloads.
fn unique_path(dir: &Path, name: &Path) -> PathBuf {
    let path = dir.join(name);
    if !path.exists() {
        return path;
    }
    let stem = name
        .file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default();
    let extension = name
        .extension()
        .map(|extension| format!(".{}", extension.to_string_lossy()))
        .unwrap_or_default();
    (1..)
        .map(|n| dir.join(format!("{stem} ({n}){extension}")))
        .find(|candidate| !candidate.exists())
        .expect("some numbered name is free")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_a_taken_download_name() {
        let dir = std::env::temp_dir().join(format!("tablepeek-desktop-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let name = Path::new("orders.csv");
        assert_eq!(unique_path(&dir, name), dir.join("orders.csv"));
        std::fs::write(dir.join("orders.csv"), "").unwrap();
        assert_eq!(unique_path(&dir, name), dir.join("orders (1).csv"));
        std::fs::write(dir.join("orders (1).csv"), "").unwrap();
        assert_eq!(unique_path(&dir, name), dir.join("orders (2).csv"));
        std::fs::write(dir.join("README"), "").unwrap();
        assert_eq!(
            unique_path(&dir, Path::new("README")),
            dir.join("README (1)")
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn keeps_only_this_servers_pages_inside() {
        let page = |url: &str| is_app_page(&Url::parse(url).unwrap(), 7870);
        assert!(page("http://127.0.0.1:7870/?conn=abc"));
        assert!(page("http://localhost:7870/"));
        assert!(!page("http://127.0.0.1:7871/"));
        assert!(!page("https://127.0.0.1:7870/"));
        assert!(!page("https://github.com/Extransload/TablePeek/releases"));
        assert!(is_inline(
            &Url::parse("blob:http://127.0.0.1:7870/1234").unwrap()
        ));
        assert!(is_inline(&Url::parse("about:blank").unwrap()));
    }
}
