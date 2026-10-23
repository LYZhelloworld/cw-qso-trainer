import { difficultyToEnvironment, type Environment } from "../audio/environment.js";
import type { SynthReceiver, SynthStation } from "../audio/bandSynth.js";
import { textToTiming } from "../cw/encode.js";
import type { KeyElement } from "../cw/decoder.js";
import { receiveStation, type Reception, type Sideband } from "../ham/tuning.js";
import type { Tx } from "../ham/tx.js";
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
  /** Cut one station's carrier (the operator is breaking in on it). */
  silenceStation(call: string): void;
  setTransmitting(on: boolean): void;
  setMuted(on: boolean): void;
  dispose(): void;
}

export class SessionAudio {
  /** Calls currently on the band, so `syncStations` can spot the gaps. */
  private stationCalls = new Set<string>();

  constructor(
    private readonly view: () => AudioView,
    private readonly synth: LiveBand,
    /**
     * Pacing, injectable (tests). The realtime path has no buffer to await, so
     * an over "ends" when its last element would have been keyed; whoever drives
     * the exchange has to wait that long.
     */
    private readonly wait: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** True where there is an audio device to key on (Node / jsdom: false). */
  get live(): boolean {
    return this.synth.available;
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
    const synth = this.synth;
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
    this.synth.setTransmitting(on);
  }

  /** Tear down the audio graph with the session. */
  dispose(): void {
    this.synth.dispose();
  }

  /**
   * Wait out a transmission that is already keyed.
   *
   * Keying happens once, when the message is recorded (`notePlaying` /
   * `noteCq` in the session call `keyStation`), because that is the single act
   * that makes the waterfall and the speaker agree. This method therefore only
   * *paces* the caller: replies follow each other at keying speed, so whoever
   * drives the exchange has to wait as long as the over lasts. Re-keying here
   * would be harmless (`scheduleKeying` cancels and rewrites the same events),
   * but it would put a second owner on "is it on the air", which is how the two
   * drifted apart before.
   */
  async playTx(tx: Tx, _ham: VirtualHam | null | undefined, at: number): Promise<void> {
    await this.waitFor(tx.startedAt + tx.durationMs - at);
  }

  /**
   * Put a station's recorded message on the air, without waiting for it.
   *
   * This is what "hearing the band" means: a station inside the passband is
   * keyed onto its own carrier, whether or not the exchange goes on to answer
   * it. The caller decides what to do about it; the receiver has already done
   * its part.
   */
  keyStation(tx: Tx, ham: VirtualHam): void {
    this.wireSynth();
    this.synth.ensureStation({
      call: ham.call,
      freqHz: ham.freqHz,
      strength: ham.strength,
      difficulty: ham.difficulty,
    });
    // Key from the message's own start time, not from now: the carrier is live,
    // so a message that began before the operator tuned in is already part-way
    // through — and that is exactly what should be heard.
    this.synth.key(tx, ham.call, tx.startedAt);
  }

  /** The operator's own transmission: always its own pitch, never faded. */
  async playMine(tx: Tx, at: number): Promise<void> {
    // Keyed onto the monitor bus, which is not muted by half-duplex — a rig does
    // not go deaf to its own keying. Resolve when the over would end, so the
    // caller paces the exchange on keying time.
    this.wireSynth();
    this.synth.keyMine(tx, tx.startedAt);
    await this.waitFor(tx.startedAt + tx.durationMs - at);
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
    this.wireSynth();
    this.synth.ensureStation({
      call: ham.call,
      freqHz: ham.freqHz,
      strength: ham.strength,
      difficulty: ham.difficulty,
    });
    this.synth.keyFrom(tx, ham.call, at, at - tx.startedAt);
  }

  /** Mute the whole receiver (power off) without stopping the band. */
  setMuted(on: boolean): void {
    this.synth.setMuted(on);
  }

  /** Cut the operator's own keying, if it is still going.
   *
   * Nobody else's transmission is stopped by pressing PTT: the band carries on
   * and only the receiver goes deaf (see `setTransmitting`).
   */
  stop(): void {
    this.synth.silenceMine();
  }

  /**
   * Cut one station's carrier.
   *
   * Used when the operator breaks in on that station's reply: its message was
   * already keyed onto the air, so the phase has to be taken off the air too,
   * not just muted by half-duplex.
   */
  silenceStation(call: string): void {
    this.synth.silenceStation(call);
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
}
