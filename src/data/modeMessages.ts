import dxRaw from "../../data/messages/DX.msg?raw";
import cqwwRaw from "../../data/messages/CQWW.msg?raw";
import wpxRaw from "../../data/messages/WPX.msg?raw";
import { parseModeFile, type ModeFileResult } from "../message/modeFile.js";
import type { ContestKind } from "../qso/contest.js";

/**
 * The bundled quick-message sets: one file per mode in `data/messages/`,
 * inlined at build time the same way `data/cty.dat` is. They are both the
 * default and the fallback — the desktop build hands the operator a copy of each
 * to edit (see `src/ui/modeFileLoader.ts`), and reads that instead when it is
 * readable.
 *
 * One file per mode rather than one file with three sections: the eight keys of
 * a contest are a different set of words from the eight keys of an everyday
 * contact, and an operator editing them should not have to keep two contests'
 * worth of lines straight in one file.
 */

/** The mode the app starts in, and the file name it looks for first. */
export const DEFAULT_MODE_ID = "DX";
export const DEFAULT_MODE_FILE = "DX.msg";

/** Raw text of each bundled file, for writing first copies out to disk. */
export const BUNDLED_MODE_RAW: Readonly<Record<ContestKind, string>> = {
  DX: dxRaw,
  CQWW: cqwwRaw,
  WPX: wpxRaw,
};

/** The file the desktop build looks for next to the executable. */
export function modeFileName(kind: ContestKind): string {
  return `${kind}.msg`;
}

export function parseBundledMode(kind: ContestKind = "DX"): ModeFileResult {
  return parseModeFile(BUNDLED_MODE_RAW[kind], kind);
}
