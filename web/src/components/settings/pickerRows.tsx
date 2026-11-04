import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { t } from "../../i18n";
import { THEMES, type Theme, type ThemeId } from "../../palette";
import { fontListLabel, pickedFace, SYSTEM_FONT_CHOICES, type FontGroup } from "../../fonts";
import { previewSettings, type AppSettings } from "../../settings";
import { ChevronDownIcon } from "../icons";
import { Select } from "../Select";
import { Picker, type PickerItem } from "./Picker";
import { SettingRow } from "./rows";

// The settings rows that open a picker (a theme, a font), and the sizes
// beside the fonts. Each draws the app with the choice highlighted in its
// menu (the settings `preview` makes of it) until one is picked or the menu
// closes.

// A row's picker button and whether its picker is open. Closing it puts the
// keys back on the row, as Esc from any control does (not after a click
// elsewhere, which took them).
function usePicker() {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const close = (refocus: boolean): void => {
    setOpen(false);
    if (refocus) {
      buttonRef.current?.closest<HTMLElement>("[data-row]")?.focus();
    }
  };
  return { buttonRef, open, setOpen, close };
}

// A theme in small: its background and side panel, its ink and accent.
function ThemeSwatch({ theme }: { theme: Theme }) {
  const { palette } = theme;
  return (
    <span className="theme-swatch" aria-hidden="true" style={{ background: palette.bg, borderColor: palette.line }}>
      <span className="theme-swatch-panel" style={{ background: palette.panel }} />
      <span className="theme-swatch-dot" style={{ background: palette.ink }} />
      <span className="theme-swatch-dot" style={{ background: theme.accent }} />
      <span className="theme-swatch-dot" style={{ background: palette.typeInks?.string ?? palette.ok }} />
    </span>
  );
}

// The theme of one mode (light or dark): a button showing it, opening the
// themes of that mode, TablePeek's then Tern's then those imported from
// Tern theme files (removable there), and the import itself.
export function ThemeRow({
  label,
  mode,
  value,
  defaultValue,
  tern,
  onPick,
  preview,
  onImport,
  onRemove,
}: {
  label: string;
  mode: "light" | "dark";
  value: ThemeId;
  defaultValue: ThemeId;
  // Whether Tern's themes are in yet.
  tern: "loading" | "ready" | "failed";
  onPick(id: ThemeId): void;
  preview(id: ThemeId): Partial<AppSettings>;
  onImport(file: File): void;
  onRemove(theme: Theme): void;
}) {
  const { buttonRef, open, setOpen, close } = usePicker();
  const fileRef = useRef<HTMLInputElement>(null);
  const theme = THEMES.find((item) => item.id === value);
  const byLabel = (a: Theme, b: Theme): number => a.label.localeCompare(b.label, "en");
  const ofMode = THEMES.filter((item) => item.mode === mode);
  const entry = (item: Theme, group?: string, removable = false): PickerItem => ({
    value: item.id,
    label: t(item.label),
    group,
    swatch: <ThemeSwatch theme={item} />,
    selected: item.id === value,
    onRemove: removable ? () => onRemove(item) : undefined,
  });
  // TablePeek's own themes first, then Tern's, in one list; only themes
  // imported from files are set apart.
  const items: PickerItem[] = [
    ...ofMode.filter((item) => !item.group && !item.imported).map((item) => entry(item)),
    ...ofMode
      .filter((item) => item.group === "tern" && !item.imported)
      .sort(byLabel)
      .map((item) => entry(item)),
    ...ofMode
      .filter((item) => item.imported)
      .sort(byLabel)
      .map((item) => entry(item, t("가져온 테마"), true)),
  ];
  return (
    <SettingRow
      label={label}
      keywords="theme tern"
      changed={value !== defaultValue}
      onReset={() => onPick(defaultValue)}
    >
      <button
        ref={buttonRef}
        type="button"
        className="settings-picker-button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${t(label)}: ${theme ? t(theme.label) : value}`}
        onClick={() => setOpen((was) => !was)}
      >
        {theme ? <ThemeSwatch theme={theme} /> : null}
        <span className="settings-picker-value">{theme ? t(theme.label) : value}</span>
        <ChevronDownIcon size={10} />
      </button>
      {open && buttonRef.current !== null ? (
        <Picker
          anchor={buttonRef.current}
          label={t(label)}
          items={items}
          actions={[{ label: t("Tern 테마 파일 가져오기…"), run: () => fileRef.current?.click() }]}
          note={
            tern === "loading"
              ? t("Tern 테마를 불러오는 중…")
              : tern === "failed"
                ? t("Tern 테마를 불러오지 못했습니다.")
                : null
          }
          onPick={(id) => {
            close(true);
            onPick(id);
          }}
          onPreview={(id) => previewSettings(id === null ? null : preview(id))}
          onClose={close}
        />
      ) : null}
      {/* Outside the row's controls: the row's ⏎ opens the picker. */}
      {createPortal(
        <input
          ref={fileRef}
          type="file"
          accept=".css,text/css"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file !== undefined) {
              close(true);
              onImport(file);
            }
          }}
        />,
        document.body,
      )}
    </SettingRow>
  );
}

