import { useEffect, useRef } from "react";
import { palette, type ValueKind } from "../palette";

// The home's backdrop: a table laid out as a floor running to the horizon,
// its rows flowing toward the viewer over a slow swell. Each column holds one
// kind of value in the theme's type colours; cells flicker on as if read,
// now and then a row is selected, and the pointer is a lens that lifts the
// cells under it and shows their values. A click sends a ripple out.
//
// "hero" is the first-run page; "quiet" sits behind the connection list,
// dimmer and slower, with no values. Reduced motion gets one still frame.

export type BackdropMode = "hero" | "quiet";

const KINDS: ValueKind[] = ["string", "integer", "date", "boolean", "float", "json", "uuid", "enum"];
const SAMPLES: Record<string, string[]> = {
  string: ["'alice'", "'seoul'", "'peek'", "'hello'", "'ok'"],
  integer: ["42", "1024", "7", "365", "2026"],
  date: ["2026-11-04", "1999-12-31", "2024-02-29"],
  boolean: ["true", "false"],
  float: ["3.14", "0.618", "98.6", "2.718"],
  json: ["{…}", "[1,2]", '{"a":1}'],
  uuid: ["9f1c…", "a7e2…", "03bd…"],
  enum: ["paid", "draft", "open"],
};
// Bucket indexes after the kinds: NULL cells and selected rows.
const NULL_SLOT = KINDS.length;
const ACCENT_SLOT = KINDS.length + 1;
const LEVELS = 6;

// World units: the camera sits CAM_H above the floor.
const CAM_H = 1;
const CELL_W = 0.36;
const CELL_D = 0.16;
const Z_FAR = 10;
const FLOW = 0.22;
const SWELL = 0.1;
const LENS_R2 = 0.3;
// The lens's pool of light is drawn at this radius, then scaled to its depth.
const SPOT_R = 100;
const RIPPLE_LIFE = 2.4;
const RIPPLE_SPEED = 1.7;
const MAX_RIPPLES = 4;
// The moment the still frame shows (past the entrance).
const STILL_T = 9.4;

interface ModeSpec {
  horizon: number; // fraction of the height
  gain: number;
  fps: number;
  values: boolean;
}

const MODES: Record<BackdropMode, ModeSpec> = {
  hero: { horizon: 0.6, gain: 1, fps: 60, values: true },
  quiet: { horizon: 0.74, gain: 0.42, fps: 30, values: false },
};

interface Ripple {
  x: number;
  z: number;
  t0: number;
}

interface Colors {
  slots: string[];
  maxAlpha: number;
  lines: CanvasGradient;
  glow: CanvasGradient;
  spot: CanvasGradient;
  mono: string;
}

