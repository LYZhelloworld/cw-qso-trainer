import { el } from "./dom.js";
import type { SMeterReading } from "../ham/smeter.js";

/**
 * The receiver's S-meter, drawn the way a rig draws one: a single horizontal
 * bar, not a ladder of rising bars.
 *
 * Scale
 *  - The bar is split at S9. Everything up to S9 is blue; everything past it is
 *    red, so "I am over S9" is a colour, not a number you have to read.
 *  - The S half takes 60 % of the width — nine units spread over most of the
 *    bar — and the over-S9 half takes the remaining 40 % for 60 dB. That is the
 *    conventional ICOMs' layout and keeps S9 at a glance-able, always-same spot.
 *
 * Everything here is driven by the same `SMeterReading` the audio uses (see
 * `ham/smeter`), so the bar agrees with the speaker: no sound, no needle.
 */

/** dB over S9 that fills the red half of the bar (S9+60 is the usual top). */
export const OVER_DB_SPAN = 60;

/** Fraction of the bar width the S1..S9 segment occupies. */
const S_SEGMENT = 0.6;

/** What one redraw writes into the DOM. */
export interface SMeterBar {
  /** Fill of the blue (S1..S9) segment, 0..1. */
  sFill: number;
  /** Fill of the red (S9..S9+60) segment, 0..1. */
  overFill: number;
  /** Panel text: "S7", "S9+12", or "—" when nothing is being received. */
  label: string;
  /** Whether the meter is hearing anything at all. */
  live: boolean;
}

const QUIET: SMeterBar = { sFill: 0, overFill: 0, label: "—", live: false };

/** Map a reading onto the bar. Pure, so the geometry is unit-tested. */
export function smeterBar(reading: SMeterReading | null): SMeterBar {
  if (reading === null) return QUIET;
  const sFill = Math.min(1, Math.max(0, (reading.s - 1) / 8));
  const overFill = Math.min(1, Math.max(0, reading.overDb / OVER_DB_SPAN));
  return { sFill, overFill, label: reading.label, live: true };
}

/** Where a scale label sits across the whole bar (0..100 %). */
export function scalePosition(unit: number, overDb = 0): number {
  const s = Math.min(1, Math.max(0, (unit - 1) / 8)) * S_SEGMENT;
  const over = Math.min(1, Math.max(0, overDb / OVER_DB_SPAN)) * (1 - S_SEGMENT);
  return (s + over) * 100;
}

/** The labels printed under the bar. S9 marks the colour change. */
const SCALE: ReadonlyArray<{ text: string; pct: number; s9?: boolean }> = [
  { text: "S1", pct: scalePosition(1) },
  { text: "S3", pct: scalePosition(3) },
  { text: "S5", pct: scalePosition(5) },
  { text: "S7", pct: scalePosition(7) },
  { text: "S9", pct: scalePosition(9), s9: true },
  { text: "+20", pct: scalePosition(9, 20) },
  { text: "+40", pct: scalePosition(9, 40) },
  { text: "+60", pct: scalePosition(9, 60) },
];

export interface SMeterHost {
  /** The receiver's current reading, or null when nothing is being heard. */
  reading(): SMeterReading | null;
  /** Register a cleanup, run when the page is left. */
  onLeave(fn: () => void): void;
  /** Redraw period in ms. Fast enough to follow the key. */
  tickMs?: number;
}

const DEFAULT_TICK_MS = 60;

/**
 * Build the meter. It redraws on its own timer — the needle drifts with each
 * signal's slow QSB, which has nothing to do with when the band's stations
 * happen to call CQ — and the page-level cleanup stops it when the view is
 * thrown away.
 */
export function renderSMeter(host: SMeterHost): HTMLElement {
  const wrap = el("div", { class: "smeter", attrs: { role: "meter" } });
  wrap.append(
    el("div", { class: "smeter-head" }, [
      el("span", { class: "smeter-label", text: "S" }),
      el("span", { class: "smeter-read", text: QUIET.label }),
    ]),
  );

  const track = el("div", { class: "smeter-track" });
  const sSegment = el("div", { class: "smeter-seg s" });
  const sFill = el("i", { class: "smeter-fill" });
  sSegment.append(sFill);
  const overSegment = el("div", { class: "smeter-seg over" });
  const overFill = el("i", { class: "smeter-fill" });
  overSegment.append(overFill);
  track.append(sSegment, overSegment);

  const scale = el("div", { class: "smeter-scale" });
  for (const tick of SCALE) {
    const label = el("span", {
      class: tick.s9 ? "smeter-tick s9" : "smeter-tick",
      text: tick.text,
    });
    label.style.left = `${tick.pct}%`;
    // Centred on its tick, except at the ends where half the text would be cut.
    label.style.transform =
      tick.pct <= 0 ? "none" : tick.pct >= 100 ? "translateX(-100%)" : "translateX(-50%)";
    scale.append(label);
  }

  wrap.append(track, scale);
  const readout = wrap.querySelector<HTMLElement>(".smeter-read")!;

  const draw = (): void => {
    const bar = smeterBar(host.reading());
    readout.textContent = bar.label;
    sFill.style.width = `${(bar.sFill * 100).toFixed(1)}%`;
    overFill.style.width = `${(bar.overFill * 100).toFixed(1)}%`;
    wrap.classList.toggle("quiet", !bar.live);
    wrap.setAttribute("aria-valuetext", bar.label);
    wrap.title = bar.live ? `信号强度 ${bar.label}` : "滤波器里没有信号";
  };
  draw();
  const timer = setInterval(draw, host.tickMs ?? DEFAULT_TICK_MS);
  host.onLeave(() => clearInterval(timer));
  return wrap;
}
