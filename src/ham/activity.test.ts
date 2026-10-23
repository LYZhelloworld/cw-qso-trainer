import { describe, expect, it } from "vitest";
import { VirtualHam } from "./virtualHam.js";
import {
  ANSWER_CQ_DELAY_MAX_MS,
  ANSWER_CQ_DELAY_MIN_MS,
  CQ_GAP_MAX_MS,
  CQ_GAP_MIN_MS,
  HamActivity,
  REPLY_DELAY_MAX_MS,
  REPLY_DELAY_MIN_MS,
  RESUME_CQ_DELAY_MAX_MS,
  RESUME_CQ_DELAY_MIN_MS,
  answerCqDelayMs,
  nextCqGapMs,
  replyDelayMs,
  resumeCqDelayMs,
  targetHamCount,
} from "./activity.js";

/** Always picks the lower bound of every interval. */
const low = () => 0;
/** Always picks (nearly) the upper bound. */
const high = () => 0.999999;

function hamOf(call: string): VirtualHam {
  return new VirtualHam({ call, difficulty: "novice" });
}

/** Activity driven by a manual clock so timings are exact. */
function manual(rng: () => number = low) {
  let t = 0;
  const act = new HamActivity({ now: () => t, rng });
  return {
    act,
    advanceTo(ms: number) {
      t = ms;
      return act.advance(t);
    },
    get now() {
      return t;
    },
  };
}

describe("延迟与数量区间（VIRTUAL-HAM.md）", () => {
  it("两次 CQ 之间的守听间隔落在 3–8 秒", () => {
    expect(nextCqGapMs(low)).toBe(CQ_GAP_MIN_MS);
    expect(nextCqGapMs(high)).toBe(CQ_GAP_MAX_MS);
    for (const f of [nextCqGapMs, () => nextCqGapMs(Math.random)]) {
      const v = f();
      expect(v).toBeGreaterThanOrEqual(CQ_GAP_MIN_MS);
      expect(v).toBeLessThanOrEqual(CQ_GAP_MAX_MS);
    }
  });

  it("应答延迟 1–5 秒、回复延迟 1–3 秒", () => {
    expect(answerCqDelayMs(low)).toBe(ANSWER_CQ_DELAY_MIN_MS);
    expect(answerCqDelayMs(high)).toBe(ANSWER_CQ_DELAY_MAX_MS);
    expect(replyDelayMs(low)).toBe(REPLY_DELAY_MIN_MS);
    expect(replyDelayMs(high)).toBe(REPLY_DELAY_MAX_MS);
  });

  it("频段活跃数量 12–18 个", () => {
    expect(targetHamCount(low)).toBe(12);
    expect(targetHamCount(high)).toBe(18);
  });

  it("通联结束后的重呼延迟 2–6 秒", () => {
    expect(resumeCqDelayMs(low)).toBe(RESUME_CQ_DELAY_MIN_MS);
    expect(resumeCqDelayMs(high)).toBe(RESUME_CQ_DELAY_MAX_MS);
  });

  it("越界的注入随机源也不会超出区间（钳制生效）", () => {
    expect(nextCqGapMs(() => 1)).toBe(CQ_GAP_MAX_MS);
    expect(nextCqGapMs(() => -1)).toBe(CQ_GAP_MIN_MS);
    expect(targetHamCount(() => 1)).toBe(18);
    expect(targetHamCount(() => -1)).toBe(12);
  });
});

