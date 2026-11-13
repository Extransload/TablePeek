// What the key-value workbench's parts share: the host they report
// through, the safe-mode rule for a change, the key actions the key list
// and the key details both offer (rename, expiry, export, delete), the
// confirm popover for deletes and the small labels (type badge, time left,
// size).

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { writeClipboard } from "../../../clipboard";
import { confirmDialog } from "../../../components/ConfirmDialog";
import { notifyError } from "../../../components/ErrorNotice";
import { downloadBlob, safeFileName } from "../../../export";
import { formatBytes } from "../../../format";
import { t } from "../../../i18n";
import type { SafeMode } from "../../../sqlTools";
import { needsConfirm } from "../../elasticsearch/ui/common";
import { edit, exportKey, KvError, type EditOp } from "../api";
import { binText, consoleArg, type Bin } from "../bin";

// A change to a key the rest of the workbench follows: the key list, the
// key shown.
export type KeyChange =
  | { kind: "created"; db: number; key: Bin; type: string }
  | { kind: "deleted"; db: number; key: Bin }
  | { kind: "renamed"; db: number; key: Bin; to: Bin }
  | { kind: "changed"; db: number; key: Bin };

export interface RedisHost {
  conn: string;
  // A short success message (toast).
  notify(message: string): void;
  safeMode: SafeMode;
  // A read-only replica (`edit_by_key` false): no writes at all.
  readOnly: boolean;
  onKeyChange(change: KeyChange): void;
}

// Asks before a change when safe mode wants it (level 2 before every
// write); `danger` asks always.
export async function askWrite(host: RedisHost, request: { title: string; message: string; command: string; okLabel: string; danger?: boolean }): Promise<boolean> {
  if (request.danger !== true && !needsConfirm("write", host.safeMode)) {
    return true;
  }
  return confirmDialog({
    title: request.title,
    message: `${request.message}\n\n${request.command}`,
    confirmLabel: request.okLabel,
    danger: request.danger === true,
  });
}

// A change sent with the safe-mode question first; null when declined or
// failed (the failure shown as a toast).
export async function runEdit(host: RedisHost, db: number, key: Bin, op: EditOp, ask: { title: string; message: string; command: string; okLabel: string; danger?: boolean } | null): Promise<{ changed: number; id?: string } | null> {
  if (ask !== null && !(await askWrite(host, ask))) {
    return null;
  }
  try {
    return await edit(host.conn, db, key, op);
  } catch (error) {
    notifyError(error, { context: "data" });
    return null;
  }
}

