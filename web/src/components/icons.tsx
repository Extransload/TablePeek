interface IconProps {
  size?: number;
  className?: string;
}

// Call sites pass compact nominal sizes; render every icon about half again larger.
const ICON_SCALE = 1.5;

function px(size: number): number {
  return Math.round(size * ICON_SCALE);
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
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="M4.5 2.8 12.4 8l-7.9 5.2z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function StopIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <rect x="3.8" y="3.8" width="8.4" height="8.4" rx="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function CheckIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="m3.4 8.4 3 3 6.2-6.6" />
    </svg>
  );
}

export function AlertIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 4.8v3.8" />
      <circle cx="8" cy="11.1" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function ExternalIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="M9.2 2.8h4v4M13.2 2.8 7.6 8.4" />
      <path d="M11.6 9.6v2.8a1 1 0 0 1-1 1H3.6a1 1 0 0 1-1-1V5.4a1 1 0 0 1 1-1h2.8" />
    </svg>
  );
}

export function PlusIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="M8 3.2v9.6M3.2 8h9.6" />
    </svg>
  );
}

export function MinusIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="M3.2 8h9.6" />
    </svg>
  );
}

export function CloseIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6" />
    </svg>
  );
}

export function ChevronIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="M6.2 3.8 10.4 8l-4.2 4.2" />
    </svg>
  );
}

export function KeyIcon({ size = 11, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <circle cx="5.4" cy="8" r="2.6" />
      <path d="M8 8h6M11.6 8v2.6M13.6 8v1.8" />
    </svg>
  );
}

// A keyboard: shortcuts.
export function KeyboardIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <rect x="1.6" y="3.8" width="12.8" height="8.4" rx="1.6" />
      <path d="M4.4 6.6h.01M6.8 6.6h.01M9.2 6.6h.01M11.6 6.6h.01M4.4 9.4h.01M11.6 9.4h.01M6.6 9.4h2.8" />
    </svg>
  );
}

// Two slider tracks with their knobs: general settings.
export function SlidersIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="M2.4 5.2h11.2M2.4 10.8h11.2" />
      <circle cx="10.2" cy="5.2" r="1.6" fill="currentColor" stroke="none" />
      <circle cx="5.8" cy="10.8" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

// A sun: appearance (theme, colours, fonts), as Tern marks it.
export function SunIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <circle cx="8" cy="8" r="2.8" />
      <path d="M8 1.6v1.4M8 13v1.4M1.6 8h1.4M13 8h1.4M3.5 3.5l1 1M11.5 11.5l1 1M3.5 12.5l1-1M11.5 4.5l1-1" />
    </svg>
  );
}

// Two opposite arrows: moving data in and out.
export function TransferIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="M2.6 5.4h10.4M10.2 2.6l2.8 2.8-2.8 2.8M13.4 10.6H3M5.8 7.8 3 10.6l2.8 2.8" />
    </svg>
  );
}

// A padlock: security and the passcode lock.
export function LockIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <rect x="3.2" y="7" width="9.6" height="6.8" rx="1.4" />
      <path d="M5.4 7V5.2a2.6 2.6 0 0 1 5.2 0V7" />
    </svg>
  );
}

export function SearchIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <circle cx="7" cy="7" r="4.2" />
      <path d="M10.2 10.2 13.6 13.6" />
    </svg>
  );
}

export function RefreshIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="M13.2 8a5.2 5.2 0 1 1-1.6-3.7" />
      <path d="M13.4 2.6v3.2h-3.2" />
    </svg>
  );
}

export function DatabaseIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <ellipse cx="8" cy="4.2" rx="5.4" ry="2.2" />
      <path d="M2.6 4.2v7.6c0 1.2 2.4 2.2 5.4 2.2s5.4-1 5.4-2.2V4.2" />
      <path d="M2.6 8c0 1.2 2.4 2.2 5.4 2.2S13.4 9.2 13.4 8" />
    </svg>
  );
}

export function TableIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <rect x="2.2" y="3" width="11.6" height="10" rx="1.2" />
      <path d="M2.2 6.4h11.6M6.6 6.4V13" />
    </svg>
  );
}

export function FolderIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="M2 4.4A1.4 1.4 0 0 1 3.4 3h2.8l1.4 1.9h5A1.4 1.4 0 0 1 14 6.3v5.3A1.4 1.4 0 0 1 12.6 13H3.4A1.4 1.4 0 0 1 2 11.6z" />
    </svg>
  );
}

