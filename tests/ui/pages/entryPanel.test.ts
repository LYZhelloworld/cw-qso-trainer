// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderEntryPanel } from "../../../src/ui/pages/entryPanel.js";
import { normalizeSettings, type AppSettings } from "../../../src/ui/settingsSchema.js";
import { emptyEntry, type EntryValues } from "../../../src/ui/entryModel.js";
import { parseBundledMode } from "../../../src/data/modeMessages.js";
import { clearLogs, listLogs } from "../../../src/ui/storage/logStore.js";
import type { QsoSession } from "../../../src/ui/session.js";
import type { AppHost, PageId } from "../../../src/ui/app.js";

/** The panel is wiring: what would go on the air is recorded, not keyed. */
function makeHarness(entry: EntryValues = emptyEntry(), opts: { holdSend?: boolean } = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  const sent: string[] = [];
  /** What the panel asked the send bar under the display to show. */
  const shown: string[] = [];
  const gates: Array<() => void> = [];
  let cleanups: Array<() => void> = [];

  const session = {
    isSending: false,
    freqMHz: 14.025,
    userSend: async (text: string): Promise<void> => {
      sent.push(text);
      // A send that never finishes: proves nothing after it waits for it.
      if (opts.holdSend) await new Promise<void>((r) => gates.push(r));
    },
  } as unknown as QsoSession;

  const host: AppHost = {
    settings: normalizeSettings({ myCall: "BG7XXX" }),
    session,
    entry,
    modeMessages: parseBundledMode().config,
    showOutgoing(text: string) {
      shown.push(text);
    },
    updateSettings(patch: Partial<AppSettings>) {
      host.settings = normalizeSettings({ ...host.settings, ...patch });
      render();
    },
    newSession() {},
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
    renderEntryPanel(host, page);
    root.replaceChildren(page);
  }

  render();
  return {
    host,
    entry,
    sent,
    shown,
    root,
    render,
    releaseSend: () => {
      for (const open of gates) open();
    },
  };
}

function keys(root: HTMLElement): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>(".qm-key"));
}

function activeKeys(root: HTMLElement): string[] {
  return keys(root)
    .filter((b) => b.classList.contains("active"))
    .map((b) => b.querySelector(".qm-fkey")?.textContent ?? "");
}

/** The three boxes say what they are in their placeholder, not in a label. */
function box(root: HTMLElement, placeholder: string): HTMLInputElement {
  const input = root.querySelector<HTMLInputElement>(
    `input.entry-field[placeholder="${placeholder}"]`,
  );
  if (!input) throw new Error(`未找到输入框：${placeholder}`);
  return input;
}

function press(input: HTMLInputElement, k: string): void {
  input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
}

/** Type into a box the way a user does: value first, then the event. */
function type(input: HTMLInputElement, text: string): void {
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function hint(root: HTMLElement): string {
  return root.querySelector(".entry-hint")?.textContent ?? "";
}

beforeEach(async () => {
  // fake-indexeddb persists for the whole file: each case starts with an empty book.
  await clearLogs();
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("八个快速报文键", () => {
  it("按 F1–F8 排好，一部八个，缺的键也占位", () => {
    const { root } = makeHarness();
    expect(keys(root).map((b) => b.querySelector(".qm-fkey")?.textContent)).toEqual([
      "F1",
      "F2",
      "F3",
      "F4",
      "F5",
      "F6",
      "F7",
      "F8",
    ]);
  });

  it("按钮文字按宏展开：F4 是自己的呼号，F5 缺值就显示宏名", () => {
    const { root } = makeHarness();
    expect(keys(root).map((b) => b.querySelector(".qm-label")?.textContent)).toEqual([
      "CQ",
      "RST",
      "TU",
      "BG7XXX",
      "{THEIRCALL}",
      "RST REPEAT",
      "?",
      "",
    ]);
  });

  it("只有真的没有报文的键（默认是 F8）是灰的，其余都能按", () => {
    const { root } = makeHarness();
    const all = keys(root);
    expect(all.slice(0, 7).every((b) => !b.disabled)).toBe(true);
    expect(all[7].disabled).toBe(true); // F8 留空
  });

  it("缺值的键照发：缺的那一段就是空的，不弹提示", async () => {
    const { root, sent } = makeHarness();
    keys(root)[1].click(); // F2 需要 {THEIRCALL} 和 {RST}
    // 空着就空着发出去，和手写一条报文没有区别；程序不替操作者补内容。
    await vi.waitFor(() => expect(sent).toEqual(["DE BG7XXX R UR RST K"]));
    expect(hint(root)).toBe("");
  });

  it("tooltip 就是即将发出的报文；没值的地方留着宏名", () => {
    const { root } = makeHarness();
    const all = keys(root);
    expect(all[0].title).toBe("CQ CQ CQ DE BG7XXX BG7XXX PSE K");
    expect(all[2].title).toBe("R TU 73 SK");
    expect(all[1].title).toBe("{THEIRCALL} DE BG7XXX R UR RST {RST} {RST} K");
    expect(all[1].title).not.toContain("还缺");
    expect(all[7].title).toContain("没有报文");
  });

  it("点一下就把报文发出去，宏在按下的那一刻展开", async () => {
    const { root, sent, entry } = makeHarness({ ...emptyEntry(), call: "JA1ABC" });
    entry.rstTx = "599";
    type(box(root, "对方呼号"), "JA1ABC");
    keys(root)[1].click();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toBe("JA1ABC DE BG7XXX R UR RST 5NN 5NN K");
  });

  it("F1–F8 是快捷键，和点击等价", async () => {
    const { sent } = makeHarness();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "F7" }));
    await vi.waitFor(() => expect(sent).toEqual(["?"]));
  });

  it("设置弹窗开着时快捷键让给弹窗", async () => {
    const { sent } = makeHarness();
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    document.body.append(overlay);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "F7" }));
    await Promise.resolve();
    expect(sent).toEqual([]);
    overlay.remove();
  });
});

