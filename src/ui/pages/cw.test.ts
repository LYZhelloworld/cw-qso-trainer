// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderQsoPanel } from "./cw.js";
import { normalizeSettings, type AppSettings } from "../settingsSchema.js";
import { QsoSession } from "../session.js";
import type { AppHost, PageId } from "../app.js";

/** Mounts the CW page against a real session with a controllable host double. */
function makeHarness(overrides: Partial<AppSettings> = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  const settings = normalizeSettings({ myCall: "BG7XXX", ...overrides });
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
    renderQsoPanel(host, page);
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

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("通联面板", () => {
  it("只有发送、电键与操作，没有状态行与收发记录", () => {
    const { root } = makeHarness();
    expect(root.textContent).toContain("发送");
    expect(root.textContent).toContain("电键输入");
    expect(root.textContent).toContain("操作");
    // 状态行、记录面板都不在了。
    expect(root.textContent).not.toContain("通联状态");
    expect(root.textContent).not.toContain("收报 / 发报记录");
    expect(root.textContent).not.toContain("尚无通联内容");
    expect(root.querySelector(".cw-pane")).toBeNull();
  });

  it("不显示对方是谁：呼号要靠抄收", async () => {
    const { root, session, render } = makeHarness();
    session.seedHams(1);
    session.retune(session.listHams()[0].freqHz / 1e6); // 对准它，通带内才听得见
    await session.hamCallsCq();
    render();

    const call = session.ham!.call;
    expect(root.textContent).not.toContain(call);
    expect(root.textContent).not.toContain("对方 ");
  });

  it("短语宏会把预设报文填入输入框", () => {
    const { root } = makeHarness();
    const input = root.querySelector("textarea");
    expect(input).not.toBeNull();

    findButton(root, "RST 599").click();
    expect(input!.value).toBe("R UR RST 599 BK");

    findButton(root, "73 SK").click();
    expect(input!.value).toBe("R TU 73 SK");

    // 宏里只有协议，没有对方呼号——那个得自己抄。
    findButton(root, "我发 CQ").click();
    expect(input!.value).toBe("CQ CQ CQ DE BG7XXX BG7XXX PSE K");
  });

  it("发送后会清空输入框，但不会在页面上留下记录", async () => {
    const { root, session, render } = makeHarness();
    session.seedHams(1);
    session.retune(session.listHams()[0].freqHz / 1e6); // 对准它，通带内才听得见
    await session.hamCallsCq();
    render();

    const input = root.querySelector("textarea")!;
    input.value = "R UR RST 599 BK";
    findButton(root, "发送").click();

    expect(input.value).toBe("");
    await vi.waitFor(() => {
      expect(session.lines.some((l) => l.who === "me")).toBe(true);
    });
    // 报文进了空中，没有进屏幕。
    expect(root.querySelector(".cw-pane")).toBeNull();
  });

  it("离开页面时注销键盘监听（清理钩子已注册）", () => {
    const harness = makeHarness();
    expect(harness.cleanups()).toBeGreaterThan(0);
  });

  it("重绘不会弄丢输入框里还没发送的报文", () => {
    const { root, host } = makeHarness();
    const first = root.querySelector("textarea")!;
    first.value = "R UR RST 5"; // 输入一半，尚未发送
    first.dispatchEvent(new Event("input"));

    host.refresh();

    expect(root.querySelector("textarea")!.value).toBe("R UR RST 5");
  });
});

describe("CW 页 iambic 双桨输入", () => {
  const IAMBIC = {
    keyMode: "iambic" as const,
    dotCode: "KeyZ",
    dashCode: "KeyX",
    wpm: 20, // 点长 60ms
  };

  const press = (code: string): void => {
    document.dispatchEvent(new KeyboardEvent("keydown", { code }));
  };
  const release = (code: string): void => {
    document.dispatchEvent(new KeyboardEvent("keyup", { code }));
  };

  it("iambic 模式下展示双桨键位提示", () => {
    const { root } = makeHarness(IAMBIC);
    expect(root.textContent).toContain("点键「KeyZ」");
    expect(root.textContent).toContain("划键「KeyX」");
    expect(root.textContent).toContain("电键输入（iambic 双桨）");
  });

  it("敲一个点键后解码出的字符写入发送框", async () => {
    const { root } = makeHarness(IAMBIC);
    const input = root.querySelector("textarea")!;

    press("KeyZ");
    await sleep(70); // 一个点长 60ms
    release("KeyZ");

    await vi.waitFor(() => expect(input.value).toBe("E"), { timeout: 2000, interval: 20 });
  });

  it("squeeze（点划同按）交替发出点划", async () => {
    const { root } = makeHarness(IAMBIC);
    const input = root.querySelector("textarea")!;

    press("KeyZ");
    press("KeyX"); // 双桨同按 -> 点划交替
    await sleep(250); // 点(60) + 间隔(60) + 划进行到一半
    release("KeyZ");
    release("KeyX");

    // 模式 A（默认）：松开双桨即停，敲出 .- = A
    await vi.waitFor(() => expect(input.value).toBe("A"), { timeout: 2000, interval: 20 });
  });

  it("空格键插入单词间隔，后续字符被分开", async () => {
    const { root } = makeHarness(IAMBIC);
    const input = root.querySelector("textarea")!;

    press("KeyZ");
    await sleep(70);
    release("KeyZ");
    await vi.waitFor(() => expect(input.value).toBe("E"), { timeout: 2000, interval: 20 });

    press("Space"); // 分词
    press("KeyZ");
    await sleep(70);
    release("KeyZ");

    await vi.waitFor(() => expect(input.value).toBe("E E"), { timeout: 2000, interval: 20 });
  });

  it("直键模式下 iambic 键位不生效", async () => {
    const { root } = makeHarness({ keyMode: "straight", dotCode: "KeyZ", wpm: 20 });
    const input = root.querySelector("textarea")!;

    press("KeyZ");
    await sleep(70);
    release("KeyZ");
    await sleep(400);

    expect(input.value).toBe("");
    expect(root.textContent).toContain("电键输入（直键）");
  });
});

describe("堆叠提示", () => {
  it("多台应答时标出台数并提示必须点名，但不给出呼号", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    let t = 0;
    const ticks: Array<() => void> = [];
    const settings = normalizeSettings({ myCall: "BG7XXX" });
    const session = new QsoSession(14.025, settings, {
      now: () => t,
      startTicking: (cb) => {
        ticks.push(cb);
        return () => {};
      },
      delay: async () => {},
    });
    const host = {
      settings,
      session,
      updateSettings() {},
      newSession() {},
      go() {},
      refresh() {},
      onLeave() {},
    } as unknown as AppHost;

    await session.userCallsCq();
    session.start();
    // Drive the injected clock until at least one station has called.
    for (t = 250; t <= 20_000 && session.heardPileupCallers().length === 0; t += 250) {
      for (const cb of ticks) cb();
    }

    renderQsoPanel(host, root);
    const caller = session.heardPileupCallers()[0];
    expect(caller).toBeDefined();
    expect(root.textContent).toContain("必须点名");
    // 谁在应你、有几台，都得自己听；页面上不列、也没有「点名 XXX」按钮。
    expect(root.textContent).not.toContain(caller.call);
    expect(root.textContent).not.toContain("台同时应答");
    expect(
      Array.from(root.querySelectorAll("button")).some((b) => (b.textContent ?? "").includes("点名")),
    ).toBe(false);
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
