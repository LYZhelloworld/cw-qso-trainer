import { BANDS } from "./bands.js";
import { PASSBAND_HZ, normalisePassband } from "../ham/tuning.js";
import {
  CQ_ZONE_MAX,
  CQ_ZONE_MIN,
  SERIAL_MAX,
  SERIAL_MIN,
  type ContestKind,
} from "../qso/contest.js";

/**
 * User settings schema: defaults, normalisation and callsign validation.
 * Intentionally free of DOM / storage so it stays unit-testable under Node.
 *
 * Deliberately *not* here: the CW sideband. A rig keeps its mode per band, so
 * that lives on the band's session (see `QsoSession.sideband`) — a single
 * global "CW-L / CW-U" preference would leak one band's choice onto the next.
 */

export type UiDifficulty = "novice" | "intermediate" | "hardcore";
export type IambicMode = "A" | "B";
/**
 * How the operator puts a message on the air. The three modes are mutually
 * exclusive in the operating panel: a straight key, iambic paddles, or typing
 * the message and letting the rig key it out.
 */
export type KeyMode = "straight" | "iambic" | "text";

export interface AppSettings {
  /** The user's own callsign (practise callsign; format-checked only). */
  myCall: string;
  /** CW sidetone / received tone frequency in Hz. */
  toneHz: number;
  /** Character speed in words per minute. */
  wpm: number;
  /** Stretch inter-character / inter-word gaps (Farnsworth). */
  farnsworthEnabled: boolean;
  /** Effective Farnsworth speed; never higher than `wpm`. */
  farnsworthWpm: number;
  difficulty: UiDifficulty;
  freqMHz: number;
  bandIndex: number;
  /** Straight key, iambic paddles, or free-text message. */
  keyMode: KeyMode;
  /** Physical key (KeyboardEvent.code) used as the straight key. */
  keyCode: string;
  /** Iambic paddle keys (KeyboardEvent.code). */
  dotCode: string;
  dashCode: string;
  /** Sidetone while keying (the rig's monitor tone). */
  sidetone: boolean;
  /** Sidetone level, 0..100. Scaled to a 0..1 linear gain for the oscillator. */
  sidetoneVolume: number;
  /** Iambic squeeze behaviour: A drops the latched element, B sends it. */
  iambicMode: IambicMode;
  /** Receiver CW filter width in Hz (one of `PASSBAND_OPTIONS`). */
  passbandHz: number;
  /**
   * Which of the three operating modes the rig is in: everyday DX, or one of the
   * two contests. It decides the quick messages, the exchange box and which log
   * the row is written to — not the receiver, which is CW in all three.
   */
  contest: ContestKind;
  /**
   * The CQ zone we send in CQWW. `0` means "work it out from the callsign" (see
   * `ownZone`), which is what a station set up correctly should leave it on.
   */
  cqZone: number;
  /**
   * The serial the *next* WPX contact will be given. It lives here rather than in
   * the contact so that closing the app mid-contest does not restart the
   * numbering — the log is the running total, this is the counter in front of it.
   */
  wpxSerial: number;
  /**
   * Which contest session (场次) each contest's log is currently being written
   * into, keyed by contest.
   *
   * A real contest has a start and an end; a trainer has neither, so the operator
   * draws the line by hand: "start a new one" bumps that contest's number, every
   * earlier row becomes history and stays readable, and the log page shows one
   * session at a time instead of an ever-growing list. Per contest, because a
   * boundary on the CQWW book must not turn the WPX book into an archive.
   */
  contestRounds: ContestRounds;
}

/** The two contests that have sessions; DX has no "round" to be in. */
export interface ContestRounds {
  CQWW: number;
  WPX: number;
}

export const WPM_MIN = 5;
export const WPM_MAX = 40;
export const TONE_MIN = 300;
export const TONE_MAX = 1200;
/** Sidetone level shown to the user (percent); mapped to 0..1 gain internally. */
export const SIDETONE_MIN = 0;
export const SIDETONE_MAX = 100;
/** Contest session numbers. One number per session; they only ever go up. */
export const ROUND_MIN = 1;
export const ROUND_MAX = 999;

export const DEFAULT_SETTINGS: AppSettings = {
  myCall: "",
  toneHz: 700,
  wpm: 18,
  farnsworthEnabled: false,
  farnsworthWpm: 18,
  difficulty: "novice",
  freqMHz: 14.025,
  bandIndex: 1,
  // The message mode: typing what you want to send is the easiest way in, and
  // the key modes stay one setting away for anyone practising hand keying.
  keyMode: "text",
  keyCode: "Space",
  // Z/X: adjacent, so both can be squeezed at once; no browser shortcut grabs
  // them and they are barely used while typing.
  dotCode: "KeyZ",
  dashCode: "KeyX",
  iambicMode: "A",
  sidetone: true,
  sidetoneVolume: 40,
  passbandHz: PASSBAND_HZ,
  contest: "DX",
  // 0 = read it off the callsign. A trainer loaded for the first time has no
  // callsign yet, so any fixed zone would be a guess; the derived one at least
  // follows the call the operator eventually types.
  cqZone: 0,
  wpxSerial: 1,
  contestRounds: { CQWW: ROUND_MIN, WPX: ROUND_MIN },
};

/** Mirrors the callsign pattern used by MESSAGE-PARSING (ITU-style). */
export const CALLSIGN_RE = /^[A-Z]{1,2}[0-9][A-Z]{0,4}(?:\/[A-Z0-9]{1,4})?$/;

