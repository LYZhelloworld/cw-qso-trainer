import type { KeyElement } from "../cw/decoder.js";
import {
  buildBackgroundSignals,
  inSpectrumWindow,
  mulberry32,
  type SpectrumSignal,
  type SpectrumSnapshot,
} from "../ham/spectrum.js";
import { qsbDb, qsbDepthFor, smeterReading, type SMeterReading } from "../ham/smeter.js";
import { makeTx, txKeyed, txOnAir, type Tx } from "../ham/tx.js";
import type { VirtualHam } from "../ham/virtualHam.js";
import type { SessionAudio } from "./sessionAudio.js";
import type { SessionContext } from "./sessionTypes.js";

/**
 * What the receiver can be *shown*: the waterfall, the S-meter, and the keying
 * table they are both derived from.
 *
 * Split out of `QsoSession` because these three answer one question — "what is
 * on the air right now, and can the operator hear it?" — and they must never
 * answer it differently. The waterfall draws `toneKeyed` (real dots and dashes),
 * the meter reads `onAirAt` (the whole over, so the needle holds instead of
 * flickering), and the keying table is the single record they both consult.
 *
 * Everything it needs to know about the station — dial, filter, power, partner,
 * callsign — arrives through `SessionContext`. The envelope of the operator's
 * *own* over also lives here, because it is display data: the same elements that
 * drive the monitor tone are the ones drawn as the operator's trace. Whoever
 * keys our transmitter tells this module what went out; it never reads the key.
 */

/**
 * One HAM transmission placed on the air, as seen by the debug console.
 *
 * `path` is the single fact that explains "the waterfall / S-meter show it but I
 * hear nothing": `audible` means the speaker should have it; anything else means
 * the audio layer is (correctly or otherwise) suppressing it — `offband` (outside
 * the receiver's filter), `muted` (the rig is powered down / half-duplex deaf
 * while we transmit), or `transmitting` (our own key is down, so nobody is heard).
 */
export interface AiredMessage {
  /** The band this station lives on, e.g. "14.050". */
  band: string;
  /** The station's callsign. */
  call: string;
  /** The full text keyed out, e.g. "CQ CQ CQ DE BA1XYZ BA1XYZ PSE K". */
  text: string;
  /** When the over started, in ms (session wall clock). */
  at: number;
  /** How long the over takes to key, in ms. */
  durationMs: number;
  /** Whether the operator can actually hear it right now. */
  path: "audible" | "offband" | "muted" | "transmitting";
  /** Convenience mirror of `path === "audible"` for filtering. */
  inPassband: boolean;
}

export class BandMonitor {
  /**
   * What each station is transmitting right now — the keying truth.
   *
   * One record per station holds the message, its envelope and when it started.
   * Everything that needs to know "is there sound coming out of the speaker"
   * asks this table and nothing else: the waterfall draws `txKeyed` (the real
   * dots and dashes), the S-meter reads `txOnAir` (the whole over, so the
   * needle holds instead of flickering), and a mid-message join reads the text
   * plus its offset. Three maps used to track this (`onAir` for CQ text,
   * `playingUntil` for a deadline, `airEnvelope` for the envelope) and could
   * disagree; one table cannot.
   */
  private readonly txs = new Map<string, Tx>();

  /**
   * When `spectrum()` was last asked for a line. The waterfall samples once per
   * line, and a line covers a slice of time — see `txKeyedBetween`. Negative
   * until the first line is drawn.
   */
  private spectrumAt = -1;

  /**
   * The operator's own keying: the envelope of the over in progress, and when it
   * started. Null between overs.
   */
  private txTiming: KeyElement[] | null = null;
  private txStartedAt = 0;
  /**
   * Live keying: when the operator's key went down and when it last came up, so
   * the envelope can be appended element by element as it is keyed instead of
   * being known in advance.
   */
  private liveDownAt: number | null = null;
  private liveUpAt: number | null = null;

  /**
   * Decorative background carriers on this band (see `spectrum`). Built lazily
   * once per session from its own RNG, so they never disturb the sequence that
   * drives HAM generation and CQ timing.
   */
  private background: SpectrumSignal[] | null = null;

  /**
   * Debug listeners (the F12 console). Every HAM transmission fires them with an
   * `AiredMessage` — the single place the debugger learns what a station is
   * keying and whether the operator can hear it. Kept separate from the activity
   * listener so enabling the console never perturbs the band.
   */
  private readonly airListeners: Array<(m: AiredMessage) => void> = [];

  constructor(
    private readonly ctx: SessionContext,
    private readonly audio: SessionAudio,
  ) {}

  // --- what the operator can see -------------------------------------------

