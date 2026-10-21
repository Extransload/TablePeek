use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tablepeek_types::{HttpTunnelConfig, MssqlConfig, MySqlConfig, PostgresConfig, SshConfig};

pub const HISTORY_CAP: usize = 100;
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
    // Set by older versions that kept this profile's passwords in the keychain;
    // cleared (and the entries removed) by forget_saved_passwords.
    #[serde(default)]
    pub persist_password: bool,
    #[serde(default)]
    pub last_used: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryEntry {
    pub sql: String,
    pub at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FavoriteEntry {
    pub id: String,
    pub name: String,
    pub sql: String,
    #[serde(default)]
    pub keyword: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct StoreData {
    #[serde(default)]
    pub connections: Vec<SavedConnection>,
    #[serde(default)]
    pub history: Vec<HistoryEntry>,
    #[serde(default)]
    pub favorites: Vec<FavoriteEntry>,
    // The one-time sweep of passwords older versions left in the keychain has run.
    #[serde(default)]
    pub keychain_swept: bool,
}

pub struct StoreFile {
    dir: PathBuf,
    data: StoreData,
}

impl StoreFile {
    pub fn load(dir: &Path) -> Self {
        let data = std::fs::read(dir.join(STORE_FILE))
            .ok()
            .and_then(|bytes| serde_json::from_slice::<StoreData>(&bytes).ok())
            .unwrap_or_default();
        Self {
            dir: dir.to_path_buf(),
            data,
        }
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
        self.persist()?;
        Ok(true)
    }

    /// Passwords are no longer kept. Profiles an older version saved them for get
    /// their keychain entries removed (through `delete`, given each account) and
    /// the flag cleared, once. Returns how many profiles that touched.
    pub fn forget_saved_passwords(
        &mut self,
        mut delete: impl FnMut(&str),
    ) -> Result<usize, String> {
        let mut touched = 0;
        for connection in self
            .data
            .connections
            .iter_mut()
            .filter(|connection| connection.persist_password)
        {
            for kind in SECRET_KINDS {
                delete(&connection_account(&connection.id, kind));
            }
            connection.persist_password = false;
            touched += 1;
        }
        if touched > 0 {
            self.persist()?;
        }
        Ok(touched)
    }

    /// Removes, once, every keychain item older versions wrote under TablePeek's
    /// service names, including ones whose profile is long gone. `first_account`
    /// names an item left in a service (None when it is empty); `delete` removes
    /// one and says whether it did. An account TablePeek never writes stops that
    /// service's sweep untouched. Returns how many items went.
    pub fn sweep_keychain_once(
        &mut self,
        mut first_account: impl FnMut(&str) -> Option<String>,
        mut delete: impl FnMut(&str, &str) -> bool,
    ) -> Result<usize, String> {
        if self.data.keychain_swept {
            return Ok(0);
        }
        let mut removed = 0;
        for service in std::iter::once(KEYRING_SERVICE).chain(LEGACY_KEYRING_SERVICES) {
            for _ in 0..SWEEP_LIMIT {
                let Some(account) = first_account(service) else {
                    break;
                };
                let own = OWN_ACCOUNT_PREFIXES
                    .iter()
                    .any(|prefix| account.starts_with(prefix));
                if !own || !delete(service, &account) {
                    break;
                }
                removed += 1;
            }
        }
        self.data.keychain_swept = true;
        self.persist()?;
        Ok(removed)
    }

    pub fn find_connection(&self, id: &str) -> Option<&SavedConnection> {
        self.data
            .connections
            .iter()
            .find(|connection| connection.id == id)
    }

    pub fn record_history(&mut self, sql: &str, at: u64) -> Result<(), String> {
        let sql = sql.trim();
        if sql.is_empty() {
            return Ok(());
        }
        if let Some(newest) = self.data.history.first_mut() {
            if newest.sql == sql {
                newest.at = at;
                return self.persist();
            }
        }
        self.data.history.insert(
            0,
            HistoryEntry {
                sql: sql.to_string(),
                at,
            },
        );
        self.data.history.truncate(HISTORY_CAP);
        self.persist()
    }

    pub fn history(&self, limit: usize) -> Vec<HistoryEntry> {
        self.data.history.iter().take(limit).cloned().collect()
    }

    pub fn clear_history(&mut self) -> Result<(), String> {
        self.data.history.clear();
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

// Every keychain account an older version could have written for a profile.
const SECRET_KINDS: [&str; 6] = ["postgres", "cockroach", "mysql", "mssql", "ssh", "http"];
// Accounts TablePeek ever wrote: profiles ("conn:…") and its keychain test ("test:…").
const OWN_ACCOUNT_PREFIXES: [&str; 2] = ["conn:", "test:"];
// More than any real keychain holds; keeps a misbehaving lookup from looping forever.
const SWEEP_LIMIT: usize = 10_000;

// Passwords are never stored now; these only remove what older versions left
// in the keychain (under the current and legacy service names).

// /usr/bin/security, given up on after a few seconds: a keychain that wants a
// dialog answered must not hold up the server.
#[cfg(target_os = "macos")]
fn security(args: &[&str]) -> Option<std::process::Output> {
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    let mut child = Command::new("/usr/bin/security")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return child.wait_with_output().ok(),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

#[cfg(target_os = "macos")]
pub fn delete_password(account: &str) {
    for service in std::iter::once(KEYRING_SERVICE).chain(LEGACY_KEYRING_SERVICES) {
        let _ = security(&["delete-generic-password", "-s", service, "-a", account]);
    }
}

/// One account left under `service`, read from the item's attributes (never its secret).
#[cfg(target_os = "macos")]
pub fn first_keychain_account(service: &str) -> Option<String> {
    let output = security(&["find-generic-password", "-s", service])?;
    if !output.status.success() {
        return None;
    }
    account_from_attributes(&String::from_utf8_lossy(&output.stdout))
}

// The account in `security find-generic-password` attributes: `"acct"<blob>="conn:…"`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn account_from_attributes(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let value = line.trim().strip_prefix("\"acct\"<blob>=\"")?;
        value.strip_suffix('"').map(str::to_string)
    })
}

#[cfg(target_os = "macos")]
pub fn delete_keychain_item(service: &str, account: &str) -> bool {
    security(&["delete-generic-password", "-s", service, "-a", account])
        .is_some_and(|output| output.status.success())
}

// Other platforms' keychains can't be listed: only per-profile cleanup there.
#[cfg(not(target_os = "macos"))]
pub fn first_keychain_account(_service: &str) -> Option<String> {
    None
}

#[cfg(not(target_os = "macos"))]
pub fn delete_keychain_item(_service: &str, _account: &str) -> bool {
    false
}

#[cfg(not(target_os = "macos"))]
pub fn delete_password(account: &str) {
    for service in std::iter::once(KEYRING_SERVICE).chain(LEGACY_KEYRING_SERVICES) {
        if let Ok(entry) = keyring::Entry::new(service, account) {
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

    #[test]
    fn forget_saved_passwords_clears_each_profile_once() {
        let dir = temp_dir("forget");
        let mut store = StoreFile::load(&dir);
        store.add_connection(sample_connection("kept")).unwrap();
        let mut typed = sample_mysql_connection("typed");
        typed.persist_password = false;
        store.add_connection(typed).unwrap();

        let mut deleted = Vec::new();
        let touched = store
            .forget_saved_passwords(|account| deleted.push(account.to_string()))
            .unwrap();
        assert_eq!(touched, 1);
        for kind in ["postgres", "cockroach", "mysql", "mssql", "ssh", "http"] {
            assert!(
                deleted.contains(&connection_account("kept", kind)),
                "{kind}"
            );
        }
        assert!(
            deleted
                .iter()
                .all(|account| account.starts_with("conn:kept:")),
            "{deleted:?}"
        );

        let mut reloaded = StoreFile::load(&dir);
        assert!(reloaded
            .data()
            .connections
            .iter()
            .all(|connection| !connection.persist_password));
        let mut again = Vec::new();
        assert_eq!(
            reloaded
                .forget_saved_passwords(|account| again.push(account.to_string()))
                .unwrap(),
            0
        );
        assert!(again.is_empty(), "nothing left to forget");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn sweep_keychain_once_removes_only_tablepeek_accounts() {
        use std::collections::HashMap;
        let dir = temp_dir("sweep");
        let mut store = StoreFile::load(&dir);
        // A fake keychain: service -> accounts, in lookup order.
        let mut keychain: HashMap<&str, Vec<String>> = HashMap::from([
            (
                "tablepeek",
                vec![
                    "conn:gone:mysql".into(),
                    "conn:gone:ssh".into(),
                    "test:abc".into(),
                ],
            ),
            (
                "wrendb",
                vec![
                    "conn:old:postgres".into(),
                    "someone-else".into(),
                    "conn:after:http".into(),
                ],
            ),
            ("prodb", vec![]),
            ("unrelated", vec!["conn:x:mysql".into()]),
        ]);
        let mut deleted = Vec::new();
        let removed = {
            let keychain = std::cell::RefCell::new(&mut keychain);
            store
                .sweep_keychain_once(
                    |service| {
                        keychain
                            .borrow()
                            .get(service)
                            .and_then(|accounts| accounts.first().cloned())
                    },
                    |service, account| {
                        deleted.push(format!("{service}/{account}"));
                        let mut keychain = keychain.borrow_mut();
                        let accounts = keychain.get_mut(service).unwrap();
                        accounts.retain(|item| item != account);
                        true
                    },
                )
                .unwrap()
        };
        assert_eq!(removed, 4);
        assert_eq!(
            deleted,
            [
                "tablepeek/conn:gone:mysql",
                "tablepeek/conn:gone:ssh",
                "tablepeek/test:abc",
                "wrendb/conn:old:postgres"
            ]
        );
        assert_eq!(
            keychain["wrendb"],
            ["someone-else", "conn:after:http"],
            "stops at an account it didn't write"
        );
        assert_eq!(
            keychain["unrelated"].len(),
            1,
            "other services are never touched"
        );

        let mut again = 0;
        let mut reloaded = StoreFile::load(&dir);
        assert_eq!(
            reloaded
                .sweep_keychain_once(
                    |_| {
                        again += 1;
                        None
                    },
                    |_, _| true
                )
                .unwrap(),
            0
        );
        assert_eq!(again, 0, "runs once");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn account_is_read_from_security_attributes() {
        let attributes = "keychain: \"/Users/u/Library/Keychains/login.keychain-db\"\nclass: \"genp\"\nattributes:\n    0x00000007 <blob>=\"tablepeek\"\n    \"acct\"<blob>=\"conn:abc123:mysql\"\n    \"svce\"<blob>=\"tablepeek\"\n";
        assert_eq!(
            account_from_attributes(attributes).as_deref(),
            Some("conn:abc123:mysql")
        );
        assert_eq!(account_from_attributes("    \"acct\"<blob>=<NULL>\n"), None);
        assert_eq!(account_from_attributes(""), None);
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
        store.record_history("SELECT 1", 100).unwrap();
        store
            .record_history("SELECT * FROM users WHERE name = '홍길동'", 200)
            .unwrap();
        store
            .add_favorite(FavoriteEntry {
                id: "fav-1".into(),
                name: "사용자 목록".into(),
                sql: "SELECT * FROM users".into(),
                keyword: None,
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

        assert_eq!(reloaded.history(10).len(), 2);
        assert_eq!(
            reloaded.history(1)[0].sql,
            "SELECT * FROM users WHERE name = '홍길동'"
        );
        assert_eq!(reloaded.favorites().len(), 1);

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn history_dedupes_consecutive_and_caps() {
        let dir = temp_dir("history");
        let mut store = StoreFile::load(&dir);
        for index in 0..(HISTORY_CAP + 20) {
            store
                .record_history(&format!("SELECT {index}"), index as u64)
                .unwrap();
        }
        assert_eq!(store.history(HISTORY_CAP * 2).len(), HISTORY_CAP);
        let newest = HISTORY_CAP + 19;
        assert_eq!(store.history(2)[0].sql, format!("SELECT {newest}"));

        store
            .record_history(&format!("SELECT {newest}"), 999)
            .unwrap();
        assert_eq!(store.history(HISTORY_CAP * 2).len(), HISTORY_CAP);
        assert_eq!(store.history(1)[0].at, 999);

        store.record_history("   ", 1000).unwrap();
        assert_eq!(store.history(1)[0].at, 999);

        store.record_history("  SELECT 1  ", 1001).unwrap();
        assert_eq!(store.history(1)[0].sql, "SELECT 1");

        let reloaded = StoreFile::load(&dir);
        assert_eq!(reloaded.history(1)[0].sql, "SELECT 1");
        assert_eq!(reloaded.history(1)[0].at, 1001);

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
            })
            .unwrap();
        assert!(store.remove_favorite("fav-1").unwrap());
        assert!(!store.remove_favorite("fav-1").unwrap());

        store.clear_history().unwrap();

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
