import { button, clear, el } from "./dom.js";
import { BANDS } from "./bands.js";
import { formatFreqMHz } from "./logRecord.js";
import { sidebandLabel, type Sideband } from "../ham/tuning.js";
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
  /**
   * The mode of the band being shown (CW-L / CW-U). Comes from the session, not
   * from settings: a rig remembers the mode per band, so it is band state.
   */
  sideband: Sideband;
}

/**
 * What the panadapter's overlay says, gathered by the App from the session.
 *
 * Deliberately almost nothing: the display is a receiver, not a status board.
 * How many signals are in view, whether the filter is passing one, who is
 * calling — all of that is what the operator's ears are for.
 */
export interface ScopeView {
  powered: boolean;
}

export class RigFace {
  readonly root = el("div", { class: "rig" });
  /** The panadapter canvas. Created once; never detached on re-render. */
  readonly canvas = el("canvas", { class: "scope-canvas" });

  private readonly main = el("div", { class: "rig-main" });
  /**
   * The dial marker: one vertical line at the tuned frequency, the way a real
   * rig's panadapter shows where the VFO is. It sits in the middle because the
   * display is drawn around the dial; the filter width is an audio property,
   * not a pair of edges to draw.
   */
  private readonly cursor = el("div", { class: "scope-cursor" });
  private readonly label = el("span", { class: "scope-label" });
  private readonly scope = el("div", { class: "rig-scope" }, [
    this.canvas,
    this.cursor,
    this.label,
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
    meta.append(this.modeButton(view.sideband));

    const right = el("div", { class: "rig-right" });
    const power = button(
      powered ? "⏻ 关台" : "⏻ 开台",
      () => this.opts.onPower(!powered),
      powered ? "btn power on" : "btn power",
    );
    power.setAttribute("aria-pressed", String(powered));
    right.append(power, button("⚙ 设置", () => this.opts.onOpenSettings(), "btn gear"));

    this.main.append(brand, freq, meta, right);
  }

  /**
   * Refresh the overlay text. Deliberately does not touch the canvas, so the
   * picture (and its history) is untouched by a re-render.
   *
   * Nothing is written while the rig is on: the display is a receiver, not an
   * operating manual, and the only thing worth saying about a dark screen is
   * that the power is off.
   */
  updateScope(view: ScopeView): void {
    this.scope.classList.toggle("off", !view.powered);
    this.label.textContent = view.powered ? "" : "设备已关机";
  }

  /**
   * The mode readout is also the mode switch. Each band has its own memory:
   * 40 m and down start on CW-L, 20 m and up on CW-U, and clicking here changes
   * *this band only* — turn to another band and it keeps its own mode. Either
   * way a logged QSO is plain CW (see `logRecord`).
   */
  private modeButton(sideband: Sideband): HTMLElement {
    const btn = button(
      sidebandLabel(sideband),
      () => this.opts.onToggleSideband(sideband),
      "badge mode sideband-btn",
    );
    const other = sideband === "USB" ? "CW-L" : "CW-U";
    btn.title = `${sidebandLabel(sideband)}（本波段）· 点击切换到 ${other}`;
    return btn;
  }
}
