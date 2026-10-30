// Props of the collection tab's table view, detail panel, index list and
// explain view, and what they need from the workbench around them.

import type { SafeMode } from "../../../sqlTools";
import type { Namespace, QueryOptions } from "../api";
import type { BsonDocument, BsonValue } from "../bson";
import type { DocEdit } from "../guard";
import type { Fact } from "./DocDetailPanel";

// Saves `edits` made to `original` (a document as loaded) with the conflict
// guard of MONGODB.md §4. Resolves to null once saved (or once the conflict
// dialog was settled), or to the failure to show at the edited item (a
// validation rule, a duplicate key, …). The workbench reloads the page after
// a save, so the views only render the documents they are given.
export type SaveEdits = (original: BsonDocument, edits: DocEdit[]) => Promise<Error | null>;

// The query bar as the explain view runs it; null parts are not sent.
export interface DocQuery {
  filter: BsonDocument;
  projection: BsonDocument | null;
  sort: BsonDocument | null;
  skip: number;
  limit: number;
  // The 옵션 row's collation, hint and time limit; missing when none is set.
  options?: QueryOptions;
}

// What the panels need from the app around them.
export interface DocHost {
  // A short message (toast).
  notify(message: string): void;
  // Asks before a destructive command (safe mode); resolves true to go on.
  // `command` is the mongosh text of what will be sent.
  confirm(request: { title: string; message: string; command: string; okLabel: string }): Promise<boolean>;
  // The connection's safe mode: 0 runs writes the server needs `confirmed`
  // for without asking (still sending `confirmed: true`).
  safeMode: SafeMode;
}

// The ⊞ table view; what it has selected goes to the app's detail panel.
export interface DocTableViewProps {
  ns: Namespace;
  // The page as loaded (the originals edits are guarded against).
  docs: BsonDocument[];
  // The connection's stable key (the one App keys column widths by), so
  // widths set by hand come back when the collection opens again.
  connKey: string;
  // Views and read-only connections.
  readOnly: boolean;
  // The query bar's sort. At the top level a header click asks for a new
  // sort (null: none) and the workbench runs the query again; drilled levels
  // sort their rows in place.
  sort: BsonDocument | null;
  onSort(sort: BsonDocument | null): void;
  save: SaveEdits;
  // The facts the detail panel lists with no row selected (a collection's
  // sizes and indexes; the search workbench gives an index's); null while
  // they load or where there are none.
  facts: Fact[] | null;
  // Field drill path, kept by the workbench per collection tab so switching
  // views and pages keeps it; [] is the top level.
  path: string[];
  onPathChange(path: string[]): void;
  // The detail panel's type labels (see DocFieldsProps.typeLabel).
  typeLabel?(path: string, value: BsonValue): string | null;
  // A row's document in the JSON editor (replace), cloned into a new one,
  // or deleted (asking first): the cell menu's document items, offered where
  // given.
  onEditJson?(doc: BsonDocument): void;
  onClone?(doc: BsonDocument): void;
  onDelete?(doc: BsonDocument): void;
}

// A prefilled create dialog (from the explain view's suggestion). `seq`
// changes for each request so the same keys can be asked for twice.
export interface IndexCreateRequest {
  seq: number;
  keys: BsonDocument;
}

export interface IndexesPanelProps {
  ns: Namespace;
  readOnly: boolean;
  // Field paths offered in the create dialog (sampled from loaded documents).
  fields: string[];
  // Opens the create dialog prefilled; the workbench switches to this tab
  // first.
  createRequest: IndexCreateRequest | null;
  host: DocHost;
  // What the detail panel lists with no index picked.
  facts: Fact[] | null;
  // Called after an index was made or dropped (stats chips refresh).
  onChanged(): void;
}

export interface ExplainPanelProps {
  ns: Namespace;
  // What the detail panel lists with no stage picked.
  facts: Fact[] | null;
  // The query bar's current state, or the message of why it does not parse.
  query: DocQuery | { error: string };
  // explain("executionStats") runs the query, so it never runs on typing:
  // only when the tab is shown with a query not yet explained, on a run
  // request, or on 계획 다시 계산. `active` is false while another sub-tab
  // is in front.
  active: boolean;
  // Bumped by the query bar's 계획 button, ⌘↩ and 찾기 to run again.
  runSeq: number;
  // The suggestion's 만들기 button: switch to 인덱스 and open the dialog.
  onCreateIndex(keys: BsonDocument): void;
}
