import { describe, expect, it } from "vitest";
import { bandOfFreq, dupeIds } from "../../src/ui/logDupes.js";
import type { LogRecord } from "../../src/ui/logRecord.js";

function row(id: number, over: Partial<LogRecord> = {}): LogRecord {
  return {
    id,
    date: "2026-10-14",
    timeUtc: "12:00:00",
    call: "JA1ABC",
    freqMHz: "14.0250",
    mode: "CW",
    rstRx: "599",
    rstTx: "599",
    contest: "CQWW",
    exchRx: "05",
    exchTx: "24",
    round: 1,
    ...over,
  };
}

describe("哪里算「同一个波段」", () => {
  it("按频率落在哪个波段判，不按小数点后几位", () => {
    expect(bandOfFreq("14.0250")).toBe("20m");
    expect(bandOfFreq("14.0317")).toBe("20m");
    expect(bandOfFreq("7.0250")).toBe("40m");
    expect(bandOfFreq("21.0300")).toBe("15m");
    expect(bandOfFreq("28.5000")).toBe("10m");
  });

  it("落在波段之外的频率也有个归处，读不出来的算「?」", () => {
    expect(bandOfFreq("3.5000")).toBe("3MHz");
    expect(bandOfFreq("")).toBe("?");
    expect(bandOfFreq("nonsense")).toBe("?");
  });
});

describe("重复通联的标记", () => {
  it("同一个台、同一波段、同一场：后面那条标成重复", () => {
    const rows = [row(1), row(2, { timeUtc: "12:05:00" })];
    expect([...dupeIds(rows)]).toEqual([2]);
  });

  it("第一条永远不是重复，哪怕它在列表里排在后面", () => {
    // 列表是新到旧排的：id 大的在前。判重不能跟着显示顺序走。
    const rows = [row(2, { timeUtc: "12:05:00" }), row(1)];
    expect([...dupeIds(rows)]).toEqual([2]);
  });

  it("换了波段、换了场次、换了模式，都是另一次通联", () => {
    expect(dupeIds([row(1), row(2, { freqMHz: "7.0250" })]).size).toBe(0);
    expect(dupeIds([row(1), row(2, { round: 2 })]).size).toBe(0);
    expect(dupeIds([row(1), row(2, { contest: "WPX" })]).size).toBe(0);
  });

  it("呼号大小写与首尾空格不算区别", () => {
    expect(dupeIds([row(1), row(2, { call: " ja1abc " })]).size).toBe(1);
  });

  it("通三次标两次，第一次不标", () => {
    const rows = [row(1), row(2), row(3)];
    expect([...dupeIds(rows)].sort()).toEqual([2, 3]);
  });

  it("还没存过的行（没有 id）不标，也不影响别人", () => {
    const fresh: LogRecord = { ...row(0), id: undefined };
    expect(dupeIds([row(1), fresh]).size).toBe(0);
  });
});
