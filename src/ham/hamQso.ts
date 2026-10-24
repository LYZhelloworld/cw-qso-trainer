/**
 * HAM-to-HAM QSO: two virtual stations work each other on the band while the
 * operator listens but cannot break in.
 *
 * This is deliberately a *script*, not the interactive `QsoMachine`. The state
 * machine exists to interpret what the operator types — copy errors, omitted
 * callsigns, retries. Two virtual stations have no operator, so there is nothing
 * to interpret: they simply run the standard exchange from QSO-PROTOCOL.md in
 * order, at the operator's keying speed, with a realistic gap between overs.
 *
 * The exchange is co-channel: the answering station tunes onto the caller's
 * frequency, exactly as a real operator would. That is what makes it something
 * the operator can tune in and listen to; both sides share one carrier, so the
 * waterfall shows a single bright column while they work each other.
 *
 * Pure logic: no DOM, no audio, no timers.
 */

import type { HamActivityState } from "./activity.js";
import type { VirtualHam } from "./virtualHam.js";

/** One over in a HAM-to-HAM exchange. */
export interface HamQsoLine {
  /** `"a"` opened with CQ and closes with 73; `"b"` answered. */
  from: "a" | "b";
  text: string;
}

/**
 * A band needs at least this many stations before two may work each other:
 * the pair plus at least one station left over for the operator to work.
 */
export const HAM_QSO_MIN_STATIONS = 3;

/** How long between two background QSOs on the same band (30–90 s). */
export const HAM_QSO_INTERVAL_MIN_MS = 30_000;
export const HAM_QSO_INTERVAL_MAX_MS = 90_000;

/** Silence between overs in a HAM-to-HAM exchange (0.6–1.6 s). */
export const HAM_QSO_GAP_MIN_MS = 600;
export const HAM_QSO_GAP_MAX_MS = 1_600;

function randInt(min: number, max: number, rng: () => number): number {
  const raw = Math.floor(min + rng() * (max - min + 1));
  return Math.min(max, Math.max(min, raw));
}

/** The standard six-line exchange (QSO-PROTOCOL.md), caller first. */
export function hamQsoScript(a: string, b: string): HamQsoLine[] {
  return [
    { from: "a", text: `CQ CQ CQ DE ${a} ${a} PSE K` },
    { from: "b", text: `${a} DE ${b} K` },
    { from: "a", text: "R UR RST 599 599 BK" },
    { from: "b", text: "R UR RST 599 BK" },
    { from: "a", text: "R TU 73 SK" },
    { from: "b", text: "R TU 73 SK" },
  ];
}

/** How long to wait before looking for the next background QSO. */
export function hamQsoIntervalMs(rng: () => number = Math.random): number {
  return randInt(HAM_QSO_INTERVAL_MIN_MS, HAM_QSO_INTERVAL_MAX_MS, rng);
}

/** Silence after one over before the other station replies. */
export function hamQsoGapMs(rng: () => number = Math.random): number {
  return randInt(HAM_QSO_GAP_MIN_MS, HAM_QSO_GAP_MAX_MS, rng);
}

/**
 * Pick the station that opens the exchange.
 *
 * It must be a *caller* — a station on the spectrum that is calling CQ — because
 * the answerer is drawn from the band's listening pool (`ham/answerers`) and has
 * no frequency of its own. A station already in a QSO is never taken, which also
 * guarantees the operator's own partner is left alone mid-exchange.
 *
 * The caller is drawn from the stations currently calling CQ when there are any:
 * that is precisely what happens on the air — somebody answers the CQ that is
 * already going out.
 */
export function pickHamQsoCaller(
  entries: ReadonlyArray<{ ham: VirtualHam; state: HamActivityState }>,
  rng: () => number = Math.random,
): VirtualHam | null {
  if (entries.length < HAM_QSO_MIN_STATIONS) return null;
  const free = entries.filter((e) => e.state !== "inQso");
  // The caller plus at least one station left over for the operator to work.
  if (free.length < 2) return null;

  const calling = free.filter((e) => e.state === "cqing");
  const pool = calling.length > 0 ? calling : free;
  return pool[randInt(0, pool.length - 1, rng)].ham;
}
