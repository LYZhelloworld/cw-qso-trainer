import { DEFAULT_MODE_FILE, DEFAULT_MODE_ID, parseBundledMode } from "../data/modeMessages.js";
import { parseModeFile, type ModeMessages } from "../message/modeFile.js";

/**
 * Where the quick messages come from, in order of preference:
 *
 *  1. the operator's own file, next to the executable (`app-data/messages/DX.msg`),
 *     which the desktop shell creates on first run from the bundled default;
 *  2. the bundled default, inlined at build time.
 *
 * The web build can never satisfy (1) — a browser page cannot read a file
 * beside itself — so it runs on (2), which is the same text the desktop build
 * starts its copy from. That keeps one definition of the messages, and it means
 * a broken user file can never leave the operator without keys: the fallback is
 * already parsed and on screen before the file is even looked at.
 */

export interface LoadedMode {
  config: ModeMessages;
  /** Which of the two the messages actually came from. */
  source: "file" | "bundled";
  /** Problems with the file, line-numbered. Empty for a clean read. */
  problems: string[];
}

/** Reads `messages/<name>` from next to the executable; null when unavailable. */
export type ModeFileReader = (name: string) => Promise<string | null>;

/** The desktop shell's command (see `src-tauri/src/lib.rs`). */
const READ_COMMAND = "read_mode_file";

interface TauriInternals {
  invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
}

function tauriInvoke(): TauriInternals["invoke"] | null {
  const internals = (globalThis as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  const invoke = internals?.invoke;
  return typeof invoke === "function" ? invoke : null;
}

/**
 * Read the user's mode file from disk. Returns null in the browser, and also
 * when the shell has no such file — the two are the same to the caller.
 */
export const readModeFileFromDisk: ModeFileReader = async (name) => {
  const invoke = tauriInvoke();
  if (!invoke) return null;
  const text = await invoke(READ_COMMAND, { name });
  return typeof text === "string" ? text : null;
};

export async function loadModeMessages(
  read: ModeFileReader = readModeFileFromDisk,
): Promise<LoadedMode> {
  const bundled = parseBundledMode();
  const fallback = (problems: string[] = []): LoadedMode => ({
    config: bundled.config,
    source: "bundled",
    problems,
  });

  let raw: string | null;
  try {
    raw = await read(DEFAULT_MODE_FILE);
  } catch (err) {
    // A shell that cannot read the file is not a reason to lose the keys.
    return fallback([`读不到 ${DEFAULT_MODE_FILE}：${String(err)}`]);
  }
  if (raw === null) return fallback();

  const parsed = parseModeFile(raw, DEFAULT_MODE_ID);
  const usable = parsed.config.messages.some((m) => m.text !== "");
  if (!usable) {
    // An empty or entirely unreadable file would leave eight dead keys: keep the
    // default and report, rather than trading working keys for an empty panel.
    return fallback([`${DEFAULT_MODE_FILE} 里没有可用报文，改用内置默认`].concat(parsed.problems));
  }
  return { config: parsed.config, source: "file", problems: parsed.problems };
}
