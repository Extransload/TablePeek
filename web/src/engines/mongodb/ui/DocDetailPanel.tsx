// The right-hand panel of the table view (MONGODB.md §3.5), in the look of
// the app's row detail panel: the selected document, or in a drilled level
// the selected element with its path, as the same editable field rows the
// cards use; several rows show what they share; no row shows the
// collection's sizes.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { FieldBox } from "../../../components/FieldBox";
import { SearchIcon } from "../../../components/icons";
import type { SelectedRows } from "../../../grid/CanvasGrid";
import { formatBytes } from "../../../format";
import { t } from "../../../i18n";
import { collStats, isAbort, type CollStats, type Namespace } from "../api";
import { deepEqual, isDocument, typeName, type BsonDocument, type BsonValue } from "../bson";
import { toShell } from "../format";
import type { DocEdit } from "../guard";
import { cellValue, type DocTable } from "../table";
import { DocFields, docKey } from "./CardView";
import { ShellText } from "./ShellText";
import type { SaveEdits } from "./types";
import { valueText } from "./valueEdit";

// The app's row detail panel keeps its width here; sharing it keeps the two
// panels the same size.
const DETAIL_WIDTH_KEY = "tablepeek.detail-width";
const DETAIL_MIN = 260;
const DETAIL_MAX = 720;
// Past this many selected rows, values are not compared.
const COMPARE_MAX_ROWS = 5000;

function clampWidth(width: number): number {
  const max = Math.max(DETAIL_MIN, Math.min(DETAIL_MAX, window.innerWidth - 480));
  return Math.round(Math.min(Math.max(width, DETAIL_MIN), max));
}

function loadWidth(): number | null {
  try {
    const saved = Number(window.localStorage.getItem(DETAIL_WIDTH_KEY));
    return Number.isFinite(saved) && saved > 0 ? clampWidth(saved) : null;
  } catch {
    return null;
  }
}

function storeWidth(width: number | null): void {
  try {
    if (width === null) {
      window.localStorage.removeItem(DETAIL_WIDTH_KEY);
    } else {
      window.localStorage.setItem(DETAIL_WIDTH_KEY, String(width));
    }
  } catch {}
}

interface DocDetailPanelProps {
  ns: Namespace;
  table: DocTable;
  rows: SelectedRows | null;
  readOnly: boolean;
  save: SaveEdits;
  // Closes the panel: its edge dragged past half the panel's narrowest width.
  onClose(): void;
}

export function DocDetailPanel({ ns, table, rows, readOnly, save, onClose }: DocDetailPanelProps) {
  const [width, setWidth] = useState<number | null>(loadWidth);
  const [query, setQuery] = useState("");
  const panelRef = useRef<HTMLElement | null>(null);

  function saveWidth(next: number | null): void {
    setWidth(next);
    storeWidth(next);
  }

  function onSplitterDown(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = panelRef.current?.getBoundingClientRect().width ?? DETAIL_MIN;
    let next = startWidth;
    handle.classList.add("dragging");
    document.body.classList.add("col-resizing");
    const end = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      handle.classList.remove("dragging");
      document.body.classList.remove("col-resizing");
    };
    const move = (e: globalThis.PointerEvent): void => {
      // The panel is on the right: moving left widens it.
      const raw = startWidth - (e.clientX - startX);
      // Dragged under half its narrowest width, the panel closes at once; the
      // saved width stays for when it opens again.
      if (raw < DETAIL_MIN / 2) {
        end();
        onClose();
        return;
      }
      next = clampWidth(raw);
      setWidth(next);
    };
    const up = (): void => {
      end();
      saveWidth(next);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function onSplitterKey(event: KeyboardEvent<HTMLDivElement>): void {
    const current = panelRef.current?.getBoundingClientRect().width ?? DETAIL_MIN;
    const step = event.shiftKey ? 64 : 16;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      saveWidth(clampWidth(current + (event.key === "ArrowLeft" ? step : -step)));
    } else if (event.key === "Home" || event.key === "Enter") {
      event.preventDefault();
      saveWidth(null);
    }
  }

  const selected = rows !== null && rows.from >= 0 && rows.to < table.rows.length ? rows : null;

  return (
    <>
      <div
        className="detail-splitter"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("행 상세 패널 너비")}
        tabIndex={0}
        title={t("끌어서 너비 조절 · 두 번 누르면 원래대로")}
        onPointerDown={onSplitterDown}
        onDoubleClick={() => saveWidth(null)}
        onKeyDown={onSplitterKey}
      />
      <aside
        ref={panelRef}
        className="row-detail mg-detail"
        aria-label={t("행 상세")}
        style={width === null ? undefined : ({ "--detail-w": `${width}px` } as CSSProperties)}
      >
        <label className="field-search">
          <SearchIcon size={12} />
          <input placeholder={t("필드 검색…")} value={query} spellCheck={false} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <div className="mg-detail-body">
          {selected === null ? (
            <CollectionFacts ns={ns} query={query} />
          ) : selected.from === selected.to ? (
            <SingleRow ns={ns} table={table} row={selected.from} readOnly={readOnly} save={save} query={query} />
          ) : (
            <SharedValues table={table} rows={selected} query={query} />
          )}
        </div>
      </aside>
    </>
  );
}

