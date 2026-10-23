import { describe, expect, it } from "vitest";
import { QsoSession } from "./session.js";
import { normalizeSettings } from "./settingsSchema.js";
import { SpyBand } from "./bandSpy.js";
import { mulberry32 } from "../ham/spectrum.js";

/** 20 m CW reference — where this band's stations live. */
const REF = 14_025_000;

/**
 * What the session asks the band to do, in order. The session's job in the
 * realtime model is not to render audio but to *drive* the band: put stations
 * on it, key messages onto them, go deaf while sending. That conversation is
 * what these tests assert; the nodes themselves are `bandSynth.test.ts`.
 */
function makeSession() {
  let t = 0;
  const ticks: Array<() => void> = [];
  const band = new SpyBand();
  const settings = normalizeSettings({ freqMHz: 14.025, myCall: "BG7XXX", wpm: 20 });
  const session = new QsoSession(14.025, settings, {
    rng: mulberry32(11),
    now: () => t,
    referenceHz: REF,
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
    async tickTo(ms: number) {
      t = ms;
      for (const cb of ticks) cb();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    },
  };
}

describe("实时模型 — 会话驱动频段", () => {
  it("播种时每台都装上发射机，离开时拆掉", () => {
    const { session, band } = makeSession();
    const hams = session.seedHams(3);

    expect([...band.stations].sort()).toEqual(hams.map((h) => h.call).sort());
    expect(band.receiver?.dialHz).toBe(14_025_000);
  });

  it("台站发 CQ：报文按它自己的起始时刻敲上去，不是从收到的那一刻", async () => {
    const { session, band, tickTo } = makeSession();
    const hams = session.seedHams(2);
    // 调到第一台的频率上：通带是 500 Hz，不调过去就听不到它
    session.retune(hams[0].freqHz / 1e6);
    session.start();
    session.setReceiving(true);

    // 推进到第一台开始呼叫
    let keyed = band.last("key");
    for (let ms = 1_000; ms <= 20_000 && !keyed; ms += 250) {
      await tickTo(ms);
      keyed = band.last("key");
    }

    expect(keyed).toBeDefined();
    expect(String(keyed!.text)).toMatch(/^CQ CQ CQ DE /);
    // 键控落在报文记录自己的开始时刻上：声音与瀑布读同一个时间
    const tx = session.spectrum().signals.find((s) => s.call === keyed!.call);
    expect(tx).toBeDefined();
  });

  it("拨轮一动只重调接收机：没有重新敲任何报文", () => {
    const { session, band } = makeSession();
    session.seedHams(3);
    const before = band.all("key").length;

    session.retune(14.0265);

    expect(band.receiver?.dialHz).toBe(14_026_500);
    expect(band.all("key").length).toBe(before);
  });

  it("发报：先让接收机静音，自己的报文敲在监听支路上，发完恢复", async () => {
    const { session, band } = makeSession();
    session.seedHams(2);
    session.setReceiving(true);

    await session.userSend("CQ CQ CQ DE BG7XXX BG7XXX PSE K");

    const order = band.calls.map((c) => c.what);
    expect(order).toContain("keyMine");
    expect(order.indexOf("transmitting")).toBeLessThan(order.indexOf("keyMine"));
    // 半双工：发的时候静音，发完（含尾音）再放开
    const transmitting = band.all("transmitting").map((c) => c.on);
    expect(transmitting[0]).toBe(true);
    expect(transmitting.at(-1)).toBe(false);
    // 别家的台一个没少：波段照常在发，只是我们聋了
    expect(band.stations.size).toBe(2);
  });

  it("关台只是静音，波段不停：开台时从报文中间接上", async () => {
    const { session, band, tickTo } = makeSession();
    const hams = session.seedHams(2);
    session.retune(hams[0].freqHz / 1e6);
    session.start();
    session.setReceiving(false);

    // 关着机也要一直走时钟：波段自有它的节奏，只是我们听不见
    let onAirAt = -1;
    for (let ms = 250; ms <= 30_000 && onAirAt < 0; ms += 250) {
      await tickTo(ms);
      // 只等我们调过去的那一台，别家的 CQ 不在通带里
      if (session.spectrum().signals.some((s) => s.active && s.call === hams[0].call)) {
        onAirAt = ms;
      }
    }
    expect(onAirAt).toBeGreaterThanOrEqual(0);
    // 关台是聋，不是停台：报文照样被敲在频率上，只是总线压到 0，我们听不到。
    expect(band.all("key").length).toBeGreaterThan(0);
    expect(band.last("muted")?.on).toBe(true);

    // 让这条报文先发出去一段，再开台
    await tickTo(onAirAt + 1_000);
    session.setReceiving(true);

    expect(band.last("muted")?.on).toBe(false);
    const join = band.last("keyFrom");
    expect(join).toBeDefined();
    // 接上时把已经过去的那一段让过去，从此刻往后敲
    expect(Number(join!.elapsedMs)).toBeGreaterThan(0);
    expect(String(join!.text)).toMatch(/^CQ CQ CQ DE /);
  });

  it("换波段时把这一段的发射机全部拆掉", () => {
    const { session, band } = makeSession();
    session.seedHams(3);
    expect(band.stations.size).toBe(3);

    session.dispose();

    expect(band.stations.size).toBe(0);
    expect(band.last("dispose")).toBeDefined();
  });

  it("通联进行中，通带里的 CQ 仍然被敲响：屏幕亮着，喇叭就不能哑", async () => {
    const { session, band, tickTo } = makeSession();
    const hams = session.seedHams(2);
    session.retune(hams[0].freqHz / 1e6);
    session.start();
    session.setReceiving(true);

    // 先让它呼叫一次，会话开始跟这一台建立联系。
    // 只认我们调过去的那一台：别的台也在发，只是不在通带里。
    let firstKeyed = false;
    for (let ms = 250; ms <= 30_000 && !firstKeyed; ms += 250) {
      await tickTo(ms);
      firstKeyed = band.all("key").some((c) => c.call === hams[0].call);
    }
    expect(firstKeyed).toBe(true);

    // 操作者回一句，会话进入 EXCHANGE：从此这次呼叫不再"开启"通联
    await session.userSend("R R R TEST");
    expect(session.state).toBe("EXCHANGE");
    band.clear();

    // 同一台在通带里再次呼叫
    const handle = session as unknown as {
      handleActivity(events: Array<{ type: "cq"; ham: typeof hams[0] }>): void;
    };
    handle.handleActivity([{ type: "cq", ham: hams[0] }]);

    // 状态机不再应答它，但报文照样敲在频率上——瀑布、S 表、耳朵说的是同一件事
    const keyed = band.last("key");
    expect(keyed).toBeDefined();
    expect(String(keyed!.text)).toMatch(/^CQ CQ CQ DE /);
    expect(session.state).toBe("EXCHANGE");
  });

  it("自己发报时波段照常运转：别人的 CQ 也敲在频率上，只是进不了喇叭", async () => {
    let t = 0;
    const ticks: Array<() => void> = [];
    const band = new SpyBand();
    // 扣住发报，让 `transmitting` 一直为真
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const settings = normalizeSettings({ freqMHz: 14.025, myCall: "BG7XXX", wpm: 20 });
    const session = new QsoSession(14.025, settings, {
      rng: mulberry32(11),
      now: () => t,
      referenceHz: REF,
      startTicking: (cb) => {
        ticks.push(cb);
        return () => {};
      },
      delay: async () => {},
      pace: () => gate,
      synth: band,
    });
    const hams = session.seedHams(2);
    session.retune(hams[0].freqHz / 1e6);
    session.start();
    session.setReceiving(true);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    const sending = session.userSend("R R R TEST");
    expect(session.isTransmitting).toBe(true);
    band.clear();

    // 半双工期间另一个台开口：记录必然伴随敲响，否则就又是"屏幕亮、喇叭哑"
    const handle = session as unknown as {
      handleActivity(events: Array<{ type: "cq"; ham: typeof hams[0] }>): void;
    };
    handle.handleActivity([{ type: "cq", ham: hams[1] }]);
    const keyed = band.all("key").filter((c) => String(c.text).startsWith("CQ CQ CQ DE"));
    expect(keyed).toHaveLength(1);
    expect(keyed[0]!.call).toBe(hams[1].call);

    release();
    await sending;
  });
});
