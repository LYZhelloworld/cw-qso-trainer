import { difficultyToEnvironment, type Environment } from "../audio/environment.js";
import type { SynthReceiver, SynthStation } from "../audio/bandSynth.js";
import type { AudioPlayer, EngineRenderOptions } from "../audio/engine.js";
import { textToTiming } from "../cw/encode.js";
import type { KeyElement } from "../cw/decoder.js";
import { receiveStation, type Reception, type Sideband } from "../ham/tuning.js";
import { txOffsetSec, type Tx } from "../ham/tx.js";
import type { VirtualHam } from "../ham/virtualHam.js";
import type { AppSettings } from "./settingsSchema.js";

/**
 * Everything audio-related for one session: what the receiver does to a
 * station, and getting a message on the air.
 *
 * Split out of `QsoSession` because it is the one part of the session that only
 * *reads* state — the current settings, where the dial is, which filter is in,
 * who the partner is — and never changes what the QSO is doing. The session
 * hands it a `view()` snapshot on every call instead of letting it hold a
 * reference, so there is no way for a change of settings to be missed.
 */

/** The live settings/dial state a playback decision depends on. */
export interface AudioView {
  settings: AppSettings;
  /** Dial frequency in Hz. */
  dialHz: number;
  /** The sideband being demodulated (decides which way a detuned note shifts). */
  sideband: Sideband;
  /** Receiver filter width in Hz. */
  passbandHz: number;
  /** The station being worked, if there is one. */
  partner: VirtualHam | null;
}

/**
 * The band engine the session drives, as far as the session is concerned.
 *
 * `BandSynth` implements it; tests pass a spy. Keeping it a narrow port means
 * the session can be tested for *what it asks the band to do* — put this
 * station on, key this message, go deaf while I send — without building a Web
 * Audio graph. The engine's own node-level behaviour is tested next to it.
 */
export interface LiveBand {
  readonly available: boolean;
  setReceiver(rx: SynthReceiver): void;
  setEnvironment(environment: Environment): void;
  ensureStation(station: SynthStation): void;
  removeStation(call: string): void;
  key(tx: Tx, call: string, atMs: number): void;
  keyFrom(tx: Tx, call: string, atMs: number, elapsedMs: number): void;
  keyMine(tx: Tx, atMs: number, elapsedMs?: number): void;
  silenceMine(): void;
  setTransmitting(on: boolean): void;
  setMuted(on: boolean): void;
  dispose(): void;
}

export class SessionAudio {  /**
   * Realtime band synth, when one is supplied. With it the session **keys** a
   * transmission instead of rendering a recording; without it the old PCM path
   * is used. Both are kept side by side while the model is migrated, so the
   * sound can be compared and either one switched off in a single place.
   */
  private synthOn = false;
  /** Calls currently on the band, so `syncStations` can spot the gaps. */
  private stationCalls = new Set<string>();

