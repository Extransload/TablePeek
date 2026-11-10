//! The AI provider that is a program on this machine: the Codex CLI, signed
//! in by the user in a terminal. TablePeek runs it as published, one answer
//! per run, read-only, in an empty folder; its sign-in and plan stay its own
//! (nothing of it is read or kept here).

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdout, Command};

use super::usage::{self, Window};
use super::Event;

/// How long a status or model-list command may take.
const QUICK_TIMEOUT: Duration = Duration::from_secs(10);
/// The end of a failed run's stderr the page is told.
const STDERR_LIMIT: usize = 4_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub(crate) enum Cli {
    Codex,
}

impl Cli {
    fn program(self) -> &'static str {
        match self {
            Self::Codex => "codex",
        }
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::Codex => "Codex CLI",
        }
    }

    /// What the user runs in a terminal to sign in.
    pub(crate) fn sign_in_hint(self) -> &'static str {
        match self {
            Self::Codex => "터미널에서 `codex login`을 실행하세요",
        }
    }

    pub(crate) fn install_hint(self) -> &'static str {
        match self {
            Self::Codex => "`npm i -g @openai/codex` 또는 `brew install codex`로 설치하세요",
        }
    }
}

/// Where the program is, whether it answers and is signed in.
#[derive(Debug, Clone, Default, Serialize)]
pub(crate) struct CliStatus {
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub signed_in: bool,
    /// The account signed in, as the page shows it.
    pub email: Option<String>,
    /// How it is signed in ("ChatGPT").
    pub account: Option<String>,
    /// The workspace or organization it is signed in to.
    pub workspace: Option<String>,
}

/// Folders programs are installed in that an app started from the Dock may
/// not have on its PATH.
fn extra_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        for sub in [
            ".local/bin",
            ".npm-global/bin",
            ".bun/bin",
            ".volta/bin",
            ".cargo/bin",
        ] {
            dirs.push(home.join(sub));
        }
    }
    dirs
}

/// The PATH the program runs with: ours, then the install folders (a
/// script's `#!/usr/bin/env node` needs node's).
fn search_path() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| std::env::split_paths(&path).collect())
        .unwrap_or_default();
    for dir in extra_dirs() {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs
}

/// The program, where it is installed.
pub(crate) fn find(cli: Cli) -> Option<PathBuf> {
    search_path()
        .into_iter()
        .map(|dir| dir.join(cli.program()))
        .find(|path| is_executable(path))
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path)
            .map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

