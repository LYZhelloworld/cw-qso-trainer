import { button, clear, el } from "./dom.js";
import { BANDS } from "./bands.js";
import { SPECTRUM_SPAN_HZ } from "../ham/spectrum.js";
import { sidebandLabel, type Sideband } from "../ham/tuning.js";
import { CONTEST_KINDS, CONTEST_LABEL, type ContestKind } from "../qso/contest.js";
import type { AppSettings } from "./settingsSchema.js";

/**
 * The radio's body, in two pieces that the App places separately:
 *
 *  - the **head** (`root`): what the operator is doing and with what —
 *    RX/TX · band · mode on the left, settings and the power switch on the
 *    right. Its middle slot is left empty for the App's page nav.
 *  - the **scope** (`scopeRoot`): the panadapter at the bottom of the screen,
 *    with a kHz scale under it and the standby shutter that covers the picture
 *    while the rig is off.
 *
 * They are separate elements because the operating page sits *between* them;
 * the App mounts the head first, then the page, then the scope.
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
  /** The mode selector was changed: DX, CQWW or WPX. */
  onContest(kind: ContestKind): void;
  /**
   * Whether our own key is down, for the RX/TX badge.
   *
   * Polled rather than pushed: a transmission starts and ends without a
   * re-render (the send box keeps its focus and the scope keeps scrolling), so
   * there is no render to hang the badge on.
   */
  isTransmitting?(): boolean;
}

/** How often the RX/TX badge is re-read. Cheap enough to feel immediate. */
const TX_POLL_MS = 120;

/** What the head needs to draw itself. */
export interface RigView {
  settings: AppSettings;
  powered: boolean;
  /**
   * The mode of the band being shown (CW-L / CW-U). Comes from the session, not
   * from settings: a rig remembers the mode per band, so it is band state.
   */
  sideband: Sideband;
  /**
   * Which of the three operating modes the rig is in. Unlike the sideband this
   * is not per band: a contest is one entry, worked on whatever band is open.
   */
  contest: ContestKind;
}

/** What the scope's shutter says. */
export interface ScopeView {
  powered: boolean;
}

/** One label on the panadapter's frequency scale. */
export interface AxisTick {
  /** Offset from the dial in kHz: negative left, 0 centre, positive right. */
  khz: number;
  /** Where it sits across the display, 0..100 %. */
  pct: number;
  /** Text to print — a bare signed number, no unit (see `axisTicks`). */
  label: string;
}

/**
 * Ticks for the scale under the waterfall: 0 is the dial, negative to the left,
 * positive to the right.
 *
 * The display is always drawn around the dial (see `Waterfall`), so this scale
 * is static: the numbers are offsets from wherever you are tuned, not absolute
 * frequencies — which is exactly what a panadapter's scale means.
 *
 * Every label is a bare number. Printing "kHz" on the outer one only made that
 * label wider than the rest, so it stopped lining up with its tick; the unit is
 * in the docs and the dial, where it is unambiguous.
 */
export function axisTicks(spanHz: number, stepKhz = 5): AxisTick[] {
  const halfKhz = spanHz / 2000;
  if (!(halfKhz > 0)) return [];
  const ticks: AxisTick[] = [];
  for (let khz = -halfKhz; khz <= halfKhz + 1e-9; khz += stepKhz) {
    const rounded = Math.round(khz);
    ticks.push({ khz: rounded, pct: 50 + (khz / halfKhz) * 50, label: formatKhz(rounded) });
  }
  return ticks;
}

function formatKhz(khz: number): string {
  if (khz === 0) return "0";
  return khz > 0 ? `+${khz}` : `${khz}`;
}

export class RigFace {
  /** The head. Mounted at the top of the app. */
  readonly root = el("header", { class: "rig" });
  /** Middle slot, left for the App's page nav. */
  readonly center = el("div", { class: "rig-center" });
  /** The panadapter. Mounted at the bottom of the app, after the page. */
  readonly scopeRoot = el("section", { class: "rig-scope" });
  /** The panadapter canvas. Created once; never detached on re-render. */
  readonly canvas = el("canvas", { class: "scope-canvas" });

  private readonly txBadge = el("span", { class: "txrx rx", text: "RX" });
  private readonly band = el("span", { class: "rig-band" });
  private readonly left = el("div", { class: "rig-left" });
  private readonly right = el("div", { class: "rig-right" });

  /**
   * The dial marker: one vertical line at the tuned frequency, the way a real
   * rig's panadapter shows where the VFO is. It sits in the middle because the
   * display is drawn around the dial; the filter width is an audio property,
   * not a pair of edges to draw.
   */
  private readonly cursor = el("div", { class: "scope-cursor" });
  private readonly standby = el("div", { class: "standby" });
  private readonly field = el("div", { class: "scope-field" }, [
    this.canvas,
    this.cursor,
    this.standby,
  ]);
  private readonly axis = el("div", { class: "scope-axis" });

