import type { TranscriptLine } from "../session.js";
import type { MachineSnapshot } from "../../qso/stateMachine.js";
import type { Difficulty } from "../../ham/virtualHam.js";

/**
 * Staging persistence for an *in-progress* QSO, so an accidental refresh does
 * not throw away the conversation the user is mid-way through. Completed or
 * failed QSOs are intentionally NOT staged (the log keeps the record; the
 * transcript can be discarded on refresh).
 *
 * Single-key localStorage (one active QSO at a time), JSON-serialized. Every
 * access is guarded so a missing/blocked storage (private mode, Node) degrades
 * to "no staging" without throwing.
 */

const KEY = "cw-qso-trainer:qso-staging";

export interface HamSnapshot {
  call: string;
  difficulty: Difficulty;
  report: string;
  /** Absolute frequency in Hz (optional: older snapshots predate the waterfall). */
  freqHz?: number;
  /** Signal strength 0..1 (optional, as above). */
  strength?: number;
}

export interface StagedQso {
  freqMHz: number;
  lines: TranscriptLine[];
  draft: string;
  machine: MachineSnapshot | null;
  ham: HamSnapshot | null;
}

function available(): boolean {
  return typeof localStorage !== "undefined";
}

export function saveStaging(data: StagedQso): void {
  if (!available()) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // Storage unavailable or over quota: staging is best-effort only.
  }
}

export function loadStaging(): StagedQso | null {
  if (!available()) return null;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StagedQso;
  } catch {
    return null;
  }
}

export function clearStaging(): void {
  if (!available()) return;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Ignore.
  }
}
