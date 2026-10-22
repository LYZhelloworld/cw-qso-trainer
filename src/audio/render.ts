import { textToTiming } from "../cw/encode.js";

/**
 * Pure CW audio renderer (no browser dependency).
 *
 * Turns a text message into mono PCM samples: a 700 Hz sine tone gated by the
 * Morse keying envelope, plus an optional electromagnetic environment
 * (QSB fading, QRM interfering carriers, QRN atmospheric noise). The result is
 * a `Float32Array` of samples in [-1, 1] — fully deterministic for a given
 * `noiseSeed`, so it is unit-testable under Node and is also exactly what the
 * browser playback path feeds into an `AudioBuffer`.
 *
 * This is a pure *presentation* layer (ROADMAP step 4): it never touches the
 * QSO state machine or message parsing.
 */

export interface QsbOptions {
  /** Whether signal fading is applied. */
  enabled: boolean;
  /** Fading period in seconds (slow 5–15s, fast 1–3s per AUDIO-ENVIRONMENT.md). */
  periodSec: number;
  /** Fading depth in [0, 1]; 0 = no change, 1 = signal dips to silence at troughs. */
  depth: number;
}

export interface QrmOptions {
  /** Whether man-made CW interference is added. */
  enabled: boolean;
  /** Number of interfering carrier tones (nearby stations). */
  interferers: number;
  /** Per-interferer amplitude in [0, 1]. */
  level: number;
}

export interface QrnOptions {
  /** Whether atmospheric noise (static) is added. */
  enabled: boolean;
  /** White-noise amplitude in [0, 1]. */
  level: number;
}

export interface CwRenderOptions {
  /** Message to render. */
  text: string;
  wpm?: number;
  farnsworthWpm?: number;
  /** Explicit dot unit in ms (overrides wpm). */
  unit?: number;
  sampleRate?: number;
  toneHz?: number;
  /**
   * Amplitude for the signal itself, in [0, 1] — the receiver's filter response
   * at this station's offset (see `ham/tuning`'s `passbandGain`). It scales the
   * tone only: the band's noise and interference keep their own level, which is
   * what makes a signal on the filter skirt drop *into* the noise rather than
   * take the noise down with it.
   */
  gain?: number;
  qsb?: Partial<QsbOptions>;
  qrm?: Partial<QrmOptions>;
  qrn?: Partial<QrnOptions>;
  /** Seed for the noise generator (deterministic output). */
  noiseSeed?: number;
}

export interface Segment {
  startSec: number;
  durationSec: number;
  on: boolean;
}

export interface RenderResult {
  samples: Float32Array;
  sampleRate: number;
  durationSec: number;
  /** Keying timeline (on = tone element, off = silence / gap). */
  segments: Segment[];
}

const DEFAULT_QSB: QsbOptions = { enabled: false, periodSec: 10, depth: 0 };
const DEFAULT_QRM: QrmOptions = { enabled: false, interferers: 0, level: 0 };
const DEFAULT_QRN: QrnOptions = { enabled: false, level: 0 };

/** Deterministic PRNG (mulberry32) so rendered noise is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Coerce an arbitrary gain into [0, 1]; NaN and negatives fall back to 1 / 0. */
function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function mergeDefined<T extends object>(defaults: T, override?: Partial<T>): T {  const out: T = { ...defaults };
  if (override) {
    for (const k of Object.keys(override) as (keyof T)[]) {
      const v = override[k];
      if (v !== undefined) out[k] = v as T[keyof T];
    }
  }
  return out;
}

// Fixed offsets (Hz) for interfering carriers relative to the main tone.
const QRM_OFFSETS = [250, -600, 900, -1200, 1800, -2000];

/**
 * Render a CW message to mono PCM samples.
 */
