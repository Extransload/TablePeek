import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { listGroups } from "../connGroups";
import { listConnMeta } from "../connMeta";
import { t } from "../i18n";
import type { ConnSummary, SavedConnection } from "../store";
import { DriverIcon } from "./DriverIcon";
import {
  byLastUsed,
  filterConnections,
  openAddress,
  openMatches,
  openName,
  savedAddress,
  tagPills,
} from "./HomeConnectionList";
import { PlusIcon, SearchIcon } from "./icons";

export interface PickTarget {
  savedId?: string;
  connId?: string;
}

interface ConnectionPickerModalProps {
  title: string;
  conns: ConnSummary[];
  saved: SavedConnection[];
  onPick(target: PickTarget): void;
  onClose(): void;
  // Offered as "New connection…" in the footer when given.
  onNew?(): void;
}

// Pick a connection for a job that needs one open (backup, restore): the
// home list's rows, with groups shown as plain headings.
export function ConnectionPickerModal({ title, conns, saved, onPick, onClose, onNew }: ConnectionPickerModalProps) {
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);
  const groups = useMemo(() => listGroups(), []);
  const metaById = useMemo(() => listConnMeta(), []);

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const savedIds = new Set(saved.map((connection) => connection.id));
  const needle = query.trim().toLowerCase();
  const unsaved = conns.filter(
    (conn) => (conn.saved_id === undefined || !savedIds.has(conn.saved_id)) && openMatches(conn, needle),
  );
  const shown = filterConnections(saved, metaById, groups, query);
  const visible = [...saved].sort(byLastUsed).filter((connection) => shown.has(connection.id));
  const groupIds = new Set(groups.map((group) => group.id));
  const groupOf = (connection: SavedConnection) => {
    const id = metaById[connection.id]?.group ?? "";
    return groupIds.has(id) ? id : "";
  };
  const ungrouped = visible.filter((connection) => groupOf(connection) === "");
  const sections = groups
    .map((group) => ({ group, members: visible.filter((connection) => groupOf(connection) === group.id) }))
    .filter((section) => section.members.length > 0);
  const empty = unsaved.length === 0 && visible.length === 0;

  const connectedState = (
    <span className="launcher-state">
      <span className="launcher-state-dot" aria-hidden="true" />
      {t("연결됨")}
    </span>
  );

  function row(key: string, target: PickTarget, icon: ReactNode, name: string, extra: ReactNode, address: string) {
    return (
      <button type="button" key={key} className="launcher-row picker-row" onClick={() => onPick(target)}>
        {icon}
        <div className="launcher-row-body">
          <div className="launcher-row-title">
            <span className="launcher-row-name">{name}</span>
            {extra}
          </div>
          <div className="launcher-row-sub">
            <span className="launcher-row-address">{address}</span>
          </div>
        </div>
      </button>
    );
  }

  function savedRow(connection: SavedConnection) {
    const open = conns.some((conn) => conn.saved_id === connection.id);
    return row(
      `saved:${connection.id}`,
      { savedId: connection.id },
      <DriverIcon kind={connection.driver} size={30} className="launcher-logo" />,
      connection.name,
      <>
        {tagPills(metaById[connection.id])}
        {open ? connectedState : null}
      </>,
      savedAddress(connection),
    );
  }

  // ↓ from the search box goes to the first row; Enter picks it.
  function onSearchKey(event: KeyboardEvent<HTMLInputElement>): void {
    const first = listRef.current?.querySelector<HTMLButtonElement>(".picker-row");
    if (first === null || first === undefined) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      first.focus();
    } else if (event.key === "Enter") {
      event.preventDefault();
      first.click();
    }
  }

  function onListKey(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    const rows = [...(listRef.current?.querySelectorAll<HTMLButtonElement>(".picker-row") ?? [])];
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) {
      return;
    }
    event.preventDefault();
    rows[event.key === "ArrowDown" ? Math.min(index + 1, rows.length - 1) : Math.max(index - 1, 0)]?.focus();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal picker-modal" role="dialog" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">{title}</span>
        </div>
        <div className="picker-search">
          <label className="launcher-search">
            <SearchIcon size={10} className="launcher-search-icon" />
            <input
              autoFocus
              value={query}
              placeholder={t("연결 검색 (이름·호스트·태그)")}
              spellCheck={false}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKey}
            />
          </label>
        </div>
        <div className="modal-body picker-list" ref={listRef} onKeyDown={onListKey}>
          {unsaved.map((conn) =>
            row(
              `open:${conn.id}`,
              { connId: conn.id },
              <DriverIcon kind={conn.kind} size={30} className="launcher-logo" />,
              openName(conn),
              connectedState,
              openAddress(conn),
            ),
          )}
          {ungrouped.map(savedRow)}
          {sections.map(({ group, members }) => (
            <div key={group.id} className="picker-group">
              <div className="picker-group-title">
                <span className="launcher-color-dot" style={{ background: group.color }} aria-hidden="true" />
                {group.name}
              </div>
              {members.map(savedRow)}
            </div>
          ))}
          {empty ? (
            <div className="launcher-empty">
              {query.trim() !== "" ? t("검색 결과가 없습니다") : t("저장된 연결이 없습니다")}
            </div>
          ) : null}
        </div>
        <div className="modal-foot">
          {onNew !== undefined ? (
            <button type="button" onClick={onNew}>
              <PlusIcon size={9} />
              {t("새 연결…")}
            </button>
          ) : null}
          <span className="spacer" />
          <button type="button" onClick={onClose}>
            {t("취소")}
          </button>
        </div>
      </div>
    </div>
  );
}
