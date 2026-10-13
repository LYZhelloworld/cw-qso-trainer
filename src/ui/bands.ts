/** Band definitions for the frequency page (four CW bands, per UI.md). */

export interface Band {
  name: string;
  label: string;
  minMHz: number;
  maxMHz: number;
  defaultMHz: number;
}

export const BANDS: readonly Band[] = [
  { name: "80m", label: "80m · 3.5", minMHz: 3.5, maxMHz: 3.8, defaultMHz: 3.55 },
  { name: "40m", label: "40m · 7", minMHz: 7.0, maxMHz: 7.2, defaultMHz: 7.025 },
  { name: "20m", label: "20m · 14", minMHz: 14.0, maxMHz: 14.35, defaultMHz: 14.025 },
  { name: "15m", label: "15m · 21", minMHz: 21.0, maxMHz: 21.45, defaultMHz: 21.025 },
];

/** Tuning step in MHz (1 kHz). */
export const FREQ_STEP_MHZ = 0.001;

export function clampToBand(freqMHz: number, band: Band): number {
  if (!Number.isFinite(freqMHz)) return band.defaultMHz;
  return Math.min(band.maxMHz, Math.max(band.minMHz, freqMHz));
}

/** Round to 4 decimals — avoids float drift like 14.024999999 after stepping. */
export function roundFreq(freqMHz: number): number {
  return Math.round(freqMHz * 10000) / 10000;
}
