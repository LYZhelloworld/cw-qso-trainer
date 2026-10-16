import { describe, expect, it } from "vitest";
import {
  MAX_HEARD_HZ,
  MIN_HEARD_HZ,
  PASSBAND_HALF_HZ,
  PASSBAND_HZ,
  SIDEBAND_SPLIT_HZ,
  audibleToneHz,
  detuneHz,
  heardToneHz,
  inPassband,
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
    // 纯映射的保险丝：真到了这个距离早就被滤波器切掉了（见下面的通带一节），
    // 这里只保证"钳在可听范围"这条数学性质成立。
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

describe("CW 接收通带（500 Hz，中心是拨轮）", () => {
  it("带宽 500 Hz，即 ±250 Hz", () => {
    expect(PASSBAND_HZ).toBe(500);
    expect(PASSBAND_HALF_HZ).toBe(250);
  });

  it("±250 Hz 以内听得到，超出就听不到", () => {
    expect(inPassband(HIGH, HIGH)).toBe(true);
    expect(inPassband(HIGH + PASSBAND_HALF_HZ, HIGH)).toBe(true);
    expect(inPassband(HIGH - PASSBAND_HALF_HZ, HIGH)).toBe(true);
    expect(inPassband(HIGH + PASSBAND_HALF_HZ + 1, HIGH)).toBe(false);
    expect(inPassband(HIGH - PASSBAND_HALF_HZ - 1, HIGH)).toBe(false);
    // 隔着一整格（1 kHz）——正是邻台的位置——必然在通带之外
    expect(inPassband(HIGH + 1000, HIGH)).toBe(false);
  });

  it("audibleToneHz：通带内给出音调，通带外给 null（不是变尖，是没了）", () => {
    expect(audibleToneHz({ toneHz: 700, stationHz: HIGH + 200, dialHz: HIGH })).toBe(900);
    expect(audibleToneHz({ toneHz: 700, stationHz: HIGH - 200, dialHz: HIGH })).toBe(500);
    expect(audibleToneHz({ toneHz: 700, stationHz: HIGH + 1000, dialHz: HIGH })).toBeNull();
  });

  it("显示的频率是载波频率：拨轮对准台时听到的就是设定音调", () => {
    // CW 电台的约定——频率读数上不额外加 PITCH。设 700 Hz 就对在 7.010000，
    // 听到的正是 700 Hz；换个 PITCH 只改侧音高低，不改频率读数。
    expect(audibleToneHz({ toneHz: 700, stationHz: LOW, dialHz: LOW })).toBe(700);
    expect(audibleToneHz({ toneHz: 600, stationHz: LOW, dialHz: LOW })).toBe(600);
    expect(audibleToneHz({ toneHz: 700, stationHz: HIGH, dialHz: HIGH })).toBe(700);
  });
});
