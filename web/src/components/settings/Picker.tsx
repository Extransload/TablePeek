import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { t } from "../../i18n";
import { CheckIcon, CloseIcon, SearchIcon } from "../icons";
import { Highlight } from "./rows";

// A searchable list opened from a settings row's button (a theme, a font):
// typing filters it, ↑↓ move, ⏎ picks, Esc or Tab close, and a click
// anywhere else closes it. Actions (importing a theme file) follow the
// items; ⌘⌫ removes an item that can be removed.

export interface PickerItem {
  // The value picked.
  value: string;
  label: string;
  // Items of a group follow one another under its name.
  group?: string;
  swatch?: ReactNode;
  selected?: boolean;
  onRemove?(): void;
}

export interface PickerAction {
  label: string;
  run(): void;
}

const EDGE = 6;
const GAP = 4;
const WIDTH = 300;
const MAX_HEIGHT = 380;
const PAGE = 10;

type Entry = { kind: "item"; item: PickerItem } | { kind: "action"; action: PickerAction };

export function Picker({
  anchor,
  label,
  items,
  actions = [],
  note,
  onPick,
  onClose,
}: {
  anchor: HTMLElement;
  label: string;
  items: PickerItem[];
  actions?: PickerAction[];
  // A line under the list (themes still loading).
  note?: string | null;
  onPick(value: string): void;
  // Whether the keys go back to the row's button: not after a click elsewhere.
  onClose(refocus: boolean): void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const close = useRef(onClose);
  close.current = onClose;
  const [query, setQuery] = useState("");
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const entries = useMemo<Entry[]>(() => {
    const found = items.filter((item) => {
      const text = `${item.label} ${item.group ?? ""}`.toLowerCase();
      return terms.every((term) => text.includes(term));
    });
    return [
      ...found.map((item): Entry => ({ kind: "item", item })),
      ...actions.map((action): Entry => ({ kind: "action", action })),
    ];
    // `terms` is made from `query`.
  }, [items, actions, query]);
  const [active, setActive] = useState(() => Math.max(0, items.findIndex((item) => item.selected)));
  const current = Math.min(active, entries.length - 1);

  // Under the button, its right edges lined up, or above it when there is
  // more room there.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (box === null) {
      return;
    }
    const place = () => {
      const field = anchor.getBoundingClientRect();
      const below = window.innerHeight - field.bottom - GAP - EDGE;
      const above = field.top - GAP - EDGE;
      const upward = below < 220 && above > below;
      box.style.maxHeight = `${Math.max(160, Math.min(MAX_HEIGHT, upward ? above : below))}px`;
      box.style.left = `${Math.max(EDGE, Math.min(field.right - WIDTH, window.innerWidth - WIDTH - EDGE))}px`;
      box.style.top = upward ? "" : `${field.bottom + GAP}px`;
      box.style.bottom = upward ? `${window.innerHeight - field.top + GAP}px` : "";
    };
    place();
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!box.contains(target) && !anchor.contains(target)) {
        close.current(false);
      }
    };
    document.addEventListener("pointerdown", outside, true);
    // The settings scrolled under it: it would stay behind.
    document.addEventListener("scroll", outside, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("scroll", outside, true);
      window.removeEventListener("resize", place);
    };
  }, [anchor]);

  // The highlighted entry stays in sight: centred when the list opens.
  const opened = useRef(false);
  useLayoutEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`[data-index="${current}"]`);
    if (list && row) {
      const top = row.offsetTop;
      const bottom = top + row.offsetHeight;
      if (!opened.current) {
        list.scrollTop = top - (list.clientHeight - row.offsetHeight) / 2;
      } else if (top < list.scrollTop) {
        list.scrollTop = top;
      } else if (bottom > list.scrollTop + list.clientHeight) {
        list.scrollTop = bottom - list.clientHeight;
      }
    }
    opened.current = true;
  }, [current]);

  function choose(entry: Entry | undefined): void {
    if (entry?.kind === "item") {
      onPick(entry.item.value);
    } else if (entry?.kind === "action") {
      entry.action.run();
    }
  }

  function onKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing) {
      return;
    }
    const last = entries.length - 1;
    switch (event.key) {
      case "Escape":
        onClose(true);
        break;
      case "Tab":
        onClose(true);
        break;
      case "Enter":
        choose(entries[current]);
        break;
      case "ArrowDown":
        setActive(Math.min(last, current + 1));
        break;
      case "ArrowUp":
        setActive(Math.max(0, current - 1));
        break;
      case "PageDown":
        setActive(Math.min(last, current + PAGE));
        break;
      case "PageUp":
        setActive(Math.max(0, current - PAGE));
        break;
      case "Backspace": {
        const entry = entries[current];
        if (!(event.metaKey || event.ctrlKey) || entry?.kind !== "item" || entry.item.onRemove === undefined) {
          return;
        }
        entry.item.onRemove();
        break;
      }
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  let group: string | undefined;
  return createPortal(
    <div
      ref={boxRef}
      className="context-menu settings-picker"
      role="dialog"
      aria-label={label}
      style={{ width: WIDTH }}
      // It sits outside the sheet: its keys and focus stay its own.
      onKeyDown={(event) => event.stopPropagation()}
      onFocus={(event) => event.stopPropagation()}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (next instanceof Node && !event.currentTarget.contains(next) && !anchor.contains(next)) {
          onClose(false);
        }
      }}
    >
      <label className="settings-picker-search">
        <SearchIcon size={11} />
        <input
          type="text"
          value={query}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          placeholder={t("검색")}
          aria-label={label}
          aria-controls={listId}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
      </label>
      <div
        ref={listRef}
        className="settings-picker-list"
        role="listbox"
        id={listId}
        // The field keeps the keys while an entry is clicked.
        onMouseDown={(event) => event.preventDefault()}
      >
        {entries.map((entry, index) => {
          const heading = entry.kind === "item" && entry.item.group !== group ? entry.item.group : undefined;
          group = entry.kind === "item" ? entry.item.group : undefined;
          const first = entry.kind === "action" && entries[index - 1]?.kind !== "action";
          return [
            heading ? (
              <div key={`group:${heading}`} className="select-group" role="presentation">
                {heading}
              </div>
            ) : null,
            first ? <div key="actions" className="context-sep" role="presentation" /> : null,
            <div
              key={entry.kind === "item" ? `item:${entry.item.value}` : `action:${entry.action.label}`}
              role="option"
              data-index={index}
              aria-selected={entry.kind === "item" && entry.item.selected === true}
              className={`context-item settings-picker-item${index === current ? " active" : ""}${
                entry.kind === "action" ? " action" : ""
              }`}
              onMouseMove={() => index !== current && setActive(index)}
              onClick={() => choose(entry)}
            >
              {entry.kind === "item" ? (
                <>
                  <span className="context-check" aria-hidden="true">
                    {entry.item.selected ? <CheckIcon size={9} /> : null}
                  </span>
                  {entry.item.swatch}
                  <span className="context-label">
                    <Highlight text={entry.item.label} terms={terms} />
                  </span>
                  {entry.item.onRemove ? (
                    <button
                      type="button"
                      className="icon-button settings-picker-remove"
                      title={t("지우기")}
                      aria-label={t("지우기")}
                      tabIndex={-1}
                      onClick={(event) => {
                        event.stopPropagation();
                        entry.item.onRemove?.();
                      }}
                    >
                      <CloseIcon size={9} />
                    </button>
                  ) : null}
                </>
              ) : (
                <span className="context-label">{entry.action.label}</span>
              )}
            </div>,
          ];
        })}
        {entries.every((entry) => entry.kind === "action") && query !== "" ? (
          <p className="settings-picker-empty">{t("맞는 항목이 없습니다")}</p>
        ) : null}
      </div>
      {note ? <p className="settings-picker-note">{note}</p> : null}
    </div>,
    document.body,
  );
}
