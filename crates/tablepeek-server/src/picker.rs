//! The operating system's own open-file dialog. The server listens on
//! loopback only, so the browser asking runs on this machine and the dialog
//! shows on the same screen: an `NSOpenPanel` on macOS, a WinForms
//! `OpenFileDialog` on Windows, zenity or kdialog elsewhere.

use std::path::{Path, PathBuf};
#[cfg(not(target_os = "macos"))]
use std::process::{Command, Output, Stdio};
use std::sync::{Mutex, TryLockError};

/// Files the dialog lets through: `name` labels them where the platform shows
/// a filter, `extensions` (without the dot) are the ones offered.
pub struct PickFilter {
    pub name: String,
    pub extensions: Vec<String>,
}

pub struct PickRequest {
    pub title: String,
    pub filter: Option<PickFilter>,
    /// Folder to open in; ignored unless it is an existing directory.
    pub dir: Option<PathBuf>,
    /// Show hidden files (macOS only; the others follow the system setting).
    pub hidden: bool,
}

pub enum PickError {
    /// No dialog this platform can show (no zenity or kdialog, no display).
    Unavailable,
    /// A dialog is already up.
    Busy,
    Failed(String),
}

// Held while a dialog is up: one at a time.
static PICKING: Mutex<()> = Mutex::new(());

/// Blocks until the dialog closes: `Some(path)` for a picked file, `None` on
/// cancel. `shown` runs once the dialog is on screen (on Linux, once it has
/// started: zenity and kdialog don't say).
pub fn pick_file(
    request: &PickRequest,
    shown: &mut dyn FnMut(),
) -> Result<Option<String>, PickError> {
    let _picking = match PICKING.try_lock() {
        Ok(guard) => guard,
        Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
        Err(TryLockError::WouldBlock) => return Err(PickError::Busy),
    };
    let dir = request.dir.as_deref().filter(|dir| dir.is_dir());
    let extensions: Vec<&str> = request
        .filter
        .iter()
        .flat_map(|filter| filter.extensions.iter())
        .map(String::as_str)
        // Spliced into a filter string: plain extensions only.
        .filter(|ext| !ext.is_empty() && ext.chars().all(|c| c.is_ascii_alphanumeric()))
        .collect();
    let filter_name = request
        .filter
        .as_ref()
        .map_or("", |filter| filter.name.as_str());
    platform_pick(
        &request.title,
        filter_name,
        &extensions,
        dir,
        request.hidden,
        shown,
    )
}

#[cfg(not(target_os = "macos"))]
fn picked(output: &str) -> Option<String> {
    let path = output.trim_end_matches(['\r', '\n']);
    (!path.is_empty()).then(|| path.to_string())
}

#[cfg(not(target_os = "macos"))]
fn failure(output: &Output) -> PickError {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    PickError::Failed(if stderr.is_empty() {
        format!("파일 선택 창이 실패했습니다 ({})", output.status)
    } else {
        stderr
    })
}

#[cfg(target_os = "macos")]
fn platform_pick(
    title: &str,
    _filter_name: &str,
    extensions: &[&str],
    dir: Option<&Path>,
    hidden: bool,
    shown: &mut dyn FnMut(),
) -> Result<Option<String>, PickError> {
    mac::pick(
        &serde_json::json!({
            "title": title,
            "extensions": extensions,
            "dir": dir.map(|dir| dir.to_string_lossy()),
            "hidden": hidden,
        }),
        shown,
    )
}

/// One long-lived `osascript` (JavaScript for Automation), started by the
/// first pick, that keeps AppKit and an open panel loaded: its first panel
/// takes about a second, the ones after a tenth of that. Per request (one
/// JSON line on stdin) it writes `{"shown": true}` once the panel is up, then
/// `{"path": …}` (null when cancelled) or `{"error": …}`.
#[cfg(target_os = "macos")]
mod mac {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
    use std::sync::Mutex;

    use super::PickError;

