import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type SelectHTMLAttributes,
} from "react";
import { createPortal } from "react-dom";
import { overlayRight } from "../dock";
import { CheckIcon } from "./icons";
import { useMenuPreview } from "./menuPreview";

// A <select> whose list opens as one of TablePeek's menus instead of the
// system's box. The field itself stays a native select (its size, styles,
// typing to pick, and the form value), and the list is read from its own
// <option> and <optgroup> children, so it drops in for `select`. With
// `onPreview` the highlighted option is shown until one is picked or the
// list closes (see menuPreview).

type Entry =
  | { kind: "group"; label: string }
  | { kind: "option"; value: string; label: string; disabled: boolean; selected: boolean };

const EDGE = 4;
const GAP = 2;
const MAX_HEIGHT = 320;
const PAGE = 10;
// Typed letters within this long of each other spell one name to jump to.
const TYPEAHEAD_MS = 600;

function entriesOf(select: HTMLSelectElement): Entry[] {
  const entries: Entry[] = [];
  const add = (option: HTMLOptionElement, groupDisabled: boolean) => {
    entries.push({
      kind: "option",
      value: option.value,
      label: option.label || option.text,
      disabled: option.disabled || groupDisabled,
      selected: option.selected,
    });
  };
  for (const child of Array.from(select.children)) {
    if (child instanceof HTMLOptGroupElement) {
      entries.push({ kind: "group", label: child.label });
      for (const option of Array.from(child.children)) {
        if (option instanceof HTMLOptionElement) {
          add(option, child.disabled);
        }
      }
    } else if (child instanceof HTMLOptionElement) {
      add(child, false);
    }
  }
  return entries;
}

function pickable(entry: Entry | undefined): boolean {
  return entry !== undefined && entry.kind === "option" && !entry.disabled;
}

// The next pickable entry from `from` in steps of `step`, stopping at the
// ends; `from` itself when there is none further.
function step(entries: Entry[], from: number, by: number): number {
  const direction = by > 0 ? 1 : -1;
  let found = from;
  let left = Math.abs(by);
  for (let index = from + direction; index >= 0 && index < entries.length && left > 0; index += direction) {
    if (pickable(entries[index])) {
      found = index;
      left -= 1;
    }
  }
  return found;
}

// Under the field, as wide as it at least, its labels starting where the
// field's text does (the check column hangs out to the left of the field,
// as a system menu's does); above it when there is more room there.
function placeMenu(select: HTMLSelectElement, menu: HTMLElement): void {
  const field = select.getBoundingClientRect();
  // Measured from the corner: a fixed box left near the right edge would
  // come out narrower than its rows.
  menu.style.left = "0px";
  menu.style.top = "0px";
  // Layout offsets, not drawn boxes: the list scales in as it opens.
  const label = menu.querySelector<HTMLElement>(".select-option .context-label");
  let labelInset = 0;
  for (let node: HTMLElement | null = label; node !== null && node !== menu; node = node.offsetParent as HTMLElement | null) {
    labelInset += node.offsetLeft;
  }
  if (label !== null) {
    labelInset += menu.clientLeft;
  }
  const style = getComputedStyle(select);
  const textInset = parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth);
  const hang = Math.max(0, labelInset - textInset);
  menu.style.minWidth = `${field.width + hang}px`;
  const below = window.innerHeight - field.bottom - GAP - EDGE;
  const above = field.top - GAP - EDGE;
  const height = Math.min(menu.scrollHeight, MAX_HEIGHT);
  const upward = height > below && above > below;
  menu.style.maxHeight = `${Math.max(80, Math.min(MAX_HEIGHT, upward ? above : below))}px`;
  // Its layout size: following the field while it still scales in, its
  // drawn box would be smaller.
  const width = menu.offsetWidth;
  const tall = menu.offsetHeight;
  const left = field.left - hang;
  menu.style.left = `${Math.max(EDGE, Math.min(left, overlayRight(left) - width - EDGE))}px`;
  menu.style.top = `${upward ? field.top - GAP - tall : field.bottom + GAP}px`;
}

// Each field's way to open its list, for openSelect.
const openers = new WeakMap<HTMLSelectElement, () => void>();

// Opens a Select's list from outside the field, as Enter on it would (a
// settings row opening its menu).
export function openSelect(select: HTMLSelectElement): void {
  select.focus({ preventScroll: true });
  openers.get(select)?.();
}

