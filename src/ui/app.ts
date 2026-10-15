import { button, clear, el } from "./dom.js";
import {
  DISCLAIMER_TEXT,
  acknowledgeDisclaimer,
  hasAcknowledgedDisclaimer,
} from "./disclaimer.js";
import { QsoSession } from "./session.js";
import { loadSettings, saveSettings } from "./storage/settingsStore.js";
import { normalizeSettings, type AppSettings } from "./settingsSchema.js";
import { renderAbout } from "./pages/about.js";
import { renderLog } from "./pages/logPage.js";
import { renderRadio } from "./pages/radio.js";
import { renderSettingsPanel } from "./pages/settingsPage.js";
import { renderErrorPanel } from "./errorPanel.js";
import { BANDS } from "./bands.js";
import { formatFreqMHz } from "./logRecord.js";

export type PageId = "radio" | "log" | "about";

export interface AppHost {
  settings: AppSettings;
  session: QsoSession;
  /**
   * Station power. `false` = 关台 (standby: no HAM activity, no audio).
   * Optional so lightweight test hosts can omit it (treated as powered).
   */
  readonly powered?: boolean;
  /** Turn the station on/off (the rig's 开台/关台 switch). */
  setPower?(on: boolean): void;
  /** Merge a partial update, persist it and re-render. */
  updateSettings(patch: Partial<AppSettings>): void;
  /** Abandon the current QSO and re-seed activity on the frequency. */
  newSession(): void;
  go(page: PageId): void;
  /** Open the settings sheet behind the gear button. */
  openSettings?(): void;
  refresh(): void;
  /** Register a cleanup (e.g. remove key listeners) run before the next render. */
  onLeave(fn: () => void): void;
}

type PageRenderer = (host: AppHost, root: HTMLElement) => void;

/**
 * Render a page, turning any renderer exception into `onError` instead of letting
 * it bubble up and blank the whole app. Extracted so the boundary is unit-tested
 * without mounting a full App.
 */
export function safeRenderPage(
  render: PageRenderer,
  host: AppHost,
  root: HTMLElement,
  onError: (err: unknown) => void,
): void {
  try {
    render(host, root);
  } catch (err) {
    onError(err);
  }
}

interface PageDef {
  id: PageId;
  label: string;
  render: PageRenderer;
}

const PAGES: PageDef[] = [
  { id: "radio", label: "电台", render: renderRadio },
  { id: "log", label: "日志", render: renderLog },
  { id: "about", label: "关于", render: renderAbout },
];

/** Decorative band-scope bar heights (0..1). Deterministic, so no jitter. */
const SCOPE_BARS = 48;
const SCOPE_HEIGHTS: number[] = Array.from({ length: SCOPE_BARS }, (_, i) =>
  Math.abs(Math.sin(i * 0.7) * Math.cos(i * 0.23)),
);

/**
 * The application shell, styled as a radio: a persistent "rig" header (frequency,
 * band, mode, power switch, settings gear) plus a small nav for the secondary
 * views (log / about). Settings live behind the gear as a modal sheet.
 */
/** Clamp a band index into range (settings are normalised, but be defensive). */
function clampBandIndex(index: number): number {
  return Math.min(Math.max(index, 0), BANDS.length - 1);
}

export class App implements AppHost {
  settings: AppSettings;
  /**
   * One session per band — this is the *environment*. Every band's virtual HAMs
   * are generated when the app opens and keep calling CQ / giving up / being
   * replaced for as long as it stays open, whether or not the operator is
   * powered up. The rig's power switch only decides whether we hear the band we
   * are tuned to; the others simply keep running unheard.
   */
  private readonly sessions: QsoSession[];
  /** Which band the operator is tuned to (index into `sessions`). */
  private activeBand: number;
  private page: PageId = "radio";
  /** Radio power. Off by default so the band is silent until the user opens up. */
  private powerOn = false;
  private settingsOverlay: HTMLElement | null = null;
  private readonly rigRoot = el("div", { class: "rig" });
  private readonly navRoot = el("nav", { class: "nav" });
  private readonly pageRoot = el("div");
  private cleanups: Array<() => void> = [];

  constructor(private readonly root: HTMLElement) {
    this.settings = loadSettings();
    this.activeBand = clampBandIndex(this.settings.bandIndex);
    // The air is built up front but no timer runs until `start()`.
    this.sessions = BANDS.map((_, i) => this.createSession(i));
    this.sessions[this.activeBand].retune(this.settings.freqMHz);
  }

  /** The session for the band the operator is currently tuned to. */
  get session(): QsoSession {
    return this.sessions[this.activeBand];
  }

