import { useSyncExternalStore } from "react";
import { toAppError } from "../errorHelp";
import { getLanguage, t, tServer } from "../i18n";
import { store, type AiProvider, type AiUsage, type AiUsageWindow } from "../store";
import { Spinner } from "./Spinner";

// A connection's account and how much of its limits is used (Settings › AI,
// the AI box, the model picker's headers), read when a screen showing it
// opens and again after each answer from that connection: never on a timer.

interface UsageState {
  usage: AiUsage | null;
  loading: boolean;
  error: unknown;
}

let usages: Partial<Record<AiProvider, UsageState>> = {};
// Each provider's latest read: an older answer arriving late is dropped.
const reads: Partial<Record<AiProvider, number>> = {};
const listeners = new Set<() => void>();

function setUsage(provider: AiProvider, state: UsageState): void {
  usages = { ...usages, [provider]: state };
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAiUsages(): Partial<Record<AiProvider, UsageState>> {
  return useSyncExternalStore(subscribe, () => usages);
}

// Reads a connection's usage again; `refresh` asks the CLI afresh.
export function loadAiUsage(provider: AiProvider, refresh = false): void {
  const read = (reads[provider] ?? 0) + 1;
  reads[provider] = read;
  setUsage(provider, { usage: usages[provider]?.usage ?? null, loading: true, error: null });
  store.fetchAiUsage(provider, refresh).then(
    (usage) => reads[provider] === read && setUsage(provider, { usage, loading: false, error: null }),
    (error: unknown) => reads[provider] === read && setUsage(provider, { usage: null, loading: false, error }),
  );
}

// After an answer, what is shown of that connection is read again.
store.subscribeAiAnswers((provider) => {
  if (usages[provider] !== undefined) {
    loadAiUsage(provider);
  }
});

// The usage shown no more (the connection signed out or its key deleted).
export function forgetAiUsage(provider: AiProvider): void {
  reads[provider] = (reads[provider] ?? 0) + 1;
  const { [provider]: _gone, ...rest } = usages;
  usages = rest;
  for (const listener of listeners) {
    listener();
  }
}

type Level = "ok" | "warn" | "full";

function levelOf(percent: number): Level {
  return percent >= 100 ? "full" : percent >= 80 ? "warn" : "ok";
}

function percentOf(window: AiUsageWindow): number {
  return Math.max(0, Math.min(100, Math.round(window.used_percent)));
}

// "5시간", "주간", "하루": a window by its kind, else its length.
function windowShort(window: AiUsageWindow): string {
  switch (window.kind) {
    case "five_hour":
      return t("5시간");
    case "seven_day":
      return t("주간");
    case "daily":
      return t("하루");
    default:
      if (window.minutes === null) {
        return window.kind;
      }
      return window.minutes % 1440 === 0
        ? t("{days}일", { days: window.minutes / 1440 })
        : window.minutes % 60 === 0
          ? t("{hours}시간", { hours: window.minutes / 60 })
          : t("{minutes}분", { minutes: window.minutes });
  }
}

// "1시간 52분", "3분": a span to the minute, rounded `up` (a wait) or down
// (how long ago).
function span(seconds: number, up = true): string {
  const total = Math.max(1, up ? Math.ceil(seconds / 60) : Math.floor(seconds / 60));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours === 0) {
    return t("{minutes}분", { minutes });
  }
  return minutes === 0 ? t("{hours}시간", { hours }) : t("{hours}시간 {minutes}분", { hours, minutes });
}

