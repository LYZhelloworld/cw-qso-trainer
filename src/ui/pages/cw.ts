import { button, el, panel } from "../dom.js";
import { addLog } from "../storage/logStore.js";
import type { AppHost } from "../app.js";
import { renderKeyPanel } from "./keyPanel.js";

/**
 * The operating panel: a send box and a key. Nothing else.
 *
 * There is deliberately no transcript, no station named, no status readout, no
 * "start a QSO" button and no list of who is answering. The operator transmits
 * whenever they want to; what the band does about it is up to the band. A real
 * station shows none of that either — you find out by listening.
 */
export function renderQsoPanel(host: AppHost, root: HTMLElement): void {
  const session = host.session;
  const settings = host.settings;

  // --- send box ------------------------------------------------------------
  const input = el("textarea", {
    attrs: { placeholder: "把你抄到的内容发出去，例如 R UR RST 599 BK" },
  });
  input.value = session.draft;
  input.addEventListener("input", () => {
    session.setDraft(input.value);
  });
  /** Keep both sides in sync so a re-render restores what the user was typing. */
  const setDraft = (text: string): void => {
    session.setDraft(text);
    input.value = text;
  };

  const flushLog = async (): Promise<void> => {
    const record = session.pendingLog();
    if (!record) return;
    await addLog(record);
    session.markLogged();
    session.note("通联完成，已写入日志");
  };

  const sendBtn = button("发送", () => send(), "btn primary");
  const send = (): void => {
    const text = input.value.trim();
    if (!text || session.isSending) return;
    setDraft("");
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

  // --- key input: straight key or iambic paddles ---------------------------
  // The key itself (listeners, keyer, sidetone) is a device of its own — see
  // `keyPanel`. All it gives back is text.
  const keyPanel = renderKeyPanel({
    settings,
    onLeave: (fn) => host.onLeave(fn),
    onCharacter: (text) => setDraft(input.value + text),
    onPhrase: (text) => setDraft(input.value ? `${input.value} ${text}` : text),
  });

  const body: HTMLElement[] = [];
  // Without a callsign your own CQ is not your callsign, and the log would lie.
  if (!settings.myCall) {
    const warn = el("div", { class: "hint" });
    warn.append(document.createTextNode("请先填写本方呼号："));
    warn.append(button("打开设置", () => host.openSettings?.(), "btn small"));
    body.push(warn);
  }
  body.push(
    input,
    el("div", { class: "row" }, [sendBtn]),
    el("div", {
      class: "hint",
      text: "Ctrl+Enter 也可发送。发送时接收中断；发完稍等片刻恢复收听。",
    }),
  );

  root.append(panel("发送", ...body), panel(keyPanel.title, keyPanel.node));
}
