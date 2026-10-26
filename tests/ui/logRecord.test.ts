import { describe, expect, it } from "vitest";
import { buildLogRecord, formatFreqMHz } from "../../src/ui/logRecord.js";
import { emptyEntry, type EntryValues } from "../../src/ui/entryModel.js";

function entry(patch: Partial<EntryValues> = {}): EntryValues {
  return { ...emptyEntry("run"), ...patch };
}

describe("buildLogRecord", () => {
  it("maps the operator's row onto the LOG.md log fields", () => {
    const rec = buildLogRecord(
      entry({ call: "ja1abc", rstTx: "599", rstRx: "579" }),
      14.025,
      new Date("2026-10-14T12:34:56.000Z"),
    );
    expect(rec).not.toBeNull();
    expect(rec?.date).toBe("2026-10-14");
    expect(rec?.timeUtc).toBe("12:34:56");
    expect(rec?.call).toBe("JA1ABC"); // upper-cased, as a logbook writes it
    expect(rec?.freqMHz).toBe("14.0250");
    expect(rec?.mode).toBe("CW");
    expect(rec?.rstRx).toBe("579");
    expect(rec?.rstTx).toBe("599");
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
    expect(buildLogRecord(entry({ rstTx: "599", rstRx: "599" }), 14.025, now)).toBeNull();
    expect(buildLogRecord(entry({ call: "JA1ABC", rstRx: "599" }), 14.025, now)).toBeNull();
    expect(buildLogRecord(entry({ call: "JA1ABC", rstTx: "599" }), 14.025, now)).toBeNull();
    expect(
      buildLogRecord(entry({ call: "JA1ABC", rstTx: "599", rstRx: "59" }), 14.025, now),
    ).toBeNull();
  });
});

describe("formatFreqMHz", () => {
  it("formats to four decimals", () => {
    expect(formatFreqMHz(14.025)).toBe("14.0250");
    expect(formatFreqMHz(7.025)).toBe("7.0250");
    expect(formatFreqMHz(28.025)).toBe("28.0250");
  });
});