describe("高亮跟着该说的下一句走", () => {
  it("Run：空行亮 F1", () => {
    const { root } = makeHarness();
    expect(activeKeys(root)).toEqual(["F1"]);
  });

  it("S&P：空行亮 F4，而不是 F1", () => {
    const { root } = makeHarness({ ...emptyEntry("s&p") });
    expect(activeKeys(root)).toEqual(["F4"]);
  });

  it("填了呼号就亮 F2", () => {
    const { root } = makeHarness();
    type(box(root, "对方呼号"), "ja1abc");
    expect(activeKeys(root)).toEqual(["F2"]);
    // 呼号进框后自动转大写
    expect(box(root, "对方呼号").value).toBe("JA1ABC");
  });

  it("对方 RST 填好就亮 F3", () => {
    const { root } = makeHarness({ ...emptyEntry(), call: "JA1ABC" });
    type(box(root, "对方 RST"), "579");
    expect(activeKeys(root)).toEqual(["F3"]);
  });

  it("切换 Run / S&P 就地换灯", () => {
    const { root, entry } = makeHarness();
    const radios = root.querySelectorAll<HTMLInputElement>('input[type="radio"]');
    expect(entry.mode).toBe("run");
    radios[1].checked = true;
    radios[1].dispatchEvent(new Event("change"));
    expect(entry.mode).toBe("s&p");
    expect(activeKeys(root)).toEqual(["F4"]);
  });
});

