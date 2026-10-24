import { describe, expect, it } from "vitest";
import {
  ANSWERER_POOL_MAX,
  ANSWERER_POOL_MIN,
  AnswererPool,
  answererPoolSize,
} from "../../src/ham/answerers.js";
import { VirtualHam } from "../../src/ham/virtualHam.js";

let n = 0;
/** Distinct, legal-looking calls: the pool must never hand one out twice. */
function spawn(): VirtualHam {
  n += 1;
  return new VirtualHam({ call: `JA1AA${String.fromCharCode(65 + (n % 26))}`, difficulty: "novice", role: "answerer" });
}

describe("守听池规模", () => {
  it("每个波段 80–120 个守听的台", () => {
    expect(answererPoolSize(() => 0)).toBe(ANSWERER_POOL_MIN);
    expect(answererPoolSize(() => 0.999999)).toBe(ANSWERER_POOL_MAX);
    expect(answererPoolSize(() => -1)).toBe(ANSWERER_POOL_MIN);
    expect(answererPoolSize(() => 2)).toBe(ANSWERER_POOL_MAX);
  });

  it("远高于频谱窗口里同时能站下的台数", () => {
    // 窗口 ±10 kHz、台间平均 3 kHz，一屏十来台；守听池是另一个数量级。
    expect(ANSWERER_POOL_MIN).toBeGreaterThan(51);
  });
});

describe("取台与归还", () => {
  it("取出来的台没有频率：它们不在频谱上，只在开口时才出现", () => {
    const pool = new AnswererPool({ size: 90 });
    const drawn = pool.draw(3, spawn);

    expect(drawn).toHaveLength(3);
    for (const ham of drawn) {
      expect(ham.role).toBe("answerer");
      expect(ham.freqHz).toBe(0);
    }
    expect(new Set(drawn.map((h) => h.call)).size).toBe(3);
  });

  it("不占用频段上的呼号", () => {
    const pool = new AnswererPool({ size: 90 });
    const taken = new Set([spawn().call]);
    const drawn = pool.draw(4, spawn, taken);

    for (const ham of drawn) expect(taken.has(ham.call)).toBe(false);
  });

  it("按需生成：没用到的台不生成", () => {
    let made = 0;
    const pool = new AnswererPool({ size: 100 });
    const make = () => {
      made += 1;
      return spawn();
    };

    expect(pool.available).toBe(100);
    pool.draw(2, make);
    expect(made).toBe(2);
    expect(pool.available).toBe(98);
  });

  it("说完话就回到池子，下次可以再被取出来", () => {
    const pool = new AnswererPool({ size: 10 });
    const [first] = pool.draw(1, spawn);
    first.freqHz = 14_050_000;

    pool.release(first);
    expect(first.freqHz).toBe(0); // 不再发射，也不该留在频率上
    expect(pool.available).toBe(10);

    const again = pool.draw(1, spawn);
    expect(again[0].call).toBe(first.call);
  });

  it("池子取空后不再生成新的（数量就是这一波段的守听人数）", () => {
    const pool = new AnswererPool({ size: 5 });
    const drawn = pool.draw(9, spawn);

    expect(drawn).toHaveLength(5);
    expect(new Set(drawn.map((h) => h.call)).size).toBe(5);
    expect(pool.draw(1, spawn)).toHaveLength(0);
  });
});
