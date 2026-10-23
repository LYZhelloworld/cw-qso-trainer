import { describe, expect, it } from "vitest";
import { QsoSession } from "./session.js";
import { normalizeSettings } from "./settingsSchema.js";
import { SpyBand } from "./bandSpy.js";

/**
 * The band is the *environment*; the station is only the receiver. Powering the
 * rig down must silence us without touching the air: the HAMs keep calling CQ,
 * giving up and being replaced exactly as before. Everything time-based is
 * injected so a 3-minute give-up is exercised in milliseconds.
 */
function makeSession(rng: () => number = () => 0) {
  let t = 0;
  const ticks: Array<() => void> = [];
  const band = new SpyBand();
  const settings = normalizeSettings({ freqMHz: 14.05, myCall: "BG7XXX" });
  const session = new QsoSession(14.05, settings, {
    rng,
    now: () => t,
    startTicking: (cb) => {
      ticks.push(cb);
      return () => {};
    },
    delay: async () => {},
    pace: async () => {},
    synth: band,
  });

  return {
    session,
    band,
    /** Move the clock to `ms`, run the scheduler, then let async work settle. */
    async tickTo(ms: number) {
      t = ms;
      for (const cb of ticks) cb();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe("关台 = 只是不接收（环境不随人下线）", () => {
  it("关台后不再接话：不写报文，也不发声", async () => {
    const h = makeSession();
    h.session.seedHams(1);
    h.session.retune(h.session.listHams()[0].freqHz / 1e6); // 对准它
    h.session.start();
    h.session.setReceiving(false);

    await h.tickTo(5_000); // rng=0 -> 首呼延迟 5 s

    expect(h.session.lines).toHaveLength(0);
    expect(h.band.texts).toHaveLength(0);
  });

  it("关台后频段照常运转：到点仍会呼叫，台也不会消失", async () => {
    const h = makeSession();
    h.session.seedHams(1);
    h.session.retune(h.session.listHams()[0].freqHz / 1e6); // 对准它
    h.session.start();
    h.session.setReceiving(false);

    const first = h.session.listHams()[0].call;
    await h.tickTo(5_000);
    // 我们没听到，但对方确实把 CQ 发了出去
    expect(h.session.hamActivity()[0].state).toBe("cqing");

    await h.tickTo(5_000 + 180_000); // 三分钟没人应，台仍在原地继续呼叫
    const now = h.session.listHams();
    expect(now).toHaveLength(1);
    expect(now[0].call).toBe(first);
  });

  it("关台不清空已建立的通联：报文与对手都留着", async () => {
    const h = makeSession();
    h.session.seedHams(1);
    h.session.retune(h.session.listHams()[0].freqHz / 1e6); // 对准它，通带内才听得见
    await h.session.hamCallsCq(); // 开台时抄到一台 CQ
    const lines = h.session.lines.length;
    const peer = h.session.ham!.call;

    h.session.setReceiving(false);

    expect(h.session.lines).toHaveLength(lines);
    expect(h.session.ham?.call).toBe(peer);
    expect(h.session.state).toBe("PEER_CQ");
  });

  it("关台时不发射", async () => {
    const h = makeSession();
    h.session.seedHams(1);
    h.session.retune(h.session.listHams()[0].freqHz / 1e6); // 对准它，通带内才听得见
    await h.session.hamCallsCq();
    const peer = h.session.ham!.call;

    h.session.setReceiving(false);
    await h.session.userSend(`${peer} DE BG7XXX K`);
    await h.session.userCallsCq();

    expect(h.session.lines.filter((l) => l.who === "me")).toHaveLength(0);
    expect(h.session.isSending).toBe(false);
  });

  it("重新开台后可以继续接收", async () => {
    const h = makeSession();
    h.session.seedHams(1);
    h.session.retune(h.session.listHams()[0].freqHz / 1e6); // 对准它
    h.session.start();
    h.session.setReceiving(false);
    await h.tickTo(5_000);
    expect(h.session.lines).toHaveLength(0);

    h.session.setReceiving(true);
    await h.tickTo(35_000); // 下一次呼叫（rng=0 -> 间隔 30 s）

    expect(h.session.lines.some((l) => l.who === "ham" && l.text.includes("CQ"))).toBe(true);
    expect(h.band.texts.some((t: string) => t.includes("CQ"))).toBe(true);
  });

  it("关台只是把总线压到 0：正在发的报文不停，只是听不见", async () => {
    const h = makeSession();
    h.session.seedHams(1);
    h.session.retune(h.session.listHams()[0].freqHz / 1e6); // 对准它，通带内才听得见
    await h.session.hamCallsCq();
    const keyed = h.band.keyed.length;

    h.session.setReceiving(false);

    expect(h.band.muted.at(-1)).toBe(true);
    // 台站没有被打断，也没有被拆掉：真机不会因为关了机就让别人停嘴
    expect(h.band.keyed).toHaveLength(keyed);
    expect(h.band.stations.size).toBe(1);
  });

  it("retune 只改拨轮频率，不动频段上的台", () => {
    const h = makeSession();
    h.session.seedHams(2);
    const calls = h.session.listHams().map((x) => x.call);

    h.session.retune(14.06);

    expect(h.session.freqMHz).toBe(14.06);
    expect(h.session.listHams().map((x) => x.call)).toEqual(calls);
  });
});
