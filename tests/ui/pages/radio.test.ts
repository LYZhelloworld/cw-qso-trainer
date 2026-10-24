// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatDial, renderRadio } from "../../../src/ui/pages/radio.js";
import { BANDS } from "../../../src/ui/bands.js";
import { normalizeSettings, type AppSettings } from "../../../src/ui/settingsSchema.js";
import { QsoSession } from "../../../src/ui/session.js";
import type { AppHost, PageId } from "../../../src/ui/app.js";

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

/** The fill width of one S-meter segment, as a percentage. */
function fillWidth(root: HTMLElement, segment: "s" | "over"): number {
  const fill = root.querySelector<HTMLElement>(`.smeter-seg.${segment} .smeter-fill`)!;
  return Number.parseFloat(fill.style.width);
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  for (const fn of pendingCleanups.splice(0)) fn();
  document.body.innerHTML = "";
});

describe("频率读数", () => {
  it("按 MHz.kHz.Hz 分组，kHz 的位置不随波段变化", () => {
    expect(formatDial(14.025)).toBe("14.025.000");
    expect(formatDial(7.025)).toBe("7.025.000");
    expect(formatDial(28.0251)).toBe("28.025.100");
  });

  it("画面上频率水平居中，单位是 MHz", () => {
    const { root } = makeHost({ bandIndex: 1, freqMHz: 14.025 });
    const dial = root.querySelector(".dial")!;
    expect(dial.querySelector(".dial-digits")?.textContent).toBe("14.025.000");
    expect(dial.querySelector(".dial-unit")?.textContent).toBe("MHz");
    // 居中靠版面而不是靠内容：读数块本身是整行居中的一行。
    expect(dial.className).toContain("dial");
  });

  it("S 表在频率左边，和频率在同一行", () => {
    const { root } = makeHost({ myCall: "BG7XXX" });
    const line = root.querySelector(".console")!;

    // 同一行、且 S 表排在前面（CSS 把它放在左边那一列，频率居中）。
    expect(line.children[0].classList.contains("smeter")).toBe(true);
    expect(line.children[1].classList.contains("dial")).toBe(true);
  });
});

describe("电台页 — 电源", () => {
  it("关台时只剩一块暗屏和拨盘读数，没有波段与发报面板", () => {
    const { root } = makeHost({}, false);

    expect(root.querySelector(".console.off")).not.toBeNull();
    expect(root.querySelector(".dial-digits")?.textContent).toBe("14.025.000");
    expect(root.querySelector(".band-tabs")).toBeNull();
    expect(root.querySelector(".send-input")).toBeNull();
    // 开台按钮与待机窗都在机头/瀑布图那边，不在这一页里重复。
    expect(root.textContent).not.toContain("设备已关机");
  });

  it("开台后出现波段与发报面板", () => {
    const { root } = makeHost({}, true);

    expect(root.querySelector(".console.off")).toBeNull();
    expect(root.querySelector(".band-tabs")).not.toBeNull();
  });

  it("关台时不再赘述本频段有多少台在活动", () => {
    const { root, host } = makeHost({}, false);
    host.session = {
      hamActivity: () => [
        { ham: { call: "JA1ABC", report: "599" }, state: "cqing" },
        { ham: { call: "DL1XYZ", report: "589" }, state: "listening" },
      ],
      sMeter: () => null,
    } as unknown as QsoSession;
    host.refresh();

    expect(root.textContent).not.toContain("个电台在活动");
    expect(root.textContent).not.toContain("JA1ABC");
  });
});

describe("电台页 — 波段与调谐", () => {
  it("列出四个频段并高亮当前频段", () => {
    const { root } = makeHost({ bandIndex: 1 });
    const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>(".band-tabs button"));

    expect(tabs.map((b) => b.textContent)).toEqual(BANDS.map((b) => b.name));
    const active = tabs.filter((b) => b.classList.contains("active"));
    expect(active.length).toBe(1);
    expect(active[0].textContent).toBe(BANDS[1].name);
  });

  it("点击别的频段会切换 bandIndex 与默认频率", () => {
    const { root, host } = makeHost({ bandIndex: 1 });

    findButton(root, BANDS[0].name).click();

    expect(host.settings.bandIndex).toBe(0);
    expect(host.settings.freqMHz).toBe(BANDS[0].defaultMHz);
  });

  it("不再提供 ±1 kHz / ±100 Hz 的步进按键：调谐在瀑布图上做", () => {
    const { root } = makeHost({ bandIndex: 1 });

    const labels = Array.from(root.querySelectorAll("button")).map((b) => b.textContent ?? "");
    expect(labels.some((l) => l.includes("kHz") || l.includes("Hz"))).toBe(false);
    expect(root.querySelector(".tune-steps")).toBeNull();
  });

  it("不在页面上写通带宽度与台站分布——靠自己调、自己听", () => {
    const { root } = makeHost({ bandIndex: 1 });
    expect(root.textContent).not.toContain("接收通带");
    expect(root.textContent).not.toContain("波段切片");
  });
});

