import { dxccDatabase } from "../data/dxcc.js";
import { QsoMachine } from "../qso/stateMachine.js";
import { VirtualHam } from "../ham/virtualHam.js";
import { clearStaging, loadStaging, saveStaging } from "./storage/qsoStaging.js";
import type { TranscriptLine } from "./sessionTypes.js";

/**
 * Staging for an in-progress QSO: writing it out after every line, and picking
 * it back up on start-up.
 *
 * Split out of `QsoSession` because it is all serialization — deciding what is
 * worth keeping, rebuilding a `VirtualHam` and a `QsoMachine` from a snapshot —
 * and none of it needs the session except the data to write.
 */

/** A QSO that can be resumed, already rebuilt from its snapshot. */
export interface RestoredQso {
  ham: VirtualHam;
  machine: QsoMachine;
  lines: TranscriptLine[];
  draft: string;
}

/** States worth resuming. A finished or failed QSO is not a conversation. */
const RESUMABLE = new Set(["USER_CQ", "PEER_CQ", "EXCHANGE", "SIGNOFF"]);

/**
 * Write the in-progress QSO to localStorage so a refresh can resume it.
 *
 * A finished or failed QSO is cleared instead — staging is only for the
 * conversation still underway, and the log already holds the completed record.
 */
export function saveStagingFor(view: {
  freqMHz: number;
  lines: TranscriptLine[];
  draft: string;
  machine: QsoMachine | null;
  ham: VirtualHam | null;
}): void {
  const { machine, ham } = view;
  if (machine && (machine.state === "LOGGED" || machine.state === "FAILED")) {
    clearStaging();
    return;
  }
  saveStaging({
    freqMHz: view.freqMHz,
    lines: view.lines,
    draft: view.draft,
    machine: machine ? machine.snapshot() : null,
    ham: ham
      ? {
          call: ham.call,
          difficulty: ham.difficulty,
          report: ham.report,
          freqHz: ham.freqHz,
          strength: ham.strength,
        }
      : null,
  });
}

/**
 * Rebuild the last staged QSO, if there is one and it still matches this
 * frequency. Returns null for a stale snapshot — a different band, nothing
 * worth resuming, or an already-finished QSO — and drops it rather than
 * resurrecting it.
 */
export function loadRestorable(freqMHz: number, myCall: string): RestoredQso | null {
  const staged = loadStaging();
  if (!staged) return null;
  if (staged.freqMHz !== freqMHz || !staged.machine || !staged.ham) {
    clearStaging();
    return null;
  }
  if (!RESUMABLE.has(staged.machine.state)) {
    clearStaging();
    return null;
  }
  const ham = new VirtualHam({
    call: staged.ham.call,
    difficulty: staged.ham.difficulty,
    report: staged.ham.report,
    ...(staged.ham.freqHz !== undefined ? { freqHz: staged.ham.freqHz } : {}),
    ...(staged.ham.strength !== undefined ? { strength: staged.ham.strength } : {}),
  });
  return {
    ham,
    machine: QsoMachine.fromSnapshot(staged.machine, { myCall, ham, db: dxccDatabase }),
    lines: staged.lines,
    draft: staged.draft,
  };
}
