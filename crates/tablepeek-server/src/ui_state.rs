//! The web UI's own state — settings, language, open workspaces and tabs,
//! drafts, column widths, panel sizes, recent queries — kept as one
//! `{ key: value }` map in ui-state.json next to store.json.
//!
//! The browser's localStorage would lose it: it belongs to one origin, and the
//! server takes a new port every run. Every TablePeek on the machine (the CLI
//! server, the desktop app) shares this file, so a write re-reads it under a
//! file lock and changes only the keys it names, leaving whatever another
//! server wrote since.
//!
//! A page may have two batches on their way at once (one sent as it closes,
//! while an earlier one is still out); each batch names the page and its
//! number, and one older than a batch the page already saved is skipped. A
//! page's batch carries every change it hasn't seen saved, so the newer batch
//! holds what the older one did.

use std::collections::{BTreeMap, HashMap};
use std::fs::File;
use std::io::ErrorKind;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const UI_STATE_FILE: &str = "ui-state.json";
/// Held while the file is read or replaced, by every process using the dir.
const LOCK_FILE: &str = "ui-state.lock";
/// Where a file that no longer parses is moved, so it can still be looked at.
const UNREADABLE_FILE: &str = "ui-state.unreadable.json";
/// The largest state kept. A browser holds about 5 MB per origin in
/// localStorage, so this leaves room without letting the file grow unbounded.
pub const MAX_BYTES: usize = 16 * 1024 * 1024;
/// How long a page's last batch number is remembered after it saved. No
/// request of the page is still on its way by then.
const WRITER_TTL: Duration = Duration::from_secs(10 * 60);

pub type Values = BTreeMap<String, String>;

/// The last batch number each page (writer) saved, in this server.
#[derive(Default)]
pub struct Writers(Mutex<HashMap<String, (u64, Instant)>>);

impl Writers {
    /// Writes like `update`, unless `writer` already saved batch `seq` or a
    /// later one; returns whether it wrote. Writes from this server go one at
    /// a time. Blocks: call it off the async workers.
    pub fn update(
        &self,
        dir: &Path,
        writer: &str,
        seq: u64,
        set: Values,
        remove: &[String],
    ) -> Result<bool, UpdateError> {
        let mut saved = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = Instant::now();
        saved.retain(|_, (_, at)| now.duration_since(*at) < WRITER_TTL);
        if saved.get(writer).is_some_and(|(last, _)| *last >= seq) {
            return Ok(false);
        }
        update(dir, set, remove)?;
        saved.insert(writer.to_string(), (seq, now));
        Ok(true)
    }
}

#[derive(Debug, PartialEq)]
pub enum UpdateError {
    TooLarge,
    Io(String),
}

impl From<String> for UpdateError {
    fn from(message: String) -> Self {
        Self::Io(message)
    }
}

/// Reads the state. Blocks on the file lock: call it off the async workers.
pub fn read(dir: &Path) -> Result<Values, String> {
    let _lock = lock(dir)?;
    read_locked(dir)
}

/// Removes `remove`, then sets `set`, on the state as it is in the file now,
/// and replaces the file atomically. Blocks on the file lock: call it off the
/// async workers.
pub fn update(dir: &Path, set: Values, remove: &[String]) -> Result<(), UpdateError> {
    let _lock = lock(dir)?;
    let mut values = read_locked(dir)?;
    for key in remove {
        values.remove(key);
    }
    values.extend(set);
    let bytes = serde_json::to_vec(&values)
        .map_err(|err| format!("화면 상태를 직렬화할 수 없습니다: {err}"))?;
    if bytes.len() > MAX_BYTES {
        return Err(UpdateError::TooLarge);
    }
    let temp = dir.join(format!("{UI_STATE_FILE}.tmp"));
    std::fs::write(&temp, bytes)
        .map_err(|err| format!("화면 상태 파일을 쓸 수 없습니다: {err}"))?;
    // Drafts and open tabs carry statements, and the passcode hash is here.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&temp, dir.join(UI_STATE_FILE))
        .map_err(|err| format!("화면 상태 파일을 교체할 수 없습니다: {err}"))?;
    Ok(())
}

/// Takes the dir's lock, released when the returned file drops.
fn lock(dir: &Path) -> Result<File, String> {
    std::fs::create_dir_all(dir).map_err(|err| format!("저장 폴더를 만들 수 없습니다: {err}"))?;
    let file = File::options()
        .create(true)
        .truncate(false)
        .write(true)
        .open(dir.join(LOCK_FILE))
        .map_err(|err| format!("화면 상태 잠금 파일을 열 수 없습니다: {err}"))?;
    file.lock()
        .map_err(|err| format!("화면 상태 파일을 잠글 수 없습니다: {err}"))?;
    Ok(file)
}

