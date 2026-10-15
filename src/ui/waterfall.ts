/**
 * Waterfall (频谱瀑布图) renderer.
 *
 * What it draws
 *  - A window of ±spanHz/2 around the dial (default ±10 kHz). Stations are
 *    drawn as bright peaks at their ABSOLUTE frequency, so a bright blob is a
 *    CW signal sitting on the band.
 *  - Brightness follows the signal strength; a station that is calling CQ is
 *    keyed, so it shows dots and dashes instead of a steady bar.
 *  - Time runs downwards: each line is one instant, older lines slide down.
 *
 * Why tuning traces a curve
 *  - Each line is computed from the dial *at the moment that line is drawn*.
 *    Turning the dial therefore moves only the new line at the top; the history
 *    below stays where it was, and a signal leaves a slanted trace behind it.
 *    The display centre additionally eases towards the dial (like a knob
 *    settling), which turns a hard step into a smooth curve.
 *
 * Testability
 *  - Every piece of geometry/colour maths is a pure exported function.
 *  - The clock and the frame scheduler are injectable, and a missing 2D context
 *    (jsdom) degrades to "compute nothing, throw nothing".
 */

import {
  SPECTRUM_SPAN_HZ,
  mulberry32,
  type SpectrumSignal,
  type SpectrumSnapshot,
} from "../ham/spectrum.js";

/** A station's contribution to one line of the waterfall. */
export interface SignalLevel {
  freqHz: number;
  /** Level for this line, 0..1. */
  level: number;
}

export interface WaterfallOptions {
  /** Total window width in Hz (default ±10 kHz). */
  spanHz?: number;
  /** One line is emitted every this many ms. */
  rowMs?: number;
  /** Time constant of the display-centre easing (the tuning sweep). */
  easeTauMs?: number;
  /** Keying speed used to draw a calling station's dots and dashes. */
  wpm?: number;
  /** Injected clock (tests). */
  now?: () => number;
  /** Injected frame scheduler (tests); returns a canceller. */
  schedule?: (cb: () => void) => () => void;
  /**
   * Injected 2D context. Pass `null` to run headless (jsdom has no canvas).
   * When omitted the context is taken from the canvas element.
   */
  context?: CanvasRenderingContext2D | null;
}

const DEFAULT_ROW_MS = 55;
const DEFAULT_EASE_TAU_MS = 190;
const DEFAULT_WPM = 20;
/** A line is ~90 Hz wide (σ): a CW signal, not a needle. */
const SIGNAL_SIGMA_HZ = 90;
const NOISE_FLOOR = 0.03;
const NOISE_RANGE = 0.05;
/** An idle station is parked, not silent: a faint carrier marks the spot. */
const IDLE_FACTOR = 0.2;
/** Stop catching up after this many lines in one frame (tab was backgrounded). */
const MAX_ROWS_PER_FRAME = 6;

// --- colour map ------------------------------------------------------------

/** Brightness → colour stops: black → deep blue → cyan → yellow → white. */
const RAMP: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 16],
  [0, 36, 100],
  [0, 150, 220],
  [236, 224, 0],
  [255, 255, 255],
];

