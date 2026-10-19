import { QsoMachine, type QsoState } from "../qso/stateMachine.js";
import { Frequency } from "../ham/frequency.js";
import { VirtualHam } from "../ham/virtualHam.js";
import { dxccDatabase } from "../data/dxcc.js";
import { CwAudioEngine, type AudioPlayer, type EngineRenderOptions } from "../audio/engine.js";
import { difficultyToEnvironment } from "../audio/environment.js";
import {
  answerCqDelayMs,
  replyDelayMs,
  targetHamCount,
  type HamActivityEvent,
} from "../ham/activity.js";
import {
  buildBackgroundSignals,
  mulberry32,
  type SpectrumSignal,
  type SpectrumSnapshot,
} from "../ham/spectrum.js";
import {
  PILEUP_MAX_CALLS,
  matchCaller,
  pileupCallText,
  pileupSilenceMs,
  pileupSize,
  type PileupCaller,
} from "../ham/pileup.js";
import {
  audibleToneHz,
  detuneHz,
  inPassband,
  normalisePassband,
  resolveSideband,
  type Sideband,
} from "../ham/tuning.js";
import type { AppSettings } from "./settingsSchema.js";
import { textToTiming } from "../cw/encode.js";
import { canWriteLog, deriveLogRecord, type LogRecord } from "./logRecord.js";
import { clearStaging, loadStaging, saveStaging } from "./storage/qsoStaging.js";

/**
 * Presentation-layer session: pairs one virtual HAM on one band with a
 * QsoMachine, plays the CW audio, and keeps the transcript shown on the
 * operator's screen.
 *
 * A session owns TWO things that deliberately have different lifetimes:
 *  - the **band** (its virtual HAMs and their CQ rhythm, via `Frequency`) — the
 *    environment. It keeps running whether or not the operator is listening.
 *  - the **station** (audio, transcript, the QSO in progress) — that is what
 *    the rig's power switch controls (`receiving`).
 *
 * Powering down therefore never touches the band: the other stations do not go
 * off the air just because we did. See `setReceiving`.
 *
 * Real timers are wired here (the state machine itself stays deterministic).
 */

export type Speaker = "me" | "ham" | "sys";

export interface TranscriptLine {
  who: Speaker;
  text: string;
}

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

export class QsoSession {
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
  private readonly freq: Frequency;
  private readonly engine: AudioPlayer;
  private readonly rng: () => number;
  private readonly now: () => number;
  private readonly startTicking: (cb: () => void) => () => void;
  private readonly wait: (ms: number) => Promise<void>;
  /**
   * How many HAMs this band keeps active (5–9 by default, fixed for the
   * session). An explicit `seedHams(n)` overrides it, and the band refills back
   * to that number after a HAM gives up — "keep n stations", not "spawn n once".
   */
  private targetHams: number;
  private settings: AppSettings;
  private stopTicking: (() => void) | null = null;
  private activityListener: ((events: HamActivityEvent[]) => void) | null = null;
  private transcriptListener: (() => void) | null = null;

