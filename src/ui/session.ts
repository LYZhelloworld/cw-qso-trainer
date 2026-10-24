import { QsoMachine, type QsoState } from "../qso/stateMachine.js";
import { Frequency } from "../ham/frequency.js";
import { VirtualHam } from "../ham/virtualHam.js";
import { dxccDatabase } from "../data/dxcc.js";
import { BandSynth } from "../audio/bandSynth.js";
import type { LiveBand } from "../ui/sessionAudio.js";
import {
  answerCqDelayMs,
  nextCqGapMs,
  replyDelayMs,
  targetHamCount,
  type HamActivityEvent,
} from "../ham/activity.js";
import { makeTx, type Tx } from "../ham/tx.js";
import type { SMeterReading } from "../ham/smeter.js";
import type { SpectrumSnapshot } from "../ham/spectrum.js";
import { normalisePassband, resolveSideband, type Sideband } from "../ham/tuning.js";
import type { AppSettings } from "./settingsSchema.js";
import { CALL_RE } from "../message/parse.js";
import { canWriteLog, deriveLogRecord, type LogRecord } from "./logRecord.js";
import { clearStaging } from "./storage/qsoStaging.js";
import { SessionAudio } from "./sessionAudio.js";
import { HamQsoDriver } from "./sessionHamQso.js";
import { BandMonitor, type AiredMessage } from "./sessionMonitor.js";
import { OperatorTx } from "./sessionKeying.js";
import { Patience } from "./sessionPatience.js";
import { PileupDriver } from "./sessionPileup.js";
import { loadRestorable, saveStagingFor } from "./sessionStaging.js";
import { Tuning } from "./sessionTuning.js";
import type { SessionContext, Speaker, TranscriptLine } from "./sessionTypes.js";

// Re-exported so pages and storage keep importing the transcript vocabulary
// from the module they already know.
export type { Speaker, TranscriptLine };
// Same for the debug console, which listens for `AiredMessage`.
export type { AiredMessage };

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
 * Everything that can be described without the rest of the session lives next
 * door, behind a narrow interface this class implements:
 *  - `sessionTuning` — where a station sits relative to the dial (pure geometry);
 *  - `sessionAudio` — what the receiver does to a signal, and playing it;
 *  - `sessionMonitor` — the keying table, the waterfall, the S-meter;
 *  - `sessionKeying` — our transmitter: half-duplex, break-in, the live key;
 *  - `sessionPileup` — several stations answering our CQ;
 *  - `sessionHamQso` — two stations working each other;
 *  - `sessionPatience` — the two clocks that run while the operator is silent;
 *  - `sessionStaging` — writing out / picking up an in-progress QSO.
 *
 * What stays here is the part that is genuinely *the session*: which band, who
 * is on it, what a line sent to the air means, and whether the QSO is worth
 * logging. `tick()` is the best place to start reading — it is the whole
 * per-second story of the band in five lines.
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
 * Does this line name a station? "R UR RST 599 BK" does not, "BT9BYA DE BG7XXX"
 * does. It separates the two things an operator can mean while a pile-up is
 * running: answering without picking a caller (keep the pile-up going), and
 * calling somebody else entirely (leave it).
 */
