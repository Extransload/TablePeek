//! TablePeek's desktop app for macOS and Windows: the server `tablepeek serve`
//! runs, started inside the app, with its pages in the app's own windows
//! instead of a browser tab. It keeps the same settings folder
//! (`~/.tablepeek`) as the command line, and updates itself from GitHub's
//! latest release.

// A release build on Windows opens no console window next to the app's.
#![cfg_attr(
    all(target_os = "windows", not(debug_assertions)),
    windows_subsystem = "windows"
)]

#[cfg(any(target_os = "macos", target_os = "windows"))]
mod app;
#[cfg(any(target_os = "macos", target_os = "windows"))]
mod installer;
#[cfg(any(target_os = "macos", target_os = "windows"))]
mod material;
#[cfg(target_os = "macos")]
mod menu;
#[cfg(target_os = "macos")]
mod titlebar;
#[cfg(any(target_os = "macos", target_os = "windows"))]
mod window;

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn main() {
    app::run();
}

// The workspace builds everywhere; elsewhere TablePeek runs in a browser.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn main() {
    eprintln!(
        "TablePeek 데스크톱 앱은 macOS와 Windows용입니다. 이 시스템에서는 `tablepeek serve`로 실행하세요."
    );
    std::process::exit(1);
}
