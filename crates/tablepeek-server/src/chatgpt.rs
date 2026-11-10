//! Sign in with ChatGPT, the flow OpenAI offers open-source and locally
//! hosted apps (https://developers.openai.com/siwc/token-sharing-open-source):
//! Write SQL with AI then runs on the user's ChatGPT plan instead of an API
//! key.
//!
//! The page asks for a login URL and opens it in the browser. OpenAI sends the
//! browser back to this server's `/auth/callback` (loopback; only the port may
//! change between runs), where the code is exchanged with PKCE (no client
//! secret), the ID token's RS256 signature, issuer, audience, expiry and
//! nonce are checked, and the plan scope is required. The first login
//! registers TablePeek for that account (`dynamic_agent_client`); the client
//! ID it is issued is kept and reused for later logins to the same account.
//!
//! Credentials live in `chatgpt.json` in the settings folder, owner-only
//! (0600) and replaced atomically, as OpenAI's guide asks: the refresh token
//! rotates on every renewal, about hourly while in use. Renewals hold
//! `chatgpt.lock`, so the desktop app and `tablepeek serve` sharing the folder
//! never race a rotating token.

use std::collections::HashMap;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;

const FILE_NAME: &str = "chatgpt.json";
const LOCK_NAME: &str = "chatgpt.lock";
pub const CALLBACK_PATH: &str = "/auth/callback";
const DYNAMIC_CLIENT: &str = "dynamic_agent_client";
const AGENT_NAME: &str = "TablePeek";
const SCOPE: &str = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
/// The scope that lets requests use the plan; signing in without it can't.
const PLAN_SCOPE: &str = "chatgpt.tokens.use.direct";
const RESOURCE: &str = "https://api.openai.com/v1";
/// How long a login waits for the browser to come back.
const LOGIN_TTL: Duration = Duration::from_secs(10 * 60);
/// Renew this long before the access token (an hour) runs out.
const REFRESH_MARGIN: u64 = 120;
/// The ID token's clock allowance.
const LEEWAY: u64 = 60;
const TIMEOUT: Duration = Duration::from_secs(30);
/// Refresh errors after which the refresh token is no use (OpenAI's list).
const DEAD_REFRESH: [&str; 6] = [
    "invalid_grant",
    "invalid_refresh_token",
    "token_expired",
    "refresh_token_expired",
    "refresh_token_invalidated",
    "refresh_token_reused",
];

/// OpenAI's endpoints; tests point them at a stand-in.
#[derive(Debug, Clone)]
pub struct Endpoints {
    pub issuer: String,
    pub authorize: String,
    pub token: String,
    pub revoke: String,
    pub jwks: String,
    /// The API the access token is for (`/responses`, `/models`).
    pub api: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            issuer: "https://auth.openai.com".into(),
            authorize: "https://auth.openai.com/api/accounts/authorize".into(),
            token: "https://auth.openai.com/api/accounts/oauth/token".into(),
            revoke: "https://auth.openai.com/api/accounts/oauth/revoke".into(),
            jwks: "https://auth.openai.com/.well-known/jwks.json".into(),
            api: RESOURCE.into(),
        }
    }
}

/// chatgpt.json.
#[derive(Debug, Default, Serialize, Deserialize)]
struct CredFile {
    /// This installation, as OpenAI counts hosts (`urn:uuid:…`): chosen
    /// before the first login and kept.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    host_id: Option<String>,
    /// Each account TablePeek was registered for and the client ID it was
    /// issued, kept after signing out for the next login.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    accounts: Vec<Account>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    session: Option<Session>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Account {
    subject: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    email: Option<String>,
    client_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Session {
    subject: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    email: Option<String>,
    client_id: String,
    id_token: String,
    access_token: String,
    refresh_token: String,
    /// Unix seconds.
    expires_at: u64,
    scopes: Vec<String>,
}

/// The file, read under the lock held until this drops.
struct Locked {
    _lock: File,
    path: PathBuf,
    file: CredFile,
}

impl Locked {
    fn open(dir: &Path) -> Result<Self, String> {
        std::fs::create_dir_all(dir)
            .map_err(|err| format!("저장 폴더를 만들 수 없습니다: {err}"))?;
        let lock = File::options()
            .create(true)
            .truncate(false)
            .write(true)
            .open(dir.join(LOCK_NAME))
            .and_then(|file| file.lock().map(|()| file))
            .map_err(|err| format!("ChatGPT 로그인 파일을 잠글 수 없습니다: {err}"))?;
        let path = dir.join(FILE_NAME);
        // A file that no longer parses is a signed-out one; the next login
        // writes a good one over it.
        let file = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Ok(Self {
            _lock: lock,
            path,
            file,
        })
    }