export function FileIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="M4 1.8h5l3.2 3.2v9.2H4z" />
      <path d="M9 1.8V5h3.2" />
    </svg>
  );
}

export function UpIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="M8 12.4V3.6M4 7.6 8 3.6l4 4" />
    </svg>
  );
}

export function CopyIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <rect x="5.6" y="2.4" width="8" height="9.2" rx="1.2" />
      <path d="M10.4 14.2H3.6a1.2 1.2 0 0 1-1.2-1.2V5.4" />
    </svg>
  );
}

export function FilterIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="M2.4 3.4h11.2L9.4 8.4v4.2L6.6 11.6V8.4z" />
    </svg>
  );
}

export function DownloadIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="M8 2.6v7.4M4.8 7.4 8 10.6l3.2-3.2" />
      <path d="M2.8 12.4h10.4" />
    </svg>
  );
}

export function UploadIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="M8 10.6V3.2M4.8 6.4 8 3.2l3.2 3.2" />
      <path d="M2.8 12.4h10.4" />
    </svg>
  );
}

export function PanelIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <rect x="2.2" y="3" width="11.6" height="10" rx="1.2" />
      <path d="M10.2 3v10" />
    </svg>
  );
}

export function CodeIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="M5.6 4.4 2.4 8l3.2 3.6M10.4 4.4 13.6 8l-3.2 3.6" />
    </svg>
  );
}

export function StructureIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <rect x="2.2" y="3" width="11.6" height="10" rx="1.2" />
      <path d="M2.2 6.2h11.6M2.2 9.8h11.6M6.4 6.2v6.8" />
    </svg>
  );
}

export function ServerIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <rect x="2.4" y="2.6" width="11.2" height="4.4" rx="1" />
      <rect x="2.4" y="9" width="11.2" height="4.4" rx="1" />
      <path d="M4.8 4.8h.6M4.8 11.2h.6" />
    </svg>
  );
}

export function ListIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="M5.6 4.2h8M5.6 8h8M5.6 11.8h8" />
      <circle cx="2.9" cy="4.2" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="2.9" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="2.9" cy="11.8" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function PinIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="M6 2.6h4l-.6 3.4 2.2 2.2H4.4l2.2-2.2z" />
      <path d="M8 8.4v5" />
    </svg>
  );
}

export function ColumnsIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <rect x="2.2" y="3" width="11.6" height="10" rx="1.2" />
      <path d="M6.1 3v10M9.9 3v10" />
    </svg>
  );
}

export function SnippetIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <rect x="2.4" y="2.4" width="11.2" height="11.2" rx="1.4" />
      <path d="M5 5.6h6M5 8h6M5 10.4h3.4" />
    </svg>
  );
}


export function PlugIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="M6 2.5v3M10 2.5v3" />
      <path d="M4.5 5.5h7v2a3.5 3.5 0 0 1-7 0z" />
      <path d="M8 10.5v3" />
    </svg>
  );
}

export function LinkIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="M6.4 9.6 9.6 6.4" />
      <path d="M7.1 4.7 8.5 3.3a2.5 2.5 0 0 1 3.5 3.5l-1.4 1.4" />
      <path d="M8.9 11.3 7.5 12.7a2.5 2.5 0 0 1-3.5-3.5l1.4-1.4" />
    </svg>
  );
}

export function PencilIcon({ size = 12, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      width={px(size)}
      height={px(size)}
      className={className}
    >
      <path d="M11.3 2.9a1.5 1.5 0 0 1 2.1 2.1L5.6 12.8l-3 .9.9-3z" />
      <path d="M10.2 4l1.8 1.8" />
    </svg>
  );
}

export function UserIcon({ size = 12, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      width={px(size)}
      height={px(size)}
      className={className}
    >
      <circle cx="8" cy="5.4" r="2.6" />
      <path d="M2.8 13.4c.6-2.4 2.7-3.8 5.2-3.8s4.6 1.4 5.2 3.8" />
    </svg>
  );
}

export function HomeIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="M2.4 7.2 8 2.4l5.6 4.8" />
      <path d="M4 6.6v6.8h8V6.6" />
      <path d="M6.8 13.4V9.6h2.4v3.8" />
    </svg>
  );
}

// A gear with rounded teeth: settings. Path from Lucide's "settings" icon
// (ISC licence), drawn on its 24-unit grid at this set's stroke weight.
export function SettingsIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} viewBox="0 0 24 24" strokeWidth={2.1} width={px(size)} height={px(size)} className={className}>
      <path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}


