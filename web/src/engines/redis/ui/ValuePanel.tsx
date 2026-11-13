// One Redis value shown and edited as RedisInsight's formatters do: Auto
// (picked from the bytes), Unicode, ASCII (\xNN), Binary, HEX, JSON,
// Markdown, Msgpack, Base64, Pickle, Protobuf, PHP and Java serialized,
// 32- and 64-bit vectors and timestamps, with a line that says what was
// found, its size and encoding. JSON and every decoded format open in
// Quick Look's explorer (tree, search, expand and collapse, copy path or
// value), values inside them that hold JSON, a pickle, PHP or Msgpack
// decoded too; text in CodeMirror with line numbers; bytes as an offset |
// hex | ASCII dump. Edit opens the value in CodeMirror as text, JSON
// (checked as you type, Format and Minify), Msgpack's JSON, hex or
// escaped ASCII; the decoded formats are read-only. A string key's view
// and the viewer a hash's or list's value opens in are both this.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ContextMenu, type ContextMenuItem } from "../../../components/ContextMenu";
import { JsonExplorer } from "../../../components/JsonExplorer";
import { CopyIcon, LayersIcon, LockIcon, MoreIcon, PencilIcon, WrapIcon } from "../../../components/icons";
import { Select } from "../../../components/Select";
import { notifyError } from "../../../components/ErrorNotice";
import { formatBytes } from "../../../format";
import { t } from "../../../i18n";
import { binBytes, binFromBytes, binFromHex, hexOf, type Bin } from "../bin";
import {
  asciiEscape,
  asciiUnescape,
  base64Bytes,
  bitsText,
  BOM,
  decodeDocument,
  detectFormat,
  jsonDocument,
  jsonError,
  looksLikeXml,
  minifyJson,
  msgpackDocument,
  msgpackEditable,
  msgpackFromJson,
  prettyJson,
  READ_ONLY_FORMATS,
  stripBom,
  timestampOf,
  utf8,
  FORMATS,
  type FormatChoice,
  type ValueFormat,
} from "../valueFormat";
import { CodeText, type CodeLang } from "./CodeText";
import { copyText, type RedisHost } from "./common";
import { Markdown } from "./Markdown";

// A value's one toolbar: actions, then (right) the row count and controls.
export function Bar({ children, count, end }: { children?: ReactNode; count?: ReactNode; end?: ReactNode }) {
  return (
    <div className="kv-value-bar surface-bars">
      {children}
      <span className="spacer" />
      {count}
      {end}
    </div>
  );
}

