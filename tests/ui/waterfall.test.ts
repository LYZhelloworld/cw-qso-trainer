// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  Waterfall,
  brightnessToRgb,
  easeCenter,
  freqAtX,
  keyingLevel,
  keyingSeed,
  renderRow,
  signalLevel,
  xAtFreq,
} from "../../src/ui/waterfall.js";
import type { SpectrumSignal, SpectrumSnapshot } from "../../src/ham/spectrum.js";

const CENTER = 14_025_000;
const SPAN = 20_000;

function signal(over: Partial<SpectrumSignal> = {}): SpectrumSignal {
  return {
    freqHz: CENTER,
    strength: 0.9,
    call: "JA1ABC",
    workable: true,
    active: false,
    ...over,
  };
}

describe("瀑布图 — 亮度映射", () => {
  it("0 是近黑，1 是白，且全程递增", () => {
    expect(brightnessToRgb(0)).toEqual([0, 0, 16]);
    expect(brightnessToRgb(1)).toEqual([255, 255, 255]);

    let prev = -1;
    for (let i = 0; i <= 20; i += 1) {
      const [r, g, b] = brightnessToRgb(i / 20);
      for (const c of [r, g, b]) {
        expect(Number.isInteger(c)).toBe(true);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(255);
      }
      const sum = r + g + b;
      expect(sum).toBeGreaterThan(prev);
      prev = sum;
    }
  });

  it("越界输入被夹到 0..1", () => {
    expect(brightnessToRgb(-5)).toEqual(brightnessToRgb(0));
    expect(brightnessToRgb(9)).toEqual(brightnessToRgb(1));
  });
});

describe("瀑布图 — 坐标换算", () => {
  it("窗口中心落在正中间，左右对称", () => {
    expect(freqAtX(500, 1000, CENTER, SPAN)).toBe(CENTER);
    expect(freqAtX(0, 1000, CENTER, SPAN)).toBe(CENTER - SPAN / 2);
    expect(freqAtX(1000, 1000, CENTER, SPAN)).toBe(CENTER + SPAN / 2);
  });

  it("freqAtX 与 xAtFreq 互为逆运算", () => {
    for (const x of [0, 137, 500, 812, 1000]) {
      const hz = freqAtX(x, 1000, CENTER, SPAN);
      expect(xAtFreq(hz, 1000, CENTER, SPAN)).toBeCloseTo(x, 6);
    }
  });

  it("宽度为 0 时安全退化，不产生 NaN", () => {
    expect(freqAtX(10, 0, CENTER, SPAN)).toBe(CENTER);
    expect(xAtFreq(CENTER, 0, CENTER, SPAN)).toBe(0);
  });
});

describe("瀑布图 — 显示中心缓动（调谐成曲线）", () => {
  it("向目标收敛但不会一步到位", () => {
    const once = easeCenter(CENTER, CENTER + 1000, 16, 190);
    expect(once).toBeGreaterThan(CENTER);
    expect(once).toBeLessThan(CENTER + 1000);

    // Many frames later it is essentially there.
    let v = CENTER;
    for (let i = 0; i < 120; i += 1) v = easeCenter(v, CENTER + 1000, 16, 190);
    expect(v).toBeCloseTo(CENTER + 1000, 0);
  });

  it("已经到位时不动；dt<=0 直接归位", () => {
    expect(easeCenter(CENTER, CENTER, 16, 190)).toBe(CENTER);
    expect(easeCenter(CENTER, CENTER + 500, 0, 190)).toBe(CENTER + 500);
  });
});

describe("瀑布图 — 单行渲染", () => {
  const noNoise = () => 0;

  it("信号落在它频率对应的列上", () => {
    const row = renderRow([{ freqHz: CENTER, level: 1 }], CENTER, 1000, SPAN, noNoise);
    expect(row[500]).toBeCloseTo(1, 5);
    expect(row[0]).toBeLessThan(0.1);
  });

  it("拨轮上移时，同一个绝对频率的信号会向左移动（调谐曲线）", () => {
    // The station never moves; the window does. +1 kHz dial → 1 kHz left.
    const shifted = renderRow([{ freqHz: CENTER, level: 1 }], CENTER + 1000, 1000, SPAN, noNoise);
    expect(shifted[450]).toBeCloseTo(1, 5);
    expect(shifted[500]).toBeLessThan(0.2);
  });

  it("亮度随电平（信号强度）变化", () => {
    // Compared above the noise floor, so the floor itself does not skew the ratio.
    const strong = renderRow([{ freqHz: CENTER, level: 0.6 }], CENTER, 1000, SPAN, noNoise);
    const weak = renderRow([{ freqHz: CENTER, level: 0.3 }], CENTER, 1000, SPAN, noNoise);
    const strongPeak = strong[500] - strong[0];
    const weakPeak = weak[500] - weak[0];
    expect(weakPeak).toBeCloseTo(strongPeak / 2, 5);
  });

  it("没有信号时只有噪声底噪", () => {
    const row = renderRow([], CENTER, 400, SPAN, () => 0.5);
    for (const v of row) expect(v).toBeLessThan(0.12);
  });

  it("窗口外的信号完全不参与计算", () => {
    const row = renderRow([{ freqHz: CENTER + 50_000, level: 1 }], CENTER, 400, SPAN, noNoise);
    for (const v of row) expect(v).toBeLessThan(0.12);
  });
});

