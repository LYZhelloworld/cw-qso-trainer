import { DxccDatabase } from "../data/dxcc.js";
import { parseMessage, ParsedMessage } from "../message/parse.js";
import { decodeKeying, type DecodeOptions, type KeyElement } from "../cw/decoder.js";
import { VirtualHam } from "../ham/virtualHam.js";

export type QsoState =
  | "IDLE"
  | "USER_CQ"
  | "PEER_CQ"
  | "EXCHANGE"
  | "SIGNOFF"
  | "LOGGED"
  | "FAILED";

export interface QsoContext {
  myCall: string;
  peerCall: string | null;
  callsignsConfirmed: boolean;
  callsignsOmitted: boolean;
  rstRx: string | null;
  rstTx: string | null;
  peerEndHeard: boolean;
  userEndSent: boolean;
  retryCount: Record<string, number>;
}

export interface QsoLog {
  myCall: string;
  peerCall: string | null;
  rstRx: string | null;
  rstTx: string | null;
  date: string;
}

/** Sub-conditions that are independently retried; reaching the limit fails the QSO. */
export type RetryKey = "CALL" | "RST" | "COPY" | "SIGNOFF";
export const RETRY_LIMIT = 3;

const RETRY_KEYS: RetryKey[] = ["CALL", "RST", "COPY", "SIGNOFF"];

export interface QsoMachineOptions {
  myCall: string;
  /** The virtual HAM this machine is paired with (replaces the old hamCall string). */
  ham: VirtualHam;
  db: DxccDatabase;
  /** Reserved context field for the band frequency (MHz); not yet used. */
  frequency?: number;
}

/**
 * QSO state machine (step 1 prototype). It consumes the user's transmitted CW
 * text (already decoded to letters) and drives a deterministic virtual HAM.
 *
 * Timer semantics are modeled explicitly rather than with real timers, so the
 * logic stays deterministic and unit-testable; a later step wires real timers to
 * these hooks (timeoutFirstCall / timeoutResend / hamOffline).
 */
export class QsoMachine {
  state: QsoState = "IDLE";
  readonly ctx: QsoContext;
  hamOnline = true;

  private readonly ham: VirtualHam;
  private readonly db: DxccDatabase;
  private lastReply: string | null = null;
  private lastRetryKey: RetryKey | null = null;

  constructor(opts: QsoMachineOptions) {
    this.ham = opts.ham;
    this.db = opts.db;
    this.ctx = {
      myCall: opts.myCall,
      peerCall: null,
      callsignsConfirmed: false,
      callsignsOmitted: false,
      rstRx: null,
      rstTx: null,
      peerEndHeard: false,
      userEndSent: false,
      retryCount: {},
    };
  }

  // --- User-initiated or -received events -----------------------------------

  /** Local user transmits a CW line. Returns the HAM's reply message(s). */
  userSend(raw: string): string[] {
    const p = parseMessage(raw, this.ctx, "tx", this.db);
    if (p.end === "BK") this.ctx.callsignsOmitted = true;

    switch (this.state) {
      case "IDLE":
        if (p.type === "CQ") {
          this.state = "USER_CQ";
          return [];
        }
        return [];
      case "USER_CQ":
        // Still waiting for the HAM to answer; ignore anything but a repeat CQ.
        return [];
      case "PEER_CQ":
        return this.onPeerCqUserAnswer(p);
      case "EXCHANGE":
        return this.onExchangeUser(p);
      case "SIGNOFF":
        return this.onSignoffUser(p);
      default:
        return [];
    }
  }

  /**
   * Convenience: decode a keying sequence (CW-PARSING receive side) and feed the
   * resulting text into the state machine. Proves the step-2 decoder plugs into
   * the step-1 text chain without changing the state machine's logic.
   */
  userSendKeying(elements: KeyElement[], opts?: DecodeOptions): string[] {
    const { text } = decodeKeying(elements, opts);
    return this.userSend(text);
  }

  /** Virtual HAM answers the user's CQ (called after the 15s-less deterministic delay). */
  hamAnswerCq(): string {
    if (this.state !== "USER_CQ") return "";
    const reply = `${this.ctx.myCall} DE ${this.ham.call} K`;
    this.ctx.peerCall = this.ham.call;
    this.ctx.callsignsConfirmed = true;
    this.state = "EXCHANGE";
    this.lastReply = reply;
    this.lastRetryKey = null;
    return reply;
  }

  /** Virtual HAM initiates a CQ. Returns the HAM's CQ text. */
  hamCq(): string {
    this.ctx.peerCall = this.ham.call;
    this.state = "PEER_CQ";
    const reply = `CQ CQ CQ DE ${this.ham.call} ${this.ham.call} PSE K`;
    this.lastReply = reply;
    this.lastRetryKey = null;
    return reply;
  }

  /**
   * Simulate the HAM failing to copy the user's last transmission (receiver
   * incomplete). The HAM asks for a full repeat. Counts as a COPY retry.
   */
  hamMissed(): string {
    if (this.state !== "EXCHANGE" && this.state !== "SIGNOFF") return "";
    const failed = this.bumpRetry("COPY");
    const reply = "AGN?";
    this.lastReply = reply;
    this.lastRetryKey = "COPY";
    if (failed) this.fail();
    return reply;
  }

  // --- Timer hooks (deterministic; real timers wired in a later step) --------

  /** 15s first-call wait expired with no answer -> back to IDLE. */
  timeoutFirstCall(): void {
    if (this.state === "USER_CQ" || this.state === "PEER_CQ") {
      this.reset();
    }
  }

