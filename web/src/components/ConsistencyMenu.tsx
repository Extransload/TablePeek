import { useCallback, useEffect, useRef, useState } from "react";
import { notifyError } from "./ErrorNotice";
import { toAppError } from "../errorHelp";
import { t } from "../i18n";
import { store } from "../store";
import { CheckIcon, ChevronDownIcon } from "./icons";
import { useMenuDismiss } from "./useMenuDismiss";

interface ConsistencyMenuProps {
  conn: string;
  // The levels the engine takes (SqlDialect.consistencyLevels).
  levels: readonly string[];
}

// The consistency level a CQL connection's statements run at, as cqlsh's
// CONSISTENCY sets it: read from the server when the connection comes to
// the front, changed for this connection only. A statement in the editor
// can still set its own with CONSISTENCY <level>.
export function ConsistencyMenu({ conn, levels }: ConsistencyMenuProps) {
  const [open, setOpen] = useState(false);
  const [level, setLevel] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dismiss = useCallback(() => setOpen(false), []);
  useMenuDismiss(open, rootRef, dismiss);

  const run = useCallback(
    async (statement: string): Promise<void> => {
      try {
        const result = await store.exec(conn, statement);
        const shown = result.rows[0]?.[0];
        setLevel(typeof shown === "string" ? shown : null);
      } catch (error) {
        notifyError(toAppError(error, t("일관성 수준을 바꾸지 못했습니다")));
      }
    },
    [conn],
  );

  useEffect(() => {
    void run("CONSISTENCY");
  }, [run]);

  return (
    <div className="safe-mode" ref={rootRef}>
      <button
        type="button"
        className={`safe-mode-button consistency-button${open ? " open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={t("일관성 수준 (CONSISTENCY): 이 연결의 문장이 몇 개의 복제본 응답을 기다릴지")}
      >
        <span>{level ?? "…"}</span>
        <ChevronDownIcon size={9} />
      </button>
      {open ? (
        <div className="menu-panel safe-mode-panel" role="menu" aria-label={t("일관성 수준")}>
          <div className="safe-mode-heading">
            {t("일관성 수준")}
            <span className="safe-mode-scope">{t("이 연결에만 적용")}</span>
          </div>
          {levels.map((name) => (
            <button
              key={name}
              type="button"
              role="menuitemradio"
              aria-checked={level === name}
              className={`safe-mode-option${level === name ? " active" : ""}`}
              onClick={() => {
                setOpen(false);
                void run(`CONSISTENCY ${name}`);
              }}
            >
              <span className="safe-mode-option-text">
                <span className="safe-mode-option-title mono">{name}</span>
              </span>
              {level === name ? <CheckIcon size={11} className="safe-mode-option-check" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
