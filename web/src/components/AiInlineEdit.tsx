import type { EditorView } from "@codemirror/view";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
} from "react";
import {
  acceptAiPending,
  aiPendingOf,
  aiPendingText,
  aiTarget,
  aiZoneField,
  rejectAiPending,
  restoreAiOriginal,
  setAiZone,
  setAiZoneHeight,
  startAiPending,
  writeAiPending,
} from "../aiEditor";
import { t } from "../i18n";
import { ariaKeyshortcuts, formatBinding, IS_MAC } from "../shortcuts";
import { ApiRequestError, store, type AiProgress, type GeneratedSql } from "../store";
import { AiModelPicker, aiProviderReady, aiSoonPickText } from "./AiModelPicker";
import { AiUsageChip, loadAiUsage } from "./AiUsage";
import { CHATGPT_USAGE_URL, ChatGptSignInButton, ManageUsageLink, useChatGptLoginWatch } from "./ChatGpt";
import { ErrorNotice } from "./ErrorNotice";
import { AlertIcon, CheckIcon, CloseIcon, ExternalIcon, RefreshIcon, SparkleIcon } from "./icons";
import { Spinner } from "./Spinner";

// What the editor's keys (Tab, ⌘↵, Esc in the text) and the app's AI
// shortcut ask of the open box.
export interface AiInlineControl {
  // Accepts the finished change; false when none waits.
  accept(): boolean;
  // Rejects any pending change and closes.
  close(): void;
  focus(): void;
  hasFocus(): boolean;
  // Whether a finished change waits to be accepted.
  canAccept(): boolean;
}

interface AiInlineEditProps {
  view: EditorView;
  // The connection whose schema the SQL is written against.
  conn: string | null;
  control: MutableRefObject<AiInlineControl | null>;
  onClose(): void;
  // Opens Settings on the AI page (a missing model, a CLI to set up).
  onOpenSettings(): void;
}

const ACCEPT_KEY = "Mod+Enter";

type Phase =
  | { kind: "idle" }
  // `since`: when the request went, for the seconds shown while waiting;
  // `writing`: the SQL has started to come.
  | { kind: "streaming"; progress: AiProgress | null; since: number; writing: boolean }
  | { kind: "done"; result: GeneratedSql }
  | { kind: "error"; error: unknown };