describe("自主发 CQ", () => {
  it("未到预定时刻不发，到点才呼叫", () => {
    const ham = hamOf("JA1ABC");
    const { act, advanceTo } = manual();
    act.add(ham, 30_000);

    expect(advanceTo(29_999)).toEqual([]);
    expect(advanceTo(30_000)).toEqual([{ type: "cq", ham }]);
    expect(act.list()[0].state).toBe("cqing");
  });

  it("无人应答时按守听间隔反复重呼", () => {
    const ham = hamOf("JA1ABC");
    const { act, advanceTo } = manual();
    act.add(ham, 30_000);

    const calls: number[] = [];
    for (let t = 30_000; t <= 39_000; t += 3_000) {
      if (advanceTo(t).some((e) => e.type === "cq")) calls.push(t);
    }
    // 每次 CQ 之后只隔一个 3 秒的守听间隙（low 随机源取下界）。
    expect(calls).toEqual([30_000, 33_000, 36_000, 39_000]);
  });

  it("首呼延迟可覆盖，用于调到新频段后早点听到动静", () => {
    const ham = hamOf("JA1ABC");
    const { act, advanceTo } = manual();
    act.add(ham, 5_000);

    expect(advanceTo(4_999)).toEqual([]);
    expect(advanceTo(5_000)).toEqual([{ type: "cq", ham }]);
    // 之后按守听间隔（会话会用消息长度重新排定，这里只看默认值）
    expect(act.list()[0].nextCqAt).toBe(5_000 + CQ_GAP_MIN_MS);
  });

  it("会话可以用 scheduleNext 按消息长度重新排定下一次", () => {
    const ham = hamOf("JA1ABC");
    const { act, advanceTo } = manual();
    act.add(ham, 30_000);
    advanceTo(30_000);

    act.scheduleNext("JA1ABC", 27_000); // 一条 CQ 约 27 秒
    expect(advanceTo(30_000 + 26_999)).toEqual([]);
    expect(advanceTo(30_000 + 27_000)).toEqual([{ type: "cq", ham }]);
  });

  it("台一直留在频率上：不再有「3 分钟无应答下线」", () => {
    const ham = hamOf("JA1ABC");
    const { act, advanceTo } = manual();
    act.add(ham, 30_000);

    let calls = 0;
    for (let t = 30_000; t <= 600_000; t += 3_000) {
      calls += advanceTo(t).filter((e) => e.type === "cq").length;
    }
    expect(calls).toBeGreaterThan(100);
    expect(act.size).toBe(1);
    expect(act.has("JA1ABC")).toBe(true);
  });

  it("时钟不回退：推进到过去不产生事件", () => {
    const ham = hamOf("JA1ABC");
    const { act, advanceTo } = manual();
    act.add(ham, 30_000);
    advanceTo(60_000);
    expect(advanceTo(10_000)).toEqual([]);
  });
});

describe("通联期间", () => {
  it("进入通联后不再发 CQ", () => {
    const ham = hamOf("JA1ABC");
    const { act, advanceTo } = manual();
    act.add(ham, 30_000);
    act.markInQso("JA1ABC");

    expect(advanceTo(600_000)).toEqual([]);
    expect(act.list()[0].state).toBe("inQso");
  });

  it("通联结束后回到守听，重新排定 CQ", () => {
    const ham = hamOf("JA1ABC");
    const { act, advanceTo } = manual();
    act.add(ham, 30_000);
    act.markInQso("JA1ABC");
    advanceTo(500_000);
    act.markListening("JA1ABC");

    const entry = act.list()[0];
    expect(entry.state).toBe("listening");
    expect(entry.cqSince).toBeNull();
    expect(entry.nextCqAt).toBe(500_000 + CQ_GAP_MIN_MS);
    expect(advanceTo(500_000 + CQ_GAP_MIN_MS)).toEqual([{ type: "cq", ham }]);
  });

  it("签完 73 后，原来那个呼叫方几秒内重新呼叫", () => {
    const ham = hamOf("JA1ABC");
    const { act, advanceTo } = manual();
    act.add(ham, 30_000);
    advanceTo(30_000); // 第一次 CQ
    act.markInQso("JA1ABC"); // 有人应答，进入通联
    expect(act.list()[0].state).toBe("inQso");

    advanceTo(40_000);
    act.resumeCq("JA1ABC");
    expect(act.list()[0].state).toBe("listening");
    expect(act.list()[0].nextCqAt).toBe(40_000 + RESUME_CQ_DELAY_MIN_MS);

    expect(advanceTo(40_000 + RESUME_CQ_DELAY_MIN_MS - 1)).toEqual([]);
    const resumedAt = 40_000 + RESUME_CQ_DELAY_MIN_MS;
    expect(advanceTo(resumedAt)).toEqual([{ type: "cq", ham }]);
    expect(act.list()[0].state).toBe("cqing");
    expect(act.list()[0].cqSince).toBe(resumedAt);
  });
});

describe("查询", () => {
  it("list() 给出正在呼叫的台与仍在守听的台", () => {
    const a = hamOf("JA1ABC");
    const b = hamOf("K1DEF");
    const { act, advanceTo } = manual();
    act.add(a, 30_000);
    act.add(b, 300_000); // 晚很多才呼叫

    expect(act.list().map((e) => e.state)).toEqual(["listening", "listening"]);
    advanceTo(30_000);
    expect(act.list().map((e) => [e.ham.call, e.state])).toEqual([
      ["JA1ABC", "cqing"],
      ["K1DEF", "listening"],
    ]);
  });

  it("inQso 优先于 cqing：通联中的台不再算「在呼叫」", () => {
    const ham = hamOf("JA1ABC");
    const { act, advanceTo } = manual();
    act.add(ham, 30_000);
    advanceTo(30_000);
    act.markInQso("JA1ABC");
    expect(act.list()[0].state).toBe("inQso");
  });

  it("重复 add 同一呼号不会产生两份记录", () => {
    const ham = hamOf("JA1ABC");
    const { act } = manual();
    act.add(ham);
    act.add(new VirtualHam({ call: "JA1ABC", difficulty: "hardcore" }));
    expect(act.size).toBe(1);
  });
});
