// The document views' half of the app's right-hand detail panel
// (MONGODB.md §3.5). App owns the column itself, as for SQL tabs: the
// full-height slot beside the workbench, its splitter and remembered width,
// drag-to-close, ⌘I and the toolbar button, open or closed per connection.
// It hands the slot down through DetailSlotContext, and the view in front
// portals what it has selected into it: the table view's row or drilled
// element, the cards' or JSON blocks' document, a schema field, an index, a
// plan stage, a change event, a GridFS file, or with nothing selected the
// collection's facts.

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FieldBox } from "../../../components/FieldBox";
import { SearchIcon } from "../../../components/icons";
import type { SelectedRows } from "../../../grid/CanvasGrid";
import { formatBytes } from "../../../format";
import { t } from "../../../i18n";
import { collStats, isAbort, listIndexes, type CollStats, type IndexInfo, type Namespace } from "../api";
import { deepEqual, isDocument, typeName, type BsonDocument, type BsonValue } from "../bson";
import { toShell } from "../format";
import type { DocEdit } from "../guard";
import { cellValue, type DocTable } from "../table";
import { DocFields, docKey } from "./CardView";
import { ShellText } from "./ShellText";
import type { SaveEdits } from "./types";
import { valueText } from "./valueEdit";
import "./panels.css";

// Past this many selected rows, values are not compared.
const COMPARE_MAX_ROWS = 5000;

// The app's detail column as the document views see it.
export interface DetailSlot {
  // The column's element while it is open beside this tab, else null.
  element: HTMLElement | null;
  // Whether the user has the panel open on this connection.
  open: boolean;
  setOpen(open: boolean): void;
}

const NO_SLOT: DetailSlot = { element: null, open: false, setOpen: () => undefined };

export const DetailSlotContext = createContext<DetailSlot>(NO_SLOT);

export function useDetailSlot(): DetailSlot {
  return useContext(DetailSlotContext);
}

// One labelled value of a fact list (a collection's sizes, an index, a
// schema field's summary).
export interface Fact {
  name: string;
  value: string | null;
  // Shown beside the name (an index row says "index").
  type?: string;
}

// What the view in front shows in the app's detail column, under the field
// search; nothing while the panel is closed. Only one view of a tab renders
// this at a time.
export function DocDetailPanel({ children }: { children(query: string): ReactNode }) {
  const slot = useDetailSlot();
  const [query, setQuery] = useState("");
  if (!slot.open || slot.element === null) {
    return null;
  }
  return createPortal(
    <>
      <label className="field-search">
        <SearchIcon size={12} />
        <input placeholder={t("필드 검색…")} value={query} spellCheck={false} onChange={(event) => setQuery(event.target.value)} />
      </label>
      <div className="mg-detail-body">{children(query)}</div>
    </>,
    slot.element,
  );
}

// The flags of an index as its list shows them.
function indexFlags(ix: IndexInfo): string[] {
  const flags: string[] = [];
  if (ix.unique) {
    flags.push("unique");
  }
  if (ix.sparse) {
    flags.push("sparse");
  }
  if (ix.expireAfterSeconds !== undefined) {
    flags.push(`TTL ${ix.expireAfterSeconds}s`);
  }
  if (ix.partialFilterExpression !== undefined) {
    flags.push(`partial ${toShell(ix.partialFilterExpression)}`);
  }
  return flags;
}

// A collection's sizes, then one row per index: its keys, flags and size.
// Without the index list (no right to read it) the stats' index sizes stand in.
export function collectionFacts(stats: CollStats, indexes: IndexInfo[] | null): Fact[] {
  const facts: Fact[] = [
    { name: "count", value: t("문서 {count}개", { count: stats.count.toLocaleString() }) },
    { name: "size", value: formatBytes(stats.size) },
    { name: "avgObjSize", value: formatBytes(stats.avgObjSize) },
    { name: "storageSize", value: formatBytes(stats.storageSize) },
    { name: "nindexes", value: String(stats.nindexes) },
    { name: "totalIndexSize", value: formatBytes(stats.totalIndexSize) },
  ];
  const index = t("인덱스 [하나]");
  if (indexes !== null) {
    for (const ix of indexes) {
      const size = ix.size ?? stats.indexSizes.get(ix.name);
      facts.push({ name: ix.name, type: index, value: [toShell(ix.key), ...indexFlags(ix), ...(size !== undefined ? [formatBytes(size) ?? ""] : [])].join(" · ") });
    }
  } else {
    for (const [name, size] of stats.indexSizes) {
      facts.push({ name, type: index, value: formatBytes(size) });
    }
  }
  return facts;
}

