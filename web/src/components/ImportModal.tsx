import { useEffect, useMemo, useState } from "react";
import { escapeSqlIdentifier, sqlLiteral } from "../export";
import { parseCsv, parseJsonImport, detectDelimiter } from "../importParse";
import { startJob } from "../jobs";
import { getSettings } from "../settings";
import { store } from "../store";
import { quoteIdent } from "../ddl";
import { ErrorNotice } from "./ErrorNotice";
import { FolderIcon } from "./icons";

interface ImportModalProps {
  conn: string;
  kind: string;
  table: string;
  onClose(): void;
}

interface Mapping {
  include: boolean;
  source: number | null;
}

const CHUNK_ROWS = 200;
const PREVIEW_ROWS = 5;

function errorOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function matchSource(sources: string[], target: string): number | null {
  const lower = target.toLowerCase();
  const exact = sources.findIndex((source) => source.toLowerCase() === lower);
  return exact >= 0 ? exact : null;
}

export function ImportModal({ conn, kind, table, onClose }: ImportModalProps) {
  const [targetColumns, setTargetColumns] = useState<string[] | null>(null);
  const [fileName, setFileName] = useState("");
  const [encoding, setEncoding] = useState(() => getSettings().csvEncoding);
  const [header, setHeader] = useState(() => getSettings().csvHeader);
  const [delimiter, setDelimiter] = useState("auto");
  const [emptyAsNull, setEmptyAsNull] = useState(true);
  const [sources, setSources] = useState<string[]>([]);
  const [rows, setRows] = useState<unknown[][]>([]);
  const [mapping, setMapping] = useState<Record<string, Mapping>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const detail = await store.fetchTableDetail(conn, table);
        if (!cancelled) {
          setTargetColumns(detail.columns.map((column) => column.name));
        }
      } catch (err) {
        if (!cancelled) {
          setError(errorOf(err, "테이블 구조를 불러오지 못했습니다"));
          setTargetColumns([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conn, table]);

  function applyParsed(columns: string[], nextRows: unknown[][], resetMapping: boolean): void {
    setSources(columns);
    setRows(nextRows);
    setInfo(`${nextRows.length.toLocaleString()}행을 읽었습니다`);
    if (targetColumns !== null) {
      setMapping((prev) => {
        const next: Record<string, Mapping> = {};
        for (const target of targetColumns) {
          const existing = prev[target];
          next[target] =
            !resetMapping && existing !== undefined
              ? existing
              : { include: true, source: matchSource(columns, target) };
        }
        return next;
      });
    }
  }

  async function pickFile(file: File): Promise<void> {
    setError(null);
    setInfo(null);
    setFileName(file.name);
    try {
      const buffer = await file.arrayBuffer();
      let text: string;
      try {
        text = new TextDecoder(encoding).decode(buffer);
      } catch {
        text = new TextDecoder("utf-8").decode(buffer);
      }
      const isJson = file.name.toLowerCase().endsWith(".json") || text.trimStart().startsWith("[") || text.trimStart().startsWith("{");
      if (isJson) {
        const parsed = parseJsonImport(text);
        applyParsed(parsed.columns, parsed.rows, true);
      } else {
        const usedDelimiter =
          delimiter === "auto" ? detectDelimiter(text) : delimiter === "tab" ? "\t" : delimiter;
        const parsed = parseCsv(text, usedDelimiter, header);
        applyParsed(parsed.columns, parsed.rows, true);
      }
    } catch (err) {
      setError(errorOf(err, "파일을 해석하지 못했습니다"));
    }
  }

  useEffect(() => {
    if (targetColumns === null || sources.length === 0) {
      return;
    }
    setMapping((prev) => {
      if (Object.keys(prev).length > 0) {
        return prev;
      }
      const next: Record<string, Mapping> = {};
      for (const target of targetColumns) {
        next[target] = { include: true, source: matchSource(sources, target) };
      }
      return next;
    });
  }, [targetColumns, sources]);

  const included = useMemo(
    () =>
      (targetColumns ?? []).filter(
        (target) => (mapping[target]?.include ?? false) && mapping[target]?.source !== null,
      ),
    [targetColumns, mapping],
  );

  async function run(): Promise<void> {
    if (included.length === 0 || rows.length === 0 || busy) {
      return;
    }
    const job = startJob(`가져오기: ${table}`, fileName, rows.length);
    setBusy(true);
    setError(null);
    try {
      const columnSql = included.map((target) => escapeSqlIdentifier(target, kind)).join(", ");
      const head = `INSERT INTO ${quoteIdent(kind, table)} (${columnSql}) VALUES`;
      let done = 0;
      for (let start = 0; start < rows.length; start += CHUNK_ROWS) {
        const end = Math.min(rows.length, start + CHUNK_ROWS);
        const values: string[] = [];
        for (let r = start; r < end; r += 1) {
          const row = rows[r];
          const cells = included.map((target) => {
            const source = mapping[target]?.source;
            let value = source === null || source === undefined ? null : row[source];
            if (value === "" && emptyAsNull) {
              value = null;
            }
            return sqlLiteral(value);
          });
          values.push(`(${cells.join(", ")})`);
        }
        await store.exec(conn, `${head}\n${values.join(",\n")};`);
        done = end;
        job.update(done);
      }
      job.finish();
      store.setInfo(`가져오기 완료: ${table}에 ${rows.length.toLocaleString()}행`);
    } catch (err) {
      const message = errorOf(err, "가져오기에 실패했습니다");
      job.fail(message);
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  function includeAll(value: boolean): void {
    setMapping((prev) => {
      const next: Record<string, Mapping> = {};
      for (const [target, entry] of Object.entries(prev)) {
        next[target] = { ...entry, include: value && entry.source !== null };
      }
      return next;
    });
  }

  return (
    <div className="modal-backdrop" onClick={() => (busy ? undefined : onClose())}>
      <div className="modal import-modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title">데이터 가져오기</span>
          <span className="modal-path">{`${table} · ${kind}`}</span>
          <span className="spacer" />
          {info ? <span className="dim">{info}</span> : null}
        </div>
        <div className="modal-body import-body">
          {error ? <ErrorNotice message={error} /> : null}
          <section className="export-section">
            <div className="section-title">파일</div>
            <div className="create-inline">
              <label className="file-button">
                <FolderIcon size={12} />
                파일 선택
                <input
                  type="file"
                  accept=".csv,.tsv,.txt,.json"
                  disabled={busy}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) {
                      void pickFile(file);
                    }
                  }}
                />
              </label>
              {fileName ? <span className="dim">{fileName}</span> : null}
              <label className="field">
                <span>인코딩</span>
                <select
                  value={encoding}
                  onChange={(event) =>
                    setEncoding(event.target.value as "utf-8" | "euc-kr" | "utf-16le")
                  }
                >
                  <option value="utf-8">UTF-8</option>
                  <option value="euc-kr">EUC-KR</option>
                  <option value="utf-16le">UTF-16LE</option>
                </select>
              </label>
              <label className="field">
                <span>구분자</span>
                <select
                  value={delimiter}
                  onChange={(event) => setDelimiter(event.target.value)}
                >
                  <option value="auto">자동</option>
                  <option value=",">쉼표</option>
                  <option value="tab">탭</option>
                  <option value=";">세미콜론</option>
                </select>
              </label>
              <label className="check-row inline">
                <input
                  type="checkbox"
                  checked={header}
                  onChange={(event) => setHeader(event.target.checked)}
                />
                <span>첫 줄이 헤더</span>
              </label>
              <label className="check-row inline">
                <input
                  type="checkbox"
                  checked={emptyAsNull}
                  onChange={(event) => setEmptyAsNull(event.target.checked)}
                />
                <span>빈 문자열 → NULL</span>
              </label>
            </div>
          </section>
          {sources.length > 0 && targetColumns !== null ? (
            <section className="export-section">
              <div className="section-title">
                컬럼 매핑
                <span className="panel-count">
                  {`${included.length} / ${targetColumns.length}`}
                </span>
                <span className="spacer" />
                <button type="button" className="link-button" onClick={() => includeAll(true)}>
                  모두 포함
                </button>
                <button type="button" className="link-button" onClick={() => includeAll(false)}>
                  모두 제외
                </button>
              </div>
              <div className="import-map">
                {targetColumns.map((target) => {
                  const entry = mapping[target] ?? { include: false, source: null };
                  return (
                    <div className="import-map-row" key={target}>
                      <label className="check-row inline">
                        <input
                          type="checkbox"
                          checked={entry.include}
                          onChange={(event) =>
                            setMapping((prev) => ({
                              ...prev,
                              [target]: { ...entry, include: event.target.checked },
                            }))
                          }
                        />
                        <span className="mono">{target}</span>
                      </label>
                      <select
                        value={entry.source === null ? "" : String(entry.source)}
                        onChange={(event) =>
                          setMapping((prev) => ({
                            ...prev,
                            [target]: {
                              ...entry,
                              source: event.target.value === "" ? null : Number(event.target.value),
                            },
                          }))
                        }
                      >
                        <option value="">(건너뜀)</option>
                        {sources.map((source, index) => (
                          <option value={String(index)} key={`${source}:${index}`}>
                            {source}
                          </option>
                        ))}
                      </select>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}
          {rows.length > 0 ? (
            <section className="export-section">
              <div className="section-title">미리보기</div>
              <div className="import-preview">
                <table className="panel-table">
                  <thead>
                    <tr>
                      {included.map((target) => (
                        <th key={target}>{target}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, PREVIEW_ROWS).map((row, r) => (
                      <tr key={r}>
                        {included.map((target) => {
                          const source = mapping[target]?.source;
                          const value = source === null || source === undefined ? null : row[source];
                          return (
                            <td className="mono dim" key={target}>
                              {value === null ? "" : String(value)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
        </div>
        <div className="modal-foot">
          <span className="spacer" />
          <button type="button" disabled={busy} onClick={onClose}>
            닫기
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || included.length === 0 || rows.length === 0}
            onClick={() => void run()}
          >
            {`가져오기 (${rows.length.toLocaleString()}행)`}
          </button>
        </div>
      </div>
    </div>
  );
}
