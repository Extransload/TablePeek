// The Items pane of a document connection (MONGODB.md §3.1): databases,
// each opening to its collections and views with estimated document counts.
// Click opens a collection tab; the context menus offer 열기 · 새 mongosh 탭
// · 새로 고침 and the management dialogs (만들기, 가져오기, 내보내기, 이름
// 바꾸기, 삭제, 통계 — MONGODB.md §6.2), which App shows through `onAdmin`.
// A GridFS bucket (`<b>.files` beside `<b>.chunks`) shows as one node that
// opens the bucket's tab and folds out to its two collections; a database's
// menu opens its 변경 보기 tab (MONGODB.md §8.1).
// The connection's default database starts open.

import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { ContextMenu, type ContextMenuItem } from "../../../components/ContextMenu";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { ChevronIcon, DatabaseIcon, FolderIcon, MoreIcon, SearchIcon, TableIcon } from "../../../components/icons";
import { LoadingState, Spinner } from "../../../components/Spinner";
import { t } from "../../../i18n";
import { store } from "../../../store";
import { listCollections, listDatabases, type CollectionInfo, type DocDatabase } from "../api";
import { SYSTEM_DATABASES, type DocAdminRequest } from "./ManageModals";

interface DocSidebarProps {
  conn: string;
  // Bumped to read everything again (F5, after a drop).
  refreshKey: number;
  // The collection in front, highlighted.
  active: { db: string; coll: string } | null;
  // `view`: a MongoDB view, opened read-only.
  onOpen(db: string, coll: string, view: boolean): void;
  // A new mongosh tab on `db`, its text seeded when a collection was picked.
  onOpenShell(db: string, text?: string): void;
  // A management dialog (create, import, export, rename, drop, stats).
  onAdmin(request: DocAdminRequest): void;
  // A database's 변경 보기 tab.
  onOpenWatch(db: string): void;
  // A GridFS bucket's tab, and the bucket in front (highlighted).
  onOpenBucket(db: string, bucket: string): void;
  activeBucket: { db: string; bucket: string } | null;
}

// The GridFS buckets among a database's collections: `<b>.files` names whose
// `<b>.chunks` is there too.
function bucketsOf(list: CollectionInfo[]): Set<string> {
  const names = new Set(list.map((c) => c.name));
  const out = new Set<string>();
  for (const name of names) {
    if (name.endsWith(".files") && names.has(`${name.slice(0, -6)}.chunks`)) {
      out.add(name.slice(0, -6));
    }
  }
  return out;
}

type Loaded = { state: "loading" } | { state: "error"; error: unknown } | { state: "ok"; list: CollectionInfo[] };

// Databases the sidebar opened, per connection, while the app runs.
const openByConn = new Map<string, Set<string>>();
// Connections whose own database was opened once already.
const seeded = new Set<string>();

