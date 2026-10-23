/**
 * Minimal structural views of the Web Audio bits the audio layer touches.
 *
 * Kept free of the DOM lib so the core stays runnable under Node (tests, the
 * sample-WAV script) and so a fake graph can be substituted in tests without
 * pretending to be a browser.
 */

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
