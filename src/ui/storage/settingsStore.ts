import { normalizeSettings, type AppSettings } from "../settingsSchema.js";

/** Settings persistence (localStorage), per UI.md data-storage plan. */

const KEY = "cw-qso-trainer:settings";

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return normalizeSettings(null);
    return normalizeSettings(JSON.parse(raw));
  } catch {
    // Unreadable or corrupt storage: fall back to defaults rather than crash.
    return normalizeSettings(null);
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Storage may be unavailable (private mode); settings stay in-memory only.
  }
}
