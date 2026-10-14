import { button, el, panel } from "../dom.js";
import { dxccDatabase } from "../../data/dxcc.js";
import {
  DEFAULT_SETTINGS,
  SIDETONE_MAX,
  SIDETONE_MIN,
  TONE_MAX,
  TONE_MIN,
  WPM_MAX,
  WPM_MIN,
  validateCallsign,
  type IambicMode,
  type KeyMode,
  type UiDifficulty,
} from "../settingsSchema.js";
import type { AppHost } from "../app.js";

const DIFFICULTY_LABEL: Record<UiDifficulty, string> = {
  novice: "新手（无干扰，接收不全 0%）",
  intermediate: "进阶（慢衰落、偶发干扰，1%）",
  hardcore: "硬核（快衰落、干扰较多，5%）",
};

function numberRow(
  label: string,
  value: number,
  min: number,
  max: number,
  onCommit: (n: number) => void,
): HTMLLabelElement {
  const input = el("input", { attrs: { type: "number", min: String(min), max: String(max) } });
  input.value = String(value);
  input.addEventListener("change", () => onCommit(Number(input.value)));
  const wrap = el("label", { class: "field" });
  wrap.append(document.createTextNode(label), input);
  return wrap;
}

function checkRow(
  label: string,
  checked: boolean,
  onCommit: (value: boolean) => void,
): HTMLLabelElement {
  const box = el("input", { attrs: { type: "checkbox" } });
  box.checked = checked;
  box.addEventListener("change", () => onCommit(box.checked));
  const wrap = el("label", { class: "row" });
  wrap.style.gap = "6px";
  wrap.append(box, document.createTextNode(label));
  return wrap;
}

/** Button that captures the next key press and reports its `KeyboardEvent.code`. */
function keyCaptureButton(
  label: string,
  current: string,
  host: AppHost,
  onPick: (code: string) => void,
): HTMLElement {
  const btn = button(`${label}：${current}（点击后按下要使用的键）`, () => {
    btn.textContent = "请按下要使用的按键…";
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      document.removeEventListener("keydown", onKey, true);
      onPick(e.code);
    };
    document.addEventListener("keydown", onKey, true);
    host.onLeave(() => document.removeEventListener("keydown", onKey, true));
  });
  return btn;
}

