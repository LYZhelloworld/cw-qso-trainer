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
});
