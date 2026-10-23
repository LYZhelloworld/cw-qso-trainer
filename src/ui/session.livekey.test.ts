import { describe, expect, it } from "vitest";
import { QsoSession } from "./session.js";
import { normalizeSettings } from "./settingsSchema.js";
import { SpyBand } from "./bandSpy.js";
import { QsoMachine } from "../qso/stateMachine.js";
import { dxccDatabase } from "../data/dxcc.js";
import { mulberry32 } from "../ham/spectrum.js";

/**
 * Live keying: the straight-key / paddle modes put the operator on the air
 * element by element, with no send step. The rig goes deaf on the first
 * key-down, the S-meter follows the key, and the decoded over is handed to the
 * band once the operator stops keying.
 */
function makeSession() {
  let t = 0;
  const band = new SpyBand();
  const settings = normalizeSettings({ freqMHz: 14.05, myCall: "BG7XXX", wpm: 20 });
  const session = new QsoSession(14.05, settings, {
    rng: mulberry32(7),
    now: () => t,
    referenceHz: 14_050_000,
    startTicking: () => () => {},
    delay: async () => {},
    pace: async () => {},
    synth: band,
  });
  session.setReceiving(true);
  return {
    session,
    band,
    at(ms: number): void {
      t = ms;
    },
  };
}

describe("实时键控（直键 / 双桨）", () => {
  it("第一个键按下就上机：发射中、接收机失聪", () => {
    const { session, band } = makeSession();

    expect(session.beginLiveKeying()).toBe(true);
    expect(session.isTransmitting).toBe(true);
    expect(band.transmitting).toContain(true);
  });

  it("按键期间不能再发文本报文（半双工，一次只发一条）", async () => {
    const { session, band } = makeSession();

    session.beginLiveKeying();
    await session.userSend("R BK");

    // 文本发送被忙锁挡住：没有新的监视音被敲上去。
    expect(band.mine).toEqual([]);
    expect(session.lines.some((l) => l.who === "me")).toBe(false);
  });

  it("S 表跟着键走：按住有读数，抬键即静", () => {
    const { session, at } = makeSession();
    at(1_000);
    session.beginLiveKeying();

    at(1_100);
    session.liveKeyDown();
    at(1_250);
    expect(session.sMeter()).not.toBeNull();

    at(1_300);
    session.liveKeyUp();
    at(1_400);
    expect(session.sMeter()).toBeNull();
  });

  it("发完把解码文本当作一帧报文记下，并关闭载波", async () => {
    const { session } = makeSession();

    session.beginLiveKeying();
    session.liveKeyDown();
    session.liveKeyUp();
    await session.finishLiveKeying("r ur rst 599 bk");

    const mine = session.lines.filter((l) => l.who === "me");
    expect(mine.map((l) => l.text)).toEqual(["R UR RST 599 BK"]);
    expect(session.isTransmitting).toBe(false);
  });

  it("空的一轮只闭载波，不留下报文", async () => {
    const { session } = makeSession();

    session.beginLiveKeying();
    await session.finishLiveKeying("   ");

    expect(session.lines.some((l) => l.who === "me")).toBe(false);
    expect(session.isTransmitting).toBe(false);
  });

  it("键控发出的 CQ 会拉起堆叠", async () => {
    const { session } = makeSession();

    session.beginLiveKeying();
    await session.finishLiveKeying("CQ CQ CQ DE BG7XXX BG7XXX PSE K");

    // The pile-up itself is private; a beat after a CQ it must be open, even
    // though on this empty band nobody has answered yet.
    const pileup = (session as unknown as { pileup: { active: boolean } }).pileup;
    expect(pileup.active).toBe(true);
  });

  it("键控报文与文本报文走同一套判定：点名的台会回话", async () => {
    const { session } = makeSession();
    session.seedHams(2);
    const [a, b] = session.listHams();
    // 调到 A 上，并让它处在呼叫状态。
    (a as unknown as { freqHz: number }).freqHz = session.dialHz;
    session.band.advance(1e9);
    // 预置状态：另一台的 CQ 已经占住会话机（错误应答的成因）。
    session.ham = b;
    session.machine = new QsoMachine({ myCall: "BG7XXX", ham: b, db: dxccDatabase });
    session.machine.hamCq();

    session.beginLiveKeying();
    await session.finishLiveKeying(`${a.call} DE BG7XXX K`);

    expect(session.ham?.call).toBe(a.call);
    expect(session.state).toBe("EXCHANGE");
  });

  it("关台时不能开载波", () => {
    const { session } = makeSession();
    session.setReceiving(false);

    expect(session.beginLiveKeying()).toBe(false);
    expect(session.isTransmitting).toBe(false);
  });
});
