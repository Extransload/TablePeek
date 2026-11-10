//! Writing SQL from a request in words, with the user's own model
//! (docs/GUIDE.md#write-sql-with-ai).
//!
//! Off until the user turns it on in Settings › AI, where the provider is
//! chosen by how it is paid for: the ChatGPT plan (sign in, chatgpt.rs), an
//! API key (OpenAI, Anthropic, Gemini, OpenRouter, or any OpenAI-compatible
//! address), or a local server without a key (Ollama, LM Studio, or any
//! address). The provider, each one's model and address live in `ai.json` in
//! the settings folder; each provider's API key lives only in the OS keychain
//! (`ai:<provider>`). A request sends the provider the connection's schema
//! (table and column names, types, keys, foreign keys), the engine's name,
//! the request and the SQL the user selected: never rows. The answer streams
//! back to the page as NDJSON and only ever goes into the editor; nothing
//! here runs it.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::{get, post, put};
use axum::Router;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tablepeek_engine::registry;
use tablepeek_types::{ApiError, Relation, TableSchema};

mod cli;
mod usage;

use super::chatgpt::{self, AuthError, ChatGpt, Endpoints};
use super::{
    authorized, bad_request, engine_error, internal_error, keychain, keyring_error, login_page,
    slot_for, store, store_error, unauthorized, update, AppState, ConnSlot,
};
use cli::{Cli, CliStatus};
use usage::{UsageFile, Window};

type ApiResult<T> = Result<T, (StatusCode, Json<ApiError>)>;

const CONFIG_FILE: &str = "ai.json";
const OPENAI_BASE: &str = "https://api.openai.com/v1";
// Gemini's OpenAI-compatible endpoint: the same request and stream shape.
const GEMINI_BASE: &str = "https://generativelanguage.googleapis.com/v1beta/openai";
const OPENROUTER_BASE: &str = "https://openrouter.ai/api/v1";
const OLLAMA_BASE: &str = "http://localhost:11434/v1";
const LMSTUDIO_BASE: &str = "http://localhost:1234/v1";
const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODELS_URL: &str = "https://api.anthropic.com/v1/models?limit=1000";
const ANTHROPIC_VERSION: &str = "2023-06-01";
// Anthropic requires a cap; a query never comes near it.
const ANTHROPIC_MAX_TOKENS: u32 = 8192;
/// How much schema text a request carries (about 12k tokens). A bigger schema
/// sends the tables the request names, their neighbours by foreign key, and
/// the other tables' names only.
const SCHEMA_BUDGET: usize = 48_000;
const PROMPT_LIMIT: usize = 4_000;
const CONTEXT_LIMIT: usize = 32_000;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
/// The longest a provider may stay silent, before its first byte or between
/// two: a reasoning model can think a while before it writes.
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);
/// How often the page gets the SQL so far.
const PARTIAL_INTERVAL: Duration = Duration::from_millis(50);
const ERROR_BODY_LIMIT: usize = 64 * 1024;

pub fn routes() -> Router<AppState> {
    Router::new()
        // GET `?refresh=true` reads the CLIs' state again.
        .route("/api/ai", get(status).put(configure))
        // Keys only: `{key}` saves, `{clear_key: true}` deletes.
        .route("/api/ai/providers/{id}", put(configure_provider))
        .route("/api/ai/models", get(models))
        .route("/api/ai/usage", get(usage_of))
        .route("/api/ai/sql", post(generate))
        .route("/api/ai/complete", post(complete))
        .route(
            "/api/ai/chatgpt/login",
            post(chatgpt_login).delete(chatgpt_login_cancel),
        )
        .route("/api/ai/chatgpt/logout", post(chatgpt_logout))
        // Where OpenAI sends the browser back: outside /api, so without the
        // page's token; the login's `state` is what it must match.
        .route(chatgpt::CALLBACK_PATH, get(chatgpt_callback))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    /// The user's ChatGPT plan, through Sign in with ChatGPT.
    #[default]
    Chatgpt,
    /// The user's Codex CLI, signed in in a terminal.
    Codex,
    Openai,
    Anthropic,
    Gemini,
    Openrouter,
    Ollama,
    Lmstudio,
}

impl Provider {
    const ALL: [Self; 8] = [
        Self::Chatgpt,
        Self::Codex,
        Self::Openai,
        Self::Anthropic,
        Self::Gemini,
        Self::Openrouter,
        Self::Ollama,
        Self::Lmstudio,
    ];

    fn parse(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|provider| provider.id() == id)
    }

    fn id(self) -> &'static str {
        match self {
            Self::Chatgpt => "chatgpt",
            Self::Codex => "codex",
            Self::Openai => "openai",
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini",
            Self::Openrouter => "openrouter",
            Self::Ollama => "ollama",
            Self::Lmstudio => "lmstudio",
        }
    }

    /// Offered now; the API-key and local-server providers are listed as
    /// coming soon.
    fn available(self) -> bool {
        matches!(self, Self::Chatgpt | Self::Codex | Self::Gemini)
    }

    /// Quick enough for suggestions as you type: an API, not a program
    /// started for each answer.
    fn suggests(self) -> bool {
        self.available() && self.cli().is_none()
    }

    /// The program on this machine it runs.
    fn cli(self) -> Option<Cli> {
        match self {
            Self::Codex => Some(Cli::Codex),
            _ => None,
        }
    }

    fn account(self) -> String {
        format!("ai:{}", self.id())
    }

    fn needs_key(self) -> bool {
        matches!(
            self,
            Self::Openai | Self::Anthropic | Self::Gemini | Self::Openrouter
        )
    }

    /// The OpenAI-compatible address of those spoken to that way.
    fn default_url(self) -> &'static str {
        match self {
            Self::Openai => OPENAI_BASE,
            Self::Gemini => GEMINI_BASE,
            Self::Openrouter => OPENROUTER_BASE,
            Self::Ollama => OLLAMA_BASE,
            Self::Lmstudio => LMSTUDIO_BASE,
            Self::Chatgpt | Self::Codex | Self::Anthropic => "",
        }
    }
}

fn unavailable(provider: Provider) -> (StatusCode, Json<ApiError>) {
    bad_request(
        "provider_unavailable",
        format!(
            "{}는 곧 지원합니다. 설정 › AI에서 ChatGPT, Codex CLI, Gemini 중 하나를 고르세요",
            provider.id()
        ),
    )
}

/// ai.json.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct AiFile {
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    provider: Provider,
    /// The model picked, per provider (the picked provider's is in use).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    models: BTreeMap<Provider, String>,
    /// Suggestions while typing (POST /api/ai/complete).
    #[serde(default)]
    autocomplete: bool,
    /// The model the suggestions use; none is the picked model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    complete_model: Option<ModelRef>,
}

/// A model on a provider.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct ModelRef {
    provider: Provider,
    model: String,
}

impl AiFile {
    /// ai.json as saved, without providers this version doesn't know (an
    /// earlier one's `custom`, addresses it kept): the rest still holds.
    fn read(bytes: &[u8]) -> Self {
        let Ok(mut value) = serde_json::from_slice::<Value>(bytes) else {
            return Self::default();
        };
        let known = |id: &str| Provider::parse(id).is_some();
        if let Some(models) = value.get_mut("models").and_then(Value::as_object_mut) {
            models.retain(|id, _| known(id));
        }
        if value["provider"].as_str().is_some_and(|id| !known(id)) {
            value["provider"] = Value::Null;
        }
        if value["complete_model"]["provider"]
            .as_str()
            .is_some_and(|id| !known(id))
        {
            value["complete_model"] = Value::Null;
        }
        if let Some(object) = value.as_object_mut() {
            object.retain(|_, field| !field.is_null());
        }
        serde_json::from_value(value).unwrap_or_default()
    }

    fn model(&self) -> &str {
        self.models.get(&self.provider).map_or("", String::as_str)
    }

    /// The provider and model suggestions while typing use.
    fn complete_target(&self) -> (Provider, &str) {
        match &self.complete_model {
            Some(target) => (target.provider, target.model.as_str()),
            None => (self.provider, self.model()),
        }
    }
}

/// The settings, held for the server's run and written through to ai.json.
pub struct AiSettings {
    path: PathBuf,
    file: tokio::sync::Mutex<AiFile>,
    chatgpt: ChatGpt,
    /// Each connection's schema as last read (`AiSettings::schema`).
    schemas: std::sync::Mutex<HashMap<String, CachedSchema>>,
    /// Each CLI's state as last read (`AiSettings::cli_status`).
    clis: tokio::sync::Mutex<HashMap<Cli, (Instant, CliStatus)>>,
    /// The CLI programs to run instead of those found (tests).
    cli_bins: std::sync::Mutex<HashMap<Cli, PathBuf>>,
    /// Whether each key provider has a key in the keychain, read once and
    /// kept current as keys are saved and deleted here.
    keys: tokio::sync::Mutex<BTreeMap<Provider, bool>>,
    /// ai-usage.json: windows from answers, Gemini's counts, rate limits.
    usage_path: PathBuf,
    usage: tokio::sync::Mutex<UsageFile>,
    /// The Codex CLI's account and usage as last read live.
    codex_usage: tokio::sync::Mutex<Option<(Instant, Value)>>,
}

impl AiSettings {
    /// Reads `dir`'s ai.json; a missing or unreadable one is the defaults
    /// (off).
    pub fn load(dir: &Path) -> Self {
        Self::with_endpoints(dir, Endpoints::default())
    }

    /// `load`, with ChatGPT's sign-in and API at `endpoints` (tests).
    pub(crate) fn with_endpoints(dir: &Path, endpoints: Endpoints) -> Self {
        let path = dir.join(CONFIG_FILE);
        let file = std::fs::read(&path)
            .map(|bytes| AiFile::read(&bytes))
            .unwrap_or_default();
        let (usage_path, usage_file) = UsageFile::load(dir);
        Self {
            path,
            file: tokio::sync::Mutex::new(file),
            chatgpt: ChatGpt::new(dir, endpoints),
            schemas: std::sync::Mutex::new(HashMap::new()),
            clis: tokio::sync::Mutex::new(HashMap::new()),
            cli_bins: std::sync::Mutex::new(HashMap::new()),
            keys: tokio::sync::Mutex::new(BTreeMap::new()),
            usage_path,
            usage: tokio::sync::Mutex::new(usage_file),
            codex_usage: tokio::sync::Mutex::new(None),
        }
    }

    /// Usage windows an answer reported.
    async fn record_windows(&self, provider: Provider, windows: Vec<Window>) {
        if windows.is_empty() {
            return;
        }
        let mut file = self.usage.lock().await;
        file.set_windows(provider.id(), windows, usage::now());
        file.save(&self.usage_path);
    }

    /// What a sent request leaves to keep: one more on Gemini's quota day
    /// (Google reports none left), or the rate limit a provider refused it
    /// with.
    async fn after_send(&self, provider: Provider, model: &str, sent: &ApiResult<Feed>) {
        let mut file = self.usage.lock().await;
        match sent {
            Ok(_) if provider == Provider::Gemini => {
                file.count(provider.id(), model, usage::now());
            }
            Err((_, Json(error))) if error.code == "ai_rate_limited" => {
                let limit = usage::limit_seen(error.fields.details.as_ref(), usage::now());
                file.set_limit(provider.id(), limit);
            }
            _ => return,
        }
        file.save(&self.usage_path);
    }

    /// The Codex CLI's account and usage, read live again after a minute
    /// (or when `fresh`).
    async fn codex_usage(&self, path: &Path, fresh: bool) -> ApiResult<Value> {
        let mut cached = self.codex_usage.lock().await;
        if let Some((at, value)) = cached.as_ref() {
            if !fresh && at.elapsed() < CODEX_USAGE_TTL {
                return Ok(value.clone());
            }
        }
        let read = cli::codex_usage(path)
            .await
            .map_err(|message| bad_request("ai_provider_error", message))?;
        let value = json!({
            "account": { "email": read.email, "plan": read.plan, "workspace": read.workspace },
            "windows": read.windows,
            "credits": read.credits.map(|credits| json!({
                "has_credits": credits["hasCredits"].as_bool().unwrap_or(false),
                "unlimited": credits["unlimited"].as_bool().unwrap_or(false),
                "balance": credits["balance"].as_str(),
            })),
            "as_of": usage::now(),
        });
        *cached = Some((Instant::now(), value.clone()));
        Ok(value)
    }

    /// Runs `program` for `cli` instead of the one installed (tests).
    #[cfg(test)]
    fn use_cli(&self, cli: Cli, program: PathBuf) {
        lock(&self.cli_bins).insert(cli, program);
        if let Ok(mut clis) = self.clis.try_lock() {
            clis.remove(&cli);
        }
    }

    fn cli_path(&self, cli: Cli) -> Option<PathBuf> {
        lock(&self.cli_bins)
            .get(&cli)
            .cloned()
            .or_else(|| cli::find(cli))
    }

    /// Whether the CLI is installed and signed in, read again after a while
    /// (or when `fresh`): the user installs or signs in in a terminal.
    async fn cli_status(&self, cli: Cli, fresh: bool) -> CliStatus {
        let mut clis = self.clis.lock().await;
        if let Some((at, status)) = clis.get(&cli) {
            if !fresh && at.elapsed() < CLI_STATUS_TTL {
                return status.clone();
            }
        }
        let status = cli::status(cli, self.cli_path(cli)).await;
        clis.insert(cli, (Instant::now(), status.clone()));
        status
    }

    /// The CLI's program, once it is installed and signed in.
    async fn ready_cli(&self, cli: Cli) -> ApiResult<PathBuf> {
        let status = self.cli_status(cli, false).await;
        let status = if status.installed && status.signed_in {
            status
        } else {
            // Installed or signed in since: look again before refusing.
            self.cli_status(cli, true).await
        };
        match (status.installed, status.signed_in, status.path) {
            (true, true, Some(path)) => Ok(PathBuf::from(path)),
            (true, _, _) => Err(bad_request(
                "ai_cli_signed_out",
                format!(
                    "{}에 로그인하지 않았습니다. {}",
                    cli.label(),
                    cli.sign_in_hint()
                ),
            )),
            _ => Err(cli_missing(cli)),
        }
    }
}

fn cli_missing(cli: Cli) -> (StatusCode, Json<ApiError>) {
    bad_request(
        "ai_cli_missing",
        format!("{}를 찾을 수 없습니다. {}", cli.label(), cli.install_hint()),
    )
}

