import { button, clear, el, panel } from "../dom.js";
import { LOG_WATERMARK } from "../disclaimer.js";
import {
  clearLogs,
  clearPastLogs,
  deleteLog,
  listLogs,
  logsAvailable,
  updateLog,
} from "../storage/logStore.js";
import { contestOf, roundOf, type LogRecord } from "../logRecord.js";
import { dupeIds } from "../logDupes.js";
import {
  CONTEST_KINDS,
  CONTEST_LABEL,
  VERDICT_LABEL,
  normaliseExchange,
  requiresExchange,
  theirExchangeLabel,
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
 * A contest log has a second axis: the **session** (场次). A trainer has no
 * contest weekend and no 48-hour clock, so the operator draws that line by hand
 * with "start a new one"; what was written before it becomes history, still
 * readable, never mixed into the totals of the current run.
 *
 * Each row also carries two questions the paper asks:
 *
 *  - **verdict** — did the operator copy the station right? Computed when the row
 *    is written (`logRecord`), never shown while the contact is open, and it names
 *    the mistake without naming the right answer (see `verifyEntry`). A row typed
 *    in by hand has no verdict, because there was no station to check it against,
 *    and a row edited here loses its verdict, because the copy that was checked is
 *    no longer the copy in the book.
 *  - **dupe** — have we worked this station already, on this band, in this session?
 *    Computed when the page is drawn (`logDupes`) and *only* a label: the contact
 *    was completed and logged exactly as on the air, because refusing to log
 *    somebody you have already worked is not what an operator does.
 */
export function renderLog(host: AppHost, root: HTMLElement): void {
  const tab: ContestKind = host.logContest ?? host.settings.contest;
  const past = host.logPast ?? false;
  const tabs = el("div", { class: "log-tabs", attrs: { role: "tablist" } });
  const strip = el("div");
  const body = el("div");
  root.append(
    panel("通联日志", tabs, strip, body),
    el("div", { class: "watermark", text: LOG_WATERMARK }),
  );

  void listLogs().then((all) => {
    const round = host.sessionRound?.(tab) ?? 1;
    const session = (row: LogRecord): boolean =>
      past ? roundOf(row) < round : roundOf(row) === round;
    const isContest = requiresExchange(tab);
    const rows = all.filter((row) => contestOf(row) === tab && (!isContest || session(row)));

    renderTabs(tabs, host, tab, all);
    clear(strip);
    if (isContest) strip.append(sessionStrip(host, all, tab, round, past));
    clear(body);

    if (!logsAvailable()) {
      body.append(el("div", { class: "hint", text: "当前环境不支持 IndexedDB，日志无法保存。" }));
      return;
    }
    if (rows.length === 0) {
      body.append(el("div", { class: "hint", text: emptyHint(tab, past) }));
      if (!past) body.append(clearAll(host, all.length));
      return;
    }

    const dupes = dupeIds(rows);
    const table = el("table", { class: "log" });
    const headRow = el("tr");
    for (const c of columnsFor(tab)) headRow.append(el("th", { text: c }));
    const thead = el("thead");
    thead.append(headRow);

    const tbody = el("tbody");
    for (const rec of rows) tbody.append(buildRow(rec, host, tab, dupes));

    table.append(thead, tbody);
    body.append(table);
    body.append(actionsRow(host, tab, round, rows.length, past));
    // Always reachable, not only on an empty page: wanting to start over is the
    // very reason the log has rows in it.
    if (!past) body.append(clearAll(host, all.length));
    body.append(
      el("div", {
        class: "hint",
        text: "日志不可导出为 ADIF / CSV / JSON 等格式。",
      }),
    );
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
    // Each tab counts its own book — including its own session. DX has no
    // sessions, so taking the *current tab's* session number here would show an
    // empty DX book the moment somebody starts a second CQWW session.
    const round = host.sessionRound?.(kind) ?? 1;
    const count = all.filter(
      (row) =>
        contestOf(row) === kind && (!requiresExchange(kind) || roundOf(row) === round),
    ).length;
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
  return "DX：日常通联，只交换呼号与 RST（不分场次）";
}

/**
 * The session strip: this run, the ones before it, and the button that draws the
 * line between them. Only contests have sessions — an everyday contact has no
 * "round" to be in.
 */
function sessionStrip(
  host: AppHost,
  all: LogRecord[],
  tab: ContestKind,
  round: number,
  past: boolean,
): HTMLElement {
  const thisRun = all.filter((row) => contestOf(row) === tab && roundOf(row) === round).length;
  const history = all.filter((row) => contestOf(row) === tab && roundOf(row) < round).length;

  const strip = el("div", { class: "log-sessions" });
  strip.append(
    chip(`本次 ${thisRun}`, !past, () => setPast(host, false), `第 ${round} 场，正在记的那一本`),
    chip(
      `历史 ${history}`,
      past,
      () => setPast(host, true),
      history === 0 ? "还没有分割过的旧场次" : "分割之前记的那几本，只读着看",
    ),
  );
  const newRun = button("开始新的一场", () => host.startNewRound?.(tab), "btn small");
  newRun.title =
    "把本次记的整本转入历史，新的这一场从空开始；日志不删，随时能翻回去" +
    (tab === "WPX" ? "。WPX 的序号回到 001" : "");
  strip.append(newRun);
  if (round > 1) {
    strip.append(el("span", { class: "hint", text: `第 ${round} 场` }));
  }
  return strip;
}

function chip(label: string, active: boolean, onClick: () => void, title: string): HTMLElement {
  const btn = button(label, onClick, active ? "btn chip active" : "btn chip");
  btn.title = title;
  btn.setAttribute("aria-pressed", String(active));
  return btn;
}

function setPast(host: AppHost, past: boolean): void {
  host.setLogPast?.(past);
  if (!host.setLogPast) host.refresh();
}

function emptyHint(kind: ContestKind, past: boolean): string {
  if (past) {
    return "历史里还没有记录。在本次日志里点「开始新的一场」，这一场就会整本移到这里。";
  }
  if (kind === "DX") {
    return "暂无日志记录。在电台页填好对方呼号与两个 RST、按回车发出结束语，就会记到这里的。";
  }
  return `暂无 ${kind} 日志记录。在电台页把通联模式切到 ${kind}，填好呼号、两个 RST 与${theirExchangeLabel(
    kind,
  )}，按回车发出 TU 就会记到这里的。`;
}

/** Column order mirrors LOG.md's field table, with the contest columns added. */
function columnsFor(kind: ContestKind): string[] {
  const base = ["DATE", "TIME_UTC", "CALL", "FREQ_MHZ", "MODE", "RST_RX", "RST_TX"];
  if (requiresExchange(kind)) base.push("EXCH_RX", "EXCH_TX");
  return [...base, "重复", "核对", "操作"];
}

function buildRow(
  record: LogRecord,
  host: AppHost,
  kind: ContestKind,
  dupes: Set<number>,
): HTMLTableRowElement {
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
    // The exchange columns are numbers, so they only take digits: a typo here
    // used to be savable as `abc`, which left a row that could never match
    // anything and a verdict column that simply said nothing.
    if (key === "exchRx" || key === "exchTx") {
      input.addEventListener("input", () => {
        const clean = input.value.replace(/\D/g, "");
        if (clean !== input.value) input.value = clean;
      });
    }
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

  tr.append(dupeCell(typeof record.id === "number" && dupes.has(record.id)));
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
        // Stored the way the row is written during a contact: a plain number,
        // whatever spelling was typed over it.
        if (inputs.exchRx) updated.exchRx = normaliseExchange(kind, inputs.exchRx.value);
        if (inputs.exchTx) updated.exchTx = normaliseExchange(kind, inputs.exchTx.value);
        // An edited row is no longer the copy that was checked: the verdict goes
        // with the copy it judged, rather than sitting next to a changed call.
        delete updated.verdict;
        void updateLog(updated).then(() => host.refresh());
      },
      "btn small",
    ),
  );
  // Deleting one row asks the same way clearing the book does: it cannot be
  // undone, and a single stray click on a table of contacts should not lose one.
  let armed = false;
  const remove = button(
    "删除",
    () => {
      if (typeof record.id !== "number") return;
      if (!armed) {
        armed = true;
        remove.textContent = "再点一次删除";
        remove.classList.add("armed");
        return;
      }
      void deleteLog(record.id).then(() => host.refresh());
    },
    "btn small danger",
  );
  actions.append(remove);
  tr.append(actions);
  return tr;
}

