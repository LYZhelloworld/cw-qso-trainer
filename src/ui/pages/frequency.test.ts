// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderFrequency } from "./frequency.js";
import { BANDS } from "../bands.js";
import { normalizeSettings, type AppSettings } from "../settingsSchema.js";
import { QsoSession } from "../session.js";
import type { AppHost, PageId } from "../app.js";

/** Minimal host double: records updates and re-renders like App does. */
function makeHost(overrides: Partial<AppSettings> = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  const settings = normalizeSettings({ ...overrides });

  const host: AppHost = {
    settings,
    session: {
      listHams: () => [],
      hamCallsCq: async () => {},
      userCallsCq: async () => {},
    } as unknown as QsoSession,
    updateSettings(patch: Partial<AppSettings>) {
      host.settings = normalizeSettings({ ...host.settings, ...patch });
      render();
    },
    newSession() {},
    go(_page: PageId) {},
    refresh() {
      render();
    },
    onLeave(_fn: () => void) {},
  };

  function render(): void {
    const page = document.createElement("div");
    renderFrequency(host, page);
    root.replaceChildren(page);
  }

  render();
  return { host, root, render };
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

describe("频率页", () => {
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
    expect(root.textContent).toContain("3.5500 MHz");
  });

  it("±1 kHz 步进会改变显示频率且不越界", () => {
    const { root, host } = makeHost({ bandIndex: 2, freqMHz: 14.025 });

    findButton(root, "+ 1 kHz").click();
    expect(host.settings.freqMHz).toBe(14.026);
    expect(root.textContent).toContain("14.0260 MHz");

    findButton(root, "− 1 kHz").click();
    findButton(root, "− 1 kHz").click();
    expect(host.settings.freqMHz).toBe(14.024);
  });

  it("调谐到下边界时不再继续下降", () => {
    const { root, host } = makeHost({ bandIndex: 2, freqMHz: BANDS[2].minMHz });

    findButton(root, "− 1 kHz").click();

    expect(host.settings.freqMHz).toBe(BANDS[2].minMHz);
    expect(root.textContent).toContain("14.0000 MHz");
  });

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

  it("未填写本方呼号时提示先去设置，填写后提示改为可以开始", () => {
    const empty = makeHost({ myCall: "" });
    expect(empty.root.textContent).toContain("请先在「设置」页面填写本方呼号");

    const filled = makeHost({ myCall: "BG7XXX" });
    expect(filled.root.textContent).toContain("选择一种方式开始通联");
    expect(filled.root.textContent).not.toContain("请先在「设置」页面填写本方呼号");
  });

  it("提供两种发起通联的方式", () => {
    const { root } = makeHost({ myCall: "BG7XXX" });
    expect(findButton(root, "监听：等 HAM 发 CQ")).toBeDefined();
    expect(findButton(root, "我发 CQ")).toBeDefined();
  });
});
