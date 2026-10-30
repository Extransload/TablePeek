// A search connection's 보안 tab: the users, roles, role mappings and API
// keys of Elasticsearch security or the OpenSearch security plugin, one
// section each, with their dialogs. What the server can't do (security off,
// OpenSearch's users that can't be turned off, API keys before OpenSearch
// 3.7) shows with the reason the server gives.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ErrorNotice, notifyError } from "../../../components/ErrorNotice";
import { KeyIcon, PencilIcon, PlusIcon, RefreshIcon, TrashIcon } from "../../../components/icons";
import { LoadingState, Spinner } from "../../../components/Spinner";
import { t, tServer } from "../../../i18n";
import { stringifyJson } from "../../mongodb/bson";
import { isAbort, securityDelete, securityList, securityOverview, userEnabled, type SecurityEntry, type SecurityKind, type SecurityOverview } from "../api";
import type { Json } from "../json";
import { requestText } from "./common";
import { askFirst } from "./IndexDialogs";
import { ApiKeyDialog, MappingDialog, PasswordDialog, RoleDialog, UserDialog } from "./SecurityDialogs";
import { apiKeyInvalidatePath, entryPath, names, type SecurityContext } from "./SecurityParts";
import type { SecuritySection, SecurityTabProps } from "./types";
import "../../mongodb/mongodb.css";
import "../../mongodb/ui/panels.css";
import "./panels.css";
import "./security.css";

const SECTIONS: { id: SecuritySection; label: string }[] = [
  { id: "users", label: "사용자" },
  { id: "roles", label: "역할" },
  { id: "role_mappings", label: "역할 매핑" },
  { id: "api_keys", label: "API 키" },
];

