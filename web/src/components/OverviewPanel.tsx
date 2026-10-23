import { useCallback, useEffect, useMemo, useState } from "react";
import { formatBytes, formatRowEstimate } from "../format";
import { t } from "../i18n";
import { store, type EngineMeta, type TableDetail, type TableSchema } from "../store";
import { ErrorNotice } from "./ErrorNotice";
import { RefreshIcon, SearchIcon } from "./icons";
import { LoadingState, Spinner } from "./Spinner";

interface OverviewPanelProps {
  conn: string;
  meta: EngineMeta;
  refreshKey: string;
  onOpenData(table: string): void;
  onOpenStructure(table: string): void;
}

interface OverviewRow {
  name: string;
  columns: number | null;
  rows: number | null;
  rowsExact: boolean;
  size: number | null;
}

const DETAIL_LIMIT = 200;
const CONCURRENCY = 4;

function errorOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

async function mapLimited<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export function OverviewPanel({
  conn,
  meta,
  refreshKey,
  onOpenData,
  onOpenStructure,
}: OverviewPanelProps) {
  const [schemas, setSchemas] = useState<TableSchema[] | null>(null);
  const [details, setDetails] = useState<Map<string, TableDetail>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [nonce, setNonce] = useState(0);

  const exactRows = meta.kind === "sqlite";

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    setDetails(new Map());
    try {
      const schema = await store.fetchSchema(conn);
      setSchemas(schema);
      const names = schema.map((entry) => entry.name).slice(0, DETAIL_LIMIT);
      const fetched = await mapLimited(names, CONCURRENCY, async (name) => {
        try {
          return await store.fetchTableDetail(conn, name);
        } catch {
          return null;
        }
      });
      const next = new Map<string, TableDetail>();
      for (const detail of fetched) {
        if (detail !== null) {
          next.set(detail.name, detail);
        }
      }
      setDetails(next);
    } catch (err) {
      setError(errorOf(err, t("테이블 목록을 불러오지 못했습니다")));
    } finally {
      setLoading(false);
    }
  }, [conn]);

  useEffect(() => {
    void load();
  }, [load, refreshKey, nonce]);

  const rows = useMemo<OverviewRow[]>(() => {
    if (schemas === null) {
      return [];
    }
    const query = search.trim().toLowerCase();
    return schemas
      .map((entry) => {
        const detail = details.get(entry.name);
        return {
          name: entry.name,
          columns: entry.columns.length,
          rows: detail?.row_count_estimate ?? null,
          rowsExact: exactRows,
          size: detail?.size_bytes ?? null,
        };
      })
      .filter((row) => query === "" || row.name.toLowerCase().includes(query))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [schemas, details, search, exactRows]);

  const totalColumns = useMemo(
    () => rows.reduce((sum, row) => sum + (row.columns ?? 0), 0),
    [rows],
  );

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">{t("테이블 개요")}</span>
        <span className="panel-stat">
          {t("테이블 {count}개", { count: schemas === null ? "…" : schemas.length })}
        </span>
        <span className="panel-stat">{t("컬럼 {count}개", { count: totalColumns })}</span>
        <span className="spacer" />
        {/* A refresh of what's shown; a first load shows in the body. */}
        {loading && schemas !== null ? (
          <span className="panel-dim delayed-in">
            <Spinner size={10} /> {t("불러오는 중…")}
          </span>
        ) : null}
        <button
          type="button"
          className="icon-text-button"
          disabled={loading}
          onClick={() => setNonce((value) => value + 1)}
          title={t("개요 새로고침")}
        >
          <RefreshIcon size={11} />
          {t("새로고침")}
        </button>
      </div>
      <div className="schema-search overview-search">
        <SearchIcon size={11} className="schema-search-icon" />
        <input
          value={search}
          placeholder={t("테이블 이름 검색")}
          spellCheck={false}
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>
      <div className="panel-body">
        {error ? <ErrorNotice message={error} /> : null}
        {schemas === null ? (
          error ? null : <LoadingState />
        ) : rows.length === 0 ? (
          <div className="panel-empty-inline">
            {search.trim() === "" ? t("테이블이 없습니다") : t("검색 결과가 없습니다")}
          </div>
        ) : (
          <table className="panel-table overview-table">
            <thead>
              <tr>
                <th>{t("이름")}</th>
                <th>{t("컬럼")}</th>
                <th>{t("행 수")}</th>
                <th>{t("크기")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.name}>
                  <td>
                    <button
                      type="button"
                      className="link-button mono"
                      title={t("데이터 열기")}
                      onClick={() => onOpenData(row.name)}
                      onDoubleClick={(event) => {
                        event.preventDefault();
                        onOpenStructure(row.name);
                      }}
                    >
                      {row.name}
                    </button>
                  </td>
                  <td className="dim">{row.columns === null ? "" : row.columns}</td>
                  <td className="dim">
                    {row.rows === null
                      ? loading
                        ? "…"
                        : ""
                      : formatRowEstimate(row.rows, row.rowsExact)}
                  </td>
                  <td className="dim">{row.size === null ? "" : formatBytes(row.size)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {schemas !== null && schemas.length > DETAIL_LIMIT ? (
          <div className="panel-empty-inline">
            {t("행 수·크기는 상위 {count}개 테이블만 표시합니다", { count: DETAIL_LIMIT })}
          </div>
        ) : null}
      </div>
    </div>
  );
}
