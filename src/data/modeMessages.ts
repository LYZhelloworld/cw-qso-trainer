import dxRaw from "../../data/messages/DX.msg?raw";
import { parseModeFile, type ModeFileResult } from "../message/modeFile.js";

/**
 * The bundled quick-message set: `data/messages/DX.msg`, inlined at build time
 * the same way `data/cty.dat` is. It is both the default and the fallback — the
 * desktop build hands the user a copy of this file to edit (see
 * `src/ui/modeFileLoader.ts`), and reads that instead when it is readable.
 */

/** Mode id of the only mode there is today (see `doc/MESSAGES.md`). */
export const DEFAULT_MODE_ID = "DX";

/** The file name the desktop build looks for next to the executable. */
export const DEFAULT_MODE_FILE = "DX.msg";

/** Raw text of the bundled file, for writing a first copy out to disk. */
export const BUNDLED_MODE_RAW = dxRaw;

export function parseBundledMode(id: string = DEFAULT_MODE_ID): ModeFileResult {
  return parseModeFile(dxRaw, id);
}
