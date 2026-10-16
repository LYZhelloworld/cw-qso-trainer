import { describe, expect, it } from "vitest";
import { QsoSession } from "./session.js";
import { normalizeSettings } from "./settingsSchema.js";
import type { AudioPlayer, PlaybackHandle } from "../audio/engine.js";

/**
 * Wiring of the audio-break-in behaviour. No DOM, no real timer: a fake
 * `AudioPlayer` records play/stop calls so we can prove the operator can answer
 * a HAM mid-CQ (the HAM's CQ no longer blocks the send button) and that sending
 * cuts any in-flight HAM audio.
 */
class FakeAudio implements AudioPlayer {
  plays: string[] = [];
  stops = 0;
  readonly playbackAvailable = true;
  play(text: string): PlaybackHandle {
    this.plays.push(text);
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

    await s.hamCallsCq(); // HAM 开始发 CQ（后台播放）
    expect(audio.stops).toBe(0);

    const peer = s.ham!.call;
    await s.userSend(`${peer} DE BG7XXX K`); // 用户插话
    expect(audio.stops).toBeGreaterThanOrEqual(1); // 已切断 HAM 音频
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
