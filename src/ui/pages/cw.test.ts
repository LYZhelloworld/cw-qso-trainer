// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderCw } from "./cw.js";
import { normalizeSettings, type AppSettings } from "../settingsSchema.js";
import { QsoSession } from "../session.js";
import type { AppHost, PageId } from "../app.js";

/** Mounts the CW page against a real session with a controllable host double. */
function makeHarness(overrides: Partial<AppSettings> = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  const settings = normalizeSettings({ myCall: "BG7XXX", assistMode: false, ...overrides });
  const session = new QsoSession(14.025, settings);
  let cleanups: Array<() => void> = [];

  const host: AppHost = {
    settings,
    session,
    updateSettings(patch: Partial<AppSettings>) {
      host.settings = normalizeSettings({ ...host.settings, ...patch });
      session.updateSettings(host.settings);
      render();
    },
    newSession() {
      session.reset();
      session.seedHams(3);
      render();
    },
    go(_page: PageId) {},
    refresh() {
      render();
    },
    onLeave(fn: () => void) {
      cleanups.push(fn);
    },
  };

  function render(): void {
    for (const fn of cleanups) fn();
    cleanups = [];
    const page = document.createElement("div");
    renderCw(host, page);
    root.replaceChildren(page);
  }

  render();
  return { host, session, root, render, cleanups: () => cleanups.length };
}

function findButton(root: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent === text,
  );
  if (!found) throw new Error(`未找到按钮：${text}`);
  return found;
}

function hamRows(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(".cw-pane .cw-line.ham"));
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("CW 翻译页", () => {
  it("没有通联内容时给出引导提示", () => {
    const { root } = makeHarness();
    expect(root.textContent).toContain("尚无通联内容");
  });

  it("对方发来 CQ 后显示一行对方报文", async () => {
    const { root, session, render } = makeHarness({ assistMode: true });
    await session.hamCallsCq();
    render();

    const rows = hamRows(root);
    expect(rows.length).toBe(1);
    expect(rows[0].querySelector(".who")?.textContent).toBe("对方");
    expect(rows[0].textContent).toContain(session.lines[0].text);
    expect(root.textContent).toContain(`对方 ${session.ham?.call}`);
  });

  it("辅助模式关闭时对方内容被遮蔽并提供单条「显示」", async () => {
    const { root, session, render } = makeHarness({ assistMode: false });
    await session.hamCallsCq();
    render();

    const row = hamRows(root)[0];
    expect(row.querySelector(".masked")).not.toBeNull();
    expect(row.textContent).not.toContain(session.lines[0].text);
    expect(row.querySelector("button")?.textContent).toBe("显示");
  });

  it("点击「显示」只揭示该条报文且原文可读", async () => {
    const { root, session, render } = makeHarness({ assistMode: false });
    await session.hamCallsCq();
    render();

    findButton(hamRows(root)[0], "显示").click();

    const row = hamRows(root)[0];
    expect(row.querySelector(".masked")).toBeNull();
    expect(row.textContent).toContain(session.lines[0].text);
    expect(row.querySelector("button")).toBeNull();
  });

  it("辅助模式开启时直接显示原文并给出提示横幅", async () => {
    const { root, session, render } = makeHarness({ assistMode: true });
    await session.hamCallsCq();
    render();

    expect(root.querySelector(".assist-banner")?.textContent).toContain("辅助模式开启");
    expect(root.querySelector(".masked")).toBeNull();
  });

  it("勾选辅助模式复选框会更新设置并重绘", () => {
    const { root, host } = makeHarness({ assistMode: false });

    const box = root.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(box).not.toBeNull();
    box!.checked = true;
    box!.dispatchEvent(new Event("change"));

    expect(host.settings.assistMode).toBe(true);
    expect(root.querySelector(".assist-banner")).not.toBeNull();
  });

  it("短语宏会把预设报文填入输入框", () => {
    const { root } = makeHarness();
    const input = root.querySelector("textarea");
    expect(input).not.toBeNull();

    findButton(root, "RST 599").click();
    expect(input!.value).toBe("R UR RST 599 BK");

    findButton(root, "73 SK").click();
    expect(input!.value).toBe("R TU 73 SK");
  });

  it("发送报文后会把「我」这一行追加到记录里", async () => {
    const { root, session, render } = makeHarness({ assistMode: true });
    await session.hamCallsCq();
    render();

    const peer = session.ham!.call;
    const input = root.querySelector("textarea")!;
    input.value = `${peer} DE BG7XXX K`;
    findButton(root, "发送").click();

    await vi.waitFor(() => {
      expect(session.lines.some((l) => l.who === "me" && l.text.includes("DE BG7XXX"))).toBe(true);
    });
    await vi.waitFor(() => {
      expect(root.querySelectorAll(".cw-pane .cw-line.me").length).toBe(1);
    });
    expect(root.querySelector(".cw-pane .cw-line.me .who")?.textContent).toBe("我");
  });

  it("「新通联」会清空记录并回到初始提示", async () => {
    const { root, session, host } = makeHarness({ assistMode: true });
    await session.hamCallsCq();
    host.refresh();
    expect(root.querySelector(".cw-pane")?.textContent).not.toContain("尚无通联内容");

    host.newSession();

    expect(session.lines.length).toBe(0);
    expect(root.querySelector(".cw-pane")?.textContent).toContain("尚无通联内容");
  });

  it("离开页面时注销键盘监听（清理钩子已注册）", () => {
    const harness = makeHarness();
    expect(harness.cleanups()).toBeGreaterThan(0);
  });

  it("重绘（切换辅助模式）不会弄丢输入框里还没发送的报文", () => {
    const { root, host } = makeHarness({ assistMode: true });
    const first = root.querySelector("textarea")!;
    first.value = "R UR RST 5"; // 输入一半，尚未发送
    first.dispatchEvent(new Event("input"));

    const assist = root.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    assist.checked = false;
    assist.dispatchEvent(new Event("change"));

    expect(host.settings.assistMode).toBe(false);
    expect(root.querySelector("textarea")!.value).toBe("R UR RST 5");
  });
});
