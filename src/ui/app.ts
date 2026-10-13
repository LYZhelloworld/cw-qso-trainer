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
import { renderCw } from "./pages/cw.js";
import { renderFrequency } from "./pages/frequency.js";
import { renderLog } from "./pages/logPage.js";
import { renderSettings } from "./pages/settingsPage.js";

export type PageId = "frequency" | "cw" | "log" | "settings" | "about";

export interface AppHost {
  settings: AppSettings;
  session: QsoSession;
  /** Merge a partial update, persist it and re-render. */
  updateSettings(patch: Partial<AppSettings>): void;
  /** Abandon the current QSO and re-seed activity on the frequency. */
  newSession(): void;
  go(page: PageId): void;
  refresh(): void;
  /** Register a cleanup (e.g. remove key listeners) run before the next render. */
  onLeave(fn: () => void): void;
}

type PageRenderer = (host: AppHost, root: HTMLElement) => void;

interface PageDef {
  id: PageId;
  label: string;
  render: PageRenderer;
}

const PAGES: PageDef[] = [
  { id: "frequency", label: "频率", render: renderFrequency },
  { id: "cw", label: "CW 翻译", render: renderCw },
  { id: "log", label: "日志", render: renderLog },
  { id: "settings", label: "设置", render: renderSettings },
  { id: "about", label: "关于", render: renderAbout },
];

export class App implements AppHost {
  settings: AppSettings;
  session: QsoSession;
  private page: PageId = "frequency";
  private readonly navRoot = el("nav", { class: "nav" });
  private readonly pageRoot = el("div");
  private cleanups: Array<() => void> = [];

  constructor(private readonly root: HTMLElement) {
    this.settings = loadSettings();
    this.session = new QsoSession(this.settings.freqMHz, this.settings);
    this.session.seedHams(3);
  }

  start(): void {
    clear(this.root);
    const header = el("div", { class: "app-header" });
    header.append(el("span", { class: "app-title", text: "CW QSO 练习器" }));
    header.append(el("span", { class: "app-sub", text: "离线摩尔斯电码通联练习" }));
    this.root.append(header, this.navRoot, this.pageRoot, el("div", { class: "footer", text: DISCLAIMER_TEXT }));
    this.renderNav();
    this.renderPage();
    if (!hasAcknowledgedDisclaimer()) this.showDisclaimerModal();
  }

  updateSettings(patch: Partial<AppSettings>): void {
    const merged = normalizeSettings({ ...this.settings, ...patch });
    const freqChanged = merged.freqMHz !== this.settings.freqMHz;
    this.settings = merged;
    saveSettings(merged);
    if (freqChanged) {
      // A different frequency means a different set of HAMs: start over.
      this.session = new QsoSession(merged.freqMHz, merged);
      this.session.seedHams(3);
    } else {
      this.session.updateSettings(merged);
    }
    this.refresh();
  }

  newSession(): void {
    this.session.reset();
    this.session.seedHams(3);
    this.refresh();
  }

  go(page: PageId): void {
    this.page = page;
    this.renderNav();
    this.refresh();
  }

  refresh(): void {
    this.renderPage();
  }

  onLeave(fn: () => void): void {
    this.cleanups.push(fn);
  }

  // --- internals -----------------------------------------------------------

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
    def.render(this, this.pageRoot);
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
