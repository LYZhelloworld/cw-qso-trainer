import { describe, expect, it } from "vitest";
import {
  LookaheadPlayer,
  type AudioBufferLike,
  type AudioBufferSourceLike,
  type AudioContextLike,
} from "./player.js";

/** Records every `start` so we can assert the schedule against the audio clock. */
class FakeSource implements AudioBufferSourceLike {
  buffer: AudioBufferLike | null = null;
  onended: (() => void) | null = null;
  startCalls: Array<{ when: number; offset: number; duration: number }> = [];
  stopCalled = false;
  connect(): void {}
  start(when?: number, offset?: number, duration?: number): void {
    this.startCalls.push({ when: when ?? 0, offset: offset ?? 0, duration: duration ?? 0 });
  }
  stop(): void {
    this.stopCalled = true;
  }
}

class FakeCtx implements AudioContextLike {
  currentTime = 0;
  readonly destination = {};
  readonly created: FakeSource[] = [];
  createBuffer(): { length: number; copyToChannel(): void } {
    return { length: 0, copyToChannel() {} };
  }
  createBufferSource(): AudioBufferSourceLike {
    const s = new FakeSource();
    this.created.push(s);
    return s;
  }
  resume(): void {}
}

/** A timer whose callback we drive by hand, with a controllable clock. */
function manualTimer() {
  let cb: (() => void) | null = null;
  const timer = (fn: () => void): (() => void) => {
    cb = fn;
    return () => {
      cb = null;
    };
  };
  return {
    timer,
    tick: (advanceSec: number, times = 1): void => {
      for (let i = 0; i < times; i++) {
        // advance the clock slightly before each wake so the scheduler makes
        // progress; the exact amount is irrelevant to the assertions.
        // (kept here only to mirror real time passing between wakes)
        void advanceSec;
        cb?.();
      }
    },
  };
}

const ONE_SEC = new Float32Array(44100); // 1 s @ 44.1 kHz

describe("LookaheadPlayer", () => {
  it("无 context 时立即 resolve，不调度、不抛", async () => {
    const p = new LookaheadPlayer(() => null);
    const h = p.play(ONE_SEC, 44100);
    await h.done; // resolves immediately
    h.stop(); // safe no-op
  });

  it("按音频时钟分块调度，覆盖整段且首块在 lead-in 之后", () => {
    const ctx = new FakeCtx();
    const { timer, tick } = manualTimer();
    const p = new LookaheadPlayer(() => ctx, {
      timer,
      chunkSec: 0.05,
      lookaheadSec: 0.1,
    });
    const h = p.play(ONE_SEC, 44100);

    // Initial tick queues the first lookahead window worth of chunks.
    expect(ctx.created.length).toBeGreaterThan(0);
    const first = ctx.created[0].startCalls[0];
    expect(first.when).toBeCloseTo(0.05, 5); // START_PAD_SEC
    expect(first.offset).toBeCloseTo(0, 5);

    // Drive the clock forward; each wake tops up the schedule.
    for (let i = 0; i < 40; i++) {
      ctx.currentTime += 0.05;
      tick(0.05);
    }
    const total = ctx.created.reduce((acc, s) => acc + s.startCalls[0].duration, 0);
    expect(total).toBeCloseTo(1.0, 2);

    ctx.currentTime += 0.2;
    tick(0.2);
    return h.done;
  });

  it("stop() 立即中断：不再调度后续块，done 解析，已排块被停", () => {
    const ctx = new FakeCtx();
    const { timer, tick } = manualTimer();
    const p = new LookaheadPlayer(() => ctx, {
      timer,
      chunkSec: 0.05,
      lookaheadSec: 0.1,
    });
    const h = p.play(new Float32Array(44100 * 2), 44100); // 2 s

    ctx.currentTime += 0.1;
    tick(0.1);
    const scheduledBefore = ctx.created.length;
    expect(scheduledBefore).toBeGreaterThan(0);

    h.stop();

    // Further wakes must not schedule more and must not throw.
    ctx.currentTime += 1.0;
    tick(1.0);
    expect(ctx.created.length).toBe(scheduledBefore);
    expect(ctx.created.some((s) => s.stopCalled)).toBe(true);
    return h.done;
  });

  it("play() 新的会打断旧的播放", async () => {
    const ctx = new FakeCtx();
    const { timer } = manualTimer();
    const p = new LookaheadPlayer(() => ctx, { timer });
    const first = p.play(ONE_SEC, 44100);
    const second = p.play(ONE_SEC, 44100); // should stop `first`
    p.stop(); // stop `second`
    await first.done;
    await second.done;
  });
});
