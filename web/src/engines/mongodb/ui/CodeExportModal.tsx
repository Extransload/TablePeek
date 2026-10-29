// 코드로 (MONGODB.md §8.1): the documents tab's query or the aggregation
// pipeline as driver code (codegen.ts), with or without the code that
// connects, and a copy button. The connection string comes from the live
// connection's settings (its saved profile, or what it was opened with),
// never with its password; the language and the connect choice are
// remembered.

import { useEffect, useMemo, useState } from "react";
import { writeClipboard } from "../../../clipboard";
import { CopyIcon } from "../../../components/icons";
import { Select } from "../../../components/Select";
import { t } from "../../../i18n";
import { store } from "../../../store";
import type { Namespace } from "../api";
import { CODE_LANGUAGES, connectionUri, generateCode, type CodeLanguage, type CodeOptions, type CodeSource } from "../codegen";
import { AdminModal } from "./AdminModal";
import { ShellText } from "./ShellText";

const LANGUAGE_KEY = "tablepeek.mongo.codeLanguage";
const CONNECT_KEY = "tablepeek.mongo.codeConnect";
// A connection the app cannot read the settings of (not a server connection).
const FALLBACK_URI = "mongodb://localhost:27017/";

function storedLanguage(): CodeLanguage {
  try {
    const v = window.localStorage.getItem(LANGUAGE_KEY);
    return CODE_LANGUAGES.some((l) => l.id === v) ? (v as CodeLanguage) : "python";
  } catch {
    return "python";
  }
}

function remember(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Not remembered; the dialog still works.
  }
}

// The connection string of the live connection `conn` from the settings it
// was opened with (secrets already left out by the server), or null when
// it has none.
async function liveUri(conn: string): Promise<{ uri: string; placeholder: boolean } | null> {
  const info = await store.connectionInfo(conn);
  return info === null ? null : connectionUri(info.config);
}

interface CodeExportModalProps {
  ns: Namespace;
  source: CodeSource;
  options?: CodeOptions;
  // A note under the code (집계: stages turned off are left out).
  note?: string;
  // Opens mongosh code in a mongosh tab (the statement, without `use`).
  onOpenShell?(code: string): void;
  notify(message: string): void;
  onClose(): void;
}

export function CodeExportModal({ ns, source, options, note, onOpenShell, notify, onClose }: CodeExportModalProps) {
  const [language, setLanguage] = useState<CodeLanguage>(storedLanguage);
  const [connect, setConnect] = useState(() => {
    try {
      return window.localStorage.getItem(CONNECT_KEY) !== "false";
    } catch {
      return true;
    }
  });
  // undefined while reading the profile; null when there is none.
  const [uri, setUri] = useState<{ uri: string; placeholder: boolean } | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    liveUri(ns.conn).then(
      (found) => live && setUri(found),
      () => live && setUri(null),
    );
    return () => {
      live = false;
    };
  }, [ns.conn]);

  // While the connection settings are on their way the connect code waits
  // for them rather than show a placeholder address.
  const loading = connect && uri === undefined;
  const code = useMemo(
    () => (loading ? "" : generateCode(language, { db: ns.db, coll: ns.coll, source, options, uri: connect ? (uri?.uri ?? FALLBACK_URI) : null })),
    [loading, language, ns.db, ns.coll, source, options, connect, uri],
  );

  const copy = () => {
    void writeClipboard(code, notify);
    notify(t("코드를 복사했습니다"));
  };

  let uriNote: string | null = null;
  if (connect && uri !== undefined) {
    uriNote = uri === null ? t("연결 설정을 읽을 수 없어 접속 주소를 {uri}로 두었습니다", { uri: FALLBACK_URI }) : uri.placeholder ? t("접속 문자열의 <password>를 실제 비밀번호로 바꾸세요") : null;
  }

  return (
    <AdminModal
      title={t("코드로 내보내기")}
      path={`${ns.db}.${ns.coll}`}
      className="mg-code-modal"
      busy={false}
      onClose={onClose}
      foot={
        <>
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            {t("닫기")}
          </button>
          {language === "mongosh" && onOpenShell !== undefined ? (
            <button type="button" onClick={() => onOpenShell(generateCode("mongosh", { db: ns.db, coll: ns.coll, source, options, uri: null }).replace(/^use .*\n\n/, "").trimEnd())}>
              {t("mongosh 탭에서 열기")}
            </button>
          ) : null}
          <button type="button" className="primary" autoFocus disabled={loading} onClick={copy}>
            <CopyIcon size={10} />
            {t("복사")}
          </button>
        </>
      }
    >
      <div className="mg-code-head">
        <Select
          className="mg-input"
          value={language}
          aria-label={t("언어")}
          onChange={(event) => {
            const next = event.target.value as CodeLanguage;
            setLanguage(next);
            remember(LANGUAGE_KEY, next);
          }}
        >
          {CODE_LANGUAGES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </Select>
        <label className="mg-code-check">
          <input
            type="checkbox"
            checked={connect}
            onChange={(event) => {
              setConnect(event.target.checked);
              remember(CONNECT_KEY, String(event.target.checked));
            }}
          />
          {t("접속 코드 포함")}
        </label>
      </div>
      <pre className="panel-pre mg-export-code mg-code-text" aria-label={t("생성한 코드")} aria-busy={loading}>
        {loading ? <span className="panel-dim">{t("접속 설정을 읽는 중…")}</span> : language === "mongosh" ? <ShellText text={code} /> : code}
      </pre>
      {uriNote !== null ? <span className="panel-dim">{uriNote}</span> : null}
      {!connect ? <span className="panel-dim">{t("연결된 client 변수가 있다고 보고 쿼리 부분만 만듭니다")}</span> : null}
      {note !== undefined ? <span className="panel-dim">{note}</span> : null}
    </AdminModal>
  );
}
