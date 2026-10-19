/**
 * Pile-up: several stations answering one CQ at the same time.
 *
 * This is the "DX pile-up" an operator meets the moment they call CQ and the
 * band is busy. Everyone answers *on the caller's frequency* — in CW nobody
 * spreads out, they all zero-beat the station they want — so the responder
 * count is not a frequency-spreading thing. What makes a pile-up readable is
 * the timing: each station is silent for a random interval before repeating its
 * call, and those intervals are drawn independently, so the calls interleave
 * instead of landing as one block.
 *
 * The rule the operator has to learn is naming the station they want. Sending a
 * bare "R BK" into a pile-up gets nowhere: every station hears a report that
 * was not addressed to it, so they all stay silent and try again later.
 *
 * Pure logic: no audio, no timers, no roster. The session owns the actual
 * playback and roster bookkeeping.
 */

import type { VirtualHam } from "./virtualHam.js";

/** How many stations answer one CQ (2–3: one responder is not a pile-up). */
export const PILEUP_MIN_CALLERS = 2;
export const PILEUP_MAX_CALLERS = 3;

/**
 * Silence before a station repeats its call. Drawn independently per station
 * so the repeats stagger — the whole point of the model.
 */
export const PILEUP_SILENCE_MIN_MS = 3_000;
export const PILEUP_SILENCE_MAX_MS = 7_000;

/** Calls a station makes before it gives up and leaves the frequency. */
export const PILEUP_MAX_CALLS = 4;

export interface PileupCaller {
  ham: VirtualHam;
  /**
   * Whether the session conjured this station for the pile-up. A spawned
   * caller leaves the band when the pile-up ends; a station that was already
   * on the band just goes back to listening.
   */
  spawned: boolean;
  /** Absolute time of its next transmission. */
  nextCallAt: number;
  /** Transmissions made so far (the first call counts as one). */
  calls: number;
}

/** Uniform integer in [min, max], clamped against an out-of-range injected rng. */
function randInt(min: number, max: number, rng: () => number): number {
  const raw = min + Math.floor(rng() * (max - min + 1));
  return Math.min(max, Math.max(min, raw));
}

/** How many stations answer one CQ (2–3). */
export function pileupSize(rng: () => number = Math.random): number {
  return randInt(PILEUP_MIN_CALLERS, PILEUP_MAX_CALLERS, rng);
}

/** How long a station stays silent before repeating its call (3–7 s). */
export function pileupSilenceMs(rng: () => number = Math.random): number {
  return randInt(PILEUP_SILENCE_MIN_MS, PILEUP_SILENCE_MAX_MS, rng);
}

/**
 * The text a caller sends while in a pile-up: its call, twice. Short, and the
 * repetition is what makes it copyable through the jumble.
 */
export function pileupCallText(call: string): string {
  return `${call} ${call}`;
}

/**
 * The caller the operator named, if any.
 *
 * Matching is a case-insensitive substring test against the *whole* line: in a
 * pile-up the operator's transmission is typically just "JA1ABC DE BG7XXX" or
 * "JA1ABC 599", and the parser's job here is only to find out who was
 * addressed. Anything cleverer (partial calls, typo tolerance) would let the
 * user "work" a station they did not actually copy.
 */
export function matchCaller(
  text: string,
  callers: readonly PileupCaller[],
): PileupCaller | null {
  const upper = text.toUpperCase();
  let best: PileupCaller | null = null;
  let bestAt = Number.POSITIVE_INFINITY;
  for (const c of callers) {
    const at = upper.indexOf(c.ham.call);
    // The station named first in the line is the one that was addressed; two
    // calls in one transmission is unusual, but "the first name wins" is the
    // least surprising rule.
    if (at >= 0 && at < bestAt) {
      best = c;
      bestAt = at;
    }
  }
  return best;
}
