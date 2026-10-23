// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { QsoSession } from "./session.js";
import { normalizeSettings } from "./settingsSchema.js";
import { SpyBand } from "./bandSpy.js";

/** Small LCG: a constant rng would generate the same callsign forever. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    return a / 4294967296;
  };
}

function makeSession(seed = 7) {
  let t = 0;
  const ticks: Array<() => void> = [];
  const band = new SpyBand();
  const settings = normalizeSettings({ freqMHz: 14.05, myCall: "BG7XXX" });
  const session = new QsoSession(14.05, settings, {
    rng: seeded(seed),
    now: () => t,
    startTicking: (cb) => {
      ticks.push(cb);
      return () => {};
    },
    delay: async () => {},
    pace: async () => {},
    synth: band,
    referenceHz: 14_050_000,
  });

  const tickTo = async (ms: number): Promise<void> => {
    t = ms;
    for (const cb of ticks) cb();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };

  /** The system lines the operator was told about. */
  const notices = (): string[] =>
    session.lines.filter((l) => l.who === "sys").map((l) => l.text);

  return { session, band, tickTo, notices };
}

/**
 * What happens to a line the operator keys while their own CQ is still being
 * answered. Two very different intentions look alike on the air:
 *
 *  - naming one of the stations answering me (pick a caller out of the pile-up),
 *  - naming somebody else entirely (I have moved on and am answering *that* CQ).
 *
 * The second one used to be swallowed: the message went out, the pile-up said
 * "nobody was named", and the station the operator was actually calling never
 * heard a reply. Nothing was wrong with the audio — the session had decided the
 * message was not meant for anybody.
 */
describe("堆叠还在，操作者已经转去回答别的台", () => {
  it("点名不在应答名单里的台：放弃堆叠，消息照常送出去", async () => {
    const h = makeSession();
    h.session.start();
    await h.session.userCallsCq();

    const callers = h.session.pileupCallers().map((c) => c.call);
    expect(callers.length).toBeGreaterThan(0);

    // A legal callsign that is deliberately not one of the answerers.
    const outsider = "ZZ9ZZ";
    expect(callers).not.toContain(outsider);

    await h.session.userSend(`${outsider} DE BG7XXX K`);

    // The pile-up is over — the operator left it — and nothing was reported as
    // "you did not name anybody", because they did name somebody.
    expect(h.session.pileupCallers()).toHaveLength(0);
    expect(h.notices().some((t) => t.includes("没有点名任何一台"))).toBe(false);
    expect(h.session.state).not.toBe("USER_CQ");
  });

  it("没有呼号的行仍然算没点名：堆叠继续等着", async () => {
    const h = makeSession();
    h.session.start();
    await h.session.userCallsCq();
    const before = h.session.pileupCallers().length;
    expect(before).toBeGreaterThan(0);

    await h.session.userSend("R R R");

    // Naming the station *is* the skill a pile-up teaches, so a bare "R R R"
    // still gets the boot: the callers stay and try again.
    expect(h.session.pileupCallers()).toHaveLength(before);
    expect(h.notices().some((t) => t.includes("没有点名任何一台"))).toBe(true);
  });
});

/**
 * A machine in `USER_CQ` is waiting for an answer to *our* call. Nothing in the
 * running loop ever leaves that state on its own (`timeoutFirstCall` exists on
 * the machine but was never driven), so a session restored from staging could
 * sit there forever: every later reply handed to it came back as an empty list,
 * and the operator heard their own keying followed by nothing.
 */
describe("自己呼过 CQ 之后没人回", () => {
  const KEY = "cw-qso-trainer:qso-staging";

  function makeSession(clock: () => number, ticks: Array<() => void>) {
    const settings = normalizeSettings({ freqMHz: 14.05, myCall: "BG7XXX" });
    return new QsoSession(14.05, settings, {
      rng: () => 0,
      now: clock,
      startTicking: (cb) => {
        ticks.push(cb);
        return () => {};
      },
      delay: async () => {},
      pace: async () => {},
    });
  }

  beforeEach(() => localStorage.clear());

  it("恢复出一个卡在等待回应的通话：安静够久就回到守听", async () => {
    let t = 0;
    const ticks: Array<() => void> = [];
    const first = makeSession(() => t, ticks);
    first.seedHams(1);
    const ham = first.listHams()[0]!;
    first.retune(ham.freqHz / 1e6);
    await first.hamCallsCq();

    // The staging snapshot is a real one; only the state moved, to the one a
    // refresh can restore into.
    const raw = JSON.parse(localStorage.getItem(KEY)!) as {
      freqMHz: number;
      machine: { state: string };
    };
    expect(raw.machine.state).toBe("PEER_CQ");
    raw.machine.state = "USER_CQ";
    localStorage.setItem(KEY, JSON.stringify(raw));

    const restoredTicks: Array<() => void> = [];
    const second = makeSession(() => t, restoredTicks);
    second.retune(raw.freqMHz); // staging only restores onto its own frequency
    second.restoreStaging();
    second.start(); // the scheduler is what expires a call nobody answered
    expect(second.state).toBe("USER_CQ");

    // Not yet: the band has only just gone quiet.
    for (const cb of restoredTicks) cb();
    t = 10_000;
    for (const cb of restoredTicks) cb();
    expect(second.state).toBe("USER_CQ");

    // Long enough with nobody answering: back to listening, and told why.
    t = 20_000;
    for (const cb of restoredTicks) cb();
    expect(second.state).toBe("IDLE");
    expect(second.lines.some((l) => l.who === "sys" && l.text.includes("没有人回应"))).toBe(true);
  });
});
