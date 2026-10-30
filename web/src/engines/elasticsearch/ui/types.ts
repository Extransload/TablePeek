// Props shared by the index tab's sub-panels, the connection-level tabs and
// the management dialogs of the search workbench.

import type { Json } from "../json";
import type { SearchHost } from "./common";

// What an index tab opens: an index, an alias or a data stream (all of them
// search and read the same way; only an index has its own mapping to change).
export type TargetKind = "index" | "alias" | "data_stream";

export interface IndexPanelProps {
  host: SearchHost;
  // The name the tab opened (an index, alias or data stream).
  index: string;
  kind: TargetKind;
  // False while another sub-tab or tab is in front: no polling, no shortcuts.
  active: boolean;
  // Bumped by the app's refresh (F5).
  refreshSeq: number;
  // Something the panel changed (a field, a setting, an alias): the sidebar
  // and the stats read again.
  onChanged(): void;
}

// The 문서 tab's query as the 실행 계획 tab runs it: the search body built
// from the query bar, or why it does not parse.
export type SearchQuery = { body: Json } | { error: string };

export interface ProfilePanelProps extends IndexPanelProps {
  query: SearchQuery;
  // Bumped by the query bar's 계획 button and ⌘↩ on this tab to run again.
  runSeq: number;
}

export interface SqlPanelProps extends IndexPanelProps {
  // The connection's stable key (column widths are kept by it).
  connKey: string;
}

export interface ConsoleTabProps {
  host: SearchHost;
  // The connection's stable key (recent requests are kept by it).
  connKey: string;
  tabKey: string;
  // The console text, saved with the tab.
  text: string;
  onTextChange(text: string): void;
  active: boolean;
}

export interface ClusterTabProps {
  host: SearchHost;
  active: boolean;
  // Opens an index tab (from the shards and indices lists).
  onOpenIndex(name: string): void;
}

// The 보안 tab's sections, one per kind of entry the server manages.
export type SecuritySection = "users" | "roles" | "role_mappings" | "api_keys";

export interface SecurityTabProps {
  host: SearchHost;
  // The section shown, saved with the tab.
  section: SecuritySection;
  onSectionChange(section: SecuritySection): void;
  // Bumped by the app's refresh (F5).
  refreshSeq: number;
}

// A management dialog to open (sidebar context menu, the ⋯ menu, toolbars).
export type SearchAdminRequest =
  | { kind: "create" }
  | { kind: "delete"; index: string }
  | { kind: "open" | "close" | "refresh"; index: string }
  | { kind: "reindex"; index: string }
  | { kind: "clone-mapping"; index: string }
  | { kind: "alias"; index: string }
  | { kind: "import"; index: string | null }
  // The 문서 tab's query (`query`, `sort`, `_source`) or the whole index.
  | { kind: "export"; index: string; query?: Json; sort?: Json; source?: Json }
  | { kind: "stats"; index: string };

// What a finished dialog changed, so the app can follow.
export type SearchAdminEffect =
  | { kind: "changed" }
  | { kind: "created"; index: string }
  | { kind: "deleted"; index: string };

export interface SearchAdminDialogsProps {
  host: SearchHost;
  request: SearchAdminRequest;
  onEffect(effect: SearchAdminEffect): void;
  onClose(): void;
}
