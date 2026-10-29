import { dxccDatabase, type DxccDatabase } from "../data/dxcc.js";
import { hashString, resolveUserEntity } from "../ham/generate.js";
import type { VirtualHam } from "../ham/virtualHam.js";

/**
 * Contest rules: which exchanges exist, what they look like on the air, and how
 * a copied row is checked against what the station actually sent.
 *
 * Two contests and one plain mode. They differ in exactly one thing — the number
 * that goes in the exchange:
 *
 *  - **DX** — nothing is exchanged but the report. Everyday contacts.
 *  - **CQWW** — the operator's CQ zone (1–40).
 *  - **WPX** — a serial the operator increments per logged contact.
 *
 * ## How many digits?
 *
 * Neither contest fixes a width. A zone is at most two digits and a serial is at
 * most six, but whether a station pads with leading zeros, and whether it sends
 * cut numbers, is the operator's own habit: zone 5 may go out as `05`, `T5` or
 * plain `5`. So nothing here treats a shorter copy as wrong — `normaliseExchange`
 * compares values, not spellings — and a serial typed with five digits is not
 * rejected either: the operator may copy what they hear, even if no virtual
 * station here would ever send it.
 *
 * Everything here is pure: no DOM, no storage, no clock. The session asks it what
 * a station's exchange is; the entry panel asks it what the box expects; the log
 * asks it whether the operator copied it right.
 *
 * ## The report in a contest is 5NN
 *
 * A contest exchange is `5NN 05`, never `579 05`: everyone sends 599 because
 * nobody is being graded on readability mid-run. Virtual stations keep their own
 * varying reports in DX mode (`VirtualHam.report`), but in a contest the report
 * they send — and the one the log is checked against — is `CONTEST_RST`.
 */

export type ContestKind = "DX" | "CQWW" | "WPX";

/** In the order the rig's selector shows them: everyday mode first. */
export const CONTEST_KINDS: readonly ContestKind[] = ["DX", "CQWW", "WPX"];

export const CONTEST_LABEL: Record<ContestKind, string> = {
  DX: "DX",
  CQWW: "CQWW",
  WPX: "WPX",
};

/** CQ zone range, per the CQWW rules. Two digits is the most it can take. */
export const CQ_ZONE_MIN = 1;
export const CQ_ZONE_MAX = 40;
/** Where a serial stops being a serial: six digits, the most an entry box takes. */
export const SERIAL_MIN = 1;
export const SERIAL_MAX = 999_999;
/** Every contest station reports 599; the air shortens it to 5NN. */
export const CONTEST_RST = "599";

/**
 * Zone assumed when the callsign resolves to nothing: China's, because that is
 * where the trainer's example station (`BG7XXX`) transmits from, and a wrong
 * zone is still better than an empty exchange box.
 */
export const DEFAULT_ZONE = 24;

export function isContest(kind: ContestKind): boolean {
  return kind !== "DX";
}

/** Does this mode exchange a number beyond the report? */
export function requiresExchange(kind: ContestKind): boolean {
  return isContest(kind);
}

/**
 * The label of the box holding *their* number.
 *
 * Spelled out rather than composed from a name plus "对方": a space belongs in
 * "对方 CQ 分区" and not in "对方序号", and concatenation got that wrong once —
 * the placeholder read `对方CQ 分区`.
 */
export function theirExchangeLabel(kind: ContestKind): string {
  return kind === "CQWW" ? "对方 CQ 分区" : "对方序号";
}

/** Two digits, zero padded: zone 5 goes out as `05` (and on the air as `T5`). */
export function formatZone(zone: number): string {
  return String(clampInt(zone, CQ_ZONE_MIN, CQ_ZONE_MAX, DEFAULT_ZONE)).padStart(2, "0");
}

/** Three digits, zero padded: the first contact goes out as `001`. */
export function formatSerial(serial: number): string {
  return String(clampInt(serial, SERIAL_MIN, SERIAL_MAX, SERIAL_MIN)).padStart(3, "0");
}

export function isValidZone(value: string): boolean {
  const n = Number(value.trim());
  return (
    /^\d{1,2}$/.test(value.trim()) &&
    Number.isInteger(n) &&
    n >= CQ_ZONE_MIN &&
    n <= CQ_ZONE_MAX
  );
}

export function isValidSerial(value: string): boolean {
  // Any length: a copy of `12345` is a copy, not a typo the program gets to
  // refuse. It simply will not match the number the station sent, which is the
  // verdict's business, not the entry box's.
  const t = value.trim();
  return /^\d{1,6}$/.test(t) && Number(t) >= SERIAL_MIN;
}

/** How many digits the entry box lets through before it stops taking them. */
export function exchangeMaxDigits(kind: ContestKind): number {
  return kind === "CQWW" ? 2 : 6;
}

/** Is this what the operator typed into the exchange box a legal value? */
export function isValidExchange(kind: ContestKind, value: string): boolean {
  if (kind === "CQWW") return isValidZone(value);
  if (kind === "WPX") return isValidSerial(value);
  return true;
}

