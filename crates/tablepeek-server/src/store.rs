use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, PoisonError};

use serde::{Deserialize, Serialize};
use tablepeek_types::{HttpTunnelConfig, MssqlConfig, MySqlConfig, PostgresConfig, SshConfig};

/// Runs kept per connection; the oldest fall off first.
pub const HISTORY_CAP: usize = 1_000;
/// Runs kept across all connections, so forgotten files and sessions stay bounded.
const HISTORY_TOTAL_CAP: usize = 10_000;
/// Longer statements are kept clipped, with a trailing "…".
const HISTORY_SQL_CAP: usize = 10_000;
const HISTORY_FILE: &str = "history.json";
const KEYRING_SERVICE: &str = "tablepeek";
const LEGACY_KEYRING_SERVICES: [&str; 2] = ["wrendb", "prodb"];
const STORE_FILE: &str = "store.json";
const STORE_DIR: &str = ".tablepeek";
const LEGACY_STORE_DIRS: [&str; 2] = [".wrendb", ".prodb"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedHttpTunnel {
    pub host: String,
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
}

impl SavedHttpTunnel {
    pub fn from_config(tunnel: &HttpTunnelConfig) -> Self {
        Self {
            host: tunnel.host.clone(),
            port: tunnel.port,
            username: tunnel.username.clone(),
        }
    }

    pub fn to_config(&self) -> HttpTunnelConfig {
        HttpTunnelConfig {
            host: self.host.clone(),
            port: self.port,
            username: self.username.clone(),
            password: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedSsh {
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub private_key_path: Option<String>,
}

impl SavedSsh {
    pub fn from_config(ssh: &SshConfig) -> Self {
        Self {
            host: ssh.host.clone(),
            port: ssh.port,
            user: ssh.user.clone(),
            private_key_path: ssh.private_key_path.clone(),
        }
    }

    pub fn to_config(&self) -> SshConfig {
        SshConfig {
            host: self.host.clone(),
            port: self.port,
            user: self.user.clone(),
            password: None,
            private_key_path: self.private_key_path.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedConnection {
    pub id: String,
    pub name: String,
    pub driver: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub postgres: Option<PostgresConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cockroach: Option<PostgresConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mysql: Option<MySqlConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mssql: Option<MssqlConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssh: Option<SavedSsh>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub http_tunnel: Option<SavedHttpTunnel>,
    #[serde(default)]
    pub persist_password: bool,
    #[serde(default)]
    pub last_used: u64,
}

/// One statement run from the editor, or a data change committed from the
/// GUI. `scope` names the connection it ran on (see `saved_scope`), so each
/// connection keeps its own history.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    /// Stable handle for deleting one entry; given on record (or on load,
    /// for entries written before ids existed) when empty.
    #[serde(default)]
    pub id: String,
    pub scope: String,
    pub sql: String,
    pub at: u64,
    pub ms: u64,
    pub ok: bool,
    pub rows: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub const SESSION_PREFIX: &str = "session:";
const SAVED_PREFIX: &str = "saved:";

/// The history and safe-mode scope of a saved connection profile.
pub fn saved_scope(id: &str) -> String {
    format!("{SAVED_PREFIX}{id}")
}

/// A saved query ("Queries"), shared by every connection.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FavoriteEntry {
    pub id: String,
    pub name: String,
    pub sql: String,
    #[serde(default)]
    pub keyword: Option<String>,
    /// The folder's id; None keeps the query at the top level.
    #[serde(default)]
    pub folder: Option<String>,
    /// Unix seconds. Entries saved before these existed get the time they
    /// were first loaded.
    #[serde(default)]
    pub created_at: u64,
    /// Last change to the name, SQL or keyword (moving folders is not one).
    #[serde(default)]
    pub updated_at: u64,
}

/// What to change in a saved query; a None field stays as it is.
#[derive(Debug, Default)]
pub struct FavoritePatch {
    pub name: Option<String>,
    pub sql: Option<String>,
    /// Some(None) clears the keyword.
    pub keyword: Option<Option<String>>,
    /// Some(None) moves the query to the top level.
    pub folder: Option<Option<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FavoriteFolder {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub created_at: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StoreData {
    #[serde(default)]
    pub connections: Vec<SavedConnection>,
    #[serde(default)]
    pub favorites: Vec<FavoriteEntry>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub favorite_folders: Vec<FavoriteFolder>,
    /// Safe mode (0 off, 1 risky only, 2 every change) chosen per connection scope.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub safe_modes: BTreeMap<String, u8>,
}

pub struct StoreFile {
    dir: PathBuf,
    data: StoreData,
    // Newest first. Kept in its own file so a query never rewrites store.json.
    history: Vec<HistoryEntry>,
    // Bumped by every snapshot; the newest snapshot written so far, so an
    // older one finishing late never overwrites it.
    history_version: u64,
    history_written: Arc<Mutex<u64>>,
}

/// History as it stood, ready to be written: `write` it where blocking is
/// fine (the async server uses spawn_blocking); it serializes there too.
pub struct HistorySnapshot {
    dir: PathBuf,
    entries: Vec<HistoryEntry>,
    version: u64,
    written: Arc<Mutex<u64>>,
}

impl HistorySnapshot {
    /// Replaces history.json (0600, atomically) unless a newer snapshot is
    /// already there.
    pub fn write(self) -> Result<(), String> {
        let mut written = self.written.lock().unwrap_or_else(PoisonError::into_inner);
        if *written >= self.version {
            return Ok(());
        }
        let bytes = serde_json::to_vec(&self.entries)
            .map_err(|err| format!("실행 기록을 직렬화할 수 없습니다: {err}"))?;
        std::fs::create_dir_all(&self.dir)
            .map_err(|err| format!("저장 폴더를 만들 수 없습니다: {err}"))?;
        let temp = self.dir.join(format!("{HISTORY_FILE}.tmp"));
        std::fs::write(&temp, bytes).map_err(|err| format!("기록 파일을 쓸 수 없습니다: {err}"))?;
        // Statements can carry literals worth keeping private (passwords in
        // CREATE USER, personal data in WHERE clauses).
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&temp, std::fs::Permissions::from_mode(0o600));
        }
        std::fs::rename(&temp, self.dir.join(HISTORY_FILE))
            .map_err(|err| format!("기록 파일을 교체할 수 없습니다: {err}"))?;
        *written = self.version;
        Ok(())
    }
}

impl StoreFile {
    pub fn load(dir: &Path) -> Self {
        let mut data = std::fs::read(dir.join(STORE_FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<StoreData>(&bytes).ok())
            .unwrap_or_default();
        let mut history = std::fs::read(dir.join(HISTORY_FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<HistoryEntry>>(&bytes).ok())
            .unwrap_or_default();
        // An unsaved connection's slot dies with the server that opened it, so
        // its history and safe mode can never be reached again.
        history.retain(|entry| !entry.scope.starts_with(SESSION_PREFIX));
        data.safe_modes
            .retain(|scope, _| !scope.starts_with(SESSION_PREFIX));
        // Files from before ids and timestamps: fill them in once, for good.
        let mut history_ids = false;
        for entry in history.iter_mut().filter(|entry| entry.id.is_empty()) {
            entry.id = new_id();
            history_ids = true;
        }
        let now = unix_now();
        let mut favorite_times = false;
        for favorite in data.favorites.iter_mut().filter(|f| f.created_at == 0) {
            favorite.created_at = now;
            if favorite.updated_at == 0 {
                favorite.updated_at = now;
            }
            favorite_times = true;
        }
        let mut store = Self {
            dir: dir.to_path_buf(),
            data,
            history,
            history_version: 0,
            history_written: Arc::new(Mutex::new(0)),
        };
        if history_ids {
            let _ = store.persist_history();
        }
        if favorite_times {
            let _ = store.persist();
        }
        store
    }

    pub fn load_home() -> Self {
        Self::load(&default_dir())
    }

    pub fn data(&self) -> &StoreData {
        &self.data
    }

    pub fn add_connection(&mut self, connection: SavedConnection) -> Result<(), String> {
        if !self.update_connection(connection.clone())? {
            self.data.connections.push(connection);
            self.persist()?;
        }
        Ok(())
    }

    /// Replaces a saved profile in place (keeping its list position). Returns false,
    /// writing nothing, when the id no longer exists.
    pub fn update_connection(&mut self, mut connection: SavedConnection) -> Result<bool, String> {
        let Some(existing) = self
            .data
            .connections
            .iter_mut()
            .find(|existing| existing.id == connection.id)
        else {
            return Ok(false);
        };
        connection.last_used = connection.last_used.max(existing.last_used);
        *existing = connection;
        self.persist()?;
        Ok(true)
    }

    pub fn touch_connection(&mut self, id: &str, at: u64) -> Result<bool, String> {
        let Some(connection) = self
            .data
            .connections
            .iter_mut()
            .find(|connection| connection.id == id)
        else {
            return Ok(false);
        };
        connection.last_used = at.max(connection.last_used);
        self.persist()?;
        Ok(true)
    }

    pub fn remove_connection(&mut self, id: &str) -> Result<bool, String> {
        let before = self.data.connections.len();
        self.data
            .connections
            .retain(|connection| connection.id != id);
        if self.data.connections.len() == before {
            return Ok(false);
        }
        let scope = saved_scope(id);
        self.data.safe_modes.remove(&scope);
        self.persist()?;
        // The profile is gone either way; a history file that can't be
        // rewritten must not fail the delete (and skip its keychain cleanup).
        if self.history.iter().any(|entry| entry.scope == scope) {
            let _ = self.clear_history(&scope);
        }
        Ok(true)
    }

    pub fn find_connection(&self, id: &str) -> Option<&SavedConnection> {
        self.data
            .connections
            .iter()
            .find(|connection| connection.id == id)
    }

    pub fn record_history(&mut self, entry: HistoryEntry) -> Result<(), String> {
        if self.add_history(entry) {
            self.persist_history()?;
        }
        Ok(())
    }

    /// Adds an entry in memory only; false for a blank statement. Persist
    /// with `history_snapshot`.
    pub fn add_history(&mut self, mut entry: HistoryEntry) -> bool {
        let sql = entry.sql.trim();
        if sql.is_empty() {
            return false;
        }
        if entry.id.is_empty() {
            entry.id = new_id();
        }
        entry.sql = match sql.char_indices().nth(HISTORY_SQL_CAP) {
            Some((cut, _)) => format!("{}…", &sql[..cut]),
            None => sql.to_string(),
        };
        let scope = entry.scope.clone();
        self.history.insert(0, entry);
        let mut kept = 0;
        self.history.retain(|existing| {
            if existing.scope != scope {
                return true;
            }
            kept += 1;
            kept <= HISTORY_CAP
        });
        self.history.truncate(HISTORY_TOTAL_CAP);
        true
    }

    pub fn history(&self, scope: &str, limit: usize) -> Vec<HistoryEntry> {
        self.history
            .iter()
            .filter(|entry| entry.scope == scope)
            .take(limit)
            .cloned()
            .collect()
    }

    pub fn clear_history(&mut self, scope: &str) -> Result<(), String> {
        self.forget_history(scope);
        self.persist_history()
    }

    /// Drops a scope's entries in memory only. Persist with `history_snapshot`.
    pub fn forget_history(&mut self, scope: &str) {
        self.history.retain(|entry| entry.scope != scope);
    }

    /// Removes one entry of `scope`; false, writing nothing, when it has none
    /// with that id.
    pub fn remove_history(&mut self, scope: &str, id: &str) -> Result<bool, String> {
        if !self.forget_history_entry(scope, id) {
            return Ok(false);
        }
        self.persist_history()?;
        Ok(true)
    }

    /// Drops one entry of `scope` in memory only; false when it has none with
    /// that id. Persist with `history_snapshot`.
    pub fn forget_history_entry(&mut self, scope: &str, id: &str) -> bool {
        let before = self.history.len();
        self.history
            .retain(|entry| entry.scope != scope || entry.id != id);
        self.history.len() != before
    }

    /// History as it stands now, to write off this thread.
    pub fn history_snapshot(&mut self) -> HistorySnapshot {
        self.history_version += 1;
        HistorySnapshot {
            dir: self.dir.clone(),
            entries: self.history.clone(),
            version: self.history_version,
            written: self.history_written.clone(),
        }
    }

    /// False for a saved profile that was deleted while its connection stayed
    /// open; writing under its scope would leave entries nothing can remove.
    pub fn scope_exists(&self, scope: &str) -> bool {
        match scope.strip_prefix(SAVED_PREFIX) {
            Some(id) => self.find_connection(id).is_some(),
            None => true,
        }
    }

    pub fn safe_mode(&self, scope: &str) -> Option<u8> {
        self.data.safe_modes.get(scope).copied()
    }

    /// Stores a connection's safe mode; None returns it to the app-wide default.
    pub fn set_safe_mode(&mut self, scope: &str, mode: Option<u8>) -> Result<(), String> {
        match mode {
            Some(mode) => self.data.safe_modes.insert(scope.to_string(), mode),
            None => self.data.safe_modes.remove(scope),
        };
        self.persist()
    }

    pub fn add_favorite(&mut self, favorite: FavoriteEntry) -> Result<(), String> {
        self.data.favorites.push(favorite);
        self.persist()
    }

    pub fn remove_favorite(&mut self, id: &str) -> Result<bool, String> {
        let before = self.data.favorites.len();
        self.data.favorites.retain(|favorite| favorite.id != id);
        if self.data.favorites.len() == before {
            return Ok(false);
        }
        self.persist()?;
        Ok(true)
    }

    pub fn favorites(&self) -> Vec<FavoriteEntry> {
        self.data.favorites.clone()
    }

    /// Applies `patch`, bumping `updated_at` to `at` when the name, SQL or
    /// keyword actually changes. None, writing nothing, for an unknown id.
    pub fn update_favorite(
        &mut self,
        id: &str,
        patch: FavoritePatch,
        at: u64,
    ) -> Result<Option<FavoriteEntry>, String> {
        let Some(favorite) = self
            .data
            .favorites
            .iter_mut()
            .find(|favorite| favorite.id == id)
        else {
            return Ok(None);
        };
        let mut edited = false;
        if let Some(name) = patch.name {
            edited |= favorite.name != name;
            favorite.name = name;
        }
        if let Some(sql) = patch.sql {
            edited |= favorite.sql != sql;
            favorite.sql = sql;
        }
        if let Some(keyword) = patch.keyword {
            edited |= favorite.keyword != keyword;
            favorite.keyword = keyword;
        }
        if let Some(folder) = patch.folder {
            favorite.folder = folder;
        }
        if edited {
            favorite.updated_at = at;
        }
        let updated = favorite.clone();
        self.persist()?;
        Ok(Some(updated))
    }

    pub fn folders(&self) -> Vec<FavoriteFolder> {
        self.data.favorite_folders.clone()
    }

    pub fn has_folder(&self, id: &str) -> bool {
        self.data
            .favorite_folders
            .iter()
            .any(|folder| folder.id == id)
    }

    pub fn add_folder(&mut self, folder: FavoriteFolder) -> Result<(), String> {
        self.data.favorite_folders.push(folder);
        self.persist()
    }

    pub fn rename_folder(&mut self, id: &str, name: String) -> Result<bool, String> {
        let Some(folder) = self
            .data
            .favorite_folders
            .iter_mut()
            .find(|folder| folder.id == id)
        else {
            return Ok(false);
        };
        folder.name = name;
        self.persist()?;
        Ok(true)
    }

    /// Removes a folder together with the queries in it.
    pub fn remove_folder(&mut self, id: &str) -> Result<bool, String> {
        let before = self.data.favorite_folders.len();
        self.data.favorite_folders.retain(|folder| folder.id != id);
        if self.data.favorite_folders.len() == before {
            return Ok(false);
        }
        self.data
            .favorites
            .retain(|favorite| favorite.folder.as_deref() != Some(id));
        self.persist()?;
        Ok(true)
    }

    fn persist(&self) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir)
            .map_err(|err| format!("저장 폴더를 만들 수 없습니다: {err}"))?;
        let json = serde_json::to_vec_pretty(&self.data)
            .map_err(|err| format!("연결 정보를 직렬화할 수 없습니다: {err}"))?;
        let temp = self.dir.join(format!("{STORE_FILE}.tmp"));
        std::fs::write(&temp, json).map_err(|err| format!("저장 파일을 쓸 수 없습니다: {err}"))?;
        std::fs::rename(&temp, self.dir.join(STORE_FILE))
            .map_err(|err| format!("저장 파일을 교체할 수 없습니다: {err}"))?;
        Ok(())
    }

    fn persist_history(&mut self) -> Result<(), String> {
        self.history_snapshot().write()
    }
}

fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn migrate_legacy_dir(base: &Path, dir: &Path) {
    for legacy_name in LEGACY_STORE_DIRS {
        let legacy = base.join(legacy_name);
        if !legacy.exists() {
            continue;
        }
        if !dir.exists() {
            if std::fs::rename(&legacy, dir).is_ok() {
                continue;
            }
            let _ = std::fs::create_dir_all(dir);
        }
        let target = dir.join(STORE_FILE);
        if !target.exists() {
            let _ = std::fs::copy(legacy.join(STORE_FILE), target);
        }
    }
}

pub fn default_dir() -> PathBuf {
    if let Some(home) = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
    {
        let dir = home.join(STORE_DIR);
        migrate_legacy_dir(&home, &dir);
        dir
    } else {
        PathBuf::from(STORE_DIR)
    }
}

pub fn connection_account(id: &str, kind: &str) -> String {
    format!("conn:{id}:{kind}")
}

#[cfg(not(target_os = "macos"))]
fn keyring_entry_for(service: &str, account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(service, account).map_err(|err| format!("키체인을 열 수 없습니다: {err}"))
}

#[cfg(not(target_os = "macos"))]
fn keyring_entry(account: &str) -> Result<keyring::Entry, String> {
    keyring_entry_for(KEYRING_SERVICE, account)
}

#[cfg(target_os = "macos")]
fn security_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(target_os = "macos")]
fn security_run(command: &str) -> Result<std::process::Output, String> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let mut child = Command::new("/usr/bin/security")
        .arg("-i")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("키체인을 열 수 없습니다: {err}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(command.as_bytes())
            .and_then(|_| stdin.write_all(b"\n"))
            .map_err(|err| format!("키체인 요청을 전달할 수 없습니다: {err}"))?;
    }
    child
        .wait_with_output()
        .map_err(|err| format!("키체인 응답을 읽을 수 없습니다: {err}"))
}

#[cfg(target_os = "macos")]
fn security_error(output: &std::process::Output, fallback: &str) -> String {
    let raw = String::from_utf8_lossy(&output.stderr);
    let line = raw.lines().next().unwrap_or("").trim();
    if line.is_empty() {
        fallback.to_string()
    } else {
        line.to_string()
    }
}

#[cfg(target_os = "macos")]
fn security_get(service: &str, account: &str) -> Option<String> {
    let command = format!(
        "find-generic-password -s {} -a {} -w",
        security_quote(service),
        security_quote(account)
    );
    let output = security_run(&command).ok()?;
    if !output.status.success() {
        return None;
    }
    let mut text = String::from_utf8(output.stdout).ok()?;
    while text.ends_with('\n') || text.ends_with('\r') {
        text.pop();
    }
    Some(text)
}

#[cfg(target_os = "macos")]
pub fn get_password(account: &str) -> Option<String> {
    if let Some(password) = security_get(KEYRING_SERVICE, account) {
        return Some(password);
    }
    for service in LEGACY_KEYRING_SERVICES {
        if let Some(password) = security_get(service, account) {
            let _ = set_password(account, &password);
            return Some(password);
        }
    }
    None
}

#[cfg(target_os = "macos")]
pub fn set_password(account: &str, password: &str) -> Result<(), String> {
    if password.contains('\n') || password.contains('\r') {
        return Err("줄바꿈이 포함된 비밀번호는 저장할 수 없습니다".into());
    }
    let command = format!(
        "add-generic-password -U -s {} -a {} -w {} -T /usr/bin/security",
        security_quote(KEYRING_SERVICE),
        security_quote(account),
        security_quote(password)
    );
    let output = security_run(&command)?;
    if !output.status.success() {
        return Err(format!(
            "비밀번호를 키체인에 저장할 수 없습니다: {}",
            security_error(&output, "알 수 없는 오류")
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
pub fn delete_password(account: &str) {
    for service in std::iter::once(KEYRING_SERVICE).chain(LEGACY_KEYRING_SERVICES) {
        let _ = std::process::Command::new("/usr/bin/security")
            .args(["delete-generic-password", "-s", service, "-a", account])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output();
    }
}

#[cfg(not(target_os = "macos"))]
pub fn get_password(account: &str) -> Option<String> {
    if let Some(password) = keyring_entry(account)
        .ok()
        .and_then(|entry| entry.get_password().ok())
    {
        return Some(password);
    }
    for service in LEGACY_KEYRING_SERVICES {
        if let Some(password) = keyring_entry_for(service, account)
            .ok()
            .and_then(|entry| entry.get_password().ok())
        {
            let _ = set_password(account, &password);
            return Some(password);
        }
    }
    None
}

#[cfg(not(target_os = "macos"))]
pub fn set_password(account: &str, password: &str) -> Result<(), String> {
    keyring_entry(account)?
        .set_password(password)
        .map_err(|err| format!("비밀번호를 키체인에 저장할 수 없습니다: {err}"))
}

#[cfg(not(target_os = "macos"))]
pub fn delete_password(account: &str) {
    for service in std::iter::once(KEYRING_SERVICE).chain(LEGACY_KEYRING_SERVICES) {
        if let Ok(entry) = keyring_entry_for(service, account) {
            let _ = entry.delete_credential();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tablepeek_types::SslMode;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "tablepeek-store-test-{}-{}-{name}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn sample_connection(id: &str) -> SavedConnection {
        let ssh = SshConfig {
            host: "bastion.internal".into(),
            port: 22,
            user: "ops".into(),
            password: Some("ssh-secret".into()),
            private_key_path: Some("/tmp/tablepeek-test-key".into()),
        };
        SavedConnection {
            id: id.into(),
            name: "운영 DB".into(),
            driver: "postgres".into(),
            postgres: Some(PostgresConfig {
                host: "db.internal".into(),
                port: 5432,
                user: "app".into(),
                password: Some("pg-secret".into()),
                database: "app".into(),
                ssl_mode: SslMode::Disable,
                ssl_root_cert: None,
                ssl_client_cert: None,
                ssl_client_key: None,
            }),
            cockroach: None,
            mysql: None,
            mssql: None,
            ssh: Some(SavedSsh::from_config(&ssh)),
            http_tunnel: None,
            persist_password: true,
            last_used: 0,
        }
    }

    fn sample_mysql_connection(id: &str) -> SavedConnection {
        SavedConnection {
            id: id.into(),
            name: "운영 MySQL".into(),
            driver: "mysql".into(),
            postgres: None,
            cockroach: None,
            mysql: Some(MySqlConfig {
                host: "mysql.internal".into(),
                port: 3306,
                user: "app".into(),
                password: Some("my-secret".into()),
                database: "app".into(),
                ssl_mode: SslMode::Disable,
                ssl_root_cert: None,
                ssl_client_cert: None,
                ssl_client_key: None,
            }),
            mssql: None,
            ssh: None,
            http_tunnel: None,
            persist_password: true,
            last_used: 0,
        }
    }

    fn sample_cockroach_connection(id: &str) -> SavedConnection {
        SavedConnection {
            id: id.into(),
            name: "운영 CockroachDB".into(),
            driver: "cockroach".into(),
            postgres: None,
            cockroach: Some(PostgresConfig {
                host: "crdb.internal".into(),
                port: 26257,
                user: "root".into(),
                password: Some("crdb-secret".into()),
                database: "defaultdb".into(),
                ssl_mode: SslMode::Disable,
                ssl_root_cert: None,
                ssl_client_cert: None,
                ssl_client_key: None,
            }),
            mysql: None,
            mssql: None,
            ssh: None,
            http_tunnel: None,
            persist_password: true,
            last_used: 0,
        }
    }

    fn sample_mssql_connection(id: &str) -> SavedConnection {
        SavedConnection {
            id: id.into(),
            name: "운영 SQL Server".into(),
            driver: "mssql".into(),
            postgres: None,
            cockroach: None,
            mysql: None,
            mssql: Some(MssqlConfig {
                host: "mssql.internal".into(),
                port: 1433,
                user: "sa".into(),
                password: Some("ms-secret".into()),
                database: "app".into(),
                encrypt: false,
            }),
            ssh: None,
            http_tunnel: None,
            persist_password: true,
            last_used: 0,
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "실제 macOS 키체인에 기록합니다"]
    fn macos_keyring_roundtrip() {
        let account = format!("test:{}", uuid::Uuid::new_v4().simple());
        let result = (|| {
            set_password(&account, "tablepeek-keyring-roundtrip")?;
            let found = get_password(&account);
            if found.as_deref() != Some("tablepeek-keyring-roundtrip") {
                return Err(format!("키체인 왕복 실패: {found:?}"));
            }
            Ok(())
        })();
        delete_password(&account);
        result.unwrap();
    }

    #[test]
    fn migrates_legacy_store_directory() {
        for legacy_name in LEGACY_STORE_DIRS {
            let base = temp_dir("legacy-dir");
            let legacy = base.join(legacy_name);
            std::fs::create_dir_all(&legacy).unwrap();
            std::fs::write(legacy.join(STORE_FILE), br#"{"connections":[]}"#).unwrap();
            let dir = base.join(STORE_DIR);

            migrate_legacy_dir(&base, &dir);

            assert!(!legacy.exists());
            assert_eq!(
                std::fs::read_to_string(dir.join(STORE_FILE)).unwrap(),
                r#"{"connections":[]}"#
            );
            std::fs::remove_dir_all(base).unwrap();
        }
    }

    #[test]
    fn roundtrip_keeps_non_secrets_only() {
        let dir = temp_dir("roundtrip");
        let mut store = StoreFile::load(&dir);
        store.add_connection(sample_connection("abc")).unwrap();
        store
            .add_connection(sample_mysql_connection("my-1"))
            .unwrap();
        store
            .add_connection(sample_cockroach_connection("cr-1"))
            .unwrap();
        store
            .add_connection(sample_mssql_connection("ms-1"))
            .unwrap();
        store
            .record_history(run("saved:abc", "SELECT 1", 100))
            .unwrap();
        store
            .record_history(run(
                "saved:abc",
                "SELECT * FROM users WHERE name = '홍길동'",
                200,
            ))
            .unwrap();
        store
            .add_favorite(FavoriteEntry {
                id: "fav-1".into(),
                name: "사용자 목록".into(),
                sql: "SELECT * FROM users".into(),
                keyword: None,
                folder: None,
                created_at: 1,
                updated_at: 1,
            })
            .unwrap();

        let raw = std::fs::read_to_string(dir.join(STORE_FILE)).unwrap();
        assert!(
            !raw.contains("pg-secret"),
            "store.json에 PG 비밀번호가 남았습니다"
        );
        assert!(
            !raw.contains("my-secret"),
            "store.json에 MySQL 비밀번호가 남았습니다"
        );
        assert!(
            !raw.contains("crdb-secret"),
            "store.json에 CockroachDB 비밀번호가 남았습니다"
        );
        assert!(
            !raw.contains("ms-secret"),
            "store.json에 SQL Server 비밀번호가 남았습니다"
        );
        assert!(
            !raw.contains("ssh-secret"),
            "store.json에 SSH 비밀번호가 남았습니다"
        );
        assert!(
            !raw.contains("\"password\""),
            "store.json에 password 필드가 남았습니다"
        );
        assert!(
            raw.contains("/tmp/tablepeek-test-key"),
            "private_key_path가 저장되지 않았습니다"
        );

        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(value["connections"][0].get("mysql").is_none());
        assert!(value["connections"][1].get("postgres").is_none());
        assert!(value["connections"][2].get("postgres").is_none());
        assert!(value["connections"][3].get("postgres").is_none());
        assert!(value["connections"][3].get("mysql").is_none());

        let reloaded = StoreFile::load(&dir);
        let connection = &reloaded.data().connections[0];
        assert_eq!(connection.name, "운영 DB");
        let postgres = connection.postgres.as_ref().unwrap();
        assert_eq!(postgres.host, "db.internal");
        assert!(postgres.password.is_none());
        assert!(connection.mysql.is_none());
        assert_eq!(
            connection.ssh.as_ref().unwrap().private_key_path.as_deref(),
            Some("/tmp/tablepeek-test-key")
        );
        assert!(connection.persist_password);

        let mysql = reloaded.data().connections[1].mysql.as_ref().unwrap();
        assert_eq!(mysql.host, "mysql.internal");
        assert_eq!(mysql.database, "app");
        assert!(mysql.password.is_none());
        assert!(reloaded.data().connections[1].postgres.is_none());

        let cockroach = reloaded.data().connections[2].cockroach.as_ref().unwrap();
        assert_eq!(cockroach.host, "crdb.internal");
        assert_eq!(cockroach.port, 26257);
        assert_eq!(cockroach.user, "root");
        assert!(cockroach.password.is_none());
        assert!(reloaded.data().connections[2].postgres.is_none());

        let mssql = reloaded.data().connections[3].mssql.as_ref().unwrap();
        assert_eq!(mssql.host, "mssql.internal");
        assert_eq!(mssql.database, "app");
        assert!(mssql.password.is_none());
        assert!(!mssql.encrypt);
        assert!(reloaded.data().connections[3].mysql.is_none());

        assert_eq!(reloaded.history("saved:abc", 10).len(), 2);
        assert_eq!(
            reloaded.history("saved:abc", 1)[0].sql,
            "SELECT * FROM users WHERE name = '홍길동'"
        );
        assert_eq!(reloaded.favorites().len(), 1);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn run(scope: &str, sql: &str, at: u64) -> HistoryEntry {
        HistoryEntry {
            id: String::new(),
            scope: scope.into(),
            sql: sql.into(),
            at,
            ms: 12,
            ok: true,
            rows: 3,
            error: None,
        }
    }

    #[test]
    fn history_is_kept_per_scope() {
        let dir = temp_dir("history-scope");
        let mut store = StoreFile::load(&dir);
        store
            .record_history(run("saved:a", "SELECT 1", 10))
            .unwrap();
        store
            .record_history(run("file:/tmp/b.db", "SELECT 2", 20))
            .unwrap();
        store
            .record_history(HistoryEntry {
                ok: false,
                rows: 0,
                error: Some("no such table: nope".into()),
                ..run("saved:a", "SELECT * FROM nope", 30)
            })
            .unwrap();

        let a = store.history("saved:a", 50);
        assert_eq!(a.len(), 2);
        assert_eq!(a[0].sql, "SELECT * FROM nope");
        assert!(!a[0].ok);
        assert_eq!(a[0].error.as_deref(), Some("no such table: nope"));
        assert_eq!(a[1].sql, "SELECT 1");
        assert_eq!(a[1].ms, 12);
        assert_eq!(a[1].rows, 3);
        assert_eq!(store.history("file:/tmp/b.db", 50).len(), 1);
        assert!(store.history("demo", 50).is_empty());

        // History lives beside store.json, not inside it.
        let raw = std::fs::read_to_string(dir.join(STORE_FILE)).unwrap_or_default();
        assert!(!raw.contains("SELECT"));
        let reloaded = StoreFile::load(&dir);
        assert_eq!(reloaded.history("saved:a", 50).len(), 2);
        assert_eq!(reloaded.history("saved:a", 1)[0].sql, "SELECT * FROM nope");

        let mut store = reloaded;
        store.clear_history("saved:a").unwrap();
        assert!(store.history("saved:a", 50).is_empty());
        assert_eq!(store.history("file:/tmp/b.db", 50).len(), 1);
        assert!(StoreFile::load(&dir).history("saved:a", 50).is_empty());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn history_caps_each_scope_and_skips_blank_sql() {
        let dir = temp_dir("history-cap");
        let mut store = StoreFile::load(&dir);
        for index in 0..(HISTORY_CAP + 5) {
            store
                .record_history(run("saved:busy", &format!("SELECT {index}"), index as u64))
                .unwrap();
        }
        store
            .record_history(run("saved:quiet", "SELECT 'q'", 1))
            .unwrap();
        let busy = store.history("saved:busy", HISTORY_CAP * 2);
        assert_eq!(busy.len(), HISTORY_CAP);
        assert_eq!(busy[0].sql, format!("SELECT {}", HISTORY_CAP + 4));
        assert_eq!(busy[HISTORY_CAP - 1].sql, "SELECT 5");
        // A busy connection never pushes out another connection's history.
        assert_eq!(store.history("saved:quiet", 10).len(), 1);

        // Running the same statement twice is two runs, both kept.
        store
            .record_history(run("saved:quiet", "SELECT 'q'", 2))
            .unwrap();
        assert_eq!(store.history("saved:quiet", 10).len(), 2);

        store.record_history(run("saved:quiet", "   ", 3)).unwrap();
        store
            .record_history(run("saved:quiet", "  SELECT 9  ", 4))
            .unwrap();
        let quiet = store.history("saved:quiet", 10);
        assert_eq!(quiet.len(), 3);
        assert_eq!(quiet[0].sql, "SELECT 9");

        let long = "x".repeat(HISTORY_SQL_CAP + 50);
        store.record_history(run("saved:quiet", &long, 5)).unwrap();
        let clipped = &store.history("saved:quiet", 1)[0].sql;
        assert_eq!(clipped.chars().count(), HISTORY_SQL_CAP + 1);
        assert!(clipped.ends_with('…'));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn safe_mode_is_kept_per_scope() {
        let dir = temp_dir("safe-mode");
        let mut store = StoreFile::load(&dir);
        assert_eq!(store.safe_mode("saved:prod"), None);
        store.set_safe_mode("saved:prod", Some(2)).unwrap();
        store.set_safe_mode("demo", Some(0)).unwrap();

        let mut store = StoreFile::load(&dir);
        assert_eq!(store.safe_mode("saved:prod"), Some(2));
        assert_eq!(store.safe_mode("demo"), Some(0));
        assert_eq!(store.safe_mode("saved:other"), None);

        store.set_safe_mode("demo", None).unwrap();
        assert_eq!(StoreFile::load(&dir).safe_mode("demo"), None);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn removing_a_connection_forgets_its_history_and_safe_mode() {
        let dir = temp_dir("forget-scope");
        let mut store = StoreFile::load(&dir);
        store.add_connection(sample_connection("gone")).unwrap();
        store.add_connection(sample_connection("kept")).unwrap();
        store
            .record_history(run(&saved_scope("gone"), "SELECT 1", 1))
            .unwrap();
        store
            .record_history(run(&saved_scope("kept"), "SELECT 2", 2))
            .unwrap();
        store.set_safe_mode(&saved_scope("gone"), Some(2)).unwrap();
        store.set_safe_mode(&saved_scope("kept"), Some(0)).unwrap();

        assert!(store.remove_connection("gone").unwrap());

        let reloaded = StoreFile::load(&dir);
        assert!(reloaded.history(&saved_scope("gone"), 10).is_empty());
        assert_eq!(reloaded.safe_mode(&saved_scope("gone")), None);
        assert_eq!(reloaded.history(&saved_scope("kept"), 10).len(), 1);
        assert_eq!(reloaded.safe_mode(&saved_scope("kept")), Some(0));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn session_scopes_are_forgotten_on_load() {
        let dir = temp_dir("session-scope");
        let mut store = StoreFile::load(&dir);
        store
            .record_history(run("session:abc", "SELECT 1", 1))
            .unwrap();
        store.record_history(run("demo", "SELECT 2", 2)).unwrap();
        store.set_safe_mode("session:abc", Some(0)).unwrap();
        store.set_safe_mode("demo", Some(2)).unwrap();

        // A new server never sees that session's slot again.
        let reloaded = StoreFile::load(&dir);
        assert!(reloaded.history("session:abc", 10).is_empty());
        assert_eq!(reloaded.safe_mode("session:abc"), None);
        assert_eq!(reloaded.history("demo", 10).len(), 1);
        assert_eq!(reloaded.safe_mode("demo"), Some(2));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn scope_exists_only_for_live_saved_profiles() {
        let dir = temp_dir("scope-exists");
        let mut store = StoreFile::load(&dir);
        store.add_connection(sample_connection("kept")).unwrap();
        assert!(store.scope_exists(&saved_scope("kept")));
        assert!(!store.scope_exists(&saved_scope("gone")));
        assert!(store.scope_exists("demo"));
        assert!(store.scope_exists("file:/tmp/a.db"));
        assert!(store.scope_exists("session:abc"));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn history_file_is_private_to_the_user() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir("history-mode");
        let mut store = StoreFile::load(&dir);
        store.record_history(run("demo", "SELECT 1", 1)).unwrap();
        let mode = std::fs::metadata(dir.join(HISTORY_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn legacy_global_history_is_dropped_without_losing_connections() {
        let dir = temp_dir("legacy-history");
        std::fs::write(
            dir.join(STORE_FILE),
            r#"{"connections":[],"history":[{"sql":"SELECT 1","at":5}],"favorites":[]}"#,
        )
        .unwrap();
        let mut store = StoreFile::load(&dir);
        store.add_connection(sample_connection("one")).unwrap();
        let raw = std::fs::read_to_string(dir.join(STORE_FILE)).unwrap();
        assert!(!raw.contains("\"history\""));
        assert_eq!(StoreFile::load(&dir).data().connections.len(), 1);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn history_entries_get_ids_and_can_be_removed_one_by_one() {
        let dir = temp_dir("history-ids");
        let mut store = StoreFile::load(&dir);
        store.record_history(run("saved:a", "SELECT 1", 1)).unwrap();
        store.record_history(run("saved:a", "SELECT 2", 2)).unwrap();
        store.record_history(run("saved:b", "SELECT 3", 3)).unwrap();
        let a = store.history("saved:a", 10);
        assert!(a.iter().all(|entry| entry.id.len() == 32));
        assert_ne!(a[0].id, a[1].id);
        // Ids survive a reload.
        assert_eq!(StoreFile::load(&dir).history("saved:a", 10)[0].id, a[0].id);

        // Another scope's entry is out of reach even with its id.
        let b_id = store.history("saved:b", 1)[0].id.clone();
        assert!(!store.remove_history("saved:a", &b_id).unwrap());
        assert!(store.remove_history("saved:a", &a[1].id).unwrap());
        assert!(!store.remove_history("saved:a", &a[1].id).unwrap());
        let reloaded = StoreFile::load(&dir);
        let left = reloaded.history("saved:a", 10);
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].sql, "SELECT 2");
        assert_eq!(reloaded.history("saved:b", 10).len(), 1);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_late_older_snapshot_never_replaces_a_newer_one() {
        let dir = temp_dir("history-snapshots");
        let mut store = StoreFile::load(&dir);
        assert!(store.add_history(run("demo", "SELECT 1", 1)));
        assert!(!store.add_history(run("demo", "  ", 2)));
        let older = store.history_snapshot();
        assert!(store.add_history(run("demo", "SELECT 2", 3)));
        let newer = store.history_snapshot();
        newer.write().unwrap();
        older.write().unwrap();
        let sqls: Vec<String> = StoreFile::load(&dir)
            .history("demo", 10)
            .into_iter()
            .map(|entry| entry.sql)
            .collect();
        assert_eq!(sqls, vec!["SELECT 2", "SELECT 1"]);

        store.forget_history("demo");
        assert!(store.history("demo", 10).is_empty());
        store.history_snapshot().write().unwrap();
        assert!(StoreFile::load(&dir).history("demo", 10).is_empty());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn legacy_history_and_favorites_are_filled_in_once() {
        let dir = temp_dir("legacy-ids");
        std::fs::write(
            dir.join(HISTORY_FILE),
            r#"[{"scope":"demo","sql":"SELECT 1","at":5,"ms":1,"ok":true,"rows":1}]"#,
        )
        .unwrap();
        std::fs::write(
            dir.join(STORE_FILE),
            r#"{"connections":[],"favorites":[{"id":"f1","name":"전체","sql":"SELECT 1","keyword":null}]}"#,
        )
        .unwrap();
        let store = StoreFile::load(&dir);
        let id = store.history("demo", 1)[0].id.clone();
        assert_eq!(id.len(), 32);
        let favorite = &store.favorites()[0];
        assert!(favorite.created_at > 0);
        assert_eq!(favorite.updated_at, favorite.created_at);
        assert_eq!(favorite.folder, None);
        assert!(store.folders().is_empty());

        // Written back, so the next load sees the same values.
        let again = StoreFile::load(&dir);
        assert_eq!(again.history("demo", 1)[0].id, id);
        assert_eq!(again.favorites()[0].created_at, favorite.created_at);
        let raw = std::fs::read_to_string(dir.join(STORE_FILE)).unwrap();
        assert!(!raw.contains("favorite_folders"));

        std::fs::remove_dir_all(&dir).unwrap();
    }

    fn favorite(id: &str, folder: Option<&str>) -> FavoriteEntry {
        FavoriteEntry {
            id: id.into(),
            name: format!("query {id}"),
            sql: "SELECT 1".into(),
            keyword: None,
            folder: folder.map(str::to_string),
            created_at: 10,
            updated_at: 10,
        }
    }

    #[test]
    fn favorites_update_only_what_is_sent() {
        let dir = temp_dir("favorite-update");
        let mut store = StoreFile::load(&dir);
        store
            .add_folder(FavoriteFolder {
                id: "dir".into(),
                name: "Reports".into(),
                created_at: 1,
            })
            .unwrap();
        store.add_favorite(favorite("q", None)).unwrap();

        // A pure folder move keeps updated_at.
        let moved = store
            .update_favorite(
                "q",
                FavoritePatch {
                    folder: Some(Some("dir".into())),
                    ..Default::default()
                },
                20,
            )
            .unwrap()
            .unwrap();
        assert_eq!(moved.folder.as_deref(), Some("dir"));
        assert_eq!(moved.updated_at, 10);

        // Sending what is already there changes nothing either.
        let same = store
            .update_favorite(
                "q",
                FavoritePatch {
                    sql: Some("SELECT 1".into()),
                    ..Default::default()
                },
                30,
            )
            .unwrap()
            .unwrap();
        assert_eq!(same.updated_at, 10);

        let edited = store
            .update_favorite(
                "q",
                FavoritePatch {
                    name: Some("Daily".into()),
                    keyword: Some(Some("daily".into())),
                    ..Default::default()
                },
                40,
            )
            .unwrap()
            .unwrap();
        assert_eq!(edited.name, "Daily");
        assert_eq!(edited.keyword.as_deref(), Some("daily"));
        assert_eq!(edited.sql, "SELECT 1");
        assert_eq!(edited.updated_at, 40);
        assert_eq!(edited.created_at, 10);

        let cleared = store
            .update_favorite(
                "q",
                FavoritePatch {
                    keyword: Some(None),
                    folder: Some(None),
                    ..Default::default()
                },
                50,
            )
            .unwrap()
            .unwrap();
        assert_eq!(cleared.keyword, None);
        assert_eq!(cleared.folder, None);
        assert_eq!(cleared.updated_at, 50);

        assert!(store
            .update_favorite("missing", FavoritePatch::default(), 60)
            .unwrap()
            .is_none());
        let reloaded = StoreFile::load(&dir);
        assert_eq!(reloaded.favorites()[0].name, "Daily");
        assert_eq!(reloaded.favorites()[0].updated_at, 50);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn removing_a_folder_removes_its_queries() {
        let dir = temp_dir("favorite-folders");
        let mut store = StoreFile::load(&dir);
        for id in ["a", "b"] {
            store
                .add_folder(FavoriteFolder {
                    id: id.into(),
                    name: format!("folder {id}"),
                    created_at: 1,
                })
                .unwrap();
        }
        store.add_favorite(favorite("in-a", Some("a"))).unwrap();
        store.add_favorite(favorite("in-b", Some("b"))).unwrap();
        store.add_favorite(favorite("top", None)).unwrap();
        assert!(store.has_folder("a"));

        assert!(store.rename_folder("a", "Renamed".into()).unwrap());
        assert!(!store.rename_folder("missing", "x".into()).unwrap());
        assert!(store.remove_folder("a").unwrap());
        assert!(!store.remove_folder("a").unwrap());

        let reloaded = StoreFile::load(&dir);
        let folders = reloaded.folders();
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].id, "b");
        let ids: Vec<String> = reloaded.favorites().into_iter().map(|f| f.id).collect();
        assert_eq!(ids, vec!["in-b", "top"]);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn connections_and_favorites_crud() {
        let dir = temp_dir("crud");
        let mut store = StoreFile::load(&dir);
        store.add_connection(sample_connection("one")).unwrap();
        store.add_connection(sample_connection("two")).unwrap();
        store.add_connection(sample_connection("one")).unwrap();
        assert_eq!(store.data().connections.len(), 2);
        assert!(store.find_connection("two").is_some());

        assert!(store.remove_connection("two").unwrap());
        assert!(!store.remove_connection("two").unwrap());
        assert_eq!(store.data().connections.len(), 1);

        store
            .add_favorite(FavoriteEntry {
                id: "fav-1".into(),
                name: "전체".into(),
                sql: "SELECT 1".into(),
                keyword: None,
                folder: None,
                created_at: 1,
                updated_at: 1,
            })
            .unwrap();
        assert!(store.remove_favorite("fav-1").unwrap());
        assert!(!store.remove_favorite("fav-1").unwrap());

        store.touch_connection("one", 42).unwrap();
        assert_eq!(store.find_connection("one").unwrap().last_used, 42);
        assert!(!store.touch_connection("missing", 10).unwrap());
        store.touch_connection("one", 7).unwrap();
        assert_eq!(store.find_connection("one").unwrap().last_used, 42);

        let reloaded = StoreFile::load(&dir);
        assert_eq!(reloaded.data().connections.len(), 1);
        assert_eq!(reloaded.data().connections[0].id, "one");
        assert_eq!(reloaded.data().connections[0].last_used, 42);
        assert!(reloaded.favorites().is_empty());

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
