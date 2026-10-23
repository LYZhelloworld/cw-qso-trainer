import { difficultyToEnvironment, type Difficulty, type Environment } from "./environment.js";
import type { AudioBufferLike, AudioBufferSourceLike } from "./player.js";
import { qsbFactorAt } from "./render.js";
import { receiveStation, type Sideband } from "../ham/tuning.js";
import type { Tx } from "../ham/tx.js";

/**
 * Realtime band synthesizer: every station is a transmitter, the band is a bus.
 *
 * This is the model described in `doc/AUDIO-ENVIRONMENT.md`. A message is not
 * rendered to PCM and played back; it is **keyed** onto a carrier that is
 * already running, element by element, on the audio clock. That buys three
 * things the sample player cannot:
 *
 *  - **the band is live**: stations keep transmitting whether or not the
 *    operator is listening, so turning the dial onto one joins the message
 *    already in progress instead of starting a recording;
 *  - **tuning is continuous**: the dial moves the beat note and the passband
 *    gain of every station at once, with short smoothing ramps, so the note
 *    slides instead of stepping;
 *  - **one truth**: the keying comes from the same `Tx` the waterfall and the
 *    meter read, so sound and picture cannot disagree.
 *
 * Signal path per station:
 *
 * ```
 * oscillator → keyGain (dots/dashes) → levelGain (strength × filter × fading) → master
 * ```
 *
 * Two separate gains on purpose: the keying is a millisecond-accurate
 * schedule, while the level moves whenever the operator turns the dial, and
 * neither may cancel the other's events. Noise (QRN) and the QRM ghost carriers
 * go straight to `master`, so the filter attenuates **only the signal** and a
 * station on the skirt sinks into the noise floor.
 */

/** AWeb Audio bits we touch, kept structural so tests can inject a fake. */
export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, startTime: number): void;
  linearRampToValueAtTime(value: number, endTime: number): void;
  setTargetAtTime(value: number, startTime: number, timeConstant: number): void;
  cancelScheduledValues(startTime: number): void;
}

export interface GainLike {
  readonly gain: AudioParamLike;
  connect(destination: unknown): void;
  disconnect?(): void;
}

export interface OscillatorLike {
  readonly frequency: AudioParamLike;
  type: string;
  connect(destination: unknown): void;
  start(when?: number): void;
  stop(when?: number): void;
  onended: (() => void) | null;
}

export interface BandContextLike {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly destination: unknown;
  resume?(): void;
  createGain(): GainLike;
  createOscillator(): OscillatorLike;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioBufferSourceLike;
}

/** A station on the band, as far as the synthesizer is concerned. */
export interface SynthStation {
  call: string;
  freqHz: number;
  /** Signal strength in [0, 1] — what the S-meter will report. */
  strength: number;
  difficulty: Difficulty;
}

/** Where the receiver is listening: dial, sideband, filter, pitch. */
export interface SynthReceiver {
  dialHz: number;
  sideband: Sideband;
  passbandHz: number;
  /** Beat note when the dial sits exactly on a carrier, in Hz. */
  toneHz: number;
}

export interface BandSynthOptions {
  /** Where the context comes from; defaults to the shared browser one. */
  contextFactory?: () => BandContextLike | null;
  /** Wall clock in ms (injectable for tests). */
  now?: () => number;
  /** Noise / interference profile; defaults to a clean band. */
  environment?: Environment;
  /** Bus gain in [0, 1]. */
  volume?: number;
}

/** Keying edges are 5 ms like the rendered path, so the two sound the same. */
const KEY_RAMP_SEC = 0.005;
/** Dial moves and level changes glide instead of stepping. */
const GLIDE_SEC = 0.03;
/** Offsets of the QRM ghost carriers, the same ones the renderer uses. */
const QRM_OFFSETS = [250, -600, 900, -1200, 1800, -2000];

interface Voice {
  station: SynthStation;
  osc: OscillatorLike;
  keyGain: GainLike;
  levelGain: GainLike;
  /** Last note this station produced, kept so a filtered-out station does not
   * jump in pitch when it comes back into the passband. */
  lastToneHz: number;
}

function defaultNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function audioContextCtor(): (new () => BandContextLike) | undefined {
  const g = globalThis as Record<string, unknown>;
  return (g.AudioContext ?? g.webkitAudioContext) as
    | (new () => BandContextLike)
    | undefined;
}

const SILENT: Environment = difficultyToEnvironment("novice");

export class BandSynth {
  private ctx: BandContextLike | null = null;
  private triedContext = false;

  private readonly master: GainLike | null;
  private readonly noiseGain: GainLike | null;
  private readonly noiseSource: AudioBufferSourceLike | null;
  private readonly qrmGain: GainLike | null;
  private readonly qrmVoices: Array<{ osc: OscillatorLike; level: GainLike }> = [];

  private readonly voices = new Map<string, Voice>();
  private receiver: SynthReceiver | null = null;
  private environment: Environment;
  private volume: number;
  private transmitting = false;
  private disposed = false;

  private readonly now: () => number;

  constructor(private readonly opts: BandSynthOptions = {}) {
    this.now = opts.now ?? defaultNow;
    this.environment = opts.environment ?? SILENT;
    this.volume = opts.volume ?? 1;

    const ctx = this.context();
    if (!ctx) {
      this.master = null;
      this.noiseGain = null;
      this.noiseSource = null;
      this.qrmGain = null;
      return;
    }

    // Bus: everything the receiver hears passes through the master gain, so
    // half-duplex muting and the volume control have one place to act.
    this.master = ctx.createGain();
    this.master.gain.value = this.transmitting ? 0 : this.volume;
    this.master.connect(ctx.destination);

    // Noise floor: one looping buffer, so it is continuous across overs. It is
    // connected to the bus, never through a station's filter.
    this.noiseGain = ctx.createGain();
    this.noiseGain.gain.value = this.environment.qrn.enabled ? this.environment.qrn.level : 0;
    this.noiseGain.connect(this.master);
    this.noiseSource = ctx.createBufferSource();
    const noiseSeconds = 1;
    const noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * noiseSeconds), ctx.sampleRate);
    const samples = new Float32Array(Math.floor(ctx.sampleRate * noiseSeconds));
    let seed = 0x9e3779b9;
    for (let i = 0; i < samples.length; i += 1) {
      // Cheap deterministic LCG: the loop is short, the ear cannot tell.
      seed = (seed * 1664525 + 1013904223) >>> 0;
      samples[i] = (seed / 0x100000000) * 2 - 1;
    }
    noise.copyToChannel(samples, 0);
    this.noiseSource.buffer = noise;
    this.noiseSource.connect(this.noiseGain);
    this.noiseSource.start(0);

    // QRM: ghost carriers that belong to the band, not to a station.
    this.qrmGain = ctx.createGain();
    this.qrmGain.gain.value = this.environment.qrm.enabled ? 1 : 0;
    this.qrmGain.connect(this.master);
    const wanted = this.environment.qrm.enabled ? this.environment.qrm.interferers : 0;
    for (let i = 0; i < wanted && i < QRM_OFFSETS.length; i += 1) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      const level = ctx.createGain();
      level.gain.value = this.environment.qrm.level;
      osc.connect(level);
      level.connect(this.qrmGain);
      osc.start(0);
      this.qrmVoices.push({ osc, level });
    }
  }

  /** True where there is an audio device to key on (Node / jsdom: false). */
  get available(): boolean {
    return this.ctx !== null && !this.disposed;
  }

  /** The audio clock, in seconds — the axis every keying runs on. */
  get currentTimeSec(): number {
    return this.ctx?.currentTime ?? 0;
  }

  /** Put a station on the band (idempotent). Its carrier starts at level 0. */
  ensureStation(station: SynthStation): void {
    if (this.disposed || station.freqHz <= 0) return;
    const existing = this.voices.get(station.call);
    if (existing) {
      existing.station = station;
      this.applyReceiver(existing);
      return;
    }
    const ctx = this.ctx;
    if (!ctx || !this.master) return;

    const osc = ctx.createOscillator();
    osc.type = "sine";
    const keyGain = ctx.createGain();
    keyGain.gain.value = 0;
    const levelGain = ctx.createGain();
    levelGain.gain.value = 0;
    osc.connect(keyGain);
    keyGain.connect(levelGain);
    levelGain.connect(this.master);
    osc.start(ctx.currentTime);

    const voice: Voice = { station, osc, keyGain, levelGain, lastToneHz: this.toneHz };
    this.voices.set(station.call, voice);
    this.applyReceiver(voice);
  }

  /** Take a station off the band (it stopped existing, not just transmitting). */
  removeStation(call: string): void {
    const voice = this.voices.get(call);
    if (!voice) return;
    try {
      voice.osc.stop(this.ctx?.currentTime ?? 0);
      voice.levelGain.disconnect?.();
    } catch {
      /* already stopped */
    }
    this.voices.delete(call);
  }

  /** Where the receiver is listening. Every voice re-tunes and re-levels. */
  setReceiver(rx: SynthReceiver): void {
    this.receiver = rx;
    for (const voice of this.voices.values()) this.applyReceiver(voice);
    this.applyQrmFrequencies();
  }

  /**
   * Key a transmission onto a station's carrier.
   *
   * `atMs` is the wall-clock time the message starts (the same instant recorded
   * in its `Tx`), so the sound and the waterfall are keyed off one clock. Each
   * element becomes a pair of ramps on the key gain: up at the start, down
   * before the gap — the real dots and dashes, nothing left behind between them.
   */
  key(tx: Tx, call: string, atMs: number): void {
    const voice = this.voices.get(call);
    if (!voice || this.disposed) return;
    const ctx = this.ctx;
    if (!ctx) return;

    const param = voice.keyGain.gain;
    const start = this.audioTimeOf(atMs);
    param.cancelScheduledValues(start);
    param.setValueAtTime(0, start);

    let t = start;
    for (const element of tx.elements) {
      const onSec = element.on / 1000;
      const atOn = Math.max(t + KEY_RAMP_SEC, t + onSec - KEY_RAMP_SEC);
      // Level 1 here and the audible level on the voice's own gain: keying says
      // *when*, `levelGain` says *how loud*, and the two never overwrite.
      param.linearRampToValueAtTime(1, t + KEY_RAMP_SEC);
      param.setValueAtTime(1, atOn);
      param.linearRampToValueAtTime(0, t + onSec);
      t += onSec + element.off / 1000;
    }
    // Belt and braces: a late `key` from a stale driver must not leave a
    // carrier keyed forever.
    param.setValueAtTime(0, t);
  }

  /** Cut a station's keying now (the operator broke in, or the over was cut). */
  silenceStation(call: string): void {
    const voice = this.voices.get(call);
    if (!voice || !this.ctx) return;
    const now = this.ctx.currentTime;
    voice.keyGain.gain.cancelScheduledValues(now);
    voice.keyGain.gain.setTargetAtTime(0, now, KEY_RAMP_SEC / 3);
  }

  /** Half-duplex: 0 while the operator transmits, back to the volume after. */
  setTransmitting(on: boolean): void {
    this.transmitting = on;
    this.applyMaster();
  }

  /** Bus gain in [0, 1]. */
  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    this.applyMaster();
  }

  /** Swap the noise / interference profile (difficulty changed). */
  setEnvironment(environment: Environment): void {
    this.environment = environment;
    if (!this.ctx) return;
    if (this.noiseGain) {
      this.noiseGain.gain.setTargetAtTime(
        environment.qrn.enabled ? environment.qrn.level : 0,
        this.ctx.currentTime,
        GLIDE_SEC,
      );
    }
    if (this.qrmGain) {
      this.qrmGain.gain.setTargetAtTime(
        environment.qrm.enabled ? 1 : 0,
        this.ctx.currentTime,
        GLIDE_SEC,
      );
    }
    for (const { level } of this.qrmVoices) {
      // The ghost carriers keep their own amplitude node, so a change of
      // difficulty is a glide rather than a rebuild.
      level.gain.setTargetAtTime(environment.qrm.level, this.ctx.currentTime, GLIDE_SEC);
    }
    this.applyQrmFrequencies();
  }

  /** Silence everything at once (power off, or the operator starts sending). */
  silenceAll(): void {
    for (const call of this.voices.keys()) this.silenceStation(call);
  }

  /** Tear the graph down (the session is going away). */
  dispose(): void {
    this.disposed = true;
    for (const call of [...this.voices.keys()]) this.removeStation(call);
    try {
      this.noiseSource?.stop(this.ctx?.currentTime ?? 0);
    } catch {
      /* already stopped */
    }
    for (const { osc } of this.qrmVoices) {
      try {
        osc.stop(this.ctx?.currentTime ?? 0);
      } catch {
        /* already stopped */
      }
    }
    this.qrmVoices.length = 0;
  }

  // --- internals -----------------------------------------------------------

  private context(): BandContextLike | null {
    if (this.ctx) return this.ctx;
    if (this.triedContext) return null;
    this.triedContext = true;
    const factory = this.opts.contextFactory;
    if (factory) {
      this.ctx = factory();
      return this.ctx;
    }
    const Ctor = audioContextCtor();
    this.ctx = Ctor ? new Ctor() : null;
    return this.ctx;
  }

  /** The pitch the receiver is tuned to — the note when the dial is dead on. */
  private get toneHz(): number {
    return this.receiver?.toneHz ?? 700;
  }

  /**
   * Wall-clock ms → audio-clock seconds.
   *
   * `now()` is mapped onto `currentTime` and everything else is relative to it,
   * so keying scheduled from a `Tx`'s start time lands on the audio clock the
   * browser actually plays on.
   */
  private audioTimeOf(wallMs: number): number {
    return Math.max(0, this.currentTimeSec + (wallMs - this.now()) / 1000);
  }

  private applyMaster(): void {
    if (!this.master || !this.ctx) return;
    const target = this.transmitting ? 0 : this.volume;
    this.master.gain.setTargetAtTime(target, this.ctx.currentTime, GLIDE_SEC);
  }

  /**
   * Re-tune one voice to the dial and set its level from the filter and fading.
   *
   * The note comes from `receiveStation`, the very same function the S-meter
   * uses, so "what is heard" and "what is read" cannot drift apart. A station
   * past the skirt keeps its last note but drops to zero gain: it is still
   * transmitting, we are simply not listening to it.
   */
  private applyReceiver(voice: Voice): void {
    const ctx = this.ctx;
    const rx = this.receiver;
    if (!ctx || !rx) return;

    const reception = receiveStation({
      toneHz: rx.toneHz,
      stationHz: voice.station.freqHz,
      dialHz: rx.dialHz,
      sideband: rx.sideband,
      passbandHz: rx.passbandHz,
    });
    const tone = reception?.toneHz ?? voice.lastToneHz;
    voice.lastToneHz = tone;
    voice.osc.frequency.setTargetAtTime(tone, ctx.currentTime, GLIDE_SEC);

    const level = reception === null ? 0 : voice.station.strength * reception.gain;
    const env = difficultyToEnvironment(voice.station.difficulty);
    // Fading is per station and slow: sample it at "now" so a long over drifts
    // through its crests and troughs instead of being frozen at one level.
    const qsb = qsbFactorAt(env.qsb, ctx.currentTime);
    voice.levelGain.gain.setTargetAtTime(level * qsb, ctx.currentTime, GLIDE_SEC);
  }

  /** QRM ghost carriers sit a fixed offset either side of the received pitch. */
  private applyQrmFrequencies(): void {
    if (!this.ctx) return;
    for (let i = 0; i < this.qrmVoices.length; i += 1) {
      const offset = QRM_OFFSETS[i] ?? 0;
      this.qrmVoices[i].osc.frequency.setTargetAtTime(
        this.toneHz + offset,
        this.ctx.currentTime,
        GLIDE_SEC,
      );
    }
  }
}
