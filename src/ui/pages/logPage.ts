import { button, clear, el, panel } from "../dom.js";
import { LOG_WATERMARK } from "../disclaimer.js";
import { clearLogs, deleteLog, listLogs, logsAvailable, updateLog } from "../storage/logStore.js";
import { contestOf, type LogRecord } from "../logRecord.js";
import {
  CONTEST_KINDS,
  CONTEST_LABEL,
  VERDICT_LABEL,
  exchangeName,
  requiresExchange,
  type ContestKind,
  type LogVerdict,
} from "../../qso/contest.js";
import type { AppHost } from "../app.js";

/**
 * The log book, one page per mode.
 *
 * The three logs are independent records of three independent things: an
 * everyday contact and a contest contact are not the same entry, and a CQWW
 * number is not a WPX number. So the page is tabbed rather than mixed, and every
 * action on it — edit, delete, clear — applies to the tab you are looking at.
 *
 * Each row also carries a **verdict**: did the operator copy the station right?
 * It is computed when the row is written (`logRecord`), never shown while the
 * contact is open, and it names the mistake without naming the right answer —
 * see `verifyEntry`. A row typed in by hand has no verdict, because there was no
 * station to check it against, and a row edited here loses its verdict, because
 * the copy that was checked is no longer the copy in the book.
 */
export function renderLog(host: AppHost, root: HTMLElement): void {
  const tab: ContestKind = host.logContest ?? host.settings.contest;
  const tabs = el("div", { class: "log-tabs", attrs: { role: "tablist" } });
  const body = el("div");
  root.append(panel("通联日志", tabs, body), el("div", { class: "watermark", text: LOG_WATERMARK }));

  void listLogs().then((all) => {
    const rows = all.filter((row) => contestOf(row) === tab);
    renderTabs(tabs, host, tab, all);
    clear(body);
    if (!logsAvailable()) {
      body.append(el("div", { class: "hint", text: "当前环境不支持 IndexedDB，日志无法保存。" }));
      return;
    }
    if (rows.length === 0) {
      body.append(el("div", { class: "hint", text: emptyHint(tab) }));
      body.append(clearAll(host, all.length));
      return;
    }

    const table = el("table", { class: "log" });
    const headRow = el("tr");
    for (const c of columnsFor(tab)) headRow.append(el("th", { text: c }));
    const thead = el("thead");
    thead.append(headRow);

    const tbody = el("tbody");
    for (const rec of rows) tbody.append(buildRow(rec, host, tab));

    table.append(thead, tbody);
    body.append(table);
    body.append(actionsRow(host, tab, rows.length));
    body.append(el("div", { class: "hint", text: "日志不可导出为 ADIF / CSV / JSON 等格式。" }));
  });
}

/** The tab strip: one tab per log, with how many contacts each holds. */
function renderTabs(
  tabs: HTMLElement,
  host: AppHost,
  current: ContestKind,
  all: LogRecord[],
): void {
  clear(tabs);
  for (const kind of CONTEST_KINDS) {
    const count = all.filter((row) => contestOf(row) === kind).length;
    const btn = button(
      `${CONTEST_LABEL[kind]} ${count}`,
      () => selectTab(host, kind),
      kind === current ? "btn chip active" : "btn chip",
    );
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", String(kind === current));
    btn.title = tabHint(kind);
    tabs.append(btn);
  }
}

function selectTab(host: AppHost, kind: ContestKind): void {
  host.setLogContest?.(kind);
  // Hosts without the setter (tests, error pages) still get the tab they clicked.
  if (!host.setLogContest) host.refresh();
}

function tabHint(kind: ContestKind): string {
  if (kind === "CQWW") return "CQWW：交换 CQ 分区，与 DX / WPX 各记一本";
  if (kind === "WPX") return "WPX：交换自增序号，与 DX / CQWW 各记一本";
  return "DX：日常通联，只交换呼号与 RST";
}

function emptyHint(kind: ContestKind): string {
  if (kind === "DX") {
    return "暂无日志记录。在电台页填好对方呼号与两个 RST、按回车发出结束语，就会记到这里的。";
  }
  return `暂无 ${kind} 日志记录。在电台页把通联模式切到 ${kind}，填好呼号、两个 RST 与对方${exchangeName(
    kind,
  )}，按回车发出 TU 就会记到这里的。`;
}

