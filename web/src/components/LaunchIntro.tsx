import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import type { AppSettings } from "../settings";
import { authToken } from "../token";
import { BrandMark } from "./BrandLogo";

// The run the intro last played for. The server makes a new token each time it
// starts (the desktop app starts one with every launch), so the intro plays
// once per launch: a reload, a second browser tab or a new window doesn't
// play it again.
const SHOWN_KEY = "tablepeek.launchIntroRun";
// How long the intro stays (the light across "Peek" ends at about 4.1s), then
// how long it fades. styles.css times each part against these.
const HOLD_MS = 4600;
const LEAVE_MS = 800;

// Whether this page opens with the intro, marking it played: Settings →
// Appearance → Show intro on launch is on, motion isn't reduced, and nothing
// has shown it since the app started.
export function takeLaunchIntro(settings: AppSettings): boolean {
  if (!settings.launchIntro || settings.reduceMotion) {
    return false;
  }
  try {
    if (window.localStorage.getItem(SHOWN_KEY) === authToken) {
      return false;
    }
    window.localStorage.setItem(SHOWN_KEY, authToken);
  } catch {}
  return true;
}

interface LaunchIntroProps {
  onDone(): void;
}

// The mark, the wordmark and the tagline over the background picture; any
// click or key lets the app through at once.
export function LaunchIntro({ onDone }: LaunchIntroProps) {
  const [leaving, setLeaving] = useState(false);
  // The parent passes a fresh callback each render; the fade's timer keeps going.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const leave = window.setTimeout(() => setLeaving(true), HOLD_MS);
    const skip = (): void => setLeaving(true);
    window.addEventListener("pointerdown", skip, true);
    window.addEventListener("keydown", skip, true);
    return () => {
      window.clearTimeout(leave);
      window.removeEventListener("pointerdown", skip, true);
      window.removeEventListener("keydown", skip, true);
    };
  }, []);

  useEffect(() => {
    if (!leaving) {
      return;
    }
    const done = window.setTimeout(() => onDoneRef.current(), LEAVE_MS);
    return () => window.clearTimeout(done);
  }, [leaving]);

  return (
    <div className={`launch-intro${leaving ? " leaving" : ""}`} aria-hidden="true">
      <BrandMark size={96} className="launch-intro-mark" />
      <div className="launch-intro-word">
        Table<span className="brand-word-peek">Peek</span>
      </div>
      <p className="launch-intro-tagline">{t("빠르고 정확한 전문가용 데이터베이스 클라이언트")}</p>
    </div>
  );
}
