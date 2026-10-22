import { button, clear, el } from "./dom.js";
import { BANDS } from "./bands.js";
import { formatFreqMHz } from "./logRecord.js";
import { SPECTRUM_SPAN_HZ } from "../ham/spectrum.js";
import { resolveSideband, sidebandLabel, type Sideband } from "../ham/tuning.js";
import type { AppSettings } from "./settingsSchema.js";

/**
 * The radio face: the persistent header (frequency, band, mode, power switch,
 * settings gear) plus the panadapter that sits under it.
 *
 * Extracted from the App shell because the App is about *navigation* — which
 * band, which page, which settings — while this file is about drawing a radio.
 * It owns its own DOM, including the canvas, which is built once and re-used
 * across every re-render: a canvas holds its picture in the element, so
 * rebuilding it would throw the whole waterfall history away.
 */

export interface RigFaceOptions {
  /** The power switch was flipped. */
  onPower(on: boolean): void;
  onOpenSettings(): void;
  /** The mode label was clicked: pin the other sideband. */
  onToggleSideband(current: Sideband): void;
}

/** What the face needs to draw the header. */
export interface RigView {
  settings: AppSettings;
  powered: boolean;
}

/** What the panadapter's overlay says, gathered by the App from the session. */
export interface ScopeView {
  powered: boolean;
  /** Receiver filter width, for the passband marking. */
  passbandHz: number;
  /** Signals inside the waterfall window (not the whole band slice). */
  signalsInWindow: number;
  /** Of those, how many the filter is actually passing. */
  audibleInPassband: number;
  /** Stations answering our CQ right now; 0 = not in a pile-up. */
  pileupCount: number;
}

export class RigFace {
  readonly root = el("div", { class: "rig" });
  /** The panadapter canvas. Created once; never detached on re-render. */
  readonly canvas = el("canvas", { class: "scope-canvas" });

  private readonly main = el("div", { class: "rig-main" });
  /**
   * The receiver's passband drawn on top of the waterfall: a band down the
   * middle as wide as the CW filter. It is always centred because the display
   * is drawn around the dial, and the filter is centred on the dial too.
   * Anything lit up outside it is on the band but *not* being received.
   */
  private readonly passband = el("div", { class: "scope-passband" });
  private readonly label = el("span", { class: "scope-label" });
  private readonly call = el("span", { class: "scope-call" });
  private readonly scope = el("div", { class: "rig-scope" }, [
    this.canvas,
    this.passband,
    this.label,
    this.call,
  ]);
  private mounted = false;

  constructor(private readonly opts: RigFaceOptions) {}

  /** Put the face into the page. Called once, from the App's `start()`. */
  mount(parent: HTMLElement): void {
    if (this.mounted) return;
    this.mounted = true;
    this.root.append(this.main, this.scope);
    parent.append(this.root);
  }

  /** Redraw the header. Only the face is rebuilt — the scope is left alone. */
  render(view: RigView): void {
    const { settings, powered } = view;
    this.root.classList.toggle("powered", powered);
    clear(this.main);

    const band = BANDS[Math.min(Math.max(settings.bandIndex, 0), BANDS.length - 1)];

    const brand = el("div", { class: "rig-brand" });
    brand.append(el("span", { class: "app-title", text: "CW QSO 练习器" }));
    brand.append(el("span", { class: "app-sub", text: "离线摩尔斯电码通联练习" }));

    const freq = el("div", { class: "rig-freq" });
    freq.append(el("span", { class: "freq-value", text: formatFreqMHz(settings.freqMHz) }));
    freq.append(el("span", { class: "freq-unit", text: "MHz" }));

    const meta = el("div", { class: "rig-meta" });
    meta.append(el("span", { class: "badge", text: band.name }));
    meta.append(this.modeButton(settings));

    const right = el("div", { class: "rig-right" });
    const power = button(
      powered ? "⏻ 关台" : "⏻ 开台",
      () => this.opts.onPower(!powered),
      powered ? "btn power on" : "btn power",
    );
    power.setAttribute("aria-pressed", String(powered));
    right.append(power, button("⚙ 设置", () => this.opts.onOpenSettings(), "btn gear"));

    this.main.append(brand, freq, meta, right);
    this.updateScopePassband(settings.passbandHz);
  }

  /**
   * Refresh the overlay text. Deliberately does not touch the canvas, so the
   * picture (and its history) is untouched by a re-render.
   */
  updateScope(view: ScopeView): void {
    this.scope.classList.toggle("off", !view.powered);
    this.updateScopePassband(view.passbandHz);

    // Powered down the band does not go quiet — the other stations keep calling.
    // Say so, so "standby" is never mistaken for "empty".
    if (!view.powered) {
      this.label.textContent = "设备已关机 · 本波段其他电台仍在活动";
    } else if (view.pileupCount > 0) {
      // A pile-up is the one moment the label has something more useful to say
      // than "tune around": the operator has to pick a station by name.
      this.label.textContent = `${view.pileupCount} 台同时应答 · 回复时请点名`;
    } else if (view.audibleInPassband === 0) {
      // The band slice is wider than this window, so the count is "signals in
      // view", not "stations on the band".
      this.label.textContent =
        view.signalsInWindow > 0
          ? `通带内没有信号 · 窗口里有 ${view.signalsInWindow} 个信号（滚轮调谐）`
          : "波段频谱 · 滚轮调谐";
    } else {
      this.label.textContent = "波段频谱 · 滚轮调谐（Shift = 100 Hz）";
    }

    // Who is calling is deliberately not shown: copying the callsign off the
    // air is the exercise. Only the pile-up count is a fact the operator could
    // not miss with their own ears.
    this.call.textContent = view.pileupCount > 0 ? `堆叠 ×${view.pileupCount}` : "";
  }

  /**
   * The mode readout is also the sideband switch. The band's convention (40 m
   * and down LSB, 20 m and up USB) is only the starting point — the operator
   * can pin the other sideband by clicking here. Either way a logged QSO is
   * plain CW (see `logRecord`).
   */
  private modeButton(settings: AppSettings): HTMLElement {
    const sideband = resolveSideband(settings.cwSideband, Math.round(settings.freqMHz * 1e6));
    const btn = button(
      sidebandLabel(sideband),
      () => this.opts.onToggleSideband(sideband),
      "badge mode sideband-btn",
    );
    btn.title =
      settings.cwSideband === "auto"
        ? `${sidebandLabel(sideband)}（本波段默认）· 点击切换到 ${
            sideband === "USB" ? "CW-L" : "CW-U"
          }`
        : `${sidebandLabel(sideband)}（手动指定）· 点击切换（可在设置里恢复跟随波段）`;
    return btn;
  }

  private updateScopePassband(passbandHz: number): void {
    this.passband.style.width = `${(passbandHz / SPECTRUM_SPAN_HZ) * 100}%`;
  }
}
