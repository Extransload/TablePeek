import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { UpDownIcon } from "./icons";

export interface GridColumn {
  header: string;
  className?: string;
  render(row: number): ReactNode;
  // Editable cells: the editor's starting text and how a value is applied.
  value?(row: number): string;
  commit?(row: number, value: string): void;
  // Choices listed under the editor, as TablePlus offers types and values.
  // A strict cell (YES/NO) takes only these; others also accept typing.
  options?(row: number): string[];
  strict?: boolean;
  // How typing narrows the list and how a picked choice joins the typed text,
  // for list cells such as an index's columns.
  query?(value: string): string;
  pick?(value: string, option: string): string;
  readOnly?(row: number): boolean;
  changed?(row: number): boolean;
  title?(row: number): string | undefined;
}

export interface GridFocus {
  row: number;
  col: number;
  // Bumped on every request so the same cell can be asked for twice.
  seq: number;
}

interface StructureGridProps {
  rowKeys: string[];
  columns: GridColumn[];
  numbered?: boolean;
  rowClassName?(row: number): string;
  // Rows that can't be edited, such as one marked for deletion.
  rowReadOnly?(row: number): boolean;
  canDeleteRow?(row: number): boolean;
  onDeleteRow?(row: number): void;
  // Opens the editor on a cell, e.g. the name of a row just added.
  focus?: GridFocus | null;
}

interface Cell {
  row: number;
  col: number;
}

interface Editing extends Cell {
  value: string;
  // Until something is typed the list shows every choice.
  typed: boolean;
  // Highlighted choice in the list, -1 for none.
  active: number;
}

interface MenuBox {
  left: number;
  // Below the cell (top) or, near the window's bottom, above it (bottom).
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
}

const MENU_HEIGHT = 240;

