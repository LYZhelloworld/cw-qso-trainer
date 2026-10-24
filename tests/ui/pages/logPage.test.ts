// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderLog } from "../../../src/ui/pages/logPage.js";
import { addLog, clearLogs, listLogs } from "../../../src/ui/storage/logStore.js";
import { LOG_WATERMARK } from "../../../src/ui/disclaimer.js";
import { normalizeSettings } from "../../../src/ui/settingsSchema.js";
import { QsoSession } from "../../../src/ui/session.js";
import type { LogRecord } from "../../../src/ui/logRecord.js";
import type { AppHost, PageId } from "../../../src/ui/app.js";

const HEADERS = ["DATE", "TIME_UTC", "CALL", "FREQ_MHZ", "MODE", "RST_RX", "RST_TX", "操作"];

const SAMPLE: LogRecord = {
  date: "2026-10-14",
  timeUtc: "12:00:00",
  call: "JA1ABC",
  freqMHz: "14.0250",
  mode: "CW",
  rstRx: "599",
  rstTx: "599",
};

function mountLog(root: HTMLElement): AppHost {
  const host: AppHost = {
    settings: normalizeSettings({}),
    session: {} as QsoSession,
    updateSettings() {},
    newSession() {},
    go(_page: PageId) {},
    refresh() {
      render();
    },
    onLeave() {},
  };
  function render(): void {
    const page = document.createElement("div");
    renderLog(host, page);
    root.replaceChildren(page);
  }
  render();
  return host;
}

function freshRoot(): HTMLElement {
  const root = document.createElement("div");
  document.body.append(root);
  return root;
}

function buttonByText(root: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent === text,
  );
  if (!found) throw new Error(`未找到按钮：${text}`);
  return found;
}

beforeEach(async () => {
  await clearLogs();
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("日志页（IndexedDB 可用）", () => {
  it("没有记录时提示完成通联后自动写入", async () => {
    const root = freshRoot();
    mountLog(root);
    await vi.waitFor(() => expect(root.textContent).toContain("暂无日志记录"));
  });

  it("有记录时按 LOG.md 的字段顺序渲染表格", async () => {
    await addLog(SAMPLE);
    const root = freshRoot();
    mountLog(root);

    await vi.waitFor(() => expect(root.querySelector("table.log")).not.toBeNull());
    const headers = Array.from(root.querySelectorAll("thead th")).map((th) => th.textContent);
    expect(headers).toEqual(HEADERS);

    const cells = root.querySelectorAll("tbody tr");
    expect(cells.length).toBe(1);
    expect(cells[0].querySelectorAll("td").length).toBe(8);
    // MODE is read-only text, the other six fields are editable inputs.
    expect(cells[0].querySelectorAll("input").length).toBe(6);
    expect(cells[0].textContent).toContain("CW");
    expect(root.querySelector<HTMLInputElement>("tbody tr input")!.value).toBe("2026-10-14");
  });

  it("可以逐行编辑并保存", async () => {
    await addLog(SAMPLE);
    const root = freshRoot();
    mountLog(root);
    await vi.waitFor(() => expect(root.querySelector("tbody tr")).not.toBeNull());

    const inputs = Array.from(root.querySelectorAll<HTMLInputElement>("tbody tr input"));
    inputs[4].value = "589"; // RST_RX
    inputs[5].value = "579"; // RST_TX
    buttonByText(root, "保存").click();

    await vi.waitFor(async () => {
      const rows = await listLogs();
      expect(rows.length).toBe(1);
      expect(rows[0].rstRx).toBe("589");
      expect(rows[0].rstTx).toBe("579");
    });
  });

  it("编辑对方呼号时会归一化为大写", async () => {
    await addLog(SAMPLE);
    const root = freshRoot();
    mountLog(root);
    await vi.waitFor(() => expect(root.querySelector("tbody tr")).not.toBeNull());

    const inputs = Array.from(root.querySelectorAll<HTMLInputElement>("tbody tr input"));
    inputs[2].value = " ja1abc ";
    buttonByText(root, "保存").click();

    await vi.waitFor(async () => {
      const rows = await listLogs();
      expect(rows[0].call).toBe("JA1ABC");
    });
  });

  it("「清空全部」会删掉所有记录", async () => {
    await addLog(SAMPLE);
    await addLog({ ...SAMPLE, call: "JA2XYZ" });
    const root = freshRoot();
    mountLog(root);
    await vi.waitFor(() => expect(root.querySelectorAll("tbody tr").length).toBe(2));

    buttonByText(root, "清空全部").click();

    await vi.waitFor(() => expect(root.textContent).toContain("暂无日志记录"));
    await expect(listLogs()).resolves.toEqual([]);
  });

  it("常驻水印；有记录时额外明确不可导出", async () => {
    const empty = freshRoot();
    mountLog(empty);
    expect(empty.querySelector(".watermark")?.textContent).toBe(LOG_WATERMARK);

    await addLog(SAMPLE);
    const root = freshRoot();
    mountLog(root);

    await vi.waitFor(() => expect(root.querySelector("table.log")).not.toBeNull());
    expect(root.querySelector(".watermark")?.textContent).toBe(LOG_WATERMARK);
    expect(root.textContent).toContain("日志不可导出为 ADIF / CSV / JSON");
  });

  it("完整跑通一次 QSO 后自动产生一条符合条件的日志", async () => {
    const settings = normalizeSettings({ myCall: "BG7XXX", difficulty: "novice" });
    // No real waiting: this case is about the log record, not the HAM's answer
    // timing. Leaving the 1–3 s reply delays real would push it past the
    // default test timeout and make it flaky.
    const session = new QsoSession(14.025, settings, { delay: async () => {}, pace: async () => {} });

    session.seedHams(1);
    const station = session.listHams()[0];
    // Tune onto it first: a CW receiver only hears its ±250 Hz passband, and the
    // log records the dial as it stood during the contact.
    session.retune(station.freqHz / 1e6);
    await session.hamCallsCq();
    const peer = session.ham!.call;
    await session.userSend(`${peer} DE BG7XXX R UR RST 599 599 BK`);
    await session.userSend("R TU 73 SK");

    expect(session.state).toBe("LOGGED");

    const record = session.pendingLog();
    expect(record).not.toBeNull();
    expect(record!.call).toBe(peer);
    expect(record!.mode).toBe("CW");
    expect(record!.freqMHz).toBe((station.freqHz / 1e6).toFixed(4));

    await addLog(record!);
    session.markLogged();
    expect(session.pendingLog()).toBeNull(); // 防重复写入

    const rows = await listLogs();
    expect(rows.length).toBe(1);
    expect(rows[0].call).toBe(peer);

    const root = freshRoot();
    mountLog(root);
    await vi.waitFor(() => expect(root.querySelector("tbody tr")).not.toBeNull());

    // CALL lives inside an <input>, so assert on its value rather than textContent.
    const inputs = Array.from(root.querySelectorAll<HTMLInputElement>("tbody tr input"));
    expect(inputs[2].value).toBe(peer);
    expect(inputs[4].value).toBe(record!.rstRx);
    expect(inputs[5].value).toBe(record!.rstTx);
    expect(root.textContent).toContain("CW");
  });
});
