import { useCallback, useEffect, useState } from "react";
import {
  store,
  type ConnectInput,
  type DbInput,
  type Driver,
  type SavedConnection,
  type SslMode,
} from "../store";

interface ConnectModalProps {
  onClose(): void;
}

interface ConnectForm {
  driver: Driver;
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  sslMode: SslMode;
  encrypt: boolean;
  sshEnabled: boolean;
  sshHost: string;
  sshPort: string;
  sshUser: string;
  sshPassword: string;
  sshKeyPath: string;
  saveEnabled: boolean;
  saveName: string;
  persistPassword: boolean;
}

const SSL_MODES: SslMode[] = ["disable", "prefer", "require"];
const DRIVERS: Driver[] = ["postgres", "cockroach", "mysql", "mssql"];
const DEFAULT_PORT: Record<Driver, string> = {
  postgres: "5432",
  cockroach: "26257",
  mysql: "3306",
  mssql: "1433",
};
const DRIVER_LABEL: Record<Driver, string> = {
  postgres: "PostgreSQL",
  cockroach: "CockroachDB (PG 호환)",
  mysql: "MySQL / MariaDB",
  mssql: "SQL Server",
};
const DRIVER_BADGE: Record<Driver, string> = {
  postgres: "PG",
  cockroach: "CRDB",
  mysql: "MySQL",
  mssql: "MSSQL",
};
const DRIVER_HELPER: Record<Driver, string> = {
  postgres: "TLS는 미지원 — 원격은 SSH 터널 권장",
  cockroach: "PG 호환 프로토콜 · 기본 포트 26257 · ssl_mode 지원",
  mysql: "TLS는 미지원 — 원격은 SSH 터널 권장",
  mssql: "기본 포트 1433 · TLS 암호화 지원",
};
const KNOWN_PORTS = new Set(["5432", "26257", "3306", "1433"]);
const DEFAULT_FORM: ConnectForm = {
  driver: "postgres",
  host: "127.0.0.1",
  port: DEFAULT_PORT.postgres,
  user: "",
  password: "",
  database: "",
  sslMode: "disable",
  encrypt: true,
  sshEnabled: false,
  sshHost: "",
  sshPort: "22",
  sshUser: "",
  sshPassword: "",
  sshKeyPath: "",
  saveEnabled: false,
  saveName: "",
  persistPassword: false,
};

function normDriver(value: string): Driver {
  return value === "mysql" || value === "cockroach" || value === "mssql" ? value : "postgres";
}

function driverLabel(driver: Driver): string {
  return DRIVER_LABEL[driver];
}

function parsePort(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return fallback;
  }
  return parsed;
}

function errorOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function ConnectModal({ onClose }: ConnectModalProps) {
  const [saved, setSaved] = useState<SavedConnection[] | null>(null);
  const [savedError, setSavedError] = useState<string | null>(null);
  const [form, setForm] = useState<ConnectForm>(DEFAULT_FORM);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadSaved = useCallback(async (): Promise<void> => {
    try {
      const connections = await store.listConnections();
      setSaved(connections);
      setSavedError(null);
    } catch (err) {
      setSavedError(errorOf(err, "저장된 연결을 불러오지 못했습니다"));
    }
  }, []);

  useEffect(() => {
    void loadSaved();
  }, [loadSaved]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  function update(patch: Partial<ConnectForm>): void {
    setForm((prev) => ({ ...prev, ...patch }));
  }

  function changeDriver(driver: Driver): void {
    const currentPort = form.port.trim();
    const port =
      currentPort === "" || KNOWN_PORTS.has(currentPort) ? DEFAULT_PORT[driver] : form.port;
    update({ driver, port });
    setError(null);
  }

  function fillFromSaved(connection: SavedConnection): void {
    const driver = normDriver(connection.driver);
    const db =
      connection.postgres ??
      connection.cockroach ??
      connection.mysql ??
      connection.mssql;
    if (!db) {
      setError("저장된 연결 설정을 읽을 수 없습니다");
      return;
    }
    const sslMode =
      (connection.postgres ?? connection.cockroach ?? connection.mysql)?.ssl_mode ?? "disable";
    update({
      driver,
      host: db.host,
      port: String(db.port),
      user: db.user,
      password: "",
      database: db.database,
      sslMode,
      encrypt: connection.mssql?.encrypt ?? true,
      sshEnabled: connection.ssh !== undefined,
      sshHost: connection.ssh ? connection.ssh.host : DEFAULT_FORM.sshHost,
      sshPort: connection.ssh ? String(connection.ssh.port) : DEFAULT_FORM.sshPort,
      sshUser: connection.ssh ? connection.ssh.user : DEFAULT_FORM.sshUser,
      sshPassword: "",
      sshKeyPath: connection.ssh?.private_key_path ?? "",
      saveName: connection.name,
      persistPassword: connection.persist_password,
    });
    setError(null);
  }

  function buildInput(): ConnectInput {
    const database: DbInput = {
      host: form.host.trim(),
      port: parsePort(form.port, Number(DEFAULT_PORT[form.driver])),
      user: form.user.trim(),
      database: form.database.trim(),
      ssl_mode: form.sslMode,
    };
    if (form.password !== "") {
      database.password = form.password;
    }
    let input: ConnectInput;
    if (form.driver === "mysql") {
      input = { driver: "mysql", mysql: database };
    } else if (form.driver === "cockroach") {
      input = { driver: "cockroach", cockroach: database };
    } else if (form.driver === "mssql") {
      const mssql = {
        host: database.host,
        port: database.port,
        user: database.user,
        database: database.database,
        encrypt: form.encrypt,
        ...(form.password !== "" ? { password: form.password } : {}),
      };
      input = { driver: "mssql", mssql };
    } else {
      input = { driver: "postgres", postgres: database };
    }
    if (form.sshEnabled) {
      const ssh: NonNullable<ConnectInput["ssh"]> = {
        host: form.sshHost.trim(),
        port: parsePort(form.sshPort, 22),
        user: form.sshUser.trim(),
        private_key_path: form.sshKeyPath.trim(),
      };
      if (form.sshPassword !== "") {
        ssh.password = form.sshPassword;
      }
      input.ssh = ssh;
    }
    return input;
  }

  async function submit(): Promise<void> {
    if (busy) {
      return;
    }
    if (!form.host.trim() || !form.user.trim() || !form.database.trim()) {
      setError("호스트, 사용자, 데이터베이스를 입력하세요");
      return;
    }
    if (form.sshEnabled && (!form.sshHost.trim() || !form.sshUser.trim())) {
      setError("SSH 호스트와 사용자를 입력하세요");
      return;
    }
    if (form.saveEnabled && form.saveName.trim() === "") {
      setError("저장할 연결 이름을 입력하세요");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const input = buildInput();
      if (form.saveEnabled) {
        await store.createConnection(form.saveName.trim(), input, form.persistPassword);
      }
      await store.connect(input);
      onClose();
    } catch (err) {
      setError(errorOf(err, "연결에 실패했습니다"));
    } finally {
      setBusy(false);
    }
  }

  async function connectRow(id: string): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await store.connectSaved(id);
      onClose();
    } catch (err) {
      setError(errorOf(err, "연결에 실패했습니다"));
    } finally {
      setBusy(false);
    }
  }

  async function deleteRow(id: string): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await store.deleteConnection(id);
      await loadSaved();
    } catch (err) {
      setError(errorOf(err, "연결을 삭제하지 못했습니다"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal connect-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">연결</span>
          <span className="modal-path">
            {form.host.trim() ? `${form.host.trim()}:${parsePort(form.port, 0) || ""}` : ""}
          </span>
        </div>
        <div className="connect-body">
          <section className="connect-section">
            <div className="section-title">저장된 연결</div>
            {savedError ? (
              <div className="connect-inline-error">{savedError}</div>
            ) : saved === null ? (
              <div className="saved-empty">불러오는 중…</div>
            ) : saved.length === 0 ? (
              <div className="saved-empty">저장된 연결이 없습니다</div>
            ) : (
              <div className="saved-list">
                {saved.map((connection) => {
                  const db =
                    connection.postgres ??
                    connection.cockroach ??
                    connection.mysql ??
                    connection.mssql;
                  const driver = normDriver(connection.driver);
                  return (
                    <div className="saved-row" key={connection.id}>
                      <button
                        type="button"
                        className="saved-main"
                        onClick={() => fillFromSaved(connection)}
                      >
                        <span className={`driver-badge ${driver}`}>
                          {DRIVER_BADGE[driver]}
                        </span>
                        <span className="saved-name">{connection.name}</span>
                        <span className="saved-detail">
                          {db
                            ? `${db.user}@${db.host}:${db.port}/${db.database}${connection.ssh ? " · SSH" : ""}`
                            : "설정 없음"}
                        </span>
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void connectRow(connection.id)}
                      >
                        연결
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void deleteRow(connection.id)}
                      >
                        삭제
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
          <section className="connect-section">
            <div className="section-title">새 연결</div>
            <div className="form-grid">
              <label className="field">
                <span>드라이버</span>
                <select
                  value={form.driver}
                  onChange={(event) => changeDriver(normDriver(event.target.value))}
                >
                  {DRIVERS.map((driver) => (
                    <option key={driver} value={driver}>
                      {DRIVER_LABEL[driver]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>호스트</span>
                <input
                  value={form.host}
                  onChange={(event) => update({ host: event.target.value })}
                />
              </label>
              <label className="field">
                <span>포트</span>
                <input
                  inputMode="numeric"
                  value={form.port}
                  onChange={(event) => update({ port: event.target.value })}
                />
              </label>
              <label className="field">
                <span>사용자</span>
                <input
                  value={form.user}
                  onChange={(event) => update({ user: event.target.value })}
                />
              </label>
              <label className="field">
                <span>비밀번호</span>
                <input
                  type="password"
                  value={form.password}
                  onChange={(event) => update({ password: event.target.value })}
                />
              </label>
              <label className="field">
                <span>데이터베이스</span>
                <input
                  value={form.database}
                  onChange={(event) => update({ database: event.target.value })}
                />
              </label>
              {form.driver === "mssql" ? (
                <div className="field">
                  <span>TLS</span>
                  <label className="check-row inline">
                    <input
                      type="checkbox"
                      checked={form.encrypt}
                      onChange={(event) => update({ encrypt: event.target.checked })}
                    />
                    <span>암호화(TLS)</span>
                  </label>
                  <span className="field-helper">자체 서명 인증서를 신뢰합니다</span>
                </div>
              ) : (
                <label className="field">
                  <span>SSL 모드</span>
                  <select
                    value={form.sslMode}
                    onChange={(event) => update({ sslMode: event.target.value as SslMode })}
                  >
                    {SSL_MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        {mode}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <p className="helper">{driverLabel(form.driver)} · {DRIVER_HELPER[form.driver]}</p>
          </section>
          <section className="connect-section">
            <label className="check-row">
              <input
                type="checkbox"
                checked={form.sshEnabled}
                onChange={(event) => update({ sshEnabled: event.target.checked })}
              />
              <span>SSH 터널 사용</span>
            </label>
            {form.sshEnabled && (
              <div className="form-grid">
                <label className="field">
                  <span>SSH 호스트</span>
                  <input
                    value={form.sshHost}
                    onChange={(event) => update({ sshHost: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>SSH 포트</span>
                  <input
                    inputMode="numeric"
                    value={form.sshPort}
                    onChange={(event) => update({ sshPort: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>SSH 사용자</span>
                  <input
                    value={form.sshUser}
                    onChange={(event) => update({ sshUser: event.target.value })}
                  />
                </label>
                <label className="field">
                  <span>SSH 비밀번호</span>
                  <input
                    type="password"
                    value={form.sshPassword}
                    onChange={(event) => update({ sshPassword: event.target.value })}
                  />
                </label>
                <label className="field wide">
                  <span>개인 키 경로</span>
                  <input
                    value={form.sshKeyPath}
                    onChange={(event) => update({ sshKeyPath: event.target.value })}
                  />
                </label>
              </div>
            )}
          </section>
          <section className="connect-section">
            <label className="check-row">
              <input
                type="checkbox"
                checked={form.saveEnabled}
                onChange={(event) =>
                  update({
                    saveEnabled: event.target.checked,
                    persistPassword: event.target.checked ? form.persistPassword : false,
                  })
                }
              />
              <span>이 연결 저장</span>
            </label>
            <div className="form-grid">
              <label className="field">
                <span>이름</span>
                <input
                  disabled={!form.saveEnabled}
                  value={form.saveName}
                  onChange={(event) => update({ saveName: event.target.value })}
                />
              </label>
            </div>
            <label className="check-row">
              <input
                type="checkbox"
                disabled={!form.saveEnabled}
                checked={form.persistPassword}
                onChange={(event) => update({ persistPassword: event.target.checked })}
              />
              <span>비밀번호도 함께 저장</span>
            </label>
          </section>
        </div>
        <div className="modal-foot">
          {error ? <span className="connect-error">{error}</span> : null}
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            닫기
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void submit()}
          >
            연결
          </button>
        </div>
      </div>
    </div>
  );
}
