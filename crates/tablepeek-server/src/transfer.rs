//! Moving saved connections between machines: the encrypted ".tablepeek" file
//! that "export connections" writes and "import" reads.
//!
//! The file is a small JSON envelope around one AES-256-GCM ciphertext whose key
//! comes from the file password through Argon2id. Everything that identifies a
//! connection (names, hosts, users, and passwords when included) is inside the
//! ciphertext; the envelope only says how to open it, and is itself
//! authenticated, so a changed parameter fails like a wrong password.

use std::collections::HashSet;

use aes_gcm::aead::{Aead, KeyInit, Nonce, Payload};
use aes_gcm::Aes256Gcm;
use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tablepeek_types::ConnectRequest;

use crate::store::SavedConnection;

pub const FORMAT: &str = "tablepeek-connections";
pub const VERSION: u32 = 1;
pub const MIN_PASSPHRASE_CHARS: usize = 8;

/// Argon2id cost, kept in the file so it can be raised later without breaking old files.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct KdfParams {
    pub m_kib: u32,
    pub t: u32,
    pub p: u32,
}

pub const DEFAULT_KDF: KdfParams = KdfParams {
    m_kib: 64 * 1024,
    t: 3,
    p: 1,
};

const KDF_NAME: &str = "argon2id";
const CIPHER: &str = "aes-256-gcm";
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
// Opening never spends more than this, whatever a file asks for.
const MAX_M_KIB: u32 = 256 * 1024;
const MAX_T: u32 = 16;
const MAX_P: u32 = 8;

#[derive(Serialize, Deserialize)]
struct Envelope {
    format: String,
    version: u32,
    kdf: KdfHeader,
    cipher: String,
    nonce: String,
    data: String,
}

#[derive(Serialize, Deserialize)]
struct KdfHeader {
    name: String,
    m_kib: u32,
    t: u32,
    p: u32,
    salt: String,
}

impl KdfHeader {
    fn params(&self) -> KdfParams {
        KdfParams {
            m_kib: self.m_kib,
            t: self.t,
            p: self.p,
        }
    }
}

// Everything in the envelope but the ciphertext, bound to it as associated data.
fn associated_data(version: u32, kdf: &KdfHeader, cipher: &str, nonce: &str) -> Vec<u8> {
    format!(
        "{FORMAT}\n{version}\n{}\n{}\n{}\n{}\n{}\n{cipher}\n{nonce}",
        kdf.name, kdf.m_kib, kdf.t, kdf.p, kdf.salt
    )
    .into_bytes()
}

fn derive_key(passphrase: &str, salt: &[u8], kdf: KdfParams) -> Result<Aes256Gcm, String> {
    let params = Params::new(kdf.m_kib, kdf.t, kdf.p, Some(32)).map_err(|err| err.to_string())?;
    let mut key = [0u8; 32];
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|err| err.to_string())?;
    Aes256Gcm::new_from_slice(&key).map_err(|err| err.to_string())
}

#[derive(Debug, PartialEq, Eq)]
pub enum OpenError {
    /// Not a TablePeek connections file at all.
    NotConnectionsFile,
    /// A newer or unknown version, cipher, or out-of-range cost.
    Unsupported(String),
    /// Wrong password, or the file was changed after it was written.
    WrongPassphraseOrDamaged,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct BundleGroup {
    pub name: String,
    #[serde(default)]
    pub color: String,
}

/// One connection inside the file. `connect` has the shape of a connect
/// request, passwords included when the export asked for them.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BundleConnection {
    pub name: String,
    pub connect: Value,
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub tags: Vec<String>,
    /// Group name, or "" for none.
    #[serde(default)]
    pub group: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Bundle {
    #[serde(default)]
    pub groups: Vec<BundleGroup>,
    #[serde(default)]
    pub connections: Vec<BundleConnection>,
}

/// What the page keeps about a connection (it lives in the browser, not the store).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ExportMeta {
    #[serde(default)]
    pub color: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub group: String,
}

