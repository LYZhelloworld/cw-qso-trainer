/**
 * Virtual-HAM callsign generation (VIRTUAL-HAM.md).
 *
 * Selection is done in TWO stages so the spec's relative weights are honoured:
 *   1. Pick a CATEGORY by weight 100 / 40 / 10 / 5 / 1:
 *        CAT1 (100): same DXCC entity AND same region digit as the user (their
 *                    own region — e.g. other B?7 stations for a BG7 user).
 *        CAT2 ( 40): same DXCC entity, any region digit (other B?? stations).
 *        CAT3 ( 10): a different entity within 3000 km of the user's QTH.
 *        CAT4 (  5): a different entity on the same continent.
 *        CAT5 (  1): everything else.
 *   2. Within the chosen category, pick an entity/prefix and build the call.
 *
 * The user's QTH is the centroid of their callsign's DXCC entity — the dataset
 * carries one point per entity, so distances are rough inside a large country.
 * The "region digit" is scoped to
 * the entity (it does not cross countries), per VIRTUAL-HAM.md. The suffix is
 * purely random. An injectable RNG keeps generation deterministic in tests.
 */

import { DxccDatabase, type DxccEntity } from "../data/dxcc.js";
import { validateCallsign } from "../message/parse.js";
import { VirtualHam, type Difficulty, type HamRole } from "./virtualHam.js";
import { S9_STRENGTH, strengthForSUnit } from "./smeter.js";
import {
  BAND_SIGNAL_SPREAD_HZ,
  SIGNAL_STEP_HZ,
  SIGNAL_STEP_SLOTS,
  snapToStep,
} from "./spectrum.js";

export interface GenerateOptions {
  myCall: string;
  db: DxccDatabase;
  difficulty?: Difficulty;
  /** Injectable RNG for deterministic tests (defaults to Math.random). */
  rng?: () => number;
  /**
   * The band's reference frequency in Hz. The new station is placed within
   * ±`spreadHz` of it, on the 10 Hz grid the dial uses — which is where the
   * waterfall will draw it. Omit for a station that is not placed on any
   * spectrum (freqHz stays 0).
   */
  referenceHz?: number;
  /** Scatter around `referenceHz` (defaults to the band's signal spread). */
  spreadHz?: number;
  /**
   * Put the station exactly here (Hz, snapped to 10 Hz) instead of scattering
   * it. Used when a station has to answer the operator *on the operator's
   * frequency* — see `QsoSession.userCallsCq`.
   */
  atHz?: number;
  /**
   * Which population the new station belongs to. An `answerer` is never placed
   * on the band: it holds no frequency of its own and only appears when it
   * answers a CQ, so no frequency is generated for it (the caller sets it while
   * the station is transmitting).
   */
  role?: HamRole;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const MAX_ATTEMPTS = 50;

function randInt(rng: () => number, maxExclusive: number): number {
  return Math.floor(rng() * maxExclusive);
}

function randomSuffix(rng: () => number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += LETTERS[randInt(rng, 26)];
  return s;
}

/** Great-circle distance in km between two lat/lon points (haversine). */
export function haversineKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Letter prefixes of an entity that fit CALL_RE (1-2 letters, resolve back). */
function entityPrefixes(ent: DxccEntity, db: DxccDatabase): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of ent.prefixes) {
    const letterPrefix = p.replace(/[0-9].*$/, "");
    if (!/^[A-Z]{1,2}$/.test(letterPrefix) || seen.has(letterPrefix)) continue;
    seen.add(letterPrefix);
    // The dataset lists whole callsign ranges (`BG7A`, `BG9X`) that all strip to
    // the same letter prefix; keeping one of each stops a single prefix from
    // crowding out the rest of the entity's allocation.
    if (db.resolvePrefix(letterPrefix) === ent.dxcc) out.push(letterPrefix);
  }
  return out;
}

type Category = 1 | 2 | 3 | 4 | 5;

/** Pick a category by the spec weights 100/40/10/5/1 (cumulative 156). */
function chooseCategory(rng: () => number): Category {
  const r = rng() * 156;
  if (r < 100) return 1;
  if (r < 140) return 2;
  if (r < 150) return 3;
  if (r < 155) return 4;
  return 5;
}

function pickDifficulty(rng: () => number): Difficulty {
  const r = rng();
  if (r < 0.5) return "novice";
  if (r < 0.85) return "intermediate";
  return "hardcore";
}

/**
 * The RST a station reports for the operator's signal. Its S digit doubles as
 * the station's simulated strength (see `strengthFromReport`), so this spread
 * is what puts stations on different marks of the S-meter: mostly loud enough
 * to read on the top third of the scale, a few down at S4.
 *
 * Exactly one draw either way, so widening the spread did not shift the RNG
 * sequence that generates callsigns, reports or frequencies.
 */
function pickReport(rng: () => number): string {
  const r = rng();
  if (r < 0.45) return "599";
  if (r < 0.67) return "589";
  if (r < 0.83) return "579";
  if (r < 0.92) return "569";
  if (r < 0.97) return "559";
  return "549";
}

/**
 * Stable 32-bit hash of a callsign, used for per-station variation (signal
 * jitter, and the WPX serial a station sends — see `qso/contest`).
 */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * A station's signal strength (0..1) follows the RST it reports: 599 is a
 * strong signal, 579 a noticeably weaker one. A small per-call jitter keeps two
 * 599 stations from looking identical on the waterfall. Derived (not drawn from
 * the RNG) so it does not disturb the generation sequence.
 *
 * The scale itself lives in `ham/smeter` (`strengthForSUnit`), so a station
 * reporting S7 is exactly the strength the meter reads back as S7.
 */
