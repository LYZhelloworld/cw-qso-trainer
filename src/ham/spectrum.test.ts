import { describe, expect, it } from "vitest";
import {
  BAND_SIGNAL_SPREAD_HZ,
  buildBackgroundSignals,
  mulberry32,
  quantiseHz,
  SPECTRUM_SPAN_HZ,
} from "./spectrum.js";

const REF = 14_025_000; // 20 m CW

describe("spectrum constants", () => {
  it("spans ±10 kHz around the dial", () => {
    expect(SPECTRUM_SPAN_HZ).toBe(20_000);
    expect(SPECTRUM_SPAN_HZ / 2).toBe(10_000);
  });

  it("quantises to 10 Hz so peaks land on a tidy column", () => {
    expect(quantiseHz(14_025_007)).toBe(14_025_010);
    expect(quantiseHz(14_025_004)).toBe(14_025_000);
  });
});

describe("mulberry32", () => {
  it("is deterministic for a seed and stays in [0,1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    for (let i = 0; i < 50; i += 1) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe("buildBackgroundSignals", () => {
  it("scatters a few weak carriers inside the band's spread", () => {
    const signals = buildBackgroundSignals(REF, mulberry32(7));

    expect(signals.length).toBeGreaterThanOrEqual(3);
    expect(signals.length).toBeLessThanOrEqual(6);
    for (const s of signals) {
      expect(Math.abs(s.freqHz - REF)).toBeLessThanOrEqual(BAND_SIGNAL_SPREAD_HZ);
      expect(s.strength).toBeGreaterThan(0);
      expect(s.strength).toBeLessThan(0.45); // weak by design
      expect(s.workable).toBe(false); // decorative: never a QSO partner
    }
  });

  it("is stable for one seed and varies between seeds", () => {
    const a = buildBackgroundSignals(REF, mulberry32(1));
    const b = buildBackgroundSignals(REF, mulberry32(1));
    const c = buildBackgroundSignals(REF, mulberry32(2));

    expect(a.map((s) => s.freqHz)).toEqual(b.map((s) => s.freqHz));
    expect(a.map((s) => s.freqHz)).not.toEqual(c.map((s) => s.freqHz));
  });

  it("honours an explicit count", () => {
    expect(buildBackgroundSignals(REF, mulberry32(3), 5)).toHaveLength(5);
  });
});
