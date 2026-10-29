// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderEntryPanel } from "../../../src/ui/pages/entryPanel.js";
import { parseBundledMode } from "../../../src/data/modeMessages.js";
import { normalizeSettings, type AppSettings } from "../../../src/ui/settingsSchema.js";
import { emptyEntry, type EntryValues } from "../../../src/ui/entryModel.js";
import { clearLogs, listLogs } from "../../../src/ui/storage/logStore.js";
import {
  formatSerial,
  formatZone,
  type ContestKind,
  type PartnerTruth,
} from "../../../src/qso/contest.js";
import type { QsoSession } from "../../../src/ui/session.js";
import type { AppHost, PageId } from "../../../src/ui/app.js";

/**
 * The operating row in a contest: more boxes, and two of the values already known.
 *
 * The panel is wiring — what would be keyed is recorded, and so is the log row it
 * writes — so the harness stands in for the session and for the App's exchange,
 * and checks both.
 */
interface HarnessOptions {
  contest?: ContestKind;
  /** What the station being worked really sent. */
  truth?: PartnerTruth | null;
  /** The zone our callsign resolves to, for CQWW. */
  zone?: number;
}

function makeHarness(entry: EntryValues = emptyEntry("run"), opts: HarnessOptions = {}) {
  const contest = opts.contest ?? "CQWW";
  const root = document.createElement("div");
  document.body.append(root);
  const sent: string[] = [];
  let cleanups: Array<() => void> = [];

  const ownExchange = (): string => {
    if (contest === "CQWW") return formatZone(opts.zone ?? 24);
    if (contest === "WPX") {
      const typed = entry.ownNr.trim();
      return typed !== "" ? typed : formatSerial(host.settings.wpxSerial);
    }
    return "";
  };

  const session = {
    isSending: false,
    freqMHz: 14.025,
    userSend: async (text: string): Promise<void> => {
      sent.push(text);
    },
    partnerTruth: (): PartnerTruth | null => opts.truth ?? null,
  } as unknown as QsoSession;

  const host: AppHost = {
    settings: normalizeSettings({ myCall: "BG7XXX", contest }),
    session,
    entry,
    modeMessages: parseBundledMode(contest).config,
    ownExchange,
    nextWpxSerial() {
      host.settings = normalizeSettings({
        ...host.settings,
        wpxSerial: host.settings.wpxSerial + 1,
      });
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
    root,
    render,
    /** The stand-in session, so a test can flip half-duplex mid-row. */
    stub: session as unknown as { isSending: boolean },
  };
}

function keys(root: HTMLElement): HTMLButtonElement[] {
  return Array.from(root.querySelectorAll<HTMLButtonElement>(".qm-key"));
}

function box(root: HTMLElement, placeholder: string): HTMLInputElement {
  const input = root.querySelector<HTMLInputElement>(
    `input.entry-field[placeholder="${placeholder}"]`,
  );
  if (!input) throw new Error(`未找到输入框：${placeholder}`);
  return input;
}

/** Our serial's box: its placeholder is the number, not its name. */
function ownBox(root: HTMLElement): HTMLInputElement {
  const input = root.querySelector<HTMLInputElement>("input.entry-own-nr");
  if (!input) throw new Error("未找到我方序号那一格");
  return input;
}

function type(input: HTMLInputElement, text: string): void {
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function press(input: HTMLInputElement, k: string): void {
  input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
}

function hint(root: HTMLElement): string {
  return root.querySelector(".entry-hint")?.textContent ?? "";
}

beforeEach(async () => {
  await clearLogs();
});

afterEach(() => {
  document.body.replaceChildren();
});

describe("录入行的格子", () => {
  it("DX 只有三个框", () => {
    const { root } = makeHarness(emptyEntry("run"), { contest: "DX" });
    expect(
      Array.from(root.querySelectorAll<HTMLInputElement>(".entry-field")).map((i) => i.placeholder),
    ).toEqual(["对方呼号", "我方 RST", "对方 RST"]);
  });

  it("CQWW 多一个「对方 CQ 分区」", () => {
    const cqww = makeHarness(emptyEntry("run"), { contest: "CQWW" });
    expect(
      Array.from(cqww.root.querySelectorAll<HTMLInputElement>(".entry-field")).map(
        (i) => i.placeholder,
      ),
    ).toEqual(["对方呼号", "我方 RST", "对方 RST", "对方 CQ 分区"]);
  });

  it("WPX 是五个框：我方序号在自己的格子里，对方序号在最后", () => {
    const wpx = makeHarness(emptyEntry("run"), { contest: "WPX" });
    const fields = Array.from(wpx.root.querySelectorAll<HTMLInputElement>(".entry-field"));
    expect(fields.map((i) => i.getAttribute("aria-label"))).toEqual([
      "对方呼号",
      "我方 RST",
      "对方 RST",
      "我方序号",
      "对方序号",
    ]);
  });

  it("我方序号那一格用 placeholder 显示下一个号——留空就发它", () => {
    const wpx = makeHarness(emptyEntry("run"), { contest: "WPX" });
    const own = ownBox(wpx.root);
    expect(own.value).toBe("");
    expect(own.placeholder).toBe("001");
    expect(own.title).toContain("001");
  });

  it("CQWW 不在录入行显示我方分区——它在设置里，不随通联变", () => {
    const cqww = makeHarness(emptyEntry("run"), { contest: "CQWW", zone: 24 });
    // 分区是「我们在哪」，不是每通一个号：这一行没有自己的分区格。
    expect(cqww.root.querySelector("input.entry-own-nr")).toBeNull();
    expect(cqww.root.textContent).not.toContain("我方 24");
    expect(box(cqww.root, "对方 CQ 分区")).toBeTruthy();
  });

  it("分区框最多两位，序号框手写时能到六位", () => {
    const cqww = makeHarness(emptyEntry("run"), { contest: "CQWW" });
    const zone = box(cqww.root, "对方 CQ 分区");
    type(zone, "12345");
    expect(zone.value).toBe("12");
    expect(cqww.entry.exchRx).toBe("12");

    // 我方与对方两格一样宽：同一行里不该一格四位、一格六位。
    const wpx = makeHarness(emptyEntry("run"), { contest: "WPX" });
    const serial = box(wpx.root, "对方序号");
    type(serial, "1234567");
    expect(serial.value).toBe("123456");
    type(ownBox(wpx.root), "1234567");
    expect(ownBox(wpx.root).value).toBe("123456");
    expect(wpx.entry.ownNr).toBe("123456");
  });
});

describe("抄清呼号之后", () => {
  it("主叫（Run）时高亮的是 F2，不是 F4——报告那一句自带呼号", () => {
    const { root } = makeHarness({ ...emptyEntry("run"), call: "JA1ABC" }, { contest: "CQWW" });
    const lit = keys(root).filter((k) => k.classList.contains("active"));
    expect(lit).toHaveLength(1);
    expect(lit[0].textContent).toContain("F2");
  });

  it("空格：填上两个 RST 与我方序号，光标跳到对方序号，什么都不发", async () => {
    const { root, sent, entry } = makeHarness(
      { ...emptyEntry("run"), call: "JA1ABC" },
      { contest: "WPX" },
    );
    press(box(root, "对方呼号"), " ");
    await Promise.resolve();

    expect(sent).toEqual([]);
    expect(entry.rstTx).toBe("599");
    expect(entry.rstRx).toBe("599");
    expect(entry.ownNr).toBe("001");
    expect(document.activeElement).toBe(box(root, "对方序号"));
  });

  it("CQWW 的 F2 发的是「对方呼号 5NN 分区」", async () => {
    const { root, sent, entry } = makeHarness(
      { ...emptyEntry("run"), call: "JA1ABC", rstTx: "599" },
      { contest: "CQWW", zone: 24 },
    );
    keys(root)[1].click(); // F2
    await vi.waitFor(() => expect(sent).toEqual(["JA1ABC 5NN U4"]));
    expect(entry.rstTx).toBe("599");
    expect(entry.rstRx).toBe("599");
  });

  it("WPX 的 F2 发的是「对方呼号 5NN 序号」，序号用简码", async () => {
    const { root, sent } = makeHarness(
      { ...emptyEntry("run"), call: "JA1ABC" },
      { contest: "WPX" },
    );
    keys(root)[1].click(); // F2
    await vi.waitFor(() => expect(sent).toEqual(["JA1ABC 5NN TTA"]));
  });

  it("我方序号可以手改成不补位的写法，发出去的就跟着改", async () => {
    const { root, entry } = makeHarness(
      { ...emptyEntry("run"), call: "JA1ABC" },
      { contest: "WPX" },
    );
    type(ownBox(root), "12");
    expect(entry.ownNr).toBe("12");
  });
});

describe("应答别人的 CQ（S&P）", () => {
  it("抄清呼号之后高亮 F4：得先让对方听见是谁在叫它", () => {
    const { root } = makeHarness({ ...emptyEntry("s&p"), call: "JA1ABC" }, { contest: "CQWW" });
    const lit = keys(root).filter((k) => k.classList.contains("active"));
    expect(lit).toHaveLength(1);
    expect(lit[0].textContent).toContain("F4");
  });

  it("回车只发自己的呼号，填上我方 RST，光标落到对方 RST", async () => {
    const { root, sent, entry } = makeHarness(
      { ...emptyEntry("s&p"), call: "JA1ABC" },
      { contest: "CQWW" },
    );
    press(box(root, "对方呼号"), "Enter");

    await vi.waitFor(() => expect(sent).toEqual(["BG7XXX"]));
    // 这一步只是报名：报告还没发，所以还是报告那一格的事。
    expect(entry.reportSent).toBe(false);
    expect(entry.rstTx).toBe("599");
    expect(document.activeElement).toBe(box(root, "对方 RST"));
  });

  it("抄完数字再回车才是 F2：报告发出去，灯跳到 F3", async () => {
    const { root, sent, entry } = makeHarness(
      { ...emptyEntry("s&p"), call: "JA1ABC" },
      { contest: "CQWW", zone: 24 },
    );
    press(box(root, "对方呼号"), "Enter");
    await vi.waitFor(() => expect(sent).toEqual(["BG7XXX"]));

    // 对方回「BG7XXX 5NN 25」：抄两个 RST 与分区。
    type(box(root, "对方 RST"), "599");
    type(box(root, "对方 CQ 分区"), "05");
    press(box(root, "对方 CQ 分区"), "Enter");

    await vi.waitFor(() => expect(sent).toEqual(["BG7XXX", "JA1ABC 5NN U4"]));
    expect(entry.reportSent).toBe(true);
    const lit = keys(root).filter((k) => k.classList.contains("active"));
    expect(lit[0].textContent).toContain("F3");
  });
});

describe("收尾与落账", () => {
  const complete = (patch: Partial<EntryValues> = {}): EntryValues => ({
    ...emptyEntry("run"),
    call: "JA1ABC",
    rstTx: "599",
    rstRx: "599",
    reportSent: true,
    ...patch,
  });

  it("缺对方分区时不发也不记，并指到那一格", async () => {
    const { root, sent } = makeHarness(complete());
    press(box(root, "对方 RST"), "Enter");
    await Promise.resolve();
    expect(sent).toEqual([]);
    expect(await listLogs()).toHaveLength(0);
    expect(hint(root)).toContain("分区");
    expect(root.querySelector(".entry-field.bad")).toBe(box(root, "对方 CQ 分区"));
  });

  it("填齐了就发 TU 并记进 CQWW 那本日志，还带上核对结论", async () => {
    const { root, sent } = makeHarness(complete({ exchRx: "05" }), {
      contest: "CQWW",
      zone: 24,
      truth: { call: "JA1ABC", report: "599", exch: "05" },
    });

    press(box(root, "对方 CQ 分区"), "Enter");

    await vi.waitFor(async () => expect(await listLogs()).toHaveLength(1));
    expect(sent).toEqual(["TU"]);
    const rows = await listLogs();
    // 日志里记的是数字，不是空中的写法：`05` 记成 `5`。
    expect(rows[0]).toMatchObject({
      call: "JA1ABC",
      contest: "CQWW",
      exchRx: "5",
      exchTx: "24",
      verdict: "ok",
    });
  });

  it("先按 F3 再按回车：只落账，不再发第二句 TU", async () => {
    const { root, sent, stub } = makeHarness(complete({ exchRx: "05" }), {
      contest: "CQWW",
      truth: { call: "JA1ABC", report: "599", exch: "05" },
    });

    keys(root)[2].click(); // F3
    await vi.waitFor(() => expect(sent).toEqual(["TU"]));

    // 这一句还在发的时候按回车：这一步不上机，半双工不该拦它，也不该让
    // 操作者等一句 TU 的时间才能落账。
    stub.isSending = true;
    press(box(root, "对方 CQ 分区"), "Enter");

    await vi.waitFor(async () => expect(await listLogs()).toHaveLength(1));
    expect(sent).toEqual(["TU"]);
    expect((await listLogs())[0].verdict).toBe("ok");
  });

  it("F3 之后把呼号换成另一个台：回车要把 TU 重新说一遍", async () => {
    const { root, sent } = makeHarness(complete({ exchRx: "05" }));

    keys(root)[2].click(); // F3，这句 TU 是给 JA1ABC 的
    await vi.waitFor(() => expect(sent).toEqual(["TU"]));

    // 换一个呼号就是换一个台：上一句 TU 不算这一行的签收。
    type(box(root, "对方呼号"), "K1ABC");
    press(box(root, "对方 CQ 分区"), "Enter");

    await vi.waitFor(async () => expect(await listLogs()).toHaveLength(1));
    expect(sent).toEqual(["TU", "TU"]);
    expect((await listLogs())[0].call).toBe("K1ABC");
  });

  it("还要上机的那一步，半双工照样拦住", async () => {
    const { root, sent, stub } = makeHarness(complete({ exchRx: "05" }), { contest: "CQWW" });
    stub.isSending = true;
    press(box(root, "对方 CQ 分区"), "Enter");
    await Promise.resolve();
    expect(sent).toEqual([]);
    expect(await listLogs()).toHaveLength(0);
  });

  it("抄错了分区，记下来但标明是交换信息错", async () => {
    const { root } = makeHarness(complete({ exchRx: "15" }), {
      contest: "CQWW",
      truth: { call: "JA1ABC", report: "599", exch: "05" },
    });
    press(box(root, "对方 CQ 分区"), "Enter");
    await vi.waitFor(async () => expect(await listLogs()).toHaveLength(1));
    const rows = await listLogs();
    expect(rows[0].verdict).toBe("exch");
  });

  it("WPX 每记一条，序号加一，下一格显示的号就换成新的", async () => {
    const harness = makeHarness(complete({ exchRx: "1", ownNr: "1" }), { contest: "WPX" });

    press(box(harness.root, "对方序号"), "Enter");

    await vi.waitFor(async () => expect(await listLogs()).toHaveLength(1));
    const rows = await listLogs();
    expect(rows[0]).toMatchObject({ contest: "WPX", exchTx: "1", exchRx: "1" });
    expect(harness.host.settings.wpxSerial).toBe(2);
    // 行重新变空，我方那一格又只剩 placeholder——它现在指向下一个号。
    const own = ownBox(harness.root);
    expect(own.value).toBe("");
    expect(own.title).toContain("002");
  });
});
