import { useContext, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { t } from "../../i18n";
import { type Theme } from "../../palette";
import { type GridColorKey } from "../../settings";
import { type SyntaxColorKey } from "../../syntax";
import { slotUses, TABLE_SLOTS, themeTable, type TablePicks, type TableSlot } from "../../termTheme";
import { SqlPreview } from "../SqlEditor";
import { ScopeContext, SettingRow } from "./rows";

// The colours Settings picks for the theme shown: its colour table, the SQL
// editor's syntax colours and the data table's by kind of value.

// The SQL editor's every coloured part, as TablePlus lists them; a row may
// set parts that read as one (NULL and booleans, operators and punctuation).
export const SYNTAX_COLOR_ROWS: { label: string; keys: SyntaxColorKey[] }[] = [
  { label: "키워드", keys: ["keyword"] },
  { label: "함수", keys: ["function"] },
  { label: "타입", keys: ["type"] },
  { label: "숫자", keys: ["number"] },
  { label: "NULL·참거짓", keys: ["null", "bool"] },
  { label: "연산자·기호", keys: ["operator", "punctuation"] },
  { label: "작은따옴표 문자열", keys: ["string"] },
  { label: "큰따옴표 문자열", keys: ["stringDouble"] },
  { label: "백틱 문자열", keys: ["stringBacktick"] },
  { label: "주석", keys: ["comment"] },
  { label: "그 밖의 글자", keys: ["text"] },
];

// Data table colours by kind of value, in the order the grid shows them most.
export const GRID_COLOR_ROWS: { label: string; keys: GridColorKey[] }[] = [
  { label: "문자열", keys: ["string"] },
  { label: "정수", keys: ["integer"] },
  { label: "실수", keys: ["float"] },
  { label: "큰 정수", keys: ["bigint"] },
  { label: "불리언", keys: ["boolean"] },
  { label: "날짜·시각", keys: ["date"] },
  { label: "시간(TIME)", keys: ["time"] },
  { label: "JSON", keys: ["json"] },
  { label: "배열", keys: ["list"] },
  { label: "열거형", keys: ["enum"] },
  { label: "UUID", keys: ["uuid"] },
  { label: "이진", keys: ["binary"] },
  { label: "NULL", keys: ["null"] },
];

// The colour picks for the theme shown, a row each, then one putting them
// all back.
export function ColorRows<K extends string>({
  rows,
  colors,
  picked,
  keywords,
  hint,
  onPick,
}: {
  rows: { label: string; keys: K[] }[];
  colors: Record<K, string>;
  picked: Partial<Record<K, string>>;
  keywords: string;
  hint?: string;
  onPick(keys: K[], color: string | null): void;
}) {
  return (
    <>
      {rows.map((row) => {
        const color = colors[row.keys[0]];
        return (
          <SettingRow
            key={row.label}
            label={row.label}
            keywords={keywords}
            changed={row.keys.some((key) => picked[key] !== undefined)}
            onReset={() => onPick(row.keys, null)}
          >
            <span className="settings-color-value mono">{color}</span>
            <input
              type="color"
              aria-label={t(row.label)}
              value={/^#[0-9a-f]{6}$/i.test(color) ? color : "#000000"}
              onChange={(event) => onPick(row.keys, event.target.value)}
            />
          </SettingRow>
        );
      })}
      <SettingRow label="색 재설정" keywords={keywords} hint={hint}>
        <button
          type="button"
          disabled={Object.keys(picked).length === 0}
          onClick={() => onPick(rows.flatMap((row) => row.keys), null)}
        >
          {t("모두 기본값으로")}
        </button>
      </SettingRow>
    </>
  );
}

// The colour table's slots by the names terminals give them.
const SLOT_NAMES: Record<TableSlot, string> = {
  bg: "바탕",
  fg: "글자",
  ansi0: "검정",
  ansi1: "빨강",
  ansi2: "초록",
  ansi3: "노랑",
  ansi4: "파랑",
  ansi5: "자홍",
  ansi6: "청록",
  ansi7: "흰색",
  ansi8: "밝은 검정",
  ansi9: "밝은 빨강",
  ansi10: "밝은 초록",
  ansi11: "밝은 노랑",
  ansi12: "밝은 파랑",
  ansi13: "밝은 자홍",
  ansi14: "밝은 청록",
  ansi15: "밝은 흰색",
};

// The table in two lines: the background, the foreground and the 8 colours,
// then the 8 bright ones under the colours.
const TABLE_LINES: TableSlot[][] = [TABLE_SLOTS.slice(0, 10), TABLE_SLOTS.slice(10)];

// The theme's colour table as swatches, one setting: ⏎ goes in, ←→ (↑↓
// between the lines) move between swatches, ⏎ opens one's colour picker and
// ⌫ puts a picked one back to the theme's; ⌫ on the row puts them all back.
export function ColorTableRow({
  theme,
  picks,
  onPick,
}: {
  theme: Theme;
  picks: TablePicks;
  onPick(slots: TableSlot[], color: string | null): void;
}) {
  const table = themeTable(theme);
  function onSwatchKey(event: ReactKeyboardEvent<HTMLInputElement>, slot: TableSlot, line: number, column: number): void {
    if (event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.click();
    } else if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      if (picks[slot] !== undefined) {
        onPick([slot], null);
      }
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      // The bright line sits under the colours, two columns in.
      const target = TABLE_LINES[line === 0 ? 1 : 0][line === 0 ? column - 2 : column + 2];
      const swatch =
        (line === 0) === (event.key === "ArrowDown") && target !== undefined
          ? event.currentTarget.closest(".color-table")?.querySelector<HTMLInputElement>(`[data-slot="${target}"]`)
          : null;
      if (swatch) {
        event.preventDefault();
        event.stopPropagation();
        swatch.focus();
      }
    }
  }
  return (
    <SettingRow
      label="색 표"
      hint={t("{theme}에만 저장됩니다.", { theme: t(theme.label) })}
      keywords="color colour table palette ansi terminal tern 16 팔레트 터미널"
      wide
      changed={Object.keys(picks).length > 0}
      onReset={() => onPick(TABLE_SLOTS, null)}
    >
      <div className="color-table">
        {TABLE_LINES.map((slots, line) => (
          <div key={line} className={`color-table-line${line === 1 ? " bright" : ""}`}>
            {slots.map((slot, column) => {
              const color = picks[slot] ?? table[slot];
              const uses = slotUses(slot, theme.mode).map((use) => t(use));
              return (
                <label key={slot} className={`color-table-cell${picks[slot] !== undefined ? " picked" : ""}`}>
                  <input
                    type="color"
                    data-slot={slot}
                    aria-label={`${t(SLOT_NAMES[slot])} ${color}`}
                    title={`${t(SLOT_NAMES[slot])} ${color} — ${uses.join(", ")}`}
                    value={color}
                    onChange={(event) => onPick([slot], event.target.value)}
                    onKeyDown={(event) => onSwatchKey(event, slot, line, column)}
                  />
                  <span className="color-table-name">{slot.startsWith("ansi") ? slot.slice(4) : t(SLOT_NAMES[slot])}</span>
                </label>
              );
            })}
          </div>
        ))}
      </div>
    </SettingRow>
  );
}

// Every part the SQL editor colours, and letters that look alike in a font.
const EDITOR_SAMPLE = [
  "-- comment · 0O 1lI",
  "SELECT id, \"Name\", `code`, count(*) AS total, NULL, TRUE",
  "FROM users WHERE email LIKE '%@example.com' AND age >= 30;",
].join("\n");

// The SQL editor, drawn as the editor draws it: the live app may have no
// editor open. Not shown among search results.
export function EditorPreview() {
  const scope = useContext(ScopeContext);
  if (scope.terms.length > 0) {
    return null;
  }
  return (
    <section className="settings-group">
      <h4>{t("미리보기")}</h4>
      <div className="settings-preview" aria-hidden="true">
        <SqlPreview doc={EDITOR_SAMPLE} />
      </div>
    </section>
  );
}
