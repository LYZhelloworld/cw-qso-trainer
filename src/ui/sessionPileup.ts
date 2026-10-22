import {
  PILEUP_MAX_CALLS,
  matchCaller,
  pileupCallText,
  pileupSilenceMs,
  pileupSize,
  type PileupCaller,
} from "../ham/pileup.js";
import type { VirtualHam } from "../ham/virtualHam.js";
import type { SessionContext } from "./sessionTypes.js";

/**
 * A pile-up: several stations answering the operator's CQ at once.
 *
 * Split out of `QsoSession` because it is a self-contained little scheduler —
 * who is due to call, how long they stay silent in between, how many repeats
 * they get — and because the operator's QSO proper does not start until one of
 * them is named. Until then there is no partner and no state machine at all.
 *
 * The stations come from the band's **listening pool** (`ham/answerers`), not
 * off the spectrum: somebody answering a CQ was never visible in the first
 * place. That is also why the number of answerers is not limited by how many
 * frequencies the band has.
 */
export class PileupDriver {
  private callers: PileupCaller[] | null = null;

  constructor(private readonly ctx: SessionContext) {}

  /** True while stations are answering and nobody has been named yet. */
  get active(): boolean {
    return this.callers !== null;
  }

  /** The stations answering, in the order they arrived. */
  list(): VirtualHam[] {
    return this.callers?.map((c) => c.ham) ?? [];
  }

  /**
   * Those that have transmitted at least once — the ones the operator can
   * actually have copied. A station that has not called yet is not a name you
   * could have written down, so the UI does not offer it.
   */
  heard(): VirtualHam[] {
    return this.callers?.filter((c) => c.calls > 0).map((c) => c.ham) ?? [];
  }

  /**
   * Draw the stations that will answer this CQ and set the pile-up running.
   *
   * `blocked` is true when a background pair is working each other on the dial
   * frequency. A CQ keyed on top of an exchange gets no reply — nobody walks
   * out of a QSO to answer a stranger calling on the same frequency — so no
   * caller is drawn at all. The operator hears their own CQ and then silence,
   * which is exactly what that frequency sounds like from the outside.
   */
  begin(blocked: boolean): void {
    if (blocked) {
      this.callers = null;
      return;
    }
    const { band, dialHz, rng } = this.ctx;
    const taken = new Set(band.listHams().map((h) => h.call));
    const drawn = band.drawAnswerers(this.ctx.myCall(), pileupSize(rng), taken, rng);
    const callers = drawn.map((ham) => {
      // Everyone answers on the caller's frequency — co-channel, the way CW
      // operators zero-beat the station they want.
      ham.freqHz = dialHz;
      return { ham, nextCallAt: 0, calls: 0 };
    });
    this.callers = callers.length > 0 ? callers : null;
  }

  /**
   * Stagger the first calls: the first one starts at `firstAt`, each of the
   * others once the previous call has finished plus a short random gap. The
   * audio is mono, so simultaneous calls would just cut each other off.
   */
  schedule(firstAt: number): void {
    let at = firstAt;
    for (const c of this.callers ?? []) {
      c.nextCallAt = at;
      c.calls = 0;
      at += this.ctx.callDurationMs(pileupCallText(c.ham.call)) + 500 + Math.floor(this.ctx.rng() * 1000);
    }
  }

  /**
   * Advance the pile-up: the earliest caller that is due transmits, unless the
   * operator is transmitting right now — then every station listens and the
   * repeats wait, which is the "in a call, see whether it was for me" half of
   * the rule. Only one station is started per tick, so their silences stay
   * staggered even if several became due at once.
   */
  drive(): void {
    const callers = this.callers;
    if (!callers || !this.ctx.isReceiving || this.ctx.isSending) return;
    const now = this.ctx.now();
    const due = callers.filter((c) => now >= c.nextCallAt).sort((a, b) => a.nextCallAt - b.nextCallAt);
    const caller = due[0];
    if (!caller) return;

    // Out of repeats: it gives up and goes back to listening.
    if (caller.calls >= PILEUP_MAX_CALLS) {
      this.release(caller);
      this.callers = callers.filter((c) => c !== caller);
      if (this.callers.length === 0) {
        this.callers = null;
        this.ctx.note("没有人应答你的点名，各台已停止呼叫");
      }
      return;
    }

    caller.calls += 1;
    const text = pileupCallText(caller.ham.call);
    const duration = this.ctx.callDurationMs(text);
    caller.nextCallAt = now + duration + pileupSilenceMs(this.ctx.rng);
    this.ctx.push("ham", text);
    // Key this station's waterfall column only while its call is on the air.
    this.ctx.keyingUntil.set(caller.ham.call, now + duration);
    void this.ctx.playHam(text, caller.ham).then(() => {
      this.ctx.keyingUntil.delete(caller.ham.call);
    });
  }

  /** The station the operator named in `line`, or null if they named nobody. */
  match(line: string): PileupCaller | null {
    return this.callers ? matchCaller(line, this.callers) : null;
  }

  /**
   * Nobody was addressed. Re-roll every silence so the repeats stay spread out;
   * the operator gets another chance to name a station. This is deliberately
   * unforgiving — naming the station *is* the skill a pile-up teaches.
   */
  reschedule(): void {
    const now = this.ctx.now();
    for (const c of this.callers ?? []) c.nextCallAt = now + pileupSilenceMs(this.ctx.rng);
  }

  /**
   * The operator named this station: it becomes the partner and the rest go
   * back to listening. An answerer was never on the band, so nothing is
   * removed from it.
   */
  take(chosen: PileupCaller): void {
    const callers = this.callers;
    this.callers = null;
    for (const c of callers ?? []) {
      if (c !== chosen) this.release(c);
    }
  }

  /** Drop the pile-up and put every caller back where it belongs. */
  clear(): void {
    const callers = this.callers;
    this.callers = null;
    for (const c of callers ?? []) this.release(c);
  }

  /** Back to listening: the answerer leaves a band it was never really on. */
  private release(caller: PileupCaller): void {
    this.ctx.keyingUntil.delete(caller.ham.call);
    this.ctx.band.releaseAnswerer(caller.ham);
  }
}
