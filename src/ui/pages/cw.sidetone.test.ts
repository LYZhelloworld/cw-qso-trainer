// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderCw } from "./cw.js";
import { normalizeSettings, type AppSettings } from "../settingsSchema.js";
import { QsoSession } from "../session.js";
import type { AppHost, PageId } from "../app.js";

/**
 * Sidetone tests live in their own file on purpose: the CW page registers its
 * key handlers on `document`, and listeners left behind by another test file's
 * fixtures would answer the dispatched events too (each test file gets its own
 * jsdom environment, so a separate file keeps them out of the way).
 */

function mount(overrides: Partial<AppSettings> = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  const settings = normalizeSettings({ myCall: "BG7XXX", assistMode: false, ...overrides });
  const session = new QsoSession(14.025, settings);
  let cleanups: Array<() => void> = [];

  const host: AppHost = {
    settings,
    session,
    updateSettings(patch: Partial<AppSettings>) {
      host.settings = normalizeSettings({ ...host.settings, ...patch });
      session.updateSettings(host.settings);
      render();
    },
    newSession() {
      session.reset();
      render();
    },
    go(_page: PageId) {},
    refresh() {
      render();
    },
    onLeave(fn: () => void) {
      cleanups.push(fn);
    },
  };

  function render(): void {
    for (const fn of cleanups) fn();
    cleanups = [];
    const page = document.createElement("div");
    renderCw(host, page);
    root.replaceChildren(page);
  }

  render();
  return { host, session, root, render };
}

function key(type: "keydown" | "keyup", code: string): void {
  document.dispatchEvent(new KeyboardEvent(type, { code }));
}

// --- fake Web Audio --------------------------------------------------------

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

class FakeAudioNode {
  gain = new FakeParam();
  frequency = new FakeParam();
  type = "";
  connect(): void {}
  start(): void {}
  stop(): void {}
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state = "suspended";
  currentTime = 0;
  destination = {};
  osc: FakeAudioNode | null = null;
  gainNode: FakeAudioNode | null = null;
  closed = false;

  constructor() {
    FakeAudioContext.instances.push(this);
  }
  resume(): void {
    this.state = "running";
  }
  createOscillator(): FakeAudioNode {
    this.osc = new FakeAudioNode();
    return this.osc;
  }
  createGain(): FakeAudioNode {
    this.gainNode = new FakeAudioNode();
    return this.gainNode;
  }
  close(): void {
    this.closed = true;
  }
}

describe("发报侧音", () => {
  beforeEach(() => {
    FakeAudioContext.instances.length = 0;
    vi.stubGlobal("AudioContext", FakeAudioContext);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("直键：按下即起音，松开即停", () => {
    mount({ keyMode: "straight", sidetone: true, sidetoneVolume: 50 });
    key("keydown", "Space");

    const ctx = FakeAudioContext.instances[0];
    expect(ctx).toBeDefined();
    expect(ctx.osc).not.toBeNull();
    expect(ctx.gainNode?.gain.value).toBe(0.5);
    expect(ctx.state).toBe("running"); // 按键算用户手势，解除自动播放限制

    key("keyup", "Space");
    expect(ctx.gainNode?.gain.value).toBe(0);
  });

  it("侧音关闭时完全不创建音频设备", () => {
    mount({ keyMode: "straight", sidetone: false });
    key("keydown", "Space");
    expect(FakeAudioContext.instances.length).toBe(0);
  });

  it("iambic：元素期间发声，自动间隔转静音", async () => {
    mount({ keyMode: "iambic", sidetone: true, sidetoneVolume: 50, wpm: 20 });

    key("keydown", "KeyZ");
    const ctx = FakeAudioContext.instances[0];
    expect(ctx.gainNode?.gain.value).toBe(0.5);

    // 松开后元素仍在发（20 WPM 的点 = 60 ms），驱动循环推进后自动停音
    key("keyup", "KeyZ");
    await vi.waitFor(() => expect(ctx.gainNode?.gain.value).toBe(0), {
      timeout: 2000,
      interval: 20,
    });
  });

  it("重绘（清理钩子）会释放音频资源", () => {
    const h = mount({ keyMode: "straight", sidetone: true });
    key("keydown", "Space");
    const ctx = FakeAudioContext.instances[0];

    h.render();
    expect(ctx.closed).toBe(true);
  });

  it("页面提示侧音状态与音量", () => {
    const { root } = mount({ keyMode: "straight", sidetone: true, sidetoneVolume: 50, toneHz: 600 });
    expect(root.textContent).toContain("侧音：开（600 Hz，音量 50%）");
  });
});
