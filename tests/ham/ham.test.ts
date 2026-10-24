import { describe, it, expect } from "vitest";
import { VirtualHam, MISS_PROBABILITY } from "../../src/ham/virtualHam.js";
import { generateVirtualHam, haversineKm, resolveUserEntity } from "../../src/ham/generate.js";
import { Frequency } from "../../src/ham/frequency.js";
import { BAND_SIGNAL_SPREAD_HZ, SIGNAL_STEP_HZ } from "../../src/ham/spectrum.js";
import { dxccDatabase } from "../../src/data/dxcc.js";

/** Deterministic PRNG so distribution tests are reproducible. */
function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("VirtualHam", () => {
  it("maps difficulty to the spec miss probability", () => {
    expect(MISS_PROBABILITY.novice).toBe(0);
    expect(MISS_PROBABILITY.intermediate).toBe(0.01);
    expect(MISS_PROBABILITY.hardcore).toBe(0.05);
  });

  it("willMiss honours an injected RNG (deterministic)", () => {
    const ham = new VirtualHam({ call: "JA1ABC", difficulty: "hardcore" });
    expect(ham.willMiss(() => 0)).toBe(true); // 0 < 0.05
    expect(ham.willMiss(() => 1)).toBe(false); // 1 >= 0.05
    expect(ham.missProbability).toBe(0.05);
  });

  it("defaults the report to 599", () => {
    const ham = new VirtualHam({ call: "JA1ABC", difficulty: "novice" });
    expect(ham.report).toBe("599");
  });
});

describe("haversineKm", () => {
  it("is zero for identical points", () => {
    expect(haversineKm({ lat: 35.9, lon: 104.2 }, { lat: 35.9, lon: 104.2 })).toBe(0);
  });

  it("matches a known great-circle distance (Beijing->Shanghai ~1067km)", () => {
    const d = haversineKm({ lat: 39.9, lon: 116.4 }, { lat: 31.2, lon: 121.5 });
    expect(d).toBeGreaterThan(1000);
    expect(d).toBeLessThan(1150);
  });
});

describe("generateVirtualHam — validity & weighting", () => {
  it("always produces a callsign that passes validation (suffix 2–3 letters)", () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 300; i++) {
      const ham = generateVirtualHam({ myCall: "BG7XXX", db: dxccDatabase, rng });
      expect(ham.call).toMatch(/^[A-Z]{1,2}[0-9][A-Z]{2,3}$/);
    }
  });

  it("never emits the illegal single-letter suffix (e.g. BG4I)", () => {
    // Regression: suffixLen used to be 1..3, producing calls like BG4I.
    const rng = mulberry32(2024);
    for (let i = 0; i < 500; i++) {
      const ham = generateVirtualHam({ myCall: "BG7XXX", db: dxccDatabase, rng });
      const suffix = ham.call.replace(/^[A-Z]{1,2}[0-9]/, "");
      expect(suffix.length).toBeGreaterThanOrEqual(2);
      expect(suffix.length).toBeLessThanOrEqual(3);
    }
  });

  it("skews strongly toward the user's own country (CAT1+CAT2 dominate)", () => {
    const rng = mulberry32(7);
    let chinaHams = 0;
    let region7 = 0;
    const n = 400;
    for (let i = 0; i < n; i++) {
      const ham = generateVirtualHam({ myCall: "BG7XXX", db: dxccDatabase, rng });
      // BY is the DXCC marker for China (incl. all B-prefixes).
      if (dxccDatabase.resolvePrefix(ham.call.replace(/[0-9].*$/, "")) === "BY") {
        chinaHams++;
      }
      if (ham.call.match(/[0-9]/)?.[0] === "7") region7++;
    }
    expect(chinaHams / n).toBeGreaterThan(0.7); // ~90% expected
    expect(region7 / n).toBeGreaterThan(0.4); // CAT1 region reuse
  });

  it("still emits some non-local HAMs (CAT3/4/5 are reachable)", () => {
    const rng = mulberry32(123);
    const foreign = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const ham = generateVirtualHam({ myCall: "BG7XXX", db: dxccDatabase, rng });
      if (dxccDatabase.resolvePrefix(ham.call.replace(/[0-9].*$/, "")) !== "BY") {
        foreign.add(ham.call.slice(0, 2));
      }
    }
    expect(foreign.size).toBeGreaterThan(0);
  });

  it("builds a HAM whose reported RST is a valid RST token", () => {
    const ham = generateVirtualHam({ myCall: "BG7XXX", db: dxccDatabase, rng: mulberry32(1) });
    expect(ham.report).toMatch(/^[1-5][1-9][1-9]$/);
  });
});

