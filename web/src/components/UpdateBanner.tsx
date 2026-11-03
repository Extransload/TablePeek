import { useEffect, useState, useSyncExternalStore } from "react";
import { t } from "../i18n";
import type { UpdateStatus } from "../store";
import {
  configureUpdate,
  dismissRelease,
  getInstall,
  getUpdate,
  installBusy,
  installRelease,
  loadUpdate,
  offeredRelease,
  subscribeInstall,
  subscribeUpdate,
  type InstallState,
} from "../update";
import { notifyError } from "./ErrorNotice";
import { CloseIcon, DownloadIcon, ExternalIcon } from "./icons";
import { Spinner } from "./Spinner";

// A slim bar over the home screen and the workbench when a newer release is
// out: its release notes, how to update this copy (or, in the desktop app,
// installing it and restarting), skipping the release, and closing the bar
// until the next window. Nothing shows while the check is off, offline, or
// finds nothing newer.
export function UpdateBanner() {
  const update = useSyncExternalStore(subscribeUpdate, getUpdate);
  const install = useSyncExternalStore(subscribeInstall, getInstall);
  const [howOpen, setHowOpen] = useState(false);

  useEffect(() => {
    // A failed ask says nothing here (Settings shows the check's state).
    loadUpdate().catch(() => {});
  }, []);

  const latest = offeredRelease(update);
  if (update === null || latest === null) {
    return null;
  }
  // Skipping or closing the bar would hide an install under way.
  const busy = installBusy(install);
  return (
    <>
      <section className="update-banner" aria-label={t("새 버전")}>
        <DownloadIcon size={12} className="update-banner-icon" />
        <span className="update-banner-text" role="status">
          {t("TablePeek {latest}이 나왔습니다 (지금 {current})", { latest, current: update.current })}
        </span>
        {update.url !== null ? (
          <button
            type="button"
            className="link-button"
            onClick={() => window.open(update.url ?? undefined, "_blank", "noopener")}
          >
            {t("변경 내역")}
            <ExternalIcon size={10} />
          </button>
        ) : null}
        {update.installable ? (
          <UpdateInstallAction install={install} />
        ) : (
          <button type="button" className="link-button" onClick={() => setHowOpen(true)}>
            {t("업데이트 방법")}
          </button>
        )}
        {busy ? null : (
          <>
            <button
              type="button"
              className="link-button update-banner-skip"
              onClick={() => {
                configureUpdate({ skipped: latest }).catch((error: unknown) => notifyError(error));
              }}
            >
              {t("이 버전 건너뛰기")}
            </button>
            <button
              type="button"
              className="icon-button update-banner-close"
              title={t("닫기")}
              aria-label={t("닫기")}
              onClick={() => dismissRelease(latest)}
            >
              <CloseIcon size={11} />
            </button>
          </>
        )}
      </section>
      {howOpen ? <UpdateHowDialog update={update} latest={latest} onClose={() => setHowOpen(false)} /> : null}
    </>
  );
}

// Installs the release and restarts (the desktop app): a button, then how far
// the install has come, or the error it stopped with and a retry. The error's
// details show as a toast.
export function UpdateInstallAction({ install, className = "link-button" }: { install: InstallState; className?: string }) {
  function start(): void {
    void installRelease().then(() => {
      const after = getInstall();
      if (after.phase === "error") {
        notifyError(after.error, { retry: start });
      }
    });
  }

  if (installBusy(install)) {
    let text: string;
    if (install.phase === "download") {
      text = install.percent === null ? t("내려받는 중…") : t("내려받는 중… {percent}%", { percent: install.percent });
    } else if (install.phase === "install") {
      text = t("설치하는 중…");
    } else {
      text = t("다시 시작하는 중…");
    }
    return (
      <span className="update-install-progress" role="status">
        <Spinner size={10} />
        {text}
      </span>
    );
  }
  return (
    <>
      {install.phase === "error" ? <span className="update-install-error">{t("설치하지 못했습니다")}</span> : null}
      <button type="button" className={className} onClick={start}>
        <DownloadIcon size={11} />
        {install.phase === "error" ? t("다시 시도") : t("설치하고 다시 시작")}
      </button>
    </>
  );
}