  /**
   * One line's worth of data for the waterfall: the dial (the window centre)
   * and every signal on the band — the workable HAMs plus the decorative
   * background carriers. Frequencies are absolute, so tuning past a station
   * makes it drift across the display instead of moving with the dial.
   */
  spectrum(): SpectrumSnapshot {
    const at = this.ctx.now();
    // One line of the waterfall stands for a slice of time, so remember when the
    // last one was drawn: a dot can be shorter than a line (see
    // `txKeyedBetween`).
    const since = this.spectrumAt;
    this.spectrumAt = at;

    // Half-duplex: while the operator's carrier is on, the only signal on the
    // display is his own, at full strength. Everything being received is gone —
    // a transmitter is not listening, so there is nothing else to show.
    //
    // It is drawn **keyed**, not as one solid block: the envelope that drives
    // the monitor tone is the same one read here, so the trace on the waterfall
    // breaks where the tone breaks. A dash is a dash, and the gap after it is
    // silent on screen as well as in the speaker.
    if (this.ctx.isTransmitting) {
      return {
        centerHz: this.ctx.dialHz,
        signals: [
          {
            freqHz: this.ctx.dialHz,
            strength: 1,
            // A callsign-less operator gets a placeholder rather than an empty
            // string: an empty `call` marks a decorative background carrier,
            // which the waterfall draws with synthetic keying instead of
            // following `active`.
            call: this.ctx.myCall() || "ME",
            workable: false,
            active: this.txKeyedBetween(since < 0 ? at : since, at),
          },
        ],
      };
    }

    const signals: SpectrumSignal[] = [];
    // The roster holds the band's callers. Answerers hold no slot, so they are
    // not on it — but while one of them is transmitting there *is* a carrier,
    // and that is exactly what the operator hears. Add the ones currently on the
    // air: the pile-up answering us, and a partner that came out of the pool.
    const onAir: VirtualHam[] = this.ctx.pileupCallers();
    const partner = this.ctx.partner();
    if (partner?.role === "answerer") onAir.push(partner);

    const drawn = new Set<string>();
    for (const ham of [...this.ctx.listHams(), ...onAir]) {
      if (drawn.has(ham.call) || ham.freqHz <= 0) continue;
      drawn.add(ham.call);
      // A signal is on the waterfall only while its tone is on the air: the
      // real dots and dashes if we recorded the message, one steady burst for a
      // driver that only reports "keying until" (pile-ups, the background
      // pair). Between transmissions there is nothing to see.
      const active = this.onAirAt(ham, at) && this.toneKeyed(ham, at);
      signals.push({
        freqHz: ham.freqHz,
        strength: ham.strength,
        call: ham.call,
        workable: true,
        active,
      });
    }
    for (const bg of this.backgroundSignals()) signals.push(bg);
    return { centerHz: this.ctx.dialHz, signals };
  }

  /**
   * What the S-meter reads: the strongest signal the receiver is hearing *right
   * now*. Two things make that agree with the operator's ears:
   *
   *  - **A switched-off rig reads nothing.** The meter is part of the receiver,
   *    so with the power off (or another band being monitored) the needle has no
   *    reason to move, however busy the frequency is.
   *  - **Half-duplex.** While our own carrier is on, the meter reads our keying
   *    instead of the band: full scale on a dot or dash, nothing in the gap
   *    between them. Nothing is being received, so nothing else can register.
   *  - **Silence is silence.** A received station only registers while one of
   *    its transmissions is actually on the air (between CQ bursts it is
   *    listening, not transmitting), so the needle drops when the sound stops.
   *
   * The filter and QSB apply as before: a station off the passband reads lower,
   * and every signal breathes slowly on its own.
   *
   * `null` when there is nothing to hear: no sound, no reading.
   */
  sMeter(): SMeterReading | null {
    // A receiver that is switched off (or tuned to a band nobody is monitoring)
    // has no needle to move, however busy the band is. Power sits upstream of
    // everything else: with the rig off the meter reads nothing at all.
    if (!this.ctx.rigOn) return null;
    const at = this.ctx.now();
    if (this.ctx.isTransmitting) return this.txKeyedAt(at) ? smeterReading(1) : null;

    let best: SMeterReading | null = null;
    for (const ham of this.audibleStations()) {
      // No sound, no reading. The needle only moves while this station's over
      // is actually being played — whichever driver put it there.
      if (!this.onAirAt(ham, at)) continue;
      if (!inSpectrumWindow(ham.freqHz, this.ctx.dialHz)) continue;
      const rx = this.audio.reception(ham);
      if (rx === null) continue;
      // The needle moves on every band, more violently on a hard one — see
      // `qsbDepthFor` for why this is not the audio's QSB depth.
      const reading = smeterReading(ham.strength, {
        gain: rx.gain,
        qsbDb: qsbDb(ham.call, at, qsbDepthFor(ham.difficulty)),
      });
      if (reading !== null && (best === null || reading.dbm > best.dbm)) best = reading;
    }
    return best;
  }

