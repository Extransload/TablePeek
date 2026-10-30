// The 보안 tab's dialogs: a user (and its password), a role, a role mapping
// and a new API key, each showing the request it sends. Elasticsearch and
// OpenSearch differ in their models, so each dialog edits the one the
// server has; fields the dialog doesn't show are kept from the definition
// as the server gave it.

import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { ErrorNotice, FieldError } from "../../../components/ErrorNotice";
import { CopyIcon, PlusIcon, TrashIcon } from "../../../components/icons";
import { Select } from "../../../components/Select";
import { Spinner } from "../../../components/Spinner";
import { SuggestInput } from "../../../components/SuggestInput";
import { writeClipboard } from "../../../clipboard";
import { t } from "../../../i18n";
import { JsonSyntaxError, parseJson, stringifyJson } from "../../mongodb/bson";
import { AdminModal } from "../../mongodb/ui/AdminModal";
import { createApiKey, indices, securityPut, userPassword, type SecurityEntry } from "../api";
import { completeDsl, type DslCompletion } from "../dsl";
import type { Json } from "../json";
import { requestText } from "./common";
import { askFirst, ReadOnlyNote, RequestPreview } from "./IndexDialogs";
import {
  apiKeyPath,
  entryPath,
  ES_CLUSTER_PRIVILEGES,
  ES_INDEX_PRIVILEGES,
  MASK,
  masked,
  names,
  objectOf,
  OS_CLUSTER_PERMISSIONS,
  OS_INDEX_PERMISSIONS,
  OS_TENANT_PERMISSIONS,
  TokenInput,
  useEntryNames,
  type SecurityContext,
} from "./SecurityParts";
import { SearchEditor } from "./SearchEditor";

type JsonObject = { [key: string]: Json };
type Parsed = { value: JsonObject | null } | { error: string; at: number | null };

// A JSON object typed in an editor; empty text is no value.
function parseObject(text: string, problem: string): Parsed {
  if (text.trim() === "") {
    return { value: null };
  }
  let value: unknown;
  try {
    value = parseJson(text);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), at: e instanceof JsonSyntaxError ? e.offset : null };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { error: problem, at: null };
  }
  return { value: value as JsonObject };
}

function editorError(parsed: Parsed): { from: number; to: number } | null {
  return "error" in parsed && parsed.at !== null ? { from: parsed.at, to: parsed.at + 1 } : null;
}

// A query written as JSON text, shown pretty when it parses.
function prettyQuery(value: Json | undefined): string {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  if (typeof value !== "string") {
    return stringifyJson(value, 2);
  }
  try {
    return stringifyJson(parseJson(value), 2);
  } catch {
    return value;
  }
}

// The query of a role is a search query: completion reads it as the value
// of `query`.
const QUERY_WRAP = '{"query":';

function completeQuery(text: string, pos: number): DslCompletion | null {
  const result = completeDsl(QUERY_WRAP + text, pos + QUERY_WRAP.length, { fields: [], root: "search" });
  return result === null ? null : { ...result, from: result.from - QUERY_WRAP.length, to: result.to - QUERY_WRAP.length };
}

// The frame every dialog here shares: the form, the request it sends, the
// failure, and 취소 / the action.
function SecurityModal({
  title,
  path,
  wide = false,
  busy,
  readOnly,
  okLabel,
  command,
  problem,
  failure,
  onSubmit,
  onClose,
  children,
}: {
  title: string;
  path?: string;
  wide?: boolean;
  busy: boolean;
  // Nothing is sent: the dialog only shows the definition.
  readOnly: boolean;
  okLabel: string;
  command: string | null;
  problem: string | null;
  failure: unknown;
  onSubmit(): void;
  onClose(): void;
  children: ReactNode;
}) {
  return (
    <AdminModal
      title={title}
      path={path}
      className={`es-modal${wide ? " wide" : ""}`}
      busy={busy}
      onClose={onClose}
      foot={
        <>
          <span className="spacer" />
          <button type="button" onClick={onClose} disabled={busy}>
            {readOnly ? t("닫기") : t("취소")}
          </button>
          {readOnly ? null : (
            <button type="button" className="primary" disabled={busy || command === null || problem !== null} onClick={onSubmit}>
              {busy ? <Spinner size={10} /> : null}
              {okLabel}
            </button>
          )}
        </>
      }
    >
      {children}
      {readOnly ? null : <RequestPreview text={command} problem={problem} />}
      {failure !== null ? <ErrorNotice error={failure} context="admin" engine="elasticsearch" variant="compact" /> : null}
    </AdminModal>
  );
}

// Sends a write after the safe-mode question; the dialog's busy state and
// failure follow it.
function useSend(ctx: SecurityContext): { busy: boolean; failure: unknown; setFailure(e: unknown): void; send(request: { title: string; message: string; command: string; okLabel: string }, run: () => Promise<unknown>, done: () => void): Promise<void> } {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  async function send(request: { title: string; message: string; command: string; okLabel: string }, run: () => Promise<unknown>, done: () => void): Promise<void> {
    if (busy || !(await askFirst(ctx.host, "danger", request))) {
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      await run();
      done();
    } catch (e) {
      setFailure(e);
      setBusy(false);
    }
  }
  return { busy, failure, setFailure, send };
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="mg-form-row">
      <span className="mg-form-label">{label}</span>
      {children}
    </div>
  );
}

// ---- 사용자 ----