function strengthFromReport(report: string, call: string): number {
  const digit = Number(report[1]);
  const base = Number.isFinite(digit) ? strengthForSUnit(digit) : S9_STRENGTH;
  const jitter = (((hashString(call) % 21) - 10) / 10) * 0.07;
  return Math.min(1, Math.max(0.15, base + jitter));
}

/**
 * Place a station on the band: an absolute frequency on the 10 Hz grid, within
 * ±`spreadHz` of the band reference. Without a reference the station is simply
 * not placed (freqHz = 0); with `atHz` it goes exactly there.
 *
 * Draws exactly one number from the RNG either way, so changing the grid did not
 * shift the sequence that generates callsigns and reports.
 */
function placeFreq(
  referenceHz: number | undefined,
  spreadHz: number,
  atHz: number | undefined,
  rng: () => number,
): number {
  if (atHz !== undefined) return snapToStep(atHz);
  if (referenceHz === undefined) return 0;
  const steps = Math.max(1, Math.round(spreadHz / SIGNAL_STEP_HZ));
  const offset = Math.round((rng() * 2 - 1) * Math.min(steps, SIGNAL_STEP_SLOTS));
  return snapToStep(referenceHz) + offset * SIGNAL_STEP_HZ;
}

function buildCall(
  prefixes: string[],
  regionDigit: string,
  rng: () => number,
): string {
  const prefix = prefixes[randInt(rng, prefixes.length)];
  // A real callsign's suffix is 2–3 letters (e.g. BG7XXX, JA1ABC); a single
  // trailing letter (BG4I) reads as an illegal call. See VIRTUAL-HAM.md.
  const suffixLen = 2 + randInt(rng, 2); // 2..3
  return `${prefix}${regionDigit}${randomSuffix(rng, suffixLen)}`;
}

/**
 * The entity the operator's own callsign belongs to.
 *
 * The digit is part of the prefix: `B5` is China, while keeping only the
 * leading letters leaves `B` — and the first token in the table that starts
 * with `B` is Spratly's `BM9S`, which puts a Chinese operator on the wrong side
 * of the South China Sea. Walk the call from the longest prefix down and take
 * the first one the table knows. That is the same longest-match rule the table
 * itself is built on, and it fixes B5/B7 as well as A5/E7/S5/T7/Z3 without any
 * per-country special case.
 */
export function resolveUserEntity(myCall: string, db: DxccDatabase): DxccEntity | null {
  const base = myCall.split("/")[0];
  for (let len = base.length; len > 0; len -= 1) {
    const marker = db.resolvePrefix(base.slice(0, len));
    if (marker) return db.entity(marker) ?? null;
  }
  return null;
}

export function generateVirtualHam(opts: GenerateOptions): VirtualHam {
  const rng = opts.rng ?? Math.random;
  const difficulty = opts.difficulty ?? pickDifficulty(rng);
  const db = opts.db;
  const referenceHz = opts.referenceHz;
  const spreadHz = opts.spreadHz ?? BAND_SIGNAL_SPREAD_HZ;
  const atHz = opts.atHz;
  const role = opts.role ?? "caller";
  // An answerer has no frequency of its own: it is only audible while it is
  // answering someone, and the station it answers decides where it sits.
  const freqHz = () => (role === "answerer" ? 0 : placeFreq(referenceHz, spreadHz, atHz, rng));

  // User context (QTH ≈ centroid of the user's own DXCC entity).
  const uEnt = resolveUserEntity(opts.myCall, db) ?? undefined;
  const uRegionDigit = (opts.myCall.match(/[0-9]/) ?? [])[0] ?? null;
  const uContinent = uEnt?.continent ?? null;
  const uQth = uEnt ? { lat: uEnt.lat, lon: uEnt.lon } : { lat: 0, lon: 0 };

  // Partition entities into the geographic pools (CAT3/4/5). CAT1/2 use uEnt.
  const near: DxccEntity[] = [];
  const sameContinent: DxccEntity[] = [];
  const other: DxccEntity[] = [];
  for (const ent of db.listEntities()) {
    if (!uEnt || ent.dxcc === uEnt.dxcc) continue;
    const d = haversineKm(uQth, { lat: ent.lat, lon: ent.lon });
    if (d < 3000) near.push(ent);
    else if (uContinent && ent.continent === uContinent) sameContinent.push(ent);
    else other.push(ent);
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const cat = chooseCategory(rng);
    let entity: DxccEntity | undefined;
    let regionDigit: string;

    if (cat === 1 || cat === 2) {
      entity = uEnt;
      regionDigit = cat === 1 && uRegionDigit ? uRegionDigit : String(randInt(rng, 10));
    } else {
      const pool = cat === 3 ? near : cat === 4 ? sameContinent : other;
      if (pool.length === 0) continue; // pool empty (e.g. no neighbours); retry
      entity = pool[randInt(rng, pool.length)];
      regionDigit = String(randInt(rng, 10));
    }

    if (!entity) continue;
    const prefixes = entityPrefixes(entity, db);
    if (prefixes.length === 0) continue;

    const call = buildCall(prefixes, regionDigit, rng);
    if (validateCallsign(call, db)) {
      const report = pickReport(rng);
      return new VirtualHam({
        call,
        difficulty,
        report,
        freqHz: freqHz(),
        strength: strengthFromReport(report, call),
        role,
      });
    }
  }

  // Extremely unlikely fallback: a plain call from the user's own entity.
  const fbPrefixes = uEnt ? entityPrefixes(uEnt, db) : ["W"];
  const fbCall = buildCall(fbPrefixes.length ? fbPrefixes : ["W"], uRegionDigit ?? "1", rng);
  return new VirtualHam({
    call: fbCall,
    difficulty,
    report: "599",
    freqHz: freqHz(),
    strength: strengthFromReport("599", fbCall),
    role,
  });
}
