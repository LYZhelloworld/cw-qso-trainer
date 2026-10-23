import { button, el, panel } from "../dom.js";
import { addLog } from "../storage/logStore.js";
import type { AppHost } from "../app.js";
import { renderKeyPanel } from "./keyPanel.js";

/**
 * The operating panel — one of three mutually exclusive ways to transmit:
 *
 *  - **text**: type the message, press Enter, the rig keys it out at the
 *    operator's speed (the message goes out all at once);
 *  - **straight** / **iambic**: key the over live. There is no send box and no
 *    "send" step: the rig is on the air from the first element, and the over is
 *    handed to the band when the operator stops keying.
 *
 * Which one appears is a setting (`keyMode`), not a control on this page.
 * There is deliberately no transcript, no station named, no status readout and
 * no "start a QSO" button: you find out what the band did by listening.
 */
export function renderQsoPanel(host: AppHost, root: HTMLElement): void {
  const session = host.session;
  const settings = host.settings;

  const flushLog = async (): Promise<void> => {
    const record = session.pendingLog();
    if (!record) return;
    await addLog(record);
    session.markLogged();
    session.note("通联完成，已写入日志");
  };

  // Without a callsign your own CQ is not your callsign, and the log would lie.
  const warnings: HTMLElement[] = [];
  if (!settings.myCall) {
    const warn = el("div", { class: "hint" });
    warn.append(document.createTextNode("请先填写本方呼号："));
    warn.append(button("打开设置", () => host.openSettings?.(), "btn small"));
    warnings.push(warn);
  }

  if (settings.keyMode === "text") {
    // The bar itself is mounted by the App under the panadapter; only the
    // warnings have anywhere to go on this page.
    if (warnings.length) root.append(panel("提示", ...warnings));
    renderSendBar(host, host.sendBar ?? root, flushLog);
    return;
  }
  renderLiveKeyPanel(host, root, warnings, flushLog);
}

/**
 * Text mode: one line, under the panadapter, as wide as the display.
 *
 * This is where the *operator's* message is written — the thing about to be
 * keyed out — so it belongs with the picture of the band it is going onto, not
 * in the middle of the operating page. Enter keys it; the box stays focused so
 * the next over can be typed straight away.
 */
function renderSendBar(
  host: AppHost,
  bar: HTMLElement,
  flushLog: () => Promise<void>,
): void {
  const session = host.session;

  const input = el("input", {
    class: "send-input",
    attrs: {
      type: "text",
      // The box is for what *you* are about to send. The example is a reply
      // because that is what most overs are, but nothing has to be copied into
      // it: you can call CQ from here.
      placeholder: "输入报文，Enter 发送（例如：R UR RST 599 BK）",
      "aria-label": "要发出的报文",
      // Morse has no lowercase, and neither does the log: let the on-screen
      // keyboard open in caps where that hint is honoured.
      autocapitalize: "characters",
      autocomplete: "off",
      spellcheck: "false",
    },
  });
  input.value = session.draft;
  input.title = "Enter 发送；输入自动转大写";

  // Caps, not just the *look* of caps: `text-transform: uppercase` would leave
  // the value lowercase, so the draft, the log and the parser would all see
  // lower-case callsigns. Converting the value keeps one spelling everywhere.
  //
  // Translating in an `input` handler means writing to the box while the
  // browser is mid-edit, so the caret is put back where it was (1:1 for ASCII)
  // and IME composition is left alone until it commits — rewriting the value
  // mid-composition cancels the candidate list.
  let composing = false;
  const uppercase = (): void => {
    const before = input.value;
    const next = before.toUpperCase();
    if (next === before) return;
    const caret = input.selectionStart ?? before.length;
    input.value = next;
    const at = next.length === before.length ? caret : next.length;
    input.setSelectionRange(at, at);
  };
  input.addEventListener("compositionstart", () => {
    composing = true;
  });
  input.addEventListener("compositionend", () => {
    composing = false;
    uppercase();
    session.setDraft(input.value);
  });
  input.addEventListener("input", () => {
    if (!composing) uppercase();
    session.setDraft(input.value);
  });

  const sendBtn = button("发送", () => send(), "btn primary");

  /**
   * Put the caret back in the send box after a re-render.
   *
   * The bar is rebuilt on every refresh, so the browser's focus goes with the
   * old element. The operator keys one over after another, so the box has to
   * stay ready: same text, caret at the end, still focused. The lookup goes
   * through the bar's owner rather than the element we just built, because the
   * one on screen is now a different node.
   */
  const refocus = (): void => {
    const scope: ParentNode = host.sendBar ?? document;
    const next = scope.querySelector<HTMLInputElement>(".send-input");
    if (!next) return;
    next.focus();
    const end = next.value.length;
    next.setSelectionRange(end, end);
  };

  const send = (): void => {
    const text = input.value.trim();
    if (!text || session.isSending) return;
    session.setDraft("");
    input.value = "";
    sendBtn.disabled = true;
    input.focus();
    void (async () => {
      try {
        await session.userSend(text);
        await flushLog();
      } finally {
        sendBtn.disabled = false;
      }
      host.refresh();
      refocus();
    })();
  };

  // Enter sends. The over is a single line of CW, so there is nothing a
  // newline could mean here — every Enter is a send, with or without modifiers.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      send();
    }
  });

  bar.append(input, sendBtn);
}

/** Straight key / paddles: key the over live, no send box. */
function renderLiveKeyPanel(
  host: AppHost,
  root: HTMLElement,
  warnings: HTMLElement[],
  flushLog: () => Promise<void>,
): void {
  const session = host.session;

  const keyPanel = renderKeyPanel({
    settings: host.settings,
    onLeave: (fn) => host.onLeave(fn),
    onBegin: () => session.beginLiveKeying(),
    onKeying: (on) => (on ? session.liveKeyDown() : session.liveKeyUp()),
    onOver: (text) => {
      void (async () => {
        await session.finishLiveKeying(text);
        await flushLog();
        host.refresh();
      })();
    },
  });

  if (warnings.length) root.append(panel("提示", ...warnings));
  // No card around the key pad: it is a control surface, not a form, and the
  // box only stood between the dial and the display. No caption under it
  // either — how the rig behaves is something the RX/TX badge and the meter
  // already say, and a paragraph there only pushed the panadapter down.
  root.append(
    el("h2", { class: "key-head", text: keyPanel.title }),
    keyPanel.node,
  );
}
