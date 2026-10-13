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

/** Reserved stub describing a HAM-to-HAM exchange (not implemented in step 3). */
export interface HamToHamExchange {
  reserved: true;
  participants: [VirtualHam, VirtualHam];
}

export class Frequency {
  readonly freqMHz: number;
  private readonly db: DxccDatabase;
  private readonly hams = new Map<string, VirtualHam>();

  constructor(freqMHz: number, db: DxccDatabase) {
    this.freqMHz = freqMHz;
    this.db = db;
  }

  /** Spawn a new virtual HAM on this frequency, weighted relative to myCall. */
  spawnHam(myCall: string, difficulty?: Difficulty, rng?: () => number): VirtualHam {
    const ham = generateVirtualHam({ myCall, db: this.db, difficulty, rng });
    this.hams.set(ham.call, ham);
    return ham;
  }

  /** Currently spawned HAMs on this frequency. */
  listHams(): VirtualHam[] {
    return [...this.hams.values()];
  }

  /**
   * The HAM the user can currently work. RESERVED: in a later step this picks
   * the HAM that is CQing on frequency. For now it returns the first spawned
   * HAM (or null if none).
   */
  activeHam(): VirtualHam | null {
    for (const ham of this.hams.values()) return ham;
    return null;
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