  /**
   * Register (or clear) a debug listener. The F12 console uses this to print
   * what the station currently being listened to is sending.
   */
  onAir(fn: ((m: AiredMessage) => void) | null): void {
    if (fn === null) {
      this.airListeners.length = 0;
      return;
    }
    this.airListeners.push(fn);
  }

  // --- the keying table ----------------------------------------------------

  /**
   * Put a message on the air: record it in the keying table **and** key it onto
   * the station's carrier.
   *
   * These two are one act on purpose. Everything the operator can see — the
   * waterfall's dots, the S-meter's needle — is derived from the keying table,
   * while the sound comes from the transmitter. Recording without keying is
   * exactly how a station ends up drawn on screen and silent in the speaker, so
   * the two are not allowed to be separate decisions: whoever records a
   * transmission has already keyed it.
   *
   * Whether it is *heard* is a different question with a different owner — the
   * receiver's filter, mute and half-duplex state decide that, in the audio
   * layer alone.
   */
  record(ham: VirtualHam, text: string): Tx {
    const tx = makeTx(text, this.audio.keyElements(text), this.ctx.now());
    this.txs.set(ham.call, tx);
    this.audio.keyStation(tx, ham);
    // Debug hook: what this station is keying, and whether the operator can
    // actually hear it. `path` is the fact the F12 console prints to explain a
    // signal that shows on the waterfall / S-meter but reaches no speaker.
    const path: AiredMessage["path"] = this.ctx.isTransmitting
      ? "transmitting"
      : !this.ctx.rigOn
        ? "muted"
        : !this.ctx.canHear(ham)
          ? "offband"
          : "audible";
    const msg: AiredMessage = {
      band: this.ctx.bandLabel(),
      call: ham.call,
      text,
      at: tx.startedAt,
      durationMs: tx.durationMs,
      path,
      inPassband: this.ctx.canHear(ham),
    };
    for (const fn of this.airListeners) fn(msg);
    return tx;
  }

  /**
   * Record what this station is keying and when it started, returning the record
   * so the caller can hand the very same thing to the audio. A line with no
   * station behind it has nothing to key on the band, and records nothing.
   */
  notePlaying(ham: VirtualHam | null | undefined, text: string): Tx | null {
    if (!ham) return null;
    return this.record(ham, text);
  }

  /**
   * The record of what this station is keying, if it is still on the air. Null
   * when it is silent — or when its carrier was cut from under it.
   */
  onAirTx(ham: VirtualHam, at: number): Tx | null {
    const tx = this.txs.get(ham.call);
    return tx && txOnAir(tx, at) ? tx : null;
  }

  /**
   * Forget a station's record: its carrier has been cut (the operator broke in),
   * so there is nothing left on the air to draw or to join.
   */
  forget(call: string): void {
    this.txs.delete(call);
  }

  /**
   * Is this station's over on the air at `at` — i.e. is there sound coming out
   * of the speaker that belongs to it?
   *
   * Two drivers can put a station on the air, and every consumer must agree on
   * the answer: a station whose message we recorded (the envelope's window in
   * the keying table), and one whose driver only reports "keying until" (a
   * pile-up caller, the background pair). Asking one question in one place is
   * what keeps the waterfall and the S-meter from telling the operator two
   * different stories — audible in one, silent in the other.
   */
  onAirAt(ham: VirtualHam, at: number): boolean {
    const tx = this.txs.get(ham.call);
    if (tx && txOnAir(tx, at)) return true;
    const keying = Math.max(
      this.ctx.keyingUntil.get(ham.call) ?? 0,
      this.ctx.pairKeyingUntil(ham.call),
    );
    return keying > at;
  }

  // --- the operator's own over ---------------------------------------------

  /** Our carrier is up: start an empty envelope at `at`, ready for elements. */
  beginOwnOver(at: number): void {
    this.txTiming = [];
    this.txStartedAt = at;
    this.liveDownAt = null;
    this.liveUpAt = null;
  }

  /** Our whole keying is known up front (the text modes). */
  setOwnEnvelope(elements: KeyElement[], startedAt: number): void {
    this.txTiming = elements;
    this.txStartedAt = startedAt;
    this.liveDownAt = null;
    this.liveUpAt = null;
  }

