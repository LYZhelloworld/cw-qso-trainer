// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { QsoSession } from "./session.js";
import { normalizeSettings } from "./settingsSchema.js";

/**
 * In-progress QSO staging: a refresh mid-conversation should resume, not discard.
 * localStorage is available under jsdom; each case starts clean.
 */

const KEY = "cw-qso-trainer:qso-staging";

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

beforeEach(() => {
  localStorage.clear();
});

describe("进行中通联暂存", () => {
  it("进行中的通联会在推送报文时写入暂存", async () => {
    const s = makeSession();
    s.seedHams(1);
    const ham = s.listHams()[0];
    s.retune(ham.freqHz / 1e6); // 对准它，通带内才听得见
    await s.hamCallsCq(); // PEER_CQ

    const raw = localStorage.getItem(KEY);
    expect(raw).not.toBeNull();
    const data = JSON.parse(raw!);
    expect(data.freqMHz).toBe(ham.freqHz / 1e6); // 拨轮停在通联频率上
    expect(data.machine.state).toBe("PEER_CQ");
    expect(data.lines.length).toBeGreaterThan(0);
    expect(data.ham.call).toBe(s.ham!.call);
  });

  it("草稿也进入暂存", () => {
    const s = makeSession();
    s.setDraft("R UR RST 599 BK");
    const data = JSON.parse(localStorage.getItem(KEY)!);
    expect(data.draft).toBe("R UR RST 599 BK");
  });

  it("刷新后可以从暂存恢复进行中的通联并继续到完成", async () => {
    const s1 = makeSession();
    s1.seedHams(1);
    s1.retune(s1.listHams()[0].freqHz / 1e6); // 对准它，通带内才听得见
    await s1.hamCallsCq();
    const peer = s1.ham!.call;
    await s1.userSend(`${peer} DE BG7XXX K`); // -> EXCHANGE
    const linesBefore = s1.lines.length;
    expect(s1.state).toBe("EXCHANGE");

    // 模拟刷新：同一设置下新建会话并恢复暂存
    const s2 = makeSession();
    s2.retune(s1.freqMHz); // 拨轮回到同一频率（staging 按频率归属）
    s2.restoreStaging();
    expect(s2.machine).not.toBeNull();
    expect(s2.ham?.call).toBe(peer);
    expect(s2.state).toBe("EXCHANGE");
    expect(s2.lines.length).toBe(linesBefore);

    // 继续通联直到 LOGGED
    await s2.userSend("R UR RST 599 BK"); // SIGNOFF
    await s2.userSend("R TU 73 SK"); // SIGNOFF（HAM 也 TU 73 SK）
    await s2.userSend("R TU 73 SK"); // LOGGED
    expect(s2.state).toBe("LOGGED");
  });

  it("已完成的通联不再暂存（防复活）", async () => {
    const s = makeSession();
    s.seedHams(1);
    s.retune(s.listHams()[0].freqHz / 1e6); // 对准它，通带内才听得见
    await s.hamCallsCq();
    const peer = s.ham!.call;
    await s.userSend(`${peer} DE BG7XXX K`);
    await s.userSend("R UR RST 599 BK");
    await s.userSend("R TU 73 SK");
    await s.userSend("R TU 73 SK"); // LOGGED
    expect(s.state).toBe("LOGGED");
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("reset 会清空暂存", async () => {
    const s = makeSession();
    s.seedHams(1);
    s.retune(s.listHams()[0].freqHz / 1e6); // 对准它，通带内才听得见
    await s.hamCallsCq();
    expect(localStorage.getItem(KEY)).not.toBeNull();
    s.reset();
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
