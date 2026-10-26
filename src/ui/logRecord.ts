import { canLog, normaliseCall, type EntryValues } from "./entryModel.js";

/**
 * Log book rows shown on the log page, mirroring the field table in LOG.md:
 * DATE / TIME_UTC / CALL / FREQ_MHZ / MODE / RST_RX / RST_TX.
 *
 * The row is built from **what the operator wrote down** — the three boxes on
 * the operating screen — not from the state machine's idea of the QSO. A real
 * logbook is the operator's own record; if they mis-copied a call, the log
 * holds the mis-copied call, and the band never gets a vote.
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
}

export function formatFreqMHz(freqMHz: number): string {
  return freqMHz.toFixed(4);
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
  now: Date = new Date(),
): LogRecord | null {
  if (!canLog(entry)) return null;
  const iso = now.toISOString();
  return {
    date: iso.slice(0, 10),
    timeUtc: iso.slice(11, 19),
    call: normaliseCall(entry.call),
    freqMHz: formatFreqMHz(freqMHz),
    mode: "CW",
    rstRx: entry.rstRx.trim(),
    rstTx: entry.rstTx.trim(),
  };
}
