import { button, el, panel } from "../dom.js";
import { dxccDatabase } from "../../data/dxcc.js";
import { PASSBAND_HZ, PASSBAND_OPTIONS } from "../../ham/tuning.js";
import { CQ_ZONE_MAX, SERIAL_MAX, SERIAL_MIN, ownZone } from "../../qso/contest.js";
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

/** Labelled `<select>`: `[value, text]` pairs in, committed value out. */
function selectRow<T extends string>(
  label: string,
  options: ReadonlyArray<readonly [T, string]>,
  value: string,
  onCommit: (value: T) => void,
): HTMLLabelElement {
  const select = el("select");
  for (const [optionValue, text] of options) {
    const opt = el("option", { attrs: { value: optionValue } });
    opt.textContent = text;
    select.append(opt);
  }
  select.value = value;
  select.addEventListener("change", () => onCommit(select.value as T));
  const wrap = el("label", { class: "field" });
  wrap.append(document.createTextNode(label), select);
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

/**
 * The settings body, returned as a standalone element so the app can drop it
 * into the gear's modal sheet (it used to be a full page of its own).
 */
export function renderSettingsPanel(host: AppHost): HTMLElement {
  const s = host.settings;
  const root = el("div", { class: "settings-body" });

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
  const diffField = selectRow(
    "难度等级",
    (Object.keys(DIFFICULTY_LABEL) as UiDifficulty[]).map((d) => [d, DIFFICULTY_LABEL[d]] as const),
    s.difficulty,
    (difficulty) => host.updateSettings({ difficulty }),
  );

  // --- send mode -----------------------------------------------------------
  // Three mutually exclusive ways to put a message on the air. The operating
  // panel shows only the one that is selected (see `pages/cw`). Listed in the
  // order the operator meets them: the message mode first (it is the default),
  // then the two hand keys.
  const keyModeField = selectRow<KeyMode>(
    "发报模式",
    [
      ["text", "报文（打字输入，按发送键发出）"],
      ["straight", "直键（手键，实时发报）"],
      ["iambic", "双键（iambic 自动键，实时发报）"],
    ],
    s.keyMode,
    (keyMode) => host.updateSettings({ keyMode }),
  );

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
  const iambicField = selectRow<IambicMode>(
    "iambic 模式",
    [
      ["A", "模式 A（松开双桨即停）"],
      ["B", "模式 B（松开双桨补发记忆元素）"],
    ],
    s.iambicMode,
    (iambicMode) => host.updateSettings({ iambicMode }),
  );

  // --- contest exchanges ----------------------------------------------------
  // The two numbers a contest puts on the air. Neither is typed during a
  // contact: the zone is where we are, the serial is how many contacts we have
  // already logged, so both live here and both are shown on the entry row.
  const zoneField = numberRow("CQ 分区（0 = 按呼号自动）", s.cqZone, 0, CQ_ZONE_MAX, (n) =>
    host.updateSettings({ cqZone: n }),
  );
  const serialField = numberRow("WPX 下一条序号", s.wpxSerial, SERIAL_MIN, SERIAL_MAX, (n) =>
    host.updateSettings({ wpxSerial: n }),
  );

  // --- receiver filter width ----------------------------------------------
  // A narrower filter is harder to stay inside, so this is also a difficulty
  // dial: 500 Hz is forgiving, 100 Hz demands you park on the signal.
  const passbandField = selectRow(
    "接收滤波带宽",
    PASSBAND_OPTIONS.map(
      (hz) => [`${hz}`, hz === PASSBAND_HZ ? `${hz} Hz（默认）` : `${hz} Hz`] as const,
    ),
    String(s.passbandHz),
    (value) => host.updateSettings({ passbandHz: Number(value) }),
  );

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
      "CW 接收",
      passbandField,
      el("div", {
        class: "hint",
        text: "通带以拨轮频率为中心；带宽越窄，离信号越远就越听不到——500 Hz 最宽松，100 Hz 要求正好停在信号上。带宽不影响通联记录（始终记为 CW）。",
      }),
      el("div", {
        class: "hint",
        text: "边带（CW-L / CW-U）不在这里设：它跟着波段走，在电台面板上点一下模式标签就能改，每个波段各记各的。",
      }),
    ),
    panel(
      "通联",
      diffField,
      el("div", {
        class: "hint",
        text: "难度决定底噪、衰落与干扰，以及对方抄不清你报文的概率。",
      }),
    ),
    panel(
      "比赛",
      zoneField,
      el("div", {
        class: "hint",
        text: `CQWW 里发给对方的就是这个分区：现在会发 ${ownZone(
          s.cqZone,
          s.myCall,
        )} 区（补成两位，5 区发 05）。填 0 表示按本方呼号自动推断。`,
      }),
      serialField,
      el("div", {
        class: "hint",
        text: "WPX 的序号每记录一条日志加一，补成三位（第一条就是 001）。这里可以改，也可以退回去重来。",
      }),
      button("序号回到 1", () => host.updateSettings({ wpxSerial: SERIAL_MIN }), "btn small"),
      el("div", {
        class: "hint",
        text: "通联模式（DX / CQWW / WPX）在电台机头切。三种模式各自一本日志，互不混淆。",
      }),
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
              text: "同时按下点键与划键为 squeeze（点划交替）；词与词之间停久一点（约 7 个点长）就是空格。",
            }),
          ]
        : s.keyMode === "straight"
          ? [
              straightBtn,
              el("div", {
                class: "hint",
                text: "按住该键实时发报、松开停止，点划时长完全由你控制。",
              }),
            ]
          : [
              el("div", {
                class: "hint",
                text: "报文模式不使用电键：在操作面板输入报文，按「发送」由电台按当前速度自动拍发。",
              }),
            ]),
    ),
    panel("其他", button("恢复默认设置", () => host.updateSettings(DEFAULT_SETTINGS), "btn danger")),
  );
  return root;
}
