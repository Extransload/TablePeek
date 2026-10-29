//! OIDC browser logins: the human flow of MONGODB-OIDC.
//!
//! When the server asks for a token it names its identity provider (issuer,
//! client id, scopes). We read the provider's discovery document, build an
//! authorization-code request with PKCE, and wait: the page lists the
//! logins waiting here (`pending`) and opens their address in the user's
//! browser; the provider sends the browser back to TablePeek's own
//! `/api/oidc/callback`, whose `state` and `code` reach `finish`; the code
//! is then exchanged for the token the driver hands to MongoDB. A refresh
//! token, when the provider gave one, renews the token without the browser.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex, PoisonError};
use std::time::{Duration, Instant};

use base64::Engine as _;
use futures_util::FutureExt;
use mongodb::error::Error;
use mongodb::options::oidc::{Callback, CallbackContext, IdpServerResponse};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;

/// How long the user has to log in when the driver sets no deadline.
const LOGIN_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// How long one request to the provider may take.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// Where this TablePeek listens (`http://127.0.0.1:7870`): the provider
/// sends the browser back to its `/api/oidc/callback`.
static REDIRECT_BASE: Mutex<Option<String>> = Mutex::new(None);

/// Logins waiting for the browser to come back, by their `state`.
static LOGINS: LazyLock<Mutex<HashMap<String, Waiting>>> = LazyLock::new(Default::default);

struct Waiting {
    url: String,
    issuer: String,
    reply: oneshot::Sender<Result<String, String>>,
}

/// A login the page should open in the browser.
#[derive(Debug, Clone, Serialize)]
pub struct PendingLogin {
    /// Its `state`, also what `cancel` takes.
    pub id: String,
    /// The provider's login page.
    pub url: String,
    pub issuer: String,
}

/// Tells browser logins where this TablePeek listens; the server calls it
/// once it is bound.
pub fn set_redirect_base(base: &str) {
    *REDIRECT_BASE.lock().unwrap_or_else(PoisonError::into_inner) =
        Some(base.trim_end_matches('/').to_string());
}

/// The logins waiting for the user, oldest first is not promised.
pub fn pending() -> Vec<PendingLogin> {
    LOGINS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .iter()
        .map(|(id, waiting)| PendingLogin {
            id: id.clone(),
            url: waiting.url.clone(),
            issuer: waiting.issuer.clone(),
        })
        .collect()
}

/// The browser came back to the callback: hands the login with this
/// `state` its code, or the provider's error. False when no login waits
/// for that state (a stale or forged callback).
pub fn finish(state: &str, outcome: Result<String, String>) -> bool {
    let waiting = LOGINS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(state);
    match waiting {
        Some(waiting) => {
            let _ = waiting.reply.send(outcome);
            true
        }
        None => false,
    }
}

/// Gives up a waiting login: the connect that started it fails.
pub fn cancel(id: &str) -> bool {
    LOGINS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(id)
        .is_some()
}

/// Why a browser login failed, as the driver hands it back (see `mongo_err`).
#[derive(Debug)]
pub(super) struct LoginFailed(pub String);

/// The driver callback for browser logins. `login_hint` (the form's user)
/// preselects the account on the provider's page.
pub(super) fn callback(login_hint: Option<String>) -> Callback {
    Callback::human(move |context: CallbackContext| {
        let hint = login_hint.clone();
        async move {
            login(context, hint).await.map_err(|message| {
                Error::custom(LoginFailed(format!("OIDC 로그인 실패: {message}")))
            })
        }
        .boxed()
    })
}

#[derive(Deserialize)]
struct Discovery {
    authorization_endpoint: String,
    token_endpoint: String,
}

#[derive(Deserialize)]
struct TokenReply {
    access_token: Option<String>,
    expires_in: Option<u64>,
    refresh_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

async fn login(
    context: CallbackContext,
    hint: Option<String>,
) -> Result<IdpServerResponse, String> {
    let info = context
        .idp_info
        .ok_or("서버가 IdP 정보를 알려주지 않았습니다")?;
    let client_id = info
        .client_id
        .ok_or("서버의 IdP 설정에 clientId가 없어 브라우저 로그인을 할 수 없습니다")?;
    let http = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|err| err.to_string())?;
    let discovery_url = format!(
        "{}/.well-known/openid-configuration",
        info.issuer.trim_end_matches('/')
    );
    let endpoints: Discovery = http
        .get(&discovery_url)
        .send()
        .await
        .and_then(reqwest::Response::error_for_status)
        .map_err(|err| format!("IdP 정보를 읽을 수 없습니다 ({discovery_url}): {err}"))?
        .json()
        .await
        .map_err(|err| format!("IdP 정보가 올바르지 않습니다 ({discovery_url}): {err}"))?;

