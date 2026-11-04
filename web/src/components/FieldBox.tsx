import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { writeClipboard } from "../clipboard";
import { t } from "../i18n";
import { inkOf, jsonSpans, type JsonKind } from "../jsonIndex";
import type { ValueKind } from "../palette";
import { CopyIcon } from "./icons";

interface FieldBoxProps {
  name: string;
  // Column or JSON type shown on the right of the name, when known.
  type?: string | null;
  // undefined while the value is still loading.
  value: unknown;
  // The value already as text (JSON indented as stored, say): shown and
  // copied as is, in place of `value`.
  text?: string;
  // Past the shown length, a button draws the whole value (instead of an
  // ellipsis).
  showAll?: boolean;
  // The value's JSON kind: the value is drawn in the data grid's colour for
  // that kind, an object or array token by token.
  json?: JsonKind;
  // Or the value's kind as the data grid tells it (classifyCell): drawn in
  // the grid's colour for it, JSON objects and arrays token by token.
  kind?: ValueKind | null;
  // Extra control beside the name (a foreign-key jump, say).
  action?: ReactNode;
  // Shown faint in place of the value ("Multiple values", say).
  note?: string;
}

// The box shows a few lines; drawing the rest of a large value only costs time.
const SHOWN_MAX = 2000;
// Past this, JSON is drawn plain: a span per token would cost more than it shows.
const INK_MAX = 50_000;
// Past this, indenting JSON is not worth parsing it.
const PRETTY_MAX = 200_000;

function valueText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

// JSON text stored in a column reads better indented; anything else as is.
function displayText(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length > PRETTY_MAX || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
    return text;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object" ? JSON.stringify(parsed, null, 2) : text;
  } catch {
    return text;
  }
}

// One labelled value in TablePlus style: name and type above a boxed value,
// with NULL (in the grid's NULL ink) and empty strings shown as placeholders.
// Copy takes the value as stored, not the indented view.
export function FieldBox({ name, type, value, text, showAll, json, kind, action, note }: FieldBoxProps) {
  const [copied, setCopied] = useState<string | null>(null);
  // The text drawn whole after "show all"; another value starts cut again.
  const [whole, setWhole] = useState<string | null>(null);
  const timerRef = useRef(0);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);
  const placeholder =
    note ??
    (text !== undefined ? null : value === undefined ? "…" : value === null ? "NULL" : value === "" ? "EMPTY" : null);
  const isNull = note === undefined && text === undefined && value === null;
  const copyText = useMemo(
    () => (placeholder !== null ? "" : (text ?? valueText(value))),
    [placeholder, text, value],
  );
  const pretty = useMemo(
    () => (copyText === "" || text !== undefined ? copyText : displayText(copyText)),
    [copyText, text],
  );
  const cut = pretty.length > SHOWN_MAX && whole !== pretty;
  const shown = useMemo(
    () => (!cut ? pretty : showAll ? pretty.slice(0, SHOWN_MAX) : `${pretty.slice(0, SHOWN_MAX)}…`),
    [cut, pretty, showAll],
  );
  const drawn = useMemo((): ReactNode => {
    // The ink of the whole value, or "tokens" for JSON drawn token by token.
    const ink =
      json !== undefined
        ? json === "object" || json === "array"
          ? "tokens"
          : inkOf(json, value)
        : kind === "json" || kind === "list"
          ? "tokens"
          : kind;
    if (ink === undefined || ink === null || shown === "") {
      return shown;
    }
    if (ink !== "tokens") {
      return <span className={`jv-${ink}`}>{shown}</span>;
    }
    if (shown.length > INK_MAX) {
      return shown;
    }
    const parts: ReactNode[] = [];
    let at = 0;
    for (const span of jsonSpans(shown)) {
      if (span.from > at) {
        parts.push(shown.slice(at, span.from));
      }
      parts.push(
        <span key={span.from} className={`jv-${span.ink}`}>
          {shown.slice(span.from, span.to)}
        </span>,
      );
      at = span.to;
    }
    parts.push(shown.slice(at));
    return parts;
  }, [json, kind, value, shown]);

  return (
    <div className="field-box">
      <div className="field-box-head">
        <span className="field-box-name" title={name}>
          {name}
        </span>
        {action}
        <span className="spacer" />
        {type ? <span className="field-box-type">{type}</span> : null}
      </div>
      <div className={`field-box-value${placeholder !== null ? " placeholder" : ""}${isNull ? " null" : ""}`}>
        {placeholder ?? drawn}
        {cut && showAll ? (
          <button type="button" className="field-box-more" onClick={() => setWhole(pretty)}>
            {t("전체 표시 ({count}자)", { count: pretty.length.toLocaleString() })}
          </button>
        ) : null}
        {placeholder === null ? (
          <button
            type="button"
            className="field-box-copy"
            title={copied ?? t("값 복사")}
            onClick={() => {
              let failed: string | null = null;
              void writeClipboard(copyText, (message) => {
                failed = message;
              }).then(() => {
                setCopied(failed ?? t("복사했습니다"));
                window.clearTimeout(timerRef.current);
                timerRef.current = window.setTimeout(() => setCopied(null), 1200);
              });
            }}
          >
            <CopyIcon size={11} />
          </button>
        ) : null}
      </div>
    </div>
  );
}
