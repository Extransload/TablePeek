use std::path::PathBuf;
use std::process::Command as ProcessCommand;
use std::sync::Arc;

use tablepeek_engine::Engine;
use tablepeek_server::{serve, store::StoreFile, AppState, ConnSlot, Registry};

mod mcp;

const DEFAULT_DEMO_ROWS: usize = 10_000;
const MAX_DEMO_ROWS: usize = 2_000_000;

struct Args {
    db: Option<PathBuf>,
    port: u16,
    demo_rows: usize,
    no_open: bool,
    mcp: bool,
    url: Option<String>,
    token: Option<String>,
    conn: Option<String>,
}

fn usage() -> ! {
    eprintln!(
        "사용법:\n  tablepeek serve [--db <SQLite 파일>] [--port <포트>] [--demo-rows <행 수>] [--no-open]\n  tablepeek mcp [--url <URL>] [--token <토큰>] [--conn <연결 ID>]"
    );
    std::process::exit(2);
}

fn parse_args() -> Args {
    let mut args = Args {
        db: None,
        port: 0,
        demo_rows: DEFAULT_DEMO_ROWS,
        no_open: false,
        mcp: false,
        url: None,
        token: None,
        conn: None,
    };
    let mut it = std::env::args().skip(1);

    match it.next().as_deref() {
        Some("serve") => {}
        Some("mcp") => args.mcp = true,
        _ => usage(),
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
            "--url" => args.url = it.next(),
            "--token" => args.token = it.next(),
            "--conn" => args.conn = it.next(),
            other => {
                eprintln!("알 수 없는 옵션: {other}");
                std::process::exit(2);
            }
        }
    }
    args
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = parse_args();

    if args.mcp {
        let url = args
            .url
            .or_else(|| std::env::var("TABLEPEEK_URL").ok())
            .unwrap_or_else(|| "http://127.0.0.1:7870".to_string());
        let token = args
            .token
            .or_else(|| std::env::var("TABLEPEEK_TOKEN").ok())
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| {
                eprintln!("MCP 토큰이 필요합니다: --token 또는 TABLEPEEK_TOKEN");
                std::process::exit(2);
            });
        let conn = args.conn.or_else(|| std::env::var("TABLEPEEK_CONN").ok());
        return mcp::run(mcp::McpConfig { url, token, conn });
    }

    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(run_server(args))
}

async fn run_server(args: Args) -> Result<(), Box<dyn std::error::Error>> {
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
    let mut registry = Registry::new();
    let main_label = match &args.db {
        Some(path) => path.display().to_string(),
        None => "데모 데이터베이스".to_string(),
    };
    registry.insert(Arc::new(ConnSlot::new(
        "main".into(),
        main_label,
        None,
        None,
        engine,
    )));

    let state = AppState {
        registry: Arc::new(tokio::sync::Mutex::new(registry)),
        default_conn: "main".into(),
        token: token.clone().into(),
        demo_rows: args.demo_rows,
        allowed_hosts,
        store: Arc::new(tokio::sync::Mutex::new(StoreFile::load_home())),
    };

    let url = format!("http://127.0.0.1:{}/?token={}", addr.port(), token);

    println!("tablepeek dev server: {url}");
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
        let _ = ProcessCommand::new("cmd")
            .args(["/C", "start", "", url])
            .spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = ProcessCommand::new("xdg-open").arg(url).spawn();
    }
}
