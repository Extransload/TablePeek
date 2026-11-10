import { useEffect, useState, useSyncExternalStore } from "react";
import { t } from "../../i18n";
import { store, type AiCliProvider, type AiKeyProvider, type AiPatch, type AiProvider, type AiStatus } from "../../store";
import {
  AI_FAMILIES,
  AI_METHODS,
  aiCompleteReady,
  aiModelsProblem,
  AiModelPicker,
  aiProviderAvailable,
  aiProviderReady,
  aiSoonPickText,
  refreshAiModels,
  useAiModelLists,
  type AiMethod,
} from "../AiModelPicker";
import {
  ChatGptSignInButton,
  continueWithChatGpt,
  ManageUsageLink,
  reopenChatGptLogin,
  useChatGptLoginWatch,
} from "../ChatGpt";
import { AiAccountLine, AiUsageDetails, forgetAiUsage, loadAiUsage, useAiUsages } from "../AiUsage";
import { ErrorNotice, notifyError } from "../ErrorNotice";
import { writeClipboard } from "../../clipboard";
import { CheckIcon, CloseIcon, CopyIcon, ExternalIcon, RefreshIcon } from "../icons";
import { Spinner } from "../Spinner";
import { SettingRow, SettingsGroup, Switch } from "./rows";

const KEYWORDS = "ai llm text to sql";
const PROVIDER_KEYWORDS = `${KEYWORDS} provider connect`;

// What a CLI provider's row tells to run in a terminal: to install it, to sign in.
// `wait`: how long an answer takes, beside "SQL 작성".
const CLI_HELP: Record<
  AiCliProvider,
  { install: string[]; installNote: string; signIn: string[]; signInNote: string; wait: string; keywords: string }
> = {
  codex: {
    install: ["npm i -g @openai/codex"],
    installNote: "터미널에서 설치한 뒤 다시 확인을 누르세요. Homebrew라면 brew install codex도 됩니다.",
    signIn: ["codex login"],
    signInNote: "터미널에서 로그인한 뒤 다시 확인을 누르세요.",
    wait: "답까지 약 6초, 한 번에",
    keywords: "codex cli openai chatgpt terminal install login",
  },
};

// The connections whose limits the Usage section shows once connected, in
// its order.
const USAGE_PROVIDERS = ["codex", "gemini", "chatgpt"] as const;

const GEMINI_KEY_URL = "https://aistudio.google.com/apikey";
const GEMINI_TERMS_URL = "https://ai.google.dev/gemini-api/terms";

