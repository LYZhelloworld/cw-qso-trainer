import { describe, expect, it } from "vitest";
import {
  HAM_QSO_GAP_MAX_MS,
  HAM_QSO_GAP_MIN_MS,
  HAM_QSO_INTERVAL_MAX_MS,
  HAM_QSO_INTERVAL_MIN_MS,
  HAM_QSO_MIN_STATIONS,
  hamQsoGapMs,
  hamQsoIntervalMs,
  hamQsoScript,
  pickHamQsoPair,
} from "../ham/hamQso.js";
import { VirtualHam } from "../ham/virtualHam.js";

const low = () => 0;
const high = () => 0.999999;

function ham(call: string, freqHz = 14_025_000): VirtualHam {
  return new VirtualHam({ call, difficulty: "novice", freqHz });
}

describe("标准 6 行脚本", () => {
  it("按 QSO 协议交替：CQ → 应答 → RST → RST → 73 → 73", () => {
    const script = hamQsoScript("JA1ABC", "BG7XXX");

    expect(script).toHaveLength(6);
    expect(script.map((l) => l.from)).toEqual(["a", "b", "a", "b", "a", "b"]);
    expect(script[0].text).toBe("CQ CQ CQ DE JA1ABC JA1ABC PSE K");
    expect(script[1].text).toBe("JA1ABC DE BG7XXX K");
    expect(script[2].text).toBe("R UR RST 599 599 BK");
    expect(script[3].text).toBe("R UR RST 599 BK");
    expect(script[4].text).toBe("R TU 73 SK");
    expect(script[5].text).toBe("R TU 73 SK");
  });
});

describe("间隔区间", () => {
  it("后台通联每 30–90 秒尝试一次", () => {
    expect(hamQsoIntervalMs(low)).toBe(HAM_QSO_INTERVAL_MIN_MS);
    expect(hamQsoIntervalMs(high)).toBe(HAM_QSO_INTERVAL_MAX_MS);
  });

  it("两次发射之间留 0.6–1.6 秒", () => {
    expect(hamQsoGapMs(low)).toBe(HAM_QSO_GAP_MIN_MS);
    expect(hamQsoGapMs(high)).toBe(HAM_QSO_GAP_MAX_MS);
  });

  it("越界的随机源会被钳制在区间内", () => {
    expect(hamQsoIntervalMs(() => 1)).toBe(HAM_QSO_INTERVAL_MAX_MS);
    expect(hamQsoIntervalMs(() => -1)).toBe(HAM_QSO_INTERVAL_MIN_MS);
    expect(hamQsoGapMs(() => 1)).toBe(HAM_QSO_GAP_MAX_MS);
    expect(hamQsoGapMs(() => -1)).toBe(HAM_QSO_GAP_MIN_MS);
  });
});

describe("挑选一对台", () => {
  const idle = (call: string): { ham: VirtualHam; state: "listening" } => ({
    ham: ham(call),
    state: "listening",
  });

  it("至少要有 3 台：两台互连 + 留一台给操作者", () => {
    expect(pickHamQsoPair([idle("A1AAA"), idle("A2AAA")], low)).toBeNull();
    expect(HAM_QSO_MIN_STATIONS).toBe(3);
    expect(pickHamQsoPair([idle("A1AAA"), idle("A2AAA"), idle("A3AAA")], low)).not.toBeNull();
  });

  it("优先让正在呼叫 CQ 的那台当呼叫方（现实里就是有人应了它）", () => {
    const entries = [
      { ham: ham("A1AAA"), state: "cqing" as const },
      { ham: ham("A2AAA"), state: "listening" as const },
      idle("A3AAA"),
    ];
    const pair = pickHamQsoPair(entries, low)!;
    expect(pair[0].call).toBe("A1AAA");
    expect(pair[1].call).not.toBe("A1AAA");
  });

  it("已通联中的台不参与", () => {
    const entries = [
      { ham: ham("A1AAA"), state: "inQso" as const },
      { ham: ham("A2AAA"), state: "inQso" as const },
      idle("A3AAA"),
      idle("A4AAA"),
    ];
    const pair = pickHamQsoPair(entries, low)!;
    expect(["A3AAA", "A4AAA"]).toContain(pair[0].call);
    expect(["A3AAA", "A4AAA"]).toContain(pair[1].call);
  });

  it("任何时候都选出两个不同的台", () => {
    for (let i = 0; i < 20; i += 1) {
      const rng = (() => {
        let a = i * 7919 + 1;
        return () => {
          a = (Math.imul(a, 1664525) + 1013904223) >>> 0;
          return a / 4294967296;
        };
      })();
      const pair = pickHamQsoPair(
        [idle("A1AAA"), idle("A2AAA"), idle("A3AAA"), idle("A4AAA")],
        rng,
      )!;
      expect(pair[0].call).not.toBe(pair[1].call);
    }
  });

  it("空闲的台不足两台时返回 null（哪怕总数够 3 台）", () => {
    const entries = [
      { ham: ham("A1AAA"), state: "inQso" as const },
      { ham: ham("A2AAA"), state: "inQso" as const },
      idle("A3AAA"),
    ];
    expect(pickHamQsoPair(entries, low)).toBeNull();
  });
});
