// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, safeRenderPage } from "./app.js";
import { renderErrorPanel } from "./errorPanel.js";
import { DISCLAIMER_TEXT } from "./disclaimer.js";
import { BANDS } from "./bands.js";

const NAV_LABELS = ["电台", "日志", "关于"];
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

/** The rig's power button (label carries 开台 / 关台). */
function powerButton(root: HTMLElement): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll<HTMLButtonElement>(".rig button")).find((b) =>
    (b.textContent ?? "").includes("开台") || (b.textContent ?? "").includes("关台"),
  );
  if (!found) throw new Error("未找到电源按钮");
  return found;
}

function gearButton(root: HTMLElement): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll<HTMLButtonElement>(".rig button")).find((b) =>
    (b.textContent ?? "").includes("设置"),
  );
  if (!found) throw new Error("未找到设置齿轮");
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
  it("渲染品牌、三个导航按钮、电台头部与免责页脚", () => {
    const { root } = mountApp();

    expect(root.querySelector(".app-title")?.textContent).toBe("CW QSO 练习器");
    const labels = Array.from(root.querySelectorAll("nav button")).map((b) => b.textContent);
    expect(labels).toEqual(NAV_LABELS);
    expect(root.querySelector(".rig")).not.toBeNull();
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

  it("默认关台：电台页显示待机；开台后显示波段界面", () => {
    const { root, app } = mountApp();

    expect(app.powered).toBe(false);
    expect(root.textContent).toContain("设备已关机");

    app.setPower(true);
    expect(root.textContent).toContain("波段与调谐");
    expect(root.textContent).not.toContain("设备已关机");
  });

  it("电台头部的电源按钮切换开台/关台", () => {
    const { root, app } = mountApp();

    expect(powerButton(root).textContent).toContain("开台");
    powerButton(root).click();
    expect(app.powered).toBe(true);
    expect(powerButton(root).textContent).toContain("关台");
  });

  it("齿轮打开设置面板，可关闭", () => {
    localStorage.setItem(ACK_KEY, "1");
    const { root } = mountApp();

    gearButton(root).click();
    const settings = document.querySelector(".settings-modal");
    expect(settings).not.toBeNull();
    expect(settings?.textContent).toContain("身份");
    expect(settings?.textContent).toContain("本方呼号");

    Array.from(document.querySelectorAll<HTMLButtonElement>(".settings-modal button"))
      .find((b) => b.textContent === "关闭")!
      .click();
    expect(document.querySelector(".settings-modal")).toBeNull();
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

  it("切换波段会切到该波段的会话并显示新频率", () => {
    const { app, root } = mountApp();
    const before = app.session;

    app.updateSettings({ freqMHz: 7.025, bandIndex: 0 });

    expect(app.session).not.toBe(before);
    expect(app.session.freqMHz).toBe(7.025);
    expect(root.querySelector(".rig .freq-value")?.textContent).toBe("7.0250");
  });

  it("同一波段内调谐不会重建会话", () => {
    const { app } = mountApp();
    const before = app.session;

    app.updateSettings({ freqMHz: 14.026 });

    expect(app.session).toBe(before);
    expect(app.session.freqMHz).toBe(14.026);
  });

  it("电台面板的模式标签显示 CW 边带（40m 及以下 CW-L，20m 及以上 CW-U）", () => {
    const { root, app } = mountApp();
    const mode = (): string | null | undefined =>
      root.querySelector(".rig .badge.sideband-btn")?.textContent;

    expect(mode()).toBe("CW-U"); // 默认 14.025 MHz
    expect(app.session.sideband).toBe("USB");

    app.updateSettings({ freqMHz: 7.025, bandIndex: 0 });
    expect(mode()).toBe("CW-L");
    expect(app.session.sideband).toBe("LSB");

    app.updateSettings({ freqMHz: 21.025, bandIndex: 2 });
    expect(mode()).toBe("CW-U");
  });

  it("点击模式标签只改这个波段，换到别的波段仍是它自己的默认模式", () => {
    const { root, app } = mountApp();
    const label = (): HTMLButtonElement =>
      root.querySelector<HTMLButtonElement>(".rig .badge.sideband-btn")!;

    // 默认 20m 跟随波段为 USB
    expect(label().textContent).toBe("CW-U");
    label().click();
    expect(label().textContent).toBe("CW-L");
    expect(app.session.sideband).toBe("LSB");

    // 20m 上的改动不外溢：21m 仍是它自己的默认 CW-U
    app.updateSettings({ freqMHz: 21.025, bandIndex: 2 });
    expect(label().textContent).toBe("CW-U");
    expect(app.session.sideband).toBe("USB");

    // 切回 20m：刚才选的 CW-L 还在（按波段记忆）
    app.updateSettings({ freqMHz: 14.025, bandIndex: 1 });
    expect(label().textContent).toBe("CW-L");
    expect(app.session.sideband).toBe("LSB");

    // 40m 从没动过，用的是波段约定 CW-L
    app.updateSettings({ freqMHz: 7.025, bandIndex: 0 });
    expect(label().textContent).toBe("CW-L");
    expect(app.session.sideband).toBe("LSB");
  });

  it("瀑布图上当前频率是一条竖线，而不是通带的两条边", () => {
    const { root, app } = mountApp();
    expect(root.querySelectorAll(".scope-cursor").length).toBe(1);
    expect(root.querySelector(".scope-passband")).toBeNull();

    // 带宽影响的是声音，不在画面里多画一条边线
    app.updateSettings({ passbandHz: 100 });
    expect(root.querySelectorAll(".scope-cursor").length).toBe(1);
    expect(root.querySelector(".scope-passband")).toBeNull();
  });
});

describe("频谱瀑布图", () => {
  it("电台面板里有一块瀑布图 canvas", () => {
    const { root } = mountApp();
    expect(root.querySelector(".rig-scope canvas")).not.toBeNull();
  });

  it("重绘不会换掉 canvas（历史不清空 —— 画面状态在 App 而非 DOM）", () => {
    const { root, app } = mountApp();
    const canvas = root.querySelector(".rig-scope canvas");

    app.refresh();
    app.updateSettings({ freqMHz: 14.026 });
    app.setPower(true);

    expect(root.querySelector(".rig-scope canvas")).toBe(canvas);
  });

  it("画面不写调谐提示：开台只留画面，关台才说设备已关机", () => {
    const { root, app } = mountApp();
    expect(root.querySelector(".rig-scope")?.textContent).toContain("设备已关机");

    app.setPower(true);
    const scope = root.querySelector(".rig-scope");
    expect(scope?.textContent).toBe("");
  });

  it("滚轮调谐（tuneTo）会被夹在当前波段范围内", () => {
    const { app } = mountApp();
    app.setPower(true);

    app.tuneTo(14_028_000);
    expect(app.settings.freqMHz).toBeCloseTo(14.028, 6);

    app.tuneTo(99_000_000); // far outside 20 m
    expect(app.settings.freqMHz).toBe(BANDS[1].maxMHz);
  });

  it("关台时不允许调谐（关着的电台不会被点动）", () => {
    const { app } = mountApp();
    expect(app.powered).toBe(false);

    app.tuneTo(14_030_000);
    expect(app.settings.freqMHz).toBe(14.025);
  });

  it("会话为每个波段提供频谱数据（含窗口中心与信号）", () => {
    const { app } = mountApp();
    const snapshot = app.session.spectrum();

    expect(snapshot.centerHz).toBe(Math.round(app.session.freqMHz * 1e6));
    expect(Array.isArray(snapshot.signals)).toBe(true);
    expect(snapshot.signals.some((s) => s.workable)).toBe(true);
  });
});

describe("环境与电源（关台只是不接收）", () => {
  it("启动后还没开台，每个波段就已经有虚拟 HAM 在活动", () => {
    const { app } = mountApp();
    expect(app.powered).toBe(false);

    for (let i = 0; i < BANDS.length; i += 1) {
      app.updateSettings({ bandIndex: i, freqMHz: BANDS[i].defaultMHz });
      expect(app.session.listHams().length).toBeGreaterThan(0);
    }
  });

  it("关台不清空：重新开台后还是同一个会话、同一批电台", () => {
    const { app } = mountApp();
    app.setPower(true);
    const session = app.session;
    const calls = session.listHams().map((h) => h.call).sort();

    app.setPower(false);
    expect(app.powered).toBe(false);
    expect(app.session).toBe(session);
    expect(app.session.listHams().map((h) => h.call).sort()).toEqual(calls);

    app.setPower(true);
    expect(app.session).toBe(session);
    expect(app.session.listHams().map((h) => h.call).sort()).toEqual(calls);
  });

  it("只有「开着台 + 当前波段」才在接收", () => {
    const { app } = mountApp();
    expect(app.session.isReceiving).toBe(false);

    app.setPower(true);
    expect(app.session.isReceiving).toBe(true);

    app.setPower(false);
    expect(app.session.isReceiving).toBe(false);
  });

  it("换到别的波段再换回来，原波段没有被拆掉", () => {
    const { app } = mountApp();
    app.setPower(true);
    const first = app.session;
    const firstCalls = first.listHams().map((h) => h.call).sort();

    app.updateSettings({ bandIndex: 0, freqMHz: BANDS[0].defaultMHz });
    expect(app.session).not.toBe(first);
    expect(app.session.isReceiving).toBe(true); // 接收跟着人走
    expect(app.session.listHams().length).toBeGreaterThan(0);

    app.updateSettings({ bandIndex: 1, freqMHz: BANDS[1].defaultMHz });
    expect(app.session).toBe(first);
    expect(app.session.listHams().map((h) => h.call).sort()).toEqual(firstCalls);
  });
});

describe("安全渲染页面边界", () => {
  it("页面渲染正常时调用 render", () => {
    const root = document.createElement("div");
    const render = vi.fn();
    safeRenderPage(render, {} as never, root, () => {});
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("render 抛错时交给 onError 而不是抛出", () => {
    const root = document.createElement("div");
    const onError = vi.fn();
    expect(() =>
      safeRenderPage(
        () => {
          throw new Error("boom");
        },
        {} as never,
        root,
        onError,
      ),
    ).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("onError 接入错误面板后「重试」可重渲染", () => {
    const root = document.createElement("div");
    let retried = false;
    safeRenderPage(
      () => {
        throw new Error("x");
      },
      {} as never,
      root,
      (err) => renderErrorPanel(root, "cw", err, () => {
        retried = true;
      }),
    );
    const retry = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === "重试",
    );
    expect(retry).toBeDefined();
    retry?.click();
    expect(retried).toBe(true);
  });
});