export function Select({
  onMouseDown,
  onKeyDown,
  onPreview,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { onPreview?(value: string | null): void }) {
  const selectRef = useRef<HTMLSelectElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [active, setActive] = useState(-1);
  const typed = useRef({ text: "", at: 0 });
  const listId = useId();
  const highlighted = entries[active];
  useMenuPreview(onPreview, open && highlighted?.kind === "option" && !highlighted.disabled ? highlighted.value : null);

  function show(): void {
    const select = selectRef.current;
    if (select === null || select.disabled) {
      return;
    }
    const list = entriesOf(select);
    setEntries(list);
    setActive(list.findIndex((entry) => entry.kind === "option" && entry.selected));
    setOpen(true);
  }

  function hide(refocus: boolean): void {
    setOpen(false);
    if (refocus) {
      selectRef.current?.focus({ preventScroll: true });
    }
  }

  // `pointer`: picked with the mouse, so the field takes focus back without
  // the keyboard's focus halo (see onFieldMouseDown).
  function pick(value: string, pointer = false): void {
    const select = selectRef.current;
    if (pointer && select !== null) {
      select.dataset.pointerFocus = "";
    }
    hide(true);
    if (select === null || select.value === value) {
      return;
    }
    // Set as the browser would, so React's onChange sees a real change event.
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // Options that change while the list is open (fonts arriving) show at once;
  // a field turned off meanwhile (an export starting) takes its list away.
  useLayoutEffect(() => {
    if (!open || selectRef.current === null) {
      return;
    }
    if (selectRef.current.disabled) {
      setOpen(false);
      return;
    }
    setEntries(entriesOf(selectRef.current));
  }, [open, children, props.disabled]);

  useLayoutEffect(() => {
    if (open && selectRef.current !== null && menuRef.current !== null) {
      placeMenu(selectRef.current, menuRef.current);
    }
  }, [open, entries.length]);

  // The highlighted entry stays in sight: centred when the list opens.
  const opened = useRef(false);
  useLayoutEffect(() => {
    if (!open) {
      opened.current = false;
      return;
    }
    // The list scrolls by itself: scrollIntoView could move the page too,
    // and a page scroll closes the list.
    const menu = menuRef.current;
    const row = menu?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (menu && row) {
      const top = row.offsetTop;
      const bottom = top + row.offsetHeight;
      if (!opened.current) {
        menu.scrollTop = top - (menu.clientHeight - row.offsetHeight) / 2;
      } else if (top < menu.scrollTop) {
        menu.scrollTop = top;
      } else if (bottom > menu.scrollTop + menu.clientHeight) {
        menu.scrollTop = bottom - menu.clientHeight;
      }
    }
    opened.current = true;
  }, [open, active]);

  function onMenuKey(event: globalThis.KeyboardEvent): void {
    // Keys in the list: the field is the keyboard's again, halo included.
    if (selectRef.current !== null) {
      delete selectRef.current.dataset.pointerFocus;
    }
    let next = active;
    switch (event.key) {
      case "Escape":
        hide(true);
        break;
      case "Tab":
        hide(false);
        return;
      case "Enter":
      case " ":
        if (pickable(entries[active])) {
          pick((entries[active] as { value: string }).value);
        }
        break;
      case "ArrowDown":
        next = step(entries, active, 1);
        break;
      case "ArrowUp":
        next = step(entries, active, -1);
        break;
      case "PageDown":
        next = step(entries, active, PAGE);
        break;
      case "PageUp":
        next = step(entries, active, -PAGE);
        break;
      case "Home":
        next = step(entries, -1, 1);
        break;
      case "End":
        next = step(entries, entries.length, -1);
        break;
      default: {
        if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) {
          return;
        }
        const now = performance.now();
        const text = now - typed.current.at < TYPEAHEAD_MS ? typed.current.text + event.key : event.key;
        typed.current = { text, at: now };
        const wanted = text.toLowerCase();
        // A fresh letter looks past the current entry, so pressing it again moves on.
        const start = text.length === 1 ? active + 1 : Math.max(active, 0);
        for (let offset = 0; offset < entries.length; offset += 1) {
          const index = (start + offset) % entries.length;
          const entry = entries[index];
          if (pickable(entry) && entry.kind === "option" && entry.label.toLowerCase().startsWith(wanted)) {
            next = index;
            break;
          }
        }
      }
    }
    // The list owns its keys while open: the dialog under it mustn't close on Escape.
    event.preventDefault();
    event.stopPropagation();
    if (next !== active) {
      setActive(next);
    }
  }

  const handlers = useRef({ onMenuKey, hide, show });
  handlers.current = { onMenuKey, hide, show };

  useEffect(() => {
    const select = selectRef.current;
    if (select === null) {
      return;
    }
    openers.set(select, () => handlers.current.show());
    return () => {
      openers.delete(select);
    };
  }, []);

  const previews = onPreview !== undefined;
  useEffect(() => {
    if (!open) {
      return;
    }
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !selectRef.current?.contains(target)) {
        handlers.current.hide(false);
      }
    };
    // A preview redraws the app under the list (a bigger font moves the
    // field and scrolls what holds it): the list follows the field, and
    // only the wheel turned elsewhere closes it.
    const follow = (event: Event) => {
      if (selectRef.current !== null && menuRef.current !== null && !menuRef.current.contains(event.target as Node)) {
        placeMenu(selectRef.current, menuRef.current);
      }
    };
    const key = (event: globalThis.KeyboardEvent) => handlers.current.onMenuKey(event);
    const close = () => handlers.current.hide(false);
    // Scrolling anything but the list moves the field away from it.
    const scrolled = previews ? follow : outside;
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("scroll", scrolled, true);
    if (previews) {
      document.addEventListener("wheel", outside, { capture: true, passive: true });
      window.addEventListener("tablepeek:theme", follow);
    }
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("scroll", scrolled, true);
      document.removeEventListener("wheel", outside, true);
      window.removeEventListener("tablepeek:theme", follow);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [open, previews]);

  function onFieldMouseDown(event: MouseEvent<HTMLSelectElement>): void {
    onMouseDown?.(event);
    if (event.defaultPrevented || event.button !== 0) {
      return;
    }
    // No system box: this one opens instead. Focus taken by a click shows no
    // halo (the keyboard's focus ring) until a key is pressed on the field,
    // as a native select's doesn't; it would read as a second frame.
    event.preventDefault();
    event.currentTarget.dataset.pointerFocus = "";
    event.currentTarget.focus({ preventScroll: true });
    if (open) {
      hide(false);
    } else {
      show();
    }
  }

  function onFieldKeyDown(event: KeyboardEvent<HTMLSelectElement>): void {
    onKeyDown?.(event);
    delete event.currentTarget.dataset.pointerFocus;
    if (event.defaultPrevented || open) {
      return;
    }
    // Letters typed on the closed field pick as the system does, and a space
    // among them belongs to the name being typed ("Fira Code").
    const now = performance.now();
    const typing = now - typed.current.at < TYPEAHEAD_MS;
    if (event.key.length === 1 && event.key !== " " && !event.metaKey && !event.ctrlKey && !event.altKey) {
      typed.current = { text: "", at: now };
      return;
    }
    const opens =
      (event.key === " " && !typing) ||
      // ⌘↩ belongs to whatever holds the field (the filter's Apply All).
      (event.key === "Enter" && !event.metaKey && !event.ctrlKey) ||
      event.key === "F4" ||
      ((event.key === "ArrowDown" || event.key === "ArrowUp") && (event.altKey || !event.metaKey));
    if (opens) {
      event.preventDefault();
      show();
    }
  }

  return (
    <>
      <select
        {...props}
        ref={selectRef}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        onMouseDown={onFieldMouseDown}
        onKeyDown={onFieldKeyDown}
        onBlur={(event) => {
          props.onBlur?.(event);
          // Focus leaving for the open list comes back with pick or hide.
          if (!open) {
            delete event.currentTarget.dataset.pointerFocus;
          }
        }}
      >
        {children}
      </select>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              id={listId}
              className="context-menu select-menu"
              role="listbox"
              aria-label={props["aria-label"] ?? props.title}
              // The field keeps focus (and its keys) while a row is clicked;
              // a press on the list's own scrollbar is left to the browser.
              onMouseDown={(event) => {
                if (event.target !== event.currentTarget) {
                  event.preventDefault();
                }
              }}
            >
              {entries.map((entry, index) =>
                entry.kind === "group" ? (
                  <div className="select-group" role="presentation" key={`group:${index}`}>
                    {entry.label}
                  </div>
                ) : (
                  <div
                    key={`option:${index}`}
                    id={`${listId}-${index}`}
                    role="option"
                    data-index={index}
                    aria-selected={entry.selected}
                    aria-disabled={entry.disabled || undefined}
                    className={`context-item select-option${index === active ? " active" : ""}${
                      entry.disabled ? " disabled" : ""
                    }`}
                    onMouseMove={() => {
                      if (!entry.disabled && index !== active) {
                        setActive(index);
                      }
                    }}
                    onClick={() => {
                      if (!entry.disabled) {
                        pick(entry.value, true);
                      }
                    }}
                  >
                    <span className="context-label">{entry.label}</span>
                    <span className="context-check select-check" aria-hidden="true">
                      {entry.selected ? <CheckIcon size={9} /> : null}
                    </span>
                  </div>
                ),
              )}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
