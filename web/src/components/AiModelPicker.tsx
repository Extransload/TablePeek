import { useRef, useState, useSyncExternalStore } from "react";
import { toAppError } from "../errorHelp";
import { t, tServer } from "../i18n";
import { store, type AiModel, type AiModelRef, type AiPatch, type AiProvider, type AiStatus } from "../store";
import { aiUsageShort, useAiUsages } from "./AiUsage";
import { promptDialog } from "./ConfirmDialog";
import { notifyError } from "./ErrorNotice";
import { ChevronDownIcon } from "./icons";
import { Picker, type PickerAction, type PickerItem } from "./settings/Picker";

// The model AI requests use, picked across the connections that work
// (Settings › AI and the editor's AI box share it), the one suggestions as
// the user types use, and the connections' model lists the pickers show,
// kept here so the screens and the connection rows agree.

// The model families Settings groups the connections under.
export type AiFamily = "gpt" | "claude" | "gemini" | "other";

export const AI_FAMILIES: { id: AiFamily; label: string }[] = [
  { id: "gpt", label: "GPT · OpenAI" },
  { id: "claude", label: "Claude · Anthropic" },
  { id: "gemini", label: "Gemini · Google" },
  { id: "other", label: "기타" },
];

// Each way of reaching a family's models, a connection of its own (one
// provider id): `method` names it in its family's rows, `short` beside a
// model ("gpt-5.6-luna · Codex CLI"), `group` heads its models in the picker.
export interface AiMethod {
  id: AiProvider;
  family: AiFamily;
  method: string;
  short: string;
  group: string;
}

export const AI_METHODS: AiMethod[] = [
  { id: "chatgpt", family: "gpt", method: "ChatGPT 로그인", short: "ChatGPT", group: "GPT · ChatGPT" },
  { id: "codex", family: "gpt", method: "Codex CLI", short: "Codex CLI", group: "GPT · Codex CLI" },
  { id: "openai", family: "gpt", method: "API 키 [연결]", short: "OpenAI", group: "GPT · API 키" },
  { id: "anthropic", family: "claude", method: "API 키 [연결]", short: "Anthropic", group: "Claude · API 키" },
  { id: "gemini", family: "gemini", method: "API 키 [연결]", short: "Gemini", group: "Gemini · API 키" },
  { id: "openrouter", family: "other", method: "OpenRouter", short: "OpenRouter", group: "OpenRouter" },
  { id: "ollama", family: "other", method: "Ollama", short: "Ollama", group: "Ollama" },
  { id: "lmstudio", family: "other", method: "LM Studio", short: "LM Studio", group: "LM Studio" },
];

function aiMethod(provider: AiProvider): AiMethod | undefined {
  return AI_METHODS.find((method) => method.id === provider);
}

// The connection beside a model: "ChatGPT", "Codex CLI", "Gemini".
export function aiProviderLabel(provider: AiProvider): string {
  return t(aiMethod(provider)?.short ?? provider);
}

// Whether a connection can be used at all (false: coming soon).
export function aiProviderAvailable(status: AiStatus, provider: AiProvider): boolean {
  return provider === "chatgpt" || status.providers[provider]?.available === true;
}

// Signed in to ChatGPT, the CLI installed and signed in, or the key saved:
// its models listed.
export function aiProviderReady(status: AiStatus, provider: AiProvider): boolean {
  if (provider === "chatgpt") {
    return status.chatgpt.signed_in;
  }
  const connection = status.providers[provider];
  if (connection === undefined || !connection.available) {
    return false;
  }
  return connection.cli !== undefined
    ? connection.cli.installed && connection.cli.signed_in
    : connection.has_key === true;
}

// A provider's models as last read: kept while they are read again, gone
// once a read fails.
interface AiModelList {
  models: AiModel[] | null;
  loading: boolean;
  error: unknown;
}

let lists: Partial<Record<AiProvider, AiModelList>> = {};
// Each provider's latest read: an older answer arriving late is dropped.
const reads: Partial<Record<AiProvider, number>> = {};
const listeners = new Set<() => void>();

function setList(provider: AiProvider, list: AiModelList): void {
  lists = { ...lists, [provider]: list };
  for (const listener of listeners) {
    listener();
  }
}

