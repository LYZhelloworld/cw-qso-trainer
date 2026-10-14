import { describe, expect, it } from "vitest";
import { Sidetone, WebAudioSidetone, type SidetoneBackend } from "./sidetone.js";

/** Recording stand-in for the audio backend: no DOM, no real sound. */
class FakeBackend implements SidetoneBackend {
  readonly available: boolean;
  readonly events: string[] = [];
  disposed = false;

  constructor(available = true) {
    this.available = available;
  }

  start(freqHz: number, volume: number): void {
    this.events.push(`start:${freqHz}:${volume}`);
  }
  stop(): void {
    this.events.push("stop");
  }
  setFrequency(freqHz: number): void {
    this.events.push(`freq:${freqHz}`);
  }
  setVolume(volume: number): void {
    this.events.push(`vol:${volume}`);
  }
  dispose(): void {
    this.disposed = true;
    this.events.push("dispose");
  }
}

interface Overrides {
  enabled?: boolean;
  volume?: number;
  freqHz?: number;
}

function makeSidetone(backend: SidetoneBackend, over: Overrides = {}): Sidetone {
  return new Sidetone({
    backend,
    enabled: over.enabled ?? true,
    freqHz: over.freqHz ?? 700,
    volume: over.volume ?? 0.4,
  });
}

describe("Sidetone", () => {
  it("按下键发声、松开停止，并把频率与音量传下去", () => {
    const b = new FakeBackend();
    const s = makeSidetone(b, { freqHz: 600, volume: 0.5 });
    s.keyDown();
    s.keyUp();
    expect(b.events).toEqual(["start:600:0.5", "stop"]);
  });

  it("重复按下不叠加音调，重复松开不重复停止", () => {
    const b = new FakeBackend();
    const s = makeSidetone(b);
    s.keyDown();
    s.keyDown(); // keyboard auto-repeat
    expect(b.events).toEqual(["start:700:0.4"]);
    s.keyUp();
    s.keyUp();
    expect(b.events).toEqual(["start:700:0.4", "stop"]);
  });

  it("关闭侧音后按键不发声", () => {
    const b = new FakeBackend();
    const s = makeSidetone(b, { enabled: false });
    s.keyDown();
    expect(b.events).toEqual([]);
    expect(s.isOn).toBe(false);
  });

  it("正在发声时关闭侧音会立即停", () => {
    const b = new FakeBackend();
    const s = makeSidetone(b);
    s.keyDown();
    s.setEnabled(false);
    expect(b.events).toEqual(["start:700:0.4", "stop"]);
    s.keyUp(); // no second stop
    expect(b.events.filter((e) => e === "stop").length).toBe(1);
  });

  it("改频率与音量会转发给后端，音量钳制在 0..1", () => {
    const b = new FakeBackend();
    const s = makeSidetone(b);
    s.setFrequency(800);
    s.setVolume(2);
    s.setVolume(-1);
    s.setVolume(0.25);
    expect(b.events).toEqual(["freq:800", "vol:1", "vol:0", "vol:0.25"]);
  });

  it("dispose 会先停音再释放资源，且之后按键不再发声", () => {
    const b = new FakeBackend();
    const s = makeSidetone(b);
    s.keyDown();
    s.dispose();
    expect(b.events).toEqual(["start:700:0.4", "stop", "dispose"]);
    s.keyDown();
    expect(b.events.length).toBe(3);
  });

  it("后端不可用时（Node / jsdom）按键静默失败，不抛异常", () => {
    const b = new FakeBackend(false);
    const s = makeSidetone(b);
    expect(s.available).toBe(false);
    expect(() => {
      s.keyDown();
      s.keyUp();
    }).not.toThrow();
  });
});

// --- WebAudioSidetone ------------------------------------------------------

class FakeParam {
  value = 0;
  setValueAtTime(v: number): void {
    this.value = v;
  }
  linearRampToValueAtTime(v: number): void {
    this.value = v;
  }
  cancelScheduledValues(): void {}
}

class FakeGain {
  gain = new FakeParam();
  connect(): void {}
}

class FakeOsc {
  type = "";
  frequency = new FakeParam();
  started = false;
  stopped = false;
  connect(): void {}
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
}

class FakeCtx {
  static instances: FakeCtx[] = [];
  state = "suspended";
  currentTime = 0;
  destination = {};
  resumed = false;
  closed = false;
  osc: FakeOsc | null = null;
  gain: FakeGain | null = null;

  constructor() {
    FakeCtx.instances.push(this);
  }
  resume(): void {
    this.resumed = true;
    this.state = "running";
  }
  createOscillator(): FakeOsc {
    this.osc = new FakeOsc();
    return this.osc;
  }
  createGain(): FakeGain {
    this.gain = new FakeGain();
    return this.gain;
  }
  close(): void {
    this.closed = true;
  }
}

function fakeCtxFactory(): () => FakeCtx {
  return () => new FakeCtx();
}

describe("WebAudioSidetone", () => {
  it("没有 AudioContext 时不可用，且不创建任何音频对象", () => {
    const s = new WebAudioSidetone(() => null);
    expect(s.available).toBe(false);
    s.start(700, 0.4);
    s.stop();
    expect(() => s.dispose()).not.toThrow();
  });

  it("起音做斜坡到目标音量，停音斜坡回 0（避免键噪）", () => {
    const ctxs = FakeCtx.instances;
    ctxs.length = 0;
    const s = new WebAudioSidetone(fakeCtxFactory());
    expect(s.available).toBe(true);

    s.start(700, 0.5);
    const ctx = ctxs[0];
    expect(ctx).toBeDefined();
    expect(ctx.osc?.started).toBe(true);
    expect(ctx.gain?.gain.value).toBe(0.5);
    // Chrome starts suspended until a gesture; keying counts as one.
    expect(ctx.resumed).toBe(true);

    s.stop();
    expect(ctx.gain?.gain.value).toBe(0);
  });

  it("起音前增益为 0，不会一上来就响", () => {
    FakeCtx.instances.length = 0;
    const s = new WebAudioSidetone(fakeCtxFactory());
    s.start(700, 0.3);
    const ctx = FakeCtx.instances[0];
    expect(ctx.gain?.gain.value).toBe(0.3);
    s.dispose();
    expect(ctx.osc?.stopped).toBe(true);
    expect(ctx.closed).toBe(true);
  });

  it("dispose 后再调用是安全的", () => {
    const s = new WebAudioSidetone(fakeCtxFactory());
    s.start(700, 0.3);
    s.dispose();
    expect(s.available).toBe(false);
    expect(() => {
      s.start(700, 0.3);
      s.stop();
      s.dispose();
    }).not.toThrow();
  });
});
