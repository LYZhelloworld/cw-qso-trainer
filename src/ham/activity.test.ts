import { describe, expect, it } from "vitest";
import { VirtualHam } from "./virtualHam.js";
import {
  ANSWER_CQ_DELAY_MAX_MS,
  ANSWER_CQ_DELAY_MIN_MS,
  CQ_INTERVAL_MAX_MS,
  CQ_INTERVAL_MIN_MS,
  GIVE_UP_MS,
  HamActivity,
  REPLY_DELAY_MAX_MS,
  REPLY_DELAY_MIN_MS,
  answerCqDelayMs,
  nextCqDelayMs,
  replyDelayMs,
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
  it("CQ 间隔落在 30–60 秒", () => {
    expect(nextCqDelayMs(low)).toBe(CQ_INTERVAL_MIN_MS);
    expect(nextCqDelayMs(high)).toBe(CQ_INTERVAL_MAX_MS);
    for (const f of [nextCqDelayMs, () => nextCqDelayMs(Math.random)]) {
      const v = f();
      expect(v).toBeGreaterThanOrEqual(CQ_INTERVAL_MIN_MS);
      expect(v).toBeLessThanOrEqual(CQ_INTERVAL_MAX_MS);
    }
  });

  it("应答延迟 1–5 秒、回复延迟 1–3 秒", () => {
    expect(answerCqDelayMs(low)).toBe(ANSWER_CQ_DELAY_MIN_MS);
    expect(answerCqDelayMs(high)).toBe(ANSWER_CQ_DELAY_MAX_MS);
    expect(replyDelayMs(low)).toBe(REPLY_DELAY_MIN_MS);
    expect(replyDelayMs(high)).toBe(REPLY_DELAY_MAX_MS);
  });

  it("频段活跃数量 5–9 个", () => {
    expect(targetHamCount(low)).toBe(5);
    expect(targetHamCount(high)).toBe(9);
  });

  it("越界的注入随机源也不会超出区间（钳制生效）", () => {
    expect(nextCqDelayMs(() => 1)).toBe(CQ_INTERVAL_MAX_MS);
    expect(nextCqDelayMs(() => -1)).toBe(CQ_INTERVAL_MIN_MS);
    expect(targetHamCount(() => 1)).toBe(9);
    expect(targetHamCount(() => -1)).toBe(5);
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

  it("无人应答时按 30–60 秒反复重呼", () => {
    const ham = hamOf("JA1ABC");
    const { act, advanceTo } = manual();
    act.add(ham, 30_000);

    const calls: number[] = [];
    for (let t = 30_000; t <= 120_000; t += 30_000) {
      if (advanceTo(t).some((e) => e.type === "cq")) calls.push(t);
    }
    expect(calls).toEqual([30_000, 60_000, 90_000, 120_000]);
  });

  it("连续 3 分钟无应答则下线并移除", () => {
    const ham = hamOf("JA1ABC");
    const { act, advanceTo } = manual();
    act.add(ham, 30_000);

    const seen: string[] = [];
    for (let t = 30_000; t <= 210_000; t += 30_000) {
      for (const e of advanceTo(t)) seen.push(e.type);
    }
    // 30s..180s 反复呼叫，210s 时距首次 CQ 满 3 分钟 -> 下线
    expect(seen.filter((s) => s === "cq").length).toBe(6);
    expect(seen[seen.length - 1]).toBe("offline");
    expect(act.size).toBe(0);
    expect(act.has("JA1ABC")).toBe(false);
  });

  it("首呼延迟可覆盖，用于调到新频段后早点听到动静", () => {
    const ham = hamOf("JA1ABC");
    const { act, advanceTo } = manual();
    act.add(ham, 5_000);

    expect(advanceTo(4_999)).toEqual([]);
    expect(advanceTo(5_000)).toEqual([{ type: "cq", ham }]);
    // 之后回到规格区间
    act.advance(5_000);
    expect(act.list()[0].nextCqAt).toBe(5_000 + CQ_INTERVAL_MIN_MS);
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

  it("进入通联后不会因「无应答」而下线", () => {
    const ham = hamOf("JA1ABC");
    const { act, advanceTo } = manual();
    act.add(ham, 30_000);
    advanceTo(30_000); // 发出 CQ
    act.markInQso("JA1ABC");

    // 远超 3 分钟也不下线
    expect(advanceTo(30_000 + GIVE_UP_MS * 2)).toEqual([]);
    expect(act.size).toBe(1);
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
    expect(entry.nextCqAt).toBe(500_000 + CQ_INTERVAL_MIN_MS);
    expect(advanceTo(500_000 + CQ_INTERVAL_MIN_MS)).toEqual([{ type: "cq", ham }]);
  });

  it("用户应答后重置无应答计时（不会刚答完就被判超时）", () => {
    const ham = hamOf("JA1ABC");
    const { act, advanceTo } = manual();
    act.add(ham, 30_000);
    advanceTo(170_000); // 已呼叫很久
    act.markAnswered("JA1ABC");

    // 应答后计时归零：即便再过去近 3 分钟，也不会被判为「无应答」
    const events = advanceTo(170_000 + GIVE_UP_MS - 1_000);
    expect(events.some((e) => e.type === "offline")).toBe(false);
    expect(act.size).toBe(1);
  });
});

describe("查询", () => {
  it("cqingHam 给出正在呼叫的台", () => {
    const a = hamOf("JA1ABC");
    const b = hamOf("K1DEF");
    const { act, advanceTo } = manual();
    act.add(a, 30_000);
    act.add(b, 300_000); // 晚很多才呼叫

    expect(act.cqingHam()).toBeNull();
    advanceTo(30_000);
    expect(act.cqingHam()).toBe(a);
  });

  it("availableHam 跳过已通联的台", () => {
    const a = hamOf("JA1ABC");
    const b = hamOf("K1DEF");
    const { act } = manual();
    act.add(a);
    act.add(b);

    expect(act.availableHam()).toBe(a);
    act.markInQso("JA1ABC");
    expect(act.availableHam()).toBe(b);
  });

  it("重复 add 同一呼号不会产生两份记录", () => {
    const ham = hamOf("JA1ABC");
    const { act } = manual();
    act.add(ham);
    act.add(new VirtualHam({ call: "JA1ABC", difficulty: "hardcore" }));
    expect(act.size).toBe(1);
  });
});
