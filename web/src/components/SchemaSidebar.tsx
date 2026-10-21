import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import type { ConnectionEnvironment } from "../connMeta";
import { t } from "../i18n";
import { loadObjects, loadSchema, peekObjects, peekSchema } from "../schemaCache";
import { store, type ObjectList, type TableSchema } from "../store";
import type { DefinitionKind } from "../sqlTools";
import { createTemplate, dropTemplate, type ObjectKind } from "../templates";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { ErrorNotice } from "./ErrorNotice";
import { Spinner } from "./Spinner";
import {
  ChevronIcon,
  CodeIcon,
  FileIcon,
  KeyIcon,
  ListIcon,
  PinIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  ServerIcon,
  StructureIcon,
  TableIcon,
  UserIcon,
} from "./icons";

export type TableAction =
  | "copyCreate"
  | "copySelect"
  | "copyDrop"
  | "copyTruncate"
  | "copyLaravel"
  | "rename"
  | "duplicate"
  | "truncate"
  | "delete"
  | "import";

interface SchemaSidebarProps {
  conn: string;
  environment: ConnectionEnvironment;
  kind: string;
  refreshKey: string;
  pinned: string[];
  onOpenData(table: string): void;
  onOpenDataNewTab(table: string): void;
  onOpenInEditor(table: string): void;
  onOpenStructure(table: string): void;
  onOpenDdl(table: string): void;
  onOpenOverview(): void;
  onOpenServer(): void;
  onOpenDefinition(kind: DefinitionKind, name: string): void;
  onTogglePin(table: string): void;
  onTableAction(action: TableAction, table: string): void;
  onOpenCreateTable(): void;
  onOpenSql(sql: string, title: string): void;
  onOpenUsers(): void;
}

const EMPTY_OBJECTS: ObjectList = {
  views: [],
  functions: [],
  triggers: [],
  sequences: [],
  procedures: [],
};

// Large schemas render in chunks: the rest of the list is a spacer that pulls
// in the next chunk as it nears the viewport.
const TABLE_CHUNK = 200;
const TABLE_ROW_HEIGHT = 28;
const COLUMN_ROW_HEIGHT = 23;
// Padding and bottom margin around an expanded table's column list.
const COLUMN_LIST_EXTRA = 11;
// A search expands every match to show its columns, unless that is too many.
const AUTO_EXPAND_LIMIT = 30;

const OBJECT_SECTIONS: { kind: DefinitionKind; label: string }[] = [
  { kind: "view", label: "뷰" },
  { kind: "function", label: "함수" },
  { kind: "procedure", label: "프로시저" },
  { kind: "trigger", label: "트리거" },
  { kind: "sequence", label: "시퀀스" },
];

function errorOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function loadSections(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem("tablepeek.sidebar-sections");
    return raw === null ? {} : (JSON.parse(raw) as Record<string, boolean>);
  } catch {
    return {};
  }
}

function loadSystemMode(): boolean {
  try {
    return window.localStorage.getItem("tablepeek.system-tables") === "1";
  } catch {
    return false;
  }
}

function fuzzyScore(name: string, query: string): number {
  const lower = name.toLowerCase();
  const index = lower.indexOf(query);
  if (index >= 0) {
    return 1000 - index * 4 - (name.length - query.length);
  }
  let cursor = 0;
  let gaps = 0;
  let last = -1;
  for (const ch of query) {
    const found = lower.indexOf(ch, cursor);
    if (found < 0) {
      return -1;
    }
    if (last >= 0) {
      gaps += found - last - 1;
    }
    last = found;
    cursor = found + 1;
  }
  return 200 - gaps - (name.length - query.length);
}

