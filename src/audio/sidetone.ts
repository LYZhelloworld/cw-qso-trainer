/**
 * Sidetone: the tone a real rig feeds back to the operator's ear while keying.
 *
 * Unlike the HAM's messages (which are rendered to PCM and played as a buffer),
 * a sidetone must track the key instantaneously — press, tone; release, silence.
 * So this module drives a live oscillator instead of rendering samples.
 *
 * Two deliberate properties:
 * - **Clean**: a sidetone is a local monitor, never affected by QSB/QRM/QRN.
 *   The difficulty profile deliberately does not touch it.
 * - **Inert without an AudioContext**: under Node / jsdom the backend reports
 *   `available: false` and every call is a no-op, so keying and tests keep
 *   working where audio does not exist.
 */

/** Click-free fade in/out, in seconds. 5 ms is inaudible but removes key clicks. */
const RAMP_S = 0.005;

export interface SidetoneBackend {
  readonly available: boolean;
  start(freqHz: number, volume: number): void;
  stop(): void;
  setFrequency(freqHz: number): void;
  setVolume(volume: number): void;
  /** Release the audio resources. Safe to call more than once. */
  dispose(): void;
}

/** Minimal structural types for the Web Audio nodes we touch (no DOM lib dep). */
interface OscillatorLike {
  type: string;
  frequency: AudioParamLike;
  connect(node: unknown): void;
  start(): void;
  stop(): void;
}
interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, time: number): void;
  linearRampToValueAtTime(value: number, time: number): void;
  cancelScheduledValues(time: number): void;
}
interface GainLike {
  gain: AudioParamLike;
  connect(node: unknown): void;
}
interface AudioContextLike {
  readonly state?: string;
  readonly currentTime: number;
  readonly destination: unknown;
  resume?(): unknown;
  createOscillator(): OscillatorLike;
  createGain(): GainLike;
  close(): unknown;
}

export class WebAudioSidetone implements SidetoneBackend {
  private ctx: AudioContextLike | null = null;
  private osc: OscillatorLike | null = null;
  private gain: GainLike | null = null;
  private freqHz = 700;
  private disposed = false;

  constructor(private readonly ctxFactory?: () => AudioContextLike | null) {}

  get available(): boolean {
    if (this.disposed) return false;
    if (this.ctx) return true;
    // Without an injected factory we can probe cheaply; creating a context on
    // every availability check would be a real side effect.
    if (!this.ctxFactory) return audioContextCtor() !== undefined;
    return this.ensure() !== null;
  }

  start(freqHz: number, volume: number): void {
    this.freqHz = freqHz;
    const g = this.ensure();
    if (!g) return;
    const now = g.ctx.currentTime;
    // Chrome starts the context suspended until a user gesture; keying is one.
    if (g.ctx.state === "suspended" && g.ctx.resume) void g.ctx.resume();
    g.osc.frequency.setValueAtTime(freqHz, now);
    g.gain.gain.cancelScheduledValues(now);
    g.gain.gain.setValueAtTime(g.gain.gain.value, now);
    g.gain.gain.linearRampToValueAtTime(volume, now + RAMP_S);
  }

  stop(): void {
    const g = this.ctx && this.gain ? { ctx: this.ctx, gain: this.gain } : null;
    if (!g) return;
    const now = g.ctx.currentTime;
    g.gain.gain.cancelScheduledValues(now);
    g.gain.gain.setValueAtTime(g.gain.gain.value, now);
    g.gain.gain.linearRampToValueAtTime(0, now + RAMP_S);
  }

  setFrequency(freqHz: number): void {
    this.freqHz = freqHz;
    if (!this.ctx || !this.osc) return;
    this.osc.frequency.setValueAtTime(freqHz, this.ctx.currentTime);
  }

  setVolume(volume: number): void {
    if (!this.ctx || !this.gain) return;
    this.gain.gain.setValueAtTime(volume, this.ctx.currentTime);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.osc) {
      try {
        this.osc.stop();
      } catch {
        /* an already-stopped oscillator is fine */
      }
      this.osc = null;
    }
    if (this.ctx) {
      try {
        this.ctx.close();
      } catch {
        /* ignore */
      }
      this.ctx = null;
    }
    this.gain = null;
  }

  private createContext(): AudioContextLike | null {
    if (this.ctxFactory) return this.ctxFactory();
    const Ctx = audioContextCtor();
    return Ctx ? new Ctx() : null;
  }

  private ensure(): { ctx: AudioContextLike; osc: OscillatorLike; gain: GainLike } | null {
    if (this.disposed) return null;
    if (!this.ctx) {
      const ctx = this.createContext();
      if (!ctx) return null;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = this.freqHz;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      this.ctx = ctx;
      this.osc = osc;
      this.gain = gain;
    }
    if (!this.ctx || !this.osc || !this.gain) return null;
    return { ctx: this.ctx, osc: this.osc, gain: this.gain };
  }
}

export interface SidetoneOptions {
  backend?: SidetoneBackend;
  /** Master switch from the settings. */
  enabled?: boolean;
  /** 0..1 linear gain. */
  volume?: number;
  freqHz?: number;
}

/**
 * Operator-facing sidetone. Owns the on/off bookkeeping so callers can just say
 * `keyDown()` / `keyUp()`; repeated calls are idempotent (keyboard auto-repeat
 * and repeated tick() advances must not stack tones).
 */
export class Sidetone {
  private readonly backend: SidetoneBackend;
  private enabled: boolean;
  private volume: number;
  private freqHz: number;
  private on = false;
  private disposed = false;

  constructor(opts: SidetoneOptions = {}) {
    this.backend = opts.backend ?? new WebAudioSidetone();
    this.enabled = opts.enabled ?? true;
    this.volume = clamp01(opts.volume ?? 0.4);
    this.freqHz = opts.freqHz ?? 700;
  }

  get available(): boolean {
    return !this.disposed && this.backend.available;
  }

  get isOn(): boolean {
    return this.on;
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) this.forceStop();
  }

  setFrequency(freqHz: number): void {
    this.freqHz = freqHz;
    this.backend.setFrequency(freqHz);
  }

  setVolume(volume: number): void {
    this.volume = clamp01(volume);
    this.backend.setVolume(this.volume);
  }

  /** Key down: start the tone (no-op if disabled, disposed, or already on). */
  keyDown(): void {
    if (this.disposed || !this.enabled || this.on) return;
    this.on = true;
    this.backend.start(this.freqHz, this.volume);
  }

  keyUp(): void {
    if (!this.on) return;
    this.on = false;
    this.backend.stop();
  }

  /** Stop any tone and release audio resources (call when leaving the page). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.forceStop();
    this.backend.dispose();
  }

  private forceStop(): void {
    if (!this.on) return;
    this.on = false;
    this.backend.stop();
  }
}

/** Look up an AudioContext constructor without instantiating it. */
function audioContextCtor(): (new () => AudioContextLike) | undefined {
  const g = globalThis as Record<string, unknown>;
  return (g.AudioContext ?? g.webkitAudioContext) as (new () => AudioContextLike) | undefined;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0.4;
  return Math.min(1, Math.max(0, v));
}
