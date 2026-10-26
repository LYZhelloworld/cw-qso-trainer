import { el } from "../dom.js";
import { addLog } from "../storage/logStore.js";
import { buildLogRecord, type LogRecord } from "../logRecord.js";
import { expandMacros } from "../../message/macros.js";
import { isReserved, type QuickMessage } from "../../message/modeFile.js";
import {
  blockingField,
  canLog,
  DEFAULT_RST,
  emptyEntry,
  entryStep,
  highlightedKey,
  normaliseCall,
  onEnter,
  onSpace,
  type EntryAction,
  type EntryField,
  type EntryValues,
} from "../entryModel.js";
import type { AppHost } from "../app.js";

/**
 * The operating row: eight quick messages, and the three boxes the operator
 * fills in with what they heard.
 *
 * It sits under the panadapter and above the send bar — the order of the
 * contact, top to bottom: what is on the band, what you say next, what you are
 * keying out. The row itself is the one place in the app where something is
 * *read* rather than listened to — and it is read off the air first. The boxes
 * are the operator's own notes: the call they copied, the report they decided
 * to send, the report they received. Nothing fills them in automatically,
 * because copying the callsign is the skill being practised (see "没有记录，也没有
 * 台名" in `doc/UI.md`).
 *
 * The eight keys are the mode's messages (`doc/MESSAGES.md`), defined in a file
 * the operator can edit. Which of them is lit, and what Enter does, comes from
 * `entryModel.ts` — this module only renders that decision and moves the caret:
 *
 *  - empty call      → F1 (Run: call CQ) or F4 (S&P: answer somebody)
 *  - call filled     → F4 in S&P (our call in answer), until the report is picked
 *  - our report due  → F2 (send it; the report box fills itself with 599)
 *  - our report due  → F2 (send it; the report box fills itself with 599)
 *  - their report in and ours out → F3 (sign off, write the row, start a new one)
 *
 * The caret follows the ears: after F4 it waits in *their* report box, because a
 * station that has just been pounced on comes back with his report before ours
 * has gone out.
 *
 * Enter sends the message of the step; Space takes the same step without
 * sending, for an operator who wants to key it by hand. Esc gives up on the
 * station: three boxes back to blank, nothing keyed, nothing logged.
 *
 * Pressing F1 is also how the operator says "I am running": the mode box follows
 * the key, and only tuning the dial puts it back to S&P.
 *
 * Only a key with **no message at all** is dead. A key whose message still wants
 * a value the operator has not typed still sends: the hole simply goes out as
 * nothing, the way a blank box on a paper log would. The tooltip shows the
 * template with `{THEIRCALL}`-style holes left in, so it is visible beforehand
 * which value is still missing.
 */
