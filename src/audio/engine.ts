import { renderCwAudio, type CwRenderOptions, type RenderResult } from "./render.js";
import { encodeWav } from "./wav.js";
import { difficultyToEnvironment, type Difficulty } from "./environment.js";

/**
 * Playback backend abstraction. The browser path uses Web Audio's AudioContext;
 * under Node (no AudioContext) it reports `available: false` so callers can fall
 * back to rendering a WAV file instead of throwing during unit tests.
 */
export interface PlaybackBackend {
  readonly available: boolean;
  play(samples: Float32Array, sampleRate: number): Promise<void>;
}

export class WebAudioBackend implements PlaybackBackend {
  readonly available: boolean;

  constructor() {
    const g = globalThis as Record<string, unknown>;
    this.available =
      typeof g.AudioContext !== "undefined" || typeof g.webkitAudioContext !== "undefined";
  }

  async play(samples: Float32Array, sampleRate: number): Promise<void> {
    const g = globalThis as Record<string, unknown>;
    const Ctx = (g.AudioContext ?? g.webkitAudioContext) as new () => AudioContextLike;
    if (!Ctx) throw new Error("WebAudioBackend: AudioContext unavailable (browser required)");
    const ctx = new Ctx();
    try {
      const buffer = ctx.createBuffer(1, samples.length, sampleRate);
      buffer.copyToChannel(samples, 0);
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      await new Promise<void>((resolve) => {
        src.onended = () => resolve();
        src.start();
      });
    } finally {
      void ctx.close();
    }
  }
}

/** Minimal structural type for the Web Audio bits we use (avoids DOM lib dep). */
interface AudioContextLike {
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioBufferSourceLike;
  destination: unknown;
  close(): void;
}
interface AudioBufferLike {
  copyToChannel(source: Float32Array, channel: number): void;
}
interface AudioBufferSourceLike {
  buffer: unknown;
  connect(node: unknown): void;
  start(): void;
  onended: (() => void) | null;
}

export interface EngineRenderOptions extends Omit<CwRenderOptions, "text"> {}

/**
 * High-level CW audio engine. Pure presentation layer: it renders a message to
 * samples / WAV and (in the browser) plays it. It does not know about the QSO
 * state machine — but you can feed it the HAM's reply text to "hear" the HAM.
 */
export class CwAudioEngine {
  constructor(private readonly backend: PlaybackBackend = new WebAudioBackend()) {}

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

  /** Play a message (browser only). Throws if no AudioContext is available. */
  async play(text: string, opts?: EngineRenderOptions): Promise<void> {
    const r = renderCwAudio({ text, ...opts });
    await this.backend.play(r.samples, r.sampleRate);
  }

  get playbackAvailable(): boolean {
    return this.backend.available;
  }
}