    if let Some(refresh) = context.refresh_token.as_deref() {
        let renewed = exchange(
            &http,
            &endpoints.token_endpoint,
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", refresh),
                ("client_id", &client_id),
            ],
        )
        .await;
        // A refresh token the provider no longer takes means logging in again.
        if let Ok(token) = renewed {
            return Ok(token);
        }
    }

    let base = REDIRECT_BASE
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
        .ok_or("TablePeek 서버 주소를 몰라 브라우저 로그인을 시작할 수 없습니다")?;
    let redirect_uri = format!("{base}/api/oidc/callback");
    let state = uuid::Uuid::new_v4().simple().to_string();
    let verifier = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(Sha256::digest(verifier.as_bytes()));
    let mut scopes = vec!["openid".to_string()];
    for scope in info.request_scopes.unwrap_or_default() {
        if !scopes.contains(&scope) {
            scopes.push(scope);
        }
    }
    let scope = scopes.join(" ");
    let mut params = vec![
        ("response_type", "code"),
        ("client_id", client_id.as_str()),
        ("redirect_uri", redirect_uri.as_str()),
        ("scope", scope.as_str()),
        ("state", state.as_str()),
        ("code_challenge", challenge.as_str()),
        ("code_challenge_method", "S256"),
    ];
    if let Some(hint) = hint.as_deref() {
        params.push(("login_hint", hint));
    }
    let url = reqwest::Url::parse_with_params(&endpoints.authorization_endpoint, &params)
        .map_err(|err| format!("IdP 로그인 주소가 올바르지 않습니다: {err}"))?;

    let (reply, answer) = oneshot::channel();
    LOGINS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(
            state.clone(),
            Waiting {
                url: url.to_string(),
                issuer: info.issuer.clone(),
                reply,
            },
        );
    let wait = context
        .timeout
        .map(|deadline| deadline.saturating_duration_since(Instant::now()))
        .unwrap_or(LOGIN_TIMEOUT);
    let outcome = tokio::time::timeout(wait, answer).await;
    LOGINS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .remove(&state);
    let code = match outcome {
        Err(_) => return Err("브라우저 로그인 시간이 지났습니다".into()),
        // The login was cancelled (its sender dropped).
        Ok(Err(_)) => return Err("브라우저 로그인을 취소했습니다".into()),
        Ok(Ok(result)) => result?,
    };
    exchange(
        &http,
        &endpoints.token_endpoint,
        &[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", &redirect_uri),
            ("client_id", &client_id),
            ("code_verifier", &verifier),
        ],
    )
    .await
}