export function TrashIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="M3.1 4.6h9.8M6 2.7h4M4.3 4.6l.6 8.1h6.2l.6-8.1M6.6 6.8v3.8M9.4 6.8v3.8" />
    </svg>
  );
}

export function JobsIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="M2.4 4.3 8 1.9l5.6 2.4L8 6.7z" />
      <path d="m2.4 8 5.6 2.4L13.6 8M2.4 11.7 8 14.1l5.6-2.4" />
    </svg>
  );
}

export function LogIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <rect x="2.2" y="2.8" width="11.6" height="10.4" rx="1.4" />
      <path d="m4.7 6 2.2 2-2.2 2M8.5 10.2h2.8" />
    </svg>
  );
}

export function HistoryIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 4.8V8l2.2 1.4" />
    </svg>
  );
}

export function StarIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="m8 2.2 1.7 3.5 3.9.6-2.8 2.7.7 3.9L8 11.1l-3.5 1.8.7-3.9-2.8-2.7 3.9-.6z" />
    </svg>
  );
}

export function ShieldIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="M8 2.1 13 4v3.7c0 2.9-2 4.9-5 6.2-3-1.3-5-3.3-5-6.2V4z" />
      <path d="m5.8 7.9 1.5 1.5 2.9-3" />
    </svg>
  );
}

export function ChevronDownIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="m4 6.2 4 4 4-4" />
    </svg>
  );
}

export function UpDownIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="m5 6.2 3-3 3 3M5 9.8l3 3 3-3" />
    </svg>
  );
}

export function EyeIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="M1.8 8s2.3-4.4 6.2-4.4S14.2 8 14.2 8s-2.3 4.4-6.2 4.4S1.8 8 1.8 8z" />
      <circle cx="8" cy="8" r="1.9" />
    </svg>
  );
}

export function EyeOffIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="M6.3 3.9A6.4 6.4 0 0 1 8 3.6c3.9 0 6.2 4.4 6.2 4.4a11 11 0 0 1-1.8 2.4M4.2 5.1A10.7 10.7 0 0 0 1.8 8s2.3 4.4 6.2 4.4a6 6 0 0 0 2.9-.8" />
      <path d="M6.6 6.7a1.9 1.9 0 0 0 2.7 2.6M2.6 2.6l10.8 10.8" />
    </svg>
  );
}

export function LinkPasteIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="M6.6 9.4a2.6 2.6 0 0 0 3.7 0l2.2-2.2a2.6 2.6 0 0 0-3.7-3.7l-.8.8" />
      <path d="M9.4 6.6a2.6 2.6 0 0 0-3.7 0L3.5 8.8a2.6 2.6 0 0 0 3.7 3.7l.8-.8" />
    </svg>
  );
}

export function PanelLeftIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <rect x="2.2" y="3" width="11.6" height="10" rx="1.2" />
      <path d="M5.8 3v10" />
    </svg>
  );
}

export function PanelBottomIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <rect x="2.2" y="3" width="11.6" height="10" rx="1.2" />
      <path d="M2.2 9.6h11.6" />
    </svg>
  );
}

export function MoreIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <circle cx="3.6" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12.4" cy="8" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function DiagramIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <rect x="1.8" y="2.4" width="5" height="4.2" rx="0.8" />
      <rect x="9.2" y="9.4" width="5" height="4.2" rx="0.8" />
      <path d="M6.8 4.5h2.4v7h0" />
    </svg>
  );
}

export function FitIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="M2.6 5.6v-3h3M10.4 2.6h3v3M13.4 10.4v3h-3M5.6 13.4h-3v-3" />
    </svg>
  );
}

// Arrows out to the corners: open in a larger view.
export function ExpandIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="M9.6 2.6h3.8v3.8M13.4 2.6 9.2 6.8M6.4 13.4H2.6V9.6M2.6 13.4l4.2-4.2" />
    </svg>
  );
}

// Arrows in from the corners: back to the smaller view.
export function ShrinkIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="M13.4 2.6 9.4 6.6M9.4 3.4v3.2h3.2M2.6 13.4l4-4M6.6 12.6V9.4H3.4" />
    </svg>
  );
}

export function GaugeIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...BASE} width={px(size)} height={px(size)} className={className}>
      <path d="M2.6 11.6a5.6 5.6 0 1 1 10.8 0M8 10.2l2.6-3.6" />
      <circle cx="8" cy="10.6" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}
