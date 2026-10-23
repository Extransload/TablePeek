import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CellKind } from "../grid/columns";
import { getLanguage, t } from "../i18n";

interface DatePickerProps {
  kind: CellKind;
  value: unknown;
  nullable: boolean;
  // The cell, in viewport coordinates; the picker opens under it.
  anchor: { left: number; top: number; right: number; bottom: number };
  onPick(value: string | null): void;
  onClose(): void;
}

// A value split the way it was written, so a pick keeps its separator, its
// fraction digits and its zone ("2026-06-16 08:25:00.639739+09").
interface Parts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  fraction: string; // digits after the point, "" for none
  separator: string; // " " or "T"
  zone: string; // "Z", "+09", "+09:00" or ""
}

const VALUE_PATTERN =
  /^(?:(\d{4})-(\d{2})-(\d{2}))?(?:([ T])?(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/;

function parse(value: unknown): Parts | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = VALUE_PATTERN.exec(value.trim());
  if (match === null || (match[1] === undefined && match[5] === undefined)) {
    return null;
  }
  const now = new Date();
  return {
    year: match[1] !== undefined ? Number(match[1]) : now.getFullYear(),
    month: match[2] !== undefined ? Number(match[2]) : now.getMonth() + 1,
    day: match[3] !== undefined ? Number(match[3]) : now.getDate(),
    hour: match[5] !== undefined ? Number(match[5]) : 0,
    minute: match[6] !== undefined ? Number(match[6]) : 0,
    second: match[7] !== undefined ? Number(match[7]) : 0,
    fraction: match[8] ?? "",
    separator: match[4] ?? " ",
    zone: match[9] ?? "",
  };
}

// This browser's offset written the way `like` writes zones: "Z" stays UTC
// (and the time with it), "+09" or "+09:00" become the local offset.
function zoneLike(like: string, date: Date): string {
  if (like === "" || like === "Z") {
    return like;
  }
  const minutes = -date.getTimezoneOffset();
  const sign = minutes < 0 ? "-" : "+";
  const hours = String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0");
  const rest = String(Math.abs(minutes) % 60).padStart(2, "0");
  if (like.includes(":")) {
    return `${sign}${hours}:${rest}`;
  }
  return like.length > 3 || rest !== "00" ? `${sign}${hours}${rest}` : `${sign}${hours}`;
}

function fromDate(when: Date, like: Parts | null): Parts {
  // A value kept in UTC ("…Z") takes now in UTC; one with an offset takes
  // local time with the browser's own offset, so the instant is right.
  const utc = like?.zone === "Z";
  const digits = like?.fraction.length ?? 0;
  const millis = String(when.getMilliseconds()).padStart(3, "0");
  return {
    year: utc ? when.getUTCFullYear() : when.getFullYear(),
    month: (utc ? when.getUTCMonth() : when.getMonth()) + 1,
    day: utc ? when.getUTCDate() : when.getDate(),
    hour: utc ? when.getUTCHours() : when.getHours(),
    minute: utc ? when.getUTCMinutes() : when.getMinutes(),
    second: utc ? when.getUTCSeconds() : when.getSeconds(),
    fraction: digits === 0 ? "" : (millis + "000000").slice(0, digits),
    separator: like?.separator ?? " ",
    zone: zoneLike(like?.zone ?? "", when),
  };
}

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

function format(parts: Parts, kind: CellKind): string {
  const date = `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;
  const time =
    `${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}` +
    (parts.fraction !== "" ? `.${parts.fraction}` : "");
  if (kind === "date") {
    return date;
  }
  if (kind === "time") {
    return time + parts.zone;
  }
  return `${date}${parts.separator}${time}${parts.zone}`;
}

function daysIn(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

const PICKER_W = 260;

// The ⌃⌄ of a date, datetime or time cell: a month to pick the day from and
// the time under it, as TablePlus offers; Return applies, Escape cancels.
export function DatePicker({ kind, value, nullable, anchor, onPick, onClose }: DatePickerProps) {
  const initial = useMemo(() => parse(value) ?? fromDate(new Date(), null), [value]);
  const [parts, setParts] = useState<Parts>(initial);
  const [view, setView] = useState({ year: initial.year, month: initial.month });
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [place, setPlace] = useState<{ left: number; top: number }>({ left: anchor.left, top: anchor.bottom + 2 });
  const showDays = kind !== "time";
  const showTime = kind !== "date";

  // Under the cell, or above it when the window ends first; inside the window.
  useLayoutEffect(() => {
    const height = rootRef.current?.offsetHeight ?? 0;
    const below = anchor.bottom + 2;
    const top = below + height > window.innerHeight - 8 ? Math.max(8, anchor.top - height - 2) : below;
    const left = Math.min(Math.max(8, anchor.left), window.innerWidth - PICKER_W - 8);
    setPlace({ left, top });
  }, [anchor]);

  const apply = (): void => onPick(format(parts, kind));

  // Keys go to the picker, not the grid under it.
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      } else if (
        event.key === "Enter" &&
        !event.isComposing &&
        // A focused footer button (Cancel, NULL, Now) answers Return itself.
        !(event.target instanceof Element && event.target.closest(".date-picker-foot") !== null)
      ) {
        event.preventDefault();
        event.stopPropagation();
        apply();
      }
    }
    function onPointerDown(event: PointerEvent): void {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  });

  const locale = getLanguage() === "ko" ? "ko-KR" : "en-US";
  const monthLabel = new Date(view.year, view.month - 1, 1).toLocaleDateString(locale, {
    year: "numeric",
    month: "long",
  });
  const weekdays = Array.from({ length: 7 }, (_, index) =>
    new Date(2024, 0, 7 + index).toLocaleDateString(locale, { weekday: "narrow" }),
  );
  const lead = new Date(view.year, view.month - 1, 1).getDay();
  const count = daysIn(view.year, view.month);
  const today = new Date();

  function shiftMonth(step: number): void {
    setView((current) => {
      const index = current.year * 12 + (current.month - 1) + step;
      return { year: Math.floor(index / 12), month: (index % 12) + 1 };
    });
  }

  function pickDay(day: number): void {
    setParts((current) => ({ ...current, year: view.year, month: view.month, day }));
  }

  function setTime(field: "hour" | "minute" | "second", text: string, max: number): void {
    const number = Number.parseInt(text, 10);
    if (Number.isNaN(number)) {
      return;
    }
    setParts((current) => ({ ...current, [field]: Math.min(max, Math.max(0, number)) }));
  }

  return createPortal(
    <div
      ref={rootRef}
      className="date-picker"
      tabIndex={-1}
      role="dialog"
      aria-label={t("날짜 선택")}
      style={{ left: place.left, top: place.top, width: PICKER_W }}
    >
      {showDays ? (
        <>
          <div className="date-picker-head">
            <button
              type="button"
              className="icon-button"
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              aria-label={t("이전 달")}
              onClick={() => shiftMonth(-1)}
            >
              ‹
            </button>
            <span className="date-picker-month">{monthLabel}</span>
            <button
              type="button"
              className="icon-button"
              tabIndex={-1}
              onMouseDown={(event) => event.preventDefault()}
              aria-label={t("다음 달")}
              onClick={() => shiftMonth(1)}
            >
              ›
            </button>
          </div>
          <div className="date-picker-grid">
            {weekdays.map((label, index) => (
              <span className="date-picker-weekday" key={`w${index}`}>
                {label}
              </span>
            ))}
            {Array.from({ length: lead }, (_, index) => (
              <span key={`b${index}`} />
            ))}
            {Array.from({ length: count }, (_, index) => {
              const day = index + 1;
              const picked = parts.year === view.year && parts.month === view.month && parts.day === day;
              const isToday =
                today.getFullYear() === view.year && today.getMonth() + 1 === view.month && today.getDate() === day;
              return (
                <button
                  type="button"
                  key={day}
                  // Clicks don't take focus, so Return still applies the pick.
                  tabIndex={-1}
                  onMouseDown={(event) => event.preventDefault()}
                  className={`date-picker-day${picked ? " picked" : ""}${isToday ? " today" : ""}`}
                  onClick={() => pickDay(day)}
                  onDoubleClick={() => onPick(format({ ...parts, year: view.year, month: view.month, day }, kind))}
                >
                  {day}
                </button>
              );
            })}
          </div>
        </>
      ) : null}
      {showTime ? (
        <div className="date-picker-time">
          {(
            [
              ["hour", 23],
              ["minute", 59],
              ["second", 59],
            ] as const
          ).map(([field, max], index) => (
            <span key={field} className="date-picker-time-part">
              {index > 0 ? <span className="date-picker-colon">:</span> : null}
              <input
                aria-label={t(field === "hour" ? "시" : field === "minute" ? "분" : "초")}
                inputMode="numeric"
                value={pad(parts[field])}
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => setTime(field, event.target.value.slice(-2), max)}
              />
            </span>
          ))}
          {parts.fraction !== "" ? <span className="date-picker-fraction">.{parts.fraction}</span> : null}
        </div>
      ) : null}
      <div className="date-picker-foot">
        <button type="button" onClick={() => onPick(format(fromDate(new Date(), initial), kind))}>
          {t("지금")}
        </button>
        {nullable ? (
          <button type="button" onClick={() => onPick(null)}>
            NULL
          </button>
        ) : null}
        <span className="spacer" />
        <button type="button" onClick={onClose}>
          {t("취소")}
        </button>
        <button type="button" className="primary" onClick={apply}>
          {t("적용")}
        </button>
      </div>
    </div>,
    document.body,
  );
}
