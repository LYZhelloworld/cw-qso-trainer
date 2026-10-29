import { describe, expect, it } from "vitest";
import { loadModeMessages, type ModeFileReader } from "../../src/ui/modeFileLoader.js";

/** A reader that hands back whatever is in the map (or null). */
function readerFor(files: Record<string, string>): ModeFileReader {
  return async (name) => files[name] ?? null;
}

describe("loadModeMessages", () => {
  it("没有可读的文件时用内置默认（浏览器就永远是这样）", async () => {
    const loaded = await loadModeMessages("DX", async () => null);
    expect(loaded.source).toBe("bundled");
    expect(loaded.problems).toEqual([]);
    expect(loaded.config.messages[0].text).toBe("CQ CQ CQ DE {MYCALL} {MYCALL} PSE K");
  });

  it("读到用户文件就用它", async () => {
    const loaded = await loadModeMessages(
      "DX",
      readerFor({ "DX.msg": "F1 CQ,test de {MYCALL}\nF2 RST,r r r" }),
    );
    expect(loaded.source).toBe("file");
    expect(loaded.problems).toEqual([]);
    expect(loaded.config.messages[0].text).toBe("test de {MYCALL}");
    expect(loaded.config.messages[1].text).toBe("r r r");
    // 没写的键仍然占位，不会被默认报文偷偷补上
    expect(loaded.config.messages[2].text).toBe("");
  });

  it("文件有毛病也照用，并把行号带回来", async () => {
    const loaded = await loadModeMessages(
      "DX",
      readerFor({ "DX.msg": "F1 CQ,one\nF9 X,x\nwhatever" }),
    );
    expect(loaded.source).toBe("file");
    expect(loaded.config.messages[0].text).toBe("one");
    expect(loaded.problems).toHaveLength(2);
    expect(loaded.problems[0]).toContain("第 2 行");
    expect(loaded.problems[1]).toContain("第 3 行");
  });

  it("文件里一个字都读不出时退回默认，而不是给八个死键", async () => {
    const loaded = await loadModeMessages("DX", readerFor({ "DX.msg": "# 全是注释\n\n" }));
    expect(loaded.source).toBe("bundled");
    expect(loaded.problems[0]).toContain("没有可用报文");
  });

  it("读文件抛错也不影响开工", async () => {
    const loaded = await loadModeMessages("DX", async () => {
      throw new Error("权限不足");
    });
    expect(loaded.source).toBe("bundled");
    expect(loaded.problems[0]).toContain("读不到 DX.msg");
    expect(loaded.config.messages).toHaveLength(8);
  });
});
