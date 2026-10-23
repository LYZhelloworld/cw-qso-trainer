/**
 * Band spectrum: where the stations on a band sit in frequency and how strong
 * they sound. This is the model behind the waterfall display.
 *
 * Design notes
 *  - A station's frequency is ABSOLUTE (Hz), never relative to the dial. The
 *    operator tunes *across* the band and the stations stay put; that is
 *    exactly what makes the waterfall trace a slanted curve while tuning.
 *  - Workable stations are the band's virtual HAMs (owned by `Frequency`). On
 *    top of those, the spectrum carries a few weak *background* carriers so the
 *    band looks populated the way a real CW band does. They are decorative and
 *    flagged `workable: false`, so nothing else in the app mistakes them for a
 *    possible QSO partner.
 *  - Pure logic: no DOM, no timers, no audio.
 */

/** Width of the waterfall window in Hz: ±10 kHz around the dial frequency. */
export const SPECTRUM_SPAN_HZ = 20_000;

/**
 * Stations on a band are scattered within ±this of the band reference.
 *
 * Deliberately WIDER than the waterfall window (`SPECTRUM_SPAN_HZ`): a band
 * slice holds far more stations than one screen can show, so tuning across it
 * keeps turning up stations that were not visible a moment ago. That is how a
 * panadapter actually behaves — it shows a window, not the band — and it is
 * what makes tuning a search instead of a list-reading exercise.
 *
 * 25 kHz is also exactly what every band in `ui/bands` has room for around its
 * default reference (7.000–7.050 on 40 m, 14.000–14.050 on 20 m), so no
 * station is ever placed outside its own band.
 */
export const BAND_SIGNAL_SPREAD_HZ = 25_000;

/**
 * Every station on a band sits on this grid (1 kHz).
 *
 * Operators pick round frequencies — 7.010, 7.011, never 7.010.3 — and the
 * spacing has to be at least the receiver's CW passband (500 Hz, see
 * `ham/tuning`) or two stations would both fall inside it and interfere. 1 kHz
 * satisfies that with room to spare: tune onto any station and its neighbour is
 * already filtered out.
 */
export const SIGNAL_GRID_HZ = 1_000;

/** Snap a frequency onto the band's station grid (nearest 1 kHz). */
export function snapToGrid(hz: number): number {
  return Math.round(hz / SIGNAL_GRID_HZ) * SIGNAL_GRID_HZ;
}

/** How many grid slots fit in ±`BAND_SIGNAL_SPREAD_HZ`. */
export const SIGNAL_GRID_SLOTS = Math.floor(BAND_SIGNAL_SPREAD_HZ / SIGNAL_GRID_HZ);

/**
 * True when a signal at `hz` is inside the waterfall window centred on
 * `centerHz` — i.e. when it can appear on the panadapter at all.
 *
 * The pages use this to keep what they list in step with what is on screen:
 * a station outside the window is not something the operator can see, and
 * naming it would take the search away.
 */
export function inSpectrumWindow(
  hz: number,
  centerHz: number,
  spanHz: number = SPECTRUM_SPAN_HZ,
): boolean {
  return Math.abs(hz - centerHz) <= spanHz / 2;
}

export interface SpectrumSignal {
  /** Absolute frequency in Hz. */
  freqHz: number;
  /** Signal strength as heard at the receiver, 0..1. */
  strength: number;
  /** Station callsign; empty for decorative background carriers. */
  call: string;
  /** True for a HAM on the band roster (a station the operator can work). */
  workable: boolean;
  /**
   * True while the station's tone is on the air — its dots and dashes. False
   * in the listening gap between transmissions and between elements, so the
   * waterfall has nothing to draw when there is no sound.
   */
  active: boolean;
}

export interface SpectrumSnapshot {
  /** Dial frequency the receiver is tuned to, in Hz. */
  centerHz: number;
  signals: SpectrumSignal[];
}

/** Deterministic PRNG (mulberry32) — keeps a band's background stable. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A handful of weak carriers scattered across the band slice, so the waterfall
 * looks like a live band rather than an empty grid. Decorative only.
 *
 * The count scales with `BAND_SIGNAL_SPREAD_HZ`, not with the window: roughly a
 * third of them are inside any one screen, which is what keeps the window as
 * populated as it was when stations lived within ±9 kHz.
 */
export function buildBackgroundSignals(
  referenceHz: number,
  rng: () => number,
  count?: number,
): SpectrumSignal[] {
  const n = count ?? 8 + Math.floor(rng() * 8); // 8..15
  const base = snapToGrid(referenceHz);
  const out: SpectrumSignal[] = [];
  for (let i = 0; i < n; i += 1) {
    const slots = Math.round((rng() * 2 - 1) * SIGNAL_GRID_SLOTS);
    out.push({
      freqHz: base + slots * SIGNAL_GRID_HZ,
      strength: 0.12 + rng() * 0.26, // deliberately weak
      call: "",
      workable: false,
      // Some of them are "sending" so the band has texture, not just flat lines.
      active: rng() < 0.35,
    });
  }
  return out;
}
