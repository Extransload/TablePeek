// The key-value workbench's dialogs: a stream entry, and a new key of any
// type. Each byte-valued box reads as text, or as hex for bytes that
// aren't UTF-8; a failed save keeps the dialog open with the error under it.

import { useState, type ReactNode } from "react";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { Gauge } from "../../../components/Gauge";
import { MinusIcon, PlusIcon } from "../../../components/icons";
import { t } from "../../../i18n";
import { AdminModal } from "../../mongodb/ui/AdminModal";
import { edit, type CreateKind } from "../api";
import { binFromHex, binText, hexOf, isText, type Bin } from "../bin";
import { parseDuration, type RedisHost } from "./common";

// A byte value being typed: its text and whether that text is hex.
interface BinDraft {
  text: string;
  hex: boolean;
}

// The draft as bytes to send; null while hex mode holds something else.
function binOfDraft(draft: BinDraft): Bin | null {
  return draft.hex ? binFromHex(draft.text) : draft.text;
}

// A box for bytes with a Text / Hex switch; switching converts what is there.
function BinInput({ label, draft, onChange, multiline = false, autoFocus = false, placeholder }: { label: string; draft: BinDraft; onChange(next: BinDraft): void; multiline?: boolean; autoFocus?: boolean; placeholder?: string }) {
  const bad = draft.hex && binFromHex(draft.text) === null;
  const flip = (hex: boolean) => {
    if (hex === draft.hex) {
      return;
    }
    const bytes = binOfDraft(draft);
    onChange(bytes === null ? { text: draft.text, hex } : hex ? { text: hexOf(bytes), hex } : { text: isText(bytes) ? bytes : binText(bytes), hex });
  };
  return (
    <div className="mg-form-row">
      <div className="kv-input-head">
        <span className="mg-form-label">{label}</span>
        <span className="spacer" />
        <div className="kv-mini-seg" role="radiogroup" aria-label={t("값 형식")}>
          <button type="button" role="radio" aria-checked={!draft.hex} className={!draft.hex ? "active" : undefined} onClick={() => flip(false)}>
            {t("텍스트")}
          </button>
          <button type="button" role="radio" aria-checked={draft.hex} className={draft.hex ? "active" : undefined} onClick={() => flip(true)}>
            Hex
          </button>
        </div>
      </div>
      {multiline ? (
        <textarea className={`kv-textarea mono${bad ? " invalid" : ""}`} spellCheck={false} autoFocus={autoFocus} placeholder={placeholder} value={draft.text} onChange={(event) => onChange({ ...draft, text: event.target.value })} />
      ) : (
        <input type="text" className={`mg-input mono${bad ? " invalid" : ""}`} spellCheck={false} autoFocus={autoFocus} placeholder={placeholder} value={draft.text} onChange={(event) => onChange({ ...draft, text: event.target.value })} />
      )}
      {bad ? <span className="kv-field-error">{t("16진수 바이트가 아닙니다 (예: 0a ff 3c)")}</span> : null}
    </div>
  );
}

// A dialog frame with Cancel and a primary button that saves; `save`
// returns nothing when done (the dialog closes) or throws.
function SaveModal({ title, path, okLabel, ready, save, onClose, children }: { title: string; path?: string; okLabel: string; ready: boolean; save(): Promise<void>; onClose(): void; children: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const submit = async () => {
    if (busy || !ready) {
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await save();
      onClose();
    } catch (error) {
      setFailure(error);
      setBusy(false);
    }
  };
  return (
    <AdminModal
      title={title}
      path={path}
      className="kv-modal"
      busy={busy}
      onClose={onClose}
      foot={
        <>
          <span className="spacer" />
          <button type="button" onClick={onClose} disabled={busy}>
            {t("취소")}
          </button>
          <button type="button" className="primary gauge-host" disabled={busy || !ready} aria-busy={busy} onClick={() => void submit()}>
            <Gauge busy={busy} outcome={failure !== null ? "error" : "ok"} />
            {okLabel}
          </button>
        </>
      }
    >
      <div
        className="kv-form"
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void submit();
          }
        }}
      >
        {children}
        {failure !== null ? <ErrorNotice error={failure} context="data" engine="redis" variant="compact" /> : null}
      </div>
    </AdminModal>
  );
}

