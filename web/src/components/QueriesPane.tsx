import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { writeClipboard } from "../clipboard";
import { t } from "../i18n";
import {
  loadAutoSave,
  loadQuerySort,
  saveAutoSave,
  saveQuerySort,
  sortQueries,
  type QuerySort,
} from "../savedQueries";
import { store, type Favorite, type FavoriteFolder } from "../store";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { ErrorNotice } from "./ErrorNotice";
import { LoadingState } from "./Spinner";
import { PromptModal } from "./PromptModal";
import { SavedQueryModal } from "./SavedQueryModal";
import { ChevronDownIcon, ChevronIcon, FileIcon, FolderIcon, PlusIcon, SearchIcon } from "./icons";

interface QueriesPaneProps {
  onOpen(query: Favorite): void;
  onRun(sql: string): void;
  onInsert(sql: string): void;
}

// Queries outside any folder sit under this heading, as in TablePlus.
const UNGROUPED = "";

type Selection = { kind: "query"; id: string } | { kind: "folder"; id: string } | null;

interface Group {
  id: string;
  name: string;
  queries: Favorite[];
}

type Editing = { query: Favorite | null; folder: string | null } | null;
type Naming = { folder: FavoriteFolder | null } | null;

// TablePlus's Queries tab: saved queries, ungrouped first and then by folder.
// A double-click opens one in its own tab; drag one onto a folder to move it.
export function QueriesPane({ onOpen, onRun, onInsert }: QueriesPaneProps) {
  const [favorites, setFavorites] = useState<Favorite[] | null>(null);
  const [folders, setFolders] = useState<FavoriteFolder[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Selection>(null);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [sort, setSort] = useState<QuerySort>(loadQuerySort);
  const [autoSave, setAutoSave] = useState(loadAutoSave);
  // `plus` marks the menu opened from the ⌄ button, which also closes it again.
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[]; plus?: boolean } | null>(
    null,
  );
  const [editing, setEditing] = useState<Editing>(null);
  const [naming, setNaming] = useState<Naming>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const plusMenuRef = useRef<HTMLButtonElement | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const next = await store.fetchSavedQueries();
      setFavorites(next.favorites);
      setFolders(next.folders);
      setError(null);
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t("저장한 쿼리를 불러오지 못했습니다"));
    }
  }, []);

  useEffect(() => {
    void load();
    const reload = (): void => void load();
    window.addEventListener("tablepeek:favorites-changed", reload);
    return () => window.removeEventListener("tablepeek:favorites-changed", reload);
  }, [load]);

  const needle = filter.trim().toLowerCase();
  const groups = useMemo((): Group[] => {
    const matches = (query: Favorite): boolean =>
      needle === "" ||
      query.name.toLowerCase().includes(needle) ||
      (query.keyword ?? "").toLowerCase().includes(needle) ||
      query.sql.toLowerCase().includes(needle);
    const sorted = sortQueries((favorites ?? []).filter(matches), sort);
    const known = new Set(folders.map((folder) => folder.id));
    const result: Group[] = [
      {
        id: UNGROUPED,
        name: t("그룹 없음"),
        queries: sorted.filter((query) => !query.folder || !known.has(query.folder)),
      },
    ];
    const byName = folders
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
    for (const folder of byName) {
      result.push({
        id: folder.id,
        name: folder.name,
        queries: sorted.filter((query) => query.folder === folder.id),
      });
    }
    // While searching, only groups with a match. Otherwise every folder, empty
    // ones too, and the ungrouped heading whenever there are folders, so a
    // query can always be dragged back out of one.
    return result.filter((group) =>
      needle !== ""
        ? group.queries.length > 0
        : group.id !== UNGROUPED || group.queries.length > 0 || folders.length > 0,
    );
  }, [favorites, folders, sort, needle]);

  const isOpen = (id: string): boolean => needle !== "" || !(closed[id] ?? false);
  const visible = groups.flatMap((group) => (isOpen(group.id) ? group.queries : []));
  const total = favorites?.length ?? 0;

  function fail(err: unknown, fallback: string): void {
    setError(err instanceof Error && err.message ? err.message : fallback);
  }

  async function removeQuery(query: Favorite): Promise<void> {
    if (!window.confirm(t("'{name}' 쿼리를 삭제할까요?", { name: query.name }))) {
      return;
    }
    try {
      await store.deleteFavorite(query.id);
      setSelected(null);
    } catch (err) {
      fail(err, t("쿼리를 삭제하지 못했습니다"));
    }
  }

  async function removeFolder(folder: FavoriteFolder): Promise<void> {
    const count = (favorites ?? []).filter((query) => query.folder === folder.id).length;
    const question =
      count === 0
        ? t("'{name}' 폴더를 삭제할까요?", { name: folder.name })
        : t("'{name}' 폴더와 그 안의 쿼리 {count}개를 삭제할까요?", { name: folder.name, count });
    if (!window.confirm(question)) {
      return;
    }
    try {
      await store.deleteFavoriteFolder(folder.id);
      setSelected(null);
    } catch (err) {
      fail(err, t("폴더를 삭제하지 못했습니다"));
    }
  }

  async function moveQuery(id: string, folder: string): Promise<void> {
    const query = favorites?.find((entry) => entry.id === id);
    if (query === undefined || (query.folder ?? UNGROUPED) === folder) {
      return;
    }
    try {
      await store.updateFavorite(id, { folder: folder === UNGROUPED ? null : folder });
    } catch (err) {
      fail(err, t("쿼리를 옮기지 못했습니다"));
    }
  }

  function newItems(folder: string | null): ContextMenuItem[] {
    return [
      { label: t("새 쿼리…"), onSelect: () => setEditing({ query: null, folder }) },
      { label: t("새 폴더…"), onSelect: () => setNaming({ folder: null }) },
    ];
  }

  function plusMenuItems(): ContextMenuItem[] {
    const sortItem = (value: QuerySort, label: string): ContextMenuItem => ({
      label,
      checked: sort === value,
      onSelect: () => {
        setSort(value);
        saveQuerySort(value);
      },
    });
    return [
      ...newItems(null),
      {
        label: t("정렬"),
        separatorBefore: true,
        submenu: [
          sortItem("name", t("이름")),
          sortItem("created", t("만든 날짜")),
          sortItem("modified", t("수정한 날짜")),
        ],
      },
      {
        label: t("설정"),
        submenu: [
          {
            label: t("쿼리 자동 저장"),
            checked: autoSave,
            onSelect: () => {
              setAutoSave(!autoSave);
              saveAutoSave(!autoSave);
            },
          },
        ],
      },
    ];
  }

  function queryItems(query: Favorite): ContextMenuItem[] {
    return [
      { label: t("실행"), onSelect: () => onRun(query.sql) },
      { label: t("복사"), onSelect: () => void writeClipboard(query.sql, setError) },
      { label: t("편집·이름 바꾸기…"), onSelect: () => setEditing({ query, folder: query.folder ?? null }) },
      { label: t("탭에서 열기"), separatorBefore: true, onSelect: () => onOpen(query) },
      { label: t("SQL 에디터에 넣기"), onSelect: () => onInsert(query.sql) },
      { label: t("삭제"), separatorBefore: true, danger: true, onSelect: () => void removeQuery(query) },
    ];
  }

  function folderItems(folder: FavoriteFolder): ContextMenuItem[] {
    return [
      ...newItems(folder.id),
      {
        label: t("이름 바꾸기…"),
        separatorBefore: true,
        onSelect: () => setNaming({ folder }),
      },
      { label: t("삭제"), danger: true, onSelect: () => void removeFolder(folder) },
    ];
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.target !== event.currentTarget) {
      return;
    }
    const index = selected?.kind === "query" ? visible.findIndex((query) => query.id === selected.id) : -1;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = visible[Math.min(visible.length - 1, Math.max(0, index + step))];
      if (next !== undefined) {
        setSelected({ kind: "query", id: next.id });
      }
      return;
    }
    const query = index >= 0 ? visible[index] : null;
    if (event.key === "Enter" && query !== null) {
      event.preventDefault();
      onOpen(query);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      if (query !== null) {
        void removeQuery(query);
      } else if (selected?.kind === "folder") {
        const folder = folders.find((entry) => entry.id === selected.id);
        if (folder !== undefined) {
          void removeFolder(folder);
        }
      }
    }
  }

  function dropProps(groupId: string) {
    return {
      onDragOver(event: DragEvent) {
        if (event.dataTransfer.types.includes("application/x-tablepeek-query")) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDropTarget(groupId);
        }
      },
      onDragLeave(event: DragEvent) {
        // Moving between the group's own rows isn't leaving it.
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
          return;
        }
        setDropTarget((current) => (current === groupId ? null : current));
      },
      onDrop(event: DragEvent) {
        const id = event.dataTransfer.getData("application/x-tablepeek-query");
        setDropTarget(null);
        if (id !== "") {
          event.preventDefault();
          void moveQuery(id, groupId);
        }
      },
    };
  }

  return (
    <div className="sidebar-pane">
      <div className="schema-search">
        <SearchIcon size={11} className="schema-search-icon" />
        <input
          value={filter}
          placeholder={t("쿼리 검색")}
          spellCheck={false}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>
      <div
        className="schema-list queries-list"
        tabIndex={0}
        onKeyDown={onKeyDown}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY, items: newItems(null) });
        }}
      >
        {error !== null ? (
          <div className="schema-error-slot">
            <ErrorNotice message={error} variant="compact" />
          </div>
        ) : null}
        {favorites === null ? (
          error === null ? <LoadingState variant="compact" /> : null
        ) : groups.length === 0 ? (
          <div className="panel-empty">
            {total === 0 && needle === ""
              ? t("저장한 쿼리가 없습니다. 우클릭해서 새 쿼리를 추가하세요")
              : t("검색 결과가 없습니다")}
          </div>
        ) : (
          groups.map((group) => {
            const folder = folders.find((entry) => entry.id === group.id) ?? null;
            return (
              <div
                className={`queries-group${dropTarget === group.id ? " drop" : ""}`}
                key={group.id || "ungrouped"}
                {...dropProps(group.id)}
              >
                <div
                  className={`schema-section-head${
                    selected?.kind === "folder" && selected.id === group.id ? " selected" : ""
                  }`}
                  onClick={() => {
                    if (folder !== null) {
                      setSelected({ kind: "folder", id: folder.id });
                    }
                    setClosed((current) => ({ ...current, [group.id]: isOpen(group.id) }));
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (folder !== null) {
                      setSelected({ kind: "folder", id: folder.id });
                      setMenu({ x: event.clientX, y: event.clientY, items: folderItems(folder) });
                    } else {
                      setMenu({ x: event.clientX, y: event.clientY, items: newItems(null) });
                    }
                  }}
                >
                  <span className={`schema-toggle${isOpen(group.id) ? " open" : ""}`}>
                    <ChevronIcon size={10} />
                  </span>
                  {folder !== null ? <FolderIcon size={11} className="queries-folder-icon" /> : null}
                  <span className="schema-section-label">{group.name}</span>
                  <span className="schema-section-count">{group.queries.length}</span>
                </div>
                {isOpen(group.id)
                  ? group.queries.map((query) => (
                      <div
                        className={`queries-item${
                          selected?.kind === "query" && selected.id === query.id ? " selected" : ""
                        }`}
                        key={query.id}
                        draggable
                        title={query.sql}
                        onDragStart={(event) => {
                          event.dataTransfer.setData("application/x-tablepeek-query", query.id);
                          event.dataTransfer.effectAllowed = "move";
                        }}
                        onClick={() => setSelected({ kind: "query", id: query.id })}
                        onDoubleClick={() => onOpen(query)}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setSelected({ kind: "query", id: query.id });
                          setMenu({ x: event.clientX, y: event.clientY, items: queryItems(query) });
                        }}
                      >
                        <FileIcon size={11} className="queries-file-icon" />
                        <span className="queries-name">{query.name}</span>
                        {query.keyword ? <span className="queries-keyword">{query.keyword}</span> : null}
                      </div>
                    ))
                  : null}
              </div>
            );
          })
        )}
      </div>
      <div className="sidebar-foot">
        <button
          type="button"
          className="icon-button"
          title={t("새 쿼리…")}
          aria-label={t("새 쿼리…")}
          onClick={() =>
            setEditing({ query: null, folder: selected?.kind === "folder" ? selected.id : null })
          }
        >
          <PlusIcon size={12} />
        </button>
        <button
          type="button"
          className="icon-button"
          ref={plusMenuRef}
          title={t("더 보기")}
          aria-haspopup="menu"
          onClick={(event) => {
            if (menu?.plus) {
              setMenu(null);
              return;
            }
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.left, y: rect.top - 4, items: plusMenuItems(), plus: true });
          }}
        >
          <ChevronDownIcon size={11} />
        </button>
      </div>
      {menu !== null ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          anchor={menu.plus ? plusMenuRef.current : null}
          onClose={() => setMenu(null)}
        />
      ) : null}
      {editing !== null ? (
        <SavedQueryModal query={editing.query} folder={editing.folder} onClose={() => setEditing(null)} />
      ) : null}
      {naming !== null ? (
        <PromptModal
          title={naming.folder === null ? t("새 폴더") : t("폴더 이름 바꾸기")}
          label={t("이름")}
          initial={naming.folder?.name ?? ""}
          confirmLabel={naming.folder === null ? t("만들기") : t("이름 바꾸기")}
          onSubmit={async (name) => {
            try {
              if (naming.folder === null) {
                await store.createFavoriteFolder(name);
              } else {
                await store.renameFavoriteFolder(naming.folder.id, name);
              }
              return null;
            } catch (err) {
              return err instanceof Error && err.message ? err.message : t("폴더를 저장하지 못했습니다");
            }
          }}
          onClose={() => setNaming(null)}
        />
      ) : null}
    </div>
  );
}
