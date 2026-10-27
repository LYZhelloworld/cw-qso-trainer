import { describe, expect, it } from "vitest";
import {
  CONTEST_RST,
  cqText,
  contestReport,
  formatSerial,
  formatZone,
  isValidExchange,
  isValidSerial,
  isValidZone,
  normaliseExchange,
  ownExchangeText,
  ownZone,
  requiresExchange,
  stationExchange,
  verifyEntry,
  zoneOfCall,
  type PartnerTruth,
} from "../../src/qso/contest.js";
import { VirtualHam } from "../../src/ham/virtualHam.js";

function ham(call: string): VirtualHam {
  return new VirtualHam({ call, difficulty: "novice" });
}

describe("交换信息的格式", () => {
  it("CQ 分区补成两位，序号补成三位", () => {
    expect(formatZone(5)).toBe("05");
    expect(formatZone(24)).toBe("24");
    expect(formatSerial(1)).toBe("001");
    expect(formatSerial(37)).toBe("037");
    expect(formatSerial(1234)).toBe("1234");
  });

  it("分区只认 1–40，序号只认 1–9999", () => {
    expect(isValidZone("05")).toBe(true);
    expect(isValidZone("40")).toBe(true);
    expect(isValidZone("0")).toBe(false);
    expect(isValidZone("41")).toBe(false);
    expect(isValidZone("")).toBe(false);

    expect(isValidSerial("001")).toBe(true);
    expect(isValidSerial("9999")).toBe(true);
    expect(isValidSerial("0")).toBe(false);
    expect(isValidSerial("10000")).toBe(false);
  });

  it("DX 没有交换信息，什么值都算数", () => {
    expect(requiresExchange("DX")).toBe(false);
    expect(isValidExchange("DX", "whatever")).toBe(true);
    expect(isValidExchange("CQWW", "41")).toBe(false);
    expect(isValidExchange("WPX", "007")).toBe(true);
  });

  it("比较时忽略前导零：5 与 05 与 005 是同一个数", () => {
    expect(normaliseExchange("CQWW", "05")).toBe("5");
    expect(normaliseExchange("CQWW", "5")).toBe("5");
    expect(normaliseExchange("WPX", "005")).toBe("5");
    expect(normaliseExchange("WPX", "")).toBe("");
    expect(normaliseExchange("DX", "12")).toBe("");
  });
});

describe("我方发出去的数字", () => {
  it("CQWW 默认按本方呼号推断分区", () => {
    expect(zoneOfCall("BG7XXX")).toBe(24);
    expect(zoneOfCall("JA1ABC")).toBe(25);
    expect(ownZone(0, "BG7XXX")).toBe(24);
  });

  it("手工填的分区优先于呼号推断", () => {
    expect(ownZone(15, "BG7XXX")).toBe(15);
    expect(ownExchangeText("CQWW", { cqZone: 15, wpxSerial: 1, myCall: "BG7XXX" })).toBe("15");
  });

  it("WPX 发的是设置里那个序号，从 001 开始", () => {
    expect(ownExchangeText("WPX", { cqZone: 0, wpxSerial: 1, myCall: "BG7XXX" })).toBe("001");
    expect(ownExchangeText("WPX", { cqZone: 0, wpxSerial: 42, myCall: "BG7XXX" })).toBe("042");
  });

  it("DX 什么也不发", () => {
    expect(ownExchangeText("DX", { cqZone: 0, wpxSerial: 9, myCall: "BG7XXX" })).toBe("");
  });
});

describe("对方发来的数字", () => {
  it("CQWW 用对方呼号所属实体的分区", () => {
    expect(stationExchange(ham("JA1ABC"), "CQWW")).toBe("25");
    expect(stationExchange(ham("DL1ABC"), "CQWW")).toBe("14");
    expect(stationExchange(ham("K1ABC"), "CQWW")).toBe("05");
  });

  it("WPX 的序号跟着呼号走：同一台永远是同一个号", () => {
    const first = stationExchange(ham("JA1ABC"), "WPX");
    expect(first).toMatch(/^\d{3}$/);
    expect(Number(first)).toBeGreaterThanOrEqual(1);
    expect(Number(first)).toBeLessThanOrEqual(999);
    expect(stationExchange(ham("JA1ABC"), "WPX")).toBe(first);
  });

  it("DX 没有交换信息", () => {
    expect(stationExchange(ham("JA1ABC"), "DX")).toBe("");
  });
});

describe("比赛里的报告与呼叫", () => {
  it("比赛一律 5NN，DX 保留各台自己的报告", () => {
    expect(contestReport("CQWW", "579")).toBe(CONTEST_RST);
    expect(contestReport("WPX", "549")).toBe(CONTEST_RST);
    expect(contestReport("DX", "579")).toBe("579");
  });

  it("比赛呼叫 CQ TEST，日常呼叫长格式", () => {
    expect(cqText("BG7XXX", "CQWW")).toBe("CQ TEST BG7XXX BG7XXX");
    expect(cqText("BG7XXX", "DX")).toBe("CQ CQ CQ DE BG7XXX BG7XXX PSE K");
  });
});

describe("核对抄收", () => {
  const truth: PartnerTruth = { call: "JA1ABC", report: "599", exch: "05" };

  it("三项都对", () => {
    expect(verifyEntry({ call: "JA1ABC", rstRx: "599", exchRx: "05" }, truth, "CQWW")).toBe("ok");
  });

  it("呼号错优先于交换信息错", () => {
    expect(verifyEntry({ call: "JA1ABD", rstRx: "599", exchRx: "14" }, truth, "CQWW")).toBe(
      "call",
    );
  });

  it("呼号对、交换信息错，是另一类错误", () => {
    expect(verifyEntry({ call: "JA1ABC", rstRx: "599", exchRx: "14" }, truth, "CQWW")).toBe(
      "exch",
    );
  });

  it("只有 RST 错时单独说 RST", () => {
    expect(verifyEntry({ call: "JA1ABC", rstRx: "579", exchRx: "05" }, truth, "CQWW")).toBe("rst");
  });

  it("没有可核对的台就不下结论", () => {
    expect(verifyEntry({ call: "JA1ABC", rstRx: "599", exchRx: "" }, null, "DX")).toBeUndefined();
  });
});
