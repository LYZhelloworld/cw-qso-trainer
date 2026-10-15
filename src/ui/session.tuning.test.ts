import { describe, expect, it } from "vitest";
import { QsoSession } from "./session.js";
import { normalizeSettings, type AppSettings } from "./settingsSchema.js";
import type { VirtualHam } from "../ham/virtualHam.js";
import type { AudioPlayer, EngineRenderOptions, PlaybackHandle } from "../audio/engine.js";

/**
 * The audible side of the tuning model: a station the operator has not tuned in
 * sounds off-key, and which way it is off depends on the band's sideband.
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
  calls: Array<{ text: string; toneHz: number | undefined }> = [];
  readonly playbackAvailable = true;
  play(text: string, opts?: EngineRenderOptions): PlaybackHandle {
    this.calls.push({ text, toneHz: opts?.toneHz });
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

describe("CW 偏频：听到的音调随失谐变化", () => {
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

    tuneBelow(s, ham, 180); // 台在拨轮上方 180 Hz
    await s.hamCallsCq(ham);
    const before = s.partnerToneHz()!;

    tuneBelow(s, ham, -320); // 再往上调 500 Hz（台相对落到拨轮下方）

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

  it("隔着 1 kHz 一步调谐：台在下方时音调被夹在下限", async () => {
    const audio = new FakeAudio();
    const s = makeSession(audio);
    const ham = s.seedHams(1)[0];

    tuneBelow(s, ham, -1000); // 拨轮比台高 1 kHz
    await s.hamCallsCq(ham);

    expect(s.partnerDetuneHz()).toBe(-1000);
    expect(s.partnerToneHz()).toBe(250); // 700 − 1000 → 夹到可听下限
  });

  it("失谐过大时音调被夹在可听上限，不会跑到几 kHz", async () => {
    const audio = new FakeAudio();
    const s = makeSession(audio);
    const ham = s.seedHams(1)[0];

    tuneBelow(s, ham, 5000);
    await s.hamCallsCq(ham);

    expect(s.partnerToneHz()).toBe(1800);
  });

  it("跟随设定的 CW 音调：改成 900 Hz 后偏频围绕 900 计算", async () => {
    const audio = new FakeAudio();
    const s = makeSession(audio, { settings: { toneHz: 900 } });
    const ham = s.seedHams(1)[0];

    tuneBelow(s, ham, 180);
    await s.hamCallsCq(ham);

    expect(s.partnerToneHz()).toBe(1080); // 900 + 180
  });

  it("用户自己发报不受偏频影响（自己的信号永远正对频）", async () => {
    const audio = new FakeAudio();
    const s = makeSession(audio);
    const ham = s.seedHams(1)[0];

    tuneBelow(s, ham, 900);
    await s.hamCallsCq(ham);
    const sent = `${ham.call} DE BG7XXX K`;
    await s.userSend(sent);

    const mine = audio.calls.find((c) => c.text === sent);
    expect(mine?.toneHz).toBe(700); // 精确的设定音调
    expect(s.partnerToneHz()).toBe(1600); // 对方的报文仍按偏频播出
  });

  it("没有通联对象时没有音调可显示", () => {
    const audio = new FakeAudio();
    const s = makeSession(audio);

    expect(s.partnerToneHz()).toBeNull();
    expect(s.partnerDetuneHz()).toBeNull();
  });
});
