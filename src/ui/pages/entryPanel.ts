import { el } from "../dom.js";
import { addLog } from "../storage/logStore.js";
import { buildLogRecord } from "../logRecord.js";
import { expandMacros } from "../../message/macros.js";
import { isReserved, type QuickMessage } from "../../message/modeFile.js";
import {
  blockingField,
  canLog,
  emptyEntry,
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
 * This is the one place in the app where something is *read* rather than
 * listened to — and it is read off the air first. The boxes are the operator's
 * own notes: the call they copied, the report they decided to send, the report
 * they received. Nothing fills them in automatically, because copying the
 * callsign is the skill being practised (see "没有记录，也没有台名" in `doc/UI.md`).
 *
 * The eight keys are the mode's messages (`doc/MESSAGES.md`), defined in a file
 * the operator can edit. Which of them is lit, and what Enter does, comes from
 * `entryModel.ts` — this module only renders that decision and moves the caret:
 *
 *  - empty call      → F1 (Run: call CQ) or F4 (S&P: answer somebody)
 *  - call filled     → F2 (send the report; the report box fills itself with 599)
 *  - their report in → F3 (sign off, write the row, start a new one)
 *
 * Enter sends the message of the step; Space takes the same step without
 * sending, for an operator who wants to key it by hand.
 *
 * A lit key is a *step*, not a promise: in S&P the first step is "call him",
 * and that message needs his callsign, which by definition has not been copied
 * yet. So the key is lit but not pressable, and Enter says which box is
 * missing — the alternative is a dead Enter with no explanation.
 */

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

export function renderEntryPanel(host: AppHost, root: HTMLElement): void {
  const messages = host.modeMessages;
  // Lightweight hosts (tests, error pages) may not carry a message set.
  if (!messages || !host.entry) return;
  const entry: EntryValues = host.entry;

  const section = el("div", { class: "entry" });
  const keys: KeyView[] = [];
  let hint: Hint = { text: "", field: null };

  const values = (): { myCall: string; theirCall: string; rstFull: string } => ({
    myCall: host.settings.myCall,
    theirCall: entry.call,
    rstFull: entry.rstTx,
  });

  // --- the eight keys ----------------------------------------------------

  const expanded = (m: QuickMessage): { text: string; missing: string[]; label: string } => {
    const r = expandMacros(m.text, { ...values(), exch: "" });
    // A label may carry macros too (F4 shows *your* call, F5 *theirs*). When one
    // cannot be filled in, the raw name stays on the button — it says exactly
    // which value is missing instead of leaving an anonymous key.
    const l = expandMacros(m.label, { ...values(), exch: "" });
    return { text: r.text, missing: r.missing, label: l.missing.length ? m.label : l.text };
  };

  const sendable = (m: QuickMessage): string | null => {
    if (isReserved(m)) return null;
    const r = expanded(m);
    return r.missing.length > 0 || r.text === "" ? null : r.text;
  };

  /**
   * Put a key's message on the air. `blocked` means the message still needs a
   * value the operator has not filled in — the caller explains which.
   */
  const transmit = async (key: number): Promise<"sent" | "busy" | "blocked"> => {
    const m = messages.messages.find((x) => x.key === key);
    if (!m) return "blocked";
    // Half-duplex: the rig is already keying something of ours.
    if (host.session.isSending) return "busy";
    const text = sendable(m);
    if (text === null) return "blocked";
    await host.session.userSend(text);
    return "sent";
  };

  const grid = el("div", { class: "qm-grid" });
  for (const m of messages.messages) {
    const fkey = el("span", { class: "qm-fkey", text: `F${m.key}` });
    const labelNode = el("span", { class: "qm-label" });
    const node = el("button", { class: "qm-key", attrs: { type: "button" } });
    node.append(fkey, labelNode);
    node.addEventListener("click", () => {
      node.blur(); // the key is a trigger, not a place to type
      void transmit(m.key);
    });
    keys.push({ message: m, node, labelNode });
    grid.append(node);
  }

  // --- the row ------------------------------------------------------------

  const callInput = field("呼号", "entry-call", "对方呼号", { autocapitalize: "characters" });
  const rstTxInput = field("我发 RST", "entry-rst", "599", { inputmode: "numeric" });
  const rstRxInput = field("对方 RST", "entry-rst", "579", { inputmode: "numeric" });

  const row = el("div", { class: "entry-row" });
  row.append(callInput.wrap, rstTxInput.wrap, rstRxInput.wrap);

  const hintNode = el("div", { class: "entry-hint", attrs: { role: "status" } });

  callInput.input.value = entry.call;
  rstTxInput.input.value = entry.rstTx;
  rstRxInput.input.value = entry.rstRx;

  callInput.input.addEventListener("input", () => {
    clearHint();
    // A callsign never contains a space, and Morse has no lower case: keeping
    // the box upper case means the draft, the macros and the log agree.
    const upper = normaliseCall(callInput.input.value.replace(/\s+/g, ""));
    if (upper !== callInput.input.value) {
      callInput.input.value = upper;
      callInput.input.setSelectionRange(upper.length, upper.length);
    }
    entry.call = upper;
    sync();
  });
  rstTxInput.input.addEventListener("input", () => {
    clearHint();
    entry.rstTx = digits(rstTxInput.input);
    sync();
  });
  rstRxInput.input.addEventListener("input", () => {
    clearHint();
    entry.rstRx = digits(rstRxInput.input);
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

  const runAction = async (action: EntryAction): Promise<void> => {
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
    if (action.fillRstTx !== null) {
      entry.rstTx = action.fillRstTx;
      rstTxInput.input.value = action.fillRstTx;
    }
    clearHint();
    sync();
    // The caret moves *now*, not when the message has finished going out: the
    // step has been taken, and keying 599 takes several seconds during which the
    // operator may as well start copying the report coming back.
    if (action.focus) focusField(action.focus);
    if (action.send !== null) {
      // The row is written only after the operator has actually signed off on
      // the air, so the log is not closed while the message is still going out.
      const outcome = await transmit(action.send);
      if (outcome === "blocked") {
        explain(action.send);
        return;
      }
      if (outcome === "busy") return;
    }
    if (action.log) {
      const record = buildLogRecord(entry, host.session.freqMHz);
      if (record) await addLog(record);
      // A fresh row, same operating mode: the next station, or the next CQ.
      Object.assign(entry, emptyEntry(entry.mode));
      callInput.input.value = "";
      rstTxInput.input.value = "";
      rstRxInput.input.value = "";
      sync();
      if (action.focus) focusField(action.focus);
    }
  };

  /**
   * Say why the step's message cannot go out, and put the caret where the value
   * is missing. Called only when the step key was pressed and refused.
   */
  const explain = (key: number): void => {
    const m = messages.messages.find((x) => x.key === key);
    const missing = m ? expanded(m).missing : [];
    if (missing.includes("MYCALL")) {
      showHint({ text: "先在设置里填本方呼号", field: null });
      return;
    }
    if (missing.includes("THEIRCALL")) {
      showHint({ text: "先填对方呼号，再说这句", field: "call" });
      focusField("call");
      return;
    }
    showHint({ text: HINT_FOR.rstTx, field: "rstTx" });
    focusField("rstTx");
  };

  for (const f of [callInput, rstTxInput, rstRxInput]) {
    f.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void runAction(onEnter(entry));
      } else if (e.key === " ") {
        // Space is a step, not a character: the callsign box never needs one,
        // and in the key modes Space is the straight key anyway.
        e.preventDefault();
        void runAction(onSpace(entry));
      }
    });
  }

  // --- F1–F8 --------------------------------------------------------------

  const onKeyDown = (e: KeyboardEvent): void => {
    const m = /^F([1-8])$/.exec(e.key);
    if (!m || e.repeat) return;
    // A modal (settings, disclaimer) owns the keyboard while it is up.
    if (document.querySelector(".modal-overlay")) return;
    e.preventDefault();
    void transmit(Number(m[1]));
  };
  document.addEventListener("keydown", onKeyDown);
  host.onLeave(() => document.removeEventListener("keydown", onKeyDown));

  // --- keeping the screen in step ----------------------------------------

  function sync(): void {
    const lit = highlightedKey(entry);
    for (const k of keys) {
      const m = k.message;
      const text = sendable(m);
      const r = expanded(m);
      k.node.disabled = text === null;
      k.labelNode.textContent = r.label;
      // The light marks the step, not availability: in S&P the opening key needs
      // the callsign, which is exactly what the operator is about to type.
      k.node.classList.toggle("active", m.key === lit);
      k.node.title = text ?? "这个键没有报文（见配置文件的 F 行）";
    }
    for (const r of radios) r.node.checked = r.mode === entry.mode;
    callInput.wrap.classList.toggle("bad", hint.field === "call");
    rstTxInput.wrap.classList.toggle("bad", hint.field === "rstTx");
    rstRxInput.wrap.classList.toggle("bad", hint.field === "rstRx");
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

  function focusField(which: EntryField): void {
    const target =
      which === "call" ? callInput.input : which === "rstTx" ? rstTxInput.input : rstRxInput.input;
    target.focus();
    target.setSelectionRange(target.value.length, target.value.length);
  }

  section.append(modeRow, grid, row, hintNode);
  root.append(section);
  sync();
}

/** What each incomplete box is called out as. */
const HINT_FOR: Record<EntryField, string> = {
  call: "先填对方呼号",
  rstTx: "我发 RST 要三位数字（如 599 或 579）",
  rstRx: "对方 RST 要三位数字（如 599）",
};

/** A labelled box in the entry row. */
function field(
  label: string,
  cls: string,
  placeholder: string,
  attrs: Record<string, string>,
): { wrap: HTMLLabelElement; input: HTMLInputElement } {
  const input = el("input", {
    attrs: { type: "text", placeholder, autocomplete: "off", spellcheck: "false", ...attrs },
  });
  const wrap = el("label", { class: `entry-field ${cls}` });
  wrap.append(el("span", { class: "entry-label", text: label }), input);
  return { wrap, input };
}

/** Keep only digits, at most three: a report is three digits, never letters. */
function digits(input: HTMLInputElement): string {
  const clean = input.value.replace(/\D/g, "").slice(0, 3);
  if (clean !== input.value) input.value = clean;
  return clean;
}
