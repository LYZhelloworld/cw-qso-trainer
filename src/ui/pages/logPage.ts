import { button, clear, el, panel } from "../dom.js";
import { LOG_WATERMARK } from "../disclaimer.js";
import { clearLogs, listLogs, logsAvailable, updateLog } from "../storage/logStore.js";
import type { LogRecord } from "../logRecord.js";
import type { AppHost } from "../app.js";

/** Column order mirrors the UI.md log field table. */
const COLUMNS = ["DATE", "TIME_UTC", "CALL", "FREQ_MHZ", "MODE", "RST_RX", "RST_TX", "操作"];

export function renderLog(host: AppHost, root: HTMLElement): void {
  const body = el("div");
  root.append(
    panel("通联日志", body),
    el("div", { class: "watermark", text: LOG_WATERMARK }),
  );

  void listLogs().then((rows) => {
    clear(body);
    if (!logsAvailable()) {
      body.append(el("div", { class: "hint", text: "当前环境不支持 IndexedDB，日志无法保存。" }));
      return;
    }
    if (rows.length === 0) {
      body.append(
        el("div", { class: "hint", text: "暂无日志记录。完成一次完整通联后会自动写入。" }),
      );
      return;
    }

    const table = el("table", { class: "log" });
    const headRow = el("tr");
    for (const c of COLUMNS) headRow.append(el("th", { text: c }));
    const thead = el("thead");
    thead.append(headRow);

    const tbody = el("tbody");
    for (const rec of rows) tbody.append(buildRow(rec, host));

    table.append(thead, tbody);
    body.append(table);

    const actions = el("div", { class: "row" });
    actions.append(
      button(
        "清空全部",
        () => {
          void clearLogs().then(() => host.refresh());
        },
        "btn danger",
      ),
    );
    body.append(actions);
    body.append(el("div", { class: "hint", text: "日志不可导出为 ADIF / CSV / JSON 等格式。" }));
  });
}

function buildRow(record: LogRecord, host: AppHost): HTMLTableRowElement {
  const tr = el("tr");
  const inputs: Record<string, HTMLInputElement> = {};

  const addCell = (key: "date" | "timeUtc" | "call" | "freqMHz" | "rstRx" | "rstTx", width: string): void => {
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

  const actions = el("td");
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
        void updateLog(updated).then(() => host.refresh());
      },
      "btn small",
    ),
  );
  tr.append(actions);
  return tr;
}
