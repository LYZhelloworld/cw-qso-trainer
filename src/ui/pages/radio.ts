import { button, el, panel } from "../dom.js";
import {
  BANDS,
  FREQ_FINE_STEP_MHZ,
  FREQ_STEP_MHZ,
  clampToBand,
  roundFreq,
} from "../bands.js";
import { BAND_SIGNAL_SPREAD_HZ, SPECTRUM_SPAN_HZ } from "../../ham/spectrum.js";
import { renderQsoPanel } from "./cw.js";
import type { AppHost } from "../app.js";

/**
 * How often the S-meter redraws. Fast enough to follow the key — the needle is
 * supposed to agree with what is coming out of the speaker, including the gaps
 * between dits — and slow enough not to burn a frame on it.
 */
const SMETER_TICK_MS = 60;

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
 * The main "radio" screen: band tuning and the receiver's own readouts, plus the
 * QSO operating panel (status / send / keying) once the user has a partner. The
 * frequency readout itself lives in the persistent rig header, so it is not
 * repeated here.
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

  // --- receiver ------------------------------------------------------------
  // The roster is deliberately not shown. Which station sits where, and what it
  // is called, is exactly what the operator has to find by tuning and copy by
  // ear — a list would turn the exercise into reading. The S-meter stays: it is
  // what the receiver itself reports, not a directory of the band.
  root.append(panel("接收机", renderSMeter(host)));

  // --- operating panel ------------------------------------------------------
  // Always there, from the moment the rig is on: an operator transmits whenever
  // they want to, not after clicking "start a QSO". Whether anybody answers is
  // up to what the message says and who is listening (see `userSend`).
  renderQsoPanel(host, root);
}