interface AiRequest {
  prompt: string;
  context: string;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

// Where the time went: reading the schema, the wait for the first text, all of it.
function timingText(timing: NonNullable<GeneratedSql["timing"]>): string {
  const parts = [`${t("스키마")} ${seconds(timing.schema_ms)}`];
  if (timing.first_ms !== null) {
    parts.push(`${t("첫 응답")} ${seconds(timing.first_ms)}`);
  }
  parts.push(`${t("전체")} ${seconds(timing.total_ms)}`);
  return parts.join(" · ");
}

// An Enter typed right after the IME committed the request is the same press.
const IME_ECHO_MS = 200;

// A request in words, in a box anchored in the SQL editor (⌘K in Cursor):
// the provider's SQL is written straight into the text over the selection,
// or on lines of its own, marked as a pending change until Tab or ⌘↵
// accepts it or Esc puts the text back. Nothing is run.
export function AiInlineEdit({ view, conn, control, onClose, onOpenSettings }: AiInlineEditProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const statusId = useId();
  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  // The handlers the editor's keys call read the latest phase from here.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const lastRequestRef = useRef<AiRequest | null>(null);
  // The selection the request will change ("" when there is none).
  const [selection, setSelection] = useState(() => {
    const range = view.state.selection.main;
    return view.state.sliceDoc(range.from, range.to);
  });
  // The SQL an earlier request wrote, put back when the next one fails or stops.
  const baselineRef = useRef<string | null>(null);
  const aiStatus = useSyncExternalStore(store.subscribeAi, store.getAiStatus);
  const onChatGpt = aiStatus?.provider === "chatgpt";
  const chatGptSignedIn = onChatGpt && aiStatus.chatgpt?.signed_in === true;
  // A model saved from a provider that is coming soon: said before a request fails on it.
  const soonPick = aiSoonPickText(aiStatus);
  // The connection in use, when ready: how much of its limits is used shows
  // beside the model (read as the box opens, again after each answer).
  const usageProvider = aiStatus !== null && aiProviderReady(aiStatus, aiStatus.provider) ? aiStatus.provider : null;
  useEffect(() => {
    if (usageProvider !== null) {
      loadAiUsage(usageProvider);
    }
  }, [usageProvider]);
  // A login started from the error below is followed while the box is open.
  useChatGptLoginWatch(aiStatus);

  // Korean (and any IME) input: Enter or ⌘↵ pressed while a syllable is
  // still being composed is done once the composition ends, with the text
  // as committed.
  const composingRef = useRef(false);
  const afterCompositionRef = useRef<"submit" | "accept" | null>(null);
  const imeActionAtRef = useRef(0);

  // Room in the text, above where the SQL goes; gone (the change settled)
  // when the box goes. Layout effects: they run before the editor's view
  // is destroyed or moved to another tab's text.
  useLayoutEffect(() => {
    // Placed and scrolled into sight by the editor (aiEditor.ts) once its height is known.
    view.dispatch({ effects: setAiZone.of({ ...aiTarget(view.state).zone, height: 0 }) });
    const root = rootRef.current;
    // An editor shorter than the box and a line of text grows while the box
    // is open (the results below give the room), so the box is never cut
    // off by the editor's bottom or under its scrollbar.
    const pane = view.dom.closest<HTMLElement>(".editor-pane");
    const observer = new ResizeObserver(() => {
      if (root === null || !root.isConnected) {
        return;
      }
      const height = Math.ceil(root.getBoundingClientRect().height) + 8;
      view.dispatch({ effects: setAiZoneHeight.of(height) });
      if (pane !== null) {
        const bar = pane.querySelector<HTMLElement>(".editor-bar")?.offsetHeight ?? 0;
        pane.style.minHeight = `max(90px, ${height + Math.ceil(view.defaultLineHeight) + bar + 16}px)`;
      }
    });
    if (root !== null) {
      observer.observe(root);
    }
    // The editor scrolls the box into sight; focusing must not scroll the
    // panes around it.
    inputRef.current?.focus({ preventScroll: true });
    // Again next frame: the palette that opened it hands focus back as it closes.
    const frame = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      if (pane !== null) {
        pane.style.minHeight = "";
      }
      abortRef.current?.abort();
      // Closed another way (another tab, AI turned off): a finished change
      // stays; one still coming is taken back.
      const pending = aiPendingOf(view.state);
      if (pending !== null) {
        if (pending.written && !pending.streaming) {
          acceptAiPending(view);
        } else {
          rejectAiPending(view);
        }
      }
      view.dispatch({ effects: setAiZone.of(null) });
    };
  }, [view]);

