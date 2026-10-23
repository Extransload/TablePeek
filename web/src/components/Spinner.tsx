import type { ReactNode } from "react";
import { t } from "../i18n";

interface SpinnerProps {
  size?: number;
  label?: string;
  className?: string;
}

export function Spinner({ size = 12, label, className }: SpinnerProps) {
  return (
    <span
      className={`spinner${className === undefined ? "" : ` ${className}`}`}
      style={{ width: size, height: size }}
      role={label === undefined ? undefined : "status"}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
    />
  );
}

interface LoadingStateProps {
  // What is being waited for; "Loading…" by default.
  label?: string;
  // "block" fills an empty view, "overlay" covers its positioned parent and
  // "compact" is one line for lists.
  variant?: "block" | "overlay" | "compact";
  // Actions offered while waiting, such as Stop.
  children?: ReactNode;
}

// What a view shows while its contents load. It fades in only after
// --loading-delay, so a load quicker than that (switching between tables on a
// local database, say) shows nothing at all instead of flashing a spinner.
export function LoadingState({ label, variant = "block", children }: LoadingStateProps) {
  return (
    <div className={`loading-state ${variant}`} role="status">
      <Spinner size={variant === "compact" ? 12 : 18} />
      <span className="loading-label">{label ?? t("불러오는 중…")}</span>
      {children}
    </div>
  );
}
