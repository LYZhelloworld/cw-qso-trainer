import { button, el } from "../dom.js";
import { IambicKeyerInput, StraightKeyer } from "../keyer.js";
import { Sidetone } from "../../audio/sidetone.js";
import type { Paddle } from "../../cw/keyer.js";
import type { AppSettings } from "../settingsSchema.js";

/**
 * The keying panel: straight key or iambic paddles, plus the operator's own
 * sidetone.
 *
 * Split out of the QSO panel (`cw.ts`) because it is a self-contained input
 * device — it owns document-level key listeners, a keyer, an oscillator and an
 * element echo, and it talks to the rest of the page through two callbacks. The
 * QSO panel above it is about the conversation; this is about the key.
 */

export interface KeyPanelOptions {
  settings: AppSettings;
  /** Register a cleanup run before the next render (listeners, oscillator). */
  onLeave(fn: () => void): void;
  /** Iambic: one finished character, or `" "` on a word break. Appended as-is. */
  onCharacter(text: string): void;
  /** Straight key: everything keyed since the last pause, decoded at once. */
  onPhrase(text: string): void;
}

export interface KeyPanelView {
  /** Panel heading — which kind of key this panel is wired to. */
  title: string;
  node: HTMLElement;
}

export function renderKeyPanel(opts: KeyPanelOptions): KeyPanelView {
  const { settings, onLeave } = opts;
  const useIambic = settings.keyMode === "iambic";

  const keySymbols = el("div", { class: "hint", text: "" });
  const keyArea = el("div", { class: "key-area" });

  // Characters arrive one by one when keying, so they are appended as-is.
  const appendKeyed = (text: string): void => opts.onCharacter(text);

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
    onLeave(() => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      iambic.clear();
      sidetone.dispose();
    });
    return { title: "电键输入（iambic 双桨）", node: keyArea };
  }

  const keyer = new StraightKeyer(
    (text) => {
      opts.onPhrase(text);
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
  onLeave(() => {
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("keyup", onKeyUp);
    keyer.clear();
    sidetone.dispose();
  });
  return { title: "电键输入（直键）", node: keyArea };
}

/** Keys pressed inside a text field belong to the field, not to the rig. */
function isTextField(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  return !!node && (node.tagName === "INPUT" || node.tagName === "TEXTAREA");
}
