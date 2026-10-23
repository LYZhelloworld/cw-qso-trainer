import { QsoMachine, type QsoState } from "../qso/stateMachine.js";
import { Frequency } from "../ham/frequency.js";
import { VirtualHam } from "../ham/virtualHam.js";
import { dxccDatabase } from "../data/dxcc.js";
import { BandSynth } from "../audio/bandSynth.js";
import type { LiveBand } from "../ui/sessionAudio.js";
import type { KeyElement } from "../cw/decoder.js";
import {
  answerCqDelayMs,
  nextCqGapMs,
  replyDelayMs,
  targetHamCount,
  type HamActivityEvent,
} from "../ham/activity.js";
import {
  buildBackgroundSignals,
  inSpectrumWindow,
  mulberry32,
  type SpectrumSignal,
  type SpectrumSnapshot,
} from "../ham/spectrum.js";
import { qsbDb, qsbDepthFor, smeterReading, type SMeterReading } from "../ham/smeter.js";
import { makeTx, txKeyed, txOnAir, type Tx } from "../ham/tx.js";
import {
  detuneHz,
  inPassband,
  normalisePassband,
  resolveSideband,
  type Sideband,
} from "../ham/tuning.js";
import type { AppSettings } from "./settingsSchema.js";
import { CALL_RE } from "../message/parse.js";
import { canWriteLog, deriveLogRecord, type LogRecord } from "./logRecord.js";
import { clearStaging } from "./storage/qsoStaging.js";
import { SessionAudio } from "./sessionAudio.js";
import { HamQsoDriver } from "./sessionHamQso.js";
import { PileupDriver } from "./sessionPileup.js";
import { loadRestorable, saveStagingFor } from "./sessionStaging.js";
import type { SessionContext, Speaker, TranscriptLine } from "./sessionTypes.js";

// Re-exported so pages and storage keep importing the transcript vocabulary
// from the module they already know.
export type { Speaker, TranscriptLine };

/**
 * Presentation-layer session: one band's virtual HAMs plus the operator's QSO
 * with one of them, including the CW audio.
 *
 * A session owns TWO things that deliberately have different lifetimes:
 *  - the **band** (its virtual HAMs and their CQ rhythm, via `Frequency`) — the
 *    environment. It keeps running whether or not the operator is listening.
 *  - the **station** (audio, the QSO in progress) — that is what the rig's
 *    power switch controls (`receiving`).
 *
 * The exchange is kept internally (staging, logging, the state machine) but is
 * never rendered: the conversation is on the air, not on the screen.
 * Powering down therefore never touches the band: the other stations do not go
 * off the air just because we did. See `setReceiving`.
 *
 * Everything that is *somebody else's* activity lives next door, behind the
 * narrow `SessionContext` interface this class implements:
 *  - `sessionPileup` — several stations answering our CQ;
 *  - `sessionHamQso` — two stations working each other;
 *  - `sessionAudio` — what the receiver does to a signal, and playing it;
 *  - `sessionStaging` — writing out / picking up an in-progress QSO.
 *
 * Real timers are wired here (the state machine itself stays deterministic).
 */

/** Fallback callsign used for weighted HAM generation before the user sets one. */
const FALLBACK_MY_CALL = "BG7XXX";

/**
 * First CQ of a freshly spawned HAM. Deliberately shorter than the steady
 * listening gap of VIRTUAL-HAM.md so that a band the user just tuned to does not
 * sit silent for long.
 */
const FIRST_CQ_MIN_MS = 5_000;
const FIRST_CQ_MAX_MS = 20_000;

/** How often the activity scheduler is driven. */
const TICK_MS = 1_000;

/**
 * How long the receiver stays deaf after the operator's key goes up. Real
 * half-duplex CW sends have a short tail: the operator's own changeover relay
 * and their ears both need a moment before the band comes back.
 */
const TX_TAIL_MS = 1_500;

/**
 * How long the operator waits for an answer to their own CQ once the band has
 * gone quiet. Mirrors the machine's `timeoutFirstCall`: a caller who draws no
 * reply gives up and goes back to listening, so that tuning across somebody
 * else's CQ is an answer to *it* rather than a message into the void.
 */
const CALL_ANSWER_WAIT_MS = 15_000;

/**
 * Does this line name a station? "R UR RST 599 BK" does not, "BT9BYA DE BG7XXX"
 * does. It separates the two things an operator can mean while a pile-up is
 * running: answering without picking a caller (keep the pile-up going), and
 * calling somebody else entirely (leave it).
 */
function namesACall(line: string): boolean {
  return line.split(/[^A-Z0-9/]+/).some((token) => CALL_RE.test(token));
}

/**
 * One HAM transmission placed on the air, as seen by the debug console.
 *
 * `path` is the single fact that explains "the waterfall / S-meter show it but I
 * hear nothing": `audible` means the speaker should have it; anything else means
 * the audio layer is (correctly or otherwise) suppressing it — `offband` (outside
 * the receiver's filter), `muted` (the rig is powered down / half-duplex deaf
 * while we transmit), or `transmitting` (our own key is down, so nobody is heard).
 */
export interface AiredMessage {
  /** The band this station lives on, e.g. "14.050". */
  band: string;
  /** The station's callsign. */
  call: string;
  /** The full text keyed out, e.g. "CQ CQ CQ DE BA1XYZ BA1XYZ PSE K". */
  text: string;
  /** When the over started, in ms (session wall clock). */
  at: number;
  /** How long the over takes to key, in ms. */
  durationMs: number;
  /** Whether the operator can actually hear it right now. */
  path: "audible" | "offband" | "muted" | "transmitting";
  /** Convenience mirror of `path === "audible"` for filtering. */
  inPassband: boolean;
}

export interface QsoSessionOptions {
  /** Injected RNG (tests): drives CQ intervals, answer delays and band size. */
  rng?: () => number;
  /** Injected clock (tests). Defaults to Date.now. */
  now?: () => number;
  /**
   * Injected tick driver (tests). Receives the callback and returns a stopper.
   * Defaults to a 1 s interval.
   */
  startTicking?: (cb: () => void) => () => void;
  /** Injected wait (tests), used for the HAM's answer/reply delays. */
  delay?: (ms: number) => Promise<void>;
  /**
   * Injected pacing for keying time (tests): the realtime path has no buffer to
   * await, so an over "ends" when its last element would have been keyed. Kept
   * separate from `delay` because one is the band's rhythm and the other is how
   * long a transmission takes — a test usually wants to control them differently.
   */
  pace?: (ms: number) => Promise<void>;
  /**
   * Injected realtime band synth (tests). Defaults to a `BandSynth` on the
   * shared `AudioContext`; under Node / jsdom that one finds no device and
   * stays silent, which is why the session still owns a `Tx` table either way.
   */
  synth?: LiveBand;
  /**
   * The band's reference frequency in Hz — where this band's stations live.
   * Defaults to the dial frequency the session was built with. The App passes
   * the band's nominal centre so the same band always holds the same stations.
   */
  referenceHz?: number;
}

