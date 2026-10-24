import { describe, it, expect } from "vitest";
import {
  DEFAULT_SETTINGS,
  TONE_MAX,
  TONE_MIN,
  WPM_MAX,
  WPM_MIN,
  callsignPrefix,
  normalizeSettings,
  validateCallsign,
} from "../../src/ui/settingsSchema.js";

describe("normalizeSettings", () => {
  it("falls back to defaults for missing or unusable input", () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings("nonsense")).toEqual(DEFAULT_SETTINGS);
  });

  it("clamps speed and tone into their ranges", () => {
    expect(normalizeSettings({ wpm: 999 }).wpm).toBe(WPM_MAX);
    expect(normalizeSettings({ wpm: 0 }).wpm).toBe(WPM_MIN);
    expect(normalizeSettings({ toneHz: 99999 }).toneHz).toBe(TONE_MAX);
    expect(normalizeSettings({ toneHz: -5 }).toneHz).toBe(TONE_MIN);
  });

  it("never lets the Farnsworth speed exceed the character speed", () => {
    expect(normalizeSettings({ wpm: 20, farnsworthWpm: 35 }).farnsworthWpm).toBe(20);
  });

  it("upper-cases and trims the callsign", () => {
    expect(normalizeSettings({ myCall: "  bg7xxx " }).myCall).toBe("BG7XXX");
  });

  it("rejects an unknown difficulty or out-of-range band index", () => {
    expect(normalizeSettings({ difficulty: "bogus" }).difficulty).toBe("novice");
    expect(normalizeSettings({ bandIndex: 99 }).bandIndex).toBe(DEFAULT_SETTINGS.bandIndex);
    expect(normalizeSettings({ bandIndex: -1 }).bandIndex).toBe(DEFAULT_SETTINGS.bandIndex);
  });

  it("keeps iambic mode B but defaults to A", () => {
    expect(normalizeSettings({ iambicMode: "B" }).iambicMode).toBe("B");
    expect(normalizeSettings({ iambicMode: "X" }).iambicMode).toBe("A");
  });

  it("sends in message mode by default, and keeps any of the three modes", () => {
    expect(DEFAULT_SETTINGS.keyMode).toBe("text");
    expect(normalizeSettings({}).keyMode).toBe("text");
    expect(normalizeSettings({ keyMode: "straight" }).keyMode).toBe("straight");
    expect(normalizeSettings({ keyMode: "iambic" }).keyMode).toBe("iambic");
    expect(normalizeSettings({ keyMode: "bogus" }).keyMode).toBe("text");
  });

  it("边带不存设置：它属于波段，旧版本留下的 cwSideband 会被丢掉", () => {
    const settings = normalizeSettings({ cwSideband: "USB" });
    expect("cwSideband" in settings).toBe(false);
  });

  it("keeps a supported filter width but defaults to 500 Hz", () => {
    expect(normalizeSettings({ passbandHz: 250 }).passbandHz).toBe(250);
    expect(normalizeSettings({ passbandHz: 100 }).passbandHz).toBe(100);
    expect(normalizeSettings({ passbandHz: 42 }).passbandHz).toBe(500);
    expect(DEFAULT_SETTINGS.passbandHz).toBe(500);
  });
});

describe("callsignPrefix", () => {
  it("extracts the leading letter+digit prefix", () => {
    expect(callsignPrefix("BG7XXX")).toBe("BG7");
    expect(callsignPrefix("JA1ABC")).toBe("JA1");
    expect(callsignPrefix("K1ABC")).toBe("K1");
  });

  it("returns null when the call has no digit", () => {
    expect(callsignPrefix("ABC")).toBeNull();
    expect(callsignPrefix("")).toBeNull();
  });
});

describe("validateCallsign", () => {
  it("rejects empty input", () => {
    const r = validateCallsign("   ");
    expect(r.ok).toBe(false);
    expect(r.level).toBe("error");
  });

  it("rejects malformed callsigns", () => {
    expect(validateCallsign("ABC").ok).toBe(false); // no digit
    expect(validateCallsign("BG7XXX/").ok).toBe(false); // trailing slash
  });

  it("accepts well-formed callsigns regardless of case", () => {
    expect(validateCallsign("BG7XXX").ok).toBe(true);
    expect(validateCallsign("ja1abc").level).toBe("ok");
  });

  it("warns but still allows a prefix that is not in the DXCC table", () => {
    const r = validateCallsign("BG7XXX", () => false);
    expect(r.ok).toBe(true);
    expect(r.level).toBe("warn");
  });

  it("reports ok when the prefix is known", () => {
    expect(validateCallsign("BG7XXX", (p) => p === "BG7").level).toBe("ok");
  });
});
