/**
 * CW tuning model: which sideband a band is worked on, and the audible
 * consequence of not being exactly on a station's frequency.
 *
 * A CW signal is heard as a *beat note* between the station's carrier and the
 * receiver's BFO. Tune perfectly and you hear the rig's sidetone pitch; be a few
 * hundred Hz off and the note is shifted by exactly that much — the same
 * mechanism as an SSB receiver's pitch offset. Expressed in the terms the
 * operator sees (the dial D and a station sitting at displayed frequency F):
 *
 *   USB (20 m and up): the carrier sits `pitch` above the dial, so the note is
 *                      `pitch + (F − D)` — tuning the dial *up* lowers the note.
 *   LSB (40 m and down): mirrored — the note is `pitch − (F − D)`, so tuning the
 *                      dial up *raises* the note.
 *
 * On frequency (F = D) both give exactly the configured CW pitch; every kHz of
 * detuning moves the note. This is the skill of tuning a CW signal by ear.
 *
 * Simplification, deliberately: a real receiver folds the beat at zero and then
 * rejects signals outside its (narrow) passband, so a badly detuned station
 * either rushes back up in pitch or disappears entirely. We keep the mapping
 * monotonic and merely clamp it to an audible range — "further off = more wrong"
 * stays unambiguous, which is what the exercise is about.
 *
 * Pure logic: no DOM, no audio, no timers.
 */

export type Sideband = "LSB" | "USB";

/**
 * CW convention: LSB below this frequency, USB at or above it. 40 m (7 MHz) and
 * the lower bands are worked on LSB; 20 m (14 MHz) and up on USB.
 */
export const SIDEBAND_SPLIT_HZ = 10_000_000;

/** The sideband CW is worked on at a given frequency. */
export function sidebandFor(freqHz: number): Sideband {
  return freqHz >= SIDEBAND_SPLIT_HZ ? "USB" : "LSB";
}

/**
 * Heard-tone limits in Hz. A receiver's CW passband is a few hundred Hz wide, so
 * a badly detuned note would run off the end of the audio range (or below zero);
 * clamping keeps it audible and plausible instead.
 */
export const MIN_HEARD_HZ = 250;
export const MAX_HEARD_HZ = 1800;

export interface TuningOptions {
  /** The rig's CW pitch / sidetone, in Hz. */
  toneHz: number;
  /** The station's frequency, Hz. */
  stationHz: number;
  /** The dial frequency, Hz. */
  dialHz: number;
  /** Override the band's sideband (defaults to `sidebandFor(dialHz)`). */
  sideband?: Sideband;
}

/** How far a station sits from the dial, in Hz (positive = above the dial). */
export function detuneHz(stationHz: number, dialHz: number): number {
  return stationHz - dialHz;
}

/**
 * The tone actually heard from a station: the CW pitch shifted by the detuning,
 * signed by the band's sideband, clamped to `[MIN_HEARD_HZ, MAX_HEARD_HZ]`.
 * Returns `toneHz` unchanged when the station sits exactly on the dial.
 */
export function heardToneHz(opts: TuningOptions): number {
  const sideband = opts.sideband ?? sidebandFor(opts.dialHz);
  const sign = sideband === "USB" ? 1 : -1;
  const raw = opts.toneHz + sign * detuneHz(opts.stationHz, opts.dialHz);
  return Math.round(Math.min(MAX_HEARD_HZ, Math.max(MIN_HEARD_HZ, raw)));
}