export class QsoSession implements SessionContext {
  /**
   * Dial frequency for this band. Follows the operator's tuning (see `retune`)
   * because it is what the log records and what staging is keyed by.
   */
  freqMHz: number;
  /** The dial in Hz — the frequency the waterfall centres on. */
  get dialHz(): number {
    return Math.round(this.freqMHz * 1e6);
  }
  /**
   * The CW sideband this receiver is on: whatever this band was last left on,
   * or the band's convention (LSB below 10 MHz, USB above) if it has never been
   * touched. It is what decides which way the note moves as the dial is turned.
   *
   * Held per session — one session is one band — so the mode travels with the
   * band: turning the knob to 40 m gets 40 m's mode, not whatever the previous
   * band happened to be on. Same as a real rig's per-band mode memory.
   */
  get sideband(): Sideband {
    // No memory for this band yet ("auto") means: follow its convention.
    return resolveSideband(this.sidebandMode ?? "auto", this.dialHz);
  }

  /** Switch this band's mode (the rig's CW-L / CW-U label). */
  setSidebandMode(sideband: Sideband): void {
    this.sidebandMode = sideband;
    // Sideband is how the receiver interprets the dial: every note shifts, and
    // the passband flips to the other side. Nothing is retuned or re-keyed.
    this.audio.wireSynth();
  }
  /** Receiver CW filter width in Hz (500 / 250 / 100), from settings. */
  get passbandHz(): number {
    return normalisePassband(this.settings.passbandHz);
  }
  /** Half the filter width — how far off the dial a station is still audible. */
  get passbandHalfHz(): number {
    return this.passbandHz / 2;
  }

  machine: QsoMachine | null = null;
  ham: VirtualHam | null = null;
  lines: TranscriptLine[] = [];
  /**
   * Unsent text sitting in the send box. It lives here rather than in the DOM
   * because any settings change re-renders the page, which would otherwise
   * throw away whatever the user was halfway through keying in.
   */
  draft = "";
  /** Set once the finished QSO has been written to the log (prevents duplicates). */
  logWritten = false;

  /**
   * This band's mode, once the operator has chosen one. `null` means "never
   * touched": the band's convention applies (see `sideband`). Kept on the
   * session rather than in settings because it belongs to *this band* — that is
   * the whole point of per-band mode memory.
   */
  private sidebandMode: Sideband | null = null;

  /** The band: its roster and its listening pool. */
  readonly band: Frequency;
  /** Random source; see `QsoSessionOptions.rng`. */
  readonly rng: () => number;
  /**
   * Per-call "keying until" timestamps (ms) for the waterfall. A pile-up caller
   * is a transmitter only while its call is actually being played; derived from
   * the clock rather than stored as a boolean so it self-expires.
   */
  readonly keyingUntil = new Map<string, number>();
  /**
   * What each station is transmitting right now — the keying truth.
   *
   * One record per station holds the message, its envelope and when it started.
   * Everything that needs to know "is there sound coming out of the speaker"
   * asks this table and nothing else: the waterfall draws `txKeyed` (the real
   * dots and dashes), the S-meter reads `txOnAir` (the whole over, so the
   * needle holds instead of flickering), and a mid-message join reads the text
   * plus its offset. Three maps used to track this (`onAir` for CQ text,
   * `playingUntil` for a deadline, `airEnvelope` for the envelope) and could
   * disagree; one table cannot.
   */
  private readonly txs = new Map<string, Tx>();
  /**
   * Debug listeners (the F12 console). Every HAM transmission fires them with an
   * `AiredMessage` — the single place the debugger learns what a station is
   * keying and whether the operator can hear it. Kept separate from the activity
   * listener so enabling the console never perturbs the band.
   */
  private readonly airListeners: Array<(m: AiredMessage) => void> = [];

  private readonly clock: () => number;
  private readonly startTicking: (cb: () => void) => () => void;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly pace: (ms: number) => Promise<void>;
  private readonly audio: SessionAudio;
  private readonly pileup: PileupDriver;
  private readonly hamQso: HamQsoDriver;
  /**
   * How many HAMs this band keeps active (12–18 by default, fixed for the
   * session). An explicit `seedHams(n)` overrides it.
   */
  private targetHams: number;
  private settings: AppSettings;
  private stopTicking: (() => void) | null = null;
  private activityListener: ((events: HamActivityEvent[]) => void) | null = null;

  /** True while a transmission is in flight; guards against interleaved sends. */
  private sending = false;
  /**
   * True from the moment the operator's carrier goes on the air until the
   * receiver opens again: a station cannot transmit and listen at once
   * (half-duplex). While it is set, nothing is received, the spectrum shows
   * only the operator's own signal, and the S-meter follows the key.
   */
  private transmitting = false;
  /** Keying envelope of the current transmission, for the S-meter. */
  private txTiming: KeyElement[] | null = null;
  private txStartedAt = 0;
  /**
   * When the operator's own CQ stopped drawing any answer (the pile-up emptied,
   * or there never was one). `null` means the operator is not sitting on a call
   * that nobody answered. See `expireOwnCq`.
   */
  private ownCqSilentSince: number | null = null;
  /**
   * Whether the operator's receiver is open. Off = the rig is powered down.
   * Defaults to on so a session used on its own (tests, embedding) behaves like
   * a station that is already listening; the App drives it from the power
   * switch. Crucially this only gates *hearing and transmitting* — the band's
   * HAMs keep calling CQ either way (see `handleActivity`).
   */
  private receiving = true;
  /**
   * Decorative background carriers on this band (see `spectrum`). Built lazily
   * once per session from its own RNG, so they never disturb the sequence that
   * drives HAM generation and CQ timing.
   */
  private background: SpectrumSignal[] | null = null;
  /** Where this band's stations live, in Hz. */
  private readonly referenceHz: number;

