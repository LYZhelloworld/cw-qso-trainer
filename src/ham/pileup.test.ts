import { describe, expect, it } from "vitest";
import {
  PILEUP_MAX_CALLERS,
  PILEUP_MIN_CALLERS,
  PILEUP_SILENCE_MAX_MS,
  PILEUP_SILENCE_MIN_MS,
  matchCaller,
  pileupCallText,
  pileupSilenceMs,
  pileupSize,
  type PileupCaller,
} from "./pileup.js";
import { VirtualHam } from "./virtualHam.js";

function caller(call: string): PileupCaller {
  return {
    ham: new VirtualHam({ call, difficulty: "novice" }),
    nextCallAt: 0,
    calls: 0,
  };
}

describe("堆叠规模", () => {
  it("每次 2–3 台应答（一台不算堆叠）", () => {
    expect(pileupSize(() => 0)).toBe(PILEUP_MIN_CALLERS);
    expect(pileupSize(() => 0.5)).toBe(3);
    expect(pileupSize(() => 0.999999)).toBe(PILEUP_MAX_CALLERS);
    expect(PILEUP_MIN_CALLERS).toBe(2);
  });

  it("越界的随机源被夹在区间内，不会生成 0 台", () => {
    expect(pileupSize(() => -1)).toBe(PILEUP_MIN_CALLERS);
    expect(pileupSize(() => 2)).toBe(PILEUP_MAX_CALLERS);
  });
});

describe("静默间隔", () => {
  it("每台各自 3–7 秒后再重呼，用来岔开彼此", () => {
    expect(pileupSilenceMs(() => 0)).toBe(PILEUP_SILENCE_MIN_MS);
    expect(pileupSilenceMs(() => 0.999999)).toBe(PILEUP_SILENCE_MAX_MS);
    expect(pileupSilenceMs(() => 0.5)).toBeGreaterThan(PILEUP_SILENCE_MIN_MS);
    expect(pileupSilenceMs(() => 0.5)).toBeLessThan(PILEUP_SILENCE_MAX_MS);
  });
});

describe("呼叫文本", () => {
  it("只报自己的呼号，连报两遍", () => {
    expect(pileupCallText("JA1ABC")).toBe("JA1ABC JA1ABC");
  });
});

describe("点名匹配", () => {
  const callers = [caller("JA1ABC"), caller("W1XYZ")];

  it("整句里出现呼号就算点名，大小写不敏感", () => {
    expect(matchCaller("JA1ABC DE BG7XXX K", callers)?.ham.call).toBe("JA1ABC");
    expect(matchCaller("w1xyz 599", callers)?.ham.call).toBe("W1XYZ");
  });

  it("一次点中多台时取最先出现的那台", () => {
    expect(matchCaller("W1XYZ JA1ABC DE BG7XXX", callers)?.ham.call).toBe("W1XYZ");
  });

  it("没有点名（含空行、只发 R BK）时返回 null", () => {
    expect(matchCaller("R BK", callers)).toBeNull();
    expect(matchCaller("", callers)).toBeNull();
    expect(matchCaller("JA1AB DE BG7XXX", callers)).toBeNull(); // 呼号不完整
  });
});
