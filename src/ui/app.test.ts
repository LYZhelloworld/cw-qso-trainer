// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "./app.js";
import { DISCLAIMER_TEXT } from "./disclaimer.js";

const NAV_LABELS = ["频率", "CW 翻译", "日志", "设置", "关于"];
const ACK_KEY = "cw-qso-trainer:disclaimer-ack";
const SETTINGS_KEY = "cw-qso-trainer:settings";

/** Every mounted app, so the scheduler it starts is always stopped afterwards. */
const mounted: App[] = [];

function mountApp(): { app: App; root: HTMLElement } {
  const root = document.createElement("div");
  document.body.append(root);
  const app = new App(root);
  app.start();
  mounted.push(app);
  return { app, root };
}

function navButton(root: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll<HTMLButtonElement>("nav button")).find(
    (b) => b.textContent === label,
  );
  if (!found) throw new Error(`未找到导航按钮：${label}`);
  return found;
}

beforeEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});

afterEach(() => {
  // Without this each case would leave a live scheduler ticking forever.
  for (const app of mounted) app.dispose();
  mounted.length = 0;
  document.body.innerHTML = "";
});

describe("App 外壳", () => {
  it("渲染标题、五个导航按钮与免责页脚", () => {
    const { root } = mountApp();

    expect(root.querySelector(".app-title")?.textContent).toBe("CW QSO 练习器");
    const labels = Array.from(root.querySelectorAll("nav button")).map((b) => b.textContent);
    expect(labels).toEqual(NAV_LABELS);
    expect(root.querySelector(".footer")?.textContent).toBe(DISCLAIMER_TEXT);
  });

  it("首次启动弹出免责声明，点击「我已知晓」后关闭并记住选择", () => {
    mountApp();

    const overlay = document.querySelector(".modal-overlay");
    expect(overlay).not.toBeNull();
    expect(overlay?.textContent).toContain(DISCLAIMER_TEXT);

    const ack = Array.from(document.querySelectorAll<HTMLButtonElement>(".modal button")).find(
      (b) => b.textContent === "我已知晓",
    );
    expect(ack).toBeDefined();
    ack?.click();

    expect(document.querySelector(".modal-overlay")).toBeNull();
    expect(localStorage.getItem(ACK_KEY)).toBe("1");
  });

  it("已经确认过免责声明时不再弹窗", () => {
    localStorage.setItem(ACK_KEY, "1");
    mountApp();
    expect(document.querySelector(".modal-overlay")).toBeNull();
  });

  it("默认落在频率页，点击导航可切换到 CW 翻译页", () => {
    const { root } = mountApp();

    expect(root.textContent).toContain("频段");
    navButton(root, "CW 翻译").click();
    expect(root.textContent).toContain("通联状态");
    expect(root.textContent).toContain("收报 / 发报记录");
  });

  it("关于页显示版本号与免责声明", () => {
    const { root } = mountApp();

    navButton(root, "关于").click();
    expect(root.textContent).toContain("CW QSO 练习器 v0.1.0");
    expect(root.textContent).toContain(DISCLAIMER_TEXT);
    expect(root.textContent).toContain("日志不可导出为 ADIF / CSV / JSON");
  });

  it("更新设置会写入 localStorage", () => {
    const { app } = mountApp();

    app.updateSettings({ myCall: "BG7XXX" });
    const stored = localStorage.getItem(SETTINGS_KEY);
    expect(stored).not.toBeNull();
    expect(JSON.parse(stored ?? "{}").myCall).toBe("BG7XXX");
  });

  it("切换频率会重建会话（不同频率即不同 HAM 集合）", () => {
    const { app, root } = mountApp();
    const before = app.session;

    app.updateSettings({ freqMHz: 7.025, bandIndex: 1 });

    expect(app.session).not.toBe(before);
    expect(app.session.freqMHz).toBe(7.025);
    expect(root.textContent).toContain("7.0250 MHz");
  });
});
