import { describe, expect, it } from "vitest";
import { QsoSession } from "./session.js";
import { normalizeSettings } from "./settingsSchema.js";

/**
 * Wiring tests for the HAMs' autonomous CQ rhythm. Everything time-based is
 * injected (clock, tick driver, wait, rng) so a 3-minute give-up timer is
 * tested in milliseconds and no real timer is ever started.
 */
function makeSession(rng: () => number = () => 0) {
  let t = 0;
  const ticks: Array<() => void> = [];
  const waits: number[] = [];
  let stopped = false;

  const settings = normalizeSettings({ freqMHz: 14.05, myCall: "BG7XXX" });
  const session = new QsoSession(14.05, settings, {
    rng,
    now: () => t,
    startTicking: (cb) => {
      ticks.push(cb);
      return () => {
        stopped = true;
      };
    },
    delay: async (ms: number) => {
      waits.push(ms);
    },
  });

  return {
    session,
    waits,
    get stopped() {
      return stopped;
    },
    /** Move the clock to `ms`, run the scheduler, then let async work settle. */
    async tickTo(ms: number) {
      t = ms;
      for (const cb of ticks) cb();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe("HAM 自主发 CQ", () => {
  it("到点才呼叫，之前频率是安静的", async () => {
    const h = makeSession();
    h.session.seedHams(1); // rng=0 -> 首呼延迟取 5 s
    h.session.start();

    await h.tickTo(4_000);
    expect(h.session.lines.length).toBe(0);

    await h.tickTo(5_000);
    expect(h.session.lines.some((l) => l.who === "ham" && l.text.includes("CQ"))).toBe(true);
    expect(h.session.state).toBe("PEER_CQ");
  });

  it("无人应答时反复重呼，且不重置已建立的状态", async () => {
    const h = makeSession();
    h.session.seedHams(1);
    h.session.start();

    await h.tickTo(5_000);
    const peer = h.session.ham?.call;
    await h.tickTo(35_000); // rng=0 -> 下一次 CQ 间隔 30 s

    expect(h.session.state).toBe("PEER_CQ");
    expect(h.session.ham?.call).toBe(peer);
    expect(h.session.lines.filter((l) => l.who === "ham").length).toBe(2);
  });

  it("连续 3 分钟无应答则下线，并补上新台", async () => {
    const h = makeSession();
    h.session.seedHams(1);
    h.session.start();
    await h.tickTo(5_000);

    const gone = h.session.listHams()[0].call;
    await h.tickTo(5_000 + 180_000);

    expect(h.session.lines.some((l) => l.text.includes("下线"))).toBe(true);
    const now = h.session.listHams();
    expect(now).toHaveLength(1); // 补位后仍是 1 个（目标数量由 rng 决定）
    expect(now[0].call).not.toBe(gone);
  });

  it("通联中不会被频段上其他台的呼叫打断", async () => {
    const h = makeSession();
    h.session.seedHams(2); // 两台首呼都是 5 s
    h.session.start();

    await h.tickTo(5_000);
    // 同一时刻两台都在呼叫，但只有一台被接入会话
    expect(h.session.lines.filter((l) => l.who === "ham").length).toBe(1);
  });
});

describe("用户应答后", () => {
  it("该台停止自己的呼叫节奏", async () => {
    const h = makeSession();
    h.session.seedHams(1);
    h.session.start();
    await h.tickTo(5_000); // HAM 发 CQ

    const peer = h.session.ham?.call ?? "";
    await h.session.userSend(`${peer} DE BG7XXX K`);

    expect(h.session.hamActivity()[0].state).toBe("inQso");
    // 远超下一次 CQ 时刻，也不会再呼叫
    await h.tickTo(5_000 + 120_000);
    expect(h.session.lines.filter((l) => l.who === "ham" && l.text.includes("CQ")).length).toBe(1);
  });

  it("HAM 的回复前会等待 1–3 秒", async () => {
    const h = makeSession();
    h.session.seedHams(1);
    h.session.start();
    await h.tickTo(5_000);

    await h.session.userSend(`${h.session.ham?.call ?? ""} DE BG7XXX K`);
    expect(h.waits.length).toBeGreaterThan(0);
    for (const ms of h.waits) {
      expect(ms).toBeGreaterThanOrEqual(1_000);
      expect(ms).toBeLessThanOrEqual(3_000);
    }
  });

  it("通联结束后该台回到守听并可再次呼叫", async () => {
    const h = makeSession();
    h.session.seedHams(1);
    h.session.start();
    await h.tickTo(5_000);

    const peer = h.session.ham?.call ?? "";
    await h.session.userSend(`${peer} DE BG7XXX K`);
    h.session.reset(); // 放弃这次通联

    expect(h.session.hamActivity()[0].state).toBe("listening");
  });
});

describe("应答延迟区间", () => {
  it("用户发 CQ 后对方延迟 1–5 秒应答", async () => {
    const h = makeSession(() => 0.5);
    h.session.seedHams(1);

    await h.session.userCallsCq();
    expect(h.waits).toHaveLength(1);
    // randInt(1000, 5000, 0.5) = 3000
    expect(h.waits[0]).toBe(3_000);
  });

  it("延迟取自会话的随机源，注入后完全确定", async () => {
    const a = makeSession(() => 0);
    a.session.seedHams(1);
    await a.session.userCallsCq();
    expect(a.waits[0]).toBe(1_000); // 区间下界

    const b = makeSession(() => 0.999999);
    b.session.seedHams(1);
    await b.session.userCallsCq();
    expect(b.waits[0]).toBe(5_000); // 区间上界
  });
});

describe("生命周期", () => {
  it("start 才装驱动，dispose 会卸掉", () => {
    const h = makeSession();
    h.session.seedHams(1);
    expect(h.stopped).toBe(false);

    h.session.start();
    expect(h.stopped).toBe(false);
    h.session.dispose();
    expect(h.stopped).toBe(true);
  });

  it("未 start 的会话没有定时器在跑", async () => {
    const h = makeSession();
    h.session.seedHams(1);
    // 没有驱动，时间过去也不会有任何动静
    await h.tickTo(600_000);
    expect(h.session.lines.length).toBe(0);
  });
});