// Time left before a key expires, shortest form: "45s", "3m 20s", "2h 5m",
// "4d 3h"; "No limit" without an expiry.
export function ttlText(ms: number): string {
  if (ms < 0) {
    return t("제한 없음");
  }
  const s = Math.ceil(ms / 1000);
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m ${s % 60}s`;
  }
  const h = Math.floor(m / 60);
  if (h < 24) {
    return `${h}h ${m % 60}m`;
  }
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function sizeText(bytes: number | null): string {
  return bytes === null ? "—" : (formatBytes(bytes) ?? `${bytes} B`);
}

const TYPE_LABEL: Record<string, string> = {
  string: "STRING",
  hash: "HASH",
  list: "LIST",
  set: "SET",
  zset: "ZSET",
  stream: "STREAM",
  "ReJSON-RL": "JSON",
  json: "JSON",
};

export function TypeBadge({ type }: { type: string }) {
  const known = Object.hasOwn(TYPE_LABEL, type);
  const cls = known ? (type === "ReJSON-RL" ? "json" : type) : "other";
  return (
    <span className={`kv-type kv-type-${cls}`} title={type}>
      {known ? TYPE_LABEL[type] : type.replace(/-TYPE$/, "").slice(0, 6).toUpperCase()}
    </span>
  );
}

// Seconds from what the user typed: "90", "1.5h", "2d", "30m", "45s".
export function parseDuration(text: string): number | null {
  const found = /^\s*(\d+(?:\.\d+)?)\s*([smhd]?)\s*$/i.exec(text);
  if (found === null) {
    return null;
  }
  const scale: Record<string, number> = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };
  const seconds = Number(found[1]) * scale[found[2].toLowerCase()];
  return seconds > 0 && Number.isFinite(seconds) ? seconds : null;
}

export async function renameKey(host: RedisHost, db: number, key: Bin, to: Bin): Promise<boolean> {
  if (binText(to) === binText(key)) {
    return false;
  }
  const command = `RENAMENX ${consoleArg(key)} ${consoleArg(to)}`;
  if (!(await askWrite(host, { title: t("키 이름 바꾸기"), message: t("{from}의 이름을 {to}(으)로 바꿉니다.", { from: binText(key), to: binText(to) }), command, okLabel: t("이름 바꾸기") }))) {
    return false;
  }
  try {
    await edit(host.conn, db, key, { op: "rename", to });
  } catch (error) {
    // A key by that name already: overwrite it only when asked to.
    if (!(error instanceof KvError && error.code === "bad_request" && error.message.startsWith("같은 이름의 키가 이미 있습니다"))) {
      notifyError(error, { context: "data" });
      return false;
    }
    const ok = await confirmDialog({
      title: t("키 덮어쓰기"),
      message: t("{to} 키가 이미 있습니다. 지우고 이 키로 바꿀까요?", { to: binText(to) }) + `\n\nRENAME ${consoleArg(key)} ${consoleArg(to)}`,
      confirmLabel: t("덮어쓰기"),
      danger: true,
    });
    if (!ok) {
      return false;
    }
    try {
      await edit(host.conn, db, key, { op: "rename", to, overwrite: true });
    } catch (again) {
      notifyError(again, { context: "data" });
      return false;
    }
  }
  host.notify(t("키 이름을 바꿨습니다"));
  host.onKeyChange({ kind: "renamed", db, key, to });
  return true;
}

export async function setKeyTtl(host: RedisHost, db: number, key: Bin, seconds: number): Promise<boolean> {
  const ttl_ms = Math.round(seconds * 1000);
  const done = await runEdit(host, db, key, { op: "expire", ttl_ms }, { title: t("만료 시간 설정 (TTL)"), message: t("{key}가 {ttl} 뒤에 지워집니다.", { key: binText(key), ttl: ttlText(ttl_ms) }), command: `PEXPIRE ${consoleArg(key)} ${ttl_ms}`, okLabel: t("만료 설정") });
  if (done === null) {
    return false;
  }
  host.notify(t("만료 시간을 설정했습니다"));
  host.onKeyChange({ kind: "changed", db, key });
  return true;
}

export async function persistKey(host: RedisHost, db: number, key: Bin): Promise<boolean> {
  const done = await runEdit(host, db, key, { op: "persist" }, { title: t("만료 없애기"), message: t("{key}의 만료 시간을 없앱니다.", { key: binText(key) }), command: `PERSIST ${consoleArg(key)}`, okLabel: t("만료 없애기") });
  if (done === null) {
    return false;
  }
  host.notify(t("만료 시간을 없앴습니다"));
  host.onKeyChange({ kind: "changed", db, key });
  return true;
}

// Deletes keys; `ask` puts the confirm dialog first (the key details ask
// with their own popover).
export async function deleteKeys(host: RedisHost, db: number, keys: Bin[], ask = true): Promise<boolean> {
  if (keys.length === 0) {
    return false;
  }
  if (ask) {
    const ok = await confirmDialog({
      title: keys.length === 1 ? t("키 삭제") : t("키 {count}개 삭제", { count: keys.length }),
      message:
        (keys.length === 1 ? t("{key} 키를 지웁니다. 되돌릴 수 없습니다.", { key: binText(keys[0]) }) : t("키 {count}개를 지웁니다. 되돌릴 수 없습니다.", { count: keys.length })) +
        `\n\nUNLINK ${keys.slice(0, 20).map(consoleArg).join(" ")}${keys.length > 20 ? " …" : ""}`,
      confirmLabel: t("삭제"),
      danger: true,
    });
    if (!ok) {
      return false;
    }
  }
  let deleted = 0;
  for (const key of keys) {
    try {
      await edit(host.conn, db, key, { op: "delete" });
      deleted += 1;
      host.onKeyChange({ kind: "deleted", db, key });
    } catch (error) {
      notifyError(error, { context: "data" });
      break;
    }
  }
  if (deleted > 0) {
    host.notify(deleted === 1 ? t("키를 지웠습니다") : t("키 {count}개를 지웠습니다", { count: deleted }));
  }
  return deleted > 0;
}

export async function downloadKey(host: RedisHost, db: number, key: Bin, format: "json" | "text"): Promise<void> {
  try {
    const file = await exportKey(host.conn, db, key, format);
    downloadBlob(file.name ?? `${safeFileName(binText(key))}.${format === "json" ? "json" : "txt"}`, file.blob);
    host.notify(t("내보냈습니다"));
  } catch (error) {
    notifyError(error, { context: "export" });
  }
}

export async function copyText(host: RedisHost, text: string): Promise<void> {
  if (await writeClipboard(text, (message) => notifyError(message))) {
    host.notify(t("복사했습니다"));
  }
}

// A small question beside the button that asked it (RedisInsight's delete
// popover): the message and a danger button; Esc, a click outside or
// Cancel close it. Starts on Cancel.
export function ConfirmPopover({ anchor, message, okLabel, onConfirm, onClose }: { anchor: HTMLElement; message: ReactNode; okLabel: string; onConfirm(): void; onClose(): void }) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const rect = anchor.getBoundingClientRect();
    const width = boxRef.current?.offsetWidth ?? 240;
    setAt({ left: Math.max(8, Math.min(window.innerWidth - width - 8, rect.right - width)), top: rect.bottom + 6 });
  }, [anchor]);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    const onDown = (event: MouseEvent) => {
      if (boxRef.current !== null && !boxRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [onClose]);
  return createPortal(
    <div ref={boxRef} className="menu-panel kv-popover" role="alertdialog" style={at === null ? { visibility: "hidden" } : at}>
      <div className="kv-popover-text">{message}</div>
      <div className="kv-popover-actions">
        <button type="button" ref={cancelRef} onClick={onClose}>
          {t("취소")}
        </button>
        <button
          type="button"
          className="primary danger"
          onClick={() => {
            onClose();
            onConfirm();
          }}
        >
          {okLabel}
        </button>
      </div>
    </div>,
    document.body,
  );
}
