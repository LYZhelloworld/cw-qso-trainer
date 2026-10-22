import { button, el, panel } from "../dom.js";
import {
  BANDS,
  FREQ_FINE_STEP_MHZ,
  FREQ_STEP_MHZ,
  clampToBand,
  roundFreq,
} from "../bands.js";
import { detuneHz, inPassband, passbandGain } from "../../ham/tuning.js";
import { BAND_SIGNAL_SPREAD_HZ, SPECTRUM_SPAN_HZ, inSpectrumWindow } from "../../ham/spectrum.js";
import { renderQsoPanel } from "./cw.js";
import type { AppHost } from "../app.js";

/**
 * What the operator can tell about a station on the band: whether it is calling
 * CQ, or not. A station working somebody else is deliberately indistinguishable
 * from one that is just listening — nobody can see another pair's QSO, and
 * there is no reason the display should know about it.
 */
function activityLabel(state: string): string {
  return state === "cqing" ? "呼叫 CQ 中" : "守听";
}

/**
 * How often the S-meter redraws. Fast enough to follow a signal's fade, slow
 * enough not to matter: a real needle does not jump, it drifts.
 */
const SMETER_TICK_MS = 150;

/**
 * The receiver's S-meter: nine units plus a dB-over-S9 readout, following the
 * strongest signal the filter is passing (see `ham/smeter`). It redraws on its
 * own timer — the needle drifts with each signal's slow QSB, which has nothing
 * to do with when the band's stations happen to call CQ — and the page-level
 * cleanup stops the timer whenever this view is thrown away.
 */
