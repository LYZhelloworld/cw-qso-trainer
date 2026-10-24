import { describe, expect, it } from "vitest";
import { QsoSession } from "../../src/ui/session.js";
import { normalizeSettings } from "../../src/ui/settingsSchema.js";
import { SpyBand } from "../support/bandSpy.js";
import type { VirtualHam } from "../../src/ham/virtualHam.js";

/** Small LCG: a constant rng would generate the same callsign forever. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    return a / 4294967296;
  };
}

/**
 * HAM-to-HAM exchanges are background life on the band: a station that is
 * calling CQ gets answered by somebody out of the listening pool, they run the
 * scripted six-line QSO, and the whole thing is audible only when the dial sits
 * on that frequency.
 *
 * There is deliberately no accessor for "is a pair working right now" — nobody
 * can see another station's QSO, so the session does not report one. Everything
 * below is asserted through what an operator could observe: the band's roster
 * (one station busy, the rest untouched), and the audio produced when you tune
 * onto it.
 */
function makeSession(seed = 11) {
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

  /**
   * A dial setting with no station inside the passband: 50 kHz past the band
   * reference, outside the ±25 kHz slice, so no CQ is picked up and the operator
   * stays out of any QSO while the band lives its own life.
   */
  session.retune(14.1);

  /**
   * The station on the band that is busy working somebody. The answerer is not
   * on the roster — it holds no slot — so exactly one station ever shows up
   * here, and its frequency is the one to tune to.
   */
  const busy = (): VirtualHam | null => {
    if (session.inQso) return null;
    const working = session.hamActivity().filter((e) => e.state === "inQso");
    return working.length === 1 ? working[0].ham : null;
  };

  return {
    session,
    band,
    tickTo,
    busy,
    now: () => t,
    /** Step the clock until a background exchange appears. */
    async untilExchange(maxMs = 200_000): Promise<VirtualHam> {
      for (let at = 1_000; at <= maxMs; at += 1_000) {
        await tickTo(at);
        const found = busy();
        if (found) return found;
      }
      throw new Error("波段上一直没有出现互相通联");
    },
    /** Step 0.5 s at a time until the exchange ends; returns where it ended. */
    async runToEnd(step = 500, maxMs = 180_000): Promise<number | null> {
      const from = t;
      for (let at = from + step; at <= from + maxMs; at += step) {
        await tickTo(at);
        if (!busy()) return at;
      }
      return null;
    },
  };
}

