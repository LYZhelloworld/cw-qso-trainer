import { describe, expect, it } from "vitest";
import { expandMacros, macroValuesFrom, shortRst } from "../../src/message/macros.js";

const values = macroValuesFrom("BG7XXX", "JA1ABC", "599");

describe("shortRst", () => {
  it("sends 9 as N, leaving other digits alone", () => {
    expect(shortRst("599")).toBe("5NN");
    expect(shortRst("579")).toBe("57N");
    expect(shortRst("449")).toBe("44N");
    expect(shortRst("559")).toBe("55N");
    expect(shortRst("555")).toBe("555");
    expect(shortRst("")).toBe("");
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
