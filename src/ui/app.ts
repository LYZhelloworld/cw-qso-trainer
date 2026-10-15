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
export class App implements AppHost {
  settings: AppSettings;
  session: QsoSession;
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
    // Built but not started: with the station off there is no HAM activity yet.
    this.session = this.createSession();
  }

  /** A fresh, empty session for the current band (population is explicit). */
  private createSession(): QsoSession {
    return new QsoSession(this.settings.freqMHz, this.settings);
  }

  get powered(): boolean {
    return this.powerOn;
  }

  /**
   * Populate + start the HAMs' CQ rhythm, and let autonomous activity refresh
   * the view. Refreshes are skipped while the user has unsent text, so an
   * incoming CQ can never wipe out a half-typed transmission.
   */
  private startSession(): void {
    this.session.start();
    this.session.setActivityListener(() => {
      if (this.session.draft) return;
      if (this.page === "radio") this.refresh();
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
    this.renderRig();
    this.renderNav();
    this.renderPage();
    if (!hasAcknowledgedDisclaimer()) this.showDisclaimerModal();
  }

  /** 开台 / 关台. Powering down silences the band; powering up re-populates it. */
  setPower(on: boolean): void {
    if (on === this.powerOn) return;
    this.powerOn = on;
    if (on) {
      this.session.seedHams();
      this.startSession();
      // Resume an in-progress QSO if the user refreshed mid-conversation.
      this.session.restoreStaging();
    } else {
      // A powered-down radio holds nothing: drop the staged QSO and the band.
      this.session.discardStaging();
      this.session.dispose();
      this.session = this.createSession();
    }
    this.refresh();
  }

  updateSettings(patch: Partial<AppSettings>): void {
    const merged = normalizeSettings({ ...this.settings, ...patch });
    const freqChanged = merged.freqMHz !== this.settings.freqMHz;
    this.settings = merged;
    saveSettings(merged);
    if (freqChanged) {
      // A different frequency means a different set of HAMs: start over.
      // The old session must be disposed first, otherwise its scheduler keeps
      // ticking forever on a band nobody is listening to.
      this.session.dispose();
      this.session = this.createSession();
      this.session.discardStaging();
      if (this.powerOn) {
        this.session.seedHams();
        this.startSession();
      }
    } else {
      this.session.updateSettings(merged);
    }
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

  /** Release page listeners and stop the HAM scheduler. */
  dispose(): void {
    this.runCleanups();
    this.session.dispose();
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
      text: this.powerOn ? "波段频谱（示意）" : "设备已关机",
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
