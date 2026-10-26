import { button, el } from "../dom.js";
import { BANDS } from "../bands.js";
import { renderQsoPanel } from "./cw.js";
import { renderEntryPanel } from "./entryPanel.js";
import { renderSMeter } from "../smeter.js";
import type { AppHost } from "../app.js";

/**
 * The dial, written the way a rig writes it: MHz . kHz . tens of Hz, so the
 * digits you actually work with (the kHz) keep the same place in the number
 * whether you are on 7 MHz or 28 MHz. The last group counts **10 Hz** — the
 * finest step the dial can be tuned in — so it is two digits wide and reads
 * like a rig's last digit.
 *
 * `14.025` → `14.025.00`, `14.0274` → `14.027.40`
 */
export function formatDial(freqMHz: number): string {
  const tens = Math.round(freqMHz * 1e5); // dial in units of 10 Hz
  const hz10 = String(tens % 100).padStart(2, "0");
  const khz = String(Math.floor(tens / 100) % 1000).padStart(3, "0");
  return `${Math.floor(tens / 1e5)}.${khz}.${hz10}`;
}

/**
 * The operating screen: the receiver's meter and dial on one line, the band
 * selector under it, and — in the key modes — the panel you transmit from.
 *
 * The dial is the anchor of the layout — centred across the screen, big enough
 * to read from a step back — because on a rig the frequency is the one number
 * that is always being looked at. The meter sits immediately to its left, on
 * the same line, the way it does on a rig: signal strength is read out of the
 * corner of the eye while you watch the dial.
 *
 * The panadapter is *not* here: it belongs to the App and sits under the page,
 * so it keeps its picture when you switch to the log and back. The send bar of
 * the text mode lives down there too (see `App.sendBar`).
 */
export function renderRadio(host: AppHost, root: HTMLElement): void {
  const powered = host.powered !== false;

  const page = el("div", { class: "radio-page" });
  root.append(page);

  // A switched-off rig still has a dial — it is just not lit, and it hears
  // nothing. The meter stays, empty, so the screen does not read as broken.
  const stage = el("div", { class: powered ? "console" : "console off" });
  stage.append(
    renderSMeter({
      reading: () => host.session.sMeter(),
      onLeave: (fn) => host.onLeave(fn),
    }),
    dial(host),
  );
  page.append(stage);

  if (!powered) return;

  page.append(controls(host));
  // The key row and the log entry: the one part of this screen that is read off
  // the air and typed in. It sits above the panadapter with the rest of the
  // operating cluster, and stays put while the display scrolls.
  renderEntryPanel(host, page);
  // Always there, from the moment the rig is on: an operator transmits whenever
  // they want to, not after clicking "start a QSO". Whether anybody answers is
  // up to what the message says and who is listening (see `userSend`).
  renderQsoPanel(host, page);
}

/** The frequency readout: centred in the page, MHz as its unit. */
function dial(host: AppHost): HTMLElement {
  // The unit hangs off the number rather than sitting in the flex row with it,
  // so the *number* — the thing you read — is dead centre, not the pair.
  const value = el("span", { class: "dial-value" });
  value.append(
    el("span", { class: "dial-digits", text: formatDial(host.settings.freqMHz) }),
    el("span", { class: "dial-unit", text: "MHz" }),
  );
  const box = el("div", { class: "dial" });
  box.append(value);
  return box;
}

/**
 * The band selector, as a slim strip under the dial.
 *
 * Nothing else is here on purpose. Tuning is done where the band is visible —
 * the wheel over the panadapter (see `Waterfall`) — so the strip carries no
 * knobs: a row of ±Hz buttons only put a second, worse way to tune next to the
 * one you already have.
 */
function controls(host: AppHost): HTMLElement {
  const bandIndex = Math.min(Math.max(host.settings.bandIndex, 0), BANDS.length - 1);

  const tabs = el("div", { class: "band-tabs" });
  BANDS.forEach((b, i) => {
    tabs.append(
      button(
        b.name,
        () => host.updateSettings({ bandIndex: i, freqMHz: b.defaultMHz }),
        i === bandIndex ? "btn chip active" : "btn chip",
      ),
    );
  });

  const strip = el("div", { class: "rig-controls" });
  strip.append(tabs);
  return strip;
}
