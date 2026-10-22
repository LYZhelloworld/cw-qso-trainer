import { QsoMachine, type QsoState } from "../qso/stateMachine.js";
import { Frequency } from "../ham/frequency.js";
import { VirtualHam } from "../ham/virtualHam.js";
import { dxccDatabase } from "../data/dxcc.js";
import { CwAudioEngine, type AudioPlayer } from "../audio/engine.js";
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
import {
  detuneHz,
  inPassband,
  normalisePassband,
  resolveSideband,
  type Sideband,
} from "../ham/tuning.js";
import type { AppSettings } from "./settingsSchema.js";
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
 * 30–60 s rhythm of VIRTUAL-HAM.md so that a band the user just tuned to, or
 * one whose HAMs all gave up, does not sit silent for a minute.
 */
const FIRST_CQ_MIN_MS = 5_000;
const FIRST_CQ_MAX_MS = 20_000;

/** How often the activity scheduler is driven. */
const TICK_MS = 1_000;

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
  /** Injected audio player (tests); defaults to a real `CwAudioEngine`. */
  engine?: AudioPlayer;
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
   * The CW sideband this receiver is on: the band's convention unless the
   * operator pinned one from the mode label (see `ham/tuning`). It is what
   * decides which way the note moves as the dial is turned.
   */
  get sideband(): Sideband {
    return resolveSideband(this.settings.cwSideband, this.dialHz);
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
   * What each calling station is transmitting right now, and when it started.
   * This is what makes "tune in and you hear it" work: when the operator turns
   * the dial onto a station that is mid-CQ, the message is played from where it
   * has already got to instead of waiting for the next one.
   */
  private readonly onAir = new Map<
    string,
    { text: string; startedAt: number; durationMs: number }
  >();

  private readonly clock: () => number;
  private readonly startTicking: (cb: () => void) => () => void;
  private readonly wait: (ms: number) => Promise<void>;
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
    this.audio = new SessionAudio(opts.engine ?? new CwAudioEngine(), () => this.audioView());
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
    this.audio.stop(); // cut any in-flight HAM audio when leaving the band
    this.activityListener = null;
  }

  /**
   * Register a listener notified when a HAM calls CQ on its own.
   * Pages use it to refresh without a full re-render; pass null to unregister.
   */
  setActivityListener(fn: ((events: HamActivityEvent[]) => void) | null): void {
    this.activityListener = fn;
  }

  updateSettings(settings: AppSettings): void {
    this.settings = settings;
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
      this.audio.stop(); // powering down cuts whatever was being heard
      return;
    }
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
    // Tuning is also listening: whatever is on the air at the new spot starts
    // playing straight away, from wherever it has got to.
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
    return this.listHams();
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

  get isReceiving(): boolean {
    return this.receiving;
  }

  get playbackAvailable(): boolean {
    return this.audio.available;
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
    const states = new Map(this.band.activityState().map((e) => [e.ham.call, e.state]));
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
      // A background exchange is co-channel: both stations share one frequency,
      // so they share one column, and it lights while either of them is keying
      // (`keyingUntilFor` reports the pair's latest).
      const keying = Math.max(
        this.keyingUntil.get(ham.call) ?? 0,
        this.hamQso.keyingUntilFor(ham.call),
      );
      signals.push({
        freqHz: ham.freqHz,
        strength: ham.strength,
        call: ham.call,
        workable: true,
        // Only a station that is *calling* is keying. One already in a QSO with
        // us is mostly listening, so it renders as a steady carrier instead.
        // A pile-up caller or a background exchange keys only while its own
        // overs are actually being played.
        active: states.get(ham.call) === "cqing" || keying > now,
      });
    }
    for (const bg of this.backgroundSignals()) signals.push(bg);
    return { centerHz: this.dialHz, signals };
  }

  /**
   * What the S-meter reads: the strongest signal the receiver is passing right
   * now. Only stations on the slice the panadapter is showing can register, and
   * only as far as the filter lets them through — one out on the skirt reads
   * lower, one beyond it reads nothing at all. Each station carries its own
   * slow QSB (see `ham/smeter`), so the needle keeps moving between CQ events
   * rather than only when the band does something.
   *
   * `null` when nothing is coming through: there is no signal to point at.
   */
  sMeter(): SMeterReading | null {
    const at = this.clock();
    let best: SMeterReading | null = null;
    for (const ham of this.band.listHams()) {
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
   * A virtual HAM calls CQ on this frequency. Fire-and-forget: the audio plays
   * in the background and is *not* guarded by `sending`, so the operator can
   * break in and answer mid-CQ. A user transmission in progress still suppresses
   * a new CQ (no point starting one nobody can hear over the user's own keying).
   *
   * Returns false when nothing was heard: the rig is off, we are mid-exchange,
   * or there is simply no station inside the passband. The caller (a page) uses
   * that to tell the operator to tune around instead of waiting.
   */
  async hamCallsCq(ham?: VirtualHam): Promise<boolean> {
    if (this.sending) return false;
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
    void this.audio.playHam(text, target);
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
    if (this.sending) return;
    if (!this.receiving) return; // cannot transmit with the rig off
    this.sending = true;
    try {
      this.audio.stop(); // cut any ambient HAM CQ before the user's own call
      // A fresh attempt starts a clean transcript; an earlier unanswered CQ
      // left lines behind and no partner to explain them.
      if (this.machine === null) {
        this.pileup.clear();
        this.lines = [];
        this.logWritten = false;
        this.draft = "";
      }
      this.pileup.begin(this.hamQso.isAudible());
      const call = this.myCall();
      const cq = `CQ CQ CQ DE ${call} ${call} PSE K`;
      this.push("me", cq);
      await this.audio.playMine(cq);
      // VIRTUAL-HAM.md: a HAM answers the user's CQ after 1–5 s; the others
      // follow once the previous call has finished plus a short random gap.
      this.pileup.schedule(this.clock() + answerCqDelayMs(this.rng));
    } finally {
      this.sending = false;
    }
  }

  /** The user transmits one line; HAM replies are appended and played. */
  async userSend(text: string): Promise<void> {
    const line = text.trim().toUpperCase();
    if (!line) return;
    // Busy guard: a second send while the first is still being transmitted (or
    // the HAM is mid-reply) is dropped rather than interleaved with it.
    if (this.sending) return;
    if (!this.receiving) return; // cannot transmit with the rig off
    // Answering a pile-up: there is no partner yet, so this line's only real
    // job is to name one. See `answerPileup`.
    if (this.pileup.active) return this.answerPileup(line);

    const machine = this.machine;
    // Nothing of ours to send on: the key does nothing. If a pair of stations is
    // working each other here we still say nothing — hearing them is the only
    // cue a real operator gets, and they simply do not answer us.
    if (!machine) return;
    this.sending = true;
    try {
      this.audio.stop(); // break in: cut any HAM still calling CQ

      // Answering a HAM's CQ: the user has spoken up, so that HAM drops its own
      // CQ rhythm — no more repeats, and the 3-minute give-up timer stops.
      if (machine.state === "PEER_CQ" && this.ham) this.band.markInQso(this.ham.call);

      this.push("me", line);
      await this.audio.playMine(line);

      // Difficulty-driven "receiver did not copy" (novice 0%, hardcore 5%).
      if (this.ham && this.rng() < this.ham.missProbability) {
        const agn = machine.hamMissed();
        if (agn) {
          await this.wait(replyDelayMs(this.rng));
          this.push("ham", agn);
          await this.audio.playHam(agn);
          return;
        }
      }

      const replies = machine.userSend(line);
      if (replies.length === 0) this.push("sys", "（无应答）");
      for (const reply of replies) {
        // VIRTUAL-HAM.md: the HAM replies 1–3 s after the user's transmission.
        await this.wait(replyDelayMs(this.rng));
        this.push("ham", reply);
        await this.audio.playHam(reply);
      }

      // QSO complete: the HAM goes back to listening and will call CQ again.
      if (machine.state === "LOGGED" && this.ham) this.endStation(this.ham);
    } finally {
      this.sending = false;
    }
  }

  /**
   * The operator replied to a pile-up. The only thing that matters is whether a
   * station was named: a bare "R BK" addresses nobody, so every station stays
   * silent and tries again later (see `PileupDriver.drive`). This is
   * deliberately unforgiving — naming the station is the skill it teaches.
   */
  private async answerPileup(line: string): Promise<void> {
    this.sending = true;
    try {
      this.audio.stop(); // the operator's key is on top of the pile-up
      this.push("me", line);
      await this.audio.playMine(line);

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
      await this.audio.playHam(reply);
    } finally {
      this.sending = false;
    }
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

  /** Abandon the current QSO and clear the transcript. */
  reset(): void {
    // Free the HAM we were working so it resumes its own CQ rhythm. A pile-up
    // that never got as far as naming anyone has no `ham`, only callers.
    this.pileup.clear();
    if (this.ham) this.endStation(this.ham);
    this.audio.stop(); // cut any in-flight audio along with the QSO
    this.machine?.reset();
    this.machine = null;
    this.ham = null;
    this.lines = [];
    this.draft = "";
    this.logWritten = false;
    clearStaging();
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
    if (events.length > 0) this.handleActivity(events);
    this.pileup.drive();
    this.hamQso.drive();
  }

  private handleActivity(events: HamActivityEvent[]): void {
    for (const e of events) {
      // The burst goes on the air whether or not we are listening: that record
      // is what lets the operator tune in halfway through it.
      this.noteCq(e.ham);
      // Powered down: the CQ goes out on the air, we just do not hear it. The
      // band must still be advanced (which it is — that happened in frequency),
      // so the station keeps its own rhythm.
      if (!this.receiving) continue;
      // Outside the passband: the filter cuts the station off, so its CQ is
      // never picked up. It stays on the waterfall for the operator to tune to.
      if (!this.canHear(e.ham)) continue;
      // Mid-exchange: ignore other stations calling on the band rather than
      // trampling over the QSO in progress.
      if (this.exchangeInProgress) continue;
      // Mid-pile-up: the operator is answering *these* stations. Another CQ on
      // the band must not hijack the selection.
      if (this.pileup.active) continue;
      // Already listening to one station's CQ: only its own repeats get through.
      if (this.machine?.state === "PEER_CQ" && this.ham?.call !== e.ham.call) continue;
      void this.hamCallsCq(e.ham);
    }

    this.activityListener?.(events);
  }

  /**
   * Record one burst as being on the air, and re-time the station's next one:
   * the next CQ starts after this message has finished keying plus a listening
   * gap. Only the session knows how long a message takes, so the band's
   * scheduler cannot work this out on its own.
   */
  private noteCq(ham: VirtualHam): void {
    const text = `CQ CQ CQ DE ${ham.call} ${ham.call} PSE K`;
    const durationMs = this.audio.callDurationMs(text);
    this.onAir.set(ham.call, { text, startedAt: this.clock(), durationMs });
    this.band.scheduleNextCq(ham.call, durationMs + nextCqGapMs(this.rng));
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
    if (!this.receiving || this.sending) return;
    if (this.exchangeInProgress || this.pileup.active) return;
    const now = this.clock();
    let target: { ham: VirtualHam; text: string; offsetSec: number } | null = null;
    for (const entry of this.band.activityState()) {
      if (entry.state === "inQso") continue;
      if (!this.canHear(entry.ham)) continue;
      const tx = this.onAir.get(entry.ham.call);
      if (!tx) continue;
      const elapsed = now - tx.startedAt;
      if (elapsed < 0 || elapsed >= tx.durationMs) continue;
      target = { ham: entry.ham, text: tx.text, offsetSec: elapsed / 1000 };
      break;
    }
    this.audio.stop();
    if (target) void this.audio.playHamFrom(target.text, target.ham, target.offsetSec);
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

  /** Play a station's transmission (the driver side of `audio.playHam`). */
  playHam(text: string, ham?: VirtualHam): Promise<void> {
    return this.audio.playHam(text, ham);
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
