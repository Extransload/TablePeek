import { useEffect, useRef, useState } from "react";
import { writeClipboard } from "../clipboard";
import { store, type DefinitionDetail } from "../store";
import { DEFINITION_KIND_LABELS, type DefinitionKind } from "../sqlTools";
import type { DefinitionTab } from "../tabs";
import { ErrorNotice } from "./ErrorNotice";
import { CopyIcon, RefreshIcon } from "./icons";
import { Spinner } from "./Spinner";

interface DefinitionPanelProps {
  conn: string;
  tab: DefinitionTab;
  onDetail(detail: DefinitionDetail): void;
}

function errorOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function DefinitionPanel({ conn, tab, onDetail }: DefinitionPanelProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const onDetailRef = useRef(onDetail);
  onDetailRef.current = onDetail;

  useEffect(() => {
    if (nonce === 0 && tab.definition !== undefined) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const detail = await store.fetchDefinition(conn, tab.obj, tab.name);
        if (!cancelled) {
          onDetailRef.current(detail);
        }
      } catch (err) {
        if (!cancelled) {
          setError(errorOf(err, "정의를 가져오지 못했습니다"));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [conn, tab.obj, tab.name, nonce]);

  const detail = tab.definition ?? null;
  const label = DEFINITION_KIND_LABELS[tab.obj as DefinitionKind] ?? tab.obj;

  function copyDdl(ddl: string): void {
    void writeClipboard(ddl, (message) => store.setError(message));
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <span className="panel-title">{tab.name}</span>
        <span className="badge-kind">{label}</span>
        <span className="spacer" />
        {loading ? (
              <span className="panel-dim">
                <Spinner size={10} /> 불러오는 중…
              </span>
            ) : null}
        <button
          type="button"
          className="icon-text-button"
          disabled={loading}
          onClick={() => setNonce((value) => value + 1)}
          title="정의 새로고침"
        >
          <RefreshIcon size={11} />
          새로고침
        </button>
      </div>
      <div className="panel-body">
        {error ? <ErrorNotice message={error} /> : null}
        {detail === null ? (
          error ? null : <div className="panel-empty">불러오는 중…</div>
        ) : detail.ddl === null ? (
          <div className="panel-empty-inline">정의를 가져올 수 없습니다</div>
        ) : (
          <div className="panel-code">
            <div className="panel-code-head">
              <span className="dim">{label} DDL</span>
              <span className="spacer" />
              <button
                type="button"
                className="icon-text-button"
                onClick={() => copyDdl(detail.ddl ?? "")}
                title="DDL 복사"
              >
                <CopyIcon size={11} />
                복사
              </button>
            </div>
            <pre className="panel-pre">{detail.ddl}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
