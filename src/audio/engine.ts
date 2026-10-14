import { renderCwAudio, type CwRenderOptions, type RenderResult } from "./render.js";
import { encodeWav } from "./wav.js";
import { difficultyToEnvironment, type Difficulty } from "./environment.js";
import { LookaheadPlayer, type AudioContextLike, type PlaybackHandle } from "./player.js";

/**
 * High-level CW audio engine. Pure presentation layer: it renders a message to
 * samples / WAV and (in the browser) plays it through a single shared
 * `AudioContext`. It does not know about the QSO state machine — but you can
 * feed it the HAM's reply text to "hear" the HAM.
 *
 * Audio backend notes (replacing the old per-play `WebAudioBackend`):
 * - **One shared context**, created lazily. Browsers start it `suspended` until
 *   the first user gesture, so we resume it on the first `pointerdown` /
 *   `keydown` / `touchstart` (and proactively on `play`).
 * - **Lookahead scheduling** (`LookaheadPlayer`) replaces the old single
 *   `BufferSource`, so a HAM that is still calling CQ can be cut off the moment
 *   the operator breaks in.
 * - Under Node / jsdom there is no `AudioContext`, so `play` resolves
 *   immediately and `stop` is a safe no-op — playback never throws or hangs.
 */

/** The contract the UI session depends on (injectable for tests). */
export interface AudioPlayer {
  play(text: string, opts?: EngineRenderOptions): PlaybackHandle;
  stop(): void;
  readonly playbackAvailable: boolean;
}

export type { PlaybackHandle } from "./player.js";

function audioContextCtor(): (new () => AudioContextLike) | undefined {
  const g = globalThis as Record<string, unknown>;
  return (g.AudioContext ?? g.webkitAudioContext) as
    | (new () => AudioContextLike)
    | undefined;
}

let sharedCtx: AudioContextLike | null = null;
let gestureWired = false;

/**
 * Lazily create (and cache) the one AudioContext the engine uses. Returns null
 * where audio is unavailable (Node, jsdom), in which case playback is a no-op.
 */
function getSharedAudioContext(): AudioContextLike | null {
  if (sharedCtx) return sharedCtx;
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  const ctx = new Ctor();
  sharedCtx = ctx;
  wireGestureResume(ctx);
  return ctx;
}

/** Resume a suspended context on the first user gesture (autoplay policy). */
function wireGestureResume(ctx: AudioContextLike): void {
  if (gestureWired) return;
  gestureWired = true;
  const g = globalThis as Record<string, unknown>;
  const add = g.addEventListener as
    | ((type: string, cb: () => void, opts?: { once?: boolean; capture?: boolean }) => void)
    | undefined;
  if (typeof add !== "function") return;
  const resume = (): void => {
    try {
      ctx.resume?.();
    } catch {
      /* ignore */
    }
  };
  for (const ev of ["pointerdown", "keydown", "touchstart"]) {
    add(ev, resume, { once: true, capture: true });
  }
}

export interface EngineRenderOptions extends Omit<CwRenderOptions, "text"> {}

/**
 * CW audio engine. The browser path renders to PCM and plays it through the
 * shared `AudioContext`; under Node it renders but playback is a no-op.
 */
export class CwAudioEngine implements AudioPlayer {
  private readonly player: LookaheadPlayer;

  constructor(opts?: {
    /** Override the context source (tests). Defaults to the shared browser one. */
    contextFactory?: () => AudioContextLike | null;
    /** Override the scheduler timer (tests). */
    timer?: (cb: () => void, ms: number) => () => void;
  }) {
    this.player = new LookaheadPlayer(
      opts?.contextFactory ?? getSharedAudioContext,
      opts?.timer ? { timer: opts.timer } : {},
    );
  }

  /** Render a message to PCM samples (no playback). */
  render(text: string, opts?: EngineRenderOptions): RenderResult {
    return renderCwAudio({ text, ...opts });
  }

  /** Render a message straight to a 16-bit mono WAV file buffer. */
  renderToWav(text: string, opts?: EngineRenderOptions): Uint8Array {
    const r = renderCwAudio({ text, ...opts });
    return encodeWav(r.samples, r.sampleRate);
  }

  /** Render using a difficulty profile (QSB/QRM/QRN) from AUDIO-ENVIRONMENT.md. */
  renderForDifficulty(
    text: string,
    difficulty: Difficulty,
    opts?: EngineRenderOptions,
  ): RenderResult {
    const env = difficultyToEnvironment(difficulty);
    return renderCwAudio({
      text,
      ...opts,
      qsb: env.qsb,
      qrm: env.qrm,
      qrn: env.qrn,
    });
  }

  /** Play a message (browser only). Returns a handle; `done` resolves on end/stop. */
  play(text: string, opts?: EngineRenderOptions): PlaybackHandle {
    try {
      const r = renderCwAudio({ text, ...opts });
      return this.player.play(r.samples, r.sampleRate);
    } catch {
      // Rendering should never fail, but never let audio block the QSO flow.
      return { done: Promise.resolve(), stop() {} };
    }
  }

  /** Interrupt any in-flight playback (e.g. operator breaks in on a HAM's CQ). */
  stop(): void {
    this.player.stop();
  }

  get playbackAvailable(): boolean {
    return audioContextCtor() !== undefined;
  }
}
