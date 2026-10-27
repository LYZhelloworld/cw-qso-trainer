import { describe, expect, it } from "vitest";
import { QsoSession } from "../../src/ui/session.js";
import { normalizeSettings } from "../../src/ui/settingsSchema.js";
import { cutNumbers } from "../../src/message/macros.js";
import { formatZone, zoneOfCall, type ContestKind } from "../../src/qso/contest.js";

/**
 * The session's side of a contest: the words on the air, and the truth the log
 * is checked against.
 *
 * A constant RNG keeps the station's difficulty (and therefore its chance of
 * missing what we send) out of the picture: `0.1` picks `novice`, which never
 * misses.
 */
function contestSession(kind: ContestKind) {
  const settings = normalizeSettings({ myCall: "BG7XXX", contest: kind, difficulty: "novice" });
  const session = new QsoSession(14.025, settings, {
    rng: () => 0.1,
    delay: async () => {},
    pace: async () => {},
  });
  session.seedHams(1);
  const station = session.listHams()[0];
  session.retune(station.freqHz / 1e6);
  return { session, station };
}

describe("比赛模式下的会话", () => {
  it("CQWW：虚拟台喊 CQ TEST，我方报到，对方连报告带分区一起给", async () => {
    const { session } = contestSession("CQWW");
    await session.hamCallsCq();
    const peer = session.ham!.call;

    expect(session.lines.at(-1)?.text).toBe(`CQ TEST ${peer} ${peer}`);

    const truth = session.partnerTruth();
    expect(truth).toMatchObject({ call: peer, report: "599" });
    // 分区来自呼号所属的 DXCC 实体，补成两位。
    expect(truth?.exch).toBe(formatZone(zoneOfCall(peer)!));

    // S&P：先报自己的呼号，主叫台一个回合把报告与分区都给全。
    await session.userSend("BG7XXX");
    expect(session.state).toBe("EXCHANGE");
    expect(session.lines.at(-1)?.text).toBe(`BG7XXX 5NN ${cutNumbers(truth!.exch)}`);

    // 我方回 5NN + 分区，主叫台说 TU。
    await session.userSend("5NN U4");
    expect(session.state).toBe("SIGNOFF");
    expect(session.lines.at(-1)?.text).toBe("TU");

    await session.userSend("TU");
    expect(session.state).toBe("LOGGED");
    // 落账那一刻还没发生，但真相要一直拿得到：录入行就是在这个时候取的。
    expect(session.partnerTruth()).toEqual(truth);
  });

  it("WPX：双方交换的是序号，编号从 001 起", async () => {
    const { session } = contestSession("WPX");
    await session.hamCallsCq();
    const truth = session.partnerTruth();
    expect(truth?.exch).toMatch(/^\d{3}$/);
  });

  it("DX 不变：对方发自己的报告，没有交换信息", async () => {
    const { session } = contestSession("DX");
    await session.hamCallsCq();
    expect(session.lines.at(-1)?.text).toMatch(/^CQ CQ CQ DE .+ PSE K$/);
    const truth = session.partnerTruth();
    expect(truth?.exch).toBe("");
    expect(truth?.report).toMatch(/^[1-5][1-9][1-9]$/);
  });
});
