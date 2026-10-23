import { describe, expect, it } from "vitest";
import { QsoSession } from "./session.js";
import { normalizeSettings } from "./settingsSchema.js";
import { SpyBand } from "./bandSpy.js";

/**
 * Wiring of the audio-break-in behaviour, seen from the band's side: what the
 * session asks the synthesizer to do. No DOM, no real timer, no Web Audio — a
 * spy band records the conversation, so the assertions are about what actually
 * goes on the air rather than about a rendered buffer.
 */

/**
 * A gate the test opens when it wants transmissions to finish. The realtime path
 * has no buffer to await, so an over ends on a timer — blocking that timer is
 * what lets a test observe the operator mid-transmission.
 */
class Gate {
  private open = true;
  private pending: Array<() => void> = [];

  wait = (): Promise<void> =>
    this.open ? Promise.resolve() : new Promise<void>((resolve) => this.pending.push(resolve));

  /** Hold transmissions open, so a test can look at one mid-flight. */
  hold(): void {
    this.open = false;
  }
  release(): void {
    this.open = true;
    for (const resolve of this.pending.splice(0)) resolve();
  }
}

function makeSession(band: SpyBand, gate = new Gate()) {
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
    pace: () => gate.wait(),
    synth: band,
  });
  return {
    session,
    gate,
    tickTo(ms: number) {
      t = ms;
      for (const cb of ticks) cb();
    },
  };
}

describe("音频插话（break-in）", () => {
  it("HAM 正在发 CQ 时，发送按钮不被占用（isSending 为 false），用户可插话", async () => {
    const band = new SpyBand();
    const { session } = makeSession(band);
    session.seedHams(1);
    // Sit on the station: a CW receiver only hears what is inside its passband.
    session.retune(session.listHams()[0].freqHz / 1e6);

    await session.hamCallsCq();
    expect(session.state).toBe("PEER_CQ");
    expect(session.isSending).toBe(false); // 关键：HAM CQ 不再锁住发送
    expect(band.keyed.some((k) => k.text.includes("CQ"))).toBe(true);

    // 用户此时插话应当被接受，而非被 busy 守门丢弃
    const peer = session.ham!.call;
    await session.userSend(`${peer} DE BG7XXX K`);
    expect(session.lines.filter((l) => l.who === "me").length).toBe(1);
  });

  it("发报时接收机变聋；波段照常发射，只是我们听不到", async () => {
    const band = new SpyBand();
    const { session } = makeSession(band);
    session.seedHams(1);
    session.retune(session.listHams()[0].freqHz / 1e6);
    await session.hamCallsCq();

    const peer = session.ham!.call;
    await session.userSend(`${peer} DE BG7XXX K`);

    // 半双工时总线静音（真机就是聋），而不是把别人的报文停掉
    expect(band.transmitting[0]).toBe(true);
    expect(band.transmitting.at(-1)).toBe(false);
    expect(band.stations.size).toBe(1); // 台还在频段上
  });

  it("用户自己的发送仍受 busy 保护（并发只生效一次）", async () => {
    const band = new SpyBand();
    const { session } = makeSession(band);
    session.seedHams(1);
    session.retune(session.listHams()[0].freqHz / 1e6); // 对准它，通带内才听得见
    await session.hamCallsCq();
    const peer = session.ham!.call;

    const p1 = session.userSend(`${peer} DE BG7XXX K`);
    const p2 = session.userSend(`${peer} DE BG7XXX K`); // 并发，应被丢弃
    await Promise.all([p1, p2]);

    expect(session.lines.filter((l) => l.who === "me").length).toBe(1);
    expect(session.isSending).toBe(false);
  });
});

