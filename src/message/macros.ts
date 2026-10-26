/**
 * Macro expansion for quick messages (see `doc/MESSAGES.md`).
 *
 * A mode file writes messages as templates — `CQ CQ CQ DE {MYCALL} {MYCALL} PSE K`
 * — and the values only become known while operating: the other station's call
 * is what the operator copied down, the RST is what they decided to send. So
 * expansion happens at the moment the key is pressed, never earlier.
 *
 * Pure text: no DOM, no session, no clock.
 */

/** Every macro the mode files may use. */
export const MACRO_NAMES = ["MYCALL", "THEIRCALL", "RST", "RSTFULL", "EXCH"] as const;
export type MacroName = (typeof MACRO_NAMES)[number];

export interface MacroValues {
  /** Our callsign, as set in the settings. */
  myCall: string;
  /** The station being worked, as typed into the log entry. */
  theirCall: string;
  /** The report we are sending, full form (e.g. `599`). */
  rstFull: string;
  /** Contest exchange. Empty in DX mode, and allowed to be. */
  exch?: string;
}

export interface ExpandOptions {
  /**
   * Leave a macro that has no value in the text, as `{NAME}`, instead of
   * dropping it. That is how a key's tooltip shows the message it *would* key:
   * a hole stays visible, so the operator can see which value is still missing.
   * On the air the hole is simply nothing (see `missing`).
   */
  keepUnfilled?: boolean;
}

export interface ExpandResult {
  /** The message as it goes on the air: single spaces, no leading/trailing. */
  text: string;
  /**
   * Macros that had no value yet. Names of macros, deduplicated.
   *
   * This is reporting, not a veto: a message with a hole still goes out — the
   * hole is just empty, exactly as if the operator had left the box blank. The
   * only thing that stops a message is having no text at all.
   */
  missing: string[];
}

const MACRO_RE = /\{([A-Za-z]+)\}/g;

/**
 * CW "cut numbers": the digits that have a shorter, conventional letter form on
 * the air, after the IARU manual's table (0 = T, 1 = A, 2 = U, 3 = V, 7 = B,
 * 8 = D, 9 = N).
 *
 * Two digits are absent on purpose:
 *  - `4` and `6` have no cut form at all — every published list sends them in
 *    full.
 *  - `5` does have one (`E`), but cutting it turns the one report everybody
 *    sends into `ENN`: nobody expects it, and the peer model reads `5NN`. Add
 *    `"5": "E"` here to opt in; nothing else has to change.
 *
 * Cutting is about the air only: the log keeps the digits the operator typed.
 */
export const CUT_NUMBERS: Readonly<Record<string, string>> = {
  "0": "T",
  "1": "A",
  "2": "U",
  "3": "V",
  "7": "B",
  "8": "D",
  "9": "N",
};

/**
 * Send every digit that has a cut form as that form: `599` → `5NN`, `579` →
 * `5BN`, `339` → `VVN`. Digits without a form keep their shape.
 */
export function cutNumbers(
  text: string,
  table: Readonly<Record<string, string>> = CUT_NUMBERS,
): string {
  return text.replace(/[0-9]/g, (digit) => table[digit] ?? digit);
}

/** Expand one template. Unknown or empty macros are reported, not guessed. */
export function expandMacros(
  template: string,
  values: MacroValues,
  options: ExpandOptions = {},
): ExpandResult {
  const byName: Record<MacroName, string> = {
    MYCALL: values.myCall.trim(),
    THEIRCALL: values.theirCall.trim(),
    // Reports and exchanges go out as cut numbers; the full-width macros stay
    // as typed, so a mode file can always ask for plain digits.
    RST: cutNumbers(values.rstFull.trim()),
    RSTFULL: values.rstFull.trim(),
    // The contest exchange is empty in DX mode by definition, so an empty value
    // here is not a missing one.
    EXCH: cutNumbers((values.exch ?? "").trim()),
  };

  const missing: string[] = [];
  const expanded = template.replace(MACRO_RE, (whole, rawName: string) => {
    const name = rawName.toUpperCase() as MacroName;
    if (!(name in byName)) {
      missing.push(rawName);
      return whole;
    }
    const value = byName[name];
    if (value === "" && name !== "EXCH") {
      missing.push(rawName);
      // Nothing has been typed for this one: it contributes nothing to the
      // message — unless the caller wants to *see* the hole.
      return options.keepUnfilled ? whole : "";
    }
    return value;
  });

  return {
    // Removing a macro can leave a double space (or one at the edge); a message
    // is a line of CW, so the gaps that matter are the ones between words.
    text: expanded.replace(/\s+/g, " ").trim(),
    missing: [...new Set(missing)],
  };
}

/** The values a message is expanded against, taken from the operating screen. */
export function macroValuesFrom(
  myCall: string,
  theirCall: string,
  rstFull: string,
): MacroValues {
  return { myCall, theirCall, rstFull, exch: "" };
}
