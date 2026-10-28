// @vitest-environment jsdom
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderLog } from "../../../src/ui/pages/logPage.js";
import { addLog, clearLogs, listLogs } from "../../../src/ui/storage/logStore.js";
import { LOG_WATERMARK } from "../../../src/ui/disclaimer.js";
import { normalizeSettings } from "../../../src/ui/settingsSchema.js";
import { QsoSession } from "../../../src/ui/session.js";
import type { LogRecord } from "../../../src/ui/logRecord.js";
import { buildLogRecord } from "../../../src/ui/logRecord.js";
import { emptyEntry } from "../../../src/ui/entryModel.js";
import type { ContestKind } from "../../../src/qso/contest.js";
import type { AppHost, PageId } from "../../../src/ui/app.js";

const DX_HEADERS = [
  "DATE",
  "TIME_UTC",
  "CALL",
  "FREQ_MHZ",
  "MODE",
  "RST_RX",
  "RST_TX",
  "重复",
  "核对",
  "操作",
];

const SAMPLE: LogRecord = {
  date: "2026-10-14",
  timeUtc: "12:00:00",
  call: "JA1ABC",
  freqMHz: "14.0250",
  mode: "CW",
  rstRx: "599",
  rstTx: "599",
  contest: "DX",
  exchRx: "",
  exchTx: "",
  verdict: "ok",
};

const CQWW_ROW: LogRecord = {
  ...SAMPLE,
  call: "DL1ABC",
  contest: "CQWW",
  exchRx: "14",
  exchTx: "24",
  verdict: "exch",
};

interface HarnessOptions {
  /** The session each contest's log is currently on. */
  rounds?: Partial<Record<"CQWW" | "WPX", number>>;
  /** Open the page on the history view. */
  past?: boolean;
}