export function UserDialog({ ctx, entry, onClose, onSaved }: { ctx: SecurityContext; entry: SecurityEntry | null; onClose(): void; onSaved(name: string): void }) {
  const { host, os } = ctx;
  const body = objectOf(entry?.body);
  const readOnly = host.readOnly || entry?.reserved === true;
  const [name, setName] = useState(entry?.name ?? "");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [fullName, setFullName] = useState(typeof body.full_name === "string" ? body.full_name : "");
  const [email, setEmail] = useState(typeof body.email === "string" ? body.email : "");
  const [description, setDescription] = useState(typeof body.description === "string" ? body.description : "");
  const [roles, setRoles] = useState(names(os ? body.opendistro_security_roles : body.roles));
  const [backendRoles, setBackendRoles] = useState(names(body.backend_roles));
  const roleNames = useEntryNames(host.conn, "roles", !readOnly);
  const { busy, failure, setFailure, send } = useSend(ctx);
  const isNew = entry === null;
  const trimmed = name.trim();

  const problem = isNew && trimmed === "" ? t("사용자 이름을 쓰세요") : isNew && password === "" ? t("새 사용자에는 비밀번호가 필요합니다") : isNew && !os && password.length < 6 ? t("비밀번호는 6자 이상이어야 합니다") : isNew && password !== again ? t("비밀번호 확인이 다릅니다") : null;

  const next = useMemo((): JsonObject => {
    const out: JsonObject = { ...body };
    if (os) {
      out.opendistro_security_roles = roles;
      out.backend_roles = backendRoles;
      out.description = description;
    } else {
      out.roles = roles;
      if (fullName.trim() !== "" || "full_name" in body) {
        out.full_name = fullName.trim() === "" ? null : fullName.trim();
      }
      if (email.trim() !== "" || "email" in body) {
        out.email = email.trim() === "" ? null : email.trim();
      }
    }
    if (isNew) {
      out.password = password;
    }
    return out;
  }, [body, os, roles, backendRoles, description, fullName, email, isNew, password]);

  const path = entryPath(os, "users", trimmed || "…");
  // An OpenSearch user changed without a password is patched field by field
  // (the server does the same), so the password stays.
  const command = os && !isNew ? requestText("PATCH", path, Object.entries(next).map(([key, value]) => ({ op: "add", path: `/${key}`, value }))) : requestText("PUT", path, masked(next));

  function submit(): void {
    if (problem !== null) {
      return;
    }
    void send(
      { title: isNew ? t("사용자 만들기") : t("사용자 편집"), message: t("사용자 {name}을(를) 저장할까요?", { name: trimmed }), command, okLabel: t("저장") },
      () => securityPut(host.conn, "users", trimmed, next),
      () => onSaved(trimmed),
    );
  }

  const change = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setFailure(null);
  };

  return (
    <SecurityModal
      title={isNew ? t("사용자 만들기") : readOnly ? t("사용자 보기") : t("사용자 편집")}
      path={isNew ? undefined : entry.name}
      busy={busy}
      readOnly={readOnly}
      okLabel={isNew ? t("만들기") : t("저장")}
      command={command}
      problem={problem}
      failure={failure}
      onSubmit={submit}
      onClose={onClose}
    >
      {host.readOnly ? <ReadOnlyNote /> : entry?.reserved ? <p className="es-admin-note">{t("기본 제공 사용자는 고칠 수 없습니다")}</p> : null}
      {isNew ? (
        <>
          <Field label={t("사용자 이름")}>
            <input type="text" className="mg-input mono" spellCheck={false} autoFocus value={name} onChange={(event) => change(setName)(event.target.value)} />
          </Field>
          <div className="mg-form-grid">
            <Field label={t("비밀번호")}>
              <input type="password" className="mg-input" autoComplete="new-password" value={password} onChange={(event) => change(setPassword)(event.target.value)} />
            </Field>
            <Field label={t("비밀번호 확인")}>
              <input type="password" className="mg-input" autoComplete="new-password" value={again} onChange={(event) => change(setAgain)(event.target.value)} />
            </Field>
          </div>
        </>
      ) : null}
      {os ? (
        <Field label={t("설명")}>
          <input type="text" className="mg-input" disabled={readOnly} value={description} onChange={(event) => change(setDescription)(event.target.value)} />
        </Field>
      ) : (
        <div className="mg-form-grid">
          <Field label={t("전체 이름")}>
            <input type="text" className="mg-input" disabled={readOnly} value={fullName} onChange={(event) => change(setFullName)(event.target.value)} />
          </Field>
          <Field label={t("이메일")}>
            <input type="email" className="mg-input" disabled={readOnly} value={email} onChange={(event) => change(setEmail)(event.target.value)} />
          </Field>
        </div>
      )}
      <Field label={os ? t("보안 역할 (opendistro_security_roles)") : t("역할")}>
        <TokenInput values={roles} onChange={change(setRoles)} suggestions={roleNames} readOnly={readOnly} ariaLabel={t("역할")} placeholder={t("역할 이름")} />
      </Field>
      {os ? (
        <Field label={t("백엔드 역할 (역할 매핑이 이 이름으로 역할을 줍니다)")}>
          <TokenInput values={backendRoles} onChange={change(setBackendRoles)} readOnly={readOnly} ariaLabel={t("백엔드 역할")} />
        </Field>
      ) : null}
      {readOnly && !isNew ? (
        <>
          <div className="mg-form-label">{t("정의")}</div>
          <pre className="panel-pre mg-ix-preview">{stringifyJson(body, 2)}</pre>
        </>
      ) : null}
    </SecurityModal>
  );
}

export function PasswordDialog({ ctx, name, onClose, onDone }: { ctx: SecurityContext; name: string; onClose(): void; onDone(): void }) {
  const { host, os, overview } = ctx;
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const { busy, failure, setFailure, send } = useSend(ctx);
  const problem = password === "" ? t("새 비밀번호를 입력하세요") : !os && password.length < 6 ? t("비밀번호는 6자 이상이어야 합니다") : password !== again ? t("비밀번호 확인이 다릅니다") : null;
  const path = entryPath(os, "users", name);
  const command = os ? requestText("PATCH", path, [{ op: "add", path: "/password", value: MASK }]) : requestText("POST", `${path}/_password`, { password: MASK });
  const self = overview.user?.name === name;

  return (
    <SecurityModal
      title={t("비밀번호 바꾸기")}
      path={name}
      busy={busy}
      readOnly={false}
      okLabel={t("바꾸기")}
      command={command}
      problem={problem}
      failure={failure}
      onSubmit={() =>
        void send(
          { title: t("비밀번호 바꾸기"), message: t("사용자 {name}의 비밀번호를 바꿀까요?", { name }), command, okLabel: t("바꾸기") },
          () => userPassword(host.conn, name, password),
          onDone,
        )
      }
      onClose={onClose}
    >
      {self ? <p className="es-admin-note">{t("이 연결이 로그인한 사용자입니다 — 바꾼 뒤에는 연결 설정의 비밀번호도 바꾸세요")}</p> : null}
      <div className="mg-form-grid">
        <Field label={t("새 비밀번호")}>
          <input
            type="password"
            className="mg-input"
            autoComplete="new-password"
            autoFocus
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              setFailure(null);
            }}
          />
        </Field>
        <Field label={t("비밀번호 확인")}>
          <input
            type="password"
            className="mg-input"
            autoComplete="new-password"
            value={again}
            onChange={(event) => {
              setAgain(event.target.value);
              setFailure(null);
            }}
          />
        </Field>
      </div>
    </SecurityModal>
  );
}

// ---- 역할 ----

