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
import type { AppSettings } from "./settingsSchema.js";
import { canWriteLog, deriveLogRecord, type LogRecord } from "./logRecord.js";
import { clearStaging, loadStaging, saveStaging } from "./storage/qsoStaging.js";

/**
 * Presentation-layer session: pairs one virtual HAM on one frequency with a
 * QsoMachine, plays the CW audio, and keeps the transcript shown on the CW page.
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
}

export class QsoSession {
  readonly freqMHz: number;
  private readonly freq: Frequency;
  private readonly engine: AudioPlayer;
  private readonly rng: () => number;
  private readonly now: () => number;
  private readonly startTicking: (cb: () => void) => () => void;
  private readonly wait: (ms: number) => Promise<void>;
  /** How many HAMs this band keeps active (1–3, fixed for the session). */
  private readonly targetHams: number;
  private settings: AppSettings;
  private stopTicking: (() => void) | null = null;
  private activityListener: ((events: HamActivityEvent[]) => void) | null = null;
  private transcriptListener: (() => void) | null = null;

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
  /** True while a transmission is in flight; guards against interleaved sends. */
  private sending = false;

  constructor(freqMHz: number, settings: AppSettings, opts: QsoSessionOptions = {}) {
    this.freqMHz = freqMHz;
    this.settings = settings;
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
    this.freq = new Frequency(freqMHz, dxccDatabase, { rng: this.rng, now: this.now });
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
   * Register a listener notified whenever a transcript line is appended, so a
   * page can redraw just its transcript. Without this the page would only
   * update after the whole exchange round-trip — meaning the user's own line
   * would not appear until the HAM had finished replying seconds later.
   */
  setTranscriptListener(fn: (() => void) | null): void {
    this.transcriptListener = fn;
  }

  get state(): QsoState {
    return this.machine?.state ?? "IDLE";
  }

  get inQso(): boolean {
    return this.machine !== null && this.machine.state !== "IDLE";
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
   * Populate the frequency with activity so the band is not empty. With no
   * argument the band keeps 1–3 HAMs (VIRTUAL-HAM.md), decided once per session.
   */
  seedHams(count?: number): VirtualHam[] {
    const target = count ?? this.targetHams;
    while (this.freq.hamCount < target) this.spawnHam();
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
   */
  async hamCallsCq(ham?: VirtualHam): Promise<void> {
    if (this.sending) return;
    const target = ham ?? this.pickHam();
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
    void this.playHam(text);
  }

  /** The user calls CQ; a single HAM answers after a short delay. */
  async userCallsCq(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      this.stopAudio(); // cut any ambient HAM CQ before the user's own call
      const machine = this.startMachine(this.pickHam());
      const cq = `CQ CQ CQ DE ${this.myCall()} ${this.myCall()} PSE K`;
      machine.userSend(cq); // -> USER_CQ
      this.push("me", cq);
      await this.playMine(cq);
      // VIRTUAL-HAM.md: a HAM answers the user's CQ after 1–5 s.
      await this.wait(answerCqDelayMs(this.rng));
      const reply = machine.hamAnswerCq();
      if (reply) {
        if (this.ham) this.freq.markInQso(this.ham.call);
        this.push("ham", reply);
        await this.playHam(reply);
      } else {
        this.push("sys", "无人应答，CQ 超时");
      }
    } finally {
      this.sending = false;
    }
  }

  /** The user transmits one line; HAM replies are appended and played. */
  async userSend(text: string): Promise<void> {
    const machine = this.machine;
    if (!machine) return;
    const line = text.trim().toUpperCase();
    if (!line) return;
    // Busy guard: a second send while the first is still being transmitted (or
    // the HAM is mid-reply) is dropped rather than interleaved with it.
    if (this.sending) return;
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
    // Free the HAM we were working so it resumes its own CQ rhythm.
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

  private pickHam(): VirtualHam {
    return this.freq.activeHam() ?? this.spawnHam();
  }

  /** One step of the scheduler (driven by the injected timer). */
  private tick(): void {
    const events = this.freq.advance();
    if (events.length > 0) this.handleActivity(events);
  }

  private handleActivity(events: HamActivityEvent[]): void {
    for (const e of events) {
      if (e.type === "offline") {
        this.note(`${e.ham.call} 停止呼叫，已下线`);
        this.refillHams();
      }
    }

    for (const e of events) {
      if (e.type !== "cq") continue;
      // Mid-exchange: ignore other stations calling on the band rather than
      // trampling over the QSO in progress.
      if (this.exchangeInProgress) continue;
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

  private spawnHam(): VirtualHam {
    return this.freq.spawnHam(
      this.myCall(),
      this.settings.difficulty,
      undefined,
      this.firstCqDelay(),
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
        ? { call: this.ham.call, difficulty: this.ham.difficulty, report: this.ham.report }
        : null,
    });
  }

  private dropStaging(): void {
    clearStaging();
  }

  /** Public: drop any staged QSO (e.g. when the user tunes to a new band). */
  discardStaging(): void {
    clearStaging();
  }

  private async playHam(text: string): Promise<void> {
    const env = difficultyToEnvironment(this.ham?.difficulty ?? this.settings.difficulty);
    await this.play(text, { qsb: env.qsb, qrm: env.qrm, qrn: env.qrn });
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
