import { describe, expect, it } from "vitest";
import {
  DB_PER_S_UNIT,
  QSB_MAX_DB,
  S1_DBM,
  S9_DBM,
  S9_STRENGTH,
  qsbDb,
  qsbDepthFor,
  smeterReading,
  strengthForSUnit,
  strengthToDbm,
} from "./smeter.js";
import { SKIRT_FLOOR_GAIN } from "./tuning.js";

describe("S 表 — 刻度", () => {
  it("九段 S1–S9，每段 6 dB，S9 是 −73 dBm", () => {
    expect(S9_DBM).toBe(-73);
    expect(DB_PER_S_UNIT).toBe(6);
    expect(S1_DBM).toBe(-121);
    expect(strengthToDbm(strengthForSUnit(9))).toBeCloseTo(S9_DBM, 6);
    expect(strengthToDbm(strengthForSUnit(1))).toBeCloseTo(S1_DBM, 6);
  });

  it("RST 的 S 位原样读回来：强度与表针不会各说各话", () => {
    for (let s = 1; s <= 9; s += 1) {
      expect(smeterReading(strengthForSUnit(s))?.label).toBe(`S${s}`);
    }
  });

  it("比 S9 更强时读成 S9+dB，而不是停在 S9", () => {
    const r = smeterReading(strengthForSUnit(10));
    expect(r?.s).toBe(9);
    expect(r?.overDb).toBe(6);
    expect(r?.label).toBe("S9+6");
  });

  it("S9 本身读作 S9，不加 +0", () => {
    const r = smeterReading(S9_STRENGTH);
    expect(r?.overDb).toBe(0);
    expect(r?.label).toBe("S9");
  });

  it("比 S1 还弱的信号夹到 S1，表针不会掉出刻度", () => {
    const r = smeterReading(0.1);
    expect(r?.s).toBe(1);
    expect(r?.label).toBe("S1");
    expect(r?.dbm).toBe(S1_DBM);
  });
});

describe("S 表 — 滤波器与 QSB", () => {
  it("被滤波器切断时没有读数", () => {
    expect(smeterReading(0.9, { gain: 0 })).toBeNull();
  });

  it("裙边按 dB 扣：−26 dB 就是掉 26 dB，不是掉成 5%", () => {
    const full = smeterReading(0.95);
    const skirt = smeterReading(0.95, { gain: SKIRT_FLOOR_GAIN });
    expect(skirt).not.toBeNull();
    expect(full!.dbm - skirt!.dbm).toBeCloseTo(-20 * Math.log10(SKIRT_FLOOR_GAIN), 6);
    // 26 dB ≈ 4.3 个 S 单位 —— 读数是"很弱"，不是"没了"。
    expect(skirt!.s).toBeLessThanOrEqual(full!.s - 4);
    expect(skirt!.s).toBeGreaterThan(1);
  });

  it("QSB 直接扣在 dB 上", () => {
    const still = smeterReading(0.95)!;
    const fading = smeterReading(0.95, { qsbDb: -4 })!;
    expect(still.dbm - fading.dbm).toBeCloseTo(4, 6);
  });

  it("QSB 按呼号各自起伏：确定、有界、互不相同", () => {
    for (const ms of [0, 1_700, 40_000]) {
      expect(qsbDb("JA1ABC", ms)).toBe(qsbDb("JA1ABC", ms));
      expect(Math.abs(qsbDb("JA1ABC", ms))).toBeLessThanOrEqual(QSB_MAX_DB + 1e-9);
    }
    // 同一时刻两个台不在同一相位上，否则整条波段会一起呼吸。
    expect(qsbDb("JA1ABC", 0)).not.toBeCloseTo(qsbDb("BG7ZZZ", 0), 3);
    // 同一个台过一段时间会变。
    expect(qsbDb("JA1ABC", 0)).not.toBeCloseTo(qsbDb("JA1ABC", 3_000), 3);
  });

  it("每个难度都让表针动，越硬摆得越大", () => {
    const swing = (d: string): number => {
      const depth = qsbDepthFor(d);
      let max = 0;
      for (let ms = 0; ms < 20_000; ms += 250) {
        max = Math.max(max, Math.abs(qsbDb("JA1ABC", ms, depth)));
      }
      return max;
    };
    // 新手难度也不能让表针完全僵住——那看起来像坏了，不像安静。
    expect(swing("novice")).toBeGreaterThan(0.5);
    expect(swing("hardcore")).toBeGreaterThan(swing("intermediate"));
    expect(swing("intermediate")).toBeGreaterThan(swing("novice"));
  });
});
