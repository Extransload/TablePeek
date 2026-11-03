//! The server's update installer, done with Tauri's updater: the release's
//! `latest.json` names the bundle for this platform, whose signature is
//! checked against the public key in tauri.conf.json before it replaces the
//! app.

use std::time::Duration;

use tablepeek_server::update::{InstallError, InstallStep, Installer};
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

/// How long the app waits after installing before it restarts, so the
/// page hears that the install went through.
const RESTART_DELAY: Duration = Duration::from_millis(500);

pub struct UpdaterInstaller {
    app: AppHandle,
}

impl UpdaterInstaller {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

#[async_trait::async_trait]
impl Installer for UpdaterInstaller {
    async fn install(
        &self,
        progress: Box<dyn Fn(InstallStep) + Send + Sync>,
    ) -> Result<String, InstallError> {
        let failed = |err: tauri_plugin_updater::Error| InstallError::Failed(err.to_string());
        let update = self
            .app
            .updater()
            .map_err(failed)?
            .check()
            .await
            .map_err(failed)?
            .ok_or(InstallError::NoUpdate)?;

        let mut downloaded = 0u64;
        // On Windows the installer takes over and the app exits as soon as
        // the download is verified; the page hears the install step only.
        update
            .download_and_install(
                |chunk, total| {
                    downloaded += chunk as u64;
                    progress(InstallStep::Download { downloaded, total });
                },
                || progress(InstallStep::Install),
            )
            .await
            .map_err(failed)?;

        let app = self.app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(RESTART_DELAY).await;
            app.request_restart();
        });
        Ok(format!("v{}", update.version))
    }
}
