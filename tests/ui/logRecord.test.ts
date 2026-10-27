import { describe, expect, it } from "vitest";
import { buildLogRecord, contestOf, formatFreqMHz } from "../../src/ui/logRecord.js";
import { emptyEntry, type EntryValues } from "../../src/ui/entryModel.js";
import type { PartnerTruth } from "../../src/qso/contest.js";

function entry(patch: Partial<EntryValues> = {}): EntryValues {
  return { ...emptyEntry("run"), ...patch };
}

const TRUTH: PartnerTruth = { call: "JA1ABC", report: "599", exch: "05" };

describe("buildLogRecord", () => {
  it("maps the operator's row onto the LOG.md log fields", () => {
    const rec = buildLogRecord(
      entry({ call: "ja1abc", rstTx: "599", rstRx: "579" }),
      14.025,
      { now: new Date("2026-10-14T12:34:56.000Z") },
    );
    expect(rec).not.toBeNull();
    expect(rec?.date).toBe("2026-10-14");
    expect(rec?.timeUtc).toBe("12:34:56");
    expect(rec?.call).toBe("JA1ABC"); // upper-cased, as a logbook writes it
    expect(rec?.freqMHz).toBe("14.0250");
    expect(rec?.mode).toBe("CW");
    expect(rec?.rstRx).toBe("579");
    expect(rec?.rstTx).toBe("599");
    // A DX row belongs to the DX log and has no exchange.
    expect(rec?.contest).toBe("DX");
    expect(rec?.exchRx).toBe("");
    expect(rec?.exchTx).toBe("");
  });

  it("records the dial as it stands when the operator signs off", () => {
    const rec = buildLogRecord(
      entry({ call: "JA1ABC", rstTx: "599", rstRx: "599" }),
      7.0123,
    );
    expect(rec?.freqMHz).toBe("7.0123");
  });

  it("refuses a row that is not finished", () => {
    const now = new Date("2026-10-14T12:34:56.000Z");
    const opts = { now };
    expect(buildLogRecord(entry({ rstTx: "599", rstRx: "599" }), 14.025, opts)).toBeNull();
    expect(buildLogRecord(entry({ call: "JA1ABC", rstRx: "599" }), 14.025, opts)).toBeNull();
    expect(buildLogRecord(entry({ call: "JA1ABC", rstTx: "599" }), 14.025, opts)).toBeNull();
    expect(
      buildLogRecord(entry({ call: "JA1ABC", rstTx: "599", rstRx: "59" }), 14.025, opts),
    ).toBeNull();
  });

  it("a contest row carries both exchanges and belongs to its own log", () => {
    const rec = buildLogRecord(
      entry({ call: "JA1ABC", rstTx: "599", rstRx: "599", exchRx: "05" }),
      14.025,
      { contest: "CQWW", exchTx: "24", truth: TRUTH },
    );
    expect(rec).not.toBeNull();
    expect(rec?.contest).toBe("CQWW");
    expect(rec?.exchTx).toBe("24");
    expect(rec?.exchRx).toBe("05");
  });

  it("a contest row needs the other station's number as well", () => {
    const now = new Date("2026-10-14T12:34:56.000Z");
    const incomplete = entry({ call: "JA1ABC", rstTx: "599", rstRx: "599" });
    expect(buildLogRecord(incomplete, 14.025, { contest: "WPX", now })).toBeNull();
    expect(
      buildLogRecord(entry({ ...incomplete, exchRx: "0" }), 14.025, { contest: "WPX", now }),
    ).toBeNull();
    expect(
      buildLogRecord(entry({ ...incomplete, exchRx: "001" }), 14.025, { contest: "WPX", now }),
    ).not.toBeNull();
  });
});

describe("核对：这一行抄得对不对", () => {
  const row = entry({ call: "JA1ABC", rstTx: "599", rstRx: "599", exchRx: "05" });

  it("全都抄对了就是 ok", () => {
    const rec = buildLogRecord(row, 14.025, { contest: "CQWW", truth: TRUTH });
    expect(rec?.verdict).toBe("ok");
  });

  it("呼号错了只说呼号错，不再评判交换信息", () => {
    const rec = buildLogRecord({ ...row, call: "JA1ABD" }, 14.025, {
      contest: "CQWW",
      truth: TRUTH,
    });
    expect(rec?.verdict).toBe("call");
  });

  it("呼号对、交换信息错，是另一种错", () => {
    const rec = buildLogRecord({ ...row, exchRx: "15" }, 14.025, {
      contest: "CQWW",
      truth: TRUTH,
    });
    expect(rec?.verdict).toBe("exch");
  });

  it("前导零不算错：抄成 5 和抄成 05 是同一个分区", () => {
    const rec = buildLogRecord({ ...row, exchRx: "5" }, 14.025, {
      contest: "CQWW",
      truth: TRUTH,
    });
    expect(rec?.verdict).toBe("ok");
  });

  it("RST 抄错单独标出来", () => {
    const rec = buildLogRecord({ ...row, rstRx: "579" }, 14.025, {
      contest: "CQWW",
      truth: TRUTH,
    });
    expect(rec?.verdict).toBe("rst");
  });

  it("没有与某个台的收发过程，就不作判定", () => {
    const rec = buildLogRecord(row, 14.025, { contest: "CQWW", truth: null });
    expect(rec?.verdict).toBeUndefined();
  });
});

describe("contestOf", () => {
  it("老日志没有字段时按 DX 算", () => {
    expect(
      contestOf({
        date: "2026-10-14",
        timeUtc: "12:00:00",
        call: "JA1ABC",
        freqMHz: "14.0250",
        mode: "CW",
        rstRx: "599",
        rstTx: "599",
      }),
    ).toBe("DX");
  });
});

describe("formatFreqMHz", () => {
  it("formats to four decimals", () => {
    expect(formatFreqMHz(14.025)).toBe("14.0250");
    expect(formatFreqMHz(7.025)).toBe("7.0250");
    expect(formatFreqMHz(28.025)).toBe("28.0250");
  });
});
