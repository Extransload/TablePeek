use std::path::PathBuf;
use std::process::Command as ProcessCommand;
use std::sync::Arc;

use prodb_engine::Engine;
use prodb_server::{serve, store::StoreFile, AppState, SessionStore, SESSION_CAP};

const DEFAULT_DEMO_ROWS: usize = 10_000;
const MAX_DEMO_ROWS: usize = 2_000_000;

struct Args {
    db: Option<PathBuf>,
    port: u16,
    demo_rows: usize,
    no_open: bool,
}

fn parse_args() -> Args {
    let mut args = Args {
        db: None,
        port: 0,
        demo_rows: DEFAULT_DEMO_ROWS,
        no_open: false,
    };
    let mut it = std::env::args().skip(1);

    match it.next().as_deref() {
        Some("serve") => {}
        _ => {
            eprintln!(
                "사용법: prodb serve [--db <SQLite 파일>] [--port <포트>] [--demo-rows <행 수>] [--no-open]"
            );
            std::process::exit(2);
        }
    }

    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--db" => args.db = it.next().map(PathBuf::from),
            "--port" => args.port = it.next().and_then(|v| v.parse().ok()).unwrap_or(0),
            "--demo-rows" => {
                args.demo_rows = it
                    .next()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(DEFAULT_DEMO_ROWS)
                    .clamp(1, MAX_DEMO_ROWS);
            }
            "--no-open" => args.no_open = true,
            other => {
                eprintln!("알 수 없는 옵션: {other}");
                std::process::exit(2);
            }
        }
    }
    args
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = parse_args();

    let engine = match &args.db {
        Some(path) => Engine::open_file(path)?,
        None => Engine::open_demo(args.demo_rows)?,
    };

    match &args.db {
        Some(path) => println!("SQLite 연결: {}", path.display()),
        None => println!(
            "데모용 인메모리 SQLite에 demo 테이블({}행)을 만들었습니다.",
            args.demo_rows
        ),
    }

    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", args.port)).await?;
    let addr = listener.local_addr()?;

    let allowed_hosts = Arc::new(vec![
        format!("127.0.0.1:{}", addr.port()),
        format!("localhost:{}", addr.port()),
    ]);
    let state = AppState {
        engine: Arc::new(engine),
        token: token.clone().into(),
        demo_rows: args.demo_rows,
        allowed_hosts,
        sessions: Arc::new(tokio::sync::Mutex::new(SessionStore::new(SESSION_CAP))),
        tunnel: Arc::new(tokio::sync::Mutex::new(None)),
        store: Arc::new(tokio::sync::Mutex::new(StoreFile::load_home())),
        inflight: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
    };

    let url = format!("http://127.0.0.1:{}/?token={}", addr.port(), token);

    println!("prodb dev server: {url}");
    println!("종료: Ctrl+C");

    if !args.no_open {
        open_browser(&url);
    }

    serve(listener, state).await?;
    Ok(())
}

fn open_browser(url: &str) {
    #[cfg(target_os = "macos")]
    {
        let _ = ProcessCommand::new("open").arg(url).spawn();
    }
    #[cfg(target_os = "windows")]
    {
        let _ = ProcessCommand::new("cmd").args(["/C", "start", "", url]).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = ProcessCommand::new("xdg-open").arg(url).spawn();
    }
}