    fn save(&self) -> Result<(), String> {
        let write = || -> std::io::Result<()> {
            let tmp = self.path.with_extension("json.tmp");
            let mut options = File::options();
            options.write(true).create(true).truncate(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut out = options.open(&tmp)?;
            std::io::Write::write_all(&mut out, &serde_json::to_vec_pretty(&self.file)?)?;
            out.sync_all()?;
            std::fs::rename(&tmp, &self.path)
        };
        write().map_err(|err| format!("ChatGPT 로그인 정보를 저장할 수 없습니다: {err}"))
    }

    fn host_id(&mut self) -> String {
        self.file
            .host_id
            .get_or_insert_with(|| format!("urn:uuid:{}", uuid::Uuid::new_v4()))
            .clone()
    }
}

async fn locked(dir: &Path) -> Result<Locked, String> {
    let dir = dir.to_path_buf();
    tokio::task::spawn_blocking(move || Locked::open(&dir))
        .await
        .map_err(|err| err.to_string())?
}

/// A login started here, until the browser comes back with its `state`.
struct Pending {
    nonce: String,
    verifier: String,
    redirect_uri: String,
    /// The account's issued client ID, or none for a first registration.
    client_id: Option<String>,
    /// The account a repeat login must come back as.
    subject: Option<String>,
    started: Instant,
}

#[derive(Debug, Clone)]
enum Login {
    Idle,
    Pending(String),
    Failed(String),
}

/// What GET /api/ai says about ChatGPT.
#[derive(Debug, Serialize)]
pub struct Status {
    pub signed_in: bool,
    pub email: Option<String>,
    /// "idle", "pending" or "failed": the last login started here.
    pub login: &'static str,
    pub login_error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct Model {
    pub slug: String,
    pub display_name: String,
}

/// Why a token or a call couldn't be had.
#[derive(Debug, PartialEq)]
pub enum AuthError {
    /// Not signed in.
    SignedOut,
    /// The session ended (revoked, expired, disconnected in ChatGPT): sign in
    /// again.
    Ended,
    /// OpenAI couldn't be reached, or the file couldn't be read or written;
    /// the session is kept. The message says what was being done.
    Failed(String),
    /// OpenAI answered with a refusal; the session is kept.
    Refused(String),
}

pub struct ChatGpt {
    dir: PathBuf,
    endpoints: Endpoints,
    pending: std::sync::Mutex<HashMap<String, Pending>>,
    login: std::sync::Mutex<Login>,
    /// One renewal at a time in this server (the file lock covers others).
    renewing: tokio::sync::Mutex<()>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| since.as_secs())
}

fn random() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("the OS random source");
    URL_SAFE_NO_PAD.encode(bytes)
}

fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(ring::digest::digest(
        &ring::digest::SHA256,
        verifier.as_bytes(),
    ))
}

/// One client for every call to OpenAI's sign-in, built once (building one
/// loads the system's root certificates).
fn client() -> Result<reqwest::Client, AuthError> {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client.clone());
    }
    let client = reqwest::Client::builder()
        .user_agent(format!("TablePeek/{}", crate::update::VERSION))
        .timeout(TIMEOUT)
        .build()
        .map_err(|err| AuthError::Failed(err.to_string()))?;
    Ok(CLIENT.get_or_init(|| client).clone())
}

/// An OAuth error body's code and message: `{"error": "x",
/// "error_description"}`, `{"error": {"code", "message"}}` or `{"detail"}`.
fn oauth_error(body: &str) -> (Option<String>, String) {
    let value: Value = serde_json::from_str(body).unwrap_or(Value::Null);
    let code = value
        .get("error")
        .and_then(|error| {
            error
                .as_str()
                .or_else(|| error.get("code").and_then(Value::as_str))
        })
        .map(str::to_string);
    let message = value
        .get("error_description")
        .or_else(|| value.pointer("/error/message"))
        .or_else(|| value.get("detail"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| code.clone())
        .unwrap_or_else(|| body.chars().take(300).collect());
    (code, message)
}

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default)]
    refresh_token: Option<String>,
    #[serde(default)]
    id_token: Option<String>,
    expires_in: u64,
    #[serde(default)]
    scope: Option<String>,
}

#[derive(Debug, Deserialize)]
struct Claims {
    iss: String,
    aud: Value,
    exp: u64,
    sub: String,
    #[serde(default)]
    nonce: Option<String>,
    #[serde(default)]
    email: Option<String>,
}