  constructor(freqMHz: number, settings: AppSettings, opts: QsoSessionOptions = {}) {
    this.freqMHz = freqMHz;
    this.settings = settings;
    this.referenceHz = opts.referenceHz ?? Math.round(freqMHz * 1e6);
    this.rng = opts.rng ?? Math.random;
    this.clock = opts.now ?? (() => Date.now());
    this.wait = opts.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.pace = opts.pace ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.startTicking =
      opts.startTicking ??
      ((cb) => {
        const id = setInterval(cb, TICK_MS);
        return () => clearInterval(id);
      });
    this.targetHams = targetHamCount(this.rng);
    this.band = new Frequency(freqMHz, dxccDatabase, {
      rng: this.rng,
      now: this.clock,
      referenceHz: this.referenceHz,
    });
    this.audio = new SessionAudio(
      () => this.audioView(),
      // Same clock the keying is scheduled on: a `Tx` is recorded on the
      // session's wall clock and turned into audio-clock automation here.
      opts.synth ?? new BandSynth({ now: this.clock }),
      this.pace,
    );
    this.audio.wireSynth();
    this.pileup = new PileupDriver(this);
    this.hamQso = new HamQsoDriver(this);
  }

  // --- lifecycle -----------------------------------------------------------

  /**
   * Start driving the HAMs' CQ rhythm. Kept separate from the constructor so
   * that tests can build a session without any real timer running.
   */
  start(): void {
    if (this.stopTicking) return;
    this.stopTicking = this.startTicking(() => this.tick());
  }

  /** Stop the scheduler. Call before dropping a session (e.g. on band change). */
  dispose(): void {
    if (this.stopTicking) {
      this.stopTicking();
      this.stopTicking = null;
    }
    this.pileup.clear();
    this.audio.dispose(); // tear the band down with the session
    this.activityListener = null;
  }

  /**
   * Register a listener notified when a HAM calls CQ on its own.
   * Pages use it to refresh without a full re-render; pass null to unregister.
   */
  setActivityListener(fn: ((events: HamActivityEvent[]) => void) | null): void {
    this.activityListener = fn;
  }

  /**
   * Register a debug listener fired whenever a HAM transmission is placed on the
   * air (see `AiredMessage`). The F12 console uses this to print what the station
   * currently being listened to is sending. Pass null to detach.
   */
  onAir(fn: ((m: AiredMessage) => void) | null): void {
    if (fn === null) {
      this.airListeners.length = 0;
      return;
    }
    this.airListeners.push(fn);
  }

  updateSettings(settings: AppSettings): void {
    this.settings = settings;
    // Pitch, filter width and difficulty all change what the receiver does, so
    // the whole band is re-tuned and re-levelled rather than waiting for the
    // next over.
    this.audio.wireSynth();
  }

  /**
   * Open / close the operator's receiver — the rig's power switch.
   *
   * Off means the station neither hears nor transmits: incoming CQ calls are not
   * picked up, nothing is played, and `userSend` / `userCallsCq` are refused.
   * It does NOT clear anything. The band, its HAM roster and any QSO already in
   * progress are left exactly as they were, and the HAMs keep calling CQ in the
   * background — the environment does not go off the air when we do.
   */
  setReceiving(on: boolean): void {
    if (on === this.receiving) return;
    this.receiving = on;
    if (!on) {
      // Powering down is deafness, not a stop: the band keeps transmitting and
      // the keying keeps running, so switching back on lands mid-message.
      this.audio.setMuted(true);
      return;
    }
    this.audio.setMuted(false);
    this.audio.wireSynth();
    // Powering up onto a station that is mid-CQ should put us in the middle of
    // it, exactly like switching a real receiver on.
    this.rejoinOnAir();
  }

  /**
   * Retune inside the same band. The air is unchanged (a 1 kHz move does not
   * conjure a new set of stations); only the dial frequency used for logging and
   * staging follows the operator.
   */
  retune(freqMHz: number): void {
    if (freqMHz === this.freqMHz) return;
    this.freqMHz = freqMHz;
    if (this.machine) this.persistStaging();
    // Tuning is also listening: every station's note and level follow the dial
    // at once, so whatever is inside the passband at the new spot is heard
    // straight away, from wherever it has got to.
    this.audio.wireSynth();
    this.rejoinOnAir();
  }

  /**
   * Populate the frequency with activity so the band is not empty. With no
   * argument the band keeps 12–18 HAMs (VIRTUAL-HAM.md), decided once per session;
   * an explicit count also becomes the level the band refills to.
   */
  seedHams(count?: number): VirtualHam[] {
    if (count !== undefined) this.targetHams = count;
    while (this.band.hamCount < this.targetHams) this.spawnHam();
    const hams = this.listHams();
    // Every station gets a transmitter the moment it exists on this band.
    this.audio.syncStations(hams);
    return hams;
  }

  listHams(): VirtualHam[] {
    return this.band.listHams();
  }

  /** Roster with each HAM's state, for the frequency page. */
  hamActivity() {
    return this.band.activityState();
  }

  // --- operator state ------------------------------------------------------

  get state(): QsoState {
    // Mid-pile-up there is no machine yet, but the operator has certainly
    // called CQ — report that, or the panel would say "idle" while three
    // stations are answering.
    if (this.pileup.active && this.machine === null) return "USER_CQ";
    return this.machine?.state ?? "IDLE";
  }

  get inQso(): boolean {
    if (this.pileup.active) return true;
    return this.machine !== null && this.machine.state !== "IDLE";
  }

  /** True while a transmission (user or HAM) is being sent — UI disables send. */
  get isSending(): boolean {
    return this.sending;
  }

  /**
   * True while the operator's own carrier is (or was until a moment ago) on the
   * air. Nothing can be received then: half-duplex means transmit **or** listen.
   */
  get isTransmitting(): boolean {
    return this.transmitting;
  }

  get isReceiving(): boolean {
    return this.receiving && !this.transmitting;
  }

  get playbackAvailable(): boolean {
    return this.audio.live;
  }

  // --- tuning --------------------------------------------------------------

  /**
   * The tone the operator currently hears from the station being worked: the
   * rig's CW pitch shifted by however far that station sits from the dial (see
   * `ham/tuning`). Null when there is no partner, when it has no frequency (a
   * HAM generated without a band reference), or when it has been tuned far
   * enough outside the passband that the filter's skirt has run out — an
   * off-frequency station fades, and then it is silence.
   */
  partnerToneHz(): number | null {
    if (!this.ham || this.ham.freqHz <= 0) return null;
    return this.audio.reception(this.ham)?.toneHz ?? null;
  }

