import {
  MorseDecoder,
  classifyElement,
  decodeKeying,
  estimateUnit,
  type KeyElement,
} from "../cw/decoder.js";
import { IambicKeyer, type IambicMode, type Paddle } from "../cw/keyer.js";

/**
 * Straight-key input. The user holds a physical key; key-down durations become
 * dot/dash elements and the existing step-2 decoder turns them into text.
 *
 * The dot unit is estimated from the shortest key-down, so the user does not
 * have to key at exactly the configured WPM.
 */

/** Silence after the last element that flushes the current character sequence. */
const DEFAULT_IDLE_MS = 1500;

export class StraightKeyer {
  private downAt: number | null = null;
  private lastUpAt: number | null = null;
  private els: KeyElement[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Character-boundary timer: decodes the over so far for the live echo. */
  private charTimer: ReturnType<typeof setTimeout> | null = null;
  /** Text already handed to `onChar` (so only growth is reported). */
  private emitted = "";
  /** Index in `els` where the character still being keyed starts. */
  private pendingStart = 0;

  /**
   * Live echo of the decoded over, updated as each character boundary passes.
   * The text is the whole over so far, not a delta.
   */
  onChar?: (text: string) => void;

  constructor(
    private readonly onDecode: (text: string) => void,
    private readonly idleMs: number = DEFAULT_IDLE_MS,
    /** Tone on/off, for the sidetone. Fires only on an actual change. */
    private readonly onKeying?: (on: boolean) => void,
    /** Dot unit in ms — how long a character gap is, for the live echo. */
    private readonly unit: number = 60,
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
    this.cancelCharTimer();
    // Close the gap on the previous element now that we know its length.
    if (this.lastUpAt !== null && this.els.length > 0) {
      this.els[this.els.length - 1].off = now - this.lastUpAt;
    }
    this.downAt = now;
    this.onKeying?.(true);
  }

  keyUp(now: number = Date.now()): void {
    if (this.downAt === null) return;
    const on = now - this.downAt;
    this.downAt = null;
    this.lastUpAt = now;
    this.els.push({ on, off: 0 });
    this.onKeying?.(false);
    this.timer = setTimeout(() => this.finish(), this.idleMs);
    // A character ends after 3d of silence. Decode what is there so the echo
    // in the send bar fills in as the operator keys, not only at the end.
    this.charTimer = setTimeout(() => {
      this.charTimer = null;
      this.flushChars(Date.now());
    }, 3 * this.unit);
  }

  /** Decode what has been keyed so far and hand the text to the callback. */
  finish(): void {
    this.cancelTimer();
    this.cancelCharTimer();
    this.stopTone();
    if (this.els.length === 0) return;
    this.flushChars(Date.now());
    // A fresh decoder per utterance: MorseDecoder accumulates elements and is
    // never cleared, so reusing one would replay earlier characters.
    const decoder = new MorseDecoder();
    for (const el of this.els) decoder.push(el);
    const result = decoder.finish();
    this.els = [];
    this.lastUpAt = null;
    this.emitted = "";
    this.pendingStart = 0;
    if (result.text) this.onDecode(result.text);
  }

  clear(): void {
    this.cancelTimer();
    this.cancelCharTimer();
    this.stopTone();
    this.els = [];
    this.downAt = null;
    this.lastUpAt = null;
    this.emitted = "";
    this.pendingStart = 0;
  }

  /**
   * Decode the over so far and report it if it grew by a prefix of itself.
   *
   * The last element's gap is closed at `at` (the boundary time) rather than
   * left at 0, or the decoder would see the character as still open.
   */
  private flushChars(at: number): void {
    if (this.els.length === 0) return;
    const copy = this.els.map((e) => ({ on: e.on, off: e.off }));
    if (this.lastUpAt !== null) {
      copy[copy.length - 1].off = Math.max(0, at - this.lastUpAt);
    }
    const text = decodeKeying(copy).text;
    if (text.length > this.emitted.length && text.startsWith(this.emitted)) {
      this.emitted = text;
      // Everything keyed so far is now decoded text; the next element starts a
      // fresh character, so the pending dots/dashes reset here.
      this.pendingStart = this.els.length;
      this.onChar?.(text);
    }
  }

  /** Dot/dash echo shown while keying, so the user sees what they sent. */
  currentSymbols(): string {
    if (this.els.length === 0) return "";
    const d = estimateUnit(this.els.map((e) => e.on));
    return this.els.map((e) => classifyElement(e.on, d)).join("");
  }

  /**
   * Dots/dashes of the character still being keyed — the part the decoder has
   * not turned into a letter yet. Shown after the decoded text in the send bar.
   */
  pendingSymbols(): string {
    const pending = this.els.slice(this.pendingStart);
    if (pending.length === 0) return "";
    const d = estimateUnit(this.els.map((e) => e.on));
    return pending.map((e) => classifyElement(e.on, d)).join("");
  }

  private stopTone(): void {
    if (this.downAt === null) return;
    this.downAt = null;
    this.onKeying?.(false);
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private cancelCharTimer(): void {
    if (this.charTimer !== null) {
      clearTimeout(this.charTimer);
      this.charTimer = null;
    }
  }
}

export interface IambicInputOptions {
  wpm: number;
  mode: IambicMode;
  /** Called with each finished character, and with " " before a new word. */
  onText: (text: string) => void;
  /** Echo of the dot-dash symbols of the character being sent. */
  onSymbols?: (symbols: string) => void;
  /** Tone on/off, for the sidetone. Fires only when the element phase changes. */
  onKeying?: (on: boolean) => void;
  /** Called when the keyer has nothing left to send (no element, no queue). */
  onIdle?: () => void;
  /** Injectable clock (tests) — defaults to `Date.now`. */
  now?: () => number;
  /**
   * Injectable tick driver (tests). Receives the tick callback and returns a
   * function that stops it. Defaults to a 20 ms interval.
   */
  startTicking?: (cb: () => void) => () => void;
}

const TICK_MS = 20;

/**
 * Iambic paddle input: drives the core `IambicKeyer` from a clock and reports
 * finished characters. Squeeze, element/word gaps and mode A/B all live in the
 * core keyer; this class only owns the timing loop and the text plumbing.
 */
export class IambicKeyerInput {
  private readonly keyer: IambicKeyer;
  private readonly now: () => number;
  private readonly startTicking: (cb: () => void) => () => void;
  private readonly onText: (text: string) => void;
  private readonly onSymbols?: (symbols: string) => void;
  private readonly onKeying?: (on: boolean) => void;
  private readonly onIdle?: () => void;
  private stopTicking: (() => void) | null = null;
  private keyingOn = false;

  constructor(opts: IambicInputOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.startTicking =
      opts.startTicking ??
      ((cb) => {
        const id = setInterval(cb, TICK_MS);
        return () => clearInterval(id);
      });
    this.onText = opts.onText;
    this.onSymbols = opts.onSymbols;
    this.onKeying = opts.onKeying;
    this.onIdle = opts.onIdle;
    this.keyer = new IambicKeyer({
      wpm: opts.wpm,
      mode: opts.mode,
      onCharacter: (ev) => {
        // A word is separated by silence, not by a key: the keyer reports when a
        // character starts a new word, and the text gets its space here.
        if (ev.newWord) this.onText(" ");
        this.onText(ev.text);
        this.onSymbols?.("");
      },
    });
  }

  press(paddle: Paddle): void {
    this.keyer.press(paddle, this.now());
    this.keyer.advance(this.now());
    this.ensureTicking();
    this.onSymbols?.(this.keyer.snapshot().pendingSymbol);
    this.syncKeying();
  }

  release(paddle: Paddle): void {
    this.keyer.release(paddle, this.now());
    this.keyer.advance(this.now());
    this.onSymbols?.(this.keyer.snapshot().pendingSymbol);
    this.syncKeying();
  }

  /** Advance the keyer manually; also called by the driver. */
  tick(): void {
    this.keyer.advance(this.now());
    const snap = this.keyer.snapshot();
    this.onSymbols?.(snap.pendingSymbol);
    this.syncKeying();
    if (snap.busy) return;
    // Everything keyed (including anything that was queued) has gone out.
    this.stop();
    this.onIdle?.();
  }

  finish(): void {
    this.keyer.finish(this.now());
    this.onSymbols?.("");
    this.syncKeying();
    this.stop();
  }

  clear(): void {
    this.stop();
    this.keyer.reset();
    this.onSymbols?.("");
    this.syncKeying();
  }

  /** True while an element, its gap, or a queued tap is still being sent. */
  isBusy(): boolean {
    return this.keyer.snapshot().busy;
  }

  setSpeed(wpm: number): void {
    this.keyer.setSpeed({ wpm });
  }

  setMode(mode: IambicMode): void {
    this.keyer.setMode(mode);
  }

  currentSymbols(): string {
    return this.keyer.snapshot().pendingSymbol;
  }

  text(): string {
    return this.keyer.text();
  }

  private ensureTicking(): void {
    if (this.stopTicking) return;
    this.stopTicking = this.startTicking(() => this.tick());
  }

  private stop(): void {
    if (this.stopTicking) {
      this.stopTicking();
      this.stopTicking = null;
    }
  }

  /**
   * Mirror the element phase (not `busy`) so the sidetone sounds during a dot or
   * dash and stays silent through the gaps the keyer inserts by itself.
   */
  private syncKeying(): void {
    const keying = this.keyer.snapshot().keying;
    if (keying === this.keyingOn) return;
    this.keyingOn = keying;
    this.onKeying?.(keying);
  }
}
