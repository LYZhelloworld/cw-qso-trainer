/**
 * Frequency: models a band slot where multiple virtual HAMs are active. It
 * spawns weighted virtual HAMs (via generateVirtualHam) and tracks who is on
 * the frequency, so the app can pick a partner for the user to work.
 *
 * Per ROADMAP step 3, this is the "multiple virtual HAMs & frequency activity"
 * piece. The "two AI HAMs conduct a QSO while the user listens but cannot
 * interrupt" scenario is RESERVED: the architecture already supports it (a
 * VirtualHam is a standalone entity and a QsoMachine can pair any two), but its
 * scheduling/rendering is deferred. `planHamToHam` is the typed placeholder.
 */

import { DxccDatabase } from "../data/dxcc.js";
import { generateVirtualHam } from "./generate.js";
import { VirtualHam, type Difficulty } from "./virtualHam.js";
import {
  HamActivity,
  type HamActivityEntry,
  type HamActivityEvent,
} from "./activity.js";

/** Reserved stub describing a HAM-to-HAM exchange (not implemented in step 3). */
export interface HamToHamExchange {
  reserved: true;
  participants: [VirtualHam, VirtualHam];
}

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
 * Frequency: models a band slot where multiple virtual HAMs are active. It
 * spawns weighted virtual HAMs (via generateVirtualHam) and owns their CQ
 * rhythm (via HamActivity) — one store, so a HAM that goes offline is gone from
 * both the roster and the schedule.
 *
 * Per ROADMAP step 3, this is the "multiple virtual HAMs & frequency activity"
 * piece. The "two AI HAMs conduct a QSO while the user listens but cannot
 * interrupt" scenario is RESERVED: the architecture already supports it (a
 * VirtualHam is a standalone entity and a QsoMachine can pair any two), but its
 * scheduling/rendering is deferred. `planHamToHam` is the typed placeholder.
 */
export class Frequency {
  readonly freqMHz: number;
  private readonly db: DxccDatabase;
  private readonly activity: HamActivity;
  /** Where new stations are placed on the band, in Hz. */
  private readonly referenceHz: number;
  private readonly spreadHz: number | undefined;

  constructor(freqMHz: number, db: DxccDatabase, opts: FrequencyOptions = {}) {
    this.freqMHz = freqMHz;
    this.db = db;
    this.activity = new HamActivity({ rng: opts.rng, now: opts.now });
    this.referenceHz = opts.referenceHz ?? Math.round(freqMHz * 1e6);
    this.spreadHz = opts.spreadHz;
  }

  /**
   * Spawn a new virtual HAM on this frequency, weighted relative to myCall.
   *
   * @param firstCqDelayMs Override for this HAM's first CQ. Omit for the spec
   *   interval (30–60 s); pass something short so a freshly tuned band makes
   *   noise soon instead of leaving the user staring at silence.
   */
  spawnHam(
    myCall: string,
    difficulty?: Difficulty,
    rng?: () => number,
    firstCqDelayMs?: number,
  ): VirtualHam {
    let ham = this.generate(myCall, difficulty, rng);
    // Redraw on a callsign collision with a HAM already on this frequency,
    // otherwise activity.add() would silently drop it and the caller would be
    // handed a HAM that is not actually on the band.
    for (let attempt = 0; attempt < 8 && this.activity.has(ham.call); attempt += 1) {
      ham = this.generate(myCall, difficulty, rng);
    }
    this.activity.add(ham, firstCqDelayMs);
    return ham;
  }

  /** Generate one HAM placed on this band (no roster bookkeeping). */
  private generate(myCall: string, difficulty?: Difficulty, rng?: () => number): VirtualHam {
    return generateVirtualHam({
      myCall,
      db: this.db,
      difficulty,
      rng,
      referenceHz: this.referenceHz,
      spreadHz: this.spreadHz,
    });
  }

  /** Currently active HAMs on this frequency. */
  listHams(): VirtualHam[] {
    return this.activity.list().map((e) => e.ham);
  }

  /**
   * The HAM the user can currently work: the one calling CQ if there is one,
   * otherwise any HAM that is not already in a QSO.
   */
  activeHam(): VirtualHam | null {
    return this.activity.cqingHam() ?? this.activity.availableHam();
  }

  /** Roster with each HAM's activity state (listening / calling / in QSO). */
  activityState(): HamActivityEntry[] {
    return this.activity.list();
  }

  /** The HAM whose CQ is out and unanswered, if any. */
  cqingHam(): VirtualHam | null {
    return this.activity.cqingHam();
  }

  /** Number of HAMs still on the frequency. */
  get hamCount(): number {
    return this.activity.size;
  }

  /**
   * Advance the CQ rhythm to `at` and return what happened: HAMs calling CQ,
   * and HAMs giving up after 3 minutes unanswered (already removed).
   */
  advance(at?: number): HamActivityEvent[] {
    return this.activity.advance(at);
  }

  /** The user started working this HAM: it stops calling CQ. */
  markInQso(call: string): void {
    this.activity.markInQso(call);
  }

  /** The QSO with this HAM ended: it goes back to listening. */
  markListening(call: string): void {
    this.activity.markListening(call);
  }

  /** Take a HAM off the frequency entirely. */
  removeHam(call: string): void {
    this.activity.remove(call);
  }
}

/**
 * RESERVED placeholder for two AI HAMs talking to each other. Real
 * implementation (scripted exchange + background rendering, user cannot
 * interrupt) is deferred to a later step. Returns a typed stub so callers can
 * already type against the interface.
 */
export function planHamToHam(a: VirtualHam, b: VirtualHam): HamToHamExchange {
  return { reserved: true, participants: [a, b] };
}
