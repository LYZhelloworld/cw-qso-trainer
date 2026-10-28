import { describe, expect, it } from "vitest";
import { BUNDLED_MODE_RAW, modeFileName, parseBundledMode } from "../../src/data/modeMessages.js";
import { CONTEST_KINDS } from "../../src/qso/contest.js";

/**
 * The three bundled key sets. One file per mode: switching the rig's mode
 * switches all eight keys, and the two contest sets are the same eight words
 * with a different number in `{EXCH}`.
 */
describe("内置模式报文", () => {
  it("每种模式都有一个文件", () => {
    for (const kind of CONTEST_KINDS) {
      expect(modeFileName(kind)).toBe(`${kind}.msg`);
      expect(BUNDLED_MODE_RAW[kind].trim().length).toBeGreaterThan(0);
    }
  });

  it("三份都能干净地解析出八个键", () => {
    for (const kind of CONTEST_KINDS) {
      const parsed = parseBundledMode(kind);
      expect(parsed.problems).toEqual([]);
      expect(parsed.config.id).toBe(kind);
      expect(parsed.config.messages.map((m) => m.key)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    }
  });

  it("比赛的两份按键序与 doc/MESSAGES.md 一致", () => {
    for (const kind of ["CQWW", "WPX"] as const) {
      const texts = parseBundledMode(kind).config.messages.map((m) => m.text);
      expect(texts).toEqual([
        "CQ TEST {MYCALL}",
        "{THEIRCALL} {RST} {EXCH}",
        "TU",
        "{MYCALL}",
        "{THEIRCALL}",
        "{RST} {EXCH} {EXCH}",
        "?",
        "NR?",
      ]);
    }
  });

  it("DX 还是原来那八个键", () => {
    const texts = parseBundledMode("DX").config.messages.map((m) => m.text);
    expect(texts[0]).toBe("CQ CQ CQ DE {MYCALL} {MYCALL} PSE K");
    expect(texts[6]).toBe("?");
    expect(texts[7]).toBe("");
  });
});
