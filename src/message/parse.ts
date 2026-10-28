import { DxccDatabase } from "../data/dxcc.js";
import { CUT_NUMBERS } from "./macros.js";

export type MessageType = "CQ" | "CALL" | "RST" | "END" | "QUERY" | "UNKNOWN";
export type EndMarker = "PSE_K" | "K" | "BK" | "SK" | null;

export interface ParsedMessage {
  to: string | null;
  from: string | null;
  type: MessageType;
  rst: string | null;
  end: EndMarker;
  omit_calls: boolean;
  callsignValid: boolean;
  /** Non-CQ callsign tokens found in the message (for copy-error detection). */
  callsigns: string[];
  raw: string;
}

/**
 * Minimal context the parser needs to decide callsign omission. The QSO state
 * machine owns the authoritative context and passes a read-only view here.
 */
export interface ParseContext {
  myCall: string;
  peerCall: string | null;
  callsignsConfirmed: boolean;
  callsignsOmitted: boolean;
}

// ITU callsign format. Suffix letters optional to admit China's `B5` style
// portable calls; `/...` operation suffix (e.g. /P, /M, /5) still allowed.
export const CALL_RE = /^[A-Z]{1,2}[0-9][A-Z]{0,4}(?:\/[A-Z0-9]{1,4})?$/;
// RST is validated as a whole token, never as a substring of the message.
export const RST_RE = /^[1-5][1-9][1-9]$/;

/** The digits behind the cut letters, derived so the two tables cannot drift. */
const UNCUT: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(CUT_NUMBERS).map(([digit, letter]) => [letter, digit]),
);

/**
 * Read one cut number back as digits: `5NN` → `599`, `5BN` → `579`, `VVN` →
 * `339`. A token that does not unfold into a legal report is left alone.
 */
function uncut(token: string): string {
  if (!/^[A-Z0-9]{3}$/.test(token)) return token;
  const digits = [...token].map((c) => UNCUT[c] ?? c).join("");
  return RST_RE.test(digits) ? digits : token;
}

/** Letters before the first digit, with any `/...` operation suffix removed. */
export function extractLetterPrefix(callsign: string): string {
  const base = callsign.split("/")[0];
  return base.replace(/[0-9].*$/, "");
}

/**
 * Does this token read as an exchanged number — `05`, `012`, or their cut forms
 * `T5`, `TTA`?
 *
 * A contest exchange sits immediately after the report, and cut numbers are
 * indistinguishable from callsigns by shape alone: `U4` is 24, but it also looks
 * exactly like a two-letter, one-digit callsign. What separates them is position,
 * which the caller tracks (see `parseMessage`), and this test, which only has to
 * accept a short run of digits and cut letters.
 *
 * Position wins over "is it a real callsign": `RST 599 N9N` reads `N9N` as 999,
 * not as a station. The other way round would break `A45` (serial 145) and
 * `T4A` (040), which are ordinary contest copy — and a call appearing *after* the
 * report is a shape that barely occurs in practice. The trade-off is written up
 * in `doc/MESSAGE-PARSING.md` under 「比赛交换数字」.
 */
function readsAsNumber(token: string): boolean {
  if (/^\d{1,4}$/.test(token)) return true;
  if (!/^[A-Z0-9]{1,4}$/.test(token)) return false;
  let digits = "";
  for (const ch of token) {
    if (/[0-9]/.test(ch)) digits += ch;
    else if (UNCUT[ch]) digits += UNCUT[ch];
    else return false;
  }
  return digits.length <= 4;
}

/**
 * Callsigns a line names, with any exchanged number left out.
 *
 * This is the same positional rule as `parseMessage`, packaged for the session's
 * "who was that addressed to?" question. Without it a contest exchange would
 * read as a callsign: `U4` (24 zone) is indistinguishable from a two-letter,
 * one-digit call by shape, so a station calling CQ would appear to have been
 * named by a message that named nobody.
 *
 * The operator's own call is *not* filtered here — callers differ on that.
 */
export function namedCallsignsIn(line: string): string[] {
  const out: string[] = [];
  let exchangeSlots = 0;
  for (const token of normalize(line).split(/[^A-Z0-9/]+/)) {
    if (!token) continue;
    if (RST_RE.test(token)) {
      exchangeSlots = 2;
      continue;
    }
    if (exchangeSlots > 0 && readsAsNumber(token)) {
      exchangeSlots -= 1;
      continue;
    }
    exchangeSlots = 0;
    if (CALL_RE.test(token) && !out.includes(token)) out.push(token);
  }
  return out;
}

/** Validate a token as a callsign: ITU format + prefix-table hit. */
export function validateCallsign(token: string, db: DxccDatabase): boolean {
  if (!CALL_RE.test(token)) return false;
  return db.isValidPrefix(extractLetterPrefix(token));
}

