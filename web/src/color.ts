// Colour arithmetic on #rrggbb strings, shared by the themes and by the build
// (vite.config.ts converts Tern's themes with it), so nothing here may touch
// the page.

export function parseHex(hex: string): [number, number, number] | null {
  const value = hex.replace("#", "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    return null;
  }
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

export function toHex(rgb: readonly number[]): string {
  return `#${rgb
    .map((value) => Math.min(255, Math.max(0, Math.round(value))).toString(16).padStart(2, "0"))
    .join("")}`;
}

export function mixHex(a: string, b: string, amount: number): string {
  const pa = parseHex(a);
  const pb = parseHex(b);
  if (pa === null || pb === null) {
    return a;
  }
  return toHex([0, 1, 2].map((channel) => pa[channel] + (pb[channel] - pa[channel]) * amount));
}

// Relative luminance, as WCAG 2 defines it.
export function luminance(hex: string): number {
  const rgb = parseHex(hex);
  if (rgb === null) {
    return 0;
  }
  const [r, g, b] = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// WCAG 2 contrast ratio, 1 to 21.
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function contrastInk(hex: string): string {
  if (parseHex(hex) === null) {
    return "#ffffff";
  }
  // White stays on saturated accents until it drops under 3:1 contrast,
  // so pastel accents (Rosé Pine, Dracula) get dark text.
  return luminance(hex) > 0.3 ? "#1f2230" : "#ffffff";
}

// `color` made to read on every one of `grounds` at `ratio` or better: moved
// toward white over dark grounds, toward black over light ones, as little as
// it takes, so it keeps its hue.
export function readableOn(color: string, grounds: readonly string[], ratio: number, mode: "dark" | "light"): string {
  const worst = (value: string): number => Math.min(...grounds.map((ground) => contrastRatio(value, ground)));
  if (worst(color) >= ratio) {
    return color;
  }
  const toward = mode === "dark" ? "#ffffff" : "#000000";
  for (let step = 1; step <= 50; step += 1) {
    const next = mixHex(color, toward, step / 50);
    if (worst(next) >= ratio) {
      return next;
    }
  }
  return toward;
}

export function withAlpha(hex: string, alpha: number): string {
  const rgb = parseHex(hex) ?? [0, 0, 0];
  return `rgba(${rgb.join(", ")}, ${alpha})`;
}

export function saturation(hex: string): number {
  const rgb = parseHex(hex);
  if (rgb === null) {
    return 0;
  }
  const max = Math.max(...rgb) / 255;
  const min = Math.min(...rgb) / 255;
  const lightness = (max + min) / 2;
  return max === min ? 0 : (max - min) / (1 - Math.abs(2 * lightness - 1));
}
