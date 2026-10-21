import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { CheckIcon } from "./icons";

export interface ContextMenuItem {
  label: string;
  // Omitted for an item that only opens its submenu.
  onSelect?(): void;
  submenu?: ContextMenuItem[];
  // Shown with a check mark when true; any item setting it gives the whole
  // panel a check column.
  checked?: boolean;
  danger?: boolean;
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

const EDGE = 4;

function nextEnabled(items: ContextMenuItem[], from: number, step: 1 | -1): number {
  for (let offset = 1; offset <= items.length; offset += 1) {
    const index = (from + step * offset + items.length * offset) % items.length;
    if (!items[index].disabled) {
      return index;
    }
  }
  return from;
}

export function ContextMenu({ x, y, items, anchor, onClose }: ContextMenuProps) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  // Open submenus: the item index chosen at each level above the deepest.
  const [path, setPath] = useState<number[]>([]);
  // Highlighted item, moved by the mouse or the arrow keys.
  const [active, setActive] = useState<{ level: number; index: number } | null>(null);
  const [usingKeys, setUsingKeys] = useState(false);

  const levels: ContextMenuItem[][] = [items];
  for (const index of path) {
    const submenu = levels[levels.length - 1][index]?.submenu;
    if (submenu === undefined) {
      break;
    }
    levels.push(submenu);
  }

  function panel(level: number): HTMLElement | null {
    return layerRef.current?.querySelector<HTMLElement>(`[data-level="${level}"]`) ?? null;
  }

  // Root at the pointer; each submenu beside its parent item, flipped to the
  // other side or pulled up when it would leave the window. Once a level has
  // flipped left, deeper levels keep going left so they don't cover the root.
  useLayoutEffect(() => {
    let towardLeft = false;
    levels.forEach((_, level) => {
      const element = panel(level);
      if (element === null) {
        return;
      }
      const size = element.getBoundingClientRect();
      let left = x;
      let top = y;
      if (level > 0) {
        const parentPanel = panel(level - 1);
        const parentItem = parentPanel?.querySelector<HTMLElement>(`[data-index="${path[level - 1]}"]`);
        if (parentPanel && parentItem) {
          const item = parentItem.getBoundingClientRect();
          const onLeft = parentPanel.getBoundingClientRect().left - size.width - 2;
          const onRight = item.right + 2;
          const fitsLeft = onLeft >= EDGE;
          const fitsRight = onRight + size.width <= window.innerWidth - EDGE;
          towardLeft = towardLeft ? fitsLeft || !fitsRight : !fitsRight && fitsLeft;
          left = towardLeft ? onLeft : onRight;
          top = item.top - 5;
        }
      }
      element.style.left = `${Math.max(EDGE, Math.min(left, window.innerWidth - size.width - EDGE))}px`;
      element.style.top = `${Math.max(EDGE, Math.min(top, window.innerHeight - size.height - EDGE))}px`;
    });
  }, [x, y, path.join(",")]);

  useEffect(() => {
    if (!usingKeys || active === null) {
      return;
    }
    panel(active.level)?.querySelector<HTMLElement>(`[data-index="${active.index}"]`)?.focus();
  }, [usingKeys, active?.level, active?.index]);

  function openSubmenu(level: number, index: number): void {
    setPath([...path.slice(0, level), index]);
  }

  function choose(item: ContextMenuItem, level: number, index: number): void {
    if (item.disabled) {
      return;
    }
    if (item.submenu !== undefined) {
      openSubmenu(level, index);
      setActive({ level: level + 1, index: nextEnabled(item.submenu, -1, 1) });
      return;
    }
    onClose();
    item.onSelect?.();
  }

  useEffect(() => {
    function onPointerDown(event: PointerEvent): void {
      const layer = layerRef.current;
      const target = event.target as Node;
      if (layer && !layer.contains(target) && !anchor?.contains(target)) {
        onClose();
      }
    }
    function onKeyDown(event: KeyboardEvent): void {
      const level = active?.level ?? levels.length - 1;
      const list = levels[level];
      switch (event.key) {
        case "Escape":
          // One level at a time, then the whole menu.
          if (path.length > 0) {
            setActive({ level: path.length - 1, index: path[path.length - 1] });
            setPath(path.slice(0, -1));
          } else {
            onClose();
          }
          break;
        case "ArrowDown":
        case "ArrowUp": {
          const from = active?.level === level ? active.index : event.key === "ArrowDown" ? -1 : list.length;
          setActive({ level, index: nextEnabled(list, from, event.key === "ArrowDown" ? 1 : -1) });
          setPath(path.slice(0, level));
          break;
        }
        case "ArrowRight":
          if (active !== null && list[active.index]?.submenu !== undefined && !list[active.index].disabled) {
            choose(list[active.index], level, active.index);
          }
          break;
        case "ArrowLeft":
          if (level > 0) {
            setActive({ level: level - 1, index: path[level - 1] });
            setPath(path.slice(0, level - 1));
          }
          break;
        case "Enter":
          if (active === null) {
            return;
          }
          choose(list[active.index], level, active.index);
          break;
        default:
          return;
      }
      event.preventDefault();
      setUsingKeys(true);
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
  });

  return (
    <div ref={layerRef} className="context-layer" onContextMenu={(event) => event.preventDefault()}>
      {levels.map((list, level) => {
        const hasChecks = list.some((item) => item.checked !== undefined);
        return (
          <div
            key={level}
            className="context-menu"
            role="menu"
            data-level={level}
            style={level === 0 ? { left: x, top: y } : undefined}
          >
            {list.map((item, index) => {
              const open = path[level] === index && level < levels.length - 1;
              const highlighted = active?.level === level && active.index === index;
              return (
                <div className="context-entry" key={`${index}-${item.label}`}>
                  {item.separatorBefore ? <div className="context-sep" /> : null}
                  <button
                    type="button"
                    role="menuitem"
                    data-index={index}
                    className={`context-item${item.danger ? " danger" : ""}${highlighted ? " active" : ""}${open ? " open" : ""}`}
                    disabled={item.disabled}
                    aria-haspopup={item.submenu !== undefined ? "menu" : undefined}
                    aria-expanded={item.submenu !== undefined ? open : undefined}
                    onMouseEnter={() => {
                      setUsingKeys(false);
                      setActive({ level, index });
                      if (item.submenu !== undefined && !item.disabled) {
                        openSubmenu(level, index);
                      } else {
                        setPath(path.slice(0, level));
                      }
                    }}
                    onClick={() => choose(item, level, index)}
                  >
                    {hasChecks ? (
                      <span className="context-check" aria-hidden="true">
                        {item.checked ? <CheckIcon size={9} /> : null}
                      </span>
                    ) : null}
                    <span className="context-label">{item.label}</span>
                    {item.submenu !== undefined ? (
                      <span className="context-arrow" aria-hidden="true">
                        ›
                      </span>
                    ) : null}
                  </button>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