interface EsIndexGroup {
  key: number;
  names: string[];
  privileges: string[];
  grant: string[];
  except: string[];
  query: string;
  restricted: boolean;
  // Fields of the group the dialog doesn't edit, kept as they were.
  rest: JsonObject;
}

interface EsAppGroup {
  key: number;
  application: string;
  privileges: string[];
  resources: string[];
}

interface OsIndexGroup {
  key: number;
  patterns: string[];
  actions: string[];
  fls: string[];
  masked: string[];
  dls: string;
  rest: JsonObject;
}

interface OsTenantGroup {
  key: number;
  patterns: string[];
  actions: string[];
}

let groupSeq = 0;

function esIndexGroups(value: Json | undefined): EsIndexGroup[] {
  return (Array.isArray(value) ? value : []).map((raw) => {
    const group = objectOf(raw);
    const fields = objectOf(group.field_security);
    const { names: n, privileges, field_security: _fs, query, allow_restricted_indices, ...rest } = group;
    return { key: ++groupSeq, names: names(n), privileges: names(privileges), grant: names(fields.grant), except: names(fields.except), query: prettyQuery(query), restricted: allow_restricted_indices === true, rest };
  });
}

function osIndexGroups(value: Json | undefined): OsIndexGroup[] {
  return (Array.isArray(value) ? value : []).map((raw) => {
    const group = objectOf(raw);
    const { index_patterns, allowed_actions, fls, masked_fields, dls, ...rest } = group;
    return { key: ++groupSeq, patterns: names(index_patterns), actions: names(allowed_actions), fls: names(fls), masked: names(masked_fields), dls: prettyQuery(dls), rest };
  });
}