/**
 * The comparative form of an exchange: digits, no leading zeros.
 *
 * What is *sent* is padded (`05`, `001`); what is *copied* may come back as `5`,
 * `05` or `005` depending on how much of the leading zeros the operator caught.
 * All three are the same exchange, and the log must not call two of them wrong.
 */
export function normaliseExchange(kind: ContestKind, value: string): string {
  if (!requiresExchange(kind)) return "";
  const digits = value.replace(/\D/g, "");
  if (digits === "") return "";
  return String(Number(digits));
}

/**
 * The CQ zone a callsign transmits from, from its DXCC entity.
 *
 * Null when the call resolves to nothing — a practise call that is not in the
 * table, for instance. The caller decides what to do about that.
 */
export function zoneOfCall(call: string, db: DxccDatabase = dxccDatabase): number | null {
  const entity = resolveUserEntity(call, db);
  return entity ? entity.cqZone : null;
}

/**
 * The zone the operator is sending from: their setting when they set one, and
 * otherwise whatever their callsign's entity says.
 */
export function ownZone(cqZone: number, myCall: string): number {
  if (cqZone >= CQ_ZONE_MIN && cqZone <= CQ_ZONE_MAX) return cqZone;
  return zoneOfCall(myCall) ?? DEFAULT_ZONE;
}

/**
 * Our own exchange, ready to go on the air: what `{EXCH}` expands to.
 *
 * Empty in DX mode, which is not an error — `expandMacros` knows the exchange is
 * allowed to be empty (see `message/macros.ts`).
 */
export function ownExchangeText(
  kind: ContestKind,
  own: { cqZone: number; wpxSerial: number; myCall: string },
): string {
  if (kind === "CQWW") return formatZone(ownZone(own.cqZone, own.myCall));
  if (kind === "WPX") return formatSerial(own.wpxSerial);
  return "";
}

/**
 * A virtual station's exchange. Derived, never drawn from the RNG:
 *
 *  - CQWW — the zone of the station's DXCC entity, which is what a real CQWW log
 *    would hold;
 *  - WPX — a three-digit serial derived from the callsign, so the same station
 *    sends the same number for as long as it is on the band (stations in a real
 *    contest do too: their number is their contact count, not a random draw),
 *    and the generator's RNG sequence is left exactly as it was.
 *
 * One station in four leaves the leading zeros off (`5` rather than `05`, `12`
 * rather than `012`). Operators do both, and a copy has to be right either way —
 * which is why `verifyEntry` compares values instead of spellings.
 */
export function stationExchange(
  ham: VirtualHam,
  kind: ContestKind,
  db: DxccDatabase = dxccDatabase,
): string {
  const hash = hashString(ham.call);
  const padded = hash % 4 !== 0;
  if (kind === "CQWW") {
    const zone = zoneOfCall(ham.call, db) ?? DEFAULT_ZONE;
    return padded ? formatZone(zone) : String(zone);
  }
  if (kind === "WPX") {
    const serial = 1 + (hash % 999);
    return padded ? formatSerial(serial) : String(serial);
  }
  return "";
}

/** The report a station sends in this mode: always 5NN in a contest. */
export function contestReport(kind: ContestKind, ownReport: string): string {
  return isContest(kind) ? CONTEST_RST : ownReport;
}

/**
 * A CQ in this mode. Contest operators call `CQ TEST`; everyone else calls the
 * long form with `PSE K`. One definition, because the session's background CQs
 * and the state machine's opening CQ have to sound the same.
 */
export function cqText(call: string, kind: ContestKind): string {
  return isContest(kind) ? `CQ TEST ${call} ${call}` : `CQ CQ CQ DE ${call} ${call} PSE K`;
}

/**
 * Whether a logged row matches what the station actually sent.
 *
 *  - `ok`   — call, exchange and report all copied;
 *  - `call` — the callsign is wrong (nothing else is judged: a row logged against
 *             the wrong station is a different contact, not a typo in a number);
 *  - `exch` — the call is right, the exchanged number is not;
 *  - `rst`  — everything else right, only the report is off;
 *  - `undefined` — no station to compare against (the row was not worked).
 */
export type LogVerdict = "ok" | "call" | "exch" | "rst";

/** What the station really sent, captured while the contact is still open. */
export interface PartnerTruth {
  call: string;
  report: string;
  exch: string;
}

export const VERDICT_LABEL: Record<LogVerdict, string> = {
  ok: "正确",
  call: "呼号错误",
  exch: "交换信息错误",
  rst: "RST 错误",
};

export function verifyEntry(
  copy: { call: string; rstRx: string; exchRx: string },
  truth: PartnerTruth | null,
  kind: ContestKind,
): LogVerdict | undefined {
  if (!truth) return undefined;
  if (copy.call.trim().toUpperCase() !== truth.call.trim().toUpperCase()) return "call";
  if (
    requiresExchange(kind) &&
    normaliseExchange(kind, copy.exchRx) !== normaliseExchange(kind, truth.exch)
  ) {
    return "exch";
  }
  if (copy.rstRx.trim() !== truth.report.trim()) return "rst";
  return "ok";
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}
