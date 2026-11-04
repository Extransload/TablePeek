import { createContext, useContext, useId, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { bothLanguages, t } from "../../i18n";
import { openSelect } from "../Select";

// The rows of Settings (see SettingsSheet): a name on the left and a
// control on the right, in titled groups, and what the search matches them by.

// Fields whose keys (letters, arrows) are their own while they have focus.
const FIELD_TYPES: Record<string, true> = {
  text: true,
  number: true,
  password: true,
  search: true,
  email: true,
  url: true,
  tel: true,
  range: true,
};

export function isField(element: Element): boolean {
  return (
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement && Object.hasOwn(FIELD_TYPES, element.type)) ||
    (element instanceof HTMLElement && element.isContentEditable)
  );
}

// A row's controls, in order, that can be used now.
export function rowControls(row: HTMLElement): HTMLElement[] {
  return Array.from(
    row.querySelectorAll<HTMLElement>(".settings-row-control :is(input, select, textarea, button, a[href])"),
  ).filter((control) => !(control as HTMLInputElement).disabled);
}

// ⏎ or Space on a row: a lone switch flips, a menu or a picker opens, a
// field or a colour takes it; a row of several controls is gone into, at
// its first.
function activateRow(row: HTMLElement): void {
  const controls = rowControls(row);
  const control = controls[0];
  if (control === undefined) {
    return;
  }
  if (controls.length > 1) {
    control.focus();
  } else if (control instanceof HTMLSelectElement) {
    openSelect(control);
  } else if (control instanceof HTMLInputElement && (control.type === "checkbox" || control.type === "color")) {
    control.click();
  } else if (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement) {
    control.focus();
    if (control.type !== "range") {
      control.select();
    }
  } else {
    control.click();
  }
}

export function focusRow(row: HTMLElement): void {
  row.focus({ preventScroll: true });
  row.scrollIntoView({ block: "nearest" });
}

// What the rows inside are matched against while searching: the words
// typed, and the page and group they are in (in both languages).
interface Scope {
  terms: string[];
  page: string;
  group: string;
}

export const ScopeContext = createContext<Scope>({ terms: [], page: "", group: "" });

// Whether a row whose own words (its name, note and keywords, and its
// group's title) are `own` is found: every word typed is on its page or in
// its own words, and one at least in its own, so a page's name alone
// offers the page rather than every row on it.
export function rowFound(scope: Scope, own: string): boolean {
  const mine = own.toLowerCase();
  const where = `${scope.page} ${mine}`.toLowerCase();
  return scope.terms.every((term) => where.includes(term)) && scope.terms.some((term) => mine.includes(term));
}

// `text` with the words searched for marked.
export function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (terms.length === 0) {
    return <>{text}</>;
  }
  const lower = text.toLowerCase();
  const marked = new Array<boolean>(text.length).fill(false);
  for (const term of terms) {
    for (let at = lower.indexOf(term); at >= 0; at = lower.indexOf(term, at + term.length)) {
      marked.fill(true, at, at + term.length);
    }
  }
  const parts: ReactNode[] = [];
  let start = 0;
  for (let index = 1; index <= text.length; index += 1) {
    if (index === text.length || marked[index] !== marked[start]) {
      const part = text.slice(start, index);
      parts.push(marked[start] ? <mark key={start}>{part}</mark> : part);
      start = index;
    }
  }
  return <>{parts}</>;
}

// A titled run of rows (`title` a message key), with a note under its title.
export function SettingsGroup({ title, hint, children }: { title?: string; hint?: string; children: ReactNode }) {
  const scope = useContext(ScopeContext);
  return (
    <ScopeContext.Provider value={{ ...scope, group: title ? bothLanguages(title) : "" }}>
      <section className="settings-group">
        {title ? <h4>{t(title)}</h4> : null}
        {hint ? <p className="settings-hint settings-group-hint">{hint}</p> : null}
        <div className="settings-box">{children}</div>
      </section>
    </ScopeContext.Provider>
  );
}

// One setting: its name (`label`, a message key, found in either language)
// and a note under it on the left, its control on the right, or under it
// when `wide`. Changed from its default, it shows a dot and Reset (⌫ on the
// row). Rows not matching the search aren't drawn.
export function SettingRow({
  label,
  hint,
  keywords,
  changed = false,
  wide = false,
  onReset,
  onActivate,
  children,
}: {
  label: string;
  hint?: string | null;
  keywords?: string;
  changed?: boolean;
  wide?: boolean;
  onReset?(): void;
  // ⏎ or Space on the row, instead of its control's own (a choice steps).
  onActivate?(): void;
  children: ReactNode;
}) {
  const scope = useContext(ScopeContext);
  const id = useId();
  if (scope.terms.length > 0 && !rowFound(scope, [scope.group, bothLanguages(label), hint ?? "", keywords ?? ""].join(" "))) {
    return null;
  }
  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (onActivate) {
        onActivate();
      } else {
        activateRow(event.currentTarget);
      }
    } else if ((event.key === "Backspace" || event.key === "Delete") && changed && onReset) {
      event.preventDefault();
      onReset();
    }
  }
  return (
    <div
      className={`settings-row${wide ? " wide" : ""}`}
      data-row=""
      data-changed={changed ? "" : undefined}
      tabIndex={-1}
      role="group"
      aria-labelledby={`${id}-label`}
      aria-describedby={hint ? `${id}-hint` : undefined}
      onKeyDown={onKeyDown}
    >
      <div className="settings-row-text">
        <div className="settings-row-title">
          <span className="settings-row-label" id={`${id}-label`}>
            <Highlight text={t(label)} terms={scope.terms} />
          </span>
          {changed ? (
            <>
              <span className="settings-row-dot" title={t("기본값에서 바뀜")} aria-label={t("기본값에서 바뀜")} />
              {onReset ? (
                <button type="button" className="settings-row-reset" tabIndex={-1} onClick={onReset}>
                  {t("재설정")}
                </button>
              ) : null}
            </>
          ) : null}
        </div>
        {hint ? (
          <p className="settings-hint" id={`${id}-hint`}>
            {hint}
          </p>
        ) : null}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

// A few choices side by side; ⏎ on the row steps to the next.
export function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange(value: T): void;
}) {
  return (
    <div className="segmented settings-choice" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className={value === option.value ? "active" : ""}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function nextChoice<T extends string>(options: { value: T }[], value: T): T {
  const index = options.findIndex((option) => option.value === value);
  return options[(index + 1) % options.length].value;
}

export function Switch({
  label,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange(checked: boolean): void;
}) {
  return (
    <input
      type="checkbox"
      role="switch"
      className="settings-switch"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

// A slider and the value it is at.
export function Slider({
  label,
  value,
  max,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  max: number;
  unit: string;
  onChange(value: number): void;
}) {
  return (
    <>
      <input
        type="range"
        className="settings-range"
        aria-label={label}
        min={0}
        max={max}
        step={1}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="settings-range-value mono">
        {value}
        {unit}
      </span>
    </>
  );
}
