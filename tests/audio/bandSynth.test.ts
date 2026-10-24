import { describe, expect, it } from "vitest";
import { BandSynth } from "../../src/audio/bandSynth.js";
import { BUSSES, FakeBandContext, round, sampleParam, stationGains } from "../support/fakeContext.js";
import { difficultyToEnvironment } from "../../src/audio/environment.js";
import { makeTx } from "../../src/ham/tx.js";
import type { Sideband } from "../../src/ham/tuning.js";

const DIAL = 14_025_000;
const STATION = { call: "JA1ABC", freqHz: DIAL, strength: 0.5, difficulty: "novice" as const };
function makeSynth(sideband: Sideband = "USB") {
  const ctx = new FakeBandContext();
  let wall = 0;
  const synth = new BandSynth({
    contextFactory: () => ctx,
    now: () => wall,
  });
  synth.setReceiver({ dialHz: DIAL, sideband, passbandHz: 500, toneHz: 700 });
  // One station on the band, so the bus is built: the graph comes up on first
  // use, not in the constructor.
  synth.ensureStation(STATION);
  return {
    ctx,
    synth,
    /** Wind the wall clock and the audio clock forward together. */
    advance(ms: number) {
      wall += ms;
      ctx.currentTime += ms / 1000;
    },
    /** The first station's level gain. */
    lastLevel() {
      return stationGains(ctx, 0).level;
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
    const keyGain = stationGains(ctx, 0).key;
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
    const keyGain = stationGains(ctx, 0).key;

    synth.key(makeTx("A B", ELEMENTS, 0), STATION.call, 0);
    ctx.currentTime = 0.05;
    synth.silenceStation(STATION.call);

    const last = keyGain.events.at(-1)!;
    expect(last.kind).toBe("target");
    expect(last.value).toBe(0);
  });

  it("半双工：发报时总线静音，发完回到原来的音量", () => {
    const { ctx, synth } = makeSynth();
    const master = ctx.gains[BUSSES.master].gain;

    synth.setVolume(0.8);
    synth.setTransmitting(true);
    expect(master.value).toBe(0);

    synth.setTransmitting(false);
    expect(master.value).toBeCloseTo(0.8, 6);
  });

  it("难度换档：底噪与 QRM 的总电平跟着换", () => {
    const { ctx, synth } = makeSynth();
    const noise = ctx.gains[BUSSES.noise].gain;
    const qrm = ctx.gains[BUSSES.qrm].gain;

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
      synth.keyMine(makeTx("A B", ELEMENTS, 0), 0);
      synth.setTransmitting(true);
      synth.dispose();
    }).not.toThrow();
  });
});

describe("BandSynth — 从报文中间接上", () => {
  it("已经发出去的部分不再排：只从此刻往后敲", () => {
    const { ctx, synth, lastLevel } = makeSynth();
    synth.ensureStation(STATION);
    const keyGain = stationGains(ctx, 0).key;
    expect(lastLevel()).toBeDefined();

    // 报文从墙上 0 ms 开始，现在到了 500 ms；前 150 ms 已经在空中了
    // （第一个元素 100 ms 的点 + 50 ms 的间隔），剩下 50 ms 间隔 + 第二个元素
    synth.keyFrom(makeTx("A B", ELEMENTS, 0), STATION.call, 500, 150);

    const ramps = keyGain.events.filter((e) => e.kind === "ramp");
    expect(ramps.map((e) => [e.value, round(e.time)])).toEqual([
      [1, 0.555],
      [0, 0.65],
    ]);
  });

  it("正好落在点里：从剩余的半个点接着响，不是从头再来", () => {
    const { ctx, synth } = makeSynth();
    synth.ensureStation(STATION);
    const keyGain = stationGains(ctx, 0).key;

    // 50 ms 已发出去，第一个元素还剩 50 ms 的点
    synth.keyFrom(makeTx("A B", ELEMENTS, 0), STATION.call, 500, 50);

    const ramps = keyGain.events.filter((e) => e.kind === "ramp");
    // 落在点上就直接起音（5 ms 淡入），这个点还剩 50 ms，然后才是间隔
    expect(ramps.map((e) => [e.value, round(e.time)])).toEqual([
      [1, 0.505],
      [0, 0.55],
      [1, 0.655],
      [0, 0.75],
    ]);
  });
});

describe("BandSynth — 键控包络的形状", () => {
  /** "A B" at these elements: tone 0–100 ms, gap 100–200, tone 200–300. */
  const envelopeOf = () => {
    const h = makeSynth();
    h.synth.ensureStation(STATION);
    h.synth.key(makeTx("A B", ELEMENTS, 0), STATION.call, 0);
    return (ms: number) => sampleParam(stationGains(h.ctx, 0).key, ms / 1000);
  };

  it("间隔里是真静音：不会从上一个点一路淡入过来", () => {
    const at = envelopeOf();

    expect(at(50)).toBeCloseTo(1, 6); // 点里
    expect(at(100)).toBeCloseTo(0, 6); // 点的末尾
    expect(at(140)).toBeCloseTo(0, 6); // 间隔的前段
    expect(at(195)).toBeCloseTo(0, 6); // 间隔的末尾——起振前必须还是 0
    expect(at(250)).toBeCloseTo(1, 6); // 第二个点里
    expect(at(300)).toBeCloseTo(0, 6); // 报文结束
  });

  it("起振就是 5 ms 的斜坡，方波直上直下只留防爆音的边", () => {
    const at = envelopeOf();

    expect(at(0)).toBeCloseTo(0, 6);
    expect(at(2.5)).toBeCloseTo(0.5, 2); // 半个斜坡
    expect(at(5)).toBeCloseTo(1, 6);
  });
});

describe("BandSynth — 自己的发射机", () => {
  it("走监听支路：半双工静音时听不到别人，但自己的键控照样响", () => {
    const { ctx, synth } = makeSynth();
    synth.setVolume(0.8);
    synth.setTransmitting(true);

    // 接收总线静音
    expect(ctx.gains[BUSSES.master].gain.value).toBe(0);
    // 监听支路不受影响
    expect(ctx.gains[BUSSES.monitor].gain.value).toBeCloseTo(0.8, 6);

    synth.keyMine(makeTx("A B", ELEMENTS, 0), 0);

    const own = ctx.oscs.at(-1)!;
    expect(own.frequency.value).toBe(700); // 自己的载波就在拨轮上
    // 自己那台的电平固定为 1：不做滤波、不起伏
    expect(ctx.gains.at(-1)!.gain.value).toBe(1);
    // 键控增益上排的还是同一套点划
    const keyGain = ctx.gains.at(-2)!.gain;
    expect(keyGain.events.filter((e) => e.kind === "ramp").length).toBe(4);
  });

  it("拨轮一动，自己的音调跟着动，但永远等于设定值", () => {
    const { ctx, synth } = makeSynth();
    synth.keyMine(makeTx("A B", ELEMENTS, 0), 0);
    const own = ctx.oscs.at(-1)!;

    synth.setReceiver({ dialHz: DIAL + 2_000, sideband: "LSB", passbandHz: 250, toneHz: 620 });
    expect(own.frequency.value).toBe(620);
  });
});