export function DocSidebar({ conn, refreshKey, active, onOpen, onOpenShell, onAdmin, onOpenWatch, onOpenBucket, activeBucket }: DocSidebarProps) {
  const [databases, setDatabases] = useState<DocDatabase[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [open, setOpen] = useState<Set<string>>(() => openByConn.get(conn) ?? new Set());
  const [collections, setCollections] = useState<Record<string, Loaded>>({});
  const [filter, setFilter] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[] } | null>(null);
  const [nonce, setNonce] = useState(0);
  // Bucket nodes folded out to their two collections (`db.bucket`).
  const [openBuckets, setOpenBuckets] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    openByConn.set(conn, open);
  }, [conn, open]);

  const loadCollections = useCallback(
    (db: string) => {
      setCollections((prev) => ({ ...prev, [db]: { state: "loading" } }));
      listCollections(conn, db).then(
        (list) =>
          setCollections((prev) => ({
            ...prev,
            // system.* (views, profile, …) are the server's own, as Compass hides them.
            [db]: { state: "ok", list: list.filter((c) => !c.name.startsWith("system.")).sort((a, b) => a.name.localeCompare(b.name)) },
          })),
        (err: unknown) => setCollections((prev) => ({ ...prev, [db]: { state: "error", error: err } })),
      );
    },
    [conn],
  );

  // Databases, then the open ones' collections; the first time, the
  // connection's own database starts open.
  useEffect(() => {
    let alive = true;
    setError(null);
    const first = !seeded.has(conn);
    Promise.all([listDatabases(conn), first ? store.fetchServer(conn).catch(() => null) : Promise.resolve(null)]).then(
      ([list, info]) => {
        if (!alive) {
          return;
        }
        setDatabases(list);
        seeded.add(conn);
        // A database dropped since (here or elsewhere) no longer stays open.
        let shown = new Set([...(openByConn.get(conn) ?? [])].filter((name) => list.some((d) => d.name === name)));
        const own = info?.database ?? null;
        if (own !== null && own !== "" && !shown.has(own)) {
          shown = new Set(shown).add(own);
        }
        setOpen(shown);
        for (const db of shown) {
          loadCollections(db);
        }
      },
      (err: unknown) => {
        if (alive) {
          setError(err);
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [conn, refreshKey, nonce, loadCollections]);

  const toggle = (db: string) => {
    const next = new Set(open);
    if (next.has(db)) {
      next.delete(db);
    } else {
      next.add(db);
      if (collections[db] === undefined || collections[db].state === "error") {
        loadCollections(db);
      }
    }
    setOpen(next);
  };

  const query = filter.trim().toLowerCase();
  // While searching, databases whose loaded collections match stay open.
  const shownDatabases = useMemo(() => {
    if (databases === null) {
      return null;
    }
    if (query === "") {
      return databases;
    }
    return databases.filter((db) => {
      const loaded = collections[db.name];
      return db.name.toLowerCase().includes(query) || (loaded?.state === "ok" && loaded.list.some((c) => c.name.toLowerCase().includes(query)));
    });
  }, [databases, collections, query]);

  const dbMenu = (db: string): ContextMenuItem[] => [
    { label: t("컬렉션 만들기…"), onSelect: () => onAdmin({ kind: "createCollection", db }) },
    { label: t("뷰 만들기…"), onSelect: () => onAdmin({ kind: "createCollection", db, view: true }) },
    { label: t("가져오기…"), onSelect: () => onAdmin({ kind: "import", db, coll: null }) },
    { label: t("새 mongosh 탭"), separatorBefore: true, onSelect: () => onOpenShell(db) },
    { label: t("변경 보기"), onSelect: () => onOpenWatch(db) },
    { label: t("새로 고침"), onSelect: () => loadCollections(db) },
    { label: t("데이터베이스 삭제…"), separatorBefore: true, danger: true, disabled: SYSTEM_DATABASES[db] === true, onSelect: () => onAdmin({ kind: "drop", db, coll: null }) },
  ];

  const collMenu = (db: string, coll: string, view: boolean): ContextMenuItem[] => [
    { label: t("열기"), onSelect: () => onOpen(db, coll, view) },
    { label: t("새 mongosh 탭"), onSelect: () => onOpenShell(db, `db.${/^[A-Za-z_$][\w$]*$/.test(coll) ? coll : `getCollection(${JSON.stringify(coll)})`}.find({})\n`) },
    ...(view ? [] : [{ label: t("가져오기…"), separatorBefore: true, onSelect: () => onAdmin({ kind: "import", db, coll }) }]),
    { label: t("내보내기…"), separatorBefore: view, onSelect: () => onAdmin({ kind: "export", db, coll }) },
    ...(view
      ? []
      : [
          { label: t("통계"), onSelect: () => onAdmin({ kind: "stats", db, coll }) },
          { label: t("이름 바꾸기…"), onSelect: () => onAdmin({ kind: "rename", db, coll }) },
        ]),
    { label: t("새로 고침"), separatorBefore: true, onSelect: () => loadCollections(db) },
    { label: view ? t("뷰 삭제…") : t("컬렉션 삭제…"), separatorBefore: true, danger: true, onSelect: () => onAdmin({ kind: "drop", db, coll, view }) },
  ];

  const bucketMenu = (db: string, bucket: string): ContextMenuItem[] => [
    { label: t("열기"), onSelect: () => onOpenBucket(db, bucket) },
    { label: t("{name} 컬렉션 열기", { name: `${bucket}.files` }), separatorBefore: true, onSelect: () => onOpen(db, `${bucket}.files`, false) },
    { label: t("{name} 컬렉션 열기", { name: `${bucket}.chunks` }), onSelect: () => onOpen(db, `${bucket}.chunks`, false) },
    { label: t("새로 고침"), separatorBefore: true, onSelect: () => loadCollections(db) },
  ];

  const collRow = (db: string, c: CollectionInfo, nested: boolean): ReactElement => {
    const isActive = active !== null && active.db === db && active.coll === c.name;
    return (
      <div className="schema-table mg-side-coll" key={c.name}>
        <div
          className={`schema-table-row${isActive ? " active" : ""}`}
          aria-current={isActive ? "true" : undefined}
          role="button"
          tabIndex={0}
          title={`${db}.${c.name}`}
          onClick={() => onOpen(db, c.name, c.type === "view")}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onOpen(db, c.name, c.type === "view");
            }
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY, items: collMenu(db, c.name, c.type === "view") });
          }}
        >
          <span className="schema-toggle-space" />
          {nested ? <span className="schema-toggle-space" /> : null}
          <TableIcon size={11} className="schema-table-icon" />
          <span className="schema-table-name">{c.name}</span>
          {c.type === "view" ? <span className="mg-side-badge">{t("뷰 [종류]")}</span> : null}
          {c.type === "timeseries" ? <span className="mg-side-badge">{t("시계열")}</span> : null}
          {c.count !== null ? <span className="schema-section-count mg-side-count">{c.count.toLocaleString()}</span> : null}
        </div>
      </div>
    );
  };

  // A bucket node: opens the bucket's tab; its chevron folds out the two
  // collections. The count is the number of files.
  const bucketRow = (db: string, bucket: string, files: CollectionInfo, chunks: CollectionInfo | undefined): ReactElement => {
    const key = `${db}.${bucket}`;
    const isOpen = openBuckets.has(key);
    const isActive = activeBucket !== null && activeBucket.db === db && activeBucket.bucket === bucket;
    const toggleBucket = () =>
      setOpenBuckets((prev) => {
        const next = new Set(prev);
        if (!next.delete(key)) {
          next.add(key);
        }
        return next;
      });
    return (
      <div className="schema-table mg-side-coll" key={`bucket:${bucket}`}>
        <div
          className={`schema-table-row${isActive ? " active" : ""}`}
          aria-current={isActive ? "true" : undefined}
          aria-expanded={isOpen}
          role="button"
          tabIndex={0}
          title={t("GridFS 버킷 {name}", { name: key })}
          onClick={() => onOpenBucket(db, bucket)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onOpenBucket(db, bucket);
            } else if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
              event.preventDefault();
              if (isOpen !== (event.key === "ArrowRight")) {
                toggleBucket();
              }
            }
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY, items: bucketMenu(db, bucket) });
          }}
        >
          <span
            className={`schema-toggle${isOpen ? " open" : ""}`}
            onClick={(event) => {
              event.stopPropagation();
              toggleBucket();
            }}
          >
            <ChevronIcon size={10} />
          </span>
          <FolderIcon size={11} className="schema-table-icon" />
          <span className="schema-table-name">{bucket}</span>
          <span className="mg-side-badge">GridFS</span>
          {files.count !== null ? <span className="schema-section-count mg-side-count">{files.count.toLocaleString()}</span> : null}
        </div>
        {isOpen ? (
          <>
            {collRow(db, files, true)}
            {chunks !== undefined ? collRow(db, chunks, true) : null}
          </>
        ) : null}
      </div>
    );
  };

  const renderCollections = (db: string): ReactElement | null => {
    const loaded = collections[db];
    if (loaded === undefined || loaded.state === "loading") {
      return <LoadingState variant="compact" label={t("컬렉션을 불러오는 중…")} />;
    }
    if (loaded.state === "error") {
      return (
        <div className="schema-error-slot">
          <ErrorNotice error={loaded.error} context="general" engine="mongodb" variant="compact" />
        </div>
      );
    }
    const buckets = bucketsOf(loaded.list);
    const matches = (name: string) => name.toLowerCase().includes(query);
    const showAll = query === "" || db.toLowerCase().includes(query);
    // A bucket shows when its name or either collection matches.
    const list = showAll
      ? loaded.list
      : loaded.list.filter((c) => {
          const bucket = c.name.endsWith(".files") || c.name.endsWith(".chunks") ? c.name.slice(0, c.name.lastIndexOf(".")) : null;
          return matches(c.name) || (bucket !== null && buckets.has(bucket) && (matches(bucket) || matches(`${bucket}.files`) || matches(`${bucket}.chunks`)));
        });
    if (list.length === 0) {
      return <div className="schema-empty">{query === "" ? t("컬렉션이 없습니다") : t("검색 결과가 없습니다")}</div>;
    }
    const byName = new Map(loaded.list.map((c) => [c.name, c]));
    return (
      <>
        {list.map((c) => {
          if (c.name.endsWith(".chunks") && buckets.has(c.name.slice(0, -7))) {
            return null;
          }
          if (c.name.endsWith(".files") && buckets.has(c.name.slice(0, -6))) {
            const bucket = c.name.slice(0, -6);
            return bucketRow(db, bucket, c, byName.get(`${bucket}.chunks`));
          }
          return collRow(db, c, false);
        })}
      </>
    );
  };

  return (
    <div className="sidebar-pane">
      <div className="schema-search">
        <SearchIcon size={11} className="schema-search-icon" />
        <input value={filter} placeholder={t("데이터베이스·컬렉션 검색")} spellCheck={false} onChange={(event) => setFilter(event.target.value)} />
        <button
          type="button"
          className="icon-button schema-more"
          title={t("더 보기")}
          aria-haspopup="menu"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({
              x: rect.left,
              y: rect.bottom + 4,
              items: [
                { label: t("데이터베이스 만들기…"), onSelect: () => onAdmin({ kind: "createDatabase" }) },
                { label: t("새로 고침"), separatorBefore: true, onSelect: () => setNonce((n) => n + 1) },
              ],
            });
          }}
        >
          {databases === null && error === null ? <Spinner size={11} /> : <MoreIcon size={13} />}
        </button>
      </div>
      <div className="schema-list">
        {error !== null ? (
          <div className="schema-error-slot">
            <ErrorNotice error={error} context="general" engine="mongodb" variant="compact" />
          </div>
        ) : shownDatabases === null ? (
          <LoadingState variant="compact" label={t("데이터베이스를 불러오는 중…")} />
        ) : shownDatabases.length === 0 ? (
          <div className="schema-empty">{query === "" ? t("데이터베이스가 없습니다") : t("검색 결과가 없습니다")}</div>
        ) : (
          shownDatabases.map((db) => {
            const isOpen = open.has(db.name) || (query !== "" && collections[db.name]?.state === "ok");
            const loaded = collections[db.name];
            return (
              <div className="schema-section" key={db.name}>
                <div
                  className="schema-section-head mg-side-db"
                  role="button"
                  tabIndex={0}
                  aria-expanded={isOpen}
                  onClick={() => toggle(db.name)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      toggle(db.name);
                    }
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenu({ x: event.clientX, y: event.clientY, items: dbMenu(db.name) });
                  }}
                >
                  <span className={`schema-toggle${isOpen ? " open" : ""}`}>
                    <ChevronIcon size={10} />
                  </span>
                  <DatabaseIcon size={11} className="schema-table-icon" />
                  <span className="schema-section-label">{db.name}</span>
                  {loaded?.state === "ok" ? <span className="schema-section-count">{loaded.list.length}</span> : null}
                </div>
                {isOpen ? renderCollections(db.name) : null}
              </div>
            );
          })
        )}
      </div>
      {menu !== null ? <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}
