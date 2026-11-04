import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import { DURATION, EASE, reducedMotion, subscribeMotion } from "../motion";

// Loading as a gauge: the box that is waiting fills from the left, behind its
// contents, in its own colour (--gauge-color on it or an ancestor; the accent
// otherwise). The host needs `gauge-host` (positioned, its own stacking
// context); the fill takes its corners.
//
// Without a value the fill runs a curve toward 90%: quick at first, then
// slower and slower without ever stopping, its leading edge shimmering. With
// one (0–1) it follows it. When the work ends it races to full and fades
// (done), flashes the error colour and drains (failed) or just drains
// (cancelled). Only transform and opacity move. A wait shorter than
// --loading-delay shows nothing; under Reduce motion a busy box is half
// tinted, without movement, until the work ends.

export type GaugeOutcome = "ok" | "error" | "cancel";

// The same as --loading-delay in styles.css: a wait shorter than this shows
// no gauge at all.
export const LOADING_DELAY = 200;
const CEILING = 0.9;
const CURVE_SECONDS = 120;

// Where the curve is t seconds in: ~41% after a second, ~66% after three,
// ~82% after ten, still creeping at a minute.
function curve(t: number): number {
  return CEILING * (1 - Math.pow(1 + t / 1.5, -1.2));
}

function curveTime(p: number): number {
  const clamped = Math.min(Math.max(p, 0), CEILING * 0.995);
  return 1.5 * (Math.pow(1 - clamped / CEILING, -1 / 1.2) - 1);
}

function at(p: number): string {
  return `translateX(${((p - 1) * 100).toFixed(3)}%)`;
}

const SAMPLES = [0, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32, 45, 60, 90, 120];
const CURVE_FRAMES: Keyframe[] = SAMPLES.map((t) => ({ offset: t / CURVE_SECONDS, transform: at(curve(t)) }));

// One stretch of work: when it began, and how far ahead of the clock steps
// have pushed the curve (in seconds).
interface Run {
  start: number;
  shift: number;
}

// Runs by gauge id, so a gauge shown again (a tab strip switched back to)
// carries on where the work has got instead of starting over.
const runs = new Map<string, Run>();

function curveNow(run: Run): number {
  return (performance.now() - run.start) / 1000 + run.shift;
}

class GaugeMotion {
  private fillAnim: Animation | null = null;
  private fadeAnim: Animation | null = null;
  private gen = 0;

  constructor(
    private readonly root: HTMLElement,
    private readonly fill: HTMLElement,
    private readonly flash: HTMLElement,
  ) {}

  // How full the gauge is now, mid-animation included.
  private position(): number {
    const width = this.fill.offsetWidth;
    if (width === 0) {
      return 0;
    }
    try {
      const matrix = new DOMMatrixReadOnly(getComputedStyle(this.fill).transform);
      return Math.min(1, Math.max(0, matrix.m41 / width + 1));
    } catch {
      return 0;
    }
  }

  private opacity(): number {
    return Number(getComputedStyle(this.root).opacity) || 0;
  }

  // Holds the fill where it is, as its own style, with nothing playing.
  private hold(): number {
    const p = this.position();
    this.fill.style.transform = at(p);
    this.fillAnim?.cancel();
    this.fillAnim = null;
    return p;
  }

  private fade(to: number, options: KeyframeAnimationOptions): Animation {
    const from = this.opacity();
    const anim = this.root.animate([{ opacity: from }, { opacity: to }], { fill: "both", ...options });
    this.fadeAnim?.cancel();
    this.fadeAnim = anim;
    return anim;
  }

  private playCurve(t: number): void {
    this.fillAnim?.cancel();
    const anim = this.fill.animate(CURVE_FRAMES, { duration: CURVE_SECONDS * 1000, fill: "forwards" });
    anim.currentTime = Math.min(Math.max(t, 0), CURVE_SECONDS) * 1000;
    this.fillAnim = anim;
  }

  private glide(to: number, duration: number, easing: string, delay = 0, then?: () => void): void {
    const from = this.hold();
    const gen = this.gen;
    const anim = this.fill.animate([{ transform: at(from) }, { transform: at(to) }], {
      duration,
      delay,
      easing,
      fill: "both",
    });
    this.fillAnim = anim;
    anim.finished.then(
      () => {
        if (gen === this.gen && this.fillAnim === anim) {
          then?.();
        }
      },
      () => {},
    );
  }

