import { describe, it, expect } from "vitest";
import { dxccDatabase, DxccDatabase, type DxccData } from "../../src/data/dxcc.js";
import { parseCty } from "../../src/data/cty.js";

const minimal: DxccData = {
  entities: {
    BY: { dxcc: "BY", lat: 0, lon: 0, prefixes: ["BA", "BD", "BG", "BT", "BZ"], continent: "AS", cqZone: 24 },
    JA: { dxcc: "JA", lat: 0, lon: 0, prefixes: ["JA"], continent: "AS", cqZone: 25 },
    K: { dxcc: "K", lat: 0, lon: 0, prefixes: ["AA", "K", "N", "W"], continent: "NA", cqZone: 5 },
  },
};

describe("DxccDatabase prefix matching", () => {
  const db = new DxccDatabase(minimal);

  it("matches an exact prefix token", () => {
    expect(db.resolvePrefix("JA")).toBe("JA");
    expect(db.isValidPrefix("JA")).toBe(true);
  });

  it("matches a head substring of a known prefix (B -> BA/BD/BG/...)", () => {
    expect(db.resolvePrefix("B")).toBe("BY");
    expect(db.isValidPrefix("B")).toBe(true);
  });

  it("matches a longer letter prefix against a shorter token (KA -> K)", () => {
    // cty.dat lists the US as AA-AK/K/N/W; KA1ABC and WA2XYZ are real calls
    // that only resolve if the comparison runs in this direction too.
    expect(db.resolvePrefix("KA")).toBe("K");
    expect(db.resolvePrefix("WA")).toBe("K");
  });

  it("rejects an unknown prefix", () => {
    expect(db.isValidPrefix("QQ")).toBe(false);
    expect(db.resolvePrefix("QQ")).toBeNull();
  });

  it("rejects an empty prefix instead of matching everything", () => {
    // extractLetterPrefix returns "" for a callsign starting with a digit.
    expect(db.resolvePrefix("")).toBeNull();
  });
});

const SAMPLE = [
  "Aland Islands:            15:  18:  EU:   60.13:   -19.90:    -2.0:  OH0:",
  "    OG0,OH0,OI0,",
  "    =OH0ABC;",
  "",
  "United States:            05:   8:  NA:   39.80:   -98.60:    -5.0:  K:",
  "    AA,AB,AC,K,N,W;",
  "WAE Only:                 15:  28:  EU:   48.20:   -16.30:    -1.0:  *4U1V:",
  "    =4U0IARU;",
  "Conway Reef:              32:  56:  OC:   21.73:  -174.60:   -12.0:  3D2/c:",
  "    =3D2CCC;",
  "Zone Overrides:           20:  39:  AS:    9.88:  -114.23:    -8.0:  3H:",
  "    3H0(23)[42],3H9(23)[43];",
].join("\r\n");

describe("parseCty", () => {
  const data = parseCty(SAMPLE);

  it("reads the centroid and negates the longitude", () => {
    const oh0 = data.entities.OH0;
    expect(oh0.lat).toBe(60.13);
    // The file counts degrees WEST as positive; we count them east.
    expect(oh0.lon).toBe(19.9);
    expect(oh0.continent).toBe("EU");
  });

  it("collects prefixes across continuation lines, without duplicates", () => {
    expect(data.entities.OH0.prefixes).toEqual(["OH0", "OG0", "OI0"]);
  });

  it("drops `=` full callsigns and zone overrides", () => {
    expect(data.entities["3H"].prefixes).toEqual(["3H", "3H0", "3H9"]);
    expect(data.entities.K.prefixes).toEqual(["K", "AA", "AB", "AC", "N", "W"]);
  });

  it("drops WAE-only records", () => {
    expect(data.entities["4U1V"]).toBeUndefined();
  });

  it("drops records that list only full callsigns", () => {
    // Conway Reef has no assignable prefix, only the call 3D2CCC.
    expect(data.entities["3D2/c"]).toBeUndefined();
  });

  it("rejects a header with missing fields", () => {
    expect(() => parseCty("Broken: 1: 2\r\n")).toThrow(/fields/);
  });

  it("rejects a file that parses to nothing", () => {
    expect(() => parseCty("\r\n\r\n")).toThrow(/no entities/);
  });
});

describe("bundled dataset", () => {
  it("carries the whole country file", () => {
    // ~340 DXCC entities; a truncated download or a wrong path lands far below.
    expect(dxccDatabase.listEntities().length).toBeGreaterThan(300);
  });

  it("takes the Chinese centroid as east longitude", () => {
    const by = dxccDatabase.entity("BY");
    expect(by?.continent).toBe("AS");
    expect(by?.lat).toBeCloseTo(36, 0);
    expect(by?.lon).toBeCloseTo(102, 0);
  });

  it("accepts real callsigns from either direction of the prefix table", () => {
    for (const call of ["BG7XXX", "BA4AA", "JA1ABC", "W1AW", "KA1ABC", "IK2XYZ", "VK2AB"]) {
      const letters = call.replace(/[0-9].*$/, "");
      expect(dxccDatabase.isValidPrefix(letters), call).toBe(true);
      expect(dxccDatabase.resolvePrefix(letters), call).not.toBeNull();
    }
  });

  it("leaves out entities that exist only as individual callsigns", () => {
    expect(dxccDatabase.entity("3D2/c")).toBeUndefined();
    expect(dxccDatabase.entity("4U1V")).toBeUndefined();
  });
});
