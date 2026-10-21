import { useCallback, useEffect, useState } from "react";
import { t } from "../i18n";
import { store, type EngineMeta } from "../store";
import { ErrorNotice } from "./ErrorNotice";
import { RefreshIcon } from "./icons";

interface UserManagerModalProps {
  conn: string;
  meta: EngineMeta;
  onClose(): void;
}

function errorOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteName(kind: string, name: string): string {
  if (kind === "mysql") {
    return `\`${name.replace(/`/g, "``")}\``;
  }
  if (kind === "mssql") {
    return `[${name.replace(/]/g, "]]")}]`;
  }
  return `"${name.replace(/"/g, '""')}"`;
}

interface UserRow {
  name: string;
  extra: string;
}

export function UserManagerModal({ conn, meta, onClose }: UserManagerModalProps) {
  const kind = meta.kind;
  const supported = kind === "postgres" || kind === "cockroachdb" || kind === "mysql" || kind === "mssql";
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newHost, setNewHost] = useState("%");
  const [superUser, setSuperUser] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    if (!supported) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (kind === "mysql") {
        const result = await store.exec(conn, "SELECT user, host FROM mysql.user ORDER BY user, host");
        const rows = result.rows.map((row) => ({
          name: String(row[0] ?? ""),
          extra: String(row[1] ?? ""),
        }));
        setUsers(rows);
      } else if (kind === "mssql") {
        const result = await store.exec(
          conn,
          "SELECT name, type_desc FROM sys.server_principals WHERE type IN ('S','U','G') ORDER BY name",
        );
        const rows = result.rows.map((row) => ({
          name: String(row[0] ?? ""),
          extra: String(row[1] ?? ""),
        }));
        setUsers(rows);
      } else {
        const result = await store.exec(conn, "SELECT usename, usesuper FROM pg_user ORDER BY usename");
        const rows = result.rows.map((row) => ({
          name: String(row[0] ?? ""),
          extra: row[1] === true || row[1] === "t" ? "SUPERUSER" : "",
        }));
        setUsers(rows);
      }
    } catch (err) {
      setError(errorOf(err, t("사용자 목록을 불러오지 못했습니다")));
      setUsers([]);
    } finally {
      setBusy(false);
    }
  }, [conn, kind, supported]);

  useEffect(() => {
    void load();
  }, [load]);

  async function runSql(statements: string[], info: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      for (const statement of statements) {
        await store.exec(conn, statement);
      }
      store.setInfo(info);
      await load();
    } catch (err) {
      setError(errorOf(err, t("{action}에 실패했습니다", { action: info })));
    } finally {
      setBusy(false);
    }
  }

  async function createUser(): Promise<void> {
    const name = newName.trim();
    if (name === "" || newPassword === "") {
      setError(t("이름과 비밀번호를 입력하세요"));
      return;
    }
    if (kind === "mysql") {
      const statements = [
        `CREATE USER ${quoteLiteral(name)}@${quoteLiteral(newHost.trim() || "%")} IDENTIFIED BY ${quoteLiteral(newPassword)}`,
      ];
      void runSql(statements, t("사용자를 생성했습니다: {name}", { name }));
      return;
    }
    if (kind === "mssql") {
      void runSql(
        [`CREATE LOGIN ${quoteName(kind, name)} WITH PASSWORD = ${quoteLiteral(newPassword)}`],
        t("로그인을 생성했습니다: {name}", { name }),
      );
      return;
    }
    const statements = [
      `CREATE ROLE ${quoteName(kind, name)} LOGIN PASSWORD ${quoteLiteral(newPassword)}`,
    ];
    if (superUser) {
      statements.push(`ALTER ROLE ${quoteName(kind, name)} SUPERUSER`);
    }
    void runSql(statements, t("역할을 생성했습니다: {name}", { name }));
  }

  async function dropUser(row: UserRow): Promise<void> {
    if (!window.confirm(t("사용자 {name}을(를) 삭제할까요?", { name: row.name }))) {
      return;
    }
    if (kind === "mysql") {
      void runSql(
        [`DROP USER ${quoteLiteral(row.name)}@${quoteLiteral(row.extra)}`],
        t("사용자를 삭제했습니다: {name}", { name: row.name }),
      );
      return;
    }
    if (kind === "mssql") {
      void runSql(
        [`DROP LOGIN ${quoteName(kind, row.name)}`],
        t("로그인을 삭제했습니다: {name}", { name: row.name }),
      );
      return;
    }
    void runSql(
      [`DROP ROLE ${quoteName(kind, row.name)}`],
      t("역할을 삭제했습니다: {name}", { name: row.name }),
    );
  }

  async function changePassword(row: UserRow): Promise<void> {
    const password = window.prompt(t("{name}의 새 비밀번호", { name: row.name }), "");
    if (password === null || password === "") {
      return;
    }
    if (kind === "mysql") {
      void runSql(
        [
          `ALTER USER ${quoteLiteral(row.name)}@${quoteLiteral(row.extra)} IDENTIFIED BY ${quoteLiteral(password)}`,
        ],
        t("비밀번호를 변경했습니다: {name}", { name: row.name }),
      );
      return;
    }
    if (kind === "mssql") {
      void runSql(
        [`ALTER LOGIN ${quoteName(kind, row.name)} WITH PASSWORD = ${quoteLiteral(password)}`],
        t("비밀번호를 변경했습니다: {name}", { name: row.name }),
      );
      return;
    }
    void runSql(
      [`ALTER ROLE ${quoteName(kind, row.name)} WITH PASSWORD ${quoteLiteral(password)}`],
      t("비밀번호를 변경했습니다: {name}", { name: row.name }),
    );
  }

  const canCreate = newName.trim() !== "" && newPassword !== "";

  return (
    <div className="modal-backdrop" onClick={() => (busy ? undefined : onClose())}>
      <div className="modal user-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">{t("사용자 관리")}</span>
          <span className="modal-path">{meta.kind}</span>
          <span className="spacer" />
          <button
            type="button"
            className="icon-text-button"
            disabled={busy || !supported}
            onClick={() => void load()}
            title={t("새로고침")}
          >
            <RefreshIcon size={11} />
            {t("새로고침")}
          </button>
        </div>
        {!supported ? (
          <div className="modal-body">
            <p className="helper">{t("이 엔진은 사용자 관리를 지원하지 않습니다")}</p>
          </div>
        ) : (
          <>
            <div className="modal-body user-body">
              {error ? <ErrorNotice message={error} /> : null}
              <table className="panel-table">
                <thead>
                  <tr>
                    <th>{t("이름")}</th>
                    <th>{kind === "mysql" ? t("호스트") : t("유형")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {(users ?? []).map((row) => (
                    <tr key={`${row.name}:${row.extra}`}>
                      <td className="mono">{row.name}</td>
                      <td className="dim">{row.extra}</td>
                      <td className="user-actions">
                        <button
                          type="button"
                          className="link-button"
                          disabled={busy}
                          onClick={() => void changePassword(row)}
                        >
                          {t("비밀번호 변경")}
                        </button>
                        <button
                          type="button"
                          className="link-button"
                          disabled={busy}
                          onClick={() => void dropUser(row)}
                        >
                          {t("삭제")}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {users !== null && users.length === 0 && !error ? (
                <div className="panel-empty-inline">{t("사용자가 없습니다")}</div>
              ) : null}
            </div>
            <div className="modal-body user-create">
              <div className="section-title">{t("사용자 생성")}</div>
              <div className="create-inline">
                <label className="field">
                  <span>{t("이름")}</span>
                  <input
                    value={newName}
                    spellCheck={false}
                    onChange={(event) => setNewName(event.target.value)}
                  />
                </label>
                {kind === "mysql" ? (
                  <label className="field">
                    <span>{t("호스트")}</span>
                    <input
                      value={newHost}
                      spellCheck={false}
                      onChange={(event) => setNewHost(event.target.value)}
                    />
                  </label>
                ) : null}
                <label className="field">
                  <span>{t("비밀번호")}</span>
                  <input
                    value={newPassword}
                    type="password"
                    spellCheck={false}
                    onChange={(event) => setNewPassword(event.target.value)}
                  />
                </label>
                {kind === "postgres" || kind === "cockroachdb" ? (
                  <label className="check-row inline">
                    <input
                      type="checkbox"
                      checked={superUser}
                      onChange={(event) => setSuperUser(event.target.checked)}
                    />
                    <span>SUPERUSER</span>
                  </label>
                ) : null}
                <button
                  type="button"
                  className="primary"
                  disabled={busy || !canCreate}
                  onClick={() => void createUser()}
                >
                  {t("생성")}
                </button>
              </div>
            </div>
          </>
        )}
        <div className="modal-foot">
          <span className="spacer" />
          <button type="button" disabled={busy} onClick={onClose}>
            {t("닫기")}
          </button>
        </div>
      </div>
    </div>
  );
}
