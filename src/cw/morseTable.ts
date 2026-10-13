/**
 * Standard International Morse code table (practice subset per CW-PARSING.md).
 *
 * `MORSE` maps a character / prosign token to its dot-dash symbol. `FROM_MORSE`
 * is the reverse lookup used by the decoder. Prosigns `AR` and `SK` are sent as
 * a single symbol with no internal letter spacing, so they live here as tokens
 * rather than being split into letters.
 */
export const MORSE: Record<string, string> = {
  // Letters
  A: ".-",
  B: "-...",
  C: "-.-.",
  D: "-..",
  E: ".",
  F: "..-.",
  G: "--.",
  H: "....",
  I: "..",
  J: ".---",
  K: "-.-",
  L: ".-..",
  M: "--",
  N: "-.",
  O: "---",
  P: ".--.",
  Q: "--.-",
  R: ".-.",
  S: "...",
  T: "-",
  U: "..-",
  V: "...-",
  W: ".--",
  X: "-..-",
  Y: "-.--",
  Z: "--..",
  // Digits
  "0": "-----",
  "1": ".----",
  "2": "..---",
  "3": "...--",
  "4": "....-",
  "5": ".....",
  "6": "-....",
  "7": "--...",
  "8": "---..",
  "9": "----.",
  // Punctuation / prosigns
  "/": "-..-.",
  "?": "..--..",
  "=": "-...-", // BT (break / buffer)
  AR: ".-.-.", // end of message
  SK: "...-.-", // end (silent key)
};

/** Tokens that must be encoded/decoded as a single prosign symbol. */
export const PROSIGN_TOKENS = new Set(["AR", "SK"]);

/** Reverse lookup: dot-dash symbol -> character / prosign token. */
export const FROM_MORSE = new Map<string, string>();
for (const [ch, sym] of Object.entries(MORSE)) {
  FROM_MORSE.set(sym, ch);
}
