import { describe, it, expect } from "vitest";
import type { QsoLog } from "../../src/qso/stateMachine.js";
import { canWriteLog, deriveLogRecord, formatFreqMHz, type LogGate } from "../../src/ui/logRecord.js";

const completeGate: LogGate = {
  state: "LOGGED",
  callsignsConfirmed: true,
  rstRx: "599",
  rstTx: "599",
  peerEndHeard: true,
  userEndSent: true,
};

const completeQso: QsoLog = {
  myCall: "BG7XXX",
  peerCall: "JA1ABC",
  rstRx: "599",
  rstTx: "579",
  date: "2026-10-14T12:34:56.000Z",
};

describe("canWriteLog", () => {
  it("is true only when all six LOG.md conditions hold", () => {
    expect(canWriteLog(completeGate)).toBe(true);
  });

  it("requires the LOGGED state", () => {
    expect(canWriteLog({ ...completeGate, state: "SIGNOFF" })).toBe(false);
    expect(canWriteLog({ ...completeGate, state: "EXCHANGE" })).toBe(false);
  });

  it("requires confirmed callsigns", () => {
    expect(canWriteLog({ ...completeGate, callsignsConfirmed: false })).toBe(false);
  });

  it("requires both RSTs", () => {
    expect(canWriteLog({ ...completeGate, rstRx: null })).toBe(false);
    expect(canWriteLog({ ...completeGate, rstTx: null })).toBe(false);
  });

  it("requires both ends to have been exchanged", () => {
    expect(canWriteLog({ ...completeGate, peerEndHeard: false })).toBe(false);
    expect(canWriteLog({ ...completeGate, userEndSent: false })).toBe(false);
  });
});

describe("deriveLogRecord", () => {
  it("maps a completed QSO onto the LOG.md log fields", () => {
    const rec = deriveLogRecord(completeQso, 14.025, new Date("2026-10-14T12:34:56.000Z"));
    expect(rec).not.toBeNull();
    expect(rec?.date).toBe("2026-10-14");
    expect(rec?.timeUtc).toBe("12:34:56");
    expect(rec?.call).toBe("JA1ABC");
    expect(rec?.freqMHz).toBe("14.0250");
    expect(rec?.mode).toBe("CW");
    expect(rec?.rstRx).toBe("599");
    expect(rec?.rstTx).toBe("579");
  });

  it("returns null when the exchange is incomplete", () => {
    expect(deriveLogRecord({ ...completeQso, peerCall: null }, 14.025)).toBeNull();
    expect(deriveLogRecord({ ...completeQso, rstRx: null }, 14.025)).toBeNull();
    expect(deriveLogRecord({ ...completeQso, rstTx: null }, 14.025)).toBeNull();
  });
});

describe("formatFreqMHz", () => {
  it("formats to four decimals", () => {
    expect(formatFreqMHz(14.025)).toBe("14.0250");
    expect(formatFreqMHz(7.025)).toBe("7.0250");
    expect(formatFreqMHz(28.025)).toBe("28.0250");
  });
});
