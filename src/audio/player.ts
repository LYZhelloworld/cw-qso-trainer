/**
 * Lookahead playback scheduler for pre-rendered CW samples.
 *
 * The whole message is rendered once by `renderCwAudio` (so the noise floor /
 * QRM stay continuous across the message — see the QRN caveat in
 * AUDIO-ENVIRONMENT.md), then this player schedules it on the Web Audio clock in
 * small chunks *ahead* of the playhead. Scheduling ahead (rather than one giant
 * `BufferSource`) buys two things the practice app needs:
 *
 *  1. **Interruptibility** — `stop()` halts scheduling and silences any
 *     not-yet-played chunk, so the operator can break in on a HAM that is still
 *     calling CQ.
 *  2. **Glitch-free long audio** — the audio clock (not `setTimeout`) drives
 *     timing, so playback keeps its rhythm even when the main thread is busy.
 *
 * All timing primitives are injectable so the scheduler is deterministic under
 * Node (no `AudioContext`, no real timer) and unit-testable.
 */

/** Minimal structural view of the Web Audio bits we touch (no DOM lib dep). */
export interface AudioContextLike {
  readonly currentTime: number;
  readonly destination: unknown;
  /** Resume a suspended context (browser autoplay policy). Optional under test. */
  resume?(): void;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  createBufferSource(): AudioBufferSourceLike;
}

export interface AudioBufferLike {
  readonly length: number;
  copyToChannel(source: Float32Array, channel: number): void;
}

export interface AudioBufferSourceLike {
  buffer: AudioBufferLike | null;
  connect(node: unknown): void;
  /** `start(when, offsetSec, durationSec)` plays a slice of the buffer. */
  start(when?: number, offset?: number, duration?: number): void;
  stop(when?: number): void;
  onended: (() => void) | null;
}

/** A single in-flight playback. Resolve `done` on natural end or on `stop()`. */
export interface PlaybackHandle {
  readonly done: Promise<void>;
  stop(): void;
}

export interface PlayerOptions {
  /** How far ahead (seconds) to schedule audio relative to the playhead. */
  lookaheadSec?: number;
  /** How often (ms) the scheduler wakes to top up the schedule. */
  scheduleIntervalMs?: number;
  /** Size of each scheduled chunk in seconds. */
  chunkSec?: number;
  /** Injectable timer (tests); defaults to `setInterval`/`clearInterval`. */
  timer?: (cb: () => void, ms: number) => () => void;
}

const DEFAULT_LOOKAHEAD_SEC = 0.1;
const DEFAULT_INTERVAL_MS = 25;
const DEFAULT_CHUNK_SEC = 0.05; // ~50 ms at any sample rate; fine for break-in
const START_PAD_SEC = 0.05; // small lead-in so the first chunk is not clipped

export class LookaheadPlayer {
  private current: PlaybackHandle | null = null;

  constructor(
    private readonly makeContext: () => AudioContextLike | null,
    private readonly opts: PlayerOptions = {},
  ) {}

  /** Schedule `samples` for playback. Cuts any in-flight playback first. */
  play(samples: Float32Array, sampleRate: number): PlaybackHandle {
    this.current?.stop();

    const ctx = this.makeContext();
    if (!ctx) {
      // No audio device (Node, jsdom, or a browser with no AudioContext):
      // resolve immediately so callers that await `done` never hang.
      const immediate: PlaybackHandle = { done: Promise.resolve(), stop() {} };
      this.current = immediate;
      return immediate;
    }

    const lookahead = this.opts.lookaheadSec ?? DEFAULT_LOOKAHEAD_SEC;
    const intervalMs = this.opts.scheduleIntervalMs ?? DEFAULT_INTERVAL_MS;
    const chunkSec = this.opts.chunkSec ?? DEFAULT_CHUNK_SEC;
    const timer =
      this.opts.timer ??
      ((cb: () => void, ms: number) => {
        const id = setInterval(cb, ms);
        return () => clearInterval(id);
      });

    const durationSec = samples.length / sampleRate;
    const buffer = ctx.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);

    let offsetSec = 0;
    let nextTime = ctx.currentTime + START_PAD_SEC;
    const sources: Array<{ src: AudioBufferSourceLike; end: number }> = [];
    let resolved = false;
    let cancel: () => void = () => {};
    let resolveDone!: () => void;
    const done = new Promise<void>((res) => {
      resolveDone = res;
    });

    const finish = (): void => {
      if (resolved) return;
      resolved = true;
      cancel();
      resolveDone();
    };

    const tick = (): void => {
      if (resolved) return;
      const now = ctx.currentTime;
      // Top up the schedule: keep ~lookahead seconds queued on the clock.
      while (offsetSec < durationSec && nextTime < now + lookahead) {
        const dur = Math.min(chunkSec, durationSec - offsetSec);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.start(nextTime, offsetSec, dur);
        const end = nextTime + dur;
        sources.push({ src, end });
        // The final chunk ending resolves the handle (idempotent with stop()).
        if (offsetSec + dur >= durationSec) src.onended = () => finish();
        nextTime += dur;
        offsetSec += dur;
      }
      // Drop sources whose tail has already passed the playhead.
      for (let i = sources.length - 1; i >= 0; i--) {
        if (sources[i].end <= now) sources.splice(i, 1);
      }
      if (offsetSec >= durationSec && sources.length === 0) finish();
    };

    cancel = timer(tick, intervalMs);
    tick();

    const handle: PlaybackHandle = {
      done,
      stop: () => {
        if (resolved) return;
        resolved = true;
        cancel();
        for (const s of sources) {
          try {
            s.src.stop();
          } catch {
            /* an already-ended source is fine */
          }
        }
        sources.length = 0;
        resolveDone();
      },
    };
    this.current = handle;
    return handle;
  }

  /** Interrupt any in-flight playback (no-op if nothing is playing). */
  stop(): void {
    this.current?.stop();
    this.current = null;
  }
}