// AI: SQL written from a request with one model, picked across the
// connections ready below, and optional suggestions as the user types with a
// ChatGPT or Gemini model. The connections are grouped by model family, each
// way in (a sign-in, a CLI, an API key) connected on its own. The settings
// live on the server (keys in the OS keychain); nothing here is kept in the
// page's saved state.
export function AiSettings() {
  const status = useSyncExternalStore(store.subscribeAi, store.getAiStatus);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    store.fetchAi().catch((error: unknown) => notifyError(error));
  }, []);

  useChatGptLoginWatch(status);

  // Each connected connection's usage, read as the page opens or as it
  // connects; a connection that went is no longer shown.
  const connected = status === null ? null : USAGE_PROVIDERS.filter((provider) => aiProviderReady(status, provider)).join(" ");
  useEffect(() => {
    if (connected === null) {
      return;
    }
    const now = connected.split(" ");
    for (const provider of USAGE_PROVIDERS) {
      if (now.includes(provider)) {
        loadAiUsage(provider);
      } else {
        forgetAiUsage(provider);
      }
    }
  }, [connected]);

  async function save(patch: AiPatch): Promise<void> {
    setBusy(true);
    try {
      await store.configureAi(patch);
    } catch (error) {
      notifyError(error);
    } finally {
      setBusy(false);
    }
  }

  const ready = status !== null;
  // Suggestions need ChatGPT or a Gemini key: turning them on waits for one.
  const completeBlocked = status !== null && !aiCompleteReady(status);
  const soonPick = aiSoonPickText(status);

  return (
    <>
      <SettingsGroup
        title="AI로 SQL 작성"
        hint={t(
          "스키마(테이블·열 이름과 타입·키)와 요청, 선택한 SQL(제안을 켜면 커서 앞뒤의 SQL)만 제공자에게 보내고 행 데이터는 보내지 않습니다.",
        )}
      >
        <SettingRow
          label="AI로 SQL 작성"
          hint={t("쿼리 탭에서 요청을 글로 적으면 SQL을 에디터에 바로 써 줍니다. 받을지는 직접 고르고, 실행도 직접 합니다.")}
          keywords={KEYWORDS}
          changed={status?.enabled === true}
          onReset={() => void save({ enabled: false })}
        >
          {!ready ? <Spinner size={10} /> : null}
          <Switch
            label={t("AI로 SQL 작성")}
            checked={status?.enabled ?? false}
            disabled={!ready || busy}
            onChange={(enabled) => void save({ enabled })}
          />
        </SettingRow>
        <SettingRow
          label="모델"
          hint={soonPick ?? t("연결한 제공자의 모델 중 하나를 고릅니다.")}
          keywords={`${PROVIDER_KEYWORDS} model chatgpt codex cli gemini`}
          wide
        >
          <AiModelPicker status={status} where="settings" />
        </SettingRow>
        <SettingRow
          label="입력하는 동안 제안"
          hint={
            completeBlocked
              ? t(
                  "ChatGPT 로그인이나 Gemini API 키가 필요합니다. Codex CLI로는 쓸 수 없습니다 (답마다 몇 초 걸림).",
                )
              : t(
                  "입력을 멈출 때마다 이어질 SQL을 회색 글자로 보여 주고 Tab으로 넣습니다. 멈출 때마다 스키마와 커서 앞뒤의 SQL을 제공자에게 보내 요청이 하나씩 들어가므로 사용량과 비용이 늘어납니다.",
                )
          }
          keywords={`${KEYWORDS} autocomplete suggest suggestion copilot ghost inline completion chatgpt gemini 자동 완성`}
          changed={status?.autocomplete === true}
          onReset={() => void save({ autocomplete: false })}
        >
          <Switch
            label={t("입력하는 동안 제안")}
            checked={status?.autocomplete ?? false}
            disabled={!ready || busy || (completeBlocked && status.autocomplete !== true)}
            onChange={(autocomplete) => void save({ autocomplete })}
          />
        </SettingRow>
        <SettingRow
          label="자동 완성 모델"
          hint={
            aiSoonPickText(status, "complete") ??
            t("제안에 쓸 ChatGPT나 Gemini 모델입니다. 빠른 모델(GPT mini, Gemini Flash-Lite 급)을 권합니다.")
          }
          keywords={`${PROVIDER_KEYWORDS} autocomplete suggest model fast chatgpt gemini 자동 완성`}
          changed={status?.complete_model != null}
          onReset={() => void save({ complete_model: null })}
          wide
        >
          <AiModelPicker status={status} where="settings" target="complete" />
        </SettingRow>
      </SettingsGroup>
      {status !== null ? (
        <UsageSection providers={connected === null || connected === "" ? [] : (connected.split(" ") as AiProvider[])} />
      ) : null}
      {status !== null ? (
        <p className="settings-hint ai-connections-note">
          {t("Codex CLI 연결은 이 컴퓨터에 설치한 Codex CLI와 그 요금제로 요청합니다. TablePeek은 로그인 정보를 저장하지 않습니다.")}
        </p>
      ) : null}
      {status !== null
        ? AI_FAMILIES.map((family) => (
            <SettingsGroup key={family.id} title={family.label}>
              {AI_METHODS.filter((method) => method.family === family.id).map((method) => (
                <MethodRow key={method.id} method={method} family={family.label} status={status} />
              ))}
            </SettingsGroup>
          ))
        : null}
    </>
  );
}

// How much of each connected connection's limits is used, a row each, read
// again all at once by its one refresh button.
function UsageSection({ providers }: { providers: AiProvider[] }) {
  const usages = useAiUsages();
  const loading = providers.some((provider) => usages[provider]?.loading === true);
  return (
    <SettingsGroup
      title="사용량"
      action={
        providers.length > 0 ? (
          <button
            type="button"
            className="link-button settings-group-action-button"
            disabled={loading}
            onClick={() => {
              for (const provider of providers) {
                loadAiUsage(provider, true);
              }
            }}
          >
            {loading ? <Spinner size={9} /> : <RefreshIcon size={10} />}
            {t("새로고침")}
          </button>
        ) : undefined
      }
    >
      {providers.length === 0 ? (
        <p className="settings-hint ai-usage-empty">{t("연결된 곳이 없습니다")}</p>
      ) : (
        providers.map((provider) => {
          const method = AI_METHODS.find((candidate) => candidate.id === provider);
          return (
            <SettingRow
              key={provider}
              label={method?.group ?? provider}
              keywords={`${KEYWORDS} usage limit quota remaining rate 사용량 한도 남은`}
              wide
            >
              <AiUsageDetails provider={provider} />
            </SettingRow>
          );
        })
      )}
    </SettingsGroup>
  );
}