  machine: QsoMachine | null = null;
  ham: VirtualHam | null = null;
  lines: TranscriptLine[] = [];
  /**
   * Stations answering the operator's CQ right now (see `ham/pileup`). While
   * this is set the QSO has not started yet: nobody has been named, so there is
   * no `machine` and no partner — only a handful of stations calling back.
   */
  private pileup: PileupCaller[] | null = null;
  /**
   * Per-call "keying until" timestamps (ms) for the waterfall. A pile-up caller
   * is a transmitter only while its call is actually being played; derived from
   * the clock rather than stored as a boolean so it self-expires.
   */
  private readonly keyingUntil = new Map<string, number>();
  /**
   * Unsent text sitting in the send box. It lives here rather than in the DOM
   * because any settings change re-renders the page, which would otherwise
   * throw away whatever the user was halfway through keying in.
   */
  draft = "";
  /** Set once the finished QSO has been written to the log (prevents duplicates). */
  logWritten = false;
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
    this.now = opts.now ?? (() => Date.now());
    this.wait =
      opts.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.startTicking =
      opts.startTicking ??
      ((cb) => {
        const id = setInterval(cb, TICK_MS);
        return () => clearInterval(id);
      });
    this.targetHams = targetHamCount(this.rng);
    this.freq = new Frequency(freqMHz, dxccDatabase, {
      rng: this.rng,
      now: this.now,
      referenceHz: this.referenceHz,
    });
    this.engine = opts.engine ?? new CwAudioEngine();
  }

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
    this.clearPileup();
    this.engine.stop(); // cut any in-flight HAM audio when leaving the band
    this.activityListener = null;
  }

  /**
   * Register a listener notified when a HAM calls CQ on its own or gives up.
   * Pages use it to refresh without a full re-render; pass null to unregister.
   */
  setActivityListener(fn: ((events: HamActivityEvent[]) => void) | null): void {
    this.activityListener = fn;
  }

  /** Roster with each HAM's state, for the frequency page. */
  hamActivity() {
    return this.freq.activityState();
  }

  /**
   * One line's worth of data for the waterfall: the dial (the window centre)
   * and every signal on the band — the workable HAMs plus the decorative
   * background carriers. Frequencies are absolute, so tuning past a station
   * makes it drift across the display instead of moving with the dial.
   */
  spectrum(): SpectrumSnapshot {
    const states = new Map(this.freq.activityState().map((e) => [e.ham.call, e.state]));
    const now = this.now();
    const signals: SpectrumSignal[] = [];
    for (const ham of this.freq.listHams()) {
      signals.push({
        freqHz: ham.freqHz,
        strength: ham.strength,
        call: ham.call,
        workable: true,
        // Only a station that is *calling* is keying. One already in a QSO with
        // us is mostly listening, so it renders as a steady carrier instead.
        // A pile-up caller keys only while its own call is being played.
        active:
          states.get(ham.call) === "cqing" ||
          (this.keyingUntil.get(ham.call) ?? 0) > now,
      });
    }
    for (const bg of this.backgroundSignals()) signals.push(bg);
    return { centerHz: this.dialHz, signals };
  }

  /**
   * The tone the operator currently hears from the station being worked: the
   * rig's CW pitch shifted by however far that station sits from the dial (see
   * `ham/tuning`). Null when there is no partner, when it has no frequency (a
   * HAM generated without a band reference), or when it has been tuned outside
   * the receiver's passband — an off-frequency station is not a wrong note, it
   * is silence.
   */
  partnerToneHz(): number | null {
    if (!this.ham || this.ham.freqHz <= 0) return null;
    return this.hamToneHz(this.ham);
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
    const candidates = this.freq
      .activityState()
      .filter((e) => e.state !== "inQso")
      .map((e) => e.ham)
      .sort(
        (a, b) =>
          Math.abs(detuneHz(a.freqHz, this.dialHz)) - Math.abs(detuneHz(b.freqHz, this.dialHz)),
      );
    return candidates[0] ?? null;
  }

  /** HAMs on the band that the current dial setting cannot hear at all. */
  unheardHams(): VirtualHam[] {
    return this.freq.listHams().filter((h) => !inPassband(h.freqHz, this.dialHz, this.passbandHz));
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

  /**
   * Register a listener notified whenever a transcript line is appended, so a
   * page can redraw just its transcript. Without this the page would only
   * update after the whole exchange round-trip — meaning the user's own line
   * would not appear until the HAM had finished replying seconds later.
   */
  setTranscriptListener(fn: (() => void) | null): void {
    this.transcriptListener = fn;
  }

  get state(): QsoState {
    // Mid-pile-up there is no machine yet, but the operator has certainly
    // called CQ — report that, or the panel would say "idle" while three
    // stations are answering.
    if (this.pileup !== null && this.machine === null) return "USER_CQ";
    return this.machine?.state ?? "IDLE";
  }

  get inQso(): boolean {
    if (this.pileup !== null) return true;
    return this.machine !== null && this.machine.state !== "IDLE";
  }

  /** The stations answering the operator's CQ, in the order they arrived. */
  pileupCallers(): VirtualHam[] {
    return this.pileup?.map((c) => c.ham) ?? [];
  }

  /**
   * Pile-up callers that have already transmitted at least once — the ones the
   * operator can actually have copied. A station that has not called yet is not
   * a name you could have written down, so the UI does not offer it.
   */
  heardPileupCallers(): VirtualHam[] {
    return this.pileup?.filter((c) => c.calls > 0).map((c) => c.ham) ?? [];
  }

  /** True when this call is one of the stations currently answering our CQ. */
  isPileupCaller(call: string): boolean {
    return this.pileup?.some((c) => c.ham.call === call) ?? false;
  }

  get playbackAvailable(): boolean {
    return this.engine.playbackAvailable;
  }

  /** True while a transmission (user or HAM) is being sent — UI disables send. */
  get isSending(): boolean {
    return this.sending;
  }

  /** Update the unsent draft and persist it so a refresh keeps what was typed. */
  setDraft(value: string): void {
    this.draft = value;
    this.persistStaging();
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
    if (!on) this.engine.stop(); // powering down cuts whatever was being heard
  }

  get isReceiving(): boolean {
    return this.receiving;
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
  }

  /**
   * Populate the frequency with activity so the band is not empty. With no
   * argument the band keeps 5–9 HAMs (VIRTUAL-HAM.md), decided once per session;
   * an explicit count also becomes the level the band refills to.
   */
  seedHams(count?: number): VirtualHam[] {
    if (count !== undefined) this.targetHams = count;
    while (this.freq.hamCount < this.targetHams) this.spawnHam();
    return this.listHams();
  }

  listHams(): VirtualHam[] {
    return this.freq.listHams();
  }

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
    const target = ham ?? this.pickHam("listen");
    // Not audible = not heard. The band is not empty, the operator just has not
    // tuned to anyone yet (the waterfall shows where they are).
    if (!target || !this.canHear(target)) return false;
    // The same HAM calling again must not restart the exchange: repeating hamCq()
    // on a machine already in PEER_CQ is idempotent, so reuse it and just log
    // and play the repeated call.
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
    void this.playHam(text, target);
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
      this.stopAudio(); // cut any ambient HAM CQ before the user's own call
      // A fresh attempt starts a clean transcript; an earlier unanswered CQ
      // left lines behind and no partner to explain them.
      if (this.machine === null) {
        this.clearPileup();
        this.lines = [];
        this.logWritten = false;
        this.draft = "";
      }
      const callers = this.formPileup();
      const cq = `CQ CQ CQ DE ${this.myCall()} ${this.myCall()} PSE K`;
      this.push("me", cq);
      await this.playMine(cq);
      // VIRTUAL-HAM.md: a HAM answers the user's CQ after 1–5 s. The others
      // follow once the previous call has finished plus a short random gap, so
      // the pile-up staggers instead of cutting itself off.
      let at = this.now() + answerCqDelayMs(this.rng);
      for (const c of callers) {
        c.nextCallAt = at;
        c.calls = 0;
        at += this.callDurationMs(pileupCallText(c.ham.call)) + 500 + Math.floor(this.rng() * 1000);
      }
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
    if (this.pileup !== null) return this.answerPileup(line);

    const machine = this.machine;
    if (!machine) return;
    this.sending = true;
    try {
      this.stopAudio(); // break in: cut any HAM still calling CQ

      // Answering a HAM's CQ: the user has spoken up, so that HAM drops its own
      // CQ rhythm — no more repeats, and the 3-minute give-up timer stops.
      if (machine.state === "PEER_CQ" && this.ham) this.freq.markInQso(this.ham.call);

      this.push("me", line);
      await this.playMine(line);

      // Difficulty-driven "receiver did not copy" (novice 0%, hardcore 5%).
      if (this.ham && this.rng() < this.ham.missProbability) {
        const agn = machine.hamMissed();
        if (agn) {
          await this.wait(replyDelayMs(this.rng));
          this.push("ham", agn);
          await this.playHam(agn);
          return;
        }
      }

      const replies = machine.userSend(line);
      if (replies.length === 0) this.push("sys", "（无应答）");
      for (const reply of replies) {
        // VIRTUAL-HAM.md: the HAM replies 1–3 s after the user's transmission.
        await this.wait(replyDelayMs(this.rng));
        this.push("ham", reply);
        await this.playHam(reply);
      }

      // QSO complete: the HAM goes back to listening and will call CQ again.
      if (machine.state === "LOGGED" && this.ham) this.freq.markListening(this.ham.call);
    } finally {
      this.sending = false;
    }
  }

  /**
   * The operator replied to a pile-up. The only thing that matters is whether a
   * station was named: a bare "R BK" addresses nobody, so every station stays
   * silent and tries again later (see `drivePileup`). This is deliberately
   * unforgiving — naming the station is the skill a pile-up teaches.
   */
  private async answerPileup(line: string): Promise<void> {
    const callers = this.pileup;
    if (!callers) return;
    this.sending = true;
    try {
      this.stopAudio(); // the operator's key is on top of the pile-up
      this.push("me", line);
      await this.playMine(line);

      const chosen = matchCaller(line, callers);
      if (!chosen) {
        // Nobody was addressed. Re-roll every silence so the repeats stay
        // spread out; the operator gets another chance to name a station.
        for (const c of callers) c.nextCallAt = this.now() + pileupSilenceMs(this.rng);
        this.push("sys", "没有点名任何一台，各台继续等待");
        return;
      }

      // The named station is the partner; the rest leave. A caller conjured for
      // this pile-up goes off the band, a station that was already here just
      // goes back to listening.
      this.pileup = null;
      for (const c of callers) {
        if (c !== chosen) this.releaseCaller(c);
      }
      this.freq.markInQso(chosen.ham.call);
      const machine = this.startMachine(chosen.ham);
      // The CQ went out before the machine existed (a pile-up has no partner
      // yet), so put it in the state it would have been in.
      machine.beginUserCq();
      await this.wait(replyDelayMs(this.rng));
      const reply = machine.hamAcceptedSelection();
      this.push("ham", reply);
      await this.playHam(reply);
    } finally {
      this.sending = false;
    }
  }

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

  /** Append a system note to the transcript (not part of the QSO exchange). */
  note(text: string): void {
    this.push("sys", text);
  }

  /** Abandon the current QSO and clear the transcript. */
  reset(): void {
    // Free the HAM we were working so it resumes its own CQ rhythm. A pile-up
    // that never got as far as naming anyone has no `ham`, only callers.
    this.clearPileup();
    if (this.ham) this.freq.markListening(this.ham.call);
    this.engine.stop(); // cut any in-flight audio along with the QSO
    this.machine?.reset();
    this.machine = null;
    this.ham = null;
    this.lines = [];
    this.draft = "";
    this.logWritten = false;
    this.dropStaging();
  }

  /**
   * Restore an in-progress QSO from the last staging snapshot, if any and if it
   * still matches this frequency. Called once on app start so an accidental
   * refresh resumes rather than discarding the conversation.
   */
  restoreStaging(): void {
    const staged = loadStaging();
    if (!staged) return;
    // A different band, or nothing worth resuming, or an already-finished QSO:
    // drop the stale snapshot rather than resurrecting it.
    if (staged.freqMHz !== this.freqMHz) {
      clearStaging();
      return;
    }
    if (!staged.machine || !staged.ham) {
      clearStaging();
      return;
    }
    const active = ["USER_CQ", "PEER_CQ", "EXCHANGE", "SIGNOFF"];
    if (!active.includes(staged.machine.state)) {
      clearStaging();
      return;
    }
    const ham = new VirtualHam({
      call: staged.ham.call,
      difficulty: staged.ham.difficulty,
      report: staged.ham.report,
      ...(staged.ham.freqHz !== undefined ? { freqHz: staged.ham.freqHz } : {}),
      ...(staged.ham.strength !== undefined ? { strength: staged.ham.strength } : {}),
    });
    this.ham = ham;
    this.machine = QsoMachine.fromSnapshot(staged.machine, {
      myCall: this.myCall(),
      ham,
      db: dxccDatabase,
    });
    this.lines = staged.lines;
    this.draft = staged.draft;
    this.logWritten = staged.logWritten;
  }

  // --- internals -----------------------------------------------------------

  private myCall(): string {
    return this.settings.myCall || FALLBACK_MY_CALL;
  }

  /** True once the user is actually exchanging with a HAM (not just listening). */
  private get exchangeInProgress(): boolean {
    const s = this.machine?.state;
    return s === "USER_CQ" || s === "EXCHANGE" || s === "SIGNOFF";
  }

  /**
   * The station to work, given why we are looking for one. You cannot work what
   * you cannot hear, so the passband always has the first say.
   *
   *  - `"call"` — the operator is calling CQ. Whoever answers is answering *on
   *    the operator's frequency*, so an empty passband gets a new station placed
   *    right on the dial — exactly what happens on the air.
   *  - `"listen"` — the operator is tuning around for somebody else's CQ. That
   *    one has to be *found*, so an empty passband returns null; conjuring a
   *    station out of the dial would take the searching away.
   */
  private pickHam(mode: "call" | "listen"): VirtualHam | null {
    const heard = this.heardActiveHam();
    if (heard) return heard;
    if (mode === "listen") return null;
    return this.spawnHam(this.dialHz);
  }

  /** True when a station is inside the receiver's passband right now. */
  private canHear(ham: VirtualHam): boolean {
    return ham.freqHz <= 0 || inPassband(ham.freqHz, this.dialHz, this.passbandHz);
  }

  /** One step of the scheduler (driven by the injected timer). */
  private tick(): void {
    const events = this.freq.advance();
    if (events.length > 0) this.handleActivity(events);
    this.drivePileup();
  }

  /**
   * Advance the pile-up: the earliest caller that is due transmits, unless the
   * operator is transmitting right now — then every station listens and the
   * repeats wait, which is the "in a call, see whether it was for me" half of
   * the rule. Only one station is started per tick, so their silences stay
   * staggered even if several became due at once.
   */
  private drivePileup(): void {
    const callers = this.pileup;
    if (!callers || !this.receiving || this.sending) return;
    const now = this.now();
    const due = callers
      .filter((c) => now >= c.nextCallAt)
      .sort((a, b) => a.nextCallAt - b.nextCallAt);
    const caller = due[0];
    if (!caller) return;

    // Out of repeats: it gives up and leaves (a spawned one off the band, a
    // station that was already here back to listening).
    if (caller.calls >= PILEUP_MAX_CALLS) {
      this.releaseCaller(caller);
      this.pileup = callers.filter((c) => c !== caller);
      if (this.pileup.length === 0) {
        this.pileup = null;
        this.note("没有人应答你的点名，各台已停止呼叫");
      }
      return;
    }

    caller.calls += 1;
    const text = pileupCallText(caller.ham.call);
    const duration = this.callDurationMs(text);
    caller.nextCallAt = now + duration + pileupSilenceMs(this.rng);
    this.push("ham", text);
    // Key this station's waterfall column only while its call is on the air.
    this.keyingUntil.set(caller.ham.call, now + duration);
    void this.playHam(text, caller.ham).then(() => {
      this.keyingUntil.delete(caller.ham.call);
    });
  }

  /**
   * Build the stations that answer this CQ. Stations already inside the
   * passband heard it, so they are reused; the rest are conjured right on the
   * dial — everyone answers on the caller's frequency, which is why a pile-up
   * is co-channel and the 1 kHz band grid does not apply to it. Every caller is
   * marked in-QSO so its own CQ rhythm stops for the duration.
   */
  private formPileup(): PileupCaller[] {
    const size = pileupSize(this.rng);
    const busy = new Set(
      this.freq
        .activityState()
        .filter((e) => e.state === "inQso")
        .map((e) => e.ham.call),
    );
    const callers: PileupCaller[] = [];
    for (const ham of this.freq.listHams()) {
      if (callers.length >= size) break;
      if (busy.has(ham.call)) continue;
      if (!this.canHear(ham)) continue;
      callers.push({ ham, spawned: false, nextCallAt: 0, calls: 0 });
      this.freq.markInQso(ham.call);
    }
    while (callers.length < size) {
      const ham = this.spawnHam(this.dialHz);
      callers.push({ ham, spawned: true, nextCallAt: 0, calls: 0 });
      this.freq.markInQso(ham.call);
    }
    this.pileup = callers;
    return callers;
  }

  /** Drop the pile-up and put every caller back where it belongs. */
  private clearPileup(): void {
    const callers = this.pileup;
    if (!callers) return;
    this.pileup = null;
    for (const c of callers) this.releaseCaller(c);
  }

  private releaseCaller(caller: PileupCaller): void {
    this.keyingUntil.delete(caller.ham.call);
    if (caller.spawned) this.freq.removeHam(caller.ham.call);
    else this.freq.markListening(caller.ham.call);
  }

  /** How long a message takes to key at the operator's current speed, in ms. */
  private callDurationMs(text: string): number {
    const elements = textToTiming(text, {
      wpm: this.settings.wpm,
      ...(this.settings.farnsworthEnabled
        ? { farnsworthWpm: this.settings.farnsworthWpm }
        : {}),
    });
    return elements.reduce((total, e) => total + e.on + e.off, 0);
  }

  private handleActivity(events: HamActivityEvent[]): void {
    for (const e of events) {
      if (e.type === "offline") {
        // The band keeps replacing stations that give up whether or not we are
        // listening; only the *report* of it is withheld while powered down.
        if (this.receiving) this.note(`${e.ham.call} 停止呼叫，已下线`);
        this.refillHams();
      }
    }

    for (const e of events) {
      if (e.type !== "cq") continue;
      // Powered down: the CQ goes out on the air, we just do not hear it. The
      // band must still be advanced (which it is — that happened in frequency),
      // so the station keeps its own rhythm and may still give up.
      if (!this.receiving) continue;
      // Outside the passband: the filter cuts the station off, so its CQ is
      // never picked up. It stays on the waterfall for the operator to tune to.
      if (!this.canHear(e.ham)) continue;
      // Mid-exchange: ignore other stations calling on the band rather than
      // trampling over the QSO in progress.
      if (this.exchangeInProgress) continue;
      // Mid-pile-up: the operator is answering *these* stations. Another CQ on
      // the band must not hijack the selection.
      if (this.pileup !== null) continue;
      // Already listening to one station's CQ: only its own repeats get through.
      if (this.machine?.state === "PEER_CQ" && this.ham?.call !== e.ham.call) continue;
      void this.hamCallsCq(e.ham);
    }

    this.activityListener?.(events);
  }

  /** Top the band back up to its target size after a HAM gave up. */
  private refillHams(): void {
    while (this.freq.hamCount < this.targetHams) this.spawnHam();
  }

  /**
   * Spawn a station on this band. `atHz` pins it to an exact frequency (the
   * operator's dial, for a station about to answer the operator's CQ).
   */
  private spawnHam(atHz?: number): VirtualHam {
    return this.freq.spawnHam(
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

  private push(who: Speaker, text: string): void {
    this.lines.push({ who, text });
    this.transcriptListener?.();
    this.persistStaging();
  }

  /**
   * Write the in-progress QSO to staging (localStorage) so a refresh can resume.
   * A finished or failed QSO is cleared instead — staging is only for the
   * conversation still underway, and the log already holds the completed record.
   */
  private persistStaging(): void {
    if (this.machine && (this.machine.state === "LOGGED" || this.machine.state === "FAILED")) {
      clearStaging();
      return;
    }
    saveStaging({
      freqMHz: this.freqMHz,
      lines: this.lines,
      draft: this.draft,
      logWritten: this.logWritten,
      machine: this.machine ? this.machine.snapshot() : null,
      ham: this.ham
        ? {
            call: this.ham.call,
            difficulty: this.ham.difficulty,
            report: this.ham.report,
            freqHz: this.ham.freqHz,
            strength: this.ham.strength,
          }
        : null,
    });
  }

  private dropStaging(): void {
    clearStaging();
  }

  /**
   * The CW pitch a station is heard at, given where the dial sits: exactly the
   * configured tone when it is zero-beaten, shifted by the detuning while it is
   * inside the passband (see `ham/tuning`), and `null` once the filter has cut
   * it off. Falls back to the plain pitch for an unplaced station.
   */
  private hamToneHz(ham?: VirtualHam | null): number | null {
    const station = ham ?? this.ham;
    if (!station || station.freqHz <= 0) return this.settings.toneHz;
    return audibleToneHz({
      toneHz: this.settings.toneHz,
      stationHz: station.freqHz,
      dialHz: this.dialHz,
      sideband: this.sideband,
      passbandHz: this.passbandHz,
    });
  }

  private async playHam(text: string, ham?: VirtualHam): Promise<void> {
    const speaker = ham ?? this.ham;
    const toneHz = this.hamToneHz(speaker);
    // Outside the passband we render nothing: the station is filtered out, so
    // there is no note to play — not even a wrong one.
    if (toneHz === null) return;
    const env = difficultyToEnvironment(speaker?.difficulty ?? this.settings.difficulty);
    // `...extra` wins over the default pitch in `play`, so the station is heard
    // off-key whenever the operator has not tuned it in.
    await this.play(text, {
      qsb: env.qsb,
      qrm: env.qrm,
      qrn: env.qrn,
      toneHz,
    });
  }

  private async playMine(text: string): Promise<void> {
    await this.play(text, {});
  }

  /** Cut any in-flight playback (the operator breaks in on a HAM's CQ). */
  private stopAudio(): void {
    this.engine.stop();
  }

  private async play(text: string, extra: EngineRenderOptions): Promise<void> {
    const opts: EngineRenderOptions = {
      wpm: this.settings.wpm,
      toneHz: this.settings.toneHz,
      ...(this.settings.farnsworthEnabled
        ? { farnsworthWpm: this.settings.farnsworthWpm }
        : {}),
      ...extra,
    };
    try {
      await this.engine.play(text, opts).done;
    } catch {
      // No AudioContext or blocked autoplay: the text transcript still works.
    }
  }
}
