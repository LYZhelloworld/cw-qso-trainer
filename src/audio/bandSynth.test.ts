import { describe, expect, it } from "vitest";
import {
  BandSynth,
  type AudioParamLike,
  type BandContextLike,
  type GainLike,
  type OscillatorLike,
} from "./bandSynth.js";
import { difficultyToEnvironment } from "./environment.js";
import { makeTx } from "../ham/tx.js";
import type { Sideband } from "../ham/tuning.js";

/**
 * A fake Web Audio graph: enough of the API for `BandSynth`, and it records the
 * automation it is asked for, which is the whole point — the engine's job is to
 * schedule ramps, so the assertions are about *when* and *how loud*.
 */
class FakeParam implements AudioParamLike {
  value = 0;
  events: Array<{ kind: "set" | "ramp" | "target" | "cancel"; value: number; time: number }> = [];
  setValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ kind: "set", value, time });
  }
  linearRampToValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ kind: "ramp", value, time });
  }
  setTargetAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ kind: "target", value, time });
  }
  cancelScheduledValues(time: number): void {
    this.events.push({ kind: "cancel", value: 0, time });
  }
}

class FakeGain implements GainLike {
  readonly gain = new FakeParam();
  connect(): void {}
  disconnect(): void {}
}

class FakeOsc implements OscillatorLike {
  readonly frequency = new FakeParam();
  type = "sine";
  started = false;
  stopped = false;
  onended: (() => void) | null = null;
  connect(): void {}
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
}

function makeContext() {
  const ctx = {
    currentTime: 0,
    sampleRate: 48_000,
    destination: {},
    gains: [] as FakeGain[],
    oscs: [] as FakeOsc[],
    sources: [] as Array<{ start: () => void; stop: () => void }>,
    createGain(): FakeGain {
      const g = new FakeGain();
      ctx.gains.push(g);
      return g;
    },
    createOscillator(): FakeOsc {
      const o = new FakeOsc();
      ctx.oscs.push(o);
      return o;
    },
    createBuffer(_channels: number, length: number) {
      return { length, copyToChannel(): void {} };
    },
    createBufferSource() {
      const s = {
        buffer: null as unknown,
        connect: (): void => {},
        start: (): void => {},
        stop: (): void => {},
        onended: null,
      };
      ctx.sources.push(s);
      return s;
    },
  };
  return ctx;
}

const DIAL = 14_025_000;
const STATION = { call: "JA1ABC", freqHz: DIAL, strength: 0.5, difficulty: "novice" as const };

function makeSynth(sideband: Sideband = "USB") {
  const ctx = makeContext();
  let wall = 0;
  const synth = new BandSynth({
    contextFactory: () => ctx as unknown as BandContextLike,
    now: () => wall,
  });
  synth.setReceiver({ dialHz: DIAL, sideband, passbandHz: 500, toneHz: 700 });
  return {
    ctx,
    synth,
    /** Wind the wall clock and the audio clock forward together. */
    advance(ms: number) {
      wall += ms;
      ctx.currentTime += ms / 1000;
    },
    /** The gain node the station's level runs through (the last one created). */
    lastLevel(): FakeParam {
      return ctx.gains[ctx.gains.length - 1].gain;
    },
  };
}

/** Elements of "A B": two 100 ms elements, each followed by a 100 ms gap. */
const ELEMENTS = [
  { on: 100, off: 100 },
  { on: 100, off: 100 },
];

describe("BandSynth — 一台发射机、一条总线", () => {
  it("台站在带内时按拍频振荡，电平 = 强度 × 通带增益", () => {
    const { ctx, synth } = makeSynth();

    synth.ensureStation(STATION);

    const osc = ctx.oscs[0];
    expect(osc.started).toBe(true);
    // USB 正对频：听到的就是设定的 700 Hz
    expect(osc.frequency.value).toBe(700);
    // 电平走独立的 levelGain，与键控那条增益互不覆盖
    expect(ctx.gains.at(-1)!.gain.value).toBeCloseTo(0.5, 6);
  });

  it("偏调改变音调，滤波器只压信号：带外照样在发，只是电平为 0", () => {
    const { ctx, synth } = makeSynth();
    synth.ensureStation(STATION);

    // 拨轮下移 100 Hz（USB）：音调 = P + (F − D) = 800 Hz
    synth.setReceiver({ dialHz: DIAL - 100, sideband: "USB", passbandHz: 500, toneHz: 700 });
    expect(ctx.oscs[0].frequency.value).toBe(800);

    // 调出裙边：台还在（振荡器没停），但一点声音都传不出来
    synth.setReceiver({ dialHz: DIAL + 5_000, sideband: "USB", passbandHz: 500, toneHz: 700 });
    expect(ctx.oscs[0].stopped).toBe(false);
    expect(ctx.gains.at(-1)!.gain.value).toBe(0);
  });

  it("键控直接排在增益上：每个元素一段上扬、一段落下，起落各 5 ms", () => {
    const { ctx, synth, lastLevel } = makeSynth();
    synth.ensureStation(STATION);
    const keyGain = ctx.gains[3].gain; // master, noise, qrm 之后的第一台
    expect(lastLevel()).toBeDefined();

    synth.key(makeTx("A B", ELEMENTS, 0), STATION.call, 0);

    const ramps = keyGain.events.filter((e) => e.kind === "ramp");
    // 两个元素 → 两次上扬、两次落下；第二段从 0.2 s 起（第一段的 100 ms 间隔之后）
    expect(ramps.map((e) => [e.value, round(e.time)])).toEqual([
      [1, 0.005],
      [0, 0.1],
      [1, 0.205],
      [0, 0.3],
    ]);
  });

  it("打断发报：清掉排程并平滑归零", () => {
    const { ctx, synth } = makeSynth();
    synth.ensureStation(STATION);
    const keyGain = ctx.gains[3].gain;

    synth.key(makeTx("A B", ELEMENTS, 0), STATION.call, 0);
    ctx.currentTime = 0.05;
    synth.silenceStation(STATION.call);

    const last = keyGain.events.at(-1)!;
    expect(last.kind).toBe("target");
    expect(last.value).toBe(0);
  });

  it("半双工：发报时总线静音，发完回到原来的音量", () => {
    const { ctx, synth } = makeSynth();
    const master = ctx.gains[0].gain;

    synth.setVolume(0.8);
    synth.setTransmitting(true);
    expect(master.value).toBe(0);

    synth.setTransmitting(false);
    expect(master.value).toBeCloseTo(0.8, 6);
  });

  it("难度换档：底噪与 QRM 的总电平跟着换", () => {
    const { ctx, synth } = makeSynth();
    const noise = ctx.gains[1].gain;
    const qrm = ctx.gains[2].gain;

    const hard = difficultyToEnvironment("hardcore");
    synth.setEnvironment(hard);
    expect(noise.value).toBeCloseTo(hard.qrn.level, 6);
    expect(qrm.value).toBe(1);
  });

  it("没有 AudioContext 时静默降级，不抛不挂", () => {
    const synth = new BandSynth({ contextFactory: () => null, now: () => 0 });
    expect(synth.available).toBe(false);
    expect(() => {
      synth.ensureStation(STATION);
      synth.key(makeTx("A B", ELEMENTS, 0), STATION.call, 0);
      synth.setTransmitting(true);
      synth.dispose();
    }).not.toThrow();
  });
});

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
