//! The server's update installer, done with Tauri's updater: the release's
//! `latest.json` names the bundle for this platform, whose signature is
//! checked against the public key in tauri.conf.json. The bundle is
//! downloaded and checked in the background and kept in memory; installing
//! it replaces the app, which then restarts.

use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::Duration;

use tablepeek_server::update::{InstallError, Installer, PrepareStep};
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};

/// How long the app waits after installing before it restarts, so the
/// page hears that the install went through.
const RESTART_DELAY: Duration = Duration::from_millis(500);

pub struct UpdaterInstaller {
    app: AppHandle,
    /// The update downloaded and verified, and its bundle.
    ready: Mutex<Option<(Update, Vec<u8>)>>,
}

impl UpdaterInstaller {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            ready: Mutex::new(None),
        }
    }

    fn ready(&self) -> MutexGuard<'_, Option<(Update, Vec<u8>)>> {
        self.ready.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

fn failed(err: tauri_plugin_updater::Error) -> InstallError {
    InstallError::Failed(err.to_string())
}

#[async_trait::async_trait]
impl Installer for UpdaterInstaller {
    async fn prepare(
        &self,
        progress: Box<dyn Fn(PrepareStep) + Send + Sync>,
    ) -> Result<String, InstallError> {
        let update = self
            .app
            .updater()
            .map_err(failed)?
            .check()
            .await
            .map_err(failed)?
            .ok_or(InstallError::NoUpdate)?;
        let version = format!("v{}", update.version);
        let kept = self
            .ready()
            .as_ref()
            .is_some_and(|(ready, _)| ready.version == update.version);
        if kept {
            return Ok(version);
        }

        progress(PrepareStep::Found {
            version: version.clone(),
        });
        let mut downloaded = 0u64;
        // `download` checks the signature before it answers.
        let bytes = update
            .download(
                |chunk, total| {
                    downloaded += chunk as u64;
                    progress(PrepareStep::Download { downloaded, total });
                },
                || {},
            )
            .await
            .map_err(failed)?;
        *self.ready() = Some((update, bytes));
        Ok(version)
    }

    async fn apply(&self) -> Result<String, InstallError> {
        let (update, bytes) = self.ready().take().ok_or(InstallError::NotReady)?;
        // Replacing the app is file work; on Windows the installer takes
        // over and the app exits from here.
        let (update, bytes, installed) = tauri::async_runtime::spawn_blocking(move || {
            let installed = update.install(&bytes);
            (update, bytes, installed)
        })
        .await
        .map_err(|err| InstallError::Failed(err.to_string()))?;
        let version = format!("v{}", update.version);
        if let Err(err) = installed {
            // Kept, so installing can be tried again.
            *self.ready() = Some((update, bytes));
            return Err(failed(err));
        }

        let app = self.app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(RESTART_DELAY).await;
            app.request_restart();
        });
        Ok(version)
    }
}
