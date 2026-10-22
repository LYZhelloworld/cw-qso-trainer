import { describe, expect, it } from "vitest";
import { QsoSession } from "./session.js";
import { normalizeSettings } from "./settingsSchema.js";
import type { AudioPlayer, EngineRenderOptions, PlaybackHandle } from "../audio/engine.js";

/**
 * Wiring of the audio-break-in behaviour. No DOM, no real timer: a fake
 * `AudioPlayer` records play/stop calls so we can prove the operator can answer
 * a HAM mid-CQ (the HAM's CQ no longer blocks the send button) and that sending
 * cuts any in-flight HAM audio.
 */
class FakeAudio implements AudioPlayer {
  plays: string[] = [];
  /** Where each playback started, in seconds (0 = from the beginning). */
  offsets: number[] = [];
  stops = 0;
  readonly playbackAvailable = true;
  play(text: string, opts?: EngineRenderOptions): PlaybackHandle {
    this.plays.push(text);
    this.offsets.push(opts?.offsetSec ?? 0);
    return { done: Promise.resolve(), stop() {} };
  }
  stop(): void {
    this.stops += 1;
  }
}

function makeSession(audio: FakeAudio) {
  const settings = normalizeSettings({ freqMHz: 14.05, myCall: "BG7XXX" });
  const session = new QsoSession(14.05, settings, {
    rng: () => 0,
    now: () => 0,
    startTicking: () => () => {},
    delay: async () => {},
    engine: audio,
  });
  return session;
}

/** A session whose clock can be wound forward by hand, one scheduler tick at a time. */
function makeClockSession(audio: FakeAudio) {
  let t = 0;
  const ticks: Array<() => void> = [];
  const settings = normalizeSettings({ freqMHz: 14.05, myCall: "BG7XXX" });
  const session = new QsoSession(14.05, settings, {
    rng: () => 0,
    now: () => t,
    startTicking: (cb) => {
      ticks.push(cb);
      return () => {};
    },
    delay: async () => {},
    engine: audio,
  });
  return {
    session,
    tickTo(ms: number) {
      t = ms;
      for (const cb of ticks) cb();
    },
  };
}

describe("音频插话（break-in）", () => {
  it("HAM 正在发 CQ 时，发送按钮不被占用（isSending 为 false），用户可插话", async () => {
    const audio = new FakeAudio();
    const s = makeSession(audio);
    s.seedHams(1);
    // Sit on the station: a CW receiver only hears what is inside its passband.
    s.retune(s.listHams()[0].freqHz / 1e6);

    await s.hamCallsCq();
    expect(s.state).toBe("PEER_CQ");
    expect(s.isSending).toBe(false); // 关键：HAM CQ 不再锁住发送
    expect(audio.plays.some((t) => t.includes("CQ"))).toBe(true);

    // 用户此时插话应当被接受，而非被 busy 守门丢弃
    const peer = s.ham!.call;
    await s.userSend(`${peer} DE BG7XXX K`);
    expect(s.lines.filter((l) => l.who === "me").length).toBe(1);
  });

  it("用户发送会先切断环境里正在播放的 HAM 音频", async () => {
    const audio = new FakeAudio();
    const s = makeSession(audio);
    s.seedHams(1);
    s.retune(s.listHams()[0].freqHz / 1e6); // 对准它，通带内才听得见

    // Tuning now joins whatever is on the air, so it may stop a previous
    // playback; the baseline is taken after the dial has settled.
    const before = audio.stops;
    await s.hamCallsCq(); // HAM 开始发 CQ（后台播放）
    expect(audio.stops).toBe(before);

    const peer = s.ham!.call;
    await s.userSend(`${peer} DE BG7XXX K`); // 用户插话
    expect(audio.stops).toBeGreaterThan(before); // 已切断 HAM 音频
  });

  it("用户自己的发送仍受 busy 保护（并发只生效一次）", async () => {
    const audio = new FakeAudio();
    const s = makeSession(audio);
    s.seedHams(1);
    s.retune(s.listHams()[0].freqHz / 1e6); // 对准它，通带内才听得见
    await s.hamCallsCq();
    const peer = s.ham!.call;

    const p1 = s.userSend(`${peer} DE BG7XXX K`);
    const p2 = s.userSend(`${peer} DE BG7XXX K`); // 并发，应被丢弃
    await Promise.all([p1, p2]);

    expect(s.lines.filter((l) => l.who === "me").length).toBe(1);
    expect(s.isSending).toBe(false);
  });
});

describe("调准一个正在发报的台", () => {
  it("从它已经发到的位置接上，而不是等下一次 CQ", async () => {
    const audio = new FakeAudio();
    const { session, tickTo } = makeClockSession(audio);
    session.seedHams(1);
    const ham = session.listHams()[0];
    session.start();

    tickTo(5_000); // rng=0 -> 首呼在 5 秒；此时我们还没调过去，所以没听见
    expect(audio.plays).toHaveLength(0);

    tickTo(8_000); // 这条 CQ 已经发了 3 秒
    session.retune(ham.freqHz / 1e6); // 调准

    expect(audio.plays.some((t) => t.includes("CQ"))).toBe(true);
    expect(audio.offsets.at(-1)).toBeCloseTo(3, 0);
  });

  it("报文已经发完之后调过去，就先安静着", async () => {
    const audio = new FakeAudio();
    const { session, tickTo } = makeClockSession(audio);
    session.seedHams(1);
    const ham = session.listHams()[0];
    session.start();

    tickTo(5_000);
    const durationMs = session.callDurationMs(`CQ CQ CQ DE ${ham.call} ${ham.call} PSE K`);
    tickTo(5_000 + durationMs + 1); // 这条 CQ 已经结束了

    session.retune(ham.freqHz / 1e6);

    expect(audio.plays).toHaveLength(0);
  });
});
