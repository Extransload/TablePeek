import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { getConnMeta, setConnMeta } from "../connMeta";
import { engineById, engines, unsupportedEngine, type ConnectionField, type Engine } from "../engines";
import {
  basename,
  choiceValues,
  configFromValues,
  defaultValues,
  fieldFor,
  fieldVisible,
  optionsOf,
  parseConnectionUrl,
  staleUrlValues,
  valuesFromConfig,
  type FormValues,
} from "../engines/connection";
import { t } from "../i18n";
import { confirmDialog } from "./ConfirmDialog";
import {
  ApiRequestError,
  missingSecretOf,
  store,
  type MissingSecret,
  type ConnectInput,
  type ConnectSecrets,
  type LiveConn,
  type SavedConnection,
} from "../store";
import { DriverIcon } from "./DriverIcon";
import { ErrorNotice } from "./ErrorNotice";
import { FilePickerModal } from "./FilePickerModal";
import {
  CheckIcon,
  CloseIcon,
  DatabaseIcon,
  EyeIcon,
  EyeOffIcon,
  FileIcon,
  LinkPasteIcon,
} from "./icons";
import { Spinner } from "./Spinner";
import { Select } from "./Select";

interface ConnectModalProps {
  // Saved profile to edit; omitted for a new connection.
  editing?: SavedConnection | null;
  // Live connection already opened from this profile, if any.
  openConnId?: string | null;
  notice?: string | null;
  // Secret the dialog was opened to ask for (focused and highlighted).
  missingSecret?: MissingSecret | null;
  // Picked on the home screen before opening a new connection: an engine id,
  // the group to save into (its id), or a connection URL to fill the form from.
  initialDriver?: string | null;
  initialGroup?: string | null;
  initialUrl?: string | null;
  onClose(): void;
  onConnected(result: LiveConn): void;
  onSaved(): void;
  onSwitch(connId: string): void;
}

type SshAuth = "password" | "key";
// The SSH key's file slot; every other file slot is one of the engine's fields.
const SSH_KEY = "sshKeyPath";

interface ConnectForm {
  // The engine's id.
  driver: string;
  name: string;
  color: string;
  group: string;
  tags: string;
  // The engine's connection fields, by key. Values of fields another engine
  // had stay here while switching, so switching back keeps them.
  values: FormValues;
  persistPassword: boolean;
  sshEnabled: boolean;
  sshHost: string;
  sshPort: string;
  sshUser: string;
  sshAuth: SshAuth;
  sshPassword: string;
  sshKeyPath: string;
  httpEnabled: boolean;
  httpHost: string;
  httpPort: string;
  httpUser: string;
  httpPassword: string;
}

// A change to the form outside the engine's fields (those go through updateValues).
type FormPatch = Partial<Omit<ConnectForm, "values">>;

interface Problem {
  // A connection field's key, or one of the tunnel fields ("sshHost", …).
  field: string;
  message: string;
}

interface Status {
  kind: "ok" | "error" | "info";
  text: string;
  // What the server said, for an error it gave (its code, SQLSTATE, …).
  error?: unknown;
}

function errorStatus(err: unknown, fallback: string): Status {
  return { kind: "error", text: err instanceof Error ? err.message : fallback, error: err };
}

const SWATCHES = ["#22c55e", "#3b82f6", "#a855f7", "#f59e0b", "#ef4444", "#64748b"];

const EMPTY_FORM: Omit<ConnectForm, "driver" | "values"> = {
  name: "",
  color: "",
  group: "",
  tags: "",
  // New profiles keep their passwords in the OS keychain unless told otherwise.
  persistPassword: true,
  sshEnabled: false,
  sshHost: "",
  sshPort: "22",
  sshUser: "",
  sshAuth: "password",
  sshPassword: "",
  sshKeyPath: "",
  httpEnabled: false,
  httpHost: "",
  httpPort: "3128",
  httpUser: "",
  httpPassword: "",
};

function newForm(engine: Engine | undefined, driver: string): ConnectForm {
  return { ...EMPTY_FORM, driver: engine?.id ?? driver, values: engine ? defaultValues(engine) : {} };
}

function formFromSaved(saved: SavedConnection): ConnectForm {
  const engine = engineById(saved.driver);
  const meta = getConnMeta(saved.id);
  const keyPath = saved.ssh?.private_key_path ?? "";
  return {
    ...EMPTY_FORM,
    driver: engine?.id ?? saved.driver,
    values: engine ? valuesFromConfig(engine, saved.config) : {},
    name: saved.name,
    color: meta?.color ?? "",
    group: meta?.group ?? "",
    tags: (meta?.tags ?? []).join(", "),
    persistPassword: saved.persist_password,
    sshEnabled: saved.ssh !== undefined,
    sshHost: saved.ssh?.host ?? "",
    sshPort: saved.ssh ? String(saved.ssh.port) : "22",
    sshUser: saved.ssh?.user ?? "",
    sshAuth: keyPath.trim() !== "" ? "key" : "password",
    sshKeyPath: keyPath,
    httpEnabled: saved.http_tunnel !== undefined,
    httpHost: saved.http_tunnel?.host ?? "",
    httpPort: saved.http_tunnel ? String(saved.http_tunnel.port) : "3128",
    httpUser: saved.http_tunnel?.username ?? "",
  };
}

const URL_LIKE = /^(jdbc:)?[a-z][a-z0-9+.-]*:\/\//i;

type Action = "save" | "test" | "connect";

// A footer button pressed with the mouse leaves the focus where it is: a
// field left by the press would fill from a typed URL and move the buttons
// before the release (see act).
function keepFocus(event: ReactMouseEvent): void {
  event.preventDefault();
}

// The engine's password: the first secret field, the one the keychain keeps
// as the profile's own secret.
function passwordField(engine: Engine): ConnectionField | undefined {
  return engine.connection.fields.find((field) => field.type === "secret");
}

// The form field a missing secret is typed into.
function secretFieldOf(secret: MissingSecret, engine: Engine | undefined): string {
  if (secret === "ssh") {
    return "sshPassword";
  }
  if (secret === "http") {
    return "httpPassword";
  }
  return (engine && passwordField(engine)?.key) ?? "password";
}

function text(values: FormValues, key: string): string {
  const value = values[key];
  return typeof value === "string" ? value : "";
}

function autoName(engine: Engine | undefined, form: ConnectForm): string {
  if (engine === undefined) {
    return form.driver;
  }
  if (engine.transport === "file") {
    const path = engine.connection.fields.find((field) => field.type === "path");
    return (path && basename(text(form.values, path.key).trim())) || engine.label;
  }
  const host = text(form.values, "host").trim() || "localhost";
  const database = text(form.values, "database").trim();
  return database === "" ? host : `${database} @ ${host}`;
}

