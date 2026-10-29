import { useEffect, useId, useState, useSyncExternalStore } from "react";
import { t } from "../i18n";
import { store } from "../store";
import { FieldError, fieldErrorProps } from "./ErrorNotice";
import { AlertIcon } from "./icons";
import { Spinner } from "./Spinner";

// The one place that says the TablePeek server can't be reached (every panel
// leaves that error to it): while it is down, when the next try comes and a
// button to try now; once it restarted with a new token, how to open the
// address it gave.
export function ServerBanner() {
  const server = useSyncExternalStore(store.subscribe, () => store.getState().server);
  const [now, setNow] = useState(() => Date.now());
  const [address, setAddress] = useState("");
  const [addressError, setAddressError] = useState<string | null>(null);
  const addressErrorId = useId();

  // The countdown to the next try.
  useEffect(() => {
    if (server.retryAt === null) {
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [server.retryAt]);

  if (server.reach === "up") {
    return null;
  }

  if (server.reach === "restarted") {
    return (
      <section className="server-banner" aria-label={t("서버 연결")}>
        <AlertIcon size={13} className="server-banner-icon" />
        <div className="server-banner-text">
          <strong role="alert">{t("TablePeek 서버가 다시 시작되었습니다")}</strong>
          <span>
            {t(
              "이 창의 접속 키가 더 이상 맞지 않습니다. 서버가 새로 연 창을 쓰거나, 서버가 터미널에 보여 준 주소(…/?token=…)를 붙여 넣으세요.",
            )}
          </span>
          <form
            className="server-banner-address"
            onSubmit={(event) => {
              event.preventDefault();
              if (!store.openNewAddress(address)) {
                setAddressError(t("주소에서 token을 찾지 못했습니다"));
              }
            }}
          >
            <input
              value={address}
              placeholder="http://127.0.0.1:…/?token=…"
              aria-label={t("서버의 새 주소")}
              spellCheck={false}
              onChange={(event) => {
                setAddress(event.target.value);
                setAddressError(null);
              }}
              {...fieldErrorProps(addressErrorId, addressError)}
            />
            <button type="submit" className="primary" disabled={address.trim() === ""}>
              {t("새 주소로 열기")}
            </button>
          </form>
          <FieldError id={addressErrorId} error={addressError} />
        </div>
      </section>
    );
  }

  const seconds = server.retryAt === null ? null : Math.max(0, Math.ceil((server.retryAt - now) / 1000));
  return (
    <section className="server-banner" aria-label={t("서버 연결")}>
      <AlertIcon size={13} className="server-banner-icon" />
      <div className="server-banner-text">
        <strong role="alert">{t("TablePeek 서버에 연결할 수 없습니다")}</strong>
        <span>
          {server.checking
            ? t("다시 연결하는 중…")
            : seconds !== null
              ? t("{seconds}초 뒤에 다시 연결해 봅니다. 서버를 껐다면 다시 실행하세요.", { seconds })
              : t("서버를 껐다면 다시 실행하세요.")}
        </span>
      </div>
      <button type="button" disabled={server.checking} onClick={() => void store.reconnect()}>
        {server.checking ? <Spinner size={11} /> : null}
        {t("다시 연결")}
      </button>
    </section>
  );
}