fn read_locked(dir: &Path) -> Result<Values, String> {
    let path = dir.join(UI_STATE_FILE);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(Values::new()),
        Err(err) => return Err(format!("화면 상태 파일을 읽을 수 없습니다: {err}")),
    };
    match serde_json::from_slice(&bytes) {
        Ok(values) => Ok(values),
        // Kept failing, a broken file would leave every page on defaults
        // that are never saved; set aside, it starts over like a new one.
        Err(_) => {
            std::fs::rename(&path, dir.join(UNREADABLE_FILE))
                .map_err(|err| format!("읽을 수 없는 화면 상태 파일을 옮길 수 없습니다: {err}"))?;
            Ok(Values::new())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tablepeek-ui-state-test-{}-{}-{name}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn values(pairs: &[(&str, &str)]) -> Values {
        pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    #[test]
    fn empty_until_first_write_then_round_trips() {
        let dir = temp_dir("round-trip");
        assert_eq!(read(&dir).unwrap(), Values::new());

        let set = values(&[
            ("tablepeek.language", "en"),
            ("tablepeek.settings", "{\"a\":1}"),
        ]);
        update(&dir, set.clone(), &[]).unwrap();
        assert_eq!(read(&dir).unwrap(), set);

        update(
            &dir,
            Values::new(),
            &["tablepeek.language".into(), "tablepeek.settings".into()],
        )
        .unwrap();
        assert_eq!(read(&dir).unwrap(), Values::new());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_batch_older_than_one_saved_is_skipped() {
        let dir = temp_dir("writers");
        let writers = Writers::default();
        assert_eq!(
            writers.update(&dir, "page-a", 2, values(&[("k", "new")]), &[]),
            Ok(true)
        );
        // Page A's earlier batch arrives late; page B's own numbering is apart.
        assert_eq!(
            writers.update(&dir, "page-a", 1, values(&[("k", "old")]), &[]),
            Ok(false)
        );
        assert_eq!(
            writers.update(&dir, "page-b", 1, values(&[("b", "1")]), &[]),
            Ok(true)
        );
        assert_eq!(read(&dir).unwrap(), values(&[("b", "1"), ("k", "new")]));

        // A batch that failed doesn't count as saved.
        assert_eq!(
            writers.update(
                &dir,
                "page-a",
                3,
                values(&[("x", &"x".repeat(MAX_BYTES))]),
                &[]
            ),
            Err(UpdateError::TooLarge)
        );
        assert_eq!(
            writers.update(&dir, "page-a", 3, values(&[("k", "newer")]), &[]),
            Ok(true)
        );
        assert_eq!(read(&dir).unwrap()["k"], "newer");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn write_keeps_keys_another_writer_added_since() {
        let dir = temp_dir("other-writer");
        update(&dir, values(&[("a", "1")]), &[]).unwrap();
        // Another server (the desktop app, say) writes the file meanwhile.
        std::fs::write(
            dir.join(UI_STATE_FILE),
            r#"{"a":"1","b":"from-the-other-server"}"#,
        )
        .unwrap();

        update(&dir, values(&[("c", "3")]), &[]).unwrap();
        assert_eq!(
            read(&dir).unwrap(),
            values(&[("a", "1"), ("b", "from-the-other-server"), ("c", "3")])
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn remove_drops_only_the_named_keys() {
        let dir = temp_dir("remove");
        update(&dir, values(&[("a", "1"), ("b", "2"), ("c", "3")]), &[]).unwrap();
        update(
            &dir,
            values(&[("c", "30")]),
            &["a".into(), "never-there".into()],
        )
        .unwrap();
        assert_eq!(read(&dir).unwrap(), values(&[("b", "2"), ("c", "30")]));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn concurrent_writers_lose_no_keys() {
        let dir = temp_dir("concurrent");
        let writers: Vec<_> = (0..8)
            .map(|index| {
                let dir = dir.clone();
                std::thread::spawn(move || {
                    for round in 0..10 {
                        let key = format!("w{index}-{round}");
                        update(&dir, values(&[(&key, "x")]), &[]).unwrap();
                    }
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }
        assert_eq!(read(&dir).unwrap().len(), 80);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn oversized_state_is_refused_and_file_kept() {
        let dir = temp_dir("too-large");
        update(&dir, values(&[("a", "1")]), &[]).unwrap();
        let huge = "x".repeat(MAX_BYTES);
        assert_eq!(
            update(&dir, values(&[("b", &huge)]), &[]),
            Err(UpdateError::TooLarge)
        );
        assert_eq!(read(&dir).unwrap(), values(&[("a", "1")]));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn unreadable_file_is_set_aside_and_starts_over() {
        let dir = temp_dir("unreadable");
        std::fs::write(dir.join(UI_STATE_FILE), b"{not json").unwrap();
        assert_eq!(read(&dir).unwrap(), Values::new());
        assert_eq!(
            std::fs::read(dir.join(UNREADABLE_FILE)).unwrap(),
            b"{not json"
        );
        update(&dir, values(&[("a", "1")]), &[]).unwrap();
        assert_eq!(read(&dir).unwrap(), values(&[("a", "1")]));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
