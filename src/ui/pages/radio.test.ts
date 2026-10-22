// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderRadio } from "./radio.js";
import { BANDS } from "../bands.js";
import { normalizeSettings, type AppSettings } from "../settingsSchema.js";
import { QsoSession } from "../session.js";
import type { AppHost, PageId } from "../app.js";

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
    onLeave(_fn: () => void) {},
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

  it("关台时说明本频段其他电台仍在活动（关机 ≠ 环境下线）", () => {
    const { root, host } = makeHost({}, false);
    host.session = {
      hamActivity: () => [
        { ham: { call: "JA1ABC", report: "599" }, state: "cqing" },
        { ham: { call: "DL1XYZ", report: "589" }, state: "listening" },
      ],
    } as unknown as QsoSession;
    host.refresh();

    expect(root.textContent).toContain("本频段仍有 2 个电台在活动");
  });

  it("关台且本频段确实空着时不显示那句提示", () => {
    const { root } = makeHost({}, false);
    expect(root.textContent).toContain("设备已关机");
    expect(root.textContent).not.toContain("在活动");
  });
});

describe("电台页 — 波段与调谐", () => {
  it("列出四个频段并高亮当前频段", () => {
    const { root } = makeHost({ bandIndex: 2 });
    const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>(".band-tabs button"));

    expect(tabs.map((b) => b.textContent)).toEqual(BANDS.map((b) => b.label));
    const active = tabs.filter((b) => b.classList.contains("active"));
    expect(active.length).toBe(1);
    expect(active[0].textContent).toBe(BANDS[2].label);
  });

  it("点击别的频段会切换 bandIndex 与默认频率", () => {
    const { root, host } = makeHost({ bandIndex: 2 });

    findButton(root, BANDS[0].label).click();

    expect(host.settings.bandIndex).toBe(0);
    expect(host.settings.freqMHz).toBe(BANDS[0].defaultMHz);
  });

  it("±1 kHz 步进会改变频率且不越界", () => {
    const { root, host } = makeHost({ bandIndex: 2, freqMHz: 14.025 });

    findButton(root, "+ 1 kHz").click();
    expect(host.settings.freqMHz).toBe(14.026);

    findButton(root, "− 1 kHz").click();
    findButton(root, "− 1 kHz").click();
    expect(host.settings.freqMHz).toBe(14.024);
  });

  it("调谐到下边界时不再继续下降", () => {
    const { root, host } = makeHost({ bandIndex: 2, freqMHz: BANDS[2].minMHz });

    findButton(root, "− 1 kHz").click();
    expect(host.settings.freqMHz).toBe(BANDS[2].minMHz);
  });

  it("±100 Hz 微调用来对准通带", () => {
    const { root, host } = makeHost({ bandIndex: 2, freqMHz: 14.025 });

    findButton(root, "+ 100 Hz").click();
    expect(host.settings.freqMHz).toBe(14.0251);

    findButton(root, "− 100 Hz").click();
    findButton(root, "− 100 Hz").click();
    expect(host.settings.freqMHz).toBe(14.0249);
  });

  it("说明接收通带宽度与电台间隔", () => {
    const { root } = makeHost({ bandIndex: 2 });
    expect(root.textContent).toContain("接收通带 500 Hz");
    expect(root.textContent).toContain("电台间隔 1 kHz");
  });
});

describe("电台页 — 波段活动与通联", () => {
  it("没有活动 HAM 时提示窗口里没有信号", () => {
    const { root } = makeHost();
    expect(root.textContent).toContain("这个窗口里没有信号");
  });

  it("列出频谱窗口内的 HAM、频率与是否在通带内；窗口外的不列", () => {
    const { root, host } = makeHost({ myCall: "BG7XXX" });
    const hams = [
      { call: "JA1ABC", freqHz: 14_027_000, strength: 0.8 },
      { call: "BG7ZZZ", freqHz: 14_028_000, strength: 0.6 },
      // 拨轮外 300 Hz：出了 500 Hz 通带，但还在裙边上（听得到、很弱、不能通联）。
      { call: "VR2ABC", freqHz: 14_025_800, strength: 0.7 },
      // 20 kHz 之外：不在瀑布窗口里，页面上不该出现它的名字。
      { call: "UA0XYZ", freqHz: 14_045_000, strength: 0.5 },
    ];
    host.session = {
      inQso: false,
      dialHz: 14_025_500, // 拨轮停在两格中间：没有台落在 500 Hz 通带里
      passbandHz: 500,
      passbandHalfHz: 250,
      listHams: () => hams,
      hamActivity: () => hams.map((ham) => ({ ham, state: "listening", nextCqAt: 0, cqSince: null })),
      hamCallsCq: async () => true,
      userCallsCq: async () => {},
      heardActiveHam: () => null,
      nearestWorkableHam: () => hams[0],
    } as unknown as QsoSession;
    host.refresh();

    expect(root.textContent).toContain("JA1ABC");
    expect(root.textContent).toContain("BG7ZZZ");
    expect(root.textContent).not.toContain("UA0XYZ");
    expect(root.textContent).toContain("MHz");
    expect(root.textContent).toContain("裙边 · 很弱");
    expect(root.textContent).toContain("听不到");
    expect(root.textContent).toContain("都不在通带内");
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

    expect(root.textContent).toContain("通联状态");
    expect(root.textContent).toContain("收报 / 发报记录");
    expect(root.textContent).not.toContain("开始通联");
  });
});