// When a window starts over: in so long under a day, else the date and time.
function resetText(at: number): string {
  const seconds = at - Date.now() / 1000;
  if (seconds <= 0) {
    return t("곧 초기화");
  }
  if (seconds < 86_400) {
    return t("{wait} 뒤 초기화", { wait: span(seconds) });
  }
  const when = new Intl.DateTimeFormat(getLanguage() === "en" ? "en-US" : "ko-KR", {
    month: "short",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(at * 1000));
  return t("{when} 초기화", { when });
}

// "5시간 한도 66% 사용 · 1시간 52분 뒤 초기화".
function windowLine(window: AiUsageWindow): string {
  const used = t("{window} 한도 {percent}% 사용", { window: windowShort(window), percent: percentOf(window) });
  return window.resets_at === null ? used : `${used} · ${resetText(window.resets_at)}`;
}

function agoText(at: number): string {
  const seconds = Date.now() / 1000 - at;
  return seconds < 60 ? t("방금") : t("{span} 전", { span: span(seconds, false) });
}

// The plan and workspace ("Team · Research Factory", "Plus"), the
// plan capitalized; null when neither is known.
function planLine(usage: AiUsage): string | null {
  const account = usage.account;
  if (account === null) {
    return null;
  }
  const plan = account.plan === null ? null : account.plan.charAt(0).toUpperCase() + account.plan.slice(1);
  const parts = [plan, account.workspace].filter((part): part is string => part !== null && part !== "");
  return parts.length === 0 ? null : parts.join(" · ");
}

function mostUrgent(usage: AiUsage | null | undefined): AiUsageWindow | null {
  if (usage == null || usage.windows.length === 0) {
    return null;
  }
  return usage.windows.reduce((most, window) => (window.used_percent > most.used_percent ? window : most));
}

// Every line about a connection's usage, for a tooltip.
export function aiUsageLines(usage: AiUsage): string[] {
  const lines = [usage.account?.email ?? null, planLine(usage), ...usage.windows.map(windowLine)];
  if (usage.source === "last_answer" && usage.as_of !== null) {
    lines.push(t("마지막 답 기준 · {ago}", { ago: agoText(usage.as_of) }));
  }
  return lines.filter((line): line is string => line !== null);
}

// What is left of the most urgent window ("5시간 34% 남음"), and how close
// it is to its limit; null with nothing known.
export function aiUsageShort(usage: AiUsage | null | undefined): { left: string; level: Level } | null {
  const window = mostUrgent(usage);
  if (window === null) {
    return null;
  }
  const percent = percentOf(window);
  return {
    left: t("{window} {percent}% 남음", { window: windowShort(window), percent: 100 - percent }),
    level: levelOf(percent),
  };
}

// A window as a thin bar under its line, colored as it nears the limit.
function UsageMeter({ window }: { window: AiUsageWindow }) {
  const percent = percentOf(window);
  const line = windowLine(window);
  return (
    <div className="ai-usage-window">
      <span className="ai-usage-line">{line}</span>
      <div
        className={`ai-usage-bar ${levelOf(percent)}`}
        role="meter"
        aria-label={line}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

// A connected row's account on one line, `email · plan · workspace`: what
// the sign-in itself says (`own`), else what its usage last named; the plan
// capitalized ("team" → "Team"), and a workspace that is only the email's
// own organization ("…@gmail.com's Organization") left out.
export function AiAccountLine({
  provider,
  own,
}: {
  provider: AiProvider;
  own: { email: string | null; plan: string | null; workspace: string | null };
}) {
  const account = useAiUsages()[provider]?.usage?.account ?? null;
  const email = own.email ?? account?.email ?? null;
  const rawPlan = account?.plan ?? own.plan;
  const plan = rawPlan == null ? null : rawPlan.charAt(0).toUpperCase() + rawPlan.slice(1);
  const workspace = account?.workspace ?? own.workspace;
  const rest = [plan, workspace === `${email}'s Organization` ? null : workspace].filter(
    (part): part is string => part != null && part !== "",
  );
  if (email === null && rest.length === 0) {
    return null;
  }
  return (
    <span className="ai-account-line">
      {email !== null ? <span className="ai-account-email">{email}</span> : null}
      {rest.length > 0 ? (
        <span className="ai-account-plan">{`${email !== null ? " · " : ""}${rest.join(" · ")}`}</span>
      ) : null}
    </span>
  );
}

// A connected connection's limits in Settings › AI's Usage section: a line
// and a bar per window, credits, Gemini's own counts, how fresh it is, or
// why it couldn't be read.
export function AiUsageDetails({ provider }: { provider: AiProvider }) {
  const state = useAiUsages()[provider];
  if (state === undefined) {
    return null;
  }
  const { usage, loading, error } = state;
  return (
    <div className="ai-usage">
      {usage?.windows.map((window) => <UsageMeter key={`${window.kind}-${window.minutes}`} window={window} />)}
      {usage?.credits != null && (usage.credits.unlimited || usage.credits.has_credits) ? (
        <span className="ai-usage-note">
          {usage.credits.unlimited
            ? t("크레딧 무제한")
            : usage.credits.balance !== null
              ? t("크레딧 {balance}", { balance: usage.credits.balance })
              : t("크레딧 있음")}
        </span>
      ) : null}
      {usage !== null && provider === "gemini" ? <GeminiUsage usage={usage} /> : null}
      {usage?.source === "last_answer" && usage.as_of !== null && usage.windows.length > 0 ? (
        <span className="ai-usage-note">{t("마지막 답 기준 · {ago}", { ago: agoText(usage.as_of) })}</span>
      ) : null}
      {usage?.source === "none" || (usage !== null && usage.windows.length === 0 && provider !== "gemini") ? (
        <span className="ai-usage-note">{t("아직 정보가 없습니다 — 한 번 쓰면 나옵니다")}</span>
      ) : null}
      {error != null ? (
        <span className="ai-usage-note warn">
          {t("사용량을 읽지 못했습니다: {reason}", { reason: tServer(toAppError(error).message) })}
        </span>
      ) : null}
      {loading && usage === null ? <Spinner size={10} /> : null}
    </div>
  );
}

// Gemini's: the requests sent from here today, the last limit Google
// reported; Google doesn't say what is left.
function GeminiUsage({ usage }: { usage: AiUsage }) {
  const today =
    usage.today.length === 0
      ? t("없음")
      : usage.today.map((entry) => t("{model} {count}회", { model: entry.model, count: entry.requests })).join(" · ");
  const limit = usage.limit;
  return (
    <>
      <span className="ai-usage-note">{t("오늘 보낸 요청 (이 컴퓨터): {list}", { list: today })}</span>
      {limit !== null && limit.limit !== null ? (
        <span className="ai-usage-note">
          {[
            t(limit.per_day ? "한도: 하루 {limit}회" : "한도: {limit}회", { limit: limit.limit }),
            limit.free_tier ? t("(무료 등급)") : null,
          ]
            .filter((part) => part !== null)
            .join(" ")}
          {limit.model !== null ? ` · ${limit.model}` : ""}
        </span>
      ) : null}
      <span className="ai-usage-note">
        {t("Google은 남은 한도를 알려 주지 않아, 횟수는 TablePeek이 이 컴퓨터에서 센 것입니다.")}
      </span>
    </>
  );
}

// The AI box's few words beside the model: the active connection's most
// urgent window, the full lines in its tooltip; nothing with nothing known.
export function AiUsageChip({ provider }: { provider: AiProvider }) {
  const usage = useAiUsages()[provider]?.usage;
  const short = aiUsageShort(usage);
  if (usage == null || short === null) {
    return null;
  }
  const lines = aiUsageLines(usage).join("\n");
  return (
    <span className={`ai-usage-chip ${short.level}`} title={lines} aria-label={lines}>
      {short.left}
    </span>
  );
}