  /** 5s wait after a transmission expired with no valid reply -> HAM resends. */
  timeoutResend(): string[] {
    if (this.state !== "EXCHANGE" && this.state !== "SIGNOFF") return [];
    if (this.lastRetryKey) {
      const n = (this.ctx.retryCount[this.lastRetryKey] ?? 0) + 1;
      this.ctx.retryCount[this.lastRetryKey] = n;
      if (n >= RETRY_LIMIT) {
        this.fail();
        return this.lastReply ? [this.lastReply] : [];
      }
    }
    return this.lastReply ? [this.lastReply] : [];
  }

  /** 3min with no answer to the HAM's CQ -> HAM goes offline. */
  hamOffline(): void {
    if (this.state === "PEER_CQ") {
      this.hamOnline = false;
      this.reset();
    }
  }

  // --- Inspection / lifecycle -------------------------------------------------

  getContext(): Readonly<QsoContext> {
    return this.ctx;
  }

  getLog(): QsoLog | null {
    if (this.state !== "LOGGED") return null;
    return {
      myCall: this.ctx.myCall,
      peerCall: this.ctx.peerCall,
      rstRx: this.ctx.rstRx,
      rstTx: this.ctx.rstTx,
      date: new Date().toISOString(),
    };
  }

  /** Clear the context and return to IDLE (LOGGED / FAILED -> IDLE). */
  reset(): void {
    this.state = "IDLE";
    this.hamOnline = true;
    this.ctx.peerCall = null;
    this.ctx.callsignsConfirmed = false;
    this.ctx.callsignsOmitted = false;
    this.ctx.rstRx = null;
    this.ctx.rstTx = null;
    this.ctx.peerEndHeard = false;
    this.ctx.userEndSent = false;
    for (const k of RETRY_KEYS) this.ctx.retryCount[k] = 0;
    this.lastReply = null;
    this.lastRetryKey = null;
  }

  // --- Internals --------------------------------------------------------------

  private onPeerCqUserAnswer(p: ParsedMessage): string[] {
    if (this.copyError(p)) return [this.handleCopyError()];
    this.ctx.callsignsConfirmed = true;
    this.state = "EXCHANGE";
    if (p.rst) this.ctx.rstTx = p.rst; // user's answer may already carry their RST
    return this.hamExchangeReply(p);
  }

  private onExchangeUser(p: ParsedMessage): string[] {
    if (this.copyError(p)) return [this.handleCopyError()];

    // Illegal RST: an RST word present but no valid RST token.
    if (p.type === "QUERY" && /\bRST\b/.test(p.raw.toUpperCase())) {
      const failed = this.bumpRetry("RST");
      const reply = "UR RST?";
      this.lastReply = reply;
      this.lastRetryKey = "RST";
      if (failed) this.fail();
      return [reply];
    }

    if (p.rst) {
      this.ctx.rstTx = p.rst;
      const reply = `R UR RST ${p.rst} BK`;
      this.ctx.rstRx = this.ham.report;
      this.lastReply = reply;
      this.lastRetryKey = null;
      this.maybeSignoff();
      return [reply];
    }

    const reply = "R BK";
    this.lastReply = reply;
    this.lastRetryKey = null;
    return [reply];
  }

  private onSignoffUser(p: ParsedMessage): string[] {
    if (this.copyError(p)) return [this.handleCopyError()];

    if (p.type === "END" || p.end === "SK" || /\b(TU|73|SK)\b/.test(p.raw.toUpperCase())) {
      this.ctx.userEndSent = true;
    }

    const reply = "R TU 73 SK";
    this.lastReply = reply;
    this.lastRetryKey = null;
    this.ctx.peerEndHeard = true; // HAM sends its own end
    if (this.ctx.userEndSent && this.ctx.peerEndHeard) {
      this.state = "LOGGED";
    } else {
      this.state = "SIGNOFF";
    }
    return [reply];
  }

  private hamExchangeReply(_p: ParsedMessage): string[] {
    // Deterministic HAM: acknowledge with R and offer its RST (BK signals the
    // user may omit callsigns going forward). The report is this HAM's RST for
    // the user's signal (varies per virtual-HAM behaviour).
    const reply = `R UR RST ${this.ham.report} BK`;
    this.lastReply = reply;
    this.lastRetryKey = null;
    this.ctx.rstRx = this.ham.report;
    this.maybeSignoff();
    return [reply];
  }

  private copyError(p: ParsedMessage): boolean {
    if (p.omit_calls) return false;
    if (!p.callsignValid) return true;
    const unexpected = p.callsigns.filter(
      (c) => c !== this.ctx.myCall && c !== this.ctx.peerCall,
    );
    return unexpected.length > 0;
  }

  private handleCopyError(): string {
    const failed = this.bumpRetry("CALL");
    const reply = `QRZ? DE ${this.ham.call}`;
    this.lastReply = reply;
    this.lastRetryKey = "CALL";
    if (failed) this.fail();
    return reply;
  }

  private maybeSignoff(): void {
    if (
      this.ctx.callsignsConfirmed &&
      this.ctx.rstRx !== null &&
      this.ctx.rstTx !== null
    ) {
      this.state = "SIGNOFF";
    }
  }

  private bumpRetry(key: RetryKey): boolean {
    const n = (this.ctx.retryCount[key] ?? 0) + 1;
    this.ctx.retryCount[key] = n;
    this.lastRetryKey = key;
    return n >= RETRY_LIMIT;
  }

  private fail(): void {
    this.state = "FAILED";
  }
}
