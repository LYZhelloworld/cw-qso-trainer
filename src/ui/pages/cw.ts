import { button, clear, el, panel } from "../dom.js";
import { IambicKeyerInput, StraightKeyer } from "../keyer.js";
import { Sidetone } from "../../audio/sidetone.js";
import type { Paddle } from "../../cw/keyer.js";
import { addLog } from "../storage/logStore.js";
import type { TranscriptLine } from "../session.js";
import type { AppHost } from "../app.js";

/** Lines the user chose to reveal while assist mode is off (per-session). */
const revealed = new WeakSet<TranscriptLine>();

function maskText(text: string): string {
  return text.replace(/\S/g, "█");
}

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
 * The QSO operating panel (status / transcript / send / keying). Rendered by the
 * radio page once the user has a partner; it appends its panels to `root`.
 */
export function renderQsoPanel(host: AppHost, root: HTMLElement): void {
  const session = host.session;
  const settings = host.settings;

  // --- assist mode ---------------------------------------------------------
  const assistBox = el("input", { attrs: { type: "checkbox" } });
  assistBox.checked = settings.assistMode;
  assistBox.addEventListener("change", () =>
    host.updateSettings({ assistMode: assistBox.checked }),
  );
  const assistLabel = el("label", { class: "row" });
  assistLabel.append(assistBox, document.createTextNode("辅助模式（直接显示对方原文）"));

  // --- status --------------------------------------------------------------
  const ctx = session.machine?.getContext();
  const status = el("div", { class: "row" });
  status.append(
    el("span", { class: "badge", text: STATE_LABEL[session.state] ?? session.state }),
  );
  if (session.ham) status.append(el("span", { class: "hint", text: `对方 ${session.ham.call}` }));
  // The note the partner is actually heard at. Zero-beaten it is the rig's pitch;
  // off-frequency it is shifted by the detuning (see ham/tuning), signed by the
  // receiving sideband (CW-L / CW-U), which is what the operator's ear is
  // supposed to notice. Beyond the passband edge the filter cuts the station off
  // entirely — that is worth saying out loud, because the transcript keeps
  // running while the audio goes silent.
  const halfHz = session.passbandHalfHz;
  const detune = session.partnerDetuneHz();
  if (detune !== null) {
    const off = detune > 0 ? `+${detune}` : `${detune}`;
    if (!session.partnerInPassband()) {
      status.append(
        el("span", {
          class: "hint tone-off",
          text: `对方已在通带之外（偏 ${off} Hz）· 调回 ±${halfHz} Hz 才听得到`,
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
  if (ctx?.rstRx) status.append(el("span", { class: "hint", text: `收 ${ctx.rstRx}` }));
  if (ctx?.rstTx) status.append(el("span", { class: "hint", text: `发 ${ctx.rstTx}` }));

  // --- transcript ----------------------------------------------------------
  const pane = el("div", { class: "cw-pane" });
  /**
   * Redraws only the transcript, leaving the send box and its draft untouched.
   * Runs on every appended line, so the user's own transmission shows up the
   * instant it is sent instead of after the HAM's delayed reply.
   */
  const renderTranscript = (): void => {
    clear(pane);
    if (session.lines.length === 0) {
      pane.append(el("div", { class: "hint", text: "尚无通联内容。" }));
      return;
    }
    for (const line of session.lines) {
      const row = el("div", { class: `cw-line ${line.who}` });
      const who = line.who === "me" ? "我" : line.who === "ham" ? "对方" : "系统";
      row.append(el("span", { class: "who", text: who }));
      const hidden = line.who === "ham" && !settings.assistMode && !revealed.has(line);
      if (hidden) {
        row.append(el("span", { class: "txt masked", text: maskText(line.text) }));
        row.append(
          button("显示", () => {
            revealed.add(line);
            renderTranscript();
          }, "btn small"),
        );
      } else {
        row.append(el("span", { class: "txt", text: line.text }));
      }
      pane.append(row);
    }
  };
  renderTranscript();
  session.setTranscriptListener(renderTranscript);

  // --- send box ------------------------------------------------------------
  const input = el("textarea", {
    attrs: { placeholder: "输入要发送的内容，例如 R UR RST 599 BK" },
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

  const my = settings.myCall || "BG7XXX";
  const peer = session.ham?.call ?? "";
  const macros = el("div", { class: "row" });
  const macroList: Array<[string, string]> = [
    ["应答 CQ", peer ? `${peer} DE ${my} K` : `${my} DE ${my} K`],
    ["RST 599", "R UR RST 599 BK"],
    ["收到", "R BK"],
    ["73 SK", "R TU 73 SK"],
  ];
  for (const [label, text] of macroList) {
    macros.append(button(label, () => { setDraft(text); }, "btn small"));
  }

  // --- key input: straight key or iambic paddles ---------------------------
  const keySymbols = el("div", { class: "hint", text: "" });
  const keyArea = el("div", { class: "key-area" });

  const isTextField = (target: EventTarget | null): boolean => {
    const node = target as HTMLElement | null;
    return !!node && (node.tagName === "INPUT" || node.tagName === "TEXTAREA");
  };

  /** Characters arrive one by one when keying, so they are appended as-is. */
  const appendKeyed = (text: string): void => {
    setDraft(input.value + text);
  };

  const useIambic = settings.keyMode === "iambic";

  // Sidetone: the operator's own monitor tone while keying. It follows the key
  // (straight) or the element phase (iambic) and is never affected by QSB/QRM.
  const sidetone = new Sidetone({
    enabled: settings.sidetone,
    volume: settings.sidetoneVolume / 100,
    freqHz: settings.toneHz,
  });
  const driveSidetone = (on: boolean): void => {
    if (on) sidetone.keyDown();
    else sidetone.keyUp();
  };
  const sidetoneHint = el("div", {
    class: "hint",
    text: !settings.sidetone
      ? "侧音：关（可在设置页开启）"
      : sidetone.available
        ? `侧音：开（${settings.toneHz} Hz，音量 ${settings.sidetoneVolume}%）`
        : "侧音：开，但当前环境没有可用的音频输出（仅影响发声，不影响发报）",
  });

  if (useIambic) {
    const iambic = new IambicKeyerInput({
      wpm: settings.wpm,
      mode: settings.iambicMode,
      onText: appendKeyed,
      onSymbols: (s) => {
        keySymbols.textContent = s ? `正在发：${s}` : "";
      },
      onKeying: driveSidetone,
    });

    keyArea.append(
      el("div", {
        text: `点键「${settings.dotCode}」/ 划键「${settings.dashCode}」，同时按下为 squeeze；空格分词（焦点在输入框时不生效）`,
      }),
      keySymbols,
      sidetoneHint,
      button("结束电键输入", () => { iambic.finish(); keySymbols.textContent = ""; }, "btn small"),
    );

    const paddleFor = (code: string): Paddle | null =>
      code === settings.dotCode ? "dot" : code === settings.dashCode ? "dash" : null;

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.repeat || isTextField(e.target)) return;
      const paddle = paddleFor(e.code);
      if (paddle) {
        e.preventDefault();
        iambic.press(paddle);
        keyArea.classList.add("active");
        return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        iambic.wordBreak();
      }
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (isTextField(e.target)) return;
      const paddle = paddleFor(e.code);
      if (!paddle) return;
      e.preventDefault();
      iambic.release(paddle);
      keyArea.classList.remove("active");
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    host.onLeave(() => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      iambic.clear();
      sidetone.dispose();
    });
  } else {
    const keyer = new StraightKeyer(
      (text) => {
        setDraft(input.value ? `${input.value} ${text}` : text);
          keySymbols.textContent = `已解码：${text}`;
      },
      1500,
      driveSidetone,
    );

    keyArea.append(
      el("div", { text: `按住「${settings.keyCode}」发报（焦点在输入框时不生效）` }),
      keySymbols,
      sidetoneHint,
      button("结束电键输入", () => { keyer.finish(); keySymbols.textContent = ""; }, "btn small"),
    );

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.code !== settings.keyCode || e.repeat || isTextField(e.target)) return;
      e.preventDefault();
      keyer.keyDown();
      keyArea.classList.add("active");
      keySymbols.textContent = keyer.currentSymbols();
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code !== settings.keyCode || isTextField(e.target)) return;
      e.preventDefault();
      keyer.keyUp();
      keyArea.classList.remove("active");
      keySymbols.textContent = keyer.currentSymbols();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    host.onLeave(() => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      keyer.clear();
      sidetone.dispose();
    });
  }

  // --- assemble ------------------------------------------------------------
  const banner = settings.assistMode
    ? el("div", {
        class: "assist-banner",
        text: "辅助模式开启：对方原文可见。关闭后才能有效练习抄收。",
      })
    : el("div", {
        class: "hint",
        text: "辅助模式关闭：对方内容需自行抄收，可点「显示」对照。",
      });

  const controls = el("div", { class: "row" });
  controls.append(
    button("新通联（结束当前）", () => host.newSession()),
  );

  root.append(
    panel("通联状态", banner, assistLabel, status),
    panel("收报 / 发报记录", pane),
    panel(
      "发送",
      input,
      macros,
      el("div", { class: "row" }, [sendBtn]),
      el("div", { class: "hint", text: "Ctrl+Enter 也可发送。发送内容会按设定速度播出 CW 音调。" }),
    ),
    panel(useIambic ? "电键输入（iambic 双桨）" : "电键输入（直键）", keyArea),
    panel("操作", controls),
  );

  host.onLeave(() => session.setTranscriptListener(null));
}
