import { describe, expect, it } from "vitest";
import { QsoSession } from "../../src/ui/session.js";
import { normalizeSettings } from "../../src/ui/settingsSchema.js";
import { BAND_SIGNAL_SPREAD_HZ, mulberry32 } from "../../src/ham/spectrum.js";

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
    pace: async () => {},
  });
  return {
    session,
    /** Move the clock without stepping the scheduler. */
    setTime(ms: number) {
      t = ms;
    },
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

  it("只在真正发报时 active；两条 CQ 之间的守听间隙里没有信号", async () => {
    const h = makeSession();
    h.session.seedHams(1);
    h.session.start();
    const call = h.session.listHams()[0].call;
    const active = (): boolean | undefined =>
      h.session.spectrum().signals.find((s) => s.call === call)?.active;

    await h.tickTo(20_001); // the first CQ starts
    expect(active()).toBe(true);

    // 这条 CQ 已经发完，下一条还没开始。台仍在"持续呼叫"（state 仍是
    // cqing），但此刻没有声音，瀑布上不应该再有它。
    const dur = h.session.callDurationMs(`CQ CQ CQ DE ${call} ${call} PSE K`);
    await h.tickTo(20_001 + dur + 50);
    expect(h.session.hamActivity()[0].state).toBe("cqing");
    expect(active()).toBe(false);

    h.session.dispose();
  });
});

describe("会话频谱 — 自己发报时也跟着键控通断", () => {
  /** The operator's own carrier in the snapshot (half-duplex: the only one). */
  function mine(session: QsoSession) {
    return session.spectrum().signals.find((s) => s.workable === false && s.freqHz > 0);
  }

  it("实时键控：按下才亮，抬起就暗，不是一条连续条带", () => {
    const { session, setTime } = makeSession();
    expect(session.beginLiveKeying()).toBe(true);

    // 25 WPM 的点比一行还短，所以瀑布是**按行**（55 ms 一片）取样的：一个点
    // 加一段长静默再加一个划，画出来应当是"亮—暗—亮"，而不是一条实心条带。
    const events: Array<[number, () => void]> = [
      [55, () => session.liveKeyDown()],
      [110, () => session.liveKeyUp()],
      [275, () => session.liveKeyDown()],
      [495, () => session.liveKeyUp()],
    ];
    const lit: boolean[] = [];
    for (let t = 0; t <= 605; t += 55) {
      setTime(t);
      while (events.length && events[0][0] <= t) events.shift()![1]();
      lit.push(Boolean(mine(session)?.active));
    }

    expect(lit[0]).toBe(false); // 载波开着、键还没按下：没有音频就没有东西可画
    expect(lit).toContain(true); // 按下去了
    expect(lit[lit.length - 1]).toBe(false); // 早就松开：暗

    // 暗段之后又亮起来：点与划之间的静默确实画成了空行。
    const firstDark = lit.indexOf(false, 1);
    expect(firstDark).toBeGreaterThan(0);
    expect(lit.slice(firstDark).some(Boolean)).toBe(true);
  });

  it("发射时只画自己这一路信号，且就在拨轮频率上", () => {
    const { session, setTime } = makeSession();
    session.seedHams(4);
    session.beginLiveKeying();
    setTime(100);
    session.liveKeyDown();
    setTime(150);

    const signals = session.spectrum().signals;
    // 半双工：发射时不接收，波段上别的台一个都不该出现。
    expect(signals).toHaveLength(1);
    expect(signals[0].freqHz).toBe(14_025_000);
    expect(signals[0].strength).toBe(1);
    expect(signals[0].call).toBe("BG7XXX");
    expect(signals[0].active).toBe(true);
  });

  it("没设呼号时也不退回背景载波的合成点划", () => {
    let t = 150;
    const noCall = new QsoSession(
      14.025,
      normalizeSettings({ freqMHz: 14.025, myCall: "" }),
      {
        rng: mulberry32(3),
        now: () => t,
        referenceHz: REF,
        startTicking: () => () => {},
        delay: async () => {},
        pace: async () => {},
      },
    );
    noCall.beginLiveKeying();
    noCall.liveKeyDown();
    t = 200;

    const sig = noCall.spectrum().signals[0];
    // 空呼号原本是"装饰载波"的标记，会导致瀑布改用合成的点划；
    // 自己发射时必须是真实键控，所以给一个占位呼号。
    expect(sig.call).not.toBe("");
    expect(sig.active).toBe(true);
    noCall.dispose();
  });
});
