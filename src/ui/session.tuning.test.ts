import { describe, expect, it } from "vitest";
import { QsoSession } from "./session.js";
import { normalizeSettings, type AppSettings } from "./settingsSchema.js";
import type { VirtualHam } from "../ham/virtualHam.js";
import type { AudioPlayer, EngineRenderOptions, PlaybackHandle } from "../audio/engine.js";
import { PASSBAND_HALF_HZ } from "../ham/tuning.js";

/**
 * The audible side of the tuning model: a station the operator has not tuned in
 * sounds off-key, and a station further off than the receiver's 500 Hz passband
 * allows is not heard at all. Which way the note shifts depends on the band's
 * sideband.
 *
 * No DOM, no real timer. A fake `AudioPlayer` records the pitch each message was
 * rendered at, so the assertions are about what would actually be *heard*.
 *
 * Station placement draws from `Math.random` (only activity timing uses the
 * session's injectable RNG), so no test assumes a particular frequency: the dial
 * is always set *relative to the station's own frequency* — exactly what the
 * operator does with the tuning knob.
 */
class FakeAudio implements AudioPlayer {
  calls: Array<{ text: string; toneHz: number | undefined; gain: number | undefined }> = [];
  readonly playbackAvailable = true;
  play(text: string, opts?: EngineRenderOptions): PlaybackHandle {
    this.calls.push({ text, toneHz: opts?.toneHz, gain: opts?.gain });
    return { done: Promise.resolve(), stop() {} };
  }
  stop(): void {}
}

interface SessionOptions {
  freqMHz?: number;
  settings?: Partial<AppSettings>;
}

function makeSession(audio: FakeAudio, opts: SessionOptions = {}): QsoSession {
  const freqMHz = opts.freqMHz ?? 14.025; // 20 m → USB
  const settings = normalizeSettings({ myCall: "BG7XXX", toneHz: 700, ...opts.settings });
  return new QsoSession(freqMHz, settings, {
    rng: () => 0.5,
    now: () => 0,
    startTicking: () => () => {},
    delay: async () => {},
    engine: audio,
    referenceHz: Math.round(freqMHz * 1e6),
  });
}

/** Tune the dial `offsetHz` *below* the station (so it sits `offsetHz` above). */
function tuneBelow(s: QsoSession, ham: VirtualHam, offsetHz: number): void {
  s.retune((ham.freqHz - offsetHz) / 1e6);
}

function lastTone(audio: FakeAudio): number | undefined {
  return audio.calls[audio.calls.length - 1]?.toneHz;
}

describe("CW 偏频：通带内的音调随失谐变化", () => {
  it("USB 波段（20m）：台在拨轮上方时，听到的音调高于设定值", async () => {
    const audio = new FakeAudio();
    const s = makeSession(audio);
    const ham = s.seedHams(1)[0];

    tuneBelow(s, ham, 180);
    await s.hamCallsCq(ham);

    expect(s.partnerDetuneHz()).toBe(180);
    expect(s.partnerToneHz()).toBe(880); // 700 + 180
    expect(lastTone(audio)).toBe(880);
  });

  it("USB 方向：往上调拨轮，音调变低", async () => {
    const audio = new FakeAudio();
    const s = makeSession(audio);
    const ham = s.seedHams(1)[0];

    tuneBelow(s, ham, 200); // 台在拨轮上方 200 Hz
    await s.hamCallsCq(ham);
    const before = s.partnerToneHz()!;

    tuneBelow(s, ham, -200); // 再往上调 400 Hz（台相对落到拨轮下方）

    expect(s.partnerToneHz()).toBeLessThan(before);
  });

  it("LSB 波段（40m）：同一位置方向相反——音调低于设定值", async () => {
    const audio = new FakeAudio();
    const s = makeSession(audio, { freqMHz: 7.025 }); // 40 m → LSB
    const ham = s.seedHams(1)[0];

    tuneBelow(s, ham, 180);
    await s.hamCallsCq(ham);

    expect(s.partnerDetuneHz()).toBe(180);
    expect(s.partnerToneHz()).toBe(520); // 700 − 180
    expect(lastTone(audio)).toBe(520);
  });

  it("正对频（拨轮对准台）时，音调回到设定值", async () => {
    const audio = new FakeAudio();
    const s = makeSession(audio);
    const ham = s.seedHams(1)[0];

    tuneBelow(s, ham, 0);
    await s.hamCallsCq(ham);

    expect(s.partnerDetuneHz()).toBe(0);
    expect(s.partnerToneHz()).toBe(700);
    expect(lastTone(audio)).toBe(700);
  });

  it("跟随设定的 CW 音调：改成 900 Hz 后偏频围绕 900 计算", async () => {
    const audio = new FakeAudio();
    const s = makeSession(audio, { settings: { toneHz: 900 } });
    const ham = s.seedHams(1)[0];

    tuneBelow(s, ham, 180);
    await s.hamCallsCq(ham);

    expect(s.partnerToneHz()).toBe(1080); // 900 + 180
  });
});

