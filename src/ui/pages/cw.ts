import { button, el, panel } from "../dom.js";
import { addLog } from "../storage/logStore.js";
import type { AppHost } from "../app.js";
import { renderKeyPanel } from "./keyPanel.js";

const STATE_LABEL: Record<string, string> = {
  IDLE: "空闲",
  USER_CQ: "等待应答（我已发 CQ）",
  PEER_CQ: "对方正在呼叫 CQ",
  EXCHANGE: "交换信息中",
  SIGNOFF: "结束流程中",
  LOGGED: "已完成并记录",
  FAILED: "通联失败",
};

/**
 * The QSO operating panel: status / send / keying / log.
 *
 * There is deliberately **no transcript**, and no station is named. The
 * conversation is on the air: the operator copies what the other station sends
 * and writes back what they heard. Echoing every message on screen would turn
 * the exercise into reading, and labelling the other station would hand over
 * the callsign that copying is supposed to produce.
 *
 * The tuning note stays, because it is about the *receiver* (are you on
 * frequency?), not about what was said.
 */
export function renderQsoPanel(host: AppHost, root: HTMLElement): void {
  const session = host.session;
  const settings = host.settings;

  // --- status --------------------------------------------------------------
  const status = el("div", { class: "row" });
  status.append(
    el("span", { class: "badge", text: STATE_LABEL[session.state] ?? session.state }),
  );
  // The note the partner is actually heard at. Zero-beaten it is the rig's
  // pitch; off-frequency it is shifted by the detuning (see ham/tuning), signed
  // by the receiving sideband (CW-L / CW-U). Outside the passband the filter's
  // skirt keeps it audible for a while — quieter and quieter — and then it is
  // gone. Worth saying out loud in both cases.
  const halfHz = session.passbandHalfHz;
  const detune = session.partnerDetuneHz();
  if (detune !== null) {
    const off = detune > 0 ? `+${detune}` : `${detune}`;
    if (!session.partnerInPassband()) {
      const weak = session.partnerGain() !== null;
      status.append(
        el("span", {
          class: "hint tone-off",
          text: weak
            ? `对方在通带外（偏 ${off} Hz）· 信号很弱，调回 ±${halfHz} Hz`
            : `对方已在滤波器之外（偏 ${off} Hz）· 没有声音了`,
        }),
      );
    } else {
      const heard = session.partnerToneHz() ?? settings.toneHz;
      status.append(
        el("span", {
          class: Math.abs(detune) >= 50 ? "hint tone-off" : "hint",
          text:
            Math.abs(detune) >= 50
              ? `音调 ${heard} Hz · 偏频 ${off} Hz`
              : `音调 ${heard} Hz`,
        }),
      );
    }
  }

  // --- pile-up: several stations answered the CQ at once --------------------
  // Only the count is shown. Which stations they are is on the air, and naming
  // one is the operator's job — see the hint under the send box.
  const pileupCallers = session.pileupCallers();
  if (pileupCallers.length > 0) {
    status.append(
      el("span", { class: "badge", text: `${pileupCallers.length} 台同时应答` }),
    );
  }

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
    panel("通联状态", status),
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
