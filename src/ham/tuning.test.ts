import { describe, expect, it } from "vitest";
import {
  MAX_HEARD_HZ,
  MIN_HEARD_HZ,
  SIDEBAND_SPLIT_HZ,
  detuneHz,
  heardToneHz,
  sidebandFor,
} from "./tuning.js";

const HIGH = 14_025_000; // 20 m → USB
const LOW = 7_025_000; // 40 m → LSB

describe("CW 边带约定", () => {
  it("40m 及以下用 LSB，20m 及以上用 USB", () => {
    expect(sidebandFor(3_550_000)).toBe("LSB");
    expect(sidebandFor(7_025_000)).toBe("LSB");
    expect(sidebandFor(SIDEBAND_SPLIT_HZ - 1)).toBe("LSB");
    expect(sidebandFor(SIDEBAND_SPLIT_HZ)).toBe("USB");
    expect(sidebandFor(14_025_000)).toBe("USB");
    expect(sidebandFor(21_025_000)).toBe("USB");
  });
});

describe("CW 偏频音调", () => {
  it("正对频时听到的就是设定的 CW 音调", () => {
    expect(heardToneHz({ toneHz: 700, stationHz: HIGH, dialHz: HIGH })).toBe(700);
    expect(heardToneHz({ toneHz: 700, stationHz: LOW, dialHz: LOW })).toBe(700);
  });

  it("USB：台在拨轮上方时音调变高、下方时变低", () => {
    expect(heardToneHz({ toneHz: 700, stationHz: HIGH + 300, dialHz: HIGH })).toBe(1000);
    expect(heardToneHz({ toneHz: 700, stationHz: HIGH - 300, dialHz: HIGH })).toBe(400);
  });

  it("LSB：方向相反——台在拨轮上方时音调变低", () => {
    expect(heardToneHz({ toneHz: 700, stationHz: LOW + 300, dialHz: LOW })).toBe(400);
    expect(heardToneHz({ toneHz: 700, stationHz: LOW - 300, dialHz: LOW })).toBe(1000);
  });

  it("同一边带下，往上调拨轮音调单调下降（USB），LSB 则上升", () => {
    const usb = (dialHz: number) =>
      heardToneHz({ toneHz: 700, stationHz: HIGH, dialHz, sideband: "USB" });
    const lsb = (dialHz: number) =>
      heardToneHz({ toneHz: 700, stationHz: LOW, dialHz, sideband: "LSB" });

    expect(usb(HIGH - 200)).toBeGreaterThan(usb(HIGH + 200));
    expect(lsb(LOW - 200)).toBeLessThan(lsb(LOW + 200));
  });

  it("失谐不是整数 kHz 时按线性偏移，不做取整到最近 kHz", () => {
    expect(heardToneHz({ toneHz: 700, stationHz: HIGH + 180, dialHz: HIGH })).toBe(880);
    expect(heardToneHz({ toneHz: 700, stationHz: HIGH - 180, dialHz: HIGH })).toBe(520);
  });

  it("偏离过大时夹在可听范围内，不会跑到 0 或几 kHz", () => {
    expect(heardToneHz({ toneHz: 700, stationHz: HIGH + 9000, dialHz: HIGH })).toBe(MAX_HEARD_HZ);
    expect(heardToneHz({ toneHz: 700, stationHz: HIGH - 9000, dialHz: HIGH })).toBe(MIN_HEARD_HZ);
    // 音调设在偏低一档时同样受夹（300 − 500 → 下限）
    expect(heardToneHz({ toneHz: 300, stationHz: LOW + 500, dialHz: LOW })).toBe(MIN_HEARD_HZ);
  });

  it("可以显式覆盖边带（与 40m 一样低的下边带频率也能量到高音）", () => {
    expect(
      heardToneHz({ toneHz: 700, stationHz: HIGH + 300, dialHz: HIGH, sideband: "LSB" }),
    ).toBe(400);
    expect(heardToneHz({ toneHz: 700, stationHz: LOW + 300, dialHz: LOW, sideband: "USB" })).toBe(
      1000,
    );
  });

  it("detuneHz 带符号（正 = 台在拨轮上方）", () => {
    expect(detuneHz(HIGH + 500, HIGH)).toBe(500);
    expect(detuneHz(HIGH - 500, HIGH)).toBe(-500);
    expect(detuneHz(HIGH, HIGH)).toBe(0);
  });
});
