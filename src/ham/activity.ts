/**
 * HAM activity scheduling: when a virtual HAM calls CQ, and how long it takes to
 * answer the user.
 *
 * Per VIRTUAL-HAM.md:
 *  - A calling station transmits continuously: one CQ burst, a short listening
 *    gap, then the next burst. The band is never quiet for long, which is what a
 *    real band segment sounds like and what makes "tune in and listen" work.
 *  - 12–18 HAMs are *calling* on a band at a time (the band's callers; the
 *    stations that only answer CQ are a separate, much larger population — see
 *    `ham/answerers`)
 *  - Answers the user's CQ after 1–5 s
 *  - Replies to the user's answer after 1–3 s
 *
 * Pure logic: the clock and the RNG are injected and there is no `setTimeout`
 * inside, so behaviour is fully deterministic and unit-testable. The UI layer
 * owns the real timer that calls `advance()` — the same split used by
 * `cw/keyer.ts`, where the core is driven from outside.
 */

import type { VirtualHam } from "./virtualHam.js";

/**
 * Silence between one CQ burst and the next, in ms (3–8 s) — the operator
 * listening between overs. The burst itself lasts as long as the message does
 * (the session knows that and re-times the next one with `scheduleNext`), so
 * this is a *gap*, not an interval between starts.
 */
export const CQ_GAP_MIN_MS = 3_000;
export const CQ_GAP_MAX_MS = 8_000;
/**
 * How long a station waits before calling CQ again after signing off a QSO
 * (2–6 s). It has just said 73; a real operator clears the key, listens for a
 * moment, then starts calling again.
 */
export const RESUME_CQ_DELAY_MIN_MS = 2_000;
export const RESUME_CQ_DELAY_MAX_MS = 6_000;
/**
 * Number of *calling* stations kept active on one band.
 *
 * A real CW band segment is busy, and — this is the point — wider than any one
 * screen: the stations are scattered over ±25 kHz (`ham/spectrum`) while the
 * waterfall shows ±10 kHz, so the operator meets new stations by tuning rather
 * than by looking at a list. 12–18 stations over 51 grid slots is roughly one
 * every 3 kHz: enough to keep hunting, thin enough that a 500 Hz passband is
 * usually empty until you land on somebody.
 *
 * Only callers count here. The stations that merely answer CQ hold no slot and
 * are not part of this number — that pool is far larger and lives in
 * `ham/answerers`.
 */
export const ACTIVE_HAMS_MIN = 12;
export const ACTIVE_HAMS_MAX = 18;
/** Delay before a HAM answers the user's CQ (1–5 s). */
export const ANSWER_CQ_DELAY_MIN_MS = 1_000;
export const ANSWER_CQ_DELAY_MAX_MS = 5_000;
/** Delay before a HAM replies to the user's answer (1–3 s). */
export const REPLY_DELAY_MIN_MS = 1_000;
export const REPLY_DELAY_MAX_MS = 3_000;

export type HamActivityState = "listening" | "cqing" | "inQso";

export interface HamActivityEntry {
  ham: VirtualHam;
  /**
   * Derived: `inQso` > `cqing` (a CQ is out and unanswered) > `listening`.
   * `cqing` is not stored separately — it follows from the CQ timestamp.
   */
  state: HamActivityState;
  /** Absolute time of the next CQ. Only meaningful while not in a QSO. */
  nextCqAt: number;
  /** When the first unanswered CQ went out; null while the HAM has not called. */
  cqSince: number | null;
}

export type HamActivityEvent = { type: "cq"; ham: VirtualHam };

/** Uniform integer in [min, max]. Clamped so an out-of-range injected rng still stays inside. */
function randInt(min: number, max: number, rng: () => number): number {
  const raw = min + Math.floor(rng() * (max - min + 1));
  return Math.min(max, Math.max(min, raw));
}

/** Gap until the next CQ burst (3–8 s). */
export function nextCqGapMs(rng: () => number = Math.random): number {
  return randInt(CQ_GAP_MIN_MS, CQ_GAP_MAX_MS, rng);
}

/** Pause before a station that just finished a QSO calls CQ again (2–6 s). */
export function resumeCqDelayMs(rng: () => number = Math.random): number {
  return randInt(RESUME_CQ_DELAY_MIN_MS, RESUME_CQ_DELAY_MAX_MS, rng);
}

/** How long a HAM takes to answer the user's CQ (1–5 s). */
export function answerCqDelayMs(rng: () => number = Math.random): number {
  return randInt(ANSWER_CQ_DELAY_MIN_MS, ANSWER_CQ_DELAY_MAX_MS, rng);
}