describe("回车与空格的分别", () => {
  it("空呼号按回车：Run 发 CQ", async () => {
    const { root, sent } = makeHarness();
    press(box(root, "对方呼号"), "Enter");
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toBe("CQ CQ CQ DE BG7XXX BG7XXX PSE K");
  });

  it("空呼号按回车：S&P 发 F4，缺对方呼号的那一段留空", async () => {
    const { root, sent } = makeHarness({ ...emptyEntry("s&p") });
    press(box(root, "对方呼号"), "Enter");
    await vi.waitFor(() => expect(sent).toEqual(["DE BG7XXX"]));
    expect(hint(root)).toBe("");
  });

  it("呼号填好按回车：自动填 599、发 F2、光标跳到对方 RST", async () => {
    const { root, sent, entry } = makeHarness();
    type(box(root, "对方呼号"), "JA1ABC");
    press(box(root, "对方呼号"), "Enter");
    expect(entry.rstTx).toBe("599");
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toBe("JA1ABC DE BG7XXX R UR RST 5NN 5NN K");
    expect(box(root, "我方 RST").value).toBe("599");
    await vi.waitFor(() => expect(document.activeElement).toBe(box(root, "对方 RST")));
  });

  it("呼号填好按空格：同样跳过去填 599，但一个字符也不发", async () => {
    const { root, sent, entry } = makeHarness();
    type(box(root, "对方呼号"), "JA1ABC");
    press(box(root, "对方呼号"), " ");
    expect(entry.rstTx).toBe("599");
    await vi.waitFor(() => expect(document.activeElement).toBe(box(root, "对方 RST")));
    expect(sent).toEqual([]);
  });

  it("已有 RST 不被 599 覆盖", async () => {
    const { root, entry } = makeHarness({ ...emptyEntry(), call: "JA1ABC", rstTx: "579" });
    press(box(root, "对方呼号"), "Enter");
    expect(entry.rstTx).toBe("579");
    expect(box(root, "我方 RST").value).toBe("579");
  });

  it("最后一步按回车：发 F3、写日志、清空、光标回呼号框、灯回 F1", async () => {
    const { root, sent, entry } = makeHarness();
    // The whole contact, as it is actually worked: call in, Enter (F2 + 599),
    // their report in, Enter (F3 + log).
    type(box(root, "对方呼号"), "JA1ABC");
    press(box(root, "对方呼号"), "Enter");
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    type(box(root, "对方 RST"), "579");
    press(box(root, "对方 RST"), "Enter");

    await vi.waitFor(() => expect(sent.at(-1)).toBe("R TU 73 SK"));
    expect(sent).toHaveLength(2);
    // The row is written after the sign-off has gone out.
    await vi.waitFor(async () => expect(await listLogs()).toHaveLength(1));

    const rows = await listLogs();
    expect(rows[0]).toMatchObject({
      call: "JA1ABC",
      freqMHz: "14.0250",
      mode: "CW",
      rstRx: "579",
      rstTx: "599",
    });

    expect(entry).toMatchObject({ call: "", rstTx: "", rstRx: "", mode: "run" });
    expect(box(root, "对方呼号").value).toBe("");
    expect(box(root, "对方 RST").value).toBe("");
    await vi.waitFor(() => expect(document.activeElement).toBe(box(root, "对方呼号")));
    expect(activeKeys(root)).toEqual(["F1"]);
  });

  it("RST 不完整就不发、不记，并指出是哪个框", async () => {
    const { root, sent } = makeHarness({ ...emptyEntry(), call: "JA1ABC", rstRx: "579" });
    press(box(root, "对方 RST"), "Enter");
    await Promise.resolve();
    expect(sent).toEqual([]);
    expect(await listLogs()).toHaveLength(0);
    expect(hint(root)).toContain("我方 RST");
    expect(root.querySelector(".entry-field.bad")).not.toBeNull();
  });
});

describe("发出去的报文", () => {
  it("按下快速报文时，同一句话交给最下面的发送框显示", async () => {
    const { root, shown } = makeHarness();
    keys(root)[2].click(); // F3：不依赖任何宏
    await vi.waitFor(() => expect(shown).toEqual(["R TU 73 SK"]));
  });

  it("回车发 F3 时当场落账，不等这句发完，也不等对方回 73", async () => {
    const { root, sent, releaseSend } = makeHarness(emptyEntry(), { holdSend: true });
    type(box(root, "对方呼号"), "JA1ABC");
    press(box(root, "对方呼号"), "Enter"); // F2：卡在发报里没出来
    type(box(root, "对方 RST"), "579");
    press(box(root, "对方 RST"), "Enter"); // F3：发出去的同时落账

    await vi.waitFor(async () => expect(await listLogs()).toHaveLength(1));
    expect(sent).toEqual(["JA1ABC DE BG7XXX R UR RST 5NN 5NN K", "R TU 73 SK"]);
    releaseSend();
  });
});

describe("三个框自己说自己是什么", () => {
  it("没有标签，只有 placeholder", () => {
    const { root } = makeHarness();
    expect(root.querySelector(".entry-label")).toBeNull();
    const placeholders = Array.from(
      root.querySelectorAll<HTMLInputElement>(".entry-field"),
    ).map((i) => i.placeholder);
    expect(placeholders).toEqual(["对方呼号", "我方 RST", "对方 RST"]);
  });
});

describe("输入框的收束", () => {
  it("RST 只收数字，最多三位", () => {
    const { root, entry } = makeHarness();
    type(box(root, "对方 RST"), "5a99x");
    expect(box(root, "对方 RST").value).toBe("599");
    expect(entry.rstRx).toBe("599");
  });

  it("呼号里的空格被去掉", () => {
    const { root } = makeHarness();
    type(box(root, "对方呼号"), "ja1 abc");
    expect(box(root, "对方呼号").value).toBe("JA1ABC");
  });
});