fn persist(path: &Path, file: &AiFile) -> Result<(), String> {
    let write = || -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(file)?)?;
        std::fs::rename(&tmp, path)
    };
    write().map_err(|err| format!("AI 설정을 저장할 수 없습니다: {err}"))
}

/// What GET and PUT /api/ai answer.
#[derive(Debug, Serialize)]
struct AiStatus {
    enabled: bool,
    /// The picked model's provider and name.
    provider: Provider,
    model: String,
    /// Suggestions while typing, and the model they use (null: `model`).
    autocomplete: bool,
    complete_model: Option<ModelRef>,
    /// Every provider but ChatGPT: offered yet, and a CLI's state.
    providers: BTreeMap<Provider, ProviderStatus>,
    chatgpt: chatgpt::Status,
}

#[derive(Debug, Serialize)]
struct ProviderStatus {
    available: bool,
    /// A provider paid with an API key: whether one is saved.
    #[serde(skip_serializing_if = "Option::is_none")]
    has_key: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cli: Option<CliStatus>,
}

/// How long a CLI's installed and signed-in state is reused.
const CLI_STATUS_TTL: Duration = Duration::from_secs(30);

async fn status_of(file: &AiFile, ai: &AiSettings, fresh: bool) -> AiStatus {
    let mut providers = BTreeMap::new();
    for provider in Provider::ALL {
        if provider == Provider::Chatgpt {
            continue;
        }
        let cli = match provider.cli() {
            Some(cli) => Some(ai.cli_status(cli, fresh).await),
            None => None,
        };
        let has_key = if provider.needs_key() {
            Some(ai.has_key(provider).await)
        } else {
            None
        };
        providers.insert(
            provider,
            ProviderStatus {
                available: provider.available(),
                has_key,
                cli,
            },
        );
    }
    AiStatus {
        enabled: file.enabled,
        provider: file.provider,
        model: file.model().to_string(),
        autocomplete: file.autocomplete,
        complete_model: file.complete_model.clone(),
        providers,
        chatgpt: ai.chatgpt.status().await,
    }
}

#[derive(Debug, Default, Deserialize)]
struct StatusQuery {
    /// Read the CLIs' state again (Settings › AI's Refresh).
    #[serde(default)]
    refresh: bool,
}

async fn status(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<StatusQuery>,
) -> ApiResult<Json<AiStatus>> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let file = state.ai.file.lock().await.clone();
    Ok(Json(status_of(&file, &state.ai, query.refresh).await))
}

fn parse_provider(id: &str) -> ApiResult<Provider> {
    Provider::parse(id).ok_or_else(|| {
        bad_request(
            "invalid_request",
            format!("알 수 없는 AI 제공자입니다: {id}"),
        )
    })
}

/// Writes ai.json with `change` made, and keeps it.
async fn update_file(state: &AppState, change: impl FnOnce(&mut AiFile)) -> ApiResult<AiFile> {
    let mut file = state.ai.file.lock().await;
    let mut next = file.clone();
    change(&mut next);
    persist(&state.ai.path, &next).map_err(store_error)?;
    *file = next.clone();
    Ok(next)
}

/// PUT /api/ai: on or off, the model picked (with its provider), and the
/// suggestions while typing with theirs (`complete_model: null` is the
/// picked model).
#[derive(Debug, Default, Deserialize)]
struct AiPatch {
    enabled: Option<bool>,
    provider: Option<String>,
    model: Option<String>,
    autocomplete: Option<bool>,
    #[serde(default, deserialize_with = "present")]
    complete_model: Option<Option<ModelPatch>>,
}

#[derive(Debug, Deserialize)]
struct ModelPatch {
    provider: String,
    model: String,
}

/// A field that is there, `null` included: `Some(None)` clears it.
fn present<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

async fn configure(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(patch): Json<AiPatch>,
) -> ApiResult<Json<AiStatus>> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let provider = patch.provider.as_deref().map(parse_provider).transpose()?;
    if let Some(provider) = provider.filter(|provider| !provider.available()) {
        return Err(unavailable(provider));
    }
    let complete_model = match &patch.complete_model {
        None => None,
        Some(None) => Some(None),
        Some(Some(target)) => {
            let model = target.model.trim();
            if model.is_empty() {
                return Err(bad_request("invalid_request", "자동 제안 모델을 고르세요"));
            }
            let provider = parse_provider(&target.provider)?;
            if !provider.suggests() {
                return Err(complete_unsupported());
            }
            Some(Some(ModelRef {
                provider,
                model: model.to_string(),
            }))
        }
    };
    let file = update_file(&state, |next| {
        if let Some(autocomplete) = patch.autocomplete {
            next.autocomplete = autocomplete;
        }
        if let Some(target) = complete_model {
            next.complete_model = target;
        }
        if let Some(enabled) = patch.enabled {
            next.enabled = enabled;
        }
        if let Some(provider) = provider {
            next.provider = provider;
        }
        if let Some(model) = patch.model.as_deref().map(str::trim) {
            if model.is_empty() {
                next.models.remove(&next.provider);
            } else {
                next.models.insert(next.provider, model.to_string());
            }
        }
    })
    .await?;
    Ok(Json(status_of(&file, &state.ai, false).await))
}

/// How long the Codex CLI's usage is reused before it is read again.
const CODEX_USAGE_TTL: Duration = Duration::from_secs(60);

#[derive(Debug, Deserialize)]
struct UsageQuery {
    provider: String,
    /// Read again what is read live (Codex).
    #[serde(default)]
    refresh: bool,
}

/// GET /api/ai/usage?provider=: a connection's account and the usage left,
/// as far as it says: live from the Codex CLI, from ChatGPT's last answer,
/// counted here for Gemini (Google reports none).
async fn usage_of(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<UsageQuery>,
) -> ApiResult<Json<Value>> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let provider = parse_provider(&query.provider)?;
    if !provider.available() {
        return Err(unavailable(provider));
    }
    let at = usage::now();
    let (last, today, limit) = {
        let file = state.ai.usage.lock().await;
        (
            file.windows(provider.id())
                .map(|(windows, at)| (windows.to_vec(), at)),
            file.today(provider.id(), at),
            file.limit(provider.id()).cloned(),
        )
    };
    let mut answer = json!({
        "provider": provider,
        "account": null,
        "windows": [],
        "credits": null,
        "today": today
            .iter()
            .map(|(model, requests)| json!({ "model": model, "requests": requests }))
            .collect::<Vec<_>>(),
        "limit": limit,
        "as_of": null,
        "source": "none",
    });
    match provider {
        Provider::Codex => {
            let path = state.ai.ready_cli(Cli::Codex).await?;
            let live = state.ai.codex_usage(&path, query.refresh).await?;
            for key in ["account", "windows", "credits", "as_of"] {
                answer[key] = live[key].clone();
            }
            answer["source"] = json!("live");
        }
        Provider::Chatgpt => {
            let status = state.ai.chatgpt.status().await;
            if status.signed_in {
                answer["account"] =
                    json!({ "email": status.email, "plan": null, "workspace": null });
            }
            // What ChatGPT's last answer said is left of the plan.
            if let Some((windows, at)) = &last {
                answer["windows"] = json!(windows);
                answer["as_of"] = json!(at);
                answer["source"] = json!("last_answer");
            }
        }
        // Google tells no remaining quota: what was sent from here today,
        // against the daily limit its last refusal named.
        _ => {
            answer["source"] = json!("local");
            if let Some(limit) = limit.filter(|limit| limit.per_day) {
                if let (Some(model), Some(cap)) = (&limit.model, limit.limit.filter(|cap| *cap > 0))
                {
                    let sent: u64 = today
                        .iter()
                        .filter(|(name, _)| usage::same_quota(name, model))
                        .map(|(_, requests)| requests)
                        .sum();
                    let used = (sent as f64 / cap as f64 * 100.0).min(100.0);
                    answer["windows"] = json!([{
                        "kind": "daily",
                        "minutes": 1440,
                        "used_percent": used,
                        "resets_at": usage::next_pacific_midnight(at),
                    }]);
                    answer["as_of"] = json!(at);
                }
            }
        }
    }
    Ok(Json(answer))
}

/// Suggestions come from an API (ChatGPT, Gemini): a CLI takes seconds to
/// start for each answer.
fn complete_unsupported() -> (StatusCode, Json<ApiError>) {
    bad_request(
        "ai_complete_unsupported",
        "CLI는 응답에 몇 초 걸려 입력 중 제안에 쓸 수 없습니다. 제안 모델은 ChatGPT나 Gemini에서 고르세요",
    )
}

impl AiSettings {
    async fn has_key(&self, provider: Provider) -> bool {
        let mut keys = self.keys.lock().await;
        if let Some(known) = keys.get(&provider) {
            return *known;
        }
        let account = provider.account();
        let found = keychain(move || store::get_password(&account).is_some()).await;
        keys.insert(provider, found);
        found
    }
}

/// PUT /api/ai/providers/{id}: a key provider's API key, saved in the OS
/// keychain (`ai:<id>`) or deleted.
#[derive(Debug, Default, Deserialize)]
struct ProviderPatch {
    key: Option<String>,
    #[serde(default)]
    clear_key: bool,
}

async fn configure_provider(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
    Json(patch): Json<ProviderPatch>,
) -> ApiResult<Json<AiStatus>> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let provider = parse_provider(&id)?;
    if !provider.needs_key() {
        return Err(bad_request(
            "invalid_request",
            "이 제공자는 API 키를 쓰지 않습니다",
        ));
    }
    if !provider.available() {
        return Err(unavailable(provider));
    }
    let account = provider.account();
    if patch.clear_key {
        keychain(move || store::delete_password(&account)).await;
        state.ai.keys.lock().await.insert(provider, false);
    } else {
        let key = patch.key.as_deref().map(str::trim).unwrap_or_default();
        if key.is_empty() {
            return Err(bad_request("invalid_request", "API 키가 비어 있습니다"));
        }
        let key = key.to_string();
        keychain(move || store::set_password(&account, &key))
            .await
            .map_err(keyring_error)?;
        state.ai.keys.lock().await.insert(provider, true);
    }
    let file = state.ai.file.lock().await.clone();
    Ok(Json(status_of(&file, &state.ai, false).await))
}

/// What a failed token or call says to the page.
fn auth_error(err: AuthError) -> (StatusCode, Json<ApiError>) {
    match err {
        AuthError::SignedOut => bad_request(
            "ai_not_configured",
            "ChatGPT에 로그인하지 않았습니다. 설정 › AI에서 로그인하세요",
        ),
        AuthError::Ended => bad_request(
            "ai_signed_out",
            "ChatGPT 로그인이 끝났습니다. 다시 로그인하세요",
        ),
        AuthError::Failed(message) => (
            StatusCode::BAD_GATEWAY,
            Json(ApiError::new("ai_network", message)),
        ),
        AuthError::Refused(message) => (
            StatusCode::BAD_GATEWAY,
            Json(ApiError::new("ai_provider_error", message)),
        ),
    }
}

#[derive(Debug, Default, Deserialize)]
struct LoginRequest {
    #[serde(default)]
    new_account: bool,
}

/// POST /api/ai/chatgpt/login: the URL the page opens in the browser.
async fn chatgpt_login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<LoginRequest>,
) -> ApiResult<Json<Value>> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    // The address pages are served at, which OpenAI sends the browser back to.
    let host = state
        .allowed_hosts
        .first()
        .ok_or_else(|| internal_error("서버 주소를 알 수 없습니다"))?;
    let url = state
        .ai
        .chatgpt
        .begin(host, req.new_account)
        .await
        .map_err(internal_error)?;
    Ok(Json(json!({ "url": url })))
}

/// DELETE /api/ai/chatgpt/login: stop waiting for the browser.
async fn chatgpt_login_cancel(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Json<AiStatus>> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    state.ai.chatgpt.cancel();
    let file = state.ai.file.lock().await.clone();
    Ok(Json(status_of(&file, &state.ai, false).await))
}

/// POST /api/ai/chatgpt/logout. `revoked: false`: the tokens are gone here,
/// but OpenAI didn't confirm; disconnecting in ChatGPT's settings ends it.
async fn chatgpt_logout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let revoked = state.ai.chatgpt.sign_out().await.map_err(store_error)?;
    let file = state.ai.file.lock().await.clone();
    let status = status_of(&file, &state.ai, false).await;
    Ok(Json(json!({ "revoked": revoked, "status": status })))
}

#[derive(Debug, Deserialize)]
struct ModelsQuery {
    provider: String,
}

#[derive(Debug, Serialize)]
struct ModelEntry {
    id: String,
    name: String,
}

/// GET /api/ai/models?provider=: the provider's models as it lists them now
/// (the account's, for ChatGPT; the CLI's own catalog or aliases).
async fn models(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ModelsQuery>,
) -> ApiResult<Json<Value>> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let provider = parse_provider(&query.provider)?;
    if !provider.available() {
        return Err(unavailable(provider));
    }
    let models: Vec<ModelEntry> = match (provider.cli(), provider) {
        (Some(cli), _) => {
            let path = state.ai.cli_path(cli).ok_or_else(|| cli_missing(cli))?;
            cli::models(cli, &path)
                .await
                .map_err(|message| bad_request("ai_provider_error", message))?
                .into_iter()
                .map(|(id, name)| ModelEntry { id, name })
                .collect()
        }
        (None, Provider::Chatgpt) => state
            .ai
            .chatgpt
            .models()
            .await
            .map_err(auth_error)?
            .into_iter()
            .map(|model| ModelEntry {
                id: model.slug,
                name: model.display_name,
            })
            .collect(),
        (None, Provider::Anthropic) => {
            let key = stored_key(Provider::Anthropic).await?.unwrap_or_default();
            let body = list(ANTHROPIC_MODELS_URL, |request| {
                request
                    .header("x-api-key", &key)
                    .header("anthropic-version", ANTHROPIC_VERSION)
            })
            .await?;
            entries(&body, |item| item["display_name"].as_str())
        }
        (None, provider) => {
            let url = provider.default_url();
            let key = stored_key(provider).await?;
            let body = list(&format!("{url}/models"), |request| match &key {
                Some(key) => request.bearer_auth(key),
                None => request,
            })
            .await?;
            let mut models = entries(&body, |item| item["name"].as_str());
            // OpenAI and Gemini list every kind of model, in no order.
            if matches!(provider, Provider::Openai | Provider::Gemini) {
                models.retain(|model| !NOT_CHAT.iter().any(|kind| model.id.contains(kind)));
                models.sort_by(|a, b| a.id.cmp(&b.id));
            }
            models
        }
    };
    Ok(Json(json!({ "models": models })))
}

