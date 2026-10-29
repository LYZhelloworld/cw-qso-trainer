import { DxccDatabase } from "../data/dxcc.js";
import { parseMessage, ParsedMessage } from "../message/parse.js";
import { cutNumbers } from "../message/macros.js";
import { decodeKeying, type DecodeOptions, type KeyElement } from "../cw/decoder.js";
import { VirtualHam } from "../ham/virtualHam.js";
import { contestReport, cqText, isContest, type ContestKind } from "./contest.js";

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

/** Serializable snapshot of a machine, enough to resume an in-progress QSO. */
export interface MachineSnapshot {
  state: QsoState;
  ctx: QsoContext;
  lastReply: string | null;
  lastRetryKey: RetryKey | null;
  hamOnline: boolean;
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
  /**
   * Which mode the contact is being worked in. DX is the everyday exchange;
   * CQWW and WPX shorten it to `5NN <exch>` and end on `TU` (see `qso/contest`).
   */
  contest?: ContestKind;
  /**
   * This station's exchange as digits (`05`, `001`), computed by the session from
   * its callsign. Empty in DX mode.
   */
  hamExchange?: string;
}

/**
 * QSO state machine. It consumes the user's transmitted CW text (already
 * decoded to letters) and drives a deterministic virtual HAM.
 *
 * Timer semantics are modelled explicitly rather than with real timers, so the
 * logic stays deterministic and unit-testable. The 「超时」 hooks below are that
 * deterministic *interface*; the session owns the clock that drives them:
 * `timeoutFirstCall` is mirrored by `Patience.expireOwnCq` and `timeoutResend`
 * by `Patience.servicePartnerWait` (both in `src/ui/sessionPatience.ts`) — the
 * partner repeating itself when the operator stays silent, then giving up.
 */
export class QsoMachine {
  state: QsoState = "IDLE";
  readonly ctx: QsoContext;
  hamOnline = true;

  private readonly ham: VirtualHam;
  private readonly db: DxccDatabase;
  private readonly contest: ContestKind;
  private readonly hamExchange: string;
  private lastReply: string | null = null;
  private lastRetryKey: RetryKey | null = null;

  constructor(opts: QsoMachineOptions) {
    this.ham = opts.ham;
    this.db = opts.db;
    this.contest = opts.contest ?? "DX";
    this.hamExchange = opts.hamExchange ?? "";
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
    // In a contest the answer is the callsign and nothing else: the report and
    // the exchange come after the runner has named the station back, which is
    // what keeps a run moving (see `doc/QSO-PROTOCOL.md`).
    const reply = this.contested
      ? this.ham.call
      : `${this.ctx.myCall} DE ${this.ham.call} K`;
    this.ctx.peerCall = this.ham.call;
    this.ctx.callsignsConfirmed = true;
    this.state = "EXCHANGE";
    this.lastReply = reply;
    this.lastRetryKey = null;
    return reply;
  }

  /**
   * The operator has called CQ. The text itself is sent by the session (there
   * is no partner yet), so this only records the state the machine is in while
   * a pile-up is being answered.
   */
  beginUserCq(): void {
    if (this.state === "IDLE") this.state = "USER_CQ";
  }

  /**
   * The operator picked this HAM out of a pile-up by name.
   *
   * Unlike `hamAnswerCq` there is no fresh "MYCALL DE HAM" line: the station
   * already identified itself in the pile-up, so the next thing it sends is its
   * report. Everything else matches a normal answered CQ.
   */
  hamAcceptedSelection(): string {
    if (this.state !== "USER_CQ") return "";
    this.ctx.peerCall = this.ham.call;
    this.ctx.callsignsConfirmed = true;
    this.ctx.rstRx = this.peerReport();
    this.state = "EXCHANGE";
    // A contest station named out of a pile-up gives its report *and* its
    // exchange in one over — it has been waiting to say them. No callsign: it
    // has just been named, and repeating it would cost the runner a second.
    const reply = this.contested
      ? `${this.peerReportAir()} ${this.exchangeAir()}`
      : `R UR RST ${this.ham.report} BK`;
    this.lastReply = reply;
    this.lastRetryKey = null;
    return reply;
  }

  /** Virtual HAM initiates a CQ. Returns the HAM's CQ text. */
  hamCq(): string {
    this.ctx.peerCall = this.ham.call;
    this.state = "PEER_CQ";
    // Same wording as the band's background CQs — one definition, in `contest`.
    const reply = cqText(this.ham.call, this.contest);
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
    // In a contest the thing that goes missing is the number, and the question is
    // one word: `NR?`. Our own report is the last thing asked about, so counting
    // the two separately is pointless — whatever was lost, this asks for it back.
    const reply = this.contested ? "NR?" : "AGN?";
    this.lastReply = reply;
    this.lastRetryKey = "COPY";
    if (failed) this.fail();
    return reply;
  }

  // --- Timer hooks (deterministic; NOT called by the app — see class comment) -

  /** Would be "15 s first-call wait expired with no answer" → back to IDLE. */
  timeoutFirstCall(): void {
    if (this.state === "USER_CQ" || this.state === "PEER_CQ") {
      this.reset();
    }
  }