export function renderEntryPanel(host: AppHost, root: HTMLElement): void {
  const messages = host.modeMessages;
  // Lightweight hosts (tests, error pages) may not carry a message set.
  if (!messages || !host.entry) return;
  const entry: EntryValues = host.entry;

  const section = el("div", { class: "entry" });
  const keys: KeyView[] = [];
  let hint: Hint = { text: "", field: null };

  const macroValues = (): { myCall: string; theirCall: string; rstFull: string } => ({
    myCall: host.settings.myCall,
    theirCall: entry.call,
    rstFull: entry.rstTx,
  });

  // --- the eight keys ----------------------------------------------------

  /** The message as it would go out, and the button's own text. */
  const expanded = (m: QuickMessage): { text: string; label: string } => {
    const v = { ...macroValues(), exch: "" };
    // A label may carry macros too (F4 shows *your* call, F5 *theirs*). A hole
    // stays on the button as `{THEIRCALL}`: it says exactly which value is
    // missing instead of leaving an anonymous key.
    const l = expandMacros(m.label, v, { keepUnfilled: true });
    return { text: expandMacros(m.text, v).text, label: l.text };
  };

  /** The message with its holes left in — what the tooltip shows. */
  const template = (m: QuickMessage): string =>
    expandMacros(m.text, { ...macroValues(), exch: "" }, { keepUnfilled: true }).text;

  /**
   * The message as it would go out, or null when there is nothing to key.
   *
   * A message with an unfilled macro is sendable: the missing part is simply
   * empty. Only a key with no text at all (a reserved slot) has nothing to say.
   */
  const sendable = (m: QuickMessage): string | null => {
    if (isReserved(m)) return null;
    const text = expanded(m).text;
    return text === "" ? null : text;
  };

  /**
   * What the key's tooltip says: the message it will key out, with any value
   * still missing left visible as `{NAME}`.
   */
  const tooltip = (m: QuickMessage): string => (isReserved(m) ? RESERVED_HINT : template(m));

  /** Put a message on the air, and let the bar under the display show it. */
  const send = (text: string): void => {
    if (text === "") return;
    // Started before the preview is asked for: `userSend` raises the carrier
    // synchronously, so the bar is filled by the time it is on screen.
    void host.session.userSend(text);
    host.showOutgoing?.(text);
  };

  /** Press one key. A dead key has nothing to say and does nothing. */
  const pressKey = (key: number): void => {
    const m = messages.messages.find((x) => x.key === key);
    if (!m) return;
    // Half-duplex: the rig is already keying something of ours.
    if (host.session.isSending) return;
    const text = sendable(m);
    if (text === null) return;
    send(text);
    let stepped = false;
    // Calling CQ *is* the declaration of intent: whoever puts F1 on the air is
    // running, whether they clicked the key or pressed the F1 key. Nothing else
    // flips the mode towards Run — and any tuning flips it back to S&P.
    if (key === 1 && entry.mode !== "run") {
      entry.mode = "run";
      stepped = true;
    }
    // Pressing the lit key does what Enter on it would do. In S&P the opening F4
    // is done with once the report box holds a number, and F2 puts our report on
    // the air; without this the light would stay on a message already sent.
    if (key === 4 && entryStep(entry) === "answer" && entry.rstTx.trim() === "") {
      entry.rstTx = DEFAULT_RST;
      rstTxInput.value = DEFAULT_RST;
      stepped = true;
    } else if (key === 2 && entryStep(entry) === "report") {
      entry.reportSent = true;
      stepped = true;
    }
    if (stepped) {
      clearHint();
      sync();
    }
  };

  const grid = el("div", { class: "qm-grid" });
  for (const m of messages.messages) {
    const fkey = el("span", { class: "qm-fkey", text: `F${m.key}` });
    const labelNode = el("span", { class: "qm-label" });
    const node = el("button", { class: "qm-key", attrs: { type: "button" } });
    node.append(fkey, labelNode);
    node.addEventListener("click", () => {
      node.blur(); // the key is a trigger, not a place to type
      pressKey(m.key);
    });
    keys.push({ message: m, node, labelNode });
    grid.append(node);
  }

  // --- the row ------------------------------------------------------------
  //
  // No labels: the three boxes sit in one line and say what they are inside
  // themselves, so the row is one line tall instead of a label column plus a
  // field column. The placeholders carry the wording the labels used to.

  const callInput = field("entry-call", "对方呼号", { autocapitalize: "characters" });
  const rstTxInput = field("entry-rst", "我方 RST", { inputmode: "numeric" });
  const rstRxInput = field("entry-rst", "对方 RST", { inputmode: "numeric" });

  const row = el("div", { class: "entry-row" });
  row.append(callInput, rstTxInput, rstRxInput);

  const hintNode = el("div", { class: "entry-hint", attrs: { role: "status" } });

  callInput.value = entry.call;
  rstTxInput.value = entry.rstTx;
  rstRxInput.value = entry.rstRx;

  callInput.addEventListener("input", () => {
    clearHint();
    // A callsign never contains a space, and Morse has no lower case: keeping
    // the box upper case means the draft, the macros and the log agree.
    const upper = normaliseCall(callInput.value.replace(/\s+/g, ""));
    if (upper !== callInput.value) {
      callInput.value = upper;
      callInput.setSelectionRange(upper.length, upper.length);
    }
    entry.call = upper;
    sync();
  });
  rstTxInput.addEventListener("input", () => {
    clearHint();
    entry.rstTx = digits(rstTxInput);
    sync();
  });
  rstRxInput.addEventListener("input", () => {
    clearHint();
    entry.rstRx = digits(rstRxInput);
    sync();
  });

  // --- Run / S&P ----------------------------------------------------------

  const modeRow = el("div", {
    class: "entry-mode",
    attrs: { role: "radiogroup", "aria-label": "运行方式" },
  });
  const radios: Array<{ mode: EntryValues["mode"]; node: HTMLInputElement }> = [];
  const MODES: Array<[EntryValues["mode"], string, string]> = [
    ["run", "Run", "自己发 CQ，等别人来应答"],
    ["s&p", "S&P", "Search & Pounce：听到别人在 CQ，过去应答他"],
  ];
  for (const [mode, label, why] of MODES) {
    const radio = el("input", { attrs: { type: "radio", name: "entry-mode" } });
    radio.checked = entry.mode === mode;
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      entry.mode = mode;
      clearHint();
      sync();
    });
    const wrap = el("label", { class: "mode-opt", attrs: { title: why } });
    wrap.append(radio, document.createTextNode(label));
    radios.push({ mode, node: radio });
    modeRow.append(wrap);
  }

  // --- Enter / Space ------------------------------------------------------

  const runAction = (action: EntryAction): void => {
    // Half-duplex: while our own message — or the answer to it — is still on the
    // air there is nothing to take a step *to*. Returning before moving the
    // caret matters: a step that did not happen must not look like it did.
    if (host.session.isSending) return;
    if (action.log && !canLog(entry)) {
      const bad = blockingField(entry);
      if (bad) {
        showHint({ text: HINT_FOR[bad], field: bad });
        focusField(bad);
      }
      return;
    }
    // The report box fills itself *before* the message is expanded: F2's text
    // carries `{RST}`, and the 599 is exactly the value that has to go into it.
    if (action.fillRstTx !== null) {
      entry.rstTx = action.fillRstTx;
      rstTxInput.value = action.fillRstTx;
    }
    // Our side of the exchange has gone out: the row is past the report step,
    // so a report box filled from here on means the sign-off is next.
    if (action.markReported) entry.reportSent = true;
    // The message is expanded *before* the row is cleared: it is built from the
    // callsign and report that are about to be wiped.
    let outgoing: string | null = null;
    if (action.send !== null) {
      const m = messages.messages.find((x) => x.key === action.send);
      if (!m) return;
      outgoing = sendable(m);
    }
    clearHint();
    let completed: LogRecord | null = null;
    if (action.log) {
      completed = buildLogRecord(entry, host.session.freqMHz);
      // A fresh row, same operating mode: the next station, or the next CQ.
      Object.assign(entry, emptyEntry(entry.mode));
      callInput.value = "";
      rstTxInput.value = "";
      rstRxInput.value = "";
    }
    sync();
    // The caret moves *now*, not when the message has finished going out: the
    // step has been taken, and keying 599 takes several seconds during which the
    // operator may as well start copying the report coming back.
    if (action.focus) focusField(action.focus);
    // Signing off is what ends the QSO, not the other station's 73 coming back:
    // the row is committed the moment the operator presses Enter, and the
    // message goes out behind it.
    if (outgoing !== null) send(outgoing);
    if (completed) {
      void addLog(completed).catch((err: unknown) => {
        console.error("[日志] 写入失败：", err);
      });
    }
  };

  for (const input of [callInput, rstTxInput, rstRxInput]) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        runAction(onEnter(entry));
      } else if (e.key === " ") {
        // Space is a step, not a character: the callsign box never needs one,
        // and in the key modes Space is the straight key anyway.
        e.preventDefault();
        runAction(onSpace(entry));
      }
    });
  }

  // --- F1–F8 --------------------------------------------------------------

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    // A modal (settings, disclaimer) owns the keyboard while it is up.
    if (document.querySelector(".modal-overlay")) return;
    // Esc gives up on this station — the same gesture N1MM uses to empty its
    // entry window. Not a step, so it is not subject to half-duplex: what is
    // already on the air stays on the air, but the row is blank when the
    // operator looks back at it.
    if (e.key === "Escape") {
      e.preventDefault();
      clearEntry();
      return;
    }
    const m = /^F([1-8])$/.exec(e.key);
    if (!m) return;
    e.preventDefault();
    pressKey(Number(m[1]));
  };
  document.addEventListener("keydown", onKeyDown);
  host.onLeave(() => document.removeEventListener("keydown", onKeyDown));

  // --- keeping the screen in step ----------------------------------------

  function sync(): void {
    const lit = highlightedKey(entry);
    for (const k of keys) {
      const m = k.message;
      k.labelNode.textContent = expanded(m).label;
      // Only a key with no message at all is dead; everything else answers a
      // press, if only by saying what it is still waiting for.
      k.node.disabled = isReserved(m);
      // The light marks the step, not availability: in S&P the opening key needs
      // the callsign, which is exactly what the operator is about to type.
      k.node.classList.toggle("active", m.key === lit);
      k.node.title = tooltip(m);
    }
    for (const r of radios) r.node.checked = r.mode === entry.mode;
    callInput.classList.toggle("bad", hint.field === "call");
    rstTxInput.classList.toggle("bad", hint.field === "rstTx");
    rstRxInput.classList.toggle("bad", hint.field === "rstRx");
  }

  function showHint(next: Hint): void {
    hint = next;
    hintNode.textContent = next.text;
    sync();
  }

  function clearHint(): void {
    if (hint.text === "" && hint.field === null) return;
    hint = { text: "", field: null };
    hintNode.textContent = "";
    sync();
  }

  /**
   * Give up on this station: wipe the row and say nothing (Esc).
   *
   * Deliberately not a step on the ladder: nothing is keyed, nothing is logged,
   * and the operating mode is kept — giving up on one station says nothing
   * about how the next one starts. Called from the document-level handler, so
   * it also works while the rig is still keying: the carrier cannot be recalled,
   * but the boxes can be emptied for whatever comes next.
   */
  function clearEntry(): void {
    Object.assign(entry, emptyEntry(entry.mode));
    callInput.value = "";
    rstTxInput.value = "";
    rstRxInput.value = "";
    clearHint();
    focusField("call");
    sync();
  }

  function focusField(which: EntryField): void {
    const target =
      which === "call" ? callInput : which === "rstTx" ? rstTxInput : rstRxInput;
    target.focus();
    target.setSelectionRange(target.value.length, target.value.length);
  }

  section.append(modeRow, grid, row, hintNode);
  root.append(section);
  sync();
}

