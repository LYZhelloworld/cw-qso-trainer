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

/** Stations on a band are scattered within ±this of the band reference. */
export const BAND_SIGNAL_SPREAD_HZ = 9_000;

export interface SpectrumSignal {
  /** Absolute frequency in Hz. */
  freqHz: number;
  /** Signal strength as heard at the receiver, 0..1. */
  strength: number;
  /** Station callsign; empty for decorative background carriers. */
  call: string;
  /** True for a HAM on the band roster (a station the operator can work). */
  workable: boolean;
  /** True while the station is calling (keyed); false when idle. */
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
 * A handful of weak carriers scattered across the band, so the waterfall looks
 * like a live band rather than an empty grid. Decorative only.
 */
export function buildBackgroundSignals(
  referenceHz: number,
  rng: () => number,
  count?: number,
): SpectrumSignal[] {
  const n = count ?? 3 + Math.floor(rng() * 4); // 3..6
  const out: SpectrumSignal[] = [];
  for (let i = 0; i < n; i += 1) {
    const offset = Math.round(((rng() * 2 - 1) * BAND_SIGNAL_SPREAD_HZ) / 10) * 10;
    out.push({
      freqHz: referenceHz + offset,
      strength: 0.12 + rng() * 0.26, // deliberately weak
      call: "",
      workable: false,
      // Some of them are "sending" so the band has texture, not just flat lines.
      active: rng() < 0.35,
    });
  }
  return out;
}

/** Spread a station's frequency to the nearest 10 Hz (a tidy waterfall column). */
export function quantiseHz(hz: number): number {
  return Math.round(hz / 10) * 10;
}
