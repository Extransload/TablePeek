import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { writeClipboard } from "../clipboard";
import { t } from "../i18n";
import { CopyIcon } from "./icons";

interface FieldBoxProps {
  name: string;
  // Column or JSON type shown on the right of the name, when known.
  type?: string | null;
  // undefined while the value is still loading.
  value: unknown;
  // Extra control beside the name (a foreign-key jump, say).
  action?: ReactNode;
  // Shown faint in place of the value ("Multiple values", say).
  note?: string;
}

// The box shows a few lines; drawing the rest of a large value only costs time.
const SHOWN_MAX = 2000;
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
// with NULL and empty strings shown as faint placeholders. Copy takes the
// value as stored, not the indented view.
export function FieldBox({ name, type, value, action, note }: FieldBoxProps) {
  const [copied, setCopied] = useState<string | null>(null);
  const timerRef = useRef(0);
  useEffect(() => () => window.clearTimeout(timerRef.current), []);
  const loading = value === undefined;
  const placeholder =
    note ?? (loading ? "…" : value === null ? "NULL" : value === "" ? "EMPTY" : null);
  const text = placeholder === null ? valueText(value) : "";
  const shown = useMemo(() => {
    if (text === "") {
      return "";
    }
    const pretty = displayText(text);
    return pretty.length > SHOWN_MAX ? `${pretty.slice(0, SHOWN_MAX)}…` : pretty;
  }, [text]);

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
      <div className={`field-box-value${placeholder !== null ? " placeholder" : ""}`}>
        {placeholder ?? shown}
        {placeholder === null ? (
          <button
            type="button"
            className="field-box-copy"
            title={copied ?? t("값 복사")}
            onClick={() => {
              let failed: string | null = null;
              void writeClipboard(text, (message) => {
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