/// The ID token's claims once its RS256 signature (by a key in `jwks`), its
/// issuer, audience, expiry and nonce check out.
fn verify_id_token(
    token: &str,
    jwks: &Value,
    issuer: &str,
    client_id: &str,
    nonce: &str,
    now: u64,
) -> Result<Claims, String> {
    let mut parts = token.split('.');
    let (Some(header), Some(payload), Some(signature), None) =
        (parts.next(), parts.next(), parts.next(), parts.next())
    else {
        return Err("ID 토큰 형식이 아닙니다".into());
    };
    let decode = |part: &str| {
        URL_SAFE_NO_PAD
            .decode(part)
            .map_err(|_| "ID 토큰을 읽을 수 없습니다".to_string())
    };
    let header: Value = serde_json::from_slice(&decode(header)?).map_err(|err| err.to_string())?;
    if header["alg"] != "RS256" {
        return Err(format!(
            "ID 토큰의 서명 방식이 RS256이 아닙니다: {}",
            header["alg"]
        ));
    }
    let keys = jwks["keys"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    let key = keys
        .iter()
        .find(|key| key["kid"] == header["kid"] && key["kty"] == "RSA")
        .ok_or("ID 토큰에 서명한 키를 OpenAI 키 목록에서 찾을 수 없습니다")?;
    let component = |name: &str| {
        key[name]
            .as_str()
            .and_then(|text| URL_SAFE_NO_PAD.decode(text).ok())
            .ok_or_else(|| format!("OpenAI 키의 {name}를 읽을 수 없습니다"))
    };
    let public = ring::rsa::PublicKeyComponents {
        n: component("n")?,
        e: component("e")?,
    };
    let signed = &token[..token.len() - signature.len() - 1];
    public
        .verify(
            &ring::signature::RSA_PKCS1_2048_8192_SHA256,
            signed.as_bytes(),
            &decode(signature)?,
        )
        .map_err(|_| "ID 토큰의 서명이 맞지 않습니다".to_string())?;

    let claims: Claims =
        serde_json::from_slice(&decode(payload)?).map_err(|err| err.to_string())?;
    if claims.iss != issuer {
        return Err(format!("ID 토큰의 발급자가 다릅니다: {}", claims.iss));
    }
    let audience = match &claims.aud {
        Value::String(aud) => aud == client_id,
        Value::Array(list) => list.iter().any(|aud| aud == client_id),
        _ => false,
    };
    if !audience {
        return Err("ID 토큰이 이 클라이언트에 발급된 것이 아닙니다".into());
    }
    if claims.exp + LEEWAY < now {
        return Err("ID 토큰이 만료되었습니다".into());
    }
    if claims.nonce.as_deref() != Some(nonce) {
        return Err("ID 토큰의 nonce가 맞지 않습니다".into());
    }
    if claims.sub.is_empty() {
        return Err("ID 토큰에 계정 식별자가 없습니다".into());
    }
    Ok(claims)
}

impl ChatGpt {
    pub fn new(dir: &Path, endpoints: Endpoints) -> Self {
        Self {
            dir: dir.to_path_buf(),
            endpoints,
            pending: Default::default(),
            login: std::sync::Mutex::new(Login::Idle),
            renewing: tokio::sync::Mutex::new(()),
        }
    }

    pub fn api(&self) -> &str {
        &self.endpoints.api
    }

    fn set_login(&self, login: Login) {
        *self
            .login
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = login;
    }

    pub async fn status(&self) -> Status {
        let session = locked(&self.dir)
            .await
            .ok()
            .and_then(|locked| locked.file.session);
        let login = self
            .login
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let (login, login_error) = match login {
            // Abandoned in the browser: once it can't come back, not pending.
            Login::Pending(state) if self.waiting(&state) => ("pending", None),
            Login::Idle | Login::Pending(_) => ("idle", None),
            Login::Failed(message) => ("failed", Some(message)),
        };
        Status {
            signed_in: session.is_some(),
            email: session.and_then(|session| session.email),
            login,
            login_error,
        }
    }

    fn waiting(&self, state: &str) -> bool {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(state)
            .is_some_and(|pending| pending.started.elapsed() < LOGIN_TTL)
    }

    /// Gives up the logins waiting for the browser; a late callback finds
    /// none.
    pub fn cancel(&self) {
        self.pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
        self.set_login(Login::Idle);
    }

    /// The URL that starts a login in the browser, which comes back to
    /// `http://{host}/auth/callback` (`host` the server's `127.0.0.1:port`).
    /// `new_account` registers for another account; otherwise the account
    /// last signed in to is asked for again.
    pub async fn begin(&self, host: &str, new_account: bool) -> Result<String, String> {
        let mut locked = locked(&self.dir).await?;
        let known = locked.file.host_id.is_some();
        let host_id = locked.host_id();
        if !known {
            locked.save()?;
        }
        let account = if new_account {
            None
        } else {
            let last = locked
                .file
                .session
                .as_ref()
                .map(|session| session.subject.clone());
            match last {
                Some(subject) => locked
                    .file
                    .accounts
                    .iter()
                    .find(|account| account.subject == subject),
                None => locked.file.accounts.last(),
            }
            .cloned()
        };
        let id_token = locked
            .file
            .session
            .as_ref()
            .filter(|session| {
                account
                    .as_ref()
                    .is_some_and(|account| account.subject == session.subject)
            })
            .map(|session| session.id_token.clone());
        drop(locked);

        let state = random();
        let pending = Pending {
            nonce: random(),
            verifier: random(),
            redirect_uri: format!("http://{host}{CALLBACK_PATH}"),
            client_id: account.as_ref().map(|account| account.client_id.clone()),
            subject: account.as_ref().map(|account| account.subject.clone()),
            started: Instant::now(),
        };
        let mut params: Vec<(&str, String)> = vec![
            (
                "client_id",
                pending
                    .client_id
                    .clone()
                    .unwrap_or_else(|| DYNAMIC_CLIENT.into()),
            ),
            ("ext_agent_host_id", host_id),
            ("response_type", "code".into()),
            ("redirect_uri", pending.redirect_uri.clone()),
            ("scope", SCOPE.into()),
            ("resource", RESOURCE.into()),
            ("state", state.clone()),
            ("nonce", pending.nonce.clone()),
            ("code_challenge_method", "S256".into()),
            ("code_challenge", challenge(&pending.verifier)),
        ];
        match &account {
            None => params.push(("agent_name_hint", AGENT_NAME.into())),
            Some(account) => {
                if let Some(email) = &account.email {
                    params.push(("login_hint", email.clone()));
                }
                if let Some(id_token) = id_token {
                    params.push(("id_token_hint", id_token));
                }
            }
        }
        let url = reqwest::Url::parse_with_params(&self.endpoints.authorize, &params)
            .map_err(|err| err.to_string())?;

        let mut waiting = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        waiting.retain(|_, pending| pending.started.elapsed() < LOGIN_TTL);
        waiting.insert(state.clone(), pending);
        drop(waiting);
        self.set_login(Login::Pending(state));
        Ok(url.into())
    }

    /// The browser came back. Returns whether a login was waiting for
    /// `state`, and how it ended.
    pub async fn finish(&self, callback: Callback) -> Option<Result<(), String>> {
        let state = callback.state.clone()?;
        let pending = self
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(&state)
            .filter(|pending| pending.started.elapsed() < LOGIN_TTL)?;
        let outcome = self.complete(pending, callback).await;
        // A newer login started meanwhile keeps the page waiting for it.
        let mut login = self
            .login
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if matches!(&*login, Login::Pending(current) if *current == state) {
            *login = match &outcome {
                Ok(()) => Login::Idle,
                Err(message) => Login::Failed(message.clone()),
            };
        }
        Some(outcome)
    }

    async fn complete(&self, pending: Pending, callback: Callback) -> Result<(), String> {
        if let Some(error) = callback.error {
            return Err(match callback.error_description {
                Some(description) => format!("{error} ({description})"),
                None => error,
            });
        }
        let code = callback.code.ok_or("OpenAI가 코드를 보내지 않았습니다")?;
        let client_id = match (&pending.client_id, callback.client_id) {
            (Some(saved), Some(sent)) if *saved != sent => {
                return Err("OpenAI가 다른 클라이언트 ID를 보냈습니다".into())
            }
            (Some(saved), _) => saved.clone(),
            (None, Some(issued)) if issued != DYNAMIC_CLIENT => issued,
            (None, _) => return Err("등록이 끝나지 않았습니다 (클라이언트 ID 없음)".into()),
        };

        let client = client().map_err(describe)?;
        let response = client
            .post(&self.endpoints.token)
            .form(&[
                ("grant_type", "authorization_code"),
                ("code", code.as_str()),
                ("redirect_uri", pending.redirect_uri.as_str()),
                ("client_id", client_id.as_str()),
                ("code_verifier", pending.verifier.as_str()),
                ("resource", RESOURCE),
            ])
            .send()
            .await
            .map_err(|err| err.to_string())?;
        let status = response.status();
        let body = response.text().await.map_err(|err| err.to_string())?;
        if !status.is_success() {
            return Err(format!(
                "토큰 교환 실패 ({}): {}",
                status.as_u16(),
                oauth_error(&body).1
            ));
        }
        let tokens: TokenResponse = serde_json::from_str(&body).map_err(|err| err.to_string())?;
        let id_token = tokens
            .id_token
            .ok_or("OpenAI가 ID 토큰을 보내지 않았습니다")?;
        let jwks: Value = client
            .get(&self.endpoints.jwks)
            .send()
            .await
            .and_then(reqwest::Response::error_for_status)
            .map_err(|err| err.to_string())?
            .json()
            .await
            .map_err(|err| err.to_string())?;
        let claims = verify_id_token(
            &id_token,
            &jwks,
            &self.endpoints.issuer,
            &client_id,
            &pending.nonce,
            now(),
        )?;
        if pending
            .subject
            .as_ref()
            .is_some_and(|subject| *subject != claims.sub)
        {
            return Err("고른 계정과 다른 ChatGPT 계정으로 로그인했습니다".into());
        }

        let scopes: Vec<String> = tokens
            .scope
            .or(callback.scope)
            .unwrap_or_default()
            .split_whitespace()
            .map(str::to_string)
            .collect();
        let mut locked = locked(&self.dir).await?;
        // The registration is kept whether or not the plan was allowed, so a
        // second try asks the same client again.
        match locked
            .file
            .accounts
            .iter_mut()
            .find(|account| account.client_id == client_id)
        {
            Some(account) => account.email = claims.email.clone(),
            None => locked.file.accounts.push(Account {
                subject: claims.sub.clone(),
                email: claims.email.clone(),
                client_id: client_id.clone(),
            }),
        }
        if !scopes.iter().any(|scope| scope == PLAN_SCOPE) {
            locked.save()?;
            return Err(
                "ChatGPT 요금제 사용을 허락하지 않아 쓸 수 없습니다. 다시 로그인해 허락하세요"
                    .into(),
            );
        }
        let refresh_token = tokens
            .refresh_token
            .ok_or("OpenAI가 갱신 토큰을 보내지 않았습니다")?;
        locked.file.session = Some(Session {
            subject: claims.sub,
            email: claims.email,
            client_id,
            id_token,
            access_token: tokens.access_token,
            refresh_token,
            expires_at: now() + tokens.expires_in,
            scopes,
        });
        locked.save()
    }

    /// A current access token, renewed first when it is about to run out.
    pub async fn access_token(&self) -> Result<String, AuthError> {
        let _renewing = self.renewing.lock().await;
        let mut locked = locked(&self.dir).await.map_err(AuthError::Failed)?;
        let session = locked.file.session.clone().ok_or(AuthError::SignedOut)?;
        if session.expires_at > now() + REFRESH_MARGIN {
            return Ok(session.access_token);
        }
        let client = client()?;
        let response = client
            .post(&self.endpoints.token)
            .form(&[
                ("grant_type", "refresh_token"),
                ("client_id", session.client_id.as_str()),
                ("refresh_token", session.refresh_token.as_str()),
                ("resource", RESOURCE),
            ])
            .send()
            .await
            .map_err(|err| AuthError::Failed(format!("{RENEW_FAILED}{err}")))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|err| AuthError::Failed(format!("{RENEW_FAILED}{err}")))?;
        if !status.is_success() {
            let (code, message) = oauth_error(&body);
            if code
                .as_deref()
                .is_some_and(|code| DEAD_REFRESH.contains(&code))
            {
                locked.file.session = None;
                locked.save().map_err(AuthError::Failed)?;
                return Err(AuthError::Ended);
            }
            return Err(AuthError::Refused(format!(
                "{RENEW_FAILED}{} {message}",
                status.as_u16()
            )));
        }
        let tokens: TokenResponse = serde_json::from_str(&body)
            .map_err(|err| AuthError::Failed(format!("{RENEW_FAILED}{err}")))?;
        let session = locked.file.session.as_mut().ok_or(AuthError::SignedOut)?;
        session.access_token = tokens.access_token.clone();
        session.expires_at = now() + tokens.expires_in;
        if let Some(refresh) = tokens.refresh_token {
            session.refresh_token = refresh;
        }
        if let Some(id_token) = tokens.id_token {
            session.id_token = id_token;
        }
        if let Some(scope) = tokens.scope {
            session.scopes = scope.split_whitespace().map(str::to_string).collect();
        }
        locked.save().map_err(AuthError::Failed)?;
        Ok(tokens.access_token)
    }

    /// Ends the session: OpenAI is asked to revoke the refresh token, and the
    /// tokens are cleared here either way. Returns whether OpenAI confirmed;
    /// the account's registration and the host ID stay for the next login.
    pub async fn sign_out(&self) -> Result<bool, String> {
        let _renewing = self.renewing.lock().await;
        let mut locked = locked(&self.dir).await?;
        let Some(session) = locked.file.session.take() else {
            return Ok(true);
        };
        let mut revoked = false;
        if let Ok(client) = client() {
            for attempt in 0..3u64 {
                let sent = client
                    .post(&self.endpoints.revoke)
                    .form(&[
                        ("token", session.refresh_token.as_str()),
                        ("token_type_hint", "refresh_token"),
                        ("client_id", session.client_id.as_str()),
                    ])
                    .send()
                    .await;
                match sent {
                    Ok(response) if response.status().is_success() => {
                        revoked = true;
                        break;
                    }
                    // A refusal won't change on a retry; a network failure
                    // or 5xx might.
                    Ok(response) if !response.status().is_server_error() => break,
                    _ => tokio::time::sleep(Duration::from_millis(500 * (attempt + 1))).await,
                }
            }
        }
        locked.save()?;
        Ok(revoked)
    }

    /// The models the signed-in account may use, in OpenAI's order.
    pub async fn models(&self) -> Result<Vec<Model>, AuthError> {
        let token = self.access_token().await?;
        let response = client()?
            .get(format!("{}/models", self.endpoints.api))
            .bearer_auth(token)
            .send()
            .await
            .map_err(|err| AuthError::Failed(format!("{MODELS_FAILED}{err}")))?;
        let status = response.status();
        let body: Value = response
            .json()
            .await
            .map_err(|err| AuthError::Failed(format!("{MODELS_FAILED}{err}")))?;
        if !status.is_success() {
            return Err(AuthError::Refused(format!(
                "{MODELS_FAILED}{} {}",
                status.as_u16(),
                oauth_error(&body.to_string()).1
            )));
        }
        let models = body["models"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or_default();
        Ok(models
            .iter()
            .filter(|model| model["visibility"] == "list")
            .filter_map(|model| {
                let slug = model["slug"].as_str()?.to_string();
                let display_name = model["display_name"].as_str().unwrap_or(&slug).to_string();
                Some(Model { slug, display_name })
            })
            .collect())
    }
}

const RENEW_FAILED: &str = "ChatGPT 토큰을 갱신하지 못했습니다: ";
const MODELS_FAILED: &str = "ChatGPT 모델 목록을 읽지 못했습니다: ";

fn describe(err: AuthError) -> String {
    match err {
        AuthError::Failed(message) | AuthError::Refused(message) => message,
        AuthError::SignedOut | AuthError::Ended => "로그인이 필요합니다".into(),
    }
}

/// What OpenAI sends the browser back with.
#[derive(Debug, Default, Deserialize)]
pub struct Callback {
    pub state: Option<String>,
    pub code: Option<String>,
    pub client_id: Option<String>,
    pub scope: Option<String>,
    pub error: Option<String>,
    pub error_description: Option<String>,
}

#[cfg(test)]
pub(crate) mod testing {
    //! A stand-in OpenAI: authorization server and API, with an RSA key
    //! that signs its ID tokens.

    use std::sync::{Arc, Mutex};

    use axum::extract::{Form, State};
    use axum::http::{HeaderMap, StatusCode};
    use axum::response::IntoResponse;
    use axum::routing::{get, post};
    use axum::{Json, Router};
    use serde_json::json;

    use super::*;

    const KEY: &str = include_str!("../testdata/chatgpt-test-key.b64");

    #[derive(Default)]
    pub struct World {
        /// The nonce the next ID token carries.
        pub nonce: String,
        pub subject: String,
        /// Scopes the token endpoint grants.
        pub scope: String,
        /// Seconds the access tokens it hands out last.
        pub expires_in: u64,
        /// Refresh tokens handed out and still good.
        pub refresh: Vec<String>,
        pub refreshes: usize,
        pub revoked: Vec<String>,
        /// Bodies POSTed to /v1/responses.
        pub requests: Vec<Value>,
        /// SSE text /v1/responses answers with.
        pub stream: String,
    }

    pub struct Fake {
        pub endpoints: Endpoints,
        pub world: Arc<Mutex<World>>,
    }

    fn key_pair() -> ring::rsa::KeyPair {
        let der = KEY
            .lines()
            .filter(|line| !line.starts_with('#'))
            .collect::<String>();
        let der = base64::engine::general_purpose::STANDARD
            .decode(der)
            .unwrap();
        ring::rsa::KeyPair::from_pkcs8(&der).unwrap()
    }

    pub fn jwks() -> Value {
        let public = ring::rsa::PublicKeyComponents::<Vec<u8>>::from(key_pair().public());
        json!({ "keys": [{
            "kty": "RSA", "alg": "RS256", "use": "sig", "kid": "test",
            "n": URL_SAFE_NO_PAD.encode(&public.n), "e": URL_SAFE_NO_PAD.encode(&public.e),
        }] })
    }

    pub fn sign(claims: &Value) -> String {
        let header = URL_SAFE_NO_PAD.encode(json!({ "alg": "RS256", "kid": "test" }).to_string());
        let payload = URL_SAFE_NO_PAD.encode(claims.to_string());
        let input = format!("{header}.{payload}");
        let pair = key_pair();
        let mut signature = vec![0; pair.public().modulus_len()];
        pair.sign(
            &ring::signature::RSA_PKCS1_SHA256,
            &ring::rand::SystemRandom::new(),
            input.as_bytes(),
            &mut signature,
        )
        .unwrap();
        format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature))
    }

    async fn token(
        State((world, issuer)): State<(Arc<Mutex<World>>, String)>,
        Form(form): Form<HashMap<String, String>>,
    ) -> axum::response::Response {
        let mut world = world.lock().unwrap();
        let client_id = form["client_id"].clone();
        if form["grant_type"] == "refresh_token" {
            let used = &form["refresh_token"];
            if !world.refresh.contains(used) {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({ "error": "refresh_token_reused" })),
                )
                    .into_response();
            }
            world.refresh.retain(|token| token != used);
            world.refreshes += 1;
        }
        let refresh = format!("refresh-{}", random());
        world.refresh.push(refresh.clone());
        let id_token = sign(&json!({
            "iss": issuer, "aud": client_id, "sub": world.subject, "email": "ann@example.com",
            "nonce": world.nonce, "exp": now() + 3600, "iat": now(),
        }));
        Json(json!({
            "access_token": format!("access-{}", random()), "refresh_token": refresh,
            "id_token": id_token, "token_type": "Bearer", "expires_in": world.expires_in,
            "scope": world.scope,
        }))
        .into_response()
    }

    async fn revoke(
        State((world, _)): State<(Arc<Mutex<World>>, String)>,
        Form(form): Form<HashMap<String, String>>,
    ) -> StatusCode {
        let mut world = world.lock().unwrap();
        world.refresh.retain(|token| *token != form["token"]);
        world.revoked.push(form["token"].clone());
        StatusCode::OK
    }

    async fn models(headers: HeaderMap) -> axum::response::Response {
        if !headers[axum::http::header::AUTHORIZATION]
            .to_str()
            .unwrap()
            .starts_with("Bearer access-")
        {
            return StatusCode::UNAUTHORIZED.into_response();
        }
        Json(json!({ "models": [
            { "slug": "gpt-sol", "display_name": "GPT Sol", "visibility": "list" },
            { "slug": "internal", "display_name": "Hidden", "visibility": "hide" },
        ] }))
        .into_response()
    }

    async fn responses(
        State((world, _)): State<(Arc<Mutex<World>>, String)>,
        Json(body): Json<Value>,
    ) -> String {
        let mut world = world.lock().unwrap();
        world.requests.push(body);
        world.stream.clone()
    }

    pub async fn start() -> Fake {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let world = Arc::new(Mutex::new(World {
            subject: "user-1".into(),
            scope: SCOPE.into(),
            expires_in: 3600,
            ..World::default()
        }));
        let app = Router::new()
            .route("/oauth/token", post(token))
            .route("/oauth/revoke", post(revoke))
            .route("/jwks", get(|| async { Json(jwks()) }))
            .route("/v1/models", get(models))
            .route("/v1/responses", post(responses))
            .with_state((world.clone(), base.clone()));
        tokio::spawn(async move { axum::serve(listener, app).await });
        Fake {
            endpoints: Endpoints {
                issuer: base.clone(),
                authorize: format!("{base}/authorize"),
                token: format!("{base}/oauth/token"),
                revoke: format!("{base}/oauth/revoke"),
                jwks: format!("{base}/jwks"),
                api: format!("{base}/v1"),
            },
            world,
        }
    }

    /// The query of a login URL, by name.
    pub fn query(url: &str) -> HashMap<String, String> {
        reqwest::Url::parse(url)
            .unwrap()
            .query_pairs()
            .into_owned()
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::testing::*;
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("tablepeek-chatgpt-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    /// Signs in through the stand-in as the browser would, with the client
    /// ID the callback carries for a first registration.
    async fn sign_in(
        auth: &ChatGpt,
        fake: &Fake,
        issued: &str,
        new_account: bool,
    ) -> Result<(), String> {
        let url = auth.begin("127.0.0.1:7870", new_account).await.unwrap();
        let query = query(&url);
        fake.world.lock().unwrap().nonce = query["nonce"].clone();
        auth.finish(Callback {
            state: Some(query["state"].clone()),
            code: Some("code".into()),
            client_id: (query["client_id"] == DYNAMIC_CLIENT).then(|| issued.to_string()),
            ..Callback::default()
        })
        .await
        .expect("a login was waiting")
    }

    #[test]
    fn id_tokens_need_the_signature_issuer_audience_and_nonce() {
        let jwks = jwks();
        let claims = |over: Value| {
            let mut base = json!({ "iss": "https://auth.openai.com", "aud": "oaiapp_1", "sub": "u", "nonce": "n", "exp": 2_000_000_000u64 });
            base.as_object_mut()
                .unwrap()
                .extend(over.as_object().unwrap().clone());
            base
        };
        let check = |token: &str| {
            verify_id_token(
                token,
                &jwks,
                "https://auth.openai.com",
                "oaiapp_1",
                "n",
                1_900_000_000,
            )
        };
        assert_eq!(check(&sign(&claims(json!({})))).unwrap().sub, "u");
        assert!(check(&sign(&claims(json!({ "aud": ["x", "oaiapp_1"] })))).is_ok());
        for (bad, why) in [
            (json!({ "iss": "https://evil" }), "발급자"),
            (json!({ "aud": "oaiapp_2" }), "클라이언트"),
            (json!({ "nonce": "other" }), "nonce"),
            (json!({ "exp": 1_800_000_000u64 }), "만료"),
        ] {
            let err = check(&sign(&claims(bad.clone()))).unwrap_err();
            assert!(err.contains(why), "{bad}: {err}");
        }
        // A changed payload under the original signature.
        let token = sign(&claims(json!({})));
        let mut parts: Vec<&str> = token.split('.').collect();
        let forged = URL_SAFE_NO_PAD.encode(claims(json!({ "sub": "someone-else" })).to_string());
        parts[1] = &forged;
        assert!(check(&parts.join(".")).unwrap_err().contains("서명"));
    }

    #[tokio::test]
    async fn the_login_url_registers_first_and_reuses_the_issued_client_after() {
        let fake = start().await;
        let dir = temp("login-url");
        let auth = ChatGpt::new(&dir, fake.endpoints.clone());
        let first = query(&auth.begin("127.0.0.1:7870", false).await.unwrap());
        assert_eq!(first["client_id"], DYNAMIC_CLIENT);
        assert_eq!(first["agent_name_hint"], "TablePeek");
        assert_eq!(first["redirect_uri"], "http://127.0.0.1:7870/auth/callback");
        assert_eq!(first["scope"], SCOPE);
        assert_eq!(first["resource"], RESOURCE);
        assert_eq!(first["code_challenge_method"], "S256");
        assert!(first["ext_agent_host_id"].starts_with("urn:uuid:"));
        assert_eq!(auth.status().await.login, "pending");

        sign_in(&auth, &fake, "oaiapp_1", false).await.unwrap();
        let status = auth.status().await;
        assert!(status.signed_in);
        assert_eq!(
            (status.login, status.email.as_deref()),
            ("idle", Some("ann@example.com"))
        );

        // Again, on another port: the issued client and the same host.
        let again = query(&auth.begin("127.0.0.1:9999", false).await.unwrap());
        assert_eq!(again["client_id"], "oaiapp_1");
        assert_eq!(again["ext_agent_host_id"], first["ext_agent_host_id"]);
        assert_eq!(again["login_hint"], "ann@example.com");
        assert!(again.contains_key("id_token_hint"));
        assert!(!again.contains_key("agent_name_hint"));
        // Another account registers anew.
        let other = query(&auth.begin("127.0.0.1:7870", true).await.unwrap());
        assert_eq!(other["client_id"], DYNAMIC_CLIENT);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join(FILE_NAME))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_login_without_the_plan_scope_or_with_a_stale_state_fails() {
        let fake = start().await;
        let dir = temp("refused");
        let auth = ChatGpt::new(&dir, fake.endpoints.clone());
        fake.world.lock().unwrap().scope = "openid profile email offline_access".into();
        let err = sign_in(&auth, &fake, "oaiapp_1", false).await.unwrap_err();
        assert!(err.contains("요금제"), "{err}");
        let status = auth.status().await;
        assert!(!status.signed_in);
        assert_eq!(status.login, "failed");
        // The registration stays: the retry asks the issued client.
        let retry = query(&auth.begin("127.0.0.1:7870", false).await.unwrap());
        assert_eq!(retry["client_id"], "oaiapp_1");

        // A callback nobody waits for.
        let unknown = auth
            .finish(Callback {
                state: Some("nope".into()),
                code: Some("c".into()),
                ..Callback::default()
            })
            .await;
        assert!(unknown.is_none());
        // Declined in the browser.
        let url = query(&auth.begin("127.0.0.1:7870", false).await.unwrap());
        let declined = auth
            .finish(Callback {
                state: Some(url["state"].clone()),
                error: Some("access_denied".into()),
                ..Callback::default()
            })
            .await
            .unwrap();
        assert_eq!(declined.unwrap_err(), "access_denied");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn access_tokens_renew_once_near_expiry_and_a_dead_refresh_signs_out() {
        let fake = start().await;
        let dir = temp("refresh");
        let auth = ChatGpt::new(&dir, fake.endpoints.clone());
        // Tokens that are already inside the renewal margin.
        fake.world.lock().unwrap().expires_in = 10;
        sign_in(&auth, &fake, "oaiapp_1", false).await.unwrap();
        fake.world.lock().unwrap().expires_in = 3600;

        let (a, b) = tokio::join!(auth.access_token(), auth.access_token());
        assert_eq!(a.unwrap(), b.unwrap());
        assert_eq!(fake.world.lock().unwrap().refreshes, 1);
        assert!(auth.access_token().await.is_ok());
        assert_eq!(fake.world.lock().unwrap().refreshes, 1);

        // Revoked elsewhere (disconnected in ChatGPT): the next renewal ends it.
        let mut locked = Locked::open(&dir).unwrap();
        locked.file.session.as_mut().unwrap().expires_at = 0;
        locked.save().unwrap();
        drop(locked);
        fake.world.lock().unwrap().refresh.clear();
        assert_eq!(auth.access_token().await, Err(AuthError::Ended));
        assert!(!auth.status().await.signed_in);
        assert_eq!(auth.access_token().await, Err(AuthError::SignedOut));
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn signing_out_revokes_and_keeps_the_registration() {
        let fake = start().await;
        let dir = temp("sign-out");
        let auth = ChatGpt::new(&dir, fake.endpoints.clone());
        sign_in(&auth, &fake, "oaiapp_1", false).await.unwrap();
        let refresh = Locked::open(&dir)
            .unwrap()
            .file
            .session
            .unwrap()
            .refresh_token;
        assert!(auth.sign_out().await.unwrap());
        assert_eq!(fake.world.lock().unwrap().revoked, vec![refresh]);
        assert!(!auth.status().await.signed_in);
        let next = query(&auth.begin("127.0.0.1:7870", false).await.unwrap());
        assert_eq!(next["client_id"], "oaiapp_1");
        assert!(!next.contains_key("id_token_hint"));

        let models = {
            sign_in(&auth, &fake, "oaiapp_1", false).await.unwrap();
            auth.models().await.unwrap()
        };
        assert_eq!(models.len(), 1);
        assert_eq!(
            (models[0].slug.as_str(), models[0].display_name.as_str()),
            ("gpt-sol", "GPT Sol")
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
