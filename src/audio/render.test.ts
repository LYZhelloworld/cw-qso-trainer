import { describe, it, expect } from "vitest";
import { renderCwAudio, type Segment } from "./render.js";
import { encodeWav, decodeWav } from "./wav.js";
import { difficultyToEnvironment } from "./environment.js";
import { CwAudioEngine } from "./engine.js";
import { QsoMachine } from "../qso/stateMachine.js";
import { VirtualHam } from "../ham/virtualHam.js";
import { dxccDatabase } from "../data/dxcc.js";

const SR = 8000;

function collectOnSamples(samples: Float32Array, segments: Segment[], sampleRate: number): number[] {
  const out: number[] = [];
  for (const s of segments) {
    if (!s.on) continue;
    const start = Math.round(s.startSec * sampleRate);
    const count = Math.round(s.durationSec * sampleRate);
    for (let i = 0; i < count; i++) out.push(samples[start + i]);
  }
  return out;
}

function collectOffSamples(samples: Float32Array, segments: Segment[], sampleRate: number): number[] {
  // Use the longest off segment to avoid edge/ramp contamination.
  let best: Segment | null = null;
  for (const s of segments) {
    if (s.on) continue;
    if (!best || s.durationSec > best.durationSec) best = s;
  }
  if (!best) return [];
  const start = Math.round(best.startSec * sampleRate);
  const count = Math.round(best.durationSec * sampleRate);
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(samples[start + i]);
  return out;
}

function rms(xs: number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x * x;
  return Math.sqrt(s / xs.length);
}

function median(xs: number[]): number {
  const a = [...xs].sort((p, q) => p - q);
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

describe("renderCwAudio — basics", () => {
  it("is deterministic for a fixed noiseSeed", () => {
    const opts = { text: "CQ CQ DE BG7XXX", sampleRate: SR, noiseSeed: 42, qrn: { enabled: true, level: 0.05 } };
    const a = renderCwAudio(opts);
    const b = renderCwAudio(opts);
    expect(a.samples).toEqual(b.samples);
  });

  it("produces audible tone on elements and silence on gaps when no environment", () => {
    const r = renderCwAudio({ text: "CQ CQ", sampleRate: SR, toneHz: 700, wpm: 20 });
    const on = collectOnSamples(r.samples, r.segments, SR);
    const off = collectOffSamples(r.samples, r.segments, SR);
    expect(rms(on)).toBeGreaterThan(0.1);
    expect(rms(off)).toBeLessThan(1e-4);
  });

  it("matches the expected duration of a single dot (E) at 20 WPM", () => {
    const r = renderCwAudio({ text: "E", sampleRate: SR, wpm: 20 });
    // d = 1200 / 20 = 60 ms, single dot, no trailing gap.
    expect(r.durationSec).toBeCloseTo(0.06, 3);
  });
});

describe("renderCwAudio — receiver filter gain（滤波器裙边）", () => {
  const text = "E E E";

  it("gain 线性缩放信号本身", () => {
    const full = renderCwAudio({ text, sampleRate: SR, toneHz: 700, wpm: 20 });
    const weak = renderCwAudio({ text, sampleRate: SR, toneHz: 700, wpm: 20, gain: 0.1 });
    const ratio =
      rms(collectOnSamples(weak.samples, weak.segments, SR)) /
      rms(collectOnSamples(full.samples, full.segments, SR));
    expect(ratio).toBeCloseTo(0.1, 2);
  });

  it("gain 为 0 时一点信号都不剩", () => {
    const r = renderCwAudio({ text, sampleRate: SR, toneHz: 700, wpm: 20, gain: 0 });
    expect(rms(collectOnSamples(r.samples, r.segments, SR))).toBeLessThan(1e-6);
  });

  it("不压底噪与干扰：QRM / QRN 的电平与 gain 无关", () => {
    const base = {
      text,
      sampleRate: SR,
      wpm: 20,
      noiseSeed: 7,
      qrm: { enabled: true, interferers: 3, level: 0.2 },
      qrn: { enabled: true, level: 0.1 },
    };
    const full = renderCwAudio({ ...base, gain: 1 });
    const weak = renderCwAudio({ ...base, gain: 0.05 });
    // 间隙里只有环境声，两边的底噪必须一模一样。
    expect(rms(collectOffSamples(weak.samples, weak.segments, SR))).toBeCloseTo(
      rms(collectOffSamples(full.samples, full.segments, SR)),
      6,
    );
  });

  it("信号压到底噪以下时，听到的几乎只剩噪声", () => {
    const r = renderCwAudio({
      text,
      sampleRate: SR,
      wpm: 20,
      gain: 0.02,
      qrn: { enabled: true, level: 0.2 },
      noiseSeed: 3,
    });
    const on = rms(collectOnSamples(r.samples, r.segments, SR));
    const off = rms(collectOffSamples(r.samples, r.segments, SR));
    expect(on / off).toBeLessThan(1.2); // 叠上去的那点信号几乎听不出来
  });
});

describe("renderCwAudio — electromagnetic environment", () => {
  it("QSB reduces the median tone magnitude", () => {
    const base = { text: "CQ CQ CQ DE BG7XXX", sampleRate: SR, wpm: 18, toneHz: 700 };
    const off = collectOnSamples(renderCwAudio(base).samples, renderCwAudio(base).segments, SR);
    const on = collectOnSamples(
      renderCwAudio({ ...base, qsb: { enabled: true, periodSec: 2, depth: 0.6 } }).samples,
      renderCwAudio({ ...base, qsb: { enabled: true, periodSec: 2, depth: 0.6 } }).segments,
      SR,
    );
    const mOff = median(off.map(Math.abs));
    const mOn = median(on.map(Math.abs));
    expect(mOff).toBeGreaterThan(0.5);
    expect(mOn).toBeLessThan(0.85 * mOff);
  });

  it("QRM adds energy during off gaps", () => {
    const noQrm = renderCwAudio({ text: "CQ CQ", sampleRate: SR, qrm: { enabled: false } });
    const withQrm = renderCwAudio({
      text: "CQ CQ",
      sampleRate: SR,
      qrm: { enabled: true, interferers: 1, level: 0.06 },
    });
    expect(rms(collectOffSamples(noQrm.samples, noQrm.segments, SR))).toBeLessThan(1e-4);
    expect(rms(collectOffSamples(withQrm.samples, withQrm.segments, SR))).toBeGreaterThan(0.01);
  });

  it("QRN adds energy during off gaps", () => {
    const noQrn = renderCwAudio({ text: "CQ CQ", sampleRate: SR, qrn: { enabled: false } });
    const withQrn = renderCwAudio({
      text: "CQ CQ",
      sampleRate: SR,
      qrn: { enabled: true, level: 0.06 },
      noiseSeed: 7,
    });
    expect(rms(collectOffSamples(noQrn.samples, noQrn.segments, SR))).toBeLessThan(1e-4);
    expect(rms(collectOffSamples(withQrn.samples, withQrn.segments, SR))).toBeGreaterThan(0.01);
  });
});

describe("WAV codec", () => {
  it("encodes a valid RIFF/WAVE 16-bit mono header", () => {
    const r = renderCwAudio({ text: "CQ DE BG7XXX", sampleRate: SR });
    const wav = encodeWav(r.samples, r.sampleRate);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const str = (at: number) => {
      let s = "";
      for (let i = 0; i < 4; i++) s += String.fromCharCode(view.getUint8(at + i));
      return s;
    };
    expect(str(0)).toBe("RIFF");
    expect(str(8)).toBe("WAVE");
    expect(str(12)).toBe("fmt ");
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(SR); // sample rate
    expect(view.getUint16(34, true)).toBe(16); // bits
    expect(str(36)).toBe("data");
    expect(view.getUint32(40, true)).toBe(r.samples.length * 2);
  });

  it("round-trips samples within int16 quantization", () => {
    const r = renderCwAudio({ text: "CQ DE BG7XXX", sampleRate: SR });
    const wav = encodeWav(r.samples, r.sampleRate);
    const { samples, sampleRate } = decodeWav(wav);
    expect(sampleRate).toBe(SR);
    expect(samples.length).toBe(r.samples.length);
    let maxDiff = 0;
    for (let i = 0; i < samples.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs(samples[i] - r.samples[i]));
    }
    expect(maxDiff).toBeLessThan(1 / 32767 + 1e-9);
  });
});

