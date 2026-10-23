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
 * - **word gap = a longer pause**, not a key: a character that starts 7d or more
 *   after the previous element *ended* begins a new word — 3d for the character
 *   gap that flushed the last letter, plus 4d more. Words are separated by
 *   silence, the way they are on the air.
 *
 * Fast paddling is buffered: a press that arrives while an element is still being
 * sent is queued and played after it, so a quick tap is never dropped just
 * because the keyer was not ready for it.
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
  onCharacter?: (ev: {
    text: string;
    symbol: string;
    unknown: boolean;
    /** True when this character starts a new word (a long pause preceded it). */
    newWord: boolean;
  }) => void;
}

export interface IambicKeyerSnapshot {
  /** Text sent so far, including the character still being built. */
  text: string;
  /** Dot-dash symbols of the character currently being sent. */
  pendingSymbol: string;
  /** True while an element or its gap is still in flight. */
  busy: boolean;
  /**
   * True only while a tone is actually being sent (element phase), false during
   * the mandatory gaps. This is what a sidetone monitor must follow.
   */
  keying: boolean;
}

type Phase = "idle" | "element" | "gap";

const DEFAULT_WPM = 20;

/**
 * How many taps may wait behind the element being sent. A burst of fast paddling
 * can be a dozen elements deep, so leave plenty of room; the cap only stops a
 * stuck key from growing an unbounded backlog.
 */
const MAX_QUEUED_ELEMENTS = 16;

export class IambicKeyer {
  private d: number;
  private mode: IambicMode;
  private readonly onElement?: (el: KeyElement) => void;
  private readonly onCharacter?: (ev: {
    text: string;
    symbol: string;
    unknown: boolean;
    newWord: boolean;
  }) => void;

  private dotDown = false;
  private dashDown = false;
  /** Element remembered while both paddles were squeezed (iambic memory). */
  private latched: Paddle | null = null;
  private lastPaddle: Paddle | null = null;
  /**
   * Taps that arrived while an element was already being sent, in the order they
   * came. Played after that element, so a fast sequence is "recorded" rather than
   * half of it dropped.
   */
  private readonly queue: Paddle[] = [];

  private phase: Phase = "idle";
  /** Time the current phase ends. */
  private phaseEnd = 0;
  private elementKind: Paddle | null = null;
  private elementStart = 0;
  private elementEnd = 0;
  /** End of the most recently finished element, for measuring the word pause. */
  private lastElementEndAt = 0;
  /** When the previous character was flushed (3d after its last element). */
  private lastCharAt = 0;
  /** Set when the character being built starts a new word. */
  private newWord = false;
  /** Duration of the element awaiting its trailing gap. */
  private pendingOn = 0;
  private gapIsCharGap = false;

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

  /** Press a paddle at `now`. Squeeze is detected at the element boundaries. */
  press(paddle: Paddle, now: number): void {
    this.advance(now);
    if (paddle === "dot") this.dotDown = true;
    else this.dashDown = true;

    if (this.phase === "idle") {
      this.startElement(paddle, now);
    } else if (this.queue.length < MAX_QUEUED_ELEMENTS) {
      // Every tap is an element, even when it lands on top of the other paddle
      // (fast alternation does exactly that). Queue it in order and let the
      // keyer play it; squeeze — both held across a boundary — is the held-state
      // alternation in `decideNext`, not a property of this single press.
      this.queue.push(paddle);
    }
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
      this.lastElementEndAt = this.elementEnd;
      this.symbol += this.elementKind === "dot" ? "." : "-";
      this.commit(0);
    } else if (this.phase === "gap") {
      this.commit(Math.max(1, t - this.elementEnd));
    }
    this.phase = "idle";
    this.latched = null;
    this.queue.length = 0;
    this.flushChar(t);
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
    this.lastElementEndAt = 0;
    this.lastCharAt = 0;
    this.newWord = false;
    this.pendingOn = 0;
    this.gapIsCharGap = false;
    this.queue.length = 0;
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
      keying: this.phase === "element",
    };
  }

  // --- internals -----------------------------------------------------------

  private startElement(kind: Paddle, t: number): void {
    // A character that starts a long pause after the previous element begins a
    // new word. 7d is the standard word gap; the character was flushed 3d after
    // the last element, so the check is 4d after the flush.
    if (this.symbol === "" && this.lastCharAt > 0 && t - this.lastCharAt >= 4 * this.d) {
      this.endWord();
      this.newWord = true;
      // Keep the element stream honest for the receiver-side decoder: the last
      // element's trailing gap really was this long.
      const last = this.els[this.els.length - 1];
      if (last) last.off = Math.max(last.off, t - this.lastElementEndAt);
    }

    this.phase = "element";
    this.elementKind = kind;
    this.elementStart = t;
    this.phaseEnd = t + (kind === "dot" ? this.d : 3 * this.d);
    this.lastPaddle = kind;
    this.gapIsCharGap = false;
  }

  /** Called when the current phase (element or gap) ends at time `t`. */
  private step(t: number): void {
    if (this.phase === "element") {
      this.pendingOn = t - this.elementStart;
      this.elementEnd = t;
      this.lastElementEndAt = t;
      this.symbol += this.elementKind === "dot" ? "." : "-";
      this.phase = "gap";
      this.gapIsCharGap = false;
      this.phaseEnd = t + this.d; // mandatory 1d element gap
      return;
    }

    const next = this.decideNext();
    if (next !== null) {
      this.commit(t - this.elementEnd);
      this.startElement(next, t);
      return;
    }

    // Nothing held and nothing queued: stretch the gap from 1d to 3d, which is
    // where the character ends.
    if (!this.gapIsCharGap) {
      this.gapIsCharGap = true;
      this.phaseEnd = t + 2 * this.d;
      return;
    }
    this.commit(t - this.elementEnd);
    this.flushChar(t);
    this.phase = "idle";
  }

  /**
   * Pick the next element when a gap ends.
   *
   * Queued taps first (a fast sequence is played in the order it was keyed),
   * then — both paddles held across the boundary — squeeze alternation, then a
   * held paddle repeating, then Mode B's release memory.
   */
  private decideNext(): Paddle | null {
    const both = this.dotDown && this.dashDown;
    const queued = this.queue.shift();
    if (queued) {
      // Both held across this boundary: the classic keyer also remembers the
      // element that would come after this one. Mode B sends it if both
      // paddles are released while this element plays; Mode A drops it.
      if (both) this.latched = queued === "dot" ? "dash" : "dot";
      return queued;
    }

    if (both) {
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

  private flushChar(at = this.clock): void {
    if (!this.symbol) return;
    const ch = FROM_MORSE.get(this.symbol);
    const text = ch ?? "?";
    this.currentWord += text;
    const symbol = this.symbol;
    this.symbol = "";
    this.lastCharAt = at;
    const newWord = this.newWord;
    this.newWord = false;
    this.onCharacter?.({ text, symbol, unknown: ch === undefined, newWord });
  }

  private endWord(): void {
    if (!this.currentWord) return;
    this.words.push(this.currentWord);
    this.currentWord = "";
  }
}