/// A connection ready to save: final name, request with any passwords, and
/// whether those passwords should go to the keychain.
#[derive(Debug)]
pub struct ImportItem {
    pub name: String,
    pub connect: ConnectRequest,
    pub persist_password: bool,
    pub color: String,
    pub tags: Vec<String>,
    pub group: String,
}

pub fn seal(plaintext: &[u8], passphrase: &str, kdf: KdfParams) -> Result<String, String> {
    let mut salt = [0u8; SALT_LEN];
    let mut nonce = [0u8; NONCE_LEN];
    getrandom::fill(&mut salt)
        .and_then(|_| getrandom::fill(&mut nonce))
        .map_err(|err| format!("난수를 만들 수 없습니다: {err}"))?;
    let cipher = derive_key(passphrase, &salt, kdf)?;
    let header = KdfHeader {
        name: KDF_NAME.into(),
        m_kib: kdf.m_kib,
        t: kdf.t,
        p: kdf.p,
        salt: B64.encode(salt),
    };
    let nonce_text = B64.encode(nonce);
    let aad = associated_data(VERSION, &header, CIPHER, &nonce_text);
    let data = cipher
        .encrypt(
            &Nonce::<Aes256Gcm>::from(nonce),
            Payload {
                msg: plaintext,
                aad: &aad,
            },
        )
        .map_err(|_| "연결 파일을 암호화하지 못했습니다".to_string())?;
    serde_json::to_string_pretty(&Envelope {
        format: FORMAT.into(),
        version: VERSION,
        kdf: header,
        cipher: CIPHER.into(),
        nonce: nonce_text,
        data: B64.encode(data),
    })
    .map_err(|err| err.to_string())
}

pub fn open(file: &str, passphrase: &str) -> Result<Vec<u8>, OpenError> {
    let value: Value = serde_json::from_str(file).map_err(|_| OpenError::NotConnectionsFile)?;
    if value.get("format").and_then(Value::as_str) != Some(FORMAT) {
        return Err(OpenError::NotConnectionsFile);
    }
    let version = value.get("version").and_then(Value::as_u64);
    if version != Some(u64::from(VERSION)) {
        return Err(OpenError::Unsupported(
            "지원하지 않는 연결 파일 버전입니다".into(),
        ));
    }
    let envelope: Envelope =
        serde_json::from_value(value).map_err(|_| OpenError::WrongPassphraseOrDamaged)?;
    if envelope.kdf.name != KDF_NAME || envelope.cipher != CIPHER {
        return Err(OpenError::Unsupported(
            "지원하지 않는 암호화 방식입니다".into(),
        ));
    }
    let out_of_range =
        || OpenError::Unsupported("연결 파일의 암호화 설정이 허용 범위를 벗어났습니다".into());
    let kdf = envelope.kdf.params();
    if kdf.m_kib > MAX_M_KIB || kdf.t == 0 || kdf.t > MAX_T || kdf.p == 0 || kdf.p > MAX_P {
        return Err(out_of_range());
    }
    let decode = |text: &str| {
        B64.decode(text)
            .map_err(|_| OpenError::WrongPassphraseOrDamaged)
    };
    let salt = decode(&envelope.kdf.salt)?;
    let nonce_bytes = decode(&envelope.nonce)?;
    let data = decode(&envelope.data)?;
    if salt.len() != SALT_LEN {
        return Err(OpenError::WrongPassphraseOrDamaged);
    }
    let nonce = <&Nonce<Aes256Gcm>>::try_from(nonce_bytes.as_slice())
        .map_err(|_| OpenError::WrongPassphraseOrDamaged)?;
    let cipher = derive_key(passphrase, &salt, kdf).map_err(|_| out_of_range())?;
    let aad = associated_data(
        envelope.version,
        &envelope.kdf,
        &envelope.cipher,
        &envelope.nonce,
    );
    cipher
        .decrypt(
            nonce,
            Payload {
                msg: &data,
                aad: &aad,
            },
        )
        .map_err(|_| OpenError::WrongPassphraseOrDamaged)
}

