// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderSettingsPanel } from "../../../src/ui/pages/settingsPage.js";
import { DEFAULT_SETTINGS, TONE_MAX, TONE_MIN, WPM_MAX, normalizeSettings, type AppSettings } from "../../../src/ui/settingsSchema.js";
import { QsoSession } from "../../../src/ui/session.js";
import { dxccDatabase } from "../../../src/data/dxcc.js";
import type { AppHost, PageId } from "../../../src/ui/app.js";

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
    root.replaceChildren(renderSettingsPanel(host));
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
  it("包含身份 / 音频与速度 / CW 接收 / 通联 / 键位 / 其他六个区块", () => {
    const { root } = makeHost();
    expect(panelTitles(root)).toEqual([
      "身份",
      "音频与速度",
      "CW 接收",
      "通联",
      "键位",
      "其他",
    ]);
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
    // `QQ` is reserved by the ITU and never assigned, so it stays outside the
    // table no matter how often the dataset is refreshed.
    input.value = "QQ9QQQ";
    input.dispatchEvent(new Event("input"));
    const warn = fieldByLabel(root, "本方呼号").querySelector(".hint");
    expect(warn?.textContent).toContain("不在 DXCC 表中");
  });

  it("表外前缀（如 QQ7）仍可用于练习，仅提示 .warn 而非错误", () => {
    const { root } = makeHost({ myCall: "" });
    const input = fieldByLabel(root, "本方呼号").querySelector("input")!;

    input.value = "QQ7XXX";
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

  it("侧音开关与音量都在音频与速度里，改动即生效", () => {
    const { root, host } = makeHost({ sidetone: true, sidetoneVolume: 30 });

    const box = checkboxByLabel(root, "发报侧音");
    expect(box.checked).toBe(true);
    box.checked = false;
    box.dispatchEvent(new Event("change"));
    expect(host.settings.sidetone).toBe(false);

    const volume = fieldByLabel(root, "侧音音量").querySelector("input")!;
    expect(volume.value).toBe("30");
    volume.value = "70";
    volume.dispatchEvent(new Event("change"));
    expect(host.settings.sidetoneVolume).toBe(70);
  });

  it("切换难度会更新设置", () => {
    const { root, host } = makeHost();
    const select = fieldByLabel(root, "难度等级").querySelector("select")!;

    select.value = "hardcore";
    select.dispatchEvent(new Event("change"));

    expect(host.settings.difficulty).toBe("hardcore");
  });

  it("不再提供全局 CW 边带选项：边带跟着波段走", () => {
    const { root } = makeHost();
    expect(root.textContent).not.toContain("CW 边带");
    // 说明文字指向电台面板的模式标签
    expect(root.textContent).toContain("模式标签");
  });

  it("接收滤波带宽默认 500 Hz，可切到 250 / 100 Hz", () => {
    const { root, host } = makeHost();
    const select = fieldByLabel(root, "接收滤波带宽").querySelector("select")!;
    expect(select.value).toBe("500");
    expect(Array.from(select.querySelectorAll("option")).map((o) => o.value)).toEqual([
      "500",
      "250",
      "100",
    ]);

    select.value = "100";
    select.dispatchEvent(new Event("change"));
    expect(host.settings.passbandHz).toBe(100);
  });

  it("Farnsworth 开关会更新设置", () => {
    const { root, host } = makeHost({ farnsworthEnabled: false });
    const box = checkboxByLabel(root, "启用 Farnsworth");

    box.checked = true;
    box.dispatchEvent(new Event("change"));

    expect(host.settings.farnsworthEnabled).toBe(true);
  });

  it("发报模式默认直键，可切到 iambic 或文本模式", () => {
    const { root, host } = makeHost();
    // 默认直键：只显示一个直键按键，不暴露 iambic 专属控件
    expect(fieldByLabel(root, "发报模式").querySelector("select")!.value).toBe("straight");
    expect(root.textContent).toContain("直键按键");
    expect(root.textContent).not.toContain("点键：");

    const mode = fieldByLabel(root, "发报模式").querySelector("select")!;
    mode.value = "iambic";
    mode.dispatchEvent(new Event("change"));

    expect(host.settings.keyMode).toBe("iambic");
    const after = fieldByLabel(root, "发报模式").querySelector("select")!.value;
    expect(after).toBe("iambic");
    expect(root.textContent).toContain("点键：");
    expect(root.textContent).toContain("划键：");
    expect(root.textContent).toContain("squeeze");

    // 第三种模式：文本框发报，不绑电键。
    fieldByLabel(root, "发报模式").querySelector("select")!.value = "text";
    fieldByLabel(root, "发报模式")
      .querySelector("select")!
      .dispatchEvent(new Event("change"));

    expect(host.settings.keyMode).toBe("text");
    expect(root.textContent).toContain("文本框模式不使用电键");
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
