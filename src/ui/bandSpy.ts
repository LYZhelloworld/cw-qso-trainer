import type { LiveBand } from "./sessionAudio.js";
import type { SynthReceiver, SynthStation } from "../audio/bandSynth.js";
import type { Environment } from "../audio/environment.js";
import type { Tx } from "../ham/tx.js";

/**
 * A stand-in band for session tests: it records what the session asks the
 * synthesizer to do, in order. The session's job in the realtime model is not
 * to render audio but to *drive* the band — put stations on it, key messages
 * onto them, go deaf while sending — so that conversation is what these tests
 * assert. The engine's own node behaviour is `bandSynth.test.ts`.
 */
export class SpyBand implements LiveBand {
  readonly available = true;
  readonly calls: Array<{ what: string; [key: string]: unknown }> = [];
  readonly keyed: Array<{ call: string; text: string; atMs: number }> = [];
  readonly joined: Array<{ call: string; text: string; atMs: number; elapsedMs: number }> = [];
  readonly mine: string[] = [];
  readonly transmitting: boolean[] = [];
  readonly muted: boolean[] = [];
  receiver: SynthReceiver | null = null;
  readonly stations = new Set<string>();

  private log(what: string, extra: Record<string, unknown> = {}): void {
    this.calls.push({ what, ...extra });
  }

  /**
   * Every message that went on the air, in order — the band's stations and the
   * operator's own keying alike (the latter on the monitor bus, not the band's).
   */
  get texts(): string[] {
    return this.calls
      .filter((c) => c.what === "key" || c.what === "keyMine")
      .map((c) => String(c.text));
  }

  setReceiver(rx: SynthReceiver): void {
    this.receiver = rx;
    this.log("receiver", { dialHz: rx.dialHz, passbandHz: rx.passbandHz });
  }
  setEnvironment(environment: Environment): void {
    this.log("environment", { qrm: environment.qrm.enabled });
  }
  ensureStation(station: SynthStation): void {
    this.stations.add(station.call);
    this.log("station", { call: station.call });
  }
  removeStation(call: string): void {
    this.stations.delete(call);
    this.log("remove", { call });
  }
  key(tx: Tx, call: string, atMs: number): void {
    this.keyed.push({ call, text: tx.text, atMs });
    this.log("key", { call, atMs, text: tx.text });
  }
  keyFrom(tx: Tx, call: string, atMs: number, elapsedMs: number): void {
    this.joined.push({ call, text: tx.text, atMs, elapsedMs });
    this.log("keyFrom", { call, atMs, elapsedMs, text: tx.text });
  }
  keyMine(tx: Tx, atMs: number): void {
    this.mine.push(tx.text);
    this.log("keyMine", { atMs, text: tx.text });
  }
  silenceMine(): void {
    this.log("silenceMine");
  }
  setTransmitting(on: boolean): void {
    this.transmitting.push(on);
    this.log("transmitting", { on });
  }
  setMuted(on: boolean): void {
    this.muted.push(on);
    this.log("muted", { on });
  }
  dispose(): void {
    this.stations.clear();
    this.log("dispose");
  }

  /** The last call of a kind, or undefined. */
  last(what: string) {
    return [...this.calls].reverse().find((c) => c.what === what);
  }
  all(what: string) {
    return this.calls.filter((c) => c.what === what);
  }
  /** Forget the log, keeping the band's state (stations, receiver) intact. */
  clear(): void {
    this.calls.length = 0;
    this.keyed.length = 0;
    this.joined.length = 0;
    this.mine.length = 0;
    this.transmitting.length = 0;
    this.muted.length = 0;
  }
}