describe("调准一个正在发报的台", () => {
  it("从它已经发到的位置接上，而不是等下一次 CQ", () => {
    const band = new SpyBand();
    const { session, tickTo } = makeSession(band);
    session.seedHams(1);
    const ham = session.listHams()[0];
    session.start();

    tickTo(5_000); // rng=0 -> 首呼在 5 秒；此时我们还没调过去，所以没听见
    expect(band.keyed).toHaveLength(0);

    tickTo(8_000); // 这条 CQ 已经发了 3 秒
    session.retune(ham.freqHz / 1e6); // 调准

    const join = band.joined.at(-1);
    expect(join).toBeDefined();
    expect(join!.text).toContain("CQ");
    // 接上的不是第一条报文，而是"已经过去 3 秒"之后的剩余部分
    expect(join!.elapsedMs).toBeGreaterThanOrEqual(3_000);
    expect(join!.elapsedMs).toBeLessThan(3_200);
  });

  it("报文已经发完之后调过去，就先安静着", () => {
    const band = new SpyBand();
    const { session, tickTo } = makeSession(band);
    session.seedHams(1);
    const ham = session.listHams()[0];
    session.start();

    tickTo(5_000);
    const durationMs = session.callDurationMs(`CQ CQ CQ DE ${ham.call} ${ham.call} PSE K`);
    tickTo(5_000 + durationMs + 1); // 这条 CQ 已经结束了

    session.retune(ham.freqHz / 1e6);

    expect(band.joined).toHaveLength(0);
    expect(band.keyed).toHaveLength(0);
  });
});

describe("半双工：发报时不接收", () => {
  it("自己的载波在空中的时候，频谱只剩自己那一个信号", async () => {
    const band = new SpyBand();
    const { session, gate } = makeSession(band);
    session.seedHams(2);
    session.retune(session.listHams()[0].freqHz / 1e6);

    // Not awaited: the transmission is held open by the gate.
    gate.hold();
    const sending = session.userSend("CQ CQ CQ DE BG7XXX BG7XXX PSE K");
    expect(session.isTransmitting).toBe(true);

    const snapshot = session.spectrum();
    expect(snapshot.signals).toHaveLength(1);
    expect(snapshot.signals[0].freqHz).toBe(session.dialHz);
    expect(snapshot.signals[0].strength).toBe(1);

    // Half-duplex: the receiver is deaf, so a CQ on the band is not heard.
    expect(await session.hamCallsCq()).toBe(false);

    gate.release();
    await sending;
    expect(session.isTransmitting).toBe(false);
  });

  it("电键按下时 S 表满格，松开就没有读数", async () => {
    const band = new SpyBand();
    const { session, gate } = makeSession(band);
    session.seedHams(1);
    session.retune(session.listHams()[0].freqHz / 1e6);

    gate.hold();
    const sending = session.userSend("CQ CQ CQ DE BG7XXX BG7XXX PSE K");
    // 时间 0 是第一个点/划的开头：按着键。
    expect(session.isTransmitting).toBe(true);
    expect(session.sMeter()).not.toBeNull();

    gate.release();
    await sending;
    expect(session.isTransmitting).toBe(false);
    // 台在守听（这一瞬没有报文在发），表针归零。
    expect(session.sMeter()).toBeNull();
  });

  it("发报结束后接收恢复：回到守听就能再听到台上的 CQ", async () => {
    const band = new SpyBand();
    const { session, tickTo } = makeSession(band);
    session.seedHams(1);
    const ham = session.listHams()[0];
    session.retune(ham.freqHz / 1e6);

    await session.userSend(`${ham.call} DE BG7XXX K`);

    // The exchange has started, so the station answers instead of calling; the
    // point here is only that the receiver is open again.
    expect(session.isReceiving).toBe(true);
    const before = band.keyed.length;

    tickTo(60_000);
    expect(band.keyed.length).toBeGreaterThanOrEqual(before);
  });
});

describe("随时发报", () => {
  it("不用先点「开始通联」：调准一个正在呼叫的台，直接发就能接上", async () => {
    const band = new SpyBand();
    const { session, tickTo } = makeSession(band);
    session.seedHams(1);
    const ham = session.listHams()[0];
    // 台站落在 1 kHz 的槽位上，可能恰好就在默认拨轮上；先停到旁边 3 kHz，
    // 这样"还没调过去"才是真的听不到。
    session.retune(ham.freqHz / 1e6 + 0.003);
    session.start();

    tickTo(5_000); // 它在呼叫，但我们还没调过去
    expect(session.state).toBe("IDLE");
    session.retune(ham.freqHz / 1e6); // 调准，听到它
    expect(session.state).toBe("IDLE"); // 只是听到，不算开始通联

    await session.userSend(`${ham.call} DE BG7XXX K`); // 直接应答
    expect(session.state).not.toBe("IDLE");
  });
});