  /**
   * How loud the partner is coming through right now: `1` inside the passband,
   * fading toward `0` on the filter's skirt (see `passbandGain`), `null` when
   * it is gone. The UI uses this to say "audible but weak" rather than either
   * "fine" or "silent".
   */
  partnerGain(): number | null {
    if (!this.ham || this.ham.freqHz <= 0) return null;
    return this.audio.reception(this.ham)?.gain ?? null;
  }

  /** How far the partner sits from the dial, in Hz (positive = above). */
  partnerDetuneHz(): number | null {
    if (!this.ham || this.ham.freqHz <= 0) return null;
    return detuneHz(this.ham.freqHz, this.dialHz);
  }

  /** True while the partner is inside the passband (i.e. actually audible). */
  partnerInPassband(): boolean {
    if (!this.ham || this.ham.freqHz <= 0) return true;
    return inPassband(this.ham.freqHz, this.dialHz, this.passbandHz);
  }

  /**
   * The station the operator can hear *and* work right now: inside the
   * passband, not already in a QSO. Null when the passband holds nobody —
   * which is the normal state on a band the operator has not tuned across yet.
   */
  heardActiveHam(): VirtualHam | null {
    const nearest = this.nearestWorkableHam();
    return nearest && inPassband(nearest.freqHz, this.dialHz, this.passbandHz) ? nearest : null;
  }

  /**
   * The band's closest workable station to the dial, however far away — what a
   * "search" would sweep past first. Also the basis for `heardActiveHam`.
   */
  nearestWorkableHam(): VirtualHam | null {
    const candidates = this.band
      .activityState()
      .filter((e) => e.state !== "inQso")
      .map((e) => e.ham)
      .sort(
        (a, b) =>
          Math.abs(detuneHz(a.freqHz, this.dialHz)) - Math.abs(detuneHz(b.freqHz, this.dialHz)),
      );
    return candidates[0] ?? null;
  }

  /** True when a station is inside the receiver's passband right now. */
  private canHear(ham: VirtualHam): boolean {
    return ham.freqHz <= 0 || inPassband(ham.freqHz, this.dialHz, this.passbandHz);
  }

  // --- spectrum & S-meter --------------------------------------------------

  /**
   * One line's worth of data for the waterfall: the dial (the window centre)
   * and every signal on the band — the workable HAMs plus the decorative
   * background carriers. Frequencies are absolute, so tuning past a station
   * makes it drift across the display instead of moving with the dial.
   */
  spectrum(): SpectrumSnapshot {
    // Half-duplex: while the operator's carrier is on, the only signal on the
    // display is his own, at full strength. Everything being received is gone —
    // a transmitter is not listening, so there is nothing else to show.
    if (this.transmitting) {
      return {
        centerHz: this.dialHz,
        signals: [
          {
            freqHz: this.dialHz,
            strength: 1,
            call: this.myCall(),
            workable: false,
            active: true,
          },
        ],
      };
    }
    const now = this.clock();
    const signals: SpectrumSignal[] = [];
    // The roster holds the band's callers. Answerers hold no slot, so they are
    // not on it — but while one of them is transmitting there *is* a carrier,
    // and that is exactly what the operator hears. Add the ones currently on the
    // air: the pile-up answering us, and a partner that came out of the pool.
    const onAir: VirtualHam[] = this.pileup.list();
    if (this.ham?.role === "answerer") onAir.push(this.ham);

    const drawn = new Set<string>();
    for (const ham of [...this.band.listHams(), ...onAir]) {
      if (drawn.has(ham.call) || ham.freqHz <= 0) continue;
      drawn.add(ham.call);
      // A signal is on the waterfall only while its tone is on the air: the
      // real dots and dashes if we recorded the message, one steady burst for a
      // driver that only reports "keying until" (pile-ups, the background
      // pair). Between transmissions there is nothing to see.
      const active = this.onAirAt(ham, now) && this.toneKeyed(ham, now);
      signals.push({
        freqHz: ham.freqHz,
        strength: ham.strength,
        call: ham.call,
        workable: true,
        active,
      });
    }
    for (const bg of this.backgroundSignals()) signals.push(bg);
    return { centerHz: this.dialHz, signals };
  }

  /**
   * What the S-meter reads: the strongest signal the receiver is hearing *right
   * now*. Two things make that agree with the operator's ears:
   *
   *  - **Half-duplex.** While our own carrier is on, the meter reads our keying
   *    instead of the band: full scale on a dot or dash, nothing in the gap
   *    between them. Nothing is being received, so nothing else can register.
   *  - **Silence is silence.** A received station only registers while one of
   *    its transmissions is actually on the air (between CQ bursts it is
   *    listening, not transmitting), so the needle drops when the sound stops.
   *
   * The filter and QSB apply as before: a station off the passband reads lower,
   * and every signal breathes slowly on its own.
   *
   * `null` when there is nothing to hear: no sound, no reading.
   */
  sMeter(): SMeterReading | null {
    const at = this.clock();
    if (this.transmitting) return this.txKeyedAt(at) ? smeterReading(1) : null;

    let best: SMeterReading | null = null;
    for (const ham of this.audibleStations()) {
      // No sound, no reading. The needle only moves while this station's over
      // is actually being played — whichever driver put it there.
      if (!this.onAirAt(ham, at)) continue;
      if (!inSpectrumWindow(ham.freqHz, this.dialHz)) continue;
      const rx = this.audio.reception(ham);
      if (rx === null) continue;
      // The needle moves on every band, more violently on a hard one — see
      // `qsbDepthFor` for why this is not the audio's QSB depth.
      const reading = smeterReading(ham.strength, {
        gain: rx.gain,
        qsbDb: qsbDb(ham.call, at, qsbDepthFor(ham.difficulty)),
      });
      if (reading !== null && (best === null || reading.dbm > best.dbm)) best = reading;
    }
    return best;
  }

  /**
   * Every station the receiver could be hearing: the band's callers, plus the
   * answerers that only exist while they transmit (a pile-up, or the partner we
   * drew out of the listening pool).
   */
  private audibleStations(): VirtualHam[] {
    const all = [...this.band.listHams(), ...this.pileup.list()];
    if (this.ham?.role === "answerer") all.push(this.ham);
    const seen = new Set<string>();
    return all.filter((h) => (seen.has(h.call) ? false : (seen.add(h.call), true)));
  }

