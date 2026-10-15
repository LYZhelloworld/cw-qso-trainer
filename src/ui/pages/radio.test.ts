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
      listHams: () => [],
      hamActivity: () => [],
      hamCallsCq: async () => {},
      userCallsCq: async () => {},
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
});

describe("电台页 — 波段活动与通联", () => {
  it("没有活动 HAM 时提示当前频率没有活动", () => {
    const { root } = makeHost();
    expect(root.textContent).toContain("当前频率没有活动");
  });

  it("列出当前频率上的 HAM 与其 RST", () => {
    const session = new QsoSession(14.025, normalizeSettings({ myCall: "BG7XXX" }));
    session.seedHams(2);
    const { root, host } = makeHost({ myCall: "BG7XXX" });
    host.session = session;
    host.refresh();

    const calls = session.listHams().map((h) => h.call);
    expect(calls.length).toBe(2);
    for (const call of calls) expect(root.textContent).toContain(call);
    expect(root.textContent).toContain("发送 RST");
  });

  it("未填写本方呼号时提示去设置，填写后提示可以开始", () => {
    const empty = makeHost({ myCall: "" });
    expect(empty.root.textContent).toContain("请先填写本方呼号");
    expect(findButton(empty.root, "打开设置")).toBeDefined();

    const filled = makeHost({ myCall: "BG7XXX" });
    expect(filled.root.textContent).toContain("选择一种方式开始通联吧。");
    expect(filled.root.textContent).not.toContain("请先填写本方呼号");
  });

  it("提供两种发起通联的方式", () => {
    const { root } = makeHost({ myCall: "BG7XXX" });
    expect(findButton(root, "监听：等 HAM 发 CQ")).toBeDefined();
    expect(findButton(root, "我发 CQ")).toBeDefined();
  });

  it("通联进行中时显示通联面板，而不是「开始通联」", async () => {
    const session = new QsoSession(14.025, normalizeSettings({ myCall: "BG7XXX" }));
    await session.hamCallsCq(); // enters PEER_CQ
    const { root, host } = makeHost({ myCall: "BG7XXX" });
    host.session = session;
    host.refresh();

    expect(root.textContent).toContain("通联状态");
    expect(root.textContent).toContain("收报 / 发报记录");
    expect(root.textContent).not.toContain("开始通联");
  });
});