describe("瀑布图 — CW 键控包络", () => {
  it("只产出 0/1，且同一输入结果一致", () => {
    for (let t = 0; t < 2000; t += 37) {
      const v = keyingLevel(1234, t, 20);
      expect(v === 0 || v === 1).toBe(true);
      expect(keyingLevel(1234, t, 20)).toBe(v);
    }
  });

  it("一个周期内点划与间隔都有（不是常亮也不是全灭）", () => {
    const seen = new Set<number>();
    for (let t = 0; t < 3000; t += 5) seen.add(keyingLevel(99, t, 20));
    expect([...seen].sort()).toEqual([0, 1]);
  });

  it("不同台（不同种子）的节奏不同", () => {
    let diff = 0;
    for (let t = 0; t < 2000; t += 13) {
      if (keyingLevel(1, t, 20) !== keyingLevel(2, t, 20)) diff += 1;
    }
    expect(diff).toBeGreaterThan(0);
  });

  it("键控种子区分呼号与频率", () => {
    expect(keyingSeed(signal())).not.toBe(keyingSeed(signal({ call: "DL1XYZ" })));
    expect(keyingSeed(signal())).not.toBe(keyingSeed(signal({ freqHz: CENTER + 500 })));
    expect(keyingSeed(signal())).toBe(keyingSeed(signal()));
  });
});

describe("瀑布图 — 有声音才有信号", () => {
  it("真实台只在发报时点亮；守听间隙里没有信号，不是暗载波", () => {
    const sig = signal({ active: true, strength: 0.8 });
    expect(signalLevel(sig, 0, 20)).toBeCloseTo(0.8, 6);
    expect(signalLevel({ ...sig, active: false }, 0, 20)).toBe(0);
  });

  it("自己的发报按满强度画，不随合成点划闪断", () => {
    const mine = signal({ call: "BG7XXX", workable: false, active: true, strength: 1 });
    for (const t of [0, 37, 123, 900]) expect(signalLevel(mine, t, 20)).toBe(1);
  });

  it("装饰性背景载波没有音频，仍保留合成点划与暗载波", () => {
    const bg = signal({ call: "", workable: false, active: true, strength: 0.3 });
    let on = false;
    let off = false;
    for (let t = 0; t < 3000; t += 5) {
      const v = signalLevel(bg, t, 20);
      if (v === 0) off = true;
      if (Math.abs(v - 0.3) < 1e-9) on = true;
    }
    expect(on && off).toBe(true);

    // 守听中的装饰载波是很暗的一条，不会消失
    expect(signalLevel({ ...bg, active: false }, 0, 20)).toBeCloseTo(0.06, 6);
  });
});

