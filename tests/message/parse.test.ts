import { describe, it, expect } from "vitest";
import {
  normalize,
  validateCallsign,
  parseMessage,
  CALL_RE,
  type ParseContext,
} from "../../src/message/parse.js";
import { dxccDatabase } from "../../src/data/dxcc.js";

const ctxBase: ParseContext = {
  myCall: "BG7XXX",
  peerCall: "JA1ABC",
  callsignsConfirmed: true,
  callsignsOmitted: false,
};

describe("normalize", () => {
  it("collapses whitespace and uppercases", () => {
    expect(normalize("  cq   de  bg7xxx ")).toBe("CQ DE BG7XXX");
  });
  it("folds 5NN -> 599", () => {
    expect(normalize("UR RST 5NN")).toBe("UR RST 599");
  });
  it("folds TNX/THX -> TU and <SK> -> SK", () => {
    expect(normalize("TNX THX <SK>")).toBe("TU TU SK");
  });
});

describe("validateCallsign (ITU format + prefix table)", () => {
  const good = ["BG7XXX", "B5", "B1", "B5ABC", "JA1ABC", "VR2XXX", "W1AW", "BG7XXX/P", "JA1ABC/5", "JA1ABC/QRP"];
  it.each(good)("%s is valid", (c) => {
    expect(validateCallsign(c, dxccDatabase)).toBe(true);
  });

  const bad = ["QQ1ABC", "599", "ABC", "1ABC"];
  it.each(bad)("%s is invalid", (c) => {
    expect(CALL_RE.test(c)).toBe(c !== "599" && c !== "ABC" && c !== "1ABC" && c !== "BG7" && c !== "JA1");
    expect(validateCallsign(c, dxccDatabase)).toBe(false);
  });
});

describe("parseMessage", () => {
  it("dedupes repeated CQ and classifies as CQ", () => {
    const p = parseMessage(
      "CQ CQ CQ DE BG7XXX BG7XXX PSE K",
      { ...ctxBase, peerCall: null, callsignsConfirmed: false },
      "tx",
      dxccDatabase,
    );
    expect(p.type).toBe("CQ");
    expect(p.callsigns).toEqual(["BG7XXX"]);
    expect(p.callsignValid).toBe(true);
    expect(p.end).toBe("PSE_K");
  });

  it("parses a normal RST exchange line", () => {
    const p = parseMessage("JA1ABC DE BG7XXX R UR RST 599 599 BK", ctxBase, "tx", dxccDatabase);
    expect(p.type).toBe("RST");
    expect(p.rst).toBe("599");
    expect(p.end).toBe("BK");
    expect(p.callsigns).toEqual(["JA1ABC", "BG7XXX"]);
  });

  it("marks omitted callsign after confirmation", () => {
    const p = parseMessage("R UR RST 599 BK", ctxBase, "tx", dxccDatabase);
    expect(p.omit_calls).toBe(true);
    expect(p.to).toBe("JA1ABC");
    expect(p.from).toBe("BG7XXX");
  });

  it("flags an illegal RST (no valid token) as QUERY", () => {
    const p = parseMessage("UR RST 5999", ctxBase, "tx", dxccDatabase);
    expect(p.type).toBe("QUERY");
    expect(p.rst).toBeNull();
  });

  it("detects end phrases and SK end marker", () => {
    const p = parseMessage("R TU 73 SK", ctxBase, "tx", dxccDatabase);
    expect(p.type).toBe("END");
    expect(p.end).toBe("SK");
  });

  it("flags an invalid (unknown-prefix) callsign for copy-error handling", () => {
    const p = parseMessage("QQ1ABC DE BG7XXX", ctxBase, "tx", dxccDatabase);
    expect(p.callsignValid).toBe(false);
    expect(p.callsigns).toEqual(["QQ1ABC", "BG7XXX"]);
  });

  it("handles operation suffixes in the addressed callsign", () => {
    const p = parseMessage("JA1ABC/P DE BG7XXX R UR RST 599 BK", ctxBase, "tx", dxccDatabase);
    expect(p.callsigns).toContain("JA1ABC/P");
    expect(p.callsignValid).toBe(true);
  });

  it("marks omitted callsign for a K-ended line (not only BK)", () => {
    // 收发基线：用户用纯 K（而非 BK）交还发言权且省略呼号，仍应判为省略。
    const p = parseMessage("R UR RST 599 K", ctxBase, "tx", dxccDatabase);
    expect(p.omit_calls).toBe(true);
    expect(p.to).toBe("JA1ABC");
    expect(p.from).toBe("BG7XXX");
    expect(p.end).toBe("K");
    expect(p.type).toBe("RST");
  });

  it("distinguishes PSE K, K and BK end markers without over-matching", () => {
    expect(
      parseMessage("CQ CQ CQ DE BG7XXX BG7XXX PSE K", { ...ctxBase, peerCall: null, callsignsConfirmed: false }, "tx", dxccDatabase).end,
    ).toBe("PSE_K");
    expect(parseMessage("R UR RST 599 K", ctxBase, "tx", dxccDatabase).end).toBe("K");
    expect(parseMessage("R UR RST 599 BK", ctxBase, "tx", dxccDatabase).end).toBe("BK");
  });

  it("parses an RST exchange line without the leading R", () => {
    // 收发基线：用户可省略开头的 R。
    const p = parseMessage("UR RST 599 599 BK", ctxBase, "tx", dxccDatabase);
    expect(p.type).toBe("RST");
    expect(p.rst).toBe("599");
    expect(p.end).toBe("BK");
  });

  it("classifies a sign-off with no K/BK as END (e.g. TU 73)", () => {
    // 用户没发 K/BK 直接结束（也无 SK），结束语词 TU/73 仍应识别为 END。
    const p = parseMessage("R TU 73", ctxBase, "tx", dxccDatabase);
    expect(p.type).toBe("END");
    expect(p.end).toBeNull();
  });
});