  /**
   * A fresh session for one band. The tuned band takes the operator's dial
   * frequency; every other band starts on its own default.
   */
  private createSession(bandIndex: number): QsoSession {
    const freqMHz =
      bandIndex === this.activeBand ? this.settings.freqMHz : BANDS[bandIndex].defaultMHz;
    return new QsoSession(freqMHz, this.settings);
  }

  get powered(): boolean {
    return this.powerOn;
  }

  /**
   * Power + tuning decide which band (if any) the station is actually hearing.
   * Everything else keeps running silently.
   */
  private applyReceiving(): void {
    this.sessions.forEach((s, i) => {
      s.setReceiving(this.powerOn && i === this.activeBand);
    });
  }

  /**
   * Only the band being monitored refreshes the view; the rest keep running in
   * the background. Refreshes are skipped while the user has unsent text, so an
   * incoming CQ can never wipe out a half-typed transmission.
   */
  private watchBand(index: number): void {
    this.sessions.forEach((s, i) => {
      if (i !== index) {
        s.setActivityListener(null);
        return;
      }
      s.setActivityListener(() => {
        if (s.draft) return;
        if (this.page === "radio") this.refresh();
      });
    });
  }

  start(): void {
    clear(this.root);
    this.root.append(
      this.rigRoot,
      this.navRoot,
      this.pageRoot,
      el("div", { class: "footer", text: DISCLAIMER_TEXT }),
    );
    // The band exists whether or not anyone is listening: populate every band
    // and start its CQ rhythm now, so the air is already alive (and evolving)
    // by the time the operator flips the power switch.
    for (const s of this.sessions) {
      s.seedHams();
      s.start();
    }
    this.applyReceiving();
    this.watchBand(this.activeBand);
    this.renderRig();
    this.renderNav();
    this.renderPage();
    if (!hasAcknowledgedDisclaimer()) this.showDisclaimerModal();
  }

  /**
   * 开台 / 关台. This is the *receiver* switch: powering down silences the
   * station and stops it hearing anything, but the band it was on is left
   * exactly as it was — its HAMs keep calling CQ, because the environment does
   * not go off the air when we do. Powering up just starts hearing again.
   */
  setPower(on: boolean): void {
    if (on === this.powerOn) return;
    this.powerOn = on;
    // Resume a QSO that a refresh interrupted; never clobber a live one.
    if (on && !this.session.inQso) this.session.restoreStaging();
    this.applyReceiving();
    this.refresh();
  }

  updateSettings(patch: Partial<AppSettings>): void {
    const merged = normalizeSettings({ ...this.settings, ...patch });
    const bandChanged = merged.bandIndex !== this.settings.bandIndex;
    const freqChanged = merged.freqMHz !== this.settings.freqMHz;
    this.settings = merged;
    saveSettings(merged);
    for (const s of this.sessions) s.updateSettings(merged);

    if (bandChanged) {
      // Tuning away abandons the QSO on the old band — its partner goes back to
      // calling CQ on a band that keeps running without us. Only the receiver
      // moves: nothing is torn down and nothing is re-seeded.
      this.session.reset();
      this.activeBand = clampBandIndex(merged.bandIndex);
      this.session.retune(merged.freqMHz);
      this.watchBand(this.activeBand);
    } else if (freqChanged) {
      // Retuning inside the same band: same air, new dial frequency.
      this.session.retune(merged.freqMHz);
    }
    this.applyReceiving();
    this.refresh();
    this.renderSettingsModal();
  }

  newSession(): void {
    this.session.reset();
    this.session.seedHams();
    this.refresh();
  }

  go(page: PageId): void {
    this.page = page;
    this.renderNav();
    this.refresh();
  }

  /** Release page listeners and stop every band's scheduler. */
  dispose(): void {
    this.runCleanups();
    for (const s of this.sessions) s.dispose();
    this.settingsOverlay?.remove();
    this.settingsOverlay = null;
  }

  refresh(): void {
    this.renderRig();
    this.renderPage();
  }

  onLeave(fn: () => void): void {
    this.cleanups.push(fn);
  }

  // --- settings sheet ------------------------------------------------------

  openSettings(): void {
    if (!this.settingsOverlay) {
      const overlay = el("div", { class: "modal-overlay" });
      overlay.addEventListener("click", (e) => {
        if (e.target === overlay) this.closeSettings();
      });
      this.settingsOverlay = overlay;
      document.body.append(overlay);
    }
    this.renderSettingsModal();
  }

  private closeSettings(): void {
    this.settingsOverlay?.remove();
    this.settingsOverlay = null;
  }