function renderSMeter(host: AppHost): HTMLElement {
  const row = el("div", { class: "row smeter" });
  row.append(el("span", { class: "hint smeter-label", text: "信号强度" }));

  const bar = el("div", { class: "signal" });
  const cells: HTMLElement[] = [];
  for (let unit = 1; unit <= 9; unit += 1) {
    // A stepped ladder, not equal bars: the scale rises towards S9 the way a
    // real meter's does, so a reading one unit higher is visibly higher.
    const cell = el("i", {});
    cell.style.height = `${5 + unit * 1.7}px`;
    cells.push(cell);
    bar.append(cell);
  }
  const readout = el("span", { class: "smeter-read", text: "—" });
  row.append(readout, bar);

  const draw = (): void => {
    const reading = host.session.sMeter();
    readout.textContent = reading?.label ?? "—";
    row.classList.toggle("quiet", reading === null);
    for (const [i, cell] of cells.entries()) {
      cell.classList.toggle("on", reading !== null && i < reading.s);
    }
    row.title =
      reading === null
        ? "滤波器里没有信号"
        : `信号 ${Math.round(reading.dbm)} dBm · ${reading.label}`;
  };
  draw();
  const timer = setInterval(draw, SMETER_TICK_MS);
  host.onLeave(() => clearInterval(timer));
  return row;
}

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
  tuning.append(
    button("− 1 kHz", () => step(-FREQ_STEP_MHZ)),
    button("+ 1 kHz", () => step(FREQ_STEP_MHZ)),
  );
  // Stations sit on a 1 kHz grid, so the coarse buttons land exactly on one.
  // The fine buttons are for working the passband edges — they are how the
  // pitch offset (and its 500 Hz limit) becomes something you can hear.
  const fineTuning = el("div", { class: "row" });
  fineTuning.append(
    button("− 100 Hz", () => step(-FREQ_FINE_STEP_MHZ), "btn small"),
    button("+ 100 Hz", () => step(FREQ_FINE_STEP_MHZ), "btn small"),
  );

  // The receiver's filter width is an operator choice (500 / 250 / 100 Hz);
  // what matters here is that it is centred on the dial and the coarse buttons
  // land exactly on the 1 kHz station grid.
  const halfHz = host.session.passbandHalfHz;
  root.append(
    panel(
      "波段与调谐",
      tabs,
      tuning,
      fineTuning,
      el("div", {
        class: "hint",
        text: `接收通带 ${halfHz * 2} Hz（±${halfHz} Hz），中心就是拨轮频率；电台间隔 1 kHz。`,
      }),
      el("div", {
        class: "hint",
        text: `台站散布在中心 ±${BAND_SIGNAL_SPREAD_HZ / 1000} kHz 的波段切片上，瀑布一次只看得到 ±${
          SPECTRUM_SPAN_HZ / 2000
        } kHz —— 调过去才会遇到新的台。`,
      }),
    ),
  );

  // --- already in a QSO: show the operating panel --------------------------
  if (host.session.inQso) {
    renderQsoPanel(host, root);
    return;
  }

  // --- band activity -------------------------------------------------------
  // Only what the panadapter is showing: the band slice is wider than the
  // waterfall window, so tuning on turns up stations that are not in this list
  // yet. That is the point — you find stations by tuning, not by reading a list.
  const roster = host.session
    .hamActivity()
    .filter((e) => inSpectrumWindow(e.ham.freqHz, host.session.dialHz));
  const dialHz = host.session.dialHz;
  const passbandHz = host.session.passbandHz;
  // The meter sits above the list because it is what the receiver is doing,
  // not something you read off the list: it follows the strongest signal the
  // filter passes, so it agrees with what the operator is hearing.
  const meter = renderSMeter(host);

  const audible = roster.filter((e) => inPassband(e.ham.freqHz, dialHz, passbandHz));

  const activity = el("div", { class: "col" });
  if (roster.length === 0) {
    activity.append(el("div", { class: "hint", text: "这个窗口里没有信号 · 调谐换一段看看" }));
  } else {
    for (const entry of roster) {
      const detune = detuneHz(entry.ham.freqHz, dialHz);
      const heard = inPassband(entry.ham.freqHz, dialHz, passbandHz);
      // Three states, not two: inside the passband, on the filter's skirt
      // (audible but too weak to work — see `ham/tuning`), and gone.
      const gain = passbandGain(entry.ham.freqHz, dialHz, passbandHz);
      const line = el("div", { class: "row" });
      line.append(el("span", { text: entry.ham.call }));
      line.append(el("span", { class: "badge", text: activityLabel(entry.state) }));
      line.append(
        el("span", {
          class: "hint",
          text: `${(entry.ham.freqHz / 1e6).toFixed(4)} MHz · ${detune > 0 ? "+" : ""}${detune} Hz`,
        }),
      );
      line.append(
        el("span", {
          class: heard ? "badge heard" : "hint tone-off",
          text: heard ? "通带内" : gain > 0 ? "裙边 · 很弱" : "听不到",
        }),
      );
      activity.append(line);
    }
  }
  if (audible.length === 0 && roster.length > 0) {
    activity.append(
      el("div", {
        class: "hint",
        text: `窗口里这 ${roster.length} 个信号都不在通带内（拨轮 ±${halfHz} Hz 内才能通联）。调谐或直接点频谱上的亮斑。`,
      }),
    );
  }
  root.append(panel("波段活动", meter, activity));

  // --- start a QSO ---------------------------------------------------------
  const nearest = host.session.nearestWorkableHam();
  const listen = (): void => {
    // Inside the passband: just let it call. Otherwise sweep to it first, the
    // way a search would — the operator hears the dial move and then the CQ.
    const heard = host.session.heardActiveHam();
    const target = heard ?? nearest;
    if (!target) return;
    if (!heard) host.updateSettings({ freqMHz: target.freqHz / 1e6 });
    void host.session.hamCallsCq(target).then(() => host.refresh());
  };

  const actions = el("div", { class: "row" });
  const listenBtn = button("监听：等 HAM 发 CQ", listen, "btn primary");
  listenBtn.disabled = nearest === null;
  const callBtn = button("我发 CQ", () => {
    void host.session.userCallsCq().then(() => host.refresh());
  });
  actions.append(listenBtn, callBtn);

  const start = el("div", { class: "col" });
  start.append(actions);
  if (!host.settings.myCall) {
    const warn = el("div", { class: "hint" });
    warn.append(document.createTextNode("请先填写本方呼号："));
    warn.append(button("打开设置", () => host.openSettings?.(), "btn small"));
    start.append(warn);
  } else if (nearest === null) {
    start.append(el("div", { class: "hint", text: "这个波段上暂时没有电台，稍等一会儿再看看。" }));
  } else if (host.session.heardActiveHam() !== null) {
    start.append(
      el("div", { class: "hint", text: "拨轮已经对准了一个信号，可以直接监听或应答。" }),
    );
  } else {
    start.append(
      el("div", {
        class: "hint",
        text: "监听会自动扫描到最近的电台；也可以自己用 ± 按钮或点频谱调谐。",
      }),
    );
  }
  root.append(panel("开始通联", start));
}