  /** Is the operator's own key down at `at`? */
  private txKeyedAt(at: number): boolean {
    if (!this.txTiming) return false;
    let t = at - this.txStartedAt;
    if (t < 0) return false;
    for (const e of this.txTiming) {
      if (t < e.on) return true;
      t -= e.on;
      if (t < e.off) return false;
      t -= e.off;
    }
    return false;
  }

  /**
   * Put a message on the air: record it in the keying table **and** key it onto
   * the station's carrier.
   *
   * These two are one act on purpose. Everything the operator can see — the
   * waterfall's dots, the S-meter's needle — is derived from the keying table,
   * while the sound comes from the transmitter. Recording without keying is
   * exactly how a station ends up drawn on screen and silent in the speaker, so
   * the two are not allowed to be separate decisions: whoever records a
   * transmission has already keyed it.
   *
   * Whether it is *heard* is a different question with a different owner — the
   * receiver's filter, mute and half-duplex state decide that, in the audio
   * layer alone.
   */
  private airStation(ham: VirtualHam, text: string): Tx {
    const tx = makeTx(text, this.audio.keyElements(text), this.clock());
    this.txs.set(ham.call, tx);
    this.audio.keyStation(tx, ham);
    // Debug hook: what this station is keying, and whether the operator can
    // actually hear it. `path` is the fact the F12 console prints to explain a
    // signal that shows on the waterfall / S-meter but reaches no speaker.
    const path: AiredMessage["path"] = this.transmitting
      ? "transmitting"
      : !this.receiving
        ? "muted"
        : !this.canHear(ham)
          ? "offband"
          : "audible";
    const msg: AiredMessage = {
      band: this.bandLabel(),
      call: ham.call,
      text,
      at: tx.startedAt,
      durationMs: tx.durationMs,
      path,
      inPassband: this.canHear(ham),
    };
    for (const fn of this.airListeners) fn(msg);
    return tx;
  }

  /** Human-readable band label for the debug console, e.g. "14.050". */
  private bandLabel(): string {
    return this.freqMHz.toFixed(3);
  }

  /**
   * Record what this station is keying and when it started: the message's real
   * envelope goes into the keying table, and everything else (waterfall, meter,
   * playback) reads it from there. Returns the record so the caller can hand
   * the very same thing to the audio.
   */
  private notePlaying(ham: VirtualHam | null | undefined, text: string): Tx | null {
    if (!ham) return null;
    return this.airStation(ham, text);
  }

  /**
   * Is this station's over on the air at `at` — i.e. is there sound coming out
   * of the speaker that belongs to it?
   *
   * Two drivers can put a station on the air, and every consumer must agree on
   * the answer: a station whose message we recorded (the envelope's window in
   * the keying table), and one whose driver only reports "keying until" (a
   * pile-up caller, the background pair). Asking one question in one place is
   * what keeps the waterfall and the S-meter from telling the operator two
   * different stories — audible in one, silent in the other.
   */
  private onAirAt(ham: VirtualHam, at: number): boolean {
    const tx = this.txs.get(ham.call);
    if (tx && txOnAir(tx, at)) return true;
    const keying = Math.max(
      this.keyingUntil.get(ham.call) ?? 0,
      this.hamQso.keyingUntilFor(ham.call),
    );
    return keying > at;
  }

  /**
   * Is the *tone* on at `at` — the dots and dashes, not just the over?
   *
   * Only the waterfall asks this. A panadapter can be honest to the
   * millisecond; a meter has ballistics and holds through the gap between two
   * dits instead of flickering at the keying rate. A station with no recorded
   * envelope (a driver that only reports "keying until") is drawn as one steady
   * burst for as long as it claims to be keying.
   */
  private toneKeyed(ham: VirtualHam, at: number): boolean {
    const tx = this.txs.get(ham.call);
    if (tx && txOnAir(tx, at)) return txKeyed(tx, at);
    return true;
  }

  /** The band's decorative carriers (see `spectrum`); built once per session. */
  private backgroundSignals(): SpectrumSignal[] {
    if (!this.background) {
      // Seeded from the band reference, so a band always looks the same and the
      // session's own RNG sequence (HAM generation, CQ timing) is untouched.
      const seed = Math.abs(Math.round(this.referenceHz)) % 2147483647;
      this.background = buildBackgroundSignals(this.referenceHz, mulberry32(seed));
    }
    return this.background;
  }

  // --- pile-up (delegated) -------------------------------------------------

  /** The stations answering the operator's CQ, in the order they arrived. */
  pileupCallers(): VirtualHam[] {
    return this.pileup.list();
  }

  /**
   * Pile-up callers that have already transmitted at least once — the ones the
   * operator can actually have copied. A station that has not called yet is not
   * a name you could have written down, so the UI does not offer it.
   */
  heardPileupCallers(): VirtualHam[] {
    return this.pileup.heard();
  }

  // --- transcript ----------------------------------------------------------

  /**
   * The transcript is internal only: it keeps the exchange for staging, logging
   * and the state machine's own bookkeeping. Nothing renders it — the
   * conversation is on the air, not on the screen.
   */

  /** Update the unsent draft and persist it so a refresh keeps what was typed. */
  setDraft(value: string): void {
    this.draft = value;
    this.persistStaging();
  }

  /** Append a line to the (internal) transcript. */
  push(who: Speaker, text: string): void {
    this.lines.push({ who, text });
    this.persistStaging();
  }

  /** Append a system note to the transcript (not part of the QSO exchange). */
  note(text: string): void {
    this.push("sys", text);
  }

  // --- operator actions ----------------------------------------------------

  /**
   * Put the operator's own message on the air.
   *
   * Half-duplex: from the first dit the receiver is deaf, and it stays deaf for
   * a moment after the key goes up (`TX_TAIL_MS`). Everything that was being
   * received is cut, and the waterfall shows this signal instead (see
   * `spectrum`). The S-meter follows the key while it lasts.
   */
  private async transmit(text: string): Promise<void> {
    this.audio.stop(); // our key comes down on top of whatever was playing
    this.push("me", text);
    this.transmitting = true;
    this.txStartedAt = this.clock();
    // One record drives everything: the monitor tone, the S-meter (`txTiming`)
    // and the waterfall. There is no second copy of the keying to drift.
    const tx = makeTx(text, this.audio.keyElements(text), this.txStartedAt);
    this.txTiming = tx.elements;
    this.audio.setTransmitting(true);
    try {
      await this.audio.playMine(tx, this.txStartedAt);
    } finally {
      await this.wait(TX_TAIL_MS);
      this.transmitting = false;
      this.audio.setTransmitting(false);
      this.txTiming = null;
    }
  }