/** How long a HAM takes to reply once the user answered its CQ (1–3 s). */
export function replyDelayMs(rng: () => number = Math.random): number {
  return randInt(REPLY_DELAY_MIN_MS, REPLY_DELAY_MAX_MS, rng);
}

/** How many HAMs to keep active on one band (12–18). */
export function targetHamCount(rng: () => number = Math.random): number {
  return randInt(ACTIVE_HAMS_MIN, ACTIVE_HAMS_MAX, rng);
}

export interface HamActivityOptions {
  rng?: () => number;
  /** Injected clock. */
  now?: () => number;
}

interface Record {
  ham: VirtualHam;
  inQso: boolean;
  nextCqAt: number;
  cqSince: number | null;
}

/**
 * Tracks what every HAM on one frequency is doing. Call `advance(now)` from a
 * driver; it returns the events that fired at that moment.
 */
export class HamActivity {
  private readonly records = new Map<string, Record>();
  private readonly rng: () => number;
  private readonly now: () => number;

  constructor(opts: HamActivityOptions = {}) {
    this.rng = opts.rng ?? Math.random;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * Put a HAM on the frequency.
   *
   * @param firstCqDelayMs Override for the very first CQ. The default is one
   *   listening gap (3–8 s); callers pass something shorter when they want
   *   audible activity immediately after tuning to a band.
   */
  add(ham: VirtualHam, firstCqDelayMs?: number): void {
    if (this.records.has(ham.call)) return;
    const now = this.now();
    this.records.set(ham.call, {
      ham,
      inQso: false,
      nextCqAt: now + (firstCqDelayMs ?? nextCqGapMs(this.rng)),
      cqSince: null,
    });
  }

  remove(call: string): void {
    this.records.delete(call);
  }

  has(call: string): boolean {
    return this.records.has(call);
  }

  /** Snapshot of every HAM on the frequency. */
  list(): HamActivityEntry[] {
    const out: HamActivityEntry[] = [];
    for (const r of this.records.values()) {
      out.push({
        ham: r.ham,
        state: r.inQso ? "inQso" : r.cqSince === null ? "listening" : "cqing",
        nextCqAt: r.nextCqAt,
        cqSince: r.cqSince,
      });
    }
    return out;
  }

  /** Count of HAMs still on the frequency. */
  get size(): number {
    return this.records.size;
  }

  /** The user started working this HAM: stop its CQ rhythm. */
  markInQso(call: string): void {
    const r = this.records.get(call);
    if (!r) return;
    r.inQso = true;
    r.cqSince = null;
  }

  /** The QSO ended: the HAM goes back to listening and will call CQ again. */
  markListening(call: string): void {
    const r = this.records.get(call);
    if (!r) return;
    r.inQso = false;
    r.cqSince = null;
    r.nextCqAt = this.now() + nextCqGapMs(this.rng);
  }

  /**
   * A station just finished a QSO and goes back to calling CQ — the way a real
   * operator does after signing off: a short pause, then "CQ CQ CQ" again.
   *
   * Distinct from `markListening`, which leaves it quiet for the normal gap.
   */
  resumeCq(call: string, delayMs?: number): void {
    const r = this.records.get(call);
    if (!r) return;
    r.inQso = false;
    r.cqSince = null;
    r.nextCqAt = this.now() + (delayMs ?? resumeCqDelayMs(this.rng));
  }

  /**
   * Re-time this station's next CQ. The session calls this after each burst,
   * because only it knows how long the message takes to key: the next CQ starts
   * one message + one listening gap later, so a slow fist is never talked over.
   */
  scheduleNext(call: string, delayMs: number): void {
    const r = this.records.get(call);
    if (!r) return;
    r.nextCqAt = this.now() + Math.max(0, delayMs);
  }

  /**
   * Advance to `at` and return everything that happened.
   *
   * A calling station repeats its CQ for as long as it is on the band — there
   * is no give-up timer. Stations stay put so the band is a stable, continuous
   * signal to tune across; the session re-times each repeat to the length of
   * the message it just sent.
   */
  advance(at: number = this.now()): HamActivityEvent[] {
    const events: HamActivityEvent[] = [];

    for (const r of this.records.values()) {
      if (r.inQso) continue;

      if (at >= r.nextCqAt) {
        r.cqSince = at;
        // Fallback timing; the session re-times it once it knows the message
        // length (see `scheduleNext`).
        r.nextCqAt = at + nextCqGapMs(this.rng);
        events.push({ type: "cq", ham: r.ham });
      }
    }

    return events;
  }
}
