/**
 * S-meter: the signal-strength readout on the rig's front panel.
 *
 * The scale
 *  - Nine numbered units, S1 to S9, 6 dB apart, as the IARU defines them: S9 is
 *    −73 dBm and S1 sits 48 dB below it. Anything stronger than S9 is read as
 *    so many dB over: "S9+20". A needle has no reason to stop at the top mark,
 *    and a report of "you are 20 over" is exactly what an operator hears on a
 *    quiet band with a loud station on it.
 *
 * Where the numbers come from
 *  - A station's `strength` is already simulated in `ham/generate`, derived from
 *    the RST it reports, so the meter simply reads that back on the dB scale:
 *    a station reporting 599 sits at S9, one reporting 579 at S7. Deliberate
 *    simplification — in reality the two directions of a path are independent,
 *    and the point here is a meter that agrees with what the operator was told.
 *
 * What moves the needle
 *  - The receiver's filter: a station out on the skirt arrives `passbandGain`
 *    quieter, and the meter drops with it. That is a dB-for-dB drop, so the
 *    gain is added in the dB domain (a linear multiply would compress the fall
 *    into the bottom unit and lose what the operator is watching).
 *  - QSB: every signal fades slowly and by its own amount, so the needle
 *    breathes even with the dial standing still. Derived from the callsign and
 *    the clock, never from the shared RNG — a station fades the same way on
 *    every visit, and no other simulation sequence is shifted by it.
 *
 * Pure logic: no DOM, no audio, no timers.
 */

/** Signal strength at S9, in dBm (IARU). */
export const S9_DBM = -73;

/** dB between adjacent S units. */
export const DB_PER_S_UNIT = 6;

/** Signal strength at S1, in dBm — 48 dB below S9. */
export const S1_DBM = S9_DBM - 8 * DB_PER_S_UNIT;

/**
 * The `strength` a station gets for a 599 report — the anchor tying the
 * simulated strength scale to the dB scale (see `generate.strengthFromReport`,
 * which spreads S1..S9 over 0.30..0.95).
 */
export const S9_STRENGTH = 0.95;

/** Strength covered by one S unit. */
const STRENGTH_PER_S_UNIT = 0.65 / 8;

/**
 * The simulated `strength` that reads as S unit `s` on the meter. `generate`
 * builds a station's strength through this, so the two scales cannot drift
 * apart: change the S scale here and the stations move with it.
 */
export function strengthForSUnit(s: number): number {
  return S9_STRENGTH + (s - 9) * STRENGTH_PER_S_UNIT;
}

/** Deepest fade QSB ever adds, in dB — the swing at full depth. */
export const QSB_MAX_DB = 10;

/**
 * A station's strength as a dBm reading, before the receiver touches it. The
 * mapping is affine on purpose: it is the inverse of how `generate` built the
 * strength, so S numbers come back out of it unchanged.
 */
export function strengthToDbm(strength: number): number {
  return S9_DBM + ((strength - S9_STRENGTH) / STRENGTH_PER_S_UNIT) * DB_PER_S_UNIT;
}

/** 32-bit FNV-1a hash — picks a stable QSB phase per callsign. */
function hashCall(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * The QSB envelope for one station at one moment, in dB (negative = faded).
 *
 * Two out-of-step tones, a slow one (~17 s) and a quicker one (~7 s), so the
 * fade never looks like a clean sine: that irregular breathing is what makes a
 * signal sound alive. The phases come from the callsign, so every station
 * `depth` (0..1) comes from the band's environment — how hard the difficulty
 * setting makes signals fade (see `audio/environment`). At 0 the needle does not
 * move at all, which is what a novice band should look like.
 */
export function qsbDb(call: string, atMs: number, depth = 1): number {
  const swing = QSB_MAX_DB * Math.min(1, Math.max(0, depth));
  if (swing <= 0) return 0;
  const h = hashCall(call);
  const phaseSlow = ((h % 997) / 997) * Math.PI * 2;
  const phaseFast = (((h >>> 11) % 991) / 991) * Math.PI * 2;
  const t = atMs / 1000;
  const slow = 0.65 * Math.sin((t / 17) * Math.PI * 2 + phaseSlow);
  const fast = 0.35 * Math.sin((t / 7) * Math.PI * 2 + phaseFast);
  return (slow + fast) * swing;
}

/**
 * How deeply this band's signals fade, by difficulty. Not the same number as
 * the audio's QSB depth: with a novice setting the *sound* is kept steady so it
 * is easy to copy, but a real needle still breathes with the noise on every
 * signal, so there is always a floor of movement here. Losing the needle
 * entirely would make the meter look broken rather than calm.
 */
export function qsbDepthFor(difficulty: string): number {
  if (difficulty === "hardcore") return 1;
  if (difficulty === "intermediate") return 0.6;
  return 0.25;
}

export interface SMeterOptions {
  /** Filter gain from `passbandGain` — 1 in the passband, 0 when cut off. */
  gain?: number;
  /** QSB envelope in dB (see `qsbDb`). */
  qsbDb?: number;
}

/** What the needle shows. */
export interface SMeterReading {
  /** Signal level in dBm, floored at S1 so the needle never reads below scale. */
  dbm: number;
  /** S unit 1..9; 9 also covers "over S9" (see `overDb`). */
  s: number;
  /** dB over S9, rounded; 0 while the signal is below S9. */
  overDb: number;
  /** Panel text: "S7", "S9", "S9+12". */
  label: string;
}

/**
 * Read the meter for one station: its simulated strength, what the filter is
 * doing to it, and its current QSB. `null` once the filter has cut it off —
 * there is nothing left to point at.
 */
export function smeterReading(
  strength: number,
  opts: SMeterOptions = {},
): SMeterReading | null {
  const gain = opts.gain ?? 1;
  if (!(gain > 0)) return null;
  const dbm = strengthToDbm(strength) + 20 * Math.log10(gain) + (opts.qsbDb ?? 0);

  const overDb = dbm - S9_DBM;
  if (overDb >= 0) {
    const rounded = Math.round(overDb);
    return { dbm, s: 9, overDb: rounded, label: rounded > 0 ? `S9+${rounded}` : "S9" };
  }
  // Nearest mark, not the mark below: a needle 1 dB under S9 still reads S9.
  const s = Math.max(1, Math.min(9, Math.round(9 + overDb / DB_PER_S_UNIT)));
  return { dbm: Math.max(S1_DBM, dbm), s, overDb: 0, label: `S${s}` };
}