function GroupCard({ title, readOnly, onRemove, children }: { title: string; readOnly: boolean; onRemove(): void; children: ReactNode }) {
  return (
    <div className="es-sec-group">
      <div className="es-sec-group-head">
        <span className="es-sec-group-title">{title}</span>
        <span className="spacer" />
        {readOnly ? null : (
          <button type="button" className="icon-text-button mg-danger-text" onClick={onRemove}>
            <TrashIcon size={10} />
            {t("빼기")}
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function AddGroup({ label, onAdd }: { label: string; onAdd(): void }) {
  return (
    <button type="button" className="icon-text-button es-sec-add" onClick={onAdd}>
      <PlusIcon size={9} />
      {label}
    </button>
  );
}

export function RoleDialog({ ctx, entry, copy, onClose, onSaved }: { ctx: SecurityContext; entry: SecurityEntry | null; copy: boolean; onClose(): void; onSaved(name: string): void }) {
  const { host, os } = ctx;
  // A copy leaves out the metadata keys the server reserves (`_reserved` of a
  // built-in role), which it would refuse on a new one.
  const body = useMemo((): JsonObject => {
    const source = objectOf(entry?.body);
    if (!copy || source.metadata === undefined) {
      return source;
    }
    return { ...source, metadata: Object.fromEntries(Object.entries(objectOf(source.metadata)).filter(([key]) => !key.startsWith("_"))) };
  }, [entry, copy]);
  const isNew = entry === null || copy;
  const readOnly = !isNew && (host.readOnly || entry?.reserved === true);
  const [name, setName] = useState(copy && entry !== null ? `${entry.name}_copy` : (entry?.name ?? ""));
  const [cluster, setCluster] = useState(names(os ? body.cluster_permissions : body.cluster));
  const [esIndices, setEsIndices] = useState(() => esIndexGroups(body.indices));
  const [apps, setApps] = useState<EsAppGroup[]>(() =>
    (Array.isArray(body.applications) ? body.applications : []).map((raw) => {
      const app = objectOf(raw);
      return { key: ++groupSeq, application: typeof app.application === "string" ? app.application : "", privileges: names(app.privileges), resources: names(app.resources) };
    }),
  );
  const [runAs, setRunAs] = useState(names(body.run_as));
  const [osIndices, setOsIndices] = useState(() => osIndexGroups(body.index_permissions));
  const [tenants, setTenants] = useState<OsTenantGroup[]>(() =>
    (Array.isArray(body.tenant_permissions) ? body.tenant_permissions : []).map((raw) => {
      const group = objectOf(raw);
      return { key: ++groupSeq, patterns: names(group.tenant_patterns), actions: names(group.allowed_actions) };
    }),
  );
  const [description, setDescription] = useState(typeof body.description === "string" ? body.description : "");
  const [indexNames, setIndexNames] = useState<string[]>([]);
  const userNames = useEntryNames(host.conn, "users", !readOnly && !os);
  const { busy, failure, setFailure, send } = useSend(ctx);
  const trimmed = name.trim();

  useEffect(() => {
    if (readOnly) {
      return;
    }
    const ctl = new AbortController();
    indices(host.conn, false, ctl.signal).then(
      (list) => setIndexNames(["*", ...list.map((row) => row.name).sort()]),
      () => setIndexNames(["*"]),
    );
    return () => ctl.abort();
  }, [host.conn, readOnly]);

  const built = useMemo((): { body: JsonObject } | { error: string } => {
    if (trimmed === "") {
      return { error: t("역할 이름을 쓰세요") };
    }
    const out: JsonObject = { ...body };
    if (os) {
      const groups: Json[] = [];
      for (const [i, group] of osIndices.entries()) {
        if (group.patterns.length === 0) {
          return { error: t("인덱스 권한 {n}: 인덱스 패턴을 쓰세요", { n: i + 1 }) };
        }
        const parsed = parseObject(group.dls, t("문서 수준 보안(DLS)은 쿼리 객체여야 합니다"));
        if ("error" in parsed) {
          return { error: t("인덱스 권한 {n}: {problem}", { n: i + 1, problem: parsed.error }) };
        }
        groups.push({
          ...group.rest,
          index_patterns: group.patterns,
          allowed_actions: group.actions,
          fls: group.fls,
          masked_fields: group.masked,
          // OpenSearch keeps the query as text.
          ...(parsed.value !== null ? { dls: stringifyJson(parsed.value) } : {}),
        });
      }
      out.cluster_permissions = cluster;
      out.index_permissions = groups;
      out.tenant_permissions = tenants.map((group) => ({ tenant_patterns: group.patterns, allowed_actions: group.actions }));
      if (description.trim() !== "" || "description" in body) {
        out.description = description.trim();
      }
      return { body: out };
    }
    const groups: Json[] = [];
    for (const [i, group] of esIndices.entries()) {
      if (group.names.length === 0 || group.privileges.length === 0) {
        return { error: t("인덱스 권한 {n}: 인덱스 이름과 권한을 하나 이상 쓰세요", { n: i + 1 }) };
      }
      const parsed = parseObject(group.query, t("문서 쿼리는 쿼리 객체여야 합니다"));
      if ("error" in parsed) {
        return { error: t("인덱스 권한 {n}: {problem}", { n: i + 1, problem: parsed.error }) };
      }
      const next: JsonObject = { ...group.rest, names: group.names, privileges: group.privileges };
      if (group.grant.length > 0 || group.except.length > 0) {
        next.field_security = { grant: group.grant.length > 0 ? group.grant : ["*"], ...(group.except.length > 0 ? { except: group.except } : {}) };
      }
      if (parsed.value !== null) {
        next.query = parsed.value;
      }
      if (group.restricted) {
        next.allow_restricted_indices = true;
      }
      groups.push(next);
    }
    for (const [i, app] of apps.entries()) {
      if (app.application.trim() === "" || app.privileges.length === 0 || app.resources.length === 0) {
        return { error: t("애플리케이션 권한 {n}: 애플리케이션, 권한, 리소스를 모두 쓰세요", { n: i + 1 }) };
      }
    }
    out.cluster = cluster;
    out.indices = groups;
    if (apps.length > 0 || "applications" in body) {
      out.applications = apps.map((app) => ({ application: app.application.trim(), privileges: app.privileges, resources: app.resources }));
    }
    if (runAs.length > 0 || "run_as" in body) {
      out.run_as = runAs;
    }
    return { body: out };
  }, [trimmed, body, os, osIndices, cluster, tenants, description, esIndices, apps, runAs]);

  const command = "body" in built ? requestText("PUT", entryPath(os, "roles", trimmed), built.body) : null;

  function submit(): void {
    if (!("body" in built) || command === null) {
      return;
    }
    const roleBody = built.body;
    void send(
      { title: isNew ? t("역할 만들기") : t("역할 편집"), message: t("역할 {name}을(를) 저장할까요?\n이 역할을 가진 사용자의 권한이 바로 바뀝니다.", { name: trimmed }), command, okLabel: t("저장") },
      () => securityPut(host.conn, "roles", trimmed, roleBody),
      () => onSaved(trimmed),
    );
  }

  // Every edit clears the last failure.
  function edit<T>(set: (update: (value: T) => T) => void): (update: (value: T) => T) => void {
    return (update) => {
      set(update);
      setFailure(null);
    };
  }
  const editEs = edit(setEsIndices);
  const editOs = edit(setOsIndices);
  const editApps = edit(setApps);
  const editTenants = edit(setTenants);
  const patchEs = (key: number, patch: Partial<EsIndexGroup>) => editEs((list) => list.map((g) => (g.key === key ? { ...g, ...patch } : g)));
  const patchOs = (key: number, patch: Partial<OsIndexGroup>) => editOs((list) => list.map((g) => (g.key === key ? { ...g, ...patch } : g)));

  return (
    <SecurityModal
      title={copy ? t("역할 복사") : isNew ? t("역할 만들기") : readOnly ? t("역할 보기") : t("역할 편집")}
      path={isNew ? undefined : entry?.name}
      wide
      busy={busy}
      readOnly={readOnly}
      okLabel={isNew ? t("만들기") : t("저장")}
      command={command}
      problem={"error" in built ? built.error : null}
      failure={failure}
      onSubmit={submit}
      onClose={onClose}
    >
      {host.readOnly ? <ReadOnlyNote /> : entry?.reserved && !copy ? <p className="es-admin-note">{t("기본 제공 역할은 고칠 수 없습니다 — 복사해서 새 역할로 만드세요")}</p> : null}
      {isNew ? (
        <Field label={t("역할 이름")}>
          <input
            type="text"
            className="mg-input mono"
            spellCheck={false}
            autoFocus
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setFailure(null);
            }}
          />
        </Field>
      ) : null}
      {os ? (
        <Field label={t("설명")}>
          <input type="text" className="mg-input" disabled={readOnly} value={description} onChange={(event) => setDescription(event.target.value)} />
        </Field>
      ) : null}
      <Field label={os ? t("클러스터 권한 (cluster_permissions)") : t("클러스터 권한 (cluster)")}>
        <TokenInput values={cluster} onChange={(v) => { setCluster(v); setFailure(null); }} suggestions={os ? OS_CLUSTER_PERMISSIONS : ES_CLUSTER_PRIVILEGES} readOnly={readOnly} ariaLabel={t("클러스터 권한")} placeholder={os ? "cluster_monitor" : "monitor"} />
      </Field>
      <div className="mg-form-label es-sec-part">{os ? t("인덱스 권한 (index_permissions)") : t("인덱스 권한 (indices)")}</div>
      {os
        ? osIndices.map((group, i) => (
            <GroupCard key={group.key} title={t("인덱스 권한 {n}", { n: i + 1 })} readOnly={readOnly} onRemove={() => editOs((list) => list.filter((g) => g.key !== group.key))}>
              <Field label={t("인덱스 패턴")}>
                <TokenInput values={group.patterns} onChange={(v) => patchOs(group.key, { patterns: v })} suggestions={indexNames} readOnly={readOnly} ariaLabel={t("인덱스 패턴")} placeholder="logs-*" />
              </Field>
              <Field label={t("허용 동작 (allowed_actions)")}>
                <TokenInput values={group.actions} onChange={(v) => patchOs(group.key, { actions: v })} suggestions={OS_INDEX_PERMISSIONS} readOnly={readOnly} ariaLabel={t("허용 동작")} placeholder="read" />
              </Field>
              <div className="mg-form-grid">
                <Field label={t("필드 수준 보안 (fls, ~필드는 제외)")}>
                  <TokenInput values={group.fls} onChange={(v) => patchOs(group.key, { fls: v })} readOnly={readOnly} ariaLabel={t("필드 수준 보안")} placeholder="~secret" />
                </Field>
                <Field label={t("가릴 필드 (masked_fields)")}>
                  <TokenInput values={group.masked} onChange={(v) => patchOs(group.key, { masked: v })} readOnly={readOnly} ariaLabel={t("가릴 필드")} />
                </Field>
              </div>
              <QueryField label={t("문서 수준 보안 (dls, 이 쿼리에 맞는 문서만 보입니다)")} value={group.dls} readOnly={readOnly} onChange={(v) => patchOs(group.key, { dls: v })} />
            </GroupCard>
          ))
        : esIndices.map((group, i) => (
            <GroupCard key={group.key} title={t("인덱스 권한 {n}", { n: i + 1 })} readOnly={readOnly} onRemove={() => editEs((list) => list.filter((g) => g.key !== group.key))}>
              <Field label={t("인덱스 이름·패턴 (names)")}>
                <TokenInput values={group.names} onChange={(v) => patchEs(group.key, { names: v })} suggestions={indexNames} readOnly={readOnly} ariaLabel={t("인덱스 이름·패턴")} placeholder="logs-*" />
              </Field>
              <Field label={t("권한 (privileges)")}>
                <TokenInput values={group.privileges} onChange={(v) => patchEs(group.key, { privileges: v })} suggestions={ES_INDEX_PRIVILEGES} readOnly={readOnly} ariaLabel={t("권한")} placeholder="read" />
              </Field>
              <div className="mg-form-grid">
                <Field label={t("보이는 필드 (field_security.grant)")}>
                  <TokenInput values={group.grant} onChange={(v) => patchEs(group.key, { grant: v })} readOnly={readOnly} ariaLabel={t("보이는 필드")} placeholder="*" />
                </Field>
                <Field label={t("뺄 필드 (field_security.except)")}>
                  <TokenInput values={group.except} onChange={(v) => patchEs(group.key, { except: v })} readOnly={readOnly} ariaLabel={t("뺄 필드")} />
                </Field>
              </div>
              <QueryField label={t("문서 쿼리 (query, 이 쿼리에 맞는 문서만 보입니다)")} value={group.query} readOnly={readOnly} onChange={(v) => patchEs(group.key, { query: v })} />
              <label className="es-check">
                <input type="checkbox" disabled={readOnly} checked={group.restricted} onChange={(event) => patchEs(group.key, { restricted: event.target.checked })} />
                {t("제한된 인덱스에도 (allow_restricted_indices)")}
              </label>
            </GroupCard>
          ))}
      {readOnly ? null : (
        <AddGroup
          label={t("인덱스 권한 추가")}
          onAdd={() =>
            os
              ? editOs((list) => [...list, { key: ++groupSeq, patterns: [], actions: [], fls: [], masked: [], dls: "", rest: {} }])
              : editEs((list) => [...list, { key: ++groupSeq, names: [], privileges: [], grant: [], except: [], query: "", restricted: false, rest: {} }])
          }
        />
      )}
      {os ? (
        <>
          <div className="mg-form-label es-sec-part">{t("테넌트 권한 (tenant_permissions)")}</div>
          {tenants.map((group, i) => (
            <GroupCard key={group.key} title={t("테넌트 권한 {n}", { n: i + 1 })} readOnly={readOnly} onRemove={() => editTenants((list) => list.filter((g) => g.key !== group.key))}>
              <div className="mg-form-grid">
                <Field label={t("테넌트 패턴")}>
                  <TokenInput values={group.patterns} onChange={(v) => editTenants((list) => list.map((g) => (g.key === group.key ? { ...g, patterns: v } : g)))} readOnly={readOnly} ariaLabel={t("테넌트 패턴")} placeholder="global_tenant" />
                </Field>
                <Field label={t("허용 동작 (allowed_actions)")}>
                  <TokenInput values={group.actions} onChange={(v) => editTenants((list) => list.map((g) => (g.key === group.key ? { ...g, actions: v } : g)))} suggestions={OS_TENANT_PERMISSIONS} readOnly={readOnly} ariaLabel={t("허용 동작")} />
                </Field>
              </div>
            </GroupCard>
          ))}
          {readOnly ? null : <AddGroup label={t("테넌트 권한 추가")} onAdd={() => editTenants((list) => [...list, { key: ++groupSeq, patterns: [], actions: [] }])} />}
        </>
      ) : (
        <>
          <div className="mg-form-label es-sec-part">{t("애플리케이션 권한 (applications)")}</div>
          {apps.map((app, i) => (
            <GroupCard key={app.key} title={t("애플리케이션 권한 {n}", { n: i + 1 })} readOnly={readOnly} onRemove={() => editApps((list) => list.filter((a) => a.key !== app.key))}>
              <Field label={t("애플리케이션")}>
                <input
                  type="text"
                  className="mg-input mono"
                  spellCheck={false}
                  disabled={readOnly}
                  placeholder="kibana-.kibana"
                  value={app.application}
                  onChange={(event) => editApps((list) => list.map((a) => (a.key === app.key ? { ...a, application: event.target.value } : a)))}
                />
              </Field>
              <div className="mg-form-grid">
                <Field label={t("권한 (privileges)")}>
                  <TokenInput values={app.privileges} onChange={(v) => editApps((list) => list.map((a) => (a.key === app.key ? { ...a, privileges: v } : a)))} readOnly={readOnly} ariaLabel={t("권한")} placeholder="read" />
                </Field>
                <Field label={t("리소스 (resources)")}>
                  <TokenInput values={app.resources} onChange={(v) => editApps((list) => list.map((a) => (a.key === app.key ? { ...a, resources: v } : a)))} readOnly={readOnly} ariaLabel={t("리소스")} placeholder="*" />
                </Field>
              </div>
            </GroupCard>
          ))}
          {readOnly ? null : <AddGroup label={t("애플리케이션 권한 추가")} onAdd={() => editApps((list) => [...list, { key: ++groupSeq, application: "", privileges: [], resources: [] }])} />}
          <Field label={t("다른 사용자로 실행 (run_as)")}>
            <TokenInput values={runAs} onChange={(v) => { setRunAs(v); setFailure(null); }} suggestions={userNames} readOnly={readOnly} ariaLabel={t("다른 사용자로 실행")} />
          </Field>
        </>
      )}
      {readOnly ? (
        <>
          <div className="mg-form-label">{t("정의")}</div>
          <pre className="panel-pre mg-ix-preview">{stringifyJson(body, 2)}</pre>
        </>
      ) : null}
    </SecurityModal>
  );
}

function QueryField({ label, value, readOnly, onChange }: { label: string; value: string; readOnly: boolean; onChange(value: string): void }) {
  const id = useId();
  const parsed = useMemo(() => parseObject(value, t("쿼리 객체여야 합니다 (예: {\"term\": {\"team\": \"ops\"}})")), [value]);
  return (
    <div className="mg-form-row">
      <span className="mg-form-label">{label}</span>
      <SearchEditor
        value={value}
        onChange={onChange}
        complete={completeQuery}
        readOnly={readOnly}
        error={editorError(parsed)}
        placeholder={'{ "term": { "team": "ops" } }'}
        className="es-filter-editor es-sec-query"
        ariaLabel={label}
      />
      <FieldError id={id} error={"error" in parsed ? parsed.error : null} />
    </div>
  );
}

// ---- 역할 매핑 ----

// Rule templates for an Elasticsearch role mapping (`rules`).
const RULE_TEMPLATES: { label: string; rules: Json }[] = [
  { label: "모든 사용자", rules: { field: { username: "*" } } },
  { label: "사용자 이름", rules: { field: { username: ["alice", "bob"] } } },
  { label: "렐름", rules: { field: { "realm.name": "ldap1" } } },
  { label: "그룹 (LDAP DN)", rules: { field: { groups: "cn=admins,dc=example,dc=com" } } },
  { label: "메타데이터 값", rules: { field: { "metadata.department": "ops" } } },
  { label: "모두 맞을 때 (all)", rules: { all: [{ field: { "realm.name": "ldap1" } }, { field: { groups: "cn=ops,dc=example,dc=com" } }] } },
  { label: "하나라도 맞을 때 (any)", rules: { any: [{ field: { username: "alice" } }, { field: { groups: "cn=admins,dc=example,dc=com" } }] } },
  { label: "제외 (except)", rules: { all: [{ field: { "realm.name": "saml1" } }, { except: { field: { username: "guest" } } }] } },
];

export function MappingDialog({ ctx, entry, onClose, onSaved }: { ctx: SecurityContext; entry: SecurityEntry | null; onClose(): void; onSaved(name: string): void }) {
  const { host, os } = ctx;
  const body = objectOf(entry?.body);
  const isNew = entry === null;
  const readOnly = host.readOnly || entry?.reserved === true;
  const [name, setName] = useState(entry?.name ?? "");
  const [enabled, setEnabled] = useState(body.enabled !== false);
  const [roles, setRoles] = useState(names(body.roles));
  const [rules, setRules] = useState(body.rules !== undefined && body.rules !== null ? stringifyJson(body.rules, 2) : "");
  const [users, setUsers] = useState(names(body.users));
  const [backendRoles, setBackendRoles] = useState(names(body.backend_roles));
  const [hosts, setHosts] = useState(names(body.hosts));
  const [description, setDescription] = useState(typeof body.description === "string" ? body.description : "");
  const roleNames = useEntryNames(host.conn, "roles", !readOnly);
  const userNames = useEntryNames(host.conn, "users", !readOnly && os);
  const { busy, failure, setFailure, send } = useSend(ctx);
  const trimmed = name.trim();
  const parsedRules = useMemo(() => parseObject(rules, t("규칙은 JSON 객체여야 합니다")), [rules]);
  const templates = Array.isArray(body.role_templates) && body.role_templates.length > 0;

  const built = useMemo((): { body: JsonObject } | { error: string } => {
    if (trimmed === "") {
      return { error: os ? t("역할을 고르세요") : t("역할 매핑 이름을 쓰세요") };
    }
    if (os) {
      const out: JsonObject = { ...body, users, backend_roles: backendRoles, hosts };
      if (description.trim() !== "" || "description" in body) {
        out.description = description.trim();
      }
      return { body: out };
    }
    if ("error" in parsedRules) {
      return { error: parsedRules.error };
    }
    if (parsedRules.value === null) {
      return { error: t("규칙을 쓰세요 (템플릿에서 고를 수 있습니다)") };
    }
    if (roles.length === 0 && !templates) {
      return { error: t("줄 역할을 하나 이상 쓰세요") };
    }
    const out: JsonObject = { ...body, enabled, rules: parsedRules.value };
    if (roles.length > 0 || !templates) {
      out.roles = roles;
    }
    return { body: out };
  }, [trimmed, os, body, users, backendRoles, hosts, description, parsedRules, roles, templates, enabled]);

  const command = "body" in built ? requestText("PUT", entryPath(os, "role_mappings", trimmed), built.body) : null;

  function submit(): void {
    if (!("body" in built) || command === null) {
      return;
    }
    const mappingBody = built.body;
    void send(
      { title: isNew ? t("역할 매핑 만들기") : t("역할 매핑 편집"), message: t("역할 매핑 {name}을(를) 저장할까요?\n이 매핑에 맞는 사용자의 역할이 바로 바뀝니다.", { name: trimmed }), command, okLabel: t("저장") },
      () => securityPut(host.conn, "role_mappings", trimmed, mappingBody),
      () => onSaved(trimmed),
    );
  }

  return (
    <SecurityModal
      title={isNew ? t("역할 매핑 만들기") : readOnly ? t("역할 매핑 보기") : t("역할 매핑 편집")}
      path={isNew ? undefined : entry.name}
      wide={!os}
      busy={busy}
      readOnly={readOnly}
      okLabel={isNew ? t("만들기") : t("저장")}
      command={command}
      problem={"error" in built ? built.error : null}
      failure={failure}
      onSubmit={submit}
      onClose={onClose}
    >
      {host.readOnly ? <ReadOnlyNote /> : entry?.reserved ? <p className="es-admin-note">{t("기본 제공 역할 매핑은 고칠 수 없습니다")}</p> : null}
      {isNew ? (
        <Field label={os ? t("역할 (매핑 이름은 역할 이름입니다)") : t("역할 매핑 이름")}>
          {os ? (
            <SuggestInput type="text" className="mg-input mono" spellCheck={false} autoFocus suggestions={roleNames} placeholder={t("역할 이름")} value={name} onChange={(event) => { setName(event.target.value); setFailure(null); }} />
          ) : (
            <input type="text" className="mg-input mono" spellCheck={false} autoFocus value={name} onChange={(event) => { setName(event.target.value); setFailure(null); }} />
          )}
        </Field>
      ) : null}
      {os ? (
        <>
          <Field label={t("설명")}>
            <input type="text" className="mg-input" disabled={readOnly} value={description} onChange={(event) => setDescription(event.target.value)} />
          </Field>
          <Field label={t("사용자 (users)")}>
            <TokenInput values={users} onChange={(v) => { setUsers(v); setFailure(null); }} suggestions={userNames} readOnly={readOnly} ariaLabel={t("사용자")} />
          </Field>
          <Field label={t("백엔드 역할 (backend_roles)")}>
            <TokenInput values={backendRoles} onChange={(v) => { setBackendRoles(v); setFailure(null); }} readOnly={readOnly} ariaLabel={t("백엔드 역할")} />
          </Field>
          <Field label={t("호스트 (hosts)")}>
            <TokenInput values={hosts} onChange={(v) => { setHosts(v); setFailure(null); }} readOnly={readOnly} ariaLabel={t("호스트")} placeholder="10.0.0.*" />
          </Field>
        </>
      ) : (
        <>
          <label className="es-check">
            <input type="checkbox" disabled={readOnly} checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            {t("사용 (enabled)")}
          </label>
          <Field label={t("줄 역할 (roles)")}>
            <TokenInput values={roles} onChange={(v) => { setRoles(v); setFailure(null); }} suggestions={roleNames} readOnly={readOnly} ariaLabel={t("역할")} placeholder={t("역할 이름")} />
          </Field>
          {templates ? <p className="panel-dim">{t("역할 템플릿(role_templates)은 그대로 둡니다")}</p> : null}
          <div className="mg-form-row">
            <div className="es-sec-row-head">
              <span className="mg-form-label">{t("규칙 (rules)")}</span>
              <span className="spacer" />
              {readOnly ? null : (
                <Select
                  className="mg-input es-sec-template"
                  aria-label={t("템플릿 넣기")}
                  value=""
                  onChange={(event) => {
                    const template = RULE_TEMPLATES[Number(event.target.value)];
                    if (template !== undefined) {
                      setRules(stringifyJson(template.rules, 2));
                      setFailure(null);
                    }
                  }}
                >
                  <option value="">{t("템플릿 넣기…")}</option>
                  {RULE_TEMPLATES.map((template, i) => (
                    <option key={template.label} value={i}>
                      {t(template.label)}
                    </option>
                  ))}
                </Select>
              )}
            </div>
            <SearchEditor
              value={rules}
              onChange={(next) => {
                setRules(next);
                setFailure(null);
              }}
              onRun={submit}
              readOnly={readOnly}
              error={editorError(parsedRules)}
              placeholder={'{ "field": { "username": "*" } }'}
              className="es-settings-editor"
              ariaLabel={t("규칙")}
            />
            <FieldError id="es-sec-rules" error={"error" in parsedRules ? parsedRules.error : null} />
          </div>
        </>
      )}
    </SecurityModal>
  );
}

// ---- API 키 ----

const EXPIRY_CHOICES = ["", "1d", "7d", "30d", "90d", "365d", "custom"] as const;
type ExpiryChoice = (typeof EXPIRY_CHOICES)[number];

// OpenSearch refuses keys that never expire and, by default, any longer than
// 90 days (`max_duration_seconds`), so it gets neither choice.
const OS_EXPIRY_CHOICES: readonly ExpiryChoice[] = ["1d", "7d", "30d", "90d", "custom"];

function expiryLabel(choice: ExpiryChoice): string {
  switch (choice) {
    case "":
      return t("만료 없음");
    case "custom":
      return t("직접 입력");
    default:
      return t("{n}일", { n: Number(choice.slice(0, -1)) });
  }
}

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

// `12h` as seconds; null when it isn't a whole number and a unit.
function durationSeconds(text: string): number | null {
  const m = /^(\d+)\s*([smhd])$/.exec(text.trim());
  return m === null ? null : Number(m[1]) * UNIT_SECONDS[m[2]];
}

const DESCRIPTOR_TEMPLATES: { label: string; value: Json }[] = [
  { label: "읽기 전용 (인덱스 패턴)", value: { reader: { cluster: ["monitor"], indices: [{ names: ["logs-*"], privileges: ["read", "view_index_metadata"] }] } } },
  { label: "쓰기 (인덱스 패턴)", value: { writer: { cluster: ["monitor"], indices: [{ names: ["logs-*"], privileges: ["create_doc", "auto_configure"] }] } } },
  { label: "모니터링만", value: { monitor: { cluster: ["monitor"] } } },
];

const OS_KEY_TEMPLATE: Json = { cluster_permissions: ["cluster_monitor"], index_permissions: [{ index_pattern: ["logs-*"], allowed_actions: ["read"] }] };

export function ApiKeyDialog({ ctx, onClose, onCreated }: { ctx: SecurityContext; onClose(): void; onCreated(): void }) {
  const { host, os } = ctx;
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState<ExpiryChoice>("30d");
  const [custom, setCustom] = useState("");
  const [rights, setRights] = useState(os ? stringifyJson(OS_KEY_TEMPLATE, 2) : "");
  const [metadata, setMetadata] = useState("");
  const [created, setCreated] = useState<Record<string, unknown> | null>(null);
  const { busy, failure, setFailure, send } = useSend(ctx);
  const trimmed = name.trim();
  const parsedRights = useMemo(() => parseObject(rights, os ? t("권한은 JSON 객체여야 합니다") : t("역할 설명(role_descriptors)은 JSON 객체여야 합니다")), [rights, os]);
  const parsedMetadata = useMemo(() => parseObject(metadata, t("메타데이터는 JSON 객체여야 합니다")), [metadata]);

  const built = useMemo((): { body: JsonObject } | { error: string } => {
    if (trimmed === "") {
      return { error: t("키 이름을 쓰세요") };
    }
    if (os && !/^[A-Za-z0-9_-]+$/.test(trimmed)) {
      return { error: t("OpenSearch API 키 이름에는 영문, 숫자, _, -만 쓸 수 있습니다") };
    }
    const expiryText = expiry === "custom" ? custom.trim() : expiry;
    const seconds = expiryText === "" ? null : durationSeconds(expiryText);
    if (expiryText !== "" && seconds === null) {
      return { error: t("만료는 숫자와 단위로 쓰세요 (예: 12h, 7d; 단위 s·m·h·d)") };
    }
    if (os && seconds === null) {
      return { error: t("OpenSearch API 키에는 만료가 필요합니다 (기본 최대 90일)") };
    }
    if ("error" in parsedRights) {
      return { error: parsedRights.error };
    }
    if (os) {
      return { body: { name: trimmed, ...(seconds !== null ? { duration_seconds: seconds } : {}), ...(parsedRights.value ?? {}) } };
    }
    if ("error" in parsedMetadata) {
      return { error: parsedMetadata.error };
    }
    const out: JsonObject = { name: trimmed };
    if (expiryText !== "") {
      out.expiration = expiryText.replace(/\s+/g, "");
    }
    if (parsedRights.value !== null) {
      out.role_descriptors = parsedRights.value;
    }
    if (parsedMetadata.value !== null) {
      out.metadata = parsedMetadata.value;
    }
    return { body: out };
  }, [trimmed, os, expiry, custom, parsedRights, parsedMetadata]);

  const command = "body" in built ? requestText("POST", apiKeyPath(os), built.body) : null;

  function submit(): void {
    if (!("body" in built) || command === null) {
      return;
    }
    const keyBody = built.body;
    void send(
      { title: t("API 키 만들기"), message: t("API 키 {name}을(를) 만들까요?\n키는 만든 직후 한 번만 보여 줍니다.", { name: trimmed }), command, okLabel: t("만들기") },
      async () => setCreated(await createApiKey(host.conn, keyBody)),
      () => undefined,
    );
  }

  if (created !== null) {
    return <ApiKeyCreated os={os} created={created} onCopy={(text, what) => void writeClipboard(text, host.notify).then(() => host.notify(t("{what}을(를) 복사했습니다", { what })))} onClose={onCreated} />;
  }

  return (
    <SecurityModal title={t("API 키 만들기")} wide busy={busy} readOnly={host.readOnly} okLabel={t("만들기")} command={command} problem={"error" in built ? built.error : null} failure={failure} onSubmit={submit} onClose={onClose}>
      {host.readOnly ? <ReadOnlyNote /> : null}
      <div className="mg-form-grid">
        <Field label={t("키 이름")}>
          <input
            type="text"
            className="mg-input mono"
            spellCheck={false}
            autoFocus
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setFailure(null);
            }}
          />
        </Field>
        <Field label={t("만료")}>
          <div className="es-sec-expiry">
            <Select className="mg-input" aria-label={t("만료")} value={expiry} onChange={(event) => setExpiry(event.target.value as ExpiryChoice)}>
              {(os ? OS_EXPIRY_CHOICES : EXPIRY_CHOICES).map((choice) => (
                <option key={choice} value={choice}>
                  {expiryLabel(choice)}
                </option>
              ))}
            </Select>
            {expiry === "custom" ? <input type="text" className="mg-input mono" spellCheck={false} placeholder="12h" aria-label={t("만료")} value={custom} onChange={(event) => setCustom(event.target.value)} /> : null}
          </div>
        </Field>
      </div>
      <div className="mg-form-row">
        <div className="es-sec-row-head">
          <span className="mg-form-label">{os ? t("권한 (cluster_permissions, index_permissions)") : t("역할 설명 (role_descriptors, 비우면 만드는 사용자의 권한 그대로)")}</span>
          <span className="spacer" />
          {os ? null : (
            <Select
              className="mg-input es-sec-template"
              aria-label={t("템플릿 넣기")}
              value=""
              onChange={(event) => {
                const template = DESCRIPTOR_TEMPLATES[Number(event.target.value)];
                if (template !== undefined) {
                  setRights(stringifyJson(template.value, 2));
                  setFailure(null);
                }
              }}
            >
              <option value="">{t("템플릿 넣기…")}</option>
              {DESCRIPTOR_TEMPLATES.map((template, i) => (
                <option key={template.label} value={i}>
                  {t(template.label)}
                </option>
              ))}
            </Select>
          )}
        </div>
        <SearchEditor
          value={rights}
          onChange={(next) => {
            setRights(next);
            setFailure(null);
          }}
          onRun={submit}
          error={editorError(parsedRights)}
          placeholder={'{ "reader": { "indices": [ { "names": ["logs-*"], "privileges": ["read"] } ] } }'}
          className="es-settings-editor"
          ariaLabel={os ? t("권한") : t("역할 설명")}
        />
        <FieldError id="es-sec-rights" error={"error" in parsedRights ? parsedRights.error : null} />
        <span className="panel-dim">{os ? t("키의 권한은 만드는 사용자의 권한을 넘지 못합니다") : t("키의 권한은 역할 설명과 만드는 사용자 권한의 교집합입니다")}</span>
      </div>
      {os ? null : (
        <Field label={t("메타데이터 (선택)")}>
          <SearchEditor value={metadata} onChange={setMetadata} error={editorError(parsedMetadata)} placeholder={'{ "team": "ci" }'} className="es-filter-editor es-sec-query" ariaLabel={t("메타데이터")} />
          <FieldError id="es-sec-metadata" error={"error" in parsedMetadata ? parsedMetadata.error : null} />
        </Field>
      )}
    </SecurityModal>
  );
}