describe("CW 通带与裙边：出了通带先变弱，再消失", () => {
  it("边缘内满音量可通联，出界 1 Hz 还听得到但已经不是通联对象，再往外就没声了", async () => {
    const audio = new FakeAudio();
    const s = makeSession(audio);
    const ham = s.seedHams(1)[0];

    tuneBelow(s, ham, PASSBAND_HALF_HZ); // 正好落在滤波器边缘
    await s.hamCallsCq(ham);
    expect(s.partnerInPassband()).toBe(true);
    expect(s.partnerToneHz()).toBe(700 + PASSBAND_HALF_HZ);
    expect(s.partnerGain()).toBe(1); // 通带内是平的

    tuneBelow(s, ham, -PASSBAND_HALF_HZ - 1); // 偏出 1 Hz
    expect(s.partnerInPassband()).toBe(false);
    // 裙边上：音调还在、音量已经掉下来，但掉得很轻（不是一刀切）。
    expect(s.partnerToneHz()).toBe(700 - PASSBAND_HALF_HZ - 1);
    expect(s.partnerGain()).toBeGreaterThan(0.99);

    tuneBelow(s, ham, -400); // 越过 1.5×半宽（375 Hz）
    expect(s.partnerGain()).toBeNull();
    expect(s.partnerToneHz()).toBeNull();
  });

  it("裙边上的对方报文按衰减后的音量播出（音调照旧按偏频走）", async () => {
    const audio = new FakeAudio();
    const s = makeSession(audio);
    const ham = s.seedHams(1)[0];

    tuneBelow(s, ham, 0); // 先对准，把 CQ 收下来
    await s.hamCallsCq(ham);
    expect(s.partnerGain()).toBe(1);

    tuneBelow(s, ham, 320); // 通联中慢慢调走：越过 ±250，落在裙边中段
    await s.userSend(`${ham.call} DE BG7XXX K`);

    expect(s.partnerInPassband()).toBe(false);
    const gain = s.partnerGain()!;
    expect(gain).toBeGreaterThan(0);
    expect(gain).toBeLessThan(0.5); // 已经明显弱下去，但还没到静音
    const reply = audio.calls[audio.calls.length - 1];
    expect(reply.toneHz).toBe(700 + 320);
    expect(reply.gain).toBeCloseTo(gain, 6);
  });

  it("通联中调走超过通带：对方的声音直接消失，而不是变尖", async () => {
    const audio = new FakeAudio();
    const s = makeSession(audio);
    const ham = s.seedHams(1)[0];

    tuneBelow(s, ham, 0);
    await s.hamCallsCq(ham);
    expect(s.partnerToneHz()).toBe(700);

    tuneBelow(s, ham, 1000); // 1 kHz 一步（40 m/20 m 都是这个步进）

    expect(s.partnerDetuneHz()).toBe(1000); // 位置关系仍然读得出来
    expect(s.partnerInPassband()).toBe(false);
    expect(s.partnerToneHz()).toBeNull(); // 不是 1700 Hz，是没声音
  });

  it("通带外的台不会接入会话（听不见的 CQ 不会被抄收）", async () => {
    const audio = new FakeAudio();
    const s = makeSession(audio);
    const ham = s.seedHams(1)[0];

    tuneBelow(s, ham, -1000); // 拨轮比台高 1 kHz，早已出了滤波器

    const heard = await s.hamCallsCq(ham);

    expect(heard).toBe(false);
    expect(s.state).toBe("IDLE");
    expect(audio.calls).toHaveLength(0);
  });

  it("通带外的台不会被自动选中，也不会被自动播报", async () => {
    const audio = new FakeAudio();
    const s = makeSession(audio);
    s.seedHams(2);
    // Dial parked *between* two grid slots (…025.5): every station is at least
    // 500 Hz away, so none of them is inside the 500 Hz passband.
    s.retune(14.0255);

    const heard = await s.hamCallsCq();

    expect(heard).toBe(false);
    expect(s.lines).toHaveLength(0);
  });
});

