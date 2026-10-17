import { useCallback, useEffect, useMemo, useState } from "react";
import { store, type TableSchema } from "../store";
import { ChevronIcon, CodeIcon, KeyIcon, RefreshIcon, SearchIcon } from "./icons";

interface SchemaSidebarProps {
  refreshKey: string;
  onOpenData(table: string): void;
  onOpenInEditor(table: string): void;
}

function errorOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function SchemaSidebar({ refreshKey, onOpenData, onOpenInEditor }: SchemaSidebarProps) {
  const [tables, setTables] = useState<TableSchema[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [nonce, setNonce] = useState(0);
  const [filter, setFilter] = useState("");

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const next = await store.fetchSchema();
      setTables(next);
    } catch (err) {
      setError(errorOf(err, "스키마를 불러오지 못했습니다"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey, nonce]);

  function toggle(name: string): void {
    setExpanded((prev) => ({ ...prev, [name]: !(prev[name] ?? false) }));
  }

  const query = filter.trim().toLowerCase();
  const visible = useMemo(() => {
    if (tables === null) {
      return null;
    }
    if (query === "") {
      return tables;
    }
    return tables.filter((table) => table.name.toLowerCase().includes(query));
  }, [tables, query]);

  return (
    <div className="schema-sidebar">
      <div className="sidebar-head">
        <span className="sidebar-title">스키마</span>
        {tables ? <span className="schema-count">{tables.length}</span> : null}
        <span className="spacer" />
        <button
          type="button"
          className="icon-button"
          title="스키마 새로고침"
          disabled={loading}
          onClick={() => setNonce((value) => value + 1)}
        >
          <RefreshIcon size={12} />
        </button>
      </div>
      <div className="schema-search">
        <SearchIcon size={11} className="schema-search-icon" />
        <input
          value={filter}
          placeholder="테이블 검색"
          spellCheck={false}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>
      <div className="schema-list">
        {error ? (
          <div className="schema-error">{error}</div>
        ) : visible === null ? (
          <div className="schema-empty">불러오는 중…</div>
        ) : visible.length === 0 ? (
          <div className="schema-empty">
            {query === "" ? "테이블이 없습니다" : "검색 결과가 없습니다"}
          </div>
        ) : (
          visible.map((table) => {
            const isOpen = query !== "" || (expanded[table.name] ?? false);
            return (
              <div className="schema-table" key={table.name}>
                <div
                  className="schema-table-row"
                  role="button"
                  tabIndex={0}
                  title={`${table.name} — 클릭: 컬럼 펼치기, 더블클릭: 데이터 열기`}
                  onClick={() => toggle(table.name)}
                  onDoubleClick={() => {
                    setExpanded((prev) => ({ ...prev, [table.name]: true }));
                    onOpenData(table.name);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      onOpenData(table.name);
                    } else if (event.key === " ") {
                      event.preventDefault();
                      toggle(table.name);
                    }
                  }}
                >
                  <span className={`schema-toggle${isOpen ? " open" : ""}`}>
                    <ChevronIcon size={10} />
                  </span>
                  <span className="schema-table-name">{table.name}</span>
                  <button
                    type="button"
                    className="schema-row-action"
                    title="쿼리 편집기에서 열기"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpenInEditor(table.name);
                    }}
                    onDoubleClick={(event) => event.stopPropagation()}
                  >
                    <CodeIcon size={11} />
                  </button>
                  <span className="schema-table-count">{table.columns.length}</span>
                </div>
                {isOpen && (
                  <div className="schema-cols">
                    {table.columns.map((column) => (
                      <div className="schema-col" key={column.name}>
                        {column.pk ? (
                          <KeyIcon size={10} className="schema-col-pk" />
                        ) : (
                          <span className="schema-col-pk-space" />
                        )}
                        <span className="schema-col-name" title={column.name}>
                          {column.name}
                        </span>
                        <span className="schema-col-type">{column.decl_type ?? ""}</span>
                        {column.not_null ? <span className="badge-nn">NOT NULL</span> : null}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
