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
 * the operator can tune in and listen to (and why the 1 kHz band grid does not
 * apply to the pair while they are working each other).
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
 * Pick two stations that are free to work each other.
 *
 * Any station not already in a QSO qualifies, and a station that is *calling
 * CQ* is preferred as the caller: that is precisely what happens on the air —
 * somebody answers the CQ that is already going out. A station already in a QSO
 * is never taken, which also guarantees the operator's own partner is left
 * alone mid-exchange.
 */
export function pickHamQsoPair(
  entries: ReadonlyArray<{ ham: VirtualHam; state: HamActivityState }>,
  rng: () => number = Math.random,
): [VirtualHam, VirtualHam] | null {
  if (entries.length < HAM_QSO_MIN_STATIONS) return null;
  const free = entries.filter((e) => e.state !== "inQso");
  if (free.length < 2) return null;

  // Prefer a station that is already calling CQ as the one being answered.
  const calling = free.filter((e) => e.state === "cqing");
  const pool = calling.length > 0 ? calling : free;
  const a = pool[randInt(0, pool.length - 1, rng)].ham;
  const rest = free.filter((e) => e.ham !== a);
  const b = rest[randInt(0, rest.length - 1, rng)].ham;
  return [a, b];
}
