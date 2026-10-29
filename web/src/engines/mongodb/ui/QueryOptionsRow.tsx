// The query bar's second 옵션 row (MONGODB.md §8.1): collation (a locale
// with suggestions and a strength), hint (one of the collection's indexes,
// or a key document typed out) and the query's own maxTimeMS, which
// replaces the settings' query timeout for this query.

import { useEffect, useState, type KeyboardEvent } from "react";
import { fieldErrorProps } from "../../../components/ErrorNotice";
import { Select } from "../../../components/Select";
import { SuggestInput } from "../../../components/SuggestInput";
import { t } from "../../../i18n";
import { isAbort, listIndexes, type Namespace } from "../api";
import { MongoEditor } from "./MongoEditor";
import type { QueryError, QueryKey, QueryText } from "./QueryBar";

// Locales the server's collation supports, the common ones (any supported
// locale may be typed).
const LOCALES = [
  "simple", "ko", "en", "en_US", "en_US_POSIX", "ja", "zh", "zh_Hant", "de", "de_AT", "fr", "fr_CA", "es", "it", "pt", "nl",
  "sv", "da", "nb", "nn", "fi_FI", "pl", "cs", "sk", "hu", "ro", "bg", "ru", "uk", "el", "tr", "he", "ar", "fa", "hi",
  "bn", "th", "vi", "id", "ms", "fil",
];

const STRENGTHS: { value: string; label: string }[] = [
  { value: "", label: "강도 기본 (3)" },
  { value: "1", label: "1 · 기본 글자만 (대소문자·악센트 무시)" },
  { value: "2", label: "2 · 악센트 구분 (대소문자 무시)" },
  { value: "3", label: "3 · 대소문자 구분" },
  { value: "4", label: "4 · 문장 부호까지 구분" },
  { value: "5", label: "5 · 모두 구분 (identical)" },
];

// The hint list's entry for "type the keys".
const KEYS = "\u0000keys";

interface QueryOptionsRowProps {
  namespace: Namespace;
  query: QueryText;
  set(key: QueryKey, value: string): void;
  onRun(): void;
  error: QueryError | null;
  // The bar's error line, which the boxes point at.
  errorId: string;
}

export function QueryOptionsRow({ namespace, query, set, onRun, error, errorId }: QueryOptionsRowProps) {
  const [indexes, setIndexes] = useState<string[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    // A view has no indexes of its own (the server refuses); the list stays empty.
    listIndexes(namespace, controller.signal).then(
      (list) => setIndexes(list.map((ix) => ix.name)),
      (failure: unknown) => {
        if (!isAbort(failure)) {
          setIndexes([]);
        }
      },
    );
    return () => controller.abort();
  }, [namespace]);

  const hint = query.hint.trim();
  const keyMode = hint.startsWith("{");
  const invalid = (key: QueryKey) => (error?.key === key ? " invalid" : "");
  const errorProps = (key: QueryKey) => fieldErrorProps(errorId, error?.key === key ? error.message : null);
  const onEnter = (event: KeyboardEvent) => event.key === "Enter" && onRun();

  return (
    <div className="filter-row mg-opts">
      <label className="mg-qlabel">collation</label>
      <SuggestInput
        className={`filter-value mg-q-locale${invalid("locale")}`}
        {...errorProps("locale")}
        suggestions={LOCALES}
        value={query.locale}
        placeholder={t("로캘 (예: ko)")}
        spellCheck={false}
        aria-label={t("collation 로캘")}
        onChange={(event) => set("locale", event.target.value)}
        onKeyDown={onEnter}
      />
      <Select className={`mg-q-select${invalid("strength")}`} value={query.strength} aria-label={t("collation 강도")} title={t("문자열을 비교하는 엄격함")} onChange={(event) => set("strength", event.target.value)}>
        {STRENGTHS.map((s) => (
          <option key={s.value} value={s.value}>
            {t(s.label)}
          </option>
        ))}
      </Select>
      <label className="mg-qlabel">hint</label>
      <Select
        className={`mg-q-select${invalid("hint")}`}
        value={keyMode ? KEYS : hint}
        aria-label={t("사용할 인덱스 (hint)")}
        onChange={(event) => set("hint", event.target.value === KEYS ? "{  }" : event.target.value)}
      >
        <option value="">{t("인덱스 자동 선택")}</option>
        {indexes.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
        {hint !== "" && !keyMode && !indexes.includes(hint) ? <option value={hint}>{hint}</option> : null}
        <option value={KEYS}>{t("키 문서로 쓰기…")}</option>
      </Select>
      {keyMode ? (
        <MongoEditor
          className={`mg-q mg-q-hint${invalid("hint")}`}
          singleLine
          autoFocus
          value={query.hint}
          onChange={(text) => set("hint", text)}
          onRun={onRun}
          role="sort"
          placeholder={t("{ 필드: 1 }")}
          error={error?.key === "hint" ? error.range : null}
          ariaLabel={t("hint 키 문서")}
        />
      ) : null}
      <label className="mg-qlabel">maxTimeMS</label>
      <input
        className={`filter-value mg-q-num${invalid("maxTimeMS")}`}
        {...errorProps("maxTimeMS")}
        value={query.maxTimeMS}
        placeholder={t("설정값")}
        title={t("이 쿼리의 서버 실행 시간 제한(밀리초). 비우면 설정의 쿼리 시간 제한을 씁니다")}
        inputMode="numeric"
        spellCheck={false}
        aria-label="maxTimeMS"
        onChange={(event) => set("maxTimeMS", event.target.value)}
        onKeyDown={onEnter}
      />
    </div>
  );
}
