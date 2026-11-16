import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { bothLanguages, t } from "../../i18n";
import { ChevronIcon, MinusIcon, PlusIcon } from "../icons";
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
    row.querySelectorAll<HTMLElement>(
      ":is(.settings-row-action, .settings-row-control) :is(input, select, textarea, button, a[href])",
    ),
  ).filter((control) => !(control as HTMLInputElement).disabled);
}

// ⏎ or Space on a row: a lone switch flips, a menu or a picker opens, a
// field or a colour takes it; a row of several controls is gone into, at
// its slider or its number field if it has one, else its first.
function activateRow(row: HTMLElement): void {
  const controls = rowControls(row);
  const control = controls[0];
  if (control === undefined) {
    return;
  }
  if (controls.length > 1) {
    const range = controls.find((each) => each instanceof HTMLInputElement && each.type === "range");
    const field = controls.find((each): each is HTMLInputElement => each instanceof HTMLInputElement && each.classList.contains("settings-stepper-input"));
    (range ?? field ?? control).focus();
    if (range === undefined && field !== undefined) {
      field.select();
    }
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

// A titled run of rows (`title` a message key), with a note under its title
// and `action`, a control for the whole group, beside it.
export function SettingsGroup({
  title,
  hint,
  action,
  children,
}: {
  title?: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const scope = useContext(ScopeContext);
  return (
    <ScopeContext.Provider value={{ ...scope, group: title ? bothLanguages(title) : "" }}>
      <section className="settings-group">
        {action !== undefined ? <div className="settings-group-action">{action}</div> : null}
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
// row). `status` follows the name on its line and `action` ends that line
// (a connection's state and its one action). Rows not matching the search
// aren't drawn.
export function SettingRow({
  label,
  hint,
  keywords,
  changed = false,
  wide = false,
  muted = false,
  status,
  action,
  onReset,
  onActivate,
  children,
}: {
  label: string;
  hint?: string | null;
  keywords?: string;
  changed?: boolean;
  wide?: boolean;
  // Not usable yet (coming soon): shown faint, still found and read.
  muted?: boolean;
  status?: ReactNode;
  action?: ReactNode;
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
      className={`settings-row${wide ? " wide" : ""}${muted ? " muted" : ""}`}
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
          {/* The name, with its dot and Reset after its last word however it wraps. */}
          <span className="settings-row-name">
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
          </span>
          {status}
          {action !== undefined ? <span className="settings-row-action">{action}</span> : null}
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

// The workings shared by every number in Settings: − and + (or ▲ and ▼)
// that step once on a press (ten steps with Shift) and, held down, keep
// stepping, faster the longer they are held, until let go or the range ends;
// ↑ and ↓ in the field doing the same; and the field taking a number typed
// in, set on ⏎ or leaving it, kept in range, Esc putting back the value.
// `value` null: the setting follows another (`follows`, its value now); a
// step starts from there, and emptying the field goes back to following.
function useNumberSteps({
  value,
  follows = null,
  min,
  max,
  step = 1,
  onChange,
}: {
  value: number | null;
  follows?: number | null;
  min: number;
  max: number;
  step?: number;
  onChange(value: number | null): void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // The value and onChange as of the last render, for steps taken while a
  // button is held (the timer outlives the render that started it).
  const shown = value ?? follows ?? min;
  const latest = useRef({ value: shown, onChange });
  latest.current = { value: shown, onChange };
  const hold = useRef<number | null>(null);
  const clamp = (next: number) => Math.min(max, Math.max(min, Math.round(next)));
  // Steps by `by` steps; false once the range ends (a held button stops).
  const stepBy = (by: number): boolean => {
    const next = clamp(latest.current.value + by * step);
    if (next === latest.current.value && value !== null) {
      return false;
    }
    latest.current.value = next;
    latest.current.onChange(next);
    return next !== min && next !== max;
  };
  // One function for the life of the control, so the window listeners it
  // adds come off again.
  const stopHold = useCallback(function stopHold() {
    if (hold.current !== null) {
      window.clearTimeout(hold.current);
      hold.current = null;
    }
    window.removeEventListener("pointerup", stopHold);
    window.removeEventListener("blur", stopHold);
  }, []);
  useEffect(() => stopHold, [stopHold]);
  // A press steps at once; held past 400 ms it repeats, every 90 ms at first
  // and down to every 30 ms, until it is let go (anywhere: the button turns
  // disabled at the end of the range and hears nothing more) or the range
  // ends.
  const startHold = (event: ReactPointerEvent<HTMLButtonElement>, by: number) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const amount = event.shiftKey ? by * 10 : by;
    stopHold();
    if (!stepBy(amount)) {
      return;
    }
    window.addEventListener("pointerup", stopHold);
    window.addEventListener("blur", stopHold);
    let delay = 90;
    const repeat = () => {
      if (!stepBy(amount)) {
        stopHold();
        return;
      }
      delay = Math.max(30, delay * 0.9);
      hold.current = window.setTimeout(repeat, delay);
    };
    hold.current = window.setTimeout(repeat, 400);
  };
  // `focusable` false: ▲ and ▼ beside a field, which ↑ and ↓ in it do.
  const stepButton = (by: 1 | -1, name: string, icon: ReactNode, className = "settings-step", focusable = true) => (
    <button
      type="button"
      className={className}
      aria-label={name}
      title={`${name} (${t("Shift: 10배")})`}
      tabIndex={focusable ? undefined : -1}
      disabled={by < 0 ? shown <= min : shown >= max}
      onPointerDown={(event) => startHold(event, by)}
      onPointerUp={stopHold}
      onPointerCancel={stopHold}
      // The keyboard's ⏎ and Space (a pointer press steps on pointerdown).
      onClick={(event) => {
        if (event.detail === 0) {
          stepBy(event.shiftKey ? by * 10 : by);
        }
      }}
    >
      {icon}
    </button>
  );
  const commit = () => {
    if (draft !== null) {
      const text = draft.trim();
      const typed = Number(text);
      if (text === "" && follows !== null) {
        onChange(null);
      } else if (text !== "" && Number.isFinite(typed)) {
        onChange(clamp(typed));
      }
    }
    setDraft(null);
  };
  const fieldProps = {
    type: "text",
    inputMode: "numeric" as const,
    spellCheck: false,
    autoComplete: "off",
    value: draft ?? (value === null ? "" : String(value)),
    placeholder: value === null && follows !== null ? String(follows) : undefined,
    onChange: (event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value.replace(/[^\d-]/g, "")),
    onKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape" && draft !== null) {
        // The field's own Esc: put the value back, stay in the field.
        event.preventDefault();
        event.stopPropagation();
        setDraft(null);
      } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        setDraft(null);
        const by = event.key === "ArrowUp" ? 1 : -1;
        stepBy(event.shiftKey ? by * 10 : by);
      } else if (event.key === "Enter") {
        commit();
      }
    },
    onBlur: commit,
  };
  return { shown, stepButton, fieldProps };
}

// A slider with − and + beside it and its value in a field that takes a
// number typed in (see useNumberSteps).
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
  const { stepButton, fieldProps } = useNumberSteps({ value, min: 0, max, onChange: (next) => onChange(next ?? 0) });
  return (
    <span className="settings-slider">
      {stepButton(-1, t("{label} 줄이기", { label }), <MinusIcon size={10} />)}
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
      {stepButton(1, t("{label} 늘리기", { label }), <PlusIcon size={10} />)}
      <span className="settings-range-value">
        <input {...fieldProps} className="settings-range-input settings-stepper-input mono" aria-label={t("{label} 값", { label })} />
        <span className="settings-range-unit mono">{unit}</span>
      </span>
    </span>
  );
}

// A number: a field that takes it typed in, with ▲ and ▼ beside it (see
// useNumberSteps). `follows`: the value it shows while it follows another
// setting (value null), marked as such; emptying the field follows again.
export function Stepper({
  label,
  value,
  follows = null,
  min,
  max,
  step = 1,
  unit,
  onChange,
}: {
  label: string;
  value: number | null;
  follows?: number | null;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange(value: number | null): void;
}) {
  const { stepButton, fieldProps } = useNumberSteps({ value, follows, min, max, step, onChange });
  return (
    <span className={`settings-stepper${value === null && follows !== null ? " follows" : ""}`}>
      {value === null && follows !== null ? <span className="settings-stepper-follow">{t("따름")}</span> : null}
      <input {...fieldProps} className="settings-stepper-input mono" aria-label={t(label)} />
      {unit !== undefined ? <span className="settings-stepper-unit mono">{unit}</span> : null}
      <span className="settings-stepper-buttons">
        {stepButton(1, t("{label} 늘리기", { label: t(label) }), <ChevronIcon size={9} className="up" />, "settings-stepper-button", false)}
        {stepButton(-1, t("{label} 줄이기", { label: t(label) }), <ChevronIcon size={9} className="down" />, "settings-stepper-button", false)}
      </span>
    </span>
  );
}