describe("difficultyToEnvironment", () => {
  it("maps the difficulty tiers per AUDIO-ENVIRONMENT.md", () => {
    expect(difficultyToEnvironment("novice").qsb.enabled).toBe(false);
    const inter = difficultyToEnvironment("intermediate");
    expect(inter.qsb.enabled).toBe(true);
    expect(inter.qsb.periodSec).toBe(10); // slow fade
    expect(inter.qsb.depth).toBeCloseTo(0.3);
    const hard = difficultyToEnvironment("hardcore");
    expect(hard.qsb.periodSec).toBe(2); // fast fade
    expect(hard.qsb.depth).toBeCloseTo(0.6);
    expect(hard.qrm.interferers).toBe(2);
    expect(hard.qrn.level).toBeCloseTo(0.06);
  });

  it("merges a custom override without dropping unset fields", () => {
    const e = difficultyToEnvironment("novice", { qsb: { enabled: true, depth: 0.5 } as any });
    expect(e.qsb.enabled).toBe(true);
    expect(e.qsb.depth).toBeCloseTo(0.5);
    expect(e.qsb.periodSec).toBe(10); // default retained
  });
});

describe("CwAudioEngine + integration (HAM voice)", () => {
  it("renders the virtual HAM's replies to audible PCM", () => {
    const ham = new VirtualHam({ call: "JA1ABC", difficulty: "novice" });
    const m = new QsoMachine({ myCall: "BG7XXX", ham, db: dxccDatabase });
    const engine = new CwAudioEngine();
    const replies: string[] = [];
    m.userSend("CQ CQ CQ DE BG7XXX BG7XXX PSE K");
    replies.push(m.hamAnswerCq());
    replies.push(...m.userSend("JA1ABC DE BG7XXX R UR RST 599 599 BK"));
    replies.push(...m.userSend("R TU 73 SK"));
    expect(replies.length).toBeGreaterThan(0);
    for (const text of replies) {
      if (!text) continue;
      const r = engine.render(text, { sampleRate: SR });
      expect(r.samples.length).toBeGreaterThan(0);
      expect(r.durationSec).toBeGreaterThan(0);
    }
  });

  it("renderToWav yields a playable buffer", () => {
    const engine = new CwAudioEngine();
    const wav = engine.renderToWav("CQ DE BG7XXX", { sampleRate: SR });
    const { samples } = decodeWav(wav);
    expect(samples.length).toBeGreaterThan(0);
  });
});
