import {
  MorseDecoder,
  classifyElement,
  estimateUnit,
  type KeyElement,
} from "../cw/decoder.js";

/**
 * Straight-key input. The user holds a physical key; key-down durations become
 * dot/dash elements and the existing step-2 decoder turns them into text.
 *
 * The dot unit is estimated from the shortest key-down, so the user does not
 * have to key at exactly the configured WPM.
 *
 * RESERVED (not implemented): iambic squeeze keying (mode A/B). The settings
 * expose the A/B choice, but only straight-key timing is produced here.
 */

/** Silence after the last element that flushes the current character sequence. */
const DEFAULT_IDLE_MS = 1500;

export class StraightKeyer {
  private downAt: number | null = null;
  private lastUpAt: number | null = null;
  private els: KeyElement[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onDecode: (text: string) => void,
    private readonly idleMs: number = DEFAULT_IDLE_MS,
  ) {}

  get isDown(): boolean {
    return this.downAt !== null;
  }

  get hasContent(): boolean {
    return this.els.length > 0;
  }

  keyDown(now: number = Date.now()): void {
    if (this.downAt !== null) return; // ignore keyboard auto-repeat
    this.cancelTimer();
    // Close the gap on the previous element now that we know its length.
    if (this.lastUpAt !== null && this.els.length > 0) {
      this.els[this.els.length - 1].off = now - this.lastUpAt;
    }
    this.downAt = now;
  }

  keyUp(now: number = Date.now()): void {
    if (this.downAt === null) return;
    const on = now - this.downAt;
    this.downAt = null;
    this.lastUpAt = now;
    this.els.push({ on, off: 0 });
    this.timer = setTimeout(() => this.finish(), this.idleMs);
  }

  /** Decode what has been keyed so far and hand the text to the callback. */
  finish(): void {
    this.cancelTimer();
    if (this.els.length === 0) return;
    // A fresh decoder per utterance: MorseDecoder accumulates elements and is
    // never cleared, so reusing one would replay earlier characters.
    const decoder = new MorseDecoder();
    for (const el of this.els) decoder.push(el);
    const result = decoder.finish();
    this.els = [];
    this.lastUpAt = null;
    if (result.text) this.onDecode(result.text);
  }

  clear(): void {
    this.cancelTimer();
    this.els = [];
    this.downAt = null;
    this.lastUpAt = null;
  }

  /** Dot/dash echo shown while keying, so the user sees what they sent. */
  currentSymbols(): string {
    if (this.els.length === 0) return "";
    const d = estimateUnit(this.els.map((e) => e.on));
    return this.els.map((e) => classifyElement(e.on, d)).join("");
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
