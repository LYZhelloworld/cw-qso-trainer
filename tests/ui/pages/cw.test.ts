// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderQsoPanel } from "../../../src/ui/pages/cw.js";
import { normalizeSettings, type AppSettings } from "../../../src/ui/settingsSchema.js";
import { QsoSession } from "../../../src/ui/session.js";
import type { AppHost, PageId } from "../../../src/ui/app.js";

/** Mounts the CW page against a real session with a controllable host double. */
function makeHarness(
  overrides: Partial<AppSettings> = {},
  options: ConstructorParameters<typeof QsoSession>[2] = {},
) {
  const root = document.createElement("div");
  document.body.append(root);
  const settings = normalizeSettings({ myCall: "BG7XXX", ...overrides });
  const session = new QsoSession(14.025, settings, options);
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

describe("三种发报模式", () => {
  it("直键模式沿用报文模式的版面，底部是只读回显框", () => {
    const { root } = makeHarness({ keyMode: "straight" });
    // 页面内容区的文字全部来自顶栏与瀑布图，这一段只挂回显框。
    expect(root.textContent).toBe("");
    const echo = root.querySelector<HTMLElement>(".send-echo");
    expect(echo).not.toBeNull();
    // 末尾有块状光标，框本身不是可编辑控件。
    expect(echo!.querySelector(".echo-caret")).not.toBeNull();
    expect(echo!.querySelector("input, textarea")).toBeNull();
    // 也没有「发送」按钮：直键模式不需要再按一次。
    expect(
      Array.from(root.querySelectorAll("button")).map((b) => b.textContent),
    ).not.toContain("发送");
  });

  it("文本模式只有发送框，底部没有回显框", () => {
    const { root } = makeHarness({ keyMode: "text" });
    expect(root.querySelector<HTMLInputElement>(".send-input")).not.toBeNull();
    expect(root.textContent).toContain("发送");
    expect(root.querySelector(".send-echo")).toBeNull();
  });

  it("iambic 模式沿用同一版面，回显框照旧在", () => {
    const { root } = makeHarness({ keyMode: "iambic" });
    // 键名与侧音都属于设置页；页面上一个字都不该出现，这里一并守住。
    expect(root.textContent).toBe("");
    expect(root.querySelector(".send-echo")).not.toBeNull();
  });
});

describe("通联面板", () => {
  it("文本模式：没有状态行、记录面板与操作按钮", () => {
    const { root } = makeHarness({ keyMode: "text" });
    expect(root.textContent).toContain("发送");
    expect(root.textContent).not.toContain("操作");
    expect(root.textContent).not.toContain("通联状态");
    expect(root.textContent).not.toContain("收报 / 发报记录");
    expect(root.textContent).not.toContain("尚无通联内容");
    expect(root.querySelector(".cw-pane")).toBeNull();
  });

  it("不显示对方是谁：呼号要靠抄收", async () => {
    const { root, session, render } = makeHarness({ keyMode: "text" });
    session.seedHams(1);
    session.retune(session.listHams()[0].freqHz / 1e6); // 对准它，通带内才听得见
    await session.hamCallsCq();
    render();

    const call = session.ham!.call;
    expect(root.textContent).not.toContain(call);
    expect(root.textContent).not.toContain("对方 ");
  });

  it("没有短语宏：报文自己打", () => {
    const { root } = makeHarness({ keyMode: "text" });
    const labels = Array.from(root.querySelectorAll("button")).map((b) => b.textContent);
    expect(labels).not.toContain("RST 599");
    expect(labels).not.toContain("我发 CQ");
    expect(labels).not.toContain("73 SK");
  });

  it("发送后会清空输入框，但不会在页面上留下记录", async () => {
    const { root, session, render } = makeHarness({ keyMode: "text" });
    session.seedHams(1);
    session.retune(session.listHams()[0].freqHz / 1e6); // 对准它，通带内才听得见
    await session.hamCallsCq();
    render();

    const input = root.querySelector<HTMLInputElement>(".send-input")!;
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
    const harness = makeHarness({ keyMode: "straight" });
    expect(harness.cleanups()).toBeGreaterThan(0);
  });

  it("重绘不会弄丢输入框里还没发送的报文", () => {
    const { root, host } = makeHarness({ keyMode: "text" });
    const first = root.querySelector<HTMLInputElement>(".send-input")!;
    first.value = "R UR RST 5"; // 输入一半，尚未发送
    first.dispatchEvent(new Event("input"));

    host.refresh();

    expect(root.querySelector<HTMLInputElement>(".send-input")!.value).toBe("R UR RST 5");
  });

  it("输入自动转成大写：草稿、日志、解析看到的是同一种拼法", () => {
    const { root, session } = makeHarness({ keyMode: "text" });
    const input = root.querySelector<HTMLInputElement>(".send-input")!;
    input.value = "bg7xxx de bd4vqk k";
    input.dispatchEvent(new Event("input"));

    expect(input.value).toBe("BG7XXX DE BD4VQK K");
    expect(session.draft).toBe("BG7XXX DE BD4VQK K");
  });

  it("转大写不把光标甩到末尾", () => {
    const { root } = makeHarness({ keyMode: "text" });
    const input = root.querySelector<HTMLInputElement>(".send-input")!;
    input.value = "rah";
    input.setSelectionRange(1, 1); // 光标在 r 后面
    input.dispatchEvent(new Event("input"));

    expect(input.value).toBe("RAH");
    expect(input.selectionStart).toBe(1);
  });

  it("Enter 直接发送，不必按 Ctrl", async () => {
    const instant = { delay: async () => {}, pace: async () => {} };
    const { root, session } = makeHarness({ keyMode: "text" }, instant);
    const input = root.querySelector<HTMLInputElement>(".send-input")!;
    input.value = "CQ CQ CQ DE BG7XXX PSE K";
    input.dispatchEvent(new Event("input"));

    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );

    await vi.waitFor(() => expect(session.lines.some((l) => l.who === "me")).toBe(true), {
      timeout: 2000,
      interval: 20,
    });
  });

  it("发送完焦点留在输入框里，接着敲下一条不用点鼠标", async () => {
    const instant = { delay: async () => {}, pace: async () => {} };
    const { root } = makeHarness({ keyMode: "text" }, instant);
    const input = root.querySelector<HTMLInputElement>(".send-input")!;
    input.value = "R";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );

    await vi.waitFor(
      () => {
        const live = root.querySelector<HTMLInputElement>(".send-input");
        expect(live).not.toBeNull();
        expect(document.activeElement).toBe(live);
      },
      { timeout: 2000, interval: 20 },
    );
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
  /** The text of the operator's overs that went on the air. */
  const sent = (session: QsoSession): string[] =>
    session.lines.filter((l) => l.who === "me").map((l) => l.text);

  it("双键敲下的点划先挂在末尾，解出字符后被文字替换", async () => {
    const { root } = makeHarness(IAMBIC);
    const text = (): string | null => root.querySelector(".echo-text")!.textContent;
    const pending = (): string | null => root.querySelector(".echo-pending")!.textContent;

    // 点只按住 30 ms（短于一个元素），松开后才是一个点；按住跨过元素边界
    // 会按 iambic 的记忆继续发第二个点。
    press("KeyZ");
    await sleep(30);
    release("KeyZ");

    // 元素发完（1d）之后符号才出现，此时还没到字符间隔。
    await vi.waitFor(() => expect(pending()).toBe("."), { timeout: 1000, interval: 20 });
    // 字符间隔过后，符号被解成 E。
    await vi.waitFor(() => expect(text()).toBe("E"), { timeout: 2000, interval: 20 });
    expect(pending()).toBe("");
  });

  it("发报途中页面被重绘（离开 / 换页）：载波落下，不会卡在发射状态", async () => {
    const { host, session } = makeHarness(IAMBIC);

    press("KeyZ");
    await vi.waitFor(() => expect(session.isTransmitting).toBe(true), { interval: 10 });
    expect(session.isSending).toBe(true);

    // 重绘会跑掉页面注册的清理钩子：没有键控逻辑来发 key-up 了，载波必须由这里放下。
    host.refresh();

    expect(session.isTransmitting).toBe(false);
    expect(session.isSending).toBe(false);
    // 不会把下一次发报挡在门外。
    expect(session.beginLiveKeying()).toBe(true);
    session.cancelLiveKeying();

    release("KeyZ");
  });

  it("敲一个点键，停手后自动结束发射，报文上机", async () => {
    const { session } = makeHarness(IAMBIC);

    press("KeyZ");
    await sleep(70); // 一个点长 60ms
    release("KeyZ");

    // 没有「发送完毕」这类按钮：停手 1.5 秒后电键自己收尾。
    await vi.waitFor(() => expect(sent(session)).toContain("E"), {
      timeout: 3000,
      interval: 20,
    });
    // 收尾就是松 PTT：TX 灭、接收机重新打开。
    await vi.waitFor(() => expect(session.isTransmitting).toBe(false), {
      timeout: 3000,
      interval: 20,
    });
  });

  it("squeeze（点划同按）交替发出点划", async () => {
    const { session } = makeHarness(IAMBIC);

    press("KeyZ");
    press("KeyX"); // 双桨同按 -> 点划交替
    await sleep(250); // 点(60) + 间隔(60) + 划进行到一半
    release("KeyZ");
    release("KeyX");

    // 模式 A（默认）：松开双桨即停，敲出 .- = A
    await vi.waitFor(() => expect(sent(session)).toContain("A"), {
      timeout: 3000,
      interval: 20,
    });
  });

  it("停久一点自动分词，不需要按空格", async () => {
    const { root, session } = makeHarness(IAMBIC);

    press("KeyZ");
    await sleep(70);
    release("KeyZ");
    // 等第一个字符真的解出来，再停；否则两个点会被并成一个 I。
    await vi.waitFor(
      () => expect(root.querySelector(".echo-text")!.textContent).toBe("E"),
      { timeout: 2000, interval: 20 },
    );

    // 距上一个元素 7d 以上（20 WPM 下 420 ms，这里停 500 ms）。
    await sleep(500);
    press("KeyZ");
    await sleep(70);
    release("KeyZ");

    await vi.waitFor(() => expect(sent(session)).toContain("E E"), {
      timeout: 3000,
      interval: 20,
    });
  });

  it("面板上没有任何手动收尾的按钮：停手就是收尾", () => {
    const pairs = [
      makeHarness(IAMBIC).root,
      makeHarness({ keyMode: "straight", keyCode: "KeyC", wpm: 20 }).root,
    ];
    for (const root of pairs) {
      const labels = Array.from(root.querySelectorAll("button")).map((b) => b.textContent);
      expect(labels).not.toContain("发送完毕");
      expect(labels).not.toContain("结束本句");
      expect(labels).not.toContain("发送");
    }
  });

  it("直键同样是停手后自动收尾：TX 灭、报文上机", async () => {
    const { session } = makeHarness({ keyMode: "straight", keyCode: "KeyC", wpm: 20 });

    press("KeyC");
    await sleep(70); // 一个点
    release("KeyC");

    await vi.waitFor(() => expect(sent(session)).toContain("E"), {
      timeout: 3000,
      interval: 20,
    });
    await vi.waitFor(() => expect(session.isTransmitting).toBe(false), {
      timeout: 3000,
      interval: 20,
    });
  });

  it("直键敲出的字符先出现在只读框里，发出后清空", async () => {
    const { root, session } = makeHarness({ keyMode: "straight", keyCode: "KeyC", wpm: 20 });
    const echoText = (): string | null => root.querySelector(".echo-text")!.textContent;
    const pending = (): string | null => root.querySelector(".echo-pending")!.textContent;

    press("KeyC");
    await sleep(70); // 一个点
    release("KeyC");
    // 还没到字符间隔：点划先以符号的形式挂在那里。
    expect(pending()).toBe(".");

    // 点之后过一个字符间隔（3d = 180 ms），符号被解成 E。
    await vi.waitFor(() => expect(echoText()).toBe("E"), { timeout: 2000, interval: 20 });
    expect(pending()).toBe("");
    // 停手 1.5 秒自动发出：报文上机，框清空。
    await vi.waitFor(() => expect(sent(session)).toContain("E"), {
      timeout: 3000,
      interval: 20,
    });
    expect(echoText()).toBe("");
  });

  it("直键模式下 iambic 键位不生效", async () => {
    const { session } = makeHarness({ keyMode: "straight", dotCode: "KeyZ", wpm: 20 });

    press("KeyZ");
    await sleep(70);
    release("KeyZ");
    await sleep(400);

    expect(sent(session)).toEqual([]);
  });
});

describe("堆叠", () => {
  it("多台应答时页面上什么都不说：谁在应你、有几台，全靠耳朵", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    let t = 0;
    const ticks: Array<() => void> = [];
    const settings = normalizeSettings({ myCall: "BG7XXX", keyMode: "text" });
    const session = new QsoSession(14.025, settings, {
      now: () => t,
      startTicking: (cb) => {
        ticks.push(cb);
        return () => {};
      },
      delay: async () => {},
    pace: async () => {},
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
    const callers = session.pileupCallers();
    expect(callers.length).toBeGreaterThan(0);
    for (const caller of callers) {
      expect(root.textContent).not.toContain(caller.call);
    }
    expect(root.textContent).not.toContain("台同时应答");
    expect(root.textContent).not.toContain("点名");
    expect(root.textContent).not.toContain("堆叠");
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
