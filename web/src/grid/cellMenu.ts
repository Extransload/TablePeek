import type { ContextMenuItem } from "../components/ContextMenu";
import type { CopyFormat } from "../copyFormats";
import { t } from "../i18n";

// What Set Value puts in the selected cells, as TablePlus names them.
export type CellValueChoice = "empty" | "null" | "default";

export interface CellMenuTarget {
  // The clicked cell's column.
  column: string;
  // ⌘C's copy of the selection.
  copySelection(): void;
  copyText(text: string): Promise<void> | void;
  // The selected rows whole, and the selected block of cells, in a format;
  // absent where the view doesn't offer them.
  copyRowsAs?(format: CopyFormat): void;
  copyCellsAs?(format: CopyFormat): void;
  // INSERT is offered only when the rows' table is known.
  canInsert?: boolean;
  // The clicked column's values over every row, one per line.
  copyColumnValues?(): void;
  quickLook(): void;
  // A view's other ways to look at the cell, listed after Quick Look.
  views?: ContextMenuItem[];
  // Absent when the cell can't be changed here.
  edit?(): void;
  // Absent when none of the selected cells can be changed here.
  setValue?(value: CellValueChoice): void;
  // The values every selected cell can take.
  nullable?: boolean;
  allowsEmpty?: boolean;
  allowsDefault?: boolean;
  // Every selected cell is NULL already.
  isNull?: boolean;
}

function formatItems(copy: (format: CopyFormat) => void, canInsert: boolean): ContextMenuItem[] {
  const formats: [CopyFormat, string][] = [
    ["text", t("일반 텍스트")],
    ["json", "JSON"],
    ["html", "HTML"],
    ["markdown", t("Markdown 표")],
    ["csv", "CSV"],
    ["csvHeader", t("CSV (헤더 포함)")],
  ];
  if (canInsert) {
    formats.push(["insert", t("INSERT 문")]);
  }
  return formats.map(([format, label]) => ({ label, onSelect: () => copy(format) }));
}

// Delete's label for the selected rows: new rows are dropped ("cancel"),
// rows all marked already are unmarked ("undo"), others are marked.
export function deleteRowsLabel(count: number, action: "cancel" | "undo" | "delete"): string {
  if (count === 1) {
    return action === "cancel" ? t("행 추가 취소") : action === "undo" ? t("행 삭제 취소") : t("행 삭제");
  }
  const values = { count: count.toLocaleString() };
  return action === "cancel"
    ? t("{count}행 추가 취소", values)
    : action === "undo"
      ? t("{count}행 삭제 취소", values)
      : t("{count}행 삭제", values);
}

// The part of a cell's menu every table shares, in TablePlus's order and the
// same everywhere; a view adds its own entries after it.
export function cellMenuItems(target: CellMenuTarget): ContextMenuItem[] {
  const canInsert = target.canInsert === true;
  const items: ContextMenuItem[] = [{ label: t("복사"), onSelect: target.copySelection }];
  if (target.copyRowsAs !== undefined) {
    items.push({ label: t("행 복사 형식"), submenu: formatItems(target.copyRowsAs, canInsert) });
  }
  if (target.copyCellsAs !== undefined) {
    items.push({ label: t("선택한 셀 복사 형식"), submenu: formatItems(target.copyCellsAs, canInsert) });
  }
  items.push({ label: t("열 이름 복사"), onSelect: () => void target.copyText(target.column) });
  if (target.copyColumnValues !== undefined) {
    items.push({ label: t("열 값 전체 복사"), onSelect: target.copyColumnValues });
  }
  items.push({ label: "Quick Look", separatorBefore: true, onSelect: target.quickLook }, ...(target.views ?? []));
  if (target.edit !== undefined) {
    items.push({ label: t("이 셀 편집"), separatorBefore: true, onSelect: target.edit });
  }
  const setValue = target.setValue;
  if (setValue !== undefined) {
    const values: ContextMenuItem[] = [];
    if (target.allowsEmpty) {
      values.push({ label: "EMPTY", onSelect: () => setValue("empty") });
    }
    if (target.nullable) {
      values.push({ label: "NULL", disabled: target.isNull === true, onSelect: () => setValue("null") });
    }
    if (target.allowsDefault) {
      values.push({ label: "DEFAULT", onSelect: () => setValue("default") });
    }
    if (values.length > 0) {
      items.push({ label: t("값 설정"), separatorBefore: target.edit === undefined, submenu: values });
    }
  }
  return items;
}
