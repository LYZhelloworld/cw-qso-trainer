// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderAbout } from "../../../src/ui/pages/about.js";
import { DISCLAIMER_TEXT, LOG_WATERMARK } from "../../../src/ui/disclaimer.js";
import type { AppHost } from "../../../src/ui/app.js";

function mount(): HTMLElement {
  const root = document.createElement("div");
  document.body.append(root);
  renderAbout({} as AppHost, root);
  return root;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("关于页", () => {
  it("显示版本号与定位说明", () => {
    const root = mount();
    expect(root.textContent).toContain("CW QSO 练习器 v1.0.0");
    expect(root.textContent).toContain("离线摩尔斯电码通联练习器");
  });

  it("完整展示免责声明文本", () => {
    expect(mount().textContent).toContain(DISCLAIMER_TEXT);
  });

  it("声明了项目范围，包括去争议化与不可导出两条", () => {
    const text = mount().textContent ?? "";
    expect(text).toContain("不记录、不展示其国家 / 地区归属");
    expect(text).toContain("日志不可导出为 ADIF / CSV / JSON");
    expect(text).not.toContain(LOG_WATERMARK); // 水印归日志页，不混入关于页
  });
});
