import { t } from "./i18n";

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export function formatBytes(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) {
    return null;
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${SIZE_UNITS[unit]}`;
}

export function formatRowEstimate(count: number | null, exact: boolean): string | null {
  if (count === null || !Number.isFinite(count) || count < 0) {
    return null;
  }
  const text = t("{count}행", { count: Math.floor(count).toLocaleString("ko-KR") });
  return exact ? text : `≈ ${text}`;
}

export function humanizeElapsed(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms) || ms < 0) {
    return null;
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    return t("{seconds}초", { seconds: (Math.round(totalSeconds * 10) / 10).toFixed(1) });
  }
  const seconds = Math.round(totalSeconds);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) {
    return rest === 0
      ? t("{minutes}분", { minutes })
      : t("{minutes}분 {seconds}초", { minutes, seconds: rest });
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0
    ? t("{hours}시간", { hours })
    : t("{hours}시간 {minutes}분", { hours, minutes: restMinutes });
}
