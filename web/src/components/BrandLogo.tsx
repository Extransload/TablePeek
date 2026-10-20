import { useId } from "react";
import { t } from "../i18n";

interface BrandMarkProps {
  size?: number;
  className?: string;
}

// Same artwork as src/assets/tablepeek-mark.svg (the favicon); ids are scoped per instance.
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
        <linearGradient id={`${id}-bg`} x1="3" y1="1" x2="29" y2="31" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#4FA3FF" />
          <stop offset="0.55" stopColor="#5B6BFF" />
          <stop offset="1" stopColor="#7A3FF2" />
        </linearGradient>
        <linearGradient id={`${id}-shine`} x1="16" y1="1" x2="16" y2="17" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#FFFFFF" stopOpacity="0.32" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
        <radialGradient id={`${id}-lens`} cx="21.2" cy="20.2" r="5.6" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#7CF5E4" stopOpacity="0.55" />
          <stop offset="1" stopColor="#1B1650" stopOpacity="0.55" />
        </radialGradient>
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="8.5" fill={`url(#${id}-bg)`} />
      <path
        d="M9.5 1h13A8.5 8.5 0 0 1 31 9.5V13Q16 19 1 13V9.5A8.5 8.5 0 0 1 9.5 1z"
        fill={`url(#${id}-shine)`}
      />
      <path d="M9 6.8h10.6a2.6 2.6 0 0 1 2.6 2.6v2H6.4v-2A2.6 2.6 0 0 1 9 6.8z" fill="#FFFFFF" />
      <rect
        x="6.4"
        y="6.8"
        width="15.8"
        height="14.2"
        rx="2.6"
        fill="none"
        stroke="#FFFFFF"
        strokeWidth="1.6"
      />
      <path
        d="M6.4 16.2h9.2M11.7 11.4v9.6"
        stroke="#FFFFFF"
        strokeOpacity="0.6"
        strokeWidth="1.3"
      />
      <circle
        cx="21.2"
        cy="20.2"
        r="5.6"
        fill={`url(#${id}-lens)`}
        stroke="#FFFFFF"
        strokeWidth="2.1"
      />
      <path d="M18.3 20.2q2.9-3 5.8 0q-2.9 3-5.8 0z" fill="#FFFFFF" />
      <circle cx="21.2" cy="20.2" r="1.25" fill="#3B2BB8" />
      <path d="M25.3 24.3l2.6 2.6" stroke="#FFFFFF" strokeWidth="2.6" strokeLinecap="round" />
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
