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
    renderTextPanel(host, root, warnings, flushLog);
    return;
  }
  renderLiveKeyPanel(host, root, warnings, flushLog);
}

/** Text mode: type the message, the rig keys it out. */
function renderTextPanel(
  host: AppHost,
  root: HTMLElement,
  warnings: HTMLElement[],
  flushLog: () => Promise<void>,
): void {
  const session = host.session;

  const input = el("textarea", {
    attrs: {
      placeholder: "把你抄到的内容发出去，例如 R UR RST 599 BK",
      // Morse has no lowercase, and neither does the log: let the on-screen
      // keyboard open in caps where that hint is honoured.
      autocapitalize: "characters",
      autocomplete: "off",
      spellcheck: "false",
    },
  });
  input.value = session.draft;

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
   * The send box is a fresh element every render, so the browser's focus goes
   * with the old one. The operator keys one over after another, so the box has
   * to stay ready: same text, caret at the end, still focused. If the page is
   * no longer the radio page there is no box to find and nothing is stolen.
   */
  const keepFocus = (): void => {
    const next = root.querySelector<HTMLTextAreaElement>("textarea");
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
      keepFocus();
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

  root.append(
    panel(
      "发送",
      ...warnings,
      input,
      el("div", { class: "row" }, [sendBtn]),
      el("div", {
        class: "hint",
        text: "Enter 发送，输入自动转大写，发完光标仍在框内。发送时接收中断；发完稍等片刻恢复收听。",
      }),
    ),
  );
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

  root.append(
    panel(keyPanel.title, ...warnings, keyPanel.node),
    el("div", {
      class: "hint",
      text: "按键即上机：发射期间接收中断，松键、停顿后恢复收听。",
    }),
  );
}