/// The `connect` value for a saved profile, in the new shape (`{ driver,
/// config, ssh?, http_tunnel? }`). `secret(kind)` is asked for each of the
/// engine's secrets by its keychain kind (the driver's id for the password),
/// "ssh" and "http"; None leaves it out.
pub fn export_connect(saved: &SavedConnection, secret: impl Fn(&str) -> Option<String>) -> Value {
    let secret = |kind: &str| secret(kind).filter(|value| !value.is_empty());
    // A connection string never carries its password into a file: the
    // engine's password field does, when asked for.
    let mut config = match tablepeek_engine::registry::factory(&saved.driver) {
        Some(factory) => factory.descriptor().without_uri_passwords(&saved.config),
        None => saved.config.clone(),
    };
    for (key, kind) in crate::driver_secret_kinds(&saved.driver) {
        if let Some(value) = secret(&kind) {
            config.insert(key, json!(value));
        }
    }
    let mut connect = json!({ "driver": saved.driver, "config": config });
    if let Some(Ok(mut ssh)) = saved.ssh.as_ref().map(serde_json::to_value) {
        if let Some(password) = secret("ssh") {
            ssh["password"] = json!(password);
        }
        connect["ssh"] = ssh;
    }
    if let Some(Ok(mut tunnel)) = saved.http_tunnel.as_ref().map(serde_json::to_value) {
        if let Some(password) = secret("http") {
            tunnel["password"] = json!(password);
        }
        connect["http_tunnel"] = tunnel;
    }
    connect
}

/// "name", or "name (label)", "name (label 2)", … when the name is taken.
pub fn unique_name(name: &str, taken: &HashSet<String>, label: &str) -> String {
    if !taken.contains(name) {
        return name.to_string();
    }
    let first = format!("{name} ({label})");
    if !taken.contains(&first) {
        return first;
    }
    (2..)
        .map(|n| format!("{name} ({label} {n})"))
        .find(|candidate| !taken.contains(candidate))
        .unwrap_or(first)
}

pub fn is_hex_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value[1..].chars().all(|ch| ch.is_ascii_hexdigit())
}

