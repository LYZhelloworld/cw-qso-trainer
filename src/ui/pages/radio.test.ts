// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderRadio } from "./radio.js";
import { BANDS } from "../bands.js";
import { normalizeSettings, type AppSettings } from "../settingsSchema.js";
import { QsoSession } from "../session.js";
import type { AppHost, PageId } from "../app.js";

/** Page-level cleanups handed to `onLeave`, run between tests so the S-meter's
 * redraw timer never outlives the test that started it. */
const pendingCleanups: Array<() => void> = [];

/** Host double for the radio page. `powered` defaults to on. */
function makeHost(overrides: Partial<AppSettings> = {}, powered = true) {
  const root = document.createElement("div");
  document.body.append(root);
  const settings = normalizeSettings({ myCall: "BG7XXX", ...overrides });
  const powerLog: boolean[] = [];

  const host: AppHost = {
    settings,
    session: {
      inQso: false,
      dialHz: 14_025_000,
      passbandHz: 500,
      passbandHalfHz: 250,
      listHams: () => [],
      hamActivity: () => [],
      hamCallsCq: async () => true,
      userCallsCq: async () => {},
      heardActiveHam: () => null,
      nearestWorkableHam: () => null,
      sMeter: () => null,
    } as unknown as QsoSession,
    powered,
    setPower(on: boolean) {
      powerLog.push(on);
    },
    updateSettings(patch: Partial<AppSettings>) {
      host.settings = normalizeSettings({ ...host.settings, ...patch });
      render();
    },
    newSession() {},
    go(_page: PageId) {},
    openSettings() {},
    refresh() {
      render();
    },
    onLeave(fn: () => void) {
      pendingCleanups.push(fn);
    },
  };

  function render(): void {
    const page = document.createElement("div");
    renderRadio(host, page);
    root.replaceChildren(page);
  }

  render();
  return { host, root, render, powerLog };
}

function findButton(root: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent === text,
  );
  if (!found) throw new Error(`未找到按钮：${text}`);
  return found;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  for (const fn of pendingCleanups.splice(0)) fn();
  document.body.innerHTML = "";
});

describe("电台页 — 电源", () => {
  it("关台时显示待机，并提供「开台」按钮，不显示波段内容", () => {
    const { root, powerLog } = makeHost({}, false);

    expect(root.textContent).toContain("设备已关机");
    expect(root.querySelector(".band-tabs")).toBeNull();

    findButton(root, "开台").click();
    expect(powerLog).toEqual([true]);
  });

  it("开台后显示波段与调谐，不再显示待机", () => {
    const { root } = makeHost({}, true);
    expect(root.textContent).not.toContain("设备已关机");
    expect(root.textContent).toContain("波段与调谐");
  });

  it("关台时不再赘述本频段有多少台在活动", () => {
    const { root, host } = makeHost({}, false);
    host.session = {
      hamActivity: () => [
        { ham: { call: "JA1ABC", report: "599" }, state: "cqing" },
        { ham: { call: "DL1XYZ", report: "589" }, state: "listening" },
      ],
    } as unknown as QsoSession;
    host.refresh();

    expect(root.textContent).toContain("设备已关机");
    expect(root.textContent).not.toContain("个电台在活动");
  });
});

