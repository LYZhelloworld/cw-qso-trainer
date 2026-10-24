import { describe, expect, it } from "vitest";
import { QsoSession } from "../../src/ui/session.js";
import { normalizeSettings } from "../../src/ui/settingsSchema.js";
import { QsoMachine } from "../../src/qso/stateMachine.js";
import { dxccDatabase } from "../../src/data/dxcc.js";

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

/**
 * Regression for the "I answered a CQ but the station never replied" bug.
 *
 * `hamCallsCq` auto-opens a `PEER_CQ` machine for *every* audible CQ, so
 * `this.machine` usually belongs to whichever station's CQ fired most recently.
 * When the operator then answers a *different* station, the old code blindly
 * returned that stale machine — so the reply (if any) came from the wrong
 * station, or the named station simply went back to calling CQ. The fix makes
 * `machineForAudible` re-target to the station named in the operator's line.
 */
describe("answering a CQ re-targets to the named station", () => {
  function makeSession() {
    const session = new QsoSession(
      14.05,
      normalizeSettings({ freqMHz: 14.05, myCall: "BG7XXX" }),
      { rng: () => 0, now: () => 0, startTicking: () => () => {}, delay: async () => {}, pace: async () => {} },
    );
    session.setReceiving(true);
    return session;
  }

  it("replies to the station you named even if another CQ claimed the machine", async () => {
    const session = makeSession();
    session.seedHams(2);
    const [a, b] = session.listHams();
    // Tune to A so it is the one we can hear.
    (a as unknown as { freqHz: number }).freqHz = session.dialHz;
    // Force A into a calling-CQ state (as the scheduler's advance() would).
    session.band.advance(1e9);

    // Precondition of the bug: a *different* station's CQ auto-opened the
    // machine — exactly what hamCallsCq() does for every audible CQ on the band.
    session.ham = b;
    session.machine = new QsoMachine({ myCall: "BG7XXX", ham: b, db: dxccDatabase });
    session.machine.hamCq(); // PEER_CQ for B

    // The operator answers A.
    await session.userSend(`${a.call} DE BG7XXX K`);

    expect(session.ham?.call).toBe(a.call);
    expect(session.state).toBe("EXCHANGE");
    const hamText = session.lines.filter((l) => l.who === "ham").map((l) => l.text).join(" ");
    // The reply came from A (A's report), not the station that had claimed the machine.
    expect(hamText).toMatch(/^R UR RST/);
    expect(hamText).not.toContain(b.call);
  });

  it("keeps the overheard station when the line names nobody", async () => {
    const session = makeSession();
    session.seedHams(2);
    const [, b] = session.listHams();
    (b as unknown as { freqHz: number }).freqHz = session.dialHz;
    session.band.advance(1e9);
    // A bare CQ-answer "R BK" with no callsign keeps the station we already hold.
    session.ham = b;
    session.machine = new QsoMachine({ myCall: "BG7XXX", ham: b, db: dxccDatabase });
    session.machine.hamCq();

    await session.userSend("R BK");

    expect(session.ham?.call).toBe(b.call);
    expect(session.state).toBe("EXCHANGE");
  });
});

