import { FROM_MORSE } from "./morseTable.js";

/**
 * Morse decoding: keying timing (ON/OFF durations in ms) -> letter text.
 *
 * This is the receive side of CW-PARSING. It only maps symbols to characters —
 * it does NOT parse callsigns / RST / sign-off (that is MESSAGE-PARSING's job,
 * fed by the text we emit here). It deliberately operates on timing, not audio;
 * audio -> timing is a later step.
 */

export interface KeyElement {
  /** Key-down duration in ms (the element: dot or dash). */
  on: number;
  /** Key-up duration in ms following this element (the gap). */
  off: number;
}

export interface DecodeOptions {
  /** Explicit dot unit `d` in ms. */
  unit?: number;
  /** Words-per-minute; `d = 1200 / wpm`. Used when `unit` is absent. */
  wpm?: number;
}

export interface DecodeResult {
  /** Uppercase letter text, words separated by single spaces. */
  text: string;
  /** The dot-dash symbol for each decoded character (in order). */
  symbols: string[];
  /** Symbols that matched no table entry (never fabricated). */
  unknown: string[];
}

const DEFAULT_UNIT = 100; // ms fallback when timing is absent

/**
 * Estimate the dot unit `d` from the shortest key-down duration. A dot is the
 * shortest element; a dash is ~3d. Good enough for practice traffic, which
 * always contains dot characters. (A dash-only message would mis-estimate; the
 * caller can pass an explicit `unit`/`wpm` to avoid that.)
 */
export function estimateUnit(ons: number[]): number {
  const valid = ons.filter((v) => v > 0).sort((a, b) => a - b);
  return valid.length ? valid[0] : DEFAULT_UNIT;
}

function resolveUnit(opts?: DecodeOptions): number | null {
  if (opts?.unit != null) return opts.unit;
  if (opts?.wpm != null) return 1200 / opts.wpm;
  return null;
}

/** Classify a key-down duration as a dot or dash (threshold 2d, ±0.5d tolerant). */
export function classifyElement(on: number, d: number): "." | "-" {
  return on < 2 * d ? "." : "-";
}

/**
 * Decode a complete keying sequence into text.
 *
 * Farnsworth safety: character/word gaps are stretched under Farnsworth, so we
 * must not hard-code the 3d letter gap. We first collect every "boundary" gap
 * (>= 2d) and take its smallest cluster as the letter-gap reference; a gap is a
 * word boundary only if it is clearly larger (>= 1.8x that reference, and at
 * least 5d). This keeps Farnsworth-stretched letter gaps from being mistaken
 * for word breaks.
 */
export function decodeKeying(elements: KeyElement[], opts?: DecodeOptions): DecodeResult {
  const d = resolveUnit(opts) ?? estimateUnit(elements.map((e) => e.on));
  const unknown: string[] = [];
  const symbols: string[] = [];
  const words: string[][] = [[]];
  let current = "";

  const boundaryGaps = elements.filter((e) => e.off >= 2 * d).map((e) => e.off);
  const letterGapRef = boundaryGaps.length ? Math.min(...boundaryGaps) : 3 * d;
  const wordThreshold = Math.max(5 * d, letterGapRef * 1.8);

  const flushChar = () => {
    if (current.length === 0) return;
    const ch = FROM_MORSE.get(current);
    if (ch === undefined) {
      unknown.push(current);
      words[words.length - 1].push("?");
    } else {
      words[words.length - 1].push(ch);
    }
    symbols.push(current);
    current = "";
  };

  for (const e of elements) {
    current += classifyElement(e.on, d);
    if (e.off < 2 * d) continue; // intra-character element spacing
    flushChar(); // end of this character
    if (e.off >= wordThreshold) words.push([]); // word boundary -> new word
  }
  flushChar();

  const text = words.map((w) => w.join("")).join(" ").trim();
  return { text, symbols, unknown };
}

/**
 * Streaming-friendly wrapper: collect key elements, then decode on finish.
 * Keeps the same robust algorithm; incremental real-time decoding (deciding a
 * character before the whole sequence is known) is a later enhancement.
 */
export class MorseDecoder {
  private readonly els: KeyElement[] = [];

  push(el: KeyElement): void {
    this.els.push(el);
  }

  finish(opts?: DecodeOptions): DecodeResult {
    return decodeKeying(this.els, opts);
  }
}
