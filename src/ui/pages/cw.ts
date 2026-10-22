import { button, el, panel } from "../dom.js";
import { addLog } from "../storage/logStore.js";
import type { AppHost } from "../app.js";
import { renderKeyPanel } from "./keyPanel.js";

/**
 * The QSO operating panel: send / keying / controls.
 *
 * There is deliberately **no transcript**, no station named, and no status
 * readout. The conversation is on the air: the operator copies what the other
 * station sends, writes back what they heard, and judges both by ear. Echoing
 * messages on screen would turn the exercise into reading; labelling the other
 * station would hand over the callsign copying is supposed to produce; and a
 * running commentary ("exchange in progress", "you are 180 Hz off") does the
 * same for the operator's own ears.
 *
 * What is left is what an operator physically does: type or key, and send.
 */
export function renderQsoPanel(host: AppHost, root: HTMLElement): void {
  const session = host.session;
  const settings = host.settings;

  // --- pile-up: several stations answered the CQ at once --------------------
  // Only the fact that a pile-up is running is said, and only where it changes
  // what to type. Which stations they are is on the air.
  const pileupCallers = session.pileupCallers();

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

  // Canned lines are protocol, not content: they say *what* to send, never who
  // to send it to or what was received. The callsign in an answer is the
  // operator's to copy.
  const my = settings.myCall || "BG7XXX";
  const macros = el("div", { class: "row" });
  const macroList: Array<[string, string]> = [
    ["我发 CQ", `CQ CQ CQ DE ${my} ${my} PSE K`],
    ["RST 599", "R UR RST 599 BK"],
    ["收到", "R BK"],
    ["73 SK", "R TU 73 SK"],
  ];
  for (const [label, text] of macroList) {
    macros.append(button(label, () => setDraft(text), "btn small"));
  }

  // --- key input: straight key or iambic paddles ---------------------------
  // The key itself (listeners, keyer, sidetone) is a device of its own — see
  // `keyPanel`. All it gives back is text.
  const keyPanel = renderKeyPanel({
    settings,
    onLeave: (fn) => host.onLeave(fn),
    onCharacter: (text) => setDraft(input.value + text),
    onPhrase: (text) => setDraft(input.value ? `${input.value} ${text}` : text),
  });

  const controls = el("div", { class: "row" });
  controls.append(button("新通联（结束当前）", () => host.newSession()));

  const pileupHint =
    pileupCallers.length > 0
      ? el("div", {
          class: "hint",
          text: "多台同时在呼：回复里必须点名，把你抄到的呼号写进报文，不点名谁也接不上。",
        })
      : null;

  root.append(
    panel(
      "发送",
      input,
      macros,
      ...(pileupHint ? [pileupHint] : []),
      el("div", { class: "row" }, [sendBtn]),
      el("div", { class: "hint", text: "Ctrl+Enter 也可发送。发送内容会按设定速度播出 CW 音调。" }),
    ),
    panel(keyPanel.title, keyPanel.node),
    panel("操作", controls),
  );
}
