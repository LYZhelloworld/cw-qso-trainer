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
 *  - The CW filter is centred on the dial and `PASSBAND_HZ` wide by default,
 *    narrowable further on request (see `PASSBAND_OPTIONS`). Past half its
 *    width the station is not merely mistuned, it is filtered out. That is why
 *    stations sit a whole kHz apart (see `ham/spectrum`): even the widest
 *    passband can never hold two of them.
 *
 * Which sideband (LSB or USB) is in use
 *  - Each band has a convention (`sidebandFor`), but the operator may pin the
 *    other one (`resolveSideband`, from the rig's clickable CW-L / CW-U label).
 *    The convention is the *default*, not a constraint.
 *
 * Simplification, deliberately: a real filter has skirts, so a note fades as it
 * approaches the edge and a badly detuned one folds at zero beat. We cut off
 * hard at the passband edge and keep the note mapping monotonic inside it.
 *
 * Pure logic: no DOM, no audio, no timers.
 */

export type Sideband = "LSB" | "USB";

/**
 * How the operator wants CW's sideband chosen: follow the band's convention
 * (`"auto"`) or pin one sideband regardless of frequency.
 */
export type SidebandPreference = "auto" | Sideband;

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
 * The sideband actually in use: the band's convention unless the operator has
 * pinned one. Pinning is for the operator's own preference (or an unusual
 * setup), not because the convention is in doubt.
 */
export function resolveSideband(
  pref: SidebandPreference | undefined,
  dialHz: number,
): Sideband {
  return pref === "LSB" || pref === "USB" ? pref : sidebandFor(dialHz);
}

/** The rig's mode readout for a sideband — the label the operator clicks. */
export function sidebandLabel(sideband: Sideband): string {
  return sideband === "USB" ? "CW-U" : "CW-L";
}

/** Opposite sideband — what the mode label switches to when clicked. */
export function otherSideband(sideband: Sideband): Sideband {
  return sideband === "USB" ? "LSB" : "USB";
}

/**
 * Receiver CW filter widths the operator can choose, in Hz, widest first.
 * A narrower filter is harder to stay inside — which is the whole point of
 * being able to pick one.
 */
export const PASSBAND_OPTIONS = [500, 250, 100] as const;

/** Default (and widest) receiver CW passband width in Hz, centred on the dial. */
export const PASSBAND_HZ = 500;
export const PASSBAND_HALF_HZ = PASSBAND_HZ / 2;

/**
 * Coerce an arbitrary stored/edited width down to one of the supported filter
 * widths. Anything unrecognised falls back to the default.
 */
export function normalisePassband(hz: unknown): number {
  return typeof hz === "number" && (PASSBAND_OPTIONS as readonly number[]).includes(hz)
    ? hz
    : PASSBAND_HZ;
}

/** Half a (possibly non-default) passband width, in Hz. */
export function passbandHalfHz(passbandHz: number): number {
  return passbandHz / 2;
}

/**
 * Heard-tone limits in Hz. Inside the widest passband the note only ever moves
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
  /** Receiver filter width in Hz (defaults to `PASSBAND_HZ`). */
  passbandHz?: number;
}

/** How far a station sits from the dial, in Hz (positive = above the dial). */
export function detuneHz(stationHz: number, dialHz: number): number {
  return stationHz - dialHz;
}

/**
 * Whether a station falls inside the receiver's passband — i.e. whether it is
 * heard at all. The passband is centred on the dial, so this is simply "within
 * half the filter width of the dial" (`±250 Hz` at the default 500 Hz width).
 */
export function inPassband(
  stationHz: number,
  dialHz: number,
  passbandHz: number = PASSBAND_HZ,
): boolean {
  return Math.abs(detuneHz(stationHz, dialHz)) <= passbandHz / 2;
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
 * silence. A narrower filter (`opts.passbandHz`) simply moves the edge closer in.
 */
export function audibleToneHz(opts: TuningOptions): number | null {
  return inPassband(opts.stationHz, opts.dialHz, opts.passbandHz ?? PASSBAND_HZ)
    ? heardToneHz(opts)
    : null;
}