function SingleRow({ ns, table, row, readOnly, save, query }: { ns: Namespace; table: DocTable; row: number; readOnly: boolean; save: SaveEdits; query: string }) {
  const entry = table.rows[row];
  const root = table.docs[entry.doc];
  const parts = entry.base === "" ? [] : entry.base.split(".");
  // A drilled element that is not a document shows as one field named by
  // its position; its edits then go to the array holding it.
  const shown: BsonDocument = isDocument(entry.value) ? entry.value : { [parts[parts.length - 1] ?? ""]: entry.value };
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

  const head = (
    <div className="mg-detail-head">
      <span className="mg-detail-path mono">
        {[ns.coll, ...parts].map((part, i) => (
          <span key={i}>
            {i > 0 ? <span className="mg-crumb-sep"> › </span> : null}
            {i > 0 && /^\d+$/.test(part) ? `[${part}]` : part}
          </span>
        ))}
      </span>
      {root._id !== undefined ? <ShellText className="mg-doc-id" text={toShell(root._id)} /> : null}
    </div>
  );

  return (
    <div className="mg-detail-scroll">
      <DocFields
        key={`${docKey(root, entry.doc)}|${entry.base}`}
        doc={shown}
        readOnly={readOnly}
        filter={query}
        onSave={readOnly ? undefined : onSave}
        head={head}
        className="mg-panel-card"
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

// Without a selected row: the collection's sizes, fetched once per panel.
function CollectionFacts({ ns, query }: { ns: Namespace; query: string }) {
  const [stats, setStats] = useState<CollStats | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    setStats(null);
    collStats(ns, ctl.signal).then(setStats, (error: unknown) => {
      if (!isAbort(error)) {
        setStats(null);
      }
    });
    return () => ctl.abort();
  }, [ns.conn, ns.db, ns.coll]);

  const needle = query.trim().toLowerCase();
  const facts: [string, string | null][] =
    stats === null
      ? []
      : [
          ["count", t("{count}개", { count: stats.count.toLocaleString() })],
          ["size", formatBytes(stats.size)],
          ["avgObjSize", formatBytes(stats.avgObjSize)],
          ["storageSize", formatBytes(stats.storageSize)],
          ["nindexes", String(stats.nindexes)],
          ["totalIndexSize", formatBytes(stats.totalIndexSize)],
        ];
  return (
    <div className="field-list mg-detail-other">
      <div className="panel-empty mg-detail-empty">{t("선택된 문서가 없습니다")}</div>
      {facts
        .filter(([name]) => needle === "" || name.toLowerCase().includes(needle))
        .map(([name, value]) => (
          <FieldBox key={name} name={name} value={value ?? ""} />
        ))}
    </div>
  );
}
