import { describe, expect, it } from "vitest";
import { QsoSession } from "./session.js";
import { normalizeSettings } from "./settingsSchema.js";
import type { AudioPlayer, PlaybackHandle } from "../audio/engine.js";
import type { VirtualHam } from "../ham/virtualHam.js";

/** Small LCG: a constant rng would generate the same callsign forever. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
    return a / 4294967296;
  };
}

class FakeAudio implements AudioPlayer {
  calls: string[] = [];
  readonly playbackAvailable = true;
  play(text: string): PlaybackHandle {
    this.calls.push(text);
    return { done: Promise.resolve(), stop() {} };
  }
  stop(): void {}
}

/** Two stations sharing one frequency, both flagged in-QSO: a background pair. */
interface BackgroundPair {
  a: VirtualHam;
  b: VirtualHam;
}

/**
 * HAM-to-HAM exchanges are background life on the band: they start on their own,
 * run a scripted six-line QSO at the operator's keying speed, and are audible
 * only when the dial sits on their frequency.
 *
 * There is deliberately no accessor for "is a pair working right now" — nobody
 * can see another pair's QSO, so the session does not report one. Everything
 * below is therefore asserted through what an operator could actually observe:
 * two stations sharing a slot with nobody answering them (shown here through
 * their activity state), and the audio they produce when you tune onto them.
 */
function makeSession(seed = 11) {
  let t = 0;
  const ticks: Array<() => void> = [];
  const audio = new FakeAudio();
  const settings = normalizeSettings({ freqMHz: 14.05, myCall: "BG7XXX" });
  const session = new QsoSession(14.05, settings, {
    rng: seeded(seed),
    now: () => t,
    startTicking: (cb) => {
      ticks.push(cb);
      return () => {};
    },
    delay: async () => {},
    engine: audio,
    referenceHz: 14_050_000,
  });

  const tickTo = async (ms: number): Promise<void> => {
    t = ms;
    for (const cb of ticks) cb();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  };

  /**
   * A dial setting with no station inside the passband: 25 kHz past the edge of
   * the band slice (±25 kHz), so no CQ is picked up and the operator stays out
   * of any QSO while the band lives its own life.
   */
  session.retune(14.1);

  /** The background pair, if the band has one and we are not in a QSO. */
  const pair = (): BackgroundPair | null => {
    if (session.inQso) return null;
    const working = session.hamActivity().filter((e) => e.state === "inQso");
    for (let i = 0; i < working.length; i += 1) {
      for (let j = i + 1; j < working.length; j += 1) {
        const a = working[i].ham;
        const b = working[j].ham;
        if (a.freqHz === b.freqHz) return { a, b };
      }
    }
    return null;
  };

  return {
    session,
    audio,
    tickTo,
    pair,
    now: () => t,
    /** Step the clock until a background exchange appears. */
    async untilExchange(maxMs = 200_000): Promise<BackgroundPair> {
      for (let at = 1_000; at <= maxMs; at += 1_000) {
        await tickTo(at);
        const found = pair();
        if (found) return found;
      }
      throw new Error("波段上一直没有出现互相通联的一对");
    },
    /** Step 0.5 s at a time until the exchange ends; returns where it ended. */
    async runToEnd(step = 500, maxMs = 180_000): Promise<number | null> {
      const from = t;
      for (let at = from + step; at <= from + maxMs; at += step) {
        await tickTo(at);
        if (!pair()) return at;
      }
      return null;
    },
  };
}

