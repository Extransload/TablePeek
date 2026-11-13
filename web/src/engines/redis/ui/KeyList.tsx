// The Browser's left pane: the keys of the database, RedisInsight-style.
// Keys come from SCAN (never KEYS), a page at a time, each once however
// often SCAN returns it, and the scan goes on by itself until the pane is
// full; "Scan more" takes it further. A pattern (MATCH) and a type (TYPE,
// or several, kept apart on the page) narrow it. List view: type, name,
// time left and size, the last two read for the rows in sight in one
// request. Tree view: namespace folders on a delimiter. Rows are drawn
// only where they show, so a list of 100k keys stays light. ↑ ↓ move the
// selection, ↩ opens a key or folds a folder, ⌫ deletes after asking.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useRowMotion } from "../../../components/Collapse";
import { ContextMenu, type ContextMenuItem } from "../../../components/ContextMenu";
import { ErrorNotice } from "../../../components/ErrorNotice";
import { Gauge } from "../../../components/Gauge";
import { ChevronIcon, FilterIcon, FolderIcon, PlusIcon, RefreshIcon, SearchIcon } from "../../../components/icons";
import { t } from "../../../i18n";
import { isAbort, keysMeta, scan, type KeyMeta } from "../api";
import { binId, binText, consoleArg, type Bin } from "../bin";
import { buildKeyTree, KeySet, matchPattern, type KeyFolder, type ScanKey } from "../keytree";
import { copyText, deleteKeys, downloadKey, sizeText, ttlText, TypeBadge, type KeyChange, type RedisHost } from "./common";

export interface KeyListPrefs {
  view: "list" | "tree";
  delimiter: string;
  pattern: string;
  types: string[];
}

const ROW = 26;
// Scan pages taken by themselves before "Scan more" is needed.
const AUTO_PAGES = 20;
const META_MAX = 500;
const KEY_TYPES = ["string", "hash", "list", "set", "zset", "stream", "ReJSON-RL"];
const DELIMITERS = [":", "/", ".", "|", "-", "_"];

type Row =
  | { kind: "folder"; folder: KeyFolder; depth: number }
  | { kind: "key"; entry: ScanKey; depth: number; name: string };

// The name with its end kept: a long key reads "user:prof…:42:settings".
function KeyName({ name }: { name: string }) {
  if (name.length <= 28) {
    return <span className="kv-name">{name === "" ? t("(빈 이름)") : name}</span>;
  }
  return (
    <span className="kv-name">
      <span className="kv-name-head">{name.slice(0, -12)}</span>
      <span className="kv-name-tail">{name.slice(-12)}</span>
    </span>
  );
}

function flatten(folder: KeyFolder, depth: number, open: ReadonlySet<string>, all: boolean, out: Row[]): void {
  for (const child of folder.folders) {
    out.push({ kind: "folder", folder: child, depth });
    if (all || open.has(child.prefix)) {
      flatten(child, depth + 1, open, all, out);
    }
  }
  for (const entry of folder.keys) {
    out.push({ kind: "key", entry, depth, name: binText(entry.key).slice(folder.prefix.length) });
  }
}

