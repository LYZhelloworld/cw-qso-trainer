import { difficultyToEnvironment } from "../audio/environment.js";
import type { AudioPlayer, EngineRenderOptions } from "../audio/engine.js";
import { textToTiming } from "../cw/encode.js";
import { receiveStation, type Reception, type Sideband } from "../ham/tuning.js";
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

export class SessionAudio {
  constructor(
    private readonly engine: AudioPlayer,
    private readonly view: () => AudioView,
  ) {}

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
   * Join a station that is already transmitting: play the rest of the message
   * from `offsetSec`. Used when the operator tunes onto a CQ that has already
   * started — the receiver should hear the tail of it, not wait for the next one.
   */
  async playHamFrom(text: string, ham: VirtualHam | undefined, offsetSec: number): Promise<void> {
    await this.playStation(text, ham, Math.max(0, offsetSec));
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
  async playMine(text: string): Promise<void> {
    await this.play(text, {});
  }

  /** Cut any in-flight playback (the operator breaks in on a HAM's CQ). */
  stop(): void {
    this.engine.stop();
  }

  /** How long a message takes to key at the operator's current speed, in ms. */
  callDurationMs(text: string): number {
    const { settings } = this.view();
    const elements = textToTiming(text, {
      wpm: settings.wpm,
      ...(settings.farnsworthEnabled ? { farnsworthWpm: settings.farnsworthWpm } : {}),
    });
    return elements.reduce((total, e) => total + e.on + e.off, 0);
  }

  private async play(text: string, extra: EngineRenderOptions): Promise<void> {
    const { settings } = this.view();
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