  /**
   * A virtual HAM calls CQ on this frequency. Fire-and-forget: the audio plays
   * in the background and is *not* guarded by `sending`, so the operator can
   * break in and answer mid-CQ. A user transmission in progress still suppresses
   * a new CQ (no point starting one nobody can hear over the user's own keying).
   *
   * Returns false when nothing was heard: the rig is off, we are mid-exchange,
   * or there is simply no station inside the passband.
   */
  async hamCallsCq(ham?: VirtualHam): Promise<boolean> {
    // Half-duplex: nobody is heard while our own key is down.
    if (this.transmitting) return false;
    // A powered-down rig hears nothing, so a CQ is never picked up.
    if (!this.receiving) return false;
    // You cannot work what you cannot hear, so the passband has the first say.
    // An empty passband means the operator has not found anybody yet — the
    // station has to be *found*, and conjuring one out of the dial would take
    // the searching away.
    const target = ham ?? this.heardActiveHam();
    if (!target || !this.canHear(target)) return false;
    // The same HAM calling again must not restart the exchange: repeating
    // hamCq() on a machine already in PEER_CQ is idempotent, so reuse it and
    // just log and play the repeated call.
    const machine =
      this.machine !== null &&
      this.ham?.call === target.call &&
      this.machine.state === "PEER_CQ"
        ? this.machine
        : this.startMachine(target);
    const text = machine.hamCq();
    this.push("ham", text);
    // Non-blocking: do not await the full CQ, otherwise the user could not
    // answer until it finished. The audio is cut by the next user transmission.
    const tx = this.notePlaying(target, text);
    if (tx) void this.audio.playTx(tx, target, this.now());
    return true;
  }

  /**
   * The operator calls CQ. Several stations answer (2–3, see `ham/pileup`),
   * each with its own randomised silence, until one of them is named.
   *
   * Only the CQ itself blocks: the answers are scheduled, not awaited, so the
   * operator can break in and name a station while the pile-up is still
   * building. That is the whole skill being practised.
   */
  async userCallsCq(): Promise<void> {
    const call = this.myCall();
    await this.userSend(`CQ CQ CQ DE ${call} ${call} PSE K`);
  }

  /**
   * The operator transmits one line — at any time, to nobody in particular.
   *
   * This is the whole operating model. What goes on the air is a message; the
   * stations on the band decide for themselves whether it was meant for them:
   *
   *  - a **CQ** invites whoever is listening to answer, and a handful do;
   *  - a line sent **while a station's CQ is still ringing** is an answer to it;
   *  - a line sent **mid-exchange** continues that exchange;
   *  - anything else goes out and nothing comes back — which is what a real
   *    operator experiences, and gets no explanation for.
   *
   * There is no "start a QSO" step: keying is the start.
   */
  async userSend(text: string): Promise<void> {
    const line = text.trim().toUpperCase();
    if (!line) return;
    // Busy guard: a second send while the first is still going out (or the HAM
    // is mid-reply) is dropped rather than interleaved with it.
    if (this.sending) return;
    if (!this.receiving) return; // cannot transmit with the rig off

    this.sending = true;
    try {
      // A CQ is not addressed to anybody — it invites the band to answer, and
      // it is a fresh call whatever was going on before.
      if (/\bCQ\b/.test(line)) {
        if (this.machine) this.endExchange();
        await this.transmit(line);
        this.beginPileup();
        return;
      }

      // A pile-up: the line's job is to name one of the stations answering.
      // But naming somebody who is *not* in the pile-up means the operator has
      // moved on — it is an answer to whatever else is on the frequency, not a
      // failed attempt at picking a caller. Dropping that into the pile-up's
      // "nobody was named" path is how a perfectly good reply disappeared into
      // a call the operator had already left behind.
      let namedElsewhere = false;
      if (this.pileup.active) {
        if (this.pileup.match(line) || !namesACall(line)) {
          await this.transmit(line);
          await this.answerPileup(line);
          return;
        }
        this.pileup.clear();
        namedElsewhere = true;
      }

      // Everything else is addressed to whoever is inside the passband now.
      const machine = this.machineForAudible();
      await this.transmit(line);
      // Nobody out there: the message went out and nothing came back.
      if (!machine) {
        if (namedElsewhere) this.note("没有点名应答的台，也没有别的台在呼叫");
        return;
      }

      // Difficulty-driven "receiver did not copy" (novice 0%, hardcore 5%).
      if (this.ham && this.rng() < this.ham.missProbability) {
        const agn = machine.hamMissed();
        if (agn) {
          await this.wait(replyDelayMs(this.rng));
          this.push("ham", agn);
          const tx = this.notePlaying(this.ham, agn);
          if (tx) await this.audio.playTx(tx, this.ham, this.now());
          return;
        }
      }

      const replies = machine.userSend(line);
      for (const reply of replies) {
        // VIRTUAL-HAM.md: the HAM replies 1–3 s after the user's transmission.
        await this.wait(replyDelayMs(this.rng));
        this.push("ham", reply);
        const tx = this.notePlaying(this.ham, reply);
        if (tx) await this.audio.playTx(tx, this.ham, this.now());
      }

      // QSO complete: the HAM goes back to its own CQ rhythm.
      if (machine.state === "LOGGED" && this.ham) this.endStation(this.ham);
    } finally {
      this.sending = false;
      // The receiver opens again: whatever is on the air now starts playing.
      this.rejoinOnAir();
    }
  }

  /** Draw the stations that will answer this CQ and start their schedule. */
  private beginPileup(): void {
    this.pileup.clear(); // release anyone still calling from an earlier CQ
    this.logWritten = false;
    this.pileup.begin(this.hamQso.isAudible());
    // VIRTUAL-HAM.md: a HAM answers the user's CQ after 1–5 s; the others
    // follow once the previous call has finished plus a short random gap.
    this.pileup.schedule(this.clock() + answerCqDelayMs(this.rng));
  }

