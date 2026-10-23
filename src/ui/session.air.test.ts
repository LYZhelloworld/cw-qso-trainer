import { describe, expect, it } from "vitest";
import { QsoSession } from "./session.js";
import { normalizeSettings } from "./settingsSchema.js";

/**
 * The onAir debug hook: every HAM transmission fires the listener with an
 * AiredMessage, and the path explains why a signal might be inaudible.
 *
 * `playHam` keys a transmission unconditionally (it is the driver side of
 * `audio`), so it reaches `airStation` whatever the receiver state — the natural
 * way to exercise each path.
 */
describe("session.onAir debug hook", () => {
  const settings = normalizeSettings({ myCall: "BG7XXX" });

  it("fires onAir for each station transmission with the audible path", () => {
    const session = new QsoSession(14.05, settings);
    session.setReceiving(true);
    const captured: string[] = [];
    session.onAir((m) => captured.push(`${m.call}:${m.path}`));

    session.seedHams(1);
    const ham = session.listHams()[0];
    // Tune the station into the passband so it is actually audible.
    (ham as unknown as { freqHz: number }).freqHz = session.dialHz;
    // onAir fires synchronously inside airStation, before the audio promise;
    // we do not await playHam (it waits on real audio timers in node).
    void session.playHam("CQ CQ CQ DE BG7XXX BG7XXX PSE K", ham).catch(() => {});

    expect(captured.some((c) => c.startsWith(ham.call) && c.endsWith("audible"))).toBe(true);
  });

  it("tags an off-band station as offband, not audible", () => {
    // Tight 100 Hz passband; park the station 2 kHz away -> canHear false.
    const session = new QsoSession(14.05, normalizeSettings({ myCall: "BG7XXX", passbandHz: 100 }));
    session.setReceiving(true);
    const paths: string[] = [];
    session.onAir((m) => paths.push(m.path));

    session.seedHams(1);
    const ham = session.listHams()[0];
    (ham as unknown as { freqHz: number }).freqHz = session.dialHz + 2000;
    void session.playHam("CQ CQ CQ DE BG7XXX BG7XXX PSE K", ham).catch(() => {});

    expect(paths).toContain("offband");
  });

  it("tags a powered-down receiver as muted", () => {
    const session = new QsoSession(14.05, settings);
    session.setReceiving(false);
    const paths: string[] = [];
    session.onAir((m) => paths.push(m.path));

    session.seedHams(1);
    void session.playHam("CQ CQ CQ DE BG7XXX BG7XXX PSE K", session.listHams()[0]).catch(() => {});

    expect(paths).toContain("muted");
  });
});
