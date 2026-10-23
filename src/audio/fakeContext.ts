import type {
  AudioParamLike,
  BandContextLike,
  GainLike,
  OscillatorLike,
} from "./bandSynth.js";
import type { AudioBufferLike } from "./types.js";

/**
 * A fake Web Audio graph for tests: enough of the API for `BandSynth`, and it
 * records the automation it is asked for — which is the point, because the
 * engine's whole job is to schedule ramps and glides, so assertions are about
 * *when*, *how loud* and *what frequency*.
 *
 * Node creation order inside `BandSynth` is fixed and documented there:
 * `master`, `noise`, `qrm bus`, `monitor`, then per station `osc`, `keyGain`,
 * `levelGain`. Tests that need a specific node read it by that order (see
 * `BUSSES` / `keysOf`), which keeps the fake itself free of engine knowledge.
 */

export class FakeParam implements AudioParamLike {
  value = 0;
  events: Array<{ kind: "set" | "ramp" | "target" | "cancel"; value: number; time: number }> = [];

  setValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ kind: "set", value, time });
  }
  linearRampToValueAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ kind: "ramp", value, time });
  }
  setTargetAtTime(value: number, time: number): void {
    this.value = value;
    this.events.push({ kind: "target", value, time });
  }
  cancelScheduledValues(time: number): void {
    this.events.push({ kind: "cancel", value: 0, time });
  }
}

export class FakeGain implements GainLike {
  readonly gain = new FakeParam();
  /** Everything this node was connected to (so wiring itself can be asserted). */
  readonly outputs: unknown[] = [];
  connect(destination: unknown): void {
    this.outputs.push(destination);
  }
  disconnect(): void {}
}

export class FakeOsc implements OscillatorLike {
  readonly frequency = new FakeParam();
  type = "sine";
  started = false;
  stopped = false;
  onended: (() => void) | null = null;
  readonly outputs: unknown[] = [];
  connect(destination: unknown): void {
    this.outputs.push(destination);
  }
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
  }
}

class FakeSource {
  buffer: AudioBufferLike | null = null;
  onended: (() => void) | null = null;
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

export class FakeBandContext implements BandContextLike {
  currentTime = 0;
  sampleRate = 48_000;
  destination = { name: "destination" };
  readonly gains: FakeGain[] = [];
  readonly oscs: FakeOsc[] = [];
  readonly sources: FakeSource[] = [];

  createGain(): FakeGain {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createOscillator(): FakeOsc {
    const o = new FakeOsc();
    this.oscs.push(o);
    return o;
  }
  createBuffer(_channels: number, length: number): AudioBufferLike {
    return { length, copyToChannel(): void {} };
  }
  createBufferSource(): FakeSource {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  resume(): void {}
}

/** Indices of the bus nodes, in the order `BandSynth` builds them. */
export const BUSSES = { master: 0, noise: 1, qrm: 2, monitor: 3 } as const;

/** Where a station's own nodes start (each station adds three of them). */
const FIRST_STATION_GAIN = 4;

/** One station's `keyGain` / `levelGain`, by the order stations were added. */
export function stationGains(ctx: FakeBandContext, index: number) {
  const key = ctx.gains[FIRST_STATION_GAIN + index * 2]?.gain;
  const level = ctx.gains[FIRST_STATION_GAIN + index * 2 + 1]?.gain;
  if (!key || !level) throw new Error(`no station #${index} in this context`);
  return { key, level };
}

/** Round to milliseconds, for readable event-time assertions. */
export function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