export function SchemaSidebar({
  conn,
  environment,
  kind,
  refreshKey,
  pinned,
  onOpenData,
  onOpenDataNewTab,
  onOpenInEditor,
  onOpenStructure,
  onOpenDdl,
  onOpenOverview,
  onOpenServer,
  onOpenDefinition,
  onTogglePin,
  onTableAction,
  onOpenCreateTable,
  onOpenSql,
  onOpenUsers,
}: SchemaSidebarProps) {
  // Seeded from the cache so switching back to a connection paints at once.
  const [tables, setTables] = useState<TableSchema[] | null>(() =>
    peekSchema(conn, loadSystemMode()),
  );
  const [objects, setObjects] = useState<ObjectList | null>(() =>
    peekObjects(conn, loadSystemMode()),
  );
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [sections, setSections] = useState<Record<string, boolean>>(loadSections);
  const [system, setSystem] = useState(loadSystemMode);
  const [nonce, setNonce] = useState(0);
  const forceRef = useRef(false);
  const [filter, setFilter] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; table: string } | null>(null);
  const [objectMenu, setObjectMenu] = useState<{
    x: number;
    y: number;
    obj: ObjectKind;
    name: string;
  } | null>(null);
  const [sectionMenu, setSectionMenu] = useState<{
    x: number;
    y: number;
    obj: ObjectKind;
  } | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const force = forceRef.current;
    forceRef.current = false;
    const cached = peekSchema(conn, system);
    if (cached !== null) {
      setTables(cached);
      setObjects(peekObjects(conn, system));
    }
    // A cached list stays on screen while it revalidates; the spinner is for
    // first loads and explicit refreshes.
    setLoading(cached === null || force);
    setError(null);
    try {
      setTables(await loadSchema(conn, system, refreshKey, force));
    } catch (err) {
      setError(errorOf(err, "스키마를 불러오지 못했습니다"));
    } finally {
      setLoading(false);
    }
    try {
      setObjects(await loadObjects(conn, system, refreshKey, force));
    } catch {
      setObjects((prev) => prev ?? EMPTY_OBJECTS);
    }
  }, [conn, system, refreshKey]);

  useEffect(() => {
    void load();
  }, [load, nonce]);

  function toggle(name: string): void {
    setExpanded((prev) => ({ ...prev, [name]: !(prev[name] ?? false) }));
  }

  function toggleSection(key: string, fallback: boolean): void {
    setSections((prev) => {
      const next = { ...prev, [key]: !(prev[key] ?? fallback) };
      try {
        window.localStorage.setItem("tablepeek.sidebar-sections", JSON.stringify(next));
      } catch {
        /* 저장 실패는 무시 */
      }
      return next;
    });
  }

  function toggleSystem(): void {
    setSystem((value) => {
      const next = !value;
      try {
        window.localStorage.setItem("tablepeek.system-tables", next ? "1" : "0");
      } catch {
        /* 저장 실패는 무시 */
      }
      return next;
    });
  }

  // Typing stays responsive; the filtered list catches up at lower priority.
  const query = useDeferredValue(filter.trim().toLowerCase());

  const orderedTables = useMemo(() => {
    if (tables === null) {
      return null;
    }
    const pinnedSet = new Set(pinned);
    const scored: { table: TableSchema; score: number; pinnedRank: number }[] = [];
    for (const table of tables) {
      const score = query === "" ? 0 : fuzzyScore(table.name, query);
      if (score < 0) {
        continue;
      }
      scored.push({
        table,
        score,
        pinnedRank: pinnedSet.has(table.name) ? pinned.indexOf(table.name) : -1,
      });
    }
    scored.sort((a, b) => {
      const aPinned = a.pinnedRank >= 0;
      const bPinned = b.pinnedRank >= 0;
      if (aPinned !== bPinned) {
        return aPinned ? -1 : 1;
      }
      if (aPinned && bPinned && a.pinnedRank !== b.pinnedRank) {
        return a.pinnedRank - b.pinnedRank;
      }
      if (query !== "" && a.score !== b.score) {
        return b.score - a.score;
      }
      return a.table.name.localeCompare(b.table.name);
    });
    return scored.map((entry) => entry.table);
  }, [tables, query, pinned]);

  const objectFiltered = useMemo(() => {
    if (objects === null) {
      return null;
    }
    if (query === "") {
      return objects;
    }
    const match = (name: string): number => fuzzyScore(name, query);
    const pick = (names: string[]): string[] =>
      names
        .map((name) => ({ name, score: match(name) }))
        .filter((entry) => entry.score >= 0)
        .sort((a, b) => b.score - a.score)
        .map((entry) => entry.name);
    return {
      views: pick(objects.views),
      functions: pick(objects.functions),
      procedures: pick(objects.procedures),
      triggers: pick(objects.triggers),
      sequences: pick(objects.sequences),
    };
  }, [objects, query]);

  const pinnedSet = useMemo(() => new Set(pinned), [pinned]);
  const tablesOpen = sections.tables ?? true;
  const tableCount = orderedTables === null ? 0 : orderedTables.length;
  const autoExpand = query !== "" && tableCount <= AUTO_EXPAND_LIMIT;

  // The chunk count restarts for a new search or schema, but not when a
  // background refresh replaces the same list.
  const chunkKey = [conn, refreshKey, system ? "1" : "0", query].join("\u0000");
  const [chunks, setChunks] = useState({ key: chunkKey, limit: TABLE_CHUNK });
  if (chunks.key !== chunkKey) {
    setChunks({ key: chunkKey, limit: TABLE_CHUNK });
  }
  const renderLimit = chunks.key === chunkKey ? chunks.limit : TABLE_CHUNK;
  const listRef = useRef<HTMLDivElement | null>(null);
  // New search results (or another database) start from the top.
  useEffect(() => {
    if (listRef.current !== null) {
      listRef.current.scrollTop = 0;
    }
  }, [chunkKey]);
  // State, not a ref: a spacer mounted again (after an error, say) needs observing.
  const [spacer, setSpacer] = useState<HTMLDivElement | null>(null);
  const hasMore = tablesOpen && tableCount > renderLimit;
  let spacerHeight = 0;
  if (hasMore && orderedTables !== null) {
    for (let index = renderLimit; index < orderedTables.length; index += 1) {
      const table = orderedTables[index];
      spacerHeight += TABLE_ROW_HEIGHT;
      if (expanded[table.name]) {
        spacerHeight += COLUMN_LIST_EXTRA + table.columns.length * COLUMN_ROW_HEIGHT;
      }
    }
  }
  useEffect(() => {
    if (spacer === null) {
      return;
    }
    // A fresh observer reports the current state right away, so a jump to the
    // bottom keeps loading chunks until the spacer is out of view.
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setChunks({ key: chunkKey, limit: renderLimit + TABLE_CHUNK });
        }
      },
      { root: listRef.current, rootMargin: "600px 0px" },
    );
    observer.observe(spacer);
    return () => observer.disconnect();
  }, [spacer, renderLimit, chunkKey]);

  function menuItems(table: string): ContextMenuItem[] {
    return [
      { label: t("데이터 열기"), onSelect: () => onOpenData(table) },
      { label: t("구조 보기"), onSelect: () => onOpenStructure(table) },
      { label: t("DDL 보기"), onSelect: () => onOpenDdl(table) },
      { label: t("쿼리 편집기에서 열기"), onSelect: () => onOpenInEditor(table) },
      {
        label: pinnedSet.has(table) ? t("상단 고정 해제") : t("상단에 고정"),
        separatorBefore: true,
        onSelect: () => onTogglePin(table),
      },
      {
        label: t("CREATE 문 복사"),
        separatorBefore: true,
        onSelect: () => onTableAction("copyCreate", table),
      },
      { label: t("SELECT 문 복사"), onSelect: () => onTableAction("copySelect", table) },
      { label: t("DROP 문 복사"), onSelect: () => onTableAction("copyDrop", table) },
      { label: t("TRUNCATE 문 복사"), onSelect: () => onTableAction("copyTruncate", table) },
      { label: t("Laravel 스키마 복사"), onSelect: () => onTableAction("copyLaravel", table) },
      {
        label: t("이름 변경…"),
        separatorBefore: true,
        onSelect: () => onTableAction("rename", table),
      },
      {
        label: t("테이블 복제…"),
        onSelect: () => onTableAction("duplicate", table),
      },
      {
        label: t("데이터 가져오기…"),
        separatorBefore: true,
        onSelect: () => onTableAction("import", table),
      },
      { label: t("테이블 비우기 (TRUNCATE)"), onSelect: () => onTableAction("truncate", table) },
      { label: t("테이블 삭제"), onSelect: () => onTableAction("delete", table) },
    ];
  }

  function renderTableRow(table: TableSchema): ReactElement {
    const isOpen = autoExpand || (expanded[table.name] ?? false);
    const isPinned = pinnedSet.has(table.name);
    return (
      <div className="schema-table" key={`table:${table.name}`}>
        <div
          className="schema-table-row"
          role="button"
          tabIndex={0}
          title={`${table.name} — ${t("데이터 열기")}`}
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey) {
              onOpenDataNewTab(table.name);
              return;
            }
            onOpenData(table.name);
          }}
          onAuxClick={(event) => {
            if (event.button === 1) {
              event.preventDefault();
              onOpenDataNewTab(table.name);
            }
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY, table: table.name });
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
          <span
            className={`schema-toggle${isOpen ? " open" : ""}`}
            role="button"
            tabIndex={-1}
            title={isOpen ? t("컬럼 접기") : t("컬럼 펼치기")}
            onClick={(event) => {
              event.stopPropagation();
              toggle(table.name);
            }}
          >
            <ChevronIcon size={10} />
          </span>
          <TableIcon size={11} className="schema-table-icon" />
          <span className="schema-table-name" title={table.name}>
            {table.name}
          </span>
          {isPinned ? <PinIcon size={9} className="schema-pin" /> : null}
          <button
            type="button"
            className="schema-row-action"
            title={t("구조 보기")}
            onClick={(event) => {
              event.stopPropagation();
              onOpenStructure(table.name);
            }}
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <StructureIcon size={11} />
          </button>
          <button
            type="button"
            className="schema-row-action"
            title={t("쿼리 편집기에서 열기")}
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
  }

  function objectIcon(kind: DefinitionKind): ReactElement {
    if (kind === "view") {
      return <TableIcon size={10} />;
    }
    if (kind === "function" || kind === "procedure") {
      return <CodeIcon size={10} />;
    }
    if (kind === "trigger") {
      return <FileIcon size={10} />;
    }
    return <ListIcon size={10} />;
  }

  return (
    <div
      className="schema-sidebar"
      data-environment={environment === "" ? undefined : environment}
    >
      <div className="sidebar-head">
        <span className="sidebar-title">{t("스키마")}</span>
        {tables ? <span className="schema-count">{tables.length}</span> : null}
        <span className="spacer" />
        <button
          type="button"
          className={system ? "chip-button active" : "chip-button"}
          title={t("시스템 스키마/테이블 표시")}
          onClick={toggleSystem}
        >
          SYS
        </button>
        <button
          type="button"
          className="icon-button"
          title={t("새 테이블 생성")}
          onClick={onOpenCreateTable}
        >
          <PlusIcon size={12} />
        </button>
        <button
          type="button"
          className="icon-button"
          title={t("테이블 개요")}
          onClick={onOpenOverview}
        >
          <ListIcon size={12} />
        </button>
        <button type="button" className="icon-button" title={t("사용자 관리")} onClick={onOpenUsers}>
          <UserIcon size={12} />
        </button>
        <button type="button" className="icon-button" title={t("서버 정보")} onClick={onOpenServer}>
          <ServerIcon size={12} />
        </button>
        <button
          type="button"
          className="icon-button"
          title={t("스키마 새로고침")}
          disabled={loading}
          onClick={() => {
            forceRef.current = true;
            setNonce((value) => value + 1);
          }}
        >
          {loading ? <Spinner size={11} /> : <RefreshIcon size={12} />}
        </button>
      </div>
      <div className="schema-search">
        <SearchIcon size={11} className="schema-search-icon" />
        <input
          value={filter}
          placeholder={t("테이블·오브젝트 검색 (퍼지)")}
          spellCheck={false}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>
      <div className="schema-list" ref={listRef}>
        {error ? (
          <div className="schema-error-slot">
            <ErrorNotice message={error} variant="compact" />
          </div>
        ) : orderedTables === null ? (
          <div className="schema-empty">
            <Spinner size={14} label={t("스키마를 불러오는 중…")} />
            <span>{t("스키마를 불러오는 중…")}</span>
          </div>
        ) : (
          <>
            <div className="schema-section-head" onClick={() => toggleSection("tables", true)}>
              <span className={`schema-toggle${tablesOpen ? " open" : ""}`}>
                <ChevronIcon size={10} />
              </span>
              <span className="schema-section-label">{t("테이블")}</span>
              <span className="schema-section-count">{tableCount}</span>
            </div>
            {tablesOpen &&
              (tableCount === 0 ? (
                <div className="schema-empty">
                  {query === "" ? t("테이블이 없습니다") : t("검색 결과가 없습니다")}
                </div>
              ) : (
                <>
                  {orderedTables.slice(0, renderLimit).map((table) => renderTableRow(table))}
                  {hasMore ? (
                    <div
                      ref={setSpacer}
                      className="schema-more"
                      style={{ height: spacerHeight }}
                      aria-hidden="true"
                    />
                  ) : null}
                </>
              ))}
            {objectFiltered !== null &&
              OBJECT_SECTIONS.map(({ kind, label }) => {
                const names = objectFiltered[`${kind}s` as keyof ObjectList];
                if (names.length === 0) {
                  return null;
                }
                const key = `objects:${kind}`;
                const isOpen = sections[key] ?? false;
                return (
                  <div className="schema-section" key={key}>
                    <div
                      className="schema-section-head"
                      onClick={() => toggleSection(key, false)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setSectionMenu({ x: event.clientX, y: event.clientY, obj: kind });
                      }}
                    >
                      <span className={`schema-toggle${isOpen ? " open" : ""}`}>
                        <ChevronIcon size={10} />
                      </span>
                      <span className="schema-section-label">{t(label)}</span>
                      <span className="schema-section-count">{names.length}</span>
                    </div>
                    {isOpen &&
                      names.map((name) => (
                        <div
                          className="schema-object-row"
                          key={`${kind}:${name}`}
                          role="button"
                          tabIndex={0}
                          title={
                            kind === "view"
                              ? `${name} — ${t("데이터 열기")}`
                              : `${name} — ${t("정의 보기")}`
                          }
                          onClick={(event) => {
                            if (kind === "view" && (event.metaKey || event.ctrlKey)) {
                              onOpenDataNewTab(name);
                              return;
                            }
                            if (kind === "view") {
                              onOpenData(name);
                            } else {
                              onOpenDefinition(kind, name);
                            }
                          }}
                          onAuxClick={(event) => {
                            if (event.button === 1 && kind === "view") {
                              event.preventDefault();
                              onOpenDataNewTab(name);
                            }
                          }}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            setObjectMenu({ x: event.clientX, y: event.clientY, obj: kind, name });
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              if (kind === "view") {
                                onOpenData(name);
                              } else {
                                onOpenDefinition(kind, name);
                              }
                            }
                          }}
                        >
                          <span className={`schema-object-icon kind-${kind}`} aria-hidden="true">
                            {objectIcon(kind)}
                          </span>
                          <span className="schema-object-name" title={name}>
                            {name}
                          </span>
                          {kind === "view" ? (
                            <button
                              type="button"
                              className="schema-row-action"
                              title={t("정의 보기")}
                              onClick={(event) => {
                                event.stopPropagation();
                                onOpenDefinition(kind, name);
                              }}
                            >
                              <CodeIcon size={11} />
                            </button>
                          ) : null}
                        </div>
                      ))}
                  </div>
                );
              })}
          </>
        )}
      </div>
      {menu !== null ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.table)}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {objectMenu !== null ? (
        <ContextMenu
          x={objectMenu.x}
          y={objectMenu.y}
          items={[
            {
              label: t("정의 보기"),
              onSelect: () => onOpenDefinition(objectMenu.obj, objectMenu.name),
            },
            {
              label: t("편집기에서 열기"),
              onSelect: () => {
                void (async () => {
                  try {
                    const detail = await store.fetchDefinition(conn, objectMenu.obj, objectMenu.name);
                    onOpenSql(detail.ddl ?? `-- ${objectMenu.name}`, objectMenu.name);
                  } catch {
                    store.setError("정의를 불러오지 못했습니다");
                  }
                })();
              },
            },
            {
              label: t("DROP 문 템플릿"),
              separatorBefore: true,
              onSelect: () =>
                onOpenSql(dropTemplate(kind, objectMenu.obj, objectMenu.name), objectMenu.name),
            },
          ]}
          onClose={() => setObjectMenu(null)}
        />
      ) : null}
      {sectionMenu !== null ? (
        <ContextMenu
          x={sectionMenu.x}
          y={sectionMenu.y}
          items={[
            {
              label: t("새 오브젝트 템플릿"),
              onSelect: () => {
                const template = createTemplate(kind, sectionMenu.obj);
                if (template === "") {
                  store.setInfo("이 엔진은 해당 오브젝트 템플릿을 지원하지 않습니다");
                  return;
                }
                onOpenSql(template, `${sectionMenu.obj} 템플릿`);
              },
            },
          ]}
          onClose={() => setSectionMenu(null)}
        />
      ) : null}
    </div>
  );
}