export function KeyList({
  host,
  db,
  total,
  refreshSeq,
  change,
  selected,
  onSelect,
  onCreate,
  onOpenCli,
  prefs,
  onPrefs,
}: {
  host: RedisHost;
  db: number;
  // DBSIZE, from the overview.
  total: number | null;
  refreshSeq: number;
  // The latest change made on this page; the list follows it without a rescan.
  change: { seq: number; change: KeyChange } | null;
  selected: Bin | null;
  onSelect(entry: ScanKey | null): void;
  onCreate(prefix: string): void;
  onOpenCli(text: string): void;
  prefs: KeyListPrefs;
  onPrefs(next: KeyListPrefs): void;
}) {
  const { conn } = host;
  const [filter, setFilter] = useState(prefs.pattern);
  const keysRef = useRef(new KeySet());
  const [version, setVersion] = useState(0);
  const [cursor, setCursor] = useState("0");
  const [started, setStarted] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [meta, setMeta] = useState<Map<string, KeyMeta>>(new Map());
  const [menu, setMenu] = useState<{ x: number; y: number; items: ContextMenuItem[]; anchor?: Element } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const [cursorRow, setCursorRow] = useState(-1);
  const scanRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pendingMeta = useRef(new Set<string>());
  const pattern = matchPattern(prefs.pattern);
  // One type goes to the server (SCAN TYPE); several are told apart here.
  const serverType = prefs.types.length === 1 ? prefs.types[0] : null;
  const typeSet = prefs.types.length > 1 ? new Set(prefs.types) : null;

  useLayoutEffect(() => {
    const box = scrollRef.current;
    if (box === null) {
      return;
    }
    const observer = new ResizeObserver(() => setHeight(box.clientHeight));
    observer.observe(box);
    setHeight(box.clientHeight);
    return () => observer.disconnect();
  }, []);

  // Scans on from `from` until `want` matching keys more, or `pages` pages.
  const scanMore = useCallback(
    async (from: string, want: number, fresh: boolean, pages = AUTO_PAGES) => {
      scanRef.current?.abort();
      const ctl = new AbortController();
      scanRef.current = ctl;
      if (fresh) {
        keysRef.current = new KeySet();
        setMeta(new Map());
        pendingMeta.current.clear();
        setVersion((n) => n + 1);
      }
      setScanning(true);
      setError(null);
      let next = from;
      let gathered = 0;
      let taken = 0;
      try {
        do {
          const page = await scan(conn, { db, cursor: next, pattern, type: serverType, count: 500 }, ctl.signal);
          const kept = typeSet === null ? page.keys : page.keys.filter((entry) => typeSet.has(entry.type));
          gathered += keysRef.current.add(kept);
          next = page.cursor;
          taken += 1;
          setCursor(next);
          setStarted(true);
          setVersion((n) => n + 1);
        } while (next !== "0" && gathered < want && taken < pages && !ctl.signal.aborted);
      } catch (reason) {
        if (!isAbort(reason)) {
          setError(reason);
          setStarted(true);
        }
      } finally {
        if (scanRef.current === ctl) {
          scanRef.current = null;
          setScanning(false);
        }
      }
    },
    // The type set is the types' list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [conn, db, pattern, serverType, prefs.types.join(",")],
  );

  const viewRows = Math.max(20, Math.ceil(height / ROW));
  useEffect(() => {
    setStarted(false);
    setCursor("0");
    setCursorRow(-1);
    void scanMore("0", viewRows * 2, true);
    return () => scanRef.current?.abort();
    // The first scan fills the pane as it is when the scan starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanMore, refreshSeq, nonce]);

  // Changes made in the key details or a dialog.
  useEffect(() => {
    if (change === null || change.change.db !== db) {
      return;
    }
    const c = change.change;
    if (c.kind === "deleted") {
      keysRef.current.delete(c.key);
    } else if (c.kind === "renamed") {
      const old = keysRef.current.list().find((entry) => binId(entry.key) === binId(c.key));
      keysRef.current.delete(c.key);
      keysRef.current.add([{ key: c.to, type: old?.type ?? "string" }]);
    } else if (c.kind === "created") {
      keysRef.current.add([{ key: c.key, type: c.type }]);
    }
    // A change may touch the time left or size.
    const id = binId(c.kind === "renamed" ? c.to : c.key);
    setMeta((prev) => {
      if (!prev.has(id)) {
        return prev;
      }
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
    pendingMeta.current.delete(id);
    setVersion((n) => n + 1);
    // Only a new change counts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [change?.seq]);

  const rows = useMemo(() => {
    const list = keysRef.current.list();
    if (prefs.view === "list") {
      return list.map((entry): Row => ({ kind: "key", entry, depth: 0, name: binText(entry.key) }));
    }
    const out: Row[] = [];
    // A narrowed scan opens every folder of a short result.
    flatten(buildKeyTree(list, prefs.delimiter), 0, open, (pattern !== null || prefs.types.length > 0) && list.length <= 300, out);
    return out;
    // `version` stands for the key set's contents.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, prefs.view, prefs.delimiter, open, pattern, prefs.types.length]);

  const done = started && cursor === "0";
  const first = Math.max(0, Math.floor(scrollTop / ROW) - 6);
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / ROW) + 6);
  const shown = rows.slice(first, last);

  // A pane not yet full scans on by itself.
  useEffect(() => {
    if (started && !scanning && !done && error === null && rows.length < viewRows) {
      void scanMore(cursor, viewRows - rows.length, false);
    }
  }, [started, scanning, done, error, rows.length, viewRows, cursor, scanMore]);

  // Time left and size of the keys in sight, in one request.
  const wantedMeta = shown.flatMap((row) => (row.kind === "key" && !meta.has(binId(row.entry.key)) && !pendingMeta.current.has(binId(row.entry.key)) ? [row.entry.key] : []));
  const wantedKey = wantedMeta.map(binId).join("\n");
  useEffect(() => {
    if (wantedMeta.length === 0) {
      return;
    }
    const keys = wantedMeta.slice(0, META_MAX);
    const timer = window.setTimeout(() => {
      for (const key of keys) {
        pendingMeta.current.add(binId(key));
      }
      keysMeta(conn, db, keys).then(
        (list) =>
          setMeta((prev) => {
            const next = new Map(prev);
            for (const entry of list) {
              next.set(binId(entry.key), entry);
            }
            return next;
          }),
        () => {
          for (const key of keys) {
            pendingMeta.current.delete(binId(key));
          }
        },
      );
    }, 120);
    return () => window.clearTimeout(timer);
    // The ids stand for the keys.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedKey, conn, db]);

  const selectedId = selected === null ? null : binId(selected);

  // A folder opening or closing: its keys drop in or fade out, the rows below glide.
  const prepareRows = useRowMotion(scrollRef);
  const toggle = (prefix: string) => {
    prepareRows();
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(prefix)) {
        next.add(prefix);
      }
      return next;
    });
  };

  const applyPattern = (text: string) => {
    setFilter(text);
    if (text !== prefs.pattern) {
      onPrefs({ ...prefs, pattern: text });
    }
  };

  const keyMenu = (entry: ScanKey): ContextMenuItem[] => [
    { label: t("열기 [탭]"), onSelect: () => onSelect(entry) },
    { label: t("CLI에서 열기"), onSelect: () => onOpenCli(`TYPE ${consoleArg(entry.key)}`) },
    { label: t("이름 복사"), separatorBefore: true, onSelect: () => void copyText(host, binText(entry.key)) },
    { label: t("JSON으로 내보내기"), onSelect: () => void downloadKey(host, db, entry.key, "json") },
    { label: t("텍스트로 내보내기"), onSelect: () => void downloadKey(host, db, entry.key, "text") },
    { label: t("키 삭제…"), separatorBefore: true, danger: true, disabled: host.readOnly, onSelect: () => void deleteKeys(host, db, [entry.key]) },
  ];

  const folderMenu = (folder: KeyFolder): ContextMenuItem[] => [
    { label: t("이 접두어로 찾기"), onSelect: () => applyPattern(`${folder.prefix}*`) },
    { label: t("이 접두어로 키 만들기…"), disabled: host.readOnly, onSelect: () => onCreate(folder.prefix) },
    { label: t("접두어 복사"), onSelect: () => void copyText(host, folder.prefix) },
    { label: t("CLI에서 SCAN"), onSelect: () => onOpenCli(`SCAN 0 MATCH ${consoleArg(`${folder.prefix}*`)} COUNT 100`) },
  ];

  const activate = (index: number) => {
    const row = rows[index];
    setCursorRow(index);
    if (row?.kind === "key") {
      onSelect(row.entry);
    }
  };

  // Keeps the row at `index` in sight.
  const reveal = (index: number) => {
    const box = scrollRef.current;
    if (box === null) {
      return;
    }
    if (index * ROW < box.scrollTop) {
      box.scrollTop = index * ROW;
    } else if ((index + 1) * ROW > box.scrollTop + box.clientHeight) {
      box.scrollTop = (index + 1) * ROW - box.clientHeight;
    }
  };

  const at = cursorRow >= 0 && cursorRow < rows.length ? cursorRow : rows.findIndex((row) => row.kind === "key" && binId(row.entry.key) === selectedId);

  const renderRow = (row: Row, index: number): ReactElement => {
    const style = { transform: `translateY(${index * ROW}px)`, paddingLeft: 8 + row.depth * 16 };
    if (row.kind === "folder") {
      const isOpen = open.has(row.folder.prefix) || ((pattern !== null || prefs.types.length > 0) && keysRef.current.size <= 300);
      return (
        <div
          key={`f:${row.folder.prefix}`}
          data-row-key={`f:${row.folder.prefix}`}
          aria-level={row.depth + 1}
          className={`kv-row kv-folder${index === at ? " cursor" : ""}`}
          style={style}
          role="treeitem"
          aria-expanded={isOpen}
          title={`${row.folder.prefix}*`}
          onClick={() => {
            setCursorRow(index);
            toggle(row.folder.prefix);
          }}
          onContextMenu={(event) => {
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY, items: folderMenu(row.folder) });
          }}
        >
          <span className={`kv-chevron${isOpen ? " open" : ""}`}>
            <ChevronIcon size={10} />
          </span>
          <FolderIcon size={12} className="kv-folder-icon" />
          <KeyName name={row.folder.name} />
          <span className="kv-count">{row.folder.count.toLocaleString()}</span>
        </div>
      );
    }
    const id = binId(row.entry.key);
    const info = meta.get(id);
    const full = binText(row.entry.key);
    return (
      <div
        key={`k:${id}`}
        data-row-key={`k:${id}`}
        data-row-depth={row.depth + 1}
        className={`kv-row kv-keyrow${id === selectedId ? " selected" : ""}${index === at ? " cursor" : ""}`}
        style={style}
        role={prefs.view === "tree" ? "treeitem" : "option"}
        aria-selected={id === selectedId}
        title={`${full}\n${row.entry.type}`}
        onClick={() => activate(index)}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY, items: keyMenu(row.entry) });
        }}
      >
        {prefs.view === "tree" ? <span className="kv-chevron" /> : null}
        <TypeBadge type={row.entry.type} />
        <KeyName name={row.name} />
        <span className={`kv-ttl${info !== undefined && info.ttl_ms >= 0 ? " live" : ""}`}>{info === undefined ? "" : info.ttl_ms === -2 ? "—" : ttlText(info.ttl_ms)}</span>
        <span className="kv-size">{info === undefined ? "" : sizeText(info.memory)}</span>
      </div>
    );
  };

  const typeLabel = prefs.types.length === 0 ? t("모든 타입") : prefs.types.map((type) => (type === "ReJSON-RL" ? "json" : type)).join(", ");

  return (
    <div className="kv-keys">
      <div className="kv-keys-head">
        <form
          className="kv-search"
          onSubmit={(event) => {
            event.preventDefault();
            applyPattern(filter);
          }}
        >
          <SearchIcon size={11} />
          <input
            value={filter}
            placeholder={t("키 찾기 (user:*)")}
            spellCheck={false}
            title={t("↩로 서버에서 찾습니다 (SCAN MATCH)")}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && filter !== "") {
                event.preventDefault();
                applyPattern("");
              }
            }}
            onBlur={() => applyPattern(filter)}
          />
        </form>
        <button
          type="button"
          className={`kv-tool${prefs.types.length > 0 ? " on" : ""}`}
          title={t("타입으로 거르기: {types}", { types: typeLabel })}
          aria-pressed={prefs.types.length > 0}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            const toggleType = (type: string) => onPrefs({ ...prefs, types: prefs.types.includes(type) ? prefs.types.filter((x) => x !== type) : [...prefs.types, type] });
            setMenu({
              x: rect.left,
              y: rect.bottom + 4,
              anchor: event.currentTarget,
              items: [
                { label: t("모든 타입"), checked: prefs.types.length === 0, onSelect: () => onPrefs({ ...prefs, types: [] }) },
                ...KEY_TYPES.map((type, i) => ({ label: type === "ReJSON-RL" ? "json" : type, checked: prefs.types.includes(type), separatorBefore: i === 0, onSelect: () => toggleType(type) })),
              ],
            });
          }}
        >
          <FilterIcon size={11} />
          {prefs.types.length > 0 ? <span className="kv-tool-count">{prefs.types.length}</span> : null}
        </button>
      </div>
      <div className="kv-keys-bar">
        <div className="kv-seg" role="radiogroup" aria-label={t("보기")}>
          <button type="button" role="radio" aria-checked={prefs.view === "list"} className={prefs.view === "list" ? "active" : undefined} onClick={() => onPrefs({ ...prefs, view: "list" })}>
            {t("목록")}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={prefs.view === "tree"}
            className={prefs.view === "tree" ? "active" : undefined}
            title={prefs.view === "tree" ? t("구분자: {sep} (다시 눌러 바꾸기)", { sep: prefs.delimiter }) : undefined}
            onClick={(event) => {
              if (prefs.view !== "tree") {
                onPrefs({ ...prefs, view: "tree" });
                return;
              }
              const rect = event.currentTarget.getBoundingClientRect();
              setMenu({
                x: rect.left,
                y: rect.bottom + 4,
                anchor: event.currentTarget,
                items: DELIMITERS.map((sep) => ({ label: t("구분자 ‘{sep}’", { sep }), checked: prefs.delimiter === sep, onSelect: () => onPrefs({ ...prefs, delimiter: sep }) })),
              });
            }}
          >
            {t("트리")}
            {prefs.view === "tree" ? <span className="kv-sep-mark">{prefs.delimiter}</span> : null}
          </button>
        </div>
        <span className="spacer" />
        <button type="button" className="kv-tool gauge-host" title={t("다시 훑기")} aria-label={t("다시 훑기")} aria-busy={scanning} onClick={() => setNonce((n) => n + 1)}>
          <Gauge busy={scanning} outcome={error !== null ? "error" : "ok"} />
          <RefreshIcon size={12} />
        </button>
        {!host.readOnly ? (
          <button type="button" className="kv-tool kv-add" title={t("키 만들기…")} aria-label={t("키 만들기…")} onClick={() => onCreate("")}>
            <PlusIcon size={12} />
          </button>
        ) : null}
      </div>
      {prefs.view === "list" ? (
        <div className="kv-keys-cols">
          <span className="kv-col-type">{t("타입")}</span>
          <span className="kv-col-name">{t("이름")}</span>
          <span className="kv-ttl">TTL</span>
          <span className="kv-size">{t("크기")}</span>
        </div>
      ) : null}
      <div
        ref={scrollRef}
        className="kv-keys-scroll"
        tabIndex={0}
        role={prefs.view === "tree" ? "tree" : "listbox"}
        aria-label={t("키")}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const next = Math.max(0, Math.min(rows.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)));
            activate(next);
            reveal(next);
          } else if (event.key === "Enter" || event.key === "ArrowRight" || event.key === "ArrowLeft") {
            const row = rows[at];
            if (row?.kind === "folder") {
              const isOpen = open.has(row.folder.prefix);
              if (event.key === "Enter" || isOpen !== (event.key === "ArrowRight")) {
                event.preventDefault();
                toggle(row.folder.prefix);
              }
            } else if (row?.kind === "key" && event.key === "Enter") {
              event.preventDefault();
              onSelect(row.entry);
            }
          } else if ((event.key === "Delete" || event.key === "Backspace") && !host.readOnly) {
            const row = rows[at];
            if (row?.kind === "key") {
              event.preventDefault();
              void deleteKeys(host, db, [row.entry.key]);
            }
          }
        }}
      >
        {error !== null && rows.length === 0 ? (
          <div className="kv-keys-note">
            <ErrorNotice error={error} context="general" engine="redis" variant="compact" onRetry={() => setNonce((n) => n + 1)} />
          </div>
        ) : !started ? (
          <div className="kv-keys-note panel-dim">{t("키를 불러오는 중…")}</div>
        ) : rows.length === 0 && done ? (
          <div className="kv-keys-note panel-dim">{pattern !== null || prefs.types.length > 0 ? t("조건에 맞는 키가 없습니다") : t("이 데이터베이스에는 키가 없습니다")}</div>
        ) : (
          <div className="kv-keys-canvas" style={{ height: rows.length * ROW }}>
            {shown.map((row, i) => renderRow(row, first + i))}
          </div>
        )}
      </div>
      <div className="kv-keys-foot">
        <span className="kv-foot-text">
          {pattern === null && prefs.types.length === 0
            ? t("{found} / 전체 {total}개 훑음", { found: keysRef.current.size.toLocaleString(), total: total?.toLocaleString() ?? "…" })
            : t("{found}개 찾음 · 전체 {total}개", { found: keysRef.current.size.toLocaleString(), total: total?.toLocaleString() ?? "…" })}
        </span>
        {error !== null && rows.length > 0 ? <span className="kv-foot-error">{t("훑다가 멈췄습니다")}</span> : null}
        <span className="spacer" />
        {done ? (
          <span className="kv-foot-text">{t("끝까지 훑었습니다")}</span>
        ) : scanning ? (
          <button type="button" className="kv-link" onClick={() => scanRef.current?.abort()}>
            {t("멈추기")}
          </button>
        ) : (
          <button type="button" className="kv-link" onClick={() => void scanMore(cursor, Math.max(500, viewRows), false)}>
            {t("더 훑기")}
          </button>
        )}
      </div>
      {menu !== null ? <ContextMenu x={menu.x} y={menu.y} anchor={menu.anchor} items={menu.items} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}
