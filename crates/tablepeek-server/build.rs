// Build metadata for `tablepeek --version` and GET /api/version: the commit
// the binary was built from, how it was built and the target it runs on.
//
// TABLEPEEK_COMMIT is the short hash of HEAD, with "-dirty" when tracked
// files differ from it, or "unknown" without git (a source archive).
// TABLEPEEK_DIST is "release" when the release workflow builds with
// TABLEPEEK_DIST=release, otherwise "source".
// TABLEPEEK_TARGET is the Rust target triple, which names the release asset
// for this platform.

use std::path::{Path, PathBuf};
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-env-changed=TABLEPEEK_DIST");
    let dist = match std::env::var("TABLEPEEK_DIST").as_deref() {
        Ok("release") => "release",
        _ => "source",
    };
    println!("cargo:rustc-env=TABLEPEEK_DIST={dist}");

    let target = std::env::var("TARGET").unwrap_or_else(|_| "unknown".into());
    println!("cargo:rustc-env=TABLEPEEK_TARGET={target}");

    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
    let commit = git_commit(&manifest_dir).unwrap_or_else(|| "unknown".into());
    println!("cargo:rustc-env=TABLEPEEK_COMMIT={commit}");
}

fn git(dir: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(dir)
        // `git status` would otherwise refresh and rewrite the index, which
        // is one of the files this script watches.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn git_commit(dir: &Path) -> Option<String> {
    let hash = git(dir, &["rev-parse", "--short", "HEAD"])?;
    if hash.is_empty() {
        return None;
    }

    // Rebuild when HEAD moves (a commit, a checkout) or the index changes.
    // Edits that are not yet staged are only noticed on the next of those;
    // watching the whole tree would rerun this on every build.
    if let Some(git_dir) = git(dir, &["rev-parse", "--absolute-git-dir"]) {
        let git_dir = PathBuf::from(git_dir);
        watch(&git_dir.join("HEAD"));
        watch(&git_dir.join("index"));
        let common = git(dir, &["rev-parse", "--git-common-dir"])
            .map(|common| {
                let common = PathBuf::from(common);
                if common.is_absolute() {
                    common
                } else {
                    dir.join(common)
                }
            })
            .unwrap_or(git_dir);
        watch(&common.join("packed-refs"));
        if let Some(head_ref) = git(dir, &["symbolic-ref", "-q", "HEAD"]) {
            watch(&common.join(head_ref));
        }
    }

    let dirty = git(dir, &["status", "--porcelain", "--untracked-files=no"])
        .is_some_and(|status| !status.is_empty());
    Some(if dirty { format!("{hash}-dirty") } else { hash })
}

// Cargo reruns a script on every build while a file it watches is missing,
// so only files that exist are watched.
fn watch(path: &Path) {
    if path.exists() {
        println!("cargo:rerun-if-changed={}", path.display());
    }
}
