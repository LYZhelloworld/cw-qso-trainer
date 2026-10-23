/**
 * Virtual HAM: a simulated station the user can work. It is a standalone entity —
 * decoupled from the QSO state machine (which now takes a VirtualHam as its
 * partner) so that, in a later step, two HAMs can be paired for HAM-to-HAM
 * background chatter.
 *
 * Per VIRTUAL-HAM.md:
 *  - The callsign suffix is generated randomly (no per-region pattern).
 *  - Difficulty controls how often the HAM fails to copy the user (asks AGN?):
 *    novice 0%, intermediate 1%, hardcore 5%.
 *  - The `report` is the RST this HAM sends for the user's signal; a later step
 *    varies it per HAM behaviour (the step-1 prototype hardcoded 599).
 */

export type Difficulty = "novice" | "intermediate" | "hardcore";

/**
 * Which of the band's two populations a station belongs to (VIRTUAL-HAM.md).
 *
 *  - `caller` — sits on a 1 kHz slot and calls CQ on its own rhythm. These are
 *    the stations the waterfall and the activity list show, and their number is
 *    bounded by the spectrum: one per slot.
 *  - `answerer` — one of the stations listening on the band. It never calls CQ,
 *    holds no slot and is invisible until it answers somebody, so this
 *    population can be far larger than the band can hold.
 *
 * The distinction is not cosmetic: only a *caller* may be placed on a slot, and
 * only an *answerer* may be drawn from the pool when a CQ needs an answer.
 */
export type HamRole = "caller" | "answerer";

/** Probability that the HAM fails to copy the user's transmission (asks AGN?). */
export const MISS_PROBABILITY: Record<Difficulty, number> = {
  novice: 0,
  intermediate: 0.01,
  hardcore: 0.05,
};

/** Fallback strength when a HAM is built without one. */
export const DEFAULT_STRENGTH = 0.7;

export interface VirtualHamOptions {
  call: string;
  difficulty: Difficulty;
  /** RST this HAM reports for the user's signal (default "599"). */
  report?: string;
  /**
   * Absolute frequency this station transmits on, in Hz (0 = not placed yet).
   * Absolute — not relative to the dial — so that turning the dial moves *us*
   * past the station, which is what the waterfall draws as a slanted trace.
   */
  freqHz?: number;
  /** Signal strength as heard at the operator's receiver, 0..1. */
  strength?: number;
  /** Which population this station belongs to (default `caller`). */
  role?: HamRole;
}

export class VirtualHam {
  readonly call: string;
  readonly difficulty: Difficulty;
  readonly missProbability: number;
  readonly report: string;
  /**
   * Mutable on purpose: an answerer has no frequency of its own, and is placed
   * on the frequency of the station it answers for as long as it transmits —
   * which is what makes a pile-up (and a background exchange) co-channel.
   */
  freqHz: number;
  readonly strength: number;
  readonly role: HamRole;

  constructor(opts: VirtualHamOptions) {
    this.call = opts.call;
    this.difficulty = opts.difficulty;
    this.missProbability = MISS_PROBABILITY[opts.difficulty];
    this.report = opts.report ?? "599";
    this.freqHz = opts.freqHz ?? 0;
    this.strength = opts.strength ?? DEFAULT_STRENGTH;
    this.role = opts.role ?? "caller";
  }

  /** Whether this HAM misses the user's transmission this turn. */
  willMiss(rng: () => number = Math.random): boolean {
    return rng() < this.missProbability;
  }
}