function clampNum(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function isDifficulty(value: unknown): value is UiDifficulty {
  return value === "novice" || value === "intermediate" || value === "hardcore";
}

/** Coerce arbitrary stored/edited data into a complete, in-range AppSettings. */
export function normalizeSettings(raw: unknown): AppSettings {
  const r = (raw ?? {}) as Partial<AppSettings>;
  const wpm = clampNum(r.wpm, DEFAULT_SETTINGS.wpm, WPM_MIN, WPM_MAX);
  const bandIndex =
    typeof r.bandIndex === "number" &&
    Number.isInteger(r.bandIndex) &&
    r.bandIndex >= 0 &&
    r.bandIndex < BANDS.length
      ? r.bandIndex
      : DEFAULT_SETTINGS.bandIndex;

  return {
    myCall: typeof r.myCall === "string" ? r.myCall.trim().toUpperCase() : DEFAULT_SETTINGS.myCall,
    toneHz: clampNum(r.toneHz, DEFAULT_SETTINGS.toneHz, TONE_MIN, TONE_MAX),
    wpm,
    farnsworthEnabled:
      typeof r.farnsworthEnabled === "boolean"
        ? r.farnsworthEnabled
        : DEFAULT_SETTINGS.farnsworthEnabled,
    // Farnsworth speed can never exceed the character speed.
    farnsworthWpm: clampNum(r.farnsworthWpm, wpm, WPM_MIN, wpm),
    difficulty: isDifficulty(r.difficulty) ? r.difficulty : DEFAULT_SETTINGS.difficulty,
    freqMHz:
      typeof r.freqMHz === "number" && Number.isFinite(r.freqMHz)
        ? r.freqMHz
        : DEFAULT_SETTINGS.freqMHz,
    bandIndex,
    keyMode:
      r.keyMode === "straight" || r.keyMode === "iambic" || r.keyMode === "text"
        ? r.keyMode
        : DEFAULT_SETTINGS.keyMode,
    keyCode: typeof r.keyCode === "string" && r.keyCode.length > 0 ? r.keyCode : DEFAULT_SETTINGS.keyCode,
    dotCode:
      typeof r.dotCode === "string" && r.dotCode.length > 0
        ? r.dotCode
        : DEFAULT_SETTINGS.dotCode,
    dashCode:
      typeof r.dashCode === "string" && r.dashCode.length > 0
        ? r.dashCode
        : DEFAULT_SETTINGS.dashCode,
    iambicMode: r.iambicMode === "B" ? "B" : "A",
    sidetone:
      typeof r.sidetone === "boolean" ? r.sidetone : DEFAULT_SETTINGS.sidetone,
    sidetoneVolume: clampNum(
      r.sidetoneVolume,
      DEFAULT_SETTINGS.sidetoneVolume,
      SIDETONE_MIN,
      SIDETONE_MAX,
    ),
    // A `cwSideband` left behind by an older build is simply ignored: the mode
    // now belongs to the band, and every band starts on its convention.
    passbandHz: normalisePassband(r.passbandHz),
    contest: isContestKind(r.contest) ? r.contest : DEFAULT_SETTINGS.contest,
    // Anything that is not a real zone means "derive it from the callsign":
    // 0 is the sentinel, and so is a missing or negative value.
    cqZone:
      typeof r.cqZone === "number" && r.cqZone > 0
        ? clampNum(r.cqZone, CQ_ZONE_MIN, CQ_ZONE_MIN, CQ_ZONE_MAX)
        : 0,
    wpxSerial: clampNum(r.wpxSerial, DEFAULT_SETTINGS.wpxSerial, SERIAL_MIN, SERIAL_MAX),
    contestRounds: {
      CQWW: clampNum(
        r.contestRounds?.CQWW,
        DEFAULT_SETTINGS.contestRounds.CQWW,
        ROUND_MIN,
        ROUND_MAX,
      ),
      WPX: clampNum(
        r.contestRounds?.WPX,
        DEFAULT_SETTINGS.contestRounds.WPX,
        ROUND_MIN,
        ROUND_MAX,
      ),
    },
  };
}

function isContestKind(value: unknown): value is ContestKind {
  return value === "DX" || value === "CQWW" || value === "WPX";
}

/** Extract the leading letter+digit prefix of a callsign (e.g. BG7XXX -> BG7). */
export function callsignPrefix(call: string): string | null {
  const m = /^([A-Z]{1,2}[0-9])/.exec(call.trim().toUpperCase());
  return m ? m[1] : null;
}

export type CallsignLevel = "ok" | "warn" | "error";

export interface CallsignCheck {
  ok: boolean;
  level: CallsignLevel;
  message: string;
}

/**
 * Validate a practise callsign. Format is required; an unknown DXCC prefix is
 * only a warning (users may want to rehearse a call that is not in the table).
 *
 * `isKnownPrefix` is injected so this module stays independent of the data layer.
 */
export function validateCallsign(
  call: string,
  isKnownPrefix?: (prefix: string) => boolean,
): CallsignCheck {
  const trimmed = call.trim().toUpperCase();
  if (trimmed.length === 0) {
    return { ok: false, level: "error", message: "请填写本方呼号" };
  }
  if (!CALLSIGN_RE.test(trimmed)) {
    return {
      ok: false,
      level: "error",
      message: "呼号格式不符合规范（示例：BG7XXX 或 JA1ABC）",
    };
  }
  const prefix = callsignPrefix(trimmed);
  if (isKnownPrefix && prefix && !isKnownPrefix(prefix)) {
    return {
      ok: true,
      level: "warn",
      message: `前缀 ${prefix} 不在 DXCC 表中，仍可用于练习`,
    };
  }
  return { ok: true, level: "ok", message: "呼号格式正确" };
}
