// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSMeter, scalePosition, smeterBar, OVER_DB_SPAN } from "../../src/ui/smeter.js";
import type { SMeterReading } from "../../src/ham/smeter.js";

const reading = (s: number, overDb = 0): SMeterReading => ({
  dbm: -100 + s * 5,
  s,
  overDb,
  label: overDb > 0 ? `S9+${overDb}` : `S${s}`,
});

/** The fill width as a percentage number (jsdom normalises "50.0%" to "50%"). */
const width = (node: HTMLElement): number => Number.parseFloat(node.style.width);

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("S 表刻度", () => {
  it("没有信号时整条是空的", () => {
    expect(smeterBar(null)).toEqual({ sFill: 0, overFill: 0, label: "—", live: false });
  });

  it("S1 空、S9 占满蓝色段", () => {
    expect(smeterBar(reading(1)).sFill).toBe(0);
    expect(smeterBar(reading(9)).sFill).toBe(1);
    expect(smeterBar(reading(5)).sFill).toBe(0.5);
  });

  it("超过 S9 才点亮红色段，并按 60 dB 满格换算", () => {
    const at9 = smeterBar(reading(9));
    expect(at9.overFill).toBe(0);

    const plus30 = smeterBar(reading(9, 30));
    expect(plus30.sFill).toBe(1);
    expect(plus30.overFill).toBe(0.5);
    expect(smeterBar(reading(9, OVER_DB_SPAN)).overFill).toBe(1);
  });

  it("刻度位置：S1 在 0%，S9 在 60%，+60 在 100%", () => {
    expect(scalePosition(1)).toBe(0);
    expect(scalePosition(9)).toBe(60);
    expect(scalePosition(9, 60)).toBe(100);
  });
});

describe("S 表横条", () => {
  it("渲染出蓝、红两段与刻度标注", () => {
    const meter = renderSMeter({ reading: () => null, onLeave: () => {} });

    expect(meter.querySelector(".smeter-seg.s")).not.toBeNull();
    expect(meter.querySelector(".smeter-seg.over")).not.toBeNull();
    const ticks = Array.from(meter.querySelectorAll(".smeter-tick")).map((t) => t.textContent);
    expect(ticks).toEqual(["S1", "S3", "S5", "S7", "S9", "+20", "+40", "+60"]);
    expect(meter.querySelector(".smeter-tick.s9")?.textContent).toBe("S9");
  });

  it("横条上方只有读数本身，不再额外挂一个 S", () => {
    const meter = renderSMeter({ reading: () => reading(7), onLeave: () => {} });

    // 读数已经带 S 前缀（"S7"）；再挂一个静态 "S" 会念成 "S S7"。
    expect(meter.firstElementChild?.textContent).toBe("S7");
    expect(meter.querySelector(".smeter-label")).toBeNull();
  });

  it("读数变化时两段填充跟着走", () => {
    vi.useFakeTimers();
    let current: SMeterReading | null = reading(9, 30);
    const meter = renderSMeter({ reading: () => current, onLeave: () => {} });
    const blue = meter.querySelector<HTMLElement>(".smeter-seg.s .smeter-fill")!;
    const red = meter.querySelector<HTMLElement>(".smeter-seg.over .smeter-fill")!;

    // 先画一次：S9 全亮，S9+30 半条红
    expect(meter.querySelector(".smeter-read")?.textContent).toBe("S9+30");
    expect(width(blue)).toBeCloseTo(100, 1);
    expect(width(red)).toBeCloseTo(50, 1);

    current = null;
    vi.advanceTimersByTime(60);
    expect(meter.querySelector(".smeter-read")?.textContent).toBe("—");
    expect(width(red)).toBe(0);
    expect(meter.classList.contains("quiet")).toBe(true);

    current = reading(5);
    vi.advanceTimersByTime(60);
    expect(width(blue)).toBeCloseTo(50, 1);
    expect(width(red)).toBe(0);
    expect(meter.classList.contains("quiet")).toBe(false);
  });

  it("离开页面时停掉重绘定时器", () => {
    vi.useFakeTimers();
    const cleanups: Array<() => void> = [];
    const readingFn = vi.fn(() => null);
    renderSMeter({ reading: readingFn, onLeave: (fn) => cleanups.push(fn) });

    expect(readingFn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(180);
    expect(readingFn).toHaveBeenCalledTimes(4);

    for (const fn of cleanups) fn();
    vi.advanceTimersByTime(180);
    expect(readingFn).toHaveBeenCalledTimes(4);
  });
});
