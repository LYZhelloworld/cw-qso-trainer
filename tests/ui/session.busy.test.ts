import { describe, expect, it } from "vitest";
import { QsoSession } from "../../src/ui/session.js";
import { normalizeSettings } from "../../src/ui/settingsSchema.js";

/**
 * Concurrency guard for transmissions. No timers, no DOM: `delay` resolves
 * immediately so a second `userSend` fired before the first awaited reply is
 * observed and dropped rather than interleaved.
 */

function makeSession() {
  const settings = normalizeSettings({ freqMHz: 14.05, myCall: "BG7XXX" });
  return new QsoSession(14.05, settings, {
    rng: () => 0,
    now: () => 0,
    startTicking: () => () => {},
    delay: async () => {},
    pace: async () => {},
  });
}

describe("发送 busy 保护", () => {
  it("并发发送只有第一次生效，不会交错报文", async () => {
    const s = makeSession();
    s.seedHams(1);
    s.retune(s.listHams()[0].freqHz / 1e6); // 对准它，通带内才听得见
    await s.hamCallsCq(); // 进入 PEER_CQ
    const peer = s.ham!.call;

    const p1 = s.userSend(`${peer} DE BG7XXX K`);
    const p2 = s.userSend(`${peer} DE BG7XXX K`); // 并发，应被丢弃
    await Promise.all([p1, p2]);

    expect(s.lines.filter((l) => l.who === "me").length).toBe(1);
    expect(s.isSending).toBe(false);
  });

  it("顺序发送不受影响（每次都完成）", async () => {
    const s = makeSession();
    s.seedHams(1);
    s.retune(s.listHams()[0].freqHz / 1e6); // 对准它，通带内才听得见
    await s.hamCallsCq();
    const peer = s.ham!.call;
    await s.userSend(`${peer} DE BG7XXX K`);
    await s.userSend("R UR RST 599 BK");

    expect(s.state).toBe("SIGNOFF");
    expect(s.lines.filter((l) => l.who === "me").length).toBe(2);
    expect(s.isSending).toBe(false);
  });
});
