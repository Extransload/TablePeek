import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { t } from "../../i18n";
import { store, type VersionInfo } from "../../store";
import { checkUpdateNow, configureUpdate, getInstall, getUpdate, loadUpdate, refreshUpdate, subscribeInstall, subscribeUpdate } from "../../update";
import { AlertIcon, CheckIcon, CodeIcon, DownloadIcon, ExternalIcon, RefreshIcon } from "../icons";
import { notifyError } from "../ErrorNotice";
import { Spinner } from "../Spinner";
import { UpdateHowDialog, UpdateInstallAction } from "../UpdateBanner";
import { SettingRow, SettingsGroup, Switch } from "./rows";

// Why the last update check failed, by the server's code: the status's second line.
function updateErrorText(code: string): string {
  if (code === "network") {
    return t("네트워크에 연결할 수 없습니다");
  }
  if (code === "timeout") {
    return t("GitHub가 5초 안에 답하지 않았습니다");
  }
  if (code === "rate_limited") {
    return t("GitHub 요청 한도에 걸렸습니다");
  }
  if (code.startsWith("http_")) {
    return t("GitHub가 HTTP {status}로 답했습니다", { status: code.slice(5) });
  }
  return t("GitHub의 릴리스 정보를 읽지 못했습니다");
}

// General: what this build is, and the check for a newer release.
export function VersionSettings() {
  const update = useSyncExternalStore(subscribeUpdate, getUpdate);
  const install = useSyncExternalStore(subscribeInstall, getInstall);
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [howOpen, setHowOpen] = useState(false);

  useEffect(() => {
    store.fetchVersion().then(setVersion, (error: unknown) => notifyError(error));
    loadUpdate().catch((error: unknown) => notifyError(error));
  }, []);

  async function checkNow(): Promise<void> {
    setChecking(true);
    try {
      await checkUpdateNow();
    } catch (error) {
      notifyError(error);
    } finally {
      setChecking(false);
    }
  }

  async function setEnabled(enabled: boolean): Promise<void> {
    try {
      await configureUpdate({ enabled });
      // Turned on: the server checks now if the last check is a day old.
      if (enabled) {
        setChecking(true);
        await refreshUpdate();
      }
    } catch (error) {
      notifyError(error);
    } finally {
      setChecking(false);
    }
  }

  const checkedAt = update !== null && update.checked_at !== null ? new Date(update.checked_at * 1000).toLocaleString() : null;
  const lastChecked = checkedAt === null ? null : t("마지막 확인: {time}", { time: checkedAt });
  // One status line in the tone of what it says: green when this is the
  // newest release, orange when a newer one is out, the accent for a build
  // ahead of the newest release, red when the check failed, muted otherwise.
  let tone: "ok" | "new" | "ahead" | "error" | "muted" = "muted";
  let icon: ReactNode = <RefreshIcon size={13} />;
  let title: string;
  let detail: string | null = lastChecked;
  if (update === null || (checking && update.enabled)) {
    icon = <Spinner size={11} />;
    title = t("확인하는 중…");
    detail = null;
  } else if (!update.enabled) {
    title = t("새 버전 확인이 꺼져 있습니다");
    detail = null;
  } else if (update.newer && update.latest !== null) {
    tone = "new";
    icon = <DownloadIcon size={13} />;
    title = update.latest === update.skipped ? t("{latest}이 나왔습니다 (건너뛴 버전)", { latest: update.latest }) : t("{latest}이 나왔습니다", { latest: update.latest });
    detail = update.published_at !== null ? t("지금 {current} · {date} 공개", { current: update.current, date: new Date(update.published_at).toLocaleDateString() }) : t("지금 {current}", { current: update.current });
  } else if (update.error !== null) {
    tone = "error";
    icon = <AlertIcon size={13} />;
    title = t("새 버전을 확인하지 못했습니다");
    detail = updateErrorText(update.error);
  } else if (update.checked_at === null) {
    title = t("아직 확인하지 않았습니다");
  } else if (update.latest === null) {
    title = t("아직 공개된 릴리스가 없습니다");
  } else if (update.latest !== update.current) {
    tone = "ahead";
    icon = <CodeIcon size={13} />;
    title = t("최신 릴리스보다 앞선 빌드입니다");
    detail = [t("최신 릴리스 {latest}", { latest: update.latest }), lastChecked].filter(Boolean).join(" · ");
  } else {
    tone = "ok";
    icon = <CheckIcon size={13} />;
    title = t("최신 버전입니다");
  }

  return (
    <SettingsGroup title="버전">
      <SettingRow label="TablePeek" keywords={`${t("버전")} 버전 업데이트 version update`} wide>
        <div className="version-head">
          {version === null ? (
            <Spinner size={10} />
          ) : (
            <>
              <span className="version-number mono" data-testid="settings-version">
                v{version.version}
              </span>
              <span className="version-chip mono" title={t("커밋")}>
                {version.commit}
              </span>
              <span className="version-chip">
                {version.dist === "release" ? t("릴리스 바이너리") : version.dist === "desktop" ? t("데스크톱 앱") : t("소스 빌드")}
              </span>
            </>
          )}
        </div>
        <div className={`version-status ${tone}`} role="status">
          <span className="version-status-icon">{icon}</span>
          <div className="version-status-text">
            <span className="version-status-title">{title}</span>
            {detail !== null ? <span className="version-status-detail">{detail}</span> : null}
          </div>
          <div className="version-status-actions">
            {update?.enabled && update.newer && update.latest !== null ? (
              <>
                {update.url !== null ? (
                  <a className="link-button" href={update.url} target="_blank" rel="noreferrer">
                    {t("변경 내역")}
                    <ExternalIcon size={10} />
                  </a>
                ) : null}
                {update.skipped !== null && update.skipped === update.latest ? (
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => {
                      configureUpdate({ skipped: null }).catch((error: unknown) => notifyError(error));
                    }}
                  >
                    {t("다시 알리기")}
                  </button>
                ) : null}
                {update.installable ? (
                  <UpdateInstallAction install={install} className="version-update-button" />
                ) : (
                  <button type="button" className="version-update-button" onClick={() => setHowOpen(true)}>
                    {t("업데이트 방법")}
                  </button>
                )}
              </>
            ) : null}
            {update?.enabled ? (
              <button type="button" onClick={() => void checkNow()} disabled={checking}>
                <RefreshIcon size={11} />
                {t("지금 확인")}
              </button>
            ) : null}
          </div>
        </div>
      </SettingRow>
      <SettingRow
        label="새 버전 확인"
        hint={update?.env_disabled ? t("TABLEPEEK_NO_UPDATE_CHECK 환경 변수가 확인을 껐습니다.") : undefined}
        changed={update !== null && !update.enabled && !update.env_disabled}
        onReset={() => void setEnabled(true)}
      >
        <Switch
          label="새 버전 확인"
          checked={update?.enabled ?? true}
          disabled={update === null || update.env_disabled}
          onChange={(enabled) => void setEnabled(enabled)}
        />
      </SettingRow>
      {/* Over the app, not inside the sheet (which may be glass, and so
          holds what is fixed inside it). */}
      {howOpen && update !== null && update.latest !== null
        ? createPortal(<UpdateHowDialog update={update} latest={update.latest} onClose={() => setHowOpen(false)} />, document.body)
        : null}
    </SettingsGroup>
  );
}
