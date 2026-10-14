import { FROM_MORSE } from "./morseTable.js";
import type { KeyElement } from "./decoder.js";

/**
 * Iambic keyer (CW-PARSING send side): paddle events -> keying timing.
 *
 * This turns paddle presses/releases into a standard keying sequence, exactly
 * like the electronic keyer inside a real rig. It is the counterpart of
 * `decodeKeying`: the elements it produces can be fed straight into the
 * decoder, which is how the round-trip tests verify it.
 *
 * Timing is driven by an explicit clock — every method takes `now` in ms and
 * nothing happens until you call it. There is no `setTimeout` / `requestAnimationFrame`
 * inside, so behaviour is fully deterministic and testable; the caller (UI or
 * Tauri shell) drives it from its own loop.
 *
 * Standard ratios, with `d = 1200 / wpm` ms:
 * - dot = 1d, dash = 3d
 * - element gap = 1d (mandatory after every element)
 * - character gap = 3d total (auto-inserted when no paddle is held)
 * - word gap = 7d (inserted on an explicit word break)
 */
export type Paddle = "dot" | "dash";

/** Mode A drops the latched element on release; Mode B sends it. */
export type IambicMode = "A" | "B";

export interface KeyerOptions {
  /** Words per minute; `d = 1200 / wpm`. Ignored when `unit` is given. */
  wpm?: number;
  /** Explicit dot unit in ms (overrides `wpm`). */
  unit?: number;
  /** Iambic mode. Defaults to `"B"` (the more common one). */
  mode?: IambicMode;
  /** Called once an element is complete and its trailing gap length is known. */
  onElement?: (el: KeyElement) => void;
  /** Called when a character ends (after the 3d gap elapses, or on finish). */
  onCharacter?: (ev: { text: string; symbol: string; unknown: boolean }) => void;
}

export interface IambicKeyerSnapshot {
  /** Text sent so far, including the character still being built. */
  text: string;
  /** Dot-dash symbols of the character currently being sent. */
  pendingSymbol: string;
  /** True while an element or its gap is still in flight. */
  busy: boolean;
}

type Phase = "idle" | "element" | "gap";

const DEFAULT_WPM = 20;

export class IambicKeyer {
  private d: number;
  private mode: IambicMode;
  private readonly onElement?: (el: KeyElement) => void;
  private readonly onCharacter?: (ev: { text: string; symbol: string; unknown: boolean }) => void;

  private dotDown = false;
  private dashDown = false;
  /** Element remembered while both paddles were squeezed (iambic memory). */
  private latched: Paddle | null = null;
  private lastPaddle: Paddle | null = null;

  private phase: Phase = "idle";
  /** Time the current phase ends. */
  private phaseEnd = 0;
  private elementKind: Paddle | null = null;
  private elementStart = 0;
  private elementEnd = 0;
  /** Duration of the element awaiting its trailing gap. */
  private pendingOn = 0;
  private gapIsCharGap = false;
  private gapIsWordGap = false;
  private wordPending = false;

  private symbol = "";
  private currentWord = "";
  private readonly words: string[] = [];
  private readonly els: KeyElement[] = [];
  private clock = 0;

  constructor(opts: KeyerOptions = {}) {
    this.d = opts.unit ?? 1200 / (opts.wpm ?? DEFAULT_WPM);
    this.mode = opts.mode ?? "B";
    this.onElement = opts.onElement;
    this.onCharacter = opts.onCharacter;
  }

  /** Dot unit in ms. */
  get unit(): number {
    return this.d;
  }

  get iambicMode(): IambicMode {
    return this.mode;
  }

  setMode(mode: IambicMode): void {
    this.mode = mode;
  }

  /** Change speed. Takes effect from the next element; safe to call mid-word. */
  setSpeed(opts: { wpm?: number; unit?: number }): void {
    this.d = opts.unit ?? (opts.wpm ? 1200 / opts.wpm : this.d);
  }

  /** Press a paddle at `now`. Squeeze (both paddles) is detected here. */
  press(paddle: Paddle, now: number): void {
    this.advance(now);
    const other: Paddle = paddle === "dot" ? "dash" : "dot";
    if (other === "dot" ? this.dotDown : this.dashDown) {
      this.latched = other; // squeezing: remember the other paddle
    }
    if (paddle === "dot") this.dotDown = true;
    else this.dashDown = true;

    if (this.phase === "idle") this.startElement(paddle, now);
  }

  /** Release a paddle at `now`. */
  release(paddle: Paddle, now: number): void {
    this.advance(now);
    if (paddle === "dot") this.dotDown = false;
    else this.dashDown = false;
    // Mode A discards the memory as soon as both paddles are up.
    if (!this.dotDown && !this.dashDown && this.mode === "A") this.latched = null;
  }

  releaseAll(now: number): void {
    this.release("dot", now);
    this.release("dash", now);
  }

  /** Insert a 7d word gap at `now` (the "space" action while sending). */
  wordBreak(now: number): void {
    this.advance(now);
    if (this.phase === "idle") {
      // The character already closed with a 3d gap; widen it retroactively.
      this.endWord();
      const last = this.els[this.els.length - 1];
      if (last && last.off < 7 * this.d) last.off = 7 * this.d;
      return;
    }
    // Element or gap still in flight: the gap will stretch to 7d before ending.
    this.wordPending = true;
  }

