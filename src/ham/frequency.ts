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
import { SIGNAL_GRID_HZ, SIGNAL_GRID_SLOTS, snapToGrid } from "./spectrum.js";
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
    const source = rng ?? Math.random;
    let ham = this.generate(myCall, difficulty, rng, atHz);
    // Redraw on a collision with a HAM already on this frequency — a shared
    // callsign would be silently dropped by activity.add(), and a shared
    // frequency slot would put two stations in one waterfall column. A station
    // deliberately placed with `atHz` is exempt: the operator asked for that
    // exact spot.
    for (let attempt = 0; attempt < 16 && this.collides(ham, atHz); attempt += 1) {
      ham = this.generate(myCall, difficulty, rng, atHz);
    }
    // A busy band (5–9 stations share 19 grid slots) can exhaust the redraws.
    // Rather than dropping the station on top of another, move it to a slot that
    // is still free. Only stations placed by the generator get moved — an `atHz`
    // station was put somewhere on purpose.
    if (atHz === undefined && this.collides(ham, atHz)) {
      const free = this.freeSlotHz(source);
      if (free !== null) {
        for (let attempt = 0; attempt < 16 && this.collides(ham, atHz); attempt += 1) {
          ham = this.generate(myCall, difficulty, rng, free);
        }
      }
    }
    this.activity.add(ham, firstCqDelayMs);
    return ham;
  }

  /**
   * A 1 kHz grid slot near the band reference that no station occupies, or null
   * when the band is genuinely full. Picks among the free slots at random so a
   * crowded band still spreads its stations out.
   */
  freeSlotHz(rng: () => number = Math.random): number | null {
    const base = snapToGrid(this.referenceHz);
    const taken = new Set(this.activity.list().map((e) => e.ham.freqHz));
    const free: number[] = [];
    for (let step = -SIGNAL_GRID_SLOTS; step <= SIGNAL_GRID_SLOTS; step += 1) {
      const hz = base + step * SIGNAL_GRID_HZ;
      if (!taken.has(hz)) free.push(hz);
    }
    if (free.length === 0) return null;
    return free[Math.min(free.length - 1, Math.floor(rng() * free.length))];
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
  ): VirtualHam {
    return generateVirtualHam({
      myCall,
      db: this.db,
      difficulty,
      rng,
      referenceHz: this.referenceHz,
      spreadHz: this.spreadHz,
      atHz,
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

  /**
   * Retune a station that is already on the band. Used when one station answers
   * another's CQ: it moves onto the caller's frequency, so the exchange is
   * co-channel and the operator can hear both sides on one dial setting.
   */
  moveHam(call: string, hz: number): void {
    const entry = this.activity.list().find((e) => e.ham.call === call);
    if (entry) entry.ham.freqHz = snapToGrid(hz);
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
