import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { onOidcLogins, store, type OidcLogin } from "../store";
import { notifyError } from "./ErrorNotice";
import { KeyIcon } from "./icons";

// A MongoDB connection with OIDC browser login waits for the user: the
// provider's login page, opened in a new browser tab (by the button, as a
// browser may block a tab the page opens on its own), and a way to give up.
// The provider sends the browser back to TablePeek, and the connect goes on.
export function OidcLoginBanner() {
  const [logins, setLogins] = useState<OidcLogin[]>([]);
  // Logins whose page was already opened once without a click.
  const opened = useRef(new Set<string>());

  useEffect(
    () =>
      onOidcLogins((next) => {
        setLogins(next);
        for (const login of next) {
          if (!opened.current.has(login.id)) {
            opened.current.add(login.id);
            window.open(login.url, "_blank", "noopener");
          }
        }
      }),
    [],
  );

  if (logins.length === 0) {
    return null;
  }
  return (
    <>
      {logins.map((login) => (
        <section key={login.id} className="server-banner oidc-banner" aria-label={t("OIDC 로그인")}>
          <KeyIcon size={13} className="server-banner-icon" />
          <div className="server-banner-text">
            <strong role="status">{t("MongoDB에 로그인하려면 브라우저에서 계속하세요")}</strong>
            <span>{t("{issuer}에 로그인하면 연결이 이어집니다.", { issuer: login.issuer })}</span>
          </div>
          <button type="button" className="primary" onClick={() => window.open(login.url, "_blank", "noopener")}>
            {t("로그인 페이지 열기")}
          </button>
          <button
            type="button"
            onClick={() => {
              setLogins((current) => current.filter((other) => other.id !== login.id));
              store.cancelOidcLogin(login.id).catch((error: unknown) => notifyError(error));
            }}
          >
            {t("취소")}
          </button>
        </section>
      ))}
    </>
  );
}
