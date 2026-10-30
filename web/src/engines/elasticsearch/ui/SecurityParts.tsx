// What the 보안 tab's sections and dialogs share: the server's security
// paths in Dev Tools notation (for the confirmations), the privilege names
// offered while typing, and the chip field that edits a list of names.

import { useEffect, useState } from "react";
import { CloseIcon } from "../../../components/icons";
import { SuggestInput } from "../../../components/SuggestInput";
import { t } from "../../../i18n";
import { isAbort, securityList, type SecurityKind, type SecurityOverview } from "../api";
import type { Json } from "../json";
import type { SearchHost } from "./common";

// What every section and dialog of the tab works with.
export interface SecurityContext {
  host: SearchHost;
  overview: SecurityOverview;
  // OpenSearch's security plugin rather than Elasticsearch security.
  os: boolean;
}

const OS_API = "/_plugins/_security/api";

function segment(name: string): string {
  return encodeURIComponent(name.trim());
}

// The path of one user, role or role mapping, as the server writes it.
export function entryPath(os: boolean, kind: Exclude<SecurityKind, "api_keys">, name: string): string {
  const base = os
    ? `${OS_API}/${kind === "users" ? "internalusers" : kind === "roles" ? "roles" : "rolesmapping"}`
    : `/_security/${kind === "users" ? "user" : kind === "roles" ? "role" : "role_mapping"}`;
  return `${base}/${segment(name)}`;
}

export function apiKeyPath(os: boolean): string {
  return os ? `${OS_API}/apitokens` : "/_security/api_key";
}

export function apiKeyInvalidatePath(os: boolean, id: string): string {
  return os ? `${OS_API}/apitokens/${segment(id)}` : "/_security/api_key";
}

export const MASK = "****";

// A body as the confirmation shows it: the password never in plain text.
export function masked(body: { [key: string]: Json }): { [key: string]: Json } {
  return "password" in body ? { ...body, password: MASK } : body;
}

// A string or a list of them as a list.
export function names(value: Json | undefined): string[] {
  if (typeof value === "string") {
    return value === "" ? [] : [value];
  }
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

export function objectOf(value: Json | undefined): { [key: string]: Json } {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) ? value : {};
}

// The names of one kind of entry, for suggestions; empty until read (and
// when they can't be).
export function useEntryNames(conn: string, kind: SecurityKind, enabled = true): string[] {
  const [list, setList] = useState<string[]>([]);
  useEffect(() => {
    if (!enabled) {
      return;
    }
    const ctl = new AbortController();
    securityList(conn, kind, ctl.signal).then(
      (entries) => setList(entries.map((entry) => entry.name).filter((name) => name !== "")),
      (e: unknown) => {
        if (!isAbort(e)) {
          setList([]);
        }
      },
    );
    return () => ctl.abort();
  }, [conn, kind, enabled]);
  return list;
}

// Elasticsearch's built-in privileges (`GET _security/privilege/_builtin`
// of 8.x), offered while typing; any other name is still taken.
export const ES_CLUSTER_PRIVILEGES = [
  "all",
  "monitor",
  "manage",
  "manage_security",
  "manage_api_key",
  "manage_own_api_key",
  "manage_index_templates",
  "manage_ingest_pipelines",
  "manage_pipeline",
  "manage_ilm",
  "manage_slm",
  "manage_transform",
  "manage_ml",
  "manage_watcher",
  "manage_ccr",
  "manage_enrich",
  "manage_rollup",
  "manage_token",
  "manage_service_account",
  "manage_logstash_pipelines",
  "manage_search_application",
  "manage_inference",
  "manage_autoscaling",
  "manage_data_frame_transforms",
  "manage_saml",
  "manage_oidc",
  "manage_user_profile",
  "monitor_ml",
  "monitor_watcher",
  "monitor_rollup",
  "monitor_snapshot",
  "monitor_transform",
  "monitor_enrich",
  "monitor_inference",
  "monitor_text_structure",
  "read_ilm",
  "read_slm",
  "read_ccr",
  "read_pipeline",
  "read_security",
  "create_snapshot",
  "cancel_task",
  "grant_api_key",
  "transport_client",
  "cross_cluster_search",
  "cross_cluster_replication",
];

