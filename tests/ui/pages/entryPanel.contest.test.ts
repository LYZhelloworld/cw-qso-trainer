// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderEntryPanel } from "../../../src/ui/pages/entryPanel.js";
import { parseBundledMode } from "../../../src/data/modeMessages.js";
import { normalizeSettings, type AppSettings } from "../../../src/ui/settingsSchema.js";
import { emptyEntry, type EntryValues } from "../../../src/ui/entryModel.js";
import { clearLogs, listLogs } from "../../../src/ui/storage/logStore.js";
import { formatSerial, formatZone, type ContestKind, type PartnerTruth } from "../../../src/qso/contest.js";
import type { QsoSession } from "../../../src/ui/session.js";
import type { AppHost, PageId } from "../../../src/ui/app.js";

/**
 * The operating row in a contest: one more box, one more value going out.
 *
 * The panel is wiring — what would be keyed is recorded, and so is the log row
 * it writes — so the harness stands in for the session and for the App's
 * exchange, and checks both.
 */
interface HarnessOptions {
  contest?: ContestKind;
  /** What the station being worked really sent. */
  truth?: PartnerTruth | null;
  /** Our own exchange; a mutable serial when the mode is WPX. */
  own?: { zone?: number; serial?: { value: number } };
}

function makeHarness(entry: EntryValues = emptyEntry("run"), opts: HarnessOptions = {}) {
  const contest = opts.contest ?? "CQWW";
  const root = document.createElement("div");
  document.body.append(root);
  const sent: string[] = [];
  let cleanups: Array<() => void> = [];

  const serial = opts.own?.serial;
  const ownExchange = (): string => {
    if (contest === "CQWW") return formatZone(opts.own?.zone ?? 24);
    if (contest === "WPX") return formatSerial(serial?.value ?? 1);
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
      if (contest === "WPX" && serial) serial.value += 1;
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
  return { host, entry, sent, root, render };
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

describe("录入行的第四格", () => {
  it("DX 只有三个框", () => {
    const { root } = makeHarness(emptyEntry("run"), { contest: "DX" });
    expect(
      Array.from(root.querySelectorAll<HTMLInputElement>(".entry-field")).map((i) => i.placeholder),
    ).toEqual(["对方呼号", "我方 RST", "对方 RST"]);
  });

  it("CQWW 多一个「对方CQ 分区」，WPX 多一个「对方序号」", () => {
    const cqww = makeHarness(emptyEntry("run"), { contest: "CQWW" });
    expect(
      Array.from(cqww.root.querySelectorAll<HTMLInputElement>(".entry-field")).map(
        (i) => i.placeholder,
      ),
    ).toEqual(["对方呼号", "我方 RST", "对方 RST", "对方CQ 分区"]);

    const wpx = makeHarness(emptyEntry("run"), { contest: "WPX" });
    expect(
      Array.from(wpx.root.querySelectorAll<HTMLInputElement>(".entry-field")).map(
        (i) => i.placeholder,
      ),
    ).toEqual(["对方呼号", "我方 RST", "对方 RST", "对方序号"]);
  });

  it("我方要发出去的那个数字显示在运行方式旁边", () => {
    const { root } = makeHarness(emptyEntry("run"), { contest: "CQWW", own: { zone: 24 } });
    expect(root.querySelector(".entry-own")?.textContent).toBe("我方 24");

    const wpx = makeHarness(emptyEntry("run"), {
      contest: "WPX",
      own: { serial: { value: 7 } },
    });
    expect(wpx.root.querySelector(".entry-own")?.textContent).toBe("我方 007");
  });

  it("分区框最多两位、序号框最多四位", () => {
    const cqww = makeHarness(emptyEntry("run"), { contest: "CQWW" });
    const zone = box(cqww.root, "对方CQ 分区");
    type(zone, "12345");
    expect(zone.value).toBe("12");
    expect(cqww.entry.exchRx).toBe("12");

    const wpx = makeHarness(emptyEntry("run"), { contest: "WPX" });
    const serial = box(wpx.root, "对方序号");
    type(serial, "12345");
    expect(serial.value).toBe("1234");
  });
});

describe("比赛报文里的 {EXCH}", () => {
  it("CQWW 的 F2 发的是 5NN 加我方分区（简码）", async () => {
    const { root, sent, entry } = makeHarness(
      { ...emptyEntry("run"), call: "JA1ABC", rstTx: "599" },
      { contest: "CQWW", own: { zone: 24 } },
    );
    keys(root)[1].click(); // F2
    await vi.waitFor(() => expect(sent).toEqual(["5NN U4"]));
    expect(entry.rstTx).toBe("599");
  });

  it("WPX 的 F2 发的是三位序号（简码）", async () => {
    const { root, sent } = makeHarness(
      { ...emptyEntry("run"), call: "JA1ABC" },
      { contest: "WPX", own: { serial: { value: 1 } } },
    );
    press(box(root, "我方 RST"), " ");
    keys(root)[3].click(); // F4：应答别人的 CQ 时先报自己的呼号
    keys(root)[1].click(); // F2
    await vi.waitFor(() => expect(sent).toEqual(["BG7XXX", "5NN TTA"]));
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
    expect(root.querySelector(".entry-field.bad")).toBe(box(root, "对方CQ 分区"));
  });

  it("填齐了就发 TU 并记进 CQWW 那本日志，还带上核对结论", async () => {
    const { root, sent } = makeHarness(complete({ exchRx: "05" }), {
      contest: "CQWW",
      own: { zone: 24 },
      truth: { call: "JA1ABC", report: "599", exch: "05" },
    });

    press(box(root, "对方CQ 分区"), "Enter");

    await vi.waitFor(async () => expect(await listLogs()).toHaveLength(1));
    expect(sent).toEqual(["TU"]);
    const rows = await listLogs();
    expect(rows[0]).toMatchObject({
      call: "JA1ABC",
      contest: "CQWW",
      exchRx: "05",
      exchTx: "24",
      verdict: "ok",
    });
  });

  it("抄错了分区，记下来但标明是交换信息错", async () => {
    const { root } = makeHarness(complete({ exchRx: "15" }), {
      contest: "CQWW",
      truth: { call: "JA1ABC", report: "599", exch: "05" },
    });
    press(box(root, "对方CQ 分区"), "Enter");
    await vi.waitFor(async () => expect(await listLogs()).toHaveLength(1));
    const rows = await listLogs();
    expect(rows[0].verdict).toBe("exch");
  });

  it("WPX 每记一条，序号加一，下一句就发新号", async () => {
    const serial = { value: 1 };
    const harness = makeHarness(complete({ exchRx: "001" }), {
      contest: "WPX",
      own: { serial },
    });

    press(box(harness.root, "对方序号"), "Enter");

    await vi.waitFor(async () => expect(await listLogs()).toHaveLength(1));
    const rows = await listLogs();
    expect(rows[0]).toMatchObject({ contest: "WPX", exchTx: "001", exchRx: "001" });
    expect(serial.value).toBe(2);
    // 行重新变空，我方要发的号已经换成下一个。
    expect(harness.root.querySelector(".entry-own")?.textContent).toBe("我方 002");
  });
});