// Field/value pairs of a stream entry, rows added and removed.
function PairsInput({ pairs, onChange }: { pairs: [BinDraft, BinDraft][]; onChange(next: [BinDraft, BinDraft][]): void }) {
  return (
    <div className="kv-pairs">
      {pairs.map(([field, value], i) => (
        <div className="kv-pair" key={i}>
          <BinInput label={t("필드")} draft={field} autoFocus={i === 0} onChange={(next) => onChange(pairs.map((pair, j) => (j === i ? [next, pair[1]] : pair)))} />
          <BinInput label={t("값")} draft={value} onChange={(next) => onChange(pairs.map((pair, j) => (j === i ? [pair[0], next] : pair)))} />
          <button type="button" className="icon-button kv-pair-remove" title={t("이 필드 빼기")} disabled={pairs.length === 1} onClick={() => onChange(pairs.filter((_, j) => j !== i))}>
            <MinusIcon size={11} />
          </button>
        </div>
      ))}
      <button type="button" className="kv-add-pair" onClick={() => onChange([...pairs, [{ text: "", hex: false }, { text: "", hex: false }]])}>
        <PlusIcon size={10} /> {t("필드 추가")}
      </button>
    </div>
  );
}

function pairsOf(pairs: [BinDraft, BinDraft][]): [Bin, Bin][] | null {
  const out: [Bin, Bin][] = [];
  for (const [field, value] of pairs) {
    const f = binOfDraft(field);
    const v = binOfDraft(value);
    if (f === null || v === null) {
      return null;
    }
    out.push([f, v]);
  }
  return out;
}

const EMPTY_PAIR: [BinDraft, BinDraft] = [
  { text: "", hex: false },
  { text: "", hex: false },
];

export function StreamAddModal({ path, onSave, onClose }: { path: string; onSave(id: string, fields: [Bin, Bin][]): Promise<void>; onClose(): void }) {
  const [id, setId] = useState("*");
  const [pairs, setPairs] = useState<[BinDraft, BinDraft][]>([EMPTY_PAIR]);
  const fields = pairsOf(pairs);
  const ready = fields !== null && id.trim() !== "" && fields.every(([field]) => binText(field) !== "");
  return (
    <SaveModal title={t("스트림 항목 추가 (XADD)")} path={path} okLabel={t("추가")} ready={ready} onClose={onClose} save={() => onSave(id.trim(), fields ?? [])}>
      <label className="mg-form-row">
        <span className="mg-form-label">{t("ID (* 이면 서버가 정합니다)")}</span>
        <input type="text" className="mg-input mono" spellCheck={false} value={id} onChange={(event) => setId(event.target.value)} />
      </label>
      <PairsInput pairs={pairs} onChange={setPairs} />
    </SaveModal>
  );
}

const CREATE_KINDS: { id: CreateKind; label: string }[] = [
  { id: "string", label: "string" },
  { id: "hash", label: "hash" },
  { id: "list", label: "list" },
  { id: "set", label: "set" },
  { id: "zset", label: "zset" },
  { id: "stream", label: "stream" },
  { id: "json", label: "JSON (RedisJSON)" },
];

