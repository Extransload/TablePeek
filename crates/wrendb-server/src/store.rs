use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use wrendb_types::{HttpTunnelConfig, MssqlConfig, MySqlConfig, PostgresConfig, SshConfig};

pub const HISTORY_CAP: usize = 100;
const KEYRING_SERVICE: &str = "wrendb";
const LEGACY_KEYRING_SERVICE: &str = "prodb";
const STORE_FILE: &str = "store.json";
const STORE_DIR: &str = ".wrendb";
const LEGACY_STORE_DIR: &str = ".prodb";

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

    pub fn add_connection(&mut self, mut connection: SavedConnection) -> Result<(), String> {
        if let Some(existing) = self
            .data
            .connections
            .iter()
            .find(|existing| existing.id == connection.id)
        {
            connection.last_used = connection.last_used.max(existing.last_used);
        }
        self.data
            .connections
            .retain(|existing| existing.id != connection.id);
        self.data.connections.push(connection);
        self.persist()
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
    let legacy = base.join(LEGACY_STORE_DIR);
    if !legacy.exists() {
        return;
    }
    if !dir.exists() {
        if std::fs::rename(&legacy, dir).is_ok() {
            return;
        }
        let _ = std::fs::create_dir_all(dir);
    }
    let target = dir.join(STORE_FILE);
    if !target.exists() {
        let _ = std::fs::copy(legacy.join(STORE_FILE), target);
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
    let password = security_get(LEGACY_KEYRING_SERVICE, account)?;
    let _ = set_password(account, &password);
    Some(password)
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
    for service in [KEYRING_SERVICE, LEGACY_KEYRING_SERVICE] {
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
    let password = keyring_entry_for(LEGACY_KEYRING_SERVICE, account)
        .ok()
        .and_then(|entry| entry.get_password().ok())?;
    let _ = set_password(account, &password);
    Some(password)
}

#[cfg(not(target_os = "macos"))]
pub fn set_password(account: &str, password: &str) -> Result<(), String> {
    keyring_entry(account)?
        .set_password(password)
        .map_err(|err| format!("비밀번호를 키체인에 저장할 수 없습니다: {err}"))
}

#[cfg(not(target_os = "macos"))]
pub fn delete_password(account: &str) {
    for service in [KEYRING_SERVICE, LEGACY_KEYRING_SERVICE] {
        if let Ok(entry) = keyring_entry_for(service, account) {
            let _ = entry.delete_credential();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wrendb_types::SslMode;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "wrendb-store-test-{}-{}-{name}",
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
            private_key_path: Some("/tmp/wrendb-test-key".into()),
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
            set_password(&account, "wrendb-keyring-roundtrip")?;
            let found = get_password(&account);
            if found.as_deref() != Some("wrendb-keyring-roundtrip") {
                return Err(format!("키체인 왕복 실패: {found:?}"));
            }
            Ok(())
        })();
        delete_password(&account);
        result.unwrap();
    }

    #[test]
    fn migrates_legacy_store_directory() {
        let base = temp_dir("legacy-dir");
        let legacy = base.join(LEGACY_STORE_DIR);
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
            raw.contains("/tmp/wrendb-test-key"),
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
            Some("/tmp/wrendb-test-key")
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