fn command(path: &Path) -> Command {
    let mut command = Command::new(path);
    if let Ok(joined) = std::env::join_paths(search_path()) {
        command.env("PATH", joined);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

/// A short command's output when it succeeds: stdout, or stderr when it
/// printed there only (`codex login status` does).
async fn quick(path: &Path, args: &[&str]) -> Option<String> {
    let output = tokio::time::timeout(QUICK_TIMEOUT, command(path).args(args).output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !stdout.is_empty() {
        return Some(stdout);
    }
    Some(String::from_utf8_lossy(&output.stderr).trim().to_string())
}

pub(crate) async fn status(cli: Cli, path: Option<PathBuf>) -> CliStatus {
    let Some(path) = path.filter(|path| is_executable(path)) else {
        return CliStatus::default();
    };
    let mut status = CliStatus {
        installed: true,
        path: Some(path.display().to_string()),
        version: quick(&path, &["--version"]).await,
        ..CliStatus::default()
    };
    match cli {
        // "Logged in using ChatGPT"; signed out exits non-zero. The email and
        // workspace come from its app server (`account/read`).
        Cli::Codex => {
            if let Some(text) = quick(&path, &["login", "status"])
                .await
                .filter(|text| text.starts_with("Logged in"))
            {
                status.signed_in = true;
                status.account = text
                    .split(" using ")
                    .nth(1)
                    .map(|how| how.trim().to_string());
                if let Ok(read) = codex_usage(&path).await {
                    status.email = read.email;
                    status.workspace = read.workspace;
                }
            }
        }
    }
    status
}

/// What the Codex CLI says of its account and usage, without asking a
/// model: its app server's `account/read` and `account/rateLimits/read`.
pub(crate) struct CodexUsage {
    pub email: Option<String>,
    pub plan: Option<String>,
    pub workspace: Option<String>,
    pub windows: Vec<Window>,
    pub credits: Option<Value>,
}

pub(crate) async fn codex_usage(path: &Path) -> Result<CodexUsage, String> {
    let mut child = command(path)
        .arg("app-server")
        .stdin(Stdio::piped())
        .spawn()
        .map_err(|err| format!("Codex CLI를 실행할 수 없습니다: {err}"))?;
    let requests = [
        r#"{"id":1,"method":"initialize","params":{"clientInfo":{"name":"tablepeek","title":"TablePeek","version":"1"}}}"#,
        r#"{"method":"initialized"}"#,
        r#"{"id":2,"method":"account/read","params":{"refreshToken":false}}"#,
        r#"{"id":3,"method":"account/rateLimits/read"}"#,
    ];
    // Kept open until the replies are in: the app server stops once stdin
    // ends.
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Codex CLI에 물을 수 없습니다".to_string())?;
    let lines: String = requests.iter().map(|line| format!("{line}\n")).collect();
    stdin
        .write_all(lines.as_bytes())
        .await
        .map_err(|err| format!("Codex CLI에 묻지 못했습니다: {err}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Codex CLI의 출력을 읽을 수 없습니다".to_string())?;
    let mut lines = BufReader::new(stdout).lines();
    let (mut account, mut limits) = (None, None);
    let read = async {
        while account.is_none() || limits.is_none() {
            let Some(line) = lines.next_line().await.map_err(|err| err.to_string())? else {
                break;
            };
            let Ok(reply) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if let Some(error) = reply.get("error") {
                return Err(error["message"].as_str().unwrap_or("오류").to_string());
            }
            match reply["id"].as_i64() {
                Some(2) => account = Some(reply["result"]["account"].clone()),
                Some(3) => limits = Some(reply["result"]["rateLimits"].clone()),
                _ => {}
            }
        }
        Ok(())
    };
    let outcome = tokio::time::timeout(QUICK_TIMEOUT, read).await;
    drop(stdin);
    let _ = child.kill().await;
    match outcome {
        Err(_) => return Err("Codex CLI가 사용량을 알려 주지 않습니다 (시간 초과)".into()),
        Ok(Err(message)) => return Err(format!("Codex CLI 사용량을 읽지 못했습니다: {message}")),
        Ok(Ok(())) => {}
    }
    let account = account.unwrap_or(Value::Null);
    let limits = limits.unwrap_or(Value::Null);
    let text = |value: &Value| value.as_str().map(str::to_string);
    Ok(CodexUsage {
        email: text(&account["email"]),
        plan: text(&account["planType"]).or_else(|| text(&limits["planType"])),
        workspace: text(&account["workspaceName"]),
        windows: [
            ("primary", &limits["primary"]),
            ("secondary", &limits["secondary"]),
        ]
        .into_iter()
        .filter_map(|(which, window)| usage::codex_window(window, which))
        .collect(),
        credits: Some(limits["credits"].clone()).filter(|credits| credits.is_object()),
    })
}

/// The models the program offers: Codex's catalog as `codex debug models`
/// prints it (those it lists).
pub(crate) async fn models(cli: Cli, path: &Path) -> Result<Vec<(String, String)>, String> {
    match cli {
        Cli::Codex => {
            let text = quick(path, &["debug", "models"])
                .await
                .ok_or_else(|| "`codex debug models`가 실패했습니다".to_string())?;
            let body: Value = serde_json::from_str(&text)
                .map_err(|err| format!("Codex 모델 목록을 읽지 못했습니다: {err}"))?;
            Ok(body["models"]
                .as_array()
                .map(Vec::as_slice)
                .unwrap_or_default()
                .iter()
                .filter(|model| model["visibility"].as_str() == Some("list"))
                .filter_map(|model| {
                    let id = model["slug"].as_str()?;
                    let name = model["display_name"].as_str().unwrap_or(id);
                    Some((id.to_string(), name.to_string()))
                })
                .collect())
        }
    }
}

/// One answer being written by the program.
pub(crate) struct Run {
    cli: Cli,
    child: Child,
    stdout: Lines<BufReader<ChildStdout>>,
    stderr: tokio::task::JoinHandle<String>,
    ended: bool,
}

/// Starts `cli` on `model` with the request on stdin.
pub(crate) fn start(
    cli: Cli,
    path: &Path,
    model: &str,
    system: &str,
    user: &str,
) -> Result<Run, String> {
    // An empty folder of its own: nothing of the user's for it to read.
    let dir = std::env::temp_dir().join("tablepeek-ai-cli");
    std::fs::create_dir_all(&dir).map_err(|err| format!("작업 폴더를 만들 수 없습니다: {err}"))?;
    let mut command = command(path);
    command.current_dir(&dir).stdin(Stdio::piped());
    let input = match cli {
        Cli::Codex => {
            command.args([
                "exec",
                "--json",
                "--skip-git-repo-check",
                "--ephemeral",
                "--ignore-user-config",
                "--sandbox",
                "read-only",
                "-c",
                "model_reasoning_effort=\"low\"",
                "-m",
                model,
                "-",
            ]);
            // Codex keeps its own instructions; ours lead the prompt.
            format!("{system}\n\n{user}")
        }
    };
    let mut child = command
        .spawn()
        .map_err(|err| format!("{}를 실행할 수 없습니다: {err}", cli.label()))?;
    if let Some(mut stdin) = child.stdin.take() {
        tokio::spawn(async move {
            let _ = stdin.write_all(input.as_bytes()).await;
            let _ = stdin.shutdown().await;
        });
    }
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| format!("{}의 출력을 읽을 수 없습니다", cli.label()))?;
    let stderr = child.stderr.take();
    let stderr = tokio::spawn(async move {
        let mut text = String::new();
        if let Some(mut stderr) = stderr {
            let _ = stderr.read_to_string(&mut text).await;
        }
        text
    });
    Ok(Run {
        cli,
        child,
        stdout: BufReader::new(stdout).lines(),
        stderr,
        ended: false,
    })
}

impl Run {
    /// The events in the program's next line of output; `None` once it has
    /// exited, with an error event first when it failed without saying why.
    pub(crate) async fn next(&mut self) -> std::io::Result<Option<Vec<Event>>> {
        if let Some(line) = self.stdout.next_line().await? {
            return Ok(Some(self.events(&line)));
        }
        if self.ended {
            return Ok(None);
        }
        self.ended = true;
        let status = self.child.wait().await?;
        if status.success() {
            return Ok(Some(Vec::new()));
        }
        let stderr = (&mut self.stderr).await.unwrap_or_default();
        let stderr = stderr.trim();
        let tail: String = stderr
            .chars()
            .rev()
            .take(STDERR_LIMIT)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        let message = if tail.is_empty() {
            format!("{}가 실패했습니다 ({status})", self.cli.label())
        } else {
            format!("{}: {tail}", self.cli.label())
        };
        Ok(Some(vec![Event::Error {
            code: None,
            message,
        }]))
    }

    fn events(&self, line: &str) -> Vec<Event> {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            return Vec::new();
        };
        match self.cli {
            Cli::Codex => codex_event(&value).into_iter().collect(),
        }
    }
}

/// Codex's JSONL: the answer comes whole in an `agent_message` item.
fn codex_event(value: &Value) -> Option<Event> {
    match value["type"].as_str()? {
        "item.completed" if value["item"]["type"] == "agent_message" => {
            Some(Event::Text(value["item"]["text"].as_str()?.to_string()))
        }
        "turn.completed" => Some(Event::Done),
        "turn.failed" => Some(Event::Error {
            code: None,
            message: value["error"]["message"]
                .as_str()
                .unwrap_or("Codex가 답하지 못했습니다")
                .to_string(),
        }),
        "error" => Some(Event::Error {
            code: None,
            message: value["message"]
                .as_str()
                .unwrap_or("Codex 오류")
                .to_string(),
        }),
        _ => None,
    }
}
