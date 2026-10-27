import type { DxccData, DxccEntity } from "./dxcc.js";

/**
 * Parser for `data/cty.dat`, the country file maintained by Jim Reisert AD1C
 * and published at country-files.com. Format reference:
 * https://www.country-files.com/cty-dat-format/
 *
 * One record per DXCC entity: a header line of eight colon-terminated fields,
 * then one or more alias lines listing the prefixes that belong to it.
 *
 *   field  contents
 *   1      country name              (parsed past, never stored)
 *   2      CQ zone
 *   3      ITU zone                  (unused)
 *   4      continent, two letters
 *   5      latitude, positive north
 *   6      longitude, positive WEST   (negated on the way in)
 *   7      UTC offset                (unused)
 *   8      primary prefix; a leading `*` marks a WAE-only entity
 *
 * Four things are taken from each record: the centroid, the continent, the CQ
 * zone and the prefix list. The country name is deliberately dropped —
 * `doc/UI.md` says the trainer never tells the operator who is on the other
 * end, and a dataset that carried names would put that one careless log line
 * away from leaking. The CQ zone survives because a contest *sends* it: it is
 * one of the two numbers a CQWW exchange consists of (`qso/contest`).
 *
 * Longitude is the one field whose sign convention differs from the rest of
 * this codebase: the file counts degrees WEST as positive, we count them EAST,
 * so it is negated exactly once, here.
 */

const CONTINENTS = new Set(["AF", "AN", "AS", "EU", "NA", "OC", "SA"]);

/** Where a per-prefix override begins: `(cq)`, `[itu]`, `<lat/lon>`, `{cont}`, `~tz~`. */
const OVERRIDE = /[([<{~]/;

/** Strip overrides and the WAE marker, leaving the bare prefix. */
function barePrefix(token: string): string {
  return token.split(OVERRIDE)[0].replace(/\*/g, "").trim();
}

interface Pending {
  marker: string;
  lat: number;
  lon: number;
  continent: string;
  cqZone: number;
  /** Prefixes collected from the alias lines; `=` entries are not prefixes. */
  aliases: string[];
}

/**
 * Read the eight header fields. Returns null for a record we keep nothing from:
 * WAE-only entities (their prefix carries `*`) count as part of a parent entity
 * in ARRL contests.
 */
function parseHeader(line: string, lineNo: number): Pending | null {
  const fields = line.split(":");
  if (fields.length < 9) {
    throw new Error(`cty.dat:${lineNo}: header has ${fields.length - 1} fields, expected 8`);
  }
  // The name may itself contain colons, so anchor on the tail: the last field
  // is the empty string after the trailing delimiter.
  const tail = fields.slice(-8);
  const cqZone = Number.parseInt(tail[0].trim(), 10);
  const continent = tail[2].trim().toUpperCase();
  const lat = Number.parseFloat(tail[3]);
  const lonWest = Number.parseFloat(tail[4]);
  const primary = tail[6].trim();

  if (!Number.isInteger(cqZone) || cqZone < 1 || cqZone > 40) {
    throw new Error(`cty.dat:${lineNo}: unreadable CQ zone "${tail[0]}"`);
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lonWest)) {
    throw new Error(`cty.dat:${lineNo}: unreadable coordinates "${tail[3]}:${tail[4]}"`);
  }
  if (!CONTINENTS.has(continent)) {
    throw new Error(`cty.dat:${lineNo}: unknown continent "${continent}"`);
  }
  if (primary.startsWith("*")) return null;

  const marker = barePrefix(primary);
  if (!marker) {
    throw new Error(`cty.dat:${lineNo}: missing primary prefix`);
  }
  return { marker, lat, lon: -lonWest, continent, cqZone, aliases: [] };
}

/**
 * Parse the whole file. Records that leave no usable prefix behind are dropped:
 * nineteen entities (Conway Reef, Bouvet, ...) can only be worked under specific
 * callsigns, and the file lists those as `=` full calls rather than prefixes.
 * The generator builds every call from a prefix, so keeping them would mean
 * inventing callsigns that the dataset itself says do not exist.
 */
export function parseCty(raw: string): DxccData {
  const entities: Record<string, DxccEntity> = {};
  let pending: Pending | null = null;

  const commit = (): void => {
    if (!pending) return;
    const { marker, lat, lon, continent, cqZone, aliases } = pending;
    pending = null;
    if (aliases.length === 0) return;
    if (entities[marker]) {
      throw new Error(`cty.dat: duplicate primary prefix "${marker}"`);
    }
    entities[marker] = {
      dxcc: marker,
      lat,
      lon,
      continent,
      cqZone,
      prefixes: [...new Set([marker, ...aliases])],
    };
  };

  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;

    // Alias lines are indented; anything else starts a new record.
    if (line[0] !== " ") {
      commit();
      pending = parseHeader(line, index + 1);
      continue;
    }
    if (!pending) continue;

    for (const token of line.trim().split(/[,\s]+/)) {
      const alias = token.replace(/;$/, "");
      // `=` marks a full callsign that must match exactly, not a prefix.
      if (!alias || alias.startsWith("=")) continue;
      const prefix = barePrefix(alias);
      if (prefix) pending.aliases.push(prefix);
    }
  }
  commit();

  if (Object.keys(entities).length === 0) {
    throw new Error("cty.dat: no entities parsed");
  }
  return { entities };
}
