import type { ContextMenuItem } from "../components/ContextMenu";
import { t } from "../i18n";
import { cellToString } from "../rowOps";

// The text a cell copies as: strings as they are, other values as JSON.
function cellToText(value: unknown): string {
  return cellToString(value) ?? "";
}

export interface CellMenuTarget {
  column: string;
  // The cell's value and its row's, loading them first if they aren't yet.
  value(): Promise<unknown> | unknown;
  row(): Promise<unknown[]> | unknown[];
  copy(text: string): Promise<void> | void;
  quickLook(): void;
  // A view's other ways to look at the cell, listed after Quick Look.
  views?: ContextMenuItem[];
  // Absent when the cell can't be changed here.
  edit?(): void;
  setValue?(value: string | null): void;
  // Whether NULL and the empty string are values this cell can take.
  nullable?: boolean;
  allowsEmpty?: boolean;
  isNull?: boolean;
}

// The part of a cell's menu every table shares, in the same order everywhere;
// a view adds its own entries after it.
export function cellMenuItems(target: CellMenuTarget): ContextMenuItem[] {
  const items: ContextMenuItem[] = [
    {
      label: t("셀 값 복사"),
      onSelect: () => {
        void (async () => {
          const value = await target.value();
          await target.copy(value === null ? "NULL" : cellToText(value));
        })();
      },
    },
    {
      label: t("열 이름 복사"),
      onSelect: () => void target.copy(target.column),
    },
    {
      label: t("행 복사 (TSV)"),
      onSelect: () => {
        void (async () => {
          const values = await target.row();
          await target.copy(values.map((entry) => (entry === null ? "" : cellToText(entry))).join("\t"));
        })();
      },
    },
    { label: "Quick Look", separatorBefore: true, onSelect: target.quickLook },
    ...(target.views ?? []),
  ];
  if (target.edit !== undefined) {
    items.push({ label: t("이 셀 편집"), separatorBefore: true, onSelect: target.edit });
  }
  const setValue = target.setValue;
  if (setValue !== undefined && target.nullable) {
    items.push({
      label: t("값을 NULL로 설정"),
      separatorBefore: target.edit === undefined,
      disabled: target.isNull === true,
      onSelect: () => setValue(null),
    });
  }
  if (setValue !== undefined && target.allowsEmpty) {
    items.push({ label: t("빈 문자열로 설정"), onSelect: () => setValue("") });
  }
  return items;
}
