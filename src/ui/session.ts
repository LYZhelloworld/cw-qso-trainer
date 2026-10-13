import { QsoMachine, type QsoState } from "../qso/stateMachine.js";
import { Frequency } from "../ham/frequency.js";
import type { VirtualHam } from "../ham/virtualHam.js";
import { dxccDatabase } from "../data/dxcc.js";
import { CwAudioEngine, type EngineRenderOptions } from "../audio/engine.js";
import { difficultyToEnvironment } from "../audio/environment.js";
import type { AppSettings } from "./settingsSchema.js";
import { canWriteLog, deriveLogRecord, type LogRecord } from "./logRecord.js";

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

/** How long the HAM "takes" before answering a CQ. */
const ANSWER_DELAY_MS = 1200;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class QsoSession {
  readonly freqMHz: number;
  private readonly freq: Frequency;
  private readonly engine: CwAudioEngine;
  private settings: AppSettings;

  machine: QsoMachine | null = null;
  ham: VirtualHam | null = null;
  lines: TranscriptLine[] = [];
  /** Set once the finished QSO has been written to the log (prevents duplicates). */
  logWritten = false;

  constructor(freqMHz: number, settings: AppSettings) {
    this.freqMHz = freqMHz;
    this.settings = settings;
    this.freq = new Frequency(freqMHz, dxccDatabase);
    this.engine = new CwAudioEngine();
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

  updateSettings(settings: AppSettings): void {
    this.settings = settings;
  }

  /** Populate the frequency with activity so the band is not empty. */
  seedHams(count = 3): VirtualHam[] {
    const out: VirtualHam[] = [];
    for (let i = 0; i < count; i += 1) {
      out.push(this.freq.spawnHam(this.myCall(), this.settings.difficulty));
    }
    return out;
  }

  listHams(): VirtualHam[] {
    return this.freq.listHams();
  }

  /** A virtual HAM calls CQ on this frequency. */
  async hamCallsCq(): Promise<void> {
    const machine = this.startMachine(this.pickHam());
    const text = machine.hamCq();
    this.push("ham", text);
    await this.playHam(text);
  }

  /** The user calls CQ; a single HAM answers after a short delay. */
  async userCallsCq(): Promise<void> {
    const machine = this.startMachine(this.pickHam());
    const cq = `CQ CQ CQ DE ${this.myCall()} ${this.myCall()} PSE K`;
    machine.userSend(cq); // -> USER_CQ
    this.push("me", cq);
    await this.playMine(cq);
    await delay(ANSWER_DELAY_MS);
    const reply = machine.hamAnswerCq();
    if (reply) {
      this.push("ham", reply);
      await this.playHam(reply);
    } else {
      this.push("sys", "无人应答，CQ 超时");
    }
  }

  /** The user transmits one line; HAM replies are appended and played. */
  async userSend(text: string): Promise<void> {
    const machine = this.machine;
    if (!machine) return;
    const line = text.trim().toUpperCase();
    if (!line) return;

    this.push("me", line);
    await this.playMine(line);

    // Difficulty-driven "receiver did not copy" (novice 0%, hardcore 5%).
    if (this.ham && Math.random() < this.ham.missProbability) {
      const agn = machine.hamMissed();
      if (agn) {
        this.push("ham", agn);
        await this.playHam(agn);
        return;
      }
    }

    const replies = machine.userSend(line);
    if (replies.length === 0) this.push("sys", "（无应答）");
    for (const reply of replies) {
      this.push("ham", reply);
      await this.playHam(reply);
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
    this.machine?.reset();
    this.machine = null;
    this.ham = null;
    this.lines = [];
    this.logWritten = false;
  }

  // --- internals -----------------------------------------------------------

  private myCall(): string {
    return this.settings.myCall || FALLBACK_MY_CALL;
  }

  private pickHam(): VirtualHam {
    return this.freq.activeHam() ?? this.freq.spawnHam(this.myCall(), this.settings.difficulty);
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
  }

  private async playHam(text: string): Promise<void> {
    const env = difficultyToEnvironment(this.ham?.difficulty ?? this.settings.difficulty);
    await this.play(text, { qsb: env.qsb, qrm: env.qrm, qrn: env.qrn });
  }

  private async playMine(text: string): Promise<void> {
    await this.play(text, {});
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
      await this.engine.play(text, opts);
    } catch {
      // No AudioContext or blocked autoplay: the text transcript still works.
    }
  }
}
