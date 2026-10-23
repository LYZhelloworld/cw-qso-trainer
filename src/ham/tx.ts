import type { KeyElement } from "../cw/decoder.js";

/**
 * One transmission on the air: what a station is saying, how it keys it, and
 * when it started.
 *
 * This is the **keying truth** the whole receiver-side picture reads from. The
 * audio keys exactly these elements, the waterfall asks `txKeyed` (is the tone
 * down right now — the real dots and dashes), and the S-meter asks `txOnAir`
 * (is this over still running — a needle has ballistics and must not flicker at
 * the keying rate). One table, three readers, so they cannot contradict each
 * other: no signal without sound, no reading without a transmission.
 *
 * Kept deliberately free of audio nodes and DOM: it is a clocked description of
 * what is on the air, not a player. `src/audio/bandSynth.ts` turns it into gain
 * ramps; the session turns it into the spectrum and the meter.
 */
export interface Tx {
  /** The message being sent, so a mid-message join knows where it has got to. */
  text: string;
  /** On/off element lengths in ms — the same envelope the audio keys. */
  elements: KeyElement[];
  /** Clock time (ms) at which the first element starts. */
  startedAt: number;
  /** Total keyed length in ms: elements plus the gaps between them. */
  durationMs: number;
}

/** How long an envelope takes to key, gaps included, in ms. */
export function keyedDuration(elements: KeyElement[]): number {
  return elements.reduce((total, e) => total + e.on + e.off, 0);
}

/** Build a transmission record from a message's envelope and its start time. */
export function makeTx(text: string, elements: KeyElement[], startedAt: number): Tx {
  return { text, elements, startedAt, durationMs: keyedDuration(elements) };
}

/** Clock time at which the over ends, in ms. */
export function txEndsAt(tx: Tx): number {
  return tx.startedAt + tx.durationMs;
}

/** Is the whole over still running at `at`? */
export function txOnAir(tx: Tx, at: number): boolean {
  return at >= tx.startedAt && at < txEndsAt(tx);
}

/**
 * Is the tone down at `at` — the dots and dashes, not just the over?
 *
 * Only the waterfall asks this. A panadapter can be honest to the millisecond;
 * a meter has ballistics and holds through the gap between two dits instead of
 * flickering at the keying rate (see `txOnAir`).
 */
export function txKeyed(tx: Tx, at: number): boolean {
  let t = at - tx.startedAt;
  if (t < 0 || t >= tx.durationMs) return false;
  for (const e of tx.elements) {
    if (t < e.on) return true;
    t -= e.on;
    if (t < e.off) return false;
    t -= e.off;
  }
  return false;
}

/**
 * How far into the over `at` is, in seconds — the offset to start playing at
 * when the operator tunes onto a station that is already mid-message. Zero
 * outside the over.
 */
export function txOffsetSec(tx: Tx, at: number): number {
  if (!txOnAir(tx, at)) return 0;
  return (at - tx.startedAt) / 1000;
}