// A connection's state after its name: a dot and a word, read together.
type ConnectionTone = "ok" | "warn" | "off";

function ConnectionStatus({ tone, text }: { tone: ConnectionTone; text: string }) {
  return (
    <span className={`ai-conn-status ${tone}`} role="img" aria-label={t("상태: {state}", { state: text })}>
      <span className="ai-conn-dot" aria-hidden="true" />
      <span aria-hidden="true">{text}</span>
    </span>
  );
}

// What a connection can do: write SQL (with its wait, for a CLI) and, or
// not, suggest as the user types.
function Capabilities({ wait, suggests }: { wait: string | null; suggests: boolean }) {
  return (
    <div className="ai-conn-caps">
      <span className="ai-cap ok">
        <CheckIcon size={11} />
        <span className="sr-only">{t("가능")}: </span>
        {wait === null ? t("SQL 작성") : `${t("SQL 작성")} · ${t(wait)}`}
      </span>
      {suggests ? (
        <span className="ai-cap ok">
          <CheckIcon size={11} />
          <span className="sr-only">{t("가능")}: </span>
          {t("입력 중 제안")}
        </span>
      ) : (
        <span className="ai-cap no">
          <CloseIcon size={11} />
          <span className="sr-only">{t("불가")}: </span>
          {t("입력 중 제안 — CLI는 답마다 몇 초 걸려 쓸 수 없습니다")}
        </span>
      )}
    </div>
  );
}

