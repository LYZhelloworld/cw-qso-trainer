import { describe, expect, it } from "vitest";
import {
  BAND_SIGNAL_SPREAD_HZ,
  buildBackgroundSignals,
  inSpectrumWindow,
  mulberry32,
  SIGNAL_GRID_HZ,
  snapToGrid,
  SPECTRUM_SPAN_HZ,
} from "./spectrum.js";

const REF = 14_025_000; // 20 m CW

describe("spectrum constants", () => {
  it("spans ±10 kHz around the dial", () => {
    expect(SPECTRUM_SPAN_HZ).toBe(20_000);
    expect(SPECTRUM_SPAN_HZ / 2).toBe(10_000);
  });

  it("snaps stations onto the 1 kHz grid operators actually use", () => {
    expect(SIGNAL_GRID_HZ).toBe(1_000);
    expect(snapToGrid(14_025_400)).toBe(14_025_000);
    expect(snapToGrid(14_025_600)).toBe(14_026_000);
    expect(snapToGrid(REF)).toBe(REF);
  });
});

describe("inSpectrumWindow", () => {
  it("只把窗口（默认 ±10 kHz）之内的信号算进来", () => {
    expect(inSpectrumWindow(14_035_000, 14_025_000)).toBe(true); // 正好在边缘
    expect(inSpectrumWindow(14_035_001, 14_025_000)).toBe(false);
    expect(inSpectrumWindow(14_015_000, 14_025_000)).toBe(true);
    expect(inSpectrumWindow(14_050_000, 14_025_000)).toBe(false);
  });

  it("窗口宽度可指定", () => {
    expect(inSpectrumWindow(14_030_000, 14_025_000, 20_000)).toBe(true);
    expect(inSpectrumWindow(14_030_000, 14_025_000, 8_000)).toBe(false);
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

    expect(signals.length).toBeGreaterThanOrEqual(8);
    expect(signals.length).toBeLessThanOrEqual(15);
    for (const s of signals) {
      expect(Math.abs(s.freqHz - REF)).toBeLessThanOrEqual(BAND_SIGNAL_SPREAD_HZ);
      expect(s.freqHz % SIGNAL_GRID_HZ).toBe(0); // 装饰载波也在 1 kHz 网格上
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
