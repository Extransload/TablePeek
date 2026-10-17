interface IconProps {
  size?: number;
  className?: string;
}

const BASE = {
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.4,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
  focusable: false,
};

export function PlayIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={size} height={size} className={className}>
      <path d="M4.5 2.8 12.4 8l-7.9 5.2z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function StopIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={size} height={size} className={className}>
      <rect x="3.8" y="3.8" width="8.4" height="8.4" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function PlusIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={size} height={size} className={className}>
      <path d="M8 3.2v9.6M3.2 8h9.6" />
    </svg>
  );
}

export function CloseIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={size} height={size} className={className}>
      <path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" />
    </svg>
  );
}

export function ChevronIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={size} height={size} className={className}>
      <path d="M6.2 3.8 10.4 8l-4.2 4.2" />
    </svg>
  );
}

export function KeyIcon({ size = 11, className }: IconProps) {
  return (
    <svg {...BASE} width={size} height={size} className={className}>
      <circle cx="5.4" cy="8" r="2.6" />
      <path d="M8 8h6M11.6 8v2.6M13.6 8v1.8" />
    </svg>
  );
}

export function SearchIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={size} height={size} className={className}>
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.2 10.2 13.6 13.6" />
    </svg>
  );
}

export function RefreshIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={size} height={size} className={className}>
      <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7" />
      <path d="M13.4 2.6v3.2h-3.2" />
    </svg>
  );
}

export function DatabaseIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={size} height={size} className={className}>
      <ellipse cx="8" cy="4.2" rx="5.4" ry="2.2" />
      <path d="M2.6 4.2v7.6c0 1.2 2.4 2.2 5.4 2.2s5.4-1 5.4-2.2V4.2" />
      <path d="M2.6 8c0 1.2 2.4 2.2 5.4 2.2S13.4 9.2 13.4 8" />
    </svg>
  );
}

export function TableIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={size} height={size} className={className}>
      <rect x="2.2" y="3" width="11.6" height="10" rx="1.2" />
      <path d="M2.2 6.4h11.6M6.6 6.4V13" />
    </svg>
  );
}

export function FolderIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={size} height={size} className={className}>
      <path d="M2 4.4A1.4 1.4 0 0 1 3.4 3h2.8l1.4 1.9h5A1.4 1.4 0 0 1 14 6.3v5.3A1.4 1.4 0 0 1 12.6 13H3.4A1.4 1.4 0 0 1 2 11.6z" />
    </svg>
  );
}

export function FileIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={size} height={size} className={className}>
      <path d="M4 1.8h5l3.2 3.2v9.2H4z" />
      <path d="M9 1.8V5h3.2" />
    </svg>
  );
}

export function UpIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={size} height={size} className={className}>
      <path d="M8 12.4V3.6M4 7.6 8 3.6l4 4" />
    </svg>
  );
}

export function CopyIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={size} height={size} className={className}>
      <rect x="5.6" y="2.4" width="8" height="9.2" rx="1.2" />
      <path d="M10.4 14.2H3.6a1.2 1.2 0 0 1-1.2-1.2V5.4" />
    </svg>
  );
}

export function FilterIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={size} height={size} className={className}>
      <path d="M2.4 3.4h11.2L9.4 8.4v4.2L6.6 11.6V8.4z" />
    </svg>
  );
}

export function DownloadIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={size} height={size} className={className}>
      <path d="M8 2.6v7.4M4.8 7.4 8 10.6l3.2-3.2" />
      <path d="M2.8 12.4h10.4" />
    </svg>
  );
}

export function PanelIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={size} height={size} className={className}>
      <rect x="2.2" y="3" width="11.6" height="10" rx="1.2" />
      <path d="M10.2 3v10" />
    </svg>
  );
}

export function CodeIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={size} height={size} className={className}>
      <path d="M5.6 4.4 2.4 8l3.2 3.6M10.4 4.4 13.6 8l-3.2 3.6" />
    </svg>
  );
}