/** The log page keeps its tabs on the App; the harness carries them there too. */
function mountLog(
  root: HTMLElement,
  contest: ContestKind = "DX",
  opts: HarnessOptions = {},
): AppHost {
  let current = contest;
  let rounds = {
    CQWW: opts.rounds?.CQWW ?? 1,
    WPX: opts.rounds?.WPX ?? 1,
  };
  let past = opts.past ?? false;
  const host: AppHost = {
    get settings() {
      return normalizeSettings({ contest: current, contestRounds: rounds });
    },
    session: {} as QsoSession,
    get logContest() {
      return current;
    },
    setLogContest(kind: ContestKind) {
      current = kind;
      past = false;
      render();
    },
    get logPast() {
      return past;
    },
    setLogPast(next: boolean) {
      past = next;
      render();
    },
    sessionRound(kind: ContestKind) {
      return kind === "CQWW" ? rounds.CQWW : kind === "WPX" ? rounds.WPX : 1;
    },
    startNewRound(kind: ContestKind) {
      if (kind === "DX") return;
      rounds = { ...rounds, [kind]: rounds[kind] + 1 };
      past = false;
      render();
    },
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

function headersOf(root: HTMLElement): (string | null)[] {
  return Array.from(root.querySelectorAll("thead th")).map((th) => th.textContent);
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
    expect(headersOf(root)).toEqual(DX_HEADERS);

    const cells = root.querySelectorAll("tbody tr");
    expect(cells.length).toBe(1);
    expect(cells[0].querySelectorAll("td").length).toBe(10);
    // MODE and the two marks are read-only text, the other six fields are inputs.
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

  it("改过的那一行不再保留原来的核对结论", async () => {
    await addLog(SAMPLE);
    const root = freshRoot();
    mountLog(root);
    await vi.waitFor(() => expect(root.querySelector("tbody tr")).not.toBeNull());

    buttonByText(root, "保存").click();

    await vi.waitFor(async () => {
      const rows = await listLogs();
      // 改过的条目已经不是当初核对过的那一条，结论跟着原稿一起作废。
      expect(rows[0].verdict).toBeUndefined();
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

  it("逐条删除也要点两次：删掉这一行，别的行还在", async () => {
    await addLog(SAMPLE);
    await addLog({ ...SAMPLE, call: "JA2XYZ" });
    const root = freshRoot();
    mountLog(root);
    await vi.waitFor(() => expect(root.querySelectorAll("tbody tr").length).toBe(2));

    const del = buttonByText(root, "删除");
    del.click();
    // 第一下只把按钮换一句话，账上一条没少。
    await vi.waitFor(async () => expect(await listLogs()).toHaveLength(2));
    expect(del.textContent).toContain("再点一次");

    del.click();
    await vi.waitFor(async () => {
      const rows = await listLogs();
      expect(rows.length).toBe(1);
      // 列表按新到旧排，删掉的是最上面那条。
      expect(rows[0].call).toBe("JA1ABC");
    });
  });

  it("「清空本日志」要点两次：第一次只是问一句", async () => {
    await addLog(SAMPLE);
    await addLog({ ...SAMPLE, call: "JA2XYZ" });
    const root = freshRoot();
    mountLog(root);
    await vi.waitFor(() => expect(root.querySelectorAll("tbody tr").length).toBe(2));

    const btn = buttonByText(root, "清空 DX 日志（2 条）");
    btn.click();
    await vi.waitFor(async () => expect(await listLogs()).toHaveLength(2));
    expect(btn.textContent).toContain("再点一次");

    btn.click();
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

  it("同一场、同一波段、同一呼号通两次：后一条标「重复」，两条都在", async () => {
    await addLog(SAMPLE);
    await addLog({ ...SAMPLE, timeUtc: "12:05:00", freqMHz: "14.0263" });
    const root = freshRoot();
    mountLog(root);
    await vi.waitFor(() => expect(root.querySelectorAll("tbody tr").length).toBe(2));

    const marked = root.querySelectorAll(".dupe:not(.none)");
    expect(marked.length).toBe(1);
    expect(marked[0].textContent).toBe("重复");
    // 新到旧排：标在上面的那一条是后通的这一次。
    expect(root.querySelector("tbody tr .dupe:not(.none)")).not.toBeNull();
    // 通联本身没有被拦下——两条都在账上。
    await expect(listLogs()).resolves.toHaveLength(2);
  });

  it("换了波段就不算重复", async () => {
    await addLog(SAMPLE);
    await addLog({ ...SAMPLE, timeUtc: "12:05:00", freqMHz: "7.0250" });
    const root = freshRoot();
    mountLog(root);
    await vi.waitFor(() => expect(root.querySelectorAll("tbody tr").length).toBe(2));
    expect(root.querySelectorAll(".dupe:not(.none)").length).toBe(0);
  });

  it("跨越两场时不算重复：同一个台在新的一场里照常记账", async () => {
    await addLog({ ...CQWW_ROW, round: 1 });
    await addLog({ ...CQWW_ROW, round: 2, timeUtc: "12:30:00" });
    const root = freshRoot();
    mountLog(root, "CQWW", { rounds: { CQWW: 2 } });
    await vi.waitFor(() => expect(root.querySelectorAll("tbody tr").length).toBe(1));
    expect(root.querySelectorAll(".dupe:not(.none)").length).toBe(0);
  });

  it("通联跑通后，按操作者填的呼号与 RST 记下一条日志", async () => {
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

    // The row comes from what the operator wrote down, not from the machine —
    // and the dial is read at the moment they sign off.
    const truth = session.partnerTruth();
    expect(truth).not.toBeNull();
    const record = buildLogRecord(
      { ...emptyEntry("run"), call: peer, rstTx: "599", rstRx: truth!.report },
      session.freqMHz,
      { truth },
    );
    expect(record).not.toBeNull();
    expect(record!.call).toBe(peer);
    expect(record!.mode).toBe("CW");
    expect(record!.freqMHz).toBe((station.freqHz / 1e6).toFixed(4));
    expect(record!.rstRx).toBe(truth!.report);
    // 抄下来的是他真正发的那个报告，所以这一条是对的。
    expect(record!.verdict).toBe("ok");

    await addLog(record!);

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

describe("三种模式各一本日志", () => {
  it("三本各数各的：标签上带条数，表格只显示当前这本", async () => {
    await addLog(SAMPLE);
    await addLog({ ...SAMPLE, call: "JA2XYZ" });
    await addLog(CQWW_ROW);

    const root = freshRoot();
    mountLog(root, "DX");
    await vi.waitFor(() => expect(root.querySelectorAll("tbody tr").length).toBe(2));

    expect(
      Array.from(root.querySelectorAll(".log-tabs button")).map((b) => b.textContent),
    ).toEqual(["DX 2", "CQWW 1", "WPX 0"]);

    buttonByText(root, "CQWW 1").click();

    await vi.waitFor(() => expect(root.querySelectorAll("tbody tr").length).toBe(1));
    // 比赛日志多了两列：对方的、我方的交换信息；「重复」三本都有。
    expect(headersOf(root)).toEqual([
      ...DX_HEADERS.slice(0, 7),
      "EXCH_RX",
      "EXCH_TX",
      "重复",
      "核对",
      "操作",
    ]);
    expect(root.querySelector<HTMLInputElement>("tbody tr input")!.value).toBe("2026-10-14");
  });

  it("核对结论写成中文，并注明错在哪一项", async () => {
    await addLog(CQWW_ROW);
    const root = freshRoot();
    mountLog(root, "CQWW");

    await vi.waitFor(() => expect(root.querySelector(".verdict")).not.toBeNull());
    expect(root.querySelector(".verdict")?.textContent).toBe("交换信息错误");
    expect(root.querySelector(".verdict")?.getAttribute("title")).toContain("不给出正确答案");
  });

  it("清空一本不碰另外两本", async () => {
    await addLog(SAMPLE);
    await addLog(CQWW_ROW);

    const root = freshRoot();
    mountLog(root, "CQWW");
    await vi.waitFor(() => expect(root.querySelectorAll("tbody tr").length).toBe(1));

    const btn = buttonByText(root, "清空本次 CQWW（1 条）");
    btn.click();
    btn.click();

    await vi.waitFor(async () => {
      const rows = await listLogs();
      expect(rows.map((r) => r.contest)).toEqual(["DX"]);
    });
  });

  it("标签上的条数各按各的场次算：CQWW 开到第二场，DX 不会被数成 0", async () => {
    await addLog(SAMPLE); // DX，没有场次
    await addLog(CQWW_ROW); // CQWW 第 1 场
    await addLog({ ...CQWW_ROW, round: 2, call: "DL2XYZ" });

    const root = freshRoot();
    mountLog(root, "CQWW", { rounds: { CQWW: 2 } });
    await vi.waitFor(() => expect(root.querySelectorAll("tbody tr").length).toBe(1));

    expect(
      Array.from(root.querySelectorAll(".log-tabs button")).map((b) => b.textContent),
    ).toEqual(["DX 1", "CQWW 1", "WPX 0"]);
  });

  it("有记录的时候也能「清空全部」——不用先把这一本删空", async () => {
    await addLog(SAMPLE);
    await addLog(CQWW_ROW);

    const root = freshRoot();
    mountLog(root, "DX");
    await vi.waitFor(() => expect(root.querySelectorAll("tbody tr").length).toBe(1));

    const btn = buttonByText(root, "清空全部日志（2 条）");
    btn.click();
    btn.click();

    await vi.waitFor(async () => expect(await listLogs()).toHaveLength(0));
  });

  it("交换信息那一格只收数字，存下去不带前导零", async () => {
    await addLog(CQWW_ROW);
    const root = freshRoot();
    mountLog(root, "CQWW");
    await vi.waitFor(() => expect(root.querySelectorAll("tbody tr").length).toBe(1));

    const inputs = Array.from(root.querySelectorAll<HTMLInputElement>("tbody tr input"));
    // date / time / call / freq / rstRx / rstTx / exchRx / exchTx
    const exchRx = inputs[6];
    exchRx.value = "ab015";
    exchRx.dispatchEvent(new Event("input", { bubbles: true }));
    expect(exchRx.value).toBe("015");

    buttonByText(root, "保存").click();
    await vi.waitFor(async () => expect((await listLogs())[0].exchRx).toBe("15"));
  });
});

describe("比赛场次（本次 / 历史）", () => {
  const OLD: LogRecord = { ...CQWW_ROW, round: 1, call: "DL1ABC" };
  const NOW: LogRecord = { ...CQWW_ROW, round: 2, call: "DL2XYZ", timeUtc: "13:00:00" };

  it("一场一条线：切到第二场之后，本次只剩新的，旧的进历史", async () => {
    await addLog(OLD);
    await addLog(NOW);

    const root = freshRoot();
    mountLog(root, "CQWW", { rounds: { CQWW: 2 } });

    await vi.waitFor(() => expect(root.querySelectorAll("tbody tr").length).toBe(1));
    expect(root.querySelectorAll<HTMLInputElement>("tbody tr input")[2].value).toBe("DL2XYZ");
    // 两个视图的条数写在按钮上，边界一眼看得见。
    expect(root.textContent).toContain("本次 1");
    expect(root.textContent).toContain("历史 1");

    buttonByText(root, "历史 1").click();
    await vi.waitFor(() => expect(root.querySelectorAll("tbody tr").length).toBe(1));
    expect(root.querySelectorAll<HTMLInputElement>("tbody tr input")[2].value).toBe("DL1ABC");
  });

  it("标签上的条数跟着视图走：看历史时数的是历史", async () => {
    await addLog(OLD);
    await addLog({ ...OLD, call: "DL3QQ", timeUtc: "12:00:00" });
    await addLog(NOW);

    const root = freshRoot();
    mountLog(root, "CQWW", { rounds: { CQWW: 2 } });

    const tab = (): string => root.querySelector(".log-tabs .btn.active")?.textContent ?? "";
    await vi.waitFor(() => expect(tab()).toBe("CQWW 1"));

    buttonByText(root, "历史 2").click();
    // 表格换成历史那两条，标签上的数也跟着换——否则页面自己在跟自己吵架。
    await vi.waitFor(() => expect(root.querySelectorAll("tbody tr").length).toBe(2));
    expect(tab()).toBe("CQWW 2");
  });

  it("「开始新的一场」把这一本整体转入历史，本次从头开始", async () => {
    await addLog(CQWW_ROW);
    const root = freshRoot();
    const host = mountLog(root, "CQWW");
    await vi.waitFor(() => expect(root.querySelectorAll("tbody tr").length).toBe(1));

    buttonByText(root, "开始新的一场").click();

    await vi.waitFor(() => expect(host.sessionRound?.("CQWW")).toBe(2));
    await vi.waitFor(() => expect(root.textContent).toContain("暂无 CQWW 日志记录"));
    // 日志没被删掉：翻到历史还看得见。
    await expect(listLogs()).resolves.toHaveLength(1);
    buttonByText(root, "历史 1").click();
    await vi.waitFor(() => expect(root.querySelectorAll("tbody tr").length).toBe(1));
  });

  it("清空本次只删这一场，历史留着", async () => {
    await addLog(OLD);
    await addLog(NOW);
    const root = freshRoot();
    mountLog(root, "CQWW", { rounds: { CQWW: 2 } });
    await vi.waitFor(() => expect(root.querySelectorAll("tbody tr").length).toBe(1));

    const btn = buttonByText(root, "清空本次 CQWW（1 条）");
    btn.click();
    btn.click();

    await vi.waitFor(async () => {
      const rows = await listLogs();
      expect(rows.map((r) => r.round)).toEqual([1]);
    });
  });

  it("DX 不分场次：标签上没有本次 / 历史", async () => {
    await addLog(SAMPLE);
    const root = freshRoot();
    mountLog(root, "DX");
    await vi.waitFor(() => expect(root.querySelectorAll("tbody tr").length).toBe(1));
    expect(root.textContent).not.toContain("开始新的一场");
    expect(root.querySelector(".log-sessions")).toBeNull();
  });
});