/// Model ids of OpenAI's and Gemini's that aren't for writing text.
const NOT_CHAT: [&str; 17] = [
    "embedding",
    "tts",
    "whisper",
    "dall-e",
    "davinci",
    "babbage",
    "moderation",
    "transcribe",
    "audio",
    "realtime",
    "image",
    "search",
    "computer-use",
    "sora",
    "aqa",
    "imagen",
    "veo",
];

/// A model list's `data` entries; Gemini's ids come as `models/<id>`.
fn entries(body: &Value, name: impl Fn(&Value) -> Option<&str>) -> Vec<ModelEntry> {
    let items = body["data"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default();
    items
        .iter()
        .filter_map(|item| {
            let id = item["id"].as_str()?;
            let id = id.strip_prefix("models/").unwrap_or(id).to_string();
            let name = name(item).map_or_else(|| id.clone(), str::to_string);
            Some(ModelEntry { id, name })
        })
        .collect()
}

/// GETs a model list. A local server that isn't running fails at once.
async fn list(
    url: &str,
    auth: impl FnOnce(reqwest::RequestBuilder) -> reqwest::RequestBuilder,
) -> ApiResult<Value> {
    let response = auth(http()?.get(url).timeout(Duration::from_secs(20)))
        .send()
        .await
        .map_err(|err| network_error(url, &describe(&err)))?;
    let status = response.status();
    let body = read_capped(response).await;
    if !status.is_success() {
        return Err(provider_error(status, &body));
    }
    serde_json::from_str(&body).map_err(|_| {
        (
            StatusCode::BAD_GATEWAY,
            Json(ApiError::new(
                "ai_provider_error",
                "AI 제공자가 모델 목록을 알아볼 수 없는 형식으로 보냈습니다",
            )),
        )
    })
}

/// GET /auth/callback: the browser back from OpenAI. The page it shows only
/// says what happened; the settings page learns it from GET /api/ai.
async fn chatgpt_callback(
    State(state): State<AppState>,
    Query(callback): Query<chatgpt::Callback>,
) -> Response {
    match state.ai.chatgpt.finish(callback).await {
        None => login_page(
            StatusCode::BAD_REQUEST,
            "로그인을 기다리지 않습니다",
            "TablePeek 설정 › AI에서 다시 로그인하세요. No sign-in is waiting; start it again in TablePeek.",
        ),
        Some(Err(error)) => login_page(
            StatusCode::OK,
            "ChatGPT에 로그인하지 못했습니다",
            &format!("ChatGPT 로그인 실패: {error}"),
        ),
        Some(Ok(())) => login_page(
            StatusCode::OK,
            "ChatGPT에 로그인했습니다",
            "이 탭을 닫고 TablePeek으로 돌아가세요. Signed in; close this tab and return to TablePeek.",
        ),
    }
}

#[derive(Debug, Deserialize)]
struct GenerateRequest {
    conn: Option<String>,
    prompt: String,
    /// The SQL selected in the editor, which the request is about.
    #[serde(default)]
    context: Option<String>,
}

/// POST /api/ai/sql. Failures known at once are plain errors; after that the
/// body is NDJSON: `{"status":"schema"}` while the schema is read,
/// `{"status":"model","tables":n}` while the model works, `{"partial": sql so
/// far}` lines, then `{"done": {sql, read_only, timing}}` or `{"error":
/// {code, message}}`. A page that stops reading drops the provider's request
/// with it.
async fn generate(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<GenerateRequest>,
) -> ApiResult<Response> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let file = state.ai.file.lock().await.clone();
    if !file.enabled {
        return Err(bad_request(
            "ai_disabled",
            "AI로 SQL 작성이 꺼져 있습니다. 설정 › AI에서 켜세요",
        ));
    }
    let prompt = req.prompt.trim();
    if prompt.is_empty() {
        return Err(bad_request("invalid_request", "원하는 쿼리를 설명하세요"));
    }
    if prompt.chars().count() > PROMPT_LIMIT {
        return Err(bad_request(
            "invalid_request",
            format!("요청이 너무 깁니다 ({PROMPT_LIMIT}자까지)"),
        ));
    }
    let context = req
        .context
        .as_deref()
        .map(str::trim)
        .filter(|sql| !sql.is_empty());
    if context.is_some_and(|sql| sql.chars().count() > CONTEXT_LIMIT) {
        return Err(bad_request(
            "invalid_request",
            format!("선택한 SQL이 너무 깁니다 ({CONTEXT_LIMIT}자까지)"),
        ));
    }
    if !file.provider.available() {
        return Err(unavailable(file.provider));
    }
    if file.model().is_empty() {
        return Err(bad_request(
            "ai_not_configured",
            "모델을 고르지 않았습니다. 설정 › AI에서 모델을 고르세요",
        ));
    }

    let (slot, label, family) = sql_target(&state, req.conn.as_deref()).await?;
    let call = call_for(&state, file.provider, file.model().to_string()).await?;
    let ask = Ask {
        ai: state.ai.clone(),
        slot,
        label,
        family,
        context: context.map(str::to_string),
        prompt: prompt.to_string(),
        provider: file.provider,
        call,
        started: Instant::now(),
    };
    Ok(answer(ask))
}

/// The connection a request writes for, with its engine's name and family;
/// only SQL engines take one.
async fn sql_target(
    state: &AppState,
    conn: Option<&str>,
) -> ApiResult<(Arc<ConnSlot>, String, String)> {
    let slot = slot_for(state, conn).await?;
    // The summary's kind tells CockroachDB from the PostgreSQL driver it uses.
    let kind = match slot.last_summary() {
        Some(summary) => summary.kind,
        None => slot.engine.engine_id().map_err(engine_error)?.to_string(),
    };
    let Some(descriptor) = registry::factory(&kind)
        .map(|factory| factory.descriptor())
        .filter(|descriptor| descriptor.paradigm == "sql")
    else {
        return Err(bad_request(
            "unsupported_capability",
            "AI로 SQL 작성은 SQL 데이터베이스에서만 쓸 수 있습니다",
        ));
    };
    Ok((slot, descriptor.label.clone(), descriptor.family.clone()))
}

/// How `model` on `provider` is asked, with its key, sign-in or program.
async fn call_for(state: &AppState, provider: Provider, model: String) -> ApiResult<Call> {
    if let Some(cli) = provider.cli() {
        return Ok(Call {
            api: Api::Cli(cli, state.ai.ready_cli(cli).await?),
            model,
            key: None,
            effort: None,
        });
    }
    Ok(match provider {
        // The access token, renewed when it is about to run out.
        Provider::Chatgpt => Call {
            api: Api::Responses(format!("{}/responses", state.ai.chatgpt.api())),
            model,
            key: Some(state.ai.chatgpt.access_token().await.map_err(auth_error)?),
            effort: None,
        },
        Provider::Anthropic => Call {
            api: Api::Anthropic,
            model,
            key: stored_key(Provider::Anthropic).await?,
            effort: None,
        },
        // The rest speak the chat completions API at their address.
        provider => Call {
            api: Api::Chat(format!("{}/chat/completions", provider.default_url())),
            // Gemini's thinking models think at length by default and
            // stream nothing meanwhile; a query needs little of it.
            effort: (provider == Provider::Gemini && thinks(&model)).then_some("low"),
            key: stored_key(provider).await?,
            model,
        },
    })
}

/// Text around the cursor a suggestion reads.
const BEFORE_LIMIT: usize = 8_000;
const AFTER_LIMIT: usize = 3_000;
/// Schema a suggestion carries: half a request's, to stay quick.
const COMPLETE_SCHEMA_BUDGET: usize = 24_000;
/// The longest a suggestion may take; later, the user has typed on.
const COMPLETE_TIMEOUT: Duration = Duration::from_secs(30);
const CURSOR: &str = "<CURSOR>";

#[derive(Debug, Deserialize)]
struct CompleteRequest {
    conn: Option<String>,
    #[serde(default)]
    before: String,
    #[serde(default)]
    after: String,
}

/// POST /api/ai/complete: the text to insert at the cursor, `{"completion"}`
/// (empty when nothing fits). The page cancels it by dropping the request.
async fn complete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<CompleteRequest>,
) -> ApiResult<Json<Value>> {
    if !authorized(&state, &headers, None) {
        return Err(unauthorized());
    }
    let file = state.ai.file.lock().await.clone();
    if !file.enabled {
        return Err(bad_request(
            "ai_disabled",
            "AI로 SQL 작성이 꺼져 있습니다. 설정 › AI에서 켜세요",
        ));
    }
    if !file.autocomplete {
        return Err(bad_request(
            "ai_autocomplete_off",
            "입력하는 동안 제안이 꺼져 있습니다. 설정 › AI에서 켜세요",
        ));
    }
    let (provider, model) = file.complete_target();
    if !provider.suggests() {
        return Err(complete_unsupported());
    }
    if model.is_empty() {
        return Err(bad_request(
            "ai_not_configured",
            "모델을 고르지 않았습니다. 설정 › AI에서 모델을 고르세요",
        ));
    }
    let before = tail(&req.before, BEFORE_LIMIT);
    let after = head(&req.after, AFTER_LIMIT);
    let (slot, label, family) = sql_target(&state, req.conn.as_deref()).await?;
    let call = call_for(&state, provider, model.to_string()).await?;
    let (tables, relations) = state.ai.schema(&slot).await?;
    let system = complete_system_prompt(&label, &family);
    let user = complete_user_prompt(&label, &tables, &relations, before, after);
    let asked = async {
        let sent = call.send(&system, &user).await;
        state.ai.after_send(provider, &call.model, &sent).await;
        collect(sent?).await
    };
    let raw = match tokio::time::timeout(COMPLETE_TIMEOUT, asked).await {
        Err(_) => {
            return Err(network_error(
                call.endpoint(),
                "응답이 없습니다 (시간 초과)",
            ))
        }
        Ok(raw) => raw?,
    };
    Ok(Json(
        json!({ "completion": clean_completion(&raw, before, after) }),
    ))
}

/// The last `limit` characters of `text` (`limit` above zero).
fn tail(text: &str, limit: usize) -> &str {
    match text.char_indices().rev().nth(limit.saturating_sub(1)) {
        Some((at, _)) => &text[at..],
        None => text,
    }
}

/// The first `limit` characters of `text`.
fn head(text: &str, limit: usize) -> &str {
    match text.char_indices().nth(limit) {
        Some((at, _)) => &text[..at],
        None => text,
    }
}

fn complete_system_prompt(label: &str, family: &str) -> String {
    let mut text = format!(
        "You are the autocomplete of TablePeek's {label} editor. In the user's text, {CURSOR} marks the cursor. Answer with exactly the text to insert there and nothing else: no Markdown fences, no explanation, and none of the text already before or after the cursor.\n\
         - Continue what is being typed: finish the word, the clause or the statement. Keep it short, a clause or a line; write a whole statement only when the cursor starts one, or the line above is a `--` comment asking for one.\n\
         - Use only the tables and columns in the schema, and quote identifiers the way {label} needs.\n\
         - Begin with a space or a line break when the text needs one there.\n\
         - If nothing useful fits, answer with nothing.\n"
    );
    if let Some(note) = family_note(family) {
        text.push_str("- ");
        text.push_str(note);
        text.push('\n');
    }
    text
}

fn complete_user_prompt(
    label: &str,
    tables: &[TableSchema],
    relations: &[Relation],
    before: &str,
    after: &str,
) -> String {
    // The tables named near the cursor come first in a big schema.
    let hint = format!("{}\n{}", tail(before, 2_000), head(after, 500));
    let mut text = format!("{label} schema:\n");
    text.push_str(&schema_text(
        tables,
        relations,
        &hint,
        COMPLETE_SCHEMA_BUDGET,
    ));
    text.push_str("\nEditor text:\n");
    text.push_str(before);
    text.push_str(CURSOR);
    text.push_str(after);
    text
}

/// A provider's whole answer, read to its end.
async fn collect(mut feed: Feed) -> ApiResult<String> {
    let mut raw = String::new();
    loop {
        let events = match feed.next().await {
            Ok(Some(events)) => events,
            Ok(None) => break,
            Err(error) => return Err((StatusCode::BAD_GATEWAY, Json(error))),
        };
        for event in events {
            match event {
                Event::Text(text) => raw.push_str(&text),
                Event::Error { code, message } => {
                    return Err((
                        StatusCode::BAD_GATEWAY,
                        Json(stream_api_error(code, &message)),
                    ));
                }
                // Suggestions don't update what the settings show.
                Event::Done | Event::Skip | Event::Limits(_) => {}
            }
        }
    }
    if raw.is_empty() {
        if let Some(text) = feed.whole() {
            raw = text;
        }
    }
    Ok(raw)
}

/// The suggestion as it goes in: unfenced, without the cursor mark, and
/// without what the model repeated of the text around the cursor.
fn clean_completion(raw: &str, before: &str, after: &str) -> String {
    let text = if raw.contains("```") {
        clean_sql(raw)
    } else {
        raw
    };
    let text = text.replace(CURSOR, "");
    let mut text = text.trim_end().to_string();
    // What the model repeated of the text before the cursor: "SELECT * FROM
    // us" + "users" → "ers", "… FROM" + "FROM demo" → " demo". Under three
    // characters only the whole word being typed counts, so a suggestion
    // that merely begins with the same letter stays.
    let word = before.len()
        - before
            .trim_end_matches(|c: char| c.is_alphanumeric() || c == '_')
            .len();
    let echoed = (1..=text.len().min(before.len()))
        .rev()
        .filter(|&len| text.is_char_boundary(len))
        .find(|&len| (len >= 3 || len == word) && before.ends_with(&text[..len]));
    if let Some(len) = echoed {
        text.drain(..len);
    }
    // The closing text already after the cursor: "count(" + "*)" before ")"
    // → "*".
    let closing = after.trim_start_matches([' ', '\t']);
    let repeated = (1..=text.len().min(closing.len()))
        .rev()
        .filter(|&len| closing.is_char_boundary(len) && text.is_char_boundary(text.len() - len))
        .find(|&len| text.ends_with(&closing[..len]) && !closing[..len].trim().is_empty());
    if let Some(len) = repeated {
        text.truncate(text.len() - len);
    }
    text
}

