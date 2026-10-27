import { useId } from "react";
import { t } from "../i18n";

interface BrandMarkProps {
  size?: number;
  className?: string;
}

const GRID_PATH = "M0 8H32M0 16H32M0 24H32M8 0V32M16 0V32M24 0V32";

// Same artwork as src/assets/tablepeek-mark.svg (the favicon); ids are scoped per instance.
// A monocle: a dark plate with a faint grid, one circular lens where the grid shows sharp on paper.
export function BrandMark({ size = 24, className }: BrandMarkProps) {
  const id = useId().replace(/:/g, "");
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id={`${id}-tile`}>
          <rect width="32" height="32" rx="7.25" />
        </clipPath>
        <clipPath id={`${id}-lens`}>
          <circle cx="16" cy="16" r="11" />
        </clipPath>
        <linearGradient
          id={`${id}-rim`}
          x1="5"
          y1="5"
          x2="27"
          y2="27"
          gradientUnits="userSpaceOnUse"
        >
          <stop offset="0" stopColor="#4FA3FF" />
          <stop offset="0.55" stopColor="#6E5BFF" />
          <stop offset="1" stopColor="#A35BFF" />
        </linearGradient>
      </defs>
      <g clipPath={`url(#${id}-tile)`}>
        <rect width="32" height="32" fill="#1A1830" />
        <path
          d={GRID_PATH}
          stroke="#C8C6F0"
          strokeOpacity="0.12"
          strokeWidth="0.5"
        />
        <g clipPath={`url(#${id}-lens)`}>
          <rect width="32" height="32" fill="#FBF6EA" />
          <path d={GRID_PATH} stroke="#1A1830" strokeWidth="0.625" />
          <rect x="16" y="16" width="8" height="8" fill="#6E5BFF" />
        </g>
        <circle
          cx="16"
          cy="16"
          r="11"
          fill="none"
          stroke={`url(#${id}-rim)`}
          strokeWidth="0.875"
        />
      </g>
    </svg>
  );
}

interface BrandLogoProps {
  onClick?(): void;
}

// With onClick the logo doubles as the home button.
export function BrandLogo({ onClick }: BrandLogoProps) {
  const content = (
    <>
      <BrandMark size={26} className="brand-mark" />
      <span className="brand-word" aria-hidden="true">
        Table<span className="brand-word-peek">Peek</span>
      </span>
    </>
  );
  if (onClick === undefined) {
    return (
      <span className="brand" role="img" aria-label="TablePeek">
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="brand brand-button"
      onClick={onClick}
      title={t("연결 홈")}
      aria-label={`TablePeek — ${t("연결 홈")}`}
    >
      {content}
    </button>
  );
}