// A font: a button showing it, opening "follow" (what "" draws), the
// system's faces and every installed one. A face picked before its family
// changed (its bold installed or removed, say) is still that face: its saved
// list is brought up to date; a saved list no longer offered shows under its
// first family's name.
export function FontRow({
  label,
  keywords,
  hint,
  value,
  follow,
  groups,
  onChange,
  preview,
}: {
  label: string;
  keywords: string;
  hint?: string;
  value: string;
  // What "" draws: its name, and the system face it is, not offered twice.
  follow: { label: string; value?: string };
  groups: FontGroup[];
  onChange(value: string): void;
  preview(value: string): Partial<AppSettings>;
}) {
  const { buttonRef, open, setOpen, close } = usePicker();
  const systems = SYSTEM_FONT_CHOICES.filter((choice) => choice.value !== follow.value);
  const choices = [...systems, ...groups.flatMap((group) => group.choices)];
  const choice = choices.find((item) => item.value === value);
  const face = value === "" || choice !== undefined ? null : pickedFace(value);
  const updated = face === null ? undefined : choices.find((item) => pickedFace(item.value) === face)?.value;
  useEffect(() => {
    if (updated !== undefined) {
      onChange(updated);
    }
    // onChange is a new function each render; the update is all that matters.
  }, [updated]);
  const shown = value === "" ? follow.label : choice !== undefined ? t(choice.label) : fontListLabel(value);
  const items: PickerItem[] = [
    { value: "", label: follow.label, selected: value === "" },
    ...(value === "" || choice !== undefined || updated !== undefined ? [] : [{ value, label: shown, selected: true }]),
    ...systems.map((item) => ({ value: item.value, label: t(item.label), group: t("시스템"), selected: item.value === value })),
    ...groups.flatMap((group) =>
      group.choices.map((item) => ({
        value: item.value,
        label: item.label,
        group: t(group.label),
        selected: item.value === value,
      })),
    ),
  ];
  return (
    <SettingRow label={label} keywords={keywords} hint={hint} changed={value !== ""} onReset={() => onChange("")}>
      <button
        ref={buttonRef}
        type="button"
        className={`settings-picker-button settings-font-button${value === "" ? " follows" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${t(label)}: ${shown}`}
        style={value === "" ? undefined : { fontFamily: value }}
        onClick={() => setOpen((was) => !was)}
      >
        <span className="settings-picker-value">{shown}</span>
        <ChevronDownIcon size={10} />
      </button>
      {open && buttonRef.current !== null ? (
        <Picker
          anchor={buttonRef.current}
          label={t(label)}
          items={items}
          onPick={(picked) => {
            close(true);
            onChange(picked);
          }}
          onPreview={(highlighted) => previewSettings(highlighted === null ? null : preview(highlighted))}
          onClose={close}
        />
      ) : null}
    </SettingRow>
  );
}

// A font's size: whole px (a list, so a size never lands half typed, plus
// the current one if older settings saved one off the steps), and first
// "follow" for a size that follows another (`follows`, the size it is then).
export function SizeRow({
  label,
  keywords,
  value,
  follows,
  min,
  max,
  defaultValue,
  onChange,
  preview,
}: {
  label: string;
  keywords: string;
  value: number | null;
  follows: number | null;
  min: number;
  max: number;
  defaultValue: number | null;
  onChange(size: number | null): void;
  preview(size: number | null): Partial<AppSettings>;
}) {
  const sizes = Array.from({ length: max - min + 1 }, (_, index) => min + index);
  if (value !== null && !sizes.includes(value)) {
    sizes.push(value);
    sizes.sort((a, b) => a - b);
  }
  return (
    <SettingRow label={label} keywords={keywords} changed={value !== defaultValue} onReset={() => onChange(defaultValue)}>
      <Select
        aria-label={t(label)}
        value={value === null ? "" : String(value)}
        onChange={(event) => onChange(event.target.value === "" ? null : Number(event.target.value))}
        onPreview={(picked) =>
          previewSettings(picked === null ? null : preview(picked === "" ? null : Number(picked)))
        }
      >
        {follows !== null ? <option value="">{t("따름 · {size}px", { size: follows })}</option> : null}
        {sizes.map((size) => (
          <option key={size} value={size}>
            {size}px
          </option>
        ))}
      </Select>
    </SettingRow>
  );
}
