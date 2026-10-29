// Icons the document views need beyond the app's set, drawn the same way
// (16-unit box, 1.4 stroke, half again the nominal size).

interface IconProps {
  size?: number;
  className?: string;
}

function svgProps(size: number, className?: string) {
  const px = Math.round(size * 1.5);
  return {
    viewBox: "0 0 16 16",
    width: px,
    height: px,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.4,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    focusable: false,
    className,
  };
}

export function BracesIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="M5.6 2.6c-1.3 0-1.8.6-1.8 1.8v1.8c0 .9-.5 1.5-1.4 1.8.9.3 1.4.9 1.4 1.8v1.8c0 1.2.5 1.8 1.8 1.8M10.4 2.6c1.3 0 1.8.6 1.8 1.8v1.8c0 .9.5 1.5 1.4 1.8-.9.3-1.4.9-1.4 1.8v1.8c0 1.2-.5 1.8-1.8 1.8" />
    </svg>
  );
}

export function GridIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <rect x="2.2" y="2.6" width="11.6" height="10.8" rx="1.2" />
      <path d="M2.2 6.2h11.6M2.2 9.8h11.6M6.1 2.6v10.8M9.9 2.6v10.8" />
    </svg>
  );
}

export function CloneIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <rect x="5.2" y="5.2" width="8.4" height="8.4" rx="1.2" />
      <path d="M10.8 5.2V3.6c0-.7-.5-1.2-1.2-1.2H3.6c-.7 0-1.2.5-1.2 1.2v6c0 .7.5 1.2 1.2 1.2h1.6M9.4 7.4v4M7.4 9.4h4" />
    </svg>
  );
}

export function ExpandIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="m5 5.4 3-3 3 3M5 10.6l3 3 3-3M8 2.6v10.8" />
    </svg>
  );
}

export function CollapseIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <path d="m5 2.6 3 3 3-3M5 13.4l3-3 3 3M3 8h10" />
    </svg>
  );
}

export function PlanIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...svgProps(size, className)}>
      <rect x="2.2" y="2.2" width="5" height="3.6" rx="0.8" />
      <rect x="8.8" y="10.2" width="5" height="3.6" rx="0.8" />
      <path d="M4.7 5.8v6.2h4.1M4.7 8h6.6v2.2" />
    </svg>
  );
}
