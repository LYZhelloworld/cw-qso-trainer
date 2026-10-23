import { nextCqGapMs } from "../ham/activity.js";
import type { Frequency } from "../ham/frequency.js";
import { makeTx } from "../ham/tx.js";
import type { VirtualHam } from "../ham/virtualHam.js";
import type { SessionAudio } from "./sessionAudio.js";
import type { BandMonitor } from "./sessionMonitor.js";

/**
 * How long the receiver stays deaf after the operator's key goes up. Real
 * half-duplex CW sends have a short tail: the operator's own changeover relay
 * and their ears both need a moment before the band comes back.
 */
const TX_TAIL_MS = 1_500;

/** What keying needs from the session. */
export interface KeyingHost {
  /** The clock, in ms. */
  now(): number;
  /** Random source, for the listening gaps that follow a cut CQ. */
  readonly rng: () => number;
  /** The band — its stations have to stand by while our carrier is up. */
  readonly band: Frequency;
  /** Per-call "keying until" timestamps, so a cut station stops being keyed. */
  readonly keyingUntil: Map<string, number>;
  /** The rig is switched on. Nothing can be transmitted with it off. */
  readonly rigOn: boolean;
  /** Can this station be heard from where the dial is? */
  canHear(ham: VirtualHam): boolean;
  /** The station being worked, if any. */
  partner(): VirtualHam | null;
  /** Record the operator's own line in the transcript. */
  sayMine(text: string): void;
  /** The operator is answering: the partner's patience starts over. */
  resetPartnerWait(): void;
  /** Our carrier is down: whatever is on the air now starts playing. */
  reopenReceiver(): void;
}

/**
 * The operator's transmitter: half-duplex, break-in, and the live key.
 *
 * Split out of `QsoSession` because it is the one part of the session that
 * *acts* on the air rather than deciding what to do about it. Everything here
 * answers "is our carrier up, and since when?" — the two text modes key a
 * message they already know, the two key modes build the envelope element by
 * element as the operator works the key.
 *
 * What happens *after* an over is the session's business (`dispatchSent`), not
 * this module's: the line goes out, the busy lock is released, and the band
 * decides who replies. Keeping that boundary is what makes break-in legible —
 * the old over is abandoned by bumping `epoch`, and nothing else has to know
 * how a QSO is supposed to continue.
 *
 * The `epoch` is a generation counter. An over is asynchronous (key, then tail,
 * then a reply), so a reset or a band switch in the middle leaves work in flight
 * that belongs to a world that no longer exists. Each over carries the epoch it
 * started in; anything that wakes up holding a stale one must not drop a carrier
 * on the new world, or clear a flag a newer over now owns.
 */
export class OperatorTx {
  /** True while an over is in flight; guards against interleaved sends. */
  private sending = false;
  /** The session generation. Bumped by `reset` / `cancel` / `invalidate`. */
  private epoch = 0;
  /**
   * True from the moment our carrier goes on the air until the receiver opens
   * again: a station cannot transmit and listen at once (half-duplex).
   */
  private transmitting = false;

  constructor(
    private readonly host: KeyingHost,
    private readonly audio: SessionAudio,
    private readonly monitor: BandMonitor,
    /** Pacing, injectable (tests) — see `QsoSessionOptions.wait`. */
    private readonly wait: (ms: number) => Promise<void>,
  ) {}

  get isSending(): boolean {
    return this.sending;
  }

  get isTransmitting(): boolean {
    return this.transmitting;
  }

  /** The generation this over belongs to. Stale epochs must not touch the rig. */
  get currentEpoch(): number {
    return this.epoch;
  }

  /** Is our carrier on the air right now? (The power switch reads this too.) */
  get carrierUp(): boolean {
    return this.transmitting;
  }

  // --- one over, the text modes -------------------------------------------

  /**
   * Take the busy lock for one over.
   *
   * Returns the epoch this over belongs to, or null when the rig cannot transmit
   * at all (busy with another over, or switched off) — in which case the caller
   * drops the message rather than interleaving it with one already going out.
   */
  beginOver(): number | null {
    // Busy guard: a second send while the first is still going out (or the HAM
    // is mid-reply) is dropped rather than interleaved with it.
    if (this.sending) return null;
    if (!this.host.rigOn) return null; // cannot transmit with the rig off
    this.sending = true;
    return this.epoch;
  }

  /**
   * Release the busy lock — but only if this over is still the current world.
   * A reset bumps the epoch and clears `sending` itself; clearing it again on
   * behalf of an abandoned over would let a *newer* over look idle.
   */
  endOver(epoch: number): void {
    if (epoch !== this.epoch) return;
    this.sending = false;
    // The receiver opens again: whatever is on the air now starts playing.
    this.host.reopenReceiver();
  }