// The new key, shown once: what goes in the `Authorization: ApiKey …` header
// (Elasticsearch's `encoded`, OpenSearch's `token`) with a copy button.
function ApiKeyCreated({ os, created, onCopy, onClose }: { os: boolean; created: Record<string, unknown>; onCopy(text: string, what: string): void; onClose(): void }) {
  const text = (key: string) => (typeof created[key] === "string" ? (created[key] as string) : "");
  const secret = os ? text("token") : text("encoded");
  const rows: [string, string][] = [
    ["ID", text("id")],
    ...(os ? [] : ([[t("이름"), text("name")], [t("비밀 (api_key)"), text("api_key")]] as [string, string][])),
  ];
  const expiration = typeof created.expiration === "number" ? new Date(created.expiration).toLocaleString() : null;
  return (
    <AdminModal
      title={t("API 키를 만들었습니다")}
      busy={false}
      className="es-modal wide"
      onClose={onClose}
      foot={
        <>
          <span className="spacer" />
          <button type="button" className="primary" onClick={onClose}>
            {t("닫기")}
          </button>
        </>
      }
    >
      <div className="mg-verdict warn">{t("이 키는 지금 한 번만 보입니다. 닫기 전에 복사해 안전한 곳에 두세요.")}</div>
      <div className="mg-form-row">
        <span className="mg-form-label">{os ? t("토큰 (Authorization: ApiKey 뒤에 씁니다)") : t("인코딩된 키 (Authorization: ApiKey 뒤에 씁니다)")}</span>
        <div className="es-sec-secret">
          <code className="mono">{secret || "—"}</code>
          <button type="button" className="icon-text-button" disabled={secret === ""} onClick={() => onCopy(secret, t("키"))}>
            <CopyIcon size={10} />
            {t("복사")}
          </button>
        </div>
      </div>
      {secret !== "" ? (
        <div className="mg-form-row">
          <span className="mg-form-label">{t("헤더")}</span>
          <div className="es-sec-secret">
            <code className="mono">{`Authorization: ApiKey ${secret}`}</code>
            <button type="button" className="icon-text-button" onClick={() => onCopy(`Authorization: ApiKey ${secret}`, t("헤더"))}>
              <CopyIcon size={10} />
              {t("복사")}
            </button>
          </div>
        </div>
      ) : null}
      <table className="panel-table es-sec-key-facts">
        <tbody>
          {rows.map(([label, value]) => (
            <tr key={label}>
              <td className="panel-dim">{label}</td>
              <td className="mono">{value || "—"}</td>
            </tr>
          ))}
          {expiration !== null ? (
            <tr>
              <td className="panel-dim">{t("만료")}</td>
              <td>{expiration}</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </AdminModal>
  );
}