describe("HAM 互相通联（后台，对操作者不可见）", () => {
  it("波段上会自己出现一对：应答方挪到呼叫方的频点上", async () => {
    const h = makeSession();
    h.session.seedHams(4);
    h.session.start();

    const q = await h.untilExchange();
    expect(q.a.freqHz).toBe(q.b.freqHz); // 应答方调到了呼叫方的频率上
    expect(h.session.hamActivity().filter((e) => e.state === "inQso")).toHaveLength(2);
    // 两者都在 1 kHz 网格上：同频是通联造成的，不是落点出错。
    expect(q.a.freqHz % 1_000).toBe(0);
  });

  it("调过去就能听到完整的 6 行，顺序与协议一致；调开之前一个字也没有", async () => {
    const h = makeSession();
    h.session.seedHams(4);
    h.session.start();
    const q = await h.untilExchange();

    // 之前不在通带内，一个字也没播出；现在把拨轮对准它们。
    expect(h.audio.calls).toHaveLength(0);
    h.session.retune(q.a.freqHz / 1e6);
    const endedAt = await h.runToEnd();

    expect(endedAt).not.toBeNull();
    // 谁先开口由配对决定；这里只要求整段报文符合协议、顺序一致。
    const script = (caller: VirtualHam, answerer: VirtualHam): string[] => [
      `CQ CQ CQ DE ${caller.call} ${caller.call} PSE K`,
      `${caller.call} DE ${answerer.call} K`,
      "R UR RST 599 599 BK",
      "R UR RST 599 BK",
      "R TU 73 SK",
      "R TU 73 SK",
    ];
    expect([script(q.a, q.b), script(q.b, q.a)]).toContainEqual(h.audio.calls);
  });

  it("在这个频率上发 CQ 插不进去：没有人应答，那一对照样把话说完", async () => {
    const h = makeSession();
    h.session.seedHams(4);
    h.session.start();
    const q = await h.untilExchange();
    h.session.retune(q.a.freqHz / 1e6);

    h.audio.calls = [];
    await h.session.userCallsCq();

    // 自己的 CQ 发出去了，但没有任何台应答：没有堆叠、没有解释、也没有提示。
    expect(h.audio.calls).toEqual(["CQ CQ CQ DE BG7XXX BG7XXX PSE K"]);
    expect(h.session.pileupCallers()).toHaveLength(0);
    expect(h.session.state).toBe("IDLE");
    expect(h.session.lines.some((l) => l.text.includes("通联"))).toBe(false);

    // 那一对既没有让位也没有被打断，仍在原频率上通联。
    expect(h.pair()).not.toBeNull();
    const scriptOf = (caller: VirtualHam, answerer: VirtualHam): string[] => [
      `CQ CQ CQ DE ${caller.call} ${caller.call} PSE K`,
      `${caller.call} DE ${answerer.call} K`,
      "R UR RST 599 599 BK",
      "R UR RST 599 BK",
      "R TU 73 SK",
      "R TU 73 SK",
    ];
    const pairLines = new Set([...scriptOf(q.a, q.b), ...scriptOf(q.b, q.a)]);
    h.audio.calls = [];
    const from = h.now();
    for (let at = from + 1_000; at <= from + 20_000; at += 1_000) {
      await h.tickTo(at);
    }
    expect(h.audio.calls.some((c) => pairLines.has(c))).toBe(true);
  });

  it("通联结束后，原来那个呼叫方接着呼叫 CQ", async () => {
    const h = makeSession();
    h.session.seedHams(4);
    h.session.start();
    const q = await h.untilExchange();
    h.session.retune(q.a.freqHz / 1e6);

    expect(await h.runToEnd()).not.toBeNull();
    // 谁先开口由配对决定：呼叫方从第一行 CQ 里认出来。
    const first = h.audio.calls.find((c) => c.startsWith("CQ CQ CQ DE"));
    const caller = first!.split(" ")[4];
    const ownCq = `CQ CQ CQ DE ${caller} ${caller} PSE K`;
    expect(h.audio.calls.filter((c) => c === ownCq)).toHaveLength(1);

    // 签完 73 后几秒内重新开口（2–6 s），而不是等 30–60 s 的常规间隔。
    let seenCqing = false;
    for (let at = h.now() + 500; at <= h.now() + 10_000; at += 500) {
      await h.tickTo(at);
      if (h.session.hamActivity().some((e) => e.ham.call === caller && e.state === "cqing")) {
        seenCqing = true;
        break;
      }
    }
    expect(seenCqing).toBe(true);
    expect(h.audio.calls.filter((c) => c === ownCq).length).toBeGreaterThanOrEqual(2);
  }, 20_000);

  it("互连中的两台不会被当成可通联对象", async () => {
    const h = makeSession();
    h.session.seedHams(4);
    h.session.start();
    const q = await h.untilExchange();
    h.session.retune(q.a.freqHz / 1e6);

    expect(h.session.heardActiveHam()).toBeNull();
    const nearest = h.session.nearestWorkableHam();
    expect(nearest?.call).not.toBe(q.a.call);
    expect(nearest?.call).not.toBe(q.b.call);
  });

  it("结束后两台回到守听，应答方回到自己的频点，波段不出现同频两台", async () => {
    const h = makeSession();
    const before = new Map(h.session.seedHams(4).map((x) => [x.call, x.freqHz]));
    h.session.start();
    const q = await h.untilExchange();

    await h.runToEnd();

    const after = h.session.listHams();
    expect(after).toHaveLength(4);
    expect(new Set(after.map((x) => x.freqHz)).size).toBe(4); // 各占一个槽
    expect(after.find((x) => x.call === q.b.call)!.freqHz).toBe(before.get(q.b.call));
    expect(h.session.hamActivity().every((e) => e.state !== "inQso")).toBe(true);
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
    // 没有任何两台处于通联状态还共用一个频点 —— 后台那一对被压住了。
    const byFreq = new Map<number, number>();
    for (const e of h.session.hamActivity().filter((x) => x.state === "inQso")) {
      byFreq.set(e.ham.freqHz, (byFreq.get(e.ham.freqHz) ?? 0) + 1);
    }
    expect([...byFreq.values()].every((n) => n < 2)).toBe(true);
  });
});
