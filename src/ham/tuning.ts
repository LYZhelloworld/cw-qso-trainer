/**
 * CW tuning model: which sideband a band is worked on, how wide the receiver's
 * passband is, and what a station sounds like from where the dial happens to be.
 *
 * The dial reads the carrier frequency
 *  - A CW rig displays the *carrier* frequency, not the beat-note frequency.
 *    Put the dial on 7.010000 for a station on 7.010000 and you hear the rig's
 *    sidetone pitch — 700 Hz, if that is what PITCH is set to. Nothing is added
 *    to the readout for the pitch: being on frequency means hearing exactly the
 *    pitch you asked for.
 *
 * Off frequency, still inside the passband: the note shifts
 *  - A CW signal is heard as a *beat note* between the station's carrier and
 *    the receiver's BFO, which sits `pitch` away from the dial. Detune the dial
 *    by Δ and the note moves by exactly Δ — the same mechanism as an SSB
 *    receiver's pitch offset. In the terms the operator sees (the dial D and a
 *    station sitting at displayed frequency F):
 *
 *      USB (20 m and up): the carrier sits `pitch` above the dial, so the note
 *                         is `pitch + (F − D)` — tuning the dial *up* lowers it.
 *      LSB (40 m and down): mirrored — the note is `pitch − (F − D)`, so tuning
 *                         the dial up *raises* the note.
 *
 * Off frequency, outside the passband: the station is simply gone
 *  - The CW filter is `PASSBAND_HZ` wide and centred on the dial. Past
 *    ±`PASSBAND_HALF_HZ` the station is not merely mistuned, it is filtered
 *    out. That is why stations sit a whole kHz apart (see `ham/spectrum`): one
 *    passband can never hold two of them.
 *
 * Simplification, deliberately: a real filter has skirts, so a note fades as it
 * approaches the edge and a badly detuned one folds at zero beat. We cut off
 * hard at ±250 Hz and keep the note mapping monotonic inside the passband.
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
 * Receiver CW passband width in Hz, centred on the dial. A station further away
 * than `PASSBAND_HALF_HZ` is cut off by the filter and not heard at all.
 */
export const PASSBAND_HZ = 500;
export const PASSBAND_HALF_HZ = PASSBAND_HZ / 2;

/**
 * Heard-tone limits in Hz. Inside a 500 Hz passband the note only ever moves
 * ±250 Hz from the pitch, so these are a backstop for a very low or very high
 * PITCH setting rather than something an operator normally runs into.
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
 * Whether a station falls inside the receiver's passband — i.e. whether it is
 * heard at all. The passband is centred on the dial, so this is simply "within
 * ±250 Hz of the dial".
 */
export function inPassband(stationHz: number, dialHz: number): boolean {
  return Math.abs(detuneHz(stationHz, dialHz)) <= PASSBAND_HALF_HZ;
}

/**
 * The tone heard from a station that *is* inside the passband: the CW pitch
 * shifted by the detuning, signed by the band's sideband, clamped to
 * `[MIN_HEARD_HZ, MAX_HEARD_HZ]`. Returns `toneHz` unchanged when the station
 * sits exactly on the dial.
 *
 * Callers that need "is it audible at all" want `audibleToneHz` instead.
 */
export function heardToneHz(opts: TuningOptions): number {
  const sideband = opts.sideband ?? sidebandFor(opts.dialHz);
  const sign = sideband === "USB" ? 1 : -1;
  const raw = opts.toneHz + sign * detuneHz(opts.stationHz, opts.dialHz);
  return Math.round(Math.min(MAX_HEARD_HZ, Math.max(MIN_HEARD_HZ, raw)));
}

/**
 * The tone the operator actually hears from a station: `heardToneHz` while it is
 * inside the passband, `null` once the filter has cut it off. `null` is the
 * whole point — a station 1 kHz off the dial is not a squeaky note, it is
 * silence.
 */
export function audibleToneHz(opts: TuningOptions): number | null {
  return inPassband(opts.stationHz, opts.dialHz) ? heardToneHz(opts) : null;
}
