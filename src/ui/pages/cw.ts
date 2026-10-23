import { button, el, panel } from "../dom.js";
import { addLog } from "../storage/logStore.js";
import type { AppHost } from "../app.js";
import { renderKeyPanel } from "./keyPanel.js";

/**
 * The operating panel — one of three mutually exclusive ways to transmit:
 *
 *  - **text**: type the message, press send, the rig keys it out at the
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
    attrs: { placeholder: "把你抄到的内容发出去，例如 R UR RST 599 BK" },
  });
  input.value = session.draft;
  input.addEventListener("input", () => {
    session.setDraft(input.value);
  });

  const sendBtn = button("发送", () => send(), "btn primary");
  const send = (): void => {
    const text = input.value.trim();
    if (!text || session.isSending) return;
    session.setDraft("");
    input.value = "";
    sendBtn.disabled = true;
    void (async () => {
      try {
        await session.userSend(text);
        await flushLog();
      } finally {
        sendBtn.disabled = false;
      }
      host.refresh();
    })();
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
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
        text: "Ctrl+Enter 也可发送。发送时接收中断；发完稍等片刻恢复收听。",
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
