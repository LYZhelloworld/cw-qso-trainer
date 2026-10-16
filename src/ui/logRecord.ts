import type { QsoLog, QsoState } from "../qso/stateMachine.js";

/**
 * Log book rows shown on the log page, mirroring the field table in UI.md:
 * DATE / TIME_UTC / CALL / FREQ_MHZ / MODE / RST_RX / RST_TX.
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

/** The conditions UI.md requires before a QSO is written to the log. */
export interface LogGate {
  state: QsoState;
  callsignsConfirmed: boolean;
  rstRx: string | null;
  rstTx: string | null;
  peerEndHeard: boolean;
  userEndSent: boolean;
}

export function canWriteLog(g: LogGate): boolean {
  return (
    g.state === "LOGGED" &&
    g.callsignsConfirmed &&
    g.rstRx !== null &&
    g.rstTx !== null &&
    g.peerEndHeard &&
    g.userEndSent
  );
}

export function formatFreqMHz(freqMHz: number): string {
  return freqMHz.toFixed(4);
}

/**
 * Derive a log row from the machine's final QsoLog plus the working frequency.
 * Returns null when the exchange is incomplete — `canWriteLog` should be checked
 * first; this is the defensive second gate.
 */
export function deriveLogRecord(
  qso: QsoLog,
  freqMHz: number,
  now: Date = new Date(),
): LogRecord | null {
  if (!qso.peerCall || !qso.rstRx || !qso.rstTx) return null;
  const iso = now.toISOString();
  return {
    date: iso.slice(0, 10),
    timeUtc: iso.slice(11, 19),
    call: qso.peerCall,
    freqMHz: formatFreqMHz(freqMHz),
    mode: "CW",
    rstRx: qso.rstRx,
    rstTx: qso.rstTx,
  };
}
