// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderSettings } from "./settingsPage.js";
import { DEFAULT_SETTINGS, TONE_MAX, TONE_MIN, WPM_MAX, normalizeSettings, type AppSettings } from "../settingsSchema.js";
import { QsoSession } from "../session.js";
import { dxccDatabase } from "../../data/dxcc.js";
import type { AppHost, PageId } from "../app.js";

function makeHost(overrides: Partial<AppSettings> = {}) {
  const root = document.createElement("div");
  document.body.append(root);
  const host: AppHost = {
    settings: normalizeSettings(overrides),
    session: {} as QsoSession,
    updateSettings(patch: Partial<AppSettings>) {
      host.settings = normalizeSettings({ ...host.settings, ...patch });
      render();
    },
    newSession() {},
    go(_page: PageId) {},
    refresh() {
      render();
    },
    onLeave(_fn: () => void) {},
  };

  function render(): void {
    const page = document.createElement("div");
    renderSettings(host, page);
    root.replaceChildren(page);
  }

  render();
  return { host, root };
}

function panelTitles(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll(".panel h2")).map((h) => h.textContent ?? "");
}

function fieldByLabel(root: HTMLElement, labelText: string): HTMLLabelElement {
  const found = Array.from(root.querySelectorAll<HTMLLabelElement>("label.field")).find((l) =>
    (l.textContent ?? "").startsWith(labelText),
  );
  if (!found) throw new Error(`未找到字段：${labelText}`);
  return found;
}

function checkboxByLabel(root: HTMLElement, labelText: string): HTMLInputElement {
  const found = Array.from(root.querySelectorAll<HTMLLabelElement>("label.row")).find((l) =>
    (l.textContent ?? "").includes(labelText),
  );
  const box = found?.querySelector<HTMLInputElement>('input[type="checkbox"]');
  if (!box) throw new Error(`未找到复选框：${labelText}`);
  return box;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  document.body.innerHTML = "";
});