/// Gemini models that take `reasoning_effort` (all since 2.5).
fn thinks(model: &str) -> bool {
    !["gemini-1", "gemini-2.0"]
        .iter()
        .any(|old| model.starts_with(old))
}

/// How long a connection's schema is reused for the next request.
const SCHEMA_TTL: Duration = Duration::from_secs(120);

/// A connection's schema as last read, for requests that follow soon.
struct CachedSchema {
    at: Instant,
    /// The database it was read in (a switch reads again).
    database: Option<String>,
    tables: Arc<Vec<TableSchema>>,
    relations: Arc<Vec<Relation>>,
}

impl AiSettings {
    /// The connection's tables and foreign keys, read again only after a
    /// while or another database.
    async fn schema(
        &self,
        slot: &ConnSlot,
    ) -> Result<(Arc<Vec<TableSchema>>, Arc<Vec<Relation>>), (StatusCode, Json<ApiError>)> {
        let database = slot.last_summary().and_then(|summary| summary.path);
        if let Some(cached) = lock(&self.schemas).get(&slot.id) {
            if cached.database == database && cached.at.elapsed() < SCHEMA_TTL {
                return Ok((cached.tables.clone(), cached.relations.clone()));
            }
        }
        let tables = Arc::new(slot.engine.schema(false).await.map_err(engine_error)?);
        // Foreign keys only help; an engine without them (CQL) still writes.
        let relations = Arc::new(slot.engine.relations(false).await.unwrap_or_default());
        lock(&self.schemas).insert(
            slot.id.clone(),
            CachedSchema {
                at: Instant::now(),
                database,
                tables: tables.clone(),
                relations: relations.clone(),
            },
        );
        Ok((tables, relations))
    }
}

fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A request found well formed, to be answered in the stream.
struct Ask {
    ai: Arc<AiSettings>,
    slot: Arc<ConnSlot>,
    label: String,
    family: String,
    context: Option<String>,
    prompt: String,
    call: Call,
    provider: Provider,
    started: Instant,
}

enum Step {
    Start(Box<Ask>),
    Schema(Box<Ask>),
    Send(Box<Ask>, String, String, u64),
    Relay(Box<Relay>),
}

fn millis(since: Instant) -> u64 {
    u64::try_from(since.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn line(value: &Value) -> Bytes {
    Bytes::from(format!("{value}\n"))
}

/// The answer as NDJSON: which step it is on, then the SQL as it comes.
fn answer(ask: Ask) -> Response {
    let steps = futures_util::stream::unfold(Some(Step::Start(Box::new(ask))), |step| async move {
        match step? {
            Step::Start(ask) => Some((
                line(&json!({ "status": "schema" })),
                Some(Step::Schema(ask)),
            )),
            Step::Schema(ask) => match ask.ai.schema(&ask.slot).await {
                Err((_, Json(error))) => Some((line(&json!({ "error": error })), None)),
                Ok((tables, relations)) => {
                    let system = system_prompt(&ask.label, &ask.family);
                    let user = user_prompt(
                        &ask.label,
                        &tables,
                        &relations,
                        ask.context.as_deref(),
                        &ask.prompt,
                    );
                    let status = json!({ "status": "model", "tables": tables.len() });
                    let schema_ms = millis(ask.started);
                    Some((
                        line(&status),
                        Some(Step::Send(ask, system, user, schema_ms)),
                    ))
                }
            },
            Step::Send(ask, system, user, schema_ms) => {
                let sent = ask.call.send(&system, &user).await;
                ask.ai
                    .after_send(ask.provider, &ask.call.model, &sent)
                    .await;
                match sent {
                    Err((_, Json(error))) => Some((line(&json!({ "error": error })), None)),
                    Ok(feed) => {
                        relay_next(Box::new(Relay {
                            feed,
                            ai: ask.ai.clone(),
                            provider: ask.provider,
                            raw: String::new(),
                            done: false,
                            shown: 0,
                            last: Instant::now(),
                            started: ask.started,
                            schema_ms,
                            first_ms: None,
                        }))
                        .await
                    }
                }
            }
            Step::Relay(relay) => relay_next(relay).await,
        }
    })
    .map(Ok::<_, Infallible>);
    (
        [
            (header::CONTENT_TYPE, "application/x-ndjson"),
            (header::CACHE_CONTROL, "no-cache"),
        ],
        Body::from_stream(steps),
    )
        .into_response()
}

/// The provider's key from the keychain; a provider that needs one fails
/// without it.
async fn stored_key(provider: Provider) -> ApiResult<Option<String>> {
    let account = provider.account();
    let key = keychain(move || store::get_password(&account)).await;
    if key.is_none() && provider.needs_key() {
        return Err(bad_request(
            "ai_not_configured",
            "API 키가 없습니다. 설정 › AI에서 키를 저장하세요",
        ));
    }
    Ok(key)
}

fn system_prompt(label: &str, family: &str) -> String {
    let mut text = format!(
        "You write {label} queries for TablePeek, a database client. Turn the user's request into one {label} statement, or a few only when the request needs them.\n\
         - Always start the answer with a `--` comment line that sums up what the query does (what it returns or changes), in the request's language, and put the query on the lines below it. For example:\n\
           -- Ten most recent orders with their customer's name\n\
           SELECT o.*, c.name FROM orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.created_at DESC LIMIT 10;\n\
         - Nothing else: no Markdown fences, no explanation outside SQL comments. A note the user needs goes in a further `--` line under the summary.\n\
         - With several statements, each gets its own summary line above it.\n\
         - When changing given SQL, answer with the whole changed SQL under a summary line rewritten for the change: replace the summary it already has, never stack a second one.\n\
         - Use only the tables and columns in the schema, and quote identifiers the way {label} needs.\n\
         - Read (SELECT) unless the request asks to change data or structure.\n\
         - If the schema can't answer the request, reply with a single `--` comment saying why.\n\
         - The request may be in any language: keep names as in the schema and write comments in the request's language.\n"
    );
    if let Some(note) = family_note(family) {
        text.push_str("- ");
        text.push_str(note);
        text.push('\n');
    }
    text
}

/// What an engine family needs said beyond plain SQL.
fn family_note(family: &str) -> Option<&'static str> {
    match family {
        "cql" => Some("This is CQL, not SQL: no joins or subqueries. Filter on the partition key (then clustering columns), and add ALLOW FILTERING only when the request can't avoid it."),
        "mssql" => Some("Limit rows with TOP or OFFSET … FETCH, not LIMIT."),
        "oracle" => Some("Limit rows with FETCH FIRST n ROWS ONLY, not LIMIT."),
        "clickhouse" => Some("Use ClickHouse's own functions and types."),
        _ => None,
    }
}

fn user_prompt(
    label: &str,
    tables: &[TableSchema],
    relations: &[Relation],
    context: Option<&str>,
    request: &str,
) -> String {
    let hint = match context {
        Some(sql) => format!("{request}\n{sql}"),
        None => request.to_string(),
    };
    let mut text = format!("{label} schema:\n");
    text.push_str(&schema_text(tables, relations, &hint, SCHEMA_BUDGET));
    if let Some(sql) = context {
        text.push_str(
            "\nChange this SQL as the request asks, and answer with the whole changed SQL:\n",
        );
        text.push_str(sql);
        text.push('\n');
    }
    text.push_str("\nRequest: ");
    text.push_str(request);
    text.push_str("\n\nAnswer with the `--` summary line, then the SQL.");
    text
}

/// `name(col type PK, col type NOT NULL, …)` a line per table, then the
/// foreign keys between the tables shown. Over `budget`, the tables `hint`
/// names come first.
fn schema_text(
    tables: &[TableSchema],
    relations: &[Relation],
    hint: &str,
    budget: usize,
) -> String {
    if tables.is_empty() {
        return "(no tables)\n".to_string();
    }
    let lines: Vec<String> = tables.iter().map(table_line).collect();
    let keys: Vec<String> = relations
        .iter()
        .map(|rel| {
            format!(
                "{}({}) -> {}({})\n",
                rel.table,
                rel.columns.join(", "),
                rel.ref_table,
                rel.ref_columns.join(", ")
            )
        })
        .collect();
    let total: usize = lines.iter().chain(&keys).map(String::len).sum();
    let keep: Vec<usize> = if total <= budget {
        (0..tables.len()).collect()
    } else {
        relevant(tables, relations, &lines, hint, budget * 3 / 4)
    };

    let mut text = String::new();
    let mut shown = HashSet::new();
    for &index in &keep {
        text.push_str(&lines[index]);
        shown.insert(tables[index].name.as_str());
    }
    let mut header = false;
    for (rel, line) in relations.iter().zip(&keys) {
        if shown.contains(rel.table.as_str()) && shown.contains(rel.ref_table.as_str()) {
            if !header {
                text.push_str("Foreign keys:\n");
                header = true;
            }
            text.push_str(line);
        }
    }
    let others: Vec<&str> = tables
        .iter()
        .map(|table| table.name.as_str())
        .filter(|name| !shown.contains(name))
        .collect();
    if !others.is_empty() {
        text.push_str("Other tables (columns not shown):");
        let mut listed = 0;
        for name in &others {
            if text.len() + name.len() + 2 > budget {
                break;
            }
            text.push(' ');
            text.push_str(name);
            text.push(',');
            listed += 1;
        }
        if listed > 0 {
            text.pop();
        }
        if listed < others.len() {
            text.push_str(&format!(" … and {} more", others.len() - listed));
        }
        text.push('\n');
    }
    text
}

fn table_line(table: &TableSchema) -> String {
    let columns: Vec<String> = table
        .columns
        .iter()
        .map(|column| {
            let mut text = column.name.clone();
            if let Some(kind) = column.decl_type.as_deref().filter(|kind| !kind.is_empty()) {
                text.push(' ');
                text.push_str(kind);
            }
            if column.pk {
                text.push_str(" PK");
            } else if column.not_null {
                text.push_str(" NOT NULL");
            }
            text
        })
        .collect();
    format!("{}({})\n", table.name, columns.join(", "))
}

/// The tables to describe in full, in schema order, within `budget`: those
/// the request names (or whose columns it names), then their neighbours by
/// foreign key, then the rest in order.
fn relevant(
    tables: &[TableSchema],
    relations: &[Relation],
    lines: &[String],
    hint: &str,
    budget: usize,
) -> Vec<usize> {
    let words: HashSet<String> = hint
        .split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|word| word.chars().count() > 1)
        .map(str::to_lowercase)
        .collect();
    let named = |name: &str| {
        let name = name.to_lowercase();
        let short = name.rsplit('.').next().unwrap_or(&name);
        words.contains(short)
            || short
                .strip_suffix('s')
                .is_some_and(|one| words.contains(one))
            || words.contains(&format!("{short}s"))
    };
    let mut scores: Vec<usize> = tables
        .iter()
        .map(|table| {
            let columns = table.columns.iter().filter(|c| named(&c.name)).count();
            let table_score = if named(&table.name) { 10 } else { 0 };
            table_score + columns
        })
        .collect();
    let index_of: std::collections::HashMap<&str, usize> = tables
        .iter()
        .enumerate()
        .map(|(index, table)| (table.name.as_str(), index))
        .collect();
    for rel in relations {
        let found = (
            index_of.get(rel.table.as_str()),
            index_of.get(rel.ref_table.as_str()),
        );
        if let (Some(&a), Some(&b)) = found {
            let (score_a, score_b) = (scores[a], scores[b]);
            if score_a >= 10 {
                scores[b] = scores[b].max(5);
            }
            if score_b >= 10 {
                scores[a] = scores[a].max(5);
            }
        }
    }
    let mut order: Vec<usize> = (0..tables.len()).collect();
    order.sort_by_key(|&index| (std::cmp::Reverse(scores[index]), index));
    let mut used = 0;
    let mut keep = Vec::new();
    for index in order {
        if used + lines[index].len() > budget {
            continue;
        }
        used += lines[index].len();
        keep.push(index);
    }
    keep.sort_unstable();
    keep
}

/// How a provider is asked.
enum Api {
    /// Chat completions at this URL: OpenAI-compatible servers, Gemini.
    Chat(String),
    Anthropic,
    /// The Responses API at this URL, on the ChatGPT plan.
    Responses(String),
    /// A CLI on this machine, its program here.
    Cli(Cli, PathBuf),
}

struct Call {
    api: Api,
    model: String,
    key: Option<String>,
    /// `reasoning_effort` for chat completions, where it shortens the wait.
    effort: Option<&'static str>,
}

impl Call {
    fn endpoint(&self) -> &str {
        match &self.api {
            Api::Chat(url) | Api::Responses(url) => url,
            Api::Anthropic => ANTHROPIC_URL,
            Api::Cli(cli, _) => cli.label(),
        }
    }

    fn body(&self, wire: Wire, system: &str, user: &str) -> Value {
        match wire {
            Wire::Anthropic => json!({
                "model": self.model,
                "max_tokens": ANTHROPIC_MAX_TOKENS,
                "stream": true,
                "system": system,
                "messages": [{ "role": "user", "content": user }],
            }),
            Wire::OpenAi => {
                let mut body = json!({
                    "model": self.model,
                    "stream": true,
                    "messages": [
                        { "role": "system", "content": system },
                        { "role": "user", "content": user },
                    ],
                });
                if let Some(effort) = self.effort {
                    body["reasoning_effort"] = json!(effort);
                }
                body
            }
            // The plan takes the Responses API only, streamed and not stored,
            // without sampling fields.
            Wire::Responses => json!({
                "model": self.model,
                "instructions": system,
                "input": [{ "role": "user", "content": user }],
                "store": false,
                "stream": true,
            }),
        }
    }

