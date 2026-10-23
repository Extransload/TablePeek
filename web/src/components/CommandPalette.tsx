import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { ErrorNotice } from "./ErrorNotice";
import { LoadingState } from "./Spinner";

export interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  sourceId?: string;
  run?(): void;
}

export interface PaletteEntry {
  label: string;
  hint?: string;
  run(): void;
}

export interface PaletteSource {
  id: string;
  title: string;
  load(): Promise<PaletteEntry[]>;
}

interface CommandPaletteProps {
  actions: PaletteAction[];
  sources: PaletteSource[];
  onClose(): void;
}

interface PaletteItem {
  key: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  run?(): void;
}

function errorOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function CommandPalette({ actions, sources, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [entries, setEntries] = useState<PaletteEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  const source = sourceId === null ? null : (sources.find((item) => item.id === sourceId) ?? null);

  useEffect(() => {
    if (sourceId === null) {
      return;
    }
    let cancelled = false;
    setEntries(null);
    setError(null);
    setQuery("");
    setIndex(0);
    const target = sourcesRef.current.find((item) => item.id === sourceId);
    if (!target) {
      setEntries([]);
      return;
    }
    void (async () => {
      try {
        const list = await target.load();
        if (!cancelled) {
          setEntries(list);
        }
      } catch (err) {
        if (!cancelled) {
          setError(errorOf(err, t("불러오지 못했습니다")));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sourceId]);

  function activateAction(action: PaletteAction): void {
    if (action.sourceId !== undefined) {
      setSourceId(action.sourceId);
      return;
    }
    action.run?.();
    onClose();
  }

  const queryText = query.trim().toLowerCase();
  const items: PaletteItem[] =
    sourceId === null
      ? actions
          .filter((action) => queryText === "" || action.label.toLowerCase().includes(queryText))
          .map((action) => ({
            key: action.id,
            label: action.label,
            hint: action.hint,
            disabled: action.disabled,
            run: () => activateAction(action),
          }))
      : (entries ?? [])
          .filter((entry) => queryText === "" || entry.label.toLowerCase().includes(queryText))
          .map((entry, position) => ({
            key: `${position}-${entry.label}`,
            label: entry.label,
            hint: entry.hint,
            run: () => {
              entry.run();
              onClose();
            },
          }));

  const active = Math.min(index, Math.max(0, items.length - 1));
  const loading = sourceId !== null && entries === null && error === null;

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex((value) => Math.min(value + 1, Math.max(0, items.length - 1)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((value) => Math.max(0, value - 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const item = items[active];
      if (item && !item.disabled) {
        item.run?.();
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "Backspace" && query === "" && sourceId !== null) {
      event.preventDefault();
      setSourceId(null);
      setIndex(0);
    }
  }

  return (
    <div
      className="palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="palette" role="dialog" aria-label={t("커맨드 팔레트")}>
        <div className="palette-head">
          {source === null ? (
            <span className="palette-mode">{t("명령")}</span>
          ) : (
            <button
              type="button"
              className="palette-back"
              title={t("뒤로 (Esc는 닫기)")}
              onClick={() => {
                setSourceId(null);
                setIndex(0);
              }}
            >
              ←
            </button>
          )}
          <input
            autoFocus
            className="palette-input"
            value={query}
            spellCheck={false}
            placeholder={source === null ? t("명령 검색") : t("{name} 검색", { name: source.title })}
            onChange={(event) => {
              setQuery(event.target.value);
              setIndex(0);
            }}
            onKeyDown={onKeyDown}
          />
          {source !== null ? <span className="palette-mode">{source.title}</span> : null}
        </div>
        <div className="palette-list">
          {error ? (
            <div className="palette-error-slot">
              <ErrorNotice message={error} variant="compact" />
            </div>
          ) : loading ? (
            <LoadingState variant="compact" />
          ) : items.length === 0 ? (
            <div className="palette-empty">{t("결과가 없습니다")}</div>
          ) : (
            items.map((item, position) => (
              <button
                type="button"
                key={item.key}
                ref={(element) => {
                  if (position === active && element) {
                    element.scrollIntoView({ block: "nearest" });
                  }
                }}
                className={`palette-item${position === active ? " active" : ""}`}
                disabled={item.disabled}
                onMouseEnter={() => setIndex(position)}
                onClick={() => item.run?.()}
              >
                <span className="palette-label">{item.label}</span>
                {item.hint ? <span className="palette-hint">{item.hint}</span> : null}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