// A command to run in a terminal, exactly, with a button copying it.
function CommandBox({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="ai-cmd">
      <code>{command}</code>
      <button
        type="button"
        className="ai-cmd-copy"
        aria-label={`${t("복사")}: ${command}`}
        onClick={() =>
          void writeClipboard(command).then((done) => {
            setCopied(done);
            if (done) {
              window.setTimeout(() => setCopied(false), 1500);
            }
          })
        }
      >
        {copied ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
        {copied ? t("복사됨") : t("복사")}
      </button>
    </span>
  );
}

// One way into a family's models, as its own row: what it needs and has.
function MethodRow({ method, family, status }: { method: AiMethod; family: string; status: AiStatus }) {
  if (!aiProviderAvailable(status, method.id)) {
    return <SoonRow method={method} family={family} />;
  }
  switch (method.id) {
    case "chatgpt":
      return <ChatGptRow method={method} status={status} />;
    case "codex":
      return <CliProviderRow method={method} provider={method.id} status={status} />;
    case "openai":
    case "anthropic":
    case "gemini":
    case "openrouter":
      return <KeyProviderRow method={method} provider={method.id} status={status} />;
    default:
      return <SoonRow method={method} family={family} />;
  }
}

// A connection coming soon: listed, faint, nothing to press.
function SoonRow({ method, family }: { method: AiMethod; family: string }) {
  return (
    <SettingRow
      label={method.method}
      keywords={`${PROVIDER_KEYWORDS} coming soon ${family} ${method.short} api key local`}
      muted
    >
      <span className="badge-state">{t("곧 지원")}</span>
    </SettingRow>
  );
}

// An API key: saved in the OS keychain and never shown again; replaced or
// deleted. Gemini's row adds where to get one and what its free tier means.
function KeyProviderRow({ method, provider, status }: { method: AiMethod; provider: AiKeyProvider; status: AiStatus }) {
  const saved = status.providers[provider]?.has_key === true;
  const [key, setKey] = useState("");
  const [replacing, setReplacing] = useState(false);
  const [saving, setSaving] = useState(false);
  const list = useAiModelLists()[provider];
  const editing = !saved || replacing;

  async function run(change: () => Promise<AiStatus>): Promise<void> {
    setSaving(true);
    try {
      refreshAiModels(await change(), provider);
      setKey("");
      setReplacing(false);
    } catch (error) {
      notifyError(error);
    } finally {
      setSaving(false);
    }
  }

  function saveKey(): void {
    const next = key.trim();
    if (next !== "") {
      void run(() => store.saveAiKey(provider, next));
    }
  }

  return (
    <SettingRow
      label={method.method}
      keywords={`${PROVIDER_KEYWORDS} ${method.short} api key secret keychain google ai studio free tier`}
      status={<ConnectionStatus tone={saved ? "ok" : "off"} text={saved ? t("키 저장됨") : t("키 없음")} />}
      action={
        saved && !replacing ? (
          <>
            <button type="button" className="link-button" disabled={saving} onClick={() => setReplacing(true)}>
              {t("키 바꾸기")}
            </button>
            <button type="button" className="link-button" disabled={saving} onClick={() => void run(() => store.clearAiKey(provider))}>
              {t("삭제")}
            </button>
          </>
        ) : undefined
      }
      wide
    >
      {editing ? (
        <div className="ai-key-entry">
          <input
            type="password"
            className="ai-key-field"
            aria-label={`${t(method.short)} ${t("API 키 [연결]")}`}
            placeholder={t("API 키 [연결]")}
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                saveKey();
              } else if (event.key === "Escape" && replacing) {
                event.stopPropagation();
                setReplacing(false);
                setKey("");
              }
            }}
          />
          <button type="button" disabled={saving || key.trim() === ""} onClick={saveKey}>
            {t("저장")}
          </button>
          {replacing ? (
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                setReplacing(false);
                setKey("");
              }}
            >
              {t("취소")}
            </button>
          ) : null}
        </div>
      ) : null}
      {editing && provider === "gemini" ? (
        <span className="ai-key-links">
          <button type="button" className="link-button" onClick={() => window.open(GEMINI_KEY_URL, "_blank", "noopener")}>
            {t("API 키 받기")}
            <ExternalIcon size={10} />
          </button>
          <span aria-hidden="true">·</span>
          <button type="button" className="link-button" onClick={() => window.open(GEMINI_TERMS_URL, "_blank", "noopener")}>
            {t("무료 등급 약관")}
            <ExternalIcon size={10} />
          </button>
        </span>
      ) : null}
      {saved && list?.error != null ? <span className="ai-conn-note warn">{aiModelsProblem(list.error)}</span> : null}
      <Capabilities wait={null} suggests />
      {provider === "gemini" ? (
        <span className="ai-conn-note">
          {t("키는 OS 키체인에 저장되고 다시 보이지 않습니다. 무료 등급은 하루 한도가 있고 요청이 Google의 모델 개선에 쓰일 수 있습니다.")}
        </span>
      ) : null}
    </SettingRow>
  );
}

// A coding CLI on this computer: connected (as whom), or the command that
// installs it or signs it in; and a check again.
function CliProviderRow({ method, provider, status }: { method: AiMethod; provider: AiCliProvider; status: AiStatus }) {
  const [checking, setChecking] = useState(false);
  const cli = status.providers[provider]?.cli;
  const help = CLI_HELP[provider];
  const installed = cli?.installed === true;
  const signedIn = installed && cli?.signed_in === true;

  async function check(): Promise<void> {
    setChecking(true);
    try {
      const next = await store.refreshAi();
      refreshAiModels(next, provider);
      if (aiProviderReady(next, provider)) {
        loadAiUsage(provider, true);
      }
    } catch (error) {
      notifyError(error);
    } finally {
      setChecking(false);
    }
  }

  return (
    <SettingRow
      label={method.method}
      keywords={`${PROVIDER_KEYWORDS} ${help.keywords}`}
      status={
        <ConnectionStatus
          tone={signedIn ? "ok" : installed ? "warn" : "off"}
          text={signedIn ? t("연결됨") : installed ? t("로그인 필요") : t("설치 안 됨")}
        />
      }
      action={
        <button
          type="button"
          className="link-button ai-conn-action"
          disabled={checking}
          aria-label={`${t(method.method)} ${t("다시 확인")}`}
          onClick={() => void check()}
        >
          {checking ? <Spinner size={9} /> : null}
          {t("다시 확인")}
        </button>
      }
      wide
    >
      {signedIn && cli !== undefined ? (
        <>
          <AiAccountLine provider={provider} own={{ email: cli.email ?? null, plan: cli.account, workspace: cli.workspace ?? null }} />
          <Capabilities wait={help.wait} suggests={false} />
        </>
      ) : (
        <>
          <div className="ai-cmds">
            {(installed ? help.signIn : help.install).map((command) => (
              <CommandBox key={command} command={command} />
            ))}
          </div>
          <span className="ai-conn-note">{t(installed ? help.signInNote : help.installNote)}</span>
          <Capabilities wait={help.wait} suggests={false} />
        </>
      )}
    </SettingRow>
  );
}