    /// The provider's answer once it says yes (a CLI, once started); its
    /// refusal as an error.
    async fn send(&self, system: &str, user: &str) -> ApiResult<Feed> {
        let (url, wire) = match &self.api {
            Api::Cli(cli, program) => {
                return cli::start(*cli, program, &self.model, system, user)
                    .map(|run| Feed::Cli(Box::new(run)))
                    .map_err(|message| {
                        (
                            StatusCode::BAD_GATEWAY,
                            Json(ApiError::new("ai_provider_error", message)),
                        )
                    });
            }
            Api::Chat(url) => (url.as_str(), Wire::OpenAi),
            Api::Anthropic => (ANTHROPIC_URL, Wire::Anthropic),
            Api::Responses(url) => (url.as_str(), Wire::Responses),
        };
        let mut request = http()?
            .post(url)
            .header(header::ACCEPT, "text/event-stream")
            .json(&self.body(wire, system, user));
        if let Some(key) = &self.key {
            request = match wire {
                Wire::Anthropic => request
                    .header("x-api-key", key)
                    .header("anthropic-version", ANTHROPIC_VERSION),
                Wire::OpenAi | Wire::Responses => request.bearer_auth(key),
            };
        }
        let response = match tokio::time::timeout(IDLE_TIMEOUT, request.send()).await {
            Err(_) => return Err(network_error(url, "응답이 없습니다 (시간 초과)")),
            Ok(Err(err)) => return Err(network_error(url, &describe(&err))),
            Ok(Ok(response)) => response,
        };
        let status = response.status();
        if status.is_success() {
            return Ok(Feed::Http {
                // What is left of the plan, where the answer says (ChatGPT).
                limits: Some(usage::header_windows(response.headers()))
                    .filter(|windows| !windows.is_empty()),
                response,
                wire,
                lines: SseLines::default(),
            });
        }
        let body = read_capped(response).await;
        Err(provider_error(status, &body))
    }
}

/// A provider's answer as it comes: server-sent events over HTTP, or the
/// lines a CLI prints.
enum Feed {
    Http {
        response: reqwest::Response,
        wire: Wire,
        lines: SseLines,
        /// Usage windows from the response headers, given once.
        limits: Option<Vec<Window>>,
    },
    Cli(Box<cli::Run>),
}

impl Feed {
    /// The events in what came next; `None` at the end.
    async fn next(&mut self) -> Result<Option<Vec<Event>>, ApiError> {
        match self {
            Self::Http {
                response,
                wire,
                lines,
                limits,
            } => {
                if let Some(windows) = limits.take() {
                    return Ok(Some(vec![Event::Limits(windows)]));
                }
                match tokio::time::timeout(IDLE_TIMEOUT, response.chunk()).await {
                    Err(_) => Err(ApiError::new(
                        "ai_network",
                        "AI 제공자가 응답하지 않습니다 (시간 초과)",
                    )),
                    Ok(Err(err)) => Err(ApiError::new(
                        "ai_network",
                        format!("AI 제공자와의 연결이 끊겼습니다: {}", describe(&err)),
                    )),
                    Ok(Ok(None)) => Ok(None),
                    Ok(Ok(Some(chunk))) => Ok(Some(
                        lines
                            .push(&chunk)
                            .iter()
                            .map(|data| wire.event(data))
                            .collect(),
                    )),
                }
            }
            Self::Cli(run) => match tokio::time::timeout(IDLE_TIMEOUT, run.next()).await {
                Err(_) => Err(ApiError::new(
                    "ai_network",
                    "CLI가 응답하지 않습니다 (시간 초과)",
                )),
                Ok(Err(err)) => Err(ApiError::new(
                    "ai_provider_error",
                    format!("CLI의 출력을 읽지 못했습니다: {err}"),
                )),
                Ok(Ok(events)) => Ok(events),
            },
        }
    }

    /// The whole answer of a server that ignored `stream: true`.
    fn whole(&self) -> Option<String> {
        match self {
            Self::Http { wire, lines, .. } => wire.whole(&lines.pending),
            Self::Cli(_) => None,
        }
    }

    /// An answer that must say it is complete (Responses), not just end.
    fn ends_explicitly(&self) -> bool {
        matches!(self, Self::Http { wire, .. } if wire.ends_explicitly())
    }
}

/// The one HTTP client for every provider call, built once: building one
/// loads the system's root certificates, which takes a noticeable while
/// (most of a second on macOS) and was paid on every request.
fn http() -> ApiResult<reqwest::Client> {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client.clone());
    }
    let client = reqwest::Client::builder()
        .user_agent(format!("TablePeek/{}", update::VERSION))
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|err| internal_error(format!("HTTP 클라이언트를 만들 수 없습니다: {err}")))?;
    Ok(CLIENT.get_or_init(|| client).clone())
}

/// The provider's refusal. A ChatGPT plan at its limit says so in a code of
/// its own, which the page answers with a link to ChatGPT's usage settings.
fn provider_error(status: reqwest::StatusCode, body: &str) -> (StatusCode, Json<ApiError>) {
    let code = serde_json::from_str::<Value>(body).ok().and_then(|value| {
        value
            .pointer("/error/code")
            .and_then(Value::as_str)
            .map(str::to_string)
    });
    if code.as_deref() == Some(USAGE_LIMIT) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(ApiError::new(
                "ai_usage_limit",
                "ChatGPT 사용 한도에 도달했습니다",
            )),
        );
    }
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return (StatusCode::TOO_MANY_REQUESTS, Json(rate_limited(body)));
    }
    (
        StatusCode::BAD_GATEWAY,
        Json(ApiError::new(
            "ai_provider_error",
            format!(
                "AI 제공자 오류 ({}): {}",
                status.as_u16(),
                error_message(body)
            ),
        )),
    )
}

/// A provider's "too many requests", said briefly: what it says of the limit
/// goes in `details` (`model`, `limit`, `per_day`, `free_tier`,
/// `retry_after_s`, as far as it says), its whole text in `raw`. Gemini says
/// it all ("limit: 20, model: gemini-3-flash … per day … Free Tier …
/// retry in 5h30m13.8s"); OpenAI and Anthropic less.
fn rate_limited(body: &str) -> ApiError {
    let text = error_message(body);
    let mut details = serde_json::Map::new();
    let field = |key: &str| {
        text.split(key).nth(1).map(|rest| {
            rest.split([',', ' ', '\n', ';'])
                .next()
                .unwrap_or_default()
                .to_string()
        })
    };
    if let Some(model) = field("model: ").filter(|model| !model.is_empty()) {
        details.insert("model".into(), json!(model));
    }
    if let Some(limit) = field("limit: ").and_then(|limit| limit.parse::<u64>().ok()) {
        details.insert("limit".into(), json!(limit));
    }
    if text.contains("per day") {
        details.insert("per_day".into(), json!(true));
    }
    if text.contains("free_tier") || text.contains("Free Tier") {
        details.insert("free_tier".into(), json!(true));
    }
    if let Some(wait) = field("retry in ").and_then(|wait| seconds_of(&wait)) {
        details.insert("retry_after_s".into(), json!(wait));
    }
    if text.contains("insufficient_quota") || body.contains("insufficient_quota") {
        details.insert("out_of_credit".into(), json!(true));
    }
    let mut error = ApiError::new("ai_rate_limited", "AI 제공자의 요청 한도를 넘었습니다");
    error.fields.raw = Some(text);
    if !details.is_empty() {
        error.fields.details = Some(Value::Object(details));
    }
    error
}

/// "5h30m13.8s", "45s", "1m" in whole seconds, rounded up.
fn seconds_of(wait: &str) -> Option<u64> {
    let wait = wait.trim_end_matches('.');
    let mut total = 0.0;
    let mut number = String::new();
    for c in wait.chars() {
        match c {
            '0'..='9' | '.' => number.push(c),
            'h' | 'm' | 's' => {
                let value: f64 = number.parse().ok()?;
                total += value
                    * match c {
                        'h' => 3600.0,
                        'm' => 60.0,
                        _ => 1.0,
                    };
                number.clear();
            }
            _ => return None,
        }
    }
    (number.is_empty() && total > 0.0).then(|| total.ceil() as u64)
}

fn network_error(url: &str, detail: &str) -> (StatusCode, Json<ApiError>) {
    (
        StatusCode::BAD_GATEWAY,
        Json(ApiError::new(
            "ai_network",
            format!("AI 제공자에 연결할 수 없습니다 ({url}): {detail}"),
        )),
    )
}

/// reqwest's error with its causes, which say what actually failed
/// (connection refused, certificate, DNS).
fn describe(err: &reqwest::Error) -> String {
    let mut text = err.to_string();
    let mut source = std::error::Error::source(err);
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text
}

async fn read_capped(mut response: reqwest::Response) -> String {
    let mut body = Vec::new();
    while body.len() < ERROR_BODY_LIMIT {
        match tokio::time::timeout(CONNECT_TIMEOUT, response.chunk()).await {
            Ok(Ok(Some(chunk))) => body.extend_from_slice(&chunk),
            _ => break,
        }
    }
    String::from_utf8_lossy(&body).into_owned()
}

/// The message in a provider's error body: `{"error":{"message"}}` (OpenAI,
/// Anthropic, Ollama), Gemini's list of those, `{"error": "…"}`, or the
/// `{"detail": "…"}` ChatGPT's plan admission answers with.
fn error_message(body: &str) -> String {
    let value: Option<Value> = serde_json::from_str(body).ok();
    let found = value.as_ref().and_then(|value| {
        let value = value
            .as_array()
            .and_then(|list| list.first())
            .unwrap_or(value);
        value
            .pointer("/error/message")
            .or_else(|| value.get("error"))
            .or_else(|| value.get("message"))
            .or_else(|| value.get("detail"))
            .and_then(Value::as_str)
    });
    match found {
        Some(message) => message.trim().to_string(),
        None => {
            let text = body.trim();
            if text.is_empty() {
                "(본문 없음)".to_string()
            } else {
                text.chars().take(300).collect()
            }
        }
    }
}

#[derive(Debug, Clone, Copy)]
enum Wire {
    /// Chat completions: `choices[0].delta.content`, ended by `[DONE]`.
    OpenAi,
    /// Messages: `content_block_delta` events carrying `text_delta`.
    Anthropic,
    /// Responses (the ChatGPT plan): `response.output_text.delta` events,
    /// done only at `response.completed`.
    Responses,
}

#[derive(Debug, PartialEq)]
enum Event {
    Text(String),
    /// What is left of the plan, from ChatGPT's answer headers.
    Limits(Vec<Window>),
    /// The answer is complete (Responses says so; the others just end).
    Done,
    Error {
        code: Option<String>,
        message: String,
    },
    Skip,
}

/// A ChatGPT plan (or the app's share of it) used up.
const USAGE_LIMIT: &str = "subscription_sharing_usage_limit_exceeded";

fn event_error(code: Option<&Value>, message: Option<&Value>, fallback: &str) -> Event {
    Event::Error {
        code: code.and_then(Value::as_str).map(str::to_string),
        message: message
            .and_then(Value::as_str)
            .unwrap_or(fallback)
            .to_string(),
    }
}

impl Wire {
    /// One server-sent event's data.
    fn event(self, data: &str) -> Event {
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            return Event::Skip;
        }
        let Ok(value) = serde_json::from_str::<Value>(data) else {
            return Event::Skip;
        };
        if let Self::Responses = self {
            return match value["type"].as_str().unwrap_or("") {
                "response.output_text.delta" => value["delta"]
                    .as_str()
                    .map_or(Event::Skip, |text| Event::Text(text.to_string())),
                "response.completed" => Event::Done,
                "response.failed" => event_error(
                    value.pointer("/response/error/code"),
                    value.pointer("/response/error/message"),
                    "응답이 실패했습니다",
                ),
                "response.incomplete" => Event::Error {
                    code: None,
                    message: format!(
                        "응답이 끝나지 않았습니다 ({})",
                        value
                            .pointer("/response/incomplete_details/reason")
                            .and_then(Value::as_str)
                            .unwrap_or("이유 없음")
                    ),
                },
                "error" => event_error(
                    value.get("code").or_else(|| value.pointer("/error/code")),
                    value
                        .get("message")
                        .or_else(|| value.pointer("/error/message")),
                    "알 수 없는 오류",
                ),
                _ => Event::Skip,
            };
        }
        if let Some(error) = value.get("error").filter(|error| !error.is_null()) {
            let message = error.get("message").or(Some(error));
            return event_error(error.get("code"), message, "알 수 없는 오류");
        }
        let text = match self {
            Self::OpenAi => value.pointer("/choices/0/delta/content"),
            Self::Anthropic if value["type"] == "content_block_delta" => {
                value.pointer("/delta/text")
            }
            Self::Anthropic | Self::Responses => None,
        };
        text.and_then(Value::as_str)
            .map_or(Event::Skip, |text| Event::Text(text.to_string()))
    }

    /// Whether only an explicit end marks the answer complete, so a stream
    /// that just stops is cut off rather than done.
    fn ends_explicitly(self) -> bool {
        matches!(self, Self::Responses)
    }

    /// The text of an answer that came whole rather than as a stream (a
    /// server that ignores `stream: true`).
    fn whole(self, body: &[u8]) -> Option<String> {
        let value: Value = serde_json::from_slice(body).ok()?;
        let text = match self {
            Self::OpenAi => value.pointer("/choices/0/message/content"),
            Self::Anthropic => value.pointer("/content/0/text"),
            Self::Responses => None,
        };
        text.and_then(Value::as_str).map(str::to_string)
    }
}

/// Splits a server-sent event stream into `data:` payloads, whatever the
/// chunks it arrives in cut through (a line, a UTF-8 character).
#[derive(Debug, Default)]
struct SseLines {
    pending: Vec<u8>,
}

impl SseLines {
    fn push(&mut self, chunk: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(chunk);
        let mut payloads = Vec::new();
        let mut start = 0;
        while let Some(end) = self.pending[start..].iter().position(|&byte| byte == b'\n') {
            let line = &self.pending[start..start + end];
            start += end + 1;
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            if let Some(data) = line.strip_prefix(b"data:") {
                let data = data.strip_prefix(b" ").unwrap_or(data);
                payloads.push(String::from_utf8_lossy(data).into_owned());
            }
        }
        self.pending.drain(..start);
        payloads
    }
}

/// The SQL in a model's answer: the first fenced block if it fenced one
/// anyway (while it streams, what of the block has come), else all of it.
fn clean_sql(raw: &str) -> &str {
    let Some(open) = raw.find("```") else {
        return raw.trim();
    };
    let rest = &raw[open + 3..];
    // The fence's language tag runs to the end of its line.
    let Some(newline) = rest.find('\n') else {
        return "";
    };
    let body = &rest[newline + 1..];
    match body.find("```") {
        Some(close) => body[..close].trim(),
        None => body.trim_end_matches('`').trim(),
    }
}

/// Whether the answer only reads: every statement in it, past its leading
/// comments, by the engine's conservative check. Only comments reads nothing.
fn reads_only(sql: &str) -> bool {
    statements(sql).into_iter().all(|statement| {
        let body = past_comments(statement);
        body.is_empty() || tablepeek_engine::is_read_only(body)
    })
}