function validPort(value: string): boolean {
  const port = Number(value.trim());
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

// "사용자를", "호스트를", "비밀번호를": the object particle that fits the word.
function withObjectParticle(word: string): string {
  const code = word.charCodeAt(word.length - 1) - 0xac00;
  if (code < 0 || code > 11171) {
    return `${word}을(를)`;
  }
  return `${word}${code % 28 === 0 ? "를" : "을"}`;
}

function buildInput(engine: Engine, form: ConnectForm): ConnectInput {
  const input: ConnectInput = { driver: engine.id, config: configFromValues(engine, form.values) };
  const tunnels = engine.connection.tunnels;
  if (form.sshEnabled && tunnels.includes("ssh")) {
    const useKey = form.sshAuth === "key";
    input.ssh = {
      host: form.sshHost.trim(),
      port: Number(form.sshPort.trim()),
      user: form.sshUser.trim(),
      private_key_path: useKey ? form.sshKeyPath.trim() : "",
      ...(!useKey && form.sshPassword !== "" ? { password: form.sshPassword } : {}),
    };
  } else if (form.httpEnabled && tunnels.includes("http")) {
    input.http_tunnel = {
      host: form.httpHost.trim(),
      port: Number(form.httpPort.trim()),
      ...(form.httpUser !== "" ? { username: form.httpUser } : {}),
      ...(form.httpPassword !== "" ? { password: form.httpPassword } : {}),
    };
  }
  return input;
}

// "save" only needs a well-formed profile; "connect" also needs what the server will ask for.
function problemsOf(
  engine: Engine,
  form: ConnectForm,
  purpose: "save" | "connect",
  storedSecrets: boolean,
): Problem[] {
  const problems: Problem[] = [];
  // Stored secrets only count while the profile keeps storing them.
  const hasStored = storedSecrets && form.persistPassword;
  for (const spec of engine.connection.fields) {
    if (!fieldVisible(spec, form.values)) {
      continue;
    }
    const field = fieldFor(spec, form.values);
    const value = text(form.values, field.key).trim();
    const label = t(field.label ?? field.key);
    if (field.type === "port") {
      if (!validPort(value)) {
        problems.push({ field: field.key, message: t("포트가 올바르지 않습니다") });
      }
      continue;
    }
    const needed =
      field.required === true ||
      (purpose === "connect" && field.required_to_connect === true) ||
      (field.required_unless !== undefined && text(form.values, field.required_unless).trim() === "");
    if (needed && value === "") {
      problems.push({
        field: field.key,
        message:
          field.type === "path"
            ? t(`${engine.label} 파일 경로를 입력하세요`)
            : t(`${withObjectParticle(field.label ?? field.key)} 입력하세요`),
      });
    } else if (field.type === "host" && (value.includes("://") || /[\s/@?]/.test(value))) {
      problems.push({ field: field.key, message: t("호스트에는 주소만 입력하세요 (URL·계정 정보 제외)") });
    } else if (field.type === "number" && value !== "" && !Number.isFinite(Number(value))) {
      problems.push({ field: field.key, message: t("{label}: 숫자를 입력하세요", { label }) });
    }
  }
  // A client certificate goes with its key.
  const cert = engine.connection.fields.find((field) => field.key === "ssl_client_cert");
  if (
    cert !== undefined &&
    fieldVisible(cert, form.values) &&
    (text(form.values, "ssl_client_cert").trim() === "") !== (text(form.values, "ssl_client_key").trim() === "")
  ) {
    problems.push({
      field: text(form.values, "ssl_client_cert").trim() === "" ? "ssl_client_cert" : "ssl_client_key",
      message: t("클라이언트 인증서와 키는 함께 지정하세요"),
    });
  }
  const tunnels = engine.connection.tunnels;
  if (form.sshEnabled && tunnels.includes("ssh")) {
    if (form.sshHost.trim() === "") {
      problems.push({ field: "sshHost", message: t("SSH 서버를 입력하세요") });
    }
    if (!validPort(form.sshPort)) {
      problems.push({ field: "sshPort", message: t("SSH 포트가 올바르지 않습니다") });
    }
    if (form.sshUser.trim() === "") {
      problems.push({ field: "sshUser", message: t("SSH 사용자를 입력하세요") });
    }
    if (form.sshAuth === "key" && form.sshKeyPath.trim() === "") {
      problems.push({ field: "sshKeyPath", message: t("SSH 키 파일을 선택하세요") });
    }
    if (
      purpose === "connect" &&
      form.sshAuth === "password" &&
      form.sshPassword === "" &&
      !hasStored
    ) {
      problems.push({ field: "sshPassword", message: t("SSH 비밀번호를 입력하세요") });
    }
  }
  if (form.httpEnabled && tunnels.includes("http")) {
    if (form.httpHost.trim() === "") {
      problems.push({ field: "httpHost", message: t("프록시 호스트를 입력하세요") });
    }
    if (!validPort(form.httpPort)) {
      problems.push({ field: "httpPort", message: t("프록시 포트가 올바르지 않습니다") });
    }
    if (form.httpPassword !== "" && form.httpUser === "") {
      problems.push({ field: "httpUser", message: t("프록시 사용자를 입력하세요") });
    }
    if (purpose === "connect" && form.httpUser !== "" && form.httpPassword === "" && !hasStored) {
      problems.push({ field: "httpPassword", message: t("프록시 비밀번호를 입력하세요") });
    }
  }
  return problems;
}

function Row({ label, children, htmlFor }: { label: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="cm-row">
      <label className="cm-label" htmlFor={htmlFor}>
        {label}
      </label>
      <div className="cm-value">{children}</div>
    </div>
  );
}

function FileSlot({
  label,
  value,
  invalid,
  onPick,
  onClear,
}: {
  label: string;
  value: string;
  invalid: boolean;
  onPick(): void;
  onClear(): void;
}) {
  const set = value.trim() !== "";
  return (
    <div className={`cm-file${set ? " set" : ""}${invalid ? " invalid" : ""}`}>
      <button type="button" className="cm-file-pick" onClick={onPick} title={set ? value : `${label}…`}>
        <FileIcon size={11} />
        <span className="cm-file-text">{set ? basename(value) : `${label}…`}</span>
      </button>
      {set ? (
        <button
          type="button"
          className="cm-file-clear"
          onClick={onClear}
          title={t("{label} 지우기", { label })}
          aria-label={t("{label} 지우기", { label })}
        >
          <CloseIcon size={9} />
        </button>
      ) : null}
    </div>
  );
}

export function ConnectModal({
  editing = null,
  openConnId = null,
  notice = null,
  missingSecret = null,
  initialDriver = null,
  initialGroup = null,
  initialUrl = null,
  onClose,
  onConnected,
  onSaved,
  onSwitch,
}: ConnectModalProps) {
  // The group isn't edited here (the home list owns it); the form only carries
  // it so saving keeps an existing group or files a new connection into one.
  // Parsed once: only the initial form and status read it.
  const [parsedUrl] = useState(() =>
    editing === null && initialUrl !== null ? parseConnectionUrl(initialUrl) : null,
  );
  const [form, setForm] = useState<ConnectForm>(() => {
    if (editing !== null) {
      return formFromSaved(editing);
    }
    if (parsedUrl !== null) {
      const base = newForm(parsedUrl.engine, parsedUrl.engine.id);
      return { ...base, values: { ...base.values, ...parsedUrl.values }, group: initialGroup ?? "" };
    }
    // The picked engine, or with nothing picked the first server engine.
    const engine =
      initialDriver !== null
        ? engineById(initialDriver)
        : engines().find((candidate) => candidate.transport === "server");
    return { ...newForm(engine, initialDriver ?? ""), group: initialGroup ?? "" };
  });
  const engine = engineById(form.driver);
  const [savedId, setSavedId] = useState<string | null>(editing?.id ?? null);
  const [storedSecrets, setStoredSecrets] = useState(editing?.persist_password ?? false);
  // The engine's advanced fields: folded unless one was changed from its default.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [problems, setProblems] = useState<Problem[]>(() =>
    missingSecret !== null && notice !== null
      ? [{ field: secretFieldOf(missingSecret, engine), message: notice }]
      : [],
  );
  const [status, setStatus] = useState<Status | null>(() => {
    if (engine === undefined) {
      return { kind: "error", text: unsupportedEngine(form.driver) };
    }
    if (notice !== null) {
      return { kind: "info", text: notice };
    }
    if (initialUrl === null || editing !== null) {
      return null;
    }
    return parsedUrl === null
      ? { kind: "error", text: t("연결 URL을 인식하지 못했습니다") }
      : { kind: "ok", text: t("URL에서 접속 정보를 채웠습니다") };
  });
  const [busy, setBusy] = useState<Action | null>(null);
  // An action to run once the changed form renders: an error's fix tests
  // again, a button pressed straight after typing a URL runs after the fill.
  const [queued, setQueued] = useState<Action | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [picker, setPicker] = useState<{ field: string; title: string } | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const sshPasswordRef = useRef<HTMLInputElement | null>(null);
  const httpPasswordRef = useRef<HTMLInputElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const saveRef = useRef<() => void>(() => {});
  const requestCloseRef = useRef<() => void>(() => {});
  const pickerOpenRef = useRef(false);
  const pickingRef = useRef(false);
  const initialRef = useRef(form);
  const backdropDownRef = useRef(false);
  // The keys the last connection URL filled that no hand has changed since
  // (see staleUrlValues), and a URL typed into a host or connection-string
  // field that hasn't filled the form yet.
  const urlFilledRef = useRef<Set<string>>(new Set(parsedUrl !== null ? Object.keys(parsedUrl.values) : []));
  const pendingFillRef = useRef<{ field: ConnectionField; typed: string } | null>(null);
  pickerOpenRef.current = picker !== null;

  function focusSecret(secret: MissingSecret): void {
    const ref = secret === "ssh" ? sshPasswordRef : secret === "http" ? httpPasswordRef : passwordRef;
    ref.current?.focus();
  }

  useEffect(() => {
    if (missingSecret !== null) {
      focusSecret(missingSecret);
    } else {
      nameRef.current?.focus();
    }
  }, [missingSecret]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        void requestCloseRef.current();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && (event.key === "s" || event.key === "S")) {
        event.preventDefault();
        if (!pickerOpenRef.current) {
          saveRef.current();
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const invalid = new Set(problems.map((problem) => problem.field));
  // An invalid field points at the error box that says why.
  const invalidProps = (key: string): { "aria-invalid"?: true; "aria-describedby"?: string } =>
    invalid.has(key) ? { "aria-invalid": true, "aria-describedby": "cm-error" } : {};
  const isEdit = savedId !== null;
  const color = form.color || "var(--accent)";

  function update(patch: FormPatch): void {
    setForm((prev) => ({ ...prev, ...patch }));
    setProblems((prev) => (prev.length === 0 ? prev : []));
    setStatus((prev) => (prev?.kind === "info" ? prev : null));
  }

  function updateValues(patch: FormValues): void {
    for (const key of Object.keys(patch)) {
      urlFilledRef.current.delete(key);
    }
    setForm((prev) => ({ ...prev, values: { ...prev.values, ...patch } }));
    setProblems((prev) => (prev.length === 0 ? prev : []));
    setStatus((prev) => (prev?.kind === "info" ? prev : null));
  }

  // Closing is ignored mid-request, and asks before dropping unsaved edits.
  async function requestClose(): Promise<void> {
    if (busy !== null) {
      return;
    }
    const dirty = JSON.stringify(form) !== JSON.stringify(initialRef.current);
    if (
      dirty &&
      !(await confirmDialog({
        title: t("변경사항 버리기"),
        message: t("저장하지 않은 변경사항이 있습니다. 닫을까요?"),
        confirmLabel: t("버리기"),
        danger: true,
      }))
    ) {
      return;
    }
    onClose();
  }
  requestCloseRef.current = requestClose;

  // Another engine keeps what was typed; its fields that weren't filled yet
  // start at their defaults, and a port still at some engine's default takes the new one's.
  function changeDriver(next: Engine, patch: FormValues = {}): void {
    const port = text(form.values, "port").trim();
    const knownPort = engines().some((candidate) => String(candidate.default_port ?? "") === port);
    const values: FormValues = { ...defaultValues(next), ...form.values };
    if (port === "" || knownPort) {
      values.port = next.default_port !== undefined ? String(next.default_port) : "";
    }
    setForm((prev) => ({ ...prev, driver: next.id, values: { ...values, ...patch } }));
    setProblems((prev) => (prev.length === 0 ? prev : []));
    setStatus((prev) => (prev?.kind === "info" ? prev : null));
  }

  // A pasted connection URL fills the form (switching to the engine it names)
  // instead of landing in the field, and takes back what the previous URL
  // filled but this one doesn't say (see staleUrlValues).
  function pasteUrl(pasted: string): void {
    pendingFillRef.current = null;
    const parsed = parseConnectionUrl(pasted);
    if (parsed === null) {
      setStatus({ kind: "error", text: t("연결 URL을 인식하지 못했습니다") });
      return;
    }
    const stale = staleUrlValues(parsed.engine, form.values, urlFilledRef.current, parsed.values);
    changeDriver(parsed.engine, { ...stale, ...parsed.values });
    urlFilledRef.current = new Set(Object.keys(parsed.values));
    setStatus({
      kind: "ok",
      text: /sslmode=verify/i.test(pasted)
        ? t("URL에서 채웠습니다 · verify 모드는 Require로 설정했습니다")
        : t("URL에서 접속 정보를 채웠습니다"),
    });
  }

  // A URL typed (rather than pasted) into a host or connection-string field
  // fills the form the same way once the field is left or Enter is pressed.
  // True when it did something, so Enter fills instead of connecting; a
  // connection string already in its kept form (a seed list or SRV name
  // without its password) is left alone.
  function fillFromTyped(field: ConnectionField, typed: string): boolean {
    pendingFillRef.current = null;
    const trimmed = typed.trim();
    if (!URL_LIKE.test(trimmed)) {
      return false;
    }
    const parsed = parseConnectionUrl(trimmed);
    if (field.type !== "host" && (field.fills_others !== true || parsed === null)) {
      return false;
    }
    if (parsed !== null && field.type !== "host" && parsed.values[field.key] === trimmed && parsed.values.password === undefined) {
      // Only the authentication follows a string kept as typed: it says
      // whether there is a user (or X.509) to sign in with.
      const auth = engine?.connection.fields.find((candidate) => candidate.key === "auth");
      const implied = parsed.values.auth;
      if (auth === undefined || typeof implied !== "string" || implied === form.values.auth) {
        return false;
      }
      const chosen = choiceValues(auth, implied);
      updateValues(chosen);
      for (const key of Object.keys(chosen)) {
        urlFilledRef.current.add(key);
      }
      return true;
    }
    pasteUrl(trimmed);
    return true;
  }

  function check(purpose: "save" | "connect"): boolean {
    if (engine === undefined) {
      setStatus({ kind: "error", text: unsupportedEngine(form.driver) });
      return false;
    }
    const found = problemsOf(engine, form, purpose, storedSecrets);
    setProblems(found);
    if (found.length > 0) {
      setStatus({ kind: "error", text: found[0].message });
      return false;
    }
    return true;
  }

  // Files the form points at must be there and readable; a file engine's
  // database file is checked on save as well.
  async function checkFiles(purpose: "save" | "connect"): Promise<boolean> {
    if (engine === undefined) {
      return false;
    }
    const files: { field: ConnectionField; path: string }[] = [];
    for (const field of engine.connection.fields) {
      const path = text(form.values, field.key).trim();
      const wanted = field.type === "path" || (purpose === "connect" && field.type === "file");
      if (wanted && path !== "" && fieldVisible(field, form.values)) {
        files.push({ field, path });
      }
    }
    if (purpose === "connect" && form.sshEnabled && form.sshAuth === "key" && form.sshKeyPath.trim() !== "") {
      files.push({ field: { key: SSH_KEY, type: "file", label: "SSH 키" }, path: form.sshKeyPath.trim() });
    }
    for (const { field, path } of files) {
      const stat = await store.statPath(path);
      if (!stat.exists || !stat.is_file || !stat.readable) {
        if (field.type === "path") {
          const message = t("데이터베이스 파일을 읽을 수 없습니다: {path}", { path });
          setProblems([{ field: field.key, message }]);
          setStatus({ kind: "error", text: message });
        } else {
          setStatus({
            kind: "error",
            text: t("{label} 파일을 읽을 수 없습니다: {path}", { label: t(field.label ?? field.key), path }),
          });
        }
        return false;
      }
    }
    return true;
  }

  // A password typed before switching to an authentication without one stays
  // in the form but isn't sent.
  function secrets(): ConnectSecrets {
    const password = engine !== undefined ? passwordField(engine) : undefined;
    const typed = password !== undefined && fieldVisible(password, form.values) ? text(form.values, password.key) : "";
    return {
      ...(typed !== "" ? { password: typed } : {}),
      ...(form.sshEnabled && form.sshAuth === "password" && form.sshPassword !== ""
        ? { ssh_password: form.sshPassword }
        : {}),
      ...(form.httpEnabled && form.httpPassword !== "" ? { http_password: form.httpPassword } : {}),
    };
  }

  async function persist(current: Engine): Promise<string> {
    const name = form.name.trim() || autoName(current, form);
    const input = buildInput(current, form);
    // An engine without secrets (a SQLite file) has no password to keep.
    const password = passwordField(current);
    const persistPassword = password !== undefined && form.persistPassword;
    let id = savedId;
    if (id !== null) {
      try {
        await store.updateConnection(id, name, input, persistPassword);
      } catch (err) {
        // Deleted elsewhere while the dialog was open: save it as a new profile.
        if (!(err instanceof ApiRequestError && err.code === "not_found")) {
          throw err;
        }
        id = null;
      }
    }
    if (id === null) {
      id = await store.createConnection(name, input, persistPassword);
      setSavedId(id);
    }
    setConnMeta(id, {
      group: form.group,
      color: form.color,
      tags: form.tags.split(","),
    });
    const typedSecret =
      (password !== undefined && fieldVisible(password, form.values) && text(form.values, password.key) !== "") ||
      form.sshPassword !== "" ||
      form.httpPassword !== "";
    setStoredSecrets(persistPassword && (storedSecrets || typedSecret));
    initialRef.current = form;
    onSaved();
    return id;
  }

  async function save(): Promise<void> {
    if (busy !== null || !check("save") || engine === undefined) {
      return;
    }
    setBusy("save");
    try {
      if (!(await checkFiles("save"))) {
        return;
      }
      await persist(engine);
      onClose();
    } catch (err) {
      setStatus(errorStatus(err, t("저장하지 못했습니다")));
    } finally {
      setBusy(null);
    }
  }
  saveRef.current = () => act("save");

  async function test(): Promise<void> {
    if (busy !== null || !check("connect") || engine === undefined) {
      return;
    }
    setBusy("test");
    setStatus(null);
    try {
      if (!(await checkFiles("connect"))) {
        return;
      }
      const result = await store.testConnection(
        buildInput(engine, form),
        form.persistPassword ? (savedId ?? undefined) : undefined,
      );
      setStatus({
        kind: "ok",
        text: t(
          engine.workbench === "document"
            ? "연결 성공 · {driver} · 컬렉션 {tables}개 · {ms}ms"
            : "연결 성공 · {driver} · 테이블 {tables}개 · {ms}ms",
          {
            driver: engine.label,
            tables: result.tables,
            ms: Math.round(result.elapsed_ms),
          },
        ),
      });
    } catch (err) {
      setStatus(errorStatus(err, t("연결하지 못했습니다")));
    } finally {
      setBusy(null);
    }
  }

  async function connect(): Promise<void> {
    if (busy !== null || !check("connect") || engine === undefined) {
      return;
    }
    setBusy("connect");
    setStatus(null);
    try {
      if (!(await checkFiles("connect"))) {
        return;
      }
      const id = await persist(engine);
      if (openConnId !== null) {
        onSwitch(openConnId);
        return;
      }
      onConnected(await store.connectSaved(id, secrets()));
    } catch (err) {
      const missing = missingSecretOf(err);
      if (missing !== null) {
        const message = err instanceof Error ? t(err.message) : t("비밀번호를 입력하세요");
        setProblems([{ field: secretFieldOf(missing, engine), message }]);
        setStatus({ kind: "error", text: message });
        focusSecret(missing);
      } else {
        setStatus(errorStatus(err, t("연결하지 못했습니다")));
      }
    } finally {
      setBusy(null);
    }
  }

  function run(action: Action): void {
    void (action === "save" ? save() : action === "test" ? test() : connect());
  }

  // A URL typed into a host or connection-string field fills the form when
  // the field is left. The footer's buttons keep the focus when pressed (so
  // the fill can't move them between press and release and lose the click),
  // which leaves the fill to run here, and the action after it renders.
  function act(action: Action): void {
    const pending = pendingFillRef.current;
    if (pending !== null && fillFromTyped(pending.field, pending.typed)) {
      // An unrecognized URL stays in the field with its error.
      if (parseConnectionUrl(pending.typed) !== null) {
        setQueued(action);
      }
      return;
    }
    run(action);
  }

  useEffect(() => {
    if (queued !== null) {
      setQueued(null);
      run(queued);
    }
    // Runs after the changed form has rendered, so the action sees it.
  }, [queued]);

  // One-click versions of the fixes an explained error suggests, where the
  // engine has the setting: the SSL mode, MongoDB's direct connection. Each
  // changes the form and tests again.
  function settingFix(key: string, value: string | boolean): (() => void) | undefined {
    const field = engine?.connection.fields.find((candidate) => candidate.key === key);
    if (field === undefined || busy !== null || form.values[key] === value) {
      return undefined;
    }
    return () => {
      updateValues({ [key]: value });
      setQueued("test");
    };
  }

  function fileValue(field: string): string {
    return field === SSH_KEY ? form.sshKeyPath : text(form.values, field);
  }

  function setFile(field: string, path: string): void {
    if (field === SSH_KEY) {
      update({ sshKeyPath: path });
    } else {
      updateValues({ [field]: path });
    }
  }

  // The system's open dialog, in the current file's folder (an SSH key's in
  // ~/.ssh), showing only the engine's own files for a database path; where
  // there is none, the in-app file list.
  async function pickFile(field: string, title: string, isPath = false): Promise<void> {
    if (pickingRef.current) {
      return;
    }
    pickingRef.current = true;
    const current = fileValue(field).trim();
    const slash = Math.max(current.lastIndexOf("/"), current.lastIndexOf("\\"));
    const dir = slash > 0 ? current.slice(0, slash) : field === SSH_KEY ? "~/.ssh" : undefined;
    const extensions = isPath ? engine?.fileExtensions : undefined;
    const filter = extensions !== undefined && engine !== undefined ? { name: engine.label, extensions } : undefined;
    try {
      const path = await store.pickFile({ title, filter, dir, hidden: field === SSH_KEY });
      if (path !== null) {
        setFile(field, path);
      }
    } catch (err) {
      if (err instanceof ApiRequestError && err.code === "native_picker_unavailable") {
        setPicker({ field, title });
      } else {
        setStatus({ kind: "error", text: err instanceof Error ? err.message : t("파일 선택 창을 열지 못했습니다") });
      }
    } finally {
      pickingRef.current = false;
    }
  }

  const storedPlaceholder = isEdit && storedSecrets ? t("저장된 비밀번호 사용") : "";
  const title =
    editing !== null
      ? t("연결 편집")
      : t("{driver} 연결", { driver: engine?.label ?? form.driver });

  // One input per field kind, laid out as the dialog always has been: a host
  // with its port on one row, the password with its keychain choice, a
  // select as a segmented control, consecutive files of a group as one row
  // of file slots.
  function renderFields(current: Engine, advanced: boolean): ReactNode[] {
    const shown = current.connection.fields
      .filter((field) => (field.advanced === true) === advanced && fieldVisible(field, form.values))
      .map((field) => fieldFor(field, form.values));
    const firstSecret = passwordField(current);
    const rows: ReactNode[] = [];
    for (let index = 0; index < shown.length; index += 1) {
      const field = shown[index];
      const label = t(field.label ?? field.key);
      const value = text(form.values, field.key);
      const id = `cm-${field.key}`;
      const invalidClass = invalid.has(field.key) ? "invalid" : "";
      const next = shown[index + 1];
      if (field.type === "host" || field.type === "uri") {
        const port = field.type === "host" && next?.type === "port" ? next : undefined;
        if (port !== undefined) {
          index += 1;
        }
        rows.push(
          <Row key={field.key} label={label} htmlFor={id}>
            <div className="cm-pair">
              <div className="cm-input-wrap">
                <input
                  id={id}
                  className={invalidClass}
                  {...invalidProps(field.key)}
                  value={value}
                  spellCheck={false}
                  placeholder={field.placeholder !== undefined ? t(field.placeholder) : undefined}
                  onChange={(event) => {
                    pendingFillRef.current = { field, typed: event.target.value };
                    updateValues({ [field.key]: event.target.value });
                  }}
                  onBlur={(event) => void fillFromTyped(field, event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.nativeEvent.isComposing && fillFromTyped(field, event.currentTarget.value)) {
                      event.preventDefault();
                    }
                  }}
                  onPaste={(event) => {
                    const pasted = event.clipboardData.getData("text");
                    if (!URL_LIKE.test(pasted.trim())) {
                      return;
                    }
                    // Never let a URL (and the password inside it) land in a host field;
                    // a connection-string field fills the form, keeping only what
                    // the fields can't say (see parseConnectionUrl).
                    if (field.type === "host") {
                      event.preventDefault();
                    } else if (field.fills_others !== true || parseConnectionUrl(pasted) === null) {
                      return;
                    } else {
                      event.preventDefault();
                    }
                    pasteUrl(pasted);
                  }}
                />
                <LinkPasteIcon size={11} className="cm-input-icon" />
              </div>
              {port !== undefined ? (
                <>
                  <span className="cm-inline-label">{t(port.label ?? port.key)}</span>
                  <input
                    className={`cm-port${invalid.has(port.key) ? " invalid" : ""}`}
                    {...invalidProps(port.key)}
                    inputMode="numeric"
                    value={text(form.values, port.key)}
                    onChange={(event) => updateValues({ [port.key]: event.target.value.replace(/[^0-9]/g, "") })}
                    aria-label={t(port.label ?? port.key)}
                  />
                </>
              ) : null}
            </div>
          </Row>,
        );
      } else if (field.type === "port") {
        rows.push(
          <Row key={field.key} label={label} htmlFor={id}>
            <input
              id={id}
              className={`cm-port${invalid.has(field.key) ? " invalid" : ""}`}
              {...invalidProps(field.key)}
              inputMode="numeric"
              value={value}
              onChange={(event) => updateValues({ [field.key]: event.target.value.replace(/[^0-9]/g, "") })}
            />
          </Row>,
        );
      } else if (field.type === "secret") {
        const own = field.key === firstSecret?.key;
        rows.push(
          <Row key={field.key} label={label} htmlFor={id}>
            <div className="cm-pair">
              <div className="cm-input-wrap">
                <input
                  id={id}
                  ref={own ? passwordRef : undefined}
                  className={invalidClass}
                  {...invalidProps(field.key)}
                  type={showPassword ? "text" : "password"}
                  value={value}
                  placeholder={
                    storedPlaceholder !== "" ? storedPlaceholder : field.placeholder !== undefined ? t(field.placeholder) : undefined
                  }
                  autoComplete="new-password"
                  onChange={(event) => updateValues({ [field.key]: event.target.value })}
                />
                <button
                  type="button"
                  className="cm-eye"
                  onClick={() => setShowPassword((shownNow) => !shownNow)}
                  title={showPassword ? t("비밀번호 숨기기") : t("비밀번호 보기")}
                  aria-label={showPassword ? t("비밀번호 숨기기") : t("비밀번호 보기")}
                >
                  {showPassword ? <EyeOffIcon size={11} /> : <EyeIcon size={11} />}
                </button>
              </div>
              {own ? (
                <Select
                  className="cm-store"
                  value={form.persistPassword ? "keychain" : "none"}
                  onChange={(event) => update({ persistPassword: event.target.value === "keychain" })}
                  title={t("DB·SSH·프록시 비밀번호 저장 방식")}
                >
                  <option value="keychain">{t("키체인에 저장")}</option>
                  <option value="none">{t("매번 입력")}</option>
                </Select>
              ) : null}
            </div>
          </Row>,
        );
      } else if (field.type === "select" && optionsOf(field).length > 3) {
        // Too many choices for one row of buttons (authentication methods,
        // OIDC flows).
        rows.push(
          <Row key={field.key} label={label}>
            <Select
              aria-label={label}
              value={value}
              onChange={(event) => updateValues(choiceValues(field, event.target.value))}
            >
              {optionsOf(field).map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.label)}
                </option>
              ))}
            </Select>
          </Row>,
        );
      } else if (field.type === "select") {
        rows.push(
          <Row key={field.key} label={label}>
            <div className="cm-segmented" role="radiogroup" aria-label={label}>
              {optionsOf(field).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={value === option.value}
                  className={value === option.value ? "active" : ""}
                  onClick={() => updateValues(choiceValues(field, option.value))}
                >
                  {t(option.label)}
                </button>
              ))}
            </div>
          </Row>,
        );
      } else if (field.type === "toggle") {
        rows.push(
          <Row key={field.key} label={label}>
            <label className="cm-switch">
              <input
                type="checkbox"
                checked={form.values[field.key] === true}
                onChange={(event) => updateValues({ [field.key]: event.target.checked })}
              />
              <span>{t(field.description ?? field.label ?? field.key)}</span>
            </label>
          </Row>,
        );
      } else if (field.type === "file") {
        const group = [field];
        while (field.group !== undefined && shown[index + 1]?.type === "file" && shown[index + 1].group === field.group) {
          index += 1;
          group.push(shown[index]);
        }
        rows.push(
          <Row key={field.key} label={t(field.group ?? field.label ?? field.key)}>
            <div className={`cm-files${group.length === 1 ? " single" : ""}`}>
              {group.map((slot) => {
                const slotLabel = t(slot.label ?? slot.key);
                return (
                  <FileSlot
                    key={slot.key}
                    label={slotLabel}
                    value={text(form.values, slot.key)}
                    invalid={invalid.has(slot.key)}
                    onPick={() => void pickFile(slot.key, t(`${slot.label ?? slot.key} 선택`))}
                    onClear={() => updateValues({ [slot.key]: "" })}
                  />
                );
              })}
            </div>
          </Row>,
        );
      } else if (field.type === "path") {
        rows.push(
          <Row key={field.key} label={label} htmlFor={id}>
            <div className="cm-pair">
              <input
                id={id}
                className={invalidClass}
                {...invalidProps(field.key)}
                value={value}
                spellCheck={false}
                autoComplete="off"
                placeholder={field.placeholder !== undefined ? t(field.placeholder) : undefined}
                onChange={(event) => updateValues({ [field.key]: event.target.value })}
              />
              <button
                type="button"
                className="cm-path-pick"
                onClick={() => void pickFile(field.key, t(`${current.label} 파일 선택`), true)}
              >
                <FileIcon size={11} />
                {t("파일 선택…")}
              </button>
            </div>
          </Row>,
        );
      } else if (field.type === "textarea") {
        rows.push(
          <Row key={field.key} label={label} htmlFor={id}>
            <textarea
              id={id}
              className={invalidClass}
              {...invalidProps(field.key)}
              value={value}
              spellCheck={false}
              placeholder={field.placeholder !== undefined ? t(field.placeholder) : undefined}
              onChange={(event) => updateValues({ [field.key]: event.target.value })}
            />
          </Row>,
        );
      } else {
        rows.push(
          <Row key={field.key} label={label} htmlFor={id}>
            <input
              id={id}
              className={invalidClass}
              {...invalidProps(field.key)}
              value={value}
              spellCheck={false}
              autoComplete="off"
              inputMode={field.type === "number" ? "decimal" : undefined}
              placeholder={field.placeholder !== undefined ? t(field.placeholder) : undefined}
              onChange={(event) => updateValues({ [field.key]: event.target.value })}
            />
          </Row>,
        );
      }
    }
    return rows;
  }

  // The server engines the card row switches between; a file engine (SQLite)
  // keeps its own form and never shows the row.
  const switchable = engine?.transport === "server" ? engines().filter((candidate) => candidate.transport === "server") : [];
  const tunnels = engine?.connection.tunnels ?? [];
  const defaults = engine !== undefined ? defaultValues(engine) : {};
  const advancedShown =
    advancedOpen ||
    (engine?.connection.fields.some(
      (field) => field.advanced === true && (invalid.has(field.key) || String(form.values[field.key] ?? "") !== String(defaults[field.key] ?? "")),
    ) ??
      false);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        backdropDownRef.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        // Only a click that started on the backdrop closes; a drag out of an input doesn't.
        if (backdropDownRef.current && event.target === event.currentTarget) {
          void requestClose();
        }
        backdropDownRef.current = false;
      }}
    >
      <form
        className="modal cm-modal"
        style={{ "--cm-color": color } as CSSProperties}
        onSubmit={(event) => {
          event.preventDefault();
          act("connect");
        }}
        noValidate
      >
        <header className="cm-head">
          <span className="cm-head-mark" aria-hidden="true">
            <DatabaseIcon size={16} />
          </span>
          <div className="cm-head-text">
            <div className="cm-title">{title}</div>
            <div className="cm-subtitle">{form.name.trim() || autoName(engine, form)}</div>
          </div>
          <button type="button" className="icon-button cm-close" onClick={() => void requestClose()} title={t("닫기")}>
            <CloseIcon size={11} />
          </button>
        </header>

        <div className="cm-body">
          {openConnId !== null ? (
            <div className="cm-banner">
              {t("이 연결은 열려 있습니다. 바뀐 설정은 다음에 연결할 때부터 적용됩니다.")}
            </div>
          ) : null}
          {engine === undefined ? <div className="cm-banner">{unsupportedEngine(form.driver)}</div> : null}

          {switchable.length > 0 ? (
            <div className="cm-drivers" role="radiogroup" aria-label={t("데이터베이스 종류")}>
              {switchable.map((choice) => (
                <button
                  key={choice.id}
                  type="button"
                  role="radio"
                  aria-checked={form.driver === choice.id}
                  className={`cm-driver${form.driver === choice.id ? " active" : ""}`}
                  onClick={() => changeDriver(choice)}
                >
                  <DriverIcon kind={choice.id} size={28} />
                  <span className="cm-driver-text">
                    <span className="cm-driver-name">{choice.label}</span>
                    <span className="cm-driver-sub">{t(choice.subtitle)}</span>
                  </span>
                  {form.driver === choice.id ? <CheckIcon size={11} className="cm-driver-check" /> : null}
                </button>
              ))}
            </div>
          ) : null}

          <section className="cm-card">
            <Row label={t("이름")} htmlFor="cm-name">
              <input
                id="cm-name"
                ref={nameRef}
                value={form.name}
                placeholder={autoName(engine, form)}
                onChange={(event) => update({ name: event.target.value })}
              />
            </Row>
            <Row label={t("상태 색상")}>
              <div className="cm-swatches" role="radiogroup" aria-label={t("상태 색상")}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={form.color === ""}
                  className={`cm-swatch none${form.color === "" ? " active" : ""}`}
                  onClick={() => update({ color: "" })}
                  title={t("색 없음")}
                />
                {SWATCHES.map((swatch) => (
                  <button
                    key={swatch}
                    type="button"
                    role="radio"
                    aria-checked={form.color === swatch}
                    className={`cm-swatch${form.color === swatch ? " active" : ""}`}
                    style={{ background: swatch }}
                    onClick={() => update({ color: swatch })}
                    title={swatch}
                  />
                ))}
                <label
                  className={`cm-swatch custom${form.color !== "" && !SWATCHES.includes(form.color) ? " active" : ""}`}
                  title={t("직접 고르기")}
                  style={
                    form.color !== "" && !SWATCHES.includes(form.color)
                      ? { background: form.color }
                      : undefined
                  }
                >
                  <input
                    type="color"
                    value={form.color === "" ? "#4082ee" : form.color}
                    onChange={(event) => update({ color: event.target.value })}
                  />
                </label>
              </div>
            </Row>
            <Row label={t("태그")} htmlFor="cm-tags">
              <input
                id="cm-tags"
                value={form.tags}
                placeholder={t("쉼표로 구분")}
                onChange={(event) => update({ tags: event.target.value })}
              />
            </Row>
          </section>

          {engine !== undefined ? <section className="cm-card">{renderFields(engine, false)}</section> : null}

          {engine !== undefined && engine.connection.fields.some((field) => field.advanced === true && fieldVisible(field, form.values)) ? (
            <>
              <div className="cm-tunnels">
                <button
                  type="button"
                  className={`cm-tunnel${advancedShown ? " active" : ""}`}
                  aria-expanded={advancedShown}
                  onClick={() => setAdvancedOpen(!advancedShown)}
                >
                  {t("고급 설정")}
                </button>
                <span className="cm-tunnel-hint">{t("레플리카셋·읽기 선호처럼 보통은 그대로 두는 설정")}</span>
              </div>
              {advancedShown ? <section className="cm-card">{renderFields(engine, true)}</section> : null}
            </>
          ) : null}

          {tunnels.length > 0 ? (
            <div className="cm-tunnels">
              {tunnels.includes("ssh") ? (
                <button
                  type="button"
                  className={`cm-tunnel${form.sshEnabled ? " active" : ""}`}
                  aria-pressed={form.sshEnabled}
                  onClick={() => update({ sshEnabled: !form.sshEnabled, httpEnabled: false })}
                >
                  {t("SSH 터널")}
                </button>
              ) : null}
              {tunnels.includes("http") ? (
                <button
                  type="button"
                  className={`cm-tunnel${form.httpEnabled ? " active" : ""}`}
                  aria-pressed={form.httpEnabled}
                  onClick={() => update({ httpEnabled: !form.httpEnabled, sshEnabled: false })}
                >
                  {t("HTTP 프록시")}
                </button>
              ) : null}
              <span className="cm-tunnel-hint">
                {form.sshEnabled || form.httpEnabled
                  ? t("DB 호스트는 터널 서버에서 본 주소로 입력하세요 (예: 127.0.0.1)")
                  : t("방화벽 너머의 DB라면 터널을 켜세요")}
              </span>
            </div>
          ) : null}

          {form.sshEnabled && tunnels.includes("ssh") ? (
            <section className="cm-card cm-reveal">
              <Row label={t("서버")} htmlFor="cm-ssh-host">
                <div className="cm-pair">
                  <input
                    id="cm-ssh-host"
                    className={invalid.has("sshHost") ? "invalid" : ""}
                    {...invalidProps("sshHost")}
                    value={form.sshHost}
                    spellCheck={false}
                    placeholder="bastion.example.com"
                    onChange={(event) => update({ sshHost: event.target.value })}
                  />
                  <span className="cm-inline-label">{t("포트")}</span>
                  <input
                    className={`cm-port${invalid.has("sshPort") ? " invalid" : ""}`}
                    {...invalidProps("sshPort")}
                    inputMode="numeric"
                    value={form.sshPort}
                    onChange={(event) => update({ sshPort: event.target.value.replace(/[^0-9]/g, "") })}
                    aria-label={t("SSH 포트")}
                  />
                </div>
              </Row>
              <Row label={t("사용자")} htmlFor="cm-ssh-user">
                <input
                  id="cm-ssh-user"
                  className={invalid.has("sshUser") ? "invalid" : ""}
                  {...invalidProps("sshUser")}
                  value={form.sshUser}
                  spellCheck={false}
                  onChange={(event) => update({ sshUser: event.target.value })}
                />
              </Row>
              <Row label={t("인증")}>
                <div className="cm-segmented" role="radiogroup" aria-label={t("SSH 인증 방식")}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={form.sshAuth === "password"}
                    className={form.sshAuth === "password" ? "active" : ""}
                    onClick={() => update({ sshAuth: "password" })}
                  >
                    {t("비밀번호")}
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={form.sshAuth === "key"}
                    className={form.sshAuth === "key" ? "active" : ""}
                    onClick={() => update({ sshAuth: "key" })}
                  >
                    {t("SSH 키")}
                  </button>
                </div>
              </Row>
              {form.sshAuth === "password" ? (
                <Row label={t("비밀번호")} htmlFor="cm-ssh-password">
                  <input
                    id="cm-ssh-password"
                    ref={sshPasswordRef}
                    className={invalid.has("sshPassword") ? "invalid" : ""}
                    {...invalidProps("sshPassword")}
                    type="password"
                    value={form.sshPassword}
                    placeholder={storedPlaceholder}
                    autoComplete="new-password"
                    onChange={(event) => update({ sshPassword: event.target.value })}
                  />
                </Row>
              ) : (
                <Row label={t("키 파일")}>
                  <div className="cm-files single">
                    <FileSlot
                      label={t("개인 키")}
                      value={form.sshKeyPath}
                      invalid={invalid.has("sshKeyPath")}
                      onPick={() => void pickFile(SSH_KEY, t("SSH 개인 키 선택"))}
                      onClear={() => update({ sshKeyPath: "" })}
                    />
                  </div>
                </Row>
              )}
            </section>
          ) : null}

          {form.httpEnabled && tunnels.includes("http") ? (
            <section className="cm-card cm-reveal">
              <Row label={t("프록시")} htmlFor="cm-http-host">
                <div className="cm-pair">
                  <input
                    id="cm-http-host"
                    className={invalid.has("httpHost") ? "invalid" : ""}
                    {...invalidProps("httpHost")}
                    value={form.httpHost}
                    spellCheck={false}
                    placeholder="proxy.example.com"
                    onChange={(event) => update({ httpHost: event.target.value })}
                  />
                  <span className="cm-inline-label">{t("포트")}</span>
                  <input
                    className={`cm-port${invalid.has("httpPort") ? " invalid" : ""}`}
                    {...invalidProps("httpPort")}
                    inputMode="numeric"
                    value={form.httpPort}
                    onChange={(event) => update({ httpPort: event.target.value.replace(/[^0-9]/g, "") })}
                    aria-label={t("프록시 포트")}
                  />
                </div>
              </Row>
              <Row label={t("사용자")} htmlFor="cm-http-user">
                <div className="cm-pair">
                  <input
                    id="cm-http-user"
                    className={invalid.has("httpUser") ? "invalid" : ""}
                    {...invalidProps("httpUser")}
                    value={form.httpUser}
                    placeholder={t("선택")}
                    onChange={(event) => update({ httpUser: event.target.value })}
                  />
                  <span className="cm-inline-label">{t("비밀번호")}</span>
                  <input
                    ref={httpPasswordRef}
                    className={invalid.has("httpPassword") ? "invalid" : ""}
                    {...invalidProps("httpPassword")}
                    type="password"
                    value={form.httpPassword}
                    placeholder={storedPlaceholder}
                    autoComplete="new-password"
                    onChange={(event) => update({ httpPassword: event.target.value })}
                    aria-label={t("프록시 비밀번호")}
                  />
                </div>
              </Row>
            </section>
          ) : null}
        </div>

        {/* An error shows once, here: explained when a rule knows it, its
            first line otherwise, with the fixes this dialog can apply. */}
        {status !== null && status.kind === "error" && busy === null ? (
          <div className="cm-error-slot" id="cm-error">
            <ErrorNotice
              error={status.error ?? status.text}
              context="connect"
              engine={form.driver}
              variant="compact"
              onFix={{
                "ssl-off": settingFix("ssl_mode", "disable"),
                "ssl-on": settingFix("ssl_mode", "require"),
                "direct-connection": settingFix("direct_connection", true),
              }}
              onClose={() => setStatus(null)}
            />
          </div>
        ) : null}
        <footer className="cm-foot">
          <span className={`cm-status${status !== null && status.kind !== "error" ? ` ${status.kind}` : ""}`} role="status">
            {busy === "test" ? (
              <>
                <Spinner size={11} />
                {t("연결을 테스트하는 중…")}
              </>
            ) : busy === "connect" ? (
              <>
                <Spinner size={11} />
                {t("연결하는 중…")}
              </>
            ) : status !== null && status.kind !== "error" ? (
              <>
                {status.kind === "ok" ? <CheckIcon size={11} /> : null}
                {status.text}
              </>
            ) : (
              <span className="cm-hint">{t("Enter 연결 · ⌘S 저장 · Esc 닫기")}</span>
            )}
          </span>
          <button type="button" onMouseDown={keepFocus} onClick={() => act("save")} disabled={busy !== null || engine === undefined}>
            {busy === "save" ? <Spinner size={11} /> : null}
            {t("저장")}
          </button>
          <button type="button" onMouseDown={keepFocus} onClick={() => act("test")} disabled={busy !== null || engine === undefined}>
            {t("테스트")}
          </button>
          <button type="submit" className="primary" onMouseDown={keepFocus} disabled={busy !== null || engine === undefined}>
            {openConnId !== null ? t("저장 후 열기") : t("연결 [버튼]")}
          </button>
        </footer>
      </form>
      {picker !== null ? (
        <FilePickerModal
          title={picker.title}
          current={fileValue(picker.field)}
          homeSubdir={picker.field === SSH_KEY ? ".ssh" : undefined}
          onPick={(path) => {
            setFile(picker.field, path);
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      ) : null}
    </div>
  );
}
