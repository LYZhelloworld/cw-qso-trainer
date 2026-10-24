/** Band definitions for the frequency page (7 / 14 / 21 / 28 MHz, per UI.md). */

export interface Band {
  name: string;
  label: string;
  minMHz: number;
  maxMHz: number;
  defaultMHz: number;
}

export const BANDS: readonly Band[] = [
  { name: "40m", label: "40m · 7", minMHz: 7.0, maxMHz: 7.2, defaultMHz: 7.025 },
  { name: "20m", label: "20m · 14", minMHz: 14.0, maxMHz: 14.35, defaultMHz: 14.025 },
  { name: "15m", label: "15m · 21", minMHz: 21.0, maxMHz: 21.45, defaultMHz: 21.025 },
  { name: "10m", label: "10m · 28", minMHz: 28.0, maxMHz: 28.5, defaultMHz: 28.025 },
];

export function clampToBand(freqMHz: number, band: Band): number {
  if (!Number.isFinite(freqMHz)) return band.defaultMHz;
  return Math.min(band.maxMHz, Math.max(band.minMHz, freqMHz));
}

/**
 * Round to 5 decimals (10 Hz) — the finest tuning step — so stepping never
 * leaves float drift like 14.024999999 behind.
 */
export function roundFreq(freqMHz: number): number {
  return Math.round(freqMHz * 100000) / 100000;
}
