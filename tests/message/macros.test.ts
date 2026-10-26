import { describe, expect, it } from "vitest";
import { cutNumbers, expandMacros, macroValuesFrom } from "../../src/message/macros.js";

const values = macroValuesFrom("BG7XXX", "JA1ABC", "599");

describe("cutNumbers", () => {
  it("sends every digit that has a cut form as that form", () => {
    expect(cutNumbers("599")).toBe("5NN");
    expect(cutNumbers("579")).toBe("5BN");
    expect(cutNumbers("339")).toBe("VVN");
    expect(cutNumbers("129")).toBe("AUN");
    expect(cutNumbers("508")).toBe("5TD");
  });

  it("leaves 4, 5 and 6 in full", () => {
    expect(cutNumbers("449")).toBe("44N");
    expect(cutNumbers("569")).toBe("56N");
    expect(cutNumbers("555")).toBe("555");
  });

  it("touches digits only — letters in the text stay", () => {
    expect(cutNumbers("R UR RST 599 K")).toBe("R UR RST 5NN K");
    expect(cutNumbers("")).toBe("");
  });
});

describe("expandMacros", () => {
  it("substitutes every macro the mode files use", () => {
    expect(
      expandMacros("{THEIRCALL} DE {MYCALL} R UR RST {RST} {RST} K", values).text,
    ).toBe("JA1ABC DE BG7XXX R UR RST 5NN 5NN K");
  });

  it("keeps RSTFULL at full length", () => {
    expect(expandMacros("UR RST {RSTFULL}", values).text).toBe("UR RST 599");
  });

  it("cuts the report on the air, but never in {RSTFULL}", () => {
    const v = macroValuesFrom("BG7XXX", "JA1ABC", "579");
    expect(expandMacros("R UR RST {RST} {RST} BK", v).text).toBe("R UR RST 5BN 5BN BK");
    expect(expandMacros("UR RST {RSTFULL}", v).text).toBe("UR RST 579");
  });

  it("accepts lower-case macro names", () => {
    expect(expandMacros("de {mycall}", values).text).toBe("de BG7XXX");
  });

  it("reports a macro whose value is not known yet, and leaves no gap behind", () => {
    const r = expandMacros("{THEIRCALL} DE {MYCALL}", macroValuesFrom("BG7XXX", "", ""));
    expect(r.text).toBe("DE BG7XXX");
    expect(r.missing).toEqual(["THEIRCALL"]);
  });

  it("treats an empty report as missing, so a half report never goes out", () => {
    const r = expandMacros("UR RST {RST} K", macroValuesFrom("BG7XXX", "JA1ABC", ""));
    expect(r.missing).toEqual(["RST"]);
    expect(r.text).toBe("UR RST K");
  });

  it("allows {EXCH} to be empty in DX mode without calling it missing", () => {
    const r = expandMacros("TU {EXCH} SK", values);
    expect(r.missing).toEqual([]);
    expect(r.text).toBe("TU SK");
  });

  it("cuts the contest exchange as well, so serials and zones are ready", () => {
    const v = { myCall: "BG7XXX", theirCall: "JA1ABC", rstFull: "599", exch: "05" };
    expect(expandMacros("NR {EXCH} BK", v).text).toBe("NR T5 BK");
  });

  it("reports an unknown macro instead of silently eating it", () => {
    const r = expandMacros("RST {SNT}", values);
    expect(r.missing).toEqual(["SNT"]);
    expect(r.text).toBe("RST {SNT}");
  });

  it("deduplicates repeated misses", () => {
    const r = expandMacros("{RST} {RST}", macroValuesFrom("BG7XXX", "JA1ABC", ""));
    expect(r.missing).toEqual(["RST"]);
  });

  it("can leave the hole visible as {NAME} instead of dropping it", () => {
    const values = macroValuesFrom("BG7XXX", "", "");
    const r = expandMacros("{THEIRCALL} DE {MYCALL} RST {RST}", values, { keepUnfilled: true });
    // What the key's tooltip shows: the line as it would read once the operator
    // fills the boxes in, with the empty ones still named.
    expect(r.text).toBe("{THEIRCALL} DE BG7XXX RST {RST}");
    expect(r.missing).toEqual(["THEIRCALL", "RST"]);
  });

  it("keeps the macro name as the operator typed it", () => {
    const r = expandMacros("de {mycall}", macroValuesFrom("", "", ""), { keepUnfilled: true });
    expect(r.text).toBe("de {mycall}");
  });

  it("collapses the spaces left by a missing macro", () => {
    expect(expandMacros("A  {EXCH}  B", values).text).toBe("A B");
  });
});
