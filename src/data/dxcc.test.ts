import { describe, it, expect } from "vitest";
import { dxccDatabase, DxccDatabase, DxccData } from "./dxcc.js";

const minimal: DxccData = {
  source: "test",
  coordinate_note: "",
  count: 2,
  entities: {
    BY: { dxcc: "BY", lat: 0, lon: 0, prefixes: ["BA", "BD", "BG", "BT", "BZ"], continent: "AS" },
    JA: { dxcc: "JA", lat: 0, lon: 0, prefixes: ["JA"], continent: "AS" },
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

  it("rejects an unknown prefix", () => {
    expect(db.isValidPrefix("ZZ")).toBe(false);
    expect(db.resolvePrefix("ZZ")).toBeNull();
  });

  it("singleton is built from the bundled 428-entity dataset", () => {
    expect(dxccDatabase.entity("BY")).toBeDefined();
    expect(dxccDatabase.isValidPrefix("BG")).toBe(true);
    // head substring of a real prefix
    expect(dxccDatabase.isValidPrefix("W")).toBe(true);
  });
});