/// `sql` cut at each `;` outside quotes and comments. A `;` the cut misreads
/// (inside a `$$` body) leaves pieces the engine's check turns down.
fn statements(sql: &str) -> Vec<&str> {
    let bytes = sql.as_bytes();
    let mut out = Vec::new();
    let mut start = 0;
    let mut at = 0;
    while at < bytes.len() {
        match bytes[at] {
            quote @ (b'\'' | b'"' | b'`') => {
                at += 1;
                while at < bytes.len() && bytes[at] != quote {
                    at += 1;
                }
            }
            b'-' if bytes.get(at + 1) == Some(&b'-') => {
                while at < bytes.len() && bytes[at] != b'\n' {
                    at += 1;
                }
            }
            b'/' if bytes.get(at + 1) == Some(&b'*') => {
                at = sql[at + 2..]
                    .find("*/")
                    .map_or(bytes.len(), |end| at + 2 + end + 1);
            }
            b';' => {
                out.push(&sql[start..at]);
                start = at + 1;
            }
            _ => {}
        }
        at += 1;
    }
    out.push(&sql[start.min(sql.len())..]);
    out
}

/// A statement past its leading `--` and `/* */` comments.
fn past_comments(statement: &str) -> &str {
    let mut rest = statement.trim();
    loop {
        if let Some(line) = rest.strip_prefix("--") {
            rest = line
                .find('\n')
                .map_or("", |end| &line[end + 1..])
                .trim_start();
        } else if let Some(block) = rest.strip_prefix("/*") {
            rest = block
                .find("*/")
                .map_or("", |end| &block[end + 2..])
                .trim_start();
        } else {
            return rest.trim_end();
        }
    }
}

fn error_line(code: &str, message: impl Into<String>) -> Value {
    json!({ "error": ApiError::new(code, message) })
}

struct Relay {
    feed: Feed,
    /// Where usage the answer reports is kept.
    ai: Arc<AiSettings>,
    provider: Provider,
    raw: String,
    /// The provider said the answer is complete.
    done: bool,
    /// Length of the SQL last sent as partial.
    shown: usize,
    last: Instant,
    /// When the request came, how long the schema took, and when the first
    /// text arrived: what the page shows of where the time went.
    started: Instant,
    schema_ms: u64,
    first_ms: Option<u64>,
}

impl Relay {
    fn finish(&mut self) -> Value {
        if self.feed.ends_explicitly() && !self.done {
            return error_line("ai_network", "응답이 끝나기 전에 연결이 끊겼습니다");
        }
        if self.raw.is_empty() {
            if let Some(text) = self.feed.whole() {
                self.raw = text;
            }
        }
        let mut done = done_line(&self.raw);
        if let Some(answer) = done.get_mut("done") {
            answer["timing"] = json!({
                "schema_ms": self.schema_ms,
                "first_ms": self.first_ms,
                "total_ms": millis(self.started),
            });
        }
        done
    }
}

/// The last line of an answer: its SQL, or why there is none.
fn done_line(raw: &str) -> Value {
    let sql = clean_sql(raw);
    if sql.is_empty() {
        return error_line("ai_empty", "AI 제공자가 빈 답을 보냈습니다");
    }
    json!({ "done": { "sql": sql, "read_only": reads_only(sql) } })
}

/// A provider's error in the middle of its answer, as the page gets it.
fn stream_error(code: Option<String>, message: &str) -> Value {
    json!({ "error": stream_api_error(code, message) })
}

fn stream_api_error(code: Option<String>, message: &str) -> ApiError {
    match code.as_deref() {
        Some(USAGE_LIMIT) => ApiError::new("ai_usage_limit", "ChatGPT 사용 한도에 도달했습니다"),
        Some(code) => ApiError::new(
            "ai_provider_error",
            format!("AI 제공자 오류: {message} ({code})"),
        ),
        None => ApiError::new("ai_provider_error", format!("AI 제공자 오류: {message}")),
    }
}

