//! Starting the app: the embedded server on Tauri's async runtime (a free
//! port, a fresh token, the settings folder the command line uses), then the
//! first window on its launch address. Quitting the app ends the server with
//! it.

use std::sync::Arc;

use tablepeek_server::launch::{LaunchOptions, Server, DEFAULT_DEMO_ROWS};
use tauri::{Manager, Url};

use crate::installer::UpdaterInstaller;
use crate::material::WindowEffects;
use crate::window;

pub fn run() {
    let builder = tauri::Builder::default()
        // Links are opened from Rust only (see window.rs); the page gets no
        // script that sends them through the plugin.
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build());
    #[cfg(target_os = "macos")]
    let builder = builder
        .menu(crate::menu::build)
        .on_menu_event(crate::menu::handle);
    builder
        .setup(|app| {
            let installer = Arc::new(UpdaterInstaller::new(app.handle().clone()));
            // Kept as the app's state too: windows opened later take the look.
            let window_material = Arc::new(WindowEffects::new(app.handle().clone()));
            app.manage(window_material.clone());
            let server = tauri::async_runtime::block_on(Server::bind(LaunchOptions {
                port: 0,
                main: None,
                demo_rows: DEFAULT_DEMO_ROWS,
                installer: Some(installer),
                window_material: Some(window_material),
            }))?;
            let port = server.port();
            let url = Url::parse(&server.launch_url())?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = server.run().await {
                    eprintln!("TablePeek 서버가 멈췄습니다: {err}");
                    handle.exit(1);
                }
            });
            window::open(app.handle(), port, url)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("TablePeek을 시작할 수 없습니다");
}
