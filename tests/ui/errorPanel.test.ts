// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderErrorPanel } from "../../src/ui/errorPanel.js";

describe("渲染错误面板", () => {
  it("展示出错信息并暴露「重试」按钮", () => {
    const root = document.createElement("div");
    let retried = false;
    renderErrorPanel(root, "cw", new Error("boom"), () => {
      retried = true;
    });

    expect(root.querySelector("h2")?.textContent).toBe("页面渲染出错");
    expect(root.textContent).toContain("boom");
    expect(root.textContent).toContain("cw");

    const retry = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === "重试",
    );
    expect(retry).toBeDefined();
    retry?.click();
    expect(retried).toBe(true);
  });

  it("非 Error 对象也能安全展示", () => {
    const root = document.createElement("div");
    renderErrorPanel(root, "log", "string error", () => {});
    expect(root.querySelector(".error-detail")?.textContent).toContain("string error");
  });
});