// A spreadsheet-like table, as in the data grid: click selects a cell,
// double-click, Enter or F2 edits it (cells with choices open a dropdown),
// typing replaces it, arrows and Tab move, Delete or Backspace removes the row.
export function StructureGrid({
  rowKeys,
  columns,
  numbered = false,
  rowClassName,
  rowReadOnly,
  canDeleteRow,
  onDeleteRow,
  focus,
}: StructureGridProps) {
  const tableRef = useRef<HTMLTableElement>(null);
  const cellRef = useRef<HTMLTableCellElement | null>(null);
  const [selected, setSelected] = useState<Cell | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [menuBox, setMenuBox] = useState<MenuBox | null>(null);
  // Enter, Tab, a click and blur can all end one edit; only the first applies.
  const editingRef = useRef(editing);
  editingRef.current = editing;

  const rowCount = rowKeys.length;

  useEffect(() => {
    if (selected !== null && selected.row >= rowCount) {
      setSelected(rowCount > 0 ? { row: rowCount - 1, col: selected.col } : null);
    }
  }, [rowCount, selected]);

  useEffect(() => {
    if (focus) {
      setSelected({ row: focus.row, col: focus.col });
      beginEdit({ row: focus.row, col: focus.col });
    }
    // Only a new request opens the editor, not a re-render.
  }, [focus?.seq]);

  const choices = editing === null ? [] : listChoices(editing);

  // The list floats over the panel, so it follows the cell while it scrolls.
  useLayoutEffect(() => {
    if (editing === null || choices.length === 0) {
      setMenuBox(null);
      return;
    }
    function place(): void {
      const rect = cellRef.current?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      const width = Math.max(rect.width, 180);
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
      const below = window.innerHeight - rect.bottom - 10;
      if (below < Math.min(MENU_HEIGHT, 160) && rect.top > below) {
        const maxHeight = Math.min(MENU_HEIGHT, rect.top - 10);
        setMenuBox({ left, bottom: window.innerHeight - rect.top + 2, width, maxHeight });
      } else {
        setMenuBox({ left, top: rect.bottom + 2, width, maxHeight: Math.min(MENU_HEIGHT, below) });
      }
    }
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [editing?.row, editing?.col, choices.length]);

  function listChoices(edit: Editing): string[] {
    const column = columns[edit.col];
    const all = column?.options?.(edit.row) ?? [];
    if (column?.strict || !edit.typed) {
      return all;
    }
    const needle = (column?.query?.(edit.value) ?? edit.value).trim().toLowerCase();
    return needle === "" ? all : all.filter((option) => option.toLowerCase().includes(needle));
  }

  function editable(cell: Cell): boolean {
    const column = columns[cell.col];
    return (
      column?.commit !== undefined &&
      !(column.readOnly?.(cell.row) ?? false) &&
      !(rowReadOnly?.(cell.row) ?? false)
    );
  }

  function beginEdit(cell: Cell, typed?: string): void {
    const column = columns[cell.col];
    if (column === undefined || !editable(cell)) {
      return;
    }
    const current = column.value?.(cell.row) ?? "";
    const options = column.options?.(cell.row) ?? [];
    setEditing({
      ...cell,
      value: typed ?? current,
      typed: typed !== undefined,
      active: column.strict ? Math.max(0, options.indexOf(current)) : -1,
    });
  }

  // Keyboard and list endings keep the keyboard in the table; a blur must not
  // pull focus back, or a click elsewhere (another grid) would lose it.
  function finishEdit(apply: boolean, options: { value?: string; refocus?: boolean } = {}): void {
    const current = editingRef.current;
    if (current === null) {
      return;
    }
    editingRef.current = null;
    setEditing(null);
    if (apply) {
      columns[current.col]?.commit?.(current.row, options.value ?? current.value);
    }
    if (options.refocus) {
      tableRef.current?.focus({ preventScroll: true });
    }
  }

  function choose(option: string): void {
    const current = editingRef.current;
    if (current === null) {
      return;
    }
    const column = columns[current.col];
    const value = column?.pick ? column.pick(current.value, option) : option;
    finishEdit(true, { value, refocus: true });
  }

  function move(cell: Cell, dRow: number, dCol: number): Cell {
    const row = Math.min(rowCount - 1, Math.max(0, cell.row + dRow));
    const col = Math.min(columns.length - 1, Math.max(0, cell.col + dCol));
    return { row, col };
  }

  // Up and Down walk the open list; Enter takes the highlighted choice.
  function menuKey(event: KeyboardEvent): boolean {
    if (editing === null || choices.length === 0) {
      return false;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const down = event.key === "ArrowDown";
      const active =
        editing.active < 0
          ? down
            ? 0
            : choices.length - 1
          : (editing.active + (down ? 1 : -1) + choices.length) % choices.length;
      setEditing({ ...editing, active });
      return true;
    }
    if (event.key === "Enter" && editing.active >= 0 && editing.active < choices.length) {
      event.preventDefault();
      choose(choices[editing.active]);
      return true;
    }
    return false;
  }

  function onTableKeyDown(event: KeyboardEvent<HTMLTableElement>): void {
    // Keys that end a Korean (IME) composition belong to the composition.
    if (event.metaKey || event.ctrlKey || event.nativeEvent.isComposing || event.keyCode === 229) {
      return;
    }
    if (editing !== null) {
      // A strict cell has no input: its list is driven from here.
      if (menuKey(event)) {
        return;
      }
      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault();
        finishEdit(false, { refocus: true });
      }
      return;
    }
    if (selected === null) {
      return;
    }
    const column = columns[selected.col];
    const step: Record<string, [number, number]> = {
      ArrowUp: [-1, 0],
      ArrowDown: [1, 0],
      ArrowLeft: [0, -1],
      ArrowRight: [0, 1],
    };
    if (event.key in step) {
      event.preventDefault();
      const [dRow, dCol] = step[event.key];
      setSelected(move(selected, dRow, dCol));
    } else if (event.key === "Tab") {
      event.preventDefault();
      setSelected(move(selected, 0, event.shiftKey ? -1 : 1));
    } else if (event.key === "Enter" || event.key === "F2" || event.key === " ") {
      event.preventDefault();
      beginEdit(selected);
    } else if (event.key === "Delete" || event.key === "Backspace") {
      if (onDeleteRow && (canDeleteRow?.(selected.row) ?? true)) {
        event.preventDefault();
        onDeleteRow(selected.row);
      }
    } else if (event.key === "Escape") {
      setSelected(null);
    } else if (event.key.length === 1 && !event.altKey && column && !column.strict) {
      event.preventDefault();
      beginEdit(selected, event.key);
    }
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    event.stopPropagation();
    if (event.nativeEvent.isComposing || event.keyCode === 229) {
      return;
    }
    if (menuKey(event)) {
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      finishEdit(true, { refocus: true });
    } else if (event.key === "Escape") {
      event.preventDefault();
      finishEdit(false, { refocus: true });
    } else if (event.key === "Tab" && editing !== null) {
      event.preventDefault();
      const next = move(editing, 0, event.shiftKey ? -1 : 1);
      finishEdit(true, { refocus: true });
      setSelected(next);
    }
  }

  // Leaving the table closes a strict cell's list without changing it.
  function onTableBlur(event: FocusEvent<HTMLTableElement>): void {
    const next = event.relatedTarget;
    if (next instanceof Node && tableRef.current?.contains(next)) {
      return;
    }
    if (editingRef.current !== null && columns[editingRef.current.col]?.strict) {
      finishEdit(false);
    }
  }

  return (
    <>
      <table
        ref={tableRef}
        className="structure-table structure-grid"
        tabIndex={0}
        onKeyDown={onTableKeyDown}
        onBlur={onTableBlur}
      >
        <thead>
          <tr>
            {numbered ? <th className="structure-num">#</th> : null}
            {columns.map((column) => (
              <th key={column.header} className={column.className}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rowKeys.map((key, row) => (
            <tr key={key} className={rowClassName?.(row)}>
              {numbered ? <td className="structure-num">{row + 1}</td> : null}
              {columns.map((column, col) => {
                const isSelected = selected?.row === row && selected.col === col;
                const isEditing = editing?.row === row && editing.col === col;
                const canEdit = editable({ row, col });
                const hasChoices = canEdit && column.options !== undefined;
                const classes = [
                  column.className,
                  isSelected ? "selected" : "",
                  column.changed?.(row) ? "changed" : "",
                  canEdit ? "" : "readonly",
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <td
                    key={column.header}
                    ref={isEditing ? cellRef : undefined}
                    className={classes}
                    title={column.title?.(row)}
                    onMouseDown={() => {
                      if (isEditing) {
                        return;
                      }
                      const open = editingRef.current;
                      if (open !== null && columns[open.col]?.strict) {
                        finishEdit(false);
                      }
                      setSelected({ row, col });
                    }}
                    onDoubleClick={() => {
                      // A double-click inside the open editor selects a word.
                      if (!isEditing) {
                        beginEdit({ row, col });
                      }
                    }}
                  >
                    {isEditing && editing !== null && !column.strict ? (
                      <input
                        autoFocus
                        spellCheck={false}
                        value={editing.value}
                        onChange={(event) =>
                          setEditing({ ...editing, value: event.target.value, typed: true, active: -1 })
                        }
                        onKeyDown={onInputKeyDown}
                        onBlur={() => finishEdit(true)}
                      />
                    ) : (
                      <span className="structure-cell">
                        <span className="structure-cell-text">{column.render(row)}</span>
                        {hasChoices ? (
                          <button
                            type="button"
                            tabIndex={-1}
                            className="structure-cell-menu"
                            title={column.header}
                            onMouseDown={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              setSelected({ row, col });
                              tableRef.current?.focus({ preventScroll: true });
                              if (isEditing) {
                                finishEdit(false, { refocus: true });
                              } else {
                                beginEdit({ row, col });
                              }
                            }}
                          >
                            <UpDownIcon size={7} />
                          </button>
                        ) : null}
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {editing !== null && menuBox !== null && choices.length > 0
        ? createPortal(
            <div
              className="structure-menu"
              style={{
                left: menuBox.left,
                top: menuBox.top,
                bottom: menuBox.bottom,
                minWidth: menuBox.width,
                maxHeight: menuBox.maxHeight,
              }}
              onMouseDown={(event) => event.preventDefault()}
            >
              {choices.map((option, index) => (
                <button
                  type="button"
                  key={option}
                  tabIndex={-1}
                  className={index === editing.active ? "active" : ""}
                  onMouseEnter={() => setEditing({ ...editing, active: index })}
                  onClick={() => choose(option)}
                >
                  {option}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
