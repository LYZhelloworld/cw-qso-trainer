import { describe, it, expect } from "vitest";
import {
  decodeKeying,
  estimateUnit,
  classifyElement,
  MorseDecoder,
  type KeyElement,
} from "../../src/cw/decoder.js";
import { textToTiming } from "../../src/cw/encode.js";
import { QsoMachine } from "../../src/qso/stateMachine.js";
import { VirtualHam } from "../../src/ham/virtualHam.js";
import { dxccDatabase } from "../../src/data/dxcc.js";

function jitter(els: KeyElement[], amount: number): KeyElement[] {
  return els.map((e) => ({
    on: e.on + amount,
    off: e.off + amount,
  }));
}

describe("classifyElement / estimateUnit", () => {
  it("classifies dot vs dash at the 2d threshold", () => {
    expect(classifyElement(100, 100)).toBe(".");
    expect(classifyElement(300, 100)).toBe("-");
    expect(classifyElement(199, 100)).toBe(".");
    expect(classifyElement(201, 100)).toBe("-");
  });

  it("estimates the dot unit from the shortest key-down", () => {
    expect(estimateUnit([300, 100, 100, 300])).toBe(100);
    expect(estimateUnit([])).toBe(100); // fallback
  });
});

describe("decodeKeying — round trip (standard speed)", () => {
  it("recovers the original text with an explicit unit", () => {
    const text = "CQ DE BG7XXX";
    const els = textToTiming(text, { unit: 100 });
    expect(decodeKeying(els, { unit: 100 }).text).toBe(text);
  });

  it("recovers the original text with wpm", () => {
    const text = "JA1ABC R UR RST 599 BK";
    const els = textToTiming(text, { wpm: 20 });
    expect(decodeKeying(els, { wpm: 20 }).text).toBe(text);
  });
});

describe("decodeKeying — auto unit estimation", () => {
  it("estimates d from timing when no unit/wpm is given", () => {
    const text = "HELLO WORLD";
    const els = textToTiming(text, { wpm: 15 }); // d = 80ms
    expect(decodeKeying(els).text).toBe(text);
  });
});

describe("decodeKeying — Farnsworth (the trap)", () => {
  it("does NOT split letters into words when spacing is stretched", () => {
    const text = "CQ DE";
    const els = textToTiming(text, { wpm: 20, farnsworthWpm: 5 });
    // d = 60ms; letter gap stretched to 3*(1200/5)=720ms; word gap to 1680ms.
    expect(decodeKeying(els).text).toBe("CQ DE");
  });

  it("still separates words correctly under Farnsworth", () => {
    const text = "CQ CQ DE BG7XXX";
    const els = textToTiming(text, { wpm: 25, farnsworthWpm: 8 });
    expect(decodeKeying(els).text).toBe(text);
  });
});

describe("decodeKeying — 单词阈值下限", () => {
  it("字符间隔紧到 2d 时，4d 的静默仍在词内", () => {
    // 手键快拍：字符间隔只有 2d，`1.8 x 2d = 3.6d` 低于 5d 下限。若无下限，
    // 紧随其后的 4d 静默会被当成换词，解出 "ET E"；有下限则仍是 "ETE"。
    const d = 100;
    const els: KeyElement[] = [
      { on: d, off: 2 * d },
      { on: 3 * d, off: 4 * d },
      { on: d, off: 0 },
    ];
    expect(decodeKeying(els, { unit: d }).text).toBe("ETE");
  });
});

describe("decodeKeying — tolerance & errors", () => {
  it("absorbs +/-0.5d timing jitter", () => {
    const text = "TEST";
    const els = textToTiming(text, { unit: 100 });
    const jittered = jitter(els, 40); // ~0.4d drift, within +/-0.5d
    expect(decodeKeying(jittered, { unit: 100 }).text).toBe(text);
  });

  it("flags an unknown symbol instead of fabricating a character", () => {
    // Six dots in a row is not a valid Morse character.
    const els: KeyElement[] = [
      { on: 100, off: 100 },
      { on: 100, off: 100 },
      { on: 100, off: 100 },
      { on: 100, off: 100 },
      { on: 100, off: 100 },
      { on: 100, off: 0 },
    ];
    const r = decodeKeying(els, { unit: 100 });
    expect(r.unknown).toEqual(["......"]);
    expect(r.text).toBe("?");
  });

  it("ignores a trailing gap so it never adds a spurious word", () => {
    const els = textToTiming("SOS", { unit: 100 });
    expect(decodeKeying(els, { unit: 100 }).text).toBe("SOS");
  });
});

describe("MorseDecoder (streaming wrapper)", () => {
  it("collects elements and decodes on finish", () => {
    const dec = new MorseDecoder();
    for (const e of textToTiming("CQ", { unit: 100 })) dec.push(e);
    expect(dec.finish({ unit: 100 }).text).toBe("CQ");
  });
});

describe("integration — decoder feeds the step-1 state machine", () => {
  it("drives the full 6-line CQ exchange to LOGGED via userSendKeying", () => {
    const m = new QsoMachine({
      myCall: "BG7XXX",
      ham: new VirtualHam({ call: "JA1ABC", difficulty: "novice" }),
      db: dxccDatabase,
    });

    m.userSendKeying(textToTiming("CQ CQ CQ DE BG7XXX BG7XXX PSE K", { wpm: 20 }));
    expect(m.state).toBe("USER_CQ");

    m.hamAnswerCq();
    expect(m.state).toBe("EXCHANGE");

    m.userSendKeying(textToTiming("JA1ABC DE BG7XXX R UR RST 599 599 BK", { wpm: 20 }));
    expect(m.state).toBe("SIGNOFF");

    m.userSendKeying(textToTiming("R TU 73 SK", { wpm: 20 }));
    expect(m.state).toBe("LOGGED");
    expect(m.getLog()?.peerCall).toBe("JA1ABC");
  });
});