  constructor(
    private readonly engine: AudioPlayer,
    private readonly view: () => AudioView,
    private readonly synth?: LiveBand,
    /**
     * Pacing, injectable (tests). The realtime path has no buffer to await, so
     * an over "ends" when its last element would have been keyed; whoever drives
     * the exchange has to wait that long.
     */
    private readonly wait: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** True when the realtime path is actually in use (no synth, no switch). */
  get live(): boolean {
    return this.synthOn && this.synth !== undefined && this.synth.available;
  }

  /** Turn the realtime band synth on or off (see `live`). */
  useSynth(on: boolean): void {
    this.synthOn = on;
    if (on) this.wireSynth();
  }

  /** Push the current receiver position and volume into the synth. */
  wireSynth(): void {
    if (!this.synth) return;
    const { settings, dialHz, sideband, passbandHz } = this.view();
    this.synth.setReceiver({
      dialHz,
      sideband,
      passbandHz,
      toneHz: settings.toneHz,
    });
    this.synth.setEnvironment(difficultyToEnvironment(settings.difficulty));
  }

  /** False where there is no AudioContext (Node, jsdom, blocked autoplay). */
  get available(): boolean {
    return this.engine.playbackAvailable;
  }

  /**
   * What the receiver does to a station at the current dial setting: its note,
   * how loud it comes through, and whether it is inside the workable window
   * (see `ham/tuning`). `null` once the filter's skirt has run out. Falls back
   * to a clean, full-strength reception for an unplaced or absent station.
   */
  reception(ham?: VirtualHam | null): Reception | null {
    const { settings, dialHz, sideband, passbandHz, partner } = this.view();
    const station = ham ?? partner;
    if (!station || station.freqHz <= 0) {
      return { toneHz: settings.toneHz, gain: 1, inPassband: true };
    }
    return receiveStation({
      toneHz: settings.toneHz,
      stationHz: station.freqHz,
      dialHz,
      sideband,
      passbandHz,
    });
  }

  /** Play a station's transmission, off-key and quieter if it is detuned. */
  async playHam(text: string, ham?: VirtualHam): Promise<void> {
    await this.playStation(text, ham, 0);
  }

  /**
   * Keep the band in step with the roster: every station that exists gets a
   * transmitter, every station that has gone gets taken off the air.
   *
   * Called from the session's tick, so a station spawned mid-exchange starts
   * calling on the same beat it appears — and one that leaves does not leave a
   * carrier behind.
   */
  syncStations(hams: VirtualHam[]): void {
    if (!this.live) return;
    const synth = this.synth!;
    const present = new Set<string>();
    for (const ham of hams) {
      if (ham.freqHz <= 0) continue; // answerers have no spot on the band
      present.add(ham.call);
      synth.ensureStation({
        call: ham.call,
        freqHz: ham.freqHz,
        strength: ham.strength,
        difficulty: ham.difficulty,
      });
    }
    for (const call of this.stationCalls) {
      if (!present.has(call)) synth.removeStation(call);
    }
    this.stationCalls = present;
  }

  /** Half-duplex: while our key is down the receiver hears nothing. */
  setTransmitting(on: boolean): void {
    this.synth?.setTransmitting(on);
  }

  /** Tear down the audio graph with the session. */
  dispose(): void {
    this.engine.stop();
    this.synth?.dispose();
  }

  /**
   * Put a recorded transmission on the air, starting where it has already got
   * to.
   *
   * Playback takes the `Tx` itself rather than a text plus an offset spelled out
   * by the caller: the same record drives the waterfall and the meter, so the
   * audio cannot start at a different point than the signal shown on screen —
   * tuning onto a station mid-CQ hears exactly the part the display says is
   * still being sent.
   */
  async playTx(tx: Tx, ham: VirtualHam | null | undefined, at: number): Promise<void> {
    if (this.live && ham) {
      // Realtime: the station's carrier is already running on the bus, so this
      // only keys the dots and dashes onto it — no rendering, no buffer.
      this.wireSynth();
      this.synth!.ensureStation({
        call: ham.call,
        freqHz: ham.freqHz,
        strength: ham.strength,
        difficulty: ham.difficulty,
      });
      // Key from the message's own start time, not from `at`: the carrier is
      // live, so a message that began before the operator tuned in is already
      // part-way through — and that is exactly what should be heard.
      this.synth!.key(tx, ham.call, tx.startedAt);
      // Nothing to play back, but callers still pace themselves on how long a
      // transmission takes (replies follow each other at keying speed), so
      // resolve when this over would have finished.
      await this.waitFor(tx.startedAt + tx.durationMs - at);
      return;
    }
    await this.playStation(tx.text, ham ?? undefined, txOffsetSec(tx, at));
  }

  private async playStation(
    text: string,
    ham: VirtualHam | undefined,
    offsetSec: number,
  ): Promise<void> {
    const { settings } = this.view();
    const rx = this.reception(ham);
    // Past the skirt we render nothing: the station is filtered out, so there
    // is no note to play — not even a wrong one.
    if (rx === null) return;
    const env = difficultyToEnvironment(ham?.difficulty ?? settings.difficulty);
    // `...extra` wins over the default pitch in `play`, so the station is heard
    // off-key whenever the operator has not tuned it in — and quieter the
    // further out it sits, down to the point where it is gone.
    await this.play(text, {
      qsb: env.qsb,
      qrm: env.qrm,
      qrn: env.qrn,
      toneHz: rx.toneHz,
      gain: rx.gain,
      offsetSec,
    });
  }

  /** The operator's own transmission: always its own pitch, never faded. */
  async playMine(tx: Tx, at: number): Promise<void> {
    if (this.live) {
      // Keyed onto the monitor bus, which is not muted by half-duplex — a rig
      // does not go deaf to its own keying. Resolve when the over would end, so
      // the caller paces the exchange the same way as with rendered audio.
      this.wireSynth();
      this.synth!.keyMine(tx, tx.startedAt);
      await this.waitFor(tx.startedAt + tx.durationMs - at);
      return;
    }
    await this.play(tx.text, {});
  }

  /**
   * Join a station that is already being transmitted: hear the rest of it, from
   * the dot that is going out right now.
   *
   * Nothing is replayed in the realtime path — the message was keyed when it
   * started, so this simply keys the remaining part as of now, which is also
   * exactly what the waterfall has been drawing.
   */
  joinTx(tx: Tx, ham: VirtualHam, at: number): void {
    if (this.live) {
      this.wireSynth();
      this.synth!.ensureStation({
        call: ham.call,
        freqHz: ham.freqHz,
        strength: ham.strength,
        difficulty: ham.difficulty,
      });
      this.synth!.keyFrom(tx, ham.call, at, at - tx.startedAt);
      return;
    }
    void this.playStation(tx.text, ham, txOffsetSec(tx, at));
  }

  /** Mute the whole receiver (power off) without stopping the band. */
  setMuted(on: boolean): void {
    if (this.live) {
      this.synth!.setMuted(on);
      return;
    }
    if (on) this.engine.stop();
  }

  /** Cut any in-flight playback (the operator breaks in on a HAM's CQ). */
  stop(): void {
    if (this.live) {
      // Nobody's transmission is stopped by the operator pressing PTT — the
      // band carries on and only the receiver goes deaf (`setTransmitting`).
      // What does stop is our own keying, if it was cut short.
      this.synth!.silenceMine();
      return;
    }
    this.engine.stop();
  }

  /**
   * The keying envelope of a message at the operator's current speed: the
   * on/off element lengths in ms. The waterfall reads the same envelope the
   * audio does, so a signal is lit exactly while its tone is on the air.
   */
  keyElements(text: string): KeyElement[] {
    const { settings } = this.view();
    return textToTiming(text, {
      wpm: settings.wpm,
      ...(settings.farnsworthEnabled ? { farnsworthWpm: settings.farnsworthWpm } : {}),
    });
  }

  /** How long a message takes to key at the operator's current speed, in ms. */
  callDurationMs(text: string): number {
    return this.keyElements(text).reduce((total, e) => total + e.on + e.off, 0);
  }

  /**
   * Wait out the rest of a transmission. The realtime path has no buffer to
   * await, but the exchange still has to pace itself on keying time, so an
   * over "ends" exactly when its last element would have finished.
   */
  private waitFor(remainingMs: number): Promise<void> {
    if (remainingMs <= 0) return Promise.resolve();
    return this.wait(remainingMs);
  }

  private async play(text: string, extra: EngineRenderOptions): Promise<void> {    const { settings } = this.view();
    const opts: EngineRenderOptions = {
      wpm: settings.wpm,
      toneHz: settings.toneHz,
      ...(settings.farnsworthEnabled ? { farnsworthWpm: settings.farnsworthWpm } : {}),
      ...extra,
    };
    try {
      await this.engine.play(text, opts).done;
    } catch {
      // No AudioContext or blocked autoplay: the QSO flow still works silently.
    }
  }
}
