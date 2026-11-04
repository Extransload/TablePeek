import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { DURATION, EASE, animate } from "../motion";

// A number in the text: its digits and the separators between them
// ("1,126", "0.25").
const RUN = /\d(?:[\d,.]*\d)?/g;

interface Parsed {
  // The words around the numbers: one more than there are numbers.
  texts: string[];
  runs: string[];
}

function parse(value: string): Parsed {
  const texts: string[] = [];
  const runs: string[] = [];
  let last = 0;
  for (const match of value.matchAll(RUN)) {
    const at = match.index ?? 0;
    texts.push(value.slice(last, at));
    runs.push(match[0]);
    last = at + match[0].length;
  }
  texts.push(value.slice(last));
  return { texts, runs };
}

interface Shown {
  value: string;
  // What it said before the latest change; null until it first changes.
  previous: string | null;
}

// A count or timing whose changes roll: only the digits that differ turn over,
// upward when the number grows and downward when it shrinks, the higher places
// a beat after the lower ones. Text around the numbers stays put; when the
// words themselves change, the whole value comes into focus instead. Screen
// readers get the plain text; under reduced motion it simply changes.
export function RollingNumber({ value, className }: { value: string | number; className?: string }) {
  const text = typeof value === "number" ? value.toLocaleString() : value;
  const faceRef = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState<Shown>(() => ({ value: text, previous: null }));
  let current = shown;
  if (shown.value !== text) {
    current = { value: text, previous: shown.value };
    setShown(current);
  }

  const next = parse(current.value);
  const before = current.previous === null ? null : parse(current.previous);
  // Digits line up only when the words around them are the same.
  const matched =
    before !== null &&
    before.runs.length === next.runs.length &&
    before.texts.every((part, index) => part === next.texts[index]);

  useLayoutEffect(() => {
    const face = faceRef.current;
    if (face === null || current.previous === null) {
      return;
    }
    if (!matched) {
      for (const running of face.getAnimations()) {
        running.cancel();
      }
      animate(
        face,
        [
          { opacity: 0, transform: "translateY(0.3em)", filter: "blur(3px)" },
          { opacity: 1, transform: "none", filter: "blur(0)" },
        ],
        { duration: DURATION.slow, easing: EASE.out },
      );
      return;
    }
    // Read nothing, write transforms only: each turning digit's strip starts a
    // cell away and settles, and the digit it replaces fades on its way out.
    for (const strip of face.querySelectorAll<HTMLElement>(".rolling-strip[data-roll]")) {
      for (const running of strip.getAnimations({ subtree: true })) {
        running.cancel();
      }
      const delay = Math.min(Number(strip.dataset.place ?? "0"), 5) * 28;
      const from = strip.dataset.roll === "up" ? "translateY(100%)" : "translateY(-100%)";
      animate(strip, [{ transform: from }, { transform: "none" }], {
        duration: DURATION.spring,
        easing: EASE.spring,
        delay,
        fill: "backwards",
      });
      const old = strip.lastElementChild;
      if (old !== null) {
        animate(old, [{ opacity: 1 }, { opacity: 0 }], { duration: DURATION.slow, easing: EASE.out, delay });
      }
    }
  }, [current, matched]);

  const parts: ReactNode[] = [];
  for (let index = 0; index < next.texts.length; index += 1) {
    const part = next.texts[index];
    if (part !== "") {
      parts.push(<span key={`t${index}`}>{part}</span>);
    }
    const run = next.runs[index];
    if (run === undefined) {
      continue;
    }
    const oldRun = matched && before !== null ? before.runs[index] : undefined;
    // Grouping is dropped for the comparison; it only decides which way digits roll.
    const up = oldRun === undefined || Number(run.replace(/,/g, "")) >= Number(oldRun.replace(/,/g, ""));
    // Places count from the right, so "999" → "1,000" keeps its ones in line.
    for (let at = 0; at < run.length; at += 1) {
      const place = run.length - 1 - at;
      const char = run[at];
      const key = `${index}:${place}`;
      if (char < "0" || char > "9") {
        parts.push(<span key={key}>{char}</span>);
        continue;
      }
      const old = oldRun === undefined ? undefined : (oldRun[oldRun.length - 1 - place] ?? "");
      const turns = old !== undefined && old !== char;
      parts.push(
        <span key={key} className="rolling-digit">
          <span
            className="rolling-strip"
            data-roll={turns ? (up ? "up" : "down") : undefined}
            data-place={turns ? place : undefined}
          >
            {char}
            {turns ? <span className="rolling-old">{old}</span> : null}
          </span>
        </span>,
      );
    }
  }

  return (
    <span className={`rolling-number${className ? ` ${className}` : ""}`}>
      <span className="sr-only">{current.value}</span>
      <span ref={faceRef} className="rolling-number-face" aria-hidden="true">
        {parts}
      </span>
    </span>
  );
}