// The collection's facts for the panel with nothing selected, read while
// the panel is open; `seq` reads them again (a save, an index made). The
// last list stays on show while a newer one loads.
export function useCollectionFacts(ns: Namespace | null, seq = 0): Fact[] | null {
  const { open } = useDetailSlot();
  const nsKey = ns === null ? null : `${ns.conn}\u0000${ns.db}\u0000${ns.coll}`;
  const [facts, setFacts] = useState<{ nsKey: string; list: Fact[] } | null>(null);
  useEffect(() => {
    if (!open || ns === null || nsKey === null) {
      return;
    }
    const ctl = new AbortController();
    const indexes = listIndexes(ns, ctl.signal).catch((error: unknown) => {
      if (isAbort(error)) {
        throw error;
      }
      return null;
    });
    Promise.all([collStats(ns, ctl.signal), indexes]).then(
      ([stats, list]) => setFacts({ nsKey, list: collectionFacts(stats, list) }),
      (error: unknown) => {
        if (!isAbort(error)) {
          setFacts({ nsKey, list: [] });
        }
      },
    );
    return () => ctl.abort();
    // The namespace's identity changes with its parent's renders; its key is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, nsKey, seq]);
  return facts !== null && facts.nsKey === nsKey ? facts.list : null;
}

// A list of facts under a title, filtered by the field search. `empty` (the
// "nothing selected" line) fills the panel only when there are no facts;
// with facts it is a one-line title above them.
export function FactsList({ title, empty, facts, query }: { title?: ReactNode; empty?: string; facts: Fact[] | null; query: string }) {
  const needle = query.trim().toLowerCase();
  const bare = facts !== null && facts.length === 0;
  return (
    <div className="field-list mg-detail-other">
      {title !== undefined ? <div className="mg-detail-head">{title}</div> : null}
      {empty === undefined ? null : bare ? <div className="panel-empty mg-detail-empty">{empty}</div> : <div className="mg-detail-title">{empty}</div>}
      {(facts ?? [])
        .filter((fact) => needle === "" || fact.name.toLowerCase().includes(needle) || (fact.type ?? "").toLowerCase().includes(needle))
        .map((fact) => (
          <FieldBox key={`${fact.type ?? ""}\u0000${fact.name}`} name={fact.name} type={fact.type} value={fact.value ?? ""} />
        ))}
    </div>
  );
}

// Nothing selected: the collection's facts.
export function NothingSelected({ facts, query, empty }: { facts: Fact[] | null; query: string; empty?: string }) {
  return <FactsList empty={empty ?? t("선택된 문서가 없습니다")} facts={facts} query={query} />;
}

function DetailHead({ parts, id, note }: { parts: string[]; id?: BsonValue; note?: ReactNode }) {
  return (
    <div className="mg-detail-head">
      <span className="mg-detail-path mono">
        {parts.map((part, i) => (
          <span key={i}>
            {i > 0 ? <span className="mg-crumb-sep"> › </span> : null}
            {i > 0 && /^\d+$/.test(part) ? `[${part}]` : part}
          </span>
        ))}
        {note !== undefined ? <span className="mg-detail-note"> {note}</span> : null}
      </span>
      {id !== undefined ? <ShellText className="mg-doc-id" text={toShell(id)} /> : null}
    </div>
  );
}

// The table view's selection: one row (a document, or in a drilled level an
// element with its path) as editable field rows, several rows as what they
// share, no row as the collection's facts.
export function TableDetail({ ns, table, rows, readOnly, save, facts, typeLabel, query }: { ns: Namespace; table: DocTable; rows: SelectedRows | null; readOnly: boolean; save: SaveEdits; facts: Fact[] | null; typeLabel?(path: string, value: BsonValue): string | null; query: string }) {
  const selected = rows !== null && rows.from >= 0 && rows.to < table.rows.length ? rows : null;
  if (selected === null) {
    return <NothingSelected facts={facts} query={query} />;
  }
  if (selected.from === selected.to) {
    return <SingleRow ns={ns} table={table} row={selected.from} readOnly={readOnly} save={save} query={query} typeLabel={typeLabel} />;
  }
  return <SharedValues table={table} rows={selected} query={query} />;
}

function SingleRow({ ns, table, row, readOnly, save, query, typeLabel }: { ns: Namespace; table: DocTable; row: number; readOnly: boolean; save: SaveEdits; query: string; typeLabel?(path: string, value: BsonValue): string | null }) {
  const entry = table.rows[row];
  const root = table.docs[entry.doc];
  const parts = entry.base === "" ? [] : entry.base.split(".");
  // A drilled element that is not a document shows as one field named by
  // its position; its edits then go to the array holding it.
  const shown: BsonDocument = isDocument(entry.value) ? entry.value : new Map([[parts[parts.length - 1] ?? "", entry.value]]);
  const prefix = isDocument(entry.value) ? entry.base : parts.slice(0, -1).join(".");

  async function onSave(edits: DocEdit[]): Promise<Error | null> {
    if (prefix === "") {
      return save(root, edits);
    }
    return save(
      root,
      edits.map((edit) => ({ ...edit, path: `${prefix}.${edit.path}` })),
    );
  }

  return (
    <div className="mg-detail-scroll">
      <DocFields
        key={`${docKey(root, entry.doc)}|${entry.base}`}
        doc={shown}
        readOnly={readOnly}
        filter={query}
        onSave={readOnly ? undefined : onSave}
        head={<DetailHead parts={[ns.coll, ...parts]} id={root.get("_id")} />}
        className="mg-panel-card"
        typeLabel={typeLabel === undefined ? undefined : (path, value) => typeLabel(prefix === "" ? path : `${prefix}.${path}`, value)}
        root={root}
        prefix={prefix}
        position={row}
      />
    </div>
  );
}

function SharedValues({ table, rows, query }: { table: DocTable; rows: SelectedRows; query: string }) {
  const count = rows.to - rows.from + 1;
  const boxes = useMemo(() => {
    if (count > COMPARE_MAX_ROWS) {
      return null;
    }
    const needle = query.trim().toLowerCase();
    return table.columns
      .filter((column) => needle === "" || column.label.toLowerCase().includes(needle))
      .map((column) => {
        const values: (BsonValue | undefined)[] = [];
        for (let r = rows.from; r <= rows.to; r++) {
          values.push(cellValue(table.rows[r], column));
        }
        const first = values[0];
        const same = values.every((v) => (v === undefined ? first === undefined : first !== undefined && deepEqual(v, first)));
        const types = [...new Set(values.map((v) => (v === undefined ? "—" : typeName(v))))];
        return { column, same, first, types };
      });
  }, [table, rows.from, rows.to, query, count]);

  return (
    <div className="field-list mg-detail-other">
      <div className="mg-detail-title">{t("{count}개 행을 선택했습니다", { count: count.toLocaleString() })}</div>
      {boxes?.map(({ column, same, first, types }) => (
        <FieldBox
          key={column.id}
          name={column.kind === "value" ? t(column.label) : column.label}
          type={types.join(" · ")}
          value={
            !same || first === undefined
              ? ""
              : first === null
                ? null
                : Array.isArray(first) || isDocument(first)
                  ? toShell(first)
                  : valueText(first)
          }
          note={!same ? t("여러 값") : first === undefined ? t("필드 없음") : undefined}
        />
      ))}
    </div>
  );
}

// The document selected in the cards or JSON view: the same field rows as
// a card, saved the same guarded way (`save` omitted: read-only).
export function DocDetail({ ns, doc, position, save, typeLabel, query }: { ns: Namespace; doc: BsonDocument; position: number; save?: SaveEdits; typeLabel?(path: string, value: BsonValue): string | null; query: string }) {
  const id = doc.get("_id");
  const editable = save !== undefined && id !== undefined;
  return (
    <div className="mg-detail-scroll">
      <DocFields
        key={docKey(doc, position)}
        doc={doc}
        readOnly={!editable}
        filter={query}
        onSave={editable ? (edits) => save(doc, edits) : undefined}
        head={<DetailHead parts={[ns.coll]} id={id} note={`#${(position + 1).toLocaleString()}`} />}
        className="mg-panel-card"
        typeLabel={typeLabel}
        position={position}
      />
    </div>
  );
}

// A selected item that is a document of its own (a plan stage, a change
// event, a GridFS file), read-only and opened out.
export function ItemDetail({ title, note, doc, query, foot }: { title: string; note?: ReactNode; doc: BsonDocument; query: string; foot?: ReactNode }) {
  return (
    <div className="mg-detail-scroll">
      <DocFields doc={doc} readOnly allOpen filter={query} head={<DetailHead parts={[title]} note={note} />} className="mg-panel-card" />
      {foot}
    </div>
  );
}