  private mounted = false;
  private tx = false;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: RigFaceOptions) {}

  /** Build the head and the scope, and start watching the key. */
  mount(parent: HTMLElement): void {
    if (this.mounted) return;
    this.mounted = true;
    this.root.append(this.left, this.center, this.right);
    parent.append(this.root);
    this.buildStandby();
    this.buildAxis();
    this.scopeRoot.append(this.field, this.axis);
    this.timer = setInterval(() => this.pollTx(), TX_POLL_MS);
  }

  dispose(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.mounted = false;
  }

  /** Redraw the head. The scope is left alone, so its history survives. */
  render(view: RigView): void {
    const { settings, powered } = view;
    this.root.classList.toggle("powered", powered);

    clear(this.left);
    this.band.textContent = BANDS[Math.min(Math.max(settings.bandIndex, 0), BANDS.length - 1)].name;
    this.left.append(
      this.txBadge,
      this.band,
      this.modeButton(view.sideband),
      this.contestSelect(view.contest),
    );

    clear(this.right);
    const power = button(
      powered ? "关台" : "开台",
      () => this.opts.onPower(!powered),
      powered ? "btn power on" : "btn power",
    );
    power.setAttribute("aria-pressed", String(powered));
    power.title = powered ? "关台（停止接收）" : "开台（开始接收）";
    this.right.append(button("设置", () => this.opts.onOpenSettings(), "btn gear"), power);
  }

  /**
   * Open or close the shutter. Deliberately does not touch the canvas, so the
   * picture (and its history) is untouched by a re-render.
   *
   * Nothing is written while the rig is on: the display is a receiver, not an
   * operating manual, and the only thing worth saying about a dark screen is
   * that the power is off.
   */
  updateScope(view: ScopeView): void {
    this.scopeRoot.classList.toggle("off", !view.powered);
    this.standby.hidden = view.powered;
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
      "rig-mode sideband-btn",
    );
    const other = sideband === "USB" ? "CW-L" : "CW-U";
    btn.title = `${sidebandLabel(sideband)}（本波段）· 点击切换到 ${other}`;
    return btn;
  }

  /**
   * The mode selector: everyday DX, or one of the two contests.
   *
   * It sits in the head next to the band and the sideband because it is the same
   * kind of choice — what the rig is being used *for* right now — and because it
   * has to be reachable with the power off: an operator sets up the mode before
   * switching on, not after. Switching it changes the eight quick messages, the
   * entry row and which log the contact is written to, and abandons any contact
   * in progress (see `App.updateSettings`).
   */
  private contestSelect(current: ContestKind): HTMLElement {
    const select = el("select", {
      class: "rig-contest",
      attrs: { "aria-label": "通联模式" },
    });
    for (const kind of CONTEST_KINDS) {
      const option = el("option", { attrs: { value: kind } });
      option.textContent = CONTEST_LABEL[kind];
      select.append(option);
    }
    select.value = current;
    select.title = "DX：日常通联 · CQWW：交换 CQ 分区 · WPX：交换序号（三种模式各记一本日志）";
    select.addEventListener("change", () => {
      this.opts.onContest(select.value as ContestKind);
    });
    return select;
  }

  /** The shutter over the waterfall: what a switched-off rig shows. */  private buildStandby(): void {
    this.standby.append(el("div", { class: "standby-icon", text: "⏻" }));
    this.standby.append(el("div", { class: "standby-title", text: "设备已关机" }));
    this.standby.append(
      el("div", { class: "standby-hint", text: "开着电台就会开始接收这个频段上的信号。" }),
    );
    this.standby.append(button("开台", () => this.opts.onPower(true), "btn primary"));
  }

  private buildAxis(): void {
    clear(this.axis);
    for (const tick of axisTicks(SPECTRUM_SPAN_HZ)) {
      const label = el("span", {
        class: tick.khz === 0 ? "axis-tick center" : "axis-tick",
        text: tick.label,
      });
      label.style.left = `${tick.pct}%`;
      // Edge labels would be half cut off if they were centred on their tick.
      label.style.transform =
        tick.pct <= 0
          ? "none"
          : tick.pct >= 100
            ? "translateX(-100%)"
            : "translateX(-50%)";
      this.axis.append(label);
    }
  }

  /**
   * Flip the badge between RX and TX. Only the class and the two letters
   * change, so the header is not rebuilt while the operator is keying.
   */
  private pollTx(): void {
    const on = this.opts.isTransmitting?.() ?? false;
    if (on === this.tx) return;
    this.tx = on;
    this.txBadge.className = on ? "txrx tx" : "txrx rx";
    this.txBadge.textContent = on ? "TX" : "RX";
    this.root.classList.toggle("transmitting", on);
  }
}