export const ES_INDEX_PRIVILEGES = [
  "all",
  "read",
  "read_cross_cluster",
  "view_index_metadata",
  "monitor",
  "write",
  "index",
  "create",
  "create_doc",
  "delete",
  "create_index",
  "delete_index",
  "auto_configure",
  "manage",
  "maintenance",
  "manage_ilm",
  "manage_data_stream_lifecycle",
  "manage_follow_index",
  "manage_leader_index",
];

// OpenSearch's default action groups; single actions (`indices:data/read/*`)
// are typed as they are.
export const OS_CLUSTER_PERMISSIONS = [
  "cluster_all",
  "cluster_monitor",
  "cluster_composite_ops",
  "cluster_composite_ops_ro",
  "cluster_manage_index_templates",
  "cluster_manage_pipelines",
  "manage_snapshots",
  "cluster:admin/opendistro/ism/*",
  "cluster:admin/opensearch/ql/datasources/*",
  "cluster:monitor/*",
  "indices:data/read/scroll*",
  "indices:data/read/mget*",
  "indices:data/read/msearch*",
];

export const OS_INDEX_PERMISSIONS = [
  "indices_all",
  "unlimited",
  "read",
  "search",
  "get",
  "write",
  "crud",
  "index",
  "delete",
  "data_access",
  "create_index",
  "manage",
  "manage_aliases",
  "indices_monitor",
  "indices:data/read/*",
  "indices:data/write/*",
  "indices:admin/mappings/get",
];

export const OS_TENANT_PERMISSIONS = ["kibana_all_read", "kibana_all_write"];

// A list of names as chips, with a field (and suggestions) to add more:
// Return, a comma or leaving the field adds what is typed, Backspace in the
// empty field takes the last one back.
export function TokenInput({
  values,
  onChange,
  suggestions = [],
  placeholder,
  ariaLabel,
  readOnly = false,
  autoFocus,
}: {
  values: string[];
  onChange(values: string[]): void;
  suggestions?: readonly string[];
  placeholder?: string;
  ariaLabel: string;
  readOnly?: boolean;
  autoFocus?: boolean;
}) {
  const [draft, setDraft] = useState("");

  function add(text: string): void {
    const fresh = text
      .split(",")
      .map((part) => part.trim())
      .filter((part, i, all) => part !== "" && !values.includes(part) && all.indexOf(part) === i);
    if (fresh.length > 0) {
      onChange([...values, ...fresh]);
    }
    setDraft("");
  }

  return (
    <div className={`es-sec-tokens${readOnly ? " readonly" : ""}`}>
      {values.map((value, i) => (
        <span key={`${value}\u0000${i}`} className="es-chip mono">
          {value}
          {readOnly ? null : (
            <button type="button" className="es-chip-x" aria-label={t("{name} 빼기", { name: value })} onClick={() => onChange(values.filter((_, j) => j !== i))}>
              <CloseIcon size={8} />
            </button>
          )}
        </span>
      ))}
      {readOnly ? (
        values.length === 0 ? <span className="panel-dim">—</span> : null
      ) : (
        <SuggestInput
          type="text"
          className="es-sec-token-field mono"
          spellCheck={false}
          autoFocus={autoFocus}
          aria-label={ariaLabel}
          placeholder={values.length === 0 ? placeholder : undefined}
          suggestions={suggestions.filter((s) => !values.includes(s))}
          value={draft}
          onChange={(event) => {
            const value = event.target.value;
            // A pick from the list arrives as a plain input Event (typing and
            // pasting as an InputEvent): a picked name goes in at once.
            if (!(event.nativeEvent instanceof InputEvent) || value.endsWith(",")) {
              add(value);
              return;
            }
            setDraft(value);
          }}
          onKeyDown={(event) => {
            const field = event.currentTarget;
            if (event.key === "Enter" && !event.nativeEvent.isComposing && draft.trim() !== "" && !field.hasAttribute("aria-activedescendant")) {
              // A highlighted suggestion is the list's to pick.
              event.preventDefault();
              add(draft);
            } else if (event.key === "Backspace" && draft === "" && values.length > 0) {
              onChange(values.slice(0, -1));
            }
          }}
          onBlur={() => {
            if (draft.trim() !== "") {
              add(draft);
            }
          }}
        />
      )}
    </div>
  );
}
