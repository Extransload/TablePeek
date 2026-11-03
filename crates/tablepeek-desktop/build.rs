// Generates the app's Tauri context (tauri.conf.json, icons) for macOS and
// Windows, the only targets the app is built for. The target is read at run
// time: the script itself is compiled for the host.
fn main() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if target_os == "macos" || target_os == "windows" {
        tauri_build::build();
    }
}