/// The next line of a provider's answer.
async fn relay_next(mut relay: Box<Relay>) -> Option<(Bytes, Option<Step>)> {
    loop {
        let events = match relay.feed.next().await {
            Err(error) => return Some((line(&json!({ "error": error })), None)),
            Ok(None) => return Some((line(&relay.finish()), None)),
            Ok(Some(events)) => events,
        };
        for event in events {
            match event {
                Event::Text(text) => {
                    if relay.first_ms.is_none() {
                        relay.first_ms = Some(millis(relay.started));
                    }
                    relay.raw.push_str(&text);
                }
                Event::Done => relay.done = true,
                Event::Error { code, message } => {
                    return Some((line(&stream_error(code, &message)), None));
                }
                Event::Limits(windows) => relay.ai.record_windows(relay.provider, windows).await,
                Event::Skip => {}
            }
        }
        if relay.last.elapsed() >= PARTIAL_INTERVAL {
            let sql = clean_sql(&relay.raw);
            if sql.len() != relay.shown {
                let partial = line(&json!({ "partial": sql }));
                relay.shown = sql.len();
                relay.last = Instant::now();
                return Some((partial, Some(Step::Relay(relay))));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::*;
    use crate::{ConnSlot, Registry};
    use tablepeek_engine::Engine;
    use tablepeek_types::ColumnSchema;

    fn state(name: &str) -> (AppState, PathBuf) {
        state_with(name, Endpoints::default())
    }

    fn state_with(name: &str, endpoints: Endpoints) -> (AppState, PathBuf) {
        let dir =
            std::env::temp_dir().join(format!("tablepeek-ai-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut registry = Registry::new();
        registry.insert(Arc::new(ConnSlot::new(
            "main".into(),
            "데모".into(),
            None,
            None,
            Engine::open_demo(3).unwrap(),
        )));
        let state = AppState {
            registry: Arc::new(tokio::sync::Mutex::new(registry)),
            default_conn: "main".into(),
            token: "test-token".into(),
            demo_rows: 3,
            allowed_hosts: Arc::new(vec!["127.0.0.1:1".into()]),
            store: Arc::new(tokio::sync::Mutex::new(store::StoreFile::load(&dir))),
            update: Arc::new(update::UpdateChecker::new(
                &dir,
                update::RELEASES_URL.into(),
                update::VERSION,
                true,
            )),
            ui_writers: Arc::default(),
            window_material: None,
            ai: Arc::new(AiSettings::with_endpoints(&dir, endpoints)),
        };
        // No CLI unless a test puts a fake one: the user's are never run.
        state.ai.use_cli(Cli::Codex, dir.join("no-codex"));
        (state, dir)
    }

    fn headers() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-tablepeek-token", "test-token".parse().unwrap());
        headers
    }

    fn patch(value: Value) -> Json<AiPatch> {
        Json(serde_json::from_value(value).unwrap())
    }

    fn ask(prompt: &str) -> Json<GenerateRequest> {
        Json(GenerateRequest {
            conn: None,
            prompt: prompt.into(),
            context: None,
        })
    }

    fn table(name: &str, columns: &[&str]) -> TableSchema {
        TableSchema {
            name: name.into(),
            columns: columns
                .iter()
                .map(|column| ColumnSchema {
                    name: (*column).into(),
                    decl_type: Some("int".into()),
                    not_null: false,
                    pk: *column == "id",
                    default: None,
                    enum_values: None,
                })
                .collect(),
        }
    }

    fn ndjson(bytes: &[u8]) -> Vec<Value> {
        std::str::from_utf8(bytes)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[test]
    fn sse_lines_survive_chunks_cut_mid_line_and_mid_character() {
        let stream = "data: {\"t\":\"가나\"}\r\n\r\nevent: ping\ndata: [DONE]\n".as_bytes();
        // Cut inside the first line's 가 (three bytes in UTF-8).
        let cut = stream.iter().position(|&byte| byte >= 0x80).unwrap() + 1;
        let mut lines = SseLines::default();
        assert!(lines.push(&stream[..cut]).is_empty());
        assert_eq!(
            lines.push(&stream[cut..]),
            vec!["{\"t\":\"가나\"}".to_string(), "[DONE]".to_string()]
        );
        assert!(lines.pending.is_empty());
    }

    #[test]
    fn wire_events_read_text_and_errors_of_each_api() {
        let openai = r#"{"choices":[{"index":0,"delta":{"content":"SELECT"}}]}"#;
        assert_eq!(Wire::OpenAi.event(openai), Event::Text("SELECT".into()));
        assert_eq!(
            Wire::OpenAi.event(r#"{"choices":[{"delta":{"role":"assistant"}}]}"#),
            Event::Skip
        );
        assert_eq!(Wire::OpenAi.event("[DONE]"), Event::Skip);
        let error = |code: Option<&str>, message: &str| Event::Error {
            code: code.map(str::to_string),
            message: message.into(),
        };
        assert_eq!(
            Wire::OpenAi.event(r#"{"error":{"message":"rate limited"}}"#),
            error(None, "rate limited")
        );
        let delta =
            r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" 1"}}"#;
        assert_eq!(Wire::Anthropic.event(delta), Event::Text(" 1".into()));
        assert_eq!(
            Wire::Anthropic.event(r#"{"type":"message_stop"}"#),
            Event::Skip
        );
        assert_eq!(
            Wire::Anthropic.event(
                r#"{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}"#
            ),
            error(None, "Overloaded")
        );
        // Responses: text, the end, and failures with their codes.
        let delta = r#"{"type":"response.output_text.delta","delta":"SEL"}"#;
        assert_eq!(Wire::Responses.event(delta), Event::Text("SEL".into()));
        assert_eq!(
            Wire::Responses.event(r#"{"type":"response.created","response":{"error":null}}"#),
            Event::Skip
        );
        assert_eq!(
            Wire::Responses.event(r#"{"type":"response.completed"}"#),
            Event::Done
        );
        let failed = r#"{"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"limit"}}}"#;
        assert_eq!(
            Wire::Responses.event(failed),
            error(Some(USAGE_LIMIT), "limit")
        );
        let incomplete = r#"{"type":"response.incomplete","response":{"incomplete_details":{"reason":"max_output_tokens"}}}"#;
        assert_eq!(
            Wire::Responses.event(incomplete),
            error(None, "응답이 끝나지 않았습니다 (max_output_tokens)")
        );
        // An answer that came whole.
        let whole = br#"{"choices":[{"message":{"content":"SELECT 2"}}]}"#;
        assert_eq!(Wire::OpenAi.whole(whole).as_deref(), Some("SELECT 2"));
    }

    #[test]
    fn clean_sql_takes_the_fenced_block_even_while_it_streams() {
        assert_eq!(clean_sql("  SELECT 1\n"), "SELECT 1");
        assert_eq!(clean_sql("```sql\nSELECT 1;\n```"), "SELECT 1;");
        assert_eq!(
            clean_sql("Here it is:\n```\nSELECT 1\n```\nIt counts rows."),
            "SELECT 1"
        );
        // Mid-stream: the tag line hasn't ended, then the closing fence is
        // half there.
        assert_eq!(clean_sql("```sq"), "");
        assert_eq!(clean_sql("```sql\nSELECT 1\n``"), "SELECT 1");
    }

    #[test]
    fn a_rate_limit_is_said_briefly_with_what_the_provider_told() {
        let gemini = r#"[{"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://aistudio.google.com/docs/rate-limits. \n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 20, model: gemini-3-flash, description: Generate content requests per day limit exceeded on Free Tier. See https://aistudio.google.com/docs/rate-limits.\nPlease retry in 5h30m13.885165551s.","status":"RESOURCE_EXHAUSTED"}}]"#;
        let (status, Json(error)) = provider_error(reqwest::StatusCode::TOO_MANY_REQUESTS, gemini);
        assert_eq!(
            (status, error.code.as_str(), error.message.as_str()),
            (
                StatusCode::TOO_MANY_REQUESTS,
                "ai_rate_limited",
                "AI 제공자의 요청 한도를 넘었습니다"
            )
        );
        assert_eq!(
            error.fields.details,
            Some(json!({
                "model": "gemini-3-flash",
                "limit": 20,
                "per_day": true,
                "free_tier": true,
                "retry_after_s": 19814,
            }))
        );
        assert!(error.fields.raw.unwrap().contains("Quota exceeded"));

        // OpenAI says less: the credit is gone, no wait.
        let openai = r#"{"error":{"message":"You exceeded your current quota.","type":"insufficient_quota","code":"insufficient_quota"}}"#;
        let (_, Json(error)) = provider_error(reqwest::StatusCode::TOO_MANY_REQUESTS, openai);
        assert_eq!(error.fields.details, Some(json!({ "out_of_credit": true })));
        assert_eq!(seconds_of("45s"), Some(45));
        assert_eq!(seconds_of("1m0.5s"), Some(61));
        assert_eq!(seconds_of("soon"), None);
    }

    #[test]
    fn reads_only_looks_past_comments_and_a_final_semicolon() {
        assert!(reads_only("SELECT * FROM t;"));
        assert!(reads_only("-- 지난달 주문\n/* note */ SELECT 1"));
        assert!(reads_only("-- 이 스키마로는 답할 수 없습니다"));
        assert!(!reads_only("UPDATE t SET a = 1;"));
        assert!(!reads_only("SELECT 1; DELETE FROM t"));
        assert!(!reads_only("-- harmless\nDROP TABLE t"));
        // The answer's shape: a summary line above each statement.
        assert!(reads_only(
            "-- 최근 주문 10건\nSELECT * FROM orders LIMIT 10;\n-- 주문 수\nSELECT count(*) FROM orders;"
        ));
        assert!(!reads_only(
            "-- 주문 보기\nSELECT * FROM orders;\n-- 오래된 주문 삭제\nDELETE FROM orders WHERE id < 10;"
        ));
    }

    #[test]
    fn schema_over_budget_keeps_the_tables_the_request_names_and_their_neighbours() {
        let mut tables: Vec<TableSchema> = (0..40)
            .map(|n| {
                table(
                    &format!("filler_{n}"),
                    &["id", "a_long_column_name", "another_column"],
                )
            })
            .collect();
        tables.push(table("customers", &["id", "name"]));
        tables.push(table("orders", &["id", "customer_id", "total"]));
        let relations = vec![Relation {
            table: "orders".into(),
            columns: vec!["customer_id".into()],
            ref_table: "customers".into(),
            ref_columns: vec!["id".into()],
        }];
        let text = schema_text(&tables, &relations, "total of each order last month", 400);
        assert!(text.len() <= 400 + 40, "{text}");
        assert!(
            text.contains("orders(id int PK, customer_id int, total int)\n"),
            "{text}"
        );
        assert!(text.contains("customers(id int PK, name int)\n"), "{text}");
        assert!(
            text.contains("Foreign keys:\norders(customer_id) -> customers(id)\n"),
            "{text}"
        );
        assert!(text.contains("Other tables (columns not shown):"), "{text}");
        assert!(text.contains("more\n"), "{text}");

        // Within budget everything is described, in schema order.
        let all = schema_text(&tables[40..], &relations, "", SCHEMA_BUDGET);
        assert!(all.starts_with("customers("), "{all}");
        assert!(!all.contains("Other tables"), "{all}");
    }

    /// A stand-in for a CLI: `#!/bin/sh` and `body`, executable, in `dir`.
    #[cfg(unix)]
    fn fake_cli(dir: &Path, name: &str, body: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[tokio::test]
    async fn settings_offer_three_connections_and_survive_a_restart() {
        let (state, dir) = state("settings");
        let initial = status(
            State(state.clone()),
            headers(),
            Query(StatusQuery::default()),
        )
        .await
        .unwrap()
        .0;
        assert!(!initial.enabled);
        assert_eq!(initial.provider, Provider::Chatgpt);
        let offered: Vec<Provider> = initial
            .providers
            .iter()
            .filter(|(_, status)| status.available)
            .map(|(provider, _)| *provider)
            .collect();
        assert_eq!(offered, [Provider::Codex, Provider::Gemini]);
        assert_eq!(initial.providers[&Provider::Gemini].has_key, Some(false));
        assert_eq!(initial.providers[&Provider::Codex].has_key, None);
        assert!(initial.providers[&Provider::Codex].cli.is_some());
        assert!(initial.providers[&Provider::Gemini].cli.is_none());

        let set = configure(
            State(state.clone()),
            headers(),
            patch(json!({ "enabled": true, "provider": "codex", "model": "gpt-6.1-terra" })),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(
            (set.provider, set.model.as_str()),
            (Provider::Codex, "gpt-6.1-terra")
        );
        // Another provider's model, then back.
        let other = configure(
            State(state.clone()),
            headers(),
            patch(json!({ "provider": "gemini", "model": "gemini-3-flash-preview" })),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(other.model, "gemini-3-flash-preview");
        let back = configure(
            State(state.clone()),
            headers(),
            patch(json!({ "provider": "codex" })),
        )
        .await
        .unwrap()
        .0;
        assert_eq!(back.model, "gpt-6.1-terra");

        for (patch_value, code) in [
            (json!({ "provider": "openai" }), "provider_unavailable"),
            (json!({ "provider": "custom" }), "invalid_request"),
            // Claude Code's CLI was offered once; it is no connection now.
            (json!({ "provider": "claude" }), "invalid_request"),
            (
                json!({ "complete_model": { "provider": "codex", "model": "gpt-6.1-terra" } }),
                "ai_complete_unsupported",
            ),
        ] {
            let refused = configure(State(state.clone()), headers(), patch(patch_value.clone()))
                .await
                .unwrap_err();
            assert_eq!(refused.1 .0.code, code, "{patch_value}");
        }

        let reloaded = AiSettings::load(&dir).file.into_inner();
        assert!(reloaded.enabled);
        assert_eq!(
            (reloaded.provider, reloaded.model()),
            (Provider::Codex, "gpt-6.1-terra")
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_earlier_settings_file_keeps_what_this_version_knows() {
        let file = AiFile::read(
            br#"{"enabled":true,"provider":"claude","base_urls":{"custom":"http://x/v1"},
                "models":{"custom":"llama3","claude":"haiku","gemini":"gemini-flash-latest","chatgpt":"gpt-sol"},
                "complete_model":{"provider":"custom","model":"m"},"autocomplete":true}"#,
        );
        assert!(file.enabled && file.autocomplete);
        assert_eq!(file.provider, Provider::Chatgpt);
        assert_eq!(file.model(), "gpt-sol");
        assert_eq!(file.complete_model, None);
        assert_eq!(
            file.models.get(&Provider::Gemini).map(String::as_str),
            Some("gemini-flash-latest")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn generating_needs_the_feature_on_a_model_and_a_ready_cli() {
        let (state, dir) = state("refusals");
        let refused = generate(State(state.clone()), headers(), ask("count rows")).await;
        assert_eq!(refused.unwrap_err().1 .0.code, "ai_disabled");
        let _ = configure(
            State(state.clone()),
            headers(),
            patch(json!({ "enabled": true })),
        )
        .await
        .unwrap();
        let refused = generate(State(state.clone()), headers(), ask("count rows")).await;
        assert_eq!(refused.unwrap_err().1 .0.code, "ai_not_configured");

        let _ = configure(
            State(state.clone()),
            headers(),
            patch(json!({ "provider": "codex", "model": "gpt-6.1-terra" })),
        )
        .await
        .unwrap();
        state.ai.use_cli(Cli::Codex, dir.join("no-such-codex"));
        let refused = generate(State(state.clone()), headers(), ask("count rows")).await;
        assert_eq!(refused.unwrap_err().1 .0.code, "ai_cli_missing");
        // Installed, signed out: `codex login status` fails.
        let codex = fake_cli(
            &dir,
            "codex",
            "case \"$1\" in --version) echo 'codex-cli 0.1.0';; *) echo 'Not logged in'; exit 1;; esac",
        );
        state.ai.use_cli(Cli::Codex, codex);
        let refused = generate(State(state.clone()), headers(), ask("count rows")).await;
        assert_eq!(refused.unwrap_err().1 .0.code, "ai_cli_signed_out");
        let status = status(
            State(state.clone()),
            headers(),
            Query(StatusQuery { refresh: true }),
        )
        .await
        .unwrap()
        .0;
        let codex = status.providers[&Provider::Codex].cli.clone().unwrap();
        assert_eq!(
            (codex.installed, codex.signed_in, codex.version.as_deref()),
            (true, false, Some("codex-cli 0.1.0"))
        );

        // A provider coming soon, saved by an earlier version, writes nothing.
        std::fs::write(
            dir.join(CONFIG_FILE),
            r#"{"enabled":true,"provider":"openrouter","models":{"openrouter":"m"}}"#,
        )
        .unwrap();
        *state.ai.file.lock().await = AiFile::read(&std::fs::read(dir.join(CONFIG_FILE)).unwrap());
        let refused = generate(State(state.clone()), headers(), ask("count rows")).await;
        assert_eq!(refused.unwrap_err().1 .0.code, "provider_unavailable");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A stand-in OpenAI-compatible server: answers each chat completion with
    /// `reply` (status, SSE chunks) and keeps the request bodies it got.
    async fn fake_provider(
        status: u16,
        chunks: Vec<&'static str>,
    ) -> (String, Arc<Mutex<Vec<Value>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let kept = seen.clone();
        let handler = move |Json(body): Json<Value>| {
            let kept = kept.clone();
            let chunks = chunks.clone();
            async move {
                kept.lock().unwrap().push(body);
                let stream = futures_util::stream::iter(chunks).then(|chunk| async move {
                    tokio::time::sleep(Duration::from_millis(5)).await;
                    Ok::<_, Infallible>(Bytes::from(chunk))
                });
                (
                    StatusCode::from_u16(status).unwrap(),
                    Body::from_stream(stream),
                )
            }
        };
        let listing = || async {
            Json(json!({ "object": "list", "data": [
                { "id": "llama3.1:8b", "object": "model" },
                { "id": "qwen2.5-coder", "object": "model", "name": "Qwen 2.5 Coder" },
            ] }))
        };
        let app = Router::new()
            .route("/v1/chat/completions", post(handler))
            .route("/v1/models", get(listing));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/v1", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await });
        (url, seen)
    }

    fn completing(before: &str, after: &str) -> Json<CompleteRequest> {
        Json(CompleteRequest {
            conn: None,
            before: before.into(),
            after: after.into(),
        })
    }

    #[tokio::test]
    async fn suggestions_come_from_an_api_not_a_cli() {
        let (state, dir) = state("complete");
        let _ = configure(
            State(state.clone()),
            headers(),
            patch(json!({ "enabled": true, "provider": "codex", "model": "gpt-6.1-terra" })),
        )
        .await
        .unwrap();
        let refused = complete(
            State(state.clone()),
            headers(),
            completing("SELECT * FROM", ";"),
        )
        .await;
        assert_eq!(refused.unwrap_err().1 .0.code, "ai_autocomplete_off");
        let _ = configure(
            State(state.clone()),
            headers(),
            patch(json!({ "autocomplete": true })),
        )
        .await
        .unwrap();
        // The main model is a CLI's: seconds per answer.
        let refused = complete(
            State(state.clone()),
            headers(),
            completing("SELECT * FROM", ";"),
        )
        .await;
        assert_eq!(refused.unwrap_err().1 .0.code, "ai_complete_unsupported");
        // Gemini's API suggests; without a key it says so.
        let _ = configure(
            State(state.clone()),
            headers(),
            patch(json!({ "complete_model": { "provider": "gemini", "model": "gemini-flash-lite-latest" } })),
        )
        .await
        .unwrap();
        let refused = complete(
            State(state.clone()),
            headers(),
            completing("SELECT * FROM", ";"),
        )
        .await;
        assert_eq!(refused.unwrap_err().1 .0.code, "ai_not_configured");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn only_gemini_takes_a_key_for_now() {
        let (state, dir) = state("keys");
        let put_key = |id: &str, body: Value| {
            configure_provider(
                State(state.clone()),
                headers(),
                AxumPath(id.to_string()),
                Json(serde_json::from_value(body).unwrap()),
            )
        };
        for (id, body, code) in [
            ("gemini", json!({ "key": "  " }), "invalid_request"),
            ("codex", json!({ "key": "x" }), "invalid_request"),
            ("openai", json!({ "key": "sk-x" }), "provider_unavailable"),
            ("custom", json!({ "key": "x" }), "invalid_request"),
        ] {
            let refused = put_key(id, body.clone()).await.unwrap_err();
            assert_eq!(refused.1 .0.code, code, "{id} {body}");
        }
        let cleared = put_key("gemini", json!({ "clear_key": true }))
            .await
            .unwrap()
            .0;
        assert_eq!(cleared.providers[&Provider::Gemini].has_key, Some(false));
        // Picked, but no key saved: writing says what is missing.
        let _ = configure(
            State(state.clone()),
            headers(),
            patch(
                json!({ "enabled": true, "provider": "gemini", "model": "gemini-3-flash-preview" }),
            ),
        )
        .await
        .unwrap();
        let refused = generate(State(state.clone()), headers(), ask("rows")).await;
        assert_eq!(refused.unwrap_err().1 .0.code, "ai_not_configured");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn a_suggestion_keeps_only_what_is_not_there_yet() {
        let cases = [
            // The word being typed, finished.
            ("users", "SELECT * FROM us", "", "ers"),
            ("FROM demo", "SELECT * FROM", "", " demo"),
            // A suggestion that only starts with the same letter stays.
            ("ge FROM t", "SELECT a", "", "ge FROM t"),
            (
                "```sql\nWHERE id = 1\n```",
                "SELECT * FROM demo ",
                "",
                "WHERE id = 1",
            ),
            ("*)", "SELECT count(", ")", "*"),
            ("\nWHERE id = 1", "SELECT * FROM demo", "", "\nWHERE id = 1"),
            ("<CURSOR>LIMIT 10", "SELECT 1 ", "", "LIMIT 10"),
            ("", "SELECT 1", "", ""),
        ];
        for (raw, before, after, want) in cases {
            assert_eq!(clean_completion(raw, before, after), want, "{raw:?}");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn codex_answers_whole_with_the_schema_on_stdin_and_says_why_it_failed() {
        let (state, dir) = state("codex");
        let dir_text = dir.display();
        let codex = fake_cli(
            &dir,
            "codex",
            &format!(
                "case \"$1\" in --version) echo 'codex-cli 0.1.0'; exit 0;; login) echo 'Logged in using ChatGPT' >&2; exit 0;; app-server) exit 1;; esac\n\
                 printf '%s\\n' \"$@\" > '{dir_text}/codex-args'\n\
                 cat > '{dir_text}/codex-stdin'\n\
                 echo '{{\"type\":\"thread.started\"}}'\n\
                 printf '%s\\n' '{{\"type\":\"item.completed\",\"item\":{{\"type\":\"agent_message\",\"text\":\"-- 최근 10명\\nSELECT * FROM demo LIMIT 10;\"}}}}'\n\
                 echo '{{\"type\":\"turn.completed\"}}'"
            ),
        );
        state.ai.use_cli(Cli::Codex, codex);
        let _ = configure(
            State(state.clone()),
            headers(),
            patch(json!({ "enabled": true, "provider": "codex", "model": "gpt-6.1-terra" })),
        )
        .await
        .unwrap();
        let response = generate(State(state.clone()), headers(), ask("최근 10명"))
            .await
            .unwrap();
        assert_eq!(
            response.headers()[header::CONTENT_TYPE],
            "application/x-ndjson"
        );
        let lines = body_lines(response).await;
        // Where it is, then the answer with where the time went.
        assert_eq!(lines[0], json!({ "status": "schema" }));
        assert_eq!(lines[1], json!({ "status": "model", "tables": 1 }));
        let done = &lines.last().unwrap()["done"];
        assert_eq!(
            (done["sql"].as_str(), done["read_only"].as_bool()),
            (
                Some("-- 최근 10명\nSELECT * FROM demo LIMIT 10;"),
                Some(true)
            )
        );
        let timing = &done["timing"];
        assert!(
            timing["schema_ms"].as_u64() <= timing["first_ms"].as_u64()
                && timing["first_ms"].as_u64() <= timing["total_ms"].as_u64(),
            "{timing}"
        );
        // The instructions lead the prompt; the schema and request follow.
        let stdin = std::fs::read_to_string(dir.join("codex-stdin")).unwrap();
        assert!(stdin.starts_with("You write SQLite queries"), "{stdin}");
        assert!(
            stdin.contains("SQLite schema:\ndemo(id INTEGER PK, name TEXT"),
            "{stdin}"
        );
        assert!(stdin.contains("\nRequest: 최근 10명\n"), "{stdin}");
        let args = std::fs::read_to_string(dir.join("codex-args")).unwrap();
        let args: Vec<&str> = args.lines().collect();
        assert_eq!(args[..2], ["exec", "--json"]);
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--sandbox", "read-only"]));
        assert!(args.windows(2).any(|pair| pair == ["-m", "gpt-6.1-terra"]));
        assert_eq!(args.last(), Some(&"-"));

        // Its refusal, as the stream's last line.
        let refusing = fake_cli(
            &dir,
            "codex-refuse",
            "case \"$1\" in --version) echo v;; login) echo 'Logged in using ChatGPT';; app-server) exit 1;; *) cat > /dev/null; printf '%s\\n' '{\"type\":\"turn.failed\",\"error\":{\"message\":\"model not supported\"}}';; esac",
        );
        state.ai.use_cli(Cli::Codex, refusing);
        let lines = body_lines(
            generate(State(state.clone()), headers(), ask("rows"))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(
            lines.last().unwrap()["error"]["message"],
            "AI 제공자 오류: model not supported"
        );

        let crashing = fake_cli(
            &dir,
            "codex-crash",
            "case \"$1\" in --version) echo v;; login) echo 'Logged in using ChatGPT';; *) echo 'usage limit reached' >&2; exit 3;; esac",
        );
        state.ai.use_cli(Cli::Codex, crashing);
        let lines = body_lines(
            generate(State(state.clone()), headers(), ask("rows"))
                .await
                .unwrap(),
        )
        .await;
        assert_eq!(
            lines.last().unwrap()["error"]["message"],
            "AI 제공자 오류: Codex CLI: usage limit reached"
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The chat completions wire, kept for the providers coming soon.
    #[tokio::test]
    async fn the_chat_api_answers_through_the_same_feed() {
        let (url, seen) = fake_provider(
            200,
            vec![
                "data: {\"choices\":[{\"delta\":{\"content\":\"```sql\\nSELECT 1\"}}]}\n\n",
                "data: {\"choices\":[{\"delta\":{\"content\":\";\\n```\"}}]}\n\ndata: [DONE]\n\n",
            ],
        )
        .await;
        let call = Call {
            api: Api::Chat(format!("{url}/chat/completions")),
            model: "m".into(),
            key: Some("sk-x".into()),
            effort: Some("low"),
        };
        let raw = collect(call.send("system", "user").await.unwrap())
            .await
            .unwrap();
        assert_eq!(clean_sql(&raw), "SELECT 1;");
        let sent = seen.lock().unwrap().pop().unwrap();
        assert_eq!(
            (
                sent["reasoning_effort"].as_str(),
                sent["messages"][1]["content"].as_str()
            ),
            (Some("low"), Some("user"))
        );

        let (url, _) = fake_provider(
            401,
            vec![r#"{"error":{"message":"Incorrect API key provided"}}"#],
        )
        .await;
        let call = Call {
            api: Api::Chat(format!("{url}/chat/completions")),
            ..call
        };
        let Err((_, Json(error))) = call.send("system", "user").await else {
            panic!("a refusal answers");
        };
        assert_eq!(
            error.message,
            "AI 제공자 오류 (401): Incorrect API key provided"
        );
    }

    async fn body_lines(response: Response) -> Vec<Value> {
        ndjson(
            &axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .unwrap(),
        )
    }

    async fn usage_for(state: &AppState, provider: &str) -> ApiResult<Value> {
        usage_of(
            State(state.clone()),
            headers(),
            Query(UsageQuery {
                provider: provider.into(),
                refresh: false,
            }),
        )
        .await
        .map(|Json(value)| value)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn codex_usage_is_read_live_without_asking_a_model() {
        let (state, dir) = state("codex-usage");
        let codex = fake_cli(
            &dir,
            "codex",
            r#"case "$1" in
--version) echo 'codex-cli 0.1.0';;
login) echo 'Logged in using ChatGPT' >&2;;
app-server) while read -r line; do case "$line" in
  *'"id":2'*) printf '%s\n' '{"id":2,"result":{"account":{"type":"chatgpt","email":"me@example.com","planType":"team","workspaceName":"Research Factory"}}}';;
  *'"id":3'*) printf '%s\n' '{"id":3,"result":{"rateLimits":{"primary":{"usedPercent":66,"windowDurationMins":300,"resetsAt":1794310026},"secondary":{"usedPercent":18,"windowDurationMins":10080,"resetsAt":1794452876},"credits":{"hasCredits":false,"unlimited":false,"balance":null}}}}';;
esac; done;;
exec) echo 'no model calls here' >&2; exit 9;;
esac"#,
        );
        state.ai.use_cli(Cli::Codex, codex);
        let usage = usage_for(&state, "codex").await.unwrap();
        assert_eq!(usage["source"], "live");
        assert_eq!(
            usage["account"],
            json!({ "email": "me@example.com", "plan": "team", "workspace": "Research Factory" })
        );
        assert_eq!(
            usage["windows"],
            json!([
                { "kind": "five_hour", "minutes": 300, "used_percent": 66.0, "resets_at": 1794310026 },
                { "kind": "seven_day", "minutes": 10080, "used_percent": 18.0, "resets_at": 1794452876 },
            ])
        );
        assert_eq!(usage["credits"]["has_credits"], false);
        // Settings show the account signed in by its email.
        let status = status(
            State(state.clone()),
            headers(),
            Query(StatusQuery { refresh: true }),
        )
        .await
        .unwrap()
        .0;
        let cli = status.providers[&Provider::Codex].cli.clone().unwrap();
        assert_eq!(
            (cli.email.as_deref(), cli.workspace.as_deref()),
            (Some("me@example.com"), Some("Research Factory"))
        );

        // Signed out: the usage can't be read either.
        let signed_out = fake_cli(&dir, "codex-out", "exit 1");
        state.ai.use_cli(Cli::Codex, signed_out);
        let refused = usage_for(&state, "codex").await.unwrap_err();
        assert_eq!(refused.1 .0.code, "ai_cli_signed_out");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn gemini_usage_is_counted_here_against_the_limit_google_named() {
        let (state, dir) = state("gemini-usage");
        let now = usage::now();
        {
            let mut file = state.ai.usage.lock().await;
            for _ in 0..5 {
                file.count("gemini", "gemini-3-flash-preview", now);
            }
            file.count("gemini", "gemini-3-flash-lite-preview", now);
        }
        let refusal = rate_limited(
            r#"{"error":{"message":"Quota exceeded for metric: generate_content_free_tier_requests, limit: 20, model: gemini-3-flash, description: requests per day limit exceeded on Free Tier.\nPlease retry in 1h0m0s."}}"#,
        );
        state
            .ai
            .after_send(
                Provider::Gemini,
                "gemini-3-flash-preview",
                &Err((StatusCode::TOO_MANY_REQUESTS, Json(refusal))),
            )
            .await;
        let usage = usage_for(&state, "gemini").await.unwrap();
        assert_eq!(usage["source"], "local");
        assert_eq!(
            usage["today"],
            json!([
                { "model": "gemini-3-flash-lite-preview", "requests": 1 },
                { "model": "gemini-3-flash-preview", "requests": 5 },
            ])
        );
        assert_eq!(
            (
                usage["limit"]["limit"].as_u64(),
                usage["limit"]["free_tier"].as_bool()
            ),
            (Some(20), Some(true))
        );
        // 5 of the 20 a day on gemini-3-flash; flash-lite's quota is another.
        assert_eq!(usage["windows"][0]["used_percent"], 25.0);
        assert!(usage["windows"][0]["resets_at"].as_i64().unwrap() > now);
        // Kept for the next start.
        let reloaded = AiSettings::load(&dir);
        assert_eq!(
            reloaded
                .usage
                .into_inner()
                .limit("gemini")
                .and_then(|limit| limit.limit),
            Some(20)
        );
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn model_lists_come_from_the_cli() {
        let (state, dir) = state("models");
        let codex = fake_cli(
            &dir,
            "codex",
            r#"echo '{"models":[{"slug":"gpt-6.1-terra","display_name":"GPT-6.1 Terra","visibility":"list"},{"slug":"codex-auto-review","display_name":"Auto Review","visibility":"hide"}]}'"#,
        );
        state.ai.use_cli(Cli::Codex, codex);
        assert_eq!(
            list_models(&state, "codex").await.unwrap(),
            json!({ "models": [{ "id": "gpt-6.1-terra", "name": "GPT-6.1 Terra" }] })
        );
        let refused = list_models(&state, "claude").await.unwrap_err();
        assert_eq!(refused.1 .0.code, "invalid_request");
        let refused = list_models(&state, "openai").await.unwrap_err();
        assert_eq!(refused.1 .0.code, "provider_unavailable");
        std::fs::remove_dir_all(&dir).unwrap();
    }

    async fn list_models(state: &AppState, provider: &str) -> ApiResult<Value> {
        models(
            State(state.clone()),
            headers(),
            Query(ModelsQuery {
                provider: provider.into(),
            }),
        )
        .await
        .map(|Json(value)| value)
    }

    #[test]
    fn model_entries_drop_gemini_prefixes() {
        let body = json!({ "data": [{ "id": "models/gemini-2.5-flash", "display_name": "Gemini 2.5 Flash" }] });
        let models = entries(&body, |item| item["display_name"].as_str());
        assert_eq!(
            (models[0].id.as_str(), models[0].name.as_str()),
            ("gemini-2.5-flash", "Gemini 2.5 Flash")
        );
    }

    #[tokio::test]
    async fn chatgpt_signs_in_through_the_callback_and_writes_on_the_plan() {
        let fake = chatgpt::testing::start().await;
        let (state, dir) = state_with("chatgpt", fake.endpoints.clone());
        let _ = configure(
            State(state.clone()),
            headers(),
            patch(json!({ "enabled": true, "provider": "chatgpt", "model": "gpt-sol" })),
        )
        .await
        .unwrap();
        let refused = generate(State(state.clone()), headers(), ask("count rows")).await;
        assert_eq!(refused.unwrap_err().1 .0.code, "ai_not_configured");
        let login = chatgpt_login(
            State(state.clone()),
            headers(),
            Json(LoginRequest::default()),
        )
        .await
        .unwrap()
        .0;
        let query = chatgpt::testing::query(login["url"].as_str().unwrap());
        assert_eq!(query["redirect_uri"], "http://127.0.0.1:1/auth/callback");
        fake.world.lock().unwrap().nonce = query["nonce"].clone();
        let page = chatgpt_callback(
            State(state.clone()),
            Query(chatgpt::Callback {
                state: Some(query["state"].clone()),
                code: Some("code".into()),
                client_id: Some("oaiapp_1".into()),
                ..Default::default()
            }),
        )
        .await;
        assert_eq!(page.status(), StatusCode::OK);
        let status = status(
            State(state.clone()),
            headers(),
            Query(StatusQuery::default()),
        )
        .await
        .unwrap()
        .0;
        assert!(status.chatgpt.signed_in);

        fake.world.lock().unwrap().stream = [
            r#"{"type":"response.created","response":{"error":null}}"#,
            r#"{"type":"response.output_text.delta","delta":"```sql\nSELECT count(*)"}"#,
            r#"{"type":"response.output_text.delta","delta":" FROM demo\n```"}"#,
            r#"{"type":"response.completed","response":{}}"#,
        ]
        .map(|event| format!("data: {event}\n\n"))
        .concat();
        let response = generate(State(state.clone()), headers(), ask("행 수"))
            .await
            .unwrap();
        assert_eq!(
            body_lines(response).await.last().unwrap()["done"]["sql"],
            "SELECT count(*) FROM demo"
        );
        let sent = fake.world.lock().unwrap().requests.pop().unwrap();
        assert_eq!(
            (sent["store"].clone(), sent["stream"].clone()),
            (json!(false), json!(true))
        );
        assert_eq!(sent["model"], "gpt-sol");
        assert!(sent["instructions"]
            .as_str()
            .unwrap()
            .starts_with("You write SQLite queries"));
        assert!(sent["input"][0]["content"]
            .as_str()
            .unwrap()
            .contains("demo(id INTEGER PK"));
        assert!(sent.get("temperature").is_none() && sent.get("messages").is_none());

        // Suggestions as you type, on their own ChatGPT model.
        let Json(status) = configure(
            State(state.clone()),
            headers(),
            patch(json!({
                "autocomplete": true,
                "complete_model": { "provider": "chatgpt", "model": "gpt-fast" },
            })),
        )
        .await
        .unwrap();
        assert_eq!(status.model, "gpt-sol");
        fake.world.lock().unwrap().stream = [
            r#"{"type":"response.output_text.delta","delta":"FROM demo"}"#,
            r#"{"type":"response.output_text.delta","delta":" WHERE id = 1"}"#,
            r#"{"type":"response.completed","response":{}}"#,
        ]
        .map(|event| format!("data: {event}\n\n"))
        .concat();
        let Json(answer) = complete(
            State(state.clone()),
            headers(),
            completing("SELECT * FROM", ";"),
        )
        .await
        .unwrap();
        // The model repeated "FROM", already typed.
        assert_eq!(answer, json!({ "completion": " demo WHERE id = 1" }));
        let sent = fake.world.lock().unwrap().requests.pop().unwrap();
        assert_eq!(sent["model"], "gpt-fast");
        assert!(sent["input"][0]["content"]
            .as_str()
            .unwrap()
            .ends_with("Editor text:\nSELECT * FROM<CURSOR>;"));

        // The plan used up, mid-answer.
        fake.world.lock().unwrap().stream = format!(
            "data: {}\n\n",
            r#"{"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_limit_exceeded","message":"Usage limit"}}}"#
        );
        let response = generate(State(state.clone()), headers(), ask("행 수"))
            .await
            .unwrap();
        assert_eq!(
            body_lines(response).await.last().unwrap()["error"]["code"],
            "ai_usage_limit"
        );
        // Cut off before response.completed: not an answer.
        fake.world.lock().unwrap().stream =
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"SELECT 1\"}\n\n".into();
        let response = generate(State(state.clone()), headers(), ask("행 수"))
            .await
            .unwrap();
        assert_eq!(
            body_lines(response).await.last().unwrap()["error"]["code"],
            "ai_network"
        );

        let models = list_models(&state, "chatgpt").await.unwrap();
        assert_eq!(
            models["models"][0],
            json!({ "id": "gpt-sol", "name": "GPT Sol" })
        );
        let out = chatgpt_logout(State(state.clone()), headers())
            .await
            .unwrap()
            .0;
        assert_eq!(out["revoked"], true);
        assert_eq!(out["status"]["chatgpt"]["signed_in"], false);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