/// Checks every connection before any is saved and names them against `taken`.
/// The error names the first bad connection (1-based).
pub fn prepare_import(
    connections: Vec<BundleConnection>,
    taken: &HashSet<String>,
    label: &str,
) -> Result<Vec<ImportItem>, String> {
    let mut names = taken.clone();
    let mut items = Vec::with_capacity(connections.len());
    for (index, entry) in connections.into_iter().enumerate() {
        let problem = |message: &str| format!("{}번째 연결: {message}", index + 1);
        let name = entry.name.trim();
        if name.is_empty() {
            return Err(problem("이름이 없습니다"));
        }
        let connect: ConnectRequest = serde_json::from_value(entry.connect)
            .map_err(|err| problem(&format!("접속 정보가 올바르지 않습니다 ({err})")))?;
        if let Some((_, message)) = crate::connect_problem(&connect) {
            return Err(problem(&message));
        }
        let carries_secret = crate::driver_secret_kinds(&connect.driver)
            .iter()
            .any(|(key, _)| crate::request_secret(&connect, key).is_some())
            || connect
                .ssh
                .as_ref()
                .is_some_and(|ssh| ssh.password.as_deref().is_some_and(|pw| !pw.is_empty()))
            || connect
                .http_tunnel
                .as_ref()
                .is_some_and(|tunnel| tunnel.password.as_deref().is_some_and(|pw| !pw.is_empty()));
        let name = unique_name(name, &names, label);
        names.insert(name.clone());
        items.push(ImportItem {
            name,
            connect,
            persist_password: carries_secret,
            color: if is_hex_color(&entry.color) {
                entry.color
            } else {
                String::new()
            },
            tags: entry.tags,
            group: entry.group,
        });
    }
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Cheap enough for tests; the real cost is DEFAULT_KDF.
    const FAST: KdfParams = KdfParams {
        m_kib: 64,
        t: 1,
        p: 1,
    };

    fn saved_mysql() -> SavedConnection {
        serde_json::from_value(json!({
            "id": "abc",
            "name": "[GCP] citewell prod",
            "driver": "mysql",
            "mysql": { "host": "db.internal", "port": 3306, "user": "app", "database": "mc", "ssl_mode": "require", "ssl_root_cert": "/k/ca.pem" },
            "ssh": { "host": "bastion", "port": 22, "user": "deploy", "private_key_path": "/k/id" },
            "http_tunnel": { "host": "proxy", "port": 8080, "username": "me" },
            "persist_password": true
        }))
        .unwrap()
    }

    #[test]
    fn seal_then_open_round_trips() {
        let file = seal(b"{\"hello\":1}", "correct horse", FAST).unwrap();
        assert_eq!(open(&file, "correct horse").unwrap(), b"{\"hello\":1}");
    }

    #[test]
    fn sealed_file_hides_the_contents() {
        let file = seal(b"db.internal secret-pw", "correct horse", FAST).unwrap();
        assert!(!file.contains("db.internal"));
        assert!(!file.contains("secret-pw"));
        let envelope: Value = serde_json::from_str(&file).unwrap();
        assert_eq!(envelope["format"], json!(FORMAT));
        assert_eq!(envelope["version"], json!(VERSION));
    }

    #[test]
    fn same_input_seals_differently_each_time() {
        let a = seal(b"same", "correct horse", FAST).unwrap();
        let b = seal(b"same", "correct horse", FAST).unwrap();
        assert_ne!(a, b, "fresh salt and nonce every time");
    }

    #[test]
    fn wrong_passphrase_is_refused() {
        let file = seal(b"x", "correct horse", FAST).unwrap();
        assert_eq!(
            open(&file, "wrong horse"),
            Err(OpenError::WrongPassphraseOrDamaged)
        );
    }

    #[test]
    fn changed_ciphertext_or_header_is_refused() {
        let file = seal(b"payload", "correct horse", FAST).unwrap();
        let envelope: Value = serde_json::from_str(&file).unwrap();

        let mut data = envelope.clone();
        let text = data["data"].as_str().unwrap().to_string();
        let flipped = if text.starts_with('A') {
            format!("B{}", &text[1..])
        } else {
            format!("A{}", &text[1..])
        };
        data["data"] = json!(flipped);
        assert_eq!(
            open(&data.to_string(), "correct horse"),
            Err(OpenError::WrongPassphraseOrDamaged)
        );

        // The cost is authenticated too: lowering it can't be used to open the file another way.
        let mut cost = envelope.clone();
        cost["kdf"]["t"] = json!(2);
        assert_eq!(
            open(&cost.to_string(), "correct horse"),
            Err(OpenError::WrongPassphraseOrDamaged)
        );
    }

    #[test]
    fn other_files_and_versions_are_told_apart() {
        assert_eq!(
            open("not json", "correct horse"),
            Err(OpenError::NotConnectionsFile)
        );
        assert_eq!(
            open("{\"format\":\"other\"}", "correct horse"),
            Err(OpenError::NotConnectionsFile)
        );
        let file = seal(b"x", "correct horse", FAST).unwrap();
        let mut newer: Value = serde_json::from_str(&file).unwrap();
        newer["version"] = json!(2);
        assert!(matches!(
            open(&newer.to_string(), "correct horse"),
            Err(OpenError::Unsupported(_))
        ));
    }

    #[test]
    fn absurd_cost_is_refused_before_any_work() {
        let file = seal(b"x", "correct horse", FAST).unwrap();
        let mut heavy: Value = serde_json::from_str(&file).unwrap();
        heavy["kdf"]["m_kib"] = json!(64 * 1024 * 1024);
        assert!(matches!(
            open(&heavy.to_string(), "correct horse"),
            Err(OpenError::Unsupported(_))
        ));
    }

    #[test]
    fn damaged_salt_reads_as_damaged() {
        let file = seal(b"x", "correct horse", FAST).unwrap();
        for salt in ["", "AAAA"] {
            let mut broken: Value = serde_json::from_str(&file).unwrap();
            broken["kdf"]["salt"] = json!(salt);
            assert_eq!(
                open(&broken.to_string(), "correct horse"),
                Err(OpenError::WrongPassphraseOrDamaged),
                "salt {salt:?}"
            );
        }
    }

    #[test]
    fn unsupported_files_get_fixed_messages() {
        let file = seal(b"x", "correct horse", FAST).unwrap();
        let mut newer: Value = serde_json::from_str(&file).unwrap();
        newer["version"] = json!(2);
        assert_eq!(
            open(&newer.to_string(), "correct horse"),
            Err(OpenError::Unsupported(
                "지원하지 않는 연결 파일 버전입니다".into()
            ))
        );
        let mut other: Value = serde_json::from_str(&file).unwrap();
        other["cipher"] = json!("chacha20-poly1305");
        assert_eq!(
            open(&other.to_string(), "correct horse"),
            Err(OpenError::Unsupported(
                "지원하지 않는 암호화 방식입니다".into()
            ))
        );
    }

    #[test]
    fn export_without_secrets_has_no_password_fields() {
        let connect = export_connect(&saved_mysql(), |_| None);
        assert!(!connect.to_string().contains("password\""), "{connect}");
        assert_eq!(connect["driver"], json!("mysql"));
        assert_eq!(connect["config"]["host"], json!("db.internal"));
        assert_eq!(connect["config"]["ssl_root_cert"], json!("/k/ca.pem"));
        assert!(connect.get("mysql").is_none(), "written in the new shape");
        assert_eq!(connect["ssh"]["private_key_path"], json!("/k/id"));
        assert_eq!(connect["http_tunnel"]["username"], json!("me"));
    }

    #[test]
    fn export_with_secrets_puts_each_in_its_place() {
        let connect = export_connect(&saved_mysql(), |kind| match kind {
            "mysql" => Some("db-pw".into()),
            "ssh" => Some("ssh-pw".into()),
            "http" => Some("proxy-pw".into()),
            _ => None,
        });
        assert_eq!(connect["config"]["password"], json!("db-pw"));
        assert_eq!(connect["ssh"]["password"], json!("ssh-pw"));
        assert_eq!(connect["http_tunnel"]["password"], json!("proxy-pw"));
        // And it is a connect request the server accepts as-is.
        let request: ConnectRequest = serde_json::from_value(connect).unwrap();
        assert_eq!(request.config["password"], json!("db-pw"));
        assert_eq!(request.ssh.unwrap().password.as_deref(), Some("ssh-pw"));
    }

    #[test]
    fn names_get_numbered_when_taken() {
        let taken: HashSet<String> = ["rf-web", "rf-web (가져옴)"]
            .into_iter()
            .map(String::from)
            .collect();
        assert_eq!(unique_name("fresh", &taken, "가져옴"), "fresh");
        assert_eq!(unique_name("rf-web", &HashSet::new(), "가져옴"), "rf-web");
        assert_eq!(unique_name("rf-web", &taken, "가져옴"), "rf-web (가져옴 2)");
        let one: HashSet<String> = ["rf-web".to_string()].into();
        assert_eq!(unique_name("rf-web", &one, "imported"), "rf-web (imported)");
    }

    #[test]
    fn colors_are_rrggbb() {
        assert!(is_hex_color("#a855f7"));
        assert!(is_hex_color("#ABCDEF"));
        for bad in ["", "red", "#abc", "#abcdeg", "url(x)", "#a855f7;"] {
            assert!(!is_hex_color(bad), "{bad}");
        }
    }

    fn entry(name: &str, connect: Value) -> BundleConnection {
        BundleConnection {
            name: name.into(),
            connect,
            color: "#22c55e".into(),
            tags: vec!["prod".into()],
            group: "CiteWell".into(),
        }
    }

    #[test]
    fn prepare_import_names_and_marks_secrets() {
        let with_pw = export_connect(&saved_mysql(), |kind| {
            (kind == "mysql").then(|| "db-pw".to_string())
        });
        let without = export_connect(&saved_mysql(), |_| None);
        let taken: HashSet<String> = ["prod".to_string()].into();
        let items = prepare_import(
            vec![entry("prod", with_pw), entry("prod", without), entry("other", json!({ "driver": "postgres", "postgres": { "host": "h", "port": 5432, "user": "u", "database": "d" } }))],
            &taken,
            "가져옴",
        )
        .unwrap();
        let names: Vec<&str> = items.iter().map(|item| item.name.as_str()).collect();
        assert_eq!(
            names,
            ["prod (가져옴)", "prod (가져옴 2)", "other"],
            "later items see earlier names too"
        );
        assert!(
            items[0].persist_password,
            "a carried password goes to the keychain"
        );
        assert!(!items[1].persist_password);
        assert_eq!(items[0].group, "CiteWell");
        assert_eq!(items[0].tags, ["prod"]);
    }

    #[test]
    fn prepare_import_rejects_the_whole_file_for_one_bad_entry() {
        let good = export_connect(&saved_mysql(), |_| None);
        let cases = [
            entry("  ", good.clone()),
            entry("x", json!({ "driver": "oracle" })),
            entry(
                "x",
                json!({ "driver": "mysql", "mysql": { "host": "h", "port": 3306, "database": "d" } }),
            ),
            entry(
                "x",
                json!({ "driver": "mysql", "mysql": { "host": "h", "port": 3306, "user": "u", "database": "d", "ssl_mode": "verify-full" } }),
            ),
            entry("x", json!({ "driver": "mysql" })),
        ];
        for (index, bad) in cases.into_iter().enumerate() {
            let error = prepare_import(
                vec![entry("ok", good.clone()), bad],
                &HashSet::new(),
                "가져옴",
            )
            .unwrap_err();
            assert!(error.starts_with("2번째 연결"), "case {index}: {error}");
        }
    }

    #[test]
    fn prepare_import_reads_old_and_new_bundles() {
        // A version-1 file from before engine configs: settings under the driver's key.
        let legacy = json!({ "driver": "postgres", "postgres": { "host": "old", "port": 5432, "user": "u", "password": "pw", "database": "d" } });
        let current = json!({ "driver": "mariadb", "config": { "host": "new", "port": 3306, "user": "u", "database": "d" }, "ssh": { "host": "b", "port": 22, "user": "o", "password": "ssh-pw" } });
        let items = prepare_import(
            vec![entry("old", legacy), entry("new", current)],
            &HashSet::new(),
            "가져옴",
        )
        .unwrap();
        assert_eq!(items[0].connect.driver, "postgres");
        assert_eq!(items[0].connect.config["host"], json!("old"));
        assert!(
            items[0].persist_password,
            "its password goes to the keychain"
        );
        assert_eq!(items[1].connect.config["host"], json!("new"));
        assert!(items[1].persist_password, "so does the SSH password");
    }

    #[test]
    fn prepare_import_drops_bad_colors() {
        let mut item = entry("x", export_connect(&saved_mysql(), |_| None));
        item.color = "url(x)".into();
        let items = prepare_import(vec![item], &HashSet::new(), "가져옴").unwrap();
        assert_eq!(items[0].color, "");
    }

    #[test]
    #[ignore = "uses the real cost; run with --ignored to time it"]
    fn default_cost_round_trips() {
        let file = seal(b"x", "correct horse", DEFAULT_KDF).unwrap();
        assert_eq!(open(&file, "correct horse").unwrap(), b"x");
    }
}