describe("电台页 — S 表", () => {
  it("是一条横条，分成 S 段与 S9 之后的红段", () => {
    const { root } = makeHost({ myCall: "BG7XXX" });

    expect(root.querySelector(".smeter-track")).not.toBeNull();
    expect(root.querySelector(".smeter-seg.s")).not.toBeNull();
    expect(root.querySelector(".smeter-seg.over")).not.toBeNull();
    const ticks = Array.from(root.querySelectorAll(".smeter-tick")).map((t) => t.textContent);
    expect(ticks).toEqual(["S1", "S3", "S5", "S7", "S9", "+20", "+40", "+60"]);
  });

  it("没有信号时横条是空的，读数为一横", () => {
    const { root } = makeHost({ myCall: "BG7XXX" });

    expect(root.querySelector(".smeter-read")?.textContent).toBe("—");
    expect(fillWidth(root, "s")).toBe(0);
    expect(fillWidth(root, "over")).toBe(0);
    expect(root.querySelector(".smeter")?.classList.contains("quiet")).toBe(true);
  });

  it("S 段是蓝色，S9 之后才点亮红色段", () => {
    const { root, host } = makeHost({ myCall: "BG7XXX" });
    (host.session as unknown as { sMeter: () => unknown }).sMeter = () => ({
      dbm: -85,
      s: 7,
      overDb: 0,
      label: "S7",
    });
    host.refresh();

    expect(root.querySelector(".smeter-read")?.textContent).toBe("S7");
    expect(fillWidth(root, "s")).toBeCloseTo(75, 1);
    expect(fillWidth(root, "over")).toBe(0);
  });

  it("超过 S9 时读数带 dB，红段按 60 dB 满格", () => {
    const { root, host } = makeHost({ myCall: "BG7XXX" });
    (host.session as unknown as { sMeter: () => unknown }).sMeter = () => ({
      dbm: -53,
      s: 9,
      overDb: 20,
      label: "S9+20",
    });
    host.refresh();

    expect(root.querySelector(".smeter-read")?.textContent).toBe("S9+20");
    expect(fillWidth(root, "s")).toBeCloseTo(100, 1);
    expect(fillWidth(root, "over")).toBeCloseTo(33.3, 1);
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
    // S 表还在：那是接收机自己的读数，不是波段名册。
    expect(root.querySelector(".smeter")).not.toBeNull();
  });

  it("未填写本方呼号时提示去设置，填写后不再提示", () => {
    const empty = makeHost({ myCall: "" });
    expect(empty.root.textContent).toContain("请先填写本方呼号");
    expect(findButton(empty.root, "打开设置")).toBeDefined();

    const filled = makeHost({ myCall: "BG7XXX" });
    expect(filled.root.textContent).not.toContain("请先填写本方呼号");
  });

  it("发送面板一直可用，不需要先「开始通联」", () => {
    const { root } = makeHost({ myCall: "BG7XXX", keyMode: "text" });
    // 还没进任何通联：发送框与发送按钮就已经在了。
    expect(root.querySelector(".send-input")).not.toBeNull();
    expect(findButton(root, "发送")).toBeDefined();
    expect(root.textContent).not.toContain("开始通联");
    expect(root.textContent).not.toContain("监听");
    expect(root.textContent).not.toContain("我发 CQ");
  });

  it("通联开始后也不会换成另一套面板", async () => {
    const session = new QsoSession(14.025, normalizeSettings({ myCall: "BG7XXX" }));
    session.seedHams(1);
    session.retune(session.listHams()[0].freqHz / 1e6); // 对准它，通带内才听得见
    await session.hamCallsCq(); // enters PEER_CQ
    const { root, host } = makeHost({ myCall: "BG7XXX", keyMode: "text" });
    host.session = session;
    host.refresh();

    expect(root.textContent).toContain("发送");
    expect(root.querySelector(".send-input")).not.toBeNull();
    // 状态行与收发记录都不显示：报文只在空中，屏幕上没有回放。
    expect(root.textContent).not.toContain("通联状态");
    expect(root.textContent).not.toContain("收报 / 发报记录");
  });
});