  /**
   * Put the operator's own message on the air.
   *
   * Half-duplex: from the first dit the receiver is deaf, and it stays deaf for
   * a moment after the key goes up (`TX_TAIL_MS`). Everything that was being
   * received is cut, and the waterfall shows this signal instead (see
   * `BandMonitor.spectrum`). The S-meter follows the key while it lasts.
   */
  async transmit(text: string, epoch: number): Promise<void> {
    this.audio.stop(); // our key comes down on top of whatever was playing
    // The band stands by while this message is on the air.
    this.standByBand();
    // The operator is answering: the partner's patience starts over from
    // scratch once this over has been answered.
    this.host.resetPartnerWait();
    this.host.sayMine(text);
    this.transmitting = true;
    const startedAt = this.host.now();
    // One record drives everything: the monitor tone, the S-meter and the
    // waterfall. There is no second copy of the keying to drift.
    const tx = makeTx(text, this.audio.keyElements(text), startedAt);
    this.monitor.setOwnEnvelope(tx.elements, startedAt);
    this.audio.setTransmitting(true);
    try {
      await this.audio.playMine(tx, startedAt);
    } finally {
      await this.wait(TX_TAIL_MS);
      // The band may have been switched away from under this over: `reset()`
      // already lowered the carrier, and a newer over may own it by now.
      if (epoch === this.epoch) this.lowerCarrier();
    }
  }

  // --- live keying (straight key / paddles) --------------------------------
  //
  // In the two key modes the operator keys in real time: the rig goes on the
  // air on the first key-down, the receiver is deaf for as long as they key,
  // and the envelope is built up element by element from what actually went
  // out. Nothing is replayed at the end — the message has already been sent.

  /**
   * Open the operator's carrier for live keying.
   *
   * Returns false when the rig cannot transmit right now (off, or already
   * sending), in which case the key panel must not swallow the key press.
   */
  beginLive(): boolean {
    // Already keying, or the rig is off: there is no carrier to open.
    if (this.transmitting || !this.host.rigOn) return false;

    // **Break-in.** The previous over may still be handing its reply back and
    // forth (`sending` is held until that cycle ends). The key takes over
    // anyway — a transmitter can always transmit. That old cycle belongs to a
    // message already on the air, so it is abandoned (the epoch stops it at its
    // next wake-up) and the station that was still keying into it is silenced,
    // so it cannot talk over the new over.
    if (this.sending) {
      this.epoch += 1;
      const partner = this.host.partner();
      if (partner) this.audio.silenceStation(partner.call);
    }

    this.sending = true;
    // Our key comes down on top of whatever was playing.
    this.audio.stop();
    // The band stands by while this over is on the air.
    this.standByBand();
    // The operator is answering: the partner's patience starts over.
    this.host.resetPartnerWait();
    this.transmitting = true;
    // The envelope starts empty; the key panel fills it in as the key is worked.
    this.monitor.beginOwnOver(this.host.now());
    this.audio.setTransmitting(true);
    return true;
  }

  /** The operator's key went down. */
  keyDown(): void {
    if (!this.transmitting || !this.sending) return;
    // A key that is already down is the same element, not a new one.
    if (this.monitor.keyHeld) return;
    this.monitor.keyDown(this.host.now());
  }

  /** The operator's key came up. */
  keyUp(): void {
    if (!this.transmitting) return;
    this.monitor.keyUp(this.host.now());
  }

  /** Is the key still down? An over cannot be closed mid-element. */
  get keyHeld(): boolean {
    return this.monitor.keyHeld;
  }

  /**
   * End one over keyed live: drop the carrier now.
   *
   * There is no carrier tail to wait out here. This is called after the key has
   * already been silent for a beat (`KeyPanel` owns that clock), and that
   * silence *is* the turn-around — so the receiver opens measured from the last
   * element, not the last element plus a tail.
   */
  closeLive(): void {
    this.lowerCarrier();
  }

  /**
   * Abandon an over that is still open because the panel that owned it is gone
   * (the operator left the page mid-key).
   *
   * The half-keyed text is not sent — the operator never finished it — but the
   * carrier has to come down and the receiver has to open, or the rig stays
   * stuck in TX for a panel that no longer exists.
   */
  cancel(): void {
    if (!this.sending && !this.transmitting) return;
    this.epoch += 1;
    this.audio.stop();
    this.lowerCarrier();
    this.sending = false;
  }

  /** End everything this generation was doing, without opening the receiver. */
  reset(): void {
    this.epoch += 1;
    this.audio.stop();
    this.lowerCarrier();
    this.sending = false;
  }

  /**
   * Disown every over in flight. Used when the session is disposed: nothing it
   * left behind may touch this transmitter again.
   */
  invalidate(): void {
    this.epoch += 1;
  }

  // --- internals -----------------------------------------------------------

  /**
   * Drop the operator's carrier and reopen the receiver.
   *
   * Idempotent, and the only place that lowers `transmitting`: the audio layer's
   * half-duplex gate belongs to the same fact, so the two can never disagree
   * about whether the receiver is open.
   */
  private lowerCarrier(): void {
    this.transmitting = false;
    this.monitor.endOwnOver();
    this.audio.setTransmitting(false);
  }

  /**
   * Put every station on this frequency on standby for the operator's over.
   *
   * While the operator is on the air, nothing else transmits here: a message
   * that was already keying is cut, and its station keeps its place in the
   * rotation (it calls again after a listening gap). This is what makes the
   * silence after the over real — nobody is left half-way through a CQ, waiting
   * to be joined in the middle when the receiver opens.
   */
  private standByBand(): void {
    const now = this.host.now();
    for (const entry of this.host.band.activityState()) {
      if (!this.host.canHear(entry.ham)) continue;
      const call = entry.ham.call;
      if (!this.monitor.onAirTx(entry.ham, now)) continue;
      this.audio.silenceStation(call);
      this.monitor.forget(call);
      this.host.keyingUntil.delete(call);
      if (entry.state === "cqing") {
        this.host.band.scheduleNextCq(call, nextCqGapMs(this.host.rng));
      }
    }
  }
}
