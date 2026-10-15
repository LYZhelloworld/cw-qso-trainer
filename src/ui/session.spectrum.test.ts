import { describe, expect, it } from "vitest";
import { QsoSession } from "./session.js";
import { normalizeSettings } from "./settingsSchema.js";
import { BAND_SIGNAL_SPREAD_HZ, mulberry32 } from "../ham/spectrum.js";

/** 20 m CW reference — where this band's stations live. */
const REF = 14_025_000;

/**
 * A session with everything time-based injected, so the CQ rhythm can be
 * stepped without a real timer (same harness as session.activity.test.ts).
 */
function makeSession(rng: () => number = mulberry32(11)) {
  let t = 0;
  const ticks: Array<() => void> = [];
  const settings = normalizeSettings({ freqMHz: 14.025, myCall: "BG7XXX" });
  const session = new QsoSession(14.025, settings, {
    rng,
    now: () => t,
    referenceHz: REF,
    startTicking: (cb) => {
      ticks.push(cb);
      return () => {};
    },
    delay: async () => {},
  });
  return {
    session,
    async tickTo(ms: number) {
      t = ms;
      for (const cb of ticks) cb();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe("会话频谱 — 瀑布图的数据源", () => {
  it("窗口中心就是拨轮频率（Hz）", () => {
    const { session } = makeSession();
    expect(session.spectrum().centerHz).toBe(14_025_000);

    session.retune(14.028);
    expect(session.spectrum().centerHz).toBe(14_028_000);
  });

  it("频段上的每个台都作为可通联信号出现，频率是绝对值", () => {
    const { session } = makeSession();
    session.seedHams(3);

    const hams = session.listHams();
    const workable = session.spectrum().signals.filter((s) => s.workable);

    expect(workable.map((s) => s.call).sort()).toEqual(hams.map((h) => h.call).sort());
    for (const s of workable) {
      expect(Math.abs(s.freqHz - REF)).toBeLessThanOrEqual(BAND_SIGNAL_SPREAD_HZ);
      expect(s.strength).toBeGreaterThan(0);
      expect(s.strength).toBeLessThanOrEqual(1);
    }
  });

  it("调谐只移动窗口，不移动电台（同一批台的绝对频率不变）", () => {
    const { session } = makeSession();
    session.seedHams(2);
    const before = session
      .spectrum()
      .signals.filter((s) => s.workable)
      .map((s) => s.freqHz);

    session.retune(14.03);

    const after = session
      .spectrum()
      .signals.filter((s) => s.workable)
      .map((s) => s.freqHz);
    expect(after).toEqual(before);
  });

  it("除了可通联的台，还有装饰性的弱背景载波（不可通联）", () => {
    const { session } = makeSession();
    session.seedHams(1);

    const signals = session.spectrum().signals;
    const background = signals.filter((s) => !s.workable);

    expect(background.length).toBeGreaterThanOrEqual(3);
    for (const s of background) {
      expect(s.strength).toBeLessThan(0.45);
      expect(Math.abs(s.freqHz - REF)).toBeLessThanOrEqual(BAND_SIGNAL_SPREAD_HZ);
    }
  });

  it("背景载波在同一会话里保持不变（不会逐帧乱跳）", () => {
    const { session } = makeSession();
    const first = session.spectrum().signals.map((s) => s.freqHz);
    const second = session.spectrum().signals.map((s) => s.freqHz);
    expect(second).toEqual(first);
  });

  it("正在呼叫的台被标为 active；守听的台不是", async () => {
    const h = makeSession();
    h.session.seedHams(1);
    h.session.start();

    // Before any CQ: the station is parked, not transmitting.
    const call = h.session.listHams()[0].call;
    expect(h.session.spectrum().signals.find((s) => s.call === call)?.active).toBe(false);

    await h.tickTo(20_001); // the first CQ is due within 5–20 s
    expect(h.session.hamActivity()[0].state).toBe("cqing");
    expect(h.session.spectrum().signals.find((s) => s.call === call)?.active).toBe(true);

    h.session.dispose();
  });
});