function hash(a: number, b: number): number {
  let h = Math.imul(a, 374761393) + Math.imul(b, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// A column holds one kind of value; a few of its cells are NULL.
function slotOf(row: number, col: number): number {
  return hash(row, col) < 0.05 ? NULL_SLOT : Math.floor(hash(col, 7) * KINDS.length);
}

function rgba(hex: string, alpha: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) {
    return `rgba(128, 128, 128, ${alpha})`;
  }
  const value = Number.parseInt(hex.slice(1), 16);
  return `rgba(${value >> 16}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

class Field {
  private readonly ctx: CanvasRenderingContext2D;
  private mode: ModeSpec;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private half = 0; // columns either side of the centre
  private rows = 0;
  private hv = new Float32Array(0); // vertex heights
  private lv = new Float32Array(0); // vertex lens glow
  private rv = new Float32Array(0); // vertex ripple glow
  private sx = new Float32Array(0);
  private sy = new Float32Array(0);
  private codes = new Uint8Array(0);
  private lit = new Int32Array(0);
  private shown = new Int32Array(0);
  private counts = new Uint16Array((ACCENT_SLOT + 1) * 8);
  private colors: Colors | null = null;
  private t = 0;
  private last = 0;
  private frame = 0;
  private pointer: { x: number; y: number } | null = null;
  private lens = { x: 0, z: 0, amp: 0 };
  private camX = 0;
  private ripples: Ripple[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    mode: BackdropMode,
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.mode = MODES[mode];
  }

  get running(): boolean {
    return this.frame !== 0;
  }

  setMode(mode: BackdropMode): void {
    this.mode = MODES[mode];
    this.colors = null;
    this.resize();
  }

  themeChanged(): void {
    this.colors = null;
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = Math.max(1, Math.round(rect.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this.dpr));
    const f = this.focal();
    this.half = Math.ceil(((this.w / 2 + 40) * Z_FAR) / f / CELL_W);
    this.rows = Math.ceil((Z_FAR - this.zStart()) / CELL_D) + 1;
    const vertices = (this.half * 2 + 1) * (this.rows + 1);
    const cells = this.half * 2 * this.rows;
    if (this.hv.length < vertices) {
      this.hv = new Float32Array(vertices);
      this.lv = new Float32Array(vertices);
      this.rv = new Float32Array(vertices);
      this.sx = new Float32Array(vertices);
      this.sy = new Float32Array(vertices);
    }
    if (this.codes.length < cells) {
      this.codes = new Uint8Array(cells);
      this.lit = new Int32Array(cells);
      this.shown = new Int32Array(cells);
    }
    this.colors = null;
  }

  start(): void {
    if (this.frame !== 0) {
      return;
    }
    this.last = performance.now();
    const tick = (now: number) => {
      this.frame = requestAnimationFrame(tick);
      // Capped: a 120 Hz display draws every other frame of a 60 fps mode.
      const elapsed = now - this.last;
      if (elapsed < 1000 / this.mode.fps - 2) {
        return;
      }
      this.last = now;
      this.draw(Math.min(elapsed / 1000, 0.05));
    };
    this.frame = requestAnimationFrame(tick);
  }

  stop(): void {
    cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  still(): void {
    this.t = STILL_T;
    this.pointer = null;
    this.lens.amp = 0;
    this.camX = 0;
    this.ripples = [];
    this.draw(0);
  }

  point(x: number, y: number): void {
    this.pointer = { x, y };
  }

  leave(): void {
    this.pointer = null;
  }

  // A ripple from where the floor is under the pointer; above the horizon,
  // from far out under it.
  press(x: number, y: number): void {
    const { horizon, f } = this.view();
    const z = y > horizon + 4 ? Math.min(Z_FAR, (CAM_H * f) / (y - horizon)) : Z_FAR * 0.55;
    this.ripples.push({ x: ((x - this.w / 2) * z) / f + this.camX, z, t0: this.t });
    if (this.ripples.length > MAX_RIPPLES) {
      this.ripples.shift();
    }
  }

  private focal(): number {
    return this.h * 0.9;
  }

  private zStart(): number {
    // Just below the bottom edge, with room for the swell.
    return ((CAM_H * this.focal()) / Math.max(1, this.h * (1 - this.mode.horizon))) * 0.82;
  }

  private view(): { horizon: number; f: number } {
    return { horizon: this.h * this.mode.horizon, f: this.focal() };
  }

  private readColors(): Colors {
    const light = document.documentElement.dataset.mode === "light";
    const { horizon } = this.view();
    const ctx = this.ctx;
    const lines = ctx.createLinearGradient(0, horizon, 0, this.h);
    lines.addColorStop(0, rgba(palette.ink, 0));
    lines.addColorStop(0.35, rgba(palette.ink, light ? 0.06 : 0.07));
    lines.addColorStop(1, rgba(palette.ink, light ? 0.16 : 0.17));
    const reach = Math.max(this.w, this.h) * 0.6;
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, reach);
    glow.addColorStop(0, rgba(palette.accent, light ? 0.16 : 0.22));
    glow.addColorStop(0.4, rgba(palette.accent, light ? 0.05 : 0.07));
    glow.addColorStop(1, rgba(palette.accent, 0));
    const spot = ctx.createRadialGradient(0, 0, 0, 0, 0, SPOT_R);
    spot.addColorStop(0, rgba(palette.accent, light ? 0.26 : 0.34));
    spot.addColorStop(1, rgba(palette.accent, 0));
    const mono = getComputedStyle(document.documentElement).getPropertyValue("--mono").trim() || "monospace";
    return {
      slots: [...KINDS.map((kind) => palette.typeInks[kind]), palette.nullInk, palette.accent],
      maxAlpha: light ? 0.34 : 0.5,
      lines,
      glow,
      spot,
      mono,
    };
  }

  private height(i: number, x: number, z: number): number {
    const t = this.t;
    let y = SWELL * (0.6 * Math.sin(0.9 * x + 0.75 * z - 1.1 * t) + 0.4 * Math.sin(-0.55 * x + 1.35 * z + 0.7 * t + 1.3));
    const lens = this.lens;
    let l = 0;
    if (lens.amp > 0.002) {
      const dx = x - lens.x;
      const dz = z - lens.z;
      l = lens.amp * Math.exp(-(dx * dx + dz * dz) / LENS_R2);
      y += 0.16 * l;
    }
    let r = 0;
    for (const ripple of this.ripples) {
      const age = t - ripple.t0;
      const ring = Math.hypot(x - ripple.x, z - ripple.z) - age * RIPPLE_SPEED;
      r += Math.exp(-ring * ring * 7) * (1 - age / RIPPLE_LIFE);
    }
    y += 0.12 * r;
    this.lv[i] = l;
    this.rv[i] = Math.min(1, r);
    return y;
  }

  private follow(dt: number): void {
    const { horizon, f } = this.view();
    const p = this.pointer;
    const onFloor = p !== null && p.y > horizon + 4;
    const ease = 1 - Math.exp(-dt * 9);
    if (onFloor) {
      const z = Math.min(Z_FAR, (CAM_H * f) / (p.y - horizon));
      const x = ((p.x - this.w / 2) * z) / f + this.camX;
      if (this.lens.amp < 0.02) {
        this.lens.x = x;
        this.lens.z = z;
      } else {
        this.lens.x += (x - this.lens.x) * ease;
        this.lens.z += (z - this.lens.z) * ease;
      }
    }
    this.lens.amp += ((onFloor ? 1 : 0) - this.lens.amp) * (1 - Math.exp(-dt * 5));
    // The floor leans a little with the pointer.
    const lean = p === null ? 0 : (p.x / this.w - 0.5) * 0.35;
    this.camX += (lean - this.camX) * (1 - Math.exp(-dt * 2));
    while (this.ripples.length > 0 && this.t - this.ripples[0].t0 >= RIPPLE_LIFE) {
      this.ripples.shift();
    }
  }

  draw(dt: number): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (dpr !== this.dpr) {
      this.resize();
    }
    if (this.w === 0 || this.h === 0) {
      return;
    }
    this.t += dt;
    this.follow(dt);
    this.colors ??= this.readColors();
    const colors = this.colors;
    const ctx = this.ctx;
    const { w, h, half, rows, mode } = this;
    const { horizon, f } = this.view();
    const cx = w / 2;
    const cols = half * 2;
    const stride = cols + 1;
    const zStart = this.zStart();
    const scroll = this.t * FLOW;
    const k0 = Math.floor((zStart + scroll) / CELL_D);
    // Entrance: the floor unrolls from the viewer to the horizon.
    const intro = 1 - (1 - Math.min(1, this.t / 1.6)) ** 3;
    const reach = zStart + (Z_FAR - zStart) * intro;

    const { hv, sx, sy } = this;
    for (let j = 0; j <= rows; j++) {
      const z = (k0 + j) * CELL_D - scroll;
      const scale = f / z;
      for (let i = 0; i <= cols; i++) {
        const v = j * stride + i;
        const x = (i - half) * CELL_W;
        const y = this.height(v, x, z);
        hv[v] = y;
        sx[v] = cx + (x - this.camX) * scale;
        sy[v] = horizon + (CAM_H - y) * scale;
      }
    }

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = intro;
    ctx.save();
    ctx.translate(cx, horizon);
    ctx.scale(1, 0.32);
    ctx.fillStyle = colors.glow;
    ctx.fillRect(-w, -h * 2, w * 2, h * 4);
    ctx.restore();
    // A pool of light on the floor under the lens.
    if (this.lens.amp > 0.01) {
      const scale = f / this.lens.z;
      const size = (scale * 0.9) / SPOT_R;
      ctx.save();
      ctx.translate(cx + (this.lens.x - this.camX) * scale, horizon + CAM_H * scale);
      ctx.scale(size, size * 0.45);
      ctx.globalAlpha = intro * this.lens.amp;
      ctx.fillStyle = colors.spot;
      ctx.fillRect(-SPOT_R, -SPOT_R, SPOT_R * 2, SPOT_R * 2);
      ctx.restore();
    }

    // Which cells light, how much, in which colour.
    const { codes, lit, shown, counts, lv, rv } = this;
    counts.fill(0);
    let litCount = 0;
    let shownCount = 0;
    for (let j = 0; j < rows; j++) {
      const zc = (k0 + j + 0.5) * CELL_D - scroll;
      if (zc > reach) {
        break;
      }
      const depth = Math.min(1, (Z_FAR - zc) / (Z_FAR * 0.7)) ** 1.6;
      const row = k0 + j;
      const selected = hash(row, 991) < 0.045;
      for (let i = 0; i < cols; i++) {
        const a = j * stride + i;
        const b = a + 1;
        const c = a + stride + 1;
        const d = a + stride;
        if (sx[b] < 0 || sx[a] > w || sy[a] > h + 40) {
          continue;
        }
        const col = i - half;
        const seed = hash(row, col);
        const kind = slotOf(row, col);
        const pulse = Math.sin(this.t * (0.5 + ((seed * 7.31) % 1) * 0.7) + seed * 40);
        const flicker = Math.max(0, (pulse - 0.9) * 10);
        const lens = (lv[a] + lv[b] + lv[c] + lv[d]) / 4;
        const ripple = (rv[a] + rv[b] + rv[c] + rv[d]) / 4;
        const crest = Math.max(0, (hv[a] + hv[b] + hv[c] + hv[d]) / (4 * SWELL) - 0.55);
        const own = Math.max(flicker * 0.75, lens, ripple * 0.85, crest * 0.35);
        const glow = Math.max(own, selected ? 0.42 : 0);
        const level = Math.round(glow * depth * mode.gain * LEVELS);
        if (level === 0) {
          continue;
        }
        const cell = j * cols + i;
        const slot = selected && own < 0.42 ? ACCENT_SLOT : kind;
        const code = slot * 8 + Math.min(level, LEVELS);
        codes[cell] = code;
        counts[code]++;
        lit[litCount++] = cell;
        if (mode.values && lens > 0.3 && depth > 0.5) {
          shown[shownCount++] = cell;
        }
      }
    }

    for (let code = 0; code < counts.length; code++) {
      if (counts[code] === 0) {
        continue;
      }
      ctx.fillStyle = colors.slots[code >> 3];
      ctx.globalAlpha = ((code & 7) / LEVELS) * colors.maxAlpha;
      ctx.beginPath();
      for (let n = 0; n < litCount; n++) {
        const cell = lit[n];
        if (codes[cell] !== code) {
          continue;
        }
        const a = Math.floor(cell / cols) * stride + (cell % cols);
        ctx.moveTo(sx[a], sy[a]);
        ctx.lineTo(sx[a + 1], sy[a + 1]);
        ctx.lineTo(sx[a + stride + 1], sy[a + stride + 1]);
        ctx.lineTo(sx[a + stride], sy[a + stride]);
        ctx.closePath();
      }
      ctx.fill();
    }

    // The table's rules: one path, fading into the distance.
    const lastRow = Math.min(rows, Math.ceil((reach + scroll) / CELL_D) - k0);
    ctx.globalAlpha = 1;
    ctx.strokeStyle = colors.lines;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let j = 0; j <= lastRow; j++) {
      const v = j * stride;
      ctx.moveTo(sx[v], sy[v]);
      for (let i = 1; i <= cols; i++) {
        ctx.lineTo(sx[v + i], sy[v + i]);
      }
    }
    for (let i = 0; i <= cols; i++) {
      ctx.moveTo(sx[i], sy[i]);
      for (let j = 1; j <= lastRow; j++) {
        const v = j * stride + i;
        ctx.lineTo(sx[v], sy[v]);
      }
    }
    ctx.stroke();

    // The lens reads the values under it.
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    let font = 0;
    for (let n = 0; n < shownCount; n++) {
      const cell = shown[n];
      const j = Math.floor(cell / cols);
      const i = cell % cols;
      const a = j * stride + i;
      const width = sx[a + 1] - sx[a];
      const height = sy[a] - sy[a + stride];
      const size = Math.min(15, Math.round(height * 0.62));
      if (size < 8) {
        continue;
      }
      const row = k0 + j;
      const col = i - half;
      const slot = slotOf(row, col);
      const samples = slot === NULL_SLOT ? null : SAMPLES[KINDS[slot]];
      const text = samples === null ? "NULL" : samples[Math.floor(hash(row, col + 31) * samples.length)];
      if (text.length * size * 0.62 > width - 6) {
        continue;
      }
      if (size !== font) {
        font = size;
        ctx.font = `${size}px ${colors.mono}`;
      }
      const lens = (lv[a] + lv[a + 1] + lv[a + stride] + lv[a + stride + 1]) / 4;
      ctx.globalAlpha = Math.min(1, (lens - 0.3) * 2.5);
      ctx.fillStyle = colors.slots[slot];
      ctx.fillText(
        text,
        (sx[a] + sx[a + 1] + sx[a + stride] + sx[a + stride + 1]) / 4,
        (sy[a] + sy[a + 1] + sy[a + stride] + sy[a + stride + 1]) / 4,
      );
    }
    ctx.globalAlpha = 1;
  }
}

interface HomeBackdropProps {
  mode: BackdropMode;
}

// Drawn while the page is shown and the home on screen; the pointer is read
// from the home itself, the canvas taking no events.
export function HomeBackdrop({ mode }: HomeBackdropProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fieldRef = useRef<Field | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    const canvas = canvasRef.current!;
    const host = canvas.parentElement!;
    const field = new Field(canvas, modeRef.current);
    fieldRef.current = field;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let onScreen = true;

    const update = () => {
      if (reduced.matches) {
        field.stop();
        field.still();
      } else if (onScreen && document.visibilityState === "visible") {
        field.start();
      } else {
        field.stop();
      }
    };
    const resized = () => {
      field.resize();
      if (!field.running) {
        update();
      }
    };
    const themed = () => {
      field.themeChanged();
      if (reduced.matches) {
        field.still();
      }
    };
    const local = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const move = (event: PointerEvent) => {
      const { x, y } = local(event);
      field.point(x, y);
    };
    const down = (event: PointerEvent) => {
      const { x, y } = local(event);
      field.press(x, y);
    };
    const leave = () => field.leave();

    const sizes = new ResizeObserver(resized);
    sizes.observe(canvas);
    const sight = new IntersectionObserver((entries) => {
      onScreen = entries.some((entry) => entry.isIntersecting);
      update();
    });
    sight.observe(canvas);
    field.resize();
    update();
    document.addEventListener("visibilitychange", update);
    reduced.addEventListener("change", update);
    window.addEventListener("tablepeek:theme", themed);
    host.addEventListener("pointermove", move);
    host.addEventListener("pointerdown", down);
    host.addEventListener("pointerleave", leave);
    return () => {
      field.stop();
      fieldRef.current = null;
      sizes.disconnect();
      sight.disconnect();
      document.removeEventListener("visibilitychange", update);
      reduced.removeEventListener("change", update);
      window.removeEventListener("tablepeek:theme", themed);
      host.removeEventListener("pointermove", move);
      host.removeEventListener("pointerdown", down);
      host.removeEventListener("pointerleave", leave);
    };
  }, []);

  useEffect(() => {
    const field = fieldRef.current;
    if (field === null) {
      return;
    }
    field.setMode(mode);
    if (!field.running) {
      field.still();
    }
  }, [mode]);

  return <canvas ref={canvasRef} className={`home-backdrop home-backdrop-${mode}`} aria-hidden="true" />;
}
