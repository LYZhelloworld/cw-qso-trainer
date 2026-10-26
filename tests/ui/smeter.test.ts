// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSMeter, scalePosition, smeterBar, barWidth, OVER_DB_SPAN } from "../../src/ui/smeter.js";
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

  it("整条的长度只有一个数：S 段 60%，红段 40%", () => {
    expect(barWidth(smeterBar(reading(1)))).toBe(0);
    expect(barWidth(smeterBar(reading(5)))).toBeCloseTo(0.3, 5);
    expect(barWidth(smeterBar(reading(9)))).toBeCloseTo(0.6, 5);
    expect(barWidth(smeterBar(reading(9, 30)))).toBeCloseTo(0.8, 5);
    expect(barWidth(smeterBar(reading(9, OVER_DB_SPAN)))).toBeCloseTo(1, 5);
  });
});

describe("S 表横条", () => {
  it("只有一条填充：蓝红分界是画在里面的，不是两条各自动", () => {
    const meter = renderSMeter({ reading: () => null, onLeave: () => {} });

    // 曾经的毛病就在这两条上：两条各自过渡、各自发光，过了 S9 看着像两根条。
    expect(meter.querySelectorAll(".smeter-fill")).toHaveLength(1);
    expect(meter.querySelector(".smeter-seg")).toBeNull();
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

  it("读数变化时只有这一条在长，颜色分界始终钉在 S9 上", () => {
    vi.useFakeTimers();
    let current: SMeterReading | null = reading(9, 30);
    const meter = renderSMeter({ reading: () => current, onLeave: () => {} });
    const fill = meter.querySelector<HTMLElement>(".smeter-fill")!;

    // S9+30：整条 80%（蓝 60% + 红 20%），分界落在自身宽度的 75% 处 = 60% 刻度。
    expect(meter.querySelector(".smeter-read")?.textContent).toBe("S9+30");
    expect(width(fill)).toBeCloseTo(80, 1);
    expect(fill.style.getPropertyValue("--s9-stop")).toBe("75%");
    expect(fill.classList.contains("over")).toBe(true);

    current = null;
    vi.advanceTimersByTime(60);
    expect(meter.querySelector(".smeter-read")?.textContent).toBe("—");
    expect(width(fill)).toBe(0);
    expect(meter.classList.contains("quiet")).toBe(true);

    // 回到 S5：只有蓝，分界退到末端，红一点不露。
    current = reading(5);
    vi.advanceTimersByTime(60);
    expect(width(fill)).toBeCloseTo(30, 1);
    expect(fill.style.getPropertyValue("--s9-stop")).toBe("100%");
    expect(fill.classList.contains("over")).toBe(false);
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
