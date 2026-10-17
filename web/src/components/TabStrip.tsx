import { useEffect, useRef, useState } from "react";
import type { WorkbenchTab } from "../tabs";
import { CloseIcon, TableIcon } from "./icons";

interface TabStripProps {
  tabs: WorkbenchTab[];
  activeId: string;
  runningTabId: string | null;
  onActivate(id: string): void;
  onClose(id: string): void;
  onRename(id: string, title: string): void;
}

export function TabStrip({
  tabs,
  activeId,
  runningTabId,
  onActivate,
  onClose,
  onRename,
}: TabStripProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cancelledRef = useRef(false);

  useEffect(() => {
    if (renamingId !== null) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [renamingId]);

  useEffect(() => {
    if (renamingId !== null && !tabs.some((tab) => tab.id === renamingId)) {
      setRenamingId(null);
    }
  }, [tabs, renamingId]);

  function startRename(tab: WorkbenchTab): void {
    cancelledRef.current = false;
    setRenamingId(tab.id);
    setDraft(tab.title);
  }

  function commitRename(): void {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      setRenamingId(null);
      return;
    }
    if (renamingId !== null) {
      onRename(renamingId, draft);
    }
    setRenamingId(null);
  }

  return (
    <div className="tab-strip" role="tablist">
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        const renaming = tab.id === renamingId;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            className={`tab${active ? " active" : ""}${tab.error ? " has-error" : ""}`}
            title={tab.title}
            onClick={() => onActivate(tab.id)}
            onDoubleClick={() => startRename(tab)}
            onAuxClick={(event) => {
              if (event.button === 1) {
                event.preventDefault();
                onClose(tab.id);
              }
            }}
          >
            {tab.id === runningTabId && <span className="tab-running" aria-hidden="true" />}
            {tab.kind === "data" ? <TableIcon size={10} className="tab-kind" /> : null}
            {renaming ? (
              <input
                ref={inputRef}
                className="tab-rename"
                value={draft}
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commitRename}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitRename();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    cancelledRef.current = true;
                    setRenamingId(null);
                  }
                }}
              />
            ) : (
              <span className="tab-label">{tab.title}</span>
            )}
            <button
              type="button"
              className="tab-close"
              title="탭 닫기 (⌘W)"
              onDoubleClick={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onClose(tab.id);
              }}
            >
              <CloseIcon size={10} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