/** Normalize a raw CW text: uppercase, collapse spaces, fold common variants. */
export function normalize(text: string): string {
  let t = text.toUpperCase().replace(/\s+/g, " ").trim();
  // Cut numbers read back as digits — the rest of the parser knows nothing
  // else. Only where a report can actually sit: right after the RST keyword,
  // and in a token that already starts with a digit (no word does; folding
  // every three-letter token would read `AND` as `198`).
  t = t.replace(/\bRST ([A-Z0-9]{3})(?: ([A-Z0-9]{3}))?/g, (_all, a: string, b?: string) =>
    b === undefined ? `RST ${uncut(a)}` : `RST ${uncut(a)} ${uncut(b)}`,
  );
  t = t
    .split(" ")
    .map((token) => (/^[1-5]/.test(token) ? uncut(token) : token))
    .join(" ");
  t = t.replace(/\bTNX\b|\bTHX\b/g, "TU");
  t = t.replace(/<SK>/g, "SK");
  return t;
}

/**
 * Parse a normalized CW text line into a structured message.
 *
 * `direction` is "tx" when the message was authored by the local user, "rx"
 * when authored by the peer (virtual HAM). It only affects the `from`/`to`
 * assignment when callsigns are omitted.
 */
export function parseMessage(
  raw: string,
  ctx: ParseContext,
  direction: "tx" | "rx",
  db: DxccDatabase,
): ParsedMessage {
  let text = normalize(raw);

  // 1. Identify the turn-over / end marker. Order matters: PSE K, BK, SK, K.
  let end: EndMarker = null;
  if (/\bPSE\s+K\b/.test(text)) {
    end = "PSE_K";
    text = text.replace(/\bPSE\s+K\b/, "");
  } else if (/\bBK\b/.test(text)) {
    end = "BK";
    text = text.replace(/\bBK\b/, "");
  } else if (/\bSK\b/.test(text)) {
    end = "SK";
    text = text.replace(/\bSK\b/, "");
  } else if (/\bK\b/.test(text)) {
    end = "K";
    text = text.replace(/\bK\b/, "");
  }
  text = text.replace(/\s+/g, " ").trim();

  // 2. Drop the DE connector.
  text = text.replace(/\bDE\b/g, " ").replace(/\s+/g, " ").trim();

  // 3. Tokenize and separate callsigns from message words.
  //
  // A contest exchange follows the report and can look exactly like a callsign
  // (`5NN U4` — 24 zone, cut form), so the two tokens after a report are read as
  // numbers first and never mistaken for a station's name. Without this, sending
  // our exchange looked like sending somebody else's callsign and the machine
  // answered `QRZ?`.
  const tokens = text.length ? text.split(" ") : [];
  const callsigns: string[] = [];
  const msgTokens: string[] = [];
  let callsignValid = true;
  let cqPresent = false;
  let exchangeSlots = 0;

  for (const t of tokens) {
    if (t === "CQ") {
      cqPresent = true;
    } else if (exchangeSlots > 0 && readsAsNumber(t)) {
      // The exchanged number, not a callsign: `{RST} {EXCH}` and its repeat.
      msgTokens.push(t);
      exchangeSlots -= 1;
    } else if (CALL_RE.test(t)) {
      // Skip a consecutive duplicate callsign (e.g. "DE BG7XXX BG7XXX").
      if (callsigns.length === 0 || callsigns[callsigns.length - 1] !== t) {
        callsigns.push(t);
      }
      if (!validateCallsign(t, db)) callsignValid = false;
    } else {
      msgTokens.push(t);
      if (RST_RE.test(t)) exchangeSlots = 2;
    }
  }

  // 4. Resolve to / from and omission.
  let to: string | null = null;
  let from: string | null = null;
  let omitCalls = false;

  if (callsigns.length === 0) {
    if (ctx.callsignsConfirmed || ctx.callsignsOmitted) {
      omitCalls = true;
      to = direction === "tx" ? ctx.peerCall : ctx.myCall;
      from = direction === "tx" ? ctx.myCall : ctx.peerCall;
    }
  } else if (callsigns.length === 1) {
    const c = callsigns[0];
    if (c === ctx.myCall) {
      to = ctx.myCall;
      from = direction === "tx" ? ctx.myCall : ctx.peerCall;
    } else if (c === ctx.peerCall) {
      to = ctx.peerCall;
      from = direction === "tx" ? ctx.myCall : ctx.peerCall;
    } else {
      to = c;
      from = direction === "tx" ? ctx.myCall : null;
    }
  } else {
    to = callsigns[0];
    from = callsigns[1];
  }

  // 5. Classify message type.
  let type: MessageType = "UNKNOWN";
  let rst: string | null = null;
  const rstTok = msgTokens.find((t) => RST_RE.test(t));
  if (rstTok) {
    rst = rstTok;
    type = "RST";
  } else if (/\bRST\b/.test(text)) {
    type = "QUERY"; // e.g. "UR RST?" with no valid RST token
  } else if (end === "SK" || /\b(TU|73|SK)\b/.test(text)) {
    type = "END";
  } else if (/\b(QRZ\?|AGN\?|\?)\b/.test(text)) {
    type = "QUERY";
  } else if (cqPresent) {
    type = "CQ";
  } else if (callsigns.length > 0) {
    type = "CALL";
  }

  return { to, from, type, rst, end, omit_calls: omitCalls, callsignValid, callsigns, raw };
}
