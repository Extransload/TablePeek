import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  ENVIRONMENT_OPTIONS,
  environmentLabel,
  getConnMeta,
  setConnMeta,
  type ConnectionEnvironment,
} from "../connMeta";
import { explainError, type ErrorHelp } from "../errorHelp";
import { t } from "../i18n";
import {
  ApiRequestError,
  missingSecretOf,
  store,
  type MissingSecret,
  type ConnectInput,
  type ConnectSecrets,
  type DbInput,
  type Driver,
  type LiveConn,
  type SavedConnection,
  type SslMode,
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

interface ConnectModalProps {
  // Saved profile to edit; omitted for a new connection.
  editing?: SavedConnection | null;
  // Live connection already opened from this profile, if any.
  openConnId?: string | null;
  notice?: string | null;
  // Secret the dialog was opened to ask for (focused and highlighted).
  missingSecret?: MissingSecret | null;
  onClose(): void;
  onConnected(result: LiveConn): void;
  onSaved(): void;
  onSwitch(connId: string): void;
}

type SshAuth = "password" | "key";
type FileField = "sslClientKey" | "sslClientCert" | "sslRootCert" | "sshKeyPath";
type FieldKey =
  | "host"
  | "port"
  | "user"
  | "database"
  | "password"
  | "sslClientKey"
  | "sslClientCert"
  | "sshHost"
  | "sshPort"
  | "sshUser"
  | "sshPassword"
  | "sshKeyPath"
  | "httpHost"
  | "httpPort"
  | "httpUser"
  | "httpPassword";

interface ConnectForm {
  driver: Driver;
  name: string;
  color: string;
  environment: ConnectionEnvironment;
  group: string;
  tags: string;
  host: string;
  port: string;
  user: string;
  password: string;
  persistPassword: boolean;
  database: string;
  sslMode: SslMode;
  sslRootCert: string;
  sslClientCert: string;
  sslClientKey: string;
  encrypt: boolean;
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

interface Problem {
  field: FieldKey;
  message: string;
}

interface Status {
  kind: "ok" | "error" | "info";
  text: string;
  // Server error code, which helps explain the error.
  code?: string;
}

function errorStatus(err: unknown, fallback: string): Status {
  return {
    kind: "error",
    text: err instanceof Error ? err.message : fallback,
    code: err instanceof ApiRequestError ? err.code : undefined,
  };
}

const DRIVERS: Driver[] = ["postgres", "mysql", "mssql", "cockroach"];
const DEFAULT_PORT: Record<Driver, string> = {
  postgres: "5432",
  cockroach: "26257",
  mysql: "3306",
  mssql: "1433",
};
const DRIVER_LABEL: Record<Driver, string> = {
  postgres: "PostgreSQL",
  cockroach: "CockroachDB",
  mysql: "MySQL",
  mssql: "SQL Server",
};
const DRIVER_SUB: Record<Driver, string> = {
  postgres: "기본 포트 5432",
  cockroach: "PG 호환 · 26257",
  mysql: "MariaDB · 3306",
  mssql: "기본 포트 1433",
};
const KNOWN_PORTS = new Set(Object.values(DEFAULT_PORT));
const SSL_MODES: { value: SslMode; label: string }[] = [
  { value: "disable", label: "사용 안 함" },
  { value: "prefer", label: "가능하면 (Prefer)" },
  { value: "require", label: "필수 (Require)" },
];
const SWATCHES = ["#22c55e", "#3b82f6", "#a855f7", "#f59e0b", "#ef4444", "#64748b"];
const URL_DRIVERS: Record<string, Driver> = {
  postgres: "postgres",
  postgresql: "postgres",
  cockroach: "cockroach",
  cockroachdb: "cockroach",
  mysql: "mysql",
  mariadb: "mysql",
  sqlserver: "mssql",
  mssql: "mssql",
};

const EMPTY_FORM: ConnectForm = {
  driver: "postgres",
  name: "",
  color: "",
  environment: "",
  group: "",
  tags: "",
  host: "127.0.0.1",
  port: DEFAULT_PORT.postgres,
  user: "",
  password: "",
  persistPassword: false,
  database: "",
  sslMode: "prefer",
  sslRootCert: "",
  sslClientCert: "",
  sslClientKey: "",
  encrypt: true,
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

function normDriver(value: string): Driver {
  return value === "mysql" || value === "cockroach" || value === "mssql" ? value : "postgres";
}

function formFromSaved(saved: SavedConnection): ConnectForm {
  const driver = normDriver(saved.driver);
  const db = saved.postgres ?? saved.cockroach ?? saved.mysql ?? saved.mssql;
  const tls = saved.postgres ?? saved.cockroach ?? saved.mysql;
  const meta = getConnMeta(saved.id);
  const keyPath = saved.ssh?.private_key_path ?? "";
  return {
    ...EMPTY_FORM,
    driver,
    name: saved.name,
    color: meta?.color ?? "",
    environment: meta?.environment ?? "",
    group: meta?.group ?? "",
    tags: (meta?.tags ?? []).join(", "),
    host: db?.host ?? "",
    port: db ? String(db.port) : DEFAULT_PORT[driver],
    user: db?.user ?? "",
    persistPassword: saved.persist_password,
    database: db?.database ?? "",
    sslMode: tls?.ssl_mode ?? "disable",
    sslRootCert: tls?.ssl_root_cert ?? "",
    sslClientCert: tls?.ssl_client_cert ?? "",
    sslClientKey: tls?.ssl_client_key ?? "",
    encrypt: saved.mssql?.encrypt ?? true,
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

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const SECRET_FIELD: Record<MissingSecret, FieldKey> = {
  db: "password",
  ssh: "sshPassword",
  http: "httpPassword",
};

// "postgres://user:pass@host:5432/db?sslmode=require", optionally "jdbc:"-prefixed.
function parseConnectionUrl(text: string): Partial<ConnectForm> | null {
  const trimmed = text.trim().replace(/^jdbc:/i, "");
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed);
  const driver = scheme ? URL_DRIVERS[scheme[1].toLowerCase()] : undefined;
  if (driver === undefined) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  const patch: Partial<ConnectForm> = { driver, port: url.port || DEFAULT_PORT[driver] };
  if (url.hostname !== "") {
    patch.host = safeDecode(url.hostname.replace(/^\[|\]$/g, ""));
  }
  const user = url.username !== "" ? safeDecode(url.username) : url.searchParams.get("user");
  if (user) {
    patch.user = user;
  }
  const password =
    url.password !== "" ? safeDecode(url.password) : url.searchParams.get("password");
  if (password) {
    patch.password = password;
  }
  const database = safeDecode(url.pathname.replace(/^\/+/, ""));
  if (database !== "") {
    patch.database = database;
  }
  const ssl = (url.searchParams.get("sslmode") ?? url.searchParams.get("ssl-mode") ?? "").toLowerCase();
  if (ssl !== "") {
    patch.sslMode =
      ssl === "disable" || ssl === "disabled"
        ? "disable"
        : ssl === "prefer" || ssl === "preferred" || ssl === "allow"
          ? "prefer"
          : "require";
  }
  return patch;
}

function autoName(form: ConnectForm): string {
  const host = form.host.trim() || "localhost";
  const database = form.database.trim();
  return database === "" ? host : `${database} @ ${host}`;
}

function validPort(value: string): boolean {
  const port = Number(value.trim());
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function basename(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(index + 1) : path;
}

function buildInput(form: ConnectForm): ConnectInput {
  const database: DbInput = {
    host: form.host.trim(),
    port: Number(form.port.trim()),
    user: form.user.trim(),
    database: form.database.trim(),
    ssl_mode: form.sslMode,
  };
  if (form.password !== "") {
    database.password = form.password;
  }
  if (form.sslMode !== "disable") {
    if (form.sslRootCert.trim() !== "") {
      database.ssl_root_cert = form.sslRootCert.trim();
    }
    if (form.sslClientCert.trim() !== "") {
      database.ssl_client_cert = form.sslClientCert.trim();
    }
    if (form.sslClientKey.trim() !== "") {
      database.ssl_client_key = form.sslClientKey.trim();
    }
  }
  let input: ConnectInput;
  if (form.driver === "mysql") {
    input = { driver: "mysql", mysql: database };
  } else if (form.driver === "cockroach") {
    input = { driver: "cockroach", cockroach: database };
  } else if (form.driver === "mssql") {
    input = {
      driver: "mssql",
      mssql: {
        host: database.host,
        port: database.port,
        user: database.user,
        database: database.database,
        encrypt: form.encrypt,
        ...(form.password !== "" ? { password: form.password } : {}),
      },
    };
  } else {
    input = { driver: "postgres", postgres: database };
  }
  if (form.sshEnabled) {
    const useKey = form.sshAuth === "key";
    input.ssh = {
      host: form.sshHost.trim(),
      port: Number(form.sshPort.trim()),
      user: form.sshUser.trim(),
      private_key_path: useKey ? form.sshKeyPath.trim() : "",
      ...(!useKey && form.sshPassword !== "" ? { password: form.sshPassword } : {}),
    };
  } else if (form.httpEnabled) {
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
function problemsOf(form: ConnectForm, purpose: "save" | "connect", storedSecrets: boolean): Problem[] {
  const problems: Problem[] = [];
  // Stored secrets only count while the profile keeps storing them.
  const hasStored = storedSecrets && form.persistPassword;
  const host = form.host.trim();
  if (host === "") {
    problems.push({ field: "host", message: t("호스트를 입력하세요") });
  } else if (host.includes("://") || /[\s/@?]/.test(host)) {
    problems.push({ field: "host", message: t("호스트에는 주소만 입력하세요 (URL·계정 정보 제외)") });
  }
  if (!validPort(form.port)) {
    problems.push({ field: "port", message: t("포트가 올바르지 않습니다") });
  }
  if (purpose === "connect" && form.user.trim() === "") {
    problems.push({ field: "user", message: t("사용자를 입력하세요") });
  }
  if (purpose === "connect" && form.database.trim() === "") {
    problems.push({ field: "database", message: t("데이터베이스를 입력하세요") });
  }
  if (
    form.driver !== "mssql" &&
    form.sslMode !== "disable" &&
    (form.sslClientCert.trim() === "") !== (form.sslClientKey.trim() === "")
  ) {
    problems.push({
      field: form.sslClientCert.trim() === "" ? "sslClientCert" : "sslClientKey",
      message: t("클라이언트 인증서와 키는 함께 지정하세요"),
    });
  }
  if (form.sshEnabled) {
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
  if (form.httpEnabled) {
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
  onClose,
  onConnected,
  onSaved,
  onSwitch,
}: ConnectModalProps) {
  const [form, setForm] = useState<ConnectForm>(() =>
    editing !== null ? formFromSaved(editing) : EMPTY_FORM,
  );
  const [savedId, setSavedId] = useState<string | null>(editing?.id ?? null);
  const [storedSecrets, setStoredSecrets] = useState(editing?.persist_password ?? false);
  const [problems, setProblems] = useState<Problem[]>(() =>
    missingSecret !== null && notice !== null
      ? [{ field: SECRET_FIELD[missingSecret], message: notice }]
      : [],
  );
  const [status, setStatus] = useState<Status | null>(
    notice !== null ? { kind: "info", text: notice } : null,
  );
  const [busy, setBusy] = useState<"save" | "test" | "connect" | null>(null);
  // Set by an error's fix button: test again once the changed form renders.
  const [retest, setRetest] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [picker, setPicker] = useState<{ field: FileField; title: string } | null>(null);
  const passwordRef = useRef<HTMLInputElement | null>(null);
  const sshPasswordRef = useRef<HTMLInputElement | null>(null);
  const httpPasswordRef = useRef<HTMLInputElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const saveRef = useRef<() => void>(() => {});
  const requestCloseRef = useRef<() => void>(() => {});
  const pickerOpenRef = useRef(false);
  const initialRef = useRef(form);
  const backdropDownRef = useRef(false);
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
        requestCloseRef.current();
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
  const isEdit = savedId !== null;
  const color = form.color || "var(--accent)";

  function update(patch: Partial<ConnectForm>): void {
    setForm((prev) => ({ ...prev, ...patch }));
    setProblems((prev) => (prev.length === 0 ? prev : []));
    setStatus((prev) => (prev?.kind === "info" ? prev : null));
  }

  // Closing is ignored mid-request, and asks before dropping unsaved edits.
  function requestClose(): void {
    if (busy !== null) {
      return;
    }
    const dirty = JSON.stringify(form) !== JSON.stringify(initialRef.current);
    if (dirty && !window.confirm(t("저장하지 않은 변경사항이 있습니다. 닫을까요?"))) {
      return;
    }
    onClose();
  }
  requestCloseRef.current = requestClose;

  function changeDriver(driver: Driver): void {
    const port = form.port.trim();
    update({ driver, port: port === "" || KNOWN_PORTS.has(port) ? DEFAULT_PORT[driver] : form.port });
  }

  function check(purpose: "save" | "connect"): boolean {
    const found = problemsOf(form, purpose, storedSecrets);
    setProblems(found);
    if (found.length > 0) {
      setStatus({ kind: "error", text: found[0].message });
      return false;
    }
    return true;
  }

  async function checkFiles(): Promise<boolean> {
    const files: { path: string; label: string }[] = [];
    if (form.driver !== "mssql" && form.sslMode !== "disable") {
      if (form.sslRootCert.trim() !== "") {
        files.push({ path: form.sslRootCert.trim(), label: t("CA 인증서") });
      }
      if (form.sslClientCert.trim() !== "") {
        files.push({ path: form.sslClientCert.trim(), label: t("클라이언트 인증서") });
      }
      if (form.sslClientKey.trim() !== "") {
        files.push({ path: form.sslClientKey.trim(), label: t("클라이언트 키") });
      }
    }
    if (form.sshEnabled && form.sshAuth === "key" && form.sshKeyPath.trim() !== "") {
      files.push({ path: form.sshKeyPath.trim(), label: t("SSH 키") });
    }
    for (const file of files) {
      const stat = await store.statPath(file.path);
      if (!stat.exists || !stat.is_file || !stat.readable) {
        setStatus({
          kind: "error",
          text: t("{label} 파일을 읽을 수 없습니다: {path}", { label: file.label, path: file.path }),
        });
        return false;
      }
    }
    return true;
  }

  function secrets(): ConnectSecrets {
    return {
      ...(form.password !== "" ? { password: form.password } : {}),
      ...(form.sshEnabled && form.sshAuth === "password" && form.sshPassword !== ""
        ? { ssh_password: form.sshPassword }
        : {}),
      ...(form.httpEnabled && form.httpPassword !== "" ? { http_password: form.httpPassword } : {}),
    };
  }

  async function persist(): Promise<string> {
    const name = form.name.trim() || autoName(form);
    const input = buildInput(form);
    let id = savedId;
    if (id !== null) {
      try {
        await store.updateConnection(id, name, input, form.persistPassword);
      } catch (err) {
        // Deleted elsewhere while the dialog was open: save it as a new profile.
        if (!(err instanceof ApiRequestError && err.code === "not_found")) {
          throw err;
        }
        id = null;
      }
    }
    if (id === null) {
      id = await store.createConnection(name, input, form.persistPassword);
      setSavedId(id);
    }
    setConnMeta(id, {
      group: form.group,
      color: form.color,
      tags: form.tags.split(","),
      environment: form.environment,
    });
    const typedSecret =
      form.password !== "" || form.sshPassword !== "" || form.httpPassword !== "";
    setStoredSecrets(form.persistPassword && (storedSecrets || typedSecret));
    initialRef.current = form;
    onSaved();
    return id;
  }

  async function save(): Promise<void> {
    if (busy !== null || !check("save")) {
      return;
    }
    setBusy("save");
    try {
      await persist();
      onClose();
    } catch (err) {
      setStatus(errorStatus(err, t("저장하지 못했습니다")));
    } finally {
      setBusy(null);
    }
  }
  saveRef.current = () => void save();

  async function test(): Promise<void> {
    if (busy !== null || !check("connect")) {
      return;
    }
    setBusy("test");
    setStatus(null);
    try {
      if (!(await checkFiles())) {
        return;
      }
      const result = await store.testConnection(
        buildInput(form),
        form.persistPassword ? (savedId ?? undefined) : undefined,
      );
      setStatus({
        kind: "ok",
        text: t("연결 성공 · {driver} · 테이블 {tables}개 · {ms}ms", {
          driver: DRIVER_LABEL[form.driver],
          tables: result.tables,
          ms: Math.round(result.elapsed_ms),
        }),
      });
    } catch (err) {
      setStatus(errorStatus(err, t("연결하지 못했습니다")));
    } finally {
      setBusy(null);
    }
  }

  async function connect(): Promise<void> {
    if (busy !== null || !check("connect")) {
      return;
    }
    setBusy("connect");
    setStatus(null);
    try {
      if (!(await checkFiles())) {
        return;
      }
      const id = await persist();
      if (openConnId !== null) {
        onSwitch(openConnId);
        return;
      }
      onConnected(await store.connectSaved(id, secrets()));
    } catch (err) {
      const missing = missingSecretOf(err);
      if (missing !== null) {
        const text = err instanceof Error ? err.message : t("비밀번호를 입력하세요");
        setProblems([{ field: SECRET_FIELD[missing], message: text }]);
        setStatus({ kind: "error", text });
        focusSecret(missing);
      } else {
        setStatus(errorStatus(err, t("연결하지 못했습니다")));
      }
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    if (retest) {
      setRetest(false);
      void test();
    }
    // Runs after the fix's form change has rendered, so test() sees it.
  }, [retest]);

  // One-click versions of the fixes an explained error suggests.
  function errorActions(help: ErrorHelp): ReactNode {
    if (form.driver === "mssql" || busy !== null) {
      return null;
    }
    if (help.action === "ssl-off" && form.sslMode !== "disable") {
      return (
        <button
          type="button"
          onClick={() => {
            update({ sslMode: "disable" });
            setRetest(true);
          }}
        >
          {t("SSL 끄고 다시 테스트")}
        </button>
      );
    }
    if (help.action === "ssl-on" && form.sslMode !== "require") {
      return (
        <button
          type="button"
          onClick={() => {
            update({ sslMode: "require" });
            setRetest(true);
          }}
        >
          {t("SSL ‘필수’로 바꾸고 다시 테스트")}
        </button>
      );
    }
    return null;
  }

  const statusHelp = useMemo(
    () => (status?.kind === "error" ? explainError(status.text, status.code) : null),
    [status],
  );

  function fileValue(field: FileField): string {
    return form[field];
  }

  const storedPlaceholder = isEdit && storedSecrets ? t("저장된 비밀번호 사용") : "";
  const title = editing !== null ? t("연결 편집") : t("{driver} 연결", { driver: DRIVER_LABEL[form.driver] });

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        backdropDownRef.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        // Only a click that started on the backdrop closes; a drag out of an input doesn't.
        if (backdropDownRef.current && event.target === event.currentTarget) {
          requestClose();
        }
        backdropDownRef.current = false;
      }}
    >
      <form
        className="modal cm-modal"
        style={{ "--cm-color": color } as CSSProperties}
        onSubmit={(event) => {
          event.preventDefault();
          void connect();
        }}
        noValidate
      >
        <header className="cm-head">
          <span className="cm-head-mark" aria-hidden="true">
            <DatabaseIcon size={16} />
          </span>
          <div className="cm-head-text">
            <div className="cm-title">{title}</div>
            <div className="cm-subtitle">{form.name.trim() || autoName(form)}</div>
          </div>
          {form.environment !== "" ? (
            <span className={`env-badge env-${form.environment}`}>{environmentLabel(form.environment)}</span>
          ) : null}
          <button type="button" className="icon-button cm-close" onClick={requestClose} title={t("닫기")}>
            <CloseIcon size={11} />
          </button>
        </header>

        <div className="cm-body">
          {openConnId !== null ? (
            <div className="cm-banner">
              {t("이 연결은 열려 있습니다. 바뀐 설정은 다음에 연결할 때부터 적용됩니다.")}
            </div>
          ) : null}

          <div className="cm-drivers" role="radiogroup" aria-label={t("데이터베이스 종류")}>
            {DRIVERS.map((driver) => (
              <button
                key={driver}
                type="button"
                role="radio"
                aria-checked={form.driver === driver}
                className={`cm-driver${form.driver === driver ? " active" : ""}`}
                onClick={() => changeDriver(driver)}
              >
                <DriverIcon kind={driver} size={28} />
                <span className="cm-driver-text">
                  <span className="cm-driver-name">{DRIVER_LABEL[driver]}</span>
                  <span className="cm-driver-sub">{t(DRIVER_SUB[driver])}</span>
                </span>
                {form.driver === driver ? <CheckIcon size={11} className="cm-driver-check" /> : null}
              </button>
            ))}
          </div>

          <section className="cm-card">
            <Row label={t("이름")} htmlFor="cm-name">
              <input
                id="cm-name"
                ref={nameRef}
                value={form.name}
                placeholder={autoName(form)}
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
            <Row label={t("환경")}>
              <div className="cm-chips" role="radiogroup" aria-label={t("환경")}>
                {ENVIRONMENT_OPTIONS.map((option) => (
                  <button
                    key={option.value || "none"}
                    type="button"
                    role="radio"
                    aria-checked={form.environment === option.value}
                    className={`cm-chip${form.environment === option.value ? " active" : ""}${option.value ? ` env-${option.value}` : ""}`}
                    onClick={() => update({ environment: option.value })}
                  >
                    {t(option.label)}
                  </button>
                ))}
              </div>
            </Row>
            <Row label={t("그룹")} htmlFor="cm-group">
              <div className="cm-pair">
                <input
                  id="cm-group"
                  value={form.group}
                  placeholder={t("예: 운영 서버")}
                  onChange={(event) => update({ group: event.target.value })}
                />
                <span className="cm-inline-label">{t("태그")}</span>
                <input
                  value={form.tags}
                  placeholder={t("쉼표로 구분")}
                  onChange={(event) => update({ tags: event.target.value })}
                />
              </div>
            </Row>
          </section>

          <section className="cm-card">
            <Row label={t("호스트")} htmlFor="cm-host">
              <div className="cm-pair">
                <div className="cm-input-wrap">
                  <input
                    id="cm-host"
                    className={invalid.has("host") ? "invalid" : ""}
                    value={form.host}
                    spellCheck={false}
                    placeholder={t("호스트 또는 연결 URL 붙여넣기")}
                    onChange={(event) => update({ host: event.target.value })}
                    onPaste={(event) => {
                      const text = event.clipboardData.getData("text");
                      if (!URL_LIKE.test(text.trim())) {
                        return;
                      }
                      // Never let a URL (and the password inside it) land in the host field.
                      event.preventDefault();
                      const patch = parseConnectionUrl(text);
                      if (patch === null) {
                        setStatus({ kind: "error", text: t("연결 URL을 인식하지 못했습니다") });
                        return;
                      }
                      update(patch);
                      setStatus({
                        kind: "ok",
                        text: /sslmode=verify/i.test(text)
                          ? t("URL에서 채웠습니다 · verify 모드는 Require로 설정했습니다")
                          : t("URL에서 접속 정보를 채웠습니다"),
                      });
                    }}
                  />
                  <LinkPasteIcon size={11} className="cm-input-icon" />
                </div>
                <span className="cm-inline-label">{t("포트")}</span>
                <input
                  className={`cm-port${invalid.has("port") ? " invalid" : ""}`}
                  inputMode="numeric"
                  value={form.port}
                  onChange={(event) => update({ port: event.target.value.replace(/[^0-9]/g, "") })}
                  aria-label={t("포트")}
                />
              </div>
            </Row>
            <Row label={t("사용자")} htmlFor="cm-user">
              <input
                id="cm-user"
                className={invalid.has("user") ? "invalid" : ""}
                value={form.user}
                spellCheck={false}
                autoComplete="off"
                onChange={(event) => update({ user: event.target.value })}
              />
            </Row>
            <Row label={t("비밀번호")} htmlFor="cm-password">
              <div className="cm-pair">
                <div className="cm-input-wrap">
                  <input
                    id="cm-password"
                    ref={passwordRef}
                    className={invalid.has("password") ? "invalid" : ""}
                    type={showPassword ? "text" : "password"}
                    value={form.password}
                    placeholder={storedPlaceholder}
                    autoComplete="new-password"
                    onChange={(event) => update({ password: event.target.value })}
                  />
                  <button
                    type="button"
                    className="cm-eye"
                    onClick={() => setShowPassword((value) => !value)}
                    title={showPassword ? t("비밀번호 숨기기") : t("비밀번호 보기")}
                    aria-label={showPassword ? t("비밀번호 숨기기") : t("비밀번호 보기")}
                  >
                    {showPassword ? <EyeOffIcon size={11} /> : <EyeIcon size={11} />}
                  </button>
                </div>
                <select
                  className="cm-store"
                  value={form.persistPassword ? "keychain" : "none"}
                  onChange={(event) => update({ persistPassword: event.target.value === "keychain" })}
                  title={t("DB·SSH·프록시 비밀번호 저장 방식")}
                >
                  <option value="keychain">{t("키체인에 저장")}</option>
                  <option value="none">{t("매번 입력")}</option>
                </select>
              </div>
            </Row>
            <Row label={t("데이터베이스")} htmlFor="cm-database">
              <input
                id="cm-database"
                className={invalid.has("database") ? "invalid" : ""}
                value={form.database}
                spellCheck={false}
                onChange={(event) => update({ database: event.target.value })}
              />
            </Row>
            {form.driver === "mssql" ? (
              <Row label={t("암호화")}>
                <label className="cm-switch">
                  <input
                    type="checkbox"
                    checked={form.encrypt}
                    onChange={(event) => update({ encrypt: event.target.checked })}
                  />
                  <span>{t("TLS로 암호화 (자체 서명 인증서 허용)")}</span>
                </label>
              </Row>
            ) : (
              <>
                <Row label={t("SSL 모드")}>
                  <div className="cm-segmented" role="radiogroup" aria-label={t("SSL 모드")}>
                    {SSL_MODES.map((mode) => (
                      <button
                        key={mode.value}
                        type="button"
                        role="radio"
                        aria-checked={form.sslMode === mode.value}
                        className={form.sslMode === mode.value ? "active" : ""}
                        onClick={() => update({ sslMode: mode.value })}
                      >
                        {t(mode.label)}
                      </button>
                    ))}
                  </div>
                </Row>
                {form.sslMode !== "disable" ? (
                  <Row label={t("SSL 키")}>
                    <div className="cm-files">
                      <FileSlot
                        label={t("클라이언트 키")}
                        value={form.sslClientKey}
                        invalid={invalid.has("sslClientKey")}
                        onPick={() => setPicker({ field: "sslClientKey", title: t("클라이언트 키 선택") })}
                        onClear={() => update({ sslClientKey: "" })}
                      />
                      <FileSlot
                        label={t("클라이언트 인증서")}
                        value={form.sslClientCert}
                        invalid={invalid.has("sslClientCert")}
                        onPick={() =>
                          setPicker({ field: "sslClientCert", title: t("클라이언트 인증서 선택") })
                        }
                        onClear={() => update({ sslClientCert: "" })}
                      />
                      <FileSlot
                        label={t("CA 인증서")}
                        value={form.sslRootCert}
                        invalid={false}
                        onPick={() => setPicker({ field: "sslRootCert", title: t("CA 인증서 선택") })}
                        onClear={() => update({ sslRootCert: "" })}
                      />
                    </div>
                  </Row>
                ) : null}
              </>
            )}
          </section>

          <div className="cm-tunnels">
            <button
              type="button"
              className={`cm-tunnel${form.sshEnabled ? " active" : ""}`}
              aria-pressed={form.sshEnabled}
              onClick={() => update({ sshEnabled: !form.sshEnabled, httpEnabled: false })}
            >
              {t("SSH 터널")}
            </button>
            <button
              type="button"
              className={`cm-tunnel${form.httpEnabled ? " active" : ""}`}
              aria-pressed={form.httpEnabled}
              onClick={() => update({ httpEnabled: !form.httpEnabled, sshEnabled: false })}
            >
              {t("HTTP 프록시")}
            </button>
            <span className="cm-tunnel-hint">
              {form.sshEnabled || form.httpEnabled
                ? t("DB 호스트는 터널 서버에서 본 주소로 입력하세요 (예: 127.0.0.1)")
                : t("방화벽 너머의 DB라면 터널을 켜세요")}
            </span>
          </div>

          {form.sshEnabled ? (
            <section className="cm-card cm-reveal">
              <Row label={t("서버")} htmlFor="cm-ssh-host">
                <div className="cm-pair">
                  <input
                    id="cm-ssh-host"
                    className={invalid.has("sshHost") ? "invalid" : ""}
                    value={form.sshHost}
                    spellCheck={false}
                    placeholder="bastion.example.com"
                    onChange={(event) => update({ sshHost: event.target.value })}
                  />
                  <span className="cm-inline-label">{t("포트")}</span>
                  <input
                    className={`cm-port${invalid.has("sshPort") ? " invalid" : ""}`}
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
                      onPick={() => setPicker({ field: "sshKeyPath", title: t("SSH 개인 키 선택") })}
                      onClear={() => update({ sshKeyPath: "" })}
                    />
                  </div>
                </Row>
              )}
            </section>
          ) : null}

          {form.httpEnabled ? (
            <section className="cm-card cm-reveal">
              <Row label={t("프록시")} htmlFor="cm-http-host">
                <div className="cm-pair">
                  <input
                    id="cm-http-host"
                    className={invalid.has("httpHost") ? "invalid" : ""}
                    value={form.httpHost}
                    spellCheck={false}
                    placeholder="proxy.example.com"
                    onChange={(event) => update({ httpHost: event.target.value })}
                  />
                  <span className="cm-inline-label">{t("포트")}</span>
                  <input
                    className={`cm-port${invalid.has("httpPort") ? " invalid" : ""}`}
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
                    value={form.httpUser}
                    placeholder={t("선택")}
                    onChange={(event) => update({ httpUser: event.target.value })}
                  />
                  <span className="cm-inline-label">{t("비밀번호")}</span>
                  <input
                    ref={httpPasswordRef}
                    className={invalid.has("httpPassword") ? "invalid" : ""}
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

        {status !== null && statusHelp !== null && busy === null ? (
          <div className="cm-error-slot">
            <ErrorNotice
              message={status.text}
              code={status.code}
              variant="compact"
              renderActions={errorActions}
              onClose={() => setStatus(null)}
            />
          </div>
        ) : null}
        <footer className="cm-foot">
          <span className={`cm-status${status ? ` ${status.kind}` : ""}`} role="status">
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
            ) : status ? (
              <>
                {status.kind === "ok" ? <CheckIcon size={11} /> : null}
                {statusHelp !== null ? statusHelp.title : status.text}
              </>
            ) : (
              <span className="cm-hint">{t("Enter 연결 · ⌘S 저장 · Esc 닫기")}</span>
            )}
          </span>
          <button type="button" onClick={() => void save()} disabled={busy !== null}>
            {busy === "save" ? <Spinner size={11} /> : null}
            {t("저장")}
          </button>
          <button type="button" onClick={() => void test()} disabled={busy !== null}>
            {t("테스트")}
          </button>
          <button type="submit" className="primary" disabled={busy !== null}>
            {openConnId !== null ? t("저장 후 열기") : t("연결")}
          </button>
        </footer>
      </form>
      {picker !== null ? (
        <FilePickerModal
          title={picker.title}
          current={fileValue(picker.field)}
          homeSubdir={picker.field === "sshKeyPath" ? ".ssh" : undefined}
          onPick={(path) => {
            update({ [picker.field]: path } as Partial<ConnectForm>);
            setPicker(null);
          }}
          onClose={() => setPicker(null)}
        />
      ) : null}
    </div>
  );
}