describe("CW 边带偏好与可调滤波带宽", () => {
  it("本波段改成 LSB 后，20m 上的音调方向反过来", async () => {
    const audio = new FakeAudio();
    const s = makeSession(audio);
    s.setSidebandMode("LSB"); // 20m 上手动改成 CW-L
    const ham = s.seedHams(1)[0];

    expect(s.sideband).toBe("LSB");
    tuneBelow(s, ham, 180); // 台在拨轮上方 180 Hz
    await s.hamCallsCq(ham);

    expect(s.partnerToneHz()).toBe(520); // LSB：700 − 180（USB 会是 880）
    expect(lastTone(audio)).toBe(520);
  });

  it("本波段改成 USB 后，40m 上的音调方向反过来", async () => {
    const audio = new FakeAudio();
    const s = makeSession(audio, { freqMHz: 7.025 });
    s.setSidebandMode("USB"); // 40m 上手动改成 CW-U
    const ham = s.seedHams(1)[0];

    expect(s.sideband).toBe("USB");
    tuneBelow(s, ham, 180);
    await s.hamCallsCq(ham);

    expect(s.partnerToneHz()).toBe(880); // USB：700 + 180（LSB 会是 520）
  });

  it("滤波带宽变窄：250 Hz 时偏 200 Hz 就已经听不到", async () => {
    const audio = new FakeAudio();
    const s = makeSession(audio, { settings: { passbandHz: 250 } });
    const ham = s.seedHams(1)[0];

    expect(s.passbandHz).toBe(250);
    expect(s.passbandHalfHz).toBe(125);

    tuneBelow(s, ham, 200); // 500 Hz 通带里还听得到，250 Hz 已出界
    expect(s.heardActiveHam()).toBeNull();
    expect(await s.hamCallsCq(ham)).toBe(false);
    expect(audio.calls).toHaveLength(0);
  });

  it("带宽 100 Hz 时只有正对频（±50 Hz）才收得到", async () => {
    const audio = new FakeAudio();
    const s = makeSession(audio, { settings: { passbandHz: 100 } });
    const ham = s.seedHams(1)[0];

    tuneBelow(s, ham, 0);
    await s.hamCallsCq(ham);
    expect(s.partnerInPassband()).toBe(true);
    expect(s.partnerToneHz()).toBe(700);

    tuneBelow(s, ham, 60); // 越过 ±50 Hz 的界：到了裙边上
    expect(s.partnerInPassband()).toBe(false);
    expect(s.partnerToneHz()).toBe(700 + 60);
    expect(s.partnerGain()).toBeGreaterThan(0);

    tuneBelow(s, ham, 80); // 1.5×50 = 75 Hz：裙边尽头
    expect(s.partnerToneHz()).toBeNull();
    expect(s.partnerGain()).toBeNull();
  });
});

describe("用户自己的发送", () => {
  it("不受偏频影响（自己的信号永远正对频）", async () => {
    const audio = new FakeAudio();
    const s = makeSession(audio);
    const ham = s.seedHams(1)[0];

    tuneBelow(s, ham, 200);
    await s.hamCallsCq(ham);
    const sent = `${ham.call} DE BG7XXX K`;
    await s.userSend(sent);

    const mine = audio.calls.find((c) => c.text === sent);
    expect(mine?.toneHz).toBe(700); // 精确的设定音调
    expect(s.partnerToneHz()).toBe(900); // 对方的报文仍按偏频播出
  });

  it("没有通联对象时没有音调可显示", () => {
    const audio = new FakeAudio();
    const s = makeSession(audio);

    expect(s.partnerToneHz()).toBeNull();
    expect(s.partnerDetuneHz()).toBeNull();
  });
});
