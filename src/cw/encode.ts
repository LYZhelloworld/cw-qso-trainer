import { MORSE, PROSIGN_TOKENS } from "./morseTable.js";
import type { KeyElement } from "./decoder.js";

/**
 * Encode text into a keying sequence (dot/dash timing). This is the companion to
 * `decodeKeying` — used for round-trip testing and as the foundation for the
 * future keyer / CW-audio output (CW-PARSING send side). It does NOT emit audio.
 *
 * Speed: `d = 1200 / wpm` ms. Standard ratios dot:dash:letter-gap:word-gap =
 * 1:3:3:7. With `farnsworthWpm` set below `wpm`, the character/word gaps are
 * stretched (Farnsworth: "characters fast, spacing slow") while dot/dash and
 * intra-character spacing stay at the faster `wpm`.
 */
export interface TimingOptions {
  wpm?: number;
  farnsworthWpm?: number;
  /** Explicit dot unit in ms (overrides wpm). */
  unit?: number;
}

export function textToTiming(text: string, opts?: TimingOptions): KeyElement[] {
  const d = opts?.unit ?? (opts?.wpm ? 1200 / opts.wpm : 100);
  const fsUnit = opts?.farnsworthWpm ? 1200 / opts.farnsworthWpm : null;
  const letterGap = fsUnit ? 3 * fsUnit : 3 * d;
  const wordGap = fsUnit ? 7 * fsUnit : 7 * d;

  const elements: KeyElement[] = [];
  const words = text.toUpperCase().trim().split(/\s+/).filter(Boolean);

  words.forEach((word, wi) => {
    const isProsgin = PROSIGN_TOKENS.has(word);
    const symbols: string[] = isProsgin
      ? [MORSE[word]]
      : [...word].map((ch) => {
          const s = MORSE[ch];
          if (!s) throw new Error(`Cannot encode unknown character: ${ch}`);
          return s;
        });

    const isLastWord = wi === words.length - 1;

    symbols.forEach((sym, si) => {
      const isLastSym = si === symbols.length - 1;
      [...sym].forEach((elem, ei) => {
        const isLastElem = ei === sym.length - 1;
        const on = elem === "." ? d : 3 * d;
        let off: number;
        if (!isLastElem) {
          off = d; // intra-character element spacing
        } else if (isLastSym) {
          off = isLastWord ? 0 : wordGap; // end of word
        } else {
          off = letterGap; // end of character, more characters follow
        }
        elements.push({ on, off });
      });
    });
  });

  return elements;
}
