/**
 * Parser for a mode's quick-message file (`data/messages/DX.msg`, and in the
 * desktop build the user's editable copy of it).
 *
 * The file is deliberately not JSON or TOML: it is the thing the operator is
 * expected to hand-edit, so it is one line per key, `#` comments, and the CW
 * message kept exactly as it will be keyed — no quoting, no escaping, no
 * structural punctuation to trip over inside a message. See `doc/MESSAGES.md`
 * for the format as it is presented to users.
 *
 *     F1 <label>,<message>
 *
 * Pure text in, data out: no DOM, no storage, no file reading. The bundled
 * default and the user's copy go through exactly the same path, so a broken
 * user file can be reported line by line instead of silently misbehaving.
 */

/** How many function keys the operating panel has (F1–F8). */
export const QUICK_KEY_COUNT = 8;

export interface QuickMessage {
  /** 1–8, i.e. the F-key number. */
  key: number;
  /**
   * Text on the button, before macro expansion. Empty = show only the key name.
   */
  label: string;
  /**
   * Message template, before macro expansion. Empty = the key is reserved: the
   * button is disabled and pressing it sends nothing.
   */
  text: string;
}

export interface ModeMessages {
  /** Mode id — the file's base name, e.g. `DX`. */
  id: string;
  /** Always `QUICK_KEY_COUNT` entries, in key order. */
  messages: QuickMessage[];
}

export interface ModeFileResult {
  config: ModeMessages;
  /**
   * Human-readable problems, each prefixed with its line number. A file with
   * problems still parses: whatever could be read is kept, and the rest falls
   * back to a blank key. Callers surface these instead of failing the app.
   */
  problems: string[];
}

/** A line that starts with F (or f) and a number: a candidate definition. */
const LINE_RE = /^[Ff](\d+)\s*(.*)$/;

/**
 * Parse one mode file. Never throws: an unreadable file yields an empty
 * (all-reserved) key set plus the reasons.
 */
export function parseModeFile(raw: string, id: string): ModeFileResult {
  const problems: string[] = [];
  const byKey = new Map<number, QuickMessage>();

  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i].trim();
    // Blank lines and whole-line comments. No inline comments on purpose: a
    // message may legitimately contain `#`, and silently truncating it there
    // would change what goes on the air.
    if (line === "" || line.startsWith("#")) continue;

    const m = LINE_RE.exec(line);
    if (!m) {
      problems.push(`第 ${lineNo} 行：认不出这一行（应为 F1 按钮文字,报文）：${line}`);
      continue;
    }

    const key = Number(m[1]);
    if (!Number.isInteger(key) || key < 1 || key > QUICK_KEY_COUNT) {
      problems.push(`第 ${lineNo} 行：F${m[1]} 超出范围，只有 F1–F${QUICK_KEY_COUNT}`);
      continue;
    }

    const rest = m[2];
    // Only the first comma separates: everything after it is the message, so a
    // message can contain commas of its own.
    const comma = rest.indexOf(",");
    const label = (comma < 0 ? "" : rest.slice(0, comma)).trim();
    const text = (comma < 0 ? rest : rest.slice(comma + 1)).trim();

    if (byKey.has(key)) {
      problems.push(`第 ${lineNo} 行：F${key} 重复定义，这一行覆盖前面的`);
    }
    byKey.set(key, { key, label, text });
  }

  const messages: QuickMessage[] = [];
  for (let key = 1; key <= QUICK_KEY_COUNT; key++) {
    messages.push(byKey.get(key) ?? { key, label: "", text: "" });
  }

  return { config: { id, messages }, problems };
}

/** True when this key has nothing to send (reserved, or the file omitted it). */
export function isReserved(message: QuickMessage): boolean {
  return message.text.trim() === "";
}