/** Map a 0..1 brightness to an RGB triple along the waterfall ramp. */
export function brightnessToRgb(v: number): [number, number, number] {
  const t = v <= 0 ? 0 : v >= 1 ? 1 : v;
  const scaled = t * (RAMP.length - 1);
  const i = Math.min(RAMP.length - 2, Math.floor(scaled));
  const f = scaled - i;
  const a = RAMP[i];
  const b = RAMP[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

/** 256-entry lookup of the ramp, so the hot loop allocates nothing. */
const RAMP_LUT: Uint8Array = (() => {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i += 1) {
    const [r, g, b] = brightnessToRgb(i / 255);
    lut[i * 3] = r;
    lut[i * 3 + 1] = g;
    lut[i * 3 + 2] = b;
  }
  return lut;
})();

// --- geometry --------------------------------------------------------------

/** Frequency under a pixel in the *CSS* coordinate space of the display. */
export function freqAtX(x: number, cssWidth: number, centerHz: number, spanHz: number): number {
  if (cssWidth <= 0) return centerHz;
  return centerHz + (x - cssWidth / 2) * (spanHz / cssWidth);
}

/** Pixel (CSS) a frequency sits at. Inverse of `freqAtX`. */
export function xAtFreq(hz: number, cssWidth: number, centerHz: number, spanHz: number): number {
  if (cssWidth <= 0) return 0;
  return cssWidth / 2 + ((hz - centerHz) * cssWidth) / spanHz;
}

/**
 * Ease the display centre towards the dial. Frame-rate independent, so a
 * backgrounded-then-restored tab does not jump.
 */
export function easeCenter(current: number, target: number, dtMs: number, tauMs: number): number {
  if (tauMs <= 0 || dtMs <= 0) return target;
  return current + (target - current) * (1 - Math.exp(-dtMs / tauMs));
}

/**
 * One line of the waterfall: a noise floor with a Gaussian peak per station.
 * `buckets` is the full width in device pixels.
 */
export function renderRow(
  levels: readonly SignalLevel[],
  centerHz: number,
  buckets: number,
  spanHz: number,
  noise: () => number,
  sigmaHz: number = SIGNAL_SIGMA_HZ,
): Float32Array {
  const out = new Float32Array(buckets);
  for (let i = 0; i < buckets; i += 1) out[i] = NOISE_FLOOR + noise() * NOISE_RANGE;

  const hzPerBucket = spanHz / buckets;
  const leftHz = centerHz - spanHz / 2;
  const sigma = Math.max(1, sigmaHz / hzPerBucket);
  const reach = Math.ceil(sigma * 3) + 1;

  for (const s of levels) {
    if (s.level <= 0) continue;
    const pos = (s.freqHz - leftHz) / hzPerBucket;
    if (pos < -reach || pos > buckets - 1 + reach) continue;
    const i0 = Math.max(0, Math.floor(pos - reach));
    const i1 = Math.min(buckets - 1, Math.ceil(pos + reach));
    for (let i = i0; i <= i1; i += 1) {
      const d = (i - pos) / sigma;
      out[i] += s.level * Math.exp(-0.5 * d * d);
    }
  }

  for (let i = 0; i < buckets; i += 1) if (out[i] > 1) out[i] = 1;
  return out;
}

// --- CW keying envelope ----------------------------------------------------

interface KeyCycle {
  /** Element lengths in dit units; sign encodes tone on (+1) or off (-1). */
  durs: number[];
  /** Total cycle length in dit units. */
  total: number;
}

const KEY_CYCLES = new Map<number, KeyCycle>();

/** A station's repeating dot/dash pattern, derived deterministically from seed. */
function keyCycle(seed: number): KeyCycle {
  const cached = KEY_CYCLES.get(seed);
  if (cached) return cached;
  let r = seed >>> 0;
  const next = (): number => {
    r = (Math.imul(r, 1664525) + 1013904223) >>> 0;
    return r;
  };
  const durs: number[] = [];
  let total = 0;
  let on = true;
  while (total < 24) {
    // Tone: a dot (1 dit) or a dash (3 dits). Silence: 1..3 dits.
    const units = on ? (next() % 4 === 0 ? 3 : 1) : 1 + (next() % 3);
    durs.push(on ? units : -units);
    total += units;
    on = !on;
  }
  const cycle: KeyCycle = { durs, total };
  KEY_CYCLES.set(seed, cycle);
  return cycle;
}

/** Stable per-station keying seed (callsign + frequency, so it is unique). */
export function keyingSeed(sig: SpectrumSignal): number {
  const s = `${sig.call}@${Math.round(sig.freqHz)}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Whether a station's tone is on at `tMs` — its dots and dashes. Deterministic,
 * so every run of the waterfall draws the same station the same way.
 */
export function keyingLevel(seed: number, tMs: number, wpm: number): number {
  const dit = 1200 / Math.min(60, Math.max(1, wpm));
  const { durs, total } = keyCycle(seed);
  const period = total * dit;
  let t = tMs % period;
  if (t < 0) t += period;
  for (const d of durs) {
    const dur = Math.abs(d) * dit;
    if (t < dur) return d > 0 ? 1 : 0;
    t -= dur;
  }
  return 0;
}

// --- scheduler -------------------------------------------------------------

function defaultNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function defaultSchedule(cb: () => void): () => void {
  const raf = (globalThis as { requestAnimationFrame?: (c: () => void) => number })
    .requestAnimationFrame;
  if (typeof raf === "function") {
    const id = raf(cb);
    return () => {
      (globalThis as { cancelAnimationFrame?: (id: number) => void }).cancelAnimationFrame?.(id);
    };
  }
  const timer = setTimeout(cb, 16);
  return () => clearTimeout(timer);
}

function safeContext2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  try {
    return typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
  } catch {
    // jsdom without the optional `canvas` package throws here.
    return null;
  }
}

// --- the renderer ----------------------------------------------------------

export class Waterfall {
  readonly canvas: HTMLCanvasElement;
  /** Fired when the operator clicks a signal; the app tunes the dial there. */
  onTune: ((freqHz: number) => void) | null = null;

  private readonly ctxFactory: () => CanvasRenderingContext2D | null;
  private ctx: CanvasRenderingContext2D | null = null;
  private ctxResolved = false;
  private readonly spanHz: number;
  private readonly rowMs: number;
  private readonly easeTauMs: number;
  private readonly now: () => number;
  private readonly schedule: (cb: () => void) => () => void;
  private readonly noise: () => number;

  private source: (() => SpectrumSnapshot) | null = null;
  private latest: SpectrumSnapshot | null = null;
  private active = false;
  private pending: (() => void) | null = null;
  private primed = false;
  private startedAt = 0;
  private lastFrameAt = 0;
  private nextRowAt = 0;
  private centerHz: number | null = null;
  private targetHz = 0;
  private wpm: number;

  private w = 0;
  private h = 0;
  private dpr = 1;
  private rowPx = 1;
  private rowImage: ImageData | null = null;

  constructor(canvas: HTMLCanvasElement, opts: WaterfallOptions = {}) {
    this.canvas = canvas;
    this.ctxFactory = () =>
      "context" in opts ? (opts.context ?? null) : safeContext2d(canvas);
    this.spanHz = opts.spanHz ?? SPECTRUM_SPAN_HZ;
    this.rowMs = opts.rowMs ?? DEFAULT_ROW_MS;
    this.easeTauMs = opts.easeTauMs ?? DEFAULT_EASE_TAU_MS;
    this.now = opts.now ?? defaultNow;
    this.schedule = opts.schedule ?? defaultSchedule;
    this.wpm = opts.wpm ?? DEFAULT_WPM;
    this.noise = mulberry32(0x5eed);
    canvas.addEventListener("click", this.handleClick);
  }

  /** The centre the display is currently drawn around (lags the dial). */
  get displayCenterHz(): number {
    return this.centerHz ?? this.targetHz;
  }

  get isRunning(): boolean {
    return this.active;
  }

  /** Where the next snapshot comes from. Pass null to detach. */
  setSource(fn: (() => SpectrumSnapshot) | null): void {
    this.source = fn;
  }

  /** Keying speed for calling stations (usually the operator's WPM). */
  setSpeed(wpm: number): void {
    if (Number.isFinite(wpm) && wpm > 0) this.wpm = wpm;
  }

  /** Powered up = scroll; powered down = freeze on the last line. */
  setActive(on: boolean): void {
    if (on) this.start();
    else this.stop();
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.syncSize();
    const loop = (): void => {
      if (!this.active) return;
      this.advance(this.now());
      this.pending = this.schedule(loop);
    };
    this.pending = this.schedule(loop);
  }

  stop(): void {
    this.active = false;
    this.pending?.();
    this.pending = null;
  }

  dispose(): void {
    this.stop();
    this.removeClickListener();
    this.source = null;
    this.onTune = null;
  }

  /**
   * Advance to `now`: ease the display centre and emit any lines that are due.
   * Public so a driver (or a test) can step it without a frame scheduler.
   */
  advance(now: number = this.now()): void {
    const snapshot = this.source ? this.source() : null;
    if (snapshot) {
      this.latest = snapshot;
      this.targetHz = snapshot.centerHz;
    }

    const dt = this.lastFrameAt > 0 ? Math.min(250, Math.max(0, now - this.lastFrameAt)) : 16;
    this.lastFrameAt = now;
    this.centerHz =
      this.centerHz === null
        ? this.targetHz
        : easeCenter(this.centerHz, this.targetHz, dt, this.easeTauMs);

    if (!this.syncSize()) return;

    if (!this.primed) {
      this.primed = true;
      this.startedAt = now;
      this.nextRowAt = now;
    }

    let emitted = 0;
    while (now >= this.nextRowAt && emitted < MAX_ROWS_PER_FRAME) {
      this.pushRow(this.nextRowAt - this.startedAt, this.centerHz, this.latest);
      this.nextRowAt += this.rowMs;
      emitted += 1;
    }
    // Fell far behind (tab was in the background): resync instead of storming.
    if (emitted >= MAX_ROWS_PER_FRAME) this.nextRowAt = now + this.rowMs;
  }

  /** Draw one line and scroll the history down. */
  private pushRow(
    tMs: number,
    centerHz: number,
    snapshot: SpectrumSnapshot | null,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !this.rowImage) return;

    // Scroll: the whole history moves down by one line, so only the new line at
    // the top reflects the current dial.
    ctx.drawImage(this.canvas, 0, 0, this.w, this.h, 0, this.rowPx, this.w, this.h);

    const levels = this.levelsFor(snapshot, tMs, centerHz);
    const row = renderRow(levels, centerHz, this.w, this.spanHz, this.noise);
    const data = this.rowImage.data;
    for (let x = 0; x < this.w; x += 1) {
      const idx = (row[x] * 255) | 0;
      const o = idx * 3;
      const r = RAMP_LUT[o];
      const g = RAMP_LUT[o + 1];
      const b = RAMP_LUT[o + 2];
      for (let y = 0; y < this.rowPx; y += 1) {
        const p = (y * this.w + x) * 4;
        data[p] = r;
        data[p + 1] = g;
        data[p + 2] = b;
        data[p + 3] = 255;
      }
    }
    ctx.putImageData(this.rowImage, 0, 0);
  }

  /** Turn the band's signals into per-line levels (keying, idle carrier). */
  private levelsFor(
    snapshot: SpectrumSnapshot | null,
    tMs: number,
    centerHz: number,
  ): SignalLevel[] {
    if (!snapshot) return [];
    const out: SignalLevel[] = [];
    const margin = this.spanHz * 0.6; // ignore anything well outside the window
    for (const sig of snapshot.signals) {
      if (Math.abs(sig.freqHz - centerHz) > margin) continue;
      const level = sig.active
        ? sig.strength * keyingLevel(keyingSeed(sig), tMs, this.wpm)
        : sig.strength * IDLE_FACTOR;
      if (level > 0.02) out.push({ freqHz: sig.freqHz, level });
    }
    return out;
  }

  /**
   * Match the backing store to the element's CSS box. Returns false while the
   * element has no layout yet (detached, or under jsdom), so nothing is drawn
   * and the existing picture is never wiped by a transient zero size.
   */
  private syncSize(): boolean {
    const cssW = this.canvas.clientWidth;
    const cssH = this.canvas.clientHeight;
    if (cssW <= 0 || cssH <= 0) return false;

    // Acquire the drawing context only now that there is a box to draw into.
    // Under jsdom (no layout) this never happens, so nothing is logged.
    if (!this.ctxResolved) {
      this.ctxResolved = true;
      this.ctx = this.ctxFactory();
    }

    const dpr = Math.min(2, Math.max(1, globalThis.devicePixelRatio || 1));
    const w = Math.round(cssW * dpr);
    const h = Math.round(cssH * dpr);
    if (w === this.w && h === this.h && dpr === this.dpr) return true;

    this.canvas.width = w;
    this.canvas.height = h;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    this.rowPx = dpr;
    if (this.ctx) {
      this.rowImage = this.ctx.createImageData(w, this.rowPx);
      this.ctx.fillStyle = "#000208";
      this.ctx.fillRect(0, 0, w, h);
    }
    return true;
  }

  private readonly handleClick = (e: MouseEvent): void => {
    if (!this.onTune) return;
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width <= 0) return;
    const hz = freqAtX(e.clientX - rect.left, rect.width, this.displayCenterHz, this.spanHz);
    this.onTune(this.nearestWorkable(hz) ?? hz);
  };

  /** Snap a click onto a workable station when it lands close enough. */
  private nearestWorkable(hz: number): number | null {
    const signals = this.latest?.signals;
    if (!signals) return null;
    let best: number | null = null;
    let bestDistance = Infinity;
    for (const s of signals) {
      if (!s.workable) continue;
      const d = Math.abs(s.freqHz - hz);
      if (d < bestDistance) {
        bestDistance = d;
        best = s.freqHz;
      }
    }
    return best !== null && bestDistance <= 300 ? best : null;
  }

  private removeClickListener(): void {
    this.canvas.removeEventListener("click", this.handleClick);
  }
}