// The platform a release archive is for, by its Rust target.
const PLATFORMS: Record<string, string> = {
  "aarch64-apple-darwin": "macOS (Apple Silicon)",
  "x86_64-apple-darwin": "macOS (Intel)",
  "x86_64-unknown-linux-gnu": "Linux (x86_64)",
  "aarch64-unknown-linux-gnu": "Linux (ARM64)",
  "x86_64-pc-windows-msvc": "Windows (x64)",
};

// How to update this copy: a release binary is replaced with the archive for
// this platform; a source build pulls and builds again.
export function UpdateHowDialog({
  update,
  latest,
  onClose,
}: {
  update: UpdateStatus;
  latest: string;
  onClose(): void;
}) {
  // Esc closes this dialog only, not the one under it.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  const windows = update.target.includes("windows");
  const mac = update.target.includes("apple-darwin");
  const binary = windows ? "tablepeek.exe" : "tablepeek";
  const platform = PLATFORMS[update.target] ?? update.target;
  // The archive itself when the release has one for this platform, else
  // the release page to pick from.
  const download = update.asset_url ?? update.url;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal update-how-modal"
        role="dialog"
        aria-label={t("업데이트 방법")}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-title">{t("업데이트 방법")}</span>
          <span className="modal-path">
            {update.current} → {latest}
          </span>
        </div>
        <div className="modal-body update-how-body">
          {update.dist === "release" ? (
            <ol className="update-how-steps">
              <li>
                <span>{t("{platform}용 압축 파일을 내려받습니다.", { platform })}</span>
                {download !== null ? (
                  <a className="update-how-asset mono" href={download} target="_blank" rel="noopener noreferrer">
                    <DownloadIcon size={11} />
                    {update.asset_name ?? latest}
                  </a>
                ) : (
                  <code className="update-how-asset mono">{update.asset_name}</code>
                )}
                {update.asset_url === null && update.asset_name !== null ? (
                  <span className="helper">{t("릴리스 페이지에서 위 이름의 파일을 고르세요.")}</span>
                ) : null}
              </li>
              <li>
                <span>{t("TablePeek을 끄고(터미널에서 Ctrl+C), 압축을 풀어 나온 {binary}로 지금 쓰는 실행 파일을 바꿉니다.", { binary })}</span>
              </li>
              {mac ? (
                <li>
                  <span>{t("macOS가 내려받은 파일이라며 실행을 막으면 격리 표시를 지웁니다.")}</span>
                  <pre className="update-how-command">xattr -d com.apple.quarantine tablepeek</pre>
                </li>
              ) : null}
              <li>
                <span>{t("다시 실행하고 버전을 확인합니다.")}</span>
                <pre className="update-how-command">{`${windows ? ".\\tablepeek.exe" : "./tablepeek"} serve\n${windows ? ".\\tablepeek.exe" : "./tablepeek"} --version`}</pre>
              </li>
            </ol>
          ) : (
            <ol className="update-how-steps">
              <li>
                <span>{t("소스에서 빌드한 TablePeek입니다. 저장소 폴더에서 새 코드를 받아 다시 빌드합니다.")}</span>
                <pre className="update-how-command">git pull && make build</pre>
              </li>
              <li>
                <span>{t("TablePeek을 끄고(터미널에서 Ctrl+C) 다시 실행합니다.")}</span>
                <pre className="update-how-command">make run</pre>
              </li>
            </ol>
          )}
        </div>
        <div className="modal-foot">
          {update.url !== null ? (
            <button type="button" onClick={() => window.open(update.url ?? undefined, "_blank", "noopener")}>
              <ExternalIcon size={11} />
              {t("릴리스 페이지")}
            </button>
          ) : null}
          <span className="spacer" />
          <button type="button" className="primary" onClick={onClose}>
            {t("닫기")}
          </button>
        </div>
      </div>
    </div>
  );
}
