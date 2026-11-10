//! Starting the server the way `tablepeek serve` and the desktop app both do:
//! a listener on loopback, a fresh token for the run, the store and update
//! check of the settings folder (`~/.tablepeek`), and the connection to open
//! from the start, if any.

use std::sync::Arc;

use tablepeek_engine::Engine;

use crate::{ai, serve, store, update, window_material, AppState, ConnSlot, Registry};

/// Rows the demo database gets unless `--demo-rows` says otherwise.
pub const DEFAULT_DEMO_ROWS: usize = 10_000;

pub struct LaunchOptions {
    /// The port to listen on; 0 takes a free one.
    pub port: u16,
    /// A connection open from the start (`--db`, `--demo`): its label and
    /// engine. Pages fall back to it as `main`.
    pub main: Option<(String, Engine)>,
    /// Rows the demo database gets when a page opens one.
    pub demo_rows: usize,
    /// How this build updates itself, when it can.
    pub installer: Option<Arc<dyn update::Installer>>,
    /// How this build gives its windows the material the page picks, when
    /// its pages have windows of their own (the desktop app).
    pub window_material: Option<Arc<dyn window_material::WindowMaterial>>,
}

/// A server bound to its port and ready to run.
pub struct Server {
    listener: tokio::net::TcpListener,
    state: AppState,
    port: u16,
}

impl Server {
    /// Binds `127.0.0.1:<port>` and builds the app's state. Pages are
    /// answered at that address and at `localhost` on the same port.
    pub async fn bind(options: LaunchOptions) -> std::io::Result<Self> {
        let token = format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        );

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", options.port)).await?;
        let port = listener.local_addr()?.port();
        let allowed_hosts = Arc::new(vec![
            format!("127.0.0.1:{port}"),
            format!("localhost:{port}"),
        ]);

        let mut registry = Registry::new();
        if let Some((label, engine)) = options.main {
            registry.insert(Arc::new(ConnSlot::new(
                "main".into(),
                label,
                None,
                None,
                engine,
            )));
        }

        let dir = store::default_dir();
        let mut update = update::UpdateChecker::from_env(&dir);
        if let Some(installer) = options.installer {
            update = update.with_installer(installer);
        }
        let state = AppState {
            registry: Arc::new(tokio::sync::Mutex::new(registry)),
            default_conn: "main".into(),
            token: token.into(),
            demo_rows: options.demo_rows,
            allowed_hosts,
            store: Arc::new(tokio::sync::Mutex::new(store::StoreFile::load(&dir))),
            update: Arc::new(update),
            ui_writers: Arc::default(),
            window_material: options.window_material,
            ai: Arc::new(ai::AiSettings::load(&dir)),
        };
        Ok(Self {
            listener,
            state,
            port,
        })
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// The token every API request of this run carries.
    pub fn token(&self) -> &str {
        &self.state.token
    }

    /// `http://127.0.0.1:<port>`: where the pages live.
    pub fn origin(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    /// The address a page is opened at: the origin with the token, which the
    /// page keeps and takes out of the address bar.
    pub fn launch_url(&self) -> String {
        format!("{}/?token={}", self.origin(), self.state.token)
    }

    /// Answers requests until the listener fails or the future is dropped.
    /// A build that updates itself also looks for a release every hour.
    pub async fn run(self) -> std::io::Result<()> {
        let _watch = AbortOnDrop(tokio::spawn(self.state.update.clone().watch()));
        serve(self.listener, self.state).await
    }
}

/// Ends a task when its handle goes out of scope.
struct AbortOnDrop(tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}