  private renderSettingsModal(): void {
    const overlay = this.settingsOverlay;
    if (!overlay) return;
    clear(overlay);
    const modal = el("div", { class: "modal settings-modal" });
    const head = el("div", { class: "modal-head" });
    head.append(el("h2", { text: "设置" }));
    head.append(button("关闭", () => this.closeSettings(), "btn small"));
    modal.append(head, renderSettingsPanel(this));
    overlay.append(modal);
  }

  // --- internals -----------------------------------------------------------

  /** The radio face: frequency, band, mode, power switch and settings gear. */
  private renderRig(): void {
    clear(this.rigRoot);
    this.rigRoot.classList.toggle("powered", this.powerOn);

    const bandIndex = Math.min(Math.max(this.settings.bandIndex, 0), BANDS.length - 1);
    const band = BANDS[bandIndex];

    const brand = el("div", { class: "rig-brand" });
    brand.append(el("span", { class: "app-title", text: "CW QSO 练习器" }));
    brand.append(el("span", { class: "app-sub", text: "离线摩尔斯电码通联练习" }));

    const freq = el("div", { class: "rig-freq" });
    freq.append(el("span", { class: "freq-value", text: formatFreqMHz(this.settings.freqMHz) }));
    freq.append(el("span", { class: "freq-unit", text: "MHz" }));

    const meta = el("div", { class: "rig-meta" });
    meta.append(el("span", { class: "badge", text: band.name }));
    meta.append(el("span", { class: "badge mode", text: "CW" }));

    const right = el("div", { class: "rig-right" });
    const power = button(
      this.powerOn ? "⏻ 关台" : "⏻ 开台",
      () => this.setPower(!this.powerOn),
      this.powerOn ? "btn power on" : "btn power",
    );
    power.setAttribute("aria-pressed", String(this.powerOn));
    right.append(power, button("⚙ 设置", () => this.openSettings(), "btn gear"));

    const main = el("div", { class: "rig-main" });
    main.append(brand, freq, meta, right);

    this.rigRoot.append(main, this.buildScope());
  }

  /**
   * A lightweight band-scope strip. It is an *illustration*, not a real
   * waterfall (timing/DSP are future work): a deterministic noise floor with the
   * station currently calling CQ labelled on top.
   */
  private buildScope(): HTMLElement {
    const scope = el("div", { class: "rig-scope" });
    const bars = el("div", { class: "scope-bars" });
    for (let i = 0; i < SCOPE_BARS; i++) {
      const b = el("i");
      b.style.height = `${Math.round(12 + SCOPE_HEIGHTS[i] * 82)}%`;
      bars.append(b);
    }
    scope.append(bars);
    const label = el("span", {
      class: "scope-label",
      // Powered down, the band does not go quiet — say so, so the model is not a
      // surprise when the operator switches on.
      text: this.powerOn ? "波段频谱（示意）" : "设备已关机 · 本波段其他电台仍在活动",
    });
    scope.append(label);
    if (this.powerOn) {
      const cq = this.session.hamActivity().find((e) => e.state === "cqing");
      if (cq) scope.append(el("span", { class: "scope-call", text: `CQ ${cq.ham.call}` }));
    }
    return scope;
  }

  private renderNav(): void {
    clear(this.navRoot);
    for (const p of PAGES) {
      this.navRoot.append(
        button(p.label, () => this.go(p.id), this.page === p.id ? "active" : ""),
      );
    }
  }

  private renderPage(): void {
    this.runCleanups();
    clear(this.pageRoot);
    const def = PAGES.find((p) => p.id === this.page) ?? PAGES[0];
    safeRenderPage(def.render, this, this.pageRoot, (err) => {
      // A broken page must not take down the nav, other pages, or the live QSO.
      console.error(`[App] 渲染页面 ${def.id} 出错：`, err);
      renderErrorPanel(this.pageRoot, def.id, err, () => this.refresh());
    });
  }

  private runCleanups(): void {
    for (const fn of this.cleanups) fn();
    this.cleanups = [];
  }

  private showDisclaimerModal(): void {
    const overlay = el("div", { class: "modal-overlay" });
    const modal = el("div", { class: "modal" });
    modal.append(el("h2", { text: "免责声明" }));
    modal.append(el("p", { text: DISCLAIMER_TEXT }));
    const actions = el("div", { class: "actions" });
    actions.append(
      button(
        "我已知晓",
        () => {
          acknowledgeDisclaimer();
          overlay.remove();
        },
        "btn primary",
      ),
    );
    modal.append(actions);
    overlay.append(modal);
    document.body.append(overlay);
  }
}
