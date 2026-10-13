// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderLog } from "./logPage.js";
import { logsAvailable } from "../storage/logStore.js";
import { LOG_WATERMARK } from "../disclaimer.js";
import { normalizeSettings } from "../settingsSchema.js";
import { QsoSession } from "../session.js";
import type { AppHost, PageId } from "../app.js";

/**
 * jsdom ships no IndexedDB. Without a polyfill (this file deliberately does not
 * install one) the log page must degrade instead of throwing, per
 * "storage may be unavailable" in UI.md.
 */

function mountLog(root: HTMLElement): void {
  const host: AppHost = {
    settings: normalizeSettings({}),
    session: {} as QsoSession,
    updateSettings() {},
    newSession() {},
    go(_page: PageId) {},
    refresh() {},
    onLeave() {},
  };
  renderLog(host, root);
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("日志页（IndexedDB 不可用时的降级）", () => {
  it("当前环境确实没有 IndexedDB", () => {
    expect(logsAvailable()).toBe(false);
  });

  it("提示日志无法保存，而不是报错或空白", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    mountLog(root);

    await vi.waitFor(() =>
      expect(root.textContent).toContain("当前环境不支持 IndexedDB，日志无法保存。"),
    );
    expect(root.querySelector("table.log")).toBeNull();
  });

  it("降级时依然保留水印与免责声明", async () => {
    const root = document.createElement("div");
    document.body.append(root);
    mountLog(root);

    expect(root.querySelector(".watermark")?.textContent).toBe(LOG_WATERMARK);
    await vi.waitFor(() => expect(root.textContent).toContain("不支持 IndexedDB"));
  });
});
