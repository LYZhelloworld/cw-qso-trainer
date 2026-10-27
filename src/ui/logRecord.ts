import { canLog, normaliseCall, type EntryValues } from "./entryModel.js";
import {
  requiresExchange,
  verifyEntry,
  type ContestKind,
  type LogVerdict,
  type PartnerTruth,
} from "../qso/contest.js";

/**
 * Log book rows shown on the log page, mirroring the field table in LOG.md:
 * DATE / TIME_UTC / CALL / FREQ_MHZ / MODE / RST_RX / RST_TX, plus the contest
 * columns (EXCH_RX / EXCH_TX) and the verdict.
 *
 * The row is built from **what the operator wrote down** — the boxes on the
 * operating screen — not from the state machine's idea of the QSO. A real
 * logbook is the operator's own record; if they mis-copied a call, the log
 * holds the mis-copied call, and the band never gets a vote.
 *
 * The verdict is the one place the band *does* get a vote — after the fact, and
 * only to say whether the copy was right. See `verifyEntry` in `qso/contest`.
 *
 * Pure data + derivation (no DOM, no storage) so it stays unit-testable.
 */

export interface LogRecord {
  /** Assigned by IndexedDB (auto-increment). Absent before the first save. */
  id?: number;
  date: string; // YYYY-MM-DD
  timeUtc: string; // HH:MM:SS
  call: string;
  freqMHz: string; // e.g. "14.0250"
  /**
   * Always plain "CW". The rig's CW-L / CW-U (which sideband the receiver is
   * demodulating) is an operating preference, not a mode — it never reaches the
   * log, exactly as a real logbook records CW either way.
   */
  mode: "CW";
  rstRx: string;
  rstTx: string;
  /**
   * Which of the three logs this row belongs to. Optional because rows written
   * before contest mode existed have no such field; `contestOf` reads those as
   * DX, which is what they are.
   */
  contest?: ContestKind;
  /** The number we sent (our zone / our serial). Empty in DX mode. */
  exchTx?: string;
  /** The number they sent, as copied. Empty in DX mode. */
  exchRx?: string;
  /**
   * Whether the row matches what the station actually sent. Absent when there
   * was no station to compare against — a row typed in by hand is logged, not
   * judged — and dropped when the row is edited on the log page, because an
   * edited copy is no longer the copy that was checked.
   */
  verdict?: LogVerdict;
}

/** Which log a row belongs to; rows from before contest mode are DX. */
export function contestOf(record: LogRecord): ContestKind {
  return record.contest ?? "DX";
}

export function formatFreqMHz(freqMHz: number): string {
  return freqMHz.toFixed(4);
}

/** Everything a row needs beyond the boxes: the mode, the clock, the truth. */
export interface BuildLogOptions {
  /** The moment of sign-off; defaults to now. */
  now?: Date;
  /** Which log it goes to, and what a complete row means. */
  contest?: ContestKind;
  /** The number we sent, i.e. `{EXCH}` as it went out. */
  exchTx?: string;
  /** What the station really sent, captured while the contact was open. */
  truth?: PartnerTruth | null;
}

/**
 * Turn a completed entry row into a log row.
 *
 * The moment is "now" — when the operator signs off — and the frequency is the
 * dial at that moment, which is what a paper log would say. Null when the row
 * is not complete (`canLog`), so a half-filled row can never reach the log.
 */
export function buildLogRecord(
  entry: EntryValues,
  freqMHz: number,
  opts: BuildLogOptions = {},
): LogRecord | null {
  const contest = opts.contest ?? "DX";
  if (!canLog(entry, contest)) return null;
  const now = opts.now ?? new Date();
  const iso = now.toISOString();
  const record: LogRecord = {
    date: iso.slice(0, 10),
    timeUtc: iso.slice(11, 19),
    call: normaliseCall(entry.call),
    freqMHz: formatFreqMHz(freqMHz),
    mode: "CW",
    rstRx: entry.rstRx.trim(),
    rstTx: entry.rstTx.trim(),
    contest,
    exchRx: requiresExchange(contest) ? entry.exchRx.trim() : "",
    exchTx: requiresExchange(contest) ? (opts.exchTx ?? "").trim() : "",
  };
  const verdict = verifyEntry(entry, opts.truth ?? null, contest);
  if (verdict) record.verdict = verdict;
  return record;
}