export function BarButton({ icon, label, title, onClick, disabled, primary, on }: { icon?: ReactNode; label: string; title?: string; onClick(): void; disabled?: boolean; primary?: boolean; on?: boolean }) {
  return (
    <button
      type="button"
      className={`kv-btn${primary === true ? " primary" : ""}${on === true ? " on" : ""}`}
      title={title ?? label}
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}

// An icon-only toolbar button; its label is the tooltip and the name.
export function IconButton({ icon, label, onClick, disabled, on, className }: { icon: ReactNode; label: string; onClick(): void; disabled?: boolean; on?: boolean; className?: string }) {
  return (
    <button
      type="button"
      className={`kv-icon kv-bar-icon${on === true ? " on" : ""}${className !== undefined ? ` ${className}` : ""}`}
      title={label}
      aria-label={label}
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

// A host action beside Copy (Download): an icon in the toolbar, an item in
// its ⋯ menu when the pane is narrow.
export interface BarAction {
  label: string;
  icon: ReactNode;
  onSelect(): void;
}

// RedisInsight's names; the ones in words are translated.
const FORMAT_LABEL: Record<ValueFormat, string> = {
  text: "Unicode",
  ascii: "ASCII",
  binary: "2진수",
  hex: "HEX",
  json: "JSON",
  markdown: "Markdown",
  msgpack: "Msgpack",
  base64: "Base64",
  pickle: "Pickle",
  protobuf: "Protobuf",
  php: "PHP 직렬화",
  java: "Java 직렬화",
  vector32: "벡터 32비트",
  vector64: "벡터 64비트",
  timestamp: "타임스탬프 → 날짜",
};

function formatLabel(format: ValueFormat): string {
  return t(FORMAT_LABEL[format]);
}

// The formats shown in the explorer.
const TREE_FORMATS: Record<string, true> = { json: true, msgpack: true, pickle: true, php: true, java: true, protobuf: true, vector32: true, vector64: true };

// The formats whose inner strings and bytes can be decoded too.
const NESTING: Record<string, true> = { msgpack: true, pickle: true, php: true };

// How an edit is typed: the stored text, JSON, Msgpack as JSON, hex pairs
// or escaped ASCII.
type EditForm = "text" | "json" | "msgpack" | "hex" | "ascii";

const EDIT_LABEL: Record<EditForm, string> = { text: "Unicode", json: "JSON", msgpack: "Msgpack (JSON)", hex: "HEX", ascii: "ASCII" };

interface Draft {
  form: EditForm;
  text: string;
  // The text as the edit started, and its colouring (fixed while typing).
  initial: string;
  lang: CodeLang;
  // Compact JSON is edited indented and saved compact again, unless Format
  // or Minify said how it should be stored.
  compact: boolean;
  compactAtStart: boolean;
}

// The hex dump's rows drawn before "show more": 64 KB.
const HEX_ROWS = 4096;

function HexDump({ bytes }: { bytes: Uint8Array }) {
  const [rows, setRows] = useState(HEX_ROWS);
  const total = Math.ceil(bytes.length / 16);
  const lines = [];
  for (let row = 0; row < Math.min(rows, total); row++) {
    const chunk = bytes.subarray(row * 16, row * 16 + 16);
    const hex = [];
    const ascii = [];
    for (let i = 0; i < 16; i++) {
      const byte = chunk[i];
      if (byte === undefined) {
        hex.push(<span key={i} className="kv-hex-byte">{"  "}</span>);
        continue;
      }
      hex.push(
        <span key={i} className={`kv-hex-byte${byte === 0 ? " zero" : byte >= 0x20 && byte < 0x7f ? "" : " ctl"}`}>
          {byte.toString(16).padStart(2, "0")}
        </span>,
      );
      ascii.push(byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : <span key={i} className="kv-hex-dot">·</span>);
    }
    lines.push(
      <div key={row} className="kv-hex-row">
        <span className="kv-hex-off">{(row * 16).toString(16).padStart(8, "0")}</span>
        <span className="kv-hex-bytes">{hex}</span>
        <span className="kv-hex-ascii">{ascii}</span>
      </div>,
    );
  }
  return (
    <div className="kv-hex mono" role="table" aria-label="Hex">
      {lines}
      {total > rows ? (
        <button type="button" className="kv-link kv-hex-more" onClick={() => setRows(rows + HEX_ROWS)}>
          {t("{count}줄 더 보기", { count: Math.min(HEX_ROWS, total - rows).toLocaleString() })}
        </button>
      ) : null}
      {bytes.length === 0 ? <span className="panel-dim">{t("(빈 값)")}</span> : null}
    </div>
  );
}

// What a format shows: the explorer, code, or a dump; and the text Copy takes.
interface Shown {
  node: ReactNode;
  copy: string;
  // The format didn't fit the bytes (forced by hand): said in the info line.
  problem: string | null;
  // Base64's decoded bytes and what they read as.
  inner: { format: ValueFormat; size: number } | null;
  // A vector's length.
  count: number | null;
}

function codeLang(text: string): CodeLang {
  return jsonDocument(text) !== null ? "json" : looksLikeXml(text) ? "xml" : "plain";
}

function lossyText(bytes: Uint8Array): string {
  return new TextDecoder("utf-8").decode(bytes);
}

function TimestampView({ text }: { text: string }) {
  const found = timestampOf(text);
  if (found === null) {
    return null;
  }
  const unit = { s: t("초"), ms: t("밀리초"), "µs": t("마이크로초"), ns: t("나노초") }[found.unit];
  return (
    <dl className="kv-when">
      <dt>{t("값")}</dt>
      <dd className="mono">{text.trim()}</dd>
      <dt>{t("단위")}</dt>
      <dd>{t("{unit} (크기로 추정)", { unit })}</dd>
      <dt>{t("현지 시간")}</dt>
      <dd className="mono">{found.local}</dd>
      <dt>UTC</dt>
      <dd className="mono">{found.utc}</dd>
    </dl>
  );
}

// Where an explorer draws its controls (the toolbar) and tells its node count.
interface ExplorerHost {
  target: HTMLElement | null;
  onStats(nodes: number): void;
}

function show(bytes: Uint8Array, format: ValueFormat, wrap: boolean, nest: boolean, label: string, host: ExplorerHost, nested = false): Shown {
  const text = utf8(bytes);
  const code = (value: string, lang: CodeLang) => <CodeText value={value} lang={lang} wrap={wrap} label={label} />;
  const plain = (problem: string | null): Shown => {
    const body = text ?? lossyText(bytes);
    return { node: code(body, "plain"), copy: body, problem, inner: null, count: null };
  };
  const shown = (node: ReactNode, copy: string): Shown => ({ node, copy, problem: null, inner: null, count: null });
  switch (format) {
    case "json": {
      const doc = text === null ? null : jsonDocument(text);
      if (doc === null || text === null) {
        return plain(t("JSON 객체나 배열이 아닙니다"));
      }
      return shown(<JsonExplorer doc={doc} stored={stripBom(text).trim()} title="JSON" label={label} embedded controlsTarget={host.target} onStats={host.onStats} />, text);
    }
    case "msgpack":
    case "pickle":
    case "php":
    case "java":
    case "protobuf":
    case "vector32":
    case "vector64": {
      const found = decodeDocument(bytes, format, nest);
      if (found === null) {
        return { node: <HexDump bytes={bytes} />, copy: hexOf(binFromBytes(bytes)), problem: t("{format} 형식이 아닙니다", { format: formatLabel(format) }), inner: null, count: null };
      }
      const json = JSON.stringify(found.value, null, 2);
      const count = Array.isArray(found.value) && format.startsWith("vector") ? found.value.length : null;
      if (found.value === null || typeof found.value !== "object") {
        return { ...shown(code(json, "json"), json), count };
      }
      return { ...shown(<JsonExplorer doc={found.value} stored={null} title={formatLabel(format)} label={label} embedded controlsTarget={host.target} onStats={host.onStats} />, json), count };
    }
    case "hex":
      return shown(<HexDump bytes={bytes} />, hexOf(binFromBytes(bytes)));
    case "ascii": {
      const escaped = asciiEscape(bytes);
      return shown(code(escaped, "plain"), escaped);
    }
    case "binary": {
      const bits = bitsText(bytes);
      return shown(code(bits, "plain"), bits);
    }
    case "markdown": {
      const body = text ?? lossyText(bytes);
      return shown(<Markdown text={body} />, body);
    }
    case "timestamp":
      return text !== null && timestampOf(text) !== null ? shown(<TimestampView text={text} />, text.trim()) : plain(t("Unix 타임스탬프 숫자가 아닙니다"));
    case "base64": {
      const decoded = text === null || nested ? null : base64Bytes(text);
      if (decoded === null) {
        return plain(t("Base64가 아닙니다"));
      }
      const innerFormat = detectFormat(decoded, true);
      const inner = show(decoded, innerFormat, wrap, nest, label, host, true);
      return { ...inner, inner: { format: innerFormat, size: decoded.length } };
    }
    default: {
      const body = text ?? lossyText(bytes);
      return { node: code(body, codeLang(body)), copy: body, problem: text === null ? t("UTF-8이 아닌 바이트는 �로 보입니다") : null, inner: null, count: null };
    }
  }
}

function draftFor(bytes: Uint8Array, format: ValueFormat): Draft {
  const text = utf8(bytes);
  const draft = (form: EditForm, body: string, lang: CodeLang, compact = false): Draft => ({ form, text: body, initial: body, lang, compact, compactAtStart: compact });
  if (format === "json" && text !== null && jsonDocument(text) !== null) {
    const body = stripBom(text);
    const compact = !body.trim().includes("\n");
    return draft("json", compact ? prettyJson(body) : body, "json", compact);
  }
  if (format === "msgpack" && msgpackEditable(bytes)) {
    return draft("msgpack", JSON.stringify(msgpackDocument(bytes), null, 2), "json");
  }
  if (format === "hex" || format === "msgpack" || (text === null && format !== "ascii")) {
    return draft("hex", hexOf(binFromBytes(bytes)), "plain");
  }
  if (format === "ascii") {
    return draft("ascii", asciiEscape(bytes), "plain");
  }
  return draft("text", text ?? "", codeLang(text ?? ""));
}

export interface ValuePanelProps {
  host: RedisHost;
  // null while it loads.
  value: Bin | null;
  label: string;
  // Edit is offered (the value is whole and the connection writable).
  editable: boolean;
  // Saves the new value; true when it was saved (the editor closes).
  onSave(value: Bin): Promise<boolean>;
  // The format picked resets when this changes (another key).
  identity: string;
  // Opens in edit mode (a long row value's pencil).
  startEditing?: boolean;
  // Extra notes after the info, and actions after Copy.
  notes?: ReactNode;
  actions?: BarAction[];
  // The body's own wrapper (loading, errors) around what is shown.
  frame?(content: ReactNode): ReactNode;
  // Leaving edit mode by Cancel or Esc (the viewer closes when it opened for it).
  onCancelEdit?(): void;
}

export function ValuePanel({ host, value, label, editable, onSave, identity, startEditing = false, notes, actions = [], frame, onCancelEdit }: ValuePanelProps) {
  const [choice, setChoice] = useState<FormatChoice>("auto");
  const [wrap, setWrap] = useState(true);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  // Values inside a decoded value that hold JSON, a pickle, PHP or Msgpack.
  const [nest, setNest] = useState(true);
  // The toolbar's slot an explorer draws its controls into, and its node count.
  const [slot, setSlot] = useState<HTMLSpanElement | null>(null);
  const [nodes, setNodes] = useState<number | null>(null);
  const [more, setMore] = useState<{ x: number; y: number; anchor: Element } | null>(null);
  const bytes = useMemo(() => (value === null ? null : binBytes(value)), [value]);
  const detected = useMemo(() => (bytes === null ? null : detectFormat(bytes)), [bytes]);
  const mode: ValueFormat = choice === "auto" ? (detected ?? "text") : choice;

  useEffect(() => {
    setChoice("auto");
    setDraft(null);
  }, [identity]);

  const readOnly = Object.hasOwn(READ_ONLY_FORMATS, mode);

  useEffect(() => {
    if (startEditing && bytes !== null && editable && !readOnly) {
      setDraft(draftFor(bytes, mode));
    }
    // Only when the value first arrives for a viewer opened to edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startEditing, bytes === null]);

  const shown = useMemo(() => (bytes === null ? null : show(bytes, mode, wrap, nest, label, { target: slot, onStats: setNodes })), [bytes, mode, wrap, nest, label, slot]);
  const hadBom = bytes !== null && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  const problem = draft?.form === "json" || draft?.form === "msgpack" ? jsonError(draft.text) : null;
  const badBytes =
    draft === null ? false : draft.form === "hex" ? binFromHex(draft.text) === null : draft.form === "ascii" ? asciiUnescape(draft.text) === null : false;

  const cancel = () => {
    setDraft(null);
    onCancelEdit?.();
  };

  const submit = async () => {
    if (draft === null || saving || problem !== null || badBytes) {
      return;
    }
    let next: Bin | null;
    if (draft.form === "hex") {
      next = binFromHex(draft.text);
    } else if (draft.form === "ascii") {
      const raw = asciiUnescape(draft.text);
      next = raw === null ? null : binFromBytes(raw);
    } else if (draft.form === "json") {
      next = (hadBom ? BOM : "") + (draft.compact ? minifyJson(draft.text) : draft.text);
    } else if (draft.form === "msgpack") {
      const packed = msgpackFromJson(draft.text);
      if (packed === null) {
        notifyError(t("Msgpack으로 저장할 수 없는 JSON입니다"));
        return;
      }
      next = binFromBytes(packed);
    } else {
      next = draft.text;
    }
    if (next === null) {
      notifyError(draft.form === "hex" ? t("16진수 바이트가 아닙니다 (예: 0a ff 3c)") : t("\\xNN 이스케이프가 올바르지 않습니다"));
      return;
    }
    setSaving(true);
    try {
      if (await onSave(next)) {
        setDraft(null);
      }
    } finally {
      setSaving(false);
    }
  };

  const size = bytes === null ? null : (formatBytes(bytes.length) ?? `${bytes.length} B`);
  const encoding = bytes === null ? null : utf8(bytes) === null ? t("바이너리") : hadBom ? "UTF-8 BOM" : "UTF-8";
  const innerMode = mode === "base64" ? (shown?.inner?.format ?? null) : mode;
  const codeMode = innerMode === "text" || innerMode === "ascii" || innerMode === "binary";

  const editingBar = draft !== null;
  const unchanged = draft !== null && draft.text === draft.initial && draft.compact === draft.compactAtStart;
  const nests = innerMode !== null && Object.hasOwn(NESTING, innerMode);
  const explorer = shown !== null && nodes !== null && innerMode !== null && Object.hasOwn(TREE_FORMATS, innerMode);
  const readOnlyNote = t("이 형식은 읽기 전용입니다. Unicode, JSON 또는 HEX로 바꿔 편집하세요");
  const infoTitle = [
    `${formatLabel(mode)}${shown?.inner != null ? ` → ${formatLabel(shown.inner.format)}` : ""}`,
    `${size ?? ""} · ${encoding ?? ""}`,
    explorer ? t("노드 {count}개", { count: (nodes ?? 0).toLocaleString() }) : null,
    readOnly ? readOnlyNote : null,
  ]
    .filter((line) => line !== null)
    .join("\n");
  // What folds into ⋯ when the pane is narrow.
  const foldItems = (): ContextMenuItem[] => [
    ...(nests ? [{ label: t("안쪽 값 풀기"), checked: nest, onSelect: () => setNest(!nest) }] : []),
    ...(codeMode ? [{ label: t("줄바꿈"), checked: wrap, onSelect: () => setWrap(!wrap) }] : []),
    ...actions.map((action) => ({ label: action.label, onSelect: action.onSelect })),
  ];
  const foldable = nests || codeMode || actions.length > 0;

  return (
    <div className="kv-value kv-vp">
      {editingBar ? (
        <div className="kv-value-bar kv-vbar surface-bars">
          <span className="kv-info">
            <span className="kv-info-format">{t("편집: {form}", { form: EDIT_LABEL[draft.form] })}</span>
          </span>
          {problem !== null ? (
            <span className="kv-bar-note kv-warn" title={problem.message}>
              {t("JSON 오류: {message}", { message: problem.message })}
            </span>
          ) : null}
          {badBytes ? <span className="kv-bar-note kv-warn">{draft.form === "hex" ? t("16진수 바이트가 아닙니다 (예: 0a ff 3c)") : t("\\xNN 이스케이프가 올바르지 않습니다")}</span> : null}
          <span className="spacer" />
          {draft.form === "json" || draft.form === "msgpack" ? (
            <>
              <BarButton label={t("정리")} title={t("들여쓰기 (Format)")} disabled={problem !== null} onClick={() => setDraft({ ...draft, text: prettyJson(draft.text), compact: false })} />
              <BarButton label={t("한 줄로")} title={t("공백 없애기 (Minify)")} disabled={problem !== null} onClick={() => setDraft({ ...draft, text: minifyJson(draft.text), compact: false })} />
            </>
          ) : null}
          <IconButton icon={<WrapIcon size={11} />} label={t("긴 줄 접어 보기")} on={wrap} onClick={() => setWrap(!wrap)} />
          <BarButton label={t("취소")} title={t("취소 (Esc)")} onClick={cancel} />
          <BarButton label={saving ? t("저장 중…") : t("저장")} title={t("저장 (⌘S)")} primary disabled={saving || problem !== null || badBytes || unchanged} onClick={() => void submit()} />
        </div>
      ) : (
        <div className="kv-value-bar kv-vbar surface-bars">
          <Select className="kv-format" aria-label={t("값 형식")} value={choice} onChange={(event) => setChoice(event.target.value as FormatChoice)}>
            <option value="auto">{detected !== null ? t("자동 · {format}", { format: formatLabel(detected) }) : t("자동")}</option>
            {FORMATS.map((format) => (
              <option key={format} value={format}>
                {formatLabel(format)}
              </option>
            ))}
          </Select>
          {bytes !== null ? (
            <span className="kv-info" title={infoTitle}>
              {shown?.inner != null ? <span className="kv-info-inner">→ {formatLabel(shown.inner.format)}</span> : null}
              {shown?.count != null ? <span>{t("값 {count}개", { count: shown.count.toLocaleString() })}</span> : null}
              <span>{size}</span>
              {readOnly && editable ? <LockIcon size={9} className="kv-info-lock" /> : null}
            </span>
          ) : null}
          {notes}
          {shown?.problem != null ? (
            <span className="kv-bar-note kv-warn" title={shown.problem}>
              {shown.problem}
            </span>
          ) : null}
          <span className="kv-bar-slot" ref={setSlot} />
          <span className="spacer" />
          {nests ? <IconButton className="kv-fold" icon={<LayersIcon size={11} />} label={t("안쪽 값 풀기: 값 안의 JSON·Pickle·PHP·Msgpack도 풀어 보기")} on={nest} onClick={() => setNest(!nest)} /> : null}
          {codeMode ? <IconButton className="kv-fold" icon={<WrapIcon size={11} />} label={t("긴 줄 접어 보기")} on={wrap} onClick={() => setWrap(!wrap)} /> : null}
          <IconButton icon={<CopyIcon size={11} />} label={t("값 복사")} disabled={shown === null} onClick={() => void copyText(host, shown?.copy ?? "")} />
          {actions.map((action) => (
            <IconButton key={action.label} className="kv-fold" icon={action.icon} label={action.label} onClick={action.onSelect} />
          ))}
          {editable ? (
            <button
              type="button"
              className="kv-btn kv-edit-btn"
              title={readOnly ? readOnlyNote : t("편집 [버튼]")}
              aria-label={t("편집 [버튼]")}
              // A disabled button shows no tooltip in some browsers: it stays
              // focusable and says why instead.
              aria-disabled={bytes === null || readOnly}
              onClick={() => {
                if (bytes !== null && !readOnly) {
                  setDraft(draftFor(bytes, mode));
                }
              }}
            >
              <PencilIcon size={10} />
              <span className="kv-btn-label">{t("편집 [버튼]")}</span>
            </button>
          ) : null}
          {foldable ? (
            <button
              type="button"
              className="kv-icon kv-bar-icon kv-more"
              title={t("더 보기")}
              aria-label={t("더 보기")}
              aria-haspopup="menu"
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setMore(more !== null ? null : { x: rect.right - 200, y: rect.bottom + 4, anchor: event.currentTarget });
              }}
            >
              <MoreIcon size={12} />
            </button>
          ) : null}
          {more !== null ? <ContextMenu x={more.x} y={more.y} anchor={more.anchor} items={foldItems()} onClose={() => setMore(null)} /> : null}
        </div>
      )}
      {(frame ?? ((content: ReactNode) => <div className="kv-value-body">{content}</div>))(
        draft !== null ? (
          <CodeText
            value={draft.text}
            lang={draft.lang}
            wrap={wrap}
            editable
            autoFocus
            label={label}
            errorAt={problem?.at ?? null}
            onChange={(text) => setDraft((prev) => (prev === null ? prev : { ...prev, text }))}
            onSave={() => void submit()}
            onCancel={cancel}
          />
        ) : (
          (shown?.node ?? null)
        ),
      )}
    </div>
  );
}