/** Column order mirrors LOG.md's field table, with the contest columns added. */
function columnsFor(kind: ContestKind): string[] {
  const base = ["DATE", "TIME_UTC", "CALL", "FREQ_MHZ", "MODE", "RST_RX", "RST_TX"];
  if (requiresExchange(kind)) base.push("EXCH_RX", "EXCH_TX");
  return [...base, "核对", "操作"];
}

function buildRow(record: LogRecord, host: AppHost, kind: ContestKind): HTMLTableRowElement {
  const tr = el("tr");
  const inputs: Record<string, HTMLInputElement> = {};

  const addCell = (
    key: "date" | "timeUtc" | "call" | "freqMHz" | "rstRx" | "rstTx" | "exchRx" | "exchTx",
    width: string,
  ): void => {
    const td = el("td");
    const input = el("input", { attrs: { type: "text" } });
    input.value = String(record[key] ?? "");
    input.style.width = width;
    inputs[key] = input;
    td.append(input);
    tr.append(td);
  };

  addCell("date", "96px");
  addCell("timeUtc", "80px");
  addCell("call", "100px");
  addCell("freqMHz", "80px");
  tr.append(el("td", { text: record.mode }));
  addCell("rstRx", "54px");
  addCell("rstTx", "54px");
  if (requiresExchange(kind)) {
    addCell("exchRx", "58px");
    addCell("exchTx", "58px");
  }

  tr.append(verdictCell(record.verdict));

  const actions = el("td", { class: "log-actions" });
  actions.append(
    button(
      "保存",
      () => {
        const updated: LogRecord = {
          ...record,
          date: inputs.date.value,
          timeUtc: inputs.timeUtc.value,
          call: inputs.call.value.trim().toUpperCase(),
          freqMHz: inputs.freqMHz.value,
          rstRx: inputs.rstRx.value,
          rstTx: inputs.rstTx.value,
        };
        if (inputs.exchRx) updated.exchRx = inputs.exchRx.value;
        if (inputs.exchTx) updated.exchTx = inputs.exchTx.value;
        // An edited row is no longer the copy that was checked: the verdict goes
        // with the copy it judged, rather than sitting next to a changed call.
        delete updated.verdict;
        void updateLog(updated).then(() => host.refresh());
      },
      "btn small",
    ),
  );
  actions.append(
    button(
      "删除",
      () => {
        if (typeof record.id !== "number") return;
        void deleteLog(record.id).then(() => host.refresh());
      },
      "btn small danger",
    ),
  );
  tr.append(actions);
  return tr;
}

/**
 * The verdict cell. Deliberately says *what* went wrong and never what the right
 * answer was: the trainer does not tell the operator who is on the other end, and
 * that rule does not stop when the contact does.
 */
function verdictCell(verdict: LogVerdict | undefined): HTMLTableCellElement {
  const td = el("td", {
    class: verdict ? `verdict ${verdict}` : "verdict unknown",
    text: verdict ? VERDICT_LABEL[verdict] : "—",
  });
  td.title =
    verdict === undefined
      ? "没有与该台的收发过程，无法核对（手记的条目）"
      : verdict === "ok"
        ? "呼号、交换信息与 RST 都抄对了"
        : "抄收有误：这里只说错在哪一项，不给出正确答案";
  return td;
}

/** Clear this tab's log. Two clicks: the first only asks. */
function actionsRow(host: AppHost, kind: ContestKind, count: number): HTMLElement {
  const row = el("div", { class: "row" });
  let armed = false;
  const btn = button(
    `清空 ${CONTEST_LABEL[kind]} 日志（${count} 条）`,
    () => {
      if (!armed) {
        armed = true;
        btn.textContent = `再点一次清空 ${count} 条，不可恢复`;
        btn.classList.add("armed");
        return;
      }
      void clearLogs(kind).then(() => host.refresh());
    },
    "btn danger",
  );
  row.append(btn);
  return row;
}

/** The only action that crosses logs; asks the same way. */
function clearAll(host: AppHost, count: number): HTMLElement {
  const row = el("div", { class: "row" });
  if (count === 0) return row;
  let armed = false;
  const btn = button(
    `清空全部日志（${count} 条）`,
    () => {
      if (!armed) {
        armed = true;
        btn.textContent = `再点一次清空全部 ${count} 条，不可恢复`;
        btn.classList.add("armed");
        return;
      }
      void clearLogs().then(() => host.refresh());
    },
    "btn danger",
  );
  row.append(btn);
  return row;
}
