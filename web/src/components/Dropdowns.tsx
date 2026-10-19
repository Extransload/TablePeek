import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { getLanguage, t } from "../i18n";
import { store, type Favorite, type HistoryEntry } from "../store";
import { Spinner } from "./Spinner";

interface PickSqlProps {
  onPickSql(sql: string): void;
}

interface FavoritesMenuProps extends PickSqlProps {
  getSql(): string;
}

function errorOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatRelative(at: number): string {
  const date = new Date(at * 1000);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  if (diffMs < 60_000) {
    return t("방금 전");
  }
  if (diffMs < 3_600_000) {
    return t("{count}분 전", { count: Math.floor(diffMs / 60_000) });
  }
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (date.getTime() >= startOfToday) {
    return t("{count}시간 전", { count: Math.floor(diffMs / 3_600_000) });
  }
  if (date.getTime() >= startOfToday - 86_400_000) {
    return t("어제");
  }
  return date.toLocaleDateString(getLanguage() === "en" ? "en-US" : "ko-KR");
}

function useMenuDismiss(
  open: boolean,
  rootRef: RefObject<HTMLDivElement | null>,
  onDismiss: () => void,
): void {
  useEffect(() => {
    if (!open) {
      return;
    }
    function onDocumentClick(event: MouseEvent): void {
      const root = rootRef.current;
      if (root && !root.contains(event.target as Node)) {
        onDismiss();
      }
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onDismiss();
      }
    }
    document.addEventListener("click", onDocumentClick);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("click", onDocumentClick);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, rootRef, onDismiss]);
}

export function HistoryMenu({ onPickSql }: PickSqlProps) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<HistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const dismiss = useCallback(() => {
    setOpen(false);
  }, []);

  useMenuDismiss(open, rootRef, dismiss);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const next = await store.fetchHistory(50);
      setItems(next);
    } catch (err) {
      setError(errorOf(err, t("기록을 불러오지 못했습니다")));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void load();
    }
  }, [open, load]);

  async function clearAll(): Promise<void> {
    if (!window.confirm(t("기록을 모두 지울까요?"))) {
      return;
    }
    try {
      await store.clearHistory();
      await load();
    } catch (err) {
      setError(errorOf(err, t("기록을 지우지 못했습니다")));
    }
  }

  return (
    <div className="menu" ref={rootRef}>
      <button type="button" onClick={() => setOpen((value) => !value)}>
        {t("기록")}
      </button>
      {open && (
        <div className="menu-panel">
          <div className="menu-list">
            {error ? (
              <div className="menu-error">{error}</div>
            ) : items === null ? (
              <div className="menu-empty">
                <Spinner size={11} /> {t("불러오는 중…")}
              </div>
            ) : items.length === 0 ? (
              <div className="menu-empty">{t("기록이 없습니다")}</div>
            ) : (
              items.map((entry, index) => (
                <button
                  type="button"
                  className="menu-row"
                  key={`${entry.at}-${index}`}
                  title={entry.sql}
                  onClick={() => {
                    onPickSql(entry.sql);
                    setOpen(false);
                  }}
                >
                  <span className="menu-sql">{entry.sql}</span>
                  <span className="menu-time">{formatRelative(entry.at)}</span>
                </button>
              ))
            )}
          </div>
          <div className="menu-foot">
            <button type="button" disabled={loading} onClick={() => void clearAll()}>
              {t("기록 지우기")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function FavoritesMenu({ onPickSql, getSql }: FavoritesMenuProps) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Favorite[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const dismiss = useCallback(() => {
    setOpen(false);
  }, []);

  useMenuDismiss(open, rootRef, dismiss);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const next = await store.fetchFavorites();
      setItems(next);
    } catch (err) {
      setError(errorOf(err, t("즐겨찾기를 불러오지 못했습니다")));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      void load();
    }
  }, [open, load]);

  const currentSql = open ? getSql().trim() : "";

  async function save(): Promise<void> {
    if (saving) {
      return;
    }
    const trimmed = name.trim();
    if (trimmed === "") {
      setError(t("이름을 입력하세요"));
      return;
    }
    const sql = getSql().trim();
    if (sql === "") {
      setError(t("저장할 SQL이 없습니다"));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await store.createFavorite(trimmed, sql, keyword.trim() === "" ? undefined : keyword.trim());
      setName("");
      setKeyword("");
      await load();
      window.dispatchEvent(new Event("wrendb:favorites-changed"));
    } catch (err) {
      setError(errorOf(err, t("즐겨찾기를 저장하지 못했습니다")));
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      await store.deleteFavorite(id);
      await load();
      window.dispatchEvent(new Event("wrendb:favorites-changed"));
    } catch (err) {
      setError(errorOf(err, t("즐겨찾기를 삭제하지 못했습니다")));
    }
  }

  return (
    <div className="menu" ref={rootRef}>
      <button type="button" onClick={() => setOpen((value) => !value)}>
        {t("즐겨찾기")}
      </button>
      {open && (
        <div className="menu-panel">
          <div className="menu-head">
            <input
              className="menu-input"
              placeholder={t("이름")}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <input
              className="menu-input keyword-input"
              placeholder={t("키워드 (자동완성)")}
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
            />
            <button type="button" disabled={saving || currentSql === ""} onClick={() => void save()}>
              {t("현재 SQL 저장")}
            </button>
          </div>
          {error ? <div className="menu-error">{error}</div> : null}
          <div className="menu-list">
            {loading && items === null ? (
              <div className="menu-empty">
                <Spinner size={11} /> {t("불러오는 중…")}
              </div>
            ) : items === null || items.length === 0 ? (
              error ? null : <div className="menu-empty">{t("즐겨찾기가 없습니다")}</div>
            ) : (
              items.map((favorite) => (
                <div className="menu-row-wrap" key={favorite.id}>
                  <button
                    type="button"
                    className="menu-row col"
                    title={favorite.sql}
                    onClick={() => {
                      onPickSql(favorite.sql);
                      setOpen(false);
                    }}
                  >
                    <span className="menu-name">
                      {favorite.name}
                      {favorite.keyword ? (
                        <span className="menu-keyword">{`:${favorite.keyword}`}</span>
                      ) : null}
                    </span>
                    <span className="menu-sql dim">{favorite.sql}</span>
                  </button>
                  <button type="button" className="menu-del" onClick={() => void remove(favorite.id)}>
                    {t("삭제")}
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