/// Posts a token request; the token, when it expires, and a refresh token.
async fn exchange(
    http: &reqwest::Client,
    endpoint: &str,
    form: &[(&str, &str)],
) -> Result<IdpServerResponse, String> {
    let reply: TokenReply = http
        .post(endpoint)
        .form(form)
        .send()
        .await
        .map_err(|err| format!("토큰을 받을 수 없습니다: {err}"))?
        .json()
        .await
        .map_err(|err| format!("토큰 응답이 올바르지 않습니다: {err}"))?;
    let Some(access_token) = reply.access_token else {
        let error = reply.error.unwrap_or_else(|| "access_token 없음".into());
        return Err(match reply.error_description {
            Some(description) => format!("토큰을 받을 수 없습니다: {error} ({description})"),
            None => format!("토큰을 받을 수 없습니다: {error}"),
        });
    };
    Ok(IdpServerResponse::builder()
        .access_token(access_token)
        .expires(
            reply
                .expires_in
                .map(|seconds| Instant::now() + Duration::from_secs(seconds)),
        )
        .refresh_token(reply.refresh_token)
        .build())
}

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::options::oidc::IdpServerInfo;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// One HTTP request: its first line and its body.
    async fn read_request(stream: &mut tokio::net::TcpStream) -> (String, String) {
        let mut data = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            let read = stream.read(&mut buffer).await.unwrap();
            data.extend_from_slice(&buffer[..read]);
            let text = String::from_utf8_lossy(&data).into_owned();
            if let Some((head, body)) = text.split_once("\r\n\r\n") {
                let length = head
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("content-length")
                            .then(|| value.trim().parse::<usize>().ok())?
                    })
                    .unwrap_or(0);
                if body.len() >= length || read == 0 {
                    return (
                        head.lines().next().unwrap_or("").to_string(),
                        body.to_string(),
                    );
                }
            }
        }
    }

    fn form_value(body: &str, name: &str) -> Option<String> {
        reqwest::Url::parse(&format!("http://x/?{body}"))
            .ok()?
            .query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    }

    /// A provider that serves discovery and checks the code exchange's PKCE
    /// verifier against the challenge the login page was asked with.
    async fn provider() -> (String, tokio::task::JoinHandle<()>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let issuer = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let base = issuer.clone();
        let task = tokio::spawn(async move {
            loop {
                let (mut stream, _) = listener.accept().await.unwrap();
                let (line, body) = read_request(&mut stream).await;
                let reply = if line.starts_with("GET /.well-known/openid-configuration") {
                    serde_json::json!({
                        "authorization_endpoint": format!("{base}/authorize"),
                        "token_endpoint": format!("{base}/token"),
                    })
                } else {
                    // The code is the challenge the login page got.
                    let code = form_value(&body, "code").unwrap_or_default();
                    let verifier = form_value(&body, "code_verifier").unwrap_or_default();
                    let hashed = base64::engine::general_purpose::URL_SAFE_NO_PAD
                        .encode(Sha256::digest(verifier.as_bytes()));
                    if hashed == code && form_value(&body, "client_id").as_deref() == Some("tp") {
                        serde_json::json!({ "access_token": "token-1", "expires_in": 60, "refresh_token": "r-1" })
                    } else {
                        serde_json::json!({ "error": "invalid_grant", "error_description": "PKCE mismatch" })
                    }
                };
                let body = reply.to_string();
                let _ = stream
                    .write_all(
                        format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        )
                        .as_bytes(),
                    )
                    .await;
            }
        });
        (issuer, task)
    }

    fn context(issuer: &str) -> CallbackContext {
        CallbackContext::builder()
            .idp_info(Some(
                IdpServerInfo::builder()
                    .issuer(issuer.to_string())
                    .client_id(Some("tp".to_string()))
                    .request_scopes(Some(vec!["mongo".to_string()]))
                    .build(),
            ))
            .build()
    }

    #[tokio::test]
    async fn browser_login_trades_the_callback_code_for_a_token() {
        let (issuer, _provider) = provider().await;
        // The live OIDC test sets the same base (it is process-wide and the
        // tests run side by side); the slash is trimmed.
        set_redirect_base("http://127.0.0.1:9/");
        let login = tokio::spawn(login(context(&issuer), Some("ann@example.com".into())));
        // The page sees the login and the "browser" comes back with a code.
        let waiting = loop {
            if let Some(found) = pending().into_iter().find(|login| login.issuer == issuer) {
                break found;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        let url = reqwest::Url::parse(&waiting.url).unwrap();
        let query = |name: &str| {
            url.query_pairs()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.into_owned())
        };
        assert!(waiting.url.starts_with(&format!("{issuer}/authorize?")));
        assert_eq!(
            query("redirect_uri").as_deref(),
            Some("http://127.0.0.1:9/api/oidc/callback")
        );
        assert_eq!(query("scope").as_deref(), Some("openid mongo"));
        assert_eq!(query("login_hint").as_deref(), Some("ann@example.com"));
        assert_eq!(query("state").as_deref(), Some(waiting.id.as_str()));
        assert!(!finish("forged", Ok("x".into())));
        assert!(finish(&waiting.id, Ok(query("code_challenge").unwrap())));
        let token = login.await.unwrap().expect("login failed");
        assert_eq!(token.access_token, "token-1");
        assert_eq!(token.refresh_token.as_deref(), Some("r-1"));
        assert!(token.expires.is_some());
        assert!(pending().iter().all(|login| login.id != waiting.id));
    }

    #[tokio::test]
    async fn cancelled_and_refused_logins_fail() {
        let (issuer, _provider) = provider().await;
        set_redirect_base("http://127.0.0.1:9");
        let next = || async {
            loop {
                if let Some(found) = pending().into_iter().find(|login| login.issuer == issuer) {
                    break found;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        };
        let login_one = tokio::spawn(login(context(&issuer), None));
        assert!(cancel(&next().await.id));
        assert_eq!(
            login_one.await.unwrap().err().as_deref(),
            Some("브라우저 로그인을 취소했습니다")
        );
        let login_two = tokio::spawn(login(context(&issuer), None));
        finish(&next().await.id, Ok("not-the-challenge".into()));
        assert_eq!(
            login_two.await.unwrap().err().as_deref(),
            Some("토큰을 받을 수 없습니다: invalid_grant (PKCE mismatch)")
        );
    }
}