    // Values arrive as JSON on stdin, never inside the script. Between picks
    // the helper sits in its event loop, not in a blocking read: an app that
    // stops taking events is reported as not responding. An accessory app
    // has no Dock icon; the modal panel level keeps the panel over the
    // browser. It quits when the server goes (stdin closes).
    const SCRIPT: &str = r#"
ObjC.import("AppKit");
var app = $.NSApplication.sharedApplication;
app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
$.NSOpenPanel.openPanel;
var input = $.NSFileHandle.fileHandleWithStandardInput;
var output = $.NSFileHandle.fileHandleWithStandardOutput;
function reply(value) {
  output.writeData($(JSON.stringify(value) + "\n").dataUsingEncoding($.NSUTF8StringEncoding));
}
function pick(request) {
  var panel = $.NSOpenPanel.openPanel;
  panel.message = request.title;
  panel.canChooseFiles = true;
  panel.canChooseDirectories = false;
  panel.allowsMultipleSelection = false;
  panel.showsHiddenFiles = request.hidden;
  if (request.extensions.length > 0) panel.allowedFileTypes = $(request.extensions);
  if (request.dir !== null) panel.directoryURL = $.NSURL.fileURLWithPath(request.dir);
  panel.level = $.NSModalPanelWindowLevel;
  app.activateIgnoringOtherApps(true);
  // Fires on the modal loop's first turn, with the panel on screen.
  var shown = $.NSTimer.timerWithTimeIntervalRepeatsBlock(0, false, function () { reply({ shown: true }); });
  $.NSRunLoop.currentRunLoop.addTimerForMode(shown, $.NSModalPanelRunLoopMode);
  if (panel.runModal != $.NSModalResponseOK || panel.URL.isNil()) return null;
  return ObjC.unwrap(panel.URL.path);
}
var pending = "";
$.NSNotificationCenter.defaultCenter.addObserverForNameObjectQueueUsingBlock(
  $.NSFileHandleReadCompletionNotification, input, $.NSOperationQueue.mainQueue,
  function (notification) {
    var data = notification.userInfo.objectForKey($.NSFileHandleNotificationDataItem);
    if (data.length == 0) app.terminate(null);
    pending += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding));
    var newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      var line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      try { reply({ path: pick(JSON.parse(line)) }); } catch (error) { reply({ error: String(error) }); }
    }
    input.readInBackgroundAndNotify;
  });
input.readInBackgroundAndNotify;
app.run;
"#;

    struct Helper {
        child: Child,
        stdin: ChildStdin,
        stdout: BufReader<ChildStdout>,
    }

    impl Helper {
        fn spawn() -> std::io::Result<Helper> {
            let mut child = Command::new("osascript")
                .args(["-l", "JavaScript", "-e", SCRIPT])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()?;
            let stdin = child.stdin.take().expect("piped stdin");
            let stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
            Ok(Helper {
                child,
                stdin,
                stdout,
            })
        }

        // The answer's line; `shown` runs on the way when the panel comes up.
        fn ask(&mut self, request: &str, shown: &mut dyn FnMut()) -> std::io::Result<String> {
            self.stdin.write_all(request.as_bytes())?;
            self.stdin.write_all(b"\n")?;
            self.stdin.flush()?;
            loop {
                let mut line = String::new();
                if self.stdout.read_line(&mut line)? == 0 {
                    return Err(std::io::ErrorKind::UnexpectedEof.into());
                }
                if line.starts_with(r#"{"shown":"#) {
                    shown();
                    continue;
                }
                return Ok(line);
            }
        }
    }

    static HELPER: Mutex<Option<Helper>> = Mutex::new(None);

    pub(super) fn pick(
        request: &serde_json::Value,
        shown: &mut dyn FnMut(),
    ) -> Result<Option<String>, PickError> {
        let mut slot = HELPER
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // A helper that has exited (killed, or never started) is replaced.
        let alive = match slot.as_mut() {
            Some(helper) => matches!(helper.child.try_wait(), Ok(None)),
            None => false,
        };
        if !alive {
            *slot = Some(Helper::spawn().map_err(|err| PickError::Failed(err.to_string()))?);
        }
        let helper = slot.as_mut().expect("helper set above");
        let reply = match helper.ask(&request.to_string(), shown) {
            Ok(reply) => reply,
            Err(_) => {
                // Gone mid-pick: the next pick starts a new one. The I/O
                // error ("unexpected end of file") would read as a lost
                // database connection, so it isn't passed on.
                if let Some(mut helper) = slot.take() {
                    let _ = helper.child.kill();
                    let _ = helper.child.wait();
                }
                return Err(PickError::Failed(
                    "파일 선택 창이 예기치 않게 닫혔습니다".to_string(),
                ));
            }
        };
        let reply: serde_json::Value =
            serde_json::from_str(&reply).map_err(|err| PickError::Failed(err.to_string()))?;
        if let Some(error) = reply.get("error").and_then(|error| error.as_str()) {
            return Err(PickError::Failed(error.to_string()));
        }
        Ok(reply
            .get("path")
            .and_then(|path| path.as_str())
            .map(str::to_string))
    }
}

