import { describe, expect, it } from "vitest";
import { QsoSession } from "../../src/ui/session.js";
import { normalizeSettings } from "../../src/ui/settingsSchema.js";

/** Small LCG: a constant rng would generate the same callsign forever. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    return a / 4294967296;
  };
}

/**
 * Pile-up wiring. Time is injected exactly as in `session.activity.test.ts`, so
 * the staggered silences can be driven in milliseconds instead of real seconds.
 */
function makeSession(seed = 7) {
  let t = 0;
  const ticks: Array<() => void> = [];
  const waits: number[] = [];
  const settings = normalizeSettings({ freqMHz: 14.05, myCall: "BG7XXX" });
  const session = new QsoSession(14.05, settings, {
    rng: seeded(seed),
    now: () => t,
    startTicking: (cb) => {
      ticks.push(cb);
      return () => {};
    },
    pace: async () => {},
    delay: async (ms: number) => {
      waits.push(ms);
    },
  });

  const tickTo = async (ms: number): Promise<void> => {
    t = ms;
    for (const cb of ticks) cb();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };

  return {
    session,
    waits,
    tickTo,
    /** Step the clock until a station answers, and report when it did. */
    async untilHam(maxMs = 20_000, step = 250): Promise<number | null> {
      for (let at = step; at <= maxMs; at += step) {
        await tickTo(at);
        if (session.lines.some((l) => l.who === "ham")) return at;
      }
      return null;
    },
  };
}

describe("用户发 CQ 后的堆叠", () => {
  it("2–3 台同时应答，全部落在拨轮频率上", async () => {
    const h = makeSession();
    await h.session.userCallsCq();

    const callers = h.session.pileupCallers();
    expect(callers.length).toBeGreaterThanOrEqual(2);
    expect(callers.length).toBeLessThanOrEqual(3);
    for (const c of callers) expect(c.freqHz).toBe(h.session.dialHz);
    expect(h.session.state).toBe("USER_CQ");
    expect(h.session.inQso).toBe(true);
    expect(h.session.ham).toBeNull(); // 还没有点名，没有「对方」
  });

  it("应答者来自守听池：频段名单一台都不多", async () => {
    const h = makeSession();
    h.session.seedHams(4);
    h.session.start();
    const before = h.session
      .hamActivity()
      .map((e) => e.ham.call)
      .sort();

    await h.session.userCallsCq();
    const callers = h.session.pileupCallers();
    expect(callers.length).toBeGreaterThanOrEqual(2);
    // 它们不占频率：频段上还是那 4 台。
    expect(
      h.session
        .hamActivity()
        .map((e) => e.ham.call)
        .sort(),
    ).toEqual(before);
    for (const c of callers) expect(c.role).toBe("answerer");

    // 点名之后仍然是同一批台：应答方是池里的人，不是从频段上拉下来的。
    await h.untilHam();
    const chosen = h.session.heardPileupCallers()[0];
    await h.session.userSend(`${chosen.call} DE BG7XXX K`);
    expect(h.session.ham?.call).toBe(chosen.call);
    expect(
      h.session
        .hamActivity()
        .map((e) => e.ham.call)
        .sort(),
    ).toEqual(before);
  });

  it("每台隔开一段自己的静默后才报呼号", async () => {
    const h = makeSession();
    h.session.start();
    await h.session.userCallsCq();

    const at = await h.untilHam();
    expect(at).not.toBeNull();
    const line = h.session.lines.find((l) => l.who === "ham")!;
    expect(h.session.pileupCallers().some((c) => line.text.includes(c.call))).toBe(true);
    // 只报一台，不是三台同时响
    expect(h.session.lines.filter((l) => l.who === "ham")).toHaveLength(1);
  });

  it("关台时不发 CQ、不产生堆叠", async () => {
    const h = makeSession();
    h.session.setReceiving(false);

    await h.session.userCallsCq();
    expect(h.session.pileupCallers()).toHaveLength(0);
    expect(h.session.lines).toHaveLength(0);
  });
});

describe("点名", () => {
  it("点名后该台成为通联对象，并回 RST", async () => {
    const h = makeSession();
    h.session.start();
    await h.session.userCallsCq();
    await h.untilHam();

    const chosen = h.session.heardPileupCallers()[0];
    expect(chosen).toBeDefined();
    await h.session.userSend(`${chosen.call} DE BG7XXX K`);

    expect(h.session.state).toBe("EXCHANGE");
    expect(h.session.ham?.call).toBe(chosen.call);
    expect(h.session.pileupCallers()).toHaveLength(0);
    expect(
      h.session.lines.some((l) => l.who === "ham" && l.text.includes("R UR RST")),
    ).toBe(true);
  });

  it("不点名就不推进：各台继续等待，并且不产生通联对象", async () => {
    const h = makeSession();
    h.session.start();
    await h.session.userCallsCq();
    await h.untilHam();

    await h.session.userSend("R BK");

    expect(h.session.state).toBe("USER_CQ");
    expect(h.session.ham).toBeNull();
    expect(h.session.pileupCallers().length).toBeGreaterThan(0);
    expect(
      h.session.lines.some((l) => l.who === "sys" && l.text.includes("没有点名")),
    ).toBe(true);
  });

  it("没人被点名时，各台重呼够次数后离场", async () => {
    const h = makeSession();
    h.session.start();
    await h.session.userCallsCq();

    for (let at = 1_000; at <= 120_000; at += 1_000) await h.tickTo(at);

    expect(h.session.pileupCallers()).toHaveLength(0);
    expect(h.session.state).toBe("IDLE");
    expect(h.session.inQso).toBe(false);
  });
});

describe("堆叠中的会话状态", () => {
  it("reset 会把临时应答台全部放回/清出", async () => {
    const h = makeSession();
    await h.session.userCallsCq();
    const calls = h.session.pileupCallers().map((c) => c.call);
    expect(calls.length).toBeGreaterThan(0);

    h.session.reset();
    expect(h.session.pileupCallers()).toHaveLength(0);
    expect(h.session.inQso).toBe(false);
    expect(h.session.lines).toHaveLength(0);
  });
});