  start(run: Run, value: number | null): void {
    this.gen += 1;
    this.root.dataset.phase = "busy";
    this.root.dataset.mode = value === null ? "indeterminate" : "determinate";
    const delay = Math.max(0, LOADING_DELAY - (performance.now() - run.start));
    this.fillAnim?.cancel();
    this.fillAnim = null;
    if (reducedMotion()) {
      this.fill.style.transform = at(value ?? 0.5);
      this.fade(1, { duration: 0, delay });
      return;
    }
    this.fade(1, { duration: DURATION.base, delay, easing: EASE.out });
    if (value !== null) {
      this.fill.style.transform = at(value);
    } else {
      this.fill.style.transform = at(0);
      this.playCurve(curveNow(run));
    }
  }

  // Real progress: the fill follows it; back to the curve when it stops saying.
  follow(run: Run, value: number | null): void {
    this.root.dataset.mode = value === null ? "indeterminate" : "determinate";
    if (reducedMotion()) {
      this.fill.style.transform = at(value ?? 0.5);
      return;
    }
    if (value !== null) {
      this.glide(Math.min(1, Math.max(0, value)), DURATION.slow, EASE.out);
      return;
    }
    const p = this.hold();
    run.shift = curveTime(p) - (performance.now() - run.start) / 1000;
    this.playCurve(curveNow(run));
  }

  // A step landed (a window of rows): the curve jumps a share of what is left.
  step(run: Run): void {
    if (reducedMotion() || this.root.dataset.mode !== "indeterminate") {
      return;
    }
    const p = this.position();
    const target = p + (CEILING - p) * 0.25;
    const glideMs = DURATION.slow;
    run.shift = curveTime(target) - (performance.now() + glideMs - run.start) / 1000;
    this.glide(target, glideMs, EASE.out, 0, () => this.playCurve(curveNow(run)));
  }

  finish(run: Run, outcome: GaugeOutcome): void {
    this.gen += 1;
    const gen = this.gen;
    const shown = performance.now() - run.start >= LOADING_DELAY && this.opacity() > 0.05;
    if (!shown || reducedMotion()) {
      this.reset();
      return;
    }
    const settle = (anim: Animation) =>
      anim.finished.then(
        () => {
          if (gen === this.gen) {
            this.reset();
          }
        },
        () => {},
      );
    this.root.dataset.phase = outcome === "ok" ? "done" : outcome;
    if (outcome === "ok") {
      this.glide(1, DURATION.slow, EASE.out);
      settle(this.fade(0, { duration: DURATION.slower, delay: DURATION.slow + DURATION.fast, easing: EASE.out }));
    } else if (outcome === "error") {
      this.flash.animate([{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 0 }], {
        duration: DURATION.slower + DURATION.fast,
        easing: "ease-out",
      });
      this.glide(0, DURATION.spring, EASE.inOut, DURATION.base);
      settle(this.fade(0, { duration: DURATION.spring, delay: DURATION.base, easing: EASE.in }));
    } else {
      this.glide(0, DURATION.slower, EASE.inOut);
      settle(this.fade(0, { duration: DURATION.slower, easing: EASE.in }));
    }
  }

  reset(): void {
    this.gen += 1;
    this.fillAnim?.cancel();
    this.fillAnim = null;
    this.fadeAnim?.cancel();
    this.fadeAnim = null;
    this.fill.style.transform = "";
    this.root.dataset.phase = "idle";
  }
}

interface GaugeProps {
  busy: boolean;
  // How far the work has got (0–1) when it says; the curve otherwise.
  value?: number | null;
  // Changes each time a step of the work lands (a window of rows, a page of
  // a walk), which nudges the curve ahead.
  step?: unknown;
  // How the work ended, read as `busy` turns false.
  outcome?: GaugeOutcome;
  // Names the work, so a gauge unmounted and shown again mid-run picks up
  // where it had got.
  id?: string;
  className?: string;
}

