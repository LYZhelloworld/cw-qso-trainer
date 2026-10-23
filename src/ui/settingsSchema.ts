import { BANDS } from "./bands.js";
import { PASSBAND_HZ, normalisePassband } from "../ham/tuning.js";

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
export type KeyMode = "straight" | "iambic";

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
  /** Straight key or iambic paddles. */
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
}

export const WPM_MIN = 5;
export const WPM_MAX = 40;
export const TONE_MIN = 300;
export const TONE_MAX = 1200;
/** Sidetone level shown to the user (percent); mapped to 0..1 gain internally. */
export const SIDETONE_MIN = 0;
export const SIDETONE_MAX = 100;

export const DEFAULT_SETTINGS: AppSettings = {
  myCall: "",
  toneHz: 700,
  wpm: 18,
  farnsworthEnabled: false,
  farnsworthWpm: 18,
  difficulty: "novice",
  freqMHz: 14.025,
  bandIndex: 1,
  keyMode: "straight",
  keyCode: "Space",
  // Z/X: adjacent, so both can be squeezed at once; no browser shortcut grabs
  // them and they are barely used while typing.
  dotCode: "KeyZ",
  dashCode: "KeyX",
  iambicMode: "A",
  sidetone: true,
  sidetoneVolume: 40,
  passbandHz: PASSBAND_HZ,
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
    keyMode: r.keyMode === "iambic" ? "iambic" : "straight",
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
  };
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
