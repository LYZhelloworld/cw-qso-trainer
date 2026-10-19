import { describe, expect, it } from "vitest";
import { QsoSession } from "./session.js";
import { normalizeSettings } from "./settingsSchema.js";
import type { AudioPlayer, PlaybackHandle } from "../audio/engine.js";

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

/**
 * HAM-to-HAM exchanges are background life on the band: they start on their own,
 * run a scripted six-line QSO at the operator's keying speed, and are audible
 * only when the dial sits on their frequency. Time is fully injected, so all of
 * that is driven in milliseconds here.
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
   * A dial setting with no station inside the passband: 500 Hz away from the
   * outermost 1 kHz grid slot, so no CQ is picked up and the operator stays out
   * of any QSO while the band lives its own life.
   */
  session.retune(14.0595);

  return {
    session,
    audio,
    tickTo,
    now: () => t,
    /** Step the clock until a background exchange appears. */
    async untilExchange(maxMs = 200_000) {
      for (let at = 1_000; at <= maxMs; at += 1_000) {
        await tickTo(at);
        const q = session.hamQsoInfo();
        if (q) return q;
      }
      return null;
    },
    /** Step 0.5 s at a time until the exchange ends; returns where it ended. */
    async runToEnd(step = 500, maxMs = 180_000): Promise<number | null> {
      const from = t;
      for (let at = from + step; at <= from + maxMs; at += step) {
        await tickTo(at);
        if (!session.hamQsoInfo()) return at;
      }
      return null;
    },
  };
}

describe("HAM 互相通联（后台）", () => {
  it("波段上会自己出现一对：两台同频，都标为通联中", async () => {
    const h = makeSession();
    h.session.seedHams(4);
    h.session.start();

    const q = (await h.untilExchange())!;
    expect(q).not.toBeNull();
    expect(q.a.freqHz).toBe(q.b.freqHz); // 应答方调到了呼叫方的频率上
    expect(q.freqHz).toBe(q.a.freqHz);
    expect(h.session.isHamQsoStation(q.a.call)).toBe(true);
    expect(h.session.isHamQsoStation(q.b.call)).toBe(true);
    expect(h.session.hamQsoPartnerOf(q.a.call)).toBe(q.b.call);
    expect(h.session.hamQsoPartnerOf(q.b.call)).toBe(q.a.call);

    const working = h.session.hamActivity().filter((e) => e.state === "inQso");
    expect(working).toHaveLength(2);
  });

  it("调过去旁听就能听到完整的 6 行，顺序与协议一致", async () => {
    const h = makeSession();
    h.session.seedHams(4);
    h.session.start();
    const q = (await h.untilExchange())!;

    // 之前不在通带内，一个字也没播出；现在把拨轮对准它们。
    expect(h.audio.calls).toHaveLength(0);
    h.session.retune(q.freqHz / 1e6);
    const endedAt = await h.runToEnd();

    expect(endedAt).not.toBeNull();
    expect(h.audio.calls).toEqual([
      `CQ CQ CQ DE ${q.a.call} ${q.a.call} PSE K`,
      `${q.a.call} DE ${q.b.call} K`,
      "R UR RST 599 599 BK",
      "R UR RST 599 BK",
      "R TU 73 SK",
      "R TU 73 SK",
    ]);
  });

  it("频率被占用：在这个频率上发 CQ 会被拒绝", async () => {
    const h = makeSession();
    h.session.seedHams(4);
    h.session.start();
    const q = (await h.untilExchange())!;
    h.session.retune(q.freqHz / 1e6);

    await h.session.userCallsCq();

    expect(h.session.pileupCallers()).toHaveLength(0);
    expect(h.session.state).toBe("IDLE");
    expect(
      h.session.lines.some((l) => l.text.includes("正在这个频率上通联")),
    ).toBe(true);
    expect(h.audio.calls.some((c) => c.startsWith("CQ CQ CQ DE BG7XXX"))).toBe(false);
  });

  it("互连中的两台不会被当成可通联对象", async () => {
    const h = makeSession();
    h.session.seedHams(4);
    h.session.start();
    const q = (await h.untilExchange())!;
    h.session.retune(q.freqHz / 1e6);

    expect(h.session.heardActiveHam()).toBeNull();
    const nearest = h.session.nearestWorkableHam();
    expect(nearest?.call).not.toBe(q.a.call);
    expect(nearest?.call).not.toBe(q.b.call);
  });

  it("结束后两台回到守听，应答方回到自己的频点，波段不出现同频两台", async () => {
    const h = makeSession();
    const before = new Map(h.session.seedHams(4).map((x) => [x.call, x.freqHz]));
    h.session.start();
    const q = (await h.untilExchange())!;

    await h.runToEnd();

    expect(h.session.hamQsoInfo()).toBeNull();
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

    for (let at = 31_000; at <= 150_000; at += 1_000) await h.tickTo(at);
    expect(h.session.hamQsoInfo()).toBeNull();
  });
});
