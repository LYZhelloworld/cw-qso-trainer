import { detuneHz, inPassband, type Reception } from "../ham/tuning.js";
import type { VirtualHam } from "../ham/virtualHam.js";

/**
 * The geometry of the dial: where a station sits relative to the operator, and
 * whether it can be worked from here.
 *
 * Every answer is a pure function of three numbers — the station's frequency,
 * the dial, and the filter width — so this is split out of `QsoSession` as a
 * *reader*: it holds no state of its own and never changes anything. The session
 * hands it a `view()` snapshot on each call, which is how a retune or a filter
 * change reaches it without either side keeping a copy.
 *
 * Kept apart because the same three questions are asked from everywhere — the
 * waterfall, the S-meter, break-in, the pile-up — and "is this station inside my
 * filter" answering itself in six places is how the display and the audio start
 * disagreeing.
 */

/** Where the receiver is pointing right now. */
export interface TuningView {
  /** Dial frequency in Hz. */
  dialHz: number;
  /** Receiver filter width in Hz (500 / 250 / 100). */
  passbandHz: number;
}

export class Tuning {
  constructor(
    private readonly view: () => TuningView,
    /** What the receiver does to a station; see `SessionAudio.reception`. */
    private readonly reception: (ham: VirtualHam) => Reception | null,
  ) {}

  /**
   * How far a station sits from the dial, in Hz (positive = above). Null for a
   * station with no frequency of its own — it is not off the dial, it is simply
   * not placed.
   */
  detuneOf(ham: VirtualHam): number | null {
    if (ham.freqHz <= 0) return null;
    return detuneHz(ham.freqHz, this.view().dialHz);
  }

  /**
   * Is this station inside the filter? This is the "can the operator work it"
   * window, not "can it be heard at all" — the skirt of the filter reaches
   * further than the passband does (see `passbandGain`).
   */
  inPassbandFor(ham: VirtualHam): boolean {
    const { dialHz, passbandHz } = this.view();
    return inPassband(ham.freqHz, dialHz, passbandHz);
  }

  /**
   * Can this station be worked from where the dial is?
   *
   * A station with no frequency of its own (a HAM in the band's listening pool)
   * is not off frequency — it is simply unplaced, and nobody can say it is out
   * of the passband. Those answer "yes" so callers do not have to special-case
   * them.
   */
  canHear(ham: VirtualHam): boolean {
    return ham.freqHz <= 0 || this.inPassbandFor(ham);
  }

  /**
   * The note this station comes through on: the rig's pitch shifted by its
   * distance from the dial. Null once there is nothing to hear — either the
   * station has no frequency, or the filter's skirt has run out.
   */
  toneOf(ham: VirtualHam): number | null {
    if (ham.freqHz <= 0) return null;
    return this.reception(ham)?.toneHz ?? null;
  }

  /**
   * How loud it comes through right now: `1` inside the passband, fading toward
   * `0` on the skirt, `null` when it is gone. Lets the UI say "audible but weak"
   * rather than choosing between "fine" and "silent".
   */
  gainOf(ham: VirtualHam): number | null {
    if (ham.freqHz <= 0) return null;
    return this.reception(ham)?.gain ?? null;
  }

  /**
   * The closest station to the dial however far away — what a search would sweep
   * past first. `candidates` are the stations worth considering at all (the
   * session filters out the ones already busy in somebody else's QSO).
   */
  nearestUsable(candidates: VirtualHam[]): VirtualHam | null {
    const dialHz = this.view().dialHz;
    const byDistance = [...candidates].sort(
      (a, b) => Math.abs(detuneHz(a.freqHz, dialHz)) - Math.abs(detuneHz(b.freqHz, dialHz)),
    );
    return byDistance[0] ?? null;
  }

  /**
   * The station the operator can both hear and work right now. Null when the
   * passband holds nobody — the normal state of a band not yet tuned across.
   */
  heardActive(candidates: VirtualHam[]): VirtualHam | null {
    const nearest = this.nearestUsable(candidates);
    return nearest && this.inPassbandFor(nearest) ? nearest : null;
  }
}