  /** Our carrier is down: nothing of ours is on the air any more. */
  endOwnOver(): void {
    this.txTiming = null;
    // A carrier-down means no key can still be held — including the abrupt
    // paths (`cancel` on leaving the page, `reset` on a band switch) that never
    // run `keyUp`. Leaving the flag set would make `keyHeld` lie after the rig
    // has already come down.
    this.liveDownAt = null;
    this.liveUpAt = null;
  }

  /**
   * The operator's key went down, live.
   *
   * The first element starts the *over*, not the carrier: the wait between
   * "ready to send" and the first dit is silence on the air, so it must not be
   * counted as part of the envelope. An element of unknown length is opened
   * until the key goes up, which is why the meter reads "keyed" for as long as
   * the operator holds it.
   */
  keyDown(at: number): void {
    if (this.txTiming === null) return;
    if (this.txTiming.length === 0) this.txStartedAt = at;
    // Close the gap on the previous element now that its length is known.
    if (this.liveUpAt !== null) {
      this.txTiming[this.txTiming.length - 1].off = at - this.liveUpAt;
    }
    this.txTiming.push({ on: Number.MAX_SAFE_INTEGER, off: 0 });
    this.liveDownAt = at;
    this.liveUpAt = null;
  }

  /** The operator's key came up: the open element's length is now known. */
  keyUp(at: number): void {
    if (this.txTiming === null || this.liveDownAt === null) return;
    const last = this.txTiming[this.txTiming.length - 1];
    if (last) last.on = Math.max(1, at - this.liveDownAt);
    this.liveDownAt = null;
    this.liveUpAt = at;
  }

  /** Is the operator's key still down? (An over cannot be closed mid-element.) */
  get keyHeld(): boolean {
    return this.liveDownAt !== null;
  }

  // --- internals -----------------------------------------------------------

  /**
   * Every station the receiver could be hearing: the band's callers, plus the
   * answerers that only exist while they transmit (a pile-up, or the partner we
   * drew out of the listening pool).
   */
  private audibleStations(): VirtualHam[] {
    const all = [...this.ctx.listHams(), ...this.ctx.pileupCallers()];
    const partner = this.ctx.partner();
    if (partner?.role === "answerer") all.push(partner);
    const seen = new Set<string>();
    return all.filter((h) => (seen.has(h.call) ? false : (seen.add(h.call), true)));
  }

  /** Is the operator's own key down at `at`? */
  private txKeyedAt(at: number): boolean {
    if (!this.txTiming) return false;
    let t = at - this.txStartedAt;
    if (t < 0) return false;
    for (const e of this.txTiming) {
      if (t < e.on) return true;
      t -= e.on;
      if (t < e.off) return false;
      t -= e.off;
    }
    return false;
  }

  /**
   * Whether the operator's carrier was on at any point in `[from, to]`.
   *
   * A waterfall line stands for a slice of time, not an instant: at 25 WPM a dit
   * is 48 ms and a line is 55 ms, so sampling only the line's own timestamp
   * would drop dots and draw a pattern the operator never sent. Asking the whole
   * slice keeps every element that was on during it.
   */
  private txKeyedBetween(from: number, to: number): boolean {
    if (!(to > from)) return this.txKeyedAt(to);
    // ~17 samples per line: fine enough for the shortest element at any speed
    // the settings allow, cheap enough to run once per line.
    const step = Math.max(4, (to - from) / 16);
    for (let t = from; t < to; t += step) if (this.txKeyedAt(t)) return true;
    return this.txKeyedAt(to);
  }

  /**
   * Is the *tone* on at `at` — the dots and dashes, not just the over?
   *
   * Only the waterfall asks this. A panadapter can be honest to the
   * millisecond; a meter has ballistics and holds through the gap between two
   * dits instead of flickering at the keying rate. A station with no recorded
   * envelope (a driver that only reports "keying until") is drawn as one steady
   * burst for as long as it claims to be keying.
   */
  private toneKeyed(ham: VirtualHam, at: number): boolean {
    const tx = this.txs.get(ham.call);
    if (tx && txOnAir(tx, at)) return txKeyed(tx, at);
    return true;
  }

  /** The band's decorative carriers (see `spectrum`); built once per session. */
  private backgroundSignals(): SpectrumSignal[] {
    if (!this.background) {
      // Seeded from the band reference, so a band always looks the same and the
      // session's own RNG sequence (HAM generation, CQ timing) is untouched.
      const seed = Math.abs(Math.round(this.ctx.referenceHz)) % 2147483647;
      this.background = buildBackgroundSignals(this.ctx.referenceHz, mulberry32(seed));
    }
    return this.background;
  }
}