describe("设置页", () => {
  it("包含身份 / 音频与速度 / 通联 / 键位 / 其他五个区块", () => {
    const { root } = makeHost();
    expect(panelTitles(root)).toEqual(["身份", "音频与速度", "通联", "键位", "其他"]);
  });

  it("未填呼号时给出错误提示", () => {
    const { root } = makeHost({ myCall: "" });
    const msg = fieldByLabel(root, "本方呼号").querySelector(".err");
    expect(msg?.textContent).toBe("请填写本方呼号");
  });

  it("格式非法的呼号给出错误提示", () => {
    const { root } = makeHost({ myCall: "XX7" });
    const input = fieldByLabel(root, "本方呼号").querySelector("input")!;
    input.value = "7ABC";
    input.dispatchEvent(new Event("input"));

    const msg = fieldByLabel(root, "本方呼号").querySelector(".err");
    expect(msg?.textContent).toContain("呼号格式不符合规范");
  });

  it("合法且前缀已知的呼号给出通过提示，未知前缀只警告", () => {
    const { root } = makeHost({ myCall: "" });
    const input = fieldByLabel(root, "本方呼号").querySelector("input")!;

    // A prefix straight from the DXCC table must be accepted outright.
    const known = dxccDatabase
      .listEntities()
      .flatMap((e) => e.prefixes)
      .find((p) => /^[A-Z]{1,2}[0-9]$/.test(p))!;
    input.value = `${known}ABC`;
    input.dispatchEvent(new Event("input"));
    expect(fieldByLabel(root, "本方呼号").querySelector(".ok-text")?.textContent).toBe(
      "呼号格式正确",
    );

    // Format-valid but unknown prefix: usable for practise, warned only.
    input.value = "ZZ9ZZZ";
    input.dispatchEvent(new Event("input"));
    const warn = fieldByLabel(root, "本方呼号").querySelector(".hint");
    expect(warn?.textContent).toContain("不在 DXCC 表中");
  });

  it("表外前缀（如 BG7）仍可用于练习，仅提示.warn 而非错误", () => {
    const { root } = makeHost({ myCall: "" });
    const input = fieldByLabel(root, "本方呼号").querySelector("input")!;

    input.value = "BG7XXX";
    input.dispatchEvent(new Event("input"));

    // Format is legal, so this must never escalate to an error.
    expect(fieldByLabel(root, "本方呼号").querySelector(".err")).toBeNull();
    expect(fieldByLabel(root, "本方呼号").textContent).toContain("仍可用于练习");
  });

  it("输入呼号后失焦才提交到设置并持久化", () => {
    const { root, host } = makeHost({ myCall: "" });
    const input = fieldByLabel(root, "本方呼号").querySelector("input")!;

    input.value = "ja1abc";
    input.dispatchEvent(new Event("input"));
    expect(host.settings.myCall).toBe("");

    input.dispatchEvent(new Event("change"));
    expect(host.settings.myCall).toBe("JA1ABC");
  });

  it("音调与速度修改后会更新设置，超出范围会被收敛到上下限", () => {
    const { root, host } = makeHost();

    const tone = fieldByLabel(root, "CW 音调 (Hz)").querySelector("input")!;
    tone.value = "800";
    tone.dispatchEvent(new Event("change"));
    expect(host.settings.toneHz).toBe(800);

    const wpm = fieldByLabel(root, "速度 WPM").querySelector("input")!;
    wpm.value = "9999";
    wpm.dispatchEvent(new Event("change"));
    expect(host.settings.wpm).toBe(WPM_MAX);

    expect(TONE_MIN).toBe(300);
    expect(TONE_MAX).toBe(1200);
  });

  it("切换难度会更新设置", () => {
    const { root, host } = makeHost();
    const select = fieldByLabel(root, "难度等级").querySelector("select")!;

    select.value = "hardcore";
    select.dispatchEvent(new Event("change"));

    expect(host.settings.difficulty).toBe("hardcore");
  });

  it("辅助模式开关会更新设置", () => {
    const { root, host } = makeHost({ assistMode: false });
    const box = checkboxByLabel(root, "辅助模式（默认）");

    expect(box.checked).toBe(false);
    box.checked = true;
    box.dispatchEvent(new Event("change"));

    expect(host.settings.assistMode).toBe(true);
  });

  it("Farnsworth 开关会更新设置", () => {
    const { root, host } = makeHost({ farnsworthEnabled: false });
    const box = checkboxByLabel(root, "启用 Farnsworth");

    box.checked = true;
    box.dispatchEvent(new Event("change"));

    expect(host.settings.farnsworthEnabled).toBe(true);
  });

  it("电键类型默认直键，切到 iambic 后出现点键/划键与模式选择", () => {
    const { root, host } = makeHost();
    // 默认直键：只显示一个直键按键，不暴露 iambic 专属控件
    expect(fieldByLabel(root, "电键类型").querySelector("select")!.value).toBe("straight");
    expect(root.textContent).toContain("直键按键");
    expect(root.textContent).not.toContain("点键：");

    const mode = fieldByLabel(root, "电键类型").querySelector("select")!;
    mode.value = "iambic";
    mode.dispatchEvent(new Event("change"));

    expect(host.settings.keyMode).toBe("iambic");
    const after = fieldByLabel(root, "电键类型").querySelector("select")!.value;
    expect(after).toBe("iambic");
    expect(root.textContent).toContain("点键：");
    expect(root.textContent).toContain("划键：");
    expect(root.textContent).toContain("squeeze");
  });

  it("iambic 模式 A/B 可切换并持久化到设置", () => {
    const { root, host } = makeHost({ keyMode: "iambic" });

    const select = fieldByLabel(root, "iambic 模式").querySelector("select")!;
    select.value = "B";
    select.dispatchEvent(new Event("change"));

    expect(host.settings.iambicMode).toBe("B");
  });

  it("点键/划键可重新绑定按键", () => {
    const { root, host } = makeHost({ keyMode: "iambic", dotCode: "ControlLeft" });

    const btn = Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find((b) =>
      b.textContent?.startsWith("点键："),
    )!;
    btn.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyZ" }));

    expect(host.settings.dotCode).toBe("KeyZ");
  });

  it("「恢复默认设置」把设置还原为默认值", () => {
    const { root, host } = makeHost({ wpm: 30, toneHz: 900, difficulty: "hardcore" });
    expect(host.settings.wpm).toBe(30);

    Array.from(root.querySelectorAll<HTMLButtonElement>("button"))
      .find((b) => b.textContent === "恢复默认设置")!
      .click();

    expect(host.settings.wpm).toBe(DEFAULT_SETTINGS.wpm);
    expect(host.settings.toneHz).toBe(DEFAULT_SETTINGS.toneHz);
    expect(host.settings.difficulty).toBe(DEFAULT_SETTINGS.difficulty);
  });
});
