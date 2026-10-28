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
 *  - our report still to send  → F2: send it (the boxes fill themselves with 599)
 *  - everything copied         → F3: sign off, write the row, start a new one
 *
 * Enter does the step *and* sends; Space does the step without sending, for when
 * the operator wants to key the message by hand.
 *
 * The last step has one exception: signing off can be *said* before it is
 * written down — F3 puts `TU` on the air, and Enter a moment later only writes
 * the row. Enter does not repeat a message that has already gone out for this
 * row (`signoffSent`), and because such an Enter keys nothing, half-duplex does
 * not apply to it either.
 *
 * ## What a contest changes
 *
 * A contest exchanges a number as well, so the row grows a box (their number, and
 * in WPX ours too), and the ladder gets one rung shorter: there is no "answer"
 * step, because the message that carries the report also carries the callsign —
 * `JA1ABC 5NN 24` answers *and* exchanges, which is the whole point of contest
 * shorthand. Copying the call therefore lights F2 directly, not F4.
 *
 * The two reports also arrive already known: everybody in a contest sends 599,
 * so taking the step fills both report boxes, and in WPX our serial too. What is
 * left to copy is the other station's number — which is why the caret lands
 * there.
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
   * The serial *we* are sending (WPX only). Starts empty: the box shows the next
   * number as its placeholder and takes the real value when the row moves past
   * the report step, so the operator can still send `12` instead of `012`.
   */
  ownNr: string;
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
  /**
   * The sign-off has already gone out for this row (F3 pressed by hand).
   *
   * Operators send `TU` and only then write the row down, so the last step is
   * taken twice: once on the air, once on paper. Without this the second press
   * puts a second `TU` on the air — the same message, to a station that has
   * already stopped listening.
   */
  signoffSent: boolean;
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
  return {
    mode,
    call: "",
    rstTx: "",
    rstRx: "",
    ownNr: "",
    exchRx: "",
    reportSent: false,
    signoffSent: false,
  };
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

export function entryStep(v: EntryValues, contest: ContestKind = "DX"): EntryStep {
  if (normaliseCall(v.call) === "") return "call";
  // Pouncing, the first thing said after copying the call is *our* call (F4),
  // not the report: "JA1ABC DE BG7XXX" answers, and only then comes the RST.
  // The step is done with once the report box holds a number — filled by Enter
  // on F4, by Space, or typed in by hand.
  //
  // A contest has no such rung: its report message carries the callsign too, so
  // copying the call already points at F2.
  if (!requiresExchange(contest) && v.mode === "s&p" && v.rstTx.trim() === "") return "answer";
  // Their report is the last thing heard — but only once ours is out. That is
  // the same rule in both modes, and it has to be: pouncing, their report comes
  // back with their call, and even in a run the station answering our CQ may
  // send "JA1ABC 5NN" in one breath, which would otherwise take a row straight
  // from an empty report box to the sign-off without our RST ever going out.
  //
  // The exchanged number is deliberately *not* part of this: it is copied in the
  // same breath as their report, so waiting for it would keep the light on F2
  // (our report, already sent) while the operator is copying. Pressing Enter
  // with the number still missing is caught by `canLog` and points at the box.
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
export function highlightedKey(v: EntryValues, contest: ContestKind = "DX"): number {
  switch (entryStep(v, contest)) {
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
  /**
   * Value to write into *their* report box when it is still empty. In a contest
   * both reports are known in advance — everybody sends 599 — so taking the step
   * writes both instead of one.
   */
  fillRstRx: string | null;
  /** Write our WPX serial into its box, when it is still empty. */
  fillOwnNr: boolean;
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
  fillRstRx: null,
  fillOwnNr: false,
  focus: null,
  markReported: false,
  log: false,
  clear: false,
};

/** Enter: take the next step, and send the message that belongs to it. */
export function onEnter(v: EntryValues, contest: ContestKind = "DX"): EntryAction {
  switch (entryStep(v, contest)) {
    case "call":
      // Nothing to send but the invitation itself: CQ when we are the one
      // calling, our call when we are answering.
      return { ...STAY, send: highlightedKey(v, contest) };
    case "answer":
      // Our call goes out, and the report box fills itself: the next thing to
      // say is the RST, and 599 is what it will be unless the operator says
      // otherwise. The caret crosses to *their* report because that is what the
      // pounced station sends back — it arrives with his call, before ours has
      // gone out, so it is what the operator has to be ready to copy.
      return {
        ...STAY,
        send: 4,
        fillRstTx: DEFAULT_RST,
        focus: "rstRx",
      };
    case "report":
      return {
        ...STAY,
        send: 2,
        ...prefill(v, contest),
        focus: requiresExchange(contest) ? "exchRx" : "rstRx",
        markReported: true,
      };
    case "signoff":
      // `TU` has already gone out for this row: this Enter is the writing-down,
      // not the saying-goodbye. Sending it again would key a second `TU` at the
      // station that has just been released.
      return {
        ...STAY,
        send: v.signoffSent ? null : 3,
        focus: "call",
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
export function onSpace(v: EntryValues, contest: ContestKind = "DX"): EntryAction {
  const step = entryStep(v, contest);
  if (step === "answer") {
    return { ...STAY, fillRstTx: DEFAULT_RST, focus: "rstRx" };
  }
  if (step !== "report") return STAY;
  return {
    ...STAY,
    ...prefill(v, contest),
    focus: requiresExchange(contest) ? "exchRx" : "rstRx",
    // Keyed by hand is still sent: the step it stands for has been taken.
    markReported: true,
  };
}

/**
 * What the row already knows when the report step is taken.
 *
 * DX fills our own report only. A contest fills both reports — 599 is what the
 * other station sends as surely as it is what we send — and our WPX serial,
 * which is a counter the program keeps, not something to copy. Nothing here
 * overwrites a box the operator has already typed in.
 */
function prefill(
  v: EntryValues,
  contest: ContestKind,
): Pick<EntryAction, "fillRstTx" | "fillRstRx" | "fillOwnNr"> {
  if (!requiresExchange(contest)) {
    return {
      fillRstTx: v.rstTx.trim() === "" ? DEFAULT_RST : null,
      fillRstRx: null,
      fillOwnNr: false,
    };
  }
  return {
    fillRstTx: v.rstTx.trim() === "" ? DEFAULT_RST : null,
    fillRstRx: v.rstRx.trim() === "" ? DEFAULT_RST : null,
    fillOwnNr: v.ownNr.trim() === "",
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
