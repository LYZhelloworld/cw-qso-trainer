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
 * Off frequency, outside the passband: the station fades, then is gone
 *  - The CW filter is centred on the dial and `PASSBAND_HZ` wide by default,
 *    narrowable further on request (see `PASSBAND_OPTIONS`). Inside half its
 *    width a station is at full strength and can be worked. Just outside, it is
 *    still faintly audible — the filter has skirts, not a brick wall — but it
 *    fades away over the next half-width and by `1.5 × half` it is silent. That
 *    fade is the audible cue that you have left the window you can work in;
 *    `inPassband` (not the fade) decides what is workable. Stations sit a whole
 *    kHz apart (see `ham/spectrum`), so even the widest passband plus its skirts
 *    can never hold two of them.
 *
 * Which sideband (LSB or USB) is in use
 *  - Each band has a convention (`sidebandFor`), but the operator may pin the
 *    other one (`resolveSideband`, from the rig's clickable CW-L / CW-U label).
 *    The convention is the *default*, not a constraint.
 *
 * Simplification, deliberately: the note mapping stays monotonic inside the
 * passband. A real filter also folds at zero beat (the note turns around and
 * rises again on the other side); we do not model that.
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
 * How far past the passband edge a station is still faintly audible, as a
 * multiple of the half-width: at 500 Hz wide, the fade runs out at ±375 Hz.
 */
export const SKIRT_FACTOR = 1.5;

/** Level at the far end of the skirt, in dB below a station on the nose. */
export const SKIRT_FLOOR_DB = -26;

/** Linear amplitude at the far end of the skirt (≈ 0.05). */
export const SKIRT_FLOOR_GAIN = 10 ** (SKIRT_FLOOR_DB / 20);

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
 * at full strength and can be worked. The passband is centred on the dial, so
 * this is simply "within half the filter width of the dial" (`±250 Hz` at the
 * default 500 Hz width).
 *
 * This is the *workable* window, not "everything you can hear": the filter's
 * skirts carry a station a little further out at reduced volume
 * (`passbandGain`), which is deliberately not enough to work it.
 */
export function inPassband(
  stationHz: number,
  dialHz: number,
  passbandHz: number = PASSBAND_HZ,
): boolean {
  return Math.abs(detuneHz(stationHz, dialHz)) <= passbandHz / 2;
}

/**
 * How loud a station is heard, as a linear amplitude multiplier in [0, 1]:
 *
 *  - inside the passband: `1` — flat, the filter passes it untouched
 *  - up to `SKIRT_FACTOR × half` outside: a raised-cosine roll-off down to
 *    `SKIRT_FLOOR_GAIN` (−26 dB), so the signal dies away as the dial drifts off
 *  - beyond that: `0` — silence
 *
 * Only the station's own volume is affected. The band's noise and interference
 * do not fade with it (`renderCwAudio` applies this to the signal alone): when
 * the tone is 26 dB down it is down *in the noise*, which is exactly why the
 * last stretch of the skirt is unusable rather than merely quiet.
 */
export function passbandGain(
  stationHz: number,
  dialHz: number,
  passbandHz: number = PASSBAND_HZ,
): number {
  const half = passbandHz / 2;
  const excess = Math.abs(detuneHz(stationHz, dialHz)) - half;
  if (excess <= 0) return 1;
  const span = (SKIRT_FACTOR - 1) * half;
  if (span <= 0 || excess >= span) return 0;
  return (
    SKIRT_FLOOR_GAIN +
    (1 - SKIRT_FLOOR_GAIN) * 0.5 * (1 + Math.cos((Math.PI * excess) / span))
  );
}

/** What the operator hears from one station at a given dial setting. */
export interface Reception {
  /** The beat note, in Hz. */
  toneHz: number;
  /** Amplitude multiplier for the signal (`1` inside the passband). */
  gain: number;
  /** Inside the passband — i.e. loud *and* workable, not just audible. */
  inPassband: boolean;
}

/**
 * Everything the receiver does to one station: the note it is heard at, how
 * loud, and whether it is inside the workable window. `null` when the filter
 * has cut it off entirely (`gain === 0`).
 */
export function receiveStation(opts: TuningOptions): Reception | null {
  const passbandHz = opts.passbandHz ?? PASSBAND_HZ;
  const gain = passbandGain(opts.stationHz, opts.dialHz, passbandHz);
  if (gain <= 0) return null;
  return {
    toneHz: heardToneHz(opts),
    gain,
    inPassband: inPassband(opts.stationHz, opts.dialHz, passbandHz),
  };
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
 * The tone the operator can still hear from a station: `heardToneHz` while it is
 * audible at all — inside the passband or on the skirt — and `null` once the
 * filter has cut it off. It is not a wrong note at the edge, it is a quieter one;
 * then nothing. A narrower filter (`opts.passbandHz`) moves the fade closer in.
 *
 * Use `receiveStation` when the volume matters too, and `inPassband` to decide
 * whether the station is actually workable.
 */
export function audibleToneHz(opts: TuningOptions): number | null {
  return receiveStation(opts)?.toneHz ?? null;
}
