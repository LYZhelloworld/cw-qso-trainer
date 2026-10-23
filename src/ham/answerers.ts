/**
 * The band's second population: the stations that *answer* CQ.
 *
 * A real band holds two kinds of station at once, and only one of them can be
 * seen on a waterfall:
 *
 *  - **Callers** sit on a frequency and call CQ. They are transmitting, so they
 *    are visible, countable and bounded by the spectrum (one per 1 kHz slot —
 *    see `ham/activity` and `ham/frequency`).
 *  - **Answerers** are listening. They never call CQ, they hold no slot, and
 *    nothing about them is visible until they key up to answer somebody. Their
 *    number has nothing to do with how many frequencies the band has: it is the
 *    number of hams *listening*, which is far larger than the spectrum can hold.
 *
 * This module models that second population as a pool. A station is drawn when
 * a CQ needs an answer (the operator's own CQ, or another station's CQ in a
 * background exchange), and it disappears back into the pool when it stops
 * transmitting. Drawing is lazy: only as many stations are generated as are
 * actually needed, so a 100-strong pool costs nothing until it is used.
 *
 * Pure logic: no timers, no audio, no band bookkeeping. The caller (a
 * `Frequency`) supplies the generator and owns the resulting stations.
 */

import type { VirtualHam } from "./virtualHam.js";

/**
 * How many stations are listening on one band, waiting for a CQ to answer.
 *
 * Deliberately far above the band's slot count (51 at ±25 kHz / 1 kHz): that
 * number is a property of the *spectrum*, and these stations are not on it.
 */
export const ANSWERER_POOL_MIN = 80;
export const ANSWERER_POOL_MAX = 120;

/** Uniform integer in [min, max], clamped against an out-of-range injected rng. */
function randInt(min: number, max: number, rng: () => number): number {
  const raw = min + Math.floor(rng() * (max - min + 1));
  return Math.min(max, Math.max(min, raw));
}

/** Size of one band's answerer population (80–120). */
export function answererPoolSize(rng: () => number = Math.random): number {
  return randInt(ANSWERER_POOL_MIN, ANSWERER_POOL_MAX, rng);
}

export interface AnswererPoolOptions {
  /** How many stations listen on this band (see `answererPoolSize`). */
  size: number;
}

/**
 * A band's listeners. `draw()` hands out stations that are about to transmit;
 * `release()` takes them back when they stop.
 */
export class AnswererPool {
  private readonly listeners: VirtualHam[] = [];
  private generated = 0;
  private readonly target: number;

  constructor(opts: AnswererPoolOptions) {
    this.target = Math.max(0, Math.floor(opts.size));
  }

  /** How many stations this band has in total. */
  get size(): number {
    return this.target;
  }

  /** How many could still be drawn (never used, plus those back from a QSO). */
  get available(): number {
    return this.target - this.generated + this.listeners.length;
  }

  /**
   * Take up to `count` stations out of the pool. `spawn` is called only for
   * stations that have never been used, so a long session recycles faces
   * instead of growing without bound.
   *
   * `taken` holds callsigns already on the band (the callers). A listener must
   * not share a call with a visible station; if the generator produces one, it
   * is redrawn.
   */
  draw(
    count: number,
    spawn: () => VirtualHam,
    taken: ReadonlySet<string> = new Set<string>(),
  ): VirtualHam[] {
    const out: VirtualHam[] = [];
    while (out.length < count) {
      const ham = this.listeners.shift() ?? this.fresh(spawn);
      if (!ham) break;
      if (taken.has(ham.call) || out.some((o) => o.call === ham.call)) continue;
      out.push(ham);
    }
    return out;
  }

  /**
   * The station has stopped transmitting and is listening again. Its frequency
   * is cleared: it was only ever on the band for the length of its over.
   */
  release(ham: VirtualHam): void {
    ham.freqHz = 0;
    if (!this.listeners.includes(ham)) this.listeners.push(ham);
  }

  /** A station that has never transmitted before, or null when the band is out. */
  private fresh(spawn: () => VirtualHam): VirtualHam | null {
    if (this.generated >= this.target) return null;
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const ham = spawn();
      // Two listeners with the same call would read as one station answering
      // twice; the generator is random, so a collision means "draw again".
      if (this.seen.has(ham.call)) continue;
      this.seen.add(ham.call);
      this.generated += 1;
      return ham;
    }
    return null;
  }

  /** Every callsign this pool has ever handed out. */
  private readonly seen = new Set<string>();
}