  /**
   * The station this line is going to, if any.
   *
   * An exchange already under way keeps it — tuning to the edge of the filter
   * makes the partner hard to hear, not gone, and the station you are working
   * stays yours until one of you signs off (or you call CQ and start over).
   * Otherwise the target is whichever station is calling inside the passband:
   * the one the operator is listening to. Null when nobody is calling there, in
   * which case the line goes out and nobody answers.
   */
  private machineForAudible(): QsoMachine | null {
    // A machine sitting in `USER_CQ` is waiting for an answer to *our* call; it
    // is not a partner. Keying a reply to somebody else's CQ means abandoning
    // our own, and reusing that machine would hand the message to its
    // `USER_CQ` branch, which returns nothing — the operator would hear their
    // own transmission and then silence, with no explanation.
    if (this.machine?.state === "USER_CQ") this.endExchange();
    if (this.machine) {
      // Speaking up starts the QSO as far as the band is concerned: the station
      // stops its own CQ rhythm while we are working it.
      if (this.ham && this.machine.state === "PEER_CQ") {
        this.band.markInQso(this.ham.call);
      }
      return this.machine;
    }
    const target = this.band
      .activityState()
      .find((e) => e.state === "cqing" && this.canHear(e.ham))?.ham;
    if (!target) return null;
    const machine = this.startMachine(target);
    machine.hamCq(); // the exchange begins with the CQ we just heard
    this.band.markInQso(target.call);
    return machine;
  }

  /**
   * The operator replied to a pile-up. The only thing that matters is whether a
   * station was named: a bare "R BK" addresses nobody, so every station stays
   * silent and tries again later (see `PileupDriver.drive`). This is
   * deliberately unforgiving — naming the station is the skill it teaches.
   */
  private async answerPileup(line: string): Promise<void> {
    const chosen = this.pileup.match(line);
    if (!chosen) {
      this.pileup.reschedule();
      this.push("sys", "没有点名任何一台，各台继续等待");
      return;
    }

    // The named station is the partner; the rest go back to listening. An
    // answerer was never on the band, so nothing is removed from it.
    this.pileup.take(chosen);
    const machine = this.startMachine(chosen.ham);
    // The CQ went out before the machine existed (a pile-up has no partner
    // yet), so put it in the state it would have been in.
    machine.beginUserCq();
    await this.wait(replyDelayMs(this.rng));
    const reply = machine.hamAcceptedSelection();
    this.push("ham", reply);
    const tx = this.notePlaying(this.ham ?? chosen.ham, reply);
    if (tx) await this.audio.playTx(tx, this.ham ?? chosen.ham, this.now());
  }

  // --- log & lifecycle of a QSO --------------------------------------------

  /** The log row to persist once a QSO completes, or null if the gate is unmet. */
  pendingLog(): LogRecord | null {
    if (this.logWritten) return null;
    const machine = this.machine;
    if (!machine) return null;
    const ctx = machine.getContext();
    if (
      !canWriteLog({
        state: machine.state,
        callsignsConfirmed: ctx.callsignsConfirmed,
        rstRx: ctx.rstRx,
        rstTx: ctx.rstTx,
        peerEndHeard: ctx.peerEndHeard,
        userEndSent: ctx.userEndSent,
      })
    ) {
      return null;
    }
    const qso = machine.getLog();
    if (!qso) return null;
    return deriveLogRecord(qso, this.freqMHz);
  }

  /** Mark the current QSO as logged so `pendingLog()` stops returning it. */
  markLogged(): void {
    this.logWritten = true;
  }

  /**
   * End the exchange without touching what the operator has typed. The partner
   * goes back to calling CQ, a pile-up is released, and the band carries on.
   */
  private endExchange(): void {
    this.pileup.clear();
    if (this.ham) this.endStation(this.ham);
    this.machine?.reset();
    this.machine = null;
    this.ham = null;
    this.logWritten = false;
    clearStaging();
  }

  /** Abandon the current QSO and clear the transcript. */
  reset(): void {
    this.audio.stop(); // cut any in-flight audio along with the QSO
    this.transmitting = false;
    this.txTiming = null;
    this.endExchange();
    this.lines = [];
    this.draft = "";
  }

  /**
   * Restore an in-progress QSO from the last staging snapshot, if any and if it
   * still matches this frequency. Called once on app start so an accidental
   * refresh resumes rather than discarding the conversation.
   */
  restoreStaging(): void {
    const restored = loadRestorable(this.freqMHz, this.myCall());
    if (!restored) return;
    this.ham = restored.ham;
    this.machine = restored.machine;
    this.lines = restored.lines;
    this.draft = restored.draft;
    this.logWritten = restored.logWritten;
  }

  private persistStaging(): void {
    saveStagingFor({
      freqMHz: this.freqMHz,
      lines: this.lines,
      draft: this.draft,
      logWritten: this.logWritten,
      machine: this.machine,
      ham: this.ham,
    });
  }

  // --- scheduler -----------------------------------------------------------

  /** One step of the scheduler (driven by the injected timer). */
  private tick(): void {
    const events = this.band.advance();
    // The roster changes here too (stations come and go), so the band's
    // transmitters are brought in line before anything is keyed onto them.
    this.audio.syncStations(this.band.listHams());
    if (events.length > 0) this.handleActivity(events);
    this.pileup.drive();
    this.hamQso.drive();
    this.expireOwnCq();
  }

  /**
   * The operator's own CQ gets a limited amount of patience.
   *
   * Without this the machine sits in `USER_CQ` forever: nobody answered, the
   * pile-up emptied, and every later call the operator made — including a
   * perfectly good answer to somebody else's CQ — was swallowed by a machine
   * still waiting for a reply to a question asked minutes ago. The band is not
   * paused while that happens, so the state has to expire the way it does in
   * `QsoMachine.timeoutFirstCall`.
   *
   * The clock only starts once the band has actually gone quiet: a pile-up that
   * is still calling means somebody *is* answering, however long they take.
   */
  private expireOwnCq(): void {
    if (this.machine?.state !== "USER_CQ" || this.pileup.active) {
      this.ownCqSilentSince = null;
      return;
    }
    const now = this.clock();
    if (this.ownCqSilentSince === null) {
      this.ownCqSilentSince = now;
      return;
    }
    if (now - this.ownCqSilentSince < CALL_ANSWER_WAIT_MS) return;
    this.ownCqSilentSince = null;
    this.endExchange();
    this.note("没有人回应你的呼叫，已回到守听");
  }

