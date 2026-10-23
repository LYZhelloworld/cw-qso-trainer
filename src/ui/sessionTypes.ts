import type { Frequency } from "../ham/frequency.js";
import type { VirtualHam } from "../ham/virtualHam.js";

/**
 * Shared vocabulary of the session layer.
 *
 * `QsoSession` is big enough that it is split across several files:
 * `session.ts` (the session itself), `sessionTypes.ts` (this file),
 * `sessionTuning.ts`, `sessionAudio.ts`, `sessionMonitor.ts`, `sessionKeying.ts`,
 * `sessionPileup.ts`, `sessionHamQso.ts`, `sessionPatience.ts` and
 * `sessionStaging.ts`. Types that more than one of them needs live here, so none
 * of them has to import the class itself — which would be a cycle.
 */

/** Who produced a transcript line. */
export type Speaker = "me" | "ham" | "sys";

/** One line of the transcript (internal bookkeeping — it is never rendered). */
export interface TranscriptLine {
  who: Speaker;
  text: string;
}

/**
 * The slice of the session that the drivers are allowed to touch.
 *
 * The session owns the *operator's* QSO; the drivers own the band's own life (a
 * pile-up answering our CQ, two stations working each other). Funnelling their
 * needs through this interface means a driver can never quietly reach into the
 * session's state: everything it may read or do is listed right here, and the
 * direction of the dependency is one-way (`driver → context`, never back).
 */
export interface SessionContext {
  /** Random source, shared with the session (tests inject a deterministic one). */
  readonly rng: () => number;
  /** The clock, in ms. */
  now(): number;
  /** The band — its roster and its listening pool. */
  readonly band: Frequency;
  /** Per-call "keying until" timestamps (ms) for the waterfall. */
  readonly keyingUntil: Map<string, number>;
  /**
   * Sound could come out of the speaker right now: the rig is on **and** we are
   * not transmitting. Half-duplex means transmit *or* listen, so our own carrier
   * makes the receiver deaf. Ask this before playing anything at the operator.
   */
  readonly isReceiving: boolean;
  /**
   * The rig is switched on. Power only — it stays true while we transmit.
   *
   * Kept separate from `isReceiving` on purpose. The S-meter asks this one to
   * decide whether it has a needle at all, and `isTransmitting` to decide what
   * the needle reads; folding the two into `isReceiving` would make the meter
   * read `null` for the whole of our own over (it still has to read our key).
   */
  readonly rigOn: boolean;
  /** One of our transmissions is in flight right now. */
  readonly isSending: boolean;
  /** The operator's own carrier is on (or was, until a moment ago). */
  readonly isTransmitting: boolean;
  /** The operator is busy with their own QSO or their own key. */
  readonly isOperatorBusy: boolean;
  /** Dial frequency in Hz — the window centre, and where a pile-up lands. */
  readonly dialHz: number;
  /** Receiver filter width in Hz. */
  readonly passbandHz: number;
  /** Where this band's stations live, in Hz — also the seed for its scenery. */
  readonly referenceHz: number;
  /** The operator's callsign (a fallback when they have not set one). */
  myCall(): string;
  /** The station being worked, if there is one. */
  partner(): VirtualHam | null;
  /** Every station holding a slot on this band. */
  listHams(): VirtualHam[];
  /** The stations answering our CQ (they hold no slot on the roster). */
  pileupCallers(): VirtualHam[];
  /** Can this station be worked from where the dial is? See `sessionTuning`. */
  canHear(ham: VirtualHam): boolean;
  /** A human-readable band label for the debug console, e.g. "14.050". */
  bandLabel(): string;
  /**
   * "Keying until" for a station driven by the background pair — those two are
   * not in the keying table, so their carrier is known only by deadline.
   */
  pairKeyingUntil(call: string): number;
  /** Append a line to the transcript. */
  push(who: Speaker, text: string): void;
  /** Append a system note to the transcript. */
  note(text: string): void;
  /** Render and play a station's transmission. */
  playHam(text: string, ham?: VirtualHam): Promise<void>;
  /** How long a message takes to key at the operator's speed, in ms. */
  callDurationMs(text: string): number;
}
