import { BANDS } from "./bands.js";
import { contestOf, roundOf, type LogRecord } from "./logRecord.js";

/**
 * Duplicates — the same station, on the same band, in the same session.
 *
 * A real contest log asks one question of every new row: *have I worked this
 * station already?* The answer never stops the contact — you finish it, say
 * thanks, and mark it dupe on paper, because refusing to log somebody you have
 * already worked is rude and, on the air, indistinguishable from not hearing
 * them. So this module only ever **labels**: nothing here gates logging, and
 * nothing here touches the entry row or the state machine.
 *
 * Band rather than exact frequency: a station worked at 14.0251 and again at
 * 14.0317 is a dupe. Contest rules count per band, and so does the operator's
 * memory of "I already worked that guy".
 *
 * The first occurrence is the contact; later ones are the duplicates. Ordering
 * is by insertion id, not by the table's newest-first display order — otherwise
 * the *original* would be the one wearing the label.
 */

/** The band a logged frequency belongs to, for dupe purposes. */
export function bandOfFreq(freqMHz: string): string {
  const f = Number(freqMHz);
  if (!Number.isFinite(f) || f <= 0) return "?";
  for (const band of BANDS) {
    if (f >= band.minMHz && f <= band.maxMHz) return band.name;
  }
  // Outside every band: still a band of its own, keyed by whole MHz, so two
  // stray entries at 3.5 MHz are recognised as the same place.
  return `${Math.floor(f)}MHz`;
}

/**
 * Ids of the rows that repeat an earlier contact.
 *
 * Rows without an id (never saved) cannot be marked and are skipped; everything
 * else is compared against the rows that came before it — by contest, session,
 * band and callsign.
 */
export function dupeIds(records: readonly LogRecord[]): Set<number> {
  const seen = new Set<string>();
  const dupes = new Set<number>();
  const ordered = [...records].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  for (const record of ordered) {
    // Only stored rows take part: an id is what makes a row "already in the
    // book", and an unstored row claiming that would mislabel the real one.
    if (typeof record.id !== "number") continue;
    const key = [
      contestOf(record),
      roundOf(record),
      bandOfFreq(record.freqMHz),
      record.call.trim().toUpperCase(),
    ].join("|");
    if (seen.has(key)) dupes.add(record.id);
    else seen.add(key);
  }
  return dupes;
}
