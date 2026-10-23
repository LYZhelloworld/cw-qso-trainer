// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { QsoSession } from "./session.js";
import { normalizeSettings } from "./settingsSchema.js";
import { SpyBand } from "./bandSpy.js";
import { mulberry32 } from "../ham/spectrum.js";

/**
 * What the station on the other end does when the operator goes quiet.
 *
 * A real operator does not leave the key down and wait forever: they send the
 * same report again, and after a couple of tries they give up and start calling
 * CQ again. The band used to fall completely silent after one reply, which
 * reads as "the other station vanished" and leaves the QSO in limbo.
 */
function makeSession() {
  let t = 0;
  const ticks: Array<() => void> = [];
  const band = new SpyBand();
  const settings = normalizeSettings({ freqMHz: 14.05, myCall: "BG7XXX", wpm: 20 });
  const session = new QsoSession(14.05, settings, {
    rng: mulberry32(11),
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
  session.start();

  /** Move the clock and run the scheduler that drives the band. */
  const tickTo = async (ms: number): Promise<void> => {
    t = ms;
    for (const cb of ticks) cb();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };

  const hamLines = (): string[] =>
    session.lines.filter((l) => l.who === "ham").map((l) => l.text);
  const notices = (): string[] =>
    session.lines.filter((l) => l.who === "sys").map((l) => l.text);

  /** Tune onto a station and let it call CQ, so the operator can answer it. */
  const catchCq = async () => {
    session.seedHams(1);
    const ham = session.listHams()[0]!;
    session.retune(ham.freqHz / 1e6);
    await session.hamCallsCq();
    return ham;
  };

  return { session, band, tickTo, hamLines, notices, catchCq };
}

describe("对方台等不到回应", () => {
  it("沉默够久会把上一条报文重发一遍", async () => {
    const h = makeSession();
    const ham = await h.catchCq();
    await h.session.userSend(`${ham.call} DE BG7XXX K`);

    const first = h.hamLines().at(-1)!;
    const base = h.hamLines().length;
    expect(first).toContain("R UR RST");
    expect(h.session.state).toBe("EXCHANGE");

    // Nothing yet: the operator has only just gone quiet.
    await h.tickTo(3_000);
    expect(h.hamLines()).toHaveLength(base);

    // Patience expired: the station sends its report again, not silence.
    await h.tickTo(12_000);
    expect(h.hamLines().slice(base)).toEqual([first]);
    expect(h.session.state).toBe("EXCHANGE");
  });

  it("重发几次仍没人应就回到 CQ，而不是一直干等", async () => {
    const h = makeSession();
    const ham = await h.catchCq();
    await h.session.userSend(`${ham.call} DE BG7XXX K`);
    const first = h.hamLines().at(-1)!;
    const base = h.hamLines().length;
    const over = h.session.callDurationMs(first);

    // Two repeats, each armed after its own over ends.
    await h.tickTo(12_000);
    await h.tickTo(12_000 + over + 10_000);
    expect(h.hamLines().slice(base)).toEqual([first, first]);

    // The third expiry is the give-up: the QSO is dropped and the station is
    // back on the band, where its own CQ rhythm picks it up again.
    await h.tickTo(12_000 + (over + 10_000) * 2);
    expect(h.session.state).toBe("IDLE");
    expect(h.notices().some((t) => t.includes("回到 CQ"))).toBe(true);
    expect(h.session.listHams().map((x) => x.call)).toContain(ham.call);
  });

  it("操作者按时应答，等待就重新开始计时（不会被催）", async () => {
    const h = makeSession();
    const ham = await h.catchCq();

    await h.session.userSend(`${ham.call} DE BG7XXX K`); // report in, armed ~10 s
    await h.tickTo(6_000);
    await h.session.userSend("R UR RST 599 BK"); // operator answers in time
    const after = h.hamLines().length;
    expect(h.hamLines().at(-1)).toBe("R TU 73 SK");

    // The old deadline (10 s) is gone: no repeat at 11 s.
    await h.tickTo(11_000);
    expect(h.hamLines()).toHaveLength(after);
  });

  it("发射时不会插话：等待期间正在发报就不重发", async () => {
    const h = makeSession();
    const ham = await h.catchCq();
    await h.session.userSend(`${ham.call} DE BG7XXX K`);
    const before = h.hamLines().length;

    h.session.beginLiveKeying();
    await h.tickTo(30_000);
    expect(h.hamLines()).toHaveLength(before);

    await h.session.finishLiveKeying("R UR RST 599 BK");
    expect(h.session.isTransmitting).toBe(false);
  });
});

describe("对方台的 CQ 不会被自己打断", () => {
  it("报完 RST 之后对方回 73，而不是把自己的报告抄回来", async () => {
    const h = makeSession();
    const ham = await h.catchCq();

    await h.session.userSend(`${ham.call} DE BG7XXX K`);
    expect(h.hamLines().at(-1)).toMatch(/^R UR RST \d{3} BK$/);

    // Both reports are in — enough information for the contact to end.
    await h.session.userSend("R UR RST 599 BK");
    expect(h.hamLines().at(-1)).toBe("R TU 73 SK");
    expect(h.session.state).toBe("SIGNOFF");

    await h.session.userSend("R TU 73 SK");
    expect(h.session.state).toBe("LOGGED");
    expect(h.hamLines().at(-1)).toBe("73");
  });

  it("长报文的下一次 CQ 从报文结束算起，不会中途重来", async () => {    const h = makeSession();
    h.session.seedHams(1);
    const ham = h.session.listHams()[0]!;
    h.session.retune(ham.freqHz / 1e6);

    // Put the station's first CQ on the air at t = 0.
    await h.tickTo(0);
    await h.session.hamCallsCq();
    const text = h.hamLines().at(-1)!;
    const duration = h.session.callDurationMs(text);
    expect(duration).toBeGreaterThan(5_000); // a long call, as real CQs are

    const entry = h.session.band.activityState().find((e) => e.ham.call === ham.call)!;
    // The next burst starts after this one finishes keying, plus a listening
    // gap — never on top of its own message (which restarted it mid-stream).
    expect(entry.nextCqAt).toBeGreaterThanOrEqual(duration);
  });
});