  private handleActivity(events: HamActivityEvent[]): void {
    for (const e of events) {
      // Two ways to put this burst on the air, and both of them key it:
      // `hamCallsCq` records it with the machine's own wording and opens the
      // exchange, `noteCq` records it as a plain CQ. The choice below is only
      // about whether the *exchange* is open to this station — never about
      // whether the station transmits. Recording without keying is exactly how
      // a signal ends up drawn on the waterfall and silent in the speaker.
      //
      // Powered down, half-duplex, outside the passband, or busy with another
      // contact: the CQ is still keyed onto its carrier. The audio layer
      // decides what reaches the speaker (filter, mute, half-duplex) and the
      // band keeps its own rhythm either way.
      if (
        !this.receiving ||
        this.transmitting ||
        !this.canHear(e.ham) ||
        this.deafToNewCalls(e.ham)
      ) {
        this.noteCq(e.ham);
        continue;
      }
      void this.hamCallsCq(e.ham);
    }

    this.activityListener?.(events);
  }

  /**
   * Should a CQ that is inside the passband be *answered* (i.e. allowed to open
   * or repeat an exchange)? It is still heard either way.
   *
   *  - mid-exchange: the QSO in progress keeps the operator's attention;
   *  - mid-pile-up: the operator is picking one of the stations already calling;
   *  - already copying one station's CQ: another station's call does not hijack
   *    the selection, but only that station's own repeats re-open it.
   */
  private deafToNewCalls(ham: VirtualHam): boolean {
    if (this.exchangeInProgress) return true;
    if (this.pileup.active) return true;
    return this.machine?.state === "PEER_CQ" && this.ham?.call !== ham.call;
  }

  /**
   * Put one burst on the air, and re-time the station's next one: the next CQ
   * starts after this message has finished keying plus a listening gap. Only
   * the session knows how long a message takes, so the band's scheduler cannot
   * work this out on its own.
   *
   * Keyed unconditionally — the band does not go quiet because of what this
   * receiver happens to be doing. Whether it reaches the speaker is the audio
   * layer's call (filter, mute, half-duplex), and whether it opens an exchange
   * is `deafToNewCalls`'s.
   */
  private noteCq(ham: VirtualHam): Tx {
    const text = `CQ CQ CQ DE ${ham.call} ${ham.call} PSE K`;
    const tx = this.airStation(ham, text);
    this.band.scheduleNextCq(ham.call, tx.durationMs + nextCqGapMs(this.rng));
    return tx;
  }

  /**
   * Join whatever is being transmitted inside the passband, from wherever that
   * message has already got to. This is the reason tuning feels live: turn the
   * dial onto a station and you are hearing it within a fraction of a second,
   * not waiting for its next CQ.
   *
   * It also cuts the station we were hearing: tuning away really does mean
   * silence, and moving inside the passband re-renders at the new offset so the
   * note shifts with the dial the way a real receiver's does.
   */
  private rejoinOnAir(): void {
    if (!this.receiving || this.sending || this.transmitting) return;
    if (this.exchangeInProgress || this.pileup.active) return;
    const now = this.clock();
    let target: { ham: VirtualHam; tx: Tx } | null = null;
    for (const entry of this.band.activityState()) {
      if (entry.state === "inQso") continue;
      if (!this.canHear(entry.ham)) continue;
      const tx = this.txs.get(entry.ham.call);
      if (!tx || !txOnAir(tx, now)) continue;
      target = { ham: entry.ham, tx };
      break;
    }
    if (this.audio.live) {
      // Nothing is stopped or restarted: the band has been transmitting all
      // along. All that is needed is to key the rest of the message that is on
      // the air right now, so the receiver lands in the middle of it.
      if (target) this.audio.joinTx(target.tx, target.ham, now);
      return;
    }
    this.audio.stop();
    if (target) void this.audio.playTx(target.tx, target.ham, now);
  }

  /** True once the user is actually exchanging with a HAM (not just listening). */
  private get exchangeInProgress(): boolean {
    const s = this.machine?.state;
    return s === "USER_CQ" || s === "EXCHANGE" || s === "SIGNOFF";
  }

  /**
   * Spawn a station on this band. `atHz` pins it to an exact frequency (the
   * operator's dial, for a station about to answer the operator's CQ).
   */
  private spawnHam(atHz?: number): VirtualHam {
    return this.band.spawnHam(
      this.myCall(),
      this.settings.difficulty,
      undefined,
      this.firstCqDelay(),
      atHz,
    );
  }

  /**
   * First CQ of a freshly spawned HAM: sooner than the steady 30–60 s rhythm so
   * a new band (or one whose HAMs all gave up) is not silent for a minute.
   */
  private firstCqDelay(): number {
    return FIRST_CQ_MIN_MS + Math.floor(this.rng() * (FIRST_CQ_MAX_MS - FIRST_CQ_MIN_MS + 1));
  }

  private startMachine(ham: VirtualHam): QsoMachine {
    this.ham = ham;
    this.machine = new QsoMachine({
      myCall: this.myCall(),
      ham,
      db: dxccDatabase,
      frequency: this.freqMHz,
    });
    return this.machine;
  }

  /**
   * The station has finished transmitting. A caller goes back to its own CQ
   * rhythm on the band; an answerer goes back to the listening pool, because it
   * never held a slot in the first place.
   */
  private endStation(ham: VirtualHam): void {
    if (ham.role === "answerer") this.band.releaseAnswerer(ham);
    else this.band.markListening(ham.call);
  }

  // --- SessionContext ------------------------------------------------------

  /** The operator is busy with their own QSO or their own key. */
  get isOperatorBusy(): boolean {
    return this.inQso || this.sending;
  }

  myCall(): string {
    return this.settings.myCall || FALLBACK_MY_CALL;
  }

  /** The clock, in ms — the drivers advance on this, never on their own timer. */
  now(): number {
    return this.clock();
  }

  /** How long a message takes to key at the operator's current speed, in ms. */
  callDurationMs(text: string): number {
    return this.audio.callDurationMs(text);
  }

  /** Put a station's transmission on the air (the driver side of `audio`). */
  playHam(text: string, ham?: VirtualHam): Promise<void> {
    const tx = this.notePlaying(ham, text);
    // A line with no station behind it (the operator's own, or a driver without
    // one) has nothing to key on the band, so it goes out on the monitor only.
    return tx ? this.audio.playTx(tx, ham, this.now()) : this.audio.playMine(
      makeTx(text, this.audio.keyElements(text), this.now()),
      this.now(),
    );
  }

  /** The snapshot `SessionAudio` reads on every call (see `sessionAudio`). */
  private audioView() {
    return {
      settings: this.settings,
      dialHz: this.dialHz,
      sideband: this.sideband,
      passbandHz: this.passbandHz,
      partner: this.ham,
    };
  }
}