  /** Would be "5 s wait after a transmission expired" → HAM resends. */
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

  /** Would be "3 min with no answer to the HAM's CQ" → HAM goes offline. */
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

  /** Capture the full machine state for persistence (resume after refresh). */
  snapshot(): MachineSnapshot {
    return {
      state: this.state,
      ctx: { ...this.ctx, retryCount: { ...this.ctx.retryCount } },
      lastReply: this.lastReply,
      lastRetryKey: this.lastRetryKey,
      hamOnline: this.hamOnline,
    };
  }

  /** Overwrite this machine's state from a snapshot (inverse of `snapshot`). */
  applySnapshot(snap: MachineSnapshot): void {
    this.state = snap.state;
    this.hamOnline = snap.hamOnline;
    Object.assign(this.ctx, snap.ctx, { retryCount: { ...snap.ctx.retryCount } });
    this.lastReply = snap.lastReply;
    this.lastRetryKey = snap.lastRetryKey;
  }

  /** Build a machine from a snapshot, paired with the given HAM. */
  static fromSnapshot(snap: MachineSnapshot, opts: QsoMachineOptions): QsoMachine {
    const m = new QsoMachine(opts);
    m.applySnapshot(snap);
    return m;
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
      // Both reports are in: the exchange is over. A station that has just
      // copied "R UR RST 599 BK" acknowledges and signs off — sending the
      // operator's own report straight back at them is a parrot, not a QSO.
      if (this.ctx.rstRx !== null) return [this.hamSignsOff()];
      // In a contest the station we called has not given us anything yet: the
      // answer to our exchange is `R 5NN <exch>`.
      const reply = this.contested
        ? `R ${this.peerReportAir()} ${this.exchangeAir()}`
        : `R UR RST ${this.ham.report} BK`;
      this.ctx.rstRx = this.peerReport();
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

    // A contest contact ends on `TU` and nothing comes back — the next station is
    // already calling. But it ends on `TU`: an `F5` (the other station's call) or
    // an `F7` (`?`) in this state is still part of the contact, and treating it as
    // a sign-off would close a QSO the operator was in the middle of fixing.
    if (this.contested) {
      const signedOff = p.type === "END" || p.end === "SK" || /\b(TU|73|SK)\b/.test(p.raw.toUpperCase());
      if (!signedOff) return [];
      this.ctx.userEndSent = true;
      this.ctx.peerEndHeard = true;
      this.state = "LOGGED";
      this.lastReply = null;
      this.lastRetryKey = null;
      return [];
    }

    if (p.type === "END" || p.end === "SK" || /\b(TU|73|SK)\b/.test(p.raw.toUpperCase())) {
      this.ctx.userEndSent = true;
    }

    // If the HAM already signed off, answering its 73 is a courtesy: a real
    // station sends the short form, not the whole sign-off a second time.
    const reply = this.ctx.peerEndHeard ? "73" : "R TU 73 SK";
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

  /**
   * Both reports have been exchanged: acknowledge and sign off.
   *
   * This is the "73" the operator has earned. It is deliberately the HAM that
   * closes the contact — the operator answered its CQ, so the operator is owed
   * the sign-off — and it leaves the machine in `SIGNOFF`, waiting for the
   * operator's own 73 before the QSO is logged.
   */
  private hamSignsOff(): string {
    // In a contest the sign-off is the single word the runner expects.
    const reply = this.contested ? "TU" : "R TU 73 SK";
    this.lastReply = reply;
    this.lastRetryKey = null;
    this.ctx.peerEndHeard = true;
    this.state = "SIGNOFF";
    return reply;
  }

  private hamExchangeReply(_p: ParsedMessage): string[] {
    // Deterministic HAM: acknowledge with R and offer its RST (BK signals the
    // user may omit callsigns going forward). The report is this HAM's RST for
    // the user's signal (varies per virtual-HAM behaviour).
    //
    // Answering a contest CQ is the other order: the station that is running
    // comes back with our call, its report and its exchange in one over, and
    // then waits for ours.
    const reply = this.contested
      ? `${this.ctx.myCall} ${this.peerReportAir()} ${this.exchangeAir()}`
      : `R UR RST ${this.ham.report} BK`;
    this.lastReply = reply;
    this.lastRetryKey = null;
    this.ctx.rstRx = this.peerReport();
    this.maybeSignoff();
    return [reply];
  }

  /**
   * The report this station sends. In a contest it is always 5NN — nobody is
   * graded on readability mid-run — and that is also the value the operator's
   * log is checked against.
   */
  private peerReport(): string {
    return contestReport(this.contest, this.ham.report);
  }

  /** Its report as the key sends it (`599` → `5NN`). */
  private peerReportAir(): string {
    return cutNumbers(this.peerReport());
  }

  /** Its exchange as the key sends it: `001` goes out as `TTA`. */
  private exchangeAir(): string {
    return cutNumbers(this.hamExchange);
  }

  private get contested(): boolean {
    return isContest(this.contest);
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