export function SecurityTab({ host, section, onSectionChange, refreshSeq }: SecurityTabProps) {
  const [overview, setOverview] = useState<SecurityOverview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reloadSeq, setReloadSeq] = useState(0);

  useEffect(() => {
    const ctl = new AbortController();
    setError(null);
    securityOverview(host.conn, ctl.signal).then(setOverview, (e: unknown) => {
      if (!isAbort(e)) {
        setError(e);
      }
    });
    return () => ctl.abort();
  }, [host.conn, refreshSeq, reloadSeq]);

  if (error !== null) {
    return (
      <div className="mg-pane es-pane">
        <div className="es-body">
          <ErrorNotice error={error} context="admin" engine="elasticsearch" onRetry={() => setReloadSeq((n) => n + 1)} />
        </div>
      </div>
    );
  }
  if (overview === null) {
    return <LoadingState />;
  }
  if (!overview.enabled) {
    return (
      <div className="mg-pane es-pane">
        <div className="panel-empty es-sec-off">
          <strong>{t("이 서버의 보안을 관리할 수 없습니다")}</strong>
          {overview.reason !== null ? <span>{tServer(overview.reason)}</span> : null}
        </div>
      </div>
    );
  }

  const ctx: SecurityContext = { host, overview, os: overview.flavor === "opensearch" };
  const user = overview.user;
  return (
    <div className="mg-root mg-coll es-root">
      <div className="mg-subbar">
        <div className="mg-subtabs" role="tablist">
          {SECTIONS.map((s) => (
            <button key={s.id} type="button" role="tab" aria-selected={section === s.id} className={section === s.id ? "active" : undefined} onClick={() => onSectionChange(s.id)}>
              {t(s.label)}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <div className="mg-substats">
          {user !== null ? (
            <span className="es-chip mono" title={[t("역할: {names}", { names: user.roles.join(", ") || "—" }), user.realm !== null ? t("렐름: {name}", { name: user.realm }) : "", user.backendRoles.length > 0 ? t("백엔드 역할: {names}", { names: user.backendRoles.join(", ") }) : ""].filter((line) => line !== "").join("\n")}>
              {t("로그인: {name}", { name: user.name })}
            </span>
          ) : null}
          {overview.manage === false ? (
            <span className="es-chip warn" title={ctx.os ? t("보안을 바꾸려면 all_access나 security_manager 역할이 필요합니다") : t("보안을 바꾸려면 manage_security 권한이 필요합니다")}>
              {t("보안 관리 권한 없음")}
            </span>
          ) : null}
        </div>
      </div>
      <SectionView key={section} ctx={ctx} kind={section} refreshSeq={refreshSeq + reloadSeq} />
    </div>
  );
}

type Dialog =
  | { kind: "user"; entry: SecurityEntry | null }
  | { kind: "password"; name: string }
  | { kind: "role"; entry: SecurityEntry | null; copy: boolean }
  | { kind: "mapping"; entry: SecurityEntry | null }
  | { kind: "apiKey" };

function textOf(value: Json | undefined): string {
  return typeof value === "string" ? value : "";
}

function numberOf(value: Json | undefined): number | null {
  return typeof value === "number" ? value : null;
}

// Names as chips, the first few; the rest as a count with all of them in
// the title.
function Chips({ values, limit = 6 }: { values: string[]; limit?: number }) {
  if (values.length === 0) {
    return <span className="panel-dim">—</span>;
  }
  return (
    <span className="es-sec-chips" title={values.length > limit ? values.join(", ") : undefined}>
      {values.slice(0, limit).map((value) => (
        <span key={value} className="es-chip mono">
          {value}
        </span>
      ))}
      {values.length > limit ? <span className="panel-dim">{t("외 {count}개", { count: values.length - limit })}</span> : null}
    </span>
  );
}

function keyState(entry: SecurityEntry, now: number): "invalidated" | "expired" | "active" {
  if (entry.invalidated === true) {
    return "invalidated";
  }
  const expires = numberOf(entry.expires_ms);
  return expires !== null && expires <= now ? "expired" : "active";
}

const ADD_LABEL: Record<SecurityKind, string> = {
  users: "사용자 만들기",
  roles: "역할 만들기",
  role_mappings: "역할 매핑 만들기",
  api_keys: "API 키 만들기",
};

// The confirmation and notice of a delete, one sentence per kind (they
// don't compose in English).
const DELETE_TEXT: Record<Exclude<SecurityKind, "api_keys">, { title: string; ask: string; done: string }> = {
  users: { title: "사용자 삭제", ask: "사용자 {name}을(를) 지울까요?\n{consequence} 되돌릴 수 없습니다.", done: "사용자 {name}을(를) 지웠습니다" },
  roles: { title: "역할 삭제", ask: "역할 {name}을(를) 지울까요?\n{consequence} 되돌릴 수 없습니다.", done: "역할 {name}을(를) 지웠습니다" },
  role_mappings: { title: "역할 매핑 삭제", ask: "역할 매핑 {name}을(를) 지울까요?\n{consequence} 되돌릴 수 없습니다.", done: "역할 매핑 {name}을(를) 지웠습니다" },
};

function SectionView({ ctx, kind, refreshSeq }: { ctx: SecurityContext; kind: SecuritySection; refreshSeq: number }) {
  const { host, os, overview } = ctx;
  const availability = overview.kinds[kind];
  const available = availability?.available !== false;
  const [rows, setRows] = useState<SecurityEntry[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [reloadSeq, setReloadSeq] = useState(0);
  const [filter, setFilter] = useState("");
  // Built-in entries (and, for API keys, invalidated or expired ones).
  const [showAll, setShowAll] = useState(kind !== "api_keys");
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  useEffect(() => {
    if (!available) {
      return;
    }
    const ctl = new AbortController();
    setError(null);
    securityList(host.conn, kind, ctl.signal).then(setRows, (e: unknown) => {
      if (!isAbort(e)) {
        setError(e);
      }
    });
    return () => ctl.abort();
  }, [host.conn, kind, available, refreshSeq, reloadSeq]);

  // Expiry is judged as of the last read.
  const now = useMemo(() => Date.now(), [rows]);
  const shown = useMemo(() => {
    if (rows === null) {
      return null;
    }
    const needle = filter.trim().toLowerCase();
    return rows.filter((row) => {
      if (!showAll && (kind === "api_keys" ? keyState(row, now) !== "active" : row.reserved === true || row.hidden === true)) {
        return false;
      }
      if (needle === "") {
        return true;
      }
      const haystack = [row.name, textOf(row.id), textOf(row.user), ...names(row.roles), ...names(row.backend_roles), ...names(row.users)].join("\u0000").toLowerCase();
      return haystack.includes(needle);
    });
  }, [rows, filter, showAll, kind, now]);
  const hiddenCount = rows !== null && shown !== null && filter.trim() === "" ? rows.length - shown.length : 0;

  function reload(): void {
    setReloadSeq((n) => n + 1);
  }

  function saved(message: string): void {
    setDialog(null);
    host.notify(message);
    reload();
  }

  async function run(key: string, action: () => Promise<unknown>, done: string): Promise<void> {
    setWorking(key);
    try {
      await action();
      host.notify(done);
      reload();
    } catch (e) {
      notifyError(e, { context: "admin" });
    } finally {
      setWorking(null);
    }
  }

  async function remove(entry: SecurityEntry): Promise<void> {
    if (kind === "api_keys") {
      return;
    }
    const self = kind === "users" && overview.user?.name === entry.name;
    const consequence =
      kind === "users"
        ? self
          ? t("이 연결이 로그인한 사용자입니다 — 지우면 이 연결도 더 이상 쓸 수 없습니다.")
          : t("이 사용자로는 더 이상 로그인할 수 없습니다.")
        : kind === "roles"
          ? t("이 역할을 가진 사용자와 매핑은 이 역할의 권한을 잃습니다.")
          : t("이 매핑으로 역할을 받던 사용자는 그 역할을 잃습니다.");
    const ok = await host.confirm({
      title: t(DELETE_TEXT[kind].title),
      message: t(DELETE_TEXT[kind].ask, { name: entry.name, consequence }),
      command: requestText("DELETE", entryPath(os, kind, entry.name)),
      okLabel: t("삭제"),
      ...(self || host.safeMode >= 1 ? { typeToConfirm: entry.name } : {}),
    });
    if (ok) {
      await run(`delete:${entry.name}`, () => securityDelete(host.conn, kind, [entry.name]), t(DELETE_TEXT[kind].done, { name: entry.name }));
    }
  }

  async function switchUser(entry: SecurityEntry, enabled: boolean): Promise<void> {
    const command = requestText("PUT", `${entryPath(os, "users", entry.name)}/${enabled ? "_enable" : "_disable"}`);
    const self = overview.user?.name === entry.name;
    const request = {
      title: enabled ? t("사용자 켜기") : t("사용자 끄기"),
      message: enabled
        ? t("사용자 {name}을(를) 다시 켤까요? 이 사용자로 다시 로그인할 수 있습니다.", { name: entry.name })
        : self
          ? t("사용자 {name}을(를) 끌까요?\n이 연결이 로그인한 사용자입니다 — 끄면 이 연결도 더 이상 쓸 수 없습니다.", { name: entry.name })
          : t("사용자 {name}을(를) 끌까요?\n지우지는 않지만 켤 때까지 이 사용자로 로그인할 수 없습니다.", { name: entry.name }),
      command,
      okLabel: enabled ? t("켜기") : t("끄기"),
    };
    // Turning a user off locks them out: asked whatever the safe mode.
    const ok = enabled ? await askFirst(host, "danger", request) : await host.confirm(request);
    if (ok) {
      await run(`enabled:${entry.name}`, () => userEnabled(host.conn, entry.name, enabled), enabled ? t("사용자 {name}을(를) 켰습니다", { name: entry.name }) : t("사용자 {name}을(를) 껐습니다", { name: entry.name }));
    }
  }

  async function invalidate(entry: SecurityEntry): Promise<void> {
    const id = textOf(entry.id);
    const label = entry.name || id;
    const ok = await host.confirm({
      title: t("API 키 무효화"),
      message: t("API 키 {name}을(를) 무효화할까요?\n이 키로 보내는 요청은 바로 거절됩니다. 되돌릴 수 없습니다.", { name: label }),
      command: os ? requestText("DELETE", apiKeyInvalidatePath(true, id)) : requestText("DELETE", apiKeyInvalidatePath(false, id), { ids: [id] }),
      okLabel: t("무효화"),
    });
    if (ok) {
      await run(`invalidate:${id}`, () => securityDelete(host.conn, "api_keys", [id]), t("API 키 {name}을(를) 무효화했습니다", { name: label }));
    }
  }

  const writable = !host.readOnly;
  const busy = working !== null;

  function rowButtons(entry: SecurityEntry) {
    if (kind === "api_keys") {
      const id = textOf(entry.id);
      return writable && entry.invalidated !== true ? (
        <button type="button" className="icon-text-button mg-danger-text" disabled={busy} onClick={() => void invalidate(entry)}>
          {working === `invalidate:${id}` ? <Spinner size={10} /> : <TrashIcon size={10} />}
          {t("무효화")}
        </button>
      ) : null;
    }
    const locked = entry.reserved === true;
    const open = () =>
      setDialog(kind === "users" ? { kind: "user", entry } : kind === "roles" ? { kind: "role", entry, copy: false } : { kind: "mapping", entry });
    return (
      <>
        <button type="button" className="icon-text-button" disabled={busy} onClick={open}>
          <PencilIcon size={10} />
          {writable && !locked ? t("편집 [버튼]") : t("보기")}
        </button>
        {kind === "roles" && writable ? (
          <button type="button" className="icon-text-button" disabled={busy} onClick={() => setDialog({ kind: "role", entry, copy: true })}>
            <PlusIcon size={9} />
            {t("복사")}
          </button>
        ) : null}
        {kind === "users" && writable && !(os && locked) ? (
          <button type="button" className="icon-text-button" disabled={busy} onClick={() => setDialog({ kind: "password", name: entry.name })}>
            <KeyIcon size={10} />
            {t("비밀번호")}
          </button>
        ) : null}
        {kind === "users" && writable && overview.userEnabled.available ? (
          <button type="button" className="icon-text-button" disabled={busy} onClick={() => void switchUser(entry, entry.enabled === false)}>
            {working === `enabled:${entry.name}` ? <Spinner size={10} /> : null}
            {entry.enabled === false ? t("켜기") : t("끄기")}
          </button>
        ) : null}
        {writable && !locked ? (
          <button type="button" className="icon-text-button mg-danger-text" disabled={busy} onClick={() => void remove(entry)}>
            {working === `delete:${entry.name}` ? <Spinner size={10} /> : <TrashIcon size={10} />}
            {t("삭제")}
          </button>
        ) : null}
      </>
    );
  }

  function nameCell(entry: SecurityEntry) {
    return (
      <td className="mono es-sec-name">
        {kind === "api_keys" ? entry.name || <span className="panel-dim">—</span> : entry.name}
        {entry.reserved === true ? <span className="es-chip dim">{t("기본 제공")}</span> : null}
        {entry.hidden === true ? <span className="es-chip dim">{t("숨김")}</span> : null}
        {kind === "users" && overview.user?.name === entry.name ? <span className="es-chip">{t("나")}</span> : null}
      </td>
    );
  }

  function table() {
    if (shown === null) {
      return null;
    }
    let head: string[];
    let cells: (entry: SecurityEntry) => ReactNode;
    if (kind === "users") {
      head = os ? ["사용자 이름", "설명", "역할", "백엔드 역할"] : ["사용자 이름", "전체 이름", "이메일", "역할", "상태"];
      cells = (entry) =>
        os ? (
          <>
            <td>{textOf(entry.description) || <span className="panel-dim">—</span>}</td>
            <td><Chips values={names(entry.roles)} /></td>
            <td><Chips values={names(entry.backend_roles)} /></td>
          </>
        ) : (
          <>
            <td>{textOf(entry.full_name) || <span className="panel-dim">—</span>}</td>
            <td>{textOf(entry.email) || <span className="panel-dim">—</span>}</td>
            <td><Chips values={names(entry.roles)} /></td>
            <td>{entry.enabled === false ? <span className="es-chip warn">{t("꺼짐")}</span> : <span className="mg-flag ok">{t("사용")}</span>}</td>
          </>
        );
    } else if (kind === "roles") {
      head = os ? ["역할 이름", "설명", "클러스터 권한", "인덱스 패턴"] : ["역할 이름", "클러스터 권한", "인덱스"];
      cells = (entry) => (
        <>
          {os ? <td>{textOf(entry.description) || <span className="panel-dim">—</span>}</td> : null}
          <td><Chips values={names(entry.cluster)} limit={4} /></td>
          <td><Chips values={names(entry.indices)} limit={4} /></td>
        </>
      );
    } else if (kind === "role_mappings") {
      head = os ? ["역할", "사용자", "백엔드 역할", "호스트"] : ["역할 매핑 이름", "상태", "줄 역할", "규칙"];
      cells = (entry) =>
        os ? (
          <>
            <td><Chips values={names(entry.users)} /></td>
            <td><Chips values={names(entry.backend_roles)} /></td>
            <td><Chips values={names(entry.hosts)} /></td>
          </>
        ) : (
          <>
            <td>{entry.enabled === false ? <span className="es-chip warn">{t("꺼짐")}</span> : <span className="mg-flag ok">{t("사용")}</span>}</td>
            <td><Chips values={names(entry.roles)} /></td>
            <td className="mono es-sec-rules" title={entry.rules !== undefined && entry.rules !== null ? stringifyJson(entry.rules, 2) : undefined}>
              {entry.rules !== undefined && entry.rules !== null ? stringifyJson(entry.rules) : <span className="panel-dim">—</span>}
            </td>
          </>
        );
    } else {
      head = ["키 이름", "ID", "소유자", "만든 때", "만료", "상태"];
      cells = (entry) => {
        const created = numberOf(entry.created_ms);
        const expires = numberOf(entry.expires_ms);
        const state = keyState(entry, now);
        const realm = textOf(entry.realm);
        return (
          <>
            <td className="mono es-sec-id">{textOf(entry.id)}</td>
            <td className="mono">{textOf(entry.user) ? `${textOf(entry.user)}${realm ? ` (${realm})` : ""}` : <span className="panel-dim">—</span>}</td>
            <td>{created !== null ? new Date(created).toLocaleString() : <span className="panel-dim">—</span>}</td>
            <td>{expires !== null ? new Date(expires).toLocaleString() : <span className="panel-dim">{t("없음")}</span>}</td>
            <td>
              {state === "invalidated" ? (
                <span className="es-chip dim">{t("무효화됨")}</span>
              ) : state === "expired" ? (
                <span className="es-chip warn">{t("만료됨")}</span>
              ) : (
                <span className="mg-flag ok">{t("유효")}</span>
              )}
            </td>
          </>
        );
      };
    }
    if (shown.length === 0) {
      return <div className="panel-empty">{rows !== null && rows.length > 0 ? t("조건에 맞는 항목이 없습니다") : t("아직 없습니다")}</div>;
    }
    return (
      <section className="structure-section">
        <table className="panel-table es-sec-table">
          <thead>
            <tr>
              {head.map((label) => (
                <th key={label}>{label === "ID" ? label : t(label)}</th>
              ))}
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((entry) => (
              <tr key={kind === "api_keys" ? textOf(entry.id) : entry.name} className={entry.enabled === false || (kind === "api_keys" && keyState(entry, now) !== "active") ? "es-sec-off-row" : undefined}>
                {nameCell(entry)}
                {cells(entry)}
                <td className="num es-row-actions">{rowButtons(entry)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    );
  }

  if (!available) {
    return (
      <div className="mg-pane es-pane">
        <div className="panel-empty es-sec-off">
          <strong>{t("이 서버에서는 쓸 수 없습니다")}</strong>
          {availability?.reason ? <span>{tServer(availability.reason)}</span> : null}
        </div>
      </div>
    );
  }

  const note =
    kind === "users" && !overview.userEnabled.available && overview.userEnabled.reason !== null
      ? tServer(overview.userEnabled.reason)
      : kind === "api_keys" && overview.manageApiKeys === false
        ? t("이 사용자에게는 API 키를 만들 권한(manage_api_key, manage_own_api_key)이 없습니다")
        : kind === "role_mappings" && os
          ? t("OpenSearch의 역할 매핑은 역할마다 하나이고, 이름이 역할 이름입니다")
          : null;

  return (
    <div className="mg-pane es-pane">
      <div className="mg-agg-bar">
        <span className="mg-agg-count">{shown === null ? t(SECTIONS.find((s) => s.id === kind)?.label ?? "") : t("{count}개", { count: shown.length.toLocaleString() })}</span>
        <input type="search" className="mg-input es-sec-filter" placeholder={t("이름으로 거르기")} aria-label={t("이름으로 거르기")} value={filter} onChange={(event) => setFilter(event.target.value)} />
        <label className="es-check">
          <input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} />
          {kind === "api_keys" ? t("무효화·만료된 키도 보기") : t("기본 제공·숨김 항목도 보기")}
        </label>
        {hiddenCount > 0 ? <span className="panel-dim">{t("{count}개 숨김", { count: hiddenCount })}</span> : null}
        <span className="spacer" />
        <button type="button" className="icon-button" title={t("새로고침")} aria-label={t("새로고침")} onClick={reload}>
          <RefreshIcon size={12} />
        </button>
        {writable ? (
          <button type="button" className="primary mg-find" onClick={() => setDialog(kind === "users" ? { kind: "user", entry: null } : kind === "roles" ? { kind: "role", entry: null, copy: false } : kind === "role_mappings" ? { kind: "mapping", entry: null } : { kind: "apiKey" })}>
            <PlusIcon size={9} />
            {t(ADD_LABEL[kind])}
          </button>
        ) : null}
      </div>
      {note !== null ? <div className="es-sec-note">{note}</div> : null}
      <div className="es-body">{error !== null ? <ErrorNotice error={error} context="admin" engine="elasticsearch" onRetry={reload} /> : rows === null ? <LoadingState /> : table()}</div>
      {dialog?.kind === "user" ? (
        <UserDialog ctx={ctx} entry={dialog.entry} onClose={() => setDialog(null)} onSaved={(name) => saved(t("사용자 {name}을(를) 저장했습니다", { name }))} />
      ) : dialog?.kind === "password" ? (
        <PasswordDialog ctx={ctx} name={dialog.name} onClose={() => setDialog(null)} onDone={() => saved(t("사용자 {name}의 비밀번호를 바꿨습니다", { name: dialog.name }))} />
      ) : dialog?.kind === "role" ? (
        <RoleDialog ctx={ctx} entry={dialog.entry} copy={dialog.copy} onClose={() => setDialog(null)} onSaved={(name) => saved(t("역할 {name}을(를) 저장했습니다", { name }))} />
      ) : dialog?.kind === "mapping" ? (
        <MappingDialog ctx={ctx} entry={dialog.entry} onClose={() => setDialog(null)} onSaved={(name) => saved(t("역할 매핑 {name}을(를) 저장했습니다", { name }))} />
      ) : dialog?.kind === "apiKey" ? (
        <ApiKeyDialog
          ctx={ctx}
          onClose={() => setDialog(null)}
          onCreated={() => {
            setDialog(null);
            reload();
          }}
        />
      ) : null}
    </div>
  );
}
