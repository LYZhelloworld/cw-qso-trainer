import { describe, expect, it } from "vitest";
import { QsoSession } from "../../src/ui/session.js";
import { normalizeSettings } from "../../src/ui/settingsSchema.js";
import { SpyBand } from "../support/bandSpy.js";
import { QsoMachine } from "../../src/qso/stateMachine.js";
import { dxccDatabase } from "../../src/data/dxcc.js";
import { mulberry32 } from "../../src/ham/spectrum.js";

/**
 * Live keying: the straight-key / paddle modes put the operator on the air
 * element by element, with no send step. The rig goes deaf on the first
 * key-down, the S-meter follows the key, and the decoded over is handed to the
 * band once the operator stops keying.
 */
/** Holds `pace` open so a test can look at a reply while it is being played. */
class Gate {
  private open = true;
  private pending: Array<() => void> = [];

  wait = (): Promise<void> =>
    this.open ? Promise.resolve() : new Promise<void>((resolve) => this.pending.push(resolve));

  hold(): void {
    this.open = false;
  }
  release(): void {
    this.open = true;
    for (const resolve of this.pending.splice(0)) resolve();
  }
}

function makeSession(pace: (ms: number) => Promise<void> = async () => {}) {
  let t = 0;
  const band = new SpyBand();
  const settings = normalizeSettings({ freqMHz: 14.05, myCall: "BG7XXX", wpm: 20 });
  const session = new QsoSession(14.05, settings, {
    rng: mulberry32(7),
    now: () => t,
    referenceHz: 14_050_000,
    startTicking: () => () => {},
    delay: async () => {},
    pace,
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

/** `keyHeld` lives on the transmitter; the test needs to see it directly. */
function keyHeldOf(session: QsoSession): boolean {
  return (session as unknown as { keying: { keyHeld: boolean } }).keying.keyHeld;
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

  it("面板在半途被拆掉（离开页面）：载波落下、可以重新上机", () => {
    const { session, band } = makeSession();
    session.beginLiveKeying();
    session.liveKeyDown();
    expect(session.isSending).toBe(true);
    expect(session.isTransmitting).toBe(true);

    session.cancelLiveKeying();

    expect(session.isSending).toBe(false);
    expect(session.isTransmitting).toBe(false);
    expect(session.isReceiving).toBe(true);
    expect(band.transmitting.at(-1)).toBe(false);
    // 载波落下时键不可能还按着：keyHeld 不能残留 true
    expect(keyHeldOf(session)).toBe(false);
    // 没有留下"永远在发"的锁：再敲一次仍然能上机
    expect(session.beginLiveKeying()).toBe(true);
  });

  it("发报途中切波段（reset）不会把那个波段卡在发射状态", () => {
    const { session, band } = makeSession();
    session.beginLiveKeying();
    session.liveKeyDown();

    session.reset(); // App 在换波段时调的就是这个

    expect(session.isSending).toBe(false);
    expect(session.isTransmitting).toBe(false);
    expect(session.isReceiving).toBe(true);
    expect(band.transmitting.at(-1)).toBe(false);
    expect(keyHeldOf(session)).toBe(false);
    expect(session.beginLiveKeying()).toBe(true);
  });

  it("对方回复还没播完就按键：打断它、开始新的一轮，而不是被锁住", async () => {
    const gate = new Gate();
    const { session, band } = makeSession(() => gate.wait());

    // 先把会话放进一个"对方刚报完、正在等我们"的通联里。
    session.seedHams(1);
    const peer = session.listHams()[0];
    (peer as unknown as { freqHz: number }).freqHz = session.dialHz;
    session.ham = peer;
    session.machine = new QsoMachine({ myCall: "BG7XXX", ham: peer, db: dxccDatabase });
    session.machine.hamCq();

    // 发一帧。回复会在 pace 上卡住（gate），这时 sending 仍然为真。
    session.beginLiveKeying();
    const over = session.finishLiveKeying(`R UR RST 599 BK`);
    gate.hold();
    await Promise.resolve(); // 让 dispatch 走到播放回复那一步
    expect(session.isSending).toBe(true);
    expect(session.isTransmitting).toBe(false);

    // 再按键：必须能上机，而不是返回 false。
    expect(session.beginLiveKeying()).toBe(true);
    expect(session.isTransmitting).toBe(true);
    // 对方那一路载波被掐断，不能盖在新的一帧上。
    expect(band.silenced).toContain(peer.call);

    // 旧的那一帧醒来后发现已经过时，不应把新的状态清掉。
    gate.release();
    await over;
    expect(session.isTransmitting).toBe(true);
    expect(session.isSending).toBe(true);

    session.cancelLiveKeying();
  });
});
