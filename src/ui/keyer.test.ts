import { describe, expect, it } from "vitest";
import { StraightKeyer } from "./keyer.js";

/** Key A (.-) with a 60 ms dot: down 0..60, gap 60, dash 120..300. */
function keyA(): StraightKeyer {
  const k = new StraightKeyer(() => {}, 50);
  k.keyDown(0);
  k.keyUp(60);
  k.keyDown(120);
  k.keyUp(300);
  return k;
}

describe("StraightKeyer", () => {
  it("键控期间 isDown 反映按键状态", () => {
    const k = new StraightKeyer(() => {});
    expect(k.isDown).toBe(false);
    k.keyDown(0);
    expect(k.isDown).toBe(true);
    k.keyUp(60);
    expect(k.isDown).toBe(false);
  });

  it("currentSymbols 实时回显点划", () => {
    const k = keyA();
    expect(k.currentSymbols()).toBe(".-");
  });

  it("finish 把点划序列解码成字母", () => {
    const texts: string[] = [];
    const k = new StraightKeyer((t) => texts.push(t), 50);
    k.keyDown(0);
    k.keyUp(60);
    k.keyDown(120);
    k.keyUp(300);

    k.finish();
    expect(texts).toEqual(["A"]);
    expect(k.hasContent).toBe(false);
  });

  it("字符间隔≥3d 时切分出多个字符", () => {
    const texts: string[] = [];
    const k = new StraightKeyer((t) => texts.push(t), 50);
    // E (.) then wait 3d, then T (-)
    k.keyDown(0);
    k.keyUp(60);
    k.keyDown(300);
    k.keyUp(480);
    k.finish();
    expect(texts).toEqual(["ET"]);
  });

  it("clear 丢弃尚未解码的内容", () => {
    const k = keyA();
    expect(k.hasContent).toBe(true);
    k.clear();
    expect(k.hasContent).toBe(false);
    expect(k.currentSymbols()).toBe("");
  });

  it("忽视键盘自动重复产生的重复 keyDown", () => {
    const texts: string[] = [];
    const k = new StraightKeyer((t) => texts.push(t), 50);
    k.keyDown(0);
    k.keyDown(10); // auto-repeat, ignored
    k.keyUp(60);
    k.finish();
    expect(texts).toEqual(["E"]);
  });

  it("停手一段时间后自动 flush（idle 超时）", async () => {
    const texts: string[] = [];
    const k = new StraightKeyer((t) => texts.push(t), 20);
    k.keyDown(0);
    k.keyUp(60); // dot -> E
    expect(texts).toEqual([]);

    await new Promise((r) => setTimeout(r, 40));
    expect(texts).toEqual(["E"]);
  });

  it("没有内容时 finish 不触发回调", () => {
    let calls = 0;
    const k = new StraightKeyer(() => {
      calls += 1;
    }, 50);
    k.finish();
    expect(calls).toBe(0);
  });
});