describe("瀑布图 — 组件生命周期", () => {
  function makeCanvas(width = 1000): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    Object.defineProperty(canvas, "getBoundingClientRect", {
      value: () => ({ left: 0, top: 0, right: width, bottom: 72, width, height: 72 }),
    });
    return canvas;
  }

  /**
   * A canvas with a layout box that can change under the renderer, plus a stub
   * 2D context that keeps the pixels it is given.
   *
   * The real reason this exists: on screen the panadapter is the flexible row of
   * the shell, so anything that makes the page above it taller resizes it — and
   * resizing a canvas clears it. jsdom has no layout and no 2D context, so both
   * have to be faked to see that the picture survives.
   */
  function resizable(box: { w: number; h: number }): {
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    calls: { grabbed: number; restored: ImageData[] };
  } {
    const canvas = document.createElement("canvas");
    Object.defineProperty(canvas, "clientWidth", { get: () => box.w });
    Object.defineProperty(canvas, "clientHeight", { get: () => box.h });
    const calls = { grabbed: 0, restored: [] as ImageData[] };
    const pixels = (w: number, h: number): ImageData =>
      ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }) as ImageData;
    const ctx = {
      fillStyle: "",
      fillRect: () => {},
      drawImage: () => {},
      createImageData: (w: number, h: number) => pixels(w, h),
      getImageData: (_x: number, _y: number, w: number, h: number) => {
        calls.grabbed += 1;
        return pixels(w, h);
      },
      putImageData: (image: ImageData) => {
        calls.restored.push(image);
      },
    } as unknown as CanvasRenderingContext2D;
    return { canvas, ctx, calls };
  }

  function snapshot(centerHz: number, signals: SpectrumSignal[] = []): SpectrumSnapshot {
    return { centerHz, signals };
  }

  it("headless（无 2d context）也能推进而不抛错", () => {
    const wf = new Waterfall(makeCanvas(), { context: null, now: () => 0 });
    wf.setSource(() => snapshot(CENTER));
    expect(() => {
      wf.advance(0);
      wf.advance(500);
      wf.dispose();
    }).not.toThrow();
  });

  it("显示器变高变矮都保住已有画面，只让新露出的部分从黑开始", () => {
    const box = { w: 400, h: 200 };
    const { canvas, ctx, calls } = resizable(box);
    const wf = new Waterfall(canvas, { context: ctx, now: () => 0, schedule: () => () => {} });
    wf.setSource(() => snapshot(CENTER, [signal({ active: true })]));

    wf.advance(0);
    // 第一次布局没有旧画面可留
    expect(calls.grabbed).toBe(0);

    // 上面的页面多了一行：瀑布图被挤矮 19px
    box.h = 181;
    wf.advance(16);
    expect(calls.grabbed).toBe(1);
    expect(calls.restored.at(-1)).toBeTruthy();

    // 那一行又没了：变回原高，画面接着往下滚，不是从头开始
    box.h = 200;
    wf.advance(32);
    expect(calls.grabbed).toBe(2);
    wf.dispose();
  });

  it("宽度变了不搬旧画面：旧的列已经对不上频率轴", () => {
    const box = { w: 400, h: 200 };
    const { canvas, ctx, calls } = resizable(box);
    const wf = new Waterfall(canvas, { context: ctx, now: () => 0, schedule: () => () => {} });
    wf.setSource(() => snapshot(CENTER));

    wf.advance(0);
    box.w = 500;
    wf.advance(16);
    expect(calls.grabbed).toBe(0);
    wf.dispose();
  });

  it("显示中心从拨轮处缓动过去，而不是瞬移", () => {
    let center = CENTER;
    const wf = new Waterfall(makeCanvas(), { context: null, now: () => 0 });
    wf.setSource(() => snapshot(center));

    wf.advance(0);
    expect(wf.displayCenterHz).toBe(CENTER);

    center = CENTER + 1000;
    wf.advance(16);
    expect(wf.displayCenterHz).toBeGreaterThan(CENTER);
    expect(wf.displayCenterHz).toBeLessThan(CENTER + 1000);

    for (let t = 32; t < 2600; t += 16) wf.advance(t);
    expect(wf.displayCenterHz).toBeCloseTo(CENTER + 1000, 0);
    wf.dispose();
  });

  it("电源开关控制是否滚动", () => {
    const wf = new Waterfall(makeCanvas(), { context: null, now: () => 0, schedule: () => () => {} });
    expect(wf.isRunning).toBe(false);
    wf.setActive(true);
    expect(wf.isRunning).toBe(true);
    wf.setActive(false);
    expect(wf.isRunning).toBe(false);
    wf.dispose();
  });

  it("reset 把显示中心直接交还给拨轮（切波段是跳变，不是扫频）", () => {
    let center = CENTER;
    const wf = new Waterfall(makeCanvas(), { context: null, now: () => 0 });
    wf.setSource(() => snapshot(center));
    wf.advance(0);

    // 跳到 21 MHz：缓动中，画面还在半路上
    center = 21_025_000;
    wf.advance(16);
    expect(wf.displayCenterHz).toBeGreaterThan(CENTER);
    expect(wf.displayCenterHz).toBeLessThan(center);

    // 清屏后从新拨轮处重新开始，不再横穿几个 MHz
    wf.reset();
    wf.advance(32);
    expect(wf.displayCenterHz).toBe(center);
    wf.dispose();
  });

  it("关台后清屏，再开台从当前拨轮重新画", () => {
    let center = CENTER;
    const wf = new Waterfall(makeCanvas(), {
      context: null,
      now: () => 0,
      schedule: () => () => {},
    });
    wf.setSource(() => snapshot(center));
    wf.setActive(true);
    wf.advance(0);
    wf.setActive(false);

    // 关着的时候换了波段：开台不应该从旧位置扫过去
    center = 7_010_000;
    wf.setActive(true);
    wf.advance(16);
    expect(wf.displayCenterHz).toBe(center);
    wf.dispose();
  });

  it("滚轮向上滚一格，频率上调 100 Hz（0.0001 MHz）", () => {
    const canvas = makeCanvas();
    const wf = new Waterfall(canvas, { context: null, now: () => 0 });
    wf.setSource(() => snapshot(CENTER, [signal()]));
    wf.advance(0);

    const tuned: number[] = [];
    wf.onTune = (hz) => tuned.push(hz);
    canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));

    expect(tuned).toEqual([CENTER + 100]);
    wf.dispose();
  });

  it("滚轮向下滚一格，频率下调 100 Hz", () => {
    const canvas = makeCanvas();
    const wf = new Waterfall(canvas, { context: null, now: () => 0 });
    wf.setSource(() => snapshot(CENTER));
    wf.advance(0);

    const tuned: number[] = [];
    wf.onTune = (hz) => tuned.push(hz);
    canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 }));

    expect(tuned).toEqual([CENTER - 100]);
    wf.dispose();
  });

  it("Shift + 滚轮是 1 kHz 粗调", () => {
    const canvas = makeCanvas();
    const wf = new Waterfall(canvas, { context: null, now: () => 0 });
    wf.setSource(() => snapshot(CENTER));
    wf.advance(0);

    const tuned: number[] = [];
    wf.onTune = (hz) => tuned.push(hz);
    canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, shiftKey: true }));

    expect(tuned).toEqual([CENTER + 1000]);
    wf.dispose();
  });

  it("一次滚几格就调几步", () => {
    const canvas = makeCanvas();
    const wf = new Waterfall(canvas, { context: null, now: () => 0 });
    wf.setSource(() => snapshot(CENTER));
    wf.advance(0);

    const tuned: number[] = [];
    wf.onTune = (hz) => tuned.push(hz);
    canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: -200 }));

    expect(tuned).toEqual([CENTER + 200]);
    wf.dispose();
  });

  it("一帧内连滚两格会累加，而不是都按旧拨轮算", () => {
    const canvas = makeCanvas();
    const wf = new Waterfall(canvas, { context: null, now: () => 0 });
    wf.setSource(() => snapshot(CENTER));
    wf.advance(0);

    const tuned: number[] = [];
    wf.onTune = (hz) => tuned.push(hz);
    // No advance() in between: the picture has not caught up yet.
    canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));

    expect(tuned).toEqual([CENTER + 100, CENTER + 200]);
    wf.dispose();
  });

  it("触控板的细碎增量会累积成整格，而不是每像素调一次", () => {
    const canvas = makeCanvas();
    const wf = new Waterfall(canvas, { context: null, now: () => 0 });
    wf.setSource(() => snapshot(CENTER));
    wf.advance(0);

    const tuned: number[] = [];
    wf.onTune = (hz) => tuned.push(hz);
    // 4 × 25 = 100 = one notch; the first three must not tune yet.
    for (let i = 0; i < 3; i += 1) {
      canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: -25 }));
    }
    expect(tuned).toEqual([]);
    canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: -25 }));
    expect(tuned).toEqual([CENTER + 100]);
    wf.dispose();
  });

  it("滚轮不会让页面跟着滚动", () => {
    const canvas = makeCanvas();
    const wf = new Waterfall(canvas, { context: null, now: () => 0 });
    wf.setSource(() => snapshot(CENTER));
    wf.advance(0);
    wf.onTune = () => {};

    const e = new WheelEvent("wheel", { deltaY: -100, cancelable: true });
    canvas.dispatchEvent(e);

    expect(e.defaultPrevented).toBe(true);
    wf.dispose();
  });

  it("dispose 之后不再响应滚轮", () => {
    const canvas = makeCanvas();
    const wf = new Waterfall(canvas, { context: null, now: () => 0 });
    wf.setSource(() => snapshot(CENTER));
    wf.advance(0);
    const onTune = vi.fn();
    wf.onTune = onTune;
    wf.dispose();

    canvas.dispatchEvent(new WheelEvent("wheel", { deltaY: -100 }));
    expect(onTune).not.toHaveBeenCalled();
  });
});
