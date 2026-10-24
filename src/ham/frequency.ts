/**
 * Frequency: models one band where multiple virtual HAMs are active. It spawns
 * weighted virtual HAMs (via generateVirtualHam), owns their CQ rhythm (via
 * HamActivity), and holds the band's much larger population of listeners (via
 * AnswererPool) — so a HAM that goes offline is gone from both the roster and
 * the schedule, while a station that only ever answers a CQ holds no frequency
 * of its own.
 *
 * The band's own HAM-to-HAM exchanges are *not* modelled here: they are
 * scheduled by `QsoSession` on top of this roster (see `ham/hamQso`).
 */

import { DxccDatabase } from "../data/dxcc.js";
import { AnswererPool, answererPoolSize } from "./answerers.js";
import { generateVirtualHam } from "./generate.js";
import { VirtualHam, type Difficulty, type HamRole } from "./virtualHam.js";
import {
  HamActivity,
  type HamActivityEntry,
  type HamActivityEvent,
} from "./activity.js";

export interface FrequencyOptions {
  /** RNG for activity timing (CQ intervals, give-up). Defaults to Math.random. */
  rng?: () => number;
  /** Injected clock (tests). Defaults to Date.now. */
  now?: () => number;
  /**
   * Band reference frequency in Hz — stations are scattered around it. Omit to
   * use the dial frequency this Frequency was built with.
   */
  referenceHz?: number;
  /** Scatter around `referenceHz`, in Hz. */
  spreadHz?: number;
}

/**
 * The band. One store for both facts: who is on the frequency (the roster, with
 * their CQ schedule) and who is listening off it (the answerer pool).
 */
export class Frequency {
  readonly freqMHz: number;
  private readonly db: DxccDatabase;
  private readonly activity: HamActivity;
  /** The band's listeners: the stations that answer CQ (see `ham/answerers`). */
  private readonly answerers: AnswererPool;
  /** Where new stations are placed on the band, in Hz. */
  private readonly referenceHz: number;
  private readonly spreadHz: number | undefined;

  constructor(freqMHz: number, db: DxccDatabase, opts: FrequencyOptions = {}) {
    this.freqMHz = freqMHz;
    this.db = db;
    this.activity = new HamActivity({ rng: opts.rng, now: opts.now });
    this.referenceHz = opts.referenceHz ?? Math.round(freqMHz * 1e6);
    this.spreadHz = opts.spreadHz;
    this.answerers = new AnswererPool({ size: answererPoolSize(opts.rng) });
  }

  /**
   * Spawn a new virtual HAM on this frequency, weighted relative to myCall.
   *
   * @param firstCqDelayMs Override for this HAM's first CQ. Omit for the spec
   *   interval (30–60 s); pass something short so a freshly tuned band makes
   *   noise soon instead of leaving the user staring at silence.
   * @param atHz Place the station exactly here (Hz) instead of scattering it
   *   over the band — used for a station that answers the operator on the
   *   operator's own frequency.
   */
  spawnHam(
    myCall: string,
    difficulty?: Difficulty,
    rng?: () => number,
    firstCqDelayMs?: number,
    atHz?: number,
  ): VirtualHam {
    let ham = this.generate(myCall, difficulty, rng, atHz);
    // Redraw when the callsign is already on the frequency — a duplicate would
    // be silently dropped by activity.add() — or when the new station landed on
    // the very same 10 Hz position as another. A station deliberately placed
    // with `atHz` is exempt from the frequency test: the operator asked for
    // that exact spot.
    for (let attempt = 0; attempt < 16 && this.collides(ham, atHz); attempt += 1) {
      ham = this.generate(myCall, difficulty, rng, atHz);
    }
    this.activity.add(ham, firstCqDelayMs);
    return ham;
  }

  /** True when this station clashes with one already on the frequency. */
  private collides(ham: VirtualHam, atHz?: number): boolean {
    if (this.activity.has(ham.call)) return true;
    if (atHz !== undefined || ham.freqHz <= 0) return false;
    return this.activity.list().some((e) => e.ham.freqHz === ham.freqHz);
  }

  /** Generate one HAM placed on this band (no roster bookkeeping). */
  private generate(
    myCall: string,
    difficulty?: Difficulty,
    rng?: () => number,
    atHz?: number,
    role: HamRole = "caller",
  ): VirtualHam {
    return generateVirtualHam({
      myCall,
      db: this.db,
      difficulty,
      rng,
      referenceHz: this.referenceHz,
      spreadHz: this.spreadHz,
      atHz,
      role,
    });
  }

  /**
   * Take stations out of the band's listening pool — the ones that answer a CQ.
   *
   * They are **not** put on the roster and not given a frequency: an answerer
   * only becomes audible while it is transmitting, and the station it answers
   * decides where (a pile-up is co-channel). The pool is deliberately much
   * larger than the spectrum can show at once, so it is not limited by the band.
   *
   * `taken` is the calls on the band already; a listener must not share one.
   */
  drawAnswerers(
    myCall: string,
    count: number,
    taken: ReadonlySet<string> = new Set<string>(),
    rng?: () => number,
  ): VirtualHam[] {
    return this.answerers.draw(
      count,
      () => this.generate(myCall, undefined, rng, undefined, "answerer"),
      taken,
    );
  }

  /** The station stopped transmitting: it goes back to listening off the band. */
  releaseAnswerer(ham: VirtualHam): void {
    this.answerers.release(ham);
  }

  /** Currently active HAMs on this frequency. */
  listHams(): VirtualHam[] {
    return this.activity.list().map((e) => e.ham);
  }

  /** Roster with each HAM's activity state (listening / calling / in QSO). */
  activityState(): HamActivityEntry[] {
    return this.activity.list();
  }

  /** Number of HAMs still on the frequency. */
  get hamCount(): number {
    return this.activity.size;
  }

  /**
   * Advance the CQ rhythm to `at` and return what happened: the HAMs that
   * started a CQ burst. Stations stay on the band — a calling station repeats
   * for as long as the operator leaves it alone.
   */
  advance(at?: number): HamActivityEvent[] {
    return this.activity.advance(at);
  }

  /** Re-time one station's next CQ (the session knows the message length). */
  scheduleNextCq(call: string, delayMs: number): void {
    this.activity.scheduleNext(call, delayMs);
  }

  /** The user started working this HAM: it stops calling CQ. */
  markInQso(call: string): void {
    this.activity.markInQso(call);
  }

  /** The QSO with this HAM ended: it goes back to listening. */
  markListening(call: string): void {
    this.activity.markListening(call);
  }

  /** The QSO ended and this station was the one calling CQ: call again shortly. */
  resumeCq(call: string, delayMs?: number): void {
    this.activity.resumeCq(call, delayMs);
  }
}
