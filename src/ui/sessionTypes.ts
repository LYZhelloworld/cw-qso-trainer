import type { Frequency } from "../ham/frequency.js";
import type { VirtualHam } from "../ham/virtualHam.js";

/**
 * Shared vocabulary of the session layer.
 *
 * `QsoSession` is big enough that it is split across several files
 * (`session.ts`, `sessionPileup.ts`, `sessionHamQso.ts`, `sessionAudio.ts`,
 * `sessionStaging.ts`). Types that more than one of them needs live here, so
 * none of them has to import the class itself — which would be a cycle.
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
  /** The receiver is open (the rig's power switch). */
  readonly isReceiving: boolean;
  /** One of our transmissions is in flight right now. */
  readonly isSending: boolean;
  /** The operator is busy with their own QSO or their own key. */
  readonly isOperatorBusy: boolean;
  /** Dial frequency in Hz — the window centre, and where a pile-up lands. */
  readonly dialHz: number;
  /** Receiver filter width in Hz. */
  readonly passbandHz: number;
  /** The operator's callsign (a fallback when they have not set one). */
  myCall(): string;
  /** Append a line to the transcript. */
  push(who: Speaker, text: string): void;
  /** Append a system note to the transcript. */
  note(text: string): void;
  /** Render and play a station's transmission. */
  playHam(text: string, ham?: VirtualHam): Promise<void>;
  /** How long a message takes to key at the operator's speed, in ms. */
  callDurationMs(text: string): number;
}