// The ChatGPT plan, signed in through the browser instead of a key.
function ChatGptRow({ method, status }: { method: AiMethod; status: AiStatus }) {
  const { signed_in: signedIn, email, login, login_error: loginError } = status.chatgpt;
  const [signingOut, setSigningOut] = useState(false);
  // Signed out here, but OpenAI didn't confirm it let go of the tokens.
  const [notRevoked, setNotRevoked] = useState(false);
  // A Business/Enterprise workspace turned the sign-in down.
  const workspaceDenied =
    login === "failed" && loginError !== null && loginError.includes("3p_delegated_access_policy_denied");

  async function signOut(): Promise<void> {
    setSigningOut(true);
    try {
      const { revoked } = await store.chatGptLogout();
      setNotRevoked(!revoked);
      refreshAiModels(store.getAiStatus() ?? status, "chatgpt");
    } catch (error) {
      notifyError(error);
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <SettingRow
      label={method.method}
      hint={
        login === "pending" || workspaceDenied
          ? t(
              "회사(Business·Enterprise) 워크스페이스 계정은 관리자 승인 없이는 로그인되지 않을 수 있습니다. 그럴 때는 Codex CLI나 Gemini API 키를 쓰세요.",
            )
          : notRevoked && !signedIn
            ? t(
                "이 컴퓨터에서는 로그아웃했지만 OpenAI가 연결 해제를 확인하지 않았습니다. ChatGPT 설정 › 보안 및 로그인에서 TablePeek 연결을 끊을 수 있습니다.",
              )
            : null
      }
      keywords={`${PROVIDER_KEYWORDS} chatgpt subscription sign in login plan usage account email logout business enterprise workspace`}
      status={
        <ConnectionStatus
          tone={signedIn ? "ok" : "warn"}
          text={signedIn ? t("연결됨") : login === "pending" ? t("로그인 중") : t("로그인 필요")}
        />
      }
      action={
        login === "pending" ? (
          <>
            <button type="button" className="link-button" onClick={reopenChatGptLogin}>
              {t("로그인 페이지 다시 열기")}
            </button>
            <button type="button" className="link-button" onClick={() => void store.cancelChatGptLogin().catch(notifyError)}>
              {t("취소")}
            </button>
          </>
        ) : signedIn ? (
          <>
            <button
              type="button"
              className="link-button"
              disabled={signingOut}
              onClick={() => {
                setNotRevoked(false);
                void continueWithChatGpt(true);
              }}
            >
              {t("다른 계정으로 로그인")}
            </button>
            <button type="button" className="link-button" disabled={signingOut} onClick={() => void signOut()}>
              {t("로그아웃")}
            </button>
          </>
        ) : (
          <ChatGptSignInButton disabled={signingOut} />
        )
      }
      wide
    >
      {login === "failed" && loginError !== null ? (
        <ErrorNotice error={{ code: "ai_login_failed", message: loginError }} variant="compact" />
      ) : null}
      {login === "pending" ? (
        <span className="ai-conn-note">
          <Spinner size={9} /> {t("브라우저에서 로그인을 끝내세요")}
        </span>
      ) : null}
      {signedIn ? <AiAccountLine provider="chatgpt" own={{ email, plan: null, workspace: null }} /> : null}
      {!signedIn && login !== "pending" ? (
        <span className="ai-conn-note">{t("ChatGPT Go·Plus·Pro 요금제의 사용량으로 요청합니다. API 키는 필요 없습니다.")}</span>
      ) : null}
      <Capabilities wait={null} suggests />
      <span className="ai-conn-meta">
        <ManageUsageLink />
      </span>
    </SettingRow>
  );
}
