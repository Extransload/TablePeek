import { useEffect, useLayoutEffect, useRef } from "react";

export interface ContextMenuItem {
  label: string;
  onSelect(): void;
  disabled?: boolean;
  separatorBefore?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  // The button that opened the menu: pressing it again is left to its own
  // click handler, so it closes the menu instead of reopening it.
  anchor?: Element | null;
  onClose(): void;
}

export function ContextMenu({ x, y, items, anchor, onClose }: ContextMenuProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const rect = root.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 4;
    const maxY = window.innerHeight - rect.height - 4;
    root.style.left = `${Math.max(4, Math.min(x, maxX))}px`;
    root.style.top = `${Math.max(4, Math.min(y, maxY))}px`;
  }, [x, y]);

  useEffect(() => {
    function onPointerDown(event: PointerEvent): void {
      const root = rootRef.current;
      const target = event.target as Node;
      if (root && !root.contains(target) && !anchor?.contains(target)) {
        onClose();
      }
    }
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
      }
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [anchor, onClose]);

  return (
    <div
      ref={rootRef}
      className="context-menu"
      style={{ left: x, top: y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) => (
        <div className="context-entry" key={`${index}-${item.label}`}>
          {item.separatorBefore ? <div className="context-sep" /> : null}
          <button
            type="button"
            className="context-item"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}