/**
 * The dupe cell. A label, not a gate: the contact happened, it is in the book,
 * and all this says is that the same station was already worked — on this band,
 * in this session. Red-flagging it is the whole feature; a trainer that refused
 * to log the second one would be teaching the wrong manners.
 */
function dupeCell(dupe: boolean): HTMLTableCellElement {
  const td = el("td", { class: dupe ? "dupe" : "dupe none" });
  if (dupe) {
    td.textContent = "重复";
    td.title = "同一场、同一波段、同一呼号，之前已经通过一次（通联照样完成、照样记下）";
  }
  return td;
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

/** Clear this view. Two clicks: the first only asks. */
function actionsRow(
  host: AppHost,
  kind: ContestKind,
  round: number,
  count: number,
  past: boolean,
): HTMLElement {
  const row = el("div", { class: "row" });
  const isContest = requiresExchange(kind);
  const label = isContest
    ? past
      ? `清空历史（${count} 条）`
      : `清空本次 ${CONTEST_LABEL[kind]}（${count} 条）`
    : `清空 ${CONTEST_LABEL[kind]} 日志（${count} 条）`;

  let armed = false;
  const btn = button(
    label,
    () => {
      if (!armed) {
        armed = true;
        btn.textContent = `再点一次清空 ${count} 条，不可恢复`;
        btn.classList.add("armed");
        return;
      }
      const done = () =>
        isContest ? (past ? clearPastLogs(kind, round) : clearLogs(kind, round)) : clearLogs(kind);
      void done().then(() => host.refresh());
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
