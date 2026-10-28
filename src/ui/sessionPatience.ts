import type { QsoMachine } from "../qso/stateMachine.js";
import type { VirtualHam } from "../ham/virtualHam.js";
import { isContest, type ContestKind } from "../qso/contest.js";

/**
 * How long the operator waits for an answer to their own CQ once the band has
 * gone quiet. Mirrors the machine's `timeoutFirstCall`: a caller who draws no
 * reply gives up and goes back to listening, so that tuning across somebody
 * else's CQ is an answer to *it* rather than a message into the void.
 */
const CALL_ANSWER_WAIT_MS = 15_000;

/**
 * How long the partner waits for the operator's next over before it sends the
 * same thing again. A station that has just reported "R UR RST 579 BK" does not
 * sit in silence — it repeats itself, and after `PARTNER_REPEAT_LIMIT` tries it
 * gives up and goes back to calling CQ. Long enough to decode and key a reply at
 * a learner's speed, short enough that the operator can tell nobody is there.
 *
 * A contest runs on a shorter clock: a runner with a pile-up cannot sit five
 * seconds on every contact, so three to five seconds is all the patience there
 * is. That is part of what makes contest copy different from a rag-chew.
 */
const PARTNER_WAIT_MS = 10_000;
const CONTEST_PARTNER_WAIT_MS = 4_000;

/** How many times the partner repeats before it gives up on the operator. */
const PARTNER_REPEAT_LIMIT = 2;

/** What the two clocks need from the session to do their job. */
export interface PatienceHost {
  /** The clock, in ms. */
  now(): number;
  /** The QSO in progress, if there is one. */
  readonly machine: QsoMachine | null;
  /** The station being worked, if there is one. */
  partner(): VirtualHam | null;
  /** Is a pile-up still calling? Then somebody *is* answering our CQ. */
  pileupIsCalling(): boolean;
  /** The rig is switched on. Off means it neither hears nor transmits. */
  readonly rigOn: boolean;
  /** One of our transmissions is in flight. */
  readonly isSending: boolean;
  /** Our carrier is on the air — nothing can be heard, and nothing answered. */
  readonly isTransmitting: boolean;
  /** We are actually exchanging with a station (not just listening to a CQ). */
  readonly exchangeInProgress: boolean;
  /** Which mode this session is running; a contest waits less. */
  readonly contest: ContestKind;
  /** Give up on the current exchange and go back to listening. */
  endExchange(): void;
  /**
   * Say one line as the partner: transcript, keying, playback. Returns how long
   * the over lasts so the next wait can be timed from its end — or null when
   * there was nothing to put on the air.
   */
  sayPartner(text: string): number | null;
  /** Append a system note to the transcript. */
  note(text: string): void;
}

/**
 * The two clocks that run while the operator is silent.
 *
 * Both answer the same question — *somebody is waiting for me, how long have I
 * got?* — and both end the same way when the answer is "too long": the exchange
 * is abandoned and the band goes back to its own rhythm. Kept together because
 * they are the only part of the session that makes something happen after a
 * *lack* of input, and because they share the rule for what "waiting" means:
 * a band that is still calling is not a band that has given up.
 *
 * Driven from the session's tick; the clock is injected, so nothing here uses a
 * timer of its own.
 */
export class Patience {
  /**
   * When the operator's own CQ stopped drawing any answer (the pile-up emptied,
   * or there never was one). `null` means the operator is not sitting on a call
   * that nobody answered.
   */
  private ownCqSilentSince: number | null = null;
  /**
   * When the partner will repeat itself if the operator stays silent, and how
   * many times it already has. `null` means no over is waiting on an answer.
   */
  private partnerWaitAt: number | null = null;
  private partnerWaits = 0;

  constructor(private readonly host: PatienceHost) {}

  /** One scheduler step. Both clocks are checked on every beat. */
  drive(): void {
    this.expireOwnCq();
    this.servicePartnerWait();
  }

  /**
   * Start the clock on the operator's next over.
   *
   * The band is not a voicemail. A station that has just sent "R UR RST 579 BK"
   * waits, sends it again, and after `PARTNER_REPEAT_LIMIT` tries it gives up
   * and calls CQ again — which is also the cue that the operator has missed
   * their opening. `afterMs` is the over that is still going out: the clock
   * only starts once it has finished keying.
   */
  armPartner(afterMs = 0): void {
    if (!this.host.partner() || !this.host.exchangeInProgress) return;
    const wait = isContest(this.host.contest) ? CONTEST_PARTNER_WAIT_MS : PARTNER_WAIT_MS;
    this.partnerWaitAt = this.host.now() + afterMs + wait;
  }

  /** The operator is answering: the partner starts waiting from scratch. */
  clearPartner(): void {
    this.partnerWaitAt = null;
    this.partnerWaits = 0;
  }

  /**
   * The operator's own CQ gets a limited amount of patience.
   *
   * Without this the machine sits in `USER_CQ` forever: nobody answered, the
   * pile-up emptied, and every later call the operator made — including a
   * perfectly good answer to somebody else's CQ — was swallowed by a machine
   * still waiting for a reply to a question asked minutes ago. The band is not
   * paused while that happens, so the state has to expire the way it does in
   * `QsoMachine.timeoutFirstCall`.
   *
   * The clock only starts once the band has actually gone quiet: a pile-up that
   * is still calling means somebody *is* answering, however long they take.
   */
  private expireOwnCq(): void {
    if (this.host.machine?.state !== "USER_CQ" || this.host.pileupIsCalling()) {
      this.ownCqSilentSince = null;
      return;
    }
    const now = this.host.now();
    if (this.ownCqSilentSince === null) {
      this.ownCqSilentSince = now;
      return;
    }
    if (now - this.ownCqSilentSince < CALL_ANSWER_WAIT_MS) return;
    this.ownCqSilentSince = null;
    this.host.endExchange();
    this.host.note("没有人回应你的呼叫，已回到守听");
  }

  /**
   * The partner's patience runs out while the operator stays silent: it repeats
   * its last over, and eventually gives up.
   *
   * Giving up is not silence either — the station goes back to its own CQ
   * rhythm, so the operator can try again or move on, rather than being left in
   * a QSO the other side has abandoned without saying so.
   */
  private servicePartnerWait(): void {
    if (this.partnerWaitAt === null) return;
    const machine = this.host.machine;
    const partner = this.host.partner();
    if (!this.host.exchangeInProgress || !partner || !machine) {
      this.partnerWaitAt = null;
      return;
    }
    // Powered down, mid-over, or busy keying: nothing to answer to yet.
    if (!this.host.rigOn || this.host.isSending || this.host.isTransmitting) return;
    if (this.host.now() < this.partnerWaitAt) return;

    if (this.partnerWaits >= PARTNER_REPEAT_LIMIT) {
      this.partnerWaitAt = null;
      this.partnerWaits = 0;
      this.host.endExchange();
      this.host.note("对方呼叫几次没人应，已回到 CQ");
      return;
    }

    this.partnerWaits += 1;
    // `timeoutResend` is the machine's own "say that again" (see its timer
    // hooks): it hands back the last over rather than inventing a new one.
    const text = machine.timeoutResend()[0];
    this.partnerWaitAt = null;
    if (!text) {
      // Nothing to repeat — the contact had nothing to say in the first place.
      this.host.endExchange();
      return;
    }
    const durationMs = this.host.sayPartner(text);
    if (durationMs === null) return;
    this.armPartner(durationMs);
  }
}
