import { describe, it, expect } from "vitest";
import { BANDS, clampToBand, roundFreq } from "../../src/ui/bands.js";

describe("BANDS", () => {
  it("exposes four bands", () => {
    expect(BANDS).toHaveLength(4);
  });

  it("places every default frequency inside its own range", () => {
    for (const band of BANDS) {
      expect(band.defaultMHz).toBeGreaterThanOrEqual(band.minMHz);
      expect(band.defaultMHz).toBeLessThanOrEqual(band.maxMHz);
    }
  });
});

describe("clampToBand", () => {
  it("keeps a frequency inside the band", () => {
    const band = BANDS[1];
    expect(clampToBand(14.0, band)).toBe(14.0);
    expect(clampToBand(99, band)).toBe(band.maxMHz);
    expect(clampToBand(0, band)).toBe(band.minMHz);
  });

  it("falls back to the band default for non-finite input", () => {
    expect(clampToBand(Number.NaN, BANDS[0])).toBe(BANDS[0].defaultMHz);
  });
});

describe("roundFreq", () => {
  it("removes float drift introduced by stepping", () => {
    expect(roundFreq(14.025 + 0.001)).toBe(14.026);
    expect(roundFreq(0.1 + 0.2)).toBe(0.3);
  });

  it("keeps the finest tuning step: 10 Hz survives the round trip", () => {
    expect(roundFreq(14.02501)).toBe(14.02501);
    expect(roundFreq(14.025001)).toBe(14.025); // below 10 Hz is not a step
  });
});
