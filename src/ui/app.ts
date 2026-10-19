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
import { BANDS, clampToBand, roundFreq } from "./bands.js";
import { formatFreqMHz } from "./logRecord.js";
import {
  inPassband,
  otherSideband,
  resolveSideband,
  sidebandLabel,
  type Sideband,
} from "../ham/tuning.js";
import { SPECTRUM_SPAN_HZ } from "../ham/spectrum.js";
import { Waterfall } from "./waterfall.js";

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
  private readonly rigMain = el("div", { class: "rig-main" });
  private readonly navRoot = el("nav", { class: "nav" });
  private readonly pageRoot = el("div");
  /**
   * The waterfall lives in the rig, like a real radio's panadapter. Both the
   * canvas and its overlay labels are built ONCE and re-used across every
   * re-render: a canvas holds its picture in the element, so rebuilding it
   * would throw the whole history away (and re-attaching keeps it).
   */
  private readonly scopeCanvas = el("canvas", { class: "scope-canvas" });
  /**
   * The receiver's passband drawn on top of the waterfall: a band down the
   * middle of the display as wide as the CW filter (by default 500 Hz out of
   * the 20 kHz window, narrower if the operator picked a tighter filter). It is
   * always centred because the display is drawn around the dial, and the filter
   * is centred on the dial too. Anything lit up outside it is on the band but
   * *not* being received. Its width is refreshed on every render from the
   * current setting.
   */
  private readonly scopePassband = el("div", { class: "scope-passband" });
  private readonly scopeLabel = el("span", { class: "scope-label" });
  private readonly scopeCall = el("span", { class: "scope-call" });
  private readonly scopeRoot = el("div", { class: "rig-scope" }, [
    this.scopeCanvas,
    this.scopePassband,
    this.scopeLabel,
    this.scopeCall,
  ]);
  private waterfall: Waterfall | null = null;
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
   * frequency; every other band starts on its own default. Either way the
   * band's *reference* (where its stations live) is its nominal centre, so the
   * same band always holds the same stations however the dial wanders.
   */
  private createSession(bandIndex: number): QsoSession {
    const freqMHz =
      bandIndex === this.activeBand ? this.settings.freqMHz : BANDS[bandIndex].defaultMHz;
    return new QsoSession(freqMHz, this.settings, {
      referenceHz: Math.round(BANDS[bandIndex].defaultMHz * 1e6),
    });
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
    this.startWaterfall();
    this.renderRig();
    this.renderNav();
    this.renderPage();
    if (!hasAcknowledgedDisclaimer()) this.showDisclaimerModal();
  }

  /**
   * Build the waterfall once and let it scroll. It reads the band straight from
   * the active session on every line, so it stays current without the App
   * having to push anything at it.
   */
  private startWaterfall(): void {
    if (!this.waterfall) {
      this.waterfall = new Waterfall(this.scopeCanvas);
      this.waterfall.setSource(() => this.session.spectrum());
      this.waterfall.onTune = (hz) => this.tuneTo(hz);
    }
    this.waterfall.setSpeed(this.settings.wpm);
    this.waterfall.setActive(this.powerOn);
  }

  /**
   * Tune the dial to an absolute frequency (Hz). Wired to the waterfall's
   * click-to-tune; clamped to the current band, and refused while powered down
   * (you cannot tune a radio that is switched off).
   */
  tuneTo(hz: number): void {
    if (!this.powerOn || !Number.isFinite(hz)) return;
    const band = BANDS[clampBandIndex(this.settings.bandIndex)];
    const mhz = roundFreq(clampToBand(hz / 1e6, band));
    if (mhz === this.settings.freqMHz) return;
    this.updateSettings({ freqMHz: mhz });
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
    // The panadapter is part of the receiver: it scrolls when we are listening
    // and freezes (keeping its history) when we are not.
    this.waterfall?.setActive(on);
    this.refresh();
  }

  /**
   * Flip the receiving sideband from the mode label. The band's convention is
   * the starting point; clicking pins the other one. Only how the receiver
   * interprets the dial changes — nothing is torn down and the transcript keeps
   * running, exactly as flipping a real rig's mode mid-QSO would.
   */
  private toggleSideband(current: Sideband): void {
    this.updateSettings({ cwSideband: otherSideband(current) });
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
    this.waterfall?.dispose();
    this.waterfall = null;
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
    // Only the face is rebuilt — the waterfall below it is never detached, so
    // its history survives every re-render.
    this.rigRoot.classList.toggle("powered", this.powerOn);
    clear(this.rigMain);

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
    // The mode readout is also the sideband switch: CW-L / CW-U. The band's
    // convention (40 m and down LSB, 20 m and up USB) is only the starting
    // point — the operator can pin the other sideband by clicking here. Either
    // way a logged QSO is plain CW (see logRecord).
    const sideband = resolveSideband(
      this.settings.cwSideband,
      Math.round(this.settings.freqMHz * 1e6),
    );
    const modeBtn = button(
      sidebandLabel(sideband),
      () => this.toggleSideband(sideband),
      "badge mode sideband-btn",
    );
    modeBtn.title =
      this.settings.cwSideband === "auto"
        ? `${sidebandLabel(sideband)}（本波段默认）· 点击切换到 ${
            sideband === "USB" ? "CW-L" : "CW-U"
          }`
        : `${sidebandLabel(sideband)}（手动指定）· 点击切换（可在设置里恢复跟随波段）`;
    meta.append(modeBtn);

    const right = el("div", { class: "rig-right" });
    const power = button(
      this.powerOn ? "⏻ 关台" : "⏻ 开台",
      () => this.setPower(!this.powerOn),
      this.powerOn ? "btn power on" : "btn power",
    );
    power.setAttribute("aria-pressed", String(this.powerOn));
    right.append(power, button("⚙ 设置", () => this.openSettings(), "btn gear"));

    this.rigMain.append(brand, freq, meta, right);

    if (this.rigRoot.childElementCount === 0) {
      this.rigRoot.append(this.rigMain, this.scopeRoot);
    }
    this.waterfall?.setSpeed(this.settings.wpm);
    this.updateScope();
  }

  /**
   * Refresh the waterfall's overlay text. Deliberately does not touch the
   * canvas, so the picture (and its history) is untouched by a re-render.
   */
  private updateScope(): void {
    this.scopeRoot.classList.toggle("off", !this.powerOn);
    // The passband marking is as wide as the filter the operator picked.
    this.scopePassband.style.width = `${
      (this.session.passbandHz / SPECTRUM_SPAN_HZ) * 100
    }%`;
    // Below the dial is the receiver's filter, so only stations inside it are
    // actually being heard — the rest are visible signals the operator has not
    // tuned to yet.
    const roster = this.powerOn ? this.session.hamActivity() : [];
    const audible = roster.filter((e) =>
      inPassband(e.ham.freqHz, this.session.dialHz, this.session.passbandHz),
    );
    // A pile-up is the one moment the label has something more useful to say
    // than "tune around": the operator has to pick a station by name.
    const pileup = this.powerOn ? this.session.pileupCallers() : [];

    // Powered down the band does not go quiet — the other stations keep calling.
    // Say so, so "standby" is never mistaken for "empty".
    if (!this.powerOn) {
      this.scopeLabel.textContent = "设备已关机 · 本波段其他电台仍在活动";
    } else if (pileup.length > 0) {
      this.scopeLabel.textContent = `${pileup.length} 台同时应答 · 回复时请点名`;
    } else if (audible.length === 0) {
      this.scopeLabel.textContent =
        roster.length > 0
          ? `通带内没有信号 · 本波段有 ${roster.length} 个电台（点击亮斑可调谐）`
          : "波段频谱 · 点击信号可调谐";
    } else {
      this.scopeLabel.textContent = "波段频谱 · 点击信号可调谐";
    }

    if (pileup.length > 0) {
      this.scopeCall.textContent = `堆叠 ×${pileup.length}`;
    } else {
      const cq = audible.find((e) => e.state === "cqing");
      this.scopeCall.textContent = cq ? `CQ ${cq.ham.call}` : "";
    }
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