describe("generateVirtualHam — 用户呼号的实体解析", () => {
  const entity = (call: string): string | null =>
    resolveUserEntity(call, dxccDatabase)?.dxcc ?? null;

  it("按最长前缀解析：B5/B7 归中国，而不是单字母 B", () => {
    // Regression: stripping the digit left "B", whose first table match is
    // Spratly's BM9S — a Chinese operator ended up in the South China Sea.
    expect(entity("B5")).toBe("BY");
    expect(entity("B7ABC")).toBe("BY");
    expect(entity("B5/P")).toBe("BY");
  });

  it("同类「单字母 + 数字」呼号也落到正确实体", () => {
    expect(entity("A5ABC")).toBe("A5");
    expect(entity("E7ABC")).toBe("E7");
    expect(entity("S5ABC")).toBe("S5");
    expect(entity("T7ABC")).toBe("T7");
    expect(entity("Z3ABC")).toBe("Z3");
  });

  it("常见前缀不受影响", () => {
    expect(entity("BG7XXX")).toBe("BY");
    expect(entity("K1ABC")).toBe("K");
    expect(entity("W1AW")).toBe("K");
    expect(entity("JA1ABC")).toBe("JA");
    expect(entity("M0ABC")).toBe("G");
  });

  it("查不到时返回 null", () => {
    expect(entity("QQ7ABC")).toBeNull();
  });

  it("B5 用户的台现在会从中国生成", () => {
    const rng = mulberry32(5);
    let china = 0;
    const n = 100;
    for (let i = 0; i < n; i++) {
      const ham = generateVirtualHam({ myCall: "B5", db: dxccDatabase, rng });
      if (dxccDatabase.resolvePrefix(ham.call.replace(/[0-9].*$/, "")) === "BY") china += 1;
    }
    // Before the fix this was 0/300: CAT1/CAT2 had no usable Chinese prefix.
    expect(china / n).toBeGreaterThan(0.5);
  });
});

describe("Frequency", () => {
  it("spawns a valid virtual HAM on the frequency", () => {
    const f = new Frequency(14.0, dxccDatabase);
    const ham = f.spawnHam("BG7XXX");
    expect(ham.call).toMatch(/^[A-Z]{1,2}[0-9][A-Z]{2,3}$/);
    expect(f.listHams()).toHaveLength(1);
    expect(f.activityState()[0].ham).toBe(ham);
  });

  it("波段上的台落在 10 Hz 网格上，不再对齐整千赫", () => {
    const f = new Frequency(14.0, dxccDatabase);
    const rng = mulberry32(99);
    for (let i = 0; i < 12; i += 1) f.spawnHam("BG7XXX", "novice", rng);

    const hams = f.listHams();
    expect(hams).toHaveLength(12);
    const freqs = hams.map((h) => h.freqHz);
    // 同一位置不放两台（频率完全相同才算撞车）。
    expect(new Set(freqs).size).toBe(12);
    for (const hz of freqs) {
      expect(hz % SIGNAL_STEP_HZ).toBe(0); // 都在 10 Hz 网格上
      expect(Math.abs(hz - 14_000_000)).toBeLessThanOrEqual(BAND_SIGNAL_SPREAD_HZ);
    }
    // 12 台全部刚好落在整千赫上的概率是 (1/100)^12——实际为 0。
    expect(freqs.some((hz) => hz % 1_000 !== 0)).toBe(true);
  });
});