export function renderSettings(host: AppHost, root: HTMLElement): void {
  const s = host.settings;

  // --- identity ------------------------------------------------------------
  const callInput = el("input", { attrs: { type: "text" } });
  callInput.value = s.myCall;
  const callMsg = el("div", { class: "hint" });
  const refreshCallMsg = (): void => {
    const check = validateCallsign(callInput.value, (p) => dxccDatabase.isValidPrefix(p));
    callMsg.className =
      check.level === "error" ? "err" : check.level === "warn" ? "hint" : "ok-text";
    callMsg.textContent = check.message;
  };
  refreshCallMsg();
  // Validate live, but only commit on blur so typing is not interrupted.
  callInput.addEventListener("input", refreshCallMsg);
  callInput.addEventListener("change", () => host.updateSettings({ myCall: callInput.value }));
  const callField = el("label", { class: "field" });
  callField.append(document.createTextNode("本方呼号"), callInput, callMsg);

  // --- difficulty ----------------------------------------------------------
  const diffSelect = el("select");
  for (const d of ["novice", "intermediate", "hardcore"] as const) {
    const opt = el("option", { attrs: { value: d } });
    opt.textContent = DIFFICULTY_LABEL[d];
    diffSelect.append(opt);
  }
  diffSelect.value = s.difficulty;
  diffSelect.addEventListener("change", () =>
    host.updateSettings({ difficulty: diffSelect.value as UiDifficulty }),
  );
  const diffField = el("label", { class: "field" });
  diffField.append(document.createTextNode("难度等级"), diffSelect);

  // --- key mode ------------------------------------------------------------
  const keyModeSelect = el("select");
  for (const m of ["straight", "iambic"] as const) {
    const opt = el("option", { attrs: { value: m } });
    opt.textContent = m === "straight" ? "直键（手键，手动控制点划）" : "iambic 双桨（自动键）";
    keyModeSelect.append(opt);
  }
  keyModeSelect.value = s.keyMode;
  keyModeSelect.addEventListener("change", () =>
    host.updateSettings({ keyMode: keyModeSelect.value as KeyMode }),
  );
  const keyModeField = el("label", { class: "field" });
  keyModeField.append(document.createTextNode("电键类型"), keyModeSelect);

  // --- key bindings --------------------------------------------------------
  const straightBtn = keyCaptureButton("直键按键", s.keyCode, host, (code) =>
    host.updateSettings({ keyCode: code }),
  );
  const dotBtn = keyCaptureButton("点键", s.dotCode, host, (code) =>
    host.updateSettings({ dotCode: code }),
  );
  const dashBtn = keyCaptureButton("划键", s.dashCode, host, (code) =>
    host.updateSettings({ dashCode: code }),
  );

  // --- iambic mode ---------------------------------------------------------
  const iambicSelect = el("select");
  for (const m of ["A", "B"] as const) {
    const opt = el("option", { attrs: { value: m } });
    opt.textContent =
      m === "A" ? "模式 A（松开双桨即停）" : "模式 B（松开双桨补发记忆元素）";
    iambicSelect.append(opt);
  }
  iambicSelect.value = s.iambicMode;
  iambicSelect.addEventListener("change", () =>
    host.updateSettings({ iambicMode: iambicSelect.value as IambicMode }),
  );
  const iambicField = el("label", { class: "field" });
  iambicField.append(document.createTextNode("iambic 模式"), iambicSelect);

  root.append(
    panel("身份", callField),
    panel(
      "音频与速度",
      numberRow("CW 音调 (Hz)", s.toneHz, TONE_MIN, TONE_MAX, (n) =>
        host.updateSettings({ toneHz: n }),
      ),
      numberRow("速度 WPM", s.wpm, WPM_MIN, WPM_MAX, (n) => host.updateSettings({ wpm: n })),
      checkRow("启用 Farnsworth（拉长间隔）", s.farnsworthEnabled, (v) =>
        host.updateSettings({ farnsworthEnabled: v }),
      ),
      numberRow("Farnsworth 速度 WPM", s.farnsworthWpm, WPM_MIN, s.wpm, (n) =>
        host.updateSettings({ farnsworthWpm: n }),
      ),
      checkRow("发报侧音（电键输入时听到自己的音调）", s.sidetone, (v) =>
        host.updateSettings({ sidetone: v }),
      ),
      numberRow("侧音音量 (%)", s.sidetoneVolume, SIDETONE_MIN, SIDETONE_MAX, (n) =>
        host.updateSettings({ sidetoneVolume: n }),
      ),
      el("div", {
        class: "hint",
        text: "侧音是电台监听音，不受难度档的衰落与干扰影响；浏览器可能要求先点击页面才允许发声。",
      }),
    ),
    panel(
      "通联",
      diffField,
      checkRow("辅助模式（默认）", s.assistMode, (v) => host.updateSettings({ assistMode: v })),
      el("div", { class: "hint", text: "辅助模式也可在 CW 翻译页面随时开关。" }),
    ),
    panel(
      "键位",
      keyModeField,
      ...(s.keyMode === "iambic"
        ? [
            dotBtn,
            dashBtn,
            iambicField,
            el("div", {
              class: "hint",
              text: "同时按下点键与划键为 squeeze（点划交替），空格键插入单词间隔。",
            }),
          ]
        : [
            straightBtn,
            el("div", {
              class: "hint",
              text: "按住该键发报、松开停止，点划时长完全由你控制。",
            }),
          ]),
    ),
    panel("其他", button("恢复默认设置", () => host.updateSettings(DEFAULT_SETTINGS), "btn danger")),
  );
}