export function Gauge({ busy, value = null, step, outcome = "ok", id, className }: GaugeProps) {
  const rootRef = useRef<HTMLSpanElement | null>(null);
  const fillRef = useRef<HTMLSpanElement | null>(null);
  const flashRef = useRef<HTMLSpanElement | null>(null);
  const motionRef = useRef<GaugeMotion | null>(null);
  const runRef = useRef<Run | null>(null);
  const mountedRef = useRef(false);
  const outcomeRef = useRef(outcome);
  const valueRef = useRef(value);
  outcomeRef.current = outcome;
  valueRef.current = value;

  useLayoutEffect(() => {
    const root = rootRef.current;
    const fill = fillRef.current;
    const flash = flashRef.current;
    if (root === null || fill === null || flash === null) {
      return;
    }
    let motion = motionRef.current;
    if (motion === null) {
      motion = new GaugeMotion(root, fill, flash);
      motionRef.current = motion;
    }
    const first = !mountedRef.current;
    mountedRef.current = true;
    if (busy) {
      const kept = first && id !== undefined ? runs.get(id) : undefined;
      const run = kept ?? { start: performance.now(), shift: 0 };
      if (id !== undefined) {
        runs.set(id, run);
      }
      runRef.current = run;
      motion.start(run, valueRef.current);
      return;
    }
    if (id !== undefined) {
      runs.delete(id);
    }
    const run = runRef.current;
    runRef.current = null;
    if (run !== null) {
      motion.finish(run, outcomeRef.current);
    }
  }, [busy]);

  useEffect(() => {
    const run = runRef.current;
    if (busy && run !== null) {
      motionRef.current?.follow(run, value);
    }
  }, [value === null ? null : Math.round(value * 1000)]);

  useEffect(() => {
    const run = runRef.current;
    if (busy && run !== null && step !== undefined) {
      motionRef.current?.step(run);
    }
  }, [step]);

  // Reduce motion turned on or off mid-run: the gauge starts over in the new way.
  useEffect(
    () =>
      subscribeMotion(() => {
        const run = runRef.current;
        if (run !== null) {
          motionRef.current?.start(run, valueRef.current);
        }
      }),
    [],
  );

  useLayoutEffect(
    () => () => {
      motionRef.current?.reset();
      motionRef.current = null;
      mountedRef.current = false;
    },
    [],
  );

  return (
    <span ref={rootRef} className={`gauge${className === undefined ? "" : ` ${className}`}`} data-phase="idle" aria-hidden="true">
      <span ref={fillRef} className="gauge-fill" />
      <span ref={flashRef} className="gauge-flash" />
    </span>
  );
}

// Work a tab's own view runs (a document query, a console request), shown on
// its tab in the strip, by the view's tab key (`${conn}:${tab id}`).
interface TabWork {
  busy: boolean;
  outcome: GaugeOutcome;
}

const tabWork = new Map<string, TabWork>();
const tabWorkListeners = new Set<() => void>();
let tabWorkVersion = 0;

function publishTabWork(): void {
  tabWorkVersion += 1;
  for (const listener of tabWorkListeners) {
    listener();
  }
}

export function useTabWork(tabKey: string, busy: boolean, outcome: GaugeOutcome = "ok"): void {
  useEffect(() => {
    const current = tabWork.get(tabKey);
    if (current === undefined ? !busy : current.busy === busy && current.outcome === outcome) {
      return;
    }
    tabWork.set(tabKey, { busy, outcome });
    publishTabWork();
  }, [tabKey, busy, outcome]);
  // The view going away (another tab brought forward) drops what it waited for.
  useEffect(
    () => () => {
      const current = tabWork.get(tabKey);
      if (current !== undefined) {
        if (current.busy) {
          tabWork.set(tabKey, { busy: false, outcome: "cancel" });
        } else {
          tabWork.delete(tabKey);
        }
        publishTabWork();
      }
    },
    [tabKey],
  );
}

function subscribeTabWork(listener: () => void): () => void {
  tabWorkListeners.add(listener);
  return () => {
    tabWorkListeners.delete(listener);
  };
}

// What views report of their tabs' work; re-renders as it changes.
export function useTabWorkOf(): (tabKey: string) => TabWork | undefined {
  useSyncExternalStore(subscribeTabWork, () => tabWorkVersion);
  return (tabKey) => tabWork.get(tabKey);
}