function subscribeLists(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useAiModelLists(): Partial<Record<AiProvider, AiModelList>> {
  return useSyncExternalStore(subscribeLists, () => lists);
}

// Reads a provider's models again.
function loadAiModels(provider: AiProvider): void {
  const read = (reads[provider] ?? 0) + 1;
  reads[provider] = read;
  setList(provider, { models: lists[provider]?.models ?? null, loading: true, error: null });
  store.listAiModels(provider).then(
    (models) => reads[provider] === read && setList(provider, { models, loading: false, error: null }),
    (error: unknown) => reads[provider] === read && setList(provider, { models: null, loading: false, error }),
  );
}

// After a connection's sign-in, CLI or key changed: its list read again, or
// dropped when it can no longer be used.
export function refreshAiModels(status: AiStatus, provider: AiProvider): void {
  if (aiProviderReady(status, provider)) {
    loadAiModels(provider);
  } else {
    reads[provider] = (reads[provider] ?? 0) + 1;
    setList(provider, { models: null, loading: false, error: null });
  }
}

// Why a provider's models couldn't be read, in a few words.
export function aiModelsProblem(error: unknown): string {
  const appError = toAppError(error);
  return appError.code === "ai_network" ? t("연결할 수 없음") : tServer(appError.message);
}

// The value of a picker item: the provider, a slash, the model id (which may
// hold slashes of its own; a provider id never does).
function pickValue(provider: AiProvider, model: string): string {
  return `${provider}/${model}`;
}

// Which model a picker sets: the one AI requests use, or the one for
// suggestions as the user types (null there: the same one).
export type AiModelTarget = "main" | "complete";

function pick(target: AiModelTarget, model: AiModelRef | null): void {
  const patch: AiPatch = target === "complete" ? { complete_model: model } : (model ?? {});
  store.configureAi(patch).catch((error: unknown) => notifyError(error));
}

// The value of the suggestions picker's "same as the main model".
const SAME_AS_MAIN = "";

// Suggestions as the user types take a ChatGPT or Gemini API model: a CLI
// takes seconds per answer.
const COMPLETE_PROVIDERS: AiProvider[] = ["chatgpt", "gemini"];

// Whether suggestions as the user types have a connection to use.
export function aiCompleteReady(status: AiStatus): boolean {
  return COMPLETE_PROVIDERS.some((provider) => aiProviderReady(status, provider));
}

// The model picked (or, for suggestions, picked for them) when its provider
// is coming soon (a pick saved before it was): what to say instead.
export function aiSoonPickText(status: AiStatus | null, target: AiModelTarget = "main"): string | null {
  const provider = status === null ? null : target === "complete" ? status.complete_model?.provider : status.provider;
  if (status === null || provider == null || aiProviderAvailable(status, provider)) {
    return null;
  }
  return t("{provider} 연결은 곧 지원합니다. 지금 쓸 수 있는 연결의 모델 중에서 다시 고르세요.", {
    provider: aiProviderLabel(provider),
  });
}

// The picked model as a button (`<model> · <connection>`, or "모델 선택")
// opening the searchable list of the models of every connection ready to
// use, grouped by connection (suggestions: ChatGPT's and Gemini's alone),
// read again as it opens. `where` says where the connections are made;
// `compact` shows the model's name alone (the connection in its tooltip).
export function AiModelPicker({
  status,
  where,
  target = "main",
  compact = false,
  className = "",
}: {
  status: AiStatus | null;
  where: "settings" | "bar";
  target?: AiModelTarget;
  compact?: boolean;
  className?: string;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const modelLists = useAiModelLists();
  const usages = useAiUsages();
  const ready =
    status === null
      ? []
      : AI_METHODS.filter(
          (option) =>
            (target === "main" || COMPLETE_PROVIDERS.includes(option.id)) && aiProviderReady(status, option.id),
        );
  const picked: AiModelRef | null =
    status === null
      ? null
      : target === "complete"
        ? status.complete_model
        : status.model !== ""
          ? { provider: status.provider, model: status.model }
          : null;
  const pickedName =
    picked === null
      ? null
      : (modelLists[picked.provider]?.models?.find((model) => model.id === picked.model)?.name ?? picked.model);
  // Suggestions follow the main model only while it is a ChatGPT or Gemini one.
  const mainFits = status !== null && COMPLETE_PROVIDERS.includes(status.provider) && status.model !== "";
  // A pick whose provider is coming soon: shown as such, not offered again.
  const soon = aiSoonPickText(status, target);
  const shown =
    picked === null
      ? target === "complete" && mainFits
        ? t("기본 모델과 같음")
        : t("모델 선택")
      : soon !== null
        ? `${pickedName} · ${aiProviderLabel(picked.provider)} · ${t("곧 지원")}`
        : `${pickedName} · ${aiProviderLabel(picked.provider)}`;

  function close(refocus: boolean): void {
    setOpen(false);
    if (refocus) {
      (buttonRef.current?.closest<HTMLElement>("[data-row]") ?? buttonRef.current)?.focus();
    }
  }

  async function enterModel(provider: AiProvider): Promise<void> {
    close(false);
    const label = aiProviderLabel(provider);
    const model = await promptDialog({
      title: t("모델 직접 입력"),
      label: t("{provider} 모델 ID", { provider: label }),
      confirmLabel: t("확인"),
    });
    if (model !== null && model !== "") {
      pick(target, { provider, model });
    }
  }

  const items: PickerItem[] = ready.flatMap((option) => {
    // A connection's header says what is left of its most urgent limit, when known.
    const left = aiUsageShort(usages[option.id]?.usage)?.left;
    const group = left === undefined ? t(option.group) : `${t(option.group)} — ${left}`;
    return (modelLists[option.id]?.models ?? []).map((model) => ({
      value: pickValue(option.id, model.id),
      label: model.name,
      group,
      selected: picked?.provider === option.id && picked.model === model.id,
    }));
  });
  const listed = items.length > 0;
  // A model typed in, or one its provider no longer lists: still shown, first.
  if (picked !== null && soon === null && !items.some((item) => item.selected)) {
    items.unshift({ value: pickValue(picked.provider, picked.model), label: shown, selected: true });
  }
  // Suggestions may follow the main model, first in their list.
  if (target === "complete" && mainFits) {
    items.unshift({ value: SAME_AS_MAIN, label: t("기본 모델과 같음"), selected: picked === null });
  }
  // Typing an id that isn't listed: offered for each provider answering.
  const actions: PickerAction[] = ready
    .filter((option) => modelLists[option.id]?.error == null)
    .map((option) => ({
      label: t("{provider} 모델 직접 입력…", { provider: t(option.group) }),
      run: () => void enterModel(option.id),
    }));
  const loading = ready.some((option) => modelLists[option.id]?.loading === true);
  const problems = ready.flatMap((option) => {
    const error = modelLists[option.id]?.error;
    return error == null ? [] : [`${t(option.group)}: ${aiModelsProblem(error)}`];
  });
  const note = [
    soon,
    loading ? t("모델 목록을 불러오는 중…") : null,
    !loading && !listed
      ? where === "settings"
        ? t("아래에서 제공자를 연결하세요")
        : t("설정 › AI에서 제공자를 연결하세요")
      : null,
    ...problems,
  ]
    .filter((line) => line !== null)
    .join(" · ");

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={`settings-picker-button ai-model-button${(picked === null && target === "main") || soon !== null ? " unset" : ""}${soon !== null ? " unavailable" : ""}${className === "" ? "" : ` ${className}`}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${target === "complete" ? t("자동 완성 모델") : t("모델")}: ${shown}`}
        title={soon ?? shown}
        disabled={status === null || (target === "complete" && !aiCompleteReady(status))}
        onClick={() => {
          if (open) {
            close(false);
            return;
          }
          for (const option of ready) {
            loadAiModels(option.id);
          }
          setOpen(true);
        }}
      >
        <span className="settings-picker-value">
          {compact && pickedName !== null && picked !== null
            ? soon !== null
              ? `${aiProviderLabel(picked.provider)} · ${t("곧 지원")}`
              : pickedName
            : shown}
        </span>
        <ChevronDownIcon size={10} />
      </button>
      {open && buttonRef.current !== null ? (
        <Picker
          anchor={buttonRef.current}
          label={target === "complete" ? t("자동 완성 모델") : t("모델")}
          items={items}
          actions={actions}
          note={note === "" ? null : note}
          onPick={(value) => {
            close(true);
            if (value === SAME_AS_MAIN) {
              pick(target, null);
              return;
            }
            const slash = value.indexOf("/");
            pick(target, { provider: value.slice(0, slash) as AiProvider, model: value.slice(slash + 1) });
          }}
          onClose={close}
        />
      ) : null}
    </>
  );
}
