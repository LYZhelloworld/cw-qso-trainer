import {
  hamQsoGapMs,
  hamQsoIntervalMs,
  hamQsoScript,
  pickHamQsoCaller,
  type HamQsoLine,
} from "../ham/hamQso.js";
import { inPassband } from "../ham/tuning.js";
import type { VirtualHam } from "../ham/virtualHam.js";
import type { SessionContext } from "./sessionTypes.js";

/**
 * Two stations on the band working each other — the band's own life, not part
 * of the operator's QSO.
 *
 * Deliberately **internal**: on the air you cannot see that two stations are
 * working each other. You either tune onto them and hear the exchange, or you
 * know nothing about it. There is therefore no accessor for "are they in a
 * QSO" — `caller()` / `answerer()` exist only so the waterfall can draw one
 * column instead of two, and so a CQ keyed on top of them gets no reply.
 */
interface Exchange {
  /** The station on the spectrum that opened with CQ. */
  a: VirtualHam;
  /** The listener that answered it — drawn from the band's answerer pool. */
  b: VirtualHam;
  freqHz: number;
  script: HamQsoLine[];
  /** Index of the next over to send. */
  index: number;
  /** When that over is due, in ms. */
  nextAt: number;
}

export class HamQsoDriver {
  private exchange: Exchange | null = null;
  /** When to look for the next exchange (0 = not scheduled yet). */
  private nextAttemptAt = 0;

  constructor(private readonly ctx: SessionContext) {}

  /** The station on the spectrum in the current exchange, if any. */
  caller(): VirtualHam | null {
    return this.exchange?.a ?? null;
  }

  /** The station that answered it, if any. */
  answerer(): VirtualHam | null {
    return this.exchange?.b ?? null;
  }

  /**
   * The waterfall draws a co-channel pair once. Both halves key the same
   * column, so a caller's column lights while *either* of them is on the air.
   * Returns 0 for a station that is not part of the exchange.
   */
  keyingUntilFor(call: string): number {
    const q = this.exchange;
    if (!q || (call !== q.a.call && call !== q.b.call)) return 0;
    return Math.max(this.ctx.keyingUntil.get(q.a.call) ?? 0, this.ctx.keyingUntil.get(q.b.call) ?? 0);
  }

  /**
   * True when a pair is working each other on the dial frequency, i.e. the
   * operator can hear the exchange. Whether they are actually there is never
   * reported — this is only used to decide what *happens*, not what is shown:
   * a CQ keyed on top of an exchange is simply not answered.
   */
  isAudible(): boolean {
    const q = this.exchange;
    return q !== null && inPassband(q.freqHz, this.ctx.dialHz, this.ctx.passbandHz);
  }

  /**
   * Advance (or occasionally start) an exchange.
   *
   * The pair runs its own script on the clock: one over at a time, at the
   * operator's keying speed, with a short gap between overs. It keeps running
   * whether or not the operator is listening — this is the band's own life, not
   * part of their QSO. Audio is only rendered when the receiver is on *and* the
   * dial is on that frequency, which `playHam` already enforces.
   */
  drive(): void {
    const now = this.ctx.now();
    const q = this.exchange;
    if (!q) {
      if (this.nextAttemptAt === 0) this.nextAttemptAt = now + hamQsoIntervalMs(this.ctx.rng);
      if (now < this.nextAttemptAt) return;
      // Schedule the next attempt first, so a band with nobody free simply
      // tries again later instead of re-rolling on every tick.
      this.nextAttemptAt = now + hamQsoIntervalMs(this.ctx.rng);
      this.start(now);
      return;
    }
    if (now < q.nextAt) return;
    // The operator's key is on the air: both stations stand by rather than
    // stepping on a transmission they can hear.
    if (this.ctx.isSending) return;

    if (q.index >= q.script.length) {
      this.finish();
      return;
    }

    const line = q.script[q.index];
    const speaker = line.from === "a" ? q.a : q.b;
    const duration = this.ctx.callDurationMs(line.text);
    q.index += 1;
    q.nextAt = now + duration + hamQsoGapMs(this.ctx.rng);
    // Only the station that is actually sending is keying; the waterfall's
    // column (they share one) lights while either of them is on the air.
    this.ctx.keyingUntil.set(speaker.call, now + duration);
    if (this.ctx.isReceiving) {
      void this.ctx.playHam(line.text, speaker).then(() => {
        this.ctx.keyingUntil.delete(speaker.call);
      });
    }
  }

  /** Both stations sign off; drop the exchange (see `finish`). */
  reset(): void {
    if (this.exchange) this.finish();
    this.nextAttemptAt = 0;
  }

  /**
   * One station calls CQ and somebody answers it.
   *
   * Both halves come from different populations: the caller is a station on the
   * spectrum, the answerer is drawn from the listening pool. The answerer is not
   * on the band and has no frequency of its own; it is set on the caller's
   * frequency for the length of the exchange, which is what makes it co-channel
   * — and therefore something the operator can listen to on a single dial
   * setting.
   *
   * Skipped while the operator has a QSO or a pile-up of their own: their
   * exchange takes precedence, and with one audio channel the two would only
   * cut each other off.
   */
  private start(now: number): void {
    const { band, rng, isOperatorBusy } = this.ctx;
    if (isOperatorBusy) return;
    const a = pickHamQsoCaller(band.activityState(), rng);
    if (!a) return;
    const taken = new Set(band.listHams().map((h) => h.call));
    const [b] = band.drawAnswerers(this.ctx.myCall(), 1, taken, rng);
    if (!b) return;

    band.markInQso(a.call);
    b.freqHz = a.freqHz;

    this.exchange = {
      a,
      b,
      freqHz: a.freqHz,
      script: hamQsoScript(a.call, b.call),
      index: 0,
      nextAt: now,
    };
  }

  /**
   * Both stations sign off. The answerer stops transmitting and is gone — it
   * never had a frequency of its own — while the caller, having just said 73,
   * clears the key for a moment and starts calling CQ again.
   */
  private finish(): void {
    const q = this.exchange;
    if (!q) return;
    this.exchange = null;
    this.ctx.keyingUntil.delete(q.a.call);
    this.ctx.keyingUntil.delete(q.b.call);

    const { band } = this.ctx;
    band.releaseAnswerer(q.b);
    // The caller does not go quiet: it resumes calling. That is what makes the
    // frequency worth tuning to afterwards, and it is the operator's chance to
    // answer a station that is free again.
    if (band.listHams().some((h) => h.call === q.a.call)) band.resumeCq(q.a.call);
  }
}
