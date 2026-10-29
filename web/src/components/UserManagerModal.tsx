import { useCallback, useEffect, useState } from "react";
import { capabilitiesOf, engineById } from "../engines";
import type { UserRow, UserStatement } from "../engines/sqlDialect";
import { t } from "../i18n";
import { confirmDialog, promptDialog } from "./ConfirmDialog";
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

export function UserManagerModal({ conn, meta, onClose }: UserManagerModalProps) {
  // How the engine lists and changes its users (its SQL dialect's).
  const admin = engineById(meta.kind)?.sql?.users;
  const supported = capabilitiesOf(meta)?.users === true && admin !== undefined;
  const [users, setUsers] = useState<UserRow[] | null>(null);
  // The list stopped at the server's row cap.
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newHost, setNewHost] = useState("%");
  const [superUser, setSuperUser] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    if (!supported || admin === undefined) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await store.exec(conn, admin.listSql);
      setUsers(result.rows.map((row) => admin.readRow(row)));
      setTruncated(result.truncated);
    } catch (err) {
      setError(errorOf(err, t("사용자 목록을 불러오지 못했습니다")));
      setUsers([]);
    } finally {
      setBusy(false);
    }
  }, [conn, admin, supported]);

  useEffect(() => {
    void load();
  }, [load]);

  // A statement carrying a password runs but stays out of History, which is
  // kept on disk and offers its entries for copying and re-running.
  async function runSql(statements: UserStatement[], info: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      for (const statement of statements) {
        const secret = typeof statement !== "string";
        await store.exec(conn, secret ? statement.sql : statement, { history: !secret });
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
    if (admin === undefined) {
      return;
    }
    const name = newName.trim();
    if (name === "" || newPassword === "") {
      setError(t("이름과 비밀번호를 입력하세요"));
      return;
    }
    void runSql(
      admin.createSql(name, newPassword, newHost, superUser && admin.superUserOption),
      t(admin.createdInfo, { name }),
    );
  }

  async function dropUser(row: UserRow): Promise<void> {
    if (admin === undefined) {
      return;
    }
    const ok = await confirmDialog({
      title: t("사용자 삭제"),
      message: t("사용자 {name}을(를) 삭제할까요?", { name: row.name }),
      confirmLabel: t("삭제"),
      danger: true,
    });
    if (!ok) {
      return;
    }
    void runSql([admin.dropSql(row)], t(admin.droppedInfo, { name: row.name }));
  }

  async function changePassword(row: UserRow): Promise<void> {
    if (admin === undefined) {
      return;
    }
    const password = await promptDialog({
      title: t("비밀번호 변경"),
      label: t("{name}의 새 비밀번호", { name: row.name }),
      confirmLabel: t("변경"),
      secret: true,
    });
    if (password === null) {
      return;
    }
    void runSql([admin.passwordSql(row, password)], t("비밀번호를 변경했습니다: {name}", { name: row.name }));
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
              {error ? <ErrorNotice error={error} context="admin" /> : null}
              <table className="panel-table">
                <thead>
                  <tr>
                    <th>{t("이름")}</th>
                    <th>{t(admin?.extraLabel ?? "유형")}</th>
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
              {truncated ? (
                <p className="helper">{t("처음 {count}명만 표시합니다", { count: (users ?? []).length.toLocaleString() })}</p>
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
                {admin?.hostField ? (
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
                {/* Where the engine's roles take a SUPERUSER option (not CockroachDB's). */}
                {admin?.superUserOption ? (
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
