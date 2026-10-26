/**
 * The log-entry row: three boxes the operator fills in by ear, plus which of the
 * eight quick messages is the one to send next.
 *
 * Everything here is pure — values in, decision out — so the whole flow (what is
 * highlighted, what Enter does, what Space does) is testable without a DOM. The
 * panel in `src/ui/pages/entryPanel.ts` only renders the decision and moves the
 * caret.
 *
 * The flow, as documented in `doc/MESSAGES.md`:
 *
 *  - call box empty      → F1 (calling CQ) or F4 (answering somebody), by mode
 *  - call filled         → F2: send the report, and the report box fills itself
 *  - their report filled → F3: sign off, write the row, start a new one
 *
 * Enter does the step *and* sends; Space does the step without sending, for when
 * the operator wants to key the message by hand.
 */

/** Run = we are calling CQ; S&P = we are answering somebody else's CQ. */
export type OperatingMode = "run" | "s&p";

export type EntryField = "call" | "rstTx" | "rstRx";

export interface EntryValues {
  mode: OperatingMode;
  /** The other station's callsign, as copied. */
  call: string;
  /** The report we send. `{RST}` / `{RSTFULL}` come from here. */
  rstTx: string;
  /** The report they gave us. */
  rstRx: string;
}

/** Which prompt is current. Drives both the highlight and what Enter does. */
export type EntryStep = "call" | "report" | "signoff";

/** A row with nothing in it: the state after the app opens and after each QSO. */
export function emptyEntry(mode: OperatingMode = "run"): EntryValues {
  return { mode, call: "", rstTx: "", rstRx: "" };
}

/**
 * The default report. Real operators send 599 overwhelmingly often, so the
 * operator should not have to type three digits to start a QSO — but it stays a
 * box they can change, because 579 is the whole point of a report.
 */
export const DEFAULT_RST = "599";

const RST_RE = /^[1-5][1-9][1-9]$/;

export function isValidRst(value: string): boolean {
  return RST_RE.test(value.trim().toUpperCase());
}

/** Callsigns are only checked for "not empty": this is a practice logbook. */
export function normaliseCall(value: string): string {
  return value.trim().toUpperCase();
}

export function entryStep(v: EntryValues): EntryStep {
  if (normaliseCall(v.call) === "") return "call";
  if (v.rstRx.trim() === "") return "report";
  return "signoff";
}

/**
 * The key that should be lit: the one whose message is the next thing to say.
 *
 * In S&P the first thing to say is "here I am" (F4, our call in answer), not a
 * CQ — that is the only place the mode changes the sequence.
 */
export function highlightedKey(v: EntryValues): number {
  switch (entryStep(v)) {
    case "call":
      return v.mode === "run" ? 1 : 4;
    case "report":
      return 2;
    case "signoff":
      return 3;
  }
}

export interface EntryAction {
  /** F-key to put on the air, or null when this action only moves the caret. */
  send: number | null;
  /**
   * Value to write into the report box when it is still empty — the step-2
   * convenience. Null means "leave what is there".
   */
  fillRstTx: string | null;
  /** Where the caret goes afterwards; null = leave it where it is. */
  focus: EntryField | null;
  /** This row is finished: append it to the log and start a new one. */
  log: boolean;
  /** Clear the boxes (always together with `log`). */
  clear: boolean;
}

const STAY: EntryAction = { send: null, fillRstTx: null, focus: null, log: false, clear: false };

/** Enter: take the next step, and send the message that belongs to it. */
export function onEnter(v: EntryValues): EntryAction {
  switch (entryStep(v)) {
    case "call":
      // Nothing to send but the invitation itself: CQ when we are the one
      // calling, our call when we are answering.
      return { ...STAY, send: highlightedKey(v) };
    case "report":
      return {
        send: 2,
        fillRstTx: v.rstTx.trim() === "" ? DEFAULT_RST : null,
        focus: "rstRx",
        log: false,
        clear: false,
      };
    case "signoff":
      return { send: 3, fillRstTx: null, focus: "call", log: true, clear: true };
  }
}

/**
 * Space: the same step, without transmitting.
 *
 * Used when the operator wants to key the message themselves (straight key,
 * paddles) or not send it at all yet. In the first and last step there is no
 * step to take without sending, so it does nothing.
 */
export function onSpace(v: EntryValues): EntryAction {
  if (entryStep(v) !== "report") return STAY;
  return {
    send: null,
    fillRstTx: v.rstTx.trim() === "" ? DEFAULT_RST : null,
    focus: "rstRx",
    log: false,
    clear: false,
  };
}

/**
 * Whether this row can be written to the log: a callsign and two reports.
 *
 * The callsign is only required to be non-empty — a practice log may hold a call
 * that does not exist, but it may not hold a blank one.
 */
export function canLog(v: EntryValues): boolean {
  return normaliseCall(v.call) !== "" && isValidRst(v.rstTx) && isValidRst(v.rstRx);
}

/**
 * Which box to blame when Enter does nothing at the last step. Null when the row
 * is complete — the panel shows a hint next to that box.
 */
export function blockingField(v: EntryValues): EntryField | null {
  if (normaliseCall(v.call) === "") return "call";
  if (!isValidRst(v.rstTx)) return "rstTx";
  if (!isValidRst(v.rstRx)) return "rstRx";
  return null;
}