/** A key's rendering: what is on the button, and whether it can be pressed. */
interface KeyView {
  message: QuickMessage;
  node: HTMLButtonElement;
  labelNode: HTMLElement;
}

/** What the hint line is saying, and which box it is pointing at. */
interface Hint {
  text: string;
  field: EntryField | null;
}

/** What each incomplete box is called out as. */
const HINT_FOR: Record<EntryField, string> = {
  call: "先填对方呼号",
  rstTx: "我方 RST 要三位数字（如 599 或 579）",
  rstRx: "对方 RST 要三位数字（如 599）",
};

/** What a key with no message at all says when the pointer rests on it. */
const RESERVED_HINT = "这个键没有报文（见配置文件的 F 行）";

/** One box of the entry row: the placeholder is its label. */
function field(cls: string, placeholder: string, attrs: Record<string, string>): HTMLInputElement {
  return el("input", {
    class: `entry-field ${cls}`,
    attrs: {
      type: "text",
      placeholder,
      "aria-label": placeholder,
      autocomplete: "off",
      spellcheck: "false",
      ...attrs,
    },
  });
}

/** Keep only digits, at most three: a report is three digits, never letters. */
function digits(input: HTMLInputElement): string {
  const clean = input.value.replace(/\D/g, "").slice(0, 3);
  if (clean !== input.value) input.value = clean;
  return clean;
}
