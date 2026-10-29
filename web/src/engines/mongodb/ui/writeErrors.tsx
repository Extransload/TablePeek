// Write failures in the document views: the explained notice (with the
// workbench's "검증 탭 열기") and, for a validation failure (121), which
// fields broke which rule, read from the server's errInfo.

import { createContext, useContext } from "react";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { t } from "../../../i18n";
import { fromEJSON, isDocument } from "../bson";
import { toShell } from "../format";

// Opens the collection's 검증 tab; null where there is none (the shell, a
// read-only connection).
export const OpenValidationContext = createContext<(() => void) | null>(null);

// A failed write, explained for the document views.
export function WriteErrorNotice({ error, variant = "compact", onClose }: { error: unknown; variant?: "block" | "compact"; onClose?(): void }) {
  const openValidation = useContext(OpenValidationContext);
  return <ErrorNotice error={error} context="document" variant={variant} onFix={openValidation === null ? undefined : { "open-validation": openValidation }} onClose={onClose} />;
}

// The thrown value as an Error, so a save resolves to one failure type.
export function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

// For a validation failure: each failing field path (dotted, as the card
// view names rows) and what it broke. Empty when the error says nothing
// field by field (another error, or a validator without $jsonSchema).
export function validationProblems(error: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const details = error !== null && typeof error === "object" && "details" in error ? error.details : undefined;
  const errInfo = record(record(details)?.errInfo);
  const rules = record(errInfo?.details)?.schemaRulesNotSatisfied;
  walk(rules, "", out);
  return out;
}

function record(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function add(out: Map<string, string>, path: string, text: string): void {
  out.set(path, out.has(path) ? `${out.get(path)} · ${text}` : text);
}

// The rules of one schema level (`schemaRulesNotSatisfied`, or a property's
// `details`), under `prefix`.
function walk(rules: unknown, prefix: string, out: Map<string, string>): void {
  if (!Array.isArray(rules)) {
    return;
  }
  for (const item of rules) {
    const rule = record(item);
    if (rule === null) {
      continue;
    }
    if (Array.isArray(rule.propertiesNotSatisfied)) {
      for (const p of rule.propertiesNotSatisfied) {
        const prop = record(p);
        if (prop !== null && typeof prop.propertyName === "string") {
          property(prop.details, `${prefix}${prop.propertyName}`, out);
        }
      }
    }
    if (Array.isArray(rule.missingProperties)) {
      for (const name of rule.missingProperties) {
        add(out, `${prefix}${String(name)}`, t("필수 필드인데 없습니다"));
      }
    }
    if (rule.operatorName === "additionalProperties" && Array.isArray(rule.additionalProperties)) {
      for (const name of rule.additionalProperties) {
        add(out, `${prefix}${String(name)}`, t("규칙에 없는 필드입니다"));
      }
    }
  }
}

// What one field broke: a nested schema's own rules, or a check like
// `minimum` or `bsonType` with the value it saw.
function property(details: unknown, path: string, out: Map<string, string>): void {
  if (!Array.isArray(details) || details.length === 0) {
    add(out, path, t("검증 규칙에 맞지 않습니다"));
    return;
  }
  for (const item of details) {
    const detail = record(item);
    if (detail === null) {
      continue;
    }
    if (Array.isArray(detail.propertiesNotSatisfied) || Array.isArray(detail.missingProperties)) {
      walk([detail], `${path}.`, out);
      continue;
    }
    const specified = fromEJSON(detail.specifiedAs);
    const rule = isDocument(specified) ? toShell(specified) : String(detail.operatorName ?? "");
    add(
      out,
      path,
      "consideredValue" in detail
        ? t("규칙 {rule}에 맞지 않습니다 — 지금 값 {value}", { rule, value: toShell(fromEJSON(detail.consideredValue)) })
        : t("규칙 {rule}에 맞지 않습니다", { rule }),
    );
  }
}