describe("电台页 — 波段与调谐", () => {
  it("列出四个频段并高亮当前频段", () => {
    const { root } = makeHost({ bandIndex: 1 });
    const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>(".band-tabs button"));

    expect(tabs.map((b) => b.textContent)).toEqual(BANDS.map((b) => b.label));
    const active = tabs.filter((b) => b.classList.contains("active"));
    expect(active.length).toBe(1);
    expect(active[0].textContent).toBe(BANDS[1].label);
  });

  it("点击别的频段会切换 bandIndex 与默认频率", () => {
    const { root, host } = makeHost({ bandIndex: 1 });

    findButton(root, BANDS[0].label).click();

    expect(host.settings.bandIndex).toBe(0);
    expect(host.settings.freqMHz).toBe(BANDS[0].defaultMHz);
  });

  it("±1 kHz 步进会改变频率且不越界", () => {
    const { root, host } = makeHost({ bandIndex: 1, freqMHz: 14.025 });

    findButton(root, "+ 1 kHz").click();
    expect(host.settings.freqMHz).toBe(14.026);

    findButton(root, "− 1 kHz").click();
    findButton(root, "− 1 kHz").click();
    expect(host.settings.freqMHz).toBe(14.024);
  });

  it("调谐到下边界时不再继续下降", () => {
    const { root, host } = makeHost({ bandIndex: 1, freqMHz: BANDS[1].minMHz });

    findButton(root, "− 1 kHz").click();
    expect(host.settings.freqMHz).toBe(BANDS[1].minMHz);
  });

  it("±100 Hz 微调用来对准通带", () => {
    const { root, host } = makeHost({ bandIndex: 1, freqMHz: 14.025 });

    findButton(root, "+ 100 Hz").click();
    expect(host.settings.freqMHz).toBe(14.0251);

    findButton(root, "− 100 Hz").click();
    findButton(root, "− 100 Hz").click();
    expect(host.settings.freqMHz).toBe(14.0249);
  });

  it("说明接收通带宽度与电台间隔", () => {
    const { root } = makeHost({ bandIndex: 1 });
    expect(root.textContent).toContain("接收通带 500 Hz");
    expect(root.textContent).toContain("电台间隔 1 kHz");
  });
});

describe("电台页 — S 表", () => {
  it("刻度是九段，没有信号时读数为空", () => {
    const { root } = makeHost({ myCall: "BG7XXX" });

    expect(root.querySelectorAll(".signal i").length).toBe(9);
    expect(root.querySelectorAll(".signal i.on").length).toBe(0);
    expect(root.querySelector(".smeter-read")?.textContent).toBe("—");
  });

  it("读数与点亮格数跟着会话的 S 表走", () => {
    const { root, host } = makeHost({ myCall: "BG7XXX" });
    (host.session as unknown as { sMeter: () => unknown }).sMeter = () => ({
      dbm: -85,
      s: 7,
      overDb: 0,
      label: "S7",
    });
    host.refresh();

    expect(root.querySelector(".smeter-read")?.textContent).toBe("S7");
    expect(root.querySelectorAll(".signal i.on").length).toBe(7);
  });

  it("超过 S9 时读数带 dB，并且九格全亮", () => {
    const { root, host } = makeHost({ myCall: "BG7XXX" });
    (host.session as unknown as { sMeter: () => unknown }).sMeter = () => ({
      dbm: -53,
      s: 9,
      overDb: 20,
      label: "S9+20",
    });
    host.refresh();

    expect(root.querySelector(".smeter-read")?.textContent).toBe("S9+20");
    expect(root.querySelectorAll(".signal i.on").length).toBe(9);
  });
});