function namesACall(line: string): boolean {
  return line.split(/[^A-Z0-9/]+/).some((token) => CALL_RE.test(token));
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

  private readonly clock: () => number;
  private readonly startTicking: (cb: () => void) => () => void;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly pace: (ms: number) => Promise<void>;
  private readonly audio: SessionAudio;
  /** Where stations sit relative to the dial — see `sessionTuning`. */
  private readonly tuning: Tuning;
  /** What the waterfall and the S-meter are shown — see `sessionMonitor`. */
  private readonly monitor: BandMonitor;
  /** Our transmitter: half-duplex, break-in, the live key — see `sessionKeying`. */
  private readonly keying: OperatorTx;
  /** The two clocks that run while the operator is silent — see `sessionPatience`. */
  private readonly patience: Patience;
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

  /**
   * Whether the operator's receiver is open. Off = the rig is powered down.
   * Defaults to on so a session used on its own (tests, embedding) behaves like
   * a station that is already listening; the App drives it from the power
   * switch. Crucially this only gates *hearing and transmitting* — the band's
   * HAMs keep calling CQ either way (see `handleActivity`).
   */
  private receiving = true;
  /** Where this band's stations live, in Hz — also the seed for its scenery. */
  readonly referenceHz: number;

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
    this.tuning = new Tuning(
      () => ({ dialHz: this.dialHz, passbandHz: this.passbandHz }),
      (ham) => this.audio.reception(ham),
    );
    this.monitor = new BandMonitor(this, this.audio);
    this.pileup = new PileupDriver(this);
    this.hamQso = new HamQsoDriver(this);
    this.keying = new OperatorTx(this, this.audio, this.monitor, this.wait);
    this.patience = new Patience(this);
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
    // Nothing an in-flight over is waiting on may touch this session again.
    this.keying.invalidate();
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
    this.monitor.onAir(fn);
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
    // A QSO that was left waiting while the rig was off gets its patience back:
    // the partner has been calling into a dead receiver, and that must not count
    // against the operator the moment they switch on.
    if (this.exchangeInProgress) this.patience.armPartner();
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
    return this.keying.isSending;
  }

  /**
   * True while the operator's own carrier is (or was until a moment ago) on the
   * air. Nothing can be received then: half-duplex means transmit **or** listen.
   */
  get isTransmitting(): boolean {
    return this.keying.isTransmitting;
  }

  get isReceiving(): boolean {
    return this.receiving && !this.keying.isTransmitting;
  }

  /**
   * The rig is switched on. Distinct from `isReceiving` on purpose: transmitting
   * makes the receiver deaf, but the rig is still on — the S-meter keeps working
   * and reads our own keying.
   */
  get rigOn(): boolean {
    return this.receiving;
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
    return this.ham ? this.tuning.toneOf(this.ham) : null;
  }

  /**
   * How loud the partner is coming through right now: `1` inside the passband,
   * fading toward `0` on the filter's skirt (see `passbandGain`), `null` when
   * it is gone. The UI uses this to say "audible but weak" rather than either
   * "fine" or "silent".
   */
  partnerGain(): number | null {
    return this.ham ? this.tuning.gainOf(this.ham) : null;
  }

  /** How far the partner sits from the dial, in Hz (positive = above). */
  partnerDetuneHz(): number | null {
    return this.ham ? this.tuning.detuneOf(this.ham) : null;
  }

  /**
   * True while the partner is inside the passband. Also true when there is no
   * partner: a station that is not there cannot be tuned off frequency, and the
   * panel should not report a filter problem nobody can fix.
   */
  partnerInPassband(): boolean {
    return !this.ham || this.ham.freqHz <= 0 || this.tuning.inPassbandFor(this.ham);
  }

  /**
   * The station the operator can hear *and* work right now: inside the
   * passband, not already in a QSO. Null when the passband holds nobody —
   * which is the normal state on a band the operator has not tuned across yet.
   */
  heardActiveHam(): VirtualHam | null {
    return this.tuning.heardActive(this.usableCandidates());
  }

  /**
   * The band's closest workable station to the dial, however far away — what a
   * "search" would sweep past first. Also the basis for `heardActiveHam`.
   */
  nearestWorkableHam(): VirtualHam | null {
    return this.tuning.nearestUsable(this.usableCandidates());
  }

  /** Every station on the band that is not already working somebody else. */
  private usableCandidates(): VirtualHam[] {
    return this.band
      .activityState()
      .filter((e) => e.state !== "inQso")
      .map((e) => e.ham);
  }

  /** True when a station is inside the receiver's passband right now. */
  canHear(ham: VirtualHam): boolean {
    return this.tuning.canHear(ham);
  }

  // --- spectrum & S-meter --------------------------------------------------
  //
  // The whole display pipeline — the keying table, the waterfall lines, the
  // meter's ballistics — lives in `sessionMonitor`. These are the pages' way in.

  /** One line of the waterfall: the dial and every signal the receiver sees. */
  spectrum(): SpectrumSnapshot {
    return this.monitor.spectrum();
  }

  /** What the S-meter reads right now, or null when there is nothing to hear. */
  sMeter(): SMeterReading | null {
    return this.monitor.sMeter();
  }

  /** Human-readable band label for the debug console, e.g. "14.050". */
  bandLabel(): string {
    return this.freqMHz.toFixed(3);
  }

  /**
   * Record what this station is keying and when it started: the message's real
   * envelope goes into the keying table, and everything else (waterfall, meter,
   * playback) reads it from there. Returns the record so the caller can hand
   * the very same thing to the audio.
   */
  private notePlaying(ham: VirtualHam | null | undefined, text: string): Tx | null {
    return this.monitor.notePlaying(ham, text);
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
   * Open the operator's carrier for live keying; false when the rig cannot
   * transmit right now (off, or already sending).
   */
  beginLiveKeying(): boolean {
    return this.keying.beginLive();
  }

  /** The operator's key went down. */
  liveKeyDown(): void {
    this.keying.keyDown();
  }

  /** The operator's key came up. */
  liveKeyUp(): void {
    this.keying.keyUp();
  }

  /**
   * Abandon an over that is still open because the panel that owned it is gone
   * (the operator left the page mid-key).
   *
   * The half-keyed text is not sent — the operator never finished it — but the
   * carrier has to come down and the receiver has to open, or the rig stays
   * stuck in TX for a panel that no longer exists.
   */
  cancelLiveKeying(): void {
    this.keying.cancel();
  }

  /**
   * End one over keyed live and let the band react to it.
   *
   * The text is what the keyer decoded from the operator's own keying; the audio
   * has already gone out, so this only records the line and runs the same
   * decision the text mode runs after an over. There is no carrier tail to wait
   * out: the key panel has already waited the silence that ends an over, and
   * that silence *is* the turn-around.
   */
  async finishLiveKeying(text: string): Promise<void> {
    if (this.keying.keyHeld) this.keying.keyUp();
    const line = text.trim().toUpperCase();
    if (!this.keying.isSending) return;
    const epoch = this.keying.currentEpoch;

    try {
      if (line) this.push("me", line);
      // No tail: the silence that ended the over is the turn-around.
      this.keying.closeLive();

      if (!line) return;
      if (/\bCQ\b/.test(line)) {
        if (this.machine) this.endExchange();
        this.beginPileup();
        return;
      }
      await this.dispatchSent(line, epoch);
    } finally {
      // Reset under us (band switch): the lock belongs to the new world now.
      this.keying.endOver(epoch);
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
    if (this.keying.isTransmitting) return false;
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
    // Re-time the station's next CQ from the *end* of this one. Without this the
    // activity scheduler keeps firing on its fallback gap (3–8 s measured from
    // the start), so a long call is cut off mid-message and restarted on top of
    // itself — heard as garbled, stuttering audio.
    if (tx) this.band.scheduleNextCq(target.call, tx.durationMs + nextCqGapMs(this.rng));
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
    // is mid-reply) is dropped rather than interleaved with it. Null also means
    // the rig is switched off, which cannot transmit either.
    const epoch = this.keying.beginOver();
    if (epoch === null) return;

    try {
      // A CQ is not addressed to anybody — it invites the band to answer, and
      // it is a fresh call whatever was going on before.
      if (/\bCQ\b/.test(line)) {
        if (this.machine) this.endExchange();
        await this.keying.transmit(line, epoch);
        if (epoch !== this.keying.currentEpoch) return;
        this.beginPileup();
        return;
      }
      await this.keying.transmit(line, epoch);
      if (epoch !== this.keying.currentEpoch) return;
      await this.dispatchSent(line, epoch);
    } finally {
      // A band switch reset this session while the over was in flight: the lock
      // belongs to that older world, and `endOver` refuses it.
      this.keying.endOver(epoch);
    }
  }

  // --- what the band does about it -----------------------------------------
  //
  // Past this point the line is already on the air. These methods decide *who
  // it was for* and let that station answer — the part of the session that is
  // neither keying nor bookkeeping.

  /**
   * What the band does about a line that has already gone out.
   *
   * Split out of `userSend` because the two key modes key the message live and
   * only get here once the over has ended. The line is on the air either way,
   * and the band's reaction must not depend on how it was keyed.
   *
   * `epoch` is the session generation this over belongs to. Resetting the
   * session (a band switch, say) bumps it; anything that wakes up after a wait
   * and finds a different one has been overtaken and must not play a reply into
   * a band the operator has already left.
   */
  private async dispatchSent(line: string, epoch: number): Promise<void> {
    // A pile-up: the line's job is to name one of the stations answering.
    // But naming somebody who is *not* in the pile-up means the operator has
    // moved on — it is an answer to whatever else is on the frequency, not a
    // failed attempt at picking a caller. Dropping that into the pile-up's
    // "nobody was named" path is how a perfectly good reply disappeared into
    // a call the operator had already left behind.
    let namedElsewhere = false;
    if (this.pileup.active) {
      if (this.pileup.match(line) || !namesACall(line)) {
        await this.answerPileup(line, epoch);
        return;
      }
      this.pileup.clear();
      namedElsewhere = true;
    }

    // Everything else is addressed to whoever is inside the passband now.
    const machine = this.machineForAudible(line);
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
        if (epoch !== this.keying.currentEpoch) return;
        this.push("ham", agn);
        const tx = this.notePlaying(this.ham, agn);
        if (tx) await this.audio.playTx(tx, this.ham, this.now());
        if (epoch !== this.keying.currentEpoch) return;
        // The partner has asked for a repeat and is waiting for one.
        this.patience.armPartner();
        return;
      }
    }

    const replies = machine.userSend(line);
    for (const reply of replies) {
      // VIRTUAL-HAM.md: the HAM replies 1–3 s after the user's transmission.
      await this.wait(replyDelayMs(this.rng));
      if (epoch !== this.keying.currentEpoch) return;
      this.push("ham", reply);
      const tx = this.notePlaying(this.ham, reply);
      if (tx) await this.audio.playTx(tx, this.ham, this.now());
      if (epoch !== this.keying.currentEpoch) return;
    }

    // The station has said its piece and is listening for the operator's next
    // over. If none comes it repeats itself instead of going silent.
    this.patience.armPartner();

    // QSO complete: the HAM goes back to its own CQ rhythm.
    if (machine.state === "LOGGED" && this.ham) this.endStation(this.ham);
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
   * Otherwise the target is whichever station is being *addressed*: if the line
   * names a callsign, that station (when it is calling CQ inside the passband)
   * is the one we answer — even if some *other* station's CQ had auto-opened
   * `this.machine`. When the line names nobody (a bare "R BK"), the machine we
   * already have (an overheard CQ) is kept. Null when nobody is calling there, in
   * which case the line goes out and nobody answers.
   *
   * This is what makes "hear a CQ, send `<call> DE <me> K`" produce a reply
   * instead of being swallowed by a machine opened for some other station.
   */
  private machineForAudible(line: string): QsoMachine | null {
    // A machine sitting in `USER_CQ` is waiting for an answer to *our* call; it
    // is not a partner. Replying to somebody else's CQ abandons it.
    if (this.machine?.state === "USER_CQ") this.endExchange();
    // A genuine exchange in progress (we have answered and are trading reports)
    // keeps the partner we are working — background CQs must not hijack it.
    if (this.machine && this.machine.state !== "PEER_CQ") return this.machine;

    // The line names a station: if that station is calling CQ inside the
    // passband, it is the one we are answering. This re-targets away from a
    // `this.machine` that background CQs had opened for a *different* station.
    const named = this.namedCallsigns(line);
    if (named.length > 0) {
      const target = this.band
        .activityState()
        .find(
          (e) =>
            e.state === "cqing" && this.canHear(e.ham) && named.includes(e.ham.call),
        )?.ham;
      if (target && this.ham?.call !== target.call) {
        const machine = this.startMachine(target);
        machine.hamCq(); // the exchange begins with the CQ we just heard
        this.band.markInQso(target.call);
        return machine;
      }
    }

    // Keep the machine we already hold (the overheard-CQ / same-station case), or
    // fall back to any station calling inside the passband.
    if (this.machine) {
      if (this.ham && this.machine.state === "PEER_CQ") this.band.markInQso(this.ham.call);
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

  /** Callsigns named in a line (excluding our own) — used to pick the addressee. */
  private namedCallsigns(line: string): string[] {
    const mine = this.myCall();
    const out: string[] = [];
    for (const tok of line.split(/\s+/)) {
      if (CALL_RE.test(tok) && tok !== mine && !out.includes(tok)) out.push(tok);
    }
    return out;
  }

  /**
   * The operator replied to a pile-up. The only thing that matters is whether a
   * station was named: a bare "R BK" addresses nobody, so every station stays
   * silent and tries again later (see `PileupDriver.drive`). This is
   * deliberately unforgiving — naming the station is the skill it teaches.
   */
  private async answerPileup(line: string, epoch: number): Promise<void> {
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
    if (epoch !== this.keying.currentEpoch) return;
    const reply = machine.hamAcceptedSelection();
    this.push("ham", reply);
    const tx = this.notePlaying(this.ham ?? chosen.ham, reply);
    if (tx) await this.audio.playTx(tx, this.ham ?? chosen.ham, this.now());
    if (epoch !== this.keying.currentEpoch) return;
    // The named station has sent its report and is waiting for ours.
    this.patience.armPartner();
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
  endExchange(): void {
    this.patience.clearPartner();
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
    // Anything an over had queued (a reply, a repeat, a tail) belongs to the
    // world this reset is ending: bumping the epoch makes those wake-ups hang up
    // instead of keying onto the band that replaces it. Half-duplex ends here
    // too — without it the receiver stays muted if the band was switched in the
    // middle of an over, and the live-key path never runs its
    // `finishLiveKeying` when its panel has already been torn down.
    this.keying.reset();
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
    this.patience.drive();
  }

  private handleActivity(events: HamActivityEvent[]): void {
    for (const e of events) {
      // Two ways to put this burst on the air: `hamCallsCq` records it with the
      // machine's own wording and opens the exchange, `noteCq` records it as a
      // plain CQ. The branch below only decides whether the *exchange* is open
      // to this station.
      //
      // While the operator's carrier is up, the band stands by: the station is
      // re-timed after a listening gap instead of keying a CQ that would be cut
      // a moment later.
      //
      // Otherwise — powered down, outside the passband, or busy with another
      // contact — the CQ is still keyed onto its carrier; the audio layer
      // decides what reaches the speaker (filter, mute) and the band keeps its
      // own rhythm either way.
      if (this.keying.isTransmitting) {
        this.band.scheduleNextCq(e.ham.call, nextCqGapMs(this.rng));
        continue;
      }
      if (
        !this.receiving ||
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
   * Keyed whenever this is called: the band does not go quiet because the rig is
   * off or busy with another contact. Whether it reaches the speaker is the
   * audio layer's call (filter, mute), and whether it opens an exchange is
   * `deafToNewCalls`'s. While the operator's own carrier is up, `handleActivity`
   * stands the station by instead of calling this.
   */
  private noteCq(ham: VirtualHam): Tx {
    const text = `CQ CQ CQ DE ${ham.call} ${ham.call} PSE K`;
    const tx = this.monitor.record(ham, text);
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
    if (!this.receiving || this.keying.isSending || this.keying.isTransmitting) return;
    if (this.exchangeInProgress || this.pileup.active) return;
    const now = this.clock();
    let target: { ham: VirtualHam; tx: Tx } | null = null;
    for (const entry of this.band.activityState()) {
      if (entry.state === "inQso") continue;
      if (!this.canHear(entry.ham)) continue;
      const tx = this.monitor.onAirTx(entry.ham, now);
      if (!tx) continue;
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
  get exchangeInProgress(): boolean {
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
   * never had a frequency of its own in the first place.
   */
  private endStation(ham: VirtualHam): void {
    if (ham.role === "answerer") this.band.releaseAnswerer(ham);
    else this.band.markListening(ham.call);
  }

  // --- SessionContext ------------------------------------------------------

  /** The operator is busy with their own QSO or their own key. */
  get isOperatorBusy(): boolean {
    return this.inQso || this.keying.isSending;
  }

  myCall(): string {
    return this.settings.myCall || FALLBACK_MY_CALL;
  }

  /** The station being worked, if any — the drivers' view of `ham`. */
  partner(): VirtualHam | null {
    return this.ham;
  }

  /**
   * When the background pair's current over ends, by deadline. Those two never
   * enter the keying table (they are not on the roster), so this is the only
   * thing that can tell the waterfall and the meter they are transmitting.
   */
  pairKeyingUntil(call: string): number {
    return this.hamQso.keyingUntilFor(call);
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

  /** Record the operator's own line — called by the transmitter, not by pages. */
  sayMine(text: string): void {
    this.push("me", text);
  }

  /** The operator is answering: the partner starts waiting from scratch. */
  resetPartnerWait(): void {
    this.patience.clearPartner();
  }

  /** Our carrier is down: whatever is on the air now starts playing. */
  reopenReceiver(): void {
    this.rejoinOnAir();
  }

  /** Is a pile-up still calling? Then somebody *is* answering our CQ. */
  pileupIsCalling(): boolean {
    return this.pileup.active;
  }

  /**
   * Say one line as the partner — used by `Patience` when the station repeats
   * itself. Returns how long the over lasts, so the next wait can be timed from
   * its end.
   */
  sayPartner(text: string): number | null {
    const partner = this.ham;
    if (!partner) return null;
    this.push("ham", text);
    const tx = this.notePlaying(partner, text);
    if (!tx) return null;
    void this.audio.playTx(tx, partner, this.now());
    return tx.durationMs;
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
