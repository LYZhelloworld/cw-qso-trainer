import { button, el, panel } from "../dom.js";
import { BANDS, FREQ_STEP_MHZ, clampToBand, roundFreq } from "../bands.js";
import { renderQsoPanel } from "./cw.js";
import type { AppHost } from "../app.js";

/** What each HAM on the band is doing right now. */
const ACTIVITY_LABEL: Record<string, string> = {
  listening: "守听",
  cqing: "呼叫 CQ 中",
  inQso: "通联中",
};

/**
 * The main "radio" screen: band tuning and live activity, plus the QSO operating
 * panel (transcript / send / keying) once the user has a partner. The frequency
 * readout itself lives in the persistent rig header, so it is not repeated here.
 */
export function renderRadio(host: AppHost, root: HTMLElement): void {
  // Powered off: nothing to hear. Offer the power switch (also in the rig).
  if (host.powered === false) {
    const standby = el("div", { class: "standby" });
    standby.append(el("div", { class: "standby-icon", text: "⏻" }));
    standby.append(el("div", { class: "standby-title", text: "设备已关机" }));
    standby.append(
      el("div", { class: "hint", text: "开着电台就会开始接收这个频段上的信号。" }),
    );
    // The band did not go quiet just because we did: the other stations keep
    // calling CQ. Say so, so the environment model is visible and not a surprise.
    const active = host.session.hamActivity().length;
    if (active > 0) {
      standby.append(
        el("div", {
          class: "hint standby-alive",
          text: `本频段仍有 ${active} 个电台在活动（只是我们没在接收）。`,
        }),
      );
    }
    standby.append(
      button("开台", () => host.setPower?.(true), "btn primary"),
    );
    root.append(panel("待机", standby));
    return;
  }

  // --- band tuning ---------------------------------------------------------
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

  const step = (delta: number): void => {
    const next = roundFreq(clampToBand(host.settings.freqMHz + delta, band));
    host.updateSettings({ freqMHz: next });
  };
  const tuning = el("div", { class: "row" });
  tuning.append(button("− 1 kHz", () => step(-FREQ_STEP_MHZ)), button("+ 1 kHz", () => step(FREQ_STEP_MHZ)));

  root.append(panel("波段与调谐", tabs, tuning));

  // --- already in a QSO: show the operating panel --------------------------
  if (host.session.inQso) {
    renderQsoPanel(host, root);
    return;
  }

  // --- band activity -------------------------------------------------------
  const roster = host.session.hamActivity();
  // S-meter reading follows the strongest station on the band, so it agrees
  // with the brightness the waterfall gives that same signal.
  const strongest = roster.reduce((max, e) => Math.max(max, e.ham.strength ?? 0), 0);
  const level = roster.length === 0 ? 0 : Math.max(2, Math.min(5, Math.round(strongest * 5)));
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
  root.append(panel("波段活动", signalRow, activity));

  // --- start a QSO ---------------------------------------------------------
  const actions = el("div", { class: "row" });
  actions.append(
    button(
      "监听：等 HAM 发 CQ",
      () => {
        void host.session.hamCallsCq().then(() => host.refresh());
      },
      "btn primary",
    ),
    button("我发 CQ", () => {
      void host.session.userCallsCq().then(() => host.refresh());
    }),
  );

  const start = el("div", { class: "col" });
  start.append(actions);
  if (host.settings.myCall) {
    start.append(el("div", { class: "hint", text: "选择一种方式开始通联吧。" }));
  } else {
    const warn = el("div", { class: "hint" });
    warn.append(document.createTextNode("请先填写本方呼号："));
    warn.append(button("打开设置", () => host.openSettings?.(), "btn small"));
    start.append(warn);
  }
  root.append(panel("开始通联", start));
}
