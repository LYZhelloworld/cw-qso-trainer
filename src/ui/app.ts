import { button, clear, el } from "./dom.js";
import {
  DISCLAIMER_TEXT,
  acknowledgeDisclaimer,
  hasAcknowledgedDisclaimer,
} from "./disclaimer.js";
import { QsoSession } from "./session.js";
import { installDebugConsole } from "./debugConsole.js";
import { loadSettings, saveSettings } from "./storage/settingsStore.js";
import { normalizeSettings, type AppSettings } from "./settingsSchema.js";
import { renderAbout } from "./pages/about.js";
import { renderLog } from "./pages/logPage.js";
import { renderRadio } from "./pages/radio.js";
import { renderEntryPanel } from "./pages/entryPanel.js";
import { renderSettingsPanel } from "./pages/settingsPage.js";
import { renderErrorPanel } from "./errorPanel.js";
import { BANDS, clampToBand, roundFreq } from "./bands.js";
import { otherSideband, type Sideband } from "../ham/tuning.js";
import { Waterfall } from "./waterfall.js";
import { RigFace, type ScopeView } from "./rigFace.js";
import { emptyEntry, type EntryValues } from "./entryModel.js";
import { loadModeMessages } from "./modeFileLoader.js";
import { parseBundledMode } from "../data/modeMessages.js";
import type { ModeMessages } from "../message/modeFile.js";

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
  /**
   * Where the text-mode send bar is mounted — the App keeps one under the
   * panadapter, so the box you type an over into is as wide as the display.
   * Optional: pages render the bar inside themselves when there is no shell.
   */
  readonly sendBar?: HTMLElement;
  /**
   * Show a message in the send bar while its carrier is up, and clear it when
   * the key drops. Used by the quick messages: what they key out was never
   * typed, so the bar under the display is the only place it can be seen going
   * out. Optional so lightweight test hosts can omit it.
   */
  showOutgoing?(text: string): void;
  /**
   * The current mode's eight quick messages (`doc/MESSAGES.md`), and the log
   * entry row the operator is filling in. Optional so lightweight test hosts do
   * not have to carry them; the entry panel simply does not render without.
   */
  readonly modeMessages?: ModeMessages;
  readonly entry?: EntryValues;
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
  /** The radio face (head + panadapter). Owns its own DOM and its canvas. */
  private readonly rig = new RigFace({
    onPower: (on) => this.setPower(on),
    onOpenSettings: () => this.openSettings(),
    onToggleSideband: (sideband) => this.toggleSideband(sideband),
    // Read by the badge on its own clock: a send starts and ends without a
    // re-render, so there is no render to hang "TX" on.
    isTransmitting: () => this.session.isTransmitting,
  });
  private readonly navRoot = el("nav", { class: "nav" });
  /**
   * The eight quick messages, and the row being filled in under them.
   *
   * The message set starts as the bundled default so the keys are there on the
   * first frame; `start()` then looks for the operator's own copy of the file
   * and swaps it in if there is one. The entry row is deliberately *not* per
   * band: it is one row on one piece of paper, and turning the dial must not
   * lose what has already been copied.
   */
  modeMessages: ModeMessages = parseBundledMode().config;
  readonly entry: EntryValues = emptyEntry();
  /** The operating screen. Scrolls on its own; the rig stays put. */
  private readonly pageRoot = el("div", { class: "page-area" });
  /**
   * The send bar, under the panadapter. Its own element rather than part of the
   * page, so it keeps the display's full width and never scrolls away with the
   * operating screen. Pages fill it (see `renderQsoPanel`); empty = hidden.
   */
  private readonly sendRoot = el("div", { class: "send-bar" });
  /**
   * The operating row — eight quick messages and the three log boxes. Its own
   * element between the panadapter and the send bar: the screen reads top to
   * bottom as the contact does (what is on the band, what you say next, what is
   * going out), and it keeps the display's full width.
   */
  private readonly entryRoot = el("div", { class: "entry-bar" });
  /** Bumped per preview so an earlier send cannot clear a later one. */
  private outgoingToken = 0;
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

  /** Where the text-mode send bar goes: directly under the panadapter. */
  get sendBar(): HTMLElement {
    return this.sendRoot;
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
        // No page rebuild on band activity. The radio view shows no live band
        // state on screen (no transcript; the roster is by-ear only), and its
        // dynamic pieces — panadapter, S-meter — redraw on their own timers.
        // Rebuilding it here would tear down the send box and key panel on every
        // scheduler tick, stealing focus from the textarea and dropping any
        // in-progress key gesture. Explicit actions (send / tune / power) call
        // `refresh()` themselves, which is enough.
      });
    });
  }

  start(): void {
    clear(this.root);
    // The console, top to bottom: the head, the page, the panadapter, and the
    // disclaimer. The nav lives in the head's middle slot, so the whole thing
    // reads as one radio rather than an app with a toolbar.
    this.rig.mount(this.root);
    this.rig.center.append(this.navRoot);
    this.root.append(
      this.pageRoot,
      this.rig.scopeRoot,
      // Order matters: the row you operate with sits under the display it is
      // keying onto, and the send bar under that.
      this.entryRoot,
      this.sendRoot,
      el("div", { class: "footer", text: DISCLAIMER_TEXT }),
    );
    // F12 console: only print what the operator can actually hear on the band
    // being monitored — every band is wired so `window.cw` reflects the active
    // one, but the streaming console is filtered to audible + active band.
    installDebugConsole(this.sessions, { getActive: () => this.session });
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
    void this.applyModeMessages();
  }

  /**
   * Swap in the operator's own message file, if the desktop build can read one.
   *
   * Deliberately fire-and-forget and after the first paint: the bundled default
   * is already on screen, so a slow or missing file never holds the app up. A
   * file that cannot be used leaves the default in place and says why in the
   * console — the alternative is an operating panel with dead keys and no
   * explanation.
   */
  private async applyModeMessages(): Promise<void> {
    const loaded = await loadModeMessages();
    if (loaded.problems.length > 0) {
      console.warn(`[模式配置] ${loaded.config.id}：`, ...loaded.problems);
    }
    if (loaded.source === "bundled") return;
    this.modeMessages = loaded.config;
    this.refresh();
  }

  /**
   * Build the waterfall once and let it scroll. It reads the band straight from
   * the active session on every line, so it stays current without the App
   * having to push anything at it.
   */
  private startWaterfall(): void {
    if (!this.waterfall) {
      this.waterfall = new Waterfall(this.rig.canvas);
      this.waterfall.setSource(() => this.session.spectrum());
      this.waterfall.onTune = (hz) => this.tuneTo(hz);
    }
    this.waterfall.setSpeed(this.settings.wpm);
    this.waterfall.setActive(this.powerOn);
  }

  /**
   * Tune the dial to an absolute frequency (Hz). Wired to the waterfall's wheel;
   * clamped to the current band, and refused while powered down (you cannot
   * tune a radio that is switched off).
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
    // The panadapter is part of the receiver: it scrolls while we are listening,
    // and goes blank when we are not — a receiver that has just been switched on
    // has no history (see `waterfall.reset`), so no stale trace is kept.
    this.waterfall?.setActive(on);
    this.refresh();
  }

  /**
   * Flip the receiving sideband from the mode label.
   *
   * This is the rig's **per-band mode memory**: the choice stays with this band
   * and only this band, so turning the knob back to 40 m finds 40 m's mode
   * rather than whatever 20 m was left on. Every band starts on its convention
   * (LSB below 10 MHz, USB above) until the operator says otherwise here. Only
   * how the receiver interprets the dial changes — nothing is torn down and the
   * QSO keeps running, exactly as flipping a real rig's mode mid-QSO would.
   */
  private toggleSideband(current: Sideband): void {
    this.session.setSidebandMode(otherSideband(current));
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
      // A band switch is a jump, not a sweep: the display starts again on the
      // new band instead of sliding there through several MHz of nothing.
      this.waterfall?.reset();
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
    this.rig.dispose();
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
    this.rig.render({
      settings: this.settings,
      powered: this.powerOn,
      // The mode belongs to the band, so the face reads it from the session
      // rather than from settings.
      sideband: this.session.sideband,
    });
    this.waterfall?.setSpeed(this.settings.wpm);
    this.rig.updateScope(this.scopeView());
  }

  /**
   * What the panadapter's overlay says. Almost nothing on purpose: the display
   * is a receiver, and what is on the band is for the operator's ears (see
   * `ScopeView`).
   */
  private scopeView(): ScopeView {
    return { powered: this.powerOn };
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
    clear(this.sendRoot);
    clear(this.entryRoot);
    // The panadapter belongs to the receiver, not to any one page: it stays for
    // the operating screen and steps aside for the log and the credits, which
    // want the height. The entry row and the send bar follow the same rule.
    this.rig.scopeRoot.hidden = this.page !== "radio";
    // On the operating screen the page is content-sized so the panadapter can
    // take the rest of the window; everywhere else the page takes the room the
    // display gives back (see `.page-area` in the stylesheet).
    this.root.classList.toggle("radio-view", this.page === "radio");
    const def = PAGES.find((p) => p.id === this.page) ?? PAGES[0];
    safeRenderPage(def.render, this, this.pageRoot, (err) => {
      // A broken page must not take down the nav, other pages, or the live QSO.
      console.error(`[App] 渲染页面 ${def.id} 出错：`, err);
      renderErrorPanel(this.pageRoot, def.id, err, () => this.refresh());
    });
    // The operating row is only worth showing when there is a rig to operate:
    // on the log, on the credits and with the power off it would be a row of
    // keys that cannot key anything.
    const showEntry = this.page === "radio" && this.powerOn;
    if (showEntry) {
      try {
        renderEntryPanel(this, this.entryRoot);
      } catch (err) {
        // Same rule as the page: a broken row must not take the radio with it.
        console.error("[App] 渲染录入行出错：", err);
      }
    }
    this.entryRoot.hidden = !showEntry || this.entryRoot.childElementCount === 0;
    // Nothing was put in it (key mode, powered down, or another page): collapse
    // the strip instead of leaving an empty gap under the display.
    this.sendRoot.hidden = this.sendRoot.childElementCount === 0;
  }

  /**
   * Put a message in the send bar while its carrier is up, then take it away.
   *
   * The eight quick keys key out a message the operator never typed, so this is
   * the only place it can be seen going out. `userSend` deliberately outlives
   * the over — it plays the other station's reply too — so the signal to clear
   * is the carrier coming down, not the promise resolving.
   */
  showOutgoing(text: string): void {
    const box = this.sendRoot.querySelector<HTMLElement>(".send-input");
    if (!box) return;
    const token = ++this.outgoingToken;
    this.paintOutgoing(box, text);
    const tick = (): void => {
      if (token !== this.outgoingToken) return;
      if (!this.session.isTransmitting) {
        this.paintOutgoing(box, "");
        return;
      }
      setTimeout(tick, 60);
    };
    setTimeout(tick, 60);
  }

  /** Write (or with `""` clear) the send bar's text, whichever kind it is. */
  private paintOutgoing(box: HTMLElement, text: string): void {
    if (!box.isConnected) return;
    if (box instanceof HTMLInputElement) {
      box.value = text;
      // The box mirrors the draft; a quick message is not a draft, so the row
      // is emptied with it rather than reappearing on the next re-render.
      if (text === "") this.session.setDraft("");
      return;
    }
    // Key modes: the bar is the read-only echo, filled by the key panel.
    const echo = box.querySelector(".echo-text");
    if (echo) echo.textContent = text;
    const pending = box.querySelector(".echo-pending");
    if (pending) pending.textContent = "";
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