#[cfg(target_os = "windows")]
fn platform_pick(
    title: &str,
    filter_name: &str,
    extensions: &[&str],
    dir: Option<&Path>,
    _hidden: bool,
    shown: &mut dyn FnMut(),
) -> Result<Option<String>, PickError> {
    use std::io::{BufRead, BufReader, Read};

    // "shown" goes out once the dialog is built (loading the assembly is the
    // slow part), then the picked path, or nothing on cancel.
    const SCRIPT: &str = r#"
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = $env:TABLEPEEK_PICK_TITLE
if ($env:TABLEPEEK_PICK_FILTER) { $dialog.Filter = $env:TABLEPEEK_PICK_FILTER }
if ($env:TABLEPEEK_PICK_DIR) { $dialog.InitialDirectory = $env:TABLEPEEK_PICK_DIR }
$owner = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true }
[Console]::Out.WriteLine('shown')
[Console]::Out.Flush()
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.FileName) }
"#;
    let filter = if extensions.is_empty() {
        String::new()
    } else {
        let patterns: Vec<String> = extensions.iter().map(|ext| format!("*.{ext}")).collect();
        let patterns = patterns.join(";");
        // `|` separates a WinForms filter's fields, so it can't be in the label.
        format!("{} ({patterns})|{patterns}", filter_name.replace('|', " "))
    };
    // The values travel in the environment, never inside the script.
    let mut child = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-STA", "-Command", SCRIPT])
        .env("TABLEPEEK_PICK_TITLE", title)
        .env("TABLEPEEK_PICK_FILTER", filter)
        .env(
            "TABLEPEEK_PICK_DIR",
            dir.map(|dir| dir.as_os_str()).unwrap_or_default(),
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| match err.kind() {
            std::io::ErrorKind::NotFound => PickError::Unavailable,
            _ => PickError::Failed(err.to_string()),
        })?;
    let mut stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
    let mut first = String::new();
    let mut rest = String::new();
    let read = stdout
        .read_line(&mut first)
        .and_then(|_| stdout.read_to_string(&mut rest));
    if first.trim_end() == "shown" {
        shown();
    } else {
        rest.insert_str(0, &first);
    }
    let output = child
        .wait_with_output()
        .map_err(|err| PickError::Failed(err.to_string()))?;
    read.map_err(|err| PickError::Failed(err.to_string()))?;
    if output.status.success() {
        // Cancel writes nothing.
        return Ok(picked(&rest));
    }
    Err(failure(&output))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_pick(
    title: &str,
    filter_name: &str,
    extensions: &[&str],
    dir: Option<&Path>,
    _hidden: bool,
    shown: &mut dyn FnMut(),
) -> Result<Option<String>, PickError> {
    if std::env::var_os("DISPLAY").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_none() {
        return Err(PickError::Unavailable);
    }
    let patterns: Vec<String> = extensions.iter().map(|ext| format!("*.{ext}")).collect();
    let patterns = patterns.join(" ");

    let mut zenity = Command::new("zenity");
    zenity.args(["--file-selection", "--title", title]);
    if let Some(dir) = dir {
        // A trailing slash opens the folder rather than selecting it.
        let mut start = dir.as_os_str().to_owned();
        start.push("/");
        zenity.arg("--filename").arg(start);
    }
    if !patterns.is_empty() {
        zenity
            .arg("--file-filter")
            .arg(format!("{} | {patterns}", filter_name.replace('|', " ")));
    }

    let mut kdialog = Command::new("kdialog");
    kdialog.args(["--title", title, "--getopenfilename"]);
    // The start folder is positional, and it comes before the filter.
    kdialog.arg(dir.map(Path::as_os_str).unwrap_or_else(|| ".".as_ref()));
    if !patterns.is_empty() {
        kdialog.arg(format!("{patterns}|{filter_name}"));
    }

    for mut command in [zenity, kdialog] {
        let child = match command
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => return Err(PickError::Failed(err.to_string())),
        };
        shown();
        let output = child
            .wait_with_output()
            .map_err(|err| PickError::Failed(err.to_string()))?;
        if output.status.success() {
            return Ok(picked(&String::from_utf8_lossy(&output.stdout)));
        }
        // Both exit 1 when the dialog is cancelled.
        if output.status.code() == Some(1) {
            return Ok(None);
        }
        return Err(failure(&output));
    }
    Err(PickError::Unavailable)
}
