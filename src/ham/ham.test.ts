import { describe, it, expect } from "vitest";
import { VirtualHam, MISS_PROBABILITY } from "./virtualHam.js";
import { generateVirtualHam, haversineKm } from "./generate.js";
import { Frequency, planHamToHam } from "./frequency.js";
import { BAND_SIGNAL_SPREAD_HZ, SIGNAL_GRID_HZ } from "./spectrum.js";
import { dxccDatabase } from "../data/dxcc.js";

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

describe("Frequency", () => {
  it("spawns a valid virtual HAM on the frequency", () => {
    const f = new Frequency(14.0, dxccDatabase);
    const ham = f.spawnHam("BG7XXX");
    expect(ham.call).toMatch(/^[A-Z]{1,2}[0-9][A-Z]{2,3}$/);
    expect(f.listHams()).toHaveLength(1);
    expect(f.activeHam()?.call).toBe(ham.call);
  });

  it("波段上摆满台时也不会两台共用一个频率槽", () => {
    const f = new Frequency(14.0, dxccDatabase);
    const rng = mulberry32(99);
    for (let i = 0; i < 12; i += 1) f.spawnHam("BG7XXX", "novice", rng);

    const hams = f.listHams();
    expect(hams).toHaveLength(12);
    const freqs = hams.map((h) => h.freqHz);
    expect(new Set(freqs).size).toBe(12);
    for (const hz of freqs) {
      expect(hz % SIGNAL_GRID_HZ).toBe(0); // 都在 1 kHz 网格上
      expect(Math.abs(hz - 14_000_000)).toBeLessThanOrEqual(BAND_SIGNAL_SPREAD_HZ);
    }
  });

  it("exposes a reserved HAM-to-HAM plan stub (step 3 placeholder)", () => {
    const f = new Frequency(14.0, dxccDatabase);
    const a = f.spawnHam("BG7XXX", "novice", mulberry32(1));
    const b = f.spawnHam("BG7XXX", "novice", mulberry32(2));
    const plan = planHamToHam(a, b);
    expect(plan.reserved).toBe(true);
    expect(plan.participants).toEqual([a, b]);
  });
});
