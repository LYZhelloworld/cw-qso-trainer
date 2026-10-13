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
 * The user's QTH is approximated by the centroid of their own callsign's DXCC
 * entity (see the dxcc.json coordinate_note). The "region digit" is scoped to
 * the entity (it does not cross countries), per VIRTUAL-HAM.md. The suffix is
 * purely random. An injectable RNG keeps generation deterministic in tests.
 */

import { DxccDatabase, type DxccEntity } from "../data/dxcc.js";
import { extractLetterPrefix, validateCallsign } from "../message/parse.js";
import { VirtualHam, type Difficulty } from "./virtualHam.js";

export interface GenerateOptions {
  myCall: string;
  db: DxccDatabase;
  difficulty?: Difficulty;
  /** Injectable RNG for deterministic tests (defaults to Math.random). */
  rng?: () => number;
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
  for (const p of ent.prefixes) {
    const letterPrefix = p.replace(/[0-9].*$/, "");
    if (/^[A-Z]{1,2}$/.test(letterPrefix) && db.resolvePrefix(letterPrefix) === ent.dxcc) {
      out.push(letterPrefix);
    }
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

function pickReport(rng: () => number): string {
  const r = rng();
  if (r < 0.6) return "599";
  if (r < 0.8) return "589";
  if (r < 0.95) return "579";
  return "599";
}

function buildCall(
  prefixes: string[],
  regionDigit: string,
  rng: () => number,
): string {
  const prefix = prefixes[randInt(rng, prefixes.length)];
  const suffixLen = 1 + randInt(rng, 3); // 1..3
  return `${prefix}${regionDigit}${randomSuffix(rng, suffixLen)}`;
}

export function generateVirtualHam(opts: GenerateOptions): VirtualHam {
  const rng = opts.rng ?? Math.random;
  const difficulty = opts.difficulty ?? pickDifficulty(rng);
  const db = opts.db;

  // User context (QTH ≈ centroid of the user's own DXCC entity).
  const uLetterPrefix = extractLetterPrefix(opts.myCall);
  const uEntityMarker = db.resolvePrefix(uLetterPrefix);
  const uEnt = uEntityMarker ? db.entity(uEntityMarker) : undefined;
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
      return new VirtualHam({ call, difficulty, report: pickReport(rng) });
    }
  }

  // Extremely unlikely fallback: a plain call from the user's own entity.
  const fbPrefixes = uEnt ? entityPrefixes(uEnt, db) : ["W"];
  const fbCall = buildCall(fbPrefixes.length ? fbPrefixes : ["W"], uRegionDigit ?? "1", rng);
  return new VirtualHam({ call: fbCall, difficulty, report: "599" });
}