describe("电台页 — 信号与通联", () => {
  it("页面上没有任何呼号：谁在台上要靠耳朵听", () => {
    const { root, host } = makeHost({ myCall: "BG7XXX" });
    const hams = [
      { call: "JA1ABC", freqHz: 14_027_000, strength: 0.8 },
      { call: "BG7ZZZ", freqHz: 14_028_000, strength: 0.6 },
    ];
    host.session = {
      inQso: false,
      dialHz: 14_025_500, // 拨轮停在两格中间：没有台落在 500 Hz 通带里
      passbandHz: 500,
      passbandHalfHz: 250,
      listHams: () => hams,
      hamActivity: () =>
        hams.map((ham) => ({ ham, state: "listening", nextCqAt: 0, cqSince: null })),
      hamCallsCq: async () => true,
      userCallsCq: async () => {},
      heardActiveHam: () => null,
      nearestWorkableHam: () => hams[0],
      sMeter: () => null,
    } as unknown as QsoSession;
    host.refresh();

    // 谁在哪、叫什么，正是要靠调谐和抄收得到的，页面不该先说出来。
    expect(root.textContent).not.toContain("JA1ABC");
    expect(root.textContent).not.toContain("BG7ZZZ");
    expect(root.textContent).not.toContain("MHz ·");
    // S 表还在：那是接收机自己的读数，不是波段名册。
    expect(root.querySelector(".smeter")).not.toBeNull();
  });

  it("未填写本方呼号时提示去设置，填写后不再提示", () => {
    const empty = makeHost({ myCall: "" });
    expect(empty.root.textContent).toContain("请先填写本方呼号");
    expect(findButton(empty.root, "打开设置")).toBeDefined();

    const filled = makeHost({ myCall: "BG7XXX" });
    expect(filled.root.textContent).not.toContain("请先填写本方呼号");
    expect(filled.root.textContent).toContain("暂时没有电台"); // 空波段
  });

  it("提供两种发起通联的方式", () => {
    const { root } = makeHost({ myCall: "BG7XXX" });
    expect(findButton(root, "监听：等 HAM 发 CQ")).toBeDefined();
    expect(findButton(root, "我发 CQ")).toBeDefined();
  });

  it("空波段上「监听」不可用", () => {
    const { root } = makeHost({ myCall: "BG7XXX" });
    expect(findButton(root, "监听：等 HAM 发 CQ").disabled).toBe(true);
  });

  it("有电台时「监听」会把拨轮扫过去，并说明会自动扫描", () => {
    const { root, host } = makeHost({ myCall: "BG7XXX" });
    host.session = {
      inQso: false,
      dialHz: 14_025_000,
      listHams: () => [],
      hamActivity: () => [],
      hamCallsCq: async () => true,
      userCallsCq: async () => {},
      heardActiveHam: () => null, // 还没对准
      nearestWorkableHam: () => ({ call: "JA1ABC", freqHz: 14_031_000 }),
      sMeter: () => null,
    } as unknown as QsoSession;
    host.refresh();

    expect(findButton(root, "监听：等 HAM 发 CQ").disabled).toBe(false);
    expect(root.textContent).toContain("监听会自动扫描到最近的电台");

    findButton(root, "监听：等 HAM 发 CQ").click();
    expect(host.settings.freqMHz).toBe(14.031); // 自动调谐到该台
  });

  it("拨轮已经对准信号时不用扫描", () => {
    const { root, host } = makeHost({ myCall: "BG7XXX" });
    host.session = {
      inQso: false,
      dialHz: 14_031_000,
      listHams: () => [],
      hamActivity: () => [],
      hamCallsCq: async () => true,
      userCallsCq: async () => {},
      heardActiveHam: () => ({ call: "JA1ABC", freqHz: 14_031_000 }),
      nearestWorkableHam: () => ({ call: "JA1ABC", freqHz: 14_031_000 }),
      sMeter: () => null,
    } as unknown as QsoSession;
    host.refresh();

    expect(root.textContent).toContain("拨轮已经对准了一个信号");
  });

  it("通联进行中时显示通联面板，而不是「开始通联」", async () => {
    const session = new QsoSession(14.025, normalizeSettings({ myCall: "BG7XXX" }));
    session.seedHams(1);
    session.retune(session.listHams()[0].freqHz / 1e6); // 对准它，通带内才听得见
    await session.hamCallsCq(); // enters PEER_CQ
    const { root, host } = makeHost({ myCall: "BG7XXX" });
    host.session = session;
    host.refresh();

    expect(root.textContent).toContain("电键输入");
    expect(root.textContent).not.toContain("开始通联");
    // 状态行与收发记录都不显示：报文只在空中，屏幕上没有回放。
    expect(root.textContent).not.toContain("通联状态");
    expect(root.textContent).not.toContain("收报 / 发报记录");
  });
});
