import { difficultyToEnvironment } from "../audio/environment.js";
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
  async playMine(text: string): Promise<void> {
    await this.play(text, {});
  }

  /** Cut any in-flight playback (the operator breaks in on a HAM's CQ). */
  stop(): void {
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
