import { button, el, panel } from "../dom.js";
import { BANDS, FREQ_STEP_MHZ, clampToBand, roundFreq } from "../bands.js";
import { formatFreqMHz } from "../logRecord.js";
import type { AppHost } from "../app.js";

/** What each HAM on the band is doing right now. */
const ACTIVITY_LABEL: Record<string, string> = {
  listening: "守听",
  cqing: "呼叫 CQ 中",
  inQso: "通联中",
};

/** Frequency page: band switching, tuning, signal strength and band activity. */
export function renderFrequency(host: AppHost, root: HTMLElement): void {
  const bandIndex = Math.min(Math.max(host.settings.bandIndex, 0), BANDS.length - 1);
  const band = BANDS[bandIndex];

  const tabs = el("div", { class: "band-tabs" });
  BANDS.forEach((b, i) => {
    tabs.append(
      button(
        b.label,
        () => host.updateSettings({ bandIndex: i, freqMHz: b.defaultMHz }),
        i === bandIndex ? "btn active" : "btn",
      ),
    );
  });

  const display = el("div", {
    class: "freq-display",
    text: `${formatFreqMHz(host.settings.freqMHz)} MHz`,
  });

  const step = (delta: number): void => {
    const next = roundFreq(clampToBand(host.settings.freqMHz + delta, band));
    host.updateSettings({ freqMHz: next });
  };

  const tuning = el("div", { class: "row" });
  tuning.append(
    button("− 1 kHz", () => step(-FREQ_STEP_MHZ)),
    button("+ 1 kHz", () => step(FREQ_STEP_MHZ)),
  );

  const roster = host.session.hamActivity();
  const level = roster.length === 0 ? 0 : Math.min(5, 2 + roster.length);
  const signal = el("div", { class: "signal" });
  for (let i = 0; i < 5; i += 1) signal.append(el("i", { class: i < level ? "on" : "" }));

  const signalRow = el("div", { class: "row" });
  signalRow.append(el("span", { class: "hint", text: "信号强度" }), signal);

  const activity = el("div", { class: "col" });
  if (roster.length === 0) {
    activity.append(el("div", { class: "hint", text: "当前频率没有活动" }));
  } else {
    for (const entry of roster) {
      const line = el("div", { class: "row" });
      line.append(el("span", { text: entry.ham.call }));
      line.append(el("span", { class: "badge", text: ACTIVITY_LABEL[entry.state] ?? entry.state }));
      line.append(el("span", { class: "hint", text: `发送 RST ${entry.ham.report}` }));
      activity.append(line);
    }
  }

  const actions = el("div", { class: "row" });
  actions.append(
    button(
      "监听：等 HAM 发 CQ",
      () => {
        void host.session.hamCallsCq().then(() => host.go("cw"));
      },
      "btn primary",
    ),
    button("我发 CQ", () => {
      void host.session.userCallsCq().then(() => host.go("cw"));
    }),
  );

  const hint = host.settings.myCall
    ? "选择一种方式开始通联，随后会跳转到 CW 翻译界面。"
    : "请先在「设置」页面填写本方呼号，再开始通联。";

  root.append(
    panel("频段", tabs),
    panel("频率", display, tuning),
    panel("信号与活动", signalRow, activity),
    panel("开始通联", actions, el("div", { class: "hint", text: hint })),
  );
}