  // The waiting line counts seconds until the SQL starts to come.
  const [now, setNow] = useState(() => Date.now());
  const waiting = phase.kind === "streaming" && !phase.writing;
  useEffect(() => {
    if (!waiting) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [waiting]);

  function canAccept(): boolean {
    return phaseRef.current.kind !== "streaming" && aiPendingOf(view.state)?.written === true;
  }

  async function run(request: AiRequest): Promise<void> {
    lastRequestRef.current = request;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const current = aiPendingOf(view.state);
    baselineRef.current = current?.written ? aiPendingText(view.state, current) : null;
    const since = Date.now();
    setNow(since);
    const streaming: Phase = { kind: "streaming", progress: null, since, writing: false };
    phaseRef.current = streaming;
    setPhase(streaming);
    try {
      const result = await store.generateSql(
        conn,
        request.prompt,
        request.context.trim() === "" ? undefined : request.context,
        (progress) => {
          if (!controller.signal.aborted) {
            setPhase((phase) => (phase.kind === "streaming" ? { ...phase, progress } : phase));
          }
        },
        (sql) => {
          if (!controller.signal.aborted) {
            writeAiPending(view, sql, true);
            setPhase((phase) => (phase.kind === "streaming" && !phase.writing ? { ...phase, writing: true } : phase));
          }
        },
        controller.signal,
      );
      if (controller.signal.aborted) {
        return;
      }
      if (result.sql === "") {
        putBack();
      } else {
        writeAiPending(view, result.sql, false);
      }
      const done: Phase = { kind: "done", result };
      phaseRef.current = done;
      setPhase(done);
      // A follow-up replaces the request just made.
      inputRef.current?.select();
    } catch (error) {
      if (controller.signal.aborted) {
        return;
      }
      putBack();
      const failed: Phase = { kind: "error", error };
      phaseRef.current = failed;
      setPhase(failed);
      // The sign-in ended on the server's side: the shared status still says signed in.
      if (error instanceof ApiRequestError && error.code === "ai_signed_out") {
        store.fetchAi().catch(() => undefined);
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
    }
  }

  function putBack(): void {
    const baseline = baselineRef.current;
    if (baseline === null) {
      restoreAiOriginal(view);
    } else {
      writeAiPending(view, baseline, false);
    }
  }

  // ↩: a new request, or a follow-up that rewrites the pending SQL.
  function submit(text: string): void {
    const request = text.trim();
    if (request === "" || phaseRef.current.kind === "streaming") {
      return;
    }
    let pending = aiPendingOf(view.state);
    if (pending === null) {
      // Where the cursor or selection is now: the editor may have moved since the box opened.
      const target = aiTarget(view.state);
      const height = view.state.field(aiZoneField, false)?.height ?? 0;
      view.dispatch({ effects: setAiZone.of({ ...target.zone, height }) });
      startAiPending(view, target.pending);
      pending = target.pending;
      setSelection(pending.prefix === "" ? pending.original : "");
    }
    void run({ prompt: request, context: aiPendingText(view.state, pending) });
  }

  function retry(): void {
    const request = lastRequestRef.current;
    if (request !== null && phaseRef.current.kind !== "streaming") {
      void run(request);
    }
  }

  function stop(): void {
    abortRef.current?.abort();
    abortRef.current = null;
    if (aiPendingOf(view.state)?.streaming) {
      putBack();
    }
    const idle: Phase = { kind: "idle" };
    phaseRef.current = idle;
    setPhase(idle);
    inputRef.current?.focus({ preventScroll: true });
  }

  function accept(): boolean {
    if (!canAccept()) {
      return false;
    }
    abortRef.current?.abort();
    acceptAiPending(view);
    onClose();
    view.focus();
    return true;
  }

  function close(): void {
    abortRef.current?.abort();
    rejectAiPending(view);
    onClose();
    view.focus();
  }

  control.current = {
    accept,
    close,
    canAccept,
    focus: () => inputRef.current?.focus({ preventScroll: true }),
    hasFocus: () => rootRef.current?.contains(document.activeElement) === true,
  };
  useLayoutEffect(
    () => () => {
      control.current = null;
    },
    [control],
  );

  function perform(intent: "submit" | "accept"): void {
    const value = inputRef.current?.value ?? "";
    setPrompt(value);
    if (intent === "accept" && accept()) {
      return;
    }
    submit(value);
  }

  function afterComposition(intent: "submit" | "accept"): void {
    imeActionAtRef.current = performance.now();
    if (composingRef.current) {
      afterCompositionRef.current = intent;
    } else {
      // The composition already ended (the key came after it): its text is in.
      window.setTimeout(() => perform(intent), 0);
    }
  }

  function onBoxKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    const native = event.nativeEvent;
    const composing = native.isComposing || native.keyCode === 229;
    const enter = event.key === "Enter" || native.code === "Enter" || native.code === "NumpadEnter";
    if (event.key === "Escape" && !composing) {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    // ⌘↵ accepts (the app leaves it to the box: nothing runs from here), or
    // sends the request when nothing waits.
    if (enter && (IS_MAC ? native.metaKey : native.ctrlKey) && !native.altKey && !native.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      if (composing) {
        afterComposition("accept");
      } else {
        perform("accept");
      }
      return;
    }
    // Keys stay in the box: Tab past its last control comes back to the field.
    if (event.key === "Tab" && !native.metaKey && !native.ctrlKey && !native.altKey) {
      const focusable = Array.from(
        rootRef.current?.querySelectorAll<HTMLElement>("input, button:not(:disabled), [tabindex='0']") ?? [],
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  }

  function onInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    const native = event.nativeEvent;
    const composing = native.isComposing || native.keyCode === 229;
    const enter = event.key === "Enter" || native.code === "Enter" || native.code === "NumpadEnter";
    if (enter && !native.shiftKey && !native.metaKey && !native.ctrlKey && !native.altKey) {
      if (composing) {
        afterComposition("submit");
        return;
      }
      event.preventDefault();
      if (performance.now() - imeActionAtRef.current < IME_ECHO_MS) {
        return;
      }
      submit(event.currentTarget.value);
      return;
    }
    // Tab takes a finished change, as in the editor.
    if (event.key === "Tab" && !composing && !event.shiftKey && !native.metaKey && !native.ctrlKey && !native.altKey && accept()) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  const streaming = phase.kind === "streaming";
  const pending = aiPendingOf(view.state);
  const acceptable = !streaming && pending?.written === true;
  const errorCode = phase.kind === "error" && phase.error instanceof ApiRequestError ? phase.error.code : null;
  const needsChatGptSignIn =
    errorCode === "ai_signed_out" || (errorCode === "ai_not_configured" && onChatGpt && !chatGptSignedIn);
  const acceptHint = `Tab · ${formatBinding(ACCEPT_KEY)}`;
  const acceptShortcuts = `Tab ${ariaKeyshortcuts(ACCEPT_KEY)}`;

  // What the box says it is doing, seen and heard.
  let shown: string | null = null;
  let heard = "";
  if (phase.kind === "streaming") {
    const step = phase.progress?.status === "model" ? t("모델이 답을 준비하는 중…") : t("스키마 읽는 중…");
    shown = phase.writing
      ? t("SQL을 쓰는 중…")
      : phase.progress?.status === "model"
        ? `${step} ${Math.floor((now - phase.since) / 1000)}s`
        : step;
    heard = phase.writing ? t("SQL을 쓰는 중…") : step;
  } else if (phase.kind === "done") {
    heard =
      phase.result.sql === ""
        ? t("AI가 SQL을 쓰지 않았습니다")
        : `${t("SQL을 에디터에 썼습니다. {accept}로 수락하고 Esc로 거부합니다.", { accept: acceptHint })}${
            phase.result.read_only ? "" : ` ${t("데이터를 바꿀 수 있는 문장")}`
          }`;
    if (phase.result.sql === "") {
      shown = t("AI가 SQL을 쓰지 않았습니다");
    }
  }
  // The request field changed since the request that wrote the pending SQL.
  const edited = prompt.trim() !== "" && prompt.trim() !== lastRequestRef.current?.prompt;
  // The second row's left side: what the request changes, how it went.
  const info = [
    soonPick !== null && phase.kind === "idle" ? (
      <span key="soon" className="ai-inline-warning" title={soonPick}>
        <AlertIcon size={11} />
        {soonPick}
      </span>
    ) : null,
    selection.trim() !== "" && !acceptable ? (
      <span key="chip" className="ai-inline-chip" title={t("선택한 SQL을 고칩니다")}>
        {t("선택한 SQL을 고칩니다")}
      </span>
    ) : null,
    shown !== null ? (
      <span key="status" className="ai-inline-status" title={shown}>
        {streaming ? <Spinner size={10} /> : null}
        {shown}
      </span>
    ) : null,
    phase.kind === "done" && !phase.result.read_only && phase.result.sql !== "" ? (
      <span key="warning" className="ai-inline-warning">
        <AlertIcon size={11} />
        {t("데이터를 바꿀 수 있는 문장")}
      </span>
    ) : null,
    phase.kind === "done" && phase.result.timing ? (
      <span key="timing" className="ai-inline-timing" title={timingText(phase.result.timing)}>
        {timingText(phase.result.timing)}
      </span>
    ) : null,
    chatGptSignedIn ? (
      <span key="plan" className="ai-inline-plan">
        {t("ChatGPT 요금제 사용 중")}
        <ManageUsageLink />
      </span>
    ) : null,
  ].filter((item) => item !== null);

  return (
    <div
      ref={rootRef}
      className="ai-inline"
      role="dialog"
      aria-label={t("AI로 SQL 작성")}
      aria-describedby={statusId}
      onKeyDown={onBoxKeyDown}
    >
      <div className="ai-inline-row">
        <span className="ai-inline-mark" aria-hidden="true">
          <SparkleIcon size={13} />
        </span>
        <input
          ref={inputRef}
          className="ai-inline-input"
          type="text"
          value={prompt}
          placeholder={acceptable ? t("더 바꿀 점을 적으세요") : t("원하는 쿼리를 설명하세요")}
          aria-label={acceptable ? t("더 바꿀 점을 적으세요") : t("원하는 쿼리를 설명하세요")}
          aria-keyshortcuts="Enter"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setPrompt(event.target.value)}
          onFocus={() => {
            if (aiPendingOf(view.state) === null) {
              const range = view.state.selection.main;
              setSelection(view.state.sliceDoc(range.from, range.to));
            }
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            const intent = afterCompositionRef.current;
            afterCompositionRef.current = null;
            if (intent !== null) {
              setPrompt(event.currentTarget.value);
              imeActionAtRef.current = performance.now();
              window.setTimeout(() => perform(intent), 0);
            }
          }}
          onKeyDown={onInputKeyDown}
        />
        {usageProvider !== null ? <AiUsageChip provider={usageProvider} /> : null}
        <AiModelPicker status={aiStatus} where="bar" compact className="ai-model-chip" />
        {streaming ? (
          <button type="button" className="ai-inline-main" onClick={stop}>
            <Spinner size={10} />
            {t("멈추기")}
          </button>
        ) : acceptable && !edited ? null : (
          <button
            type="button"
            className={`ai-inline-main${acceptable ? "" : " primary"}`}
            disabled={prompt.trim() === ""}
            title={`${acceptable ? t("다시 작성") : t("작성")} (${formatBinding("Enter")})`}
            aria-keyshortcuts="Enter"
            onClick={() => submit(inputRef.current?.value ?? prompt)}
          >
            {acceptable ? t("다시 작성") : t("작성")}
          </button>
        )}
        <button
          type="button"
          className="icon-button"
          title={`${t("닫기")} (Esc)`}
          aria-label={pending?.written ? `${t("거부하고 닫기")} (Esc)` : `${t("닫기")} (Esc)`}
          aria-keyshortcuts="Escape"
          onClick={close}
        >
          <CloseIcon size={11} />
        </button>
      </div>
      {info.length > 0 || pending?.written ? (
        <div className="ai-inline-meta">
          <div className="ai-inline-info">{info}</div>
          {pending?.written ? (
            <div className="ai-inline-actions">
              <button
                type="button"
                className="icon-button"
                disabled={streaming || lastRequestRef.current === null}
                title={t("다시 생성")}
                aria-label={t("다시 생성")}
                onClick={retry}
              >
                <RefreshIcon size={11} />
              </button>
              <button type="button" aria-keyshortcuts="Escape" title={`${t("거부")} (Esc)`} onClick={close}>
                {t("거부")}
                <kbd>Esc</kbd>
              </button>
              <button
                type="button"
                className="primary"
                disabled={!acceptable}
                aria-keyshortcuts={acceptShortcuts}
                title={`${t("수락")} (${acceptHint}) · ${t("에디터에 넣기만 하고 실행하지 않습니다")}`}
                onClick={accept}
              >
                <CheckIcon size={10} />
                {t("수락")}
                <kbd>Tab</kbd>
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {phase.kind === "error" ? (
        <ErrorNotice
          error={phase.error}
          variant="compact"
          onRetry={retry}
          actions={
            // ChatGPT's usage limit is managed in ChatGPT; a sign-in that
            // ended or never happened starts again here. Off, no model yet, a
            // CLI missing or signed out, a provider coming soon: the AI page
            // fixes it.
            errorCode === "ai_usage_limit" ? (
              <>
                <button type="button" className="primary" onClick={() => window.open(CHATGPT_USAGE_URL, "_blank", "noopener")}>
                  Manage usage
                  <ExternalIcon size={10} />
                </button>
                <button type="button" onClick={onOpenSettings}>
                  {t("AI 설정 열기")}
                </button>
              </>
            ) : needsChatGptSignIn ? (
              <>
                {aiStatus?.chatgpt?.login === "pending" ? (
                  <span className="ai-inline-status">
                    <Spinner size={10} />
                    {t("브라우저에서 로그인을 끝내세요")}
                  </span>
                ) : (
                  <ChatGptSignInButton />
                )}
                <button type="button" onClick={onOpenSettings}>
                  {t("AI 설정 열기")}
                </button>
              </>
            ) : errorCode?.startsWith("ai_") || errorCode === "provider_unavailable" ? (
              <button type="button" onClick={onOpenSettings}>
                {t("AI 설정 열기")}
              </button>
            ) : undefined
          }
          onClose={() => setPhase({ kind: "idle" })}
        />
      ) : null}
      <div id={statusId} className="sr-only" aria-live="polite" aria-atomic="true">
        {heard}
      </div>
    </div>
  );
}
