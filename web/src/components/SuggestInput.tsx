import { useEffect, useId, useLayoutEffect, useRef, useState, type InputHTMLAttributes, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

// A text field with suggestions that open as one of TablePeek's menus instead
// of the system's <datalist> box. The field stays a plain input (typing is
// free, any text is allowed); the list shows the suggestions containing what
// is typed, and picking one sets the field as typing it would, so a
// controlled field's onChange sees it.

const EDGE = 4;
const GAP = 2;
const MAX_HEIGHT = 280;
const MAX_ROWS = 200;

type Props = InputHTMLAttributes<HTMLInputElement> & { suggestions: readonly string[] };

export function SuggestInput({ suggestions, onFocus, onBlur, onKeyDown, ...props }: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();

  const typed = String(props.value ?? inputRef.current?.value ?? "").toLowerCase();
  // Matches by containment, those starting with the text first; the text
  // itself is no suggestion.
  const shown = suggestions
    .filter((s) => s.toLowerCase().includes(typed) && s.toLowerCase() !== typed)
    .sort((a, b) => Number(!a.toLowerCase().startsWith(typed)) - Number(!b.toLowerCase().startsWith(typed)))
    .slice(0, MAX_ROWS);
  const visible = open && shown.length > 0 && !props.disabled;

  function pick(value: string): void {
    const input = inputRef.current;
    setOpen(false);
    if (input === null) {
      return;
    }
    // Set as the browser would, so React's onChange sees a real input event.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus({ preventScroll: true });
  }

  // Under the field, as wide as it at least; above it when there is more room there.
  useLayoutEffect(() => {
    const input = inputRef.current;
    const menu = menuRef.current;
    if (!visible || input === null || menu === null) {
      return;
    }
    const field = input.getBoundingClientRect();
    menu.style.left = "0px";
    menu.style.top = "0px";
    menu.style.minWidth = `${field.width}px`;
    const below = window.innerHeight - field.bottom - GAP - EDGE;
    const above = field.top - GAP - EDGE;
    const height = Math.min(menu.scrollHeight, MAX_HEIGHT);
    const upward = height > below && above > below;
    menu.style.maxHeight = `${Math.max(80, Math.min(MAX_HEIGHT, upward ? above : below))}px`;
    const size = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(EDGE, Math.min(field.left, window.innerWidth - size.width - EDGE))}px`;
    menu.style.top = `${upward ? field.top - GAP - size.height : field.bottom + GAP}px`;
  }, [visible, shown.length]);

  // The highlighted row stays in sight, scrolled within the list only.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const row = menu?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    if (!visible || !menu || !row) {
      return;
    }
    if (row.offsetTop < menu.scrollTop) {
      menu.scrollTop = row.offsetTop;
    } else if (row.offsetTop + row.offsetHeight > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = row.offsetTop + row.offsetHeight - menu.clientHeight;
    }
  }, [visible, active]);

  useEffect(() => {
    if (!visible) {
      return;
    }
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !inputRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    const close = () => setOpen(false);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("scroll", outside, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("scroll", outside, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [visible]);

  function onFieldKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    onKeyDown?.(event);
    if (event.defaultPrevented) {
      return;
    }
    if (!visible) {
      if (event.key === "ArrowDown" && shown.length > 0) {
        event.preventDefault();
        setOpen(true);
        setActive(0);
      }
      return;
    }
    switch (event.key) {
      case "ArrowDown":
        setActive((index) => Math.min(shown.length - 1, index + 1));
        break;
      case "ArrowUp":
        setActive((index) => Math.max(0, index - 1));
        break;
      case "Enter":
        // Without a highlighted row Enter belongs to the form.
        if (active < 0 || active >= shown.length) {
          setOpen(false);
          return;
        }
        pick(shown[active]);
        break;
      case "Escape":
        setOpen(false);
        break;
      case "Tab":
        setOpen(false);
        return;
      default:
        return;
    }
    // The list owns these keys while open: the dialog under it mustn't close on Escape.
    event.preventDefault();
    event.stopPropagation();
  }

  return (
    <>
      <input
        {...props}
        ref={inputRef}
        role="combobox"
        autoComplete="off"
        aria-autocomplete="list"
        aria-expanded={visible}
        aria-controls={visible ? listId : undefined}
        aria-activedescendant={visible && active >= 0 ? `${listId}-${active}` : undefined}
        onFocus={(event) => {
          onFocus?.(event);
          setOpen(true);
          setActive(-1);
        }}
        onBlur={(event) => {
          onBlur?.(event);
          setOpen(false);
        }}
        onInput={() => {
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={onFieldKeyDown}
      />
      {visible
        ? createPortal(
            <div
              ref={menuRef}
              id={listId}
              className="context-menu select-menu"
              role="listbox"
              aria-label={props["aria-label"]}
              // The field keeps focus while a row is clicked.
              onMouseDown={(event) => {
                if (event.target !== event.currentTarget) {
                  event.preventDefault();
                }
              }}
            >
              {shown.map((value, index) => (
                <div
                  key={value}
                  id={`${listId}-${index}`}
                  role="option"
                  data-index={index}
                  aria-selected={index === active}
                  className={`context-item select-option${index === active ? " active" : ""}`}
                  onMouseMove={() => {
                    if (index !== active) {
                      setActive(index);
                    }
                  }}
                  onClick={() => pick(value)}
                >
                  <span className="context-label">{value}</span>
                </div>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
