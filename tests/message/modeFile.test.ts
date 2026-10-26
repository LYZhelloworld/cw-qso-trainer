import { describe, expect, it } from "vitest";
import { isReserved, parseModeFile } from "../../src/message/modeFile.js";
import { parseBundledMode } from "../../src/data/modeMessages.js";

const text = (...lines: string[]): string => lines.join("\n");

describe("parseModeFile: format", () => {
  it("splits F<n> into a button label and a message", () => {
    const { config } = parseModeFile("F1 CQ,CQ CQ CQ DE {MYCALL} PSE K", "DX");
    expect(config.id).toBe("DX");
    expect(config.messages[0]).toEqual({
      key: 1,
      label: "CQ",
      text: "CQ CQ CQ DE {MYCALL} PSE K",
    });
  });

  it("always returns eight keys, in order, filling the gaps as reserved", () => {
    const { config } = parseModeFile("F3 TU,R TU 73 SK", "DX");
    expect(config.messages.map((m) => m.key)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(config.messages[2].text).toBe("R TU 73 SK");
    expect(isReserved(config.messages[0])).toBe(true);
    expect(isReserved(config.messages[7])).toBe(true);
  });

  it("skips blank lines and whole-line comments", () => {
    const { config, problems } = parseModeFile(
      text("# 说明", "", "   ", "F1 CQ,cq de {MYCALL}", "   # 缩进的注释也算"),
      "DX",
    );
    expect(problems).toEqual([]);
    expect(config.messages[0].text).toBe("cq de {MYCALL}");
  });

  it("splits on the first comma only, so a message may contain commas", () => {
    const { config } = parseModeFile("F1 CQ,a,b,c", "DX");
    expect(config.messages[0].label).toBe("CQ");
    expect(config.messages[0].text).toBe("a,b,c");
  });

  it("treats a line without a comma as message-only, with no label", () => {
    const { config } = parseModeFile("F7 ?", "DX");
    expect(config.messages[6]).toEqual({ key: 7, label: "", text: "?" });
  });

  it("treats a bare key name, or a bare comma, as a reserved key", () => {
    expect(parseModeFile("F8", "DX").config.messages[7]).toEqual({
      key: 8,
      label: "",
      text: "",
    });
    expect(parseModeFile("F8 ,", "DX").config.messages[7].text).toBe("");
  });

  it("keeps a message with an inner # intact (no inline comments)", () => {
    const { config } = parseModeFile("F1 CQ,CQ DE {MYCALL} # 5NN", "DX");
    expect(config.messages[0].text).toBe("CQ DE {MYCALL} # 5NN");
  });
});

describe("parseModeFile: problems", () => {
  it("reports a key outside F1–F8 and drops that line", () => {
    const { config, problems } = parseModeFile("F9 X,x", "DX");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("F9");
    expect(problems[0]).toContain("超出范围");
    expect(config.messages.every(isReserved)).toBe(true);
  });

  it("reports an unparsable line with its line number", () => {
    const { problems } = parseModeFile(text("# 头", "CQ CQ CQ DE BG7XXX"), "DX");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("第 2 行");
  });

  it("lets a later duplicate win, and says so", () => {
    const { config, problems } = parseModeFile(text("F1 A,one", "F1 B,two"), "DX");
    expect(config.messages[0]).toEqual({ key: 1, label: "B", text: "two" });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("重复");
  });
});

describe("the bundled DX.msg", () => {
  it("parses cleanly", () => {
    const { problems } = parseBundledMode();
    expect(problems).toEqual([]);
  });

  it("holds the eight documented messages", () => {
    const { config } = parseBundledMode();
    const rows = config.messages.map((m) => [m.key, m.label, m.text]);
    expect(rows).toEqual([
      [1, "CQ", "CQ CQ CQ DE {MYCALL} {MYCALL} PSE K"],
      [2, "RST", "R UR RST {RST} {RST} BK"],
      [3, "TU", "R TU 73 SK"],
      [4, "{MYCALL}", "{THEIRCALL} DE {MYCALL}"],
      [5, "{THEIRCALL}", "{THEIRCALL}"],
      [6, "RST REPEAT", "R UR RST {RST} {RST} K"],
      [7, "?", "?"],
      [8, "", ""],
    ]);
  });

  it("leaves F8 as the reserved key", () => {
    expect(isReserved(parseBundledMode().config.messages[7])).toBe(true);
  });
});
