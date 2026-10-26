import { describe, expect, it } from "vitest";
import {
  blockingField,
  canLog,
  emptyEntry,
  entryStep,
  highlightedKey,
  isValidRst,
  onEnter,
  onSpace,
  type EntryValues,
} from "../../src/ui/entryModel.js";

function entry(patch: Partial<EntryValues> = {}): EntryValues {
  return { ...emptyEntry(), ...patch };
}

describe("entryStep", () => {
  it("starts at the call box, moves to the report, then to the sign-off", () => {
    expect(entryStep(entry())).toBe("call");
    expect(entryStep(entry({ call: "JA1ABC" }))).toBe("report");
    expect(entryStep(entry({ call: "JA1ABC", rstRx: "599" }))).toBe("signoff");
  });

  it("ignores the mode box — a filled call wins in both modes", () => {
    expect(entryStep(entry({ call: "JA1ABC", mode: "s&p" }))).toBe("report");
  });

  it("treats whitespace as empty", () => {
    expect(entryStep(entry({ call: "   " }))).toBe("call");
  });
});

describe("highlightedKey", () => {
  it("lights F1 when calling CQ", () => {
    expect(highlightedKey(entry())).toBe(1);
  });

  it("lights F4 instead when searching and pouncing", () => {
    expect(highlightedKey(entry({ mode: "s&p" }))).toBe(4);
  });

  it("lights F2 once the call is in, and F3 once their report is in", () => {
    expect(highlightedKey(entry({ call: "JA1ABC" }))).toBe(2);
    expect(highlightedKey(entry({ call: "JA1ABC", rstRx: "579" }))).toBe(3);
  });
});

describe("onEnter", () => {
  it("calls CQ from an empty run-mode row", () => {
    const a = onEnter(entry());
    expect(a.send).toBe(1);
    expect(a.clear).toBe(false);
    expect(a.focus).toBeNull();
  });

  it("answers with our call from an empty S&P row, without clearing anything", () => {
    const a = onEnter(entry({ mode: "s&p" }));
    expect(a.send).toBe(4);
    expect(a.clear).toBe(false);
  });

  it("fills 599, sends the report, and moves the caret to their report", () => {
    const a = onEnter(entry({ call: "JA1ABC" }));
    expect(a.send).toBe(2);
    expect(a.fillRstTx).toBe("599");
    expect(a.focus).toBe("rstRx");
    expect(a.log).toBe(false);
  });

  it("keeps a report the operator already set", () => {
    const a = onEnter(entry({ call: "JA1ABC", rstTx: "579" }));
    expect(a.fillRstTx).toBeNull();
    expect(a.send).toBe(2);
  });

  it("signs off, writes the row, and clears it", () => {
    const a = onEnter(entry({ call: "JA1ABC", rstTx: "599", rstRx: "579" }));
    expect(a.send).toBe(3);
    expect(a.log).toBe(true);
    expect(a.clear).toBe(true);
    expect(a.focus).toBe("call");
  });
});

describe("onSpace", () => {
  it("takes the report step without transmitting", () => {
    const a = onSpace(entry({ call: "JA1ABC" }));
    expect(a.send).toBeNull();
    expect(a.fillRstTx).toBe("599");
    expect(a.focus).toBe("rstRx");
  });

  it("does nothing at the first step — there is no step to take alone", () => {
    const a = onSpace(entry());
    expect(a.send).toBeNull();
    expect(a.focus).toBeNull();
  });

  it("does nothing at the last step", () => {
    const a = onSpace(entry({ call: "JA1ABC", rstRx: "599" }));
    expect(a.send).toBeNull();
    expect(a.log).toBe(false);
    expect(a.focus).toBeNull();
  });
});

describe("log row completeness", () => {
  it("requires a call and two three-digit reports", () => {
    expect(canLog(entry({ call: "JA1ABC", rstTx: "599", rstRx: "579" }))).toBe(true);
    expect(canLog(entry({ call: "", rstTx: "599", rstRx: "579" }))).toBe(false);
    expect(canLog(entry({ call: "JA1ABC", rstTx: "", rstRx: "579" }))).toBe(false);
    expect(canLog(entry({ call: "JA1ABC", rstTx: "599", rstRx: "57" }))).toBe(false);
  });

  it("names the box that is holding the row back", () => {
    expect(blockingField(entry({ call: "JA1ABC", rstTx: "599", rstRx: "579" }))).toBeNull();
    expect(blockingField(entry({ rstTx: "599", rstRx: "579" }))).toBe("call");
    expect(blockingField(entry({ call: "JA1ABC", rstRx: "579" }))).toBe("rstTx");
    expect(blockingField(entry({ call: "JA1ABC", rstTx: "599", rstRx: "59" }))).toBe("rstRx");
  });
});

describe("isValidRst", () => {
  it("accepts the reports a CW operator can actually send", () => {
    expect(isValidRst("599")).toBe(true);
    expect(isValidRst("579")).toBe(true);
    expect(isValidRst("339")).toBe(true);
  });

  it("rejects anything that is not three valid digits", () => {
    expect(isValidRst("")).toBe(false);
    expect(isValidRst("59")).toBe(false);
    expect(isValidRst("5999")).toBe(false);
    expect(isValidRst("099")).toBe(false);
    expect(isValidRst("5a9")).toBe(false);
  });
});
