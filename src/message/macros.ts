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

export interface ExpandResult {
  /** The message as it goes on the air: single spaces, no leading/trailing. */
  text: string;
  /**
   * Macros that had no value. Names of macros, deduplicated. Non-empty means
   * the message is not sendable yet — the caller disables the key rather than
   * putting a half-filled line on the air.
   */
  missing: string[];
}

const MACRO_RE = /\{([A-Za-z]+)\}/g;

/**
 * CW shorthand for a report: `9` is sent as `N`, so 599 is `5NN` and 579 is
 * `57N`. Only 9 — the other digits keep their shape in CW.
 */
export function shortRst(full: string): string {
  return full.replace(/9/g, "N");
}

/** Expand one template. Unknown or empty macros are reported, not guessed. */
export function expandMacros(template: string, values: MacroValues): ExpandResult {
  const byName: Record<MacroName, string> = {
    MYCALL: values.myCall.trim(),
    THEIRCALL: values.theirCall.trim(),
    RST: shortRst(values.rstFull.trim()),
    RSTFULL: values.rstFull.trim(),
    // The contest exchange is empty in DX mode by definition, so an empty value
    // here is not a missing one.
    EXCH: (values.exch ?? "").trim(),
  };

  const missing: string[] = [];
  const expanded = template.replace(MACRO_RE, (_whole, rawName: string) => {
    const name = rawName.toUpperCase() as MacroName;
    if (!(name in byName)) {
      missing.push(rawName);
      return `{${rawName}}`;
    }
    const value = byName[name];
    if (value === "" && name !== "EXCH") {
      missing.push(rawName);
      return "";
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