  /** Advance the keyer to `now`, emitting whatever becomes due. */
  advance(now: number): void {
    if (now < this.clock) return; // clock must not go backwards
    this.clock = now;
    let guard = 0;
    while (this.phase !== "idle" && now >= this.phaseEnd) {
      if (++guard > 100000) break; // defensive: never spin forever
      this.step(this.phaseEnd);
    }
  }

  /** Stop immediately and close out the pending element / character / word. */
  finish(now?: number): void {
    const t = now ?? this.clock;
    this.advance(t);
    if (this.phase === "element") {
      // An electronic keyer always finishes the element it has started, so we
      // emit it at full length instead of truncating it to whatever elapsed.
      this.pendingOn = this.elementKind === "dot" ? this.d : 3 * this.d;
      this.elementEnd = this.elementStart + this.pendingOn;
      this.symbol += this.elementKind === "dot" ? "." : "-";
      this.commit(0);
    } else if (this.phase === "gap") {
      this.commit(Math.max(1, t - this.elementEnd));
    }
    this.phase = "idle";
    this.latched = null;
    this.wordPending = false;
    this.flushChar();
    this.endWord();
  }

  /** Discard everything sent so far. No callbacks are fired. */
  reset(): void {
    this.dotDown = false;
    this.dashDown = false;
    this.latched = null;
    this.lastPaddle = null;
    this.phase = "idle";
    this.phaseEnd = 0;
    this.elementKind = null;
    this.elementStart = 0;
    this.elementEnd = 0;
    this.pendingOn = 0;
    this.gapIsCharGap = false;
    this.gapIsWordGap = false;
    this.wordPending = false;
    this.symbol = "";
    this.currentWord = "";
    this.words.length = 0;
    this.els.length = 0;
    this.clock = 0;
  }

  /** Keying elements produced so far (a copy). */
  elements(): KeyElement[] {
    return this.els.map((e) => ({ on: e.on, off: e.off }));
  }

  /** Text sent so far, words separated by single spaces. */
  text(): string {
    const all = this.currentWord ? [...this.words, this.currentWord] : this.words;
    return all.join(" ");
  }

  snapshot(): IambicKeyerSnapshot {
    return {
      text: this.text(),
      pendingSymbol: this.symbol,
      busy: this.phase !== "idle",
    };
  }

  // --- internals -----------------------------------------------------------

  private startElement(kind: Paddle, t: number): void {
    this.phase = "element";
    this.elementKind = kind;
    this.elementStart = t;
    this.phaseEnd = t + (kind === "dot" ? this.d : 3 * this.d);
    this.lastPaddle = kind;
    this.gapIsCharGap = false;
    this.gapIsWordGap = false;
  }

  /** Called when the current phase (element or gap) ends at time `t`. */
  private step(t: number): void {
    if (this.phase === "element") {
      this.pendingOn = t - this.elementStart;
      this.elementEnd = t;
      this.symbol += this.elementKind === "dot" ? "." : "-";
      this.phase = "gap";
      this.gapIsCharGap = false;
      this.gapIsWordGap = false;
      this.phaseEnd = t + this.d; // mandatory 1d element gap
      return;
    }

    const next = this.decideNext();
    if (next !== null) {
      this.commit(t - this.elementEnd);
      this.startElement(next, t);
      return;
    }

    // Nothing held: stretch the gap — first to 3d (character), then to 7d (word).
    if (!this.gapIsCharGap) {
      this.gapIsCharGap = true;
      this.phaseEnd = t + 2 * this.d;
      return;
    }
    if (this.wordPending && !this.gapIsWordGap) {
      this.gapIsWordGap = true;
      this.phaseEnd = t + 4 * this.d;
      return;
    }

    this.commit(t - this.elementEnd);
    this.flushChar();
    if (this.gapIsWordGap) this.endWord();
    this.wordPending = false;
    this.phase = "idle";
  }

  /**
   * Pick the next element when a gap ends. Squeeze alternates; a single paddle
   * repeats; with both released, Mode B sends the latched element once.
   */
  private decideNext(): Paddle | null {
    if (this.dotDown && this.dashDown) {
      const next: Paddle = this.lastPaddle === "dot" ? "dash" : "dot";
      this.latched = next === "dot" ? "dash" : "dot";
      return next;
    }
    if (this.dotDown) return "dot";
    if (this.dashDown) return "dash";
    if (this.mode === "B" && this.latched) {
      const n = this.latched;
      this.latched = null;
      return n;
    }
    this.latched = null;
    return null;
  }

  /** Emit the pending element with its final trailing gap. */
  private commit(off: number): void {
    const el: KeyElement = { on: this.pendingOn, off: Math.max(0, off) };
    this.els.push(el);
    this.onElement?.(el);
  }

  private flushChar(): void {
    if (!this.symbol) return;
    const ch = FROM_MORSE.get(this.symbol);
    const text = ch ?? "?";
    this.currentWord += text;
    const symbol = this.symbol;
    this.symbol = "";
    this.onCharacter?.({ text, symbol, unknown: ch === undefined });
  }

  private endWord(): void {
    if (!this.currentWord) return;
    this.words.push(this.currentWord);
    this.currentWord = "";
  }
}