describe("HAM 互相通联（后台，对操作者不可见）", () => {
  it("应答方来自守听池：频段台数不变，只多出一个忙着的台", async () => {
    const h = makeSession();
    const before = h.session.seedHams(4).map((x) => x.call);
    h.session.start();

    const caller = await h.untilExchange();
    expect(before).toContain(caller.call); // 呼叫方本来就是频段上的台
    // 应答方不占频率槽：频段名单仍是原来那 4 台，没有多出一台。
    expect(h.session.hamActivity().map((e) => e.ham.call).sort()).toEqual([...before].sort());
    expect(caller.freqHz % 1_000).toBe(0);
  });

  it("调过去就能听到完整的 6 行；应答方从来不在频段名单上", async () => {
    const h = makeSession();
    h.session.seedHams(4);
    h.session.start();
    const caller = await h.untilExchange();

    // 他们一直在发（台站照发，只是不在我们的通带里），但表针不动：
    // 听不听得到由接收机决定，不由台站闭不闭嘴决定。
    expect(h.session.sMeter()).toBeNull();
    h.session.retune(caller.freqHz / 1e6);
    const endedAt = await h.runToEnd();
    expect(endedAt).not.toBeNull();

    // 调到它上面之后，剧本的六行一行不落地敲了出来，而且顺序不乱。
    // 频段上别的台也在发，所以按内容挑出这一对的行，不能按下标。
    const texts = h.band.texts;
    const answerLine = texts.find((t) => t.startsWith(`${caller.call} DE `));
    expect(answerLine).toBeDefined();
    const script = [
      `CQ CQ CQ DE ${caller.call} ${caller.call} PSE K`,
      answerLine!,
      "R UR RST 599 599 BK",
      "R UR RST 599 BK",
      "R TU 73 SK",
      "R TU 73 SK",
    ];
    const at = script.map((line) => texts.indexOf(line));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    const answerer = answerLine!.split(" ")[2];
    // 守听的那个台从头到尾没进过频段名单：它没有频率，也不该有。
    expect(h.session.hamActivity().some((e) => e.ham.call === answerer)).toBe(false);
  });

  it("在这个频率上发 CQ 插不进去：没有人应答，那一对照样把话说完", async () => {
    const h = makeSession();
    h.session.seedHams(4);
    h.session.start();
    const caller = await h.untilExchange();
    h.session.retune(caller.freqHz / 1e6);

    h.band.clear();
    await h.session.userCallsCq();

    // 自己的 CQ 发出去了，但没有任何台应答：没有堆叠、没有解释、也没有提示。
    expect(h.band.texts).toEqual(["CQ CQ CQ DE BG7XXX BG7XXX PSE K"]);
    expect(h.session.pileupCallers()).toHaveLength(0);
    expect(h.session.state).toBe("IDLE");
    expect(h.session.lines.some((l) => l.text.includes("通联"))).toBe(false);

    // 那一对既没有让位也没有被打断，仍在原频率上通联。
    expect(h.busy()).not.toBeNull();
    const from = h.now();
    for (let at = from + 1_000; at <= from + 20_000; at += 1_000) {
      await h.tickTo(at);
    }
    expect(h.band.texts.length).toBeGreaterThan(1);
  });

  it("通联结束后，原来那个呼叫方接着呼叫 CQ", async () => {
    const h = makeSession();
    h.session.seedHams(4);
    h.session.start();
    const caller = await h.untilExchange();
    h.session.retune(caller.freqHz / 1e6);

    expect(await h.runToEnd()).not.toBeNull();
    const ownCq = `CQ CQ CQ DE ${caller.call} ${caller.call} PSE K`;
    const cqsBefore = h.band.texts.filter((c) => c === ownCq).length;

    // 签完 73 后几秒内重新开口（2–6 s），而不是等 30–60 s 的常规间隔。
    let seenCqing = false;
    for (let at = h.now() + 500; at <= h.now() + 10_000; at += 500) {
      await h.tickTo(at);
      if (h.session.hamActivity().some((e) => e.ham.call === caller.call && e.state === "cqing")) {
        seenCqing = true;
        break;
      }
    }
    expect(seenCqing).toBe(true);
    // 又多敲了一次 CQ：签名之后它回到自己的呼叫节奏
    expect(h.band.texts.filter((c) => c === ownCq).length).toBeGreaterThan(cqsBefore);
  });

  it("应答方不被当成可通联对象：它根本不在名单上", async () => {
    const h = makeSession();
    h.session.seedHams(4);
    h.session.start();
    const caller = await h.untilExchange();
    h.session.retune(caller.freqHz / 1e6);

    expect(h.session.heardActiveHam()).toBeNull();
    const nearest = h.session.nearestWorkableHam();
    expect(nearest?.call).not.toBe(caller.call);
  });

  it("结束后频段原样：还是那几台，各占一个槽，没有多出来的台", async () => {
    const h = makeSession();
    const before = h.session.seedHams(4).map((x) => [x.call, x.freqHz] as const);
    h.session.start();
    await h.untilExchange();

    await h.runToEnd();

    const after = h.session.hamActivity();
    expect(after).toHaveLength(before.length);
    expect(new Set(after.map((e) => e.ham.freqHz)).size).toBe(before.length); // 各占一个槽
    for (const [call, freqHz] of before) {
      expect(after.find((e) => e.ham.call === call)?.ham.freqHz).toBe(freqHz);
    }
    expect(after.every((e) => e.state !== "inQso")).toBe(true);
  });

  it("操作者自己正在通联时，后台不会插入一对", async () => {
    const h = makeSession();
    h.session.seedHams(4);
    // 对准某个台，等它呼叫，进入 PEER_CQ
    h.session.retune(h.session.listHams()[0].freqHz / 1e6);
    h.session.start();
    for (let at = 1_000; at <= 30_000 && !h.session.inQso; at += 1_000) {
      await h.tickTo(at);
    }
    expect(h.session.inQso).toBe(true);

    const from = h.now();
    for (let at = from + 1_000; at <= from + 120_000; at += 1_000) {
      await h.tickTo(at);
    }
    // 除了操作者自己那台，没有任何台在后台通联。
    const working = h.session.hamActivity().filter((e) => e.state === "inQso");
    expect(working.length).toBeLessThanOrEqual(1);
  });
});
