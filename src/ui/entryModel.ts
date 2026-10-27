/**
 * The log-entry row: the boxes the operator fills in by ear, plus which of the
 * eight quick messages is the one to send next.
 *
 * Everything here is pure — values in, decision out — so the whole flow (what is
 * highlighted, what Enter does, what Space does) is testable without a DOM. The
 * panel in `src/ui/pages/entryPanel.ts` only renders the decision and moves the
 * caret.
 *
 * The flow, as documented in `doc/MESSAGES.md`:
 *
 *  - call box empty            → F1 (calling CQ) or F4 (answering somebody), by mode
 *  - call filled, no report yet → F4, S&P only: our call in answer, before the report
 *  - our report still to send  → F2: send it (the box fills itself with 599)
 *  - their report in, ours out → F3: sign off, write the row, start a new one
 *
 * Enter does the step *and* sends; Space does the step without sending, for when
 * the operator wants to key the message by hand.
 *
 * A contest adds one more thing to copy — the exchanged number — so the row has
 * a fourth box there. It is not a step of its own: it arrives with their report
 * (they send `5NN 05` in one over), so the ladder is the same in all three
 * modes, and only what a *complete* row needs changes (see `canLog`).
 */

import { isValidExchange, requiresExchange, type ContestKind } from "../qso/contest.js";

/** Run = we are calling CQ; S&P = we are answering somebody else's CQ. */
export type OperatingMode = "run" | "s&p";

export type EntryField = "call" | "rstTx" | "rstRx" | "exchRx";

export interface EntryValues {
  mode: OperatingMode;
  /** The other station's callsign, as copied. */
  call: string;
  /** The report we send. `{RST}` / `{RSTFULL}` come from here. */
  rstTx: string;
  /** The report they gave us. */
  rstRx: string;
  /**
   * The number they sent: their CQ zone (CQWW) or their serial (WPX). Copied by
   * ear, like everything else here; empty in DX mode, where nothing is exchanged
   * beyond the report.
   */
  exchRx: string;
  /**
   * Our report has already gone out (or been keyed by hand) for this row.
   *
   * Which of the two reports arrives first depends on who called whom: the
   * station we pounced on comes back with *his* report in the same breath as his
   * call, and a station answering our CQ often does the same. So a filled report
   * box means "copied", not "answered" — without this flag, typing his report
   * would light the sign-off and the contact would end with our side of the
   * exchange never sent.
   */
  reportSent: boolean;
}

/** Which prompt is current. Drives both the highlight and what Enter does. */
export type EntryStep = "call" | "answer" | "report" | "signoff";

/**
 * A row with nothing in it: the state the app opens on.
 *
 * The mode is a parameter rather than a default because the two callers disagree
 * about it in a way that matters: the app opens in S&P (searching the band is
 * what one does on a fresh frequency), while finishing a contact keeps whatever
 * mode the operator was already in.
 */
export function emptyEntry(mode: OperatingMode): EntryValues {
  return { mode, call: "", rstTx: "", rstRx: "", exchRx: "", reportSent: false };
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
  // Pouncing, the first thing said after copying the call is *our* call (F4),
  // not the report: "JA1ABC DE BG7XXX" answers, and only then comes the RST.
  // The step is done with once the report box holds a number — filled by Enter
  // on F4, by Space, or typed in by hand.
  if (v.mode === "s&p" && v.rstTx.trim() === "") return "answer";
  // Their report is the last thing heard — but only once ours is out. That is
  // the same rule in both modes, and it has to be: pouncing, their report comes
  // back with their call, and even in a run the station answering our CQ may
  // send "JA1ABC 5NN" in one breath, which would otherwise take a row straight
  // from an empty report box to the sign-off without our RST ever going out.
  if (v.reportSent && v.rstRx.trim() !== "") return "signoff";
  return "report";
}

/**
 * The key that should be lit: the one whose message is the next thing to say.
 *
 * Only the opening differs by mode: Run says CQ (F1) where S&P says its own call
 * (F4), and S&P says that call twice — once with an empty call box, once with the
 * call copied but the report not yet chosen.
 */
export function highlightedKey(v: EntryValues): number {
  switch (entryStep(v)) {
    case "call":
      return v.mode === "run" ? 1 : 4;
    case "answer":
      return 4;
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
  /** Our report is out: the row is past the report step (see `reportSent`). */
  markReported: boolean;
  /** This row is finished: append it to the log and start a new one. */
  log: boolean;
  /** Clear the boxes (always together with `log`). */
  clear: boolean;
}

const STAY: EntryAction = {
  send: null,
  fillRstTx: null,
  focus: null,
  markReported: false,
  log: false,
  clear: false,
};

/** Enter: take the next step, and send the message that belongs to it. */
export function onEnter(v: EntryValues): EntryAction {
  switch (entryStep(v)) {
    case "call":
      // Nothing to send but the invitation itself: CQ when we are the one
      // calling, our call when we are answering.
      return { ...STAY, send: highlightedKey(v) };
    case "answer":
      // Our call goes out, and the report box fills itself: the next thing to
      // say is the RST, and 599 is what it will be unless the operator says
      // otherwise. The caret crosses to *their* report because that is what the
      // pounced station sends back — it arrives with his call, before ours has
      // gone out, so it is what the operator has to be ready to copy.
      return {
        send: 4,
        fillRstTx: DEFAULT_RST,
        focus: "rstRx",
        markReported: false,
        log: false,
        clear: false,
      };
    case "report":
      return {
        send: 2,
        fillRstTx: v.rstTx.trim() === "" ? DEFAULT_RST : null,
        focus: "rstRx",
        markReported: true,
        log: false,
        clear: false,
      };
    case "signoff":
      return {
        send: 3,
        fillRstTx: null,
        focus: "call",
        markReported: false,
        log: true,
        clear: true,
      };
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
  const step = entryStep(v);
  if (step === "answer") {
    return { ...STAY, fillRstTx: DEFAULT_RST, focus: "rstRx" };
  }
  if (step !== "report") return STAY;
  return {
    send: null,
    fillRstTx: v.rstTx.trim() === "" ? DEFAULT_RST : null,
    focus: "rstRx",
    // Keyed by hand is still sent: the step it stands for has been taken.
    markReported: true,
    log: false,
    clear: false,
  };
}

/**
 * Whether this row can be written to the log: a callsign, both reports, and —
 * in a contest — the number they sent.
 *
 * The callsign is only required to be non-empty — a practice log may hold a call
 * that does not exist, but it may not hold a blank one. The exchange is checked
 * against its mode's range instead: a CQWW zone outside 1–40 is not a zone, and
 * a row with a hole in it is not a contact.
 */
export function canLog(v: EntryValues, contest: ContestKind = "DX"): boolean {
  if (normaliseCall(v.call) === "") return false;
  if (!isValidRst(v.rstTx) || !isValidRst(v.rstRx)) return false;
  if (requiresExchange(contest) && !isValidExchange(contest, v.exchRx)) return false;
  return true;
}

/**
 * Which box to blame when Enter does nothing at the last step. Null when the row
 * is complete — the panel shows a hint next to that box.
 */
export function blockingField(v: EntryValues, contest: ContestKind = "DX"): EntryField | null {
  if (normaliseCall(v.call) === "") return "call";
  if (!isValidRst(v.rstTx)) return "rstTx";
  if (!isValidRst(v.rstRx)) return "rstRx";
  if (requiresExchange(contest) && !isValidExchange(contest, v.exchRx)) return "exchRx";
  return null;
}