export function renderCwAudio(opts: CwRenderOptions): RenderResult {
  const sampleRate = opts.sampleRate ?? 44100;
  const toneHz = opts.toneHz ?? 700;
  const signalGain = clamp01(opts.gain ?? 1);
  const qsb = mergeDefined(DEFAULT_QSB, opts.qsb);
  const qrm = mergeDefined(DEFAULT_QRM, opts.qrm);
  const qrn = mergeDefined(DEFAULT_QRN, opts.qrn);
  const rng = mulberry32(opts.noiseSeed ?? 0x1234abcd);

  const elements = textToTiming(opts.text, {
    wpm: opts.wpm,
    farnsworthWpm: opts.farnsworthWpm,
    unit: opts.unit,
  });

  let totalMs = 0;
  for (const e of elements) totalMs += e.on + e.off;
  const durationSec = totalMs / 1000;
  const n = Math.max(0, Math.ceil(durationSec * sampleRate));
  const samples = new Float32Array(n);

  const twoPiTone = 2 * Math.PI * toneHz;
  const qrmFreqs: number[] = [];
  if (qrm.enabled && qrm.interferers > 0) {
    for (let i = 0; i < qrm.interferers && i < QRM_OFFSETS.length; i++) {
      qrmFreqs.push(toneHz + QRM_OFFSETS[i]);
    }
  }
  const twoPiQrm = qrmFreqs.map((f) => 2 * Math.PI * f);

  const rampSec = 0.005; // 5 ms attack/release to avoid keying clicks
  const segments: Segment[] = [];
  let idx = 0;

  const writeEnv = (t: number, gate: number): number => {
    // The filter only attenuates the signal — QRM/QRN below are added at full
    // level, so a station on the skirt sinks into the noise floor.
    let v = signalGain * gate * Math.sin(twoPiTone * t);
    if (qsb.enabled && qsb.depth > 0) {
      const f = 1 - qsb.depth * (0.5 - 0.5 * Math.cos((2 * Math.PI * t) / qsb.periodSec));
      v *= f;
    }
    for (let j = 0; j < twoPiQrm.length; j++) {
      v += qrm.level * Math.sin(twoPiQrm[j] * t);
    }
    if (qrn.enabled) {
      v += (rng() * 2 - 1) * qrn.level;
    }
    return v;
  };

  for (const e of elements) {
    const onStartIdx = idx;
    const onSamples = Math.round((e.on / 1000) * sampleRate);
    const offSamples = Math.round((e.off / 1000) * sampleRate);

    for (let k = 0; k < onSamples; k++) {
      const t = idx / sampleRate;
      const distStart = t - onStartIdx / sampleRate;
      const distEnd = (onStartIdx + onSamples) / sampleRate - t;
      let gate = 1;
      if (distStart < rampSec) gate = distStart / rampSec;
      else if (distEnd < rampSec) gate = distEnd / rampSec;
      if (gate < 0) gate = 0;
      samples[idx++] = writeEnv(t, gate);
    }
    if (onSamples > 0) {
      segments.push({
        startSec: onStartIdx / sampleRate,
        durationSec: onSamples / sampleRate,
        on: true,
      });
    }

    for (let k = 0; k < offSamples; k++) {
      const t = idx / sampleRate;
      // Off segments carry only the environment (QRM/QRN), never the tone.
      let v = 0;
      for (let j = 0; j < twoPiQrm.length; j++) v += qrm.level * Math.sin(twoPiQrm[j] * t);
      if (qrn.enabled) v += (rng() * 2 - 1) * qrn.level;
      samples[idx++] = v;
    }
    if (offSamples > 0) {
      segments.push({
        startSec: onStartIdx / sampleRate + onSamples / sampleRate,
        durationSec: offSamples / sampleRate,
        on: false,
      });
    }
  }

  for (let i = 0; i < n; i++) {
    if (samples[i] > 1) samples[i] = 1;
    else if (samples[i] < -1) samples[i] = -1;
  }

  return { samples, sampleRate, durationSec, segments };
}