// A new key: its name, type, a first value (Redis keeps no empty
// collections) and an optional expiry.
export function CreateKeyModal({ host, db, prefix, onCreated, onClose }: { host: RedisHost; db: number; prefix: string; onCreated(key: Bin, type: string): void; onClose(): void }) {
  const [name, setName] = useState<BinDraft>({ text: prefix, hex: false });
  const [kind, setKind] = useState<CreateKind>("string");
  const [value, setValue] = useState<BinDraft>({ text: "", hex: false });
  const [field, setField] = useState<BinDraft>({ text: "", hex: false });
  const [score, setScore] = useState("0");
  const [pairs, setPairs] = useState<[BinDraft, BinDraft][]>([EMPTY_PAIR]);
  const [text, setText] = useState("{}");
  const [ttl, setTtl] = useState("");
  const key = binOfDraft(name);
  const ttlSecs = ttl.trim() === "" ? null : parseDuration(ttl);
  const problem = (() => {
    if (key === null || binText(key) === "") {
      return t("키 이름을 입력하세요");
    }
    if (ttl.trim() !== "" && ttlSecs === null) {
      return t("만료 시간이 올바르지 않습니다");
    }
    if (kind === "json") {
      try {
        JSON.parse(text);
      } catch {
        return t("JSON 형식이 올바르지 않습니다");
      }
    }
    if (kind === "zset" && !/^\s*[+-]?(\d+(\.\d*)?|\.\d+|inf)([eE][+-]?\d+)?\s*$/i.test(score)) {
      return t("점수는 숫자여야 합니다");
    }
    if (kind === "hash" && (binOfDraft(field) === null || field.text === "")) {
      return t("첫 필드 이름을 입력하세요");
    }
    if (kind === "stream" && (pairsOf(pairs) === null || pairs.some(([f]) => f.text === ""))) {
      return t("항목에는 필드가 하나 이상 있어야 합니다");
    }
    if (kind !== "json" && kind !== "stream" && binOfDraft(value) === null) {
      return t("16진수 바이트가 아닙니다 (예: 0a ff 3c)");
    }
    return null;
  })();

  const save = async () => {
    if (key === null || problem !== null) {
      return;
    }
    const first = binOfDraft(value) ?? "";
    await edit(host.conn, db, key, {
      op: "create",
      kind,
      ...(kind === "json" ? { text } : kind === "stream" ? { fields: pairsOf(pairs) ?? [] } : { value: first }),
      ...(kind === "hash" ? { field: binOfDraft(field) ?? "" } : {}),
      ...(kind === "zset" ? { score: score.trim() } : {}),
      ...(ttlSecs !== null ? { ttl_secs: Math.ceil(ttlSecs) } : {}),
    });
    const type = kind === "json" ? "ReJSON-RL" : kind;
    host.notify(t("키를 만들었습니다"));
    host.onKeyChange({ kind: "created", db, key, type });
    onCreated(key, type);
  };

  const valueLabel = kind === "list" ? t("첫 항목") : kind === "set" || kind === "zset" ? t("첫 멤버") : t("값");
  return (
    <SaveModal title={t("키 만들기")} path={`db${db}`} okLabel={t("만들기")} ready={problem === null} onClose={onClose} save={save}>
      <BinInput label={t("키 이름")} draft={name} autoFocus placeholder="user:42:profile" onChange={setName} />
      <div className="mg-subtabs mg-seg kv-kind-seg" role="radiogroup" aria-label={t("타입")}>
        {CREATE_KINDS.map((option) => (
          <button key={option.id} type="button" role="radio" aria-checked={kind === option.id} className={kind === option.id ? "active" : undefined} onClick={() => setKind(option.id)}>
            {option.label}
          </button>
        ))}
      </div>
      {kind === "hash" ? <BinInput label={t("첫 필드")} draft={field} onChange={setField} /> : null}
      {kind === "json" ? (
        <label className="mg-form-row">
          <span className="mg-form-label">{t("문서 (JSON)")}</span>
          <textarea className="kv-textarea mono" spellCheck={false} value={text} onChange={(event) => setText(event.target.value)} />
        </label>
      ) : kind === "stream" ? (
        <PairsInput pairs={pairs} onChange={setPairs} />
      ) : (
        <BinInput label={valueLabel} draft={value} multiline={kind === "string"} onChange={setValue} />
      )}
      {kind === "zset" ? (
        <label className="mg-form-row">
          <span className="mg-form-label">{t("점수 (score)")}</span>
          <input type="text" inputMode="decimal" className="mg-input mono" value={score} onChange={(event) => setScore(event.target.value)} />
        </label>
      ) : null}
      <label className="mg-form-row">
        <span className="mg-form-label">{t("만료 (선택): 초, 또는 30m·2h·7d")}</span>
        <input type="text" className="mg-input mono" placeholder={t("비우면 만료 없음")} value={ttl} onChange={(event) => setTtl(event.target.value)} />
      </label>
      {problem !== null && name.text !== prefix ? <span className="kv-field-error">{problem}</span> : null}
    </SaveModal>
  );
}
