import { describe, expect, it } from "vitest";
import { QsoSession } from "./session.js";
import { normalizeSettings } from "./settingsSchema.js";
import { mulberry32 } from "../ham/spectrum.js";

/** 20 m CW reference — where this band's stations live. */
const REF = 14_025_000;

/** A session with the clock and the CQ rhythm both under test control. */
function makeSession(rng: () => number = mulberry32(7)) {
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

/** Pick the only station on the band, put the dial on it, and let it call. */
async function tuneToOneCalling(session: QsoSession) {
  session.seedHams(1);
  const ham = session.listHams()[0];
  session.retune(ham.freqHz / 1e6);
  await session.hamCallsCq();
  return ham;
}

describe("会话 — S 表读数", () => {
  it("波段上没有信号时表针没有读数", () => {
    const { session } = makeSession();
    expect(session.sMeter()).toBeNull();
  });

  it("收到报文时给出读数，且与 RST 的 S 位一致", async () => {
    const { session } = makeSession();
    const ham = await tuneToOneCalling(session);

    const reading = session.sMeter();
    expect(reading).not.toBeNull();
    // 台上报的 S 位就是模拟强度，读回来不会差出半段以外。
    const reportedS = Number(ham.report[1]);
    expect(Math.abs(reading!.s - reportedS)).toBeLessThanOrEqual(2);
    expect(reading!.label).toMatch(/^S\d(\+\d+)?$/);
  });

  it("报文发完、台上守听时表针归零（没声音就没有读数）", async () => {
    const { session, setTime } = makeSession();
    await tuneToOneCalling(session);
    expect(session.sMeter()).not.toBeNull();

    setTime(10 * 60_000); // 早就发完了，台在守听
    expect(session.sMeter()).toBeNull();
  });

  it("调离通带表针下落，出了裙边就没有信号", async () => {
    const { session } = makeSession();
    const ham = await tuneToOneCalling(session);
    const aligned = session.sMeter();
    expect(aligned).not.toBeNull();

    // 300 Hz off a 500 Hz filter: still on the skirt, and the needle drops.
    session.retune((ham.freqHz + 300) / 1e6);
    const skirt = session.sMeter();
    expect(skirt).not.toBeNull();
    expect(skirt!.dbm).toBeLessThan(aligned!.dbm);

    // Well past the skirt: the filter has cut it off, nothing to point at.
    session.retune((ham.freqHz + 4_000) / 1e6);
    expect(session.sMeter()).toBeNull();
  });

  it("表针随 QSB 起伏：同一台、不同时刻读数不同", async () => {
    const { session, setTime } = makeSession();
    await tuneToOneCalling(session);

    const first = session.sMeter()!.dbm;
    setTime(3_000); // 同一条报文还在发，只是衰落变了
    const later = session.sMeter()!.dbm;
    expect(later).not.toBe(first);
  });

  it("同一张键控表：点划间隙里瀑布已经暗了，表针还抬着（表按整条报文算）", async () => {
    const { session, setTime } = makeSession();
    const ham = await tuneToOneCalling(session);
    const dur = session.callDurationMs(`CQ CQ CQ DE ${ham.call} ${ham.call} PSE K`);

    let lit = false;
    let darkButReading = false;
    for (let at = 0; at < dur; at += 5) {
      setTime(at);
      const sig = session.spectrum().signals.find((s) => s.call === ham.call);
      expect(sig).toBeDefined();
      if (sig!.active) lit = true;
      // 间隙：载波不在（瀑布不画），但这条报文还没发完，表针不该抖下去
      else if (session.sMeter() !== null) darkButReading = true;
    }
    expect(lit).toBe(true);
    expect(darkButReading).toBe(true);
  });

  it("堆叠应答也进 S 表：有声就该有读数，不管是谁把台放上去的", async () => {
    const { session, tickTo } = makeSession();
    session.seedHams(4);
    session.start();
    await session.userCallsCq();
    expect(session.pileupCallers().length).toBeGreaterThan(0);

    // 让第一台应答（堆叠只报 keyingUntil，没有逐条报文的播放簿记）
    let answered = false;
    for (let at = 250; at <= 20_000 && !answered; at += 250) {
      await tickTo(at);
      answered = session.lines.some((l) => l.who === "ham");
    }
    expect(answered).toBe(true);
    expect(session.sMeter()).not.toBeNull();
  });

  it("调到一条正在发的 CQ 中间：声音接上来，表针也得抬起来", async () => {
    const { session, tickTo } = makeSession();
    session.seedHams(1);
    const ham = session.listHams()[0];
    // 先调离它：这条 CQ 在别处发，我们听不到，但它被记账了
    session.retune((ham.freqHz + 5_000) / 1e6);
    session.start();

    let onAir = false;
    for (let at = 250; at <= 20_000 && !onAir; at += 250) {
      await tickTo(at);
      onAir = session
        .spectrum()
        .signals.some((sig) => sig.call === ham.call && sig.active);
    }
    expect(onAir).toBe(true);
    expect(session.sMeter()).toBeNull(); // 在通带外，听不到就没有读数

    // 中途把拨轮调过去：音频从半路接上（rejoinOnAir），表针必须跟着动
    session.retune(ham.freqHz / 1e6);
    expect(session.sMeter()).not.toBeNull();
  });
});
