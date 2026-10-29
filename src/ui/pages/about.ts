import { el, panel } from "../dom.js";
import { DISCLAIMER_TEXT } from "../disclaimer.js";
import type { AppHost } from "../app.js";

const VERSION = "1.2.0";

export function renderAbout(_host: AppHost, root: HTMLElement): void {
  const disclaimer = el("div", { text: DISCLAIMER_TEXT });
  disclaimer.style.whiteSpace = "pre-line";

  const scope = [
    "· 练习抄收 CW 报文、发送、完成标准 QSO 流程并记录练习日志。",
    "· 呼号只做格式与 DXCC 前缀校验，不记录、不展示其国家 / 地区归属。",
    "· 日志不可导出为 ADIF / CSV / JSON，不可用于任何奖项申请。",
    "· 所有资源本地运行，不依赖网络。",
  ];

  const scopeBox = el("div", { class: "col" });
  for (const line of scope) scopeBox.append(el("div", { class: "hint", text: line }));

  root.append(
    panel(
      "关于",
      el("div", { text: `CW QSO 练习器 v${VERSION}` }),
      el("div", { class: "hint", text: "离线摩尔斯电码通联练习器，面向业余无线电爱好者。" }),
    ),
    panel("免责声明", disclaimer),
    panel("项目范围", scopeBox),
  );
}
