import { useEffect, useRef, useState } from "react";
import { MIN_FILE_PASSWORD } from "../connectionsFile";
import { t } from "../i18n";
import { Spinner } from "./Spinner";

interface ExportConnectionsModalProps {
  title: string;
  count: number;
  // Resolves to a message when the export failed; the dialog then stays open.
  onExport(passphrase: string, includePasswords: boolean): Promise<string | null>;
  onClose(): void;
}

// Export always seals the file with a password; saved passwords go in only when asked.
export function ExportConnectionsModal({ title, count, onExport, onClose }: ExportConnectionsModalProps) {
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [includePasswords, setIncludePasswords] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const firstRef = useRef<HTMLInputElement | null>(null);

  const tooShort = passphrase.length > 0 && [...passphrase].length < MIN_FILE_PASSWORD;
  const mismatch = confirm.length > 0 && confirm !== passphrase;
  const ready = [...passphrase].length >= MIN_FILE_PASSWORD && confirm === passphrase;

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  function close(): void {
    if (!busy) {
      onClose();
    }
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        close();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  async function submit(): Promise<void> {
    if (!ready || busy) {
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      const result = await onExport(passphrase, includePasswords);
      if (result !== null) {
        setFailure(result);
        return;
      }
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={close}>
      <form
        className="modal export-modal"
        onClick={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="modal-head">
          <span className="modal-title">{title}</span>
        </div>
        <div className="modal-body export-body">
          <p className="export-lead">
            {t("연결 {count}개를 암호화한 .tablepeek 파일로 저장합니다. 가져올 때 이 파일 암호가 필요합니다.", { count })}
          </p>
          <label className="export-field">
            <span className="prompt-label">{t("파일 암호")}</span>
            <input
              ref={firstRef}
              type="password"
              autoComplete="new-password"
              value={passphrase}
              disabled={busy}
              aria-invalid={tooShort}
              onChange={(event) => {
                setPassphrase(event.target.value);
                setFailure(null);
              }}
            />
          </label>
          <label className="export-field">
            <span className="prompt-label">{t("파일 암호 확인")}</span>
            <input
              type="password"
              autoComplete="new-password"
              value={confirm}
              disabled={busy}
              aria-invalid={mismatch}
              onChange={(event) => {
                setConfirm(event.target.value);
                setFailure(null);
              }}
            />
          </label>
          {tooShort || mismatch || failure !== null ? (
            <span className="prompt-problem" role="alert">
              {failure ??
                (tooShort
                  ? t("파일 암호는 {count}자 이상이어야 합니다", { count: MIN_FILE_PASSWORD })
                  : t("두 암호가 서로 다릅니다"))}
            </span>
          ) : null}
          <label className="cm-switch export-include">
            <input
              type="checkbox"
              checked={includePasswords}
              disabled={busy}
              onChange={(event) => setIncludePasswords(event.target.checked)}
            />
            <span>{t("저장된 비밀번호 포함")}</span>
          </label>
          <p className="export-hint">
            {includePasswords
              ? t("키체인에 저장된 DB·SSH·프록시 비밀번호가 파일 안에 함께 암호화됩니다. 파일 암호를 아는 사람은 누구나 꺼낼 수 있습니다.")
              : t("비밀번호는 넣지 않습니다. 가져온 쪽에서 처음 연결할 때 묻습니다.")}
          </p>
          <p className="export-hint">
            {t("SSH 키와 SSL 인증서는 파일 경로만 담깁니다. 가져올 컴퓨터의 같은 경로에 파일을 옮겨 두세요.")}
          </p>
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          <button type="button" onClick={close} disabled={busy}>
            {t("취소")}
          </button>
          <button type="submit" className="primary" disabled={!ready || busy}>
            {busy ? <Spinner size={10} /> : null}
            {t("내보내기")}
          </button>
        </div>
      </form>
    </div>
  );
}
