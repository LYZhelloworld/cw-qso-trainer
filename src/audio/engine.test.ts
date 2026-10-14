import { describe, expect, it } from "vitest";
import { CwAudioEngine } from "./engine.js";
import type {
  AudioBufferSourceLike,
  AudioContextLike,
  PlaybackHandle,
} from "./player.js";

class FakeCtx implements AudioContextLike {
  currentTime = 0;
  readonly destination = {};
  readonly sources: Array<{ start: boolean; stop: boolean }> = [];
  createBuffer(): { length: number; copyToChannel(): void } {
    return { length: 0, copyToChannel() {} };
  }
  createBufferSource(): AudioBufferSourceLike {
    const rec = { start: false, stop: false };
    this.sources.push(rec);
    return {
      buffer: null,
      connect() {},
      start() {
        rec.start = true;
      },
      stop() {
        rec.stop = true;
      },
      onended: null,
    };
  }
  resume(): void {}
}

function manualTimer(clock?: { currentTime: number }) {
  let cb: (() => void) | null = null;
  const timer = (fn: () => void): (() => void) => {
    cb = fn;
    return () => {
      cb = null;
    };
  };
  return {
    timer,
    drive: (seconds: number, step = 0.05): void => {
      for (let t = 0; t < seconds; t += step) {
        if (clock) clock.currentTime += step;
        cb?.();
      }
    },
  };
}

describe("CwAudioEngine", () => {
  it("Node 下 playbackAvailable 为 false，play 立即 resolve（不抛不挂）", async () => {
    const e = new CwAudioEngine();
    expect(e.playbackAvailable).toBe(false);
    const h = e.play("CQ DE BG7XXX");
    await h.done;
  });

  it("存在 AudioContext 时 playbackAvailable 为 true", () => {
    const g = globalThis as Record<string, unknown>;
    const prev = g.AudioContext;
    g.AudioContext = class {};
    try {
      expect(new CwAudioEngine().playbackAvailable).toBe(true);
    } finally {
      g.AudioContext = prev;
    }
  });

  it("注入 context 时 play 走调度器，done 随播放结束解析", async () => {
    const ctx = new FakeCtx();
    const { timer, drive } = manualTimer(ctx);
    const e = new CwAudioEngine({ contextFactory: () => ctx, timer });
    const h: PlaybackHandle = e.play("CQ DE BG7XXX");
    drive(15);
    await h.done;
  });

  it("stop() 可中断进行中的播放（done 立即解析）", async () => {
    const ctx = new FakeCtx();
    const { timer, drive } = manualTimer(ctx);
    const e = new CwAudioEngine({ contextFactory: () => ctx, timer });
    const h = e.play("CQ CQ CQ DE BG7XXX BG7XXX PSE K");
    drive(0.2);
    expect(ctx.sources.some((s) => s.start)).toBe(true);
    e.stop();
    await h.done;
  });
});
