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
  return { ...emptyEntry("run"), ...patch };
}

describe("entryStep", () => {
  it("starts at the call box, moves to the report, then to the sign-off", () => {
    expect(entryStep(entry())).toBe("call");
    expect(entryStep(entry({ call: "JA1ABC" }))).toBe("report");
    expect(entryStep(entry({ call: "JA1ABC", reportSent: true, rstRx: "599" }))).toBe(
      "signoff",
    );
  });

  it("in S&P, a copied call asks for our call before the report", () => {
    expect(entryStep(entry({ call: "JA1ABC", mode: "s&p" }))).toBe("answer");
    expect(entryStep(entry({ call: "JA1ABC", rstTx: "599", mode: "s&p" }))).toBe("report");
  });

  it("the ladder is the same in every mode — a contest S&P keeps the answer step", () => {
    // 抄清呼号只是知道该叫谁，还没叫出去：报告不能是对方听见的第一句。
    // 比赛不改进这一级，因为那个台在听见我们的呼号之前不知道是谁在叫它。
    const copied = entry({ call: "JA1ABC", mode: "s&p" });
    expect(entryStep(copied)).toBe("answer");
    expect(highlightedKey(copied)).toBe(4);
    expect(entryStep({ ...copied, rstTx: "599" })).toBe("report");
    expect(highlightedKey({ ...copied, rstTx: "599" })).toBe(2);
  });

  it("no mode adds a rung: a run's report message names the station itself", () => {
    // 主叫不是在应答谁，所以它没有「报名」这一级——报文里已经带了呼号。
    for (const contest of ["DX", "CQWW", "WPX"] as const) {
      expect(onEnter(entry({ call: "JA1ABC" }), contest).send).toBe(2);
    }
  });

  it("their report does not end the row before ours has gone out — either mode", () => {
    for (const mode of ["run", "s&p"] as const) {
      const base = { call: "JA1ABC", rstTx: "599", rstRx: "579", mode };
      expect(entryStep(entry({ ...base, reportSent: false }))).toBe("report");
      expect(entryStep(entry({ ...base, reportSent: true }))).toBe("signoff");
    }
  });

  it("a station answering our CQ with call and report at once still owes us a report", () => {
    // Run mode, both boxes copied, our RST never sent: it is not the sign-off yet.
    expect(entryStep(entry({ call: "JA1ABC", rstRx: "579", mode: "run" }))).toBe("report");
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

  it("keeps F4 lit in S&P until the report is chosen", () => {
    expect(highlightedKey(entry({ call: "JA1ABC", mode: "s&p" }))).toBe(4);
    expect(highlightedKey(entry({ call: "JA1ABC", rstTx: "579", mode: "s&p" }))).toBe(2);
  });

  it("lights F2 once the call is in, and F3 once both reports are in", () => {
    expect(highlightedKey(entry({ call: "JA1ABC" }))).toBe(2);
    expect(highlightedKey(entry({ call: "JA1ABC", rstRx: "579" }))).toBe(2);
    expect(highlightedKey(entry({ call: "JA1ABC", reportSent: true, rstRx: "579" }))).toBe(3);
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

  it("puts our call on the air first in S&P, then hands over to the report", () => {
    const a = onEnter(entry({ call: "JA1ABC", mode: "s&p" }));
    expect(a.send).toBe(4);
    expect(a.fillRstTx).toBe("599");
    // 光标去"对方 RST"：被应答的那台会连呼号带报告一起回来，先抄他。
    expect(a.focus).toBe("rstRx");
    expect(a.log).toBe(false);
  });

  it("marks the report as sent when the report step is taken", () => {
    expect(onEnter(entry({ call: "JA1ABC" })).markReported).toBe(true);
    expect(onEnter(entry())).toMatchObject({ send: 1, markReported: false });
    // 他的报告已经抄下，我方的还没发：回车仍是发报告，不是收尾。
    expect(onEnter(entry({ call: "JA1ABC", rstRx: "579" }))).toMatchObject({
      send: 2,
      markReported: true,
    });
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
    const a = onEnter(entry({ call: "JA1ABC", rstTx: "599", rstRx: "579", reportSent: true }));
    expect(a.send).toBe(3);
    expect(a.log).toBe(true);
    expect(a.clear).toBe(true);
    expect(a.focus).toBe("call");
  });

  it("TU 已经发过时，回车只落账，不再把 TU 发一遍", () => {
    const a = onEnter(
      entry({ call: "JA1ABC", rstTx: "599", rstRx: "579", reportSent: true, signoffSent: true }),
    );
    expect(a.send).toBeNull();
    expect(a.log).toBe(true);
    expect(a.clear).toBe(true);
  });
});

describe("onSpace", () => {
  it("takes the report step without transmitting", () => {
    const a = onSpace(entry({ call: "JA1ABC" }));
    expect(a.send).toBeNull();
    expect(a.fillRstTx).toBe("599");
    expect(a.focus).toBe("rstRx");
  });

  it("takes the S&P opening step too, without transmitting", () => {
    const a = onSpace(entry({ call: "JA1ABC", mode: "s&p" }));
    expect(a.send).toBeNull();
    expect(a.fillRstTx).toBe("599");
    expect(a.focus).toBe("rstRx");
  });

  it("space on the report step still counts as the report going out", () => {
    expect(onSpace(entry({ call: "JA1ABC" })).markReported).toBe(true);
  });

  it("does nothing at the first step — there is no step to take alone", () => {
    const a = onSpace(entry());
    expect(a.send).toBeNull();
    expect(a.focus).toBeNull();
  });

  it("does nothing at the last step", () => {
    const a = onSpace(entry({ call: "JA1ABC", rstRx: "599", reportSent: true }));
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

describe("比赛模式下的那一行", () => {
  const done: EntryValues = entry({
    call: "JA1ABC",
    rstTx: "599",
    rstRx: "599",
    exchRx: "05",
    reportSent: true,
  });

  it("DX 不看交换信息：三个框齐了就能记", () => {
    const dx = entry({ call: "JA1ABC", rstTx: "599", rstRx: "599" });
    expect(canLog(dx, "DX")).toBe(true);
    expect(blockingField(dx, "DX")).toBeNull();
  });

  it("CQWW 少了对方分区就记不了，并指出是哪一格", () => {
    const noExch = entry({ call: "JA1ABC", rstTx: "599", rstRx: "599" });
    expect(canLog(noExch, "CQWW")).toBe(false);
    expect(blockingField(noExch, "CQWW")).toBe("exchRx");
  });

  it("分区超出 1–40、序号为 0 都不算数", () => {
    expect(canLog({ ...done, exchRx: "41" }, "CQWW")).toBe(false);
    expect(canLog({ ...done, exchRx: "0" }, "WPX")).toBe(false);
    expect(canLog({ ...done, exchRx: "001" }, "WPX")).toBe(true);
  });

  it("序号多少位都算数：抄到几位就记几位", () => {
    // 虚拟台这一版只发 001–999，但「抄不到四位」不等于「四位算错」——
    // 拦下它会变成在教一件错事。
    expect(canLog({ ...done, exchRx: "1234" }, "WPX")).toBe(true);
    expect(blockingField({ ...done, exchRx: "1234" }, "WPX")).toBeNull();
    expect(canLog({ ...done, exchRx: "10000" }, "WPX")).toBe(true);
    expect(canLog({ ...done, exchRx: "0" }, "WPX")).toBe(false);
  });

  it("比赛的 Run 一步到位：抄清呼号按回车就是发报告，不先报名", () => {
    // 主叫不是在应答谁：报告那一句自带呼号（JA1ABC 5NN 24），不用先单独报一次自己。
    const taken = onEnter(entry({ call: "JA1ABC" }), "CQWW");
    expect(taken.send).toBe(2);
    expect(taken.fillRstRx).toBe("599");
    expect(taken.markReported).toBe(true);
  });

  it("比赛的 S&P 报名之后，光标直接去对方那个号", () => {
    // 比赛双方都报 599，所以两个报告框都不用抄：取一步就都填上，光标落在
    // 唯一还空着的那一格——对方的交换数字。
    const cqww = onEnter(entry({ call: "JA1ABC", mode: "s&p" }), "CQWW");
    expect(cqww.send).toBe(4);
    expect(cqww.fillRstTx).toBe("599");
    expect(cqww.fillRstRx).toBe("599");
    expect(cqww.focus).toBe("exchRx");

    // WPX 连我方序号一起填好，落点一样。
    const wpx = onEnter(entry({ call: "JA1ABC", mode: "s&p" }), "WPX");
    expect(wpx.fillOwnNr).toBe(true);
    expect(wpx.focus).toBe("exchRx");

    // 空格走同一步，落点也一样。
    expect(onSpace(entry({ call: "JA1ABC", mode: "s&p" }), "CQWW").focus).toBe("exchRx");

    // 日常不是这样：他的报告要一个字一个字抄，所以停在那一格。
    expect(onEnter(entry({ call: "JA1ABC", mode: "s&p" })).focus).toBe("rstRx");
  });

  it("分区没抄到时不发第二轮：收尾那一步按下去会被拦下来", () => {
    const awaitingExch = entry({
      call: "JA1ABC",
      rstTx: "599",
      rstRx: "599",
      reportSent: true,
    });
    // 步进不受交换信息影响——它和对方的报告是一起抄下来的。
    expect(entryStep(awaitingExch)).toBe("signoff");
    expect(highlightedKey(awaitingExch)).toBe(3);
    // 但记不了账，指到空着的那一格。
    expect(canLog(awaitingExch, "CQWW")).toBe(false);
    expect(blockingField(awaitingExch, "CQWW")).toBe("exchRx");
  });

  it("取一步就把已知的填上：两个 RST 与我方序号，光标去抄对方的号", () => {
    const copied = entry({ call: "JA1ABC" });
    const taken = onSpace(copied, "WPX");
    expect(taken.fillRstTx).toBe("599");
    expect(taken.fillRstRx).toBe("599");
    expect(taken.fillOwnNr).toBe(true);
    expect(taken.focus).toBe("exchRx");
    // 空格是「我自己发」，所以不发报文。
    expect(taken.send).toBeNull();
  });

  it("手填过的框不覆盖", () => {
    const copied = entry({ call: "JA1ABC", rstTx: "579", rstRx: "559", ownNr: "42" });
    const taken = onEnter(copied, "WPX");
    expect(taken.fillRstTx).toBeNull();
    expect(taken.fillRstRx).toBeNull();
    expect(taken.fillOwnNr).toBe(false);
  });

  it("DX 还是先报自己再报报告", () => {
    const copied = entry({ call: "JA1ABC", mode: "s&p" });
    expect(entryStep(copied)).toBe("answer");
    expect(highlightedKey(copied)).toBe(4);
  });

  it("清空一行时交换信息与我方序号一起清掉", () => {
    expect(emptyEntry("run")).toMatchObject({ exchRx: "", ownNr: "" });
  });
});
